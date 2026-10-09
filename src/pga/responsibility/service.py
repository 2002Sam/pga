"""Responsibility portfolio and state machine (spec §4, §5, §9).

Rules this module enforces:
- Motivation belongs to the user: only the USER creates perpetual responsibilities,
  completes/cancels them, or pauses/unpauses them (invariant 1).
- External content can never create or change a responsibility (invariant 11).
- The agent may open CANDIDATE children with a bounded exploration budget and an
  expiry; a candidate becomes perpetual only through `promote`, which checks its
  promotion criteria (spec §5).
- Every transition is written to the audit log with its reason.
"""

from __future__ import annotations

import uuid
from dataclasses import dataclass
from datetime import datetime, timedelta
from typing import Any

from sqlalchemy import func, select
from sqlalchemy.orm import Session

from pga import audit
from pga.config import Policy
from pga.db.models import Responsibility
from pga.db.types import (
    PERPETUAL_STATUSES, TERMINAL_STATUSES, Origin, ResponsibilityStatus as S, utcnow,
)


class ResponsibilityError(ValueError):
    pass


class TransitionError(ResponsibilityError):
    pass


class PromotionError(ResponsibilityError):
    def __init__(self, failures: list[str]):
        super().__init__("promotion criteria not met: " + "; ".join(failures))
        self.failures = failures


class PermissionDenied(ResponsibilityError):
    pass


class LimitExceeded(ResponsibilityError):
    pass


@dataclass(frozen=True)
class Op:
    sources: frozenset[S]
    target: S | None          # None = computed by the op
    user_only: bool = False   # only the user may do this to user-created responsibilities


OPS: dict[str, Op] = {
    "wake": Op(frozenset({S.MONITORING, S.SLEEPING}), S.ACTIVE),
    "monitor": Op(frozenset({S.ACTIVE, S.SLEEPING}), S.MONITORING),
    "sleep": Op(frozenset({S.ACTIVE, S.MONITORING}), S.SLEEPING),
    "wait_for_user": Op(frozenset({S.ACTIVE, S.MONITORING}), S.WAIT_USER),
    "wait_for_event": Op(frozenset({S.ACTIVE, S.MONITORING}), S.WAIT_EXTERNAL),
    "resume": Op(frozenset({S.WAIT_USER, S.WAIT_EXTERNAL, S.SLEEPING}), None),
    "pause": Op(frozenset(PERPETUAL_STATUSES), S.SLEEPING, user_only=True),
    "unpause": Op(frozenset({S.SLEEPING}), None, user_only=True),
    "complete": Op(frozenset({S.ACTIVE, S.MONITORING, S.WAIT_USER, S.WAIT_EXTERNAL, S.SLEEPING}), S.COMPLETED, user_only=True),
    "cancel": Op(frozenset(PERPETUAL_STATUSES | {S.CANDIDATE}), S.ARCHIVED, user_only=True),
    "archive": Op(frozenset({S.COMPLETED}), S.ARCHIVED, user_only=True),
    "promote": Op(frozenset({S.CANDIDATE}), None),
    "expire": Op(frozenset({S.CANDIDATE}), S.ARCHIVED),
}
# Ops the agent itself may NOT run on candidates (a candidate is never woken/slept into perpetuity).
CANDIDATE_OPS = {"promote", "expire", "cancel"}
DEFAULT_PROMOTION = {"requires_user_approval": True, "min_useful_outcomes": 1, "min_tension": 0.0}


