"""The manager persists its map before handing tasks to server workers."""
from pga.api.app import create_app
from pga import manager_dispatch


def test_submit_persists_tasks(rt, user, monkeypatch):
    key = 'chat:pm-test'
    user.preferences = {**(user.preferences or {}), 'project_managers': {key: 'PGA'}}
    rt.session.commit()
    async def plan(*args, **kwargs):
        return {'tasks': [{'title': '实现', 'text': '实现功能', 'agent': 'codex', 'kind': 'code', 'needs_code': True, 'context': ''}]}
    monkeypatch.setattr(manager_dispatch, 'plan', plan)
    started = []
    class Worker:
        def __init__(self, target, args, **kwargs):
            self.request = args[0]
        def start(self):
            started.append(self.request)
    monkeypatch.setattr('pga.api.app.threading.Thread', Worker)
    app = create_app()
    submit = next(r.endpoint for r in app.routes if getattr(r, 'path', '').endswith('/chats/manager-submit'))
    result = submit(user.id, {'conversation': key, 'text': '实现功能', 'effort': 'high'}, rt)
    assert result['ok'] and len(started) == 1
    request = started[0]
    assert request['access'] == 'full' and request['scope'] == 'PGA'
    assert request['effort'] == 'high'
    assert request['category'] == 'code' and request['needs_code'] is True
    assert result['entry']['create_conversations'] is True
    assert result['entry']['effort'] == 'high'
    assert result['entry']['tasks'][0]['text'] == '实现功能'
    assert result['entry']['tasks'][0]['effort'] == 'high'
    from pga.db.models import AgentRun
    import uuid
    note = rt.session.get(AgentRun, uuid.UUID(result['entry']['run']))
    assert note.data['dispatch']['tasks'][0]['worker'] == request['conversation']
    assert note.data['dispatch']['tasks'][0]['key'] == result['defaults']['execute']['key']
    assert note.data['dispatch']['tasks'][0]['text'] == '实现功能'
    assert note.data['dispatch']['create_conversations'] is True


def test_submit_can_publish_generated_conversations(rt, user, monkeypatch):
    key = 'chat:pm-publish'
    user.preferences = {**(user.preferences or {}), 'project_managers': {key: 'PGA'}}
    rt.session.commit()
    async def plan(*args, **kwargs):
        return {'tasks': [{'title': '修复测试', 'text': '修复运行失败的测试', 'agent': 'codex', 'context': ''}]}
    monkeypatch.setattr(manager_dispatch, 'plan', plan)
    started = []
    class Worker:
        def __init__(self, target, args, **kwargs): self.request = args[0]
        def start(self): started.append(self.request)
    monkeypatch.setattr('pga.api.app.threading.Thread', Worker)
    app = create_app()
    submit = next(r.endpoint for r in app.routes if getattr(r, 'path', '').endswith('/chats/manager-submit'))
    result = submit(user.id, {'conversation': key, 'text': '修复运行失败的测试', 'create_conversations': True}, rt)
    assert result['ok'] and len(started) == 1
    task = result['entry']['tasks'][0]
    assert task['create_conversations'] is True
    assert task['text'] == '修复运行失败的测试'


def test_worker_startup_error_is_a_durable_failed_reply(rt, user, monkeypatch, session_factory):
    from pga import project_context
    key = 'chat:pm-worker-fail'
    user.preferences = {**(user.preferences or {}), 'project_managers':{key:'PGA'}}
    async def plan(*args, **kwargs):
        return {'tasks':[{'title':'测试启动失败','text':'测试启动失败','agent':'codex','context':''}]}
    monkeypatch.setattr(manager_dispatch,'plan',plan)
    workers=[]
    class Worker:
        def __init__(self,target,args,**kwargs): self.target,self.args=target,args
        def start(self): workers.append(self)
    monkeypatch.setattr('pga.api.app.threading.Thread',Worker)
    def unavailable_runtime(session):
        raise RuntimeError('模拟执行服务不可用')
    app=create_app(session_factory=session_factory,runtime_factory=unavailable_runtime)
    submit=next(r.endpoint for r in app.routes if getattr(r,'path','').endswith('/chats/manager-submit'))
    result=submit(user.id,{'conversation':key,'text':'测试启动失败'},rt)
    workers[0].target(*workers[0].args)
    rows=project_context.activity(rt,user,'PGA')
    row=next(r for r in rows if r['key']==result['entry']['tasks'][0]['key'])
    assert row['status']=='FAILED' and '模拟执行服务不可用' in row['error']


