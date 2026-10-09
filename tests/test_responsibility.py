"""Spec §26 — Responsibility acceptance tests, plus state machine, situation and invariant checks."""

from __future__ import annotations

from datetime import timedelta

import pytest

from pga.db.models import Belief
from pga.db.types import BeliefType, FactType, Origin, ResponsibilityStatus as S, utcnow
from pga.responsibility import (
    LimitExceeded, PermissionDenied, PromotionError, ResponsibilityError, TransitionError,
)
from pga.situation import SituationError
from pga.tension import IncomingEvidence, Signals

NEWS = ("DeepMind releases Genie 4, a world model that generates interactive 3D environments in real time "
        "for training robot manipulation policies.")
REPOSTS = [NEWS, NEWS + " (via Hacker News)", "BREAKING: " + NEWS, NEWS + " Read more on our site.", NEWS]


@pytest.fixture
def resp(rt, user):
    return rt.responsibilities.create(
        user_id=user.id, title_en="Track world model research", description_en="world models for robot manipulation",
        keywords=["world model", "genie"], actor=Origin.USER)


def ingest(rt, user, text, *, at, uri=None, **kw):
    return rt.tension.ingest(user.id, IncomingEvidence(text=text, source_uri=uri, **kw), now=at)


# ---------------------------------------------------------------- §26: duplicate news is not linear


def test_duplicate_news_does_not_linearly_increase_tension(rt, user, resp):
    t0 = utcnow()
    first = ingest(rt, user, REPOSTS[0], at=t0, uri="https://a.com/genie4?utm_source=x", trust_score=0.6)
    single = first.effects[0].delta
    assert single > 0
    clusters = {first.cluster.id}
    for i, text in enumerate(REPOSTS[1:], 1):
        res = ingest(rt, user, text, at=t0 + timedelta(minutes=i), uri=f"https://site{i}.com/genie-4", trust_score=0.6)
        clusters.add(res.cluster.id)
    assert len(clusters) == 1, "near-duplicate reports must cluster into one event"
    assert first.cluster.source_count == 5
    assert first.cluster.confidence > 0.95       # more sources → more confidence…
    assert resp.tension < 1.5 * single           # …but not linearly more tension (5× would be linear)


def test_same_url_with_tracking_params_is_one_event(rt, user, resp):
    t0 = utcnow()
    a = ingest(rt, user, "Story A about world model scaling", at=t0, uri="http://www.x.com/p/1?utm_campaign=z")
    b = ingest(rt, user, "Completely different wording", at=t0, uri="https://x.com/p/1/")
    assert a.cluster.id == b.cluster.id


# ---------------------------------------------------------------- §26: contradiction raises tension strongly


def test_contradiction_raises_tension_strongly(rt, user, resp):
    t0 = utcnow()
    plain = ingest(rt, user, "A new survey of world model benchmarks was published.", at=t0,
                   signals={resp.id: Signals(relevance=0.8)}).effects[0].delta
    contra = ingest(rt, user, "New results show world model rollouts fail on contact-rich manipulation.",
                    at=t0 + timedelta(minutes=1),
                    signals={resp.id: Signals(relevance=0.8, contradiction=1.0)}).effects[0]
    assert contra.delta > 2.5 * plain
    assert contra.delta > 0.4


def test_contradiction_counts_even_for_absorbed_event(rt, user, resp):
    t0 = utcnow()
    r1 = ingest(rt, user, NEWS, at=t0)
    rt.tension.absorb(resp, [r1.cluster.id], now=t0 + timedelta(minutes=1))
    dup = ingest(rt, user, NEWS + " (mirror)", at=t0 + timedelta(minutes=2)).effects[0].delta
    contra = ingest(rt, user, NEWS + " (update)", at=t0 + timedelta(minutes=3),
                    signals={resp.id: Signals(relevance=0.9, contradiction=1.0)}).effects[0].delta
    assert dup < 0.01 and contra > 0.3


# ---------------------------------------------------------------- §26: resolved uncertainty lowers tension


def test_resolved_uncertainty_lowers_tension(rt, user, resp, session):
    t0 = utcnow()
    rt.tension.adjust(resp, 0.6, reason="user: this matters", actor=Origin.USER, now=t0)
    b = Belief(responsibility_id=resp.id, type=BeliefType.UNCERTAINTY,
               statement_en="Unclear whether Genie 4 weights will be released", confidence=0.3)
    session.add(b)
    session.flush()
    before = resp.tension
    delta = rt.tension.resolve_uncertainty(resp, belief_id=b.id, note="weights released", now=t0)
    assert delta < 0 and resp.tension < before - 0.3
    assert b.status.value == "RESOLVED"


