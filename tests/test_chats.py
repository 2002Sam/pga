"""Everyday chats: second opinions, branches, pins."""
import json
from datetime import datetime, timedelta, timezone

from fastapi.testclient import TestClient

import pga.chats as C
from pga.agents.routing import AgentRouter
from pga.api.app import create_app
from pga.db.models import AgentRun
from pga.runtime import Runtime


def _run(user, prompt, answer, at, key, agent="claude"):
    return AgentRun(user_id=user.id, workflow="ask", pattern="single", step="run", agent=agent, adapter="x", status="SUCCEEDED",
                    prompt=prompt, output=json.dumps({"answer": answer}), data={"conversation": key, "agent": agent}, started_at=at)


def test_second_opinion_branch_and_pin(session_factory, policy, provider, backend, user, session, monkeypatch):
    now = datetime.now(timezone.utc)
    r1, r2 = _run(user, "先问一", "答一", now - timedelta(minutes=9), "chat:x"), _run(user, "再问二", "答二", now - timedelta(minutes=5), "chat:x")
    session.add_all([r1, r2])
    session.commit()
    asked = []

    def ask(self, u, text, **kw):
        asked.append((text, kw))
        return {"ok": True, "agent": kw.get("agent"), "text": "另一个答案", "model": "m"}
    monkeypatch.setattr(AgentRouter, "ask", ask)
    monkeypatch.setattr(C, "_compare", lambda *a, **k: {"agree": ["都说要做"], "differ": [{"point": "顺序", "a": "先A", "b": "先B"}], "answer": "合起来"})
    app = create_app(session_factory=session_factory,
                     runtime_factory=lambda s: Runtime(s, policy=policy, provider=provider, translation_backend=backend))
    with TestClient(app) as c:
        r = c.post(f"/v1/users/{user.id}/chats/second", json={"run": str(r2.id), "agent": "codex"})
        assert r.status_code == 200, r.text
        text, kw = asked[0]
        assert text == "再问二" and kw["agent"] == "codex" and kw["conversation"] == f"second:{r2.id}"
        assert [h["text"] for h in kw["history"]] == ["先问一", "答一"]                 # the conversation before the question
        t = c.get(f"/v1/users/{user.id}/chats/chat:x").json()["turns"]
        assert t[3]["second"]["agent"] == "codex" and t[3]["second"]["differ"][0]["b"] == "先B"
        b = c.post(f"/v1/users/{user.id}/chats/branch", json={"from": "chat:x", "upto": str(r1.id)}).json()
        one = c.get(f"/v1/users/{user.id}/chats/{b['key']}").json()
        assert one["branch"]["from"] == "chat:x" and [x["text"] for x in one["context"]] == ["先问一", "答一"] and one["turns"] == []
        tl = c.get(f"/v1/users/{user.id}/timeline", params={"days": 3}).json()
        assert b["line"] == "chat:x"
        assert c.put(f"/v1/users/{user.id}/timeline/pin", json={"line": "chat:x"}).json()["pinned"] == ["chat:x"]
        assert c.get(f"/v1/users/{user.id}/timeline", params={"days": 3}).json()["pinned"] == ["chat:x"]
        keys = [x["key"] for x in c.get(f"/v1/users/{user.id}/chats").json()]
        assert keys == ["chat:x"] and not any(k.startswith("second:") for k in {x["item"] for x in tl["sessions"]})


def test_your_own_note_goes_into_the_conversation(session_factory, policy, provider, backend, user, session):
    now = datetime.now(timezone.utc)
    r1 = _run(user, "先问一", "答一", now - timedelta(minutes=9), "chat:n")
    session.add(r1)
    session.commit()
    app = create_app(session_factory=session_factory,
                     runtime_factory=lambda s: Runtime(s, policy=policy, provider=provider, translation_backend=backend))
    with TestClient(app) as c:
        r = c.post(f"/v1/users/{user.id}/chats/note", json={"conversation": "chat:n", "text": "下一步：先把数据整理好", "line": "topic:x"}).json()
        assert r["key"] == "chat:n"
        t = c.get(f"/v1/users/{user.id}/chats/chat:n").json()["turns"]
        assert [x["role"] for x in t] == ["user", "agent", "user"] and t[2]["note"] and t[2]["text"] == "下一步：先把数据整理好"
        tl = c.get(f"/v1/users/{user.id}/timeline", params={"days": 3}).json()
        assert {x["line"] for x in tl["sessions"] if x["item"] == "chat:n"} == {"topic:x"}
    with session_factory() as s2:
        u = s2.get(type(user), user.id)
        h = C.history(Runtime(s2, policy=policy, provider=provider, translation_backend=backend), u, "chat:n")
        assert h[-1]["text"].startswith("[the user's own note]")                       # the agent reads it as your note


