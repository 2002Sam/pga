"""归档整理 (pga.consolidate): a folder tidied down to a handful of conversations, undoably."""
from datetime import datetime, timedelta, timezone
from types import SimpleNamespace

import pytest

from pga import consolidate, projectsort

NOW = datetime(2026, 10, 29, 12, tzinfo=timezone.utc)
PINNED = ["new1", "new2"]          # only pinned conversations stay out of a tidy


def item(key, title, days_ago, kind="chat", folder=""):
    return SimpleNamespace(key=key, title=title, project=folder, excerpt=title, kind=kind, agent="x", runs=["r"], turns=[2],
                           times=[NOW - timedelta(days=days_ago)], ref={})


class Sess:
    def __init__(self):
        self.added = []

    def add(self, x):
        self.added.append(x)

    def flush(self):
        pass


@pytest.fixture
def world(monkeypatch):
    items = [item(f"old{i}", f"resume v{i}", 10 + i) for i in range(12)] + [item("new1", "today", 0), item("new2", "yesterday", 1)]
    monkeypatch.setattr(consolidate, "_in_project", lambda rt, user, project, now: items)
    monkeypatch.setattr(consolidate, "_turns", lambda *a: [])
    monkeypatch.setattr(consolidate, "_tree", lambda rt, user: ({}, {}))
    monkeypatch.setattr(consolidate, "_place", lambda *a: 0)
    monkeypatch.setattr(consolidate, "_wt", lambda rt, user: None)
    user = SimpleNamespace(id="u", preferences={})
    rt = SimpleNamespace(session=Sess())
    return rt, user, items


def tree(items, topic_of):
    """A fake world tree: topic_of maps a conversation key to its topic title; two parents."""
    topics, leaves = {}, {}
    for key, tt in topic_of.items():
        if tt not in topics:
            topics[tt] = SimpleNamespace(id=tt, kind="topic", title=tt, summary=f"about {tt}", parent_id="p1" if len(topics) % 2 else "p2", depth=3)
        leaves[key] = SimpleNamespace(parent_id=tt, data={"gist": f"gist of {key}"}, kind="leaf", ref=key, depth=4)
    return leaves, topics


def test_pinned_stay_and_the_old_ones_group_by_their_world_tree_topic(world, monkeypatch):
    rt, user, items = world
    # 12 old ones in 9 topics: more than the 7 places left (10 - 3 kept) -> the model merges
    topic_of = {f"old{i}": f"topic{min(i, 8)}" for i in range(12)}
    monkeypatch.setattr(consolidate, "_tree", lambda rt, user: tree(items, topic_of))
    seen = {}

    def ask(rt_, u, system, prompt, now):
        seen["prompt"] = prompt
        return {"groups": [{"title": "简历", "from": ["g0", "g1"]}]}                     # the rest are left as they are

    p = consolidate.plan(rt, user, "简历投递", protect=["old0", "new1", "new2"], now=NOW, ask=ask)
    assert {k["key"] for k in p["keep"]} == {"new1", "new2", "old0"}
    keys = [m["key"] for g in p["groups"] for m in g["members"]]
    assert sorted(keys) == sorted(f"old{i}" for i in range(1, 12)) and len(keys) == len(set(keys))   # all others, none twice
    assert len(p["groups"]) <= consolidate.LIMIT - 3 and p["by"] == "model"
    assert "about topic" in seen["prompt"]                                                  # the model saw the topics' summaries
    assert all(m["gist"].startswith("gist of") for g in p["groups"] for m in g["members"])


