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
        if system.startswith("For each conversation write a gist"):
            return {f"i{i}": f"主旨{i}" for i in range(80)}
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


def test_every_conversation_gets_a_gist_and_you_can_add_edit_remove_and_find_topics(rt, user, tree):
    wt, _ = tree
    wt.build(user)
    chat(rt, user, "chat:e", "世界模型的物理规律怎么嵌入", datetime(2026, 10, 6, tzinfo=timezone.utc))
    r = wt.place(user)
    assert r["annotated"] >= 1 and all((n.data or {}).get("gist") for n in wt.nodes(user.id) if n.kind == "leaf")
    research = by_title(wt, user, "进行研究")
    mine = wt.add_topic(user, research, "我自己加的", "我写的概括")
    wt.refresh(user)
    assert mine.summary == "我写的概括"                                           # your words are kept
    wt.edit(user, mine, title="改过的名字", summary="新的概括")
    assert mine.title == "改过的名字" and mine.summary == "新的概括"
    world = by_title(wt, user, "世界模型研究")
    leaf = wt.leaf_of(user, "chat:a")
    wt.move(user, leaf, mine)
    out = wt.remove(user, mine)
    assert out["moved_up"] == 1 and leaf.parent_id == research.id                    # its parts move up a level
    wt.remove(user, leaf)
    assert (leaf.data or {}).get("hidden") and wt.place(user)["placed"] == 0           # gone from the tree, not placed again
    assert any(n.id == world.id for n in wt.search(user, "世界模型"))
    import pytest as _p
    with _p.raises(ValueError):
        wt.remove(user, wt.root(user))


def test_annotating_writes_ordered_tags_that_link_conversations(rt, user, tree, monkeypatch):
    wt, m = tree
    wt.build(user)
    def tagged(user_, system, prompt, why, max_tokens=3000, now=None):
        assert "tags" in system and "most central first" in system
        return {f"i{i}": {"gist": f"主旨{i}", "tags": ["世界模型", f"主题{i}"]} for i in range(80)}
    monkeypatch.setattr(wt, "_ask", tagged)
    for n in wt.nodes(user.id):
        if n.kind == "leaf":
            n.data = {k: v for k, v in (n.data or {}).items() if k != "tags"}
    assert wt.annotate(user) >= 3
    leaf = wt.leaf_of(user, "chat:a")
    assert leaf.data["tags"][0] == "世界模型" and leaf.data["gist"]
    assert wt.annotate(user) == 0                                     # done once


def test_a_tidy_keeps_the_tree_in_step_and_its_undo_puts_it_back(rt, user, tree, monkeypatch):
    """归档整理 (pga.consolidate) on the real tree: the 🗃 conversation takes the originals' place, they are hidden, a later
    pass does not bring them back, and undo or 已归档 → 放回 shows them again."""
    from pga import consolidate, projectsort
    wt, m = tree
    wt.build(user)
    monkeypatch.setattr("pga.worldtree.WorldTree._ask", lambda self, *a, **k: m(*a, **k))
    t0 = datetime(2026, 10, 1, tzinfo=timezone.utc)
    chat(rt, user, "chat:a2", "世界模型的空间表征 再问一次", t0 + timedelta(hours=1))
    wt.place(user)
    world = by_title(wt, user, "世界模型研究")
    project = projectsort.project_of(projectsort.state(user), "chat:a", "")
    now = t0 + timedelta(days=10)
    r = consolidate.apply_group(rt, user, project, "世界模型", ["chat:a", "chat:a2"], now=now, write=lambda *a: "## 做了什么\n空间表征")
    new = wt.leaf_of(user, r["key"])
    assert new is not None and new.parent_id == world.id and r["tree"] == str(new.id)
    assert all((wt.leaf_of(user, k).data or {}).get("merged_into") == r["key"] for k in ("chat:a", "chat:a2"))
    assert (world.data or {}).get("stale")
    assert wt.place(user)["placed"] == 0 and (wt.leaf_of(user, "chat:a").data or {}).get("hidden")   # archived: not placed again
    consolidate.restored(rt, user, "chat:a")                                                     # 已归档 → 放回 one of them
    assert not (wt.leaf_of(user, "chat:a").data or {}).get("hidden")
    consolidate.undo(rt, user, r["id"])
    assert not (wt.leaf_of(user, "chat:a2").data or {}).get("hidden") and (wt.leaf_of(user, r["key"]).data or {}).get("hidden")
