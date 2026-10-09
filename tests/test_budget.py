"""Spec §26 — Budget acceptance tests, plus allocator checks and the run audit log."""

from __future__ import annotations

from datetime import timedelta

import pytest

from pga.allocator import AllocationError, Estimates, Justification, RunRequest
from pga.db.models import Run
from pga.db.types import AllocationOutcome as O, Origin, ResponsibilityStatus as S, RunStatus, utcnow
from pga.llm import UsageContext
from pga.runs import RunBudgetExceeded, RunNotAllowed

FULL = Justification(why_now="tension crossed wake threshold after a contradicting paper",
                     expected_gain="decide whether the sim-to-real conclusion still holds",
                     decision_affected="which world model to adopt for the next experiment",
                     budget={"max_units": 40_000, "max_tool_calls": 10},
                     stop_condition="conclusion updated or 3 sources checked")
SMALL = Estimates(information_gain=0.9, decision_impact=0.9, user_relevance=0.8, urgency=0.5,
                  input_tokens=1000, output_tokens=1000)   # tier 3 ≈ 18k units, tier 2 ≈ 6k


@pytest.fixture
def active(rt, user):
    r = rt.responsibilities.create(user_id=user.id, title_en="World model research", actor=Origin.USER,
                                   initial_status=S.ACTIVE)
    return r


def burn(rt, user, units: float, *, proactive: bool, at=None, tier: int = 3):
    """Record premium usage directly (output tokens × 15 units at tier 3)."""
    rt.ledger.record(tier=tier, model="claude-opus-5-5", provider="anthropic", input_tokens=0,
                     output_tokens=int(units / 15), now=at,
                     ctx=UsageContext(category="active_responsibilities" if proactive else "user_reserve",
                                      proactive=proactive, user_id=user.id))


def deep(user, r, **kw):
    return RunRequest(user_id=user.id, kind="deep_research", responsibility_id=r.id, justification=FULL,
                      estimates=SMALL, **kw)


# ---------------------------------------------------------------- §26: proactive premium stops near target


def test_proactive_premium_usage_stops_near_target(rt, user, active):
    t0 = utcnow()
    assert rt.allocator.allocate(deep(user, active), now=t0).outcome == O.APPROVED
    burn(rt, user, 690_000, proactive=True, at=t0)          # 69% of capacity used proactively
    d = rt.allocator.allocate(deep(user, active), now=t0)
    assert d.outcome == O.DEFERRED
    assert "proactive premium target reached" in d.reasons[0] and "paused until reset" in d.reasons[0]
    assert d.retry_after == t0 + timedelta(hours=5)         # the provider window's reset time
    snap = rt.ledger.quota(rt.policy.quotas[0], t0)
    assert snap.remaining > snap.reserve                    # it stopped with the reserve intact


# ---------------------------------------------------------------- §26: the user can still use the reserve


def test_live_user_request_can_consume_reserved_quota(rt, user, active):
    t0 = utcnow()
    burn(rt, user, 700_000, proactive=True, at=t0)          # proactive target fully used
    d = rt.allocator.allocate(RunRequest(user_id=user.id, kind="user_interaction", estimates=SMALL), now=t0)
    assert d.outcome == O.APPROVED and d.tier == 3
    burn(rt, user, 250_000, proactive=False, at=t0)         # user digs deep into the reserve
    d = rt.allocator.allocate(RunRequest(user_id=user.id, kind="user_interaction", estimates=SMALL), now=t0)
    assert d.outcome == O.APPROVED and d.tier == 3


def test_reserve_is_protected_even_after_heavy_user_use(rt, user, active):
    t0 = utcnow()
    burn(rt, user, 500_000, proactive=False, at=t0)         # the user used half the window
    burn(rt, user, 190_000, proactive=True, at=t0)          # proactive only 19% — under its 70% target
    d = rt.allocator.allocate(deep(user, active), now=t0)
    assert d.outcome == O.DEFERRED                          # but 31% left; 30% is the user's


# ---------------------------------------------------------------- §26: background work falls back to cheap mode


