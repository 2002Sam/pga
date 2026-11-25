"""Manager startup observation and bounded failover, without real providers."""
import pytest
from pga.agents import live
from pga.agents.base import AgentResult
from pga.agents.pool import AgentPool
from pga.agents.routing import AgentRouter
from tests.test_routing import cfg


def test_check_is_once_and_does_not_stop_queue():
    lid = live.start('test')
    live.set_extra(lid, 'phase', 'queued')
    check = live.check_start(lid)
    assert check['state'] == 'queued'
    live.append(lid, 'working')
    assert live.check_start(lid) == check
    assert not live.stopped(lid)
    live.finish(lid, True)


def test_silence_is_unknown_and_output_is_started():
    lid = live.start('test')
    live.set_extra(lid, 'phase', 'running')
    assert live.check_start(lid)['state'] == 'unknown'
    live.finish(lid, True)
    lid = live.start('test')
    live.append(lid, 'working')
    assert live.check_start(lid)['state'] == 'started'
    live.finish(lid, True)


@pytest.mark.parametrize('error', ['401 unauthorized', 'quota exhausted', 'network unavailable', 'unexpected failure'])
def test_exception_switches_and_report_persists(rt, user, cfg, monkeypatch, error):
    pool = AgentPool(rt, cfg)
    router = AgentRouter(rt, pool)
    monkeypatch.setattr(router, 'rank', lambda *a, **k: [{'agent':'coder', 'usable':True}, {'agent':'thinker', 'usable':True}])
    def broken(task):
        raise RuntimeError(error)
    monkeypatch.setattr(pool.adapters['coder'], 'run', broken)
    monkeypatch.setattr(pool.adapters['thinker'], 'run', lambda task: AgentResult(ok=True, text='fixed'))
    result = router.ask(user, 'fix code', agent='coder', failover=True, conversation='chat:check', access='full')
    assert result['ok'] and result['agent'] == 'thinker'
    assert result['dispatch_reports'] == [{'agent':'coder', 'error':'RuntimeError: ' + error, 'to':'thinker'}]
    from pga.db.models import AgentRun
    import uuid
    assert rt.session.get(AgentRun, uuid.UUID(result['run_id'])).data['dispatch_reports'] == result['dispatch_reports']


def test_timer_is_ten_seconds_and_cleaned_up(rt, cfg, monkeypatch):
    from pga.agents import pool as module
    events = []
    class Timer:
        def __init__(self, seconds, callback, args):
            events.append(seconds)
            self.callback, self.args = callback, args
        def start(self):
            self.callback(*self.args)
        def cancel(self):
            events.append('cancel')
        def join(self):
            events.append('join')
    monkeypatch.setattr(module.threading, 'Timer', Timer)
    pool = AgentPool(rt, cfg)
    monkeypatch.setattr(pool.adapters['coder'], 'run', lambda task: AgentResult(ok=True, text='done'))
    task = pool._task('coder', 'test', system='', kind='code', workspace=None, permissions='read_only', timeout_s=30, want_json=False, meta={'manager_failover':True})
    step = pool._call('coder', task, 'run')
    assert events == [10.0, 'cancel', 'join']
    assert step.result.data['start_check']['state'] == 'unknown'


def test_stopped_task_never_switches(rt, user, cfg, monkeypatch):
    pool = AgentPool(rt, cfg)
    router = AgentRouter(rt, pool)
    monkeypatch.setattr(router, 'rank', lambda *a, **k: [{'agent':'thinker', 'usable':True}])
    monkeypatch.setattr(pool.adapters['coder'], 'run', lambda task: AgentResult(ok=False, status='STOPPED', error='stopped'))
    monkeypatch.setattr(pool.adapters['thinker'], 'run', lambda task: pytest.fail('must not retry user stop'))
    result = router.ask(user, 'fix code', agent='coder', failover=True, access='full')
    assert result['stopped'] and len(result['tried']) == 1


def test_unusable_fallback_is_not_retried(rt, user, cfg, monkeypatch):
    pool = AgentPool(rt, cfg)
    router = AgentRouter(rt, pool)
    monkeypatch.setattr(router, 'rank', lambda *a, **k: [{'agent':'thinker', 'usable':False}])
    monkeypatch.setattr(pool.adapters['coder'], 'run', lambda task: AgentResult(ok=False, status='FAILED', error='quota'))
    monkeypatch.setattr(pool.adapters['thinker'], 'run', lambda task: pytest.fail('unusable fallback'))
    result = router.ask(user, 'fix code', agent='coder', failover=True, fallback=['thinker', 'coder'], access='full')
    assert not result['ok'] and len(result['tried']) == 1
    assert result['dispatch_reports'][0]['to'] is None
