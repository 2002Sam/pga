"""Measured edit events only; no real agents, repository scans or user files."""
import json

import pytest

from pga.agents import live, links
from pga.agents.adapters import CodexLocal, _stream_json_progress
from pga.agents.base import AgentTask
from pga.agents.code_progress import diff_stats, tool_stats
from pga.agents.hermes import progress_event

DIFF = 'diff --git a/main.py b/main.py\n--- a/main.py\n+++ b/main.py\n@@ -1,2 +1,3 @@\n same\n-old\n+new\n+extra\n'


@pytest.fixture
def run():
    lid = live.start('code-progress-test')
    yield lid
    live.finish(lid, True)


def stats(lid):
    return next(row for row in live.snapshot() if row['id'] == lid)['code_progress']


def test_diff_headers_renames_context_and_trailing_newlines():
    assert diff_stats(DIFF) == {'paths': ['main.py'], 'added': 2, 'removed': 1, 'partial': False}
    renamed = DIFF.replace('a/main.py b/main.py', 'a/old.py b/new.py').replace('--- a/main.py', '--- a/old.py').replace('+++ b/main.py', '+++ b/new.py')
    assert diff_stats(renamed)['paths'] == ['new.py']
    assert tool_stats('functions.Edit', {'file_path':'a.py','new_string':'one\ntwo\n','old_string':'old\n'})['added'] == 2
    assert tool_stats('Bash', {'command':'echo "+code"'}) is None
    assert tool_stats('apply_patch', []) is None
    assert diff_stats('a prose reply with +something') is None


def test_only_successful_edits_count_and_replayed_completions_do_not_double_count(run):
    code = tool_stats('Edit', {'file_path':'a.py','old_string':'old','new_string':'new\nextra'})
    live.step(run, {'t':'tool','tool':'Edit','id':'a'}, code=code)
    assert stats(run)['added'] == 0
    live.step_done(run, 'a'); live.step_done(run, 'a')
    live.step(run, {'t':'tool','tool':'Edit','id':'a','secs':0}, code=code)
    assert stats(run) == {'added':2,'removed':1,'files':1,'edits':1,'partial':False,'source':'tools'}
    live.step(run, {'t':'tool','tool':'Edit','id':'failed'}, code=code)
    live.step_done(run, 'failed', error=True)
    assert stats(run)['edits'] == 1
    live.step(run, {'t':'tool','tool':'Edit','id':'b','secs':0}, code=code)
    assert stats(run)['added'] == 4 and stats(run)['files'] == 1


def test_totals_survive_step_tail_eviction_and_runs_stay_isolated(run, monkeypatch):
    monkeypatch.setattr(live, 'MAX_STEPS', 2)
    code = tool_stats('Write', {'file_path':'a.py','content':'a\nb\n'})
    live.step(run, {'id':'slow'}, code=code)
    for i in range(5):
        live.step(run, {'id':str(i), 'secs':0}, code=code)
    live.step_done(run, 'slow')
    assert stats(run)['added'] == 12 and stats(run)['edits'] == 6
    other = live.start('other-code-test')
    try:
        assert stats(other)['added'] == 0
    finally:
        live.finish(other, True)


def test_turn_diff_replaces_instead_of_accumulates_and_reverts_to_zero(run):
    live.code_diff(run, DIFF); live.code_diff(run, DIFF)
    assert stats(run) == {'added':2,'removed':1,'files':1,'partial':False,'source':'turn_diff'}
    live.step(run, {'id':'item','secs':0}, code=tool_stats('Write', {'path':'a.py','content':'ignored\n'}))
    assert stats(run)['added'] == 2
    live.code_diff(run, '')
    assert stats(run)['added'] == stats(run)['removed'] == stats(run)['files'] == 0


@pytest.mark.parametrize('adapter', ['claude','hermes'])
def test_adapter_captures_full_edit_input_before_title_truncation(run, adapter):
    task = AgentTask(prompt='test', meta={'live_id':run})
    args = {'file_path':'large.py','content':'line\n'*500}
    if adapter == 'claude':
        _stream_json_progress(json.dumps({'type':'assistant','message':{'content':[{'type':'tool_use','name':'Write','id':'w','input':args}]}}), task)
        _stream_json_progress(json.dumps({'type':'user','message':{'content':[{'type':'tool_result','tool_use_id':'w','content':'ok'}]}}), task)
    else:
        progress_event({'type':'tool_use','id':'w','name':'write_file','input':args}, task)
        progress_event({'type':'tool_result','tool_call_id':'w','output':'ok'}, task)
    assert stats(run)['added'] == 500 and stats(run)['partial']


def test_codex_cli_counts_reported_files_and_excludes_failed_changes(run):
    task = AgentTask(prompt='test', meta={'live_id':run})
    ad = CodexLocal('fake', {})
    for status in ('failed','completed'):
        ad.progress(json.dumps({'type':'item.completed','item':{'type':'file_change','id':status,'status':status,
                                                               'changes':[{'path':'main.py','diff':DIFF}]}}), task)
    assert stats(run)['added'] == 2 and stats(run)['files'] == 1


def test_codex_server_uses_reported_aggregate_without_double_counting(tmp_path, monkeypatch, run):
    from .test_links import FAKE_APP_SERVER, _script
    monkeypatch.setenv('PGA_LINKS_FILE', str(tmp_path/'links.json'))
    events = [
        {'method':'item/completed','params':{'item':{'type':'fileChange','id':'edit','status':'completed','changes':[{'path':'main.py','diff':DIFF}]}}},
        {'method':'turn/diff/updated','params':{'diff':DIFF}},
        {'method':'turn/diff/updated','params':{'diff':DIFF}},
    ]
    insertion = '\n'.join('        send({**'+repr(event)+', "params": {**'+repr(event['params'])+', "threadId": tid, "turnId": turn}})' for event in events)
    script = FAKE_APP_SERVER.replace('        reply = ', insertion+'\n        reply = ')
    ad = CodexLocal('code-progress-fake', {'command':_script(tmp_path,'codex',script)})
    try:
        result = ad.run(AgentTask(prompt='test',workspace=str(tmp_path),meta={'live_id':run}))
        assert result.ok
        assert stats(run)['source'] == 'turn_diff' and stats(run)['added'] == 2
    finally:
        links.CodexServer.close_all()


def test_codex_edit_is_visible_before_completion_and_updates_in_place(run):
    item = {'type': 'file_change', 'id': 'edit', 'changes': [{'path': 'main.py', 'diff': DIFF}]}
    adapter = CodexLocal('fake', {})
    task = AgentTask(prompt='test', meta={'live_id': run})
    def send(event):
        adapter.progress(json.dumps({'type': event, 'item': item}), task)
    def steps():
        return next(row for row in live.snapshot() if row['id'] == run)['steps']
    send('item.started')
    assert steps()[0]['title'] == 'main.py' and steps()[0].get('secs') is None
    assert stats(run)['files'] == 0
    send('item.completed')
    send('item.completed')
    assert len(steps()) == 1 and steps()[0]['secs'] >= 0
    assert stats(run)['edits'] == 1 and stats(run)['added'] == 2
