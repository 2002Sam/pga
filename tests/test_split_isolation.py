"""Comparison lanes and frozen continuation boundaries."""
import json
import uuid
from types import SimpleNamespace
from unittest.mock import Mock

import pytest
import pga.chats as chats
from pga import project_context


def row(key, question, answer):
    return SimpleNamespace(id=uuid.uuid4(), data={'conversation':key,'agent':'a'}, prompt=question, output=json.dumps({'answer':answer}), agent='a')


def setup_history(monkeypatch):
    user=SimpleNamespace(id=uuid.uuid4(), preferences={})
    rows={'chat:p':[row('chat:p','q1','a1'),row('chat:p','FUTURE QUESTION','FUTURE ANSWER')]}
    monkeypatch.setattr(chats,'runs_of',lambda rt,uid,key:rows.get(key,[]))
    return user,rows


def test_invalid_cutoff_never_returns_whole_history(monkeypatch):
    user,rows=setup_history(monkeypatch)
    with pytest.raises(chats.ChatError):
        chats.history(None,user,'chat:p',uuid.uuid4())
    with pytest.raises(chats.ChatError):
        chats.branch_context(None,user,{'from':'chat:p','upto':str(uuid.uuid4())})


def test_snapshot_does_not_change_after_regeneration_or_future_messages(monkeypatch):
    user,rows=setup_history(monkeypatch)
    snap=chats.history(None,user,'chat:p',rows['chat:p'][0].id)
    b={'from':'chat:p','upto':str(rows['chat:p'][0].id),'snapshot':snap}
    rows['chat:p'][0].output=json.dumps({'answer':'changed later'})
    assert [t['text'] for t in chats.branch_context(None,user,b)]==['q1','a1']
    got=chats.branch_context(None,user,b);got[0]['text']='mutation'
    assert b['snapshot'][0]['text']=='q1'


def test_two_lanes_retain_only_their_own_answers(monkeypatch):
    user,rows=setup_history(monkeypatch)
    from pga.agents.routing import AgentRouter
    monkeypatch.setattr(AgentRouter,'__init__',lambda self,rt:setattr(self,'pool',SimpleNamespace(adapters={'a':1,'b':1})))
    monkeypatch.setattr(chats,'inherit',lambda *a,**kw:{})
    result=chats.start_split(None,user,'chat:p',['a','b'],rows['chat:p'][1].id)
    left,right=[l['key'] for l in result['lanes']]
    assert left!=right and all(k.startswith('second:') for k in [left,right])
    rows[left]=[row(left,'same question','LEFT ONLY')]
    rows[right]=[row(right,'same question','RIGHT ONLY')]
    lh=chats.history(None,user,left);rh=chats.history(None,user,right)
    assert [x['text'] for x in lh]==['q1','a1','same question','LEFT ONLY']
    assert [x['text'] for x in rh]==['q1','a1','same question','RIGHT ONLY']
    assert chats.start_split(None,user,'chat:p',['a','b'])==result
    assert chats.children(user,'chat:p')==[]


def test_same_agent_rejected(monkeypatch):
    user,rows=setup_history(monkeypatch)
    with pytest.raises(chats.ChatError):chats.start_split(None,user,'chat:p',['a','a'])


def test_imported_boundary_must_be_explicit(monkeypatch):
    monkeypatch.setattr(chats,'imported_turns',lambda *a:([{'text':'past'},{'text':'FUTURE'}],'title'))
    user=SimpleNamespace(preferences={})
    assert chats.branch_context(None,user,{'from':'imp:x','upto':'1'})==[{'text':'past'}]
    for cutoff in ['all','bad','-1','3']:
        with pytest.raises(chats.ChatError):chats.branch_context(None,user,{'from':'imp:x','upto':cutoff})


def test_project_retrieval_cannot_reintroduce_future_or_sibling_answers(monkeypatch):
    user=SimpleNamespace(preferences={'chat_branches':{'chat:new':{'from':'chat:p','upto':'0'}}})
    monkeypatch.setattr(project_context,'category',lambda *a:'PGA')
    search=Mock(side_effect=AssertionError('must not retrieve live project context'))
    monkeypatch.setattr(project_context,'search',search)
    result=project_context.build(None,user,'chat:new','question')
    assert result['project']=='PGA' and result['sources']==[]
    search.assert_not_called()
