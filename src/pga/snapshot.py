"""Snapshots, so a perpetual agent can stop (cleanly or not) and pick up where it was.

Everything PGA knows lives in Postgres, so a snapshot is not a copy of the data: it is a manifest of what was in
flight — running and queued jobs, open runs, R0, open evolution rounds, the code version — written

    start       when the worker comes up
    periodic    every `workflow.snapshot_every_minutes` (so even a crash or a killed process leaves a recent one)
    shutdown    when PGA is stopped cleanly (the jobs this worker held are handed back to the queue)
    recovered   after the start-up recovery, with a report of what was resumed

Recovery (`recover`) runs before the worker takes any job: jobs held by a process that no longer exists go back to
the queue at once (instead of waiting for their lease to expire), runs and agent runs left RUNNING by the dead
process are closed as interrupted, and the report says how long PGA was down and what it resumed. Overdue
heartbeats then run immediately; R0 and tension decay already account for the time that passed.

Each snapshot is also written to ~/Documents/PGA/snapshots/ (latest.json plus a timestamped file) to read by eye.
"""

from __future__ import annotations

import json
import logging
import os
import socket
import subprocess
from datetime import datetime, timedelta
from pathlib import Path
from typing import Any

from sqlalchemy import func, select
from sqlalchemy.orm import Session

from pga.db.models import AgentRun, EvolutionRound, Job, R0State, Run, Snapshot
from pga.db.types import JobStatus, RunStatus, utcnow

log = logging.getLogger(__name__)

REPO = Path(__file__).resolve().parents[2]                  # …/pga
SNAP_DIR = Path(os.environ.get("PGA_SNAPSHOT_DIR") or REPO.parent / "snapshots")
FILES_KEPT = 100


def _git() -> dict:
    try:
        head = subprocess.run(["git", "rev-parse", "--short", "HEAD"], cwd=REPO, capture_output=True, text=True, timeout=5).stdout.strip()
        dirty = subprocess.run(["git", "status", "--porcelain"], cwd=REPO, capture_output=True, text=True, timeout=10).stdout
        return {"head": head or None, "changed_files": len([l for l in dirty.splitlines() if l.strip()])}
    except (OSError, subprocess.SubprocessError):
        return {}


def _alive(lease_owner: str | None) -> bool:
    """Is the process named in a lease (`host:pid:tag`) still running on this machine?"""
    if not lease_owner:
        return False
    parts = lease_owner.split(":")
    if len(parts) < 2 or parts[0] != socket.gethostname():
        return True                                             # another machine: not ours to judge
    try:
        os.kill(int(parts[1]), 0)
        return True
    except (ValueError, ProcessLookupError):
        return False
    except PermissionError:
        return True


def state(session: Session, now: datetime) -> dict[str, Any]:
    running = list(session.scalars(select(Job).where(Job.status == JobStatus.RUNNING)))
    queued = dict(session.execute(select(Job.kind, func.count()).where(Job.status == JobStatus.QUEUED).group_by(Job.kind)).all())
    due = session.scalar(select(func.count()).select_from(Job).where(Job.status == JobStatus.QUEUED, Job.run_at <= now)) or 0
    runs = list(session.scalars(select(Run).where(Run.status == RunStatus.RUNNING)))
    agent_runs = list(session.scalars(select(AgentRun).where(AgentRun.status == "RUNNING")))
    rounds = list(session.scalars(select(EvolutionRound).where(EvolutionRound.phase.notin_(["done", "stopped"]))))
    return {
        "jobs": {"running": [{"id": str(j.id), "kind": j.kind, "user": str(j.user_id) if j.user_id else None, "owner": j.lease_owner,
                              "attempts": j.attempts} for j in running],
                 "queued": queued, "due_now": due},
        "runs_running": [{"id": str(r.id), "kind": r.kind, "user": str(r.user_id), "since": r.started_at.isoformat()} for r in runs],
        "agent_runs_running": [{"id": str(a.id), "agent": a.agent, "workflow": a.workflow} for a in agent_runs],
        "r0": [{"user": str(r.user_id), "tension": r.tension, "paused": r.paused} for r in session.scalars(select(R0State))],
        "evolution_open": [{"id": str(r.id), "phase": r.phase, "user": str(r.user_id)} for r in rounds],
        "code": _git(),
    }


def capture(session: Session, kind: str, worker_id: str, extra: dict | None = None, now: datetime | None = None,
            keep: int = 500) -> Snapshot:
    now = now or utcnow()
    data = {"kind": kind, "at": now.isoformat(), "worker": worker_id, "pid": os.getpid(), **state(session, now), **(extra or {})}
    snap = Snapshot(kind=kind, worker_id=worker_id, at=now, data=data)
    session.add(snap)
    session.flush()
    old = list(session.scalars(select(Snapshot.id).order_by(Snapshot.at.desc()).offset(keep)))
    if old:
        session.execute(Snapshot.__table__.delete().where(Snapshot.id.in_(old)))
    _write_file(data, now, kind)
    return snap


