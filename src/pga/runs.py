"""Run audit log and runtime guard (spec §20, §21).

Every approved allocation becomes a Run with its why_now / expected_gain /
decision_affected / budget / stop_condition, tension before and after, model,
tokens, cost, tools, evidence/belief/artifact changes and stop reason.
The RunGuard enforces the allocation's limits while the run executes: timeout,
tool-call budget and cost budget — no runaway loops.
"""

from __future__ import annotations

import time
import uuid
from collections.abc import Iterator
from contextlib import contextmanager
from datetime import datetime
from typing import Any

from sqlalchemy import func, select
from sqlalchemy.orm import Session

from pga import audit
from pga.allocator import AllocationDecision
from pga.budget import BudgetLedger
from pga.db.models import Responsibility, Run, UsageRecord
from pga.db.types import Origin, RunStatus, utcnow
from pga.llm import UsageContext


class RunBudgetExceeded(RuntimeError):
    def __init__(self, status: RunStatus, message: str):
        super().__init__(message)
        self.status = status


class RunNotAllowed(RuntimeError):
    pass


class RunGuard:
    def __init__(self, session: Session, run: Run, limits: dict[str, Any], now: datetime | None = None):
        self.session = session
        self.now = now
        self.run = run
        self.limits = limits
        self._t0 = time.monotonic()
        self.stop_reason: str | None = None
        self.new_evidence: list[str] = []
        self.belief_changes: list[dict] = []
        self.artifact_changes: list[dict] = []
        self.user_notified = False

    def usage_context(self) -> UsageContext:
        return UsageContext(category=self.run.category, proactive=self.run.proactive, user_id=self.run.user_id,
                            run_id=self.run.id, exploration_scope=self.run.exploration_scope,
                            now=self.now)

    def units_used(self) -> float:
        return float(self.session.scalar(select(func.coalesce(func.sum(UsageRecord.units), 0.0)).where(
            UsageRecord.run_id == self.run.id)) or 0.0)

    def check(self) -> None:
        """Call between steps. Raises when the run is over its time or cost budget."""
        timeout = self.limits.get("timeout_s")
        if timeout and time.monotonic() - self._t0 > timeout:
            raise RunBudgetExceeded(RunStatus.TIMEOUT, f"run exceeded {timeout}s")
        max_units = self.limits.get("max_units")
        if max_units is not None and self.units_used() > float(max_units):
            raise RunBudgetExceeded(RunStatus.BUDGET_EXCEEDED, f"run spent more than {max_units} units")

    def tool_call(self, name: str, **summary: Any) -> None:
        max_calls = self.limits.get("max_tool_calls")
        if max_calls is not None and len(self.run.tools) >= int(max_calls):
            raise RunBudgetExceeded(RunStatus.BUDGET_EXCEEDED, f"tool budget of {max_calls} calls exhausted")
        self.run.tools = [*self.run.tools, {"name": name, "at": utcnow().isoformat(), **summary}]
        self.check()

    def stop(self, reason: str) -> None:
        self.stop_reason = reason


