"""Agent Hub: importing other agents' history, summarizing it, and telling the user."""

from __future__ import annotations

import io
import json
import sqlite3
import zipfile
from datetime import datetime, timezone

import pytest

from pga.db.models import AgentConversation, Notification
from pga.hub.connectors import claude_code_sessions, excerpt, hermes_sessions, parse_upload, redact
from pga.hub.service import HubError
from pga.notify.service import macos_channel

T0 = datetime(2026, 10, 12, 10, 0, tzinfo=timezone.utc)

CHATGPT = [{"id": "c1", "title": "Plan the PGA translation layer", "create_time": 1790000000, "update_time": 1790000500,
            "mapping": {"a": {"message": {"author": {"role": "system"}, "content": {"parts": ["sys"]}, "create_time": 1}},
                        "b": {"message": {"author": {"role": "user"}, "content": {"parts": ["How do I keep code spans intact?"]},
                                          "create_time": 1790000001}},
                        "c": {"message": {"author": {"role": "assistant"}, "content": {"parts": ["Protect them first."]},
                                          "create_time": 1790000002}}}}]
CLAUDE = [{"uuid": "u1", "name": "Paper outline", "created_at": "2026-09-01T10:00:00Z", "updated_at": "2026-09-02T10:00:00Z",
           "chat_messages": [{"sender": "human", "text": "Outline my world-model paper"},
                             {"sender": "assistant", "text": "1. Intro 2. Method"}]}]
DEEPSEEK = [{"id": "d1", "title": "Sim2real", "inserted_at": "2026-09-05T08:00:00Z",
             "mapping": {"x": {"message": {"inserted_at": "2026-09-05T08:00:01Z",
                                           "fragments": [{"type": "REQUEST", "content": "Is sim2real solved?"},
                                                         {"type": "THINK", "content": "hmm"},
                                                         {"type": "RESPONSE", "content": "Not yet."}]}}}}]


def summary_brain(system, messages):
    if "uses one AI agent" in system:
        return json.dumps({"headline": "Uses it to design the PGA agent", "used_for": ["architecture"],
                           "topics": [{"name": "translation", "weight": 0.9}],
                           "projects": [{"name": "PGA", "status": "active", "last_seen": "2026-10-10", "note": "phase 2"}],
                           "preferences": ["concise answers"], "open_threads": ["mac app"], "strengths": "planning"})
    if "per-agent usage summaries" in system:
        return json.dumps({"overview": "Most work is the PGA agent.", "agent_roles": [{"agent": "ChatGPT", "role": "design"}],
                           "projects": [{"name": "PGA", "agents": ["ChatGPT"], "status": "active", "next_step": "ship UI"}],
                           "recurring_needs": ["translation"], "overlaps": [], "gaps": ["no tests agent"],
                           "recommendations": ["link Claude Code"], "open_threads": ["mac app"]})
    return messages[-1]["content"]


# ---------------------------------------------------------------- parsing


@pytest.mark.parametrize("payload,vendor,first_user", [
    (CHATGPT, "chatgpt", "How do I keep code spans intact?"),
    (CLAUDE, "claude", "Outline my world-model paper"),
    (DEEPSEEK, "deepseek", "Is sim2real solved?"),
])
def test_exports_are_recognised(payload, vendor, first_user):
    convs, guess = parse_upload("conversations.json", json.dumps(payload).encode())
    assert guess == vendor and len(convs) == 1
    assert convs[0].turns[0] == ("user", first_user) and all(r in ("user", "assistant") for r, _ in convs[0].turns)
    assert "hmm" not in json.dumps(convs[0].turns)                     # DeepSeek THINK fragments are dropped


def test_zip_export_and_plain_transcript():
    buf = io.BytesIO()
    with zipfile.ZipFile(buf, "w") as z:
        z.writestr("export/conversations.json", json.dumps(CHATGPT))
    convs, guess = parse_upload("chatgpt-export.zip", buf.getvalue())
    assert guess == "chatgpt" and convs[0].title == "Plan the PGA translation layer"
    convs, _ = parse_upload("notes.md", "# Kimi 聊天\n我：帮我写周报\nKimi：好的，这是草稿\n继续一行".encode())
    assert convs[0].turns == [("user", "帮我写周报"), ("assistant", "好的，这是草稿\n继续一行")]


