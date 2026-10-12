"""An aim's team: roles from different sources, a round, your corrections and what they change (stand-in agents)."""

from __future__ import annotations

import json
import sys

import pytest
from sqlalchemy import select

from pga.agents.pool import AgentPool
from pga.aims import AimService
from pga.db.models import AimNote, Responsibility
from pga.db.types import Origin, ResponsibilityStatus as S
from pga.teams import TeamService, corrections_block

AGENT = r'''
import json, sys
who, text = sys.argv[1], sys.stdin.read()
if "Plan this round" in text:
    print(json.dumps({"focus": "check the newest results", "tasks": [{"role": "researcher", "task": "find what is new"},
                                                                       {"role": "maker", "task": "draft a one-page plan"}]}))
elif "<new_correction>" in text:
    print(json.dumps({"understanding": "focus on open-source tools", "summary_for_user": "will focus on open source",
        "note_for_team": "prefer open-source tools",
        "changes": [{"action": "update", "id": "R1", "priority": 0.6, "keywords": ["open source"], "why": "the user asked"},
                    {"action": "pause", "id": "R2", "why": "off the new focus"},
                    {"action": "new", "title": "Track open-source agent frameworks", "description": "weekly", "why": "new focus"}]}))
elif "Merge this round" in text:
    print(json.dumps({"summary": "found two things; the reviewer doubts one", "next": ["verify the doubtful one"]}))
else:
    print(who + " did: " + text.splitlines()[-2][:60] if len(text.splitlines()) > 1 else who + " did it")
'''


@pytest.fixture
def cfg(tmp_path):
    script = tmp_path / "agent.py"
    script.write_text(AGENT)
    proc = lambda label, caps, t: {"adapter": "process", "command": [sys.executable, str(script), label], "capabilities": caps,  # noqa: E731
                                   "traits": t, "quota": {"source": "observed", "window_hours": 5, "window_runs": 50}}
    return {
        "agents": {"gpt": proc("gpt", ["serious", "plan", "research"], {"quality": 5, "speed": 2, "cost": 3}),
                   "gpt2": proc("gpt2", ["serious", "research"], {"quality": 4, "speed": 3, "cost": 3}),
                   "claudeish": {**proc("claudeish", ["review", "serious"], {"quality": 5, "speed": 3, "cost": 3})},
                   "office": proc("office", ["office", "write"], {"quality": 4, "speed": 3, "cost": 2}),
                   "own": {"adapter": "llm", "tier": 1, "capabilities": ["quick"], "traits": {"quality": 3, "speed": 5, "cost": 1}}},
        "workflows": {"general": {"pattern": "single", "agents": ["own"]}},
        "routing": {"enabled": True, "mode": "performance", "long_tasks": True, "min_remaining": 0.1,
                    "categories": {"serious": {"label": "严肃", "prefer": ["gpt", "gpt2", "claudeish"]},
                                   "office": {"label": "办公", "prefer": ["office"]}, "quick": {"label": "快", "prefer": ["own"]}},
                    "task_kinds": {"serious": ["synthesis"]}},
        "run": {"retries": 0, "max_backoff_s": 0, "daily_usd_cap": 5.0, "workspace_root": str(tmp_path / "ws")},
    }


@pytest.fixture
def aim(rt, user):
    a = AimService(rt.session).create(user, "做出一个真正懂我的个人 AI", "Build a personal AI that truly understands me")
    for title in ("Follow agent research", "Write weekly notes"):
        r = rt.responsibilities.create(user_id=user.id, title_en=title, actor=Origin.USER)
        r.aim_id = a.id
    rt.session.flush()
    return a


def test_roles_go_to_different_agents_and_can_be_pinned(rt, aim, cfg):
    ts = TeamService(rt, AgentPool(rt, cfg))
    roster = {m["role"]: m["agent"] for m in ts.roster(aim)}
    assert roster["lead"] == "gpt" and roster["maker"] == "office" and len(set(roster.values())) == 4
    ts.set_member(aim, "critic", "gpt2")
    m = next(x for x in ts.roster(aim) if x["role"] == "critic")
    assert m["agent"] == "gpt2" and m["chosen_by"] == "you"


def test_a_round_plans_works_reviews_and_reports(rt, aim, cfg):
    ts = TeamService(rt, AgentPool(rt, cfg))
    out = ts.round(aim)
    kinds = [n.kind for n in ts.notes(aim)]
    assert kinds == ["plan", "work", "work", "review", "summary"]
    assert [t["role"] for t in out["tasks"]] == ["researcher", "maker"] and all(t["ok"] for t in out["tasks"])
    work = [n for n in ts.notes(aim) if n.kind == "work"]
    assert {n.agent for n in work} == {ts.member(aim, "researcher"), "office"}
    assert "reviewer doubts" in ts.notes(aim, 1, ("summary",))[0].text


def test_a_correction_counts_at_once_and_the_lead_turns_it_into_changes(rt, user, aim, cfg):
    ts = TeamService(rt, AgentPool(rt, cfg))
    note = ts.add_correction(aim, "更关注开源工具", "Focus more on open-source tools")
    assert "open-source tools" in corrections_block(rt.session, aim.id)
    assert "open-source tools" in AimService(rt.session).context_block(user)          # every reader of the aim sees it
    data = ts.revise(aim, note)
    r1, r2 = ts.responsibilities(aim)[:2]
    assert r1.priority_bias == pytest.approx(0.6) and "open source" in r1.keywords      # safe change: applied
    assert r2.status != S.SLEEPING                                                    # pausing waits for you
    assert [p["action"] for p in data["proposed"]] == ["pause", "new"] and note.status == "applied"
    ts.apply_proposal(aim, note, 0)
    assert r2.status == S.SLEEPING and r2.paused_by_user
    ts.apply_proposal(aim, note, 1)
    new = rt.session.scalar(select(Responsibility).where(Responsibility.title_en == "Track open-source agent frameworks"))
    assert new is not None and new.aim_id == aim.id
    with pytest.raises(Exception):
        ts.apply_proposal(aim, note, 1)                                               # only once
    assert any(n.kind == "change" and "open-source" in n.text for n in ts.notes(aim))


def test_api_team_round_and_correction(session_factory, policy, provider, backend, user, aim, cfg, monkeypatch):
    from fastapi.testclient import TestClient

    from pga.api.app import create_app
    from pga.runtime import Runtime
    app = create_app(session_factory, lambda s: Runtime(s, policy=policy, provider=provider, translation_backend=backend))
    c = TestClient(app)
    v = c.get(f"/v1/aims/{aim.id}/team").json()
    assert [m["role"] for m in v["roster"]] == ["lead", "researcher", "critic", "maker"]
    v = c.post(f"/v1/aims/{aim.id}/corrections", json={"text": "更关注开源工具"}).json()
    assert v["notes"][-1]["kind"] == "correction" and v["notes"][-1]["status"] == "pending" and "aim.revise" in v["running"]
    assert c.post(f"/v1/aims/{aim.id}/team/round").status_code == 202
    assert c.put(f"/v1/aims/{aim.id}/team", json={"auto": True}).json()["auto"] is True
    assert c.get("/v1/users/%s/agents/conversations" % user.id, params={"card": f"team:{aim.id}:lead"}).status_code == 200
