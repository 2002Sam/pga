import uuid
from pathlib import Path

import pytest

from pga.agents import live
from pga.knowledge import distill


@pytest.fixture(autouse=True)
def knowledge_root(tmp_path, monkeypatch):
    monkeypatch.setattr(distill, 'ROOT', tmp_path)


def test_streaming_file_and_final_index(rt, user):
    item = distill.create(rt, user, 'chat:knowledge-test', 'Test')
    assert Path(item['path']).exists()
    item = distill.claim(user.id, item['id'], item['conversation'])
    opening = f'<PGA_KNOWLEDGE id="{item["id"]}">'
    content = '# 实验结果\n\n' + '证据与条件。' * 2500
    with distill.stream(user.id, item):
        lid = live.start('fake', tags={'conversation': f'{user.id}:{item["conversation"]}'})
        live.append(lid, '正常回答\n' + opening[:15])
        live.append(lid, opening[15:] + content)
        assert distill.read(user.id, item['id'])['text'] == content
        live.append(lid, '\n</PGA_KNOW')
        live.append(lid, 'LEDGE>')
        assert '<PGA_' not in distill.read(user.id, item['id'])['text']
        live.finish(lid, True)
    result = {'ok': True, 'text': '正常回答\n' + opening + content + '</PGA_KNOWLEDGE>', 'agent': 'fake'}
    done = distill.finish(rt, user, item['id'], result)
    assert done['status'] == 'ready' and done['body_id']
    assert content in Path(done['path']).read_text()
    assert 'PGA_KNOWLEDGE' not in result['text'] and done['path'] in result['text']
    assert distill.listing(user.id, item['conversation'])[0]['id'] == item['id']
    assert not live._OBSERVERS


def test_failed_capture_keeps_draft_and_cannot_be_reclaimed(rt, user):
    item = distill.create(rt, user, 'chat:stop-test', 'Test')
    with pytest.raises(ValueError):
        distill.claim(user.id, item['id'], 'chat:wrong')
    item = distill.claim(user.id, item['id'], item['conversation'])
    with distill.stream(user.id, item):
        lid = live.start('fake', tags={'conversation': f'{user.id}:{item["conversation"]}'})
        other = live.start('fake', tags={'conversation': f'{uuid.uuid4()}:{item["conversation"]}'})
        live.append(other, f'<PGA_KNOWLEDGE id="{item["id"]}"># Wrong user')
        assert distill.read(user.id, item['id'])['text'] == ''
        live.append(lid, f'<PGA_KNOWLEDGE id="{item["id"]}"># 草稿')
        live.append(lid, '\n未完成')
        live.finish(lid, False)
        live.finish(other, False)
    failed = distill.finish(rt, user, item['id'], {'ok': False, 'stopped': True})
    assert failed['status'] == 'failed'
    assert distill.read(user.id, item['id'])['text'] == '# 草稿\n未完成'
    with pytest.raises(ValueError):
        distill.claim(user.id, item['id'], item['conversation'])
    assert not live._OBSERVERS


def test_http_send_capture_pipeline(session_factory, policy, provider, backend, monkeypatch):
    from fastapi.testclient import TestClient
    from pga.api.app import create_app
    from pga.agents.routing import AgentRouter
    from pga.runtime import Runtime
    import re

    def ask(self, user, text, **kwargs):
        kid = re.search(r'<PGA_KNOWLEDGE id="([a-f0-9]+)">', kwargs['tail'])[1]
        output = f'<PGA_KNOWLEDGE id="{kid}"># HTTP 知识\n结论与来源。\n</PGA_KNOWLEDGE>'
        lid = live.start('test', tags={'conversation': f'{user.id}:{kwargs["conversation"]}'})
        live.append(lid, output)
        assert '结论与来源' in distill.read(user.id, kid)['text']
        live.finish(lid, True)
        return {'ok': True, 'text': '已回答\n' + output, 'agent': 'test'}

    monkeypatch.setattr(AgentRouter, 'ask', ask)
    app = create_app(session_factory=session_factory,
                     runtime_factory=lambda s: Runtime(s, policy=policy, provider=provider, translation_backend=backend))
    with TestClient(app) as c:
        uid = c.post('/v1/users', json={'locale': 'zh-CN'}).json()['id']
        base = f'/v1/users/{uid}'
        item = c.post(base + '/knowledge-notes', json={'conversation': 'chat:test-capture', 'title': '测试'}).json()
        response = c.post(base + '/agents/ask', json={'conversation': item['conversation'], 'text': '汇总', 'knowledge_id': item['id']})
        assert response.status_code == 200, response.text
        assert response.json()['knowledge']['status'] == 'ready'
        saved = c.get(base + '/knowledge-notes/' + item['id']).json()
        assert saved['status'] == 'ready' and 'HTTP 知识' in saved['text']
        assert c.get(base + '/knowledge-notes').json()['notes'][0]['id'] == item['id']
        duplicate = c.post(base + '/agents/ask', json={'conversation': item['conversation'], 'text': '汇总', 'knowledge_id': item['id']})
        assert duplicate.status_code == 422