def test_versions_ratings_search_titles_and_prompts(session_factory, policy, provider, backend, user, session, monkeypatch):
    import uuid as _uuid
    now = datetime.now(timezone.utc)
    r1 = _run(user, "第一问", "答一", now - timedelta(minutes=9), "chat:v")
    r2 = _run(user, "第二问 关于缓存", "答二", now - timedelta(minutes=5), "chat:v")
    session.add_all([r1, r2])
    session.commit()
    seen = []

    def ask(self, u, text, **kw):
        seen.append((text, kw))
        rid = _uuid.uuid4()
        self.rt.session.add(AgentRun(id=rid, user_id=u.id, workflow="ask", pattern="single", step="workflow", agent=kw.get("agent") or "codex",
                                     adapter="pool", status="SUCCEEDED", prompt=text, output=json.dumps({"answer": "答二·新版"}),
                                     data={"conversation": kw.get("conversation"), "agent": "codex"}, started_at=datetime.now(timezone.utc)))
        self.rt.session.flush()
        return {"ok": True, "agent": "codex", "text": "答二·新版", "run_id": str(rid)}
    monkeypatch.setattr(AgentRouter, "ask", ask)
    app = create_app(session_factory=session_factory,
                     runtime_factory=lambda s: Runtime(s, policy=policy, provider=provider, translation_backend=backend))
    with TestClient(app) as c:
        r = c.post(f"/v1/users/{user.id}/chats/regen", json={"run": str(r2.id)}).json()
        assert r["of"] == str(r2.id) and seen[0][0] == "第二问 关于缓存"
        assert [h["text"] for h in seen[0][1]["history"]] == ["第一问", "答一"]            # what came before, not the answer it redoes
        t = c.get(f"/v1/users/{user.id}/chats/chat:v").json()["turns"]
        assert len(t) == 4 and t[3]["text"] == "答二·新版" and [v["text"] for v in t[3]["versions"]] == ["答二", "答二·新版"]
        c.post(f"/v1/users/{user.id}/chats/pick", json={"run": str(r2.id), "version": str(r2.id)})
        assert c.get(f"/v1/users/{user.id}/chats/chat:v").json()["turns"][3]["text"] == "答二"
        assert c.post(f"/v1/users/{user.id}/chats/rate", json={"run": str(r2.id), "rating": -1}).json()["rating"] == -1
        assert [x["turns"] for x in c.get(f"/v1/users/{user.id}/chats").json()] == [2]          # a version is not a turn
        assert c.get(f"/v1/users/{user.id}/chats-search", params={"q": "缓存"}).json()[0]["key"] == "chat:v"
        c.put(f"/v1/users/{user.id}/chats/title", json={"key": "chat:v", "title": "缓存讨论"})
        assert c.get(f"/v1/users/{user.id}/chats").json()[0]["title"] == "缓存讨论"
        p = c.put(f"/v1/users/{user.id}/prompts", json={"prompts": [{"command": "总结 x", "title": "总结", "text": "请总结："}, {"command": "", "text": "x"}]}).json()
        assert p == [{"command": "总结x", "title": "总结", "text": "请总结："}] and c.get(f"/v1/users/{user.id}/prompts").json() == p


