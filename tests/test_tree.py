"""The thought tree: a long self-dialogue cut into a few nodes, with branches; continue from any node."""

from __future__ import annotations

import json
import subprocess
from datetime import datetime, timedelta, timezone

from fastapi.testclient import TestClient

from pga.aims import AimService
from pga.api.app import create_app
from pga.db.models import AimNote, PerpetualTask, Project, ThoughtNode
from pga.llm.router import default_fake_reply
from pga.runtime import Runtime
from pga.tree import ThoughtTree, github_url


def _dialogue(rt, user, aim, n=40, start=None):
    t0 = start or datetime.now(timezone.utc) - timedelta(hours=5)
    for i in range(n):
        kind = "question" if i % 2 == 0 else "answer"
        rt.session.add(AimNote(user_id=user.id, aim_id=aim.id, kind=kind, agent="gpt", role="researcher",
                               text=f"{kind} {i} about {'cache' if i < 20 else 'notifications'}", status="answered",
                               data={"code": f"Q{i // 2 + 1}", **({"evidence": ["src/pga/a.py:3"]} if kind == "answer" else {}),
                                     **({"samples": [{"n": 1}, {"n": 2}, {"n": 3}], "divergence": .6} if i == 5 else {})},
                               created_at=t0 + timedelta(minutes=i)))
    rt.session.add(AimNote(user_id=user.id, aim_id=aim.id, kind="insight", agent="gpt", text="cache per topic, not globally",
                           data={"inspiration": True}, created_at=t0 + timedelta(minutes=6, seconds=30)))
    rt.session.flush()


def _curator(system, messages):
    if system.startswith("You keep the thought tree"):
        body = messages[-1]["content"]
        if "node " in body.split("Latest node:")[0]:          # second window: extend, then return to the first thread
            return json.dumps({"extend_latest_until": -1, "nodes": []})
        return json.dumps({"extend_latest_until": -1, "nodes": [
            {"from": 0, "to": 20, "parent": "root", "title": "缓存为什么老是失效", "summary": "查了缓存。", "key_thoughts": ["TTL 太短"], "shift": "开始"},
            {"from": 21, "to": 30, "parent": "new:0", "title": "通知太多", "summary": "转向通知。", "key_thoughts": [], "shift": "缓存查清了"},
            {"from": 31, "to": 31, "parent": "new:0", "title": "一个太小的节点", "summary": "", "key_thoughts": [], "shift": ""},
            {"from": 32, "to": 40, "parent": "new:0", "title": "回到缓存：按主题设阈值", "summary": "又回到缓存。", "key_thoughts": [], "shift": "灵感"}]})
    return default_fake_reply("m", system, messages)


def test_the_curator_cuts_a_long_dialogue_into_few_nodes_with_branches(rt, user, provider):
    aim = AimService(rt.session).create(user, "让项目不断思考", "Keep the project thinking")
    _dialogue(rt, user, aim, n=100)
    provider.handler = _curator
    tree = ThoughtTree(rt)
    out = tree.curate(user, aim, windows=2)
    nodes = [n for n in tree.nodes(aim.id) if n.kind == "segment"]
    assert out["mode"] == "model" and out["pending"] == 0
    assert len(nodes) == 90 // 25 and sum(len(n.note_ids) for n in nodes) == 101          # every turn placed, few nodes
    assert "一个太小的节点" not in [n.title for n in nodes]                                # the smallest was merged away
    root = nodes[0]
    assert root.parent_id is None and root.title == "缓存为什么老是失效" and root.key_thoughts == ["TTL 太短"]
    assert all(n.parent_id == root.id for n in nodes[1:])                               # what grows grows off the first node
    d = root.data
    assert d["sampled"] == 1 and d["samples"] == 3 and d["spread"] == .6 and d["buds"][0]["idea"].startswith("cache per topic")
    assert d["codes"][0] == "Q1" and nodes[-1].data["tip"]


def test_without_a_model_the_tree_still_grows_by_pauses(rt, user):
    aim = AimService(rt.session).create(user, "目标", "aim")
    _dialogue(rt, user, aim, n=10)
    _dialogue(rt, user, aim, n=6, start=datetime.now(timezone.utc) - timedelta(hours=1))
    tree = ThoughtTree(rt)
    out = tree.curate(user, aim, use_model=False)
    nodes = tree.nodes(aim.id)
    assert out["mode"] == "rule" and len(nodes) == 2 and nodes[1].parent_id == nodes[0].id


