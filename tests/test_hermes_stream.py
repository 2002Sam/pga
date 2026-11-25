"""Synthetic Hermes protocol replay, never a real conversation or account."""
import json
import sys
from pathlib import Path

import pytest
from pga.agents import live
from pga.agents.adapters import HermesLocal, RAW
from pga.agents.base import AgentTask
from pga.agents.hermes import clean_output, parse_output

FIXTURE = Path(__file__).parent / 'fixtures' / 'hermes-stream.jsonl'


def replay(lines):
    lid = live.start('hermes-display-test')
    task = AgentTask(prompt='test', meta={'live_id':lid})
    ad = HermesLocal('h', {})
    try:
        for line in lines:
            text = ad.progress(line, task)
            if text:
                live.append(lid, text[1:] if text.startswith(RAW) else text + '\n')
        return next(r for r in live.snapshot() if r['id'] == lid)
    finally:
        live.finish(lid, True)


def test_protocol_events_render_unicode_tools_and_answer_separately():
    row = replay(FIXTURE.read_text().splitlines())
    assert row['text'] == '我先检查配置。\n\n**检查完成**：显示正常。'
    assert row['env']['model'] == 'demo-model'
    assert len(row['steps']) == 2
    assert row['steps'][0]['title'] == 'README.md'
    assert row['steps'][0]['output'] == '读取完成：中文内容正常'
    assert row['steps'][1]['title'] == 'python -m pytest'
    assert row['steps'][1]['output'] == '2 passed\n'
    assert all('secs' in st for st in row['steps'])
    assert row['usage']['input_tokens'] == 120
    assert 'tool_use' not in row['text'] and '\\u' not in row['text']


def test_final_reply_uses_terminal_envelope_not_concatenated_json():
    result = parse_output(FIXTURE.read_text(), '')
    assert result.ok and result.text == '我先检查配置。\n\n**检查完成**：显示正常。'
    assert result.model == 'demo-model' and result.session_id == 'demo-session'


@pytest.mark.parametrize('code,status', [(1,'FAILED'),(130,'STOPPED')])
def test_partial_answer_with_failure_is_not_success(code, status):
    result = parse_output(json.dumps({'type':'result','exit_code':code,'text':'partial','error':'任务未完成'}),'')
    assert not result.ok and result.status == status and result.error == '任务未完成'


def test_missing_terminal_result_keeps_partial_text_but_reports_interruption():
    result = parse_output('{"type":"text","text":"部分输出"}\n', '')
    assert not result.ok and result.text == '部分输出' and '中断' in result.error


def test_terminal_controls_are_removed_without_reinterpreting_literal_code():
    value = '\x1b]8;;https://example.org\x07中文\x1b]8;;\x1b\\\x1b[31m红色\x1b[0m\r\nC:\\new\\test \\u4e2d'
    assert clean_output(value) == '中文红色\nC:\\new\\test \\u4e2d'
    row = replay(['\x1b[2Kprogress...', '{"type":"heartbeat","payload":"internal"}', 'Session: hidden'])
    assert row['text'] == ''


def test_repeated_tool_names_pair_in_order_and_error_remains_visible():
    events = [{'type':'tool_use','name':'terminal','input':{'command':'one'}},
              {'type':'tool_use','name':'terminal','input':{'command':'two'}},
              {'type':'tool_result','name':'terminal','output':'first','is_error':False},
              {'type':'tool_result','name':'terminal','output':'second','is_error':True}]
    steps = replay(map(json.dumps,events))['steps']
    assert steps[0]['output'] == 'first' and not steps[0].get('error')
    assert steps[1]['output'] == 'second' and steps[1]['error']


def test_result_only_and_replay_gap_add_only_missing_suffix():
    result = {'type':'result','exit_code':0,'text':'完整回答'}
    assert replay([json.dumps(result)])['text'] == '完整回答'
    assert replay([json.dumps({'type':'text','text':'完整'}),json.dumps(result)])['text'] == '完整回答'


def test_subprocess_protocol_stream_reaches_live_display(tmp_path):
    script=tmp_path/'hermes-demo'
    script.write_text(f'#!{sys.executable}\nimport sys\nassert sys.argv[sys.argv.index("--format")+1]=="stream-json"\nsys.stdin.read()\nprint({FIXTURE.read_text()!r},flush=True)\n')
    script.chmod(0o700)
    ad=HermesLocal('h',{'command':str(script),'connect':'cli'})
    lid=live.start('hermes-process-test')
    try:
        result=ad.run(AgentTask(prompt='test',workspace=str(tmp_path),meta={'live_id':lid}))
        row=next(r for r in live.snapshot() if r['id']==lid)
        assert result.ok and result.text==row['text']
        assert len(row['steps'])==2 and row['steps'][0]['output']=='读取完成：中文内容正常'
    finally:
        live.finish(lid,True)


def test_api_events_use_the_same_readable_steps(monkeypatch):
    import httpx
    from contextlib import contextmanager
    from types import SimpleNamespace
    from pga.agents.links import HermesApi
    events=[{'event':'message.delta','delta':'\x1b[32m正在检查\x1b[0m'},
            {'event':'tool.started','tool':'terminal','tool_call_id':'t1','kwargs':{'command':'echo test'}},
            {'event':'tool.completed','tool':'terminal','tool_call_id':'t1','preview':'\x1b[31mtest\x1b[0m','error':False},
            {'event':'reasoning.available','text':'核对命令输出。'},
            {'event':'run.completed','output':'检查完成'}]
    monkeypatch.setattr(httpx,'post',lambda *a,**kw:SimpleNamespace(status_code=200,json=lambda:{'run_id':'test'}))
    @contextmanager
    def stream(*a,**kw):
        yield SimpleNamespace(iter_lines=lambda:iter('data: '+json.dumps(event) for event in events))
    monkeypatch.setattr(httpx,'stream',stream)
    lid=live.start('hermes-api-display')
    try:
        result=HermesApi('http://unused','fake-key').run(HermesLocal('h',{}),AgentTask(prompt='test',meta={'live_id':lid}))
        row=next(r for r in live.snapshot() if r['id']==lid)
        assert result.ok and result.text=='检查完成'
        assert row['text']=='正在检查'
        assert row['steps'][0]['title']=='echo test' and row['steps'][0]['output']=='test'
        assert row['steps'][1]['t']=='think' and row['steps'][1]['text']=='核对命令输出。'
    finally:
        live.finish(lid,True)
