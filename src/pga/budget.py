"""Budget ledger and premium quota accounting (spec §6, §8).

Every model call is recorded once as a UsageRecord, tagged with the budget
category it is billed to and (for premium tiers) the provider quota window it
consumes. The allocator reads these to decide what may run next.
"""

from __future__ import annotations

import uuid
from dataclasses import dataclass
from datetime import datetime, timedelta

from sqlalchemy import func, select
from sqlalchemy.orm import Session

from pga import audit
from pga.config import Policy, QuotaPolicy
from pga.db.models import QuotaState, Run, UsageRecord
from pga.db.types import Origin, utcnow
from pga.llm import LLMResult, UsageContext


@dataclass
class QuotaSnapshot:
    key: str
    provider: str
    capacity: float
    used: float
    used_proactive: float
    remaining: float
    reserve: float               # units held back for user interaction / urgent work
    proactive_cap: float         # proactive target (e.g. 70% of capacity)
    window_start: datetime | None
    reset_time: datetime | None
    provider_observed: bool

    @property
    def proactive_headroom(self) -> float:
        """Units proactive work may still spend: below its target AND never into the reserve."""
        return max(0.0, min(self.proactive_cap - self.used_proactive, self.remaining - self.reserve))

    def as_dict(self) -> dict:
        return {
            "key": self.key, "provider": self.provider, "capacity": self.capacity, "used": round(self.used, 1),
            "used_proactive": round(self.used_proactive, 1), "remaining": round(self.remaining, 1),
            "reserve": self.reserve, "proactive_cap": self.proactive_cap,
            "proactive_headroom": round(self.proactive_headroom, 1),
            "window_start": self.window_start.isoformat() if self.window_start else None,
            "reset_time": self.reset_time.isoformat() if self.reset_time else None,
            "provider_observed": self.provider_observed,
        }