def test_a_whole_chat_is_copied_and_answered_by_several_at_once(session_factory, policy, provider, backend, user, session):
    now = datetime.now(timezone.utc)
    r1, r2 = _run(user, "先问一", "答一", now - timedelta(minutes=9), "chat:c"), _run(user, "再问二", "答二", now - timedelta(minutes=5), "chat:c")
    session.add_all([r1, r2])
    session.flush()
    r3 = _run(user, "再问二", "答二·deepseek", now - timedelta(minutes=4), "chat:c", agent="deepseek")
    r3.data = {**r3.data, "regen_of": str(r2.id), "multi": True}                               # asked at once with r2
    session.add(r3)
    session.commit()
    app = create_app(session_factory=session_factory,
                     runtime_factory=lambda s: Runtime(s, policy=policy, provider=provider, translation_backend=backend))
    with TestClient(app) as c:
        put = lambda agents: c.put(f"/v1/users/{user.id}/chat-multi", json={"key": "chat:c", "agents": agents}).json()["agents"]
        assert put(["claude", "claude", "claude", "claude", "claude"]) == ["claude"] * 4              # one agent more than once; at most four
        assert put(["chatgpt", "claude", "deepseek"]) == ["chatgpt", "claude", "deepseek"]
        c.put(f"/v1/users/{user.id}/chat-system", json={"key": "chat:c", "text": "简短回答"})
        one = c.get(f"/v1/users/{user.id}/chats/chat:c").json()
        assert one["multi"] == ["chatgpt", "claude", "deepseek"] and [v.get("multi", False) for v in one["turns"][3]["versions"]] == [False, True]
        b = c.post(f"/v1/users/{user.id}/chats/branch", json={"from": "chat:c", "upto": str(r2.id), "copy": True}).json()
        cp = c.get(f"/v1/users/{user.id}/chats/{b['key']}").json()
        assert cp["branch"]["copy"] and [x["text"] for x in cp["context"]] == ["先问一", "答一", "再问二", "答二·deepseek"]
        assert cp["title"] == "先问一 · 副本" and cp["system"] == "简短回答" and cp["multi"] == ["chatgpt", "claude", "deepseek"]
        assert put([]) == [] and c.get(f"/v1/users/{user.id}/chats/chat:c").json()["multi"] == []
        assert c.get(f"/v1/users/{user.id}/chats/{b['key']}").json()["multi"] == ["chatgpt", "claude", "deepseek"]   # the copy keeps its own


def test_branches_of_imported_conversations_and_deep_trees(session_factory, policy, provider, backend, user, session):
    from pga.db.models import AgentConversation, LinkedAgent
    la = LinkedAgent(user_id=user.id, name="Codex", vendor="chatgpt", connector="import")
    session.add(la)
    session.flush()
    conv = AgentConversation(linked_agent_id=la.id, external_id="x1", title="[codex] 改登录页",
                             excerpt="User: 问A\nAssistant: 答A\n第二行\nUser: 问B\nAssistant: 答B", message_count=4)
    session.add(conv)
    session.commit()
    app = create_app(session_factory=session_factory,
                     runtime_factory=lambda s: Runtime(s, policy=policy, provider=provider, translation_backend=backend))
    with TestClient(app) as c:
        b = c.post(f"/v1/users/{user.id}/chats/branch", json={"from": f"imp:{conv.id}", "upto": "2", "title": "改登录页 · 分支 A"}).json()
        one = c.get(f"/v1/users/{user.id}/chats/{b['key']}").json()           # an imported conversation, up to the turn you branched at
        assert [x["text"] for x in one["context"]] == ["问A", "答A\n第二行"] and one["parent_title"] == "改登录页" and one["title"] == "改登录页 · 分支 A"
        assert one["context"][1]["agent"] == "Codex"
        now = datetime.now(timezone.utc)
        prev, key = None, b["key"]
        for depth in range(8):                                                  # a branch of a branch of … : every level's turns come along
            r = _run(user, f"深{depth}", f"答深{depth}", now - timedelta(minutes=60 - depth), key)
            session.add(r)
            session.commit()
            prev, key = key, c.post(f"/v1/users/{user.id}/chats/branch", json={"from": key, "upto": str(r.id)}).json()["key"]
        ctx = [x["text"] for x in c.get(f"/v1/users/{user.id}/chats/{key}").json()["context"]]
        assert ctx[:2] == ["问A", "答A\n第二行"] and ctx[-2:] == ["深7", "答深7"] and len(ctx) == 2 + 16