def test_secrets_never_reach_excerpts():
    text = "my key is sk-121268d3ba6b325e-f8951d-dd02d8eb and password: hunter2, db postgresql://u:pw@h/db"
    out = redact(text)
    assert "sk-1212" not in out and "hunter2" not in out and "u:pw@" not in out
    assert "sk-" not in excerpt([("user", text), ("assistant", "ok")])


def test_claude_project_thread_session_reads_as_the_thread(tmp_path):
    """A session working a claude.ai project thread: your words come wrapped, its replies are reply tool calls."""
    proj = tmp_path / "-Users-me-PGA"
    proj.mkdir()
    wake = ('<wake reason="mention"><project id="chan_1" type="project"><thread ts="m0"><message trigger="true" from="human" '
            'author-id="user_1" id="{id}" sent-at="2026-10-10T06:00:00Z">{text}</message></thread></project></wake>')
    (proj / "s1.jsonl").write_text("\n".join(json.dumps(e, ensure_ascii=False) for e in [
        {"type": "user", "isMeta": True, "cwd": "/Users/me/PGA", "message": {"content": '<relay from="coordinator"><note>spawn</note></relay>'}},
        {"type": "assistant", "timestamp": "2026-10-10T05:59:30Z", "message": {"content": [{"type": "text", "text": "Copying the files."}]}},
        {"type": "user", "timestamp": "2026-10-10T06:00:00Z", "cwd": "/Users/me/PGA", "message": {"content": wake.format(id="m1", text="read the spec &#34;me&#34;")}},
        {"type": "assistant", "timestamp": "2026-10-10T06:01:00Z", "message": {"content": [
            {"type": "text", "text": "Now the memory note."}, {"type": "tool_use", "name": "mcp__hearthbot__reply", "input": {"text": "I read both."}}]}},
        {"type": "user", "timestamp": "2026-10-10T06:02:00Z", "message": {"content": [{"type": "tool_result", "content": "ok"}]}},
        {"type": "user", "timestamp": "2026-10-10T06:05:00Z", "message": {"content":
            '<project_claude_message><relay from="coordinator"><cited id="m2" author="user">build the rest</cited>'
            '<cited id="m1" author="user">read the spec</cited><note>the user wants more</note></relay></project_claude_message>'}},
        {"type": "user", "timestamp": "2026-10-10T06:06:00Z", "message": {"content": "[auto-continue] The usage limit has reset."}},
        {"type": "user", "timestamp": "2026-10-10T06:06:00Z", "isCompactSummary": True, "message": {"content": "This session is being continued…"}},
        {"type": "assistant", "timestamp": "2026-10-10T06:07:00Z", "message": {"content": [{"type": "tool_use", "name": "mcp__hearthbot__reply", "input": {"text": "Built it."}}]}},
        {"type": "user", "timestamp": "2026-10-19T14:16:00Z", "message": {"content": "[PGA note — access for this conversation]\n\n现在呢？"}},
        {"type": "assistant", "timestamp": "2026-10-19T14:17:00Z", "message": {"content": [{"type": "text", "text": "可以了。"}]}}]))
    c = claude_code_sessions(tmp_path)[0]
    assert c.turns == [("aside", "Copying the files."), ("user", 'read the spec "me"'), ("aside", "Now the memory note."),
                       ("assistant", "I read both."), ("user", "build the rest"), ("assistant", "Built it."),
                       ("user", "现在呢？"), ("assistant", "可以了。")]
    assert c.title == 'read the spec "me"' and c.message_count == 6 and len(c.stamps) == len(c.turns) and c.stamps[1].hour == 6
    assert "Copying" not in excerpt(c.turns) and "I read both." in excerpt(c.turns)