class BudgetLedger:
    def __init__(self, session: Session, policy: Policy, provider: str):
        self.session = session
        self.policy = policy
        self.provider = provider

    # ---------------------------------------------------------------- recording (LLM usage sink)

    def units_for(self, tier: int, input_tokens: int, output_tokens: int) -> float:
        return self.policy.llm.cost_units(tier, input_tokens, output_tokens)

    def record_llm(self, result: LLMResult, ctx: UsageContext, responsibility_id: uuid.UUID | None = None,
                   now: datetime | None = None) -> UsageRecord:
        return self.record(tier=result.tier, model=result.model, provider=result.provider,
                           input_tokens=result.input_tokens, output_tokens=result.output_tokens,
                           ctx=ctx, responsibility_id=responsibility_id, now=now)

    def record(self, *, tier: int, model: str | None, provider: str, input_tokens: int, output_tokens: int,
               ctx: UsageContext, responsibility_id: uuid.UUID | None = None,
               now: datetime | None = None) -> UsageRecord:
        now = now or utcnow()
        if responsibility_id is None and ctx.run_id:
            run = self.session.get(Run, ctx.run_id)
            responsibility_id = run.responsibility_id if run else None
        q = self.quota_policy(tier, provider)
        if q:
            self._touch_window(q, now)
        rec = UsageRecord(user_id=ctx.user_id, run_id=ctx.run_id, responsibility_id=responsibility_id,
                          provider=provider, model=model, tier=tier, input_tokens=input_tokens,
                          output_tokens=output_tokens, units=self.units_for(tier, input_tokens, output_tokens),
                          category=ctx.category, exploration_scope=ctx.exploration_scope,
                          quota_key=q.key if q else None, proactive=ctx.proactive, created_at=now)
        self.session.add(rec)
        self.session.flush()
        return rec

    def sink(self, responsibility_id: uuid.UUID | None = None):
        """Adapter for LLMRouter(usage_sink=...)."""
        return lambda result, ctx: self.record_llm(result, ctx, responsibility_id)

    # ---------------------------------------------------------------- budget categories

    def period_start(self, now: datetime) -> datetime:
        return now - timedelta(hours=self.policy.budget.period_hours)

    def category_cap(self, category: str) -> float:
        return self.policy.budget.shares.get(category, 0.0) * self.policy.budget.total_units

    def spend(self, user_id: uuid.UUID, *, category: str | None = None, exploration_scope: str | None = None,
              responsibility_id: uuid.UUID | None = None, since: datetime | None = None,
              now: datetime | None = None) -> float:
        now = now or utcnow()
        q = select(func.coalesce(func.sum(UsageRecord.units), 0.0)).where(UsageRecord.user_id == user_id)
        if responsibility_id is None or since is not None:
            q = q.where(UsageRecord.created_at >= (since or self.period_start(now)))
        if category:
            q = q.where(UsageRecord.category == category)
        if exploration_scope:
            q = q.where(UsageRecord.exploration_scope == exploration_scope)
        if responsibility_id:
            q = q.where(UsageRecord.responsibility_id == responsibility_id)
        return float(self.session.scalar(q) or 0.0)

    def unspent_proactive(self, user_id: uuid.UUID, now: datetime | None = None) -> float:
        total = 0.0
        for cat in self.policy.budget.shares:
            if cat in {"user_reserve", "free_exploration"}:
                continue  # exploration is strictly bounded and never lends its budget
            total += max(0.0, self.category_cap(cat) - self.spend(user_id, category=cat, now=now))
        return total

    def budget_frees_at(self, user_id: uuid.UUID, category: str, now: datetime) -> datetime:
        oldest = self.session.scalar(select(func.min(UsageRecord.created_at)).where(
            UsageRecord.user_id == user_id, UsageRecord.category == category,
            UsageRecord.created_at >= self.period_start(now)))
        return (oldest + timedelta(hours=self.policy.budget.period_hours)) if oldest else now

    def summary(self, user_id: uuid.UUID, now: datetime | None = None) -> dict:
        now = now or utcnow()
        out = {}
        for cat, share in self.policy.budget.shares.items():
            cap = share * self.policy.budget.total_units
            used = self.spend(user_id, category=cat, now=now)
            out[cat] = {"cap": cap, "used": round(used, 1), "remaining": round(max(0.0, cap - used), 1)}
        return {"period_hours": self.policy.budget.period_hours, "categories": out}

    # ---------------------------------------------------------------- premium quota

    def quota_policy(self, tier: int, provider: str | None = None) -> QuotaPolicy | None:
        q = self.policy.quota_for_tier(tier)
        if q is None or (provider and q.provider != provider and provider != "fake"):
            return None
        return q

    def _state(self, q: QuotaPolicy) -> QuotaState:
        st = self.session.get(QuotaState, q.key)
        if st is None:
            st = QuotaState(quota_key=q.key, provider=q.provider, quota_window_seconds=q.window_seconds,
                            capacity_units=q.capacity_units, reserved_capacity=q.capacity_units * q.reserve_ratio)
            self.session.add(st)
            self.session.flush()
        else:
            # policy is the source of truth for configured numbers
            st.quota_window_seconds = q.window_seconds
            st.capacity_units = q.capacity_units
            st.reserved_capacity = q.capacity_units * q.reserve_ratio
        return st

    def _touch_window(self, q: QuotaPolicy, now: datetime) -> None:
        if q.window_mode != "fixed":
            return
        st = self._state(q)
        if st.window_start is None or st.reset_time is None or now >= st.reset_time:
            st.window_start = now
            st.reset_time = now + timedelta(seconds=q.window_seconds)

    def quota(self, q: QuotaPolicy, now: datetime | None = None) -> QuotaSnapshot:
        now = now or utcnow()
        st = self._state(q)
        if q.window_mode == "fixed":
            if st.window_start is None or st.reset_time is None or now >= st.reset_time:
                start, reset = None, None  # no open window: the next premium call opens one
            else:
                start, reset = st.window_start, st.reset_time
        else:
            start = now - timedelta(seconds=q.window_seconds)
            oldest = self.session.scalar(select(func.min(UsageRecord.created_at)).where(
                UsageRecord.quota_key == q.key, UsageRecord.created_at >= start))
            reset = oldest + timedelta(seconds=q.window_seconds) if oldest else None

        used = used_pro = 0.0
        if start is not None:
            row = self.session.execute(select(
                func.coalesce(func.sum(UsageRecord.units), 0.0),
                func.coalesce(func.sum(UsageRecord.units).filter(UsageRecord.proactive.is_(True)), 0.0),
            ).where(UsageRecord.quota_key == q.key, UsageRecord.created_at >= start)).one()
            used, used_pro = float(row[0]), float(row[1])
        remaining = q.capacity_units - used
        observed = False
        if st.remaining_estimate is not None and st.observed_at is not None and (start is None or st.observed_at >= start):
            since_obs = float(self.session.scalar(select(func.coalesce(func.sum(UsageRecord.units), 0.0)).where(
                UsageRecord.quota_key == q.key, UsageRecord.created_at > st.observed_at)) or 0.0)
            remaining = min(remaining, st.remaining_estimate - since_obs)
            observed = True
        return QuotaSnapshot(key=q.key, provider=q.provider, capacity=q.capacity_units, used=used,
                             used_proactive=used_pro, remaining=max(0.0, remaining),
                             reserve=q.capacity_units * q.reserve_ratio,
                             proactive_cap=q.capacity_units * q.proactive_target_ratio,
                             window_start=start, reset_time=reset, provider_observed=observed)

    def observe_provider(self, quota_key: str, *, remaining: float, reset_time: datetime | None = None,
                         now: datetime | None = None) -> QuotaSnapshot:
        """Fold in what the provider reports (headers, dashboard) — it beats our own estimate."""
        now = now or utcnow()
        q = next((x for x in self.policy.quotas if x.key == quota_key), None)
        if q is None:
            raise KeyError(f"unknown quota {quota_key!r}")
        st = self._state(q)
        st.remaining_estimate = float(remaining)
        st.observed_at = now
        if reset_time is not None:
            st.reset_time = reset_time
            st.window_start = reset_time - timedelta(seconds=q.window_seconds)
        audit.record(self.session, kind="quota.observed", entity_type="quota", entity_id=None,
                     actor=Origin.SYSTEM, quota_key=quota_key, remaining=remaining,
                     reset_time=reset_time.isoformat() if reset_time else None)
        self.session.flush()
        return self.quota(q, now)
