import threading
import time
from concurrent.futures import ThreadPoolExecutor

import pytest
from pga.agents import live, links
from pga.agents.base import AgentTask
from pga.agents.adapters import CodexLocal


def test_steer_scoped_idempotent_and_kept_after_finish():
    lid = live.start('codex', tags={'conversation': 'u:chat:a'})
    sent = []
    live.bind_steering(lid, lambda text: sent.append(text) or {'turnId': 't'})
    with pytest.raises(live.SteerRejected):
        live.steer(lid, 'u:chat:other', 'm', '补充')
    with ThreadPoolExecutor(2) as pool:
        replies = list(pool.map(lambda _: live.steer(lid, 'u:chat:a', 'm', '补充'), range(2)))
    assert all(r['status'] == 'accepted' for r in replies)
    assert sent == ['补充']
    live.unbind_steering(lid)
    live.finish(lid, True)
    assert live.steer(lid, 'u:chat:a', 'm', '补充')['status'] == 'accepted'
    with pytest.raises(live.SteerRejected):
        live.steer(lid, 'u:chat:a', 'new', 'too late')
    assert live.steering_inputs(lid)[0]['text'] == '补充'
    assert not next(r for r in live.snapshot() if r['id'] == lid)['can_steer']


def test_rejected_unknown_and_stop_never_replay():
    for fail, status in [(live.SteerRejected, 'rejected'), (TimeoutError, 'uncertain')]:
        lid = live.start('codex', tags={'conversation': 'u:c'})
        calls = []
        def callback(text):
            calls.append(text)
            raise fail('failed')
        live.bind_steering(lid, callback)
        assert live.steer(lid, 'u:c', 'm', 'x')['status'] == status
        assert live.steer(lid, 'u:c', 'm', 'x')['status'] == status
        assert calls == ['x']
        assert not live.steering_inputs(lid)
        live.stop(lid)
        with pytest.raises(live.SteerRejected):
            live.steer(lid, 'u:c', 'other', 'x')
        live.finish(lid, False)
    assert live.steer('expired-run', 'u:c', 'm', 'x')['status'] == 'uncertain'


def test_finish_waits_for_steer_acknowledgement():
    lid = live.start('codex', tags={'conversation': 'u:c'})
    entered, release = threading.Event(), threading.Event()
    def callback(text):
        entered.set()
        assert release.wait(3)
        return {'turnId': 't'}
    live.bind_steering(lid, callback)
    with ThreadPoolExecutor(2) as pool:
        delivery = pool.submit(live.steer, lid, 'u:c', 'm', 'x')
        assert entered.wait(3)
        finishing = pool.submit(live.finish, lid, True)
        assert not finishing.done()
        release.set()
        assert delivery.result()['status'] == 'accepted'
        finishing.result()
    assert live.steering_inputs(lid)[0]['text'] == 'x'


def test_codex_steers_exact_active_turn_without_another_turn_start(tmp_path, monkeypatch):
    monkeypatch.setenv('PGA_LINKS_FILE', str(tmp_path/'links.json'))
    srv = links.CodexServer('test', [], {})
    started = threading.Event()
    calls = []
    class Rpc:
        def request(self, method, params, timeout):
            calls.append((method, params))
            if method == 'thread/start': return {'thread': {'id': 'thread-one'}}
            if method == 'turn/start':
                started.set()
                return {'turn': {'id': 'active-turn'}}
            assert method == 'turn/steer'
            assert params == {'threadId': 'thread-one', 'expectedTurnId': 'active-turn', 'input': [{'type':'text','text':'补充'}]}
            srv._notify({'method':'item/completed','params':{'threadId':'thread-one','turnId':'active-turn','item':{'type':'agentMessage','text':'听到了补充'}}})
            srv._notify({'method':'turn/completed','params':{'threadId':'thread-one','turnId':'active-turn','turn':{'status':'completed'}}})
            return {'turnId': 'active-turn'}
    srv.rpc = Rpc()
    ad = CodexLocal.__new__(CodexLocal); ad.config = {}
    lid = live.start('test', tags={'conversation':'u:c'})
    task = AgentTask(prompt='initial', workspace=str(tmp_path), timeout_s=5, meta={'live_id':lid,'conversation':'u:c'})
    with ThreadPoolExecutor(1) as pool:
        result = pool.submit(srv.turn, ad, task)
        assert started.wait(2)
        deadline = time.monotonic()+2
        while not next(r for r in live.snapshot() if r['id']==lid).get('can_steer'):
            assert time.monotonic() < deadline
            time.sleep(.005)
        assert live.steer(lid, 'u:c', 'm', '补充')['status'] == 'accepted'
        assert result.result().text == '听到了补充'
    assert [m for m,p in calls].count('turn/start') == 1
    assert live.steering_inputs(lid)[0]['text'] == '补充'
    live.finish(lid, True)


def test_steer_endpoint_scope_validation_and_receipts(session_factory, policy, provider, backend, user):
    from fastapi.testclient import TestClient
    from pga.api.app import create_app
    from pga.runtime import Runtime
    lid = live.start('codex', tags={'conversation': f'{user.id}:chat:a'})
    live.bind_steering(lid, lambda text: {'turnId': 't'})
    app = create_app(session_factory=session_factory, runtime_factory=lambda s: Runtime(s, policy=policy, provider=provider, translation_backend=backend))
    url = f'/v1/users/{user.id}/agents/live/{lid}/steer'
    with TestClient(app) as client:
        assert client.post(url,json={'text':'x'}).status_code == 422
        assert client.post(url,json={'conversation':'chat:b','message_id':'m','text':'x'}).json()['status'] == 'rejected'
        body={'conversation':'chat:a','message_id':'m','text':'补充'}
        assert client.post(url,json=body).json()['status'] == 'accepted'
        live.finish(lid, True)
        assert client.post(url,json=body).json()['status'] == 'accepted'