def test_continue_from_a_node_grows_your_branch_and_can_focus_the_team(session_factory, policy, provider, backend, user, session, tmp_path):
    repo = tmp_path / "repo"
    (repo / "src" / "pga").mkdir(parents=True)
    (repo / "src" / "pga" / "a.py").write_text("x = 1\n")
    g = ["git", "-C", str(repo), "-c", "user.name=t", "-c", "user.email=t@t"]
    subprocess.run(["git", "init", "-q", str(repo)], check=True)
    subprocess.run(g + ["remote", "add", "origin", "git@github.com:me/proj.git"], check=True)
    subprocess.run(g + ["add", "-A"], check=True)
    subprocess.run(g + ["commit", "-qm", "first"], check=True, env={"GIT_COMMITTER_DATE": "2020-01-01T00:00:00", "GIT_AUTHOR_DATE": "2020-01-01T00:00:00", "PATH": "/usr/bin:/bin:/usr/local/bin:/opt/homebrew/bin"})
    rt = Runtime(session, policy=policy, provider=provider, translation_backend=backend)
    aim = AimService(session).create(user, "让项目不断思考", "Keep the project thinking")
    proj = Project(user_id=user.id, name="P", path=str(repo), aim_id=aim.id, created_at=datetime.now(timezone.utc))
    session.add(proj)
    session.flush()
    session.add(PerpetualTask(user_id=user.id, aim_id=aim.id, project_id=proj.id, status="paused", settings={}))
    _dialogue(rt, user, aim, n=12)
    tree = ThoughtTree(rt)
    tree.curate(user, aim, use_model=False)
    node = tree.nodes(aim.id)[0]
    assert node.git["repo"] == "https://github.com/me/proj" and node.git["files"][0]["path"] == "src/pga/a.py"
    assert node.git["files"][0]["url"].endswith("/src/pga/a.py#L3")
    session.commit()
    app = create_app(session_factory=session_factory,
                     runtime_factory=lambda s: Runtime(s, policy=policy, provider=provider, translation_backend=backend))
    with TestClient(app) as c:
        t = c.get(f"/v1/aims/{aim.id}/tree").json()
        assert t["repo"] == "https://github.com/me/proj" and len(t["nodes"]) == 1
        r = c.post(f"/v1/thought-nodes/{node.id}/continue", json={"text": "那如果按主题设阈值呢？", "agent": "auto", "focus": True})
        assert r.status_code == 200, r.text
        b = r.json()["node"]
        assert b["kind"] == "user" and b["parent"] == str(node.id) and b["turns"] >= 1
        again = c.post(f"/v1/thought-nodes/{b['id']}/continue", json={"text": "再具体一点"}).json()["node"]
        assert again["id"] == b["id"]                                                     # your branch continues in place
        d = c.get(f"/v1/thought-nodes/{b['id']}").json()
        assert [p["id"] for p in d["path"]] == [str(node.id), b["id"]] and d["notes"][0]["agent"] == "you"
        t = c.get(f"/v1/aims/{aim.id}/tree").json()
        assert t["focus"] == b["id"]
        assert c.post(f"/v1/aims/{aim.id}/tree/focus", json={"node_id": None}).json() == {"focus": None}
    session.expire_all()
    assert session.get(ThoughtNode, node.id) is not None


def test_github_links_from_any_remote():
    assert github_url("git@github.com:2002Sam/pga.git") == "https://github.com/2002Sam/pga"
    assert github_url("ssh://git@ssh.github.com:443/2002Sam/pga.git") == "https://github.com/2002Sam/pga"
    assert github_url("https://github.com/a/b") == "https://github.com/a/b" and github_url("git@gitlab.com:a/b.git") is None


