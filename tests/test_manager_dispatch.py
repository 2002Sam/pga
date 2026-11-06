import asyncio
import time
from pga import manager_dispatch as m


def test_plan_maps_numbered_pieces_and_rejects_self_assignment(monkeypatch):
    async def good(*args):
        return '{"tasks":[{"title":"修复","parts":[1],"kind":"code"},{"title":"调研","parts":[2],"kind":"serious","note":"列出来源"}]}'
    monkeypatch.setattr(m, '_deepseek', good)
    r = asyncio.run(m.plan('修复界面。调研框架。'))
    assert r['planner'] == 'deepseek'
    assert [t['text'] for t in r['tasks']] == ['修复界面。', '调研框架。\n要求：列出来源']
    assert [t['kind'] for t in r['tasks']] == ['code', 'serious']

    async def bad(*args):
        return '{"tasks":[{"text":"测试","context":"manager"}]}'
    monkeypatch.setattr(m, '_deepseek', bad)
    r = asyncio.run(m.plan('测试'))
    assert r['fallback'] and r['tasks'][0]['text'] == '测试'


def test_pieces_no_task_took_are_kept_and_unknown_context_is_dropped(monkeypatch):
    async def partial(*args):
        return '{"tasks":[{"title":"一","parts":[1],"context":"chat:made-up"}]}'
    monkeypatch.setattr(m, '_deepseek', partial)
    t = asyncio.run(m.plan('第一件事。第二件事。'))['tasks'][0]
    assert '第二件事' in t['text'] and t['context'] == ''


def test_deadline_cancels_model_and_preserves_entire_request(monkeypatch):
    cancelled = []
    async def slow(*args):
        try:
            await asyncio.sleep(10)
        finally:
            cancelled.append(True)
    monkeypatch.setattr(m, '_deepseek', slow)
    monkeypatch.setattr(m, 'BUDGET', .03)
    start = time.monotonic()
    r = asyncio.run(m.plan('修复功能，同时保持旧行为'))
    assert time.monotonic() - start < .5
    assert r['fallback'] and r['tasks'][0]['text'] == '修复功能，同时保持旧行为'
    assert cancelled


def test_a_group_becomes_one_job_in_order_with_its_hardest_kind():
    jobs = m.jobs_of([{'title': '写脚本', 'text': 'A', 'kind': 'code', 'context': '', 'group': 'g'},
                      {'title': '列问题', 'text': 'B', 'kind': 'serious', 'context': '', 'group': ''},
                      {'title': '改段落', 'text': 'C', 'kind': 'write' if False else 'serious', 'context': 'chat:x', 'group': 'g'}])
    assert len(jobs) == 2
    assert jobs[0]['steps'] == 2 and jobs[0]['kind'] == 'code' and jobs[0]['context'] == 'chat:x'
    assert jobs[0]['text'].index('写脚本') < jobs[0]['text'].index('改段落')


def _row(agent, score, tools, usable=True, pref=None, rem=1.0):
    return {'agent': agent, 'score': score, 'tools': tools, 'usable': usable, 'preference': pref, 'remaining': rem}


def test_schedule_filters_to_agents_with_tools_outside_daily_chat():
    ranks = {'quick': [_row('deepseek', 6.0, False), _row('codex', 4.0, True)]}
    job = lambda: [{'kind': 'quick', 'context': '', 'title': 't', 'text': 't'}]
    assert m.schedule(job(), ranks, tools_only=True, load={}, affinity={})[0]['agent'] == 'codex'
    assert m.schedule(job(), ranks, tools_only=False, load={}, affinity={})[0]['agent'] == 'deepseek'
    only_chat = {'quick': [_row('deepseek', 6.0, False)]}
    j = m.schedule(job(), only_chat, tools_only=True, load={}, affinity={})[0]
    assert j['agent'] == 'deepseek' and '改用对话模型' in j['why']


def test_schedule_weighs_load_spreads_parallel_work_and_follows_context():
    ranks = {'code': [_row('claude', 6.3, True, pref=1), _row('claude-2', 5.8, True, pref=2), _row('codex', 4.0, True, pref=3),
                      _row('down', 9.0, True, usable=False)]}
    two = [{'kind': 'code', 'context': '', 'title': str(i), 'text': ''} for i in range(2)]
    assert [j['agent'] for j in m.schedule(two, ranks, tools_only=True, load={'claude': (0, 4)}, affinity={})] == ['claude', 'claude-2']
    busy = m.schedule([dict(two[0])], ranks, tools_only=True, load={'claude': (3, 4)}, affinity={})[0]
    assert busy['agent'] == 'claude-2'
    ctx = [{'kind': 'code', 'context': 'chat:old', 'title': 'x', 'text': ''}]
    j = m.schedule(ctx, {'code': [_row('claude', 5.0, True), _row('codex', 4.5, True)]}, tools_only=True, load={}, affinity={'chat:old': 'codex'})[0]
    assert j['agent'] == 'codex' and '上次处理过' in j['why']


def test_segments_split_lines_and_sentences():
    assert m.segments('1. 修bar\n2. 调研。然后写对比') == ['1. 修bar', '2. 调研。', '然后写对比']
