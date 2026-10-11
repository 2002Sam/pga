"""Stop and resume: snapshots, recovery after a crash or a clean stop."""

from __future__ import annotations

import json
import socket
from datetime import timedelta

from pga import snapshot
from pga.db.models import Run, Snapshot
from pga.db.types import JobStatus, Origin, RunStatus, utcnow
from pga.runtime import Runtime
from pga.workflow.worker import Worker


def _job(rt, user, kind="user.heartbeat", owner=None):
    j = rt.workflow.enqueue(kind, user_id=user.id, created_by=Origin.SYSTEM, dedupe_key=f"{kind}:{owner}")
    j.status, j.lease_owner, j.attempts = JobStatus.RUNNING, owner, 1
    j.lease_until = utcnow() + timedelta(minutes=10)
    rt.session.flush()
    return j


def _run(rt, user, started):
    r = Run(user_id=user.id, kind="synthesis", category="active_responsibilities", proactive=True, status=RunStatus.RUNNING,
            started_at=started)
    rt.session.add(r)
    rt.session.flush()
    return r


def test_recovery_after_a_crash_resumes_what_was_in_flight(rt, user):
    now = utcnow()
    dead = f"{socket.gethostname()}:999999:dead01"                          # a process that no longer exists
    snapshot.capture(rt.session, "periodic", dead, now=now - timedelta(hours=8))
    orphan = _job(rt, user, owner=dead)
    mine = _job(rt, user, "source.poll", owner="me")
    old = _run(rt, user, now - timedelta(hours=9))
    fresh = _run(rt, user, now - timedelta(minutes=2))                       # may belong to a live API process

    rep = snapshot.recover(rt.session, "me", now=now)
    assert rep["clean_stop"] is False and 8 * 3600 - 5 <= rep["downtime_s"] <= 8 * 3600 + 5
    assert [j["id"] for j in rep["requeued_jobs"]] == [str(orphan.id)]
    assert orphan.status == JobStatus.QUEUED and orphan.lease_owner is None and orphan.attempts == 0 and orphan.run_at == now
    assert mine.status == JobStatus.RUNNING                                  # held by the live worker: untouched
    assert old.status == RunStatus.STOPPED and "interrupted" in old.stop_reason and fresh.status == RunStatus.RUNNING
    snap = snapshot.last(rt.session)
    assert snap.kind == "recovered" and snap.data["recovery"]["interrupted_runs"] == 1
    latest = json.loads((snapshot.SNAP_DIR / "latest.json").read_text())
    assert latest["kind"] == "recovered" and any(p.name.endswith("-recovered.json") for p in snapshot.SNAP_DIR.iterdir())


def test_a_clean_stop_hands_jobs_back_and_the_next_start_knows(session_factory, policy, provider, backend, user, session):
    session.commit()
    w = Worker(session_factory, lambda s: Runtime(s, policy=policy, provider=provider, translation_backend=backend), worker_id="w1")
    with session_factory() as s:
        rt = Runtime(s, policy=policy, provider=provider, translation_backend=backend)
        held = _job(rt, s.merge(user), owner="w1")
        s.commit()
        held_id = held.id
    assert w.checkpoint(force=True)
    released = w.shutdown("test stop")
    assert [j["id"] for j in released] == [str(held_id)] and w.shutdown() == []        # once only
    w2 = Worker(session_factory, lambda s: Runtime(s, policy=policy, provider=provider, translation_backend=backend), worker_id="w2")
    rep = w2.recover()
    assert rep["clean_stop"] is True and rep["previous"]["kind"] == "shutdown" and rep["requeued_jobs"] == []
    with session_factory() as s:
        kinds = [x.kind for x in s.query(Snapshot).order_by(Snapshot.at)]
        assert kinds[-3:] == ["periodic", "shutdown", "recovered"]