class ResponsibilityService:
    def __init__(self, session: Session, policy: Policy):
        self.session = session
        self.policy = policy

    # ---------------------------------------------------------------- queries

    def get(self, rid: uuid.UUID) -> Responsibility:
        r = self.session.get(Responsibility, rid)
        if r is None:
            raise ResponsibilityError(f"responsibility {rid} not found")
        return r

    def list(self, user_id: uuid.UUID, statuses: set[S] | None = None) -> list[Responsibility]:
        q = select(Responsibility).where(Responsibility.user_id == user_id)
        if statuses:
            q = q.where(Responsibility.status.in_(statuses))
        return list(self.session.scalars(q.order_by(Responsibility.created_at)))

    def perpetual_count(self, user_id: uuid.UUID) -> int:
        return self.session.scalar(select(func.count()).select_from(Responsibility).where(
            Responsibility.user_id == user_id, Responsibility.status.in_(PERPETUAL_STATUSES))) or 0

    def candidate_depth(self, r: Responsibility) -> int:
        depth, node = 0, r
        while node is not None and node.status == S.CANDIDATE:
            depth += 1
            node = node.parent
        return depth

    # ---------------------------------------------------------------- creation

    def create(self, *, user_id: uuid.UUID, title_en: str, description_en: str = "", actor: Origin,
               raw_title: str | None = None, keywords: list[str] | None = None,
               priority_bias: float = 0.0, compute_budget: dict[str, Any] | None = None,
               wake_threshold: float | None = None, sleep_threshold: float | None = None,
               tension_policy: dict[str, Any] | None = None, initial_status: S = S.MONITORING,
               next_review_at: datetime | None = None) -> Responsibility:
        if actor != Origin.USER:
            raise PermissionDenied("only the user can create a perpetual responsibility; "
                                   "the agent may propose a candidate instead")
        if initial_status not in {S.ACTIVE, S.MONITORING}:
            raise TransitionError("new responsibilities start ACTIVE or MONITORING")
        limit = self.policy.limits.max_perpetual_responsibilities_per_user
        if self.perpetual_count(user_id) >= limit:
            raise LimitExceeded(f"user already has {limit} perpetual responsibilities "
                                "(complete, archive or pause one first)")
        tp = self.policy.tension
        wake = tp.default_wake_threshold if wake_threshold is None else wake_threshold
        sleep = tp.default_sleep_threshold if sleep_threshold is None else sleep_threshold
        _check_thresholds(wake, sleep)
        r = Responsibility(user_id=user_id, title_en=title_en, description_en=description_en,
                           raw_title=raw_title, status=initial_status, tension=0.0,
                           wake_threshold=wake, sleep_threshold=sleep, priority_bias=priority_bias,
                           compute_budget=compute_budget or {}, keywords=keywords or [],
                           tension_policy=tension_policy or {}, created_by=Origin.USER,
                           next_review_at=next_review_at)
        self.session.add(r)
        self.session.flush()
        audit.record(self.session, kind="responsibility.created", entity_type="responsibility",
                     entity_id=r.id, actor=actor, user_id=user_id, status=r.status.value, title=title_en)
        return r

    def create_candidate(self, parent: Responsibility, *, title_en: str, description_en: str = "",
                         actor: Origin, exploration_budget: dict[str, Any], ttl_hours: float = 168,
                         promotion_criteria: dict[str, Any] | None = None,
                         keywords: list[str] | None = None, now: datetime | None = None) -> Responsibility:
        """A bounded, expiring child responsibility the agent may open while exploring."""
        if actor not in {Origin.AGENT, Origin.USER}:
            raise PermissionDenied("external content cannot open responsibilities")
        if parent.status in TERMINAL_STATUSES:
            raise TransitionError("cannot open a candidate under a completed/archived responsibility")
        if not exploration_budget or "max_units" not in exploration_budget:
            raise ResponsibilityError("a candidate needs a bounded exploration_budget with max_units")
        if ttl_hours <= 0:
            raise ResponsibilityError("a candidate must expire (ttl_hours > 0)")
        limits = self.policy.limits
        if self.candidate_depth(parent) + 1 > limits.max_candidate_depth:
            raise LimitExceeded(f"candidate depth would exceed {limits.max_candidate_depth}")
        open_children = self.session.scalar(select(func.count()).select_from(Responsibility).where(
            Responsibility.parent_id == parent.id, Responsibility.status == S.CANDIDATE)) or 0
        if open_children >= limits.max_open_candidates_per_parent:
            raise LimitExceeded(f"parent already has {open_children} open candidates")
        now = now or utcnow()
        tp = self.policy.tension
        r = Responsibility(user_id=parent.user_id, parent_id=parent.id, title_en=title_en,
                           description_en=description_en, status=S.CANDIDATE, tension=0.0,
                           wake_threshold=tp.default_wake_threshold, sleep_threshold=tp.default_sleep_threshold,
                           compute_budget={"exploration": dict(exploration_budget)},
                           keywords=keywords or [], created_by=actor,
                           promotion_criteria={**DEFAULT_PROMOTION, **(promotion_criteria or {})},
                           candidate_expires_at=now + timedelta(hours=ttl_hours))
        self.session.add(r)
        self.session.flush()
        audit.record(self.session, kind="responsibility.candidate_opened", entity_type="responsibility",
                     entity_id=r.id, actor=actor, user_id=parent.user_id, parent_id=str(parent.id),
                     budget=exploration_budget, expires_at=r.candidate_expires_at.isoformat(),
                     promotion_criteria=r.promotion_criteria)
        return r

    # ---------------------------------------------------------------- transitions

    def transition(self, r: Responsibility, op: str, *, actor: Origin, reason: str = "",
                   now: datetime | None = None, **details: Any) -> Responsibility:
        if op not in OPS:
            raise TransitionError(f"unknown operation {op!r}")
        if actor == Origin.EXTERNAL:
            raise PermissionDenied("external content cannot change responsibilities")
        spec = OPS[op]
        if r.status == S.CANDIDATE and op not in CANDIDATE_OPS:
            raise TransitionError(f"a candidate cannot be {op!r}-ed; it must be promoted first")
        if r.status not in spec.sources:
            raise TransitionError(f"cannot {op} from {r.status.value}")
        if spec.user_only and actor != Origin.USER and r.created_by == Origin.USER:
            raise PermissionDenied(f"only the user can {op} a responsibility they created")
        if op == "wake" and r.paused_by_user:
            raise TransitionError("paused by the user; only the user can unpause it")
        if op == "unpause" and not r.paused_by_user:
            raise TransitionError("not paused by the user")
        if op == "resume" and r.status == S.SLEEPING and r.paused_by_user:
            raise TransitionError("paused by the user; use unpause")

        now = now or utcnow()
        before = r.status
        if op == "promote":
            target = self._check_promotion(r, actor, now)
        elif op in {"resume", "unpause"}:
            target = S.ACTIVE if r.tension >= r.wake_threshold else S.MONITORING
        else:
            assert spec.target is not None
            target = spec.target

        r.status = target
        if op == "promote" and actor == Origin.USER:
            r.created_by = Origin.USER  # the user adopted it: it is now theirs to complete or cancel
            details.setdefault("adopted_by_user", True)
        if op == "pause":
            r.paused_by_user = True
        elif op == "unpause":
            r.paused_by_user = False
        if target in TERMINAL_STATUSES:
            r.stop_reason = reason or op
        r.updated_at = now
        self.session.flush()
        audit.record(self.session, kind="responsibility.transition", entity_type="responsibility",
                     entity_id=r.id, actor=actor, user_id=r.user_id, op=op, from_status=before.value,
                     to_status=target.value, reason=reason, tension=round(r.tension, 4), **details)
        return r

    def _check_promotion(self, r: Responsibility, actor: Origin, now: datetime) -> S:
        crit = {**DEFAULT_PROMOTION, **(r.promotion_criteria or {})}
        failures: list[str] = []
        if r.candidate_expires_at and now > r.candidate_expires_at:
            failures.append("candidate has expired")
        if crit.get("requires_user_approval", True) and actor != Origin.USER:
            failures.append("requires the user's approval")
        if r.useful_outcomes < int(crit.get("min_useful_outcomes", 0)):
            failures.append(f"needs {crit['min_useful_outcomes']} useful outcome(s), has {r.useful_outcomes}")
        if r.tension < float(crit.get("min_tension", 0.0)):
            failures.append(f"tension {r.tension:.2f} below {crit['min_tension']}")
        limit = self.policy.limits.max_perpetual_responsibilities_per_user
        if self.perpetual_count(r.user_id) >= limit:
            failures.append(f"user is at the limit of {limit} perpetual responsibilities")
        if failures:
            raise PromotionError(failures)
        return S.ACTIVE if r.tension >= r.wake_threshold else S.MONITORING

    def record_useful_outcome(self, r: Responsibility, note: str, actor: Origin = Origin.AGENT) -> None:
        r.useful_outcomes += 1
        audit.record(self.session, kind="responsibility.useful_outcome", entity_type="responsibility",
                     entity_id=r.id, actor=actor, user_id=r.user_id, note=note, total=r.useful_outcomes)

    def expire_candidates(self, now: datetime | None = None) -> list[Responsibility]:
        now = now or utcnow()
        expired = list(self.session.scalars(select(Responsibility).where(
            Responsibility.status == S.CANDIDATE, Responsibility.candidate_expires_at < now)))
        for r in expired:
            self.transition(r, "expire", actor=Origin.SYSTEM, now=now,
                            reason="candidate expired without meeting promotion criteria")
        return expired

    def update(self, r: Responsibility, *, actor: Origin, **fields: Any) -> Responsibility:
        """Edit goal-defining fields. Goals belong to the user (invariants 1, 11)."""
        goal_fields = {"title_en", "description_en", "raw_title", "keywords", "priority_bias"}
        tuning_fields = {"wake_threshold", "sleep_threshold", "compute_budget", "tension_policy", "next_review_at"}
        unknown = set(fields) - goal_fields - tuning_fields
        if unknown:
            raise ResponsibilityError(f"cannot update {sorted(unknown)} directly (status changes go through ops)")
        if actor != Origin.USER and (set(fields) & goal_fields) and r.created_by == Origin.USER:
            raise PermissionDenied("only the user can change a goal they set")
        if actor == Origin.EXTERNAL:
            raise PermissionDenied("external content cannot change responsibilities")
        wake = fields.get("wake_threshold", r.wake_threshold)
        sleep = fields.get("sleep_threshold", r.sleep_threshold)
        _check_thresholds(wake, sleep)
        changed = {}
        for k, v in fields.items():
            if getattr(r, k) != v:
                changed[k] = {"from": getattr(r, k), "to": v}
                setattr(r, k, v)
        if changed:
            self.session.flush()
            audit.record(self.session, kind="responsibility.updated", entity_type="responsibility",
                         entity_id=r.id, actor=actor, user_id=r.user_id, changes=changed)
        return r


def _check_thresholds(wake: float, sleep: float) -> None:
    if not (0.0 <= sleep < wake <= 1.0):
        raise ResponsibilityError("thresholds need 0 ≤ sleep_threshold < wake_threshold ≤ 1 (hysteresis)")
