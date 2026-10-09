"""Resource Allocator (spec §7, §8, invariant 3).

Decides whether a run may spend compute, at which model tier, and under what
limits. Order of checks:

1. responsibility state  — sleeping/paused/waiting work does not compute
2. justification         — tier ≥ 2 runs must say why_now, expected_gain,
                           decision_affected, budget, stop_condition
3. candidate budget      — candidates stay inside their bounded exploration budget
4. value vs cost score   — proactive work must clear the tier's minimum score
5. category budget       — §6 shares; user_reserve protected; exploration bounded
6. premium quota         — §8: proactive stops at ~70%, ~30% kept for the user

When a check fails the allocator tries a cheaper tier (down to the task's
min_tier) before deferring — "background work falls back to cheap mode".
"""

from __future__ import annotations

import uuid
from dataclasses import dataclass, field
from datetime import datetime, timedelta
from typing import Any

from pydantic import BaseModel, Field, field_validator

from sqlalchemy import func, select
from sqlalchemy.orm import Session

from pga.budget import BudgetLedger
from pga.config import Policy, TaskPolicy
from pga.db.models import AllocationRecord, Responsibility, Run
from pga.db.types import AllocationOutcome as O, ResponsibilityStatus as S, utcnow

JUSTIFICATION_FIELDS = ("why_now", "expected_gain", "decision_affected", "budget", "stop_condition")
CHEAP_KINDS = {"monitoring", "extraction", "classification", "event_scoring", "retrieval", "deterministic", "translation"}
WAIT_EXTERNAL_KINDS = {"monitoring", "retrieval", "deterministic", "event_scoring", "classification"}


class Justification(BaseModel):
    why_now: str | None = None
    expected_gain: str | None = None
    decision_affected: str | None = None
    budget: dict[str, Any] | None = None   # e.g. {"max_units": 50000, "max_tool_calls": 10}
    stop_condition: str | None = None

    def missing(self) -> list[str]:
        return [f for f in JUSTIFICATION_FIELDS if not getattr(self, f)]


class Estimates(BaseModel):
    information_gain: float = Field(0.5, ge=0, le=1)
    decision_impact: float = Field(0.5, ge=0, le=1)
    user_relevance: float = Field(0.5, ge=0, le=1)
    urgency: float = Field(0.0, ge=0, le=1)
    reuse_value: float = Field(0.0, ge=0, le=1)
    interruption_cost: float = Field(0.0, ge=0, le=1)  # will this run notify/interrupt the user?
    staleness_risk: float = Field(0.0, ge=0, le=1)     # will the result go stale before it is used?
    input_tokens: int | None = Field(None, ge=0)
    output_tokens: int | None = Field(None, ge=0)


class RunRequest(BaseModel):
    user_id: uuid.UUID
    kind: str
    responsibility_id: uuid.UUID | None = None
    preferred_tier: int | None = Field(None, ge=0, le=3)
    category: str | None = None              # override the task's default category
    exploration_scope: str | None = None     # neighborhood | adjacent | distant (free exploration)
    justification: Justification = Justification()
    estimates: Estimates = Estimates()

    @field_validator("kind")
    @classmethod
    def _kind(cls, v: str) -> str:
        return v.strip().lower()


@dataclass
class AllocationDecision:
    outcome: O
    kind: str
    category: str
    proactive: bool
    tier_requested: int
    tier: int | None
    model: str | None
    score: float
    score_breakdown: dict[str, float]
    limits: dict[str, Any]
    justification: dict[str, Any]
    reasons: list[str] = field(default_factory=list)
    retry_after: datetime | None = None
    exploration_scope: str | None = None
    responsibility_id: uuid.UUID | None = None
    user_id: uuid.UUID | None = None
    id: uuid.UUID | None = None

    @property
    def allowed(self) -> bool:
        return self.outcome in {O.APPROVED, O.DOWNGRADED}

    def as_dict(self) -> dict[str, Any]:
        return {
            "id": str(self.id) if self.id else None, "outcome": self.outcome.value, "kind": self.kind,
            "category": self.category, "proactive": self.proactive, "tier_requested": self.tier_requested,
            "tier": self.tier, "model": self.model, "score": round(self.score, 4),
            "score_breakdown": self.score_breakdown, "limits": self.limits, "reasons": self.reasons,
            "retry_after": self.retry_after.isoformat() if self.retry_after else None,
            "exploration_scope": self.exploration_scope,
        }


