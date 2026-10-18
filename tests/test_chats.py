"""Everyday chats: second opinions, branches, pins."""
import json
from datetime import datetime, timedelta, timezone

from fastapi.testclient import TestClient

import pga.chats as C
from pga.agents.routing import AgentRouter
from pga.api.app import create_app
from pga.db.models import AgentRun
from pga.runtime import Runtime


def _run(user, prompt, answer, at, key, agent="claude"):
    return AgentRun(user_id=user.id, workflow="ask", pattern="single", step="run", agent=agent, adapter="x", status="SUCCEEDED",
                    prompt=prompt, output=json.dumps({"answer": answer}), data={"conversation": key, "agent": agent}, started_at=at)


def test_second_opinion_branch_and_pin(session_factory, policy, provider, backend, user, session, monkeypatch):
    now = datetime.now(timezone.utc)
    r1, r2 = _run(user, "先问一", "答一", now - timedelta(minutes=9), "chat:x"), _run(user, "再问二", "答二", now - timedelta(minutes=5), "chat:x")
    session.add_all([r1, r2])
    session.commit()
    asked = []

    def ask(self, u, text, **kw):
        asked.append((text, kw))
        return {"ok": True, "agent": kw.get("agent"), "text": "另一个答案", "model": "m"}
    monkeypatch.setattr(AgentRouter, "ask", ask)
    monkeypatch.setattr(C, "_compare", lambda *a, **k: {"agree": ["都说要做"], "differ": [{"point": "顺序", "a": "先A", "b": "先B"}], "answer": "合起来"})
    app = create_app(session_factory=session_factory,
                     runtime_factory=lambda s: Runtime(s, policy=policy, provider=provider, translation_backend=backend))
    with TestClient(app) as c:
        r = c.post(f"/v1/users/{user.id}/chats/second", json={"run": str(r2.id), "agent": "codex"})
        assert r.status_code == 200, r.text
        text, kw = asked[0]
        assert text == "再问二" and kw["agent"] == "codex" and kw["conversation"] == f"second:{r2.id}"
        assert [h["text"] for h in kw["history"]] == ["先问一", "答一"]                 # the conversation before the question
        t = c.get(f"/v1/users/{user.id}/chats/chat:x").json()["turns"]
        assert t[3]["second"]["agent"] == "codex" and t[3]["second"]["differ"][0]["b"] == "先B"
        b = c.post(f"/v1/users/{user.id}/chats/branch", json={"from": "chat:x", "upto": str(r1.id)}).json()
        one = c.get(f"/v1/users/{user.id}/chats/{b['key']}").json()
        assert one["branch"]["from"] == "chat:x" and [x["text"] for x in one["context"]] == ["先问一", "答一"] and one["turns"] == []
        tl = c.get(f"/v1/users/{user.id}/timeline", params={"days": 3}).json()
        assert b["line"] == "chat:x"
        assert c.put(f"/v1/users/{user.id}/timeline/pin", json={"line": "chat:x"}).json()["pinned"] == ["chat:x"]
        assert c.get(f"/v1/users/{user.id}/timeline", params={"days": 3}).json()["pinned"] == ["chat:x"]
        keys = [x["key"] for x in c.get(f"/v1/users/{user.id}/chats").json()]
        assert keys == ["chat:x"] and not any(k.startswith("second:") for k in {x["item"] for x in tl["sessions"]})


def test_your_own_note_goes_into_the_conversation(session_factory, policy, provider, backend, user, session):
    now = datetime.now(timezone.utc)
    r1 = _run(user, "先问一", "答一", now - timedelta(minutes=9), "chat:n")
    session.add(r1)
    session.commit()
    app = create_app(session_factory=session_factory,
                     runtime_factory=lambda s: Runtime(s, policy=policy, provider=provider, translation_backend=backend))
    with TestClient(app) as c:
        r = c.post(f"/v1/users/{user.id}/chats/note", json={"conversation": "chat:n", "text": "下一步：先把数据整理好", "line": "topic:x"}).json()
        assert r["key"] == "chat:n"
        t = c.get(f"/v1/users/{user.id}/chats/chat:n").json()["turns"]
        assert [x["role"] for x in t] == ["user", "agent", "user"] and t[2]["note"] and t[2]["text"] == "下一步：先把数据整理好"
        tl = c.get(f"/v1/users/{user.id}/timeline", params={"days": 3}).json()
        assert {x["line"] for x in tl["sessions"] if x["item"] == "chat:n"} == {"topic:x"}
    with session_factory() as s2:
        u = s2.get(type(user), user.id)
        h = C.history(Runtime(s2, policy=policy, provider=provider, translation_backend=backend), u, "chat:n")
        assert h[-1]["text"].startswith("[the user's own note]")                       # the agent reads it as your note
