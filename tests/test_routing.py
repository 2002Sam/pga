"""Dispatch across agents: category → preference × mode × remaining usage; the agent chat; long-term work."""

from __future__ import annotations

import json
import sys
from datetime import timedelta

import pytest

from pga.agents import AgentPool, quota
from pga.agents.routing import AgentRouter, classify
from pga.db.models import AgentRun
from pga.db.types import utcnow
from pga.llm.router import CURRENT_TASK, default_fake_reply

AGENT = r'''
import json, sys
label, prompt = sys.argv[1], sys.stdin.read()
if label == "limited":
    print("You've hit your usage limit. Try again later.", file=sys.stderr); sys.exit(1)
if '"beliefs"' in prompt or "Reply with JSON" in prompt:
    print(json.dumps({"beliefs": [], "by": label}) if label != "prose" else "Sure! Here are my thoughts in prose.")
else:
    print(f"{label} answered")
'''


@pytest.fixture
def cfg(tmp_path):
    script = tmp_path / "agent.py"
    script.write_text(AGENT)
    proc = lambda label, caps, t: {"adapter": "process", "command": [sys.executable, str(script), label], "capabilities": caps,  # noqa: E731
                                   "traits": t, "quota": {"source": "observed", "window_hours": 5, "window_runs": 10}}
    return {
        "agents": {"coder": proc("coder", ["code"], {"quality": 5, "speed": 3, "cost": 3}),
                   "thinker": proc("thinker", ["serious"], {"quality": 5, "speed": 2, "cost": 4}),
                   "prose": proc("prose", ["serious"], {"quality": 4, "speed": 4, "cost": 2}),
                   "office": proc("office", ["office"], {"quality": 4, "speed": 3, "cost": 2}),
                   "limited": proc("limited", ["serious"], {"quality": 5, "speed": 5, "cost": 1}),
                   "fast": {"adapter": "llm", "tier": 1, "capabilities": ["quick"], "traits": {"quality": 3, "speed": 5, "cost": 1}}},
        "workflows": {"general": {"pattern": "single", "agents": ["fast"]}},
        "routing": {"enabled": True, "mode": "performance", "long_tasks": True, "min_remaining": 0.1,
                    "categories": {"code": {"label": "代码", "prefer": ["coder", "thinker", "fast"]},
                                   "serious": {"label": "严肃问题", "prefer": ["thinker", "prose", "fast"]},
                                   "office": {"label": "办公", "prefer": ["office", "fast"]},
                                   "quick": {"label": "日常快速", "prefer": ["fast"]}},
                    "task_kinds": {"serious": ["synthesis"], "quick": ["translation"]}},
        "run": {"retries": 0, "max_backoff_s": 0, "daily_usd_cap": 5.0, "workspace_root": str(tmp_path / "ws")},
    }


def test_classify_by_kind_of_work():
    assert classify("这个 Python 函数为什么报错？```x=1```")[0] == "code"
    assert classify("帮我写一份周报，整理成表格")[0] == "office"
    assert classify("分析一下长期记忆的几种架构的利弊")[0] == "serious"
    assert classify("今天几号？")[0] == "quick"


def test_rank_follows_preference_then_mode_and_skips_exhausted(rt, user, provider, cfg):
    provider.handler = lambda s, m: "fast answered"
    r = AgentRouter(rt, AgentPool(rt, cfg))
    assert r.route("code")[0] == "coder" and r.route("office")[0] == "office" and r.route("quick") == ["fast"]
    assert r.route("serious")[:2] == ["thinker", "prose"]
    # economy mode: the cheaper "prose" overtakes the expensive "thinker"
    cfg["routing"]["mode"] = "economy"
    assert AgentRouter(rt, AgentPool(rt, cfg)).route("serious")[0] == "prose"
    cfg["routing"]["mode"] = "performance"
    # thinker used up its window (10 runs in 5 h) → it drops out with the reason
    for _ in range(10):
        rt.session.add(AgentRun(workflow="ask", pattern="single", step="run", agent="thinker", adapter="process", status="SUCCEEDED"))
    rt.session.flush()
    quota.clear()
    ranked = AgentRouter(rt, AgentPool(rt, cfg)).rank("serious")
    th = next(x for x in ranked if x["agent"] == "thinker")
    assert not th["usable"] and "剩余用量不足" in th["why_not"] and ranked[0]["agent"] == "prose"