def test_background_work_falls_back_to_cheap_mode(rt, user, active):
    t0 = utcnow()
    burn(rt, user, 700_000, proactive=True, at=t0)
    req = RunRequest(user_id=user.id, kind="synthesis", responsibility_id=active.id, preferred_tier=3,
                     justification=FULL, estimates=SMALL)
    d = rt.allocator.allocate(req, now=t0)
    assert d.outcome in {O.APPROVED, O.DOWNGRADED} and d.tier == 2   # proactive can't self-upgrade; stays cheap
    mon = rt.allocator.allocate(RunRequest(user_id=user.id, kind="monitoring", responsibility_id=active.id), now=t0)
    assert mon.outcome == O.APPROVED and mon.tier == 1


def test_exhausted_quota_downgrades_user_chat_instead_of_refusing(rt, user):
    t0 = utcnow()
    burn(rt, user, 995_000, proactive=False, at=t0)
    d = rt.allocator.allocate(RunRequest(user_id=user.id, kind="user_interaction", estimates=SMALL), now=t0)
    assert d.outcome == O.DOWNGRADED and d.tier == 2
    crit = rt.allocator.allocate(RunRequest(user_id=user.id, kind="critical_validation", estimates=SMALL), now=t0)
    assert crit.outcome == O.DENIED and "premium quota exhausted" in crit.reasons[0]


def test_window_reset_restores_proactive_budget(rt, user, active):
    t0 = utcnow()
    burn(rt, user, 700_000, proactive=True, at=t0)
    assert rt.allocator.allocate(deep(user, active), now=t0).outcome == O.DEFERRED
    assert rt.allocator.allocate(deep(user, active), now=t0 + timedelta(hours=5, minutes=1)).outcome == O.APPROVED


def test_provider_observation_overrides_estimate(rt, user, active):
    t0 = utcnow()
    snap = rt.ledger.observe_provider("anthropic-premium", remaining=310_000, reset_time=t0 + timedelta(hours=2), now=t0)
    assert snap.remaining == 310_000 and snap.provider_observed
    assert rt.allocator.allocate(deep(user, active), now=t0).outcome == O.DEFERRED


# ---------------------------------------------------------------- invariant 3: expensive runs must justify


def test_expensive_runs_must_answer_the_five_questions(rt, user, active):
    d = rt.allocator.allocate(RunRequest(user_id=user.id, kind="deep_research", responsibility_id=active.id,
                                         justification=Justification(why_now="curious"), estimates=SMALL))
    assert d.outcome == O.DENIED
    assert d.reasons == ["missing justification: expected_gain, decision_affected, budget, stop_condition"]
    cheap = rt.allocator.allocate(RunRequest(user_id=user.id, kind="classification", responsibility_id=active.id))
    assert cheap.outcome == O.APPROVED and cheap.tier == 1


def test_low_value_proactive_work_is_deferred(rt, user, active):
    meh = Estimates(information_gain=0.1, decision_impact=0.1, user_relevance=0.1, input_tokens=1000, output_tokens=1000)
    d = rt.allocator.allocate(deep(user, active).model_copy(update={"estimates": meh}))
    assert d.outcome == O.DEFERRED and "below tier floor" in d.reasons[0]


# ---------------------------------------------------------------- perpetual responsibility != perpetual compute


def test_sleeping_and_monitoring_responsibilities_do_not_do_deep_work(rt, user):
    r = rt.responsibilities.create(user_id=user.id, title_en="x", actor=Origin.USER)  # MONITORING
    d = rt.allocator.allocate(deep(user, r))
    assert d.outcome == O.DENIED and "MONITORING" in d.reasons[0]
    assert rt.allocator.allocate(RunRequest(user_id=user.id, kind="monitoring", responsibility_id=r.id)).allowed
    rt.responsibilities.transition(r, "sleep", actor=Origin.AGENT)
    d = rt.allocator.allocate(RunRequest(user_id=user.id, kind="monitoring", responsibility_id=r.id))
    assert d.outcome == O.DENIED and "sleeping" in d.reasons[0]
    rt.responsibilities.transition(r, "pause", actor=Origin.USER)
    assert "paused" in rt.allocator.allocate(RunRequest(user_id=user.id, kind="monitoring",
                                                        responsibility_id=r.id)).reasons[0]


