"""联想召回 (pga.associate): conversations the question does not mention, reached through the themes they share."""
from __future__ import annotations

from pga import associate as asc
from pga.db.models import WorldNode


ROWS = [("A", ["考试", "压力", "复习"]), ("B", ["压力", "失眠"]), ("C", ["考试", "报名", "计划"]),
        ("D", ["代码", "bug"]), ("E", ["报名", "截止日期"])]


def test_the_exam_comes_back_when_you_say_you_are_under_pressure():
    g = asc.build(ROWS)
    r = asc.recall(g, "最近压力好大，睡不好")
    ids = [x["id"] for x in r]
    assert {"A", "B"} <= set(ids) and all(x["direct"] for x in r if x["id"] in "AB")
    c = next(x for x in r if x["id"] == "C")
    assert not c["direct"] and "考试" in c["via"]                        # never mentioned: reached through 考试
    assert "D" not in ids                                                # unrelated stays out
    assert ids.index("C") < ids.index("E") if "E" in ids else True       # one hop further weighs less


def test_flow_is_bounded_directed_and_damped():
    g = asc.build(ROWS)
    for a, xs in g.out.items():
        assert sum(x for _, x in xs) <= asc.OUT_MASS + 1e-9               # a tag passes on at most its budget
    fwd = dict(g.out["考试"]).get("压力"); back = dict(g.out["压力"]).get("考试")
    assert fwd and back and fwd > back                                   # the written order is the easier way
    f = asc.spread(g, {"压力": 1.0})
    assert sum(f.values()) <= 1.0 + 1e-9 and f["压力"] == max(f.values())


def test_a_tag_everything_flows_into_is_damped():
    rows = [(f"x{i}", ["话题" + str(i), "代码"]) for i in range(12)] + [("y", ["话题0", "稀有想法"])]
    g = asc.build(rows)
    out = dict(g.out["话题0"])
    assert out["稀有想法"] > out["代码"]                                  # same evidence, but 代码 is a hub


def test_no_seed_no_recall():
    assert asc.recall(asc.build(ROWS), "今天天气怎么样") == []


def test_world_tree_conversations_carry_tags_and_the_ask_gets_associations(rt, user):
    root = WorldNode(user_id=user.id, depth=0, kind="root", title="世界", data={})
    rt.session.add(root); rt.session.flush()
    t = WorldNode(user_id=user.id, parent_id=root.id, depth=1, kind="topic", title="生活", data={})
    rt.session.add(t); rt.session.flush()
    leaves = {}
    for i, (lid, tags) in enumerate(ROWS):
        n = WorldNode(user_id=user.id, parent_id=t.id, depth=2, kind="leaf", title=f"对话{lid}", ref=f"chat:{lid}",
                      data={"tags": tags, "gist": f"关于{tags[0]}"})
        rt.session.add(n); rt.session.flush(); leaves[lid] = n
    text, xs = asc.block(rt, user.id, "最近压力好大", exclude={str(leaves["A"].id), str(leaves["B"].id)})
    assert "<associated_memories" in text and "对话C" in text and "考试" in text and leaves["C"] in xs
    assert "对话D" not in text