def test_node_operations_distill_reference_and_exchange(session_factory, policy, provider, backend, user, session):
    """Rename, hide, move, merge, a new branch, delete; distill a line of thought, let another tree refer to it; two branches talk."""
    from pga.db.models import Body

    rt = Runtime(session, policy=policy, provider=provider, translation_backend=backend)
    aims = AimService(session)
    aim = aims.create(user, "让项目不断思考", "Keep the project thinking")
    other_aim = aims.create(user, "健康", "Stay healthy")
    _dialogue(rt, user, aim, n=10)
    _dialogue(rt, user, aim, n=6, start=datetime.now(timezone.utc) - timedelta(hours=1))
    tree = ThoughtTree(rt)
    tree.curate(user, aim, use_model=False)
    a, b = tree.nodes(aim.id)

    def handler(system, messages):
        if "<line_A>" in system:
            return "## A 能从 B 借鉴\n按主题设阈值。"
        if system.startswith("You keep one curated knowledge document"):
            return "# 这条思路\n\nThe team found the cache TTL too short and decided to make it per topic. " * 4
        return default_fake_reply("m", system, messages)
    provider.handler = handler
    session.commit()
    app = create_app(session_factory=session_factory,
                     runtime_factory=lambda s: Runtime(s, policy=policy, provider=provider, translation_backend=backend))
    with TestClient(app) as c:
        r = c.patch(f"/v1/thought-nodes/{b.id}", json={"title": "缓存：按主题", "hidden": True}).json()
        assert r["title"] == "缓存：按主题" and r["hidden"] and r["edited"]
        assert c.patch(f"/v1/thought-nodes/{a.id}", json={"parent_id": str(b.id)}).status_code == 409    # not under its own child
        nb = c.post(f"/v1/thought-nodes/{a.id}/branch", json={"title": "试试别的缓存"}).json()
        assert nb["kind"] == "user" and nb["parent"] == str(a.id) and nb["turns"] == 0
        assert c.delete(f"/v1/thought-nodes/{a.id}").status_code == 409                                    # the team's dialogue stays
        assert c.delete(f"/v1/thought-nodes/{nb['id']}").status_code == 204
        md = c.get(f"/v1/thought-nodes/{a.id}/markdown").text
        assert md.startswith("# ") and "## 对话" in md
        d = c.post(f"/v1/thought-nodes/{a.id}/distill").json()
        assert d["status"] == "compiled" and d["dataset"]["system"] == "branch"
        body_id = d["dataset"]["id"]
        assert c.post(f"/v1/aims/{other_aim.id}/references", json={"body_id": body_id}).status_code == 201
        t2 = c.get(f"/v1/aims/{other_aim.id}/tree").json()
        assert [x["id"] for x in t2["knowledge"]["references"]] == [body_id]
        f = c.get(f"/v1/users/{user.id}/forest").json()
        assert {t["text"] for t in f["trees"]} == {"让项目不断思考", "健康"}
        assert next(k for k in f["knowledge"] if k["id"] == body_id)["used_by"] == [str(other_aim.id)]
        x = c.post(f"/v1/thought-nodes/{a.id}/exchange", json={"with": str(b.id)}).json()
        assert x["node"]["kind"] == "exchange" and x["node"]["with"] == str(b.id) and x["node"]["parent"] == str(a.id)
        merged = c.post(f"/v1/thought-nodes/{b.id}/merge").json()
        assert merged["id"] == str(a.id) and merged["turns"] == 18                                         # 11 + 7 turns
        assert c.delete(f"/v1/aims/{other_aim.id}/references/{body_id}").status_code == 204
    session.expire_all()
    assert session.get(Body, __import__("uuid").UUID(body_id)).system == "branch"


def test_every_round_reads_the_user_and_world_models_and_what_it_refers_to(rt, user):
    from pga.bodies import BodyService
    from pga.db.models import Body
    from pga.knowledge.datasets import Datasets
    from pga.tree import knowledge_context

    aim = AimService(rt.session).create(user, "目标", "aim")
    sets = Datasets(rt).ensure(user)
    sets["user"].description_en, sets["user"].compiled_at = "The user builds PGA and likes clean interfaces.", datetime.now(timezone.utc)
    ref = Body(user_id=user.id, aim_id=None, kind="database", title="别的思路", title_en="Another line", description="d",
               description_en="Per-topic thresholds beat a global one.", private=False, origin=__import__("pga.db.types", fromlist=["Origin"]).Origin.SYSTEM,
               system="branch", created_at=datetime.now(timezone.utc))
    rt.session.add(ref)
    rt.session.flush()
    BodyService(rt).bridge(user.id, f"aim:{aim.id}", f"k:{ref.id}", kind="references")
    ctx = knowledge_context(rt, aim)
    assert "<user_model" in ctx and "clean interfaces" in ctx and "<world_model" not in ctx   # world not compiled yet
    assert "Per-topic thresholds" in ctx
