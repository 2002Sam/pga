"""The worker: claims due jobs and runs one bounded step each (spec §9, §21).

    python -m pga worker

Each job runs in its own transaction. A job that raises is retried with backoff
up to `max_attempts`; a step the allocator turns down is deferred to the time
the budget frees up, without spending an attempt. The worker sleeps whenever
nothing is due — the agent is always attentive, not always working.
"""

from __future__ import annotations

import logging
import os
import socket
import threading
import time
import uuid
from collections.abc import Callable
from dataclasses import dataclass
from datetime import datetime, timedelta
from typing import TYPE_CHECKING, Any

from sqlalchemy.orm import Session, sessionmaker

from pga.db.models import Job, Source, User
from pga.db.types import JobStatus, utcnow
from pga.workflow.scheduler import ensure_heartbeats, heartbeat, register_planner, responsibility_of

if TYPE_CHECKING:
    from pga.runtime import Runtime

log = logging.getLogger("pga.worker")

# Last time a worker loop in this process ticked. The API reads it (when running `python -m pga all`)
# to tell "the loop is alive" from "nothing is processing jobs".
LAST_BEAT: datetime | None = None


class Defer(Exception):
    """Raised by a handler when the work is fine but not allowed right now."""

    def __init__(self, until: datetime | None, reason: str):
        super().__init__(reason)
        self.until = until
        self.reason = reason


class Permanent(Exception):
    """Raised by a handler for failures a retry cannot fix."""


Handler = Callable[["Runtime", Job, datetime], dict[str, Any]]
HANDLERS: dict[str, Handler] = {}


def handler(kind: str) -> Callable[[Handler], Handler]:
    def deco(fn: Handler) -> Handler:
        HANDLERS[kind] = fn
        return fn
    return deco


def _user(rt: "Runtime", job: Job) -> User:
    u = rt.session.get(User, job.user_id) if job.user_id else None
    if u is None:
        raise Permanent("job has no user")
    return u


def _defer_default(now: datetime) -> datetime:
    return now + timedelta(hours=1)


# ---------------------------------------------------------------- built-in handlers


@handler("user.heartbeat")
def _heartbeat(rt: "Runtime", job: Job, now: datetime) -> dict:
    return heartbeat(rt, _user(rt, job), now)


@handler("source.poll")
def _poll(rt: "Runtime", job: Job, now: datetime) -> dict:
    s = rt.session.get(Source, uuid.UUID(job.payload["source_id"]))
    if s is None or not s.enabled:
        return {"skipped": "source removed or disabled"}
    res = rt.sources.poll(s, now)
    return {"status": res.status, "new_items": res.new_items, "effects": res.effects}


@handler("responsibility.research")
def _research(rt: "Runtime", job: Job, now: datetime) -> dict:
    from pga.agent.research import ResearchAgent

    r = responsibility_of(rt, job)
    if r is None:
        return {"skipped": "responsibility gone"}
    forward = None
    if rt.policy.motivation.enabled and r.status.value == "ACTIVE" and not r.paused_by_user:
        acted = _motivation_forward(rt, r, now)       # tension said "reconsider"; decide whether work is worth it
        if acted.get("stop"):
            return acted
        forward = acted
    out = ResearchAgent(rt).run(r, now)
    if out.status == "deferred":
        raise Defer(out.retry_after or _defer_default(now), out.reason)
    if out.status == "failed":
        raise RuntimeError(out.reason)
    if out.lesson and hasattr(rt, "learn_from"):
        rt.learn_from(r, out)  # Phase 3: candidate skills from experience
    return {"status": out.status, "reason": out.reason, "next_state": out.next_state, "forward": forward,
            "belief_changes": len(out.belief_changes), "run_id": str(out.run_id) if out.run_id else None}


