"""The time tree: sessions on one time axis, lines, and tidying."""
import json
from datetime import datetime, timedelta, timezone

from fastapi.testclient import TestClient

from pga.api.app import create_app
from pga.db.models import AgentConversation, AgentRun, Aim, LinkedAgent, Project, ThoughtNode
from pga.runtime import Runtime
from pga.timeline import Timeline


def _run(user, prompt, at, data):
    return AgentRun(user_id=user.id, workflow="ask", pattern="single", step="run", agent="claude", adapter="claude_local",
                    status="SUCCEEDED", prompt=prompt, output=json.dumps({"answer": "ok"}), data=data, started_at=at)


def test_time_tree_lines_and_paths(session_factory, policy, provider, backend, user, session):
    rt = Runtime(session, policy=policy, provider=provider, translation_backend=backend)
    now = datetime.now(timezone.utc)
    aim = Aim(user_id=user.id, text="让 PGA 不断思考", text_en="PGA keeps thinking")
    session.add(aim)
    session.flush()
    session.add(Project(user_id=user.id, name="PGA", path="/Users/x/Documents/PGA/pga", aim_id=aim.id))
    node = ThoughtNode(user_id=user.id, aim_id=aim.id, scope="aim", kind="user", seq=1, title="上下文管理", summary="", note_ids=[], data={})
    session.add(node)
    la = LinkedAgent(user_id=user.id, name="Claude Code", vendor="claude_code", connector="import")
    session.add(la)
    session.flush()
    session.add_all([
        _run(user, "今天天气", now - timedelta(days=3), {"conversation": "chat:a"}),
        _run(user, "明天呢", now - timedelta(days=3, minutes=-10), {"conversation": "chat:a"}),
        _run(user, "接着三天前的问题", now - timedelta(hours=1), {"conversation": "chat:a"}),            # comes back: a second session
        _run(user, "缓存怎么排", now - timedelta(hours=2), {"conversation": f"node:{node.id}"}),
        AgentConversation(linked_agent_id=la.id, external_id="s1", title="[pga] fix the tree", excerpt="User: hi\nAssistant: hello",
                          project="pga", message_count=40, started_at=now - timedelta(days=2), updated_at=now - timedelta(minutes=30)),
        AgentConversation(linked_agent_id=la.id, external_id="s2", title="周报模板整理", excerpt="", message_count=4,
                          started_at=now - timedelta(days=5), updated_at=now - timedelta(days=5)),
        AgentConversation(linked_agent_id=la.id, external_id="s3", title="周报模板整理", excerpt="", message_count=6,
                          started_at=now - timedelta(days=1), updated_at=now - timedelta(days=1)),
    ])
    session.commit()
    tl = Timeline(rt)
    out = tl.build(user, 30)
    by_item = {}
    for x in out["sessions"]:
        by_item.setdefault(x["item"], []).append(x)
    assert len(by_item["chat:a"]) == 2                                              # two sessions, three days apart
    assert by_item[f"n:{node.id}"][0]["line"] == f"aim:{aim.id}"                   # a tree branch is on its tree's line
    imp = [k for k in by_item if k.startswith("c:") and by_item[k][0]["title"] == "fix the tree"][0]
    assert by_item[imp][0]["line"] == f"aim:{aim.id}" and len(by_item[imp]) == 2   # held in the motivation's folder; started and resumed
    assert out["lines"][f"aim:{aim.id}"]["kind"] == "tree" and out["lines"][f"aim:{aim.id}"]["items"] == 2
    # tidying without a model: the same title becomes one topic line
    r = tl.organize_rules(user)
    session.commit()
    assert r["new_lines"] == 1
    out = tl.build(user, 30)
    weekly = {x["line"] for x in out["sessions"] if x["title"] == "周报模板整理"}
    assert len(weekly) == 1 and out["lines"][weekly.pop()]["kind"] == "topic"
    app = create_app(session_factory=session_factory,
                     runtime_factory=lambda s: Runtime(s, policy=policy, provider=provider, translation_backend=backend))
    with TestClient(app) as c:
        assert c.put(f"/v1/users/{user.id}/timeline/items", json={"key": "chat:a", "line": f"aim:{aim.id}"}).status_code == 200
        t = c.get(f"/v1/users/{user.id}/timeline", params={"days": 30}).json()
        assert {x["line"] for x in t["sessions"] if x["item"] == "chat:a"} == {f"aim:{aim.id}"}   # you moved it: it stays
        cid = imp[2:]
        d = c.get(f"/v1/users/{user.id}/imported/{cid}").json()
        assert d["messages"] == 40 and d["agent"] == "Claude Code"
        c.post(f"/v1/users/{user.id}/chats/archive", json={"key": imp})
        t = c.get(f"/v1/users/{user.id}/timeline", params={"days": 30}).json()
        assert imp not in {x["item"] for x in t["sessions"]} and t["hidden"] == [imp]