class AllocationError(ValueError):
    pass


class ResourceAllocator:
    def __init__(self, session: Session, policy: Policy, ledger: BudgetLedger):
        self.session = session
        self.policy = policy
        self.ledger = ledger

    def task(self, kind: str) -> TaskPolicy:
        try:
            return self.policy.allocator.tasks[kind]
        except KeyError as exc:
            raise AllocationError(f"unknown task kind {kind!r}; known: {sorted(self.policy.allocator.tasks)}") from exc

    def estimate_units(self, tier: int, est: Estimates) -> float:
        if tier == 0:
            return 0.0
        limits = self.policy.allocator.default_limits_by_tier[tier]
        out_tok = est.output_tokens if est.output_tokens is not None else limits.max_output_tokens // 2
        in_tok = est.input_tokens if est.input_tokens is not None else 4000
        return self.ledger.units_for(tier, in_tok, out_tok)

    def score(self, req: RunRequest, tier: int, r: Responsibility | None) -> tuple[float, dict[str, float]]:
        w, e = self.policy.allocator.weights, req.estimates
        cost = min(3.0, self.estimate_units(tier, e) / self.policy.allocator.reference_cost_units)
        parts = {
            "information_gain": w.get("information_gain", 1) * e.information_gain,
            "decision_impact": w.get("decision_impact", 1) * e.decision_impact,
            "user_relevance": w.get("user_relevance", 1) * e.user_relevance,
            "urgency": w.get("urgency", 1) * e.urgency,
            "reuse_value": w.get("reuse_value", 1) * e.reuse_value,
            "compute_cost": -w.get("compute_cost", 1) * cost,
            "interruption_cost": -w.get("interruption_cost", 1) * e.interruption_cost,
            "staleness_risk": -w.get("staleness_risk", 1) * e.staleness_risk,
        }
        if r is not None and r.priority_bias:
            parts["priority_bias"] = r.priority_bias
        return sum(parts.values()), {k: round(v, 4) for k, v in parts.items()}

    # ---------------------------------------------------------------- main entry

    def allocate(self, req: RunRequest, now: datetime | None = None) -> AllocationDecision:
        now = now or utcnow()
        task = self.task(req.kind)
        proactive = not task.reactive
        category = req.category or task.category
        if category not in self.policy.budget.shares:
            raise AllocationError(f"unknown budget category {category!r}")
        if proactive and category == "user_reserve":
            raise AllocationError("proactive work cannot be billed to user_reserve")
        if category == "free_exploration" and req.exploration_scope not in self.policy.budget.exploration_mix:
            raise AllocationError(f"free exploration needs exploration_scope in {sorted(self.policy.budget.exploration_mix)}")

        tier_req = req.preferred_tier if req.preferred_tier is not None else task.tier
        if not task.reactive and req.preferred_tier is not None and req.preferred_tier > task.tier:
            tier_req = task.tier  # proactive work cannot self-upgrade past its task tier
        min_tier = task.min_tier if task.min_tier is not None else tier_req
        min_tier = min(min_tier, tier_req)
        just = self._justification(req, task)
        r = self.session.get(Responsibility, req.responsibility_id) if req.responsibility_id else None
        if req.responsibility_id and r is None:
            raise AllocationError("responsibility not found")
        if r is not None and r.user_id != req.user_id:
            raise AllocationError("responsibility belongs to another user")

        decision = AllocationDecision(outcome=O.DENIED, kind=req.kind, category=category, proactive=proactive,
                                      tier_requested=tier_req, tier=None, model=None, score=0.0,
                                      score_breakdown={}, limits={}, justification=just.model_dump(),
                                      exploration_scope=req.exploration_scope, responsibility_id=req.responsibility_id,
                                      user_id=req.user_id)

        # 1. responsibility state
        state_problem = self._state_problem(r, req.kind, proactive)
        if state_problem:
            decision.reasons.append(state_problem)
            return self._save(decision, now)

        # 2. justification (invariant 3)
        if tier_req >= self.policy.allocator.justification_required_from_tier:
            missing = just.missing()
            if missing:
                decision.reasons.append(f"missing justification: {', '.join(missing)}")
                return self._save(decision, now)

        # 3–6, from the requested tier down to the floor
        retry_after: datetime | None = None
        permanent = False
        for tier in range(tier_req, min_tier - 1, -1):
            est_units = self.estimate_units(tier, req.estimates)
            if just.budget and isinstance(just.budget.get("max_units"), (int, float)):
                est_units = min(est_units, float(just.budget["max_units"]))  # the run guard enforces this cap
            score, breakdown = self.score(req, tier, r)
            problem, when, hard = self._check_tier(req, task, r, tier, est_units, score, category, proactive, now)
            if problem is None:
                decision.outcome = O.APPROVED if tier == tier_req else O.DOWNGRADED
                decision.tier = tier
                decision.model = self.policy.llm.tiers.get(tier) if tier > 0 else None
                decision.score, decision.score_breakdown = score, breakdown
                decision.limits = self._limits(tier, just, est_units)
                if tier != tier_req:
                    decision.reasons.append(f"downgraded tier {tier_req} → {tier}")
                return self._save(decision, now)
            decision.reasons.append(f"tier {tier}: {problem}")
            decision.score, decision.score_breakdown = score, breakdown
            permanent = permanent or hard
            if when and (retry_after is None or when < retry_after):
                retry_after = when

        # Reactive work that cannot run is DENIED (the caller must tell the user now);
        # proactive work is DEFERRED unless the limit will never free up (candidate budget).
        decision.outcome = O.DENIED if (permanent or not proactive) else O.DEFERRED
        decision.retry_after = None if permanent else retry_after
        return self._save(decision, now)

    # ---------------------------------------------------------------- checks

    def _justification(self, req: RunRequest, task: TaskPolicy) -> Justification:
        j = req.justification.model_copy()
        if task.reactive:
            # user-facing work justifies itself; fill the blanks rather than blocking the user
            j.why_now = j.why_now or f"reactive: {req.kind}"
            j.expected_gain = j.expected_gain or "serve the user's request"
            j.decision_affected = j.decision_affected or "the user's current request"
            j.budget = j.budget or {"source": "tier defaults"}
            j.stop_condition = j.stop_condition or "response delivered"
        return j

    def _state_problem(self, r: Responsibility | None, kind: str, proactive: bool) -> str | None:
        if r is None or not proactive:
            return None
        if r.paused_by_user:
            return "responsibility is paused by the user"
        if r.status in {S.COMPLETED, S.ARCHIVED}:
            return f"responsibility is {r.status.value}"
        if r.status == S.SLEEPING:
            return "responsibility is sleeping — it computes only after tension wakes it"
        if r.status == S.WAIT_USER:
            return "waiting for the user — no proactive compute until they respond"
        if r.status == S.WAIT_EXTERNAL and kind not in WAIT_EXTERNAL_KINDS:
            return "waiting for an external event — only cheap monitoring allowed"
        if r.status == S.MONITORING and kind not in CHEAP_KINDS:
            return "responsibility is MONITORING — deeper work needs tension to wake it (ACTIVE)"
        if r.status == S.CANDIDATE and kind not in CHEAP_KINDS | {"exploration", "synthesis", "comparison"}:
            return "candidate responsibilities may only explore within their budget"
        return None

    def _check_tier(self, req: RunRequest, task: TaskPolicy, r: Responsibility | None, tier: int,
                    est: float, score: float, category: str, proactive: bool,
                    now: datetime) -> tuple[str | None, datetime | None, bool]:
        """(problem, retry_after, permanent). problem None = this tier is allowed."""
        if tier == 0:
            return None, None, False  # deterministic code is always allowed
        if tier not in self.policy.llm.tiers:
            return f"no model configured for tier {tier}", None, False

        # 3. candidate budget
        if r is not None and r.status == S.CANDIDATE:
            eb = (r.compute_budget or {}).get("exploration", {})
            spent = self.ledger.spend(req.user_id, responsibility_id=r.id)
            if spent + est > float(eb.get("max_units", 0)):
                return (f"candidate exploration budget exceeded ({spent:.0f}+{est:.0f} > {eb.get('max_units')})",
                        None, spent >= float(eb.get("max_units", 0)))
            max_runs = eb.get("max_runs")
            if max_runs is not None:
                runs = self.session.scalar(select(func.count()).select_from(Run).where(Run.responsibility_id == r.id)) or 0
                if runs >= int(max_runs):
                    return f"candidate run budget exceeded ({runs} ≥ {max_runs})", None, True

        # per-responsibility period cap, if the user set one
        if r is not None and (r.compute_budget or {}).get("max_units_per_period"):
            spent = self.ledger.spend(req.user_id, responsibility_id=r.id, since=self.ledger.period_start(now), now=now)
            if spent + est > float(r.compute_budget["max_units_per_period"]):
                return "responsibility budget for this period exceeded", now + timedelta(hours=1), False

        # 4. value vs cost (proactive only — the user asking is reason enough)
        if proactive:
            floor = self.policy.allocator.min_score_by_tier.get(tier, 0.0)
            if score < floor:
                return f"expected value {score:.2f} below tier floor {floor:.2f}", None, False

        # 5. category budget
        cap = self.ledger.category_cap(category)
        spent = self.ledger.spend(req.user_id, category=category, now=now)
        if category == "free_exploration":
            sub_cap = cap * self.policy.budget.exploration_mix[req.exploration_scope]
            sub_spent = self.ledger.spend(req.user_id, category=category, exploration_scope=req.exploration_scope, now=now)
            if sub_spent + est > sub_cap:
                return (f"free exploration ({req.exploration_scope}) budget exhausted "
                        f"({sub_spent:.0f}+{est:.0f} > {sub_cap:.0f})",
                        self.ledger.budget_frees_at(req.user_id, category, now), False)
        if spent + est > cap:
            borrowable = (not proactive and self.policy.budget.reactive_may_use_unspent)
            if not borrowable or est > self.ledger.unspent_proactive(req.user_id, now):
                return (f"{category} budget exhausted ({spent:.0f}+{est:.0f} > {cap:.0f})",
                        self.ledger.budget_frees_at(req.user_id, category, now), False)

        # 6. premium quota
        q = self.ledger.quota_policy(tier)
        if q is not None:
            snap = self.ledger.quota(q, now)
            reset = snap.reset_time or (now + timedelta(seconds=q.window_seconds))
            if proactive:
                if est > snap.proactive_headroom:
                    paused = task.quota_class in set(q.after_target.pause)
                    why = (f"proactive premium target reached ({snap.used_proactive:.0f}/{snap.proactive_cap:.0f} used, "
                           f"{snap.remaining:.0f} left, {snap.reserve:.0f} reserved for the user)")
                    return why + ("; paused until reset" if paused else ""), reset, False
            elif est > snap.remaining:
                return f"premium quota exhausted ({snap.remaining:.0f} left)", reset, False
        return None, None, False

    def _limits(self, tier: int, just: Justification, est_units: float) -> dict[str, Any]:
        d = self.policy.allocator.default_limits_by_tier[tier].model_dump()
        b = just.budget or {}
        for k in ("max_output_tokens", "timeout_s", "max_tool_calls"):
            if isinstance(b.get(k), (int, float)):
                d[k] = min(d[k], int(b[k]))
        d["max_units"] = float(b["max_units"]) if isinstance(b.get("max_units"), (int, float)) else round(est_units * 2, 1)
        return d

    def _save(self, d: AllocationDecision, now: datetime) -> AllocationDecision:
        rec = AllocationRecord(user_id=d.user_id, responsibility_id=d.responsibility_id, kind=d.kind,
                               category=d.category, proactive=d.proactive, outcome=d.outcome,
                               tier_requested=d.tier_requested, tier_granted=d.tier, model=d.model,
                               score=d.score, score_breakdown=d.score_breakdown, justification=d.justification,
                               limits=d.limits, reasons=d.reasons, retry_after=d.retry_after, created_at=now)
        self.session.add(rec)
        self.session.flush()
        d.id = rec.id
        return d