# ---------------------------------------------------------------- budget categories (§6)


def test_free_exploration_is_bounded_and_never_borrows(rt, user, policy):
    t0 = utcnow()
    cap = policy.budget.total_units * policy.budget.shares["free_exploration"]
    distant_cap = cap * policy.budget.exploration_mix["distant"]
    rt.ledger.record(tier=2, model="m", provider="anthropic", input_tokens=0, output_tokens=int(distant_cap / 5), now=t0,
                     ctx=UsageContext(category="free_exploration", proactive=True, user_id=user.id,
                                      exploration_scope="distant"))
    req = RunRequest(user_id=user.id, kind="exploration", exploration_scope="distant", justification=FULL, estimates=SMALL)
    d = rt.allocator.allocate(req, now=t0)
    assert not d.allowed and "free exploration (distant) budget exhausted" in d.reasons[-1]
    near = rt.allocator.allocate(req.model_copy(update={"exploration_scope": "neighborhood"}), now=t0)
    assert near.allowed
    with pytest.raises(AllocationError):
        rt.allocator.allocate(req.model_copy(update={"exploration_scope": None}))


def test_proactive_work_cannot_bill_the_user_reserve(rt, user, active):
    with pytest.raises(AllocationError):
        rt.allocator.allocate(deep(user, active, category="user_reserve"))


def test_candidate_stays_inside_its_exploration_budget(rt, user, active):
    cand = rt.responsibilities.create_candidate(active, title_en="tactile", actor=Origin.AGENT,
                                                exploration_budget={"max_units": 4_000})
    req = RunRequest(user_id=user.id, kind="exploration", exploration_scope="neighborhood", responsibility_id=cand.id,
                     justification=FULL, estimates=SMALL)
    d = rt.allocator.allocate(req)
    assert d.outcome == O.DOWNGRADED and d.tier == 1        # tier 2 (≈6k units) won't fit 4k; tier 1 (≈1.2k) does
    rt.ledger.record(tier=1, model="m", provider="anthropic", input_tokens=0, output_tokens=4_000,
                     ctx=UsageContext(category="free_exploration", proactive=True, user_id=user.id),
                     responsibility_id=cand.id)
    d = rt.allocator.allocate(req)
    assert d.outcome == O.DENIED and d.retry_after is None  # spent: will never free up


# ---------------------------------------------------------------- run audit log (§20) and runtime guard (§21)


def test_run_audit_record_has_every_field(rt, user, active, provider):
    d = rt.allocator.allocate(deep(user, active))
    with rt.runs.track(d) as guard:
        guard.tool_call("web_search", query="genie 4 contact-rich")
        rt.router.complete(d.tier, messages=[{"role": "user", "content": "hi"}], usage=guard.usage_context())
        guard.new_evidence.append("e1")
        guard.stop("conclusion updated")
    run = guard.run
    assert run.status == RunStatus.SUCCEEDED and run.stop_reason == "conclusion updated"
    assert run.why_now == FULL.why_now and run.stop_condition == FULL.stop_condition
    assert run.model == "claude-opus-5-5" and run.tier == 3 and run.output_tokens > 0 and run.cost_units > 0
    assert run.tools[0]["name"] == "web_search" and run.new_evidence == ["e1"]
    assert run.tension_before == run.tension_after == active.tension
    assert run.budget["granted"]["max_tool_calls"] == 10


def test_run_guard_stops_runaway_tool_loops(rt, user, active, session):
    d = rt.allocator.allocate(deep(user, active))
    with pytest.raises(RunBudgetExceeded):
        with rt.runs.track(d) as guard:
            while True:            # a runaway loop the guard must cut off
                guard.tool_call("search")
    run = session.get(Run, guard.run.id)
    assert run.status == RunStatus.BUDGET_EXCEEDED and len(run.tools) == 10


def test_cannot_start_a_run_without_an_approved_allocation(rt, user, active):
    d = rt.allocator.allocate(RunRequest(user_id=user.id, kind="deep_research", responsibility_id=active.id))
    with pytest.raises(RunNotAllowed):
        rt.runs.start(d)
