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


def test_your_own_conversations_grow_a_tree_of_their_own(session_factory, policy, provider, backend, user, session):
    """Your chats in PGA (a message and an answer each) and conversations imported from other apps, cut into a tree."""
    from pga.db.models import AgentConversation, AgentRun, LinkedAgent
    from pga.tree import YouRoot

    rt = Runtime(session, policy=policy, provider=provider, translation_backend=backend)
    t0 = datetime.now(timezone.utc) - timedelta(days=8)
    for i in range(4):
        session.add(AgentRun(user_id=user.id, workflow="ask", pattern="single", step="run", agent="claude", adapter="claude_local",
                             status="SUCCEEDED", prompt=f"怎么让 PGA 的界面更好读？{i}", output=json.dumps({"answer": f"回答 {i}"}),
                             data={"conversation": "agent:claude:console-1"}, started_at=t0 + timedelta(minutes=i)))
    session.add(AgentRun(user_id=user.id, workflow="ask", pattern="single", step="run", agent="claude", adapter="claude_local",
                         status="SUCCEEDED", prompt="这一条属于一棵思考树", output="x", data={"conversation": "node:abc"}, started_at=t0))
    la = LinkedAgent(user_id=user.id, name="ChatGPT", vendor="chatgpt", connector="import")
    session.add(la)
    session.flush()
    session.add(AgentConversation(linked_agent_id=la.id, external_id="x1", title="旅行计划", excerpt="去京都的路线",
                                  started_at=t0 + timedelta(days=5), updated_at=t0 + timedelta(days=5)))
    session.flush()
    tree = ThoughtTree(rt)
    you = YouRoot(user)
    assert tree.pending_count(you) == 4 * 2 + 1                                     # 4 chats (2 turns each) + 1 imported
    out = tree.curate(user, you, use_model=False)
    nodes = tree.nodes(you)
    assert out["pending"] == 0 and len(nodes) == 2 and all(n.scope == "user" and n.aim_id is None for n in nodes)
    assert nodes[0].data["turns"] == 8 and nodes[1].title.startswith("旅行计划")
    assert [t.kind for t in tree.notes_of(nodes[1])] == ["conversation"]
    assert tree.pending_count(you) == 0                                              # placed turns are not offered again
    session.commit()
    app = create_app(session_factory=session_factory,
                     runtime_factory=lambda s: Runtime(s, policy=policy, provider=provider, translation_backend=backend))
    with TestClient(app) as c:
        t = c.get(f"/v1/users/{user.id}/tree").json()
        assert t["aim"]["scope"] == "user" and len(t["nodes"]) == 2
        f = c.get(f"/v1/users/{user.id}/forest").json()
        assert f["you"]["text"] == "你的对话" and len(f["you"]["nodes"]) == 2
        d = c.get(f"/v1/thought-nodes/{nodes[0].id}?full=true").json()
        assert [x["kind"] for x in d["notes"]][:2] == ["question", "answer"] and len(d["children"]) == 1
        assert c.get(f"/v1/thought-nodes/{nodes[0].id}/behavior").json()["runs"] == 4
        r = c.post(f"/v1/thought-nodes/{nodes[0].id}/continue", json={"text": "再说一点", "agent": "auto"})
        assert r.status_code == 200, r.text
        b = r.json()["node"]
        assert b["scope"] == "user" and b["parent"] == str(nodes[0].id) and b["turns"] >= 1


