"""The finest level of the world tree (pga.segments): a conversation split by what was asked, its data tree, and every
question in one index file."""
from __future__ import annotations

import json
from datetime import datetime, timezone

from pga import segments as sg
from pga.db.models import AgentRun, WorldNode


def turn(rt, user, key, q, a, h, **data):
    t = datetime(2026, 10, 2, h, tzinfo=timezone.utc)
    r = AgentRun(user_id=user.id, workflow="ask", pattern="single", step="answer", agent="deepseek", adapter="llm", status="succeeded",
                 prompt=q, output=json.dumps({"answer": a}), started_at=t, finished_at=t, data={"conversation": key, "agent": "deepseek", **data})
    rt.session.add(r)
    rt.session.flush()
    return r


def leaf(rt, user, ref, title="一段对话"):
    root = WorldNode(user_id=user.id, depth=0, kind="root", title="世界", data={})
    rt.session.add(root)
    rt.session.flush()
    t = WorldNode(user_id=user.id, parent_id=root.id, depth=1, kind="topic", title="研究", data={})
    rt.session.add(t)
    rt.session.flush()
    n = WorldNode(user_id=user.id, parent_id=t.id, depth=2, kind="leaf", title=title, ref=ref, data={})
    rt.session.add(n)
    rt.session.flush()
    return n


def test_a_conversation_splits_where_you_moved_to_another_matter(rt, user, monkeypatch):
    turn(rt, user, "chat:x", "<recommended_plugins>Airtable…</recommended_plugins>", "", 0)          # put there by the app, not asked
    for i, q in enumerate(["帮我改引言", "再短一点", "换个话题：周末去哪玩", "<user_query>天气呢</user_query>"]):
        turn(rt, user, "chat:x", q, "好", i + 1)
    n = leaf(rt, user, "chat:x")
    calls = []

    def fake(rt_, user_, prompt, k, now):
        calls.append(prompt)
        return {"segments": [{"from": 1, "to": 2, "title": "改引言"}, {"from": 4, "to": 9, "title": "周末"}]}     # a gap and an overrun
    monkeypatch.setattr(sg, "_ask", fake)
    qs = sg.questions(rt, user, "chat:x")
    assert [q["text"] for q in qs][-1] == "天气呢" and qs[0]["run"]
    segs = sg.segments(rt, user, n)
    assert [(s["from"], s["to"], s["title"]) for s in segs] == [(1, 3, "改引言"), (4, 4, "周末")]
    assert [q["text"] for q in segs[0]["questions"]] == ["帮我改引言", "再短一点", "换个话题：周末去哪玩"]
    sg.segments(rt, user, n)
    assert len(calls) == 1                                                   # kept until the conversation changes
    turn(rt, user, "chat:x", "最后一问", "好", 9)
    sg.segments(rt, user, n)
    assert len(calls) == 2


def test_one_question_is_one_segment_without_a_model(rt, user, monkeypatch):
    turn(rt, user, "chat:y", "只问一件事", "好", 1)
    n = leaf(rt, user, "chat:y", "只问一件事")
    monkeypatch.setattr(sg, "_ask", lambda *a: (_ for _ in ()).throw(AssertionError("no model for one question")))
    assert [(s["from"], s["to"]) for s in sg.segments(rt, user, n)] == [(1, 1)]


def test_the_data_tree_shows_what_a_conversation_read_cited_and_did(rt, user):
    r = turn(rt, user, "chat:z", "看看代码", "看了", 1, attachments=["/tmp/ws/uploads/1-1-spec.pdf"],
             context_used={"topic": {"id": "t1", "title": "研究"}, "related": [{"ref": "chat:a", "title": "旧对话", "world": "w1"}],
                           "datasets": [{"id": "d1", "title": "论文笔记"}]})
    rt.session.add(AgentRun(user_id=user.id, parent_id=r.id, workflow="ask", pattern="single", step="answer", agent="claude", adapter="claude_code",
                            status="succeeded", prompt="", output="", data={"trace": "→ Read ~/proj/a.py\n→ Edit ~/proj/b.py\n→ WebFetch https://x.org\n→ Skill pdf\n→ mcp__github__get_issue 3\n$ pytest -q"}))
    rt.session.flush()
    c = sg.context(rt, user, "chat:z")
    assert c["topic"]["title"] == "研究" and c["related"][0]["ref"] == "chat:a" and c["datasets"][0]["title"] == "论文笔记"
    assert c["attachments"] == ["1-1-spec.pdf"] and c["read"] == ["~/proj/a.py"] and c["changed"] == ["~/proj/b.py"]
    assert c["web"] == ["https://x.org"] and c["skills"] == ["pdf"] and c["tools"] == ["get_issue"] and c["commands"] == 1


def test_every_question_goes_into_one_index_file(rt, user, tmp_path):
    turn(rt, user, "chat:x", "第一个问题", "好", 1)
    turn(rt, user, "chat:x", "第二个问题", "好", 2)
    leaf(rt, user, "chat:x", "我的对话")
    r = sg.build_index(rt, user, tmp_path / "q.md")
    text = (tmp_path / "q.md").read_text()
    assert r["questions"] == 2 and r["conversations"] == 1
    assert "## 研究" in text and "**我的对话**" in text and "第一个问题" in text and "第二个问题" in text