def test_tidying_takes_the_models_joins_and_topics(policy, provider, backend, user, session, monkeypatch):
    rt = Runtime(session, policy=policy, provider=provider, translation_backend=backend)
    now = datetime.now(timezone.utc)
    aim = Aim(user_id=user.id, text="写论文", text_en="write the paper")
    session.add(aim)
    session.flush()
    for i, t in enumerate(["实验部分怎么写", "相关工作怎么组织", "推荐一部电影", "电影里的配乐"]):
        session.add(_run(user, t, now - timedelta(days=4 - i), {"conversation": f"chat:{i}"}))
    session.commit()

    def ask(self, user_, part, targets, now_):
        names = {it.title: f"i{k}" for k, it in enumerate(part)}
        assert f"aim:{aim.id}" in targets                                        # every motivation can take a conversation
        return {"assign": [{"item": names["实验部分怎么写"], "line": f"aim:{aim.id}"}, {"item": names["相关工作怎么组织"], "line": "nope"}],
                "new": [{"title": "电影", "items": [names["推荐一部电影"], names["电影里的配乐"]]}, {"title": "孤单", "items": [names["相关工作怎么组织"]]}]}
    monkeypatch.setattr(Timeline, "_ask", ask)
    r = Timeline(rt).organize(user, now)
    assert r["joined"] == 3 and r["new_lines"] == 1
    out = Timeline(rt).build(user, 30)
    line = {x["title"]: x["line"] for x in out["sessions"]}
    assert line["实验部分怎么写"] == f"aim:{aim.id}" and line["相关工作怎么组织"] == "chat:1"
    assert line["推荐一部电影"] == line["电影里的配乐"] and out["lines"][line["电影里的配乐"]]["title"] == "电影"
    assert Timeline(rt).organize(user, now)["looked_at"] == 0                      # what it has looked at is not sent again


def test_a_line_shows_its_summaries_and_can_be_pulled_out(session_factory, policy, provider, backend, user, session):
    from pga.tree import ThoughtTree, YouRoot
    rt = Runtime(session, policy=policy, provider=provider, translation_backend=backend)
    now = datetime.now(timezone.utc)
    runs = [_run(user, "周报模板怎么写", now - timedelta(days=6), {"conversation": "chat:w1"}),
            _run(user, "周报再改改", now - timedelta(days=1), {"conversation": "chat:w2"})]
    session.add_all(runs)
    session.flush()
    session.add(ThoughtNode(user_id=user.id, aim_id=None, scope="user", kind="segment", seq=1, title="周报", summary="问：周报怎么写",
                            note_ids=[f"r:{runs[0].id}"], data={}))
    session.commit()
    tl = Timeline(rt)
    tl.move(user, "chat:w2", "chat:w1")                                            # you joined them by hand
    session.commit()
    app = create_app(session_factory=session_factory,
                     runtime_factory=lambda s: Runtime(s, policy=policy, provider=provider, translation_backend=backend))
    with TestClient(app) as c:
        d = c.get(f"/v1/users/{user.id}/timeline/line", params={"id": "chat:w1"}).json()
        assert [x["key"] for x in d["items"]] == ["chat:w1", "chat:w2"] and d["items"][0]["summary"] == "问：周报怎么写"
        r = c.post(f"/v1/users/{user.id}/timeline/line/extract", json={"id": "chat:w1", "title": "写周报"})
        assert r.status_code == 201, r.text
        aim = r.json()["aim"]
        assert r.json()["nodes"] == 2
        t = c.get(f"/v1/aims/{aim}/tree").json()
        nodes = sorted(t["nodes"], key=lambda n: n["seq"])
        assert [n["title"] for n in nodes] == ["周报模板怎么写", "周报再改改"] and nodes[1]["parent"] == nodes[0]["id"] and nodes[1]["tip"]
        assert c.get(f"/v1/thought-nodes/{nodes[0]['id']}?full=true").json()["notes"][0]["kind"] == "question"
        out = c.get(f"/v1/users/{user.id}/timeline", params={"days": 30}).json()
        assert {x["line"] for x in out["sessions"] if x["item"] in ("chat:w1", "chat:w2")} == {f"aim:{aim}"}
        assert c.post(f"/v1/users/{user.id}/timeline/line/extract", json={"id": f"aim:{aim}"}).status_code == 409
    assert ThoughtTree(rt).nodes(YouRoot(user))                                      # your conversation tree is left as it was


def test_codex_approval_reviews_are_not_conversations(policy, provider, backend, user, session):
    rt = Runtime(session, policy=policy, provider=provider, translation_backend=backend)
    now = datetime.now(timezone.utc)
    la = LinkedAgent(user_id=user.id, name="Codex", vendor="chatgpt", connector="import")
    session.add(la)
    session.flush()
    session.add_all([AgentConversation(linked_agent_id=la.id, external_id="r", title="[dji] The following is the Codex agent history whose request…",
                                       excerpt="", message_count=3, started_at=now - timedelta(hours=1), updated_at=now - timedelta(hours=1)),
                     AgentConversation(linked_agent_id=la.id, external_id="k", title="[dji] 整理视频", excerpt="", message_count=3,
                                       started_at=now - timedelta(hours=1), updated_at=now - timedelta(hours=1))])
    session.commit()
    assert [x["title"] for x in Timeline(rt).build(user, 3)["sessions"]] == ["整理视频"]