def test_user_rejection_lowers_tension_and_blocks_that_direction(rt, user, resp):
    t0 = utcnow()
    res = ingest(rt, user, NEWS, at=t0, signals={resp.id: Signals(relevance=1, decision_impact=1, uncertainty=1)})
    before = resp.tension
    rt.tension.reject_direction(resp, cluster_id=res.cluster.id, note="not interested in Genie", now=t0)
    assert resp.tension < before * 0.5
    again = ingest(rt, user, NEWS + " (another site)", at=t0 + timedelta(minutes=1),
                   signals={resp.id: Signals(relevance=1, decision_impact=1, uncertainty=1)})
    assert again.cluster.id == res.cluster.id and again.effects[0].delta == 0
    with pytest.raises(PermissionError):
        rt.tension.reject_direction(resp, actor=Origin.AGENT)


def test_expired_opportunity_removes_its_tension(rt, user, resp):
    t0 = utcnow()
    res = ingest(rt, user, "Call for papers: world model workshop, deadline Friday", at=t0,
                 expires_at=t0 + timedelta(days=2),
                 signals={resp.id: Signals(relevance=0.9, opportunity=1.0, deadline=0.8)})
    assert resp.tension > 0.3
    report = rt.tension.tick(user.id, now=t0 + timedelta(days=2, minutes=1))
    assert str(res.cluster.id) in report["expired_clusters"]
    assert resp.tension < 0.05


def test_absorbed_information_stops_pulling(rt, user, resp):
    t0 = utcnow()
    res = ingest(rt, user, NEWS, at=t0, signals={resp.id: Signals(relevance=1, decision_impact=1, uncertainty=1)})
    peak = resp.tension
    rt.tension.absorb(resp, [res.cluster.id], now=t0 + timedelta(minutes=5))
    assert resp.tension < peak * 0.3


def test_stagnation_decays_faster(rt, user, policy):
    a = rt.responsibilities.create(user_id=user.id, title_en="A", actor=Origin.USER)
    b = rt.responsibilities.create(user_id=user.id, title_en="B", actor=Origin.USER)
    t0 = utcnow()
    for r in (a, b):
        rt.tension.adjust(r, 0.5, reason="seed", actor=Origin.USER, now=t0)
    rt.tension.decay(a, t0 + timedelta(hours=72))                       # one normal half-life
    rt.tension.decay(b, t0 + timedelta(hours=policy.tension.stagnation_hours + 72))
    assert a.tension == pytest.approx(0.25, rel=1e-3)
    assert b.tension < 0.5 * 0.5 ** (policy.tension.stagnation_hours / 72) * 0.5  # faster than plain decay


# ---------------------------------------------------------------- §26: sleeping task wakes on relevant event


def test_sleeping_task_wakes_on_relevant_event(rt, user, resp):
    t0 = utcnow()
    rt.responsibilities.transition(resp, "sleep", actor=Origin.AGENT, now=t0)
    irrelevant = ingest(rt, user, "Stock markets close higher on bank earnings", at=t0)
    assert irrelevant.effects[0].delta == 0 and resp.status == S.SLEEPING
    res = ingest(rt, user, "Genie 4 world model contradicts our sim-to-real assumption", at=t0 + timedelta(minutes=1),
                 signals={resp.id: Signals(relevance=0.95, contradiction=1.0, decision_impact=0.9, uncertainty=0.8)})
    assert res.effects[0].transition == "wake" and resp.status == S.ACTIVE
    why = rt.tension.why_awake(resp)
    assert why["last_wake"]["op"] == "wake" and "contradiction" in why["last_wake"]["why_now"][0]


def test_paused_responsibility_never_auto_wakes(rt, user, resp):
    rt.responsibilities.transition(resp, "pause", actor=Origin.USER)
    ingest(rt, user, NEWS, at=utcnow(), signals={resp.id: Signals(relevance=1, contradiction=1, decision_impact=1)})
    assert resp.tension >= resp.wake_threshold and resp.status == S.SLEEPING
    with pytest.raises(TransitionError):
        rt.responsibilities.transition(resp, "wake", actor=Origin.AGENT)
    with pytest.raises(PermissionDenied):
        rt.responsibilities.transition(resp, "unpause", actor=Origin.AGENT)
    rt.responsibilities.transition(resp, "unpause", actor=Origin.USER)
    assert resp.status == S.ACTIVE and not resp.paused_by_user


