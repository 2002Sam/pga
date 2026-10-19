"""What agents may do in your conversations: read-only until you change it, per conversation or as your default."""
from fastapi.testclient import TestClient

from pga.agents.adapters import ClaudeLocal
from pga.agents.base import FULL, READ_ONLY, WORKSPACE_WRITE, AgentTask
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
    assert "bypassPermissions" not in " ".join(ro + rw + full)                 # never skips every check


def test_settings_per_conversation_and_default(session_factory, policy, provider, backend, user, session, monkeypatch, tmp_path):
    seen = []
    monkeypatch.setattr(AgentRouter, "ask", lambda self, u, text, **kw: seen.append(kw) or {"ok": True, "text": "ok"})
    app = create_app(session_factory=session_factory,
                     runtime_factory=lambda s: Runtime(s, policy=policy, provider=provider, translation_backend=backend))
    with TestClient(app) as c:
        assert c.get(f"/v1/users/{user.id}/access", params={"key": "chat:a"}).json()["current"] == {"access": "read", "folder": "", "mcp": False}
        assert c.put(f"/v1/users/{user.id}/access", json={"key": "chat:a", "access": "nope"}).status_code == 422
        assert c.put(f"/v1/users/{user.id}/access", json={"key": "chat:a", "access": "full", "folder": "/no/such/dir"}).status_code == 422
        r = c.put(f"/v1/users/{user.id}/access", json={"key": "chat:a", "access": "full", "folder": str(tmp_path), "mcp": True}).json()
        assert r == {"access": "full", "folder": str(tmp_path), "mcp": True}
        c.post(f"/v1/users/{user.id}/agents/ask", json={"text": "hi", "conversation": "chat:a"})
        c.post(f"/v1/users/{user.id}/agents/ask", json={"text": "hi", "conversation": "chat:b"})
        assert (seen[0]["access"], seen[0]["folder"], seen[0]["mcp"]) == ("full", str(tmp_path), True)
        assert (seen[1]["access"], seen[1]["folder"], seen[1]["mcp"]) == ("read", None, False)    # another chat: still read-only
        c.put(f"/v1/users/{user.id}/access", json={"access": "write", "as_default": True})
        c.post(f"/v1/users/{user.id}/agents/ask", json={"text": "hi", "conversation": "chat:c"})
        assert seen[2]["access"] == "write"


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
