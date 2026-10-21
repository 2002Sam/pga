"""世界树: conversations grouped into a tree of topics, summarised level by level, new ones finding their place,
and a topic you can talk to (pga.worldtree)."""
from __future__ import annotations

import json
from datetime import datetime, timedelta, timezone

import pytest

from pga.aims import AimService
from pga.db.models import AgentRun, WorldNode
from pga.worldtree import WorldTree, chat_node, set_chat_node


class Scripted:
    """Stands in for the model: answers by what the system prompt asks for."""
    def __init__(self):
        self.calls = []

    def __call__(self, user, system, prompt, why, max_tokens=3000, now=None):
        self.calls.append(why)
        if "library's subject tree" in system:
            return {"tree": [{"title": "进行研究", "children": [{"title": "世界模型研究", "children": []}, {"title": "论文写作", "children": []}]},
                             {"title": "开发软件", "children": [{"title": "PGA", "children": []}]}]}
        if "place a person's conversations" in system:
            out, new = {}, []
            for line in prompt.splitlines():
                if line.startswith("i") and " | " in line:
                    k = line.split(" | ")[0]
                    out[k] = "1.1" if "世界模型" in line else "1.2" if "论文" in line else "2.1" if "PGA" in line else "9"
                    if "股票" in line:
                        new.append({"under": "1", "title": "投资", "items": [k]})
            return {"assign": out, "new": new}
        if "write the summary of each topic" in system:
            return {f"t{i}": f"总结{i}" for i in range(12)}
        if "how a topic of a person's work should grow" in system:
            return {"next": [{"title": "下一步 A", "why": "因为"}, {"title": "下一步 B", "why": "所以"}]}
        return {}


def chat(rt, user, key, text, at):
    rt.session.add(AgentRun(user_id=user.id, workflow="ask", pattern="single", step="answer", agent="deepseek", adapter="llm", status="succeeded", prompt=text, output=json.dumps({"answer": "好"}),
                            started_at=at, finished_at=at, data={"conversation": key, "agent": "deepseek"}))
    rt.session.flush()


@pytest.fixture
def tree(rt, user, monkeypatch):
    t0 = datetime(2026, 10, 1, tzinfo=timezone.utc)
    chat(rt, user, "chat:a", "世界模型的空间表征怎么学", t0)
    chat(rt, user, "chat:b", "帮我改论文的引言", t0 + timedelta(hours=3))
    chat(rt, user, "chat:c", "PGA 的前端怎么拆模块", t0 + timedelta(hours=6))
    AimService(rt.session).create(user, "让 PGA 自己进化", "Let PGA evolve")
    wt = WorldTree(rt)
    m = Scripted()
    monkeypatch.setattr(wt, "_ask", m)
    return wt, m


def by_title(wt, user, title):
    return next(n for n in wt.nodes(user.id) if n.title == title)


def test_built_from_your_conversations_with_summaries_from_the_bottom_up(rt, user, tree):
    wt, m = tree
    r = wt.build(user)
    assert r["placed"] == 4 and wt.built(user)
    research, world = by_title(wt, user, "进行研究"), by_title(wt, user, "世界模型研究")
    leaf = wt.leaf_of(user, "chat:a")
    assert [x.title for x in wt.path(leaf)][:3] == ["世界", "进行研究", "世界模型研究"] and leaf.parent_id == world.id
    assert world.summary.startswith("总结") and research.summary and not (world.data or {}).get("stale")
    assert wt.leaf_of(user, "chat:b").parent_id == by_title(wt, user, "论文写作").id
    assert any(n.kind == "aim" for n in wt.nodes(user.id))                       # the motivation has its place too
    summaries = [c for c in m.calls if c.startswith("summarising")]
    assert len(summaries) >= 2                                                  # deepest level first, then the ones above


def test_a_new_conversation_finds_its_place_and_its_topics_are_summarised_again(rt, user, tree):
    wt, m = tree
    wt.build(user)
    world = by_title(wt, user, "世界模型研究")
    world.data = {**world.data, "stale": False}
    chat(rt, user, "chat:d", "股票和指数基金怎么配置", datetime(2026, 10, 5, tzinfo=timezone.utc))
    r = wt.place(user)
    assert r["placed"] == 1
    leaf = wt.leaf_of(user, "chat:d")
    assert wt.path(leaf)[-2].title == "投资" and wt.path(leaf)[-3].title == "进行研究"     # a topic opened where none fit
    assert (by_title(wt, user, "进行研究").data or {}).get("stale")
    wt.refresh(user)
    assert not (by_title(wt, user, "进行研究").data or {}).get("stale")


def test_talking_to_a_topic_reads_its_summary_parts_and_matching_conversations(rt, user, tree):
    wt, _ = tree
    wt.build(user)
    research = by_title(wt, user, "进行研究")
    ctx = wt.context(research)
    assert "进行研究" in ctx and "世界模型研究" in ctx and "论文写作" in ctx
    assert "空间表征" in wt.related(research, "空间表征学习的进展")
    set_chat_node(user, "chat:new", str(research.id))
    assert chat_node(user, "chat:new") == str(research.id)
    set_chat_node(user, "chat:new", None)
    assert chat_node(user, "chat:new") is None


def test_you_can_move_rename_and_grow_a_topic_downwards(rt, user, tree):
    wt, _ = tree
    wt.build(user)
    paper, research, dev = by_title(wt, user, "论文写作"), by_title(wt, user, "进行研究"), by_title(wt, user, "开发软件")
    wt.move(user, paper, dev)
    assert paper.parent_id == dev.id and paper.depth == 2
    with pytest.raises(ValueError):
        wt.move(user, dev, paper)                                              # not under itself
    made = wt.expand(user, research)
    assert [x.title for x in made] == ["下一步 A", "下一步 B"] and all(x.kind == "plan" for x in made)
    assert rt.session.query(WorldNode).filter(WorldNode.kind == "plan").count() == 2
