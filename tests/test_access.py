"""What agents may do in your conversations: auto until you change it, per conversation or as your default."""
from fastapi.testclient import TestClient

from pga.agents.adapters import ClaudeLocal
from pga.agents.base import AUTO, FULL, READ_ONLY, WORKSPACE_WRITE, AgentTask
from pga.agents.routing import AgentRouter
from pga.api.app import create_app
from pga.runtime import Runtime


def _cmd(perms, **meta):
    ad = ClaudeLocal.__new__(ClaudeLocal)
    ad.config = {}
    return ad.command(AgentTask(prompt="x", permissions=perms, meta=meta), "claude")


def test_claude_flags_follow_the_level_and_mcp(monkeypatch):
    import pga.agents.adapters as A
    monkeypatch.setattr(A, "_mcp_rules", lambda: ",mcp__notes")
    ro = _cmd(READ_ONLY)
    assert "--strict-mcp-config" in ro and "Bash,Edit,Write,NotebookEdit" in ro and "default" in ro
    rw = _cmd(WORKSPACE_WRITE, mcp=True)
    assert "--strict-mcp-config" not in rw and any("mcp__notes" in x for x in rw) and "acceptEdits" in rw
    full = _cmd(FULL)                                                            # a full-access project: your MCP tools too
    assert "--strict-mcp-config" not in full and any(x.startswith("Bash,") and "mcp__notes" in x for x in full)
    assert "--strict-mcp-config" in _cmd(FULL, mcp=False)                        # …unless you turned them off
    auto = _cmd(AUTO)                                                            # the default: acts on its own, Claude Code's auto mode
    assert "default" in auto and "--permission-prompt-tool" in auto and "stdio" in auto and "--disallowedTools" not in auto
    assert "Bash" not in auto[auto.index("--allowedTools") + 1]
    assert "bypassPermissions" not in " ".join(ro + rw + auto) and "bypassPermissions" in " ".join(full)   # only 完全批准 skips the checks


def test_settings_per_conversation_and_default(session_factory, policy, provider, backend, user, session, monkeypatch, tmp_path):
    seen = []
    monkeypatch.setattr(AgentRouter, "ask", lambda self, u, text, **kw: seen.append(kw) or {"ok": True, "text": "ok"})
    app = create_app(session_factory=session_factory,
                     runtime_factory=lambda s: Runtime(s, policy=policy, provider=provider, translation_backend=backend))
    with TestClient(app) as c:
        assert c.get(f"/v1/users/{user.id}/access", params={"key": "chat:a"}).json()["current"] == {"access": "auto", "folder": "", "mcp": False, "resolved_folder": ""}
        assert c.put(f"/v1/users/{user.id}/access", json={"key": "chat:a", "access": "nope"}).status_code == 422
        assert c.put(f"/v1/users/{user.id}/access", json={"key": "chat:a", "access": "full", "folder": "/no/such/dir"}).status_code == 422
        r = c.put(f"/v1/users/{user.id}/access", json={"key": "chat:a", "access": "full", "folder": str(tmp_path), "mcp": True}).json()
        assert r == {"access": "full", "folder": str(tmp_path), "mcp": True}
        c.post(f"/v1/users/{user.id}/agents/ask", json={"text": "hi", "conversation": "chat:a"})
        c.post(f"/v1/users/{user.id}/agents/ask", json={"text": "hi", "conversation": "chat:b"})
        assert (seen[0]["access"], seen[0]["folder"], seen[0]["mcp"]) == ("full", str(tmp_path), True)
        assert (seen[1]["access"], seen[1]["folder"], seen[1]["mcp"]) == ("auto", None, False)    # another chat: the default, auto
        c.put(f"/v1/users/{user.id}/access", json={"access": "read", "as_default": True})
        c.post(f"/v1/users/{user.id}/agents/ask", json={"text": "hi", "conversation": "chat:c"})
        assert seen[2]["access"] == "read"
        assert c.put(f"/v1/users/{user.id}/access", json={"key": "chat:d", "access": "write"}).json()["access"] == "auto"   # the old middle level


def test_background_work_leaves_claude_for_you_and_usage_splits(session_factory, policy, provider, backend, user, session, monkeypatch, tmp_path):
    import json
    from datetime import datetime, timezone

    from pga.agents import pool as ap
    from pga.db.models import AgentRun
    monkeypatch.setattr(ap, "CONFIG", tmp_path / "agents.yaml")
    assert ap.load()["routing"]["keep_for_me"] == ["claude_local"]
    now = datetime.now(timezone.utc)
    mine = AgentRun(user_id=user.id, workflow="ask", pattern="single", step="workflow", agent="claude", adapter="pool", status="SUCCEEDED",
                    prompt="你好", output=json.dumps({"answer": "hi"}), data={"conversation": "u:chat:z"}, started_at=now)
    bg = AgentRun(user_id=user.id, workflow="task:synthesis", pattern="single", step="workflow", agent="chatgpt", adapter="pool", status="SUCCEEDED",
                  prompt="x", output="", data={}, started_at=now)
    session.add_all([mine, bg])
    session.flush()
    session.add_all([AgentRun(user_id=user.id, parent_id=mine.id, workflow="ask", pattern="single", step="run", agent="claude", adapter="claude_local",
                              status="SUCCEEDED", prompt="你好", output="hi", started_at=now,
                              data={"usage": {"input_tokens": 4, "cache_read_input_tokens": 700000, "cache_creation_input_tokens": 0, "output_tokens": 9}}),
                     AgentRun(user_id=user.id, parent_id=bg.id, workflow="task:synthesis", pattern="single", step="run", agent="chatgpt", adapter="codex_local",
                              status="SUCCEEDED", prompt="x", output="y", started_at=now, data={"usage": {"last": {"inputTokens": 5000, "outputTokens": 10}}})])
    session.commit()
    app = create_app(session_factory=session_factory,
                     runtime_factory=lambda s: Runtime(s, policy=policy, provider=provider, translation_backend=backend))
    with TestClient(app) as c:
        sp = c.get(f"/v1/users/{user.id}/usage/split").json()
        assert sp["agents"]["claude"]["yours"]["input"] == 700004 and sp["agents"]["chatgpt"]["background"]["input"] == 5000
        assert sp["heavy"][0]["input"] == 700004 and sp["keep_for_me"] == ["claude_local"]
        assert c.put("/v1/agents/background", json={"keep_for_me": []}).json()["keep_for_me"] == []
        assert ap.load()["routing"]["keep_for_me"] == []