def test_reuses_two_default_conversations_and_related_target(rt, user, monkeypatch, tmp_path):
    from pga import memos
    monkeypatch.setattr(memos, "MEMO_DIR", tmp_path)
    image = {"name":"图", "data":"data:image/png;base64,YQ==", "paragraph":1}
    from pga import project_context, projectsort
    manager = project_context.manager_key(user, 'PGA')
    projectsort.assign(user, 'chat:related', 'PGA', create=True)
    projectsort.assign(user, 'chat:foreign', 'Other', create=True)
    rt.session.commit()
    planned = [{'title':'解释概念','text':'解释这个概念','kind':'serious','destination':'qa','context':''},
               {'title':'修复代码','text':'修复代码','kind':'code','destination':'execute','context':''},
               {'title':'继续修复','text':'继续修复','kind':'code','context':'chat:related'},
               {'title':'越界上下文','text':'解释概念','kind':'quick','context':'chat:foreign'}]
    async def plan(*args, **kwargs): return {'tasks':[{**t, 'agent':'codex'} for t in planned]}
    monkeypatch.setattr(manager_dispatch,'plan',plan)
    started=[]
    class Worker:
        def __init__(self,target,args,**kwargs): self.request=args[0]
        def start(self): started.append(self.request)
    monkeypatch.setattr('pga.api.app.threading.Thread',Worker)
    app=create_app()
    submit=next(r.endpoint for r in app.routes if getattr(r,'path','').endswith('/chats/manager-submit'))
    first=submit(user.id,{'conversation':manager,'text':'测试混合派发\n\n配图','images':[image],'files':[{'name':'文件'}],'effort':'high'},rt)
    second=submit(user.id,{'conversation':manager,'text':'再次派发'},rt)
    keys=[t['key'] for t in first['entry']['tasks']]
    assert keys==[t['key'] for t in second['entry']['tasks']]
    assert keys[0]==first['defaults']['qa']['key']==keys[3]
    assert keys[1]==first['defaults']['execute']['key']
    assert keys[2]=='chat:related'
    assert first['output']==''
    assert len({r['manager_task_id'] for r in started})==8
    assert all('history_from' not in r for r in started)
    assert started[0]['images']==[image] and started[0]['files']==[{'name':'文件'}]
    from pga.db.models import AgentRun
    import uuid
    note=rt.session.get(AgentRun,uuid.UUID(first['entry']['run']))
    picture, = note.data["manager_pictures"]
    assert picture["paragraph"] == 1
    assert memos.image_path(user.id, picture["url"].rsplit("/", 1)[-1]).read_bytes() == b"a"
    assert note.data['dispatch']['tasks'][0]['task_id']==started[0]['manager_task_id']
    assert user.preferences['chat_titles'][keys[0]]=='知识问答和回应'
    assert user.preferences['chat_titles'][keys[1]]=='执行'
    assert project_context.scope_of(user,keys[0])=='PGA'
    other=project_context.manager_defaults(user,'Other')
    assert other['qa']['key']!=keys[0]
    # No worker/model runs in this test; release all reserved slots.
    for r in started: r['_execution_slot'][1]()


def test_execution_slots_are_fifo_per_user_and_conversation():
    p1, done1=manager_dispatch.execution_slot('user','target')
    p2, done2=manager_dispatch.execution_slot('user','target')
    p3, done3=manager_dispatch.execution_slot('user','other')
    assert p1 is None and p3 is None and not p2.is_set()
    done1(); assert p2.is_set()
    done2(); done3()
    p4, done4=manager_dispatch.execution_slot('user','target')
    assert p4 is None
    done4()


def test_default_conversations_survive_category_rename_and_are_not_one_off(rt, user):
    from pga import project_context, projectsort, recycle
    original=project_context.manager_defaults(user,'PGA')
    # The same manager identity follows a category rename.
    prefs=user.preferences
    state=projectsort.state(user)
    state['list']=[*state['list'],'Renamed']
    projectsort.save(user,state)
    user.preferences={**user.preferences,'project_managers':{k:'Renamed' if v=='PGA' else v for k,v in prefs['project_managers'].items()}}
    renamed=project_context.manager_defaults(user,'Renamed')
    assert renamed==original
    assert all(project_context.scope_of(user,x['key'])=='Renamed' for x in renamed.values())
    assert recycle.plan(rt,user)==[]


def test_unavailable_agent_creates_no_assignment(rt, user, monkeypatch):
    import pytest
    from fastapi import HTTPException
    from sqlalchemy import func, select
    from pga import project_context
    from pga.db.models import AgentRun

    key = project_context.manager_key(user, 'PGA')
    async def no_agent(*args, **kwargs):
        return {'tasks': [{'agent': None, 'why': '没有可用的 agent'}]}
    monkeypatch.setattr(manager_dispatch, 'plan', no_agent)
    submit = next(r.endpoint for r in create_app().routes if getattr(r, 'name', None) == 'manager_submit')
    with pytest.raises(HTTPException) as error:
        submit(user.id, {'conversation': key, 'text': '实现功能'}, rt)
    assert error.value.status_code == 503
    assert rt.session.scalar(select(func.count()).select_from(AgentRun).where(AgentRun.user_id == user.id)) == 0
