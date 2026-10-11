"""Internal telemetry: the agent observed as an environment (spec §5).

Every signal is computed from records the system already keeps (runs, jobs, usage, notifications), over a
rolling window, together with its sample size — a rate over three runs is not evidence of anything.
"""

from __future__ import annotations

import uuid
from dataclasses import dataclass
from datetime import datetime, timedelta

from sqlalchemy import func, select, true
from sqlalchemy.orm import Session

from pga.db.models import Job, Notification, Run, UsageRecord
from pga.db.types import JobStatus, NotificationStatus, RunStatus


@dataclass(frozen=True)
class Signal:
    key: str
    label_zh: str
    weight: float          # how much a fully bad value may raise R0 tension
    good: float            # at or better than this: no pressure
    bad: float             # at or worse than this: full pressure
    min_n: int             # fewer samples than this: no opinion
    higher_is_bad: bool = True

    def severity(self, value: float | None, n: int) -> float:
        if value is None or n < self.min_n:
            return 0.0
        span = (self.bad - self.good) or 1e-9
        x = (value - self.good) / span if self.higher_is_bad else (self.good - value) / (self.good - self.bad or 1e-9)
        return max(0.0, min(1.0, x))


SIGNALS: dict[str, Signal] = {s.key: s for s in [
    Signal("run_failure_rate", "运行失败率", 1.0, .10, .40, 5),
    Signal("job_failure_rate", "后台任务失败率", .8, .10, .40, 5),
    Signal("duplicate_research_rate", "重复研究率（研究后判断没有变化）", .9, .40, .80, 4),
    Signal("notification_ignored_rate", "通知被忽略率", .6, .40, .80, 4),
    Signal("exploration_hit_rate", "自由探索命中率", .5, .50, .10, 4, higher_is_bad=False),
    Signal("premium_share", "高价模型占比", .5, .50, .85, 1),
    Signal("synthesis_latency_s", "研究平均耗时（秒）", .4, 60, 240, 4),
]}


def compute(session: Session, user_id: uuid.UUID | None, now: datetime, window_days: float = 7) -> dict:
    """{signal: {"value": float|None, "n": int}} plus raw counts over the window — for one user, or (user_id=None)
    for the whole installation: the code R0 improves is shared by every user."""
    mine = (lambda col: col == user_id) if user_id else (lambda col: true())  # noqa: E731
    since = now - timedelta(days=window_days)
    runs = list(session.scalars(select(Run).where(mine(Run.user_id), Run.started_at >= since)))
    finished = [r for r in runs if r.status != RunStatus.RUNNING]
    failed = [r for r in finished if r.status in (RunStatus.FAILED, RunStatus.TIMEOUT)]
    synth = [r for r in finished if r.kind == "synthesis" and r.status == RunStatus.SUCCEEDED]
    no_change = [r for r in synth if not r.belief_changes]
    lat = [(r.ended_at - r.started_at).total_seconds() for r in synth if r.ended_at]
    explore = [r for r in finished if r.kind == "exploration" and r.status == RunStatus.SUCCEEDED]
    hits = [r for r in explore if r.new_evidence]

    jobs = list(session.execute(select(Job.status).where(mine(Job.user_id), Job.finished_at >= since,
                                                        Job.status.in_([JobStatus.SUCCEEDED, JobStatus.FAILED]))).scalars())
    job_failed = sum(1 for s in jobs if s == JobStatus.FAILED)

    notes = list(session.scalars(select(Notification.status).where(
        mine(Notification.user_id), Notification.created_at >= since,
        Notification.status.in_([NotificationStatus.DELIVERED, NotificationStatus.READ, NotificationStatus.ANSWERED,
                                 NotificationStatus.DISMISSED]))))
    ignored = sum(1 for s in notes if s in (NotificationStatus.DISMISSED, NotificationStatus.DELIVERED))

    total_units = session.scalar(select(func.coalesce(func.sum(UsageRecord.units), 0.0)).where(
        mine(UsageRecord.user_id), UsageRecord.created_at >= since)) or 0.0
    premium_units = session.scalar(select(func.coalesce(func.sum(UsageRecord.units), 0.0)).where(
        mine(UsageRecord.user_id), UsageRecord.created_at >= since, UsageRecord.tier >= 3)) or 0.0

    rate = lambda a, b: (a / b) if b else None  # noqa: E731
    return {
        "run_failure_rate": {"value": rate(len(failed), len(finished)), "n": len(finished)},
        "job_failure_rate": {"value": rate(job_failed, len(jobs)), "n": len(jobs)},
        "duplicate_research_rate": {"value": rate(len(no_change), len(synth)), "n": len(synth)},
        "notification_ignored_rate": {"value": rate(ignored, len(notes)), "n": len(notes)},
        "exploration_hit_rate": {"value": rate(len(hits), len(explore)), "n": len(explore)},
        "premium_share": {"value": rate(premium_units, total_units), "n": 1 if total_units else 0},
        "synthesis_latency_s": {"value": (sum(lat) / len(lat)) if lat else None, "n": len(lat)},
        "_counts": {"runs": len(finished), "failed_runs": len(failed), "units": round(total_units, 1),
                    "premium_units": round(premium_units, 1), "window_days": window_days},
    }


def recent_failures(session: Session, user_id: uuid.UUID | None, now: datetime, window_days: float = 7, limit: int = 12) -> list[dict]:
    mine = (lambda col: col == user_id) if user_id else (lambda col: true())  # noqa: E731
    since = now - timedelta(days=window_days)
    rows = session.scalars(select(Run).where(mine(Run.user_id), Run.started_at >= since,
                                             Run.status.in_([RunStatus.FAILED, RunStatus.TIMEOUT]))
                           .order_by(Run.started_at.desc()).limit(limit))
    out = [{"kind": r.kind, "error": (r.error or r.stop_reason or "")[:300], "at": r.started_at.isoformat()} for r in rows]
    jobs = session.scalars(select(Job).where(mine(Job.user_id), Job.finished_at >= since, Job.status == JobStatus.FAILED)
                           .order_by(Job.finished_at.desc()).limit(limit))
    out += [{"kind": f"job:{j.kind}", "error": str(getattr(j, "last_error", "") or "")[:300], "at": j.finished_at.isoformat()} for j in jobs]
    return out
