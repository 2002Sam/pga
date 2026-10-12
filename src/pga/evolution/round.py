"""The bounded Evolution Round (spec §6–§14, §21).

    Diagnose → independent proposers → backlog → review council → controller → implement (isolated)
    → verify → candidate → user-approved promotion → canary → active (or rollback)

Each phase is one job step, so a round can pause, resume after a restart and never loops on itself.
Hard bounds come from policy.evolution (max proposers, proposals, reviewers, implementations, promotions), a
round can never start another round, and every model call is allocated from the self-improvement budget.
"""

from __future__ import annotations

import logging
import re
import uuid
from datetime import datetime, timedelta
from typing import TYPE_CHECKING

from sqlalchemy import func, select

from pga.agent.common import UNTRUSTED_NOTE, clamp01
from pathlib import Path

from pga.db.models import AgentVersion, EvolutionRound, ImprovementProposal, MotivationDecision, ProposalReview, User
from pga.db.types import CommKind, NotifyReason, utcnow
from pga.notify import Proposal
from pga.evolution.coding import CodingAgent, CodingError, SuiteResult
from pga.evolution.motivation import _call, open_round, r0_state
from pga.evolution.telemetry import recent_failures

if TYPE_CHECKING:
    from pga.runtime import Runtime

log = logging.getLogger("pga.evolution")


class EvolutionError(RuntimeError):
    pass


MAP = """PGA code map (Python, FastAPI, PostgreSQL; src/pga/…):
api/app.py HTTP API · chat.py chat turn · tension/ responsibility tension + event clustering · allocator.py value/cost
allocation · budget.py quotas · llm/router.py model tiers/providers · workflow/ jobs, worker, heartbeat scheduler ·
agent/research.py research step · agent/explore.py free exploration · knowledge/beliefs.py beliefs · sources/ feeds ·
notify/ notifications · translation/ zh⇄en gateway · hub/ other AI agents · bodies.py ambition map · evolution/ (this loop,
protected) · web/index.html UI · policy.yaml defaults (protected) · tests/ pytest suite."""

DIAGNOSE_SYSTEM = f"""You diagnose a personal agent's real bottleneck before anyone proposes fixes. Use only the evidence
given. Do not propose solutions. {UNTRUSTED_NOTE}
{MAP}
Reply with JSON only: {{"problem": {{"description": "...", "evidence": ["concrete numbers"], "affected_components": ["src/pga/…"],
"estimated_impact": "..."}}, "confidence": 0.0-1.0}}"""

PROPOSER_ROLES = {
    "conservative": "the smallest safe change that addresses the diagnosed problem",
    "config_only": "a no-code or configuration/prompt-only change (thresholds, routing, cooldowns, prompts)",
    "architecture": "an architecture-level or research-inspired redesign, still bounded and reversible",
}
PROPOSE_SYSTEM = """You are an independent proposer ({role}) for improving a personal agent. Propose at most 2 changes that
address the diagnosed problem — {brief}. Never touch permissions, the user's ambitions/motivation, safety policy,
spending or publishing authority, migrations or the evolution loop itself.
""" + MAP + """
Reply with JSON only: {{"proposals": [{{"title": "≤8 words", "change": "what to change, concretely", "files": ["src/pga/…"],
"expected_gain": "...", "expected_cost": "...", "risk": "...", "dependencies": "...", "evaluation_plan": "how to verify",
"rollback_condition": "..."}}]}}"""

REVIEWERS = {
    "evidence": ("Evidence & Cost Reviewer", "Is the diagnosed problem real and is the mechanism supported by evidence? Will it actually "
                 "improve cost/latency, and what new ongoing cost does it add?", ["evidence_strength", "expected_gain", "implementation_cost"]),
    "architecture": ("Architecture Reviewer", "What components could regress? Does it add unnecessary complexity?",
                     ["regression_risk", "implementation_cost", "reversibility"]),
    "safety": ("Goal & Safety Reviewer", "Does it improve the agent without violating its purpose? Does it expand autonomy, "
               "permissions or irreversible behaviour, or touch the user's motivation? Mark critical if so.", ["goal_alignment", "reversibility"]),
    "devil": ("Devil's Advocate", "Why might this proposal be wrong? What evidence would falsify it?",
              ["evidence_strength", "expected_gain", "regression_risk"]),
}
REVIEW_SYSTEM = """You are the {title} on a review council for a personal agent's self-improvement. {question}
Score each proposal on {dims} (0.0–1.0; for implementation_cost and regression_risk, higher = worse). List critical
objections; set "critical": true only if the proposal must not proceed. """ + UNTRUSTED_NOTE + """
Reply with JSON only: {{"reviews": [{{"id": "P01", "scores": {{{dims_json}}}, "objections": ["..."], "critical": false}}]}}"""


