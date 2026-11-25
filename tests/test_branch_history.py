"""Fork inherited snapshots and preserve creation-time access independently."""
import uuid
from datetime import datetime, timedelta, timezone

import pytest
from fastapi.testclient import TestClient

from pga.agents.routing import AgentRouter
from pga.api.app import create_app
from pga.runtime import Runtime
from .test_chats import _run


@pytest.mark.parametrize('level,mcp', [('read', False), ('auto', True), ('full', True)])
def test_nested_history_fork_freezes_context_and_access(session_factory, session, user, policy, provider, backend, monkeypatch, tmp_path, level, mcp):
    now = datetime.now(timezone.utc)
    first = _run(user, 'q1', 'a1', now, 'chat:root')
    later = _run(user, 'q2', 'a2', now + timedelta(seconds=1), 'chat:root')
    session.add_all([first, later]); session.commit()
    asked = []
    monkeypatch.setattr(AgentRouter, 'ask', lambda self, u, text, **kw: asked.append(kw) or {'ok': True, 'text': 'ok'})
    app = create_app(session_factory=session_factory, runtime_factory=lambda s: Runtime(s, policy=policy, provider=provider, translation_backend=backend))
    with TestClient(app) as c:
        base = f'/v1/users/{user.id}'
        def fork(key, point):
            r = c.post(base + '/chats/branch', json={'from': key, 'upto': point})
            assert r.status_code == 201, r.text
            return r.json()['key']
        def access(key):
            return c.get(base + '/access', params={'key': key}).json()['current']
        parent = fork('chat:root', 'all')
        settings = {'access': level, 'mcp': mcp, 'folder': str(tmp_path)}
        c.put(base + '/access', json={'key': parent, **settings})
        child = fork(parent, 'context:2')
        assert {k: access(child)[k] for k in settings} == settings
        assert c.get(base + '/chats/' + child).json()['branch']['from'] == parent
        # Also accept a retained native run ID from the inherited snapshot.
        by_run = fork(parent, str(first.id))
        for key in [child, by_run]:
            assert [t['text'] for t in c.get(base + '/chats/' + key).json()['context']] == ['q1', 'a1']
        # Parent changes and global default changes do not rewrite child authority/history.
        c.put(base + '/access', json={'key': parent, 'access': 'full' if level == 'read' else 'read', 'mcp': not mcp})
        c.put(base + '/access', json={'as_default': True, 'access': 'read'})
        grandchild = fork(child, 'context:2')
        for key in [child, grandchild]:
            assert {k: access(key)[k] for k in settings} == settings
            r = c.post(base + '/agents/ask', json={'conversation': key, 'text': 'continue', 'history': [{'role': 'assistant', 'text': 'future'}]})
            assert r.status_code == 200, r.text
            assert (asked[-1]['access'], asked[-1]['mcp'], asked[-1]['folder']) == (level, mcp, str(tmp_path))
            assert [t['text'] for t in asked[-1]['history']] == ['q1', 'a1']
        for invalid in ['context:0', 'context:-1', 'context:3', 'context:no', str(later.id), str(uuid.uuid4())]:
            assert c.post(base + '/chats/branch', json={'from': child, 'upto': invalid}).status_code == 422


def test_imported_and_default_permissions_are_snapshotted(session_factory, session, user, policy, provider, backend, tmp_path):
    from pga.db.models import AgentConversation, LinkedAgent
    linked = LinkedAgent(user_id=user.id, name='Codex', vendor='chatgpt', connector='import')
    session.add(linked); session.flush()
    imported = AgentConversation(linked_agent_id=linked.id, external_id='snapshot-test', title='Imported', excerpt='User: q\nAssistant: a', message_count=2)
    session.add(imported); session.commit()
    app = create_app(session_factory=session_factory, runtime_factory=lambda s: Runtime(s, policy=policy, provider=provider, translation_backend=backend))
    with TestClient(app) as c:
        base = f'/v1/users/{user.id}'
        settings = {'access': 'full', 'mcp': True, 'folder': str(tmp_path)}
        c.put(base + '/access', json={'key': f'c:{imported.id}', **settings})
        r = c.post(base + '/chats/branch', json={'from': f'imp:{imported.id}', 'upto': '2'})
        assert r.status_code == 201, r.text
        child = r.json()['key']
        nested = c.post(base + '/chats/branch', json={'from': child, 'upto': 'context:2'})
        assert nested.status_code == 201, nested.text
        for key in [child, nested.json()['key']]:
            got = c.get(base + '/access', params={'key': key}).json()['current']
            assert {k: got[k] for k in settings} == settings
            assert [t['text'] for t in c.get(base + '/chats/' + key).json()['context']] == ['q', 'a']
        c.put(base + '/access', json={'as_default': True, **settings})
        empty = c.post(base + '/chats/branch', json={'from': 'chat:empty', 'upto': 'all'}).json()['key']
        c.put(base + '/access', json={'as_default': True, 'access': 'read', 'mcp': False})
        got = c.get(base + '/access', params={'key': empty}).json()['current']
        assert {k: got[k] for k in settings} == settings