def test_hysteresis_band_holds_state(rt, user, resp):
    t0 = utcnow()
    rt.tension.adjust(resp, 0.6, reason="between thresholds", actor=Origin.USER, now=t0)
    assert resp.status == S.MONITORING                       # 0.6 < wake 0.75: no wake
    rt.tension.adjust(resp, 0.2, reason="push over", actor=Origin.USER, now=t0)
    assert resp.status == S.ACTIVE
    rt.tension.adjust(resp, -0.3, reason="drop to 0.5", actor=Origin.USER, now=t0)
    assert resp.status == S.ACTIVE                           # 0.5 > sleep 0.35: stays awake
    rt.tension.adjust(resp, -0.2, reason="drop to 0.3", actor=Origin.USER, now=t0)
    assert resp.status == S.MONITORING


def test_long_quiet_period_goes_to_sleep_and_scheduled_review_wakes_to_monitoring(rt, user, resp, policy):
    t0 = utcnow()
    rt.tension.tick(user.id, now=t0 + timedelta(hours=policy.tension.stagnation_hours + 1))
    assert resp.status == S.SLEEPING
    resp.next_review_at = t0 + timedelta(days=10)
    rt.tension.tick(user.id, now=t0 + timedelta(days=10, minutes=1))
    assert resp.status == S.MONITORING and resp.next_review_at is None


# ---------------------------------------------------------------- §26: candidates stay bounded


def test_candidate_cannot_become_perpetual_without_promotion(rt, user, resp):
    t0 = utcnow()
    cand = rt.responsibilities.create_candidate(resp, title_en="Explore tactile world models", actor=Origin.AGENT,
                                                exploration_budget={"max_units": 50_000, "max_runs": 3},
                                                ttl_hours=72, keywords=["tactile"], now=t0)
    assert cand.status == S.CANDIDATE and cand.candidate_expires_at is not None
    for op in ("wake", "sleep", "monitor", "wait_for_user", "resume", "complete"):
        with pytest.raises((TransitionError, PermissionDenied)):
            rt.responsibilities.transition(cand, op, actor=Origin.AGENT)
    # high tension alone never promotes it
    ingest(rt, user, "tactile world model breakthrough", at=t0,
           signals={cand.id: Signals(relevance=1, contradiction=1, decision_impact=1, uncertainty=1)})
    assert cand.tension >= cand.wake_threshold and cand.status == S.CANDIDATE
    # the agent cannot promote it, and the user cannot until promotion criteria are met
    with pytest.raises(PromotionError) as e:
        rt.responsibilities.transition(cand, "promote", actor=Origin.AGENT, now=t0)
    assert any("approval" in f for f in e.value.failures)
    with pytest.raises(PromotionError):
        rt.responsibilities.transition(cand, "promote", actor=Origin.USER, now=t0)
    rt.responsibilities.record_useful_outcome(cand, "found 2 relevant papers")
    rt.responsibilities.transition(cand, "promote", actor=Origin.USER, now=t0)
    assert cand.status == S.ACTIVE and cand.created_by == Origin.USER


def test_unpromoted_candidate_expires(rt, user, resp):
    t0 = utcnow()
    cand = rt.responsibilities.create_candidate(resp, title_en="Side quest", actor=Origin.AGENT,
                                                exploration_budget={"max_units": 1000}, ttl_hours=24, now=t0)
    rt.tension.tick(user.id, now=t0 + timedelta(hours=25))
    assert cand.status == S.ARCHIVED and "expired" in cand.stop_reason
    with pytest.raises(TransitionError):
        rt.responsibilities.transition(cand, "promote", actor=Origin.USER)


