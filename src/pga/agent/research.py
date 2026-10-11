"""One research step for an awake responsibility (spec §1.6, §5, §9, §16).

A step is bounded: it is only taken when the responsibility is ACTIVE (tension
woke it), the allocator approves a justified budget, and it ends by deciding
what the responsibility does next — continue, monitor, sleep, wait for the user
or wait for the world. There is no open-ended thinking loop.

    unabsorbed events → (optional page fetches) → synthesis call → beliefs
    → absorb events (tension falls) → communication decision → next state
"""

from __future__ import annotations

import logging
import uuid
from dataclasses import dataclass, field
from datetime import datetime, timedelta
from typing import TYPE_CHECKING, Any

from sqlalchemy import select

from pga.agent.common import UNTRUSTED_NOTE, ModelOutputError, clamp01, fence, parse_json
from pga.allocator import Estimates, Justification, RunRequest
from pga.db.models import EventCluster, Evidence, Responsibility, ResponsibilityCluster, Run, User
from pga.db.types import (
    BeliefStatus, BeliefType, CommKind, NotifyReason, Origin, ResponsibilityStatus as S, RunStatus, utcnow,
)
from pga.knowledge.beliefs import BeliefUpdate
from pga.notify import Proposal
from pga.responsibility import LimitExceeded, ResponsibilityError

if TYPE_CHECKING:
    from pga.runtime import Runtime

log = logging.getLogger("pga.agent")

MARKER = "PGA_RESEARCH_SYNTHESIS"

SYSTEM = f"""{MARKER}
You are the research step of the user's long-lived personal agent. You hold one responsibility for the user
and have been woken because new information raised its tension. Update what the agent believes, decide
whether the user needs to hear about it, and decide what this responsibility should do next.

Rules:
- Write in English. Keep facts, hypotheses, conclusions and open uncertainties separate.
- Every belief must cite evidence ids (E1, E2 …) from the list below; uncited conclusions are not allowed.
- Reuse an existing belief's key when you are revising it.
- Interrupt the user only for: CONCLUSION_CHANGED, DEADLINE, DECISION_REQUIRED, ARTIFACT_READY, UNCERTAINTY.
  Otherwise choose SILENT. Prefer silence; the user's attention is the scarcest resource.
- {UNTRUSTED_NOTE}

Reply with one JSON object only:
{{
  "beliefs": [{{"key": "short-slug", "type": "HYPOTHESIS|CONCLUSION|UNCERTAINTY",
               "statement": "...", "confidence": 0.0-1.0, "status": "ACTIVE|REFUTED|RESOLVED",
               "evidence": [{{"id": "E1", "stance": "SUPPORTS|CONTRADICTS"}}]}}],
  "resolved_uncertainty": 0.0-1.0,
  "communicate": {{"kind": "SILENT|NOTIFICATION|BRIEF|QUESTION|MEETING",
                  "reasons": ["CONCLUSION_CHANGED"], "title": "...", "body": "...", "options": ["..."]}},
  "next": {{"state": "continue|monitor|sleep|wait_user|wait_external", "review_in_hours": 24, "reason": "..."}},
  "candidates": [{{"title": "...", "why": "...", "keywords": ["..."]}}],
  "useful": true,
  "lesson": "one reusable lesson about how to do this kind of research, or empty"
}}"""


@dataclass
class ResearchOutcome:
    status: str                         # done | deferred | skipped | failed
    reason: str = ""
    retry_after: datetime | None = None
    run_id: uuid.UUID | None = None
    belief_changes: list[dict] = field(default_factory=list)
    notification_id: uuid.UUID | None = None
    next_state: str | None = None
    lesson: str = ""