def test_local_agents_are_read_only(tmp_path):
    proj = tmp_path / "-Users-me-paper"
    proj.mkdir()
    (proj / "s1.jsonl").write_text("\n".join(json.dumps(e) for e in [
        {"type": "user", "timestamp": "2026-10-01T09:00:00Z", "cwd": "/Users/me/paper",
         "message": {"content": "<system-reminder>ignore</system-reminder>Fix the figure captions"}},
        {"type": "assistant", "timestamp": "2026-10-01T09:01:00Z",
         "message": {"content": [{"type": "text", "text": "Done."}, {"type": "tool_use", "name": "Edit"}]}}]))
    cc = claude_code_sessions(tmp_path)
    assert cc[0].turns == [("user", "Fix the figure captions"), ("assistant", "Done.")] and cc[0].project == "paper"
    db = tmp_path / "state.db"
    con = sqlite3.connect(db)
    con.executescript("""create table sessions (id text primary key, title text, display_name text, started_at real,
                         last_activity_at real, ended_at real, cwd text, hidden integer);
                         create table messages (id integer primary key, session_id text, role text, content text,
                         timestamp real, active integer);
                         insert into sessions values ('h1', 'Daily brief', null, 1790000000, 1790000900, null, '/x/pga', 0);
                         insert into messages values (1, 'h1', 'user', 'brief me', 1790000001, 1),
                                                     (2, 'h1', 'tool', 'raw', 1790000002, 1),
                                                     (3, 'h1', 'assistant', 'Here it is', 1790000003, 1);""")
    con.commit()
    con.close()
    h = hermes_sessions(db)
    assert h[0].title == "Daily brief" and h[0].turns == [("user", "brief me"), ("assistant", "Here it is")]


# ---------------------------------------------------------------- service


def test_import_summarize_digest_and_context(rt, user, provider, session):
    provider.handler = summary_brain
    a = rt.hub.create(user.id, name="ChatGPT", vendor="other")
    out = rt.hub.import_bytes(a, "conversations.json", json.dumps(CHATGPT).encode(), T0)
    assert out == {"new": 1, "updated": 0, "total": 1, "vendor_guess": "chatgpt"} and a.vendor == "chatgpt"
    assert rt.hub.import_bytes(a, "conversations.json", json.dumps(CHATGPT).encode(), T0)["new"] == 0   # idempotent
    with pytest.raises(HubError):
        rt.hub.digest(user, now=T0)                                     # nothing summarized yet
    rt.hub.summarize(a, now=T0)
    assert a.summary["projects"][0]["name"] == "PGA" and not a.summary_stale and a.summary_display
    d = rt.hub.digest(user, now=T0)
    assert d.content["overview"] == "Most work is the PGA agent." and str(a.id) in d.agent_ids
    assert "PGA" in rt.hub.context_block(user.id)
    assert session.query(AgentConversation).count() == 1


def test_background_sync_notifies_once(rt, user, provider, session, monkeypatch):
    provider.handler = summary_brain
    from pga.hub import service as hub_service

    convs, _ = parse_upload("c.json", json.dumps(CLAUDE).encode())
    monkeypatch.setattr(hub_service, "read_local_split", lambda connector: (convs, set()))
    a = rt.hub.create(user.id, name="Claude Code", vendor="claude_code", connector="claude_code")
    report = rt.hub.background_sync(user, T0)
    assert report["summarized"] == ["Claude Code"] and report["digest"] is True
    n = session.get(Notification, __import__("uuid").UUID(report["notification_id"]))
    assert "Claude Code +1" in n.title_en and n.reasons == ["ARTIFACT_READY"]
    assert "notification_id" not in rt.hub.background_sync(user, T0)   # nothing new → silent
    assert a.conversation_count == 1


def test_duplicate_local_link_is_refused(rt, user):
    rt.hub.create(user.id, name="Hermes", vendor="hermes", connector="hermes")
    with pytest.raises(HubError):
        rt.hub.create(user.id, name="Hermes", vendor="hermes", connector="hermes")


def test_macos_channel_builds_an_osascript_call(user):
    calls = []
    n = Notification(title_en="Hi", display_title="你好 \"PGA\"", display_body="第二行")
    macos_channel(run=lambda cmd, **kw: calls.append(cmd))(user, n)
    assert calls[0][0] == "osascript" and 'subtitle "你好 \\"PGA\\""' in calls[0][2] and "第二行" in calls[0][2]


