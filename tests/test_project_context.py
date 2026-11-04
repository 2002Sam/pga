import json
from datetime import datetime, timezone

import pytest
from fastapi.testclient import TestClient
from pga import project_context as P, projectsort
from pga.db.models import AgentRun
from pga.api.app import create_app
from pga.agents.routing import AgentRouter
from pga.runtime import Runtime


def seed(session, user, key, project, text, status='SUCCEEDED'):
    projectsort.assign(user, key, project)
    row = AgentRun(user_id=user.id, workflow='ask', pattern='single', step='run', agent='codex', adapter='x', status=status,
        prompt='缓存设计', output=json.dumps({'answer': text}, ensure_ascii=False), data={'conversation': key}, started_at=datetime.now(timezone.utc))
    session.add(row)
    session.flush()
    return row


def test_scope_move_archive_and_self(rt, user, session):
    seed(session, user, 'chat:self', 'PGA', '自己的缓存')
    seed(session, user, 'chat:other', 'PGA', '同项目缓存结论')
    seed(session, user, 'chat:paper', '论文思考', '论文缓存机密')
    seed(session, user, 'chat:failed', 'PGA', '失败缓存', 'FAILED')
    session.commit()
    result = P.build(rt, user, 'chat:self', '缓存')
    assert '同项目缓存结论' in result['text']
    assert all(x not in result['text'] for x in ['自己的缓存', '论文缓存机密', '失败缓存'])
    assert result['sources'][0]['run']
    projectsort.assign(user, 'chat:other', '论文思考')
    session.commit()
    assert not P.search(rt, user, 'PGA', '缓存', exclude='chat:self')
    projectsort.assign(user, 'chat:other', 'PGA')
    user.preferences = {**user.preferences, 'archived_chats': ['chat:other']}
    session.commit()
    assert not P.search(rt, user, 'PGA', '缓存', exclude='chat:self')


def test_settings_revision_limits_and_late_resource(rt, user, session):
    projectsort.assign(user, 'chat:self', 'PGA')
    session.commit()
    saved = P.update(rt, user, 'PGA', {'revision': 0, 'instructions': '回答使用中文', 'resources': '普通内容 ' * 1200 + 'quantumcache 专用缓存策略', 'memory': '确认结论'})
    assert saved['revision'] == 1 and saved['id']
    with pytest.raises(RuntimeError):
        P.update(rt, user, 'PGA', {'revision': 0, 'memory': '覆盖'})
    with pytest.raises(ValueError):
        P.update(rt, user, 'PGA', {'revision': 1, 'enabled': 'yes'})
    with pytest.raises(ValueError):
        P.update(rt, user, 'PGA', {'revision': 1, 'memory': 'x' * 10001})
    result = P.build(rt, user, 'chat:self', 'quantumcache')
    assert all(t in result['text'] for t in ['回答使用中文', '确认结论', 'quantumcache'])
    assert result['sources'][0]['offset'] > 2200
    assert len(result['text']) <= P.BUDGET
    P.update(rt, user, 'PGA', {'revision': 1, 'enabled': False})
    assert not P.build(rt, user, 'chat:self', 'quantumcache')['text']
    assert not P.build(rt, user, 'chat:unassigned', '缓存')['project']


def test_api_and_resumed_agent_tail(session_factory, session, user, policy, provider, backend, monkeypatch):
    seed(session, user, 'chat:self', 'PGA', '自己的缓存')
    seed(session, user, 'chat:other', 'PGA', '共享缓存决策')
    session.commit()
    captured = []
    def ask(self, u, text, **kw):
        captured.append(kw)
        return {'ok': True, 'text': 'done'}
    monkeypatch.setattr(AgentRouter, 'ask', ask)
    app = create_app(session_factory=session_factory, runtime_factory=lambda s: Runtime(s, policy=policy, provider=provider, translation_backend=backend))
    base = f'/v1/users/{user.id}'
    with TestClient(app) as c:
        assert c.get(base + '/project-context', params={'project': 'PGA'}).json()['members'] == 2
        saved = c.put(base + '/project-context', json={'project': 'PGA', 'revision': 0, 'instructions': '使用中文'})
        assert saved.status_code == 200, saved.text
        assert c.put(base + '/project-context', json={'project': 'PGA', 'revision': 0}).status_code == 409
        assert c.get(base + '/project-context', params={'project': 'missing'}).status_code == 422
        hits = c.get(base + '/project-context/search', params={'project': 'PGA', 'q': '缓存'}).json()['sources']
        assert hits and all(h['run'] for h in hits)
        response = c.post(base + '/agents/ask', json={'conversation': 'chat:self', 'text': '缓存怎么实现', 'agent': 'codex'})
        assert response.status_code == 200, response.text
        assert response.json()['project_context']['project'] == 'PGA'
        assert '共享缓存决策' in captured[0]['tail'] and '使用中文' in captured[0]['tail']
        assert '自己的缓存' not in captured[0]['tail']


