"""API behavior for turning a short task list into a read-only schedule draft."""
import json

from fastapi.testclient import TestClient

from pga.api.app import create_app
from pga.runtime import Runtime


def app_for(session_factory, policy, provider, backend):
    return create_app(session_factory=session_factory,
                      runtime_factory=lambda s: Runtime(s, policy=policy, provider=provider, translation_backend=backend))


def draft_call(client, user, tasks, **extra):
    return client.post(f"/v1/users/{user.id}/plans/draft", json={"tasks": tasks, "start": "09:00", "minutes": 60, "lang": "zh", **extra})


def test_draft_orders_tasks_and_moves_over_capacity_to_unscheduled(session_factory, policy, provider, backend, user):
    provider.handler = lambda system, messages: json.dumps({"tasks": [
        {"index": 2, "priority": "low", "minutes": 30, "steps": ["整理资料"]},
        {"index": 0, "priority": "high", "minutes": 45, "steps": ["打开文档"]},
        {"index": 1, "priority": "medium", "minutes": 40, "steps": ["完成修改"]},
    ]}, ensure_ascii=False)
    with TestClient(app_for(session_factory, policy, provider, backend)) as c:
        r = draft_call(c, user, ["先做重点", "继续修改", "整理资料"])
        assert r.status_code == 200, r.text
        md = r.json()["markdown"]
        assert md.index("先做重点") < md.index("继续修改") < md.index("整理资料")
        scheduled, deferred = md.split("## 待安排")
        assert "先做重点" in scheduled and "先做重点" not in deferred
        assert "继续修改" in deferred and "整理资料" in deferred
        assert "09:00" in md and "打开文档" in md


def test_draft_rejects_empty_tasks_and_midnight_overflow(session_factory, policy, provider, backend, user):
    with TestClient(app_for(session_factory, policy, provider, backend)) as c:
        assert draft_call(c, user, []).status_code == 422
        r = draft_call(c, user, ["超长任务"], start="23:30", minutes=60)
        assert r.status_code == 422


def test_draft_rejects_duplicate_or_missing_model_indices(session_factory, policy, provider, backend, user):
    for tasks in [
        [{"index": 0, "priority": "high", "minutes": 30, "steps": ["准备"]},
         {"index": 0, "priority": "low", "minutes": 30, "steps": ["准备"]}],
        [{"index": 2, "priority": "high", "minutes": 30, "steps": ["准备"]}],
    ]:
        provider.handler = lambda system, messages, tasks=tasks: json.dumps({"tasks": tasks})
        with TestClient(app_for(session_factory, policy, provider, backend)) as c:
            assert draft_call(c, user, ["甲"]).status_code == 502


def test_draft_provider_failure_and_missing_user(session_factory, policy, provider, backend, user):
    provider.handler = lambda system, messages: (_ for _ in ()).throw(RuntimeError("provider failed"))
    with TestClient(app_for(session_factory, policy, provider, backend)) as c:
        assert draft_call(c, user, ["任务"]).status_code == 502
        missing = "00000000-0000-0000-0000-000000000000"
        r = c.post(f"/v1/users/{missing}/plans/draft", json={"tasks": ["任务"], "start": "09:00", "minutes": 60, "lang": "zh"})
        assert r.status_code == 404


def example_agenda():
    return {"title": "准备客户评审", "goal": "交付演示稿", "blocks": [
        {"start": "09:00", "end": "10:00", "title": "走查演示", "outcome": "演示脚本",
         "steps": ["记录阻塞点", "按顺序演练"]}],
        "assumptions": ["暂按上午有一小时安排"], "deferred": [],
        "questions": [{"question": "听众是谁？", "options": ["业务团队", "技术团队"]}]}


def test_paragraph_and_optional_revision(session_factory, policy, provider, backend, user):
    seen = []

    def respond(system, messages):
        seen.append(messages[-1]["content"])
        return json.dumps(example_agenda(), ensure_ascii=False)

    provider.handler = respond
    with TestClient(app_for(session_factory, policy, provider, backend)) as c:
        url = f"/v1/users/{user.id}/plans/draft"
        initial = {"description": "明天要给客户演示新版，先走查一遍。", "plan_date": "2026-11-25"}
        reply = c.post(url, json=initial)
        assert reply.status_code == 200, reply.text
        result = reply.json()
        assert initial["plan_date"] in seen[-1]
        assert result["questions"] == example_agenda()["questions"]
        assert all(s in result["markdown"] for s in ["# 准备客户评审", "> 交付演示稿", "09:00–10:00", "演示脚本", "安排依据"])
        reply = c.post(url, json={**initial, "previous": result["markdown"],
                                  "answers": [{"question": "听众是谁？", "choice": "技术团队"}]})
        assert reply.status_code == 200 and reply.json()["questions"] == []
        assert all(s in seen[-1] for s in [initial["description"], "准备客户评审", "技术团队"])


def test_paragraph_and_schedule_validation(session_factory, policy, provider, backend, user):
    with TestClient(app_for(session_factory, policy, provider, backend)) as c:
        url = f"/v1/users/{user.id}/plans/draft"
        for bad in [" ", "很" * 6001]:
            assert c.post(url, json={"description": bad}).status_code == 422
        agenda = example_agenda()
        agenda["blocks"] *= 2
        provider.handler = lambda *_: json.dumps(agenda)
        assert c.post(url, json={"description": "明天做演示"}).status_code == 502