def _motivation_forward(rt: "Runtime", r, now: datetime) -> dict:
    """Run the Motivation Forward and carry out its decision. {"stop": True} means: do not research now."""
    from pga.agent.research import ResearchAgent
    from pga.db.types import CommKind, NotifyReason, Origin
    from pga.evolution import MotivationForward, bump_r0
    from pga.notify import Proposal

    pending = [ev.canonical_summary_en for _, ev in ResearchAgent(rt).pending_events(r, rt.policy.workflow.max_evidence_per_research)]
    if not pending:
        return {"decision": None, "note": "nothing new to weigh"}
    d = MotivationForward(rt).decide(r, pending, now)
    why = str((d.answers or {}).get("reason") or "")[:200]
    out = {"decision": d.decision, "decision_id": str(d.id), "fallback": d.fallback}
    if d.decision in ("MONITOR", "SLEEP"):
        rt.responsibilities.transition(r, "monitor" if d.decision == "MONITOR" else "sleep", actor=Origin.SYSTEM, now=now,
                                       reason=f"Motivation Forward: {why}")
        return {**out, "stop": True}
    if d.decision in ("ASK_USER", "INVITE_MEETING", "ARCHIVE"):
        user = rt.session.get(User, r.user_id)
        q = (d.answers or {}).get("question") or why or "Should I keep working on this?"
        title = ("Suggest archiving: " if d.decision == "ARCHIVE" else "") + r.title_en
        rt.notify.propose(user, Proposal(kind=CommKind.MEETING if d.decision == "INVITE_MEETING" else CommKind.QUESTION,
                                         reasons=[NotifyReason.DECISION_REQUIRED], title_en=title[:200], body_en=str(q)[:800],
                                         options=["Keep going", "Pause it"] if d.decision != "ARCHIVE" else ["Archive it", "Keep it"],
                                         responsibility_id=r.id, dedupe_key=f"mf:{r.id}:{d.decision}"), now)
        rt.responsibilities.transition(r, "wait_for_user", actor=Origin.SYSTEM, now=now, reason=f"Motivation Forward: {why}")
        return {**out, "stop": True}
    if d.decision == "SELF_IMPROVE":
        bump_r0(rt, r.user_id, 0.25, f"Motivation Forward for '{r.title_en[:60]}' asked for self-improvement: {why}", now)
    return out                                         # DEEP_RESEARCH, EXECUTE, GENERATE_ARTIFACT, CREATE_CANDIDATE…: research


@handler("r0.forward")
def _r0_forward(rt: "Runtime", job: Job, now: datetime) -> dict:
    from pga.evolution import EvolutionService, r0_forward

    user = _user(rt, job)
    d = r0_forward(rt, user, now)
    out = {"decision": d.decision, "fallback": d.fallback}
    if d.decision == "SELF_IMPROVE":
        svc = EvolutionService(rt)
        why = svc.can_start(user.id, now)
        if why:
            return {**out, "round": None, "why": why}
        rnd = svc.start(user, trigger="r0", decision=d, now=now)
        out["round"] = str(rnd.id)
    return out


@handler("evolution.step")
def _evolution_step(rt: "Runtime", job: Job, now: datetime) -> dict:
    from pga.db.models import EvolutionRound
    from pga.evolution import EvolutionService

    rnd = rt.session.get(EvolutionRound, uuid.UUID(job.payload["round_id"]))
    if rnd is None:
        return {"skipped": "round gone"}
    return EvolutionService(rt).step(rnd, now)


@register_planner
def _plan_r0(rt: "Runtime", user: User, now: datetime) -> list[dict]:
    """Deterministic: refresh R0's telemetry and tension, close finished canaries, and queue R0's forward if due."""
    if not rt.policy.evolution.enabled:
        return []
    from sqlalchemy import func, select

    from pga.db.models import MotivationDecision
    from pga.evolution import EvolutionService, r0_tick

    if rt.policy.evolution.r0_scope == "system":            # one R0 for the installation: it lives on the owner account
        from pga.owner import owner_id
        if owner_id(rt.session) != user.id:
            return []
    st = r0_tick(rt, user.id, now)
    svc = EvolutionService(rt)
    svc.canary_check(user.id, now)
    if st.paused or st.tension < rt.policy.evolution.r0_wake or svc.can_start(user.id, now):
        return []
    last = rt.session.scalar(select(func.max(MotivationDecision.created_at)).where(
        MotivationDecision.user_id == user.id, MotivationDecision.subject == "R0"))
    if last and now - last < timedelta(hours=6):
        return []
    return [{"kind": "r0.forward", "key": f"r0:{user.id}", "priority": 140}]