def test_when_the_tree_already_fits_no_model_is_asked_and_when_the_model_is_down_a_rule_merges(world, monkeypatch):
    rt, user, items = world
    few = {f"old{i}": f"topic{i % 3}" for i in range(12)}
    monkeypatch.setattr(consolidate, "_tree", lambda rt, user: tree(items, few))
    p = consolidate.plan(rt, user, "x", protect=PINNED, now=NOW, ask=lambda *a: 1 / 0)
    assert len(p["groups"]) == 3 and p["by"] == "tree"
    many = {f"old{i}": f"topic{i}" for i in range(12)}
    monkeypatch.setattr(consolidate, "_tree", lambda rt, user: tree(items, many))

    def down(*a):
        raise consolidate.Deferred("no budget")

    p = consolidate.plan(rt, user, "x", protect=PINNED, now=NOW, ask=down)
    assert p["by"] == "rule" and len(p["groups"]) == consolidate.LIMIT - 2 and sum(len(g["members"]) for g in p["groups"]) == 12


def test_conversations_not_on_the_tree_share_one_group(world, monkeypatch):
    rt, user, items = world
    monkeypatch.setattr(consolidate, "_tree", lambda rt, user: ({}, {}))
    p = consolidate.plan(rt, user, "x", protect=PINNED, now=NOW, ask=lambda *a: 1 / 0)
    assert len(p["groups"]) == 1 and p["by"] == "none" and len(p["groups"][0]["members"]) == 12


def test_a_folder_within_the_limit_is_left_alone(world, monkeypatch):
    rt, user, _ = world
    monkeypatch.setattr(consolidate, "_in_project", lambda *a: [item("a", "one", 20), item("b", "two", 30)])
    assert consolidate.plan(rt, user, "x", protect=PINNED, now=NOW, ask=lambda *a: 1 / 0)["note"] == "within"


def test_apply_writes_one_conversation_archives_the_originals_and_can_be_undone(world):
    rt, user, _ = world
    r = consolidate.apply_group(rt, user, "简历投递", "简历版本", ["old1", "old2", "new1"], now=NOW, write=lambda *a: "## 做了什么\n投了简历")
    run = rt.session.added[0]
    assert r["n"] == 3 and "new1" in user.preferences["consolidated"][0]["members"]            # used today, not pinned: tidied too
    assert run.data["conversation"] == r["key"] and "投了简历" in run.output and run.prompt.startswith("🗃 简历版本")
    assert set(user.preferences["archived_chats"]) == {"old1", "old2", "new1"}
    assert projectsort.state(user)["of"][r["key"]] == "简历投递"
    consolidate.undo(rt, user, r["id"])
    assert user.preferences["archived_chats"] == [r["key"]]
    with pytest.raises(ValueError):
        consolidate.undo(rt, user, r["id"])


def deep_tree(n_old=12):
    """Three top topics, each with three subtopics; old{i} sits in subtopic i % 9."""
    top = {f"T{j}": SimpleNamespace(id=f"T{j}", kind="topic", title=f"top{j}", summary="", parent_id="root", depth=1) for j in range(3)}
    sub = {f"S{i}": SimpleNamespace(id=f"S{i}", kind="topic", title=f"sub{i}", summary=f"about sub{i}", parent_id=f"T{i // 3}", depth=2) for i in range(9)}
    root = {"root": SimpleNamespace(id="root", kind="root", title="世界", summary="", parent_id=None, depth=0)}
    leaves = {f"old{i}": SimpleNamespace(parent_id=f"S{i % 9}", data={"gist": f"gist {i}"}, kind="leaf", ref=f"old{i}", depth=3) for i in range(n_old)}
    return leaves, {**top, **sub, **root}


def test_the_finest_level_of_the_tree_that_fits_is_used_without_a_model(world, monkeypatch):
    rt, user, items = world
    monkeypatch.setattr(consolidate, "_tree", lambda rt, user: deep_tree())
    p = consolidate.plan(rt, user, "x", protect=PINNED, now=NOW, ask=lambda *a: 1 / 0)     # 9 subtopics > 8 places: cut one level up
    assert p["by"] == "tree" and len(p["groups"]) == 3
    assert {g["path"] for g in p["groups"]} == {"top0", "top1", "top2"} and all(g["how"] == "tree" for g in p["groups"])
    monkeypatch.setattr(consolidate, "_in_project", lambda *a: items[:10] + [item("new1", "today", 0)])
    p = consolidate.plan(rt, user, "x", protect=["new1"], now=NOW, ask=lambda *a: 1 / 0)     # 10 old in 9 subtopics, 9 places: the subtopics fit
    assert len(p["groups"]) == 9 and any(g["path"] == "top0 › sub0" for g in p["groups"])