def test_question_replay_makes_fresh_call_with_same_model_messages(session_factory, user, policy, provider, backend, monkeypatch, tmp_path):
    from pga.agents import pool
    monkeypatch.setitem(pool.DEFAULT["run"], "workspace_root", str(tmp_path))
    make = lambda s: Runtime(s, policy=policy, provider=provider, translation_backend=backend)
    app = create_app(session_factory=session_factory, runtime_factory=make)
    base = f"/v1/users/{user.id}"
    with TestClient(app) as c:
        source = "chat:original"

        def post(path, **body):
            res = c.post(base + path, json=body)
            assert res.is_success, res.text
            return res.json()

        def ask(key, text, **body):
            res = post("/agents/ask", conversation=key, text=text, agent="deepseek", model="test-model", **body)
            assert res["ok"], res
            return res

        first = ask(source, "first")
        hist = [{"role": "user", "text": "first"}, {"role": "assistant", "text": first["text"]}]
        original = ask(source, "repeat me", effort="high", history=hist, files=[
            {"name": "note.txt", "data": "data:text/plain;base64,YXR0YWNobWVudA=="}])
        original_call = next(call for call in reversed(provider.calls) if call.model == "test-model")
        assert "attachment" in original_call.messages[-1]["content"]
        ask(source, "later question")
        for point, text, previous in [(first["run_id"], "first", []), (original["run_id"], "repeat me", hist)]:
            fork = post("/chats/branch", **{"from": source, "upto": "question:" + point})
            assert fork["replay"]["text"] == text
            assert fork["replay"]["options"]["agent"] == "deepseek"
            assert [t["text"] for t in fork["snapshot"]] == [t["text"] for t in previous]
            before = sum(call.model == "test-model" for call in provider.calls)
            ask(fork["key"], text, replay_question=True)
            calls = [call for call in provider.calls if call.model == "test-model"]
            assert len(calls) == before + 1
            if previous:
                assert fork["replay"]["options"]["effort"] == "high"
                assert (calls[-1].model, calls[-1].system, calls[-1].messages) == (
                    original_call.model, original_call.system, original_call.messages)
            assert len(c.get(base + "/chats/" + fork["key"]).json()["turns"]) == 2
        assert len(c.get(base + "/chats/" + source).json()["turns"]) == 6
        entire = post("/chats/branch", **{"from": source, "upto": "all"})
        nested = post("/chats/branch", **{"from": entire["key"], "upto": "question:context:3"})
        assert nested["replay"]["text"] == "repeat me" and nested["snapshot"] == fork["snapshot"]
        assert c.post(base + "/chats/branch", json={"from": entire["key"], "upto": "question:context:2"}).status_code == 422


def test_imported_question_restores_image_from_owned_transcript(session_factory, session, user, policy, provider, backend, monkeypatch):
    from pga.db.models import AgentConversation, LinkedAgent
    from pga.hub import connectors, steps

    linked = LinkedAgent(user_id=user.id, name="test", vendor="test", connector="codex")
    session.add(linked)
    session.flush()
    record = AgentConversation(linked_agent_id=linked.id, external_id="imported-session", title="photos", message_count=2)
    session.add(record)
    session.commit()
    monkeypatch.setattr(connectors, "full_turns", lambda *args: [
        {"role": "user", "text": "what is this?", "images": ["1.0"]}, {"role": "assistant", "text": "first answer"}])
    monkeypatch.setattr(connectors, "session_home", lambda *args: (False, None))
    monkeypatch.setattr(steps, "transcript", lambda session, kind: "owned" if (session, kind) == ("imported-session", "codex") else None)
    monkeypatch.setattr(steps, "image", lambda path, ref, kind: (b"image", "image/png") if (path, ref) == ("owned", "1.0") else None)
    calls = []
    monkeypatch.setattr(AgentRouter, "ask", lambda self, u, text, **kw: calls.append((text, kw)) or {"ok": True, "text": "fresh"})
    app = create_app(session_factory=session_factory, runtime_factory=lambda s: Runtime(s, policy=policy, provider=provider, translation_backend=backend))
    with TestClient(app) as c:
        base = f"/v1/users/{user.id}"
        r = c.post(base + "/chats/branch", json={"from": f"imp:{record.id}", "upto": "question:1"})
        assert r.status_code == 201, r.text
        fork = r.json()
        assert not fork["snapshot"]
        res = c.post(base + "/agents/ask", json={"conversation": fork["key"], "text": fork["replay"]["text"], "replay_question": True})
        assert res.status_code == 200, res.text
        assert len(calls) == 1 and calls[0][0] == "what is this?"
        assert calls[0][1]["images"] == [{"data": "data:image/png;base64,aW1hZ2U="}]
