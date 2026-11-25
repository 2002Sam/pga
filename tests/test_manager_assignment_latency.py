"""Time the submit endpoint through commit and check the chosen worker against the ledger."""
import asyncio
import json
import time
import threading
import uuid

import httpx
import pytest
from fastapi.testclient import TestClient
from sqlalchemy.orm import sessionmaker

from pga import manager_dispatch, project_context, projectsort
from pga.agents import pool
from pga.agents.routing import AgentRouter
from pga.api.app import create_app
from pga.db.models import AgentRun, User
from pga.permissions import create_default_policy
from pga.runtime import Runtime


@pytest.mark.parametrize('slow_planner', [False, True], ids=['model', 'planner-timeout'])
def test_submit_assigns_within_three_seconds(engine, policy, provider, backend, tmp_path, monkeypatch, slow_planner):
    sessions = sessionmaker(engine, expire_on_commit=False)
    runtime = lambda s: Runtime(s, policy=policy, provider=provider, translation_backend=backend)
    cli = tmp_path / 'worker'
    cli.write_text('#!/bin/sh\nif [ "$1" = "--version" ]; then sleep 4; fi\necho ok\n')
    cli.chmod(0o755)
    monkeypatch.setitem(pool.DEFAULT['agents'], 'codex', {
        'adapter': 'codex_local', 'command': str(cli), 'capabilities': ['code'], 'quota': {'source': 'observed'}})

    async def planner(*args):
        if slow_planner:
            await asyncio.sleep(5)
        return json.dumps({'tasks': [{'kind': 'code', 'parts': [1], 'needs_code': True}]})
    monkeypatch.setattr(manager_dispatch, '_deepseek', planner)
    refresh_done = threading.Event()
    balance_started = threading.Event()
    if slow_planner:
        # A second remote dependency can still be in flight when a local worker is chosen.
        monkeypatch.setenv('DEEPSEEK_API_KEY', 'test-key')
        def balance(*args, **kwargs):
            balance_started.set()
            assert refresh_done.wait(8)
            return httpx.Response(200, request=httpx.Request('GET', 'https://example.invalid'),
                                  json={'is_available': False, 'balance_infos': []})
        monkeypatch.setattr(httpx, 'get', balance)
    # The worker has already received its committed assignment when ask is called.
    monkeypatch.setattr(AgentRouter, 'ask', lambda *args, **kwargs: {'ok': True})

    with sessions.begin() as s:
        user = User(permission_policy_id=create_default_policy(s, policy).id, preferences={})
        s.add(user)
        s.flush()
        uid, manager = user.id, project_context.manager_key(user, 'PGA')
        for i in range(40):
            key = f'chat:timing-{i}'
            projectsort.assign(user, key, 'PGA')
            s.add_all(AgentRun(user_id=uid, workflow='ask', pattern='single', step='run',
                               agent='codex', adapter='pool', status='SUCCEEDED', prompt=f'第 {j} 次检查',
                               output='测试记录' * 500, data={'conversation': key}) for j in range(25))

    with TestClient(create_app(sessions, runtime)) as client:
        start = time.perf_counter()
        try:
            response = client.post(f'/v1/users/{uid}/chats/manager-submit',
                                   json={'conversation': manager, 'text': '修复一个测试函数'})
        finally:
            elapsed = time.perf_counter() - start
            refresh_done.set()
        response.raise_for_status()
        entry = response.json()['entry']
        task, = entry['tasks']
        previous, release = manager_dispatch.execution_slot(uid, task['worker'])
        try:
            assert previous is None or previous.wait(10)
        finally:
            release()
        with sessions() as s:
            durable, = s.get(AgentRun, uuid.UUID(entry['run'])).data['dispatch']['tasks']
            assert (durable['agent'], durable['task_id']) == (task['agent'], task['task_id'])
        print(f'manager-submit {elapsed:.3f}s, agent={task["agent"]}')
        assert not slow_planner or balance_started.is_set()
        assert elapsed <= 3.0
        assert task['agent'] == 'codex'
