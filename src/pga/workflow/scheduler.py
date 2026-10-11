"""The heartbeat: deterministic (tier 0) planning that turns state into bounded jobs.

Every few minutes, per user:

    tick tension (decay, wake/sleep, expiries) → release timed-out waits
    → deliver held notifications → queue polls for due sources
    → queue a research step for each awake responsibility (respecting a cooldown)
    → queue bounded exploration when it is due

The heartbeat itself never calls a model. Everything it queues is checked by
the allocator when it runs, so "attentive" costs almost nothing and "working"
only happens when tension and budget both say so.
"""

from __future__ import annotations

import uuid
from collections.abc import Callable
from datetime import datetime, timedelta
from typing import TYPE_CHECKING

from sqlalchemy import select

from pga.db.models import Job, Responsibility, Run, User
from pga.db.types import JobStatus, Origin, ResponsibilityStatus as S, RunStatus, utcnow

if TYPE_CHECKING:
    from pga.runtime import Runtime

# Extra planners added by later phases (skills, artifacts): fn(rt, user, now) -> list of job descriptions.
Planner = Callable[["Runtime", User, datetime], list[dict]]
EXTRA_PLANNERS: list[Planner] = []


def register_planner(fn: Planner) -> Planner:
    EXTRA_PLANNERS.append(fn)
    return fn


def last_run_at(rt: "Runtime", user_id: uuid.UUID, kind: str, responsibility_id: uuid.UUID | None = None):
    q = select(Run.started_at).where(Run.user_id == user_id, Run.kind == kind,
                                     Run.status.in_([RunStatus.SUCCEEDED, RunStatus.BUDGET_EXCEEDED]))
    if responsibility_id:
        q = q.where(Run.responsibility_id == responsibility_id)
    return rt.session.scalar(q.order_by(Run.started_at.desc()).limit(1))


def heartbeat(rt: "Runtime", user: User, now: datetime | None = None) -> dict:
    now = now or utcnow()
    wp = rt.policy.workflow
    report: dict = {"tick": rt.tension.tick(user.id, now), "queued": []}
    report["released_waits"] = rt.workflow.expire_waits(now)
    report["delivered"] = rt.notify.deliver_due(user, now)

    def queue(kind: str, key: str, **kw) -> None:
        if len(report["queued"]) >= wp.max_jobs_per_heartbeat:
            return
        job = rt.workflow.enqueue(kind, user_id=user.id, dedupe_key=key, created_by=Origin.SYSTEM, now=now, **kw)
        if job.created_at == now:
            report["queued"].append({"kind": kind, "key": key})

    for s in rt.sources.due(user.id, now):
        queue("source.poll", f"poll:{s.id}", payload={"source_id": str(s.id)}, priority=50)

    research = rt_research_agent(rt)
    cooldown = timedelta(hours=wp.research_cooldown_hours)
    for r in rt.responsibilities.list(user.id):
        if r.paused_by_user:
            continue
        if r.status == S.WAIT_EXTERNAL and research.pending_events(r, 1):
            # the world moved: something new arrived while we were waiting for it
            rt.responsibilities.transition(r, "resume", actor=Origin.SYSTEM, now=now,
                                           reason="new external information arrived")
        if r.status not in {S.ACTIVE, S.CANDIDATE}:
            continue
        if r.status == S.CANDIDATE and not research.pending_events(r, 1):
            continue
        last = last_run_at(rt, user.id, "synthesis", r.id)
        if last is None or now - last >= cooldown:
            queue("responsibility.research", f"research:{r.id}", responsibility_id=r.id, priority=80)

    last_explore = last_run_at(rt, user.id, "exploration")
    if last_explore is None or now - last_explore >= timedelta(hours=wp.exploration_every_hours):
        queue("exploration.run", f"explore:{user.id}", priority=150)

    for planner in EXTRA_PLANNERS:
        for spec in planner(rt, user, now):
            spec = dict(spec)
            queue(spec.pop("kind"), spec.pop("key"), **spec)
    return report


def ensure_heartbeats(rt: "Runtime", now: datetime | None = None) -> int:
    """Make sure every user has exactly one upcoming heartbeat job."""
    now = now or utcnow()
    every = timedelta(minutes=rt.policy.workflow.heartbeat_minutes)
    n = 0
    for user in rt.session.scalars(select(User)):
        key = f"heartbeat:{user.id}"
        if rt.workflow.live(key) is not None:
            continue
        last = rt.session.scalar(select(Job.finished_at).where(
            Job.kind == "user.heartbeat", Job.user_id == user.id, Job.status == JobStatus.SUCCEEDED)
            .order_by(Job.finished_at.desc()).limit(1))
        run_at = max(now, last + every) if last else now
        rt.workflow.enqueue("user.heartbeat", user_id=user.id, dedupe_key=key, run_at=run_at, priority=10,
                            max_attempts=1, now=now)
        n += 1
    return n


def rt_research_agent(rt: "Runtime"):
    from pga.agent.research import ResearchAgent

    return ResearchAgent(rt)


def responsibility_of(rt: "Runtime", job: Job) -> Responsibility | None:
    return rt.session.get(Responsibility, job.responsibility_id) if job.responsibility_id else None
