import time
from concurrent.futures import ThreadPoolExecutor
import pytest
from pga.agents import approvals, live, links
from pga.agents.base import AgentTask, AUTO, READ_ONLY


def wait_pending(lid):
    for _ in range(100):
        r = next(x for x in live.snapshot() if x['id'] == lid)
        if r.get('approval'):
            return r['approval']['id']
        time.sleep(.01)
    raise AssertionError('no pending approval')


def test_codex_waits_for_user_and_full_is_run_scoped():
    lid = live.start('cx', tags={'conversation': 'user:chat:a'})
    task = AgentTask(prompt='test', permissions=AUTO, timeout_s=5, meta={'live_id':lid,'conversation':'user:chat:a'})
    srv = links.CodexServer('cx', [], {})
    srv.approval_tasks['t'] = task
    msg = {'method':'item/fileChange/requestApproval','params':{'threadId':'t','reason':'write file'}}
    with ThreadPoolExecutor() as pool:
        f = pool.submit(srv._answer, msg)
        aid = wait_pending(lid)
        assert not f.done()
        with pytest.raises(KeyError): approvals.answer(aid,'other','full')
        approvals.answer(aid,'user','full')
        assert f.result(timeout=2) == {'decision':'accept'}
        assert srv._answer(msg) == {'decision':'accept'}
    task.permissions = READ_ONLY
    assert srv._answer(msg) == {'decision':'decline'}
    live.finish(lid, True)
    assert lid not in approvals._FULL_RUNS


def test_denial_and_stop_do_not_release_tool():
    lid = live.start('cx', tags={'conversation':'user:chat:b'})
    task = AgentTask(prompt='test', permissions=AUTO, timeout_s=3, meta={'live_id':lid,'conversation':'user:chat:b'})
    with ThreadPoolExecutor() as pool:
        f = pool.submit(approvals.request, task, {'tool':'Write'})
        aid = wait_pending(lid)
        approvals.answer(aid,'user','deny')
        assert f.result(timeout=2) is False
        with pytest.raises(KeyError): approvals.answer(aid,'user','allow')
    live.finish(lid, True)