def test_candidate_needs_bounds_and_cannot_nest_forever(rt, user, resp):
    with pytest.raises(ResponsibilityError, match="bounded exploration_budget"):
        rt.responsibilities.create_candidate(resp, title_en="x", actor=Origin.AGENT, exploration_budget={})
    c1 = rt.responsibilities.create_candidate(resp, title_en="c1", actor=Origin.AGENT, exploration_budget={"max_units": 1})
    c2 = rt.responsibilities.create_candidate(c1, title_en="c2", actor=Origin.AGENT, exploration_budget={"max_units": 1})
    with pytest.raises(LimitExceeded):
        rt.responsibilities.create_candidate(c2, title_en="c3", actor=Origin.AGENT, exploration_budget={"max_units": 1})


# ---------------------------------------------------------------- ownership invariants


def test_only_user_creates_perpetual_responsibilities(rt, user):
    for actor in (Origin.AGENT, Origin.EXTERNAL, Origin.SYSTEM):
        with pytest.raises(PermissionDenied):
            rt.responsibilities.create(user_id=user.id, title_en="x", actor=actor)


def test_external_content_cannot_change_goals(rt, user, resp):
    with pytest.raises(PermissionDenied):
        rt.responsibilities.update(resp, actor=Origin.EXTERNAL, title_en="Buy crypto")
    with pytest.raises(PermissionDenied):
        rt.responsibilities.update(resp, actor=Origin.AGENT, title_en="Something else")
    with pytest.raises(PermissionDenied):
        rt.responsibilities.transition(resp, "cancel", actor=Origin.EXTERNAL)
    with pytest.raises(PermissionDenied):
        rt.responsibilities.transition(resp, "complete", actor=Origin.AGENT)
    with pytest.raises(PermissionError):
        rt.tension.adjust(resp, 0.5, reason="injected", actor=Origin.EXTERNAL)


def test_perpetual_limit(rt, user, policy):
    for i in range(policy.limits.max_perpetual_responsibilities_per_user):
        rt.responsibilities.create(user_id=user.id, title_en=f"r{i}", actor=Origin.USER)
    with pytest.raises(LimitExceeded):
        rt.responsibilities.create(user_id=user.id, title_en="one too many", actor=Origin.USER)


def test_transitions_are_audited(rt, user, resp, session):
    from sqlalchemy import select

    from pga.db.models import AuditLog
    rt.responsibilities.transition(resp, "wait_for_user", actor=Origin.AGENT, reason="need a decision")
    row = session.scalars(select(AuditLog).where(AuditLog.entity_id == resp.id,
                                                 AuditLog.kind == "responsibility.transition")).one()
    assert row.payload["from_status"] == "MONITORING" and row.payload["to_status"] == "WAIT_USER"
    assert row.payload["reason"] == "need a decision" and row.actor == Origin.AGENT


# ---------------------------------------------------------------- situation model (invariant 5, 11)


def test_fact_types_and_origins_are_separated(rt, user):
    sit = rt.situation
    with pytest.raises(SituationError):
        sit.add(user_id=user.id, type=FactType.PREFERENCE, canonical_en="likes crypto", origin=Origin.EXTERNAL, topic="t")
    with pytest.raises(SituationError):
        sit.add(user_id=user.id, type=FactType.USER_FACT, canonical_en="user is a CEO", origin=Origin.AGENT)
    with pytest.raises(SituationError):
        sit.add(user_id=user.id, type=FactType.INFERRED_PREFERENCE, canonical_en="x", origin=Origin.USER, topic="t")
    sit.add(user_id=user.id, type=FactType.OBSERVATION, canonical_en="Paper deadline cited on site",
            origin=Origin.EXTERNAL, source_uri="https://x.org")


def test_explicit_preference_beats_inferred(rt, user):
    sit = rt.situation
    inferred = sit.add(user_id=user.id, type=FactType.INFERRED_PREFERENCE, canonical_en="Prefers long reports",
                       origin=Origin.AGENT, topic="report_length", confidence=0.6)
    explicit = sit.add(user_id=user.id, type=FactType.PREFERENCE, canonical_en="Wants reports under one page",
                       origin=Origin.USER, topic="report_length")
    assert inferred.superseded_by_id == explicit.id
    late = sit.add(user_id=user.id, type=FactType.INFERRED_PREFERENCE, canonical_en="Prefers long reports again",
                   origin=Origin.AGENT, topic="report_length")
    assert late.superseded_by_id == explicit.id   # inference never overrides the user's own word
    current = [f.canonical_en for f in sit.current(user.id, {FactType.PREFERENCE, FactType.INFERRED_PREFERENCE})]
    assert current == ["Wants reports under one page"]
