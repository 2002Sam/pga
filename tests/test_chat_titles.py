"""Naming follows the whole conversation, while manual names and newer work win."""
import json
from datetime import timedelta

import pytest

from pga import chat_titles as titles
from pga.chats import set_title, set_branch
from pga.db.models import AgentRun
from pga.db.types import utcnow


def turn(rt, user, prompt="最初的问题", output="回答结果", key="chat:title", **data):
    row = AgentRun(user_id=user.id, workflow="ask", pattern="single", step="workflow", agent="test", adapter="pool",
                   status="SUCCEEDED", prompt=prompt, output=output, started_at=utcnow(), finished_at=utcnow(),
                   data={"conversation": key, **data})
    rt.session.add(row)
    rt.session.flush()
    return row


def answer(title="会话归档与管理员任务管理", summary="归档策略、任务派发和管理员界面的整合"):
    return json.dumps({"title": title, "summary": summary}, ensure_ascii=False)


def test_whole_history_and_results_then_incremental_digest(rt, user):
    turn(rt, user, "一次性对话怎么归档", "保留原文、自动回收")
    turn(rt, user, "管理员自动派发", "后端统一派发任务")
    turn(rt, user, "默认问答与执行两个对话", "已实现两种汇总目标")
    prompts = []
    def ask(prompt):
        prompts.append(prompt)
        return answer()
    assert titles.update(rt, user, "chat:title", ask=ask)
    assert all(text in prompts[0] for text in ("一次性对话怎么归档", "后端统一派发任务", "已实现两种汇总目标"))
    assert user.preferences["chat_titles"]["chat:title"] == "会话归档与管理员任务管理"
    assert titles.state(user, "chat:title")["count"] == 6
    assert not titles.update(rt, user, "chat:title", ask=ask)  # repeated completion: no call
    assert len(prompts) == 1
    turn(rt, user, "优化这些功能的快捷切换", "保留点击切换入口")
    assert not titles.update(rt, user, "chat:title", ask=ask)  # stable title, digest still refreshed
    assert len(prompts) == 2 and "归档策略、任务派发" in prompts[-1] and "保留点击切换入口" in prompts[-1]
    assert "一次性对话怎么归档" not in prompts[-1]
    assert titles.state(user, "chat:title")["count"] == 8


def test_long_bootstrap_includes_middle_and_end_without_unbounded_prompt(rt, user):
    for i in range(30):
        turn(rt, user, f"主题{i:02d} " + "问" * 3000, f"结论{i:02d} " + "答" * 3000)
    seen = []
    def ask(prompt):
        seen.append(prompt)
        return answer(summary=f"累计主题摘要{len(seen)}")
    assert titles.update(rt, user, "chat:title", ask=ask)
    assert len(seen) > 1 and all(len(p) < titles.BATCH_CHARS + 3000 for p in seen)
    assert all(f"主题{i:02d}" in "".join(seen) and f"结论{i:02d}" in "".join(seen) for i in range(30))
    assert "累计主题摘要1" in seen[1]


def test_edit_of_earlier_history_rebuilds_digest(rt, user):
    first = turn(rt, user)
    titles.update(rt, user, "chat:title", ask=lambda _: answer())
    first.prompt = "修订后的早期需求"
    rt.session.commit()
    prompts = []
    titles.update(rt, user, "chat:title", ask=lambda p: prompts.append(p) or answer("修订需求的讨论"))
    assert "修订后的早期需求" in prompts[0]


@pytest.mark.parametrize("key", ["chat:pm-one", "chat:summary-one-qa", "chat:summary-one-execute", "node:a", "second:a", "regen:a"])
def test_fixed_and_internal_conversations_never_renamed(rt, user, key):
    turn(rt, user, key=key)
    assert not titles.update(rt, user, key, ask=lambda _: pytest.fail("must not call model"))


def test_manual_name_and_legacy_explicit_name_preserved_but_seed_is_automatic(rt, user):
    turn(rt, user)
    user.preferences = {**user.preferences, "chat_titles": {"chat:title": "我的固定名称"}}
    assert not titles.update(rt, user, "chat:title", ask=lambda _: pytest.fail("legacy title"))
    set_title(user, "chat:title", "手动名称", source="manual")
    assert not titles.update(rt, user, "chat:title", ask=lambda _: pytest.fail("manual title"))
    set_title(user, "chat:title", "", source="manual")
    assert titles.update(rt, user, "chat:title", ask=lambda _: answer())