def test_a_usage_limit_error_takes_the_agent_out_until_its_window_passes(rt, user, provider, cfg):
    provider.handler = lambda s, m: "fast answered"
    cfg["routing"]["categories"]["serious"]["prefer"] = ["limited", "prose", "fast"]
    r = AgentRouter(rt, AgentPool(rt, cfg))
    out = r.ask(user, "分析一下这个决策的风险")
    assert out["ok"] and out["agent"] == "prose" and [t["agent"] for t in out["tried"]] == ["limited", "prose"]
    quota.clear()
    q = AgentRouter(rt, AgentPool(rt, cfg)).quota("limited")
    assert q.exhausted and q.remaining == 0.0 and "用量上限" in q.detail
    assert "limited" not in AgentRouter(rt, AgentPool(rt, cfg)).route("serious")


def test_the_chat_can_name_an_agent_or_route_automatically(rt, user, provider, cfg):
    provider.handler = lambda s, m: "fast answered" if not s.startswith("You turn") else default_fake_reply("m", s, m)
    r = AgentRouter(rt, AgentPool(rt, cfg))
    auto = r.ask(user, "帮我起草一封会议邮件")
    assert auto["agent"] == "office" and auto["category"] == "office" and "办公 → office" in auto["why"]
    named = r.ask(user, "帮我起草一封会议邮件", agent="fast")
    assert named["agent"] == "fast" and named["text"] == "fast answered" and named["why"] == "你指定了 fast"
    quick = r.ask(user, "你好", history=[{"role": "user", "text": "hi"}, {"role": "assistant", "text": "hello"}])
    assert quick["agent"] == "fast" and "Earlier in this chat" in provider.calls[-1].messages[-1]["content"]


def test_long_term_work_goes_to_the_routed_agent_and_falls_back(rt, user, provider, cfg):
    provider.handler = lambda s, m: json.dumps({"beliefs": [], "by": "pga-model"})
    r = AgentRouter(rt, AgentPool(rt, cfg))
    out = r.delegate("synthesis", 2, "Reply with JSON only.", [{"role": "user", "content": "evidence…"}], 800)
    assert json.loads(out.text)["by"] == "thinker" and out.provider == "thinker"
    assert r.delegate("translation", 1, "", [{"role": "user", "content": "x"}], 100) is None      # quick stays on our model
    # an agent that answers in prose where JSON is required is skipped; then our own model takes over (None)
    cfg["routing"]["categories"]["serious"]["prefer"] = ["prose", "fast"]
    assert AgentRouter(rt, AgentPool(rt, cfg)).delegate("synthesis", 2, "Reply with JSON only.", [{"role": "user", "content": "e"}], 800) is None
    logged = rt.session.query(AgentRun).filter(AgentRun.workflow == "task:synthesis", AgentRun.parent_id.is_(None)).all()
    assert {x.status for x in logged} == {"SUCCEEDED", "FAILED"}

    # wired into the LLM router: inside a "synthesis" run the call is routed, outside it is not
    rt.router.delegate = lambda kind, tier, system, messages, max_tokens: AgentRouter(rt, AgentPool(rt, cfg)).delegate(kind, tier, system, messages, max_tokens)
    cfg["routing"]["categories"]["serious"]["prefer"] = ["thinker", "fast"]
    token = CURRENT_TASK.set("synthesis")
    try:
        res = rt.router.complete(2, system="Reply with JSON only.", messages=[{"role": "user", "content": "e"}])
    finally:
        CURRENT_TASK.reset(token)
    assert res.provider == "thinker"
    assert rt.router.complete(2, system="Reply with JSON only.", messages=[{"role": "user", "content": "e"}]).provider == "fake"


def test_asking_inside_a_category_routes_by_that_category(rt, user, provider, cfg):
    provider.handler = lambda s, m: "fast answered"
    r = AgentRouter(rt, AgentPool(rt, cfg))
    out = r.ask(user, "你好", category="code")                     # a short greeting would be "quick" — the category wins
    assert out["category"] == "code" and out["agent"] == "coder" and "你在这一类里提问" in out["why"]
    with pytest.raises(ValueError):
        r.ask(user, "x", category="nope")
