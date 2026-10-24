"""上下文折叠 (pga.fold): the older part of a long conversation, folded by topic instead of cut off."""
from __future__ import annotations

import json
from datetime import datetime, timedelta, timezone

from pga.db.models import AgentRun, WorldNode
from pga.fold import earlier, fold_turns


def turns(pairs):
    out = []
    for q, a in pairs:
        out += [{"role": "user", "text": q}, {"role": "assistant", "text": a}]
    return out


PAIRS = [("帮我改论文引言的第一段", "改好了：引言第一段现在先讲问题。"), ("引言再短一点", "缩到了三句。"),
         ("换个话题：周末去杭州玩什么", "西湖、灵隐寺。"), ("杭州住哪里方便", "住湖滨。"),
         ("PGA 的台面怎么拆模块", "拆成 layout 和 render。"), ("render 再拆细", "拆成三块。"),
         ("最近一问 1", "答 1"), ("最近一问 2", "答 2")]
SEGS = [{"from": 1, "to": 2, "title": "论文引言"}, {"from": 3, "to": 4, "title": "杭州周末"}, {"from": 5, "to": 8, "title": "PGA 台面"}]


def test_far_topics_fold_and_the_one_you_come_back_to_unfolds():
    t = fold_turns(turns(PAIRS), SEGS, "回到论文引言：第二段也按第一段的方式改", recent=2)
    assert t.startswith("<earlier_in_this_conversation")
    intro = t.split("[1–2]")[1].split("[3–4]")[0]
    assert "shown in full" in intro and "缩到了三句" in intro                      # the question comes back to it
    trip = t.split("[3–4]")[1].split("[5–6]")[0]
    assert "(folded)" in trip and "杭州住哪里方便" in trip and "住湖滨" in trip          # what was asked and where it got to
    assert "最近一问" not in t                                                     # the recent turns go as messages already


def test_short_conversations_need_no_folding_and_no_segments_means_one():
    assert fold_turns(turns(PAIRS[:2]), SEGS, "x", recent=6) == ""
    t = fold_turns(turns(PAIRS), [], "完全无关的问题", recent=6)
    assert "[1–2] earlier (folded)" in t


def test_an_ask_in_a_long_chat_gets_its_older_part_folded(rt, user):
    t0 = datetime(2026, 10, 2, tzinfo=timezone.utc)
    for i, (q, a) in enumerate(PAIRS):
        rt.session.add(AgentRun(user_id=user.id, workflow="ask", pattern="single", step="answer", agent="deepseek", adapter="llm",
                                status="succeeded", prompt=q, output=json.dumps({"answer": a}), started_at=t0 + timedelta(minutes=i),
                                finished_at=t0 + timedelta(minutes=i), data={"conversation": "chat:long", "agent": "deepseek"}))
    root = WorldNode(user_id=user.id, depth=0, kind="root", title="世界", data={})
    rt.session.add(root); rt.session.flush()
    rt.session.add(WorldNode(user_id=user.id, parent_id=root.id, depth=1, kind="leaf", title="长对话", ref="chat:long",
                             data={"segments": {"sig": "old", "list": SEGS}}))
    rt.session.flush()
    t = earlier(rt, user, "chat:long", "杭州周末还有什么好吃的", recent=4)
    assert "[3–4] 杭州周末 (shown in full" in t and "[1–2] 论文引言 (folded)" in t
    assert earlier(rt, user, "chat:long", "x", recent=8) == "" and earlier(rt, user, "c:imported", "x") == ""
