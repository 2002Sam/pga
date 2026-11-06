"""A category manager's tasks: a failing agent hands the task on by the same rules, and the task — like the manager —
sees only its own category (plus the web), never the rest of PGA."""
import json
import sys
from datetime import datetime, timezone

import pytest
from fastapi.testclient import TestClient

from pga import manager_dispatch as M, project_context as P, projectsort
from pga.agents import AgentPool
from pga.agents.routing import AgentRouter, bad_answer
from pga.api.app import create_app
from pga.db.models import AgentRun
from pga.runtime import Runtime

AGENT = r'''
import sys
label = sys.argv[1]
if label == "broken":
    print("boom", file=sys.stderr); sys.exit(1)
if label == "limited":
    print("API Error: 429 rate_limit_error")       # exits 0: an "answer" that is only an error message
else:
    print(f"{label} answered")
'''


@pytest.fixture
def cfg(tmp_path):
    script = tmp_path / "agent.py"
    script.write_text(AGENT)
    proc = lambda label: {"adapter": "process", "command": [sys.executable, str(script), label], "capabilities": ["code"],  # noqa: E731
                          "traits": {"quality": 4, "speed": 3, "cost": 3}, "quota": {"source": "observed", "window_hours": 5, "window_runs": 50}}
    return {"agents": {"broken": proc("broken"), "limited": proc("limited"), "good": proc("good"), "spare": proc("spare"),
                       "fast": {"adapter": "llm", "tier": 1, "capabilities": ["quick"], "traits": {"quality": 3, "speed": 5, "cost": 1}}},
            "workflows": {"general": {"pattern": "single", "agents": ["fast"]}},
            "routing": {"enabled": True, "mode": "performance", "min_remaining": 0.1,
                        "categories": {"code": {"label": "代码", "prefer": ["good", "spare", "fast"]}, "quick": {"label": "快速", "prefer": ["fast"]}}},
            "run": {"retries": 0, "max_backoff_s": 0, "daily_usd_cap": 5.0, "workspace_root": str(tmp_path / "ws")}}


def test_error_messages_are_failures_but_talk_about_errors_is_not():
    assert bad_answer("") and bad_answer("API Error: 529 overloaded") and bad_answer("Claude AI usage limit reached|1762")
    assert bad_answer("You've hit your limit · resets 3pm") and bad_answer("Please run /login")
    assert bad_answer("错误：第 3 行少了分号") is None and bad_answer("用 token bucket 做 rate limit 就行") is None
    assert bad_answer("x" * 500 + " usage limit reached") is None          # a long answer that mentions it is an answer


def test_a_named_agent_that_fails_hands_the_task_down_the_chain(rt, user, provider, cfg):
    r = AgentRouter(rt, AgentPool(rt, cfg))
    out = r.ask(user, "修一下这个函数", agent="broken", category="code", failover=True, fallback=["limited"])
    assert out["ok"] and out["agent"] == "good"                            # broken failed, limited only printed an error
    assert [t["agent"] for t in out["tried"]] == ["broken", "limited", "good"]
    assert "错误信息" in out["tried"][1]["error"] and "管理员指定了 broken" in out["why"]
    plain = r.ask(user, "修一下这个函数", agent="broken", category="code")    # without failover a named agent is still just that one
    assert not plain["ok"] and [t["agent"] for t in plain["tried"]] == ["broken"]


def test_the_schedule_keeps_each_jobs_next_choices():
    rows = [{"agent": a, "score": s, "usable": True, "tools": True} for a, s in (("a", 5), ("b", 4), ("c", 3), ("d", 2), ("e", 1))]
    jobs = M.schedule([{"kind": "code", "context": "", "title": "t", "text": "t", "steps": 1}], {"code": rows},
                      tools_only=True, load={}, affinity={})
    assert jobs[0]["agent"] == "a" and jobs[0]["fallback"] == ["b", "c", "d"]


def seed(session, user, key, project, text):
    projectsort.assign(user, key, project)
    session.add(AgentRun(user_id=user.id, workflow='ask', pattern='single', step='run', agent='codex', adapter='x', status='SUCCEEDED',
                         prompt='缓存设计', output=json.dumps({'answer': text}, ensure_ascii=False), data={'conversation': key},
                         started_at=datetime.now(timezone.utc)))
    session.flush()