def test_branch_uses_inherited_history_and_does_not_rename_parent(rt, user):
    first = turn(rt, user, "历史主题", "历史结论")
    set_branch(user, "chat:branch", "chat:title", str(first.id))
    set_title(user, "chat:branch", "自动的分支初始名")
    turn(rt, user, "分支后续", "新结论", key="chat:branch")
    seen = []
    assert titles.update(rt, user, "chat:branch", ask=lambda p: seen.append(p) or answer())
    assert "历史主题" in seen[0] and "分支后续" in seen[0]
    assert "chat:title" not in user.preferences["chat_titles"]


@pytest.mark.parametrize("change", ["rename", "new_reply"])
def test_changes_during_generation_win(rt, user, change):
    turn(rt, user)
    def ask(_):
        if change == "rename":
            set_title(user, "chat:title", "刚刚手动改的名字", source="manual")
        else:
            turn(rt, user, "更新的消息", "更新的回答")
        rt.session.commit()
        return answer()
    assert not titles.update(rt, user, "chat:title", ask=ask)
    assert (user.preferences.get("chat_titles") or {}).get("chat:title") != "会话归档与管理员任务管理"


@pytest.mark.parametrize("payload", ['{}', '{"title": "错误\\n标题", "summary": "主题"}', '{"title": "", "summary": "主题"}'])
def test_bad_model_response_preserves_title(rt, user, payload):
    turn(rt, user)
    set_title(user, "chat:title", "原有自动标题")
    assert not titles.update(rt, user, "chat:title", ask=lambda _: payload)
    assert user.preferences["chat_titles"]["chat:title"] == "原有自动标题"


def test_failure_or_stopped_answer_does_not_trigger_naming(rt, user):
    row = turn(rt, user, stopped=True)
    assert not titles.update(rt, user, "chat:title", ask=lambda _: pytest.fail("stopped"))
    row.data, row.status = {"conversation": "chat:title"}, "FAILED"
    assert not titles.update(rt, user, "chat:title", ask=lambda _: pytest.fail("failed"))


def test_api_completion_schedules_after_answer_is_saved(rt, user, monkeypatch):
    from pga.api.app import create_app
    from pga.agents.routing import AgentRouter
    monkeypatch.setattr(rt.provider, "name", "test")
    scheduled = []
    monkeypatch.setattr(titles, "schedule", lambda sm, make, uid, key: scheduled.append(key))
    monkeypatch.setattr("pga.api.app.threading.Thread.start", lambda self: None)
    def ask(self, u, text, **kw):
        row = turn(rt, u, text, key=kw["conversation"])
        return {"ok": True, "text": row.output, "run_id": str(row.id)}
    monkeypatch.setattr(AgentRouter, "ask", ask)
    app = create_app()
    endpoint = next(r.endpoint for r in app.routes if getattr(r, "path", "").endswith("/agents/ask"))
    result = endpoint(user.id, {"text": "请回答", "conversation": "chat:title"}, rt)
    assert result["ok"] and scheduled == ["chat:title"]


def test_timeline_uses_generated_title(rt, user):
    from pga.timeline import Timeline
    turn(rt, user)
    titles.update(rt, user, "chat:title", ask=lambda _: answer())
    assert next(i for i in Timeline(rt).items(user, utcnow() - timedelta(days=1)) if i.key == "chat:title").title == "会话归档与管理员任务管理"


def test_worker_coalesces_completions_and_clears_pending_on_failure(session_factory, user, monkeypatch):
    queued, updates = [], []
    class Worker:
        def __init__(self, target, **kwargs): self.target = target
        def start(self): queued.append(self.target)
    monkeypatch.setattr(titles.threading, "Thread", Worker)
    from types import SimpleNamespace
    make = lambda s: SimpleNamespace(session=s)
    def update(rt, u, key):
        updates.append(key)
        assert titles.pending(u.id, key)
        if len(updates) == 1:
            titles.schedule(session_factory, make, user.id, key)
        else:
            raise RuntimeError("model unavailable")
    monkeypatch.setattr(titles, "update", update)
    titles.schedule(session_factory, make, user.id, "chat:title")
    titles.schedule(session_factory, make, user.id, "chat:title")
    assert len(queued) == 1
    queued[0]()
    assert len(updates) == 2 and not titles.pending(user.id, "chat:title")