def test_conversations_not_on_the_tree_are_placed_first(world, monkeypatch):
    rt, user, items = world
    full = deep_tree()
    state = {"placed": False}
    half = ({k: v for k, v in full[0].items() if k < "old5"}, full[1])
    monkeypatch.setattr(consolidate, "_tree", lambda rt, user: full if state["placed"] else half)

    def place(rt_, u, keys, now):
        state["placed"] = True
        return len(keys)

    monkeypatch.setattr(consolidate, "_place", place)
    p = consolidate.plan(rt, user, "x", protect=PINNED, now=NOW, ask=lambda *a: 1 / 0)
    assert p["placed"] > 0 and not any(g["how"] == "untreed" for g in p["groups"])


def test_a_merge_by_model_or_rule_says_so(world, monkeypatch):
    rt, user, items = world
    monkeypatch.setattr(consolidate, "_tree", lambda rt, user: tree(items, {f"old{i}": f"topic{i}" for i in range(12)}))

    def down(*a):
        raise consolidate.Deferred("no budget")

    p = consolidate.plan(rt, user, "x", protect=PINNED, now=NOW, ask=down)
    assert {g["how"] for g in p["groups"]} >= {"rule"} and any(" + " in g["path"] for g in p["groups"])


class FakeTree:
    """Enough of WorldTree for keeping it in step."""
    def __init__(self, leaves):
        self.leaves, self.added, self.stale = dict(leaves), [], []

    def leaf_of(self, user, ref):
        return self.leaves.get(ref)

    def root(self, user):
        return SimpleNamespace(id="root")

    def _add(self, user, parent, kind, title, ref=None, data=None):
        n = SimpleNamespace(id="newleaf", parent_id=parent.id, kind=kind, title=title, ref=ref, data=data or {})
        self.added.append(n)
        self.leaves[ref] = n
        return n

    def _stale(self, n):
        self.stale.append(getattr(n, "id", None))


def test_the_tree_follows_a_tidy_and_its_undo(world, monkeypatch):
    rt, user, _ = world
    leaves = {k: SimpleNamespace(id=k, parent_id="S1", data={"gist": k, "segments": {"list": [{"title": "简历"}, {"title": "面试"}]}}) for k in ("old1", "old2")}
    leaves["old3"] = SimpleNamespace(id="old3", parent_id="S2", data={})
    ft = FakeTree(leaves)
    monkeypatch.setattr(consolidate, "_wt", lambda rt, user: ft)
    monkeypatch.setattr(consolidate, "_tree", lambda rt, user: (leaves, {}))
    rt.session.get = lambda cls, nid: SimpleNamespace(id=nid)
    seen = {}

    def write(rt_, u, system, prompt, now):
        seen["p"] = prompt
        return "## 做了什么\n投了简历"

    r = consolidate.apply_group(rt, user, "简历投递", "简历版本", ["old1", "old2", "old3"], now=NOW, write=write)
    new = ft.added[0]
    assert new.parent_id == "S1" and new.ref == r["key"] and set(new.data["consolidated"]) == {"old1", "old2", "old3"}   # where most of them sat
    assert all(leaves[k].data.get("hidden") and leaves[k].data["merged_into"] == r["key"] for k in ("old1", "old2", "old3"))
    assert "S1" in ft.stale and "S2" in ft.stale and r["tree"] == "newleaf"
    assert "Matters in it: 简历 / 面试" in seen["p"]                                      # the segments were read
    consolidate.undo(rt, user, r["id"])
    assert not any(leaves[k].data.get("hidden") for k in ("old1", "old2", "old3")) and new.data["hidden"]
    assert consolidate.restored(rt, user, "old1") is False                                   # not hidden any more: nothing to do