@handler("agents.run")
def _agents_run(rt: "Runtime", job: Job, now: datetime) -> dict:
    """Run a workflow of the agent pool (single / council / convoy) in the background."""
    from pga.agents import AgentPool, PoolError

    p = job.payload or {}
    try:
        res = AgentPool(rt).run(str(p.get("workflow") or "general"), str(p.get("prompt") or ""), user=_user(rt, job),
                                system=str(p.get("system") or ""), job_id=job.id, now=now)
    except PoolError as exc:
        raise Permanent(str(exc)) from exc
    return {"run_id": str(res.run_id), "ok": res.ok, "text": res.text[:4000], "error": res.error}


@handler("layers.build")
def _layers_build(rt: "Runtime", job: Job, now: datetime) -> dict:
    """Build (or refresh) one item's information pyramid: gist, brief, full."""
    from pga.layers import LayerError

    try:
        p = rt.layers.build(_user(rt, job), str(job.payload.get("ref") or ""), now=now)
    except LayerError as exc:
        raise Permanent(str(exc)) from exc
    return {"ref": p.ref, "source_level": p.source_level, "modes": {lv: l.mode for lv, l in p.levels.items()}, "strict": p.strict}


@register_planner
def _plan_layers(rt: "Runtime", user: User, now: datetime) -> list[dict]:
    """Deterministic: queue pyramids that are missing, stale (the item changed) or only rule-cut."""
    lp = rt.policy.layers
    if not lp.background:
        return []
    return [{"kind": "layers.build", "key": f"layers:{ref}", "payload": {"ref": ref}, "priority": 160}
            for ref in rt.layers.due(user.id, now, lp.builds_per_heartbeat)]


@handler("exploration.run")
def _explore(rt: "Runtime", job: Job, now: datetime) -> dict:
    from pga.agent.explore import Explorer

    out = Explorer(rt).run(_user(rt, job), now)
    if out.status == "deferred":
        raise Defer(out.retry_after or _defer_default(now), out.reason)
    return {"status": out.status, "scope": out.scope, "queries": out.queries, "ingested": out.ingested,
            "reason": out.reason}


# ---------------------------------------------------------------- the worker


@dataclass
class StepResult:
    job_id: uuid.UUID
    kind: str
    outcome: str        # succeeded | deferred | retrying | failed
    detail: Any = None


