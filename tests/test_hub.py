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
    monkeypatch.setattr(hub_service, "read_local", lambda connector: convs)
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