def test_codex_and_workbuddy_histories_are_read_with_their_models_and_pga_runs_left_out(tmp_path):
    from pga.hub.connectors import codex_sessions, workbuddy_sessions
    day = tmp_path / "codex" / "2026" / "10" / "12"
    day.mkdir(parents=True)

    def codex(name, cwd, origin="Codex Desktop"):
        rows = [{"timestamp": "2026-10-12T01:00:00Z", "type": "session_meta", "payload": {"id": name, "cwd": cwd, "originator": origin}},
                {"timestamp": "2026-10-12T01:00:01Z", "type": "turn_context", "payload": {"model": "gpt-6-astra"}},
                {"timestamp": "2026-10-12T01:00:02Z", "type": "response_item", "payload": {"type": "message", "role": "user",
                 "content": [{"type": "input_text", "text": "# AGENTS.md instructions\nbe nice"}]}},
                {"timestamp": "2026-10-12T01:00:03Z", "type": "response_item", "payload": {"type": "message", "role": "user",
                 "content": [{"type": "input_text", "text": "帮我投递简历"}]}},
                {"timestamp": "2026-10-12T01:05:00Z", "type": "response_item", "payload": {"type": "message", "role": "assistant",
                 "content": [{"type": "output_text", "text": "好的"}]}}]
        (day / f"rollout-{name}.jsonl").write_text("\n".join(json.dumps(r, ensure_ascii=False) for r in rows))
    codex("mine", "/Users/x/Documents/ChatGPT/简历")
    codex("pga-run", "/Users/x/Documents/PGA/workspaces/20261012/abc-ask/chatgpt")
    convs = codex_sessions((tmp_path / "codex",))
    assert [c.external_id for c in convs] == ["mine"]
    assert convs[0].title == "帮我投递简历" and convs[0].model == "gpt-6-astra" and convs[0].turns[0] == ("user", "帮我投递简历")

    wb = tmp_path / "wb"
    (wb / "projects" / "Users-x-WorkBuddy-1").mkdir(parents=True)
    con = sqlite3.connect(wb / "workbuddy.db")
    con.execute("create table sessions (id text, cwd text, user_id text, title text, custom_title text, model text, created_at int, "
                "updated_at int, last_activity_at int, deleted_at int)")
    con.execute("insert into sessions values ('s1', '/Users/x/WorkBuddy/1', 'u', '整理桌面', null, 'space-bunny', 1790000000000, 1790000100000, 1790000100000, -1)")
    con.execute("insert into sessions values ('s2', '/x', 'u', '删掉的', null, 'm', 1790000000000, 1790000000000, null, 1790000200000)")
    con.commit()
    con.close()
    (wb / "projects" / "Users-x-WorkBuddy-1" / "s1.jsonl").write_text("\n".join(json.dumps(r, ensure_ascii=False) for r in [
        {"type": "message", "role": "user", "timestamp": 1790000000000, "content": [{"type": "input_text", "text": "<system-reminder>ctx</system-reminder>整理一下桌面"}]},
        {"type": "message", "role": "assistant", "timestamp": 1790000100000, "providerData": {"model": "kimi-k3-2"},
         "content": [{"type": "output_text", "text": "已整理"}]}]))
    convs = workbuddy_sessions(wb / "workbuddy.db")
    assert len(convs) == 1 and convs[0].title == "整理桌面" and convs[0].model == "kimi-k3-2"
    assert convs[0].turns == [("user", "整理一下桌面"), ("assistant", "已整理")]


def test_the_timeline_puts_every_agent_in_one_list_by_time(rt, user):
    from pga.hub.connectors import Conv
    t = lambda h: datetime(2026, 10, 12, h, tzinfo=timezone.utc)  # noqa: E731
    a = rt.hub.create(user.id, name="ChatGPT · Codex", vendor="chatgpt", connector="codex")
    b = rt.hub.create(user.id, name="WorkBuddy", vendor="workbuddy", connector="workbuddy")
    rt.hub.ingest(a, [Conv("c1", "早上的", t(8), t(9), [("user", "hi"), ("assistant", "yo")], model="gpt-6-astra")])
    rt.hub.ingest(b, [Conv("w1", "中午的", t(11), t(12), [("user", "hi")], model="kimi-k3-2")])
    rt.hub.ingest(a, [Conv("c2", "晚上的", t(20), t(21), [("user", "hi")], model="gpt-6-luna")])
    items = rt.hub.timeline(user.id)
    assert [(i["title"], i["agent"], i["model"]) for i in items] == [("晚上的", "ChatGPT · Codex", "gpt-6-luna"),
                                                                     ("中午的", "WorkBuddy", "kimi-k3-2"), ("早上的", "ChatGPT · Codex", "gpt-6-astra")]
    assert [i["title"] for i in rt.hub.timeline(user.id, agent="workbuddy")] == ["中午的"]
    user.preferences = {"demo": True}
    assert rt.hub.link_local(user) == []                       # a demo account never gets this machine's agents