def test_a_second_opinion_is_a_branch_of_its_own_on_the_same_topic(session_factory, policy, provider, backend, user, session, monkeypatch):
    from pga import projectsort
    now = datetime.now(timezone.utc)
    r1, r2 = _run(user, "先问一", "答一", now - timedelta(minutes=9), "chat:x"), _run(user, "再问二", "答二", now - timedelta(minutes=5), "chat:x")
    session.add_all([r1, r2])
    session.commit()
    monkeypatch.setattr(AgentRouter, "ask", lambda *a, **k: (_ for _ in ()).throw(AssertionError("the page asks it, not the server")))
    app = create_app(session_factory=session_factory,
                     runtime_factory=lambda s: Runtime(s, policy=policy, provider=provider, translation_backend=backend))
    with TestClient(app) as c:
        st = projectsort.state(user)
        st["of"]["chat:x"] = "简历投递"
        projectsort.save(user, st)
        session.commit()
        r = c.post(f"/v1/users/{user.id}/chats/second", json={"run": str(r2.id), "agent": "codex", "branch": True})
        assert r.status_code == 200, r.text
        b = r.json()
        assert b["agent"] == "codex" and b["question"] == "再问二" and b["from"] == "chat:x" and b["upto"] == str(r1.id)
        assert b["line"] == "chat:x" and b["project"] == "简历投递" and "第二意见" in b["title"]
        one = c.get(f"/v1/users/{user.id}/chats/{b['key']}").json()
        assert one["branch"]["upto"] == str(r1.id) and [x["text"] for x in one["context"]] == ["先问一", "答一"]   # it hears what came before the question
        session.expire_all()
        assert projectsort.state(session.get(type(user), user.id))["of"][b["key"]] == "简历投递"
        assert (session.get(type(user), user.id).preferences["derived_from"])[b["key"]] == "chat:x"             # the world tree files it where chat:x is
        e = c.post(f"/v1/users/{user.id}/chats/branch", json={"from": "chat:x", "upto": str(r1.id)}).json()   # an ordinary branch too
        session.expire_all()
        assert projectsort.state(session.get(type(user), user.id))["of"][e["key"]] == "简历投递"


def test_whole_branch_copies_settings_and_freezes_empty_child(session_factory, policy, provider, backend, user, session, tmp_path):
    now = datetime.now(timezone.utc)
    r = _run(user, '原问题', '原回答', now, 'chat:source')
    r.workspace = str(tmp_path)
    session.add(r)
    user.preferences = {**(user.preferences or {}),
        'chat_system': {'chat:source': '用中文'}, 'chat_ctx': {'chat:source': '参考材料'},
        'chat_multi': {'chat:source': ['claude', 'claude']}}
    session.commit()
    app = create_app(session_factory=session_factory,
        runtime_factory=lambda s: Runtime(s, policy=policy, provider=provider, translation_backend=backend))
    base = f'/v1/users/{user.id}'
    options = {'agent': 'claude', 'model': 'opus', 'effort': 'high'}
    with TestClient(app) as client:
        response = client.post(base + '/chats/branch', json={'from':'chat:source','upto':'all','copy':True,'options':options})
        assert response.status_code == 201, response.text
        first = response.json()['key']
        detail = client.get(base + '/chats/' + first).json()
        assert [t['text'] for t in detail['context']] == ['原问题','原回答']
        assert detail['options'] == options
        assert detail['system'] == '用中文'
        assert detail['multi'] == ['claude','claude']
        assert detail['branch']['copy'] is True
        assert client.get(base + '/access', params={'key':first}).json()['current']['folder'] == str(tmp_path)
        second = client.post(base + '/chats/branch',json={'from':first,'upto':'all','copy':True}).json()['key']
        assert client.get(base + '/chats/' + second).json()['options'] == options
        # Adding a new reply to the parent must not change the already-created child snapshot.
        session.add(_run(user, '后来的问题', '后来的回答', now + timedelta(seconds=3), first))
        session.commit()
        final = client.get(base + '/chats/' + second).json()
        assert [t['text'] for t in final['context']] == ['原问题','原回答']


