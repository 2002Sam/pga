from .test_chats import _run
from datetime import datetime, timedelta, timezone
from pga.agents.routing import AgentRouter
from pga.api.app import create_app
from pga.runtime import Runtime
from fastapi.testclient import TestClient


def test_compare_lanes_and_continuation_server_boundary(session_factory, policy, provider, backend, user, session, monkeypatch):
    import uuid
    now = datetime.now(timezone.utc)
    first = _run(user, 'past question', 'past answer', now-timedelta(minutes=2), 'chat:boundary')
    later = _run(user, 'FUTURE QUESTION', 'FUTURE ANSWER', now-timedelta(minutes=1), 'chat:boundary')
    session.add_all([first,later]);session.commit()
    captured=[]
    monkeypatch.setattr(AgentRouter,'ask',lambda self,u,text,**kw: captured.append(kw) or {'ok':True,'text':'ok'})
    app=create_app(session_factory=session_factory,runtime_factory=lambda s:Runtime(s,policy=policy,provider=provider,translation_backend=backend))
    with TestClient(app) as c:
        base=f'/v1/users/{user.id}'
        bad=c.post(base+'/chats/branch',json={'from':'chat:boundary','upto':str(uuid.uuid4())})
        assert bad.status_code==422
        b=c.post(base+'/chats/branch',json={'from':'chat:boundary','upto':str(first.id)}).json()
        r=c.post(base+'/agents/ask',json={'conversation':b['key'],'text':'continue','agent':'codex','history':[{'role':'assistant','text':'FUTURE IN CLIENT'}]})
        assert r.status_code==200,r.text
        assert [h['text'] for h in captured[-1]['history']]==['past question','past answer']
        assert 'FUTURE' not in str(captured[-1])
        split=c.post(base+'/chats/compare-start',json={'key':'chat:boundary','agents':['codex','claude'],'run':str(later.id)})
        assert split.status_code==200,split.text
        lanes=split.json()['lanes']
        assert len({l['key'] for l in lanes})==2
        for lane in lanes:
            d=c.get(base+'/chats/'+lane['key']).json()
            assert [h['text'] for h in d['context']]==['past question','past answer']
            assert d['turns']==[]
        parent=c.get(base+'/chats/chat:boundary').json()
        assert parent['split']['lanes']==lanes
        assert all(not child['key'].startswith('second:') for child in parent['children'])