def test_a_pool_agent_sees_its_own_apps_past_and_can_carry_it_on(session_factory, policy, provider, backend, user, rt, tmp_path, monkeypatch):
    from fastapi.testclient import TestClient

    from pga.agents import links
    from pga.api.app import create_app
    from pga.hub import connectors
    from pga.hub.connectors import Conv
    from pga.runtime import Runtime
    monkeypatch.setenv("PGA_LINKS_FILE", str(tmp_path / "links.json"))
    proj = tmp_path / "claude" / "-Users-x-proj"
    proj.mkdir(parents=True)
    (proj / "sess-1.jsonl").write_text("\n".join(json.dumps(e) for e in [
        {"type": "user", "timestamp": "2026-10-12T01:00:00Z", "cwd": "/Users/x/proj", "message": {"role": "user", "content": "修一下登录 bug，token=abc123secret"}},
        {"type": "assistant", "timestamp": "2026-10-12T01:01:00Z", "message": {"role": "assistant", "model": "claude-opus-5-5", "content": [{"type": "text", "text": "修好了"}]}}]))
    monkeypatch.setattr(connectors, "CLAUDE_CODE_DIR", tmp_path / "claude")
    cc = rt.hub.create(user.id, name="Claude Code", vendor="claude_code", connector="claude_code")
    rt.hub.ingest(cc, connectors._cc_file(proj / "sess-1.jsonl") and [connectors._cc_file(proj / "sess-1.jsonl", skip_pga=False)])
    cx = rt.hub.create(user.id, name="ChatGPT · Codex", vendor="chatgpt", connector="codex")
    rt.hub.ingest(cx, [Conv("thread-42", "简历", datetime(2026, 10, 11, tzinfo=timezone.utc), datetime(2026, 10, 11, 2, tzinfo=timezone.utc),
                            [("user", "hi")], model="gpt-6-astra")])
    rt.session.flush()
    c = TestClient(create_app(session_factory, lambda s: Runtime(s, policy=policy, provider=provider, translation_backend=backend)))
    counts = c.get(f"/v1/users/{user.id}/agents/past-counts").json()
    assert counts["claude"]["count"] == 1 and counts["chatgpt"]["count"] == 1 and "deepseek" not in counts
    past = c.get(f"/v1/users/{user.id}/agents/claude/past").json()
    assert [p["title"] for p in past] == ["[proj] 修一下登录 bug，token=abc123secret"[:90]] or past[0]["model"] == "claude-opus-5-5"
    one = c.get(f"/v1/users/{user.id}/agents/claude/past/{past[0]['id']}").json()
    assert [t["role"] for t in one["turns"]] == ["user", "assistant"] and "abc123secret" not in one["turns"][0]["text"]   # read in full, redacted
    cxid = c.get(f"/v1/users/{user.id}/agents/chatgpt/past").json()[0]["id"]
    r = c.post(f"/v1/users/{user.id}/agents/chatgpt/past/{cxid}/continue").json()
    assert r["resumes"] == "thread" and links.thread_for("chatgpt", f"{user.id}:{r['conversation']}") == "thread-42"   # Codex resumes that very thread


def test_sessions_pga_ran_itself_are_left_out_and_removed():
    from pga.hub.connectors import Conv, pga_made
    assert pga_made(Conv("a", "t", turns=[("user", "[via PGA]\nWhat is in src/?"), ("assistant", "x")]))
    assert pga_made(Conv("b", "t", turns=[("user", "<aim>\nBuild…</aim>\n\nAsk the next questions."), ("assistant", "x")]))
    assert not pga_made(Conv("c", "t", turns=[("user", "帮我看看这个 bug"), ("assistant", "x")]))
