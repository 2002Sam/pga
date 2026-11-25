"""Internal manager tasks retain their ledger without adding visible conversations."""
from datetime import timedelta
from pga import manager_dispatch, project_context, chats
from pga.api.app import create_app
from pga.agents import history
from pga.timeline import Timeline
from pga.db.models import AgentRun
from pga.db.types import utcnow


def test_default_tasks_share_public_conversations_and_keep_answers_in_history(rt, user, monkeypatch):
    manager = 'chat:pm-visibility'
    user.preferences = {**(user.preferences or {}), 'project_managers':{manager:'PGA'}}
    async def plan(*a, **kw):
        return {'tasks':[{'title':f'修改{i}', 'text':f'修改需求{i}', 'agent':'codex','context':''} for i in range(4)]}
    monkeypatch.setattr(manager_dispatch,'plan',plan)
    workers=[]
    class Worker:
        def __init__(self,target,args,**kwargs): self.request=args[0]
        def start(self): workers.append(self.request)
    monkeypatch.setattr('pga.api.app.threading.Thread',Worker)
    app=create_app()
    endpoint=lambda suffix,method:next(r.endpoint for r in app.routes if getattr(r,'path','').endswith(suffix) and method in r.methods)
    submit=endpoint('/chats/manager-submit','POST')
    internal=submit(user.id,{'conversation':manager,'text':'四项修改'},rt)['entry']
    public=submit(user.id,{'conversation':manager,'text':'四项修改','create_conversations':True},rt)['entry']
    hidden={t['key'] for t in internal['tasks']}; shown={t['key'] for t in public['tasks']}
    assert len(workers)==8 and all(k.startswith('chat:summary-') for k in hidden) and hidden == shown
    assert all(not k.startswith('chat:mt-') for k in shown)
    for task in workers:
        rt.session.add(AgentRun(user_id=user.id,workflow='ask',pattern='single',step='workflow',
            agent='codex',adapter='test',status='SUCCEEDED',prompt=task['text'],output='修改结果完整保留',
            data={'conversation':task['conversation'],'agent':'codex'},started_at=utcnow()))
    rt.session.flush()
    catalog=endpoint('/conversation-projects','GET')(user.id,rt)
    assert shown <= catalog['drafts'].keys()
    listed=endpoint('/chats','GET')(user.id,limit=300,archived=False,rt=rt)
    assert shown <= {c['key'] for c in listed}
    overview=project_context.overview(rt,user,'PGA')
    assert shown <= {c['key'] for c in overview['conversations']}
    activity=project_context.activity(rt,user,'PGA')
    assert hidden | shown <= {r['key'] for r in activity}
    assert all(r['answer']=='修改结果完整保留' for r in activity)
