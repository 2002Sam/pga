"""Durable workflow engine (spec §9).

Jobs live in PostgreSQL, so background work survives restarts without extra
infrastructure. Workers claim due jobs with `FOR UPDATE SKIP LOCKED` and hold a
lease; a crashed worker's job is reclaimed once its lease runs out.

Required operations: wake / sleep / pause / resume / cancel are responsibility
transitions (pga.responsibility); this module adds the job-level ones —
retry, wait_for_event, wait_for_user, migrate_version — plus enqueue/claim/finish.

Perpetual work is never `while true: think()`: the only loop is the worker
polling for *due* jobs, and every job is one bounded, budget-checked step.
"""

from __future__ import annotations

import uuid
from collections.abc import Callable
from datetime import datetime, timedelta
from typing import Any

from sqlalchemy import and_, or_, select, update
from sqlalchemy.exc import IntegrityError
from sqlalchemy.orm import Session

from pga import audit
from pga.config import Policy
from pga.db.models import Job
from pga.db.types import ACTIVE_JOB_STATUSES, JobStatus as J, Origin, utcnow


class WorkflowError(RuntimeError):
    pass


class SpawnLimitExceeded(WorkflowError):
    pass


class WorkflowEngine:
    def __init__(self, session: Session, policy: Policy):
        self.session = session
        self.policy = policy
        self.wp = policy.workflow

    # ---------------------------------------------------------------- enqueue

    def enqueue(self, kind: str, *, user_id: uuid.UUID | None = None, responsibility_id: uuid.UUID | None = None,
                payload: dict[str, Any] | None = None, run_at: datetime | None = None, priority: int = 100,
                dedupe_key: str | None = None, max_attempts: int = 3, created_by: Origin = Origin.SYSTEM,
                parent: Job | None = None, now: datetime | None = None) -> Job:
        """Queue a job. With `dedupe_key`, returns the existing live job instead of adding a second one."""
        now = now or utcnow()
        depth = (parent.depth + 1) if parent else 0
        if depth > self.wp.max_spawn_depth:
            raise SpawnLimitExceeded(f"job spawn depth {depth} exceeds {self.wp.max_spawn_depth}")
        if created_by == Origin.EXTERNAL:
            raise WorkflowError("external content cannot schedule work")
        if dedupe_key:
            existing = self.live(dedupe_key)
            if existing is not None:
                return existing
        job = Job(kind=kind, user_id=user_id, responsibility_id=responsibility_id, payload=payload or {},
                  status=J.QUEUED, priority=priority, run_at=run_at or now, max_attempts=max_attempts,
                  dedupe_key=dedupe_key, parent_job_id=parent.id if parent else None, depth=depth,
                  created_by=created_by, created_at=now, updated_at=now)
        try:
            with self.session.begin_nested():
                self.session.add(job)
                self.session.flush()
        except IntegrityError:
            # another worker queued the same key a moment ago
            existing = self.live(dedupe_key) if dedupe_key else None
            if existing is None:
                raise
            return existing
        return job

    def live(self, dedupe_key: str) -> Job | None:
        return self.session.scalar(select(Job).where(Job.dedupe_key == dedupe_key,
                                                     Job.status.in_(ACTIVE_JOB_STATUSES)))

    # ---------------------------------------------------------------- claim / finish

    def claim(self, worker_id: str, *, limit: int = 1, now: datetime | None = None,
              kinds: set[str] | None = None) -> list[Job]:
        """Lease up to `limit` due jobs. Expired leases (crashed workers) are reclaimed."""
        now = now or utcnow()
        due = or_(and_(Job.status == J.QUEUED, Job.run_at <= now),
                  and_(Job.status == J.RUNNING, Job.lease_until < now))
        q = select(Job).where(due)
        if kinds:
            q = q.where(Job.kind.in_(kinds))
        jobs = list(self.session.scalars(q.order_by(Job.priority, Job.run_at).limit(limit)
                                         .with_for_update(skip_locked=True)))
        for job in jobs:
            job.status = J.RUNNING
            job.attempts += 1
            job.lease_owner = worker_id
            job.lease_until = now + timedelta(seconds=self.wp.lease_seconds)
            job.updated_at = now
        self.session.flush()
        return jobs

    def complete(self, job: Job, result: dict[str, Any] | None = None, now: datetime | None = None) -> Job:
        now = now or utcnow()
        job.status = J.SUCCEEDED
        job.result = _jsonable(result or {})
        job.lease_owner = job.lease_until = None
        job.finished_at = job.updated_at = now
        self.session.flush()
        return job

    def defer(self, job: Job, until: datetime, reason: str, now: datetime | None = None) -> Job:
        """Not an error: the allocator said 'not now'. Re-queue without spending an attempt."""
        now = now or utcnow()
        job.status = J.QUEUED
        job.attempts = max(0, job.attempts - 1)
        job.run_at = until
        job.result = {"deferred": reason}
        job.lease_owner = job.lease_until = None
        job.updated_at = now
        self.session.flush()
        return job

    def fail(self, job: Job, error: str, now: datetime | None = None, *, permanent: bool = False) -> Job:
        now = now or utcnow()
        job.last_error = error[:4000]
        job.lease_owner = job.lease_until = None
        job.updated_at = now
        if permanent or job.attempts >= job.max_attempts:
            job.status = J.FAILED
            job.finished_at = now
            audit.record(self.session, kind="job.failed", entity_type="job", entity_id=job.id,
                         actor=Origin.SYSTEM, user_id=job.user_id, job_kind=job.kind, error=job.last_error[:500],
                         attempts=job.attempts)
        else:
            backoff = self.wp.retry_backoff_seconds
            delay = backoff[min(job.attempts - 1, len(backoff) - 1)] if backoff else 60
            job.status = J.QUEUED
            job.run_at = now + timedelta(seconds=delay)
        self.session.flush()
        return job

    # ---------------------------------------------------------------- spec §9 operations

    def cancel(self, job_id: uuid.UUID, *, actor: Origin, reason: str = "") -> Job:
        job = self._get(job_id)
        if job.status not in ACTIVE_JOB_STATUSES:
            raise WorkflowError(f"job is {job.status.value}")
        job.status = J.CANCELLED
        job.finished_at = utcnow()
        job.lease_owner = job.lease_until = None
        audit.record(self.session, kind="job.cancelled", entity_type="job", entity_id=job.id, actor=actor,
                     user_id=job.user_id, reason=reason)
        self.session.flush()
        return job

    def cancel_for_responsibility(self, responsibility_id: uuid.UUID, *, actor: Origin, reason: str) -> int:
        jobs = list(self.session.scalars(select(Job).where(Job.responsibility_id == responsibility_id,
                                                           Job.status.in_({J.QUEUED, J.WAITING}))))
        for job in jobs:
            self.cancel(job.id, actor=actor, reason=reason)
        return len(jobs)

    def retry(self, job_id: uuid.UUID, *, actor: Origin, now: datetime | None = None) -> Job:
        job = self._get(job_id)
        if job.status not in {J.FAILED, J.CANCELLED}:
            raise WorkflowError(f"only failed or cancelled jobs can be retried (job is {job.status.value})")
        if job.dedupe_key and self.live(job.dedupe_key) is not None:
            raise WorkflowError("an equivalent job is already queued")
        now = now or utcnow()
        job.status = J.QUEUED
        job.attempts = 0
        job.run_at = now
        job.finished_at = None
        audit.record(self.session, kind="job.retried", entity_type="job", entity_id=job.id, actor=actor,
                     user_id=job.user_id)
        self.session.flush()
        return job

    def wait_for_event(self, job: Job, key: str, *, timeout: timedelta | None = None,
                       now: datetime | None = None) -> Job:
        now = now or utcnow()
        job.status = J.WAITING
        job.wait_for = f"event:{key}"
        job.wait_until = now + timeout if timeout else None
        job.lease_owner = job.lease_until = None
        job.attempts = max(0, job.attempts - 1)
        job.updated_at = now
        self.session.flush()
        return job

    def wait_for_user(self, job: Job, *, timeout: timedelta | None = None, now: datetime | None = None) -> Job:
        now = now or utcnow()
        job.status = J.WAITING
        job.wait_for = "user"
        job.wait_until = now + timeout if timeout else None
        job.lease_owner = job.lease_until = None
        job.attempts = max(0, job.attempts - 1)
        job.updated_at = now
        self.session.flush()
        return job

    def signal_event(self, key: str, data: dict[str, Any] | None = None, now: datetime | None = None) -> int:
        return self._release(Job.wait_for == f"event:{key}", {"event": key, "data": data or {}}, now)

    def signal_user(self, user_id: uuid.UUID, data: dict[str, Any] | None = None,
                    responsibility_id: uuid.UUID | None = None, now: datetime | None = None) -> int:
        cond = and_(Job.wait_for == "user", Job.user_id == user_id)
        if responsibility_id:
            cond = and_(cond, Job.responsibility_id == responsibility_id)
        return self._release(cond, {"user": data or {}}, now)

    def expire_waits(self, now: datetime | None = None) -> int:
        now = now or utcnow()
        return self._release(and_(Job.wait_until.is_not(None), Job.wait_until <= now), {"timed_out": True}, now)

    def _release(self, cond, signal: dict[str, Any], now: datetime | None) -> int:
        now = now or utcnow()
        jobs = list(self.session.scalars(select(Job).where(Job.status == J.WAITING, cond).with_for_update()))
        for job in jobs:
            job.status = J.QUEUED
            job.run_at = now
            job.payload = {**job.payload, "signal": _jsonable(signal)}
            job.wait_for = job.wait_until = None
            job.updated_at = now
        self.session.flush()
        return len(jobs)

    def migrate_version(self, kind: str, to_version: int,
                        transform: Callable[[dict[str, Any]], dict[str, Any]] | None = None) -> int:
        """Move not-yet-finished jobs of `kind` onto a new workflow version (payload transformed)."""
        jobs = list(self.session.scalars(select(Job).where(
            Job.kind == kind, Job.status.in_({J.QUEUED, J.WAITING}), Job.workflow_version < to_version)
            .with_for_update()))
        for job in jobs:
            if transform:
                job.payload = transform(dict(job.payload))
            job.workflow_version = to_version
        if jobs:
            audit.record(self.session, kind="job.migrated", entity_type="job_kind", entity_id=None,
                         actor=Origin.SYSTEM, job_kind=kind, to_version=to_version, count=len(jobs))
        self.session.flush()
        return len(jobs)

    def heartbeat_lease(self, job: Job, now: datetime | None = None) -> None:
        """Long steps call this to keep their lease."""
        now = now or utcnow()
        self.session.execute(update(Job).where(Job.id == job.id).values(
            lease_until=now + timedelta(seconds=self.wp.lease_seconds)))

    def _get(self, job_id: uuid.UUID) -> Job:
        job = self.session.get(Job, job_id)
        if job is None:
            raise WorkflowError("job not found")
        return job


def _jsonable(v: Any) -> Any:
    import json

    return json.loads(json.dumps(v, default=str))
