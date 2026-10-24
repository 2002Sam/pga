"""做梦 (pga.dream): looking back over a few conversations while you are away, proposing tidying that waits for you."""
from __future__ import annotations

import random
from datetime import datetime, timedelta, timezone

import pytest

from pga.db.models import WorldNode
from pga.dream import Dreamer
from pga.knowledge.datasets import Datasets


@pytest.fixture
def tree(rt, user):
    root = WorldNode(user_id=user.id, depth=0, kind="root", title="世界", data={})
    rt.session.add(root); rt.session.flush()
    life = WorldNode(user_id=user.id, parent_id=root.id, depth=1, kind="topic", title="生活", data={})
    study = WorldNode(user_id=user.id, parent_id=root.id, depth=1, kind="topic", title="学习", data={})
    rt.session.add_all([life, study]); rt.session.flush()
    rows = [("考试复习计划", life, ["考试", "复习"]), ("压力好大睡不着", life, ["压力", "考试", "失眠"]),
            ("报名截止时间", study, ["考试", "报名"]), ("周末去哪玩", life, ["周末", "旅行"])]
    leaves = []
    for i, (t, p, tags) in enumerate(rows):
        n = WorldNode(user_id=user.id, parent_id=p.id, depth=2, kind="leaf", title=t, ref=f"chat:{i}",
                      data={"tags": tags, "gist": t, "last": f"2026-10-0{i + 1}"})
        rt.session.add(n); rt.session.flush(); leaves.append(n)
    return root, life, study, leaves


def scripted(calls):
    def ask(user, system, prompt, why, max_tokens=3000, now=None):
        calls.append(prompt)
        codes = {line.split(" | ")[2].strip(): line.split(" | ")[0].split(" ")[0] for line in prompt.splitlines() if line.startswith("L")}
        t = {line.split(" ", 1)[1].strip(): line.split(" ")[0] for line in prompt.splitlines() if line.startswith("T")}
        return {"narrative": "这几段都绕着考试：从计划到压力，再到报名。",
                "ops": [{"type": "group", "leaves": [codes["报名截止时间"]], "topic": t["生活"], "why": "都是这场考试"},
                        {"type": "archive", "leaves": [codes.get("周末去哪玩", "L9")], "why": "已经结束"},
                        {"type": "insight", "dim": "state", "text": "最近在准备一场考试，压力不小", "from": ["L1"], "why": "反复出现"},
                        {"type": "group", "leaves": ["L99"], "topic": "T1", "why": "不存在的对话"},
                        {"type": "delete_everything", "why": "不该出现"}]}
    return ask


def test_a_dream_follows_the_links_and_its_proposals_wait_for_you(rt, user, tree):
    root, life, study, leaves = tree
    dm = Dreamer(rt, random.Random(1))
    calls = []
    dm.wt._ask = scripted(calls)
    d = dm.dream(user)
    assert d is not None and "考试" in d.narrative and d.status == "pending"
    assert [o["type"] for o in d.ops] == ["group", "archive", "insight"]           # the made-up and the unknown ones are dropped
    assert all(o["status"] == "pending" for o in d.ops)
    assert leaves[2].parent_id == study.id                                          # nothing changed yet
    assert all((n.data or {}).get("dreamt_at") for n in leaves if str(n.id) in d.seeds)
    dm.decide(user, d, 0, True)
    assert leaves[2].parent_id == life.id
    dm.decide(user, d, 2, True)
    me = Datasets(rt).ensure(user)["user"]
    assert "最近在准备一场考试，压力不小" in me.data["dims"]["state"]["stated"]
    dm.decide(user, d, 1, False, "这段旅行还没去")
    assert not (leaves[3].data or {}).get("hidden") and d.status == "done" and d.ops[1]["reason"] == "这段旅行还没去"
    with pytest.raises(ValueError):
        dm.decide(user, d, 1, True)                                                 # decided already
    dm.dream(user)
    assert "这段旅行还没去" in calls[-1]                                              # the next dream reads your reason


def test_it_dreams_only_when_you_have_been_away_and_not_too_often(rt, user, tree, monkeypatch):
    from pga import idle
    from pga.worldtree import WorldTree
    monkeypatch.setattr(WorldTree, "built", lambda self, u: True)
    dm = Dreamer(rt)
    now = datetime(2026, 10, 24, 3, tzinfo=timezone.utc)
    user.preferences = {**(user.preferences or {}), "idle_state": {"last": (now - timedelta(minutes=10)).isoformat()}}
    assert not dm.due(user, now)                                                    # you were here ten minutes ago
    user.preferences = {**user.preferences, "idle_state": {"last": (now - timedelta(hours=3)).isoformat()}}
    assert dm.due(user, now)
    dm.wt._ask = scripted([])
    d = dm.dream(user, now)
    assert not dm.due(user, now + timedelta(hours=2)) and dm.due(user, now + timedelta(hours=21))
    user.preferences = {**user.preferences, "dream": {"on": False}}
    assert not dm.due(user, now + timedelta(hours=21))