def test_approval_full_persists_only_this_conversation(session_factory, policy, provider, backend, user, session):
    import time
    from concurrent.futures import ThreadPoolExecutor
    from pga.agents import approvals, live
    lid = live.start('claude', tags={'conversation':f'{user.id}:chat:approval'})
    task = AgentTask(prompt='write', permissions=AUTO, timeout_s=5,
                     meta={'live_id':lid,'conversation':f'{user.id}:chat:approval'})
    app = create_app(session_factory=session_factory,
                     runtime_factory=lambda s: Runtime(s, policy=policy, provider=provider, translation_backend=backend))
    with TestClient(app) as c, ThreadPoolExecutor() as pool:
        f = pool.submit(approvals.request, task, {'tool':'Write','input':{'file_path':'notes.txt'}})
        aid = None
        for _ in range(100):
            row = next(x for x in live.snapshot() if x['id'] == lid)
            if row.get('approval'):
                aid = row['approval']['id']; break
            time.sleep(.01)
        assert aid
        r = c.post(f'/v1/users/{user.id}/approvals/{aid}', json={'decision':'full'})
        assert r.status_code == 200 and r.json()['access']['access'] == 'full'
        assert f.result(timeout=2)
        assert c.get(f'/v1/users/{user.id}/access',params={'key':'chat:approval'}).json()['current']['access'] == 'full'
        assert c.get(f'/v1/users/{user.id}/access',params={'key':'chat:other'}).json()['current']['access'] == 'auto'
        assert c.post(f'/v1/users/{user.id}/approvals/{aid}', json={'decision':'allow'}).status_code == 404
    live.finish(lid, True)


def test_top_bar_create_binds_registered_folder_and_preserves_default(session_factory, policy, provider, backend, user, session, tmp_path):
    from pga.db.models import Project
    session.add(Project(user_id=user.id, name="PGA", path=str(tmp_path), full_access=True))
    session.commit()
    app = create_app(session_factory=session_factory,
                     runtime_factory=lambda s: Runtime(s, policy=policy, provider=provider, translation_backend=backend))
    with TestClient(app) as c:
        def create():
            r = c.post(f"/v1/users/{user.id}/conversation-projects", json={"project": "PGA", "create": True})
            assert r.status_code == 200, r.text
            return r.json()["key"]
        key = create()
        current = c.get(f"/v1/users/{user.id}/access", params={"key": key}).json()["current"]
        assert (current["access"], current["folder"]) == ("full", str(tmp_path))
        c.put(f"/v1/users/{user.id}/access", json={"access": "read", "as_default": True})
        second = create()
        assert c.get(f"/v1/users/{user.id}/access", params={"key": second}).json()["current"]["access"] == "read"
        assert c.get(f"/v1/users/{user.id}/access", params={"key": key}).json()["current"]["access"] == "full"
        c.put(f"/v1/users/{user.id}/access", json={"key": second, "access": "auto", "folder": str(tmp_path)})
        assert c.get(f"/v1/users/{user.id}/access", params={"key": second}).json()["current"]["access"] == "auto"


def test_split_agents_use_current_parent_permissions(session_factory, policy, provider, backend, user, session, monkeypatch, tmp_path):
    user.preferences = {**(user.preferences or {}),
        "chat_splits": {"chat:main": {"lanes": [{"key": "second:a"}, {"key": "second:b"}]}},
        "agent_access": {"keys": {"second:a": {"access": "read"}, "second:b": {"access": "read"}}}}
    session.commit()
    seen = []
    monkeypatch.setattr(AgentRouter, 'ask', lambda self, u, text, **kw: seen.append(kw) or {'ok': True, 'text': 'ok'})
    app = create_app(session_factory=session_factory,
                     runtime_factory=lambda s: Runtime(s, policy=policy, provider=provider, translation_backend=backend))
    with TestClient(app) as c:
        for mode in ('full', 'read'):
            assert c.put(f'/v1/users/{user.id}/access', json={'key':'chat:main', 'access':mode, 'folder':str(tmp_path)}).status_code == 200
            for lane in ('second:a', 'second:b'):
                assert c.post(f'/v1/users/{user.id}/agents/ask', json={'conversation':lane,'text':'check'}).status_code == 200
                assert seen[-1]['access'] == mode
                assert seen[-1]['folder'] == str(tmp_path)
        assert c.get(f'/v1/users/{user.id}/access',params={'key':'chat:unrelated'}).json()['current']['access'] == 'auto'