def test_the_behaviour_tree_shows_who_did_what(rt, user):
    """Each agent's runs in a node and the actions in them, read from the tool traces."""
    from pga.db.models import AgentRun

    aim = AimService(rt.session).create(user, "目标", "aim")
    _dialogue(rt, user, aim, n=6)
    tree = ThoughtTree(rt)
    tree.curate(user, aim, use_model=False)
    node = tree.nodes(aim.id)[0]
    parent = AgentRun(user_id=user.id, workflow="perpetual", pattern="single", step="run", agent="claude", adapter="claude_local",
                      status="SUCCEEDED", prompt='<question code="Q2">\nwhy?\n</question>', data={"aim": str(aim.id), "step": "investigate", "agent": "claude"},
                      started_at=node.first_at + timedelta(seconds=30), duration_s=40)
    rt.session.add(parent)
    rt.session.flush()
    rt.session.add(AgentRun(user_id=user.id, parent_id=parent.id, workflow="perpetual", pattern="single", step="investigate", agent="claude",
                            adapter="claude_local", status="SUCCEEDED", data={"trace": "→ Read /x/src/pga/a.py\n→ Grep cache\n$ pytest -q\n→ Edit src/pga/a.py"},
                            started_at=node.first_at + timedelta(seconds=31)))
    rt.session.flush()
    b = tree.behavior(node)
    ag = b["agents"][0]
    assert ag["agent"] == "claude" and ag["runs"][0]["code"] == "Q2" and ag["runs"][0]["step_zh"] == "研究"
    assert [a["kind"] for a in ag["runs"][0]["actions"]] == ["read", "search", "command", "edit"]
    assert b["totals"]["read"] == 1 and b["traced"] == 1
    tree.refresh(aim)
    assert node.data["behavior"]["runs"] == 1 and node.data["behavior"]["edit"] == 1


def test_knowledge_moves_and_is_referenced_by_nodes_and_conversations(session_factory, policy, provider, backend, user, session, monkeypatch):
    from pga.db.models import Body
    from pga.db.types import Origin

    rt = Runtime(session, policy=policy, provider=provider, translation_backend=backend)
    aims = AimService(session)
    a1, a2 = aims.create(user, "一", "one"), aims.create(user, "二", "two")
    _dialogue(rt, user, a1, n=6)
    _dialogue(rt, user, a2, n=6)
    tree = ThoughtTree(rt)
    tree.curate(user, a1, use_model=False)
    tree.curate(user, a2, use_model=False)
    n1, n2 = tree.nodes(a1.id)[0], tree.nodes(a2.id)[0]
    b = Body(user_id=user.id, aim_id=a1.id, kind="database", title="思路 · 缓存", title_en="Line: cache", description="按主题设阈值",
             description_en="Per-topic thresholds work better than one global threshold.", private=False, origin=Origin.SYSTEM, system="branch",
             created_at=datetime.now(timezone.utc))
    session.add(b)
    session.flush()
    n1.data = {**n1.data, "dataset": str(b.id)}
    session.commit()
    seen = []
    from pga.agents.routing import AgentRouter

    def ask(self, user, text, agent="auto", **kw):                                    # what the agent would be told
        seen.append(kw.get("context") or "")
        return {"ok": True, "agent": "claude", "text": "好", "error": None, "run_id": None}
    monkeypatch.setattr(AgentRouter, "ask", ask)
    app = create_app(session_factory=session_factory,
                     runtime_factory=lambda s: Runtime(s, policy=policy, provider=provider, translation_backend=backend))
    with TestClient(app) as c:
        moved = c.post(f"/v1/bodies/{b.id}/move", json={"node_id": str(n2.id)}).json()
        assert moved["aim_id"] == str(a2.id)
        assert c.get(f"/v1/thought-nodes/{n2.id}").json()["dataset"] == str(b.id)
        assert c.get(f"/v1/thought-nodes/{n1.id}").json()["dataset"] is None
        assert c.put(f"/v1/thought-nodes/{n1.id}/refs", json={"refs": [str(b.id), "nonsense"]}).json()["refs"] == [str(b.id)]
        c.post(f"/v1/thought-nodes/{n1.id}/continue", json={"text": "用上那份知识", "agent": "auto"})
        assert any("Per-topic thresholds" in s for s in seen)                          # the node's reference reached the agent
        seen.clear()
        c.post(f"/v1/users/{user.id}/agents/ask", json={"text": "你好", "agent": "auto", "refs": [str(b.id)]})
        assert any("Per-topic thresholds" in s for s in seen)                          # and a plain conversation can refer to it too