class ResearchAgent:
    def __init__(self, rt: "Runtime"):
        self.rt = rt

    # ---------------------------------------------------------------- gather

    def pending_events(self, r: Responsibility, limit: int) -> list[tuple[EventCluster, Evidence]]:
        rows = self.rt.session.execute(
            select(EventCluster, ResponsibilityCluster.contributions)
            .join(ResponsibilityCluster, ResponsibilityCluster.cluster_id == EventCluster.id)
            .where(ResponsibilityCluster.responsibility_id == r.id, ResponsibilityCluster.absorbed_at.is_(None),
                   ResponsibilityCluster.rejected_at.is_(None), ResponsibilityCluster.expired_at.is_(None))
            .order_by(EventCluster.last_seen_at.desc()).limit(limit)).all()
        out = []
        for cluster, _ in rows:
            ev = self.rt.session.scalar(select(Evidence).where(
                Evidence.event_cluster_id == cluster.id, Evidence.retracted_at.is_(None))
                .order_by(Evidence.trust_score.desc().nullslast(), Evidence.retrieved_at.desc()).limit(1))
            if ev is not None:
                out.append((cluster, ev))
        return out

    def _why_now(self, r: Responsibility) -> str:
        top = self.rt.tension.top_contributors(r, limit=3)
        if not top:
            return f"tension {r.tension:.2f} is above the wake threshold {r.wake_threshold:.2f}"
        return "; ".join(c.explanation_en[:160] for c in top)

    # ---------------------------------------------------------------- run

    def run(self, r: Responsibility, now: datetime | None = None) -> ResearchOutcome:
        rt = self.rt
        now = now or utcnow()
        rt.tension.decay(r, now)
        if r.status not in {S.ACTIVE, S.CANDIDATE} or r.paused_by_user:
            return ResearchOutcome("skipped", f"responsibility is {r.status.value}")
        wp = rt.policy.workflow
        events = self.pending_events(r, wp.max_evidence_per_research)
        if not events and r.status == S.CANDIDATE:
            return ResearchOutcome("skipped", "candidate has nothing new to explore")
        if not events:
            # awake but nothing new to absorb: let tension decay it back down
            rt.responsibilities.transition(r, "monitor", actor=Origin.AGENT, now=now,
                                           reason="nothing new to research")
            return ResearchOutcome("done", "nothing new to absorb", next_state="monitor")

        decision = rt.allocator.allocate(RunRequest(
            user_id=r.user_id, responsibility_id=r.id, kind="synthesis",
            justification=Justification(
                why_now=self._why_now(r),
                expected_gain=f"absorb {len(events)} new event(s) into the beliefs for '{r.title_en[:80]}'",
                decision_affected=f"whether the user's view or plans on '{r.title_en[:80]}' should change",
                budget={"max_units": 120_000, "max_output_tokens": 3000},
                stop_condition="all listed events absorbed and the next state chosen"),
            estimates=Estimates(information_gain=min(1.0, 0.3 + 0.1 * len(events)), decision_impact=0.6,
                                user_relevance=min(1.0, max(0.0, 0.6 + 0.2 * r.priority_bias)), urgency=min(1.0, r.tension),
                                reuse_value=0.3, input_tokens=4000 + 600 * len(events), output_tokens=1500,
                                interruption_cost=0.0, staleness_risk=0.3)), now=now)
        if not decision.allowed:
            return ResearchOutcome("deferred", "; ".join(decision.reasons), retry_after=decision.retry_after)

        user = rt.session.get(User, r.user_id)
        ids = {f"E{i + 1}": ev.id for i, (_, ev) in enumerate(events)}
        with rt.runs.track(decision, now) as guard:
            prompt = self._prompt(r, user, events)
            result = rt.router.complete(decision.tier, system=SYSTEM, messages=[{"role": "user", "content": prompt}],
                                        max_tokens=decision.limits["max_output_tokens"], usage=guard.usage_context())
            guard.check()
            try:
                data = parse_json(result.text)
            except ModelOutputError:
                guard.stop("model output was not valid JSON; nothing applied")
                return ResearchOutcome("failed", "unparseable model output", run_id=guard.run.id)
            out = self._apply(r, user, data, ids, events, guard.run, now)
            guard.belief_changes = out.belief_changes
            guard.new_evidence = [str(ev.id) for _, ev in events]
            guard.user_notified = out.notification_id is not None and out.reason != "suppressed"
            guard.stop(f"absorbed {len(events)} event(s); next: {out.next_state}")
            out.run_id = guard.run.id
        return out

    def _prompt(self, r: Responsibility, user: User, events: list[tuple[EventCluster, Evidence]]) -> str:
        rt = self.rt
        situation = rt.situation.snapshot(user.id)
        beliefs = rt.beliefs.active(r)
        parts = [f"<responsibility>\nTitle: {r.title_en}\nDescription: {r.description_en or '-'}\n"
                 f"Keywords: {', '.join(r.keywords or []) or '-'}\nTension: {r.tension:.2f}\n</responsibility>"]
        if r.aim_id and getattr(rt, "layers", None) is not None:      # the ambition, at the detail research needs
            parts.append("<ambition>\nThe long-range aim this responsibility serves:\n"
                         f"{rt.layers.text(f'aim:{r.aim_id}', rt.layers.need('research.aim'))}\n</ambition>")
        if situation:
            parts.append("<situation>\n" + "\n".join(f"{k}: " + "; ".join(v) for k, v in situation.items())
                         + "\n</situation>")
        skills = getattr(rt, "skill_context", None)
        if callable(skills):
            hint = skills(r, "research")
            if hint:
                parts.append(f"<skills>\n{hint}\n</skills>")
        recall = getattr(rt, "memory_context", None)
        if callable(recall):
            ctx = recall(r, " ".join([r.title_en, *[c.title_en for c, _ in events[:3]]]))
            if ctx:
                parts.append(f"<related_memory>\n{ctx}\n</related_memory>")
        parts.append("<current_beliefs>\n" + ("\n".join(
            f"- key={b.key} [{b.type.value}, confidence {b.confidence:.2f}] {b.statement_en}" for b in beliefs)
            or "(none yet)") + "\n</current_beliefs>")
        for i, (cluster, ev) in enumerate(events):
            meta = {"id": f"E{i + 1}", "sources": str(cluster.source_count),
                    "confidence": f"{cluster.confidence:.2f}"}
            if ev.published_at:
                meta["published"] = ev.published_at.date().isoformat()
            if cluster.expires_at:
                meta["expires"] = cluster.expires_at.isoformat(timespec="minutes")
            if ev.source_uri:
                meta["uri"] = ev.source_uri[:300]
            parts.append(fence("evidence", ev.canonical_summary_en, 3000, **meta))
        return "\n\n".join(parts)

    # ---------------------------------------------------------------- apply

    def _apply(self, r: Responsibility, user: User, data: dict[str, Any], ids: dict[str, uuid.UUID],
               events: list[tuple[EventCluster, Evidence]], run: Run, now: datetime) -> ResearchOutcome:
        rt = self.rt
        updates = []
        for b in data.get("beliefs") or []:
            if not isinstance(b, dict) or not b.get("statement"):
                continue
            try:
                btype = BeliefType(str(b.get("type", "HYPOTHESIS")).upper())
            except ValueError:
                btype = BeliefType.HYPOTHESIS
            try:
                status = BeliefStatus(str(b.get("status", "ACTIVE")).upper())
            except ValueError:
                status = BeliefStatus.ACTIVE
            cites = [(ids[c["id"]], str(c.get("stance", "SUPPORTS")).upper())
                     for c in (b.get("evidence") or []) if isinstance(c, dict) and c.get("id") in ids]
            updates.append(BeliefUpdate(key=str(b.get("key") or b["statement"])[:120], type=btype,
                                        statement_en=str(b["statement"]), confidence=clamp01(b.get("confidence"), 0.5),
                                        status=status, evidence=cites))
        changes = rt.beliefs.apply(r, updates, allowed_evidence=set(ids.values()), run_id=run.id, now=now)
        out = ResearchOutcome("done", belief_changes=[c.as_dict() for c in changes], lesson=str(data.get("lesson") or ""))

        rt.tension.absorb(r, [c.id for c, _ in events], run_id=run.id, now=now)
        resolved = clamp01(data.get("resolved_uncertainty"))
        if resolved > 0:
            rt.tension.resolve_uncertainty(r, amount=0.3 * resolved, note="research step", now=now)
        if data.get("useful"):
            rt.responsibilities.record_useful_outcome(r, "research step produced a useful update")

        # ---- communication: the agent proposes, the evidence decides which reasons are real
        comm = data.get("communicate") or {}
        try:
            kind = CommKind(str(comm.get("kind", "SILENT")).upper())
        except ValueError:
            kind = CommKind.SILENT
        claimed = set()
        for x in comm.get("reasons") or []:
            try:
                claimed.add(NotifyReason(str(x).upper()))
            except ValueError:
                pass
        reasons = self._verified_reasons(claimed, kind, changes, events, now)
        if kind != CommKind.SILENT or changes:
            title = str(comm.get("title") or (changes[0].statement_en if changes else r.title_en))[:300]
            body = str(comm.get("body") or "")
            n = rt.notify.propose(user, Proposal(
                kind=kind, reasons=sorted(reasons, key=lambda x: x.value), title_en=title, body_en=body,
                options=[str(o) for o in (comm.get("options") or [])][:6], responsibility_id=r.id, run_id=run.id,
                dedupe_key=f"{r.id}:{'|'.join(sorted(c.key for c in changes if c.material)) or title[:80]}"), now=now)
            out.notification_id = n.id
            if n.status.value == "SUPPRESSED":
                out.reason = "suppressed"
            kind = n.kind

        # ---- candidates: bounded, expiring children (never perpetual without promotion)
        for c in (data.get("candidates") or [])[:2]:
            if not isinstance(c, dict) or not c.get("title"):
                continue
            try:
                rt.responsibilities.create_candidate(
                    r, title_en=str(c["title"])[:300], description_en=str(c.get("why") or "")[:1000],
                    actor=Origin.AGENT, keywords=[str(k) for k in (c.get("keywords") or [])][:8],
                    exploration_budget={"max_units": rt.policy.workflow.candidate_budget_units, "max_runs": 3},
                    ttl_hours=rt.policy.workflow.candidate_ttl_hours, now=now)
            except (LimitExceeded, ResponsibilityError) as exc:
                log.info("candidate not opened: %s", exc)

        out.next_state = self._next_state(r, data.get("next") or {}, kind, now)
        return out

    def _verified_reasons(self, claimed: set[NotifyReason], kind: CommKind, changes, events, now) -> set[NotifyReason]:
        ok: set[NotifyReason] = set()
        if NotifyReason.CONCLUSION_CHANGED in claimed and any(c.material for c in changes):
            ok.add(NotifyReason.CONCLUSION_CHANGED)
        if NotifyReason.DEADLINE in claimed and any(
                c.expires_at and c.expires_at - now <= timedelta(days=3) for c, _ in events):
            ok.add(NotifyReason.DEADLINE)
        if kind in {CommKind.QUESTION, CommKind.MEETING}:
            ok |= claimed & {NotifyReason.DECISION_REQUIRED, NotifyReason.UNCERTAINTY}
        if NotifyReason.UNCERTAINTY in claimed and any(c.type == "UNCERTAINTY" for c in changes):
            ok.add(NotifyReason.UNCERTAINTY)
        # ARTIFACT_READY is only ever set by the artifact pipeline, never claimed by a research step
        return ok

    def _next_state(self, r: Responsibility, nxt: dict, kind: CommKind, now: datetime) -> str:
        rt = self.rt
        state = str(nxt.get("state") or "monitor").lower()
        reason = str(nxt.get("reason") or "")[:300]
        if r.status == S.CANDIDATE:
            return "candidate"  # candidates never change state on their own; only promote/expire/cancel
        if kind in {CommKind.QUESTION, CommKind.MEETING}:
            state = "wait_user"
        try:
            if state == "wait_user":
                rt.responsibilities.transition(r, "wait_for_user", actor=Origin.AGENT, now=now,
                                               reason=reason or "asked the user")
            elif state == "wait_external":
                rt.responsibilities.transition(r, "wait_for_event", actor=Origin.AGENT, now=now,
                                               reason=reason or "waiting for an external event")
            elif state == "sleep":
                hours = max(1.0, float(nxt.get("review_in_hours") or 72))
                rt.responsibilities.transition(r, "sleep", actor=Origin.AGENT, now=now, reason=reason or "nothing to do")
                r.next_review_at = now + timedelta(hours=hours)
            elif state == "continue" and r.tension > r.sleep_threshold:
                state = "continue"  # stays ACTIVE; the scheduler respects the research cooldown
            else:
                state = "monitor"
                if r.status == S.ACTIVE:
                    rt.responsibilities.transition(r, "monitor", actor=Origin.AGENT, now=now,
                                                   reason=reason or "absorbed; back to monitoring")
        except ResponsibilityError as exc:
            log.info("next-state %s not applied: %s", state, exc)
        return state


def last_research_at(rt: "Runtime", r: Responsibility) -> datetime | None:
    return rt.session.scalar(select(Run.started_at).where(
        Run.responsibility_id == r.id, Run.kind == "synthesis", Run.status == RunStatus.SUCCEEDED)
        .order_by(Run.started_at.desc()).limit(1))