def test_carry_on_always_allocates_new_identity(session_factory, policy, provider, backend, user, session):
    run = _run(user, '原问题', '原回答', datetime.now(timezone.utc), 'chat:source')
    session.add(run)
    session.commit()
    app = create_app(session_factory=session_factory,
        runtime_factory=lambda s: Runtime(s, policy=policy, provider=provider, translation_backend=backend))
    base = f'/v1/users/{user.id}/chats'
    with TestClient(app) as client:
        keys = {'chat:source'}
        for _ in range(2):
            r = client.post(base + '/branch', json={'from': 'chat:source', 'upto': str(run.id), 'key': 'chat:source'})
            assert r.status_code == 201, r.text
            key = r.json()['key']
            assert key not in keys
            keys.add(key)
            detail = client.get(base + '/' + key).json()
            assert detail['turns'] == []
            assert [t['text'] for t in detail['context']] == ['原问题', '原回答']
        original = client.get(base + '/chat:source').json()
        assert original['branch'] is None
        assert len(original['turns']) == 2


def test_branch_names_use_selected_reply_and_latest_for_copies(session_factory, policy, provider, backend, user, session):
    now = datetime.now(timezone.utc)
    first = _run(user, "父对话的问题", "## **第一条回答**\n这是说明", now - timedelta(minutes=2), "chat:names")
    last = _run(user, "后来问题", "最后一条回答", now, "chat:names")
    session.add_all([first, last])
    session.commit()
    app = create_app(session_factory=session_factory,
                     runtime_factory=lambda s: Runtime(s, policy=policy, provider=provider, translation_backend=backend))
    with TestClient(app) as client:
        url = f"/v1/users/{user.id}/chats/branch"
        selected = client.post(url, json={"from": "chat:names", "upto": str(first.id), "title_from_reply": True, "branch_tag": "A"}).json()
        assert selected["title"] == "第一条回答 这是说明 · 分支 A"
        copied = client.post(url, json={"from": "chat:names", "upto": "all", "copy": True, "title_from_reply": True, "branch_tag": "B"}).json()
        assert copied["title"] == "最后一条回答 · 分支 B"
        custom = client.post(url, json={"from": "chat:names", "upto": str(first.id), "title": "自定义标题"}).json()
        assert custom["title"] == "自定义标题"
        nested = client.post(url, json={"from": selected["key"], "upto": "all", "copy": True, "title_from_reply": True}).json()
        assert nested["title"] == "第一条回答 这是说明"


def test_branch_first_new_question_names_it_once_and_preserves_manual_titles(session_factory, policy, provider, backend, user, session):
    rt = Runtime(session, policy=policy, provider=provider, translation_backend=backend)
    C.set_branch(user, 'chat:new-title', 'chat:parent', '0')
    C.set_title(user, 'chat:new-title', '从旧回答来的标题')
    assert C.name_branch_question(rt, user, 'chat:new-title', '这是  新问题\n怎么做？')
    assert user.preferences['chat_titles']['chat:new-title'] == '这是 新问题 怎么做？'
    session.add(_run(user, '这是新问题', '回答', datetime.now(timezone.utc), 'chat:new-title'))
    session.flush()
    assert not C.name_branch_question(rt, user, 'chat:new-title', '第二个问题')
    assert not C.name_branch_question(rt, user, 'chat:ordinary', '普通对话')
    C.set_branch(user, 'chat:manual', 'chat:parent', '0')
    user.preferences = {**user.preferences, 'chat_branches': {**user.preferences['chat_branches'],
        'chat:manual': {**user.preferences['chat_branches']['chat:manual'], 'manual_title': True}}}
    C.set_title(user, 'chat:manual', '我自己起的标题')
    assert not C.name_branch_question(rt, user, 'chat:manual', '新的问题')
    assert user.preferences['chat_titles']['chat:manual'] == '我自己起的标题'