def test_structure_merge_moves_conversations_never_a_folder_of_your_own_and_undoes(monkeypatch):
    user = SimpleNamespace(id="u", preferences={})
    items = [item("a", "t", 5, folder="alpha"), item("b", "t", 5, folder="beta"), item("c", "t", 5, folder="PGA")]
    st = projectsort.state(user)
    st["list"] += ["alpha", "beta"]
    st["of"] = {"a": "alpha", "b": "beta", "c": "PGA"}
    projectsort.save(user, st)

    class TL:
        def __init__(self, rt): pass
        def items(self, u, since): return items

    monkeypatch.setattr("pga.timeline.Timeline", TL)
    seen = {}

    def ask(rt, u, system, prompt, now):
        seen["p"] = prompt
        return {"merges": [{"from": ["alpha", "PGA"], "to": "beta", "why": "x"}], "renames": []}

    topic = SimpleNamespace(id="t", kind="topic", title="求职", summary="", parent_id=None, depth=2)
    monkeypatch.setattr(consolidate, "_tree", lambda rt, u: ({k: SimpleNamespace(parent_id="t", data={}, depth=3) for k in "abc"}, {"t": topic}))
    p = consolidate.structure_plan(None, user, now=NOW, ask=ask)
    assert p["overlaps"] and "求职" in seen["p"] and "Overlapping pairs" in seen["p"]    # the folders share a world-tree topic: said to the model
    assert p["merges"][0]["from"] == ["alpha"]                                # PGA is yours: not merged away
    r = consolidate.structure_apply(None, user, p["merges"], [], now=NOW)
    st = projectsort.state(user)
    assert st["of"]["a"] == "beta" and "alpha" not in st["list"]
    assert projectsort.project_of(st, "a", "alpha") == "beta"
    consolidate.undo(None, user, r["id"])
    st = projectsort.state(user)
    assert st["of"]["a"] == "alpha" and "alpha" in st["list"]


def test_routes_are_wired(session_factory, policy, provider, backend):
    from fastapi.testclient import TestClient
    from pga.api.app import create_app
    from pga.runtime import Runtime
    app = create_app(session_factory=session_factory,
                     runtime_factory=lambda s: Runtime(s, policy=policy, provider=provider, translation_backend=backend))
    with TestClient(app) as c:
        uid = c.post("/v1/users", json={"locale": "zh-CN"}).json()["id"]
        r = c.post(f"/v1/users/{uid}/consolidate/plan", json={"project": "简历投递"})
        assert r.status_code == 200 and r.json()["note"] == "within"
        assert c.post(f"/v1/users/{uid}/consolidate/structure/plan").json()["note"] == "few"
        assert c.post(f"/v1/users/{uid}/consolidate/undo", json={"id": "nope"}).status_code == 422
        assert c.get(f"/v1/users/{uid}/consolidate").json() == {"log": []}


def test_net_probe_reports_each_target(monkeypatch):
    import httpx
    from pga import netenv

    def fake_get(url, **kw):
        if "baidu" in url:
            raise httpx.ConnectTimeout("slow")
        return SimpleNamespace(status_code=401)

    monkeypatch.setattr(httpx, "get", fake_get)
    r = netenv.probe()
    bad = [x for x in r["results"] if not x["ok"]]
    assert [x["name"] for x in bad] == ["百度"] and "ConnectTimeout" in bad[0]["error"] and len(r["results"]) == len(netenv.TARGETS)


def test_merges_of_says_what_was_folded_into_a_conversation_and_what_it_was_folded_into(world):
    rt, user, _ = world
    r = consolidate.apply_group(rt, user, "简历投递", "简历版本", ["old1", "old2"], now=NOW, write=lambda *a: "笔记")
    note = consolidate.merges_of(rt, user, r["key"])
    assert {m["key"] for m in note["from"]} == {"old1", "old2"} and note["into"] is None
    assert consolidate.merges_of(rt, user, "old1")["into"]["key"] == r["key"]
    consolidate.undo(rt, user, r["id"])
    assert consolidate.merges_of(rt, user, "old1") == {"into": None, "from": []}