class Worker:
    def __init__(self, session_factory: sessionmaker[Session], runtime_factory: Callable[[Session], "Runtime"],
                 worker_id: str | None = None, handlers: dict[str, Handler] | None = None):
        self.session_factory = session_factory
        self.runtime_factory = runtime_factory
        self.worker_id = worker_id or f"{socket.gethostname()}:{os.getpid()}:{uuid.uuid4().hex[:6]}"
        self.handlers = handlers if handlers is not None else HANDLERS
        self.boot = utcnow()
        self.current: dict | None = None          # the job in hand, for the shutdown snapshot
        self.recovery: dict | None = None
        self._last_snapshot: datetime | None = None
        self._shut = threading.Lock()
        self._stopped = False

    def _session(self) -> Session:
        return self.session_factory()

    def schedule(self, now: datetime | None = None) -> int:
        with self._session() as s:
            n = ensure_heartbeats(self.runtime_factory(s), now)
            s.commit()
            return n

    def run_once(self, now: datetime | None = None, max_jobs: int = 20) -> list[StepResult]:
        """Process due jobs until none are left (or `max_jobs`). Returns what happened."""
        self.schedule(now)
        results = []
        for _ in range(max_jobs):
            res = self._one(now)
            if res is None:
                break
            results.append(res)
        if results:
            self.schedule(now)  # a heartbeat that just finished leaves the next one queued
        return results

    def _one(self, now: datetime | None) -> StepResult | None:
        now_ = now or utcnow()
        with self._session() as s:
            rt = self.runtime_factory(s)
            jobs = rt.workflow.claim(self.worker_id, limit=1, now=now_)
            if not jobs:
                s.commit()
                return None
            job_id, kind = jobs[0].id, jobs[0].kind
            s.commit()

        fn = self.handlers.get(kind)
        self.current = {"id": str(job_id), "kind": kind, "since": now_.isoformat()}
        with self._session() as s:
            rt = self.runtime_factory(s)
            job = s.get(Job, job_id)
            try:
                if fn is None:
                    raise Permanent(f"no handler for job kind {kind!r}")
                started = time.monotonic()
                result = fn(rt, job, now_)
                rt.workflow.complete(job, {**(result or {}), "seconds": round(time.monotonic() - started, 3)}, now_)
                s.commit()
                self.current = None
                return StepResult(job_id, kind, "succeeded", result)
            except Defer as d:
                s.rollback()
                outcome, detail = "deferred", d.reason
                until = d.until
                permanent = False
            except Permanent as p:
                s.rollback()
                outcome, detail, until, permanent = "failed", str(p), None, True
            except Exception as exc:  # any other error: retry with backoff
                s.rollback()
                log.exception("job %s (%s) failed", job_id, kind)
                outcome, detail, until, permanent = "retrying", f"{type(exc).__name__}: {exc}", None, False

        self.current = None
        with self._session() as s:
            rt = self.runtime_factory(s)
            job = s.get(Job, job_id)
            if outcome == "deferred":
                rt.workflow.defer(job, until or _defer_default(now_), detail, now_)
            else:
                rt.workflow.fail(job, detail, now_, permanent=permanent)
                if job.status == JobStatus.FAILED:
                    outcome = "failed"
            s.commit()
        return StepResult(job_id, kind, outcome, detail)

    # ---------------------------------------------------------------- snapshots: stop and resume

    def recover(self, now: datetime | None = None) -> dict:
        """Before taking any job: hand back jobs a dead process held, close its runs, record what was resumed."""
        from pga import snapshot
        with self._session() as s:
            self.recovery = snapshot.recover(s, self.worker_id, now=now, boot=self.boot)
            s.commit()
        self._last_snapshot = now or utcnow()
        return self.recovery

    def checkpoint(self, now: datetime | None = None, force: bool = False) -> bool:
        from pga import snapshot
        now = now or utcnow()
        with self._session() as s:
            wp = self.runtime_factory(s).policy.workflow
            if not force and self._last_snapshot and now - self._last_snapshot < timedelta(minutes=wp.snapshot_every_minutes):
                return False
            snapshot.capture(s, "periodic", self.worker_id, {"current": self.current}, now=now, keep=wp.snapshots_kept)
            s.commit()
        self._last_snapshot = now
        return True

    def shutdown(self, reason: str = "PGA is stopping") -> list[dict]:
        """Hand the jobs this worker holds back to the queue and write the shutdown snapshot (once)."""
        from pga import snapshot
        with self._shut:
            if self._stopped:
                return []
            self._stopped = True
            try:
                with self._session() as s:
                    held = snapshot.release(s, self.worker_id, reason=reason + (f"; was running {self.current['kind']}" if self.current else ""))
                    s.commit()
                    return held
            except Exception:  # noqa: BLE001 - never block a stop
                log.exception("shutdown snapshot failed")
                return []

    def run_forever(self, stop: threading.Event | None = None, poll_seconds: float | None = None) -> None:
        stop = stop or threading.Event()
        with self._session() as s:
            poll = poll_seconds or self.runtime_factory(s).policy.workflow.worker_poll_seconds
        try:
            self.recover()
        except Exception:  # noqa: BLE001 - recovery is best effort; the leases still expire on their own
            log.exception("recovery failed")
        log.info("worker %s started", self.worker_id)
        global LAST_BEAT
        while not stop.is_set():
            LAST_BEAT = utcnow()
            try:
                done = self.run_once()
                self.checkpoint()
            except Exception:  # keep the worker alive through database hiccups
                log.exception("worker loop error")
                done = []
            if not done:
                stop.wait(poll)
        LAST_BEAT = None
        self.shutdown("the worker was asked to stop")
        log.info("worker %s stopped", self.worker_id)