def test_a_managers_task_sees_its_category_only(session_factory, session, user, policy, provider, backend, monkeypatch):
    seed(session, user, 'chat:pga-old', 'PGA', '同分类的缓存结论')
    seed(session, user, 'chat:paper', '论文思考', '论文里的机密缓存')
    projectsort.assign(user, 'chat:task', 'PGA')
    session.commit()
    captured = []
    monkeypatch.setattr(AgentRouter, 'ask', lambda self, u, text, **kw: captured.append(kw) or {'ok': True, 'text': 'done'})
    monkeypatch.setattr('pga.associate.block', lambda *a, **k: (_ for _ in ()).throw(AssertionError('global associations used')))
    app = create_app(session_factory=session_factory, runtime_factory=lambda s: Runtime(s, policy=policy, provider=provider, translation_backend=backend))
    base = f'/v1/users/{user.id}'
    with TestClient(app) as c:
        wrong = c.post(base + '/agents/ask', json={'conversation': 'chat:task', 'text': '缓存', 'scope': '论文思考'})
        assert wrong.status_code == 422                                      # not the manager's category: refused
        r = c.post(base + '/agents/ask', json={'conversation': 'chat:task', 'text': '缓存怎么做', 'agent': 'codex', 'scope': 'PGA',
                                               'failover': True, 'fallback': ['claude'], 'history_from': 'chat:paper', 'mcp': False})
        assert r.status_code == 200, r.text
        kw = captured[-1]
        assert '同分类的缓存结论' in kw['tail'] and '论文里的机密缓存' not in kw['tail']
        assert '<category_scope name="PGA">' in kw['context'] and kw['mcp'] is False
        assert not kw.get('history')                                         # another category's conversation is not read in
        assert kw['failover'] is True and kw['fallback'] == ['claude']
        r = c.post(base + '/agents/ask', json={'conversation': 'chat:task', 'text': '接着改', 'agent': 'codex'})   # later, without the flag
        assert r.status_code == 200 and '<category_scope name="PGA">' in captured[-1]['context']


def test_everyday_tasks_are_held_too_though_everyday_chats_are_not(session_factory, session, user, policy, provider, backend, monkeypatch):
    seed(session, user, 'chat:daily-old', '日常对话', '日常里的旧结论')
    projectsort.assign(user, 'chat:daily-task', '日常对话')
    projectsort.assign(user, 'chat:daily-free', '日常对话')
    session.commit()
    captured, assoc = [], []
    monkeypatch.setattr(AgentRouter, 'ask', lambda self, u, text, **kw: captured.append(kw) or {'ok': True, 'text': 'done'})
    monkeypatch.setattr('pga.associate.block', lambda *a, **k: assoc.append(1) or ('<related>全局联想</related>', []))
    app = create_app(session_factory=session_factory, runtime_factory=lambda s: Runtime(s, policy=policy, provider=provider, translation_backend=backend))
    base = f'/v1/users/{user.id}'
    with TestClient(app) as c:
        assert c.post(base + '/agents/ask', json={'conversation': 'chat:daily-free', 'text': '旧结论', 'agent': 'codex'}).status_code == 200
        assert assoc and '全局联想' in captured[-1]['tail']                   # an ordinary everyday chat: as before
        assoc.clear()
        assert c.post(base + '/agents/ask', json={'conversation': 'chat:daily-task', 'text': '旧结论', 'agent': 'codex', 'scope': '日常对话'}).status_code == 200
        assert not assoc and '全局联想' not in captured[-1]['tail'] and '<category_scope name="日常对话">' in captured[-1]['context']

@pytest.mark.parametrize('effort', ['low', 'medium', 'high', 'xhigh'])
def test_manager_auto_routing_keeps_question_effort(rt, user, provider, cfg, effort):
    router = AgentRouter(rt, AgentPool(rt, cfg))
    result = router.ask(user, '修一下这个函数', agent='auto', category='code', failover=True, effort=effort)
    assert result['ok']
    assert result['effort'] == effort
