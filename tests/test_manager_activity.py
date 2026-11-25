"""Category feed regressions: actual workflow parents, live handoff and isolation."""
import uuid
from datetime import datetime, timezone

from pga import project_context as P, projectsort
from pga.agents import live
from pga.db.models import AgentRun


def test_activity_workflow_note_live_and_steering(rt, user, session, monkeypatch):
    monkeypatch.setattr(live, '_RUNS', {})
    projectsort.assign(user, 'chat:a', 'PGA')
    projectsort.assign(user, 'chat:other', '论文思考')
    now = datetime.now(timezone.utc)
    rid = uuid.uuid4()
    text = '完整用户消息' * 100
    lid = live.start('codex')
    meta = dict(id=str(rid), user_id=str(user.id), key='chat:a', text=text, at=now.isoformat())
    live.set_extra(lid, '_manager_activity', meta)
    live.set_extra(lid, 'env', {'model':'gpt-test'})
    live.set_extra(lid, 'effort', 'high')
    live.step(lid, {'t':'tool', 'tool':'Read', 'text':'src/main.py', 'id':'x'})
    live.step_output(lid, 'x', 'partial output')
    live.step(lid, {'t':'note', 'text':'公开的中间说明'})
    live.step(lid, {'t':'thought', 'text':'private reasoning'})
    live.append(lid, 'Visible progress')
    live.set_extra(lid, 'steering', [dict(id='s1', text='追加要求', at=now.timestamp())])
    other = live.start('codex')
    live.set_extra(other, '_manager_activity', {**meta, 'id':'outside', 'key':'chat:other'})
    stranger = live.start('codex')
    live.set_extra(stranger, '_manager_activity', {**meta, 'id':'stranger', 'user_id':str(uuid.uuid4())})
    assert all('_manager_activity' not in x for x in live.snapshot())
    rows = P.activity(rt, user, 'PGA')
    assert [r['text'] for r in rows] == [text, '追加要求']
    assert rows[0]['status'] == 'RUNNING'
    assert any(p.get('output') == 'partial output' for p in rows[0]['progress'])
    assert any(p.get('text') == '公开的中间说明' for p in rows[0]['progress'])
    assert rows[0]['model'] == 'gpt-test' and rows[0]['effort'] == 'high'
    assert any(p.get('tool') == 'Read' for p in rows[0]['progress'])
    assert all('thought' not in str(p) and 'private reasoning' not in str(p) for p in rows[0]['progress'])
    parent = AgentRun(id=rid, user_id=user.id, workflow='ask', pattern='single', step='workflow',
        agent='codex', adapter='pool', status='SUCCEEDED', prompt=text, output='完成',
        data={'conversation':'chat:a', 'steering':[dict(id='s1', text='追加要求', at=now.timestamp())]}, started_at=now)
    session.add(parent)
    session.flush()
    session.add(AgentRun(user_id=user.id, parent_id=rid, workflow='ask', pattern='single', step='run',
        agent='codex', adapter='x', status='SUCCEEDED', prompt='模型内部提示', data={'conversation':'chat:a'}, started_at=now))
    session.add(AgentRun(user_id=user.id, workflow='ask', pattern='single', step='note', agent='you',
        adapter='note', status='SUCCEEDED', prompt='用户笔记', data={'conversation':'chat:a','note':True}, started_at=now))
    session.flush()
    rows = P.activity(rt, user, 'PGA')
    assert len(rows) == 3
    assert next(r for r in rows if r['id'] == str(rid))['status'] == 'SUCCEEDED'
    assert {r['text'] for r in rows} == {text, '追加要求', '用户笔记'}
    user.preferences = {**user.preferences, 'archived_chats':['chat:a']}
    assert len(P.activity(rt, user, 'PGA')) == 3
    projectsort.assign(user, 'chat:a', '论文思考')
    assert not P.activity(rt, user, 'PGA')


def test_live_and_saved_progress_metadata_match_without_reading_transcripts(rt, user, session, monkeypatch):
    monkeypatch.setattr(live, '_RUNS', {})
    key = 'chat:mt-inline'
    projectsort.assign(user, key, 'PGA')
    now = datetime.now(timezone.utc)
    rid = uuid.uuid4()
    lid = live.start('codex')
    live.set_extra(lid, '_manager_activity', dict(id=str(rid), user_id=str(user.id), key=key,
        text='实现按钮', at=now.isoformat(), requested_effort='high'))
    live.set_extra(lid, 'env', {'model': 'reported-model', 'reasoning_effort': 'medium'})
    live.step(lid, {'t':'think', 'text':'private reasoning'})
    live.step(lid, {'t':'tool', 'tool':'Read', 'title':'检查按钮文件'})
    live.append(lid, '正在验证界面')
    row = P.activity(rt, user, 'PGA')[0]
    assert (row['model'], row['effort'], row['requested_effort']) == ('reported-model','medium','high')
    assert row['progress'][0]['text'] == '检查按钮文件'
    assert 'private reasoning' not in str(row['progress'])
    saved = live.manager_record(lid)
    parent = AgentRun(id=rid, user_id=user.id, workflow='ask', pattern='single', step='workflow',
        agent='codex', adapter='pool', status='SUCCEEDED', prompt='实现按钮', output='全部完成',
        data={'conversation':key,'agent':'codex','effort':'high'}, started_at=now)
    session.add(parent);session.flush()
    session.add(AgentRun(user_id=user.id, parent_id=rid, workflow='ask', pattern='single', step='run',
        agent='codex', adapter='test', status='SUCCEEDED', data=saved, started_at=now))
    session.flush()
    monkeypatch.setattr(live, '_RUNS', {})
    row = P.activity(rt, user, 'PGA')[0]
    assert row['answer'] == '全部完成'
    assert (row['model'],row['effort'],row['requested_effort']) == ('reported-model','medium','high')
    assert any(x.get('tool') == 'Read' for x in row['progress'])
    assert 'private reasoning' not in str(row['progress'])
    parent.data = {'conversation':key,'agent':'codex','effort':'xhigh'}
    child = session.query(AgentRun).filter_by(parent_id=rid).one()
    child.data = {'model':'unreported-effort'}
    session.flush()
    row = P.activity(rt,user,'PGA')[0]
    assert row['effort'] == '' and row['requested_effort'] == 'xhigh'