def _words(t: str) -> set[str]:
    return {w for w in re.findall(r"[a-z0-9]+", t.lower()) if len(w) > 2}


def _similar(a: str, b: str) -> bool:
    x, y = _words(a), _words(b)
    return bool(x and y) and len(x & y) / len(x | y) >= 0.5


class EvolutionService:
    def __init__(self, rt: "Runtime", coding: CodingAgent | None = None):
        self.rt = rt
        self.s = rt.session
        self.ep = rt.policy.evolution
        self.coding = coding or getattr(rt, "coding", None) or CodingAgent()

    # -------------------------------------------------------------- lifecycle

    def can_start(self, user_id: uuid.UUID, now: datetime) -> str | None:
        if open_round(self.rt, user_id):
            return "a round is already running"
        last = self.s.scalar(select(func.max(EvolutionRound.created_at)).where(EvolutionRound.user_id == user_id))
        if last and now - last < timedelta(hours=self.ep.min_hours_between_rounds):
            return f"the last round started less than {self.ep.min_hours_between_rounds:g}h ago"
        return None

    def start(self, user: User, *, trigger: str, decision: MotivationDecision | None = None, now: datetime | None = None,
              force: bool = False, slate: list[ImprovementProposal] | None = None, problem: dict | None = None) -> EvolutionRound:
        """`slate`: proposals that were already found and reviewed elsewhere (the perpetual task's agents read the code
        and its critic reviewed them) — the round starts at the deterministic controller instead of diagnosing again."""
        now = now or utcnow()
        why = self.can_start(user.id, now)
        if why and not (force and "already running" not in why):
            raise EvolutionError(why)
        self.ensure_v0(user.id, now)
        rnd = EvolutionRound(user_id=user.id, decision_id=decision.id if decision else None, phase="control" if slate else "diagnose",
                             trigger=trigger, problem=problem or ({"hint": (decision.answers or {}).get("problem")} if decision else {}),
                             objective=((decision.answers or {}).get("objective") or {} if decision else {})
                             | ({"slate": [str(p.id) for p in slate]} if slate else {}),
                             budget=decision.budget if decision else {}, log=[], created_at=now)
        self.s.add(rnd)
        self.s.flush()
        for p in slate or []:
            p.last_round_id = rnd.id
        self._log(rnd, "start", f"round started by {trigger}" + (f" with {len(slate)} reviewed proposal(s)" if slate else ""), now)
        self.rt.workflow.enqueue("evolution.step", user_id=user.id, dedupe_key=f"evo:{rnd.id}", payload={"round_id": str(rnd.id)},
                                 priority=120, now=now)
        return rnd

    def _log(self, rnd: EvolutionRound, phase: str, text: str, now: datetime) -> None:
        rnd.log = list(rnd.log or []) + [{"at": now.isoformat(), "phase": phase, "text": text[:400]}]

    def _stop(self, rnd: EvolutionRound, reason: str, now: datetime) -> dict:
        rnd.phase, rnd.stop_reason, rnd.ended_at = "stopped", reason, now
        self._log(rnd, "stopped", reason, now)
        return {"phase": "stopped", "reason": reason}

    def step(self, rnd: EvolutionRound, now: datetime | None = None) -> dict:
        """Run the current phase; queue the next step unless the round has ended."""
        now = now or utcnow()
        user = self.s.get(User, rnd.user_id)
        fn = {"diagnose": self._diagnose, "propose": self._propose, "review": self._review, "control": self._control,
              "implement": self._implement}.get(rnd.phase)
        if fn is None:
            return {"phase": rnd.phase}
        out = fn(rnd, user, now)
        self.s.flush()
        if rnd.phase not in ("done", "stopped"):
            # the step count is part of the key: "implement" runs once per accepted proposal, and the same key as the
            # job running right now would be swallowed as a duplicate — the round would stall after one implementation
            self.rt.workflow.enqueue("evolution.step", user_id=user.id, dedupe_key=f"evo:{rnd.id}:{rnd.phase}:{len(rnd.log or [])}",
                                     payload={"round_id": str(rnd.id)}, priority=120, now=now)
        return out

    def revive(self, user_id: uuid.UUID, now: datetime | None = None, stale_min: float = 20) -> EvolutionRound | None:
        """A round that is open but has no step queued or running (lost job, a restart in between) gets its next step."""
        from pga.db.models import Job
        from pga.db.types import JobStatus
        now = now or utcnow()
        rnd = open_round(self.rt, user_id)
        if rnd is None:
            return None
        live = [j for j in self.s.scalars(select(Job).where(Job.kind == "evolution.step", Job.user_id == user_id,
                                                            Job.status.in_([JobStatus.QUEUED, JobStatus.RUNNING])))
                if (j.payload or {}).get("round_id") == str(rnd.id)]
        last = max([datetime.fromisoformat(e["at"]) for e in rnd.log or [] if e.get("at")] or [rnd.created_at])
        if live or now - last < timedelta(minutes=stale_min):
            return None
        self._log(rnd, rnd.phase, "the round had stalled with no step queued; resumed", now)
        self.rt.workflow.enqueue("evolution.step", user_id=user_id, dedupe_key=f"evo:{rnd.id}:{rnd.phase}:{len(rnd.log or [])}",
                                 payload={"round_id": str(rnd.id)}, priority=120, now=now)
        return rnd

    # -------------------------------------------------------------- A · diagnose

    def _diagnose(self, rnd: EvolutionRound, user: User, now: datetime) -> dict:
        st = r0_state(self.rt, user.id)
        tele = {k: v for k, v in (st.telemetry or {}).items() if not k.startswith("_")}
        fails = recent_failures(self.s, None if self.ep.r0_scope == "system" else user.id, now, self.ep.telemetry_window_days)
        prompt = "\n".join([
            f"Hint from R0's Motivation Forward: {rnd.problem.get('hint') or 'none'}; objective: {rnd.objective or 'none'}",
            "Telemetry (value, samples): " + "; ".join(f"{k}={v.get('value')} (n={v.get('n')})" for k, v in tele.items()),
            "Counts: " + str((st.telemetry or {}).get("_counts", {})),
            "Why R0 tension rose: " + ("; ".join(e.get("why", "") for e in (st.ledger or [])[:5]) or "-"),
            "Recent failures:\n" + ("\n".join(f"- {f['kind']}: {f['error']}" for f in fails) or "none"),
        ])
        data, _, err = _call(self.rt, user, kind="evolution_diagnose", system=DIAGNOSE_SYSTEM, prompt=prompt,
                             why="diagnose before proposing (evolution round)", max_tokens=900, now=now)
        prob = (data or {}).get("problem") if isinstance(data, dict) else None
        if not isinstance(prob, dict) or not prob.get("description"):
            return self._stop(rnd, f"diagnosis failed: {err or 'no problem identified'}", now)
        rnd.problem = {**prob, "hint": rnd.problem.get("hint"), "confidence": clamp01((data or {}).get("confidence"), .5)}
        rnd.phase = "propose"
        self._log(rnd, "diagnose", prob["description"], now)
        return {"phase": "diagnose", "problem": prob["description"]}

    # -------------------------------------------------------------- B · independent proposers → backlog

    def _next_code(self, user_id: uuid.UUID) -> str:
        n = self.s.scalar(select(func.count()).select_from(ImprovementProposal).where(ImprovementProposal.user_id == user_id)) or 0
        return f"P{n + 1:02d}"

    def _propose(self, rnd: EvolutionRound, user: User, now: datetime) -> dict:
        st = r0_state(self.rt, user.id)
        roles = list(PROPOSER_ROLES)[: self.ep.max_proposers]
        existing = list(self.s.scalars(select(ImprovementProposal).where(ImprovementProposal.user_id == user.id)))
        problem = f"Diagnosed problem: {rnd.problem.get('description')}\nEvidence: {rnd.problem.get('evidence')}\n" \
                  f"Affected: {rnd.problem.get('affected_components')}\n" \
                  f"Already in the backlog (do not repeat): {'; '.join(p.title for p in existing) or 'none'}"
        new, refreshed = [], []
        for role in roles:
            strong = role == "architecture" and st.tension >= 0.85          # pay for a strong proposer only when it matters
            data, _, err = _call(self.rt, user, kind="evolution_propose_strong" if strong else "evolution_propose",
                                 system=PROPOSE_SYSTEM.format(role=role, brief=PROPOSER_ROLES[role]), prompt=problem,
                                 why=f"independent proposer ({role})", max_tokens=1200, now=now)
            for it in ((data or {}).get("proposals") or [])[:2]:
                if not isinstance(it, dict) or not str(it.get("title") or "").strip():
                    continue
                title = str(it["title"]).strip()[:160]
                dup = next((p for p in existing + new if _similar(p.title, title)), None)
                if dup is not None:                                    # update evidence instead of re-inventing
                    dup.evidence = list(dup.evidence or []) + [{"round": str(rnd.id), "by": role, "note": str(it.get("change") or "")[:300]}]
                    if dup.status == "REJECTED":
                        continue
                    refreshed.append(dup)
                    continue
                if len(new) >= self.ep.max_new_proposals:
                    continue
                p = ImprovementProposal(user_id=user.id, code=self._next_code(user.id), title=title, problem=str(rnd.problem.get("description"))[:600],
                                        change=str(it.get("change") or "")[:1500], proposer=role, expected_gain=str(it.get("expected_gain") or "")[:400],
                                        expected_cost=str(it.get("expected_cost") or "")[:400], risk=str(it.get("risk") or "")[:400],
                                        evaluation_plan=str(it.get("evaluation_plan") or "")[:600], rollback_condition=str(it.get("rollback_condition") or "")[:400],
                                        files=[str(f)[:200] for f in (it.get("files") or [])][:8], evidence=[{"round": str(rnd.id), "by": role}],
                                        status="NEW", last_round_id=rnd.id, created_at=now)
                self.s.add(p)
                self.s.flush()
                new.append(p)
        slate = (new + [p for p in refreshed if p not in new])
        deferred = [p for p in existing if p.status in ("NEW", "DEFERRED") and p not in slate]
        slate += sorted(deferred, key=lambda p: -p.value)[: max(0, 5 - len(slate))]
        if not slate:
            return self._stop(rnd, "no proposals came out of this round", now)
        for p in slate:
            p.last_round_id = rnd.id
        rnd.objective = {**(rnd.objective or {}), "slate": [str(p.id) for p in slate]}
        rnd.phase = "review"
        self._log(rnd, "propose", f"{len(new)} new, {len(slate) - len(new)} from the backlog: " + ", ".join(f"{p.code} {p.title}" for p in slate), now)
        return {"phase": "propose", "new": len(new), "slate": [p.code for p in slate]}

    def _slate(self, rnd: EvolutionRound) -> list[ImprovementProposal]:
        ids = [uuid.UUID(x) for x in (rnd.objective or {}).get("slate", [])]
        return [p for p in (self.s.get(ImprovementProposal, i) for i in ids) if p is not None]

    # -------------------------------------------------------------- C · specialised review council

    def _review(self, rnd: EvolutionRound, user: User, now: datetime) -> dict:
        slate = self._slate(rnd)
        listing = "\n\n".join(f"{p.code}: {p.title}\nchange: {p.change}\nfiles: {', '.join(p.files) or '?'}\nexpected gain: {p.expected_gain}\n"
                              f"risk: {p.risk}\nevaluation: {p.evaluation_plan}" for p in slate)
        prompt = f"Diagnosed problem: {rnd.problem.get('description')}\nEvidence: {rnd.problem.get('evidence')}\n\nProposals:\n{listing}"
        by_code = {p.code: p for p in slate}
        done = 0
        for key in list(REVIEWERS)[: self.ep.max_reviewers]:
            title, question, dims = REVIEWERS[key]
            data, _, err = _call(self.rt, user, kind="evolution_review",
                                 system=REVIEW_SYSTEM.format(title=title, question=question, dims=", ".join(dims),
                                                             dims_json=", ".join(f'"{d}": 0.0' for d in dims)),
                                 prompt=prompt, why=f"review council ({title})", max_tokens=1200, now=now)
            for it in ((data or {}).get("reviews") or []):
                p = by_code.get(str((it or {}).get("id") or "").strip().upper())
                if p is None:
                    continue
                scores = {d: clamp01((it.get("scores") or {}).get(d), .5) for d in dims}
                self.s.add(ProposalReview(proposal_id=p.id, round_id=rnd.id, reviewer=key, scores=scores,
                                          objections=[str(o)[:300] for o in (it.get("objections") or [])][:5],
                                          critical=bool(it.get("critical")), created_at=now))
                done += 1
        if not done:
            return self._stop(rnd, "the review council returned nothing usable", now)
        rnd.phase = "control"
        self._log(rnd, "review", f"{done} structured reviews from {min(len(REVIEWERS), self.ep.max_reviewers)} reviewers", now)
        return {"phase": "review", "reviews": done}

    # -------------------------------------------------------------- D · evolution controller (deterministic)

    def score(self, p: ImprovementProposal, reviews: list[ProposalReview]) -> tuple[float, dict, list[str]]:
        dims: dict[str, list[float]] = {}
        objections, critical = [], []
        for r in reviews:
            for d, v in (r.scores or {}).items():
                dims.setdefault(d, []).append(float(v))
            objections += r.objections or []
            if r.critical:
                critical.append(r.reviewer)
        avg = {d: round(sum(v) / len(v), 3) for d, v in dims.items()}
        g = lambda k, d=.5: avg.get(k, d)  # noqa: E731
        value = (.2 * g("goal_alignment") + .2 * g("evidence_strength") + .3 * g("expected_gain") + .15 * g("reversibility")
                 - .15 * g("implementation_cost") - .25 * g("regression_risk")) / .6
        return round(max(0.0, min(1.0, value)), 3), {**avg, "critical_by": critical, "objections": objections[:8]}, critical

    def _control(self, rnd: EvolutionRound, user: User, now: datetime) -> dict:
        slate = self._slate(rnd)
        verdicts = []
        for p in slate:
            reviews = list(self.s.scalars(select(ProposalReview).where(ProposalReview.proposal_id == p.id, ProposalReview.round_id == rnd.id)))
            p.value, p.scores, critical = self.score(p, reviews)
            p.last_reviewed_at = now
            protected = [f for f in p.files if any(f == x or f.startswith(x) for x in self.ep.protected_paths)]
            if critical or protected:
                p.status = "REJECTED"
                verdicts.append((p, "REJECT", f"critical objection from {', '.join(critical)}" if critical else f"touches protected {', '.join(protected)}"))
            elif not reviews:
                p.status = "DEFERRED"
                verdicts.append((p, "DEFER", "no reviews"))
        ranked = sorted([p for p in slate if p.status not in ("REJECTED",) and not any(v[0] is p for v in verdicts)], key=lambda p: -p.value)
        accepted = 0
        for p in ranked:
            if p.value >= self.ep.accept_score and accepted < self.ep.max_implementations and self.ep.coding_agent != "none":
                p.status, accepted = "ACCEPTED", accepted + 1
                verdicts.append((p, "IMPLEMENT", f"value {p.value:.2f}"))
            elif p.value >= self.ep.accept_score - 0.1:
                p.status = "DEFERRED"
                verdicts.append((p, "DEFER", f"value {p.value:.2f}" + (" (implementation slots used)" if p.value >= self.ep.accept_score else "")))
            else:
                p.status = "REJECTED"
                verdicts.append((p, "REJECT", f"value {p.value:.2f} < {self.ep.accept_score - 0.1:.2f}"))
        self._log(rnd, "control", "; ".join(f"{p.code} {v} ({why})" for p, v, why in verdicts), now)
        if not accepted:
            rnd.phase, rnd.ended_at = "done", now
            self._log(rnd, "done", "nothing accepted for implementation this round", now)
            return {"phase": "control", "accepted": 0}
        rnd.phase = "implement"
        return {"phase": "control", "accepted": accepted}

    # -------------------------------------------------------------- E/F · implement in isolation, then verify

    def ensure_v0(self, user_id: uuid.UUID, now: datetime) -> AgentVersion:
        v = self.s.scalar(select(AgentVersion).where(AgentVersion.user_id == user_id).order_by(AgentVersion.created_at).limit(1))
        if v is None:
            v = AgentVersion(user_id=user_id, label="v0", status="ACTIVE", note="the agent as it was when R0 first ran", created_at=now)
            self.s.add(v)
            self.s.flush()
        return v

    def active_version(self, user_id: uuid.UUID) -> AgentVersion | None:
        return self.s.scalar(select(AgentVersion).where(AgentVersion.user_id == user_id, AgentVersion.status.in_(["ACTIVE", "CANARY"]))
                             .order_by(AgentVersion.created_at.desc()).limit(1))

    def line(self, user_id: uuid.UUID) -> list[AgentVersion]:
        """The evolution line: verified candidates you have not promoted yet, each built on the one before (oldest
        first). New work stacks on its tip, so evolution goes on while you are away; promoting a version applies it
        together with everything below it."""
        cands = list(self.s.scalars(select(AgentVersion).where(AgentVersion.user_id == user_id, AgentVersion.status == "CANDIDATE")
                                    .order_by(AgentVersion.created_at)))
        by_id = {v.id: v for v in cands}
        best: list[AgentVersion] = []
        for v in reversed(cands):                      # newest first: the longest intact chain wins
            if not (v.verification or {}).get("ok"):
                continue
            chain, cur, ok = [], v, True
            while cur is not None:
                chain.append(cur)
                parent = self.s.get(AgentVersion, cur.parent_id) if cur.parent_id else None
                if parent is None or parent.status in ("ACTIVE", "CANARY", "SUPERSEDED"):
                    break
                if parent.id not in by_id or not (parent.verification or {}).get("ok"):
                    ok = False
                    break
                cur = parent
            if ok and len(chain) > len(best):
                best = chain
        return list(reversed(best))

    def _label(self, user_id: uuid.UUID, parent: AgentVersion) -> str:
        base = parent.label.rstrip("abcdefghijklmnopqrstuvwxyz")
        n = int(base[1:] or 0) + 1
        siblings = self.s.scalar(select(func.count()).select_from(AgentVersion).where(AgentVersion.user_id == user_id,
                                                                                      AgentVersion.parent_id == parent.id)) or 0
        return f"v{n}{'abcdefghijklmnopqrstuvwxyz'[siblings % 26]}"

    def brief(self, p: ImprovementProposal, rnd: EvolutionRound) -> str:
        return "\n".join([
            f"# Accepted improvement {p.code}: {p.title}", "",
            f"Diagnosed problem: {rnd.problem.get('description')}", f"Evidence: {rnd.problem.get('evidence')}", "",
            f"Change to make: {p.change}",
            f"Files you may modify: {', '.join(p.files) or 'only what the change strictly needs under src/pga/ and tests/'}",
            f"Acceptance criteria: {p.evaluation_plan or 'existing tests keep passing; add a focused test for the change'}",
            f"Rollback condition: {p.rollback_condition or '-'}", "",
            "Rules:", "- Implement exactly this change; do not redefine the objective or widen the scope.",
            f"- Never modify: {', '.join(self.ep.protected_paths)}.",
            "- Keep every existing test passing; add or update tests under tests/ for the new behaviour.",
            "- You cannot run commands; the test suite is run for you afterwards.",
            "- When done, reply with a short summary of what you changed and why."])

    def _implement(self, rnd: EvolutionRound, user: User, now: datetime) -> dict:
        """One accepted proposal per step (a coding run plus two test suites must fit inside a job lease)."""
        mine = list(self.s.scalars(select(AgentVersion).where(AgentVersion.round_id == rnd.id)))
        for v in mine:                                     # PGA stopped in the middle of this step last time
            if v.status == "CANDIDATE" and not v.verification:
                v.status, v.note = "FAILED", "interrupted (PGA stopped during implementation)"
                self.coding.discard(v.worktree)
        tries: dict = {}
        for v in mine:
            if v.note.startswith("interrupted"):
                tries[v.proposal_id] = tries.get(v.proposal_id, 0) + 1
        done_ids = {v.proposal_id for v in mine if not v.note.startswith("interrupted") or tries.get(v.proposal_id, 0) >= 2}
        todo = [p for p in self._slate(rnd) if p.status == "ACCEPTED" and p.id not in done_ids]
        if not todo:
            return self._finish_implement(rnd, user, now)
        p = todo[0]
        stack = self.line(user.id)
        parent = stack[-1] if stack else (self.active_version(user.id) or self.ensure_v0(user.id, now))
        label = self._label(user.id, parent)
        v = AgentVersion(user_id=user.id, label=label, parent_id=parent.id, proposal_id=p.id, round_id=rnd.id, status="CANDIDATE", created_at=now)
        self.s.add(v)
        self.s.flush()
        try:
            cand = self.coding.prepare(f"{label}-{str(rnd.id)[:8]}", stack=[(x.label, x.patch) for x in stack])
            v.branch, v.worktree = cand.branch, cand.worktree
            base = (rnd.objective or {}).get("baseline_tests")
            if base is None:                                   # "Current vs Candidate": test the untouched snapshot once per round
                base = self.coding.tests(Path(cand.worktree)).as_dict()
                rnd.objective = {**(rnd.objective or {}), "baseline_tests": base}
                self._log(rnd, "verify", f"baseline suite: {base['passed']} passed, {base['failed']} failed", now)
            baseline = SuiteResult(**base)
            if self.ep.coding_agent == "pool" and not getattr(self.coding, "injected", False):
                # the agent pool's "implement" workflow: Claude Code, else Codex (agents.yaml), editing only the worktree
                from pga.agents import WORKSPACE_WRITE, AgentPool
                from pga.evolution.coding import BRIEF_SYSTEM
                res = AgentPool(self.rt).run("implement", self.brief(p, rnd), user=user, system=BRIEF_SYSTEM, workspace=cand.worktree,
                                             permissions=WORKSPACE_WRITE, timeout_s=self.ep.coding_timeout_s, now=now)
                cand.agent_summary = (f"[{(res.data or {}).get('agent', '?')}] " + (res.text or res.error or ""))[:2000]
                cand = self.coding.collect(cand)
            else:
                cand = self.coding.implement(cand, self.brief(p, rnd), timeout_s=self.ep.coding_timeout_s, max_turns=self.ep.coding_max_turns)
            v.patch, v.files = cand.patch, cand.files
            if not cand.patch:
                raise CodingError("the coding agent made no change")
            v.verification = {**self.coding.verify(cand, baseline, protected=self.ep.protected_paths, max_lines=self.ep.max_patch_lines),
                              "agent_summary": cand.agent_summary}
            if v.verification["ok"]:
                p.status, v.note = "IMPLEMENTED", "passed verification; waiting for your approval to promote"
            else:
                p.status, v.status = "FAILED", "FAILED"
                v.note = "failed verification: " + ", ".join(v.verification["failures"])
        except CodingError as exc:
            p.status, v.status, v.note = "FAILED", "FAILED", str(exc)[:400]
        self._log(rnd, "implement", f"{label} ({p.code}): {v.status} — {v.note}", now)
        return {"phase": "implement", "version": label, "status": v.status}

    def _finish_implement(self, rnd: EvolutionRound, user: User, now: datetime) -> dict:
        passed = list(self.s.scalars(select(AgentVersion).where(AgentVersion.round_id == rnd.id, AgentVersion.status == "CANDIDATE")))
        if passed:
            self.rt.notify.propose(user, self._promotion_notice(passed[0], rnd), now)
        rnd.phase, rnd.ended_at = "done", now
        self._log(rnd, "done", f"{len(passed)} candidate(s) passed verification; promotion needs your approval (max {self.ep.max_promotions})", now)
        return {"phase": "done", "candidates": [v.label for v in passed]}

    def _promotion_notice(self, v: AgentVersion, rnd: EvolutionRound) -> Proposal:
        p = self.s.get(ImprovementProposal, v.proposal_id)
        return Proposal(kind=CommKind.QUESTION, reasons=[NotifyReason.DECISION_REQUIRED],
                        title_en=f"R0 has a verified improvement ready: {v.label} — {p.title if p else ''}",
                        body_en=f"It passed verification ({v.verification.get('candidate_tests', {}).get('passed')} tests passing, "
                                f"{len(v.files)} files changed: {', '.join(v.files[:4])}). Promote applies the patch to PGA's code "
                                f"(restart PGA afterwards) and starts a {self.ep.canary_hours:g}-hour trial; Reject discards it.",
                        options=["Promote", "Reject"], dedupe_key=f"evo-candidate:{v.id}")

    # -------------------------------------------------------------- promotion, canary, rollback

    def promote(self, v: AgentVersion, now: datetime | None = None) -> AgentVersion:
        now = now or utcnow()
        if v.status != "CANDIDATE" or not (v.verification or {}).get("ok"):
            raise EvolutionError("only a verified candidate can be promoted")
        promoted_this_round = self.s.scalar(select(func.count()).select_from(AgentVersion).where(
            AgentVersion.round_id == v.round_id, AgentVersion.promoted_at.is_not(None))) or 0
        if promoted_this_round >= self.ep.max_promotions:
            raise EvolutionError(f"at most {self.ep.max_promotions} promotion(s) per round")
        below, cur = [], v
        while cur.parent_id:                               # on the evolution line: everything below it comes along
            cur = self.s.get(AgentVersion, cur.parent_id)
            if cur is None or cur.status != "CANDIDATE":
                break
            below.insert(0, cur)
        applied = []
        try:
            for x in below + [v]:
                self.coding.apply(x.patch)
                applied.append(x)
        except CodingError as exc:
            for x in reversed(applied):
                self.coding.apply(x.patch, reverse=True)
            raise EvolutionError(f"could not apply {x.label}: {exc}") from exc
        for x in below:
            x.status, x.promoted_at, x.note = "SUPERSEDED", now, f"promoted together with {v.label}"
            px = self.s.get(ImprovementProposal, x.proposal_id) if x.proposal_id else None
            if px:
                px.status = "PROMOTED"
        st = r0_state(self.rt, v.user_id)
        prev = self.active_version(v.user_id)
        if prev and prev.id != v.id:
            prev.status = "SUPERSEDED"
        v.status, v.promoted_at = "CANARY", now
        v.canary_until = now + timedelta(hours=self.ep.canary_hours)
        v.baseline = {k: x for k, x in (st.telemetry or {}).items()}
        p = self.s.get(ImprovementProposal, v.proposal_id)
        if p:
            p.status = "PROMOTED"
        v.note = "promoted to canary; restart PGA to load the new code"
        self.s.flush()
        return v

    def answer(self, dedupe_key: str | None, text: str, now: datetime | None = None) -> str | None:
        """R0 has no UI of its own: the user decides through notification buttons. Returns what was done."""
        if not dedupe_key or ":" not in dedupe_key:
            return None
        kind, _, vid = dedupe_key.partition(":")
        if kind not in ("evo-candidate", "evo-canary"):
            return None
        try:
            v = self.s.get(AgentVersion, uuid.UUID(vid))
        except ValueError:
            return None
        if v is None:
            return None
        t = (text or "").strip().lower()
        if kind == "evo-candidate" and v.status == "CANDIDATE":
            if "promote" in t or "推广" in t:
                self.promote(v, now)
                return "promoted"
            if "reject" in t or "拒绝" in t:
                self.reject(v)
                return "rejected"
        if kind == "evo-canary" and v.status == "CANARY":
            if "roll" in t or "回滚" in t:
                self.rollback(v, now)
                return "rolled back"
            if "keep" in t or "保留" in t:
                v.status, v.note = "ACTIVE", "kept by you despite the canary warning"
                self.s.flush()
                return "kept"
        return None

    def reject(self, v: AgentVersion) -> AgentVersion:
        if v.status != "CANDIDATE":
            raise EvolutionError("only a candidate can be rejected")
        v.status, v.note = "REJECTED", "rejected by you"
        p = self.s.get(ImprovementProposal, v.proposal_id)
        if p:
            p.status = "REJECTED"
        self.coding.discard(v.worktree)
        above = [v.id]
        while above:                                       # what was built on it on the evolution line goes too
            kids = list(self.s.scalars(select(AgentVersion).where(AgentVersion.parent_id.in_(above), AgentVersion.status == "CANDIDATE")))
            for k in kids:
                k.status, k.note = "REJECTED", f"built on {v.label}, which you rejected"
                pk = self.s.get(ImprovementProposal, k.proposal_id) if k.proposal_id else None
                if pk:
                    pk.status = "DEFERRED"             # the idea may still be good; it comes back on a new base
                self.coding.discard(k.worktree)
            above = [k.id for k in kids]
        self.s.flush()
        return v

    def rollback(self, v: AgentVersion, now: datetime | None = None) -> AgentVersion:
        if v.status not in ("CANARY", "ACTIVE") or not v.patch:
            raise EvolutionError("only a promoted version with a patch can be rolled back")
        self.coding.apply(v.patch, reverse=True)
        v.status, v.note = "ROLLED_BACK", "rolled back; restart PGA to load the previous code"
        parent = self.s.get(AgentVersion, v.parent_id) if v.parent_id else None
        if parent:
            parent.status = "ACTIVE"
        p = self.s.get(ImprovementProposal, v.proposal_id)
        if p:
            p.status = "ROLLED_BACK"
        self.s.flush()
        return v

    def canary_check(self, user_id: uuid.UUID, now: datetime) -> list[dict]:
        """After the canary window, keep the version if no watched signal got materially worse; otherwise ask."""
        from pga.evolution.telemetry import SIGNALS
        out = []
        st = r0_state(self.rt, user_id)
        for v in self.s.scalars(select(AgentVersion).where(AgentVersion.user_id == user_id, AgentVersion.status == "CANARY",
                                                           AgentVersion.canary_until <= now)):
            worse = []
            for k, sig in SIGNALS.items():
                b, c = (v.baseline or {}).get(k, {}), (st.telemetry or {}).get(k, {})
                if b.get("value") is None or c.get("value") is None or c.get("n", 0) < sig.min_n:
                    continue
                if sig.severity(c["value"], c["n"]) > sig.severity(b["value"], max(b.get("n", 0), sig.min_n)) + 0.2:
                    worse.append(f"{sig.label_zh} {b['value']:.2f}→{c['value']:.2f}")
            if worse:
                v.note = "canary regressed: " + "; ".join(worse) + " — consider rolling back"
                user = self.s.get(User, user_id)
                self.rt.notify.propose(user, Proposal(kind=CommKind.QUESTION, reasons=[NotifyReason.DECISION_REQUIRED],
                                                      title_en=f"{v.label} made things worse during its canary",
                                                      body_en=v.note, options=["Roll back", "Keep"], dedupe_key=f"evo-canary:{v.id}"), now)
            else:
                v.status, v.note = "ACTIVE", "canary passed; now active"
            out.append({"version": v.label, "status": v.status, "worse": worse})
        self.s.flush()
        return out