def _write_file(data: dict, now: datetime, kind: str) -> None:
    try:
        SNAP_DIR.mkdir(parents=True, exist_ok=True)
        body = json.dumps(data, ensure_ascii=False, indent=2, default=str)
        tmp = SNAP_DIR / ".latest.tmp"
        tmp.write_text(body, encoding="utf-8")
        tmp.replace(SNAP_DIR / "latest.json")
        if kind != "periodic" or now.minute % 30 < 5:              # keep the interesting ones, and one periodic per half hour
            (SNAP_DIR / f"{now.strftime('%Y%m%d-%H%M%S')}-{kind}.json").write_text(body, encoding="utf-8")
            files = sorted(p for p in SNAP_DIR.glob("2*.json"))
            for p in files[:-FILES_KEPT]:
                p.unlink(missing_ok=True)
    except OSError as exc:
        log.warning("could not write snapshot file: %s", exc)


def last(session: Session, kind: str | None = None) -> Snapshot | None:
    q = select(Snapshot).order_by(Snapshot.at.desc()).limit(1)
    if kind:
        q = q.where(Snapshot.kind == kind)
    return session.scalar(q)


def recover(session: Session, worker_id: str, now: datetime | None = None, boot: datetime | None = None) -> dict:
    """Resume after a stop. Safe to run on every start."""
    now = now or utcnow()
    boot = boot or now
    prev = last(session)
    last_job = session.scalar(select(func.max(Job.finished_at)))
    clean = bool(prev and prev.kind == "shutdown")
    stopped_at = prev.at if prev else last_job
    if not clean and last_job and stopped_at and last_job > stopped_at:
        stopped_at = last_job                                     # work went on after the last periodic snapshot
    requeued = []
    for j in session.scalars(select(Job).where(Job.status == JobStatus.RUNNING)):
        if j.lease_owner == worker_id or _alive(j.lease_owner):
            continue
        j.status, j.lease_owner, j.lease_until, j.run_at = JobStatus.QUEUED, None, None, now
        j.attempts = max(0, j.attempts - 1)                       # being cut off by a stop is not a failed attempt
        requeued.append({"id": str(j.id), "kind": j.kind})
    cutoff = min(boot, now) - timedelta(minutes=15)               # runs a live API process may still own are recent
    interrupted = 0
    for r in session.scalars(select(Run).where(Run.status == RunStatus.RUNNING, Run.started_at < cutoff)):
        r.status, r.ended_at = RunStatus.STOPPED, now
        r.stop_reason = "interrupted: PGA stopped while this run was in progress"
        interrupted += 1
    agent_interrupted = 0
    for a in session.scalars(select(AgentRun).where(AgentRun.status == "RUNNING", AgentRun.started_at < cutoff)):
        a.status, a.finished_at, a.error = "INTERRUPTED", now, "PGA stopped while this agent was working"
        agent_interrupted += 1
    overdue = session.scalar(select(func.count()).select_from(Job).where(Job.status == JobStatus.QUEUED, Job.run_at <= now)) or 0
    report = {
        "previous": {"kind": prev.kind, "at": prev.at.isoformat(), "worker": prev.worker_id} if prev else None,
        "clean_stop": clean,
        "stopped_at": stopped_at.isoformat() if stopped_at else None,
        "downtime_s": round((now - stopped_at).total_seconds()) if stopped_at else None,
        "requeued_jobs": requeued, "interrupted_runs": interrupted, "interrupted_agent_runs": agent_interrupted,
        "overdue_jobs": overdue,
    }
    session.flush()
    capture(session, "recovered", worker_id, {"recovery": report}, now=now)
    if requeued or interrupted or (report["downtime_s"] or 0) > 600:
        log.info("recovered after %s: %s", "a clean stop" if clean else "an unclean stop", report)
    return report


def release(session: Session, worker_id: str, now: datetime | None = None, reason: str = "PGA is stopping") -> list[dict]:
    """Shutting down: hand the jobs this worker holds back to the queue, then record a shutdown snapshot."""
    now = now or utcnow()
    held = []
    for j in session.scalars(select(Job).where(Job.status == JobStatus.RUNNING, Job.lease_owner == worker_id)):
        j.status, j.lease_owner, j.lease_until, j.run_at = JobStatus.QUEUED, None, None, now
        j.attempts = max(0, j.attempts - 1)
        held.append({"id": str(j.id), "kind": j.kind})
    session.flush()
    capture(session, "shutdown", worker_id, {"reason": reason, "released_jobs": held}, now=now)
    return held