def test_imported_alias_and_escaped_answer(rt, user, session):
    from pga.db.models import LinkedAgent, AgentConversation
    link = LinkedAgent(user_id=user.id, name='Archive', vendor='claude')
    session.add(link); session.flush()
    imported = AgentConversation(linked_agent_id=link.id, external_id='one', title='旧讨论', excerpt='缓存命中率达到目标')
    session.add(imported); session.flush()
    projectsort.assign(user, 'imp:' + str(imported.id), 'PGA')
    row = seed(session, user, 'chat:encoded', 'PGA', 'unused')
    row.prompt = '设计记录'
    row.output = json.dumps({'answer': '缓存分层策略'})
    session.commit()
    hits = P.search(rt, user, 'PGA', '缓存')
    assert {h['kind'] for h in hits} == {'conversation', 'import'}
    assert any(h['key'] == 'c:' + str(imported.id) for h in hits)


def test_category_map_and_manager(session_factory, session, user, policy, provider, backend, monkeypatch):
    seed(session, user, 'chat:root', 'PGA', '根对话结论')
    seed(session, user, 'chat:kid', 'PGA', '分支结论')
    seed(session, user, 'chat:wired', 'PGA', '引用结论')
    seed(session, user, 'chat:paper', '论文思考', '别的分类')
    user.preferences = {**user.preferences, 'chat_branches': {'chat:kid': {'from': 'chat:root', 'upto': 'x'}},
                        'chat_titles': {'chat:root': '缓存总设计'}}
    session.commit()
    captured = []
    monkeypatch.setattr(AgentRouter, 'ask', lambda self, u, text, **kw: captured.append(kw) or {'ok': True, 'text': 'done'})
    app = create_app(session_factory=session_factory, runtime_factory=lambda s: Runtime(s, policy=policy, provider=provider, translation_backend=backend))
    base = f'/v1/users/{user.id}'
    with TestClient(app) as c:
        r = c.post(base + '/project-map', json={'project': 'PGA', 'shown': ['chat:root', 'chat:wired'], 'refs': [['chat:root', 'chat:wired'], ['chat:paper', 'chat:wired']]})
        assert r.status_code == 200, r.text
        m = r.json()
        assert {x['key'] for x in m['conversations']} == {'chat:root', 'chat:kid', 'chat:wired'}
        assert {'from': 'chat:root', 'to': 'chat:kid', 'kind': 'branch'} in m['edges']
        assert {'from': 'chat:root', 'to': 'chat:wired', 'kind': 'ref'} in m['edges']
        assert [x['key'] for x in m['outside']] == ['chat:paper']
        assert m['manager'].startswith(P.MANAGER)
        assert next(x for x in m['conversations'] if x['key'] == 'chat:root')['asked'] == ['缓存设计']
        again = c.post(base + '/project-map', json={'project': 'PGA', 'shown': ['chat:wired'], 'refs': []}).json()
        assert not any(e['kind'] == 'ref' for e in again['edges'])
        assert c.post(base + '/project-map', json={'project': 'nope'}).status_code == 422
        response = c.post(base + '/agents/ask', json={'conversation': m['manager'], 'text': '缓存进展如何', 'agent': 'codex'})
        assert response.status_code == 200, response.text
        tail = captured[0]['tail']
        assert '(#pga-open=chat:root)' in tail and '缓存总设计' in tail and '<category_map>' in tail
        assert '别的分类' not in tail
        listed = c.get(base + '/chats').json()
        assert m['manager'] not in {x['key'] for x in listed}
        assert m['manager'] not in {x['key'] for x in c.post(base + '/project-map', json={'project': 'PGA'}).json()['conversations']}


def test_manager_search_all_history_grouped_and_paginated(rt, user, session):
    old = seed(session, user, 'chat:old', 'PGA', '缓存历史实现')
    old.started_at = datetime(2020, 1, 1, tzinfo=timezone.utc)
    for i in range(165):
        seed(session, user, 'chat:busy', 'PGA', f'缓存近期记录 {i}')
    for i in range(10):
        seed(session, user, f'chat:match{i}', 'PGA', f'缓存功能 {i}')
    row = seed(session, user, 'chat:title', 'PGA', '只有标题匹配')
    row.prompt = '普通提问'
    user.preferences = {**user.preferences, 'chat_titles': {'chat:title': '缓存性能'}}
    seed(session, user, 'chat:outside', '论文思考', '缓存外部秘密')
    session.commit()
    result = P.search_page(rt, user, 'PGA', '缓存', page_size=8)
    second = P.search_page(rt, user, 'PGA', '缓存', page=2, page_size=8)
    hits = result['sources'] + second['sources']
    assert result['total'] == 13 and result['pages'] == 2
    assert len({h['key'] for h in hits}) == 13
    assert {'chat:old', 'chat:title'} <= {h['key'] for h in hits}
    assert all(h['key'] != 'chat:outside' for h in hits)
    assert not P.search_page(rt, user, 'PGA', 'nonexistenttoken')['sources']


def test_manager_retrieves_even_with_sharing_disabled(rt, user, session):
    seed(session, user, 'chat:source', 'PGA', '缓存已经实现')
    key = P.manager_key(user, 'PGA')
    P.update(rt, user, 'PGA', {'revision': 0, 'enabled': False})
    assert '缓存已经实现' in P.build(rt, user, key, '缓存')['text']


def test_manager_search_includes_archived_conversation(rt, user, session):
    seed(session, user, 'chat:archived', 'PGA', '缓存归档中的功能')
    user.preferences = {**user.preferences, 'archived_chats': ['chat:archived']}
    session.commit()
    assert not P.search(rt, user, 'PGA', '缓存')
    assert P.search_page(rt, user, 'PGA', '缓存')['sources'][0]['key'] == 'chat:archived'
