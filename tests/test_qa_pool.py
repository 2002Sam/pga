"""Exercise dispatch and transcript isolation with real worker threads and a gated agent."""
import json
import threading

import pytest
from sqlalchemy.orm import sessionmaker

from pga import manager_dispatch, project_context
from pga.agents.routing import AgentRouter
from pga.api.app import create_app
from pga.db.models import AgentRun, User
from pga.db.types import utcnow
from pga.permissions import create_default_policy
from pga.runtime import Runtime


@pytest.mark.parametrize("kind", ["qa", "execute"])
def test_parallel_questions_contextual_followup_and_public_feed(engine, policy, provider, backend, monkeypatch, kind):
    sessions = sessionmaker(engine, expire_on_commit=False)
    runtime = lambda s: Runtime(s, policy=policy, provider=provider, translation_backend=backend)
    app = create_app(session_factory=sessions, runtime_factory=runtime)
    endpoint = lambda name: next(r.endpoint for r in app.routes if getattr(r, 'name', None) == name)
    first, other, follow = '解释缓存命中率', '月球是什么颜色', '继续解释刚才的缓存命中率'
    entered = {q: threading.Event() for q in (first, other, follow)}
    unblock = threading.Event()
    received = {}
    async def offline(*args):
        raise TimeoutError()
    monkeypatch.setattr(manager_dispatch, '_deepseek', offline)
    monkeypatch.setattr(manager_dispatch, '_ranks', lambda *args: ({k: [{'agent': 'fake', 'score': 1, 'usable': True, 'tools': True}]
                                                          for k in manager_dispatch.KINDS}, {}, {}))
    def answer(router, user, text, **kw):
        received[text] = (kw['conversation'], [h['text'] for h in kw['history']], kw['tail'])
        entered[text].set()
        if text == first:
            assert unblock.wait(15)
        row = AgentRun(user_id=user.id, workflow='ask', pattern='single', step='workflow',
                       agent='fake', adapter='pool', status='SUCCEEDED', prompt=text, output='答' + text,
                       data={'conversation': kw['conversation'], 'manager_task_id': kw['manager_task_id']},
                       started_at=utcnow(), finished_at=utcnow())
        router.rt.session.add(row)
        router.rt.session.flush()
        return {'ok': True, 'run_id': str(row.id)}
    monkeypatch.setattr(AgentRouter, 'ask', answer)

    with sessions() as session:
        rt = runtime(session)
        permission = create_default_policy(session, policy)
        u = User(permission_policy_id=permission.id, preferences={})
        session.add(u)
        manager = project_context.manager_key(u, 'PGA')
        session.commit()
        def submit(text, **fields):
            result = endpoint('manager_submit')(u.id, {'conversation':manager, 'text':text, **fields}, rt)
            return result['entry']['tasks'][0]
        def wait_for_thread(key):
            previous, release = manager_dispatch.execution_slot(u.id, key)
            try:
                assert previous is None or previous.wait(10)
            finally:
                release()
        try:
            feed_key = project_context.manager_defaults(u, 'PGA')[kind]['key']
            def submit_feed(text):
                return endpoint('agents_ask')(u.id, {'conversation': feed_key, 'text': text}, rt)['entry']['tasks'][0]
            a = submit_feed(first)
            assert a['key'] == feed_key
            assert entered[first].wait(5)
            b = submit_feed(other)
            assert entered[other].wait(5)
            c = submit(follow)
            assert a['worker'] != b['worker'] and c['worker'] == a['worker']
            assert not entered[follow].is_set()
            unblock.set()
            wait_for_thread(a['worker'])
            wait_for_thread(b['worker'])
            assert received[first][1] == received[other][1] == []
            assert received[follow][1] == [first, '答' + first]
            assert other not in received[follow][2]
            assert a['key'] == b['key'] == c['key']
            feed = endpoint('chats_one')(u.id, a['key'], rt)
            assert feed['qa_count'] == 3
            assert {t['text'] for t in feed['turns'] if t['role'] == 'agent'} == {'答' + q for q in entered}
            assert {r['key'] for r in project_context.activity(rt, u, 'PGA')} == {a['key']}
            assert a['worker'] not in project_context.members(u, 'PGA')
            # A selected answer overrides an ambiguous request from the feed composer.
            run = next(t['run'] for t in feed['turns'] if t['text'] == other)
            reply = '再举个例子'
            entered[reply] = threading.Event()
            result = endpoint('agents_ask')(u.id, {'conversation':a['key'], 'reply_to':run, 'text':reply,
                                                   'history':[{'role':'user','text':first}]}, rt)
            assert result['entry']['tasks'][0]['worker'] == b['worker']
            wait_for_thread(b['worker'])
            assert received[reply][1] == [other, '答' + other]
            # The selected reply is one candidate for the planner, not a blanket
            # override of every task in a compound request.
            example, unrelated = '再举个缓存的例子。', '另外，海水为什么是咸的？'
            entered.update({example: threading.Event(), unrelated: threading.Event()})
            async def split_request(text, context, candidates):
                assert candidates[0]['key'] == a['worker'] and a['worker'] in context
                return json.dumps({'tasks': [
                    {'parts': [1], 'kind': 'quick', 'destination': 'qa', 'context': a['worker']},
                    {'parts': [2], 'kind': 'quick', 'destination': 'qa', 'context': ''},
                ]})
            monkeypatch.setattr(manager_dispatch, '_deepseek', split_request)
            run = next(t['run'] for t in feed['turns'] if t['text'] == first)
            result = endpoint('agents_ask')(u.id, {'conversation':a['key'], 'reply_to':run,
                                                   'text':example + unrelated}, rt)
            one, two = result['entry']['tasks']
            assert one['worker'] == a['worker'] and two['worker'] not in {a['worker'], b['worker']}
            wait_for_thread(one['worker'])
            wait_for_thread(two['worker'])
            assert received[example][1] == [first, '答' + first, follow, '答' + follow]
            assert received[unrelated][1] == []
        finally:
            unblock.set()
            session.delete(u)
            session.flush()
            session.delete(permission)
            session.commit()


def test_legacy_execution_turn_opens_its_isolated_worker_and_keeps_followups(rt, user):
    from datetime import timedelta
    from pga import chats, qa_pool
    from tests.test_chats import _run

    feed = project_context.manager_defaults(user, 'PGA')['execute']['key']
    now = utcnow()
    first = _run(user, 'original', 'one', now, feed)
    other = _run(user, 'unrelated', 'two', now, feed)
    rt.session.add_all([first, other])
    rt.session.flush()
    key = qa_pool.turn_thread(feed, first.id)
    follow = _run(user, 'followup', 'three', now + timedelta(seconds=1), key)
    rt.session.add(follow)
    rt.session.flush()
    app = create_app()
    read = next(r.endpoint for r in app.routes if getattr(r, 'name', None) == 'chats_one')
    rows = read(user.id, feed, rt)['turns']
    assert [t['text'] for t in rows if t['thread'] == key] == ['original', 'one', 'followup', 'three']
    assert [t['text'] for t in read(user.id, key, rt)['turns']] == ['original', 'one', 'followup', 'three']
    assert [t['text'] for t in chats.history(rt, user, key, first.id)] == ['original', 'one']
    assert not chats.branch_of(user, key)

    chats.set_branch(user, 'chat:previous-continuation', key, str(first.id))
    legacy_child, = read(user.id, feed, rt)['children']
    assert legacy_child['key'] == 'chat:previous-continuation'
    assert legacy_child['upto'] == str(first.id)