class RunService:
    def __init__(self, session: Session, ledger: BudgetLedger):
        self.session = session
        self.ledger = ledger

    def start(self, decision: AllocationDecision, now: datetime | None = None) -> Run:
        if not decision.allowed:
            raise RunNotAllowed(f"allocation {decision.outcome.value}: {'; '.join(decision.reasons)}")
        if decision.user_id is None:
            raise RunNotAllowed("allocation has no user")
        r = self.session.get(Responsibility, decision.responsibility_id) if decision.responsibility_id else None
        j = decision.justification
        run = Run(user_id=decision.user_id, responsibility_id=decision.responsibility_id, allocation_id=decision.id,
                  kind=decision.kind, category=decision.category, exploration_scope=decision.exploration_scope,
                  proactive=decision.proactive, status=RunStatus.RUNNING, why_now=j.get("why_now"),
                  expected_gain=j.get("expected_gain"), decision_affected=j.get("decision_affected"),
                  budget={"requested": j.get("budget"), "granted": decision.limits},
                  stop_condition=j.get("stop_condition"), tension_before=r.tension if r else None,
                  provider=self.ledger.provider if decision.tier else None, model=decision.model,
                  tier=decision.tier, tools=[], started_at=now or utcnow())
        self.session.add(run)
        self.session.flush()
        return run

    def finish(self, run: Run, *, status: RunStatus = RunStatus.SUCCEEDED, stop_reason: str | None = None,
               new_evidence: list[str] | None = None, belief_changes: list[dict] | None = None,
               artifact_changes: list[dict] | None = None, user_notified: bool = False,
               error: str | None = None, now: datetime | None = None) -> Run:
        totals = self.session.execute(select(
            func.coalesce(func.sum(UsageRecord.input_tokens), 0), func.coalesce(func.sum(UsageRecord.output_tokens), 0),
            func.coalesce(func.sum(UsageRecord.units), 0.0)).where(UsageRecord.run_id == run.id)).one()
        run.input_tokens, run.output_tokens, run.cost_units = int(totals[0]), int(totals[1]), float(totals[2])
        r = self.session.get(Responsibility, run.responsibility_id) if run.responsibility_id else None
        run.tension_after = r.tension if r else None
        run.status = status
        run.stop_reason = stop_reason or ("completed" if status == RunStatus.SUCCEEDED else status.value.lower())
        run.new_evidence = list(new_evidence or [])
        run.belief_changes = list(belief_changes or [])
        run.artifact_changes = list(artifact_changes or [])
        run.user_notified = user_notified
        run.error = error
        run.ended_at = now or utcnow()
        self.session.flush()
        audit.record(self.session, kind="run.finished", entity_type="run", entity_id=run.id,
                     actor=Origin.AGENT, user_id=run.user_id, status=status.value, stop_reason=run.stop_reason,
                     cost_units=round(run.cost_units, 2), model=run.model)
        return run

    @contextmanager
    def track(self, decision: AllocationDecision, now: datetime | None = None) -> Iterator[RunGuard]:
        """`with runs.track(decision) as guard:` — starts, guards and always closes the run record."""
        run = self.start(decision, now)
        guard = RunGuard(self.session, run, decision.limits, now)
        from pga.llm.router import CURRENT_TASK
        task = CURRENT_TASK.set(decision.kind)                  # lets the agent router see what kind of work this is
        try:
            yield guard
        except RunBudgetExceeded as exc:
            self._close(guard, exc.status, str(exc), error=None)
            raise
        except Exception as exc:
            self._close(guard, RunStatus.FAILED, "error", error=f"{type(exc).__name__}: {exc}")
            raise
        else:
            reason = guard.stop_reason or "completed"
            max_units = guard.limits.get("max_units")
            used = guard.units_used()
            if max_units is not None and used > float(max_units):
                # the work finished; flag the overspend for review instead of discarding the result
                reason += f" (over budget: {used:.0f} > {float(max_units):.0f} units)"
            self._close(guard, RunStatus.SUCCEEDED, reason)
        finally:
            CURRENT_TASK.reset(task)

    def _close(self, guard: RunGuard, status: RunStatus, reason: str, error: str | None = None) -> None:
        self.finish(guard.run, status=status, stop_reason=reason, new_evidence=guard.new_evidence,
                    belief_changes=guard.belief_changes, artifact_changes=guard.artifact_changes,
                    user_notified=guard.user_notified, error=error)

    def record_user_response(self, run_id: uuid.UUID, response: str) -> Run:
        run = self.session.get(Run, run_id)
        if run is None:
            raise KeyError("run not found")
        run.user_response = response
        audit.record(self.session, kind="run.user_response", entity_type="run", entity_id=run.id,
                     actor=Origin.USER, user_id=run.user_id, response=response[:500])
        self.session.flush()
        return run
