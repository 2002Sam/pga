"""Hermes-style self-improvement (spec §12, Phase 3).

    task execution → outcome → reflection (lesson) → candidate skill → evaluation
    → version → activation → future reuse → regression watch → rollback

Safeguards, each enforced here rather than left to a prompt:
  * every skill is versioned; a revision is a new row whose parent is kept;
  * a lesson only becomes a rule after `min_support` episodes and a passing eval,
    so one failed (or lucky) episode never turns into a permanent rule;
  * similar lessons are merged into one skill (MinHash), not stacked;
  * activation is audited, and rollback reactivates the parent version;
  * a version that does worse than its parent over `regression_window` uses is
    rolled back automatically;
  * GLOBAL / USER / PROJECT scopes are separate: a user's skill is never shown to
    anyone else, and only the user can promote one to GLOBAL.
"""

from __future__ import annotations

import logging
import re
import uuid
from dataclasses import dataclass
from datetime import datetime
from typing import TYPE_CHECKING

import json

from sqlalchemy import Text, and_, cast, literal, or_, select
from sqlalchemy.dialects.postgresql import JSONB
from sqlalchemy.orm import Session

from pga import audit
from pga.agent.common import UNTRUSTED_NOTE, ModelOutputError, clamp01, parse_json
from pga.allocator import Estimates, Justification, RunRequest
from pga.db.models import Responsibility, Skill, SkillEpisode, SkillEval
from pga.db.types import Origin, SkillScope as Sc, SkillStatus as St, utcnow
from pga.tension.fingerprint import MinHasher, shingles, similarity

if TYPE_CHECKING:
    from pga.runtime import Runtime

log = logging.getLogger("pga.skills")

MARKER = "PGA_SKILL_EVAL"
EVAL_SYSTEM = f"""{MARKER}
You evaluate a candidate skill — a short reusable instruction for the user's research agent — against
past episodes of the same kind of work. For each episode, judge whether following the skill would have
made the outcome better (1), made no difference (0.5) or made it worse (0). Penalise skills that are
vague, over-general from one case, or that would make the agent interrupt the user more. {UNTRUSTED_NOTE}

Reply with JSON only: {{"scores": [0.0-1.0, ...], "verdict": "one sentence"}}"""

_HASHER = MinHasher(64)


class SkillError(ValueError):
    pass


@dataclass
class EvalResult:
    skill_id: uuid.UUID
    score: float
    passed: bool
    activated: bool
    evaluator: str
    reason: str = ""


def fingerprint(text: str) -> list[int]:
    return _HASHER.signature(shingles(text, 1, 3))   # bag of words: lessons are short


def skill_name(lesson: str) -> str:
    words = re.findall(r"[a-z0-9]+", lesson.lower())
    return "-".join(words[:6])[:120] or "lesson"


class SkillService:
    def __init__(self, session: Session, rt: "Runtime"):
        self.session = session
        self.rt = rt
        self.sp = rt.policy.skills

    # ---------------------------------------------------------------- visibility (scope isolation)

    def visible(self, user_id: uuid.UUID, responsibility_id: uuid.UUID | None, task_kind: str,
                statuses: set[St] | None = None) -> list[Skill]:
        scope_ok = or_(Skill.scope == Sc.GLOBAL, and_(Skill.scope == Sc.USER, Skill.owner_id == user_id))
        if responsibility_id:
            scope_ok = or_(scope_ok, and_(Skill.scope == Sc.PROJECT, Skill.owner_id == responsibility_id))
        q = select(Skill).where(scope_ok, Skill.task_kind == task_kind)
        if statuses:
            q = q.where(Skill.status.in_(statuses))
        return list(self.session.scalars(q.order_by(Skill.eval_score.desc().nullslast(), Skill.created_at)))

    def context(self, r: Responsibility, task_kind: str = "research") -> tuple[str, list[uuid.UUID]]:
        """Active skills to show a step, and their ids (so the episode can credit or blame them)."""
        skills = self.visible(r.user_id, r.id, task_kind, {St.ACTIVE})[: self.sp.context_max]
        text = "\n".join(f"- [{s.name} v{s.version}] {s.instructions_en}" for s in skills)
        return text, [s.id for s in skills]

    # ---------------------------------------------------------------- experience → candidates

    def record_episode(self, *, user_id: uuid.UUID, task_kind: str, success: float, lesson: str = "",
                       responsibility_id: uuid.UUID | None = None, run_id: uuid.UUID | None = None,
                       used_skill_ids: list[uuid.UUID] | None = None, scope: Sc = Sc.USER,
                       now: datetime | None = None) -> SkillEpisode:
        now = now or utcnow()
        ep = SkillEpisode(user_id=user_id, responsibility_id=responsibility_id, run_id=run_id, task_kind=task_kind,
                          success=clamp01(success), lesson_en=(lesson or "").strip()[:2000],
                          used_skill_ids=[str(i) for i in used_skill_ids or []], created_at=now)
        self.session.add(ep)
        self.session.flush()
        if ep.lesson_en:
            owner = user_id if scope == Sc.USER else responsibility_id if scope == Sc.PROJECT else None
            ep.lesson_skill_id = self._absorb_lesson(ep, scope, owner, now).id
        for sid in used_skill_ids or []:
            self._watch_regression(sid, now)
        self.session.flush()
        return ep

    def _absorb_lesson(self, ep: SkillEpisode, scope: Sc, owner: uuid.UUID | None, now: datetime) -> Skill:
        fp = fingerprint(ep.lesson_en)
        same_scope = list(self.session.scalars(select(Skill).where(
            Skill.scope == scope, Skill.owner_id == owner if owner else Skill.owner_id.is_(None),
            Skill.task_kind == ep.task_kind, Skill.status.in_([St.CANDIDATE, St.ACTIVE]))))
        best, best_sim = None, 0.0
        for s in same_scope:
            sim = similarity(fp, s.fingerprint or fingerprint(s.instructions_en))
            if sim > best_sim:
                best, best_sim = s, sim
        if best is not None and best_sim >= self.sp.similarity:
            best.support += 1          # the same lesson again: more support, not another rule (dedupe)
            return best
        s = Skill(scope=scope, owner_id=owner, name=skill_name(ep.lesson_en), version=1, task_kind=ep.task_kind,
                  instructions_en=ep.lesson_en, status=St.CANDIDATE, support=1, fingerprint=fp, created_at=now)
        while self.session.scalar(select(Skill.id).where(Skill.scope == scope, Skill.name == s.name,
                                                         Skill.owner_id == owner if owner else Skill.owner_id.is_(None))):
            s.name = f"{s.name[:110]}-{uuid.uuid4().hex[:4]}"
        self.session.add(s)
        self.session.flush()
        audit.record(self.session, kind="skill.candidate", entity_type="skill", entity_id=s.id, actor=Origin.AGENT,
                     user_id=ep.user_id, name=s.name, scope=scope.value)
        return s

    def revise(self, skill: Skill, instructions_en: str, *, actor: Origin, now: datetime | None = None) -> Skill:
        """A new version of a skill; it starts as a CANDIDATE and must pass its own eval."""
        if actor == Origin.EXTERNAL:
            raise SkillError("external content cannot change skills")
        now = now or utcnow()
        top = self.session.scalar(select(Skill.version).where(
            Skill.scope == skill.scope, Skill.name == skill.name,
            Skill.owner_id == skill.owner_id if skill.owner_id else Skill.owner_id.is_(None))
            .order_by(Skill.version.desc()).limit(1)) or skill.version
        s = Skill(scope=skill.scope, owner_id=skill.owner_id, name=skill.name, version=top + 1,
                  task_kind=skill.task_kind, instructions_en=instructions_en.strip()[:2000], status=St.CANDIDATE,
                  support=skill.support, fingerprint=fingerprint(instructions_en), parent_version_id=skill.id,
                  created_at=now)
        self.session.add(s)
        self.session.flush()
        audit.record(self.session, kind="skill.revised", entity_type="skill", entity_id=s.id, actor=actor,
                     parent=str(skill.id), version=s.version)
        return s

    # ---------------------------------------------------------------- evaluation

    def due_for_eval(self, user_id: uuid.UUID) -> list[Skill]:
        out = []
        for s in self.visible(user_id, None, "research", {St.CANDIDATE}):
            if s.support < self.sp.min_support:
                continue
            last = self.session.scalar(select(SkillEval.created_at).where(SkillEval.skill_id == s.id)
                                       .order_by(SkillEval.created_at.desc()).limit(1))
            if last is None:
                out.append(s)
        return out

    def cases(self, skill: Skill, user_id: uuid.UUID) -> list[SkillEpisode]:
        return list(self.session.scalars(select(SkillEpisode).where(
            SkillEpisode.user_id == user_id, SkillEpisode.task_kind == skill.task_kind)
            .order_by(SkillEpisode.created_at.desc()).limit(self.sp.max_eval_cases)))

    def evaluate(self, skill: Skill, user_id: uuid.UUID, now: datetime | None = None) -> EvalResult:
        """Judge a candidate against past episodes. Activation needs support AND a passing score."""
        now = now or utcnow()
        if skill.status != St.CANDIDATE:
            raise SkillError(f"only candidates are evaluated (skill is {skill.status.value})")
        cases = self.cases(skill, user_id)
        if skill.support < self.sp.min_support or len(cases) < self.sp.min_support:
            return EvalResult(skill.id, 0.0, False, False, "none",
                              f"needs {self.sp.min_support} supporting episodes before it can be judged")
        rt = self.rt
        decision = rt.allocator.allocate(RunRequest(
            user_id=user_id, kind="self_improvement",
            justification=Justification(
                why_now=f"candidate skill '{skill.name}' has {skill.support} supporting episodes",
                expected_gain="decide whether this lesson should guide future research steps",
                decision_affected="whether the skill is activated",
                budget={"max_units": 30_000, "max_output_tokens": 400},
                stop_condition="every case scored once"),
            estimates=Estimates(information_gain=.4, decision_impact=.4, user_relevance=.3, reuse_value=.8,
                                input_tokens=1500 + 300 * len(cases), output_tokens=200)), now=now)
        support_rate = sum(c.success for c in cases) / len(cases)
        if decision.allowed and decision.tier:
            with rt.runs.track(decision) as guard:
                prompt = (f"<skill name=\"{skill.name}\" version=\"{skill.version}\">\n{skill.instructions_en}\n</skill>\n\n"
                          + "\n".join(f"<episode n=\"{i + 1}\" outcome=\"{c.success:.2f}\">\n{c.lesson_en or '(no lesson)'}"
                                      "\n</episode>" for i, c in enumerate(cases)))
                res = rt.router.complete(decision.tier, system=EVAL_SYSTEM,
                                         messages=[{"role": "user", "content": prompt}],
                                         max_tokens=decision.limits.get("max_output_tokens", 400),
                                         usage=guard.usage_context())
                try:
                    data = parse_json(res.text)
                    scores = [clamp01(x, .5) for x in data.get("scores") or []][: len(cases)]
                    verdict = str(data.get("verdict") or "")[:300]
                except ModelOutputError:
                    scores, verdict = [], "judge reply unparseable"
                guard.stop(f"evaluated skill {skill.name} v{skill.version}")
                run_id = guard.run.id
            judge = sum(scores) / len(scores) if scores else 0.0
            score, evaluator = (.7 * judge + .3 * support_rate) if scores else 0.0, f"llm:tier{decision.tier}"
        else:
            # no model budget: deterministic fallback — how often the work this lesson came from went well
            score, evaluator, verdict, run_id, scores = support_rate, "rule", "; ".join(decision.reasons), None, []
        passed = score >= self.sp.eval_threshold
        self.session.add(SkillEval(skill_id=skill.id, score=score, n_cases=len(cases), passed=passed,
                                   evaluator=evaluator, run_id=run_id, created_at=now,
                                   detail={"scores": scores, "support_rate": round(support_rate, 3), "verdict": verdict}))
        skill.eval_score = score
        self.session.flush()
        activated = False
        if passed and self.sp.auto_activate:
            self.activate(skill, actor=Origin.SYSTEM, now=now)
            activated = True
        elif not passed:
            self._retire(skill, St.DEPRECATED, f"eval {score:.2f} below {self.sp.eval_threshold}", Origin.SYSTEM, now)
        return EvalResult(skill.id, score, passed, activated, evaluator, verdict)

    # ---------------------------------------------------------------- activation / rollback

    def activate(self, skill: Skill, *, actor: Origin, now: datetime | None = None) -> Skill:
        if actor == Origin.EXTERNAL:
            raise SkillError("external content cannot activate skills")
        last = self.session.scalar(select(SkillEval).where(SkillEval.skill_id == skill.id)
                                   .order_by(SkillEval.created_at.desc()).limit(1))
        if last is None or not last.passed:
            raise SkillError("a skill must pass an evaluation before activation")
        now = now or utcnow()
        for old in self._versions(skill):
            if old.id != skill.id and old.status == St.ACTIVE:
                self._retire(old, St.DEPRECATED, f"superseded by v{skill.version}", actor, now)
        skill.status = St.ACTIVE
        skill.activated_at = now
        skill.retired_at = skill.retired_reason = None
        self.session.flush()
        audit.record(self.session, kind="skill.activated", entity_type="skill", entity_id=skill.id, actor=actor,
                     name=skill.name, version=skill.version, eval_score=skill.eval_score)
        return skill

    def rollback(self, skill: Skill, *, actor: Origin, reason: str = "", now: datetime | None = None) -> Skill | None:
        """Retire this version and bring back the one it replaced (if any). Returns the version now active."""
        if actor == Origin.EXTERNAL:
            raise SkillError("external content cannot roll back skills")
        now = now or utcnow()
        self._retire(skill, St.ROLLED_BACK, reason or "rolled back", actor, now)
        parent = self.session.get(Skill, skill.parent_version_id) if skill.parent_version_id else None
        if parent is not None and parent.status in {St.DEPRECATED, St.ACTIVE}:
            parent.status = St.ACTIVE
            parent.activated_at = now
            parent.retired_at = parent.retired_reason = None
        self.session.flush()
        return parent

    def promote_to_global(self, skill: Skill, *, actor: Origin, now: datetime | None = None) -> Skill:
        """A user's own skill becomes everyone's only by the user's explicit choice."""
        if actor != Origin.USER:
            raise SkillError("only the user can share a skill globally")
        if skill.status != St.ACTIVE:
            raise SkillError("only an active skill can be shared")
        now = now or utcnow()
        g = Skill(scope=Sc.GLOBAL, owner_id=None, name=skill.name, version=1, task_kind=skill.task_kind,
                  instructions_en=skill.instructions_en, eval_score=skill.eval_score, status=St.CANDIDATE,
                  support=skill.support, fingerprint=skill.fingerprint, created_at=now)
        self.session.add(g)
        self.session.flush()
        self.session.add(SkillEval(skill_id=g.id, score=skill.eval_score or 0, n_cases=0, passed=True,
                                   evaluator=f"inherited:{skill.id}", created_at=now))
        self.session.flush()
        return self.activate(g, actor=actor, now=now)

    def _versions(self, skill: Skill) -> list[Skill]:
        return list(self.session.scalars(select(Skill).where(
            Skill.scope == skill.scope, Skill.name == skill.name,
            Skill.owner_id == skill.owner_id if skill.owner_id else Skill.owner_id.is_(None))))

    def _retire(self, skill: Skill, status: St, reason: str, actor: Origin, now: datetime) -> None:
        skill.status = status
        skill.retired_at = now
        skill.retired_reason = reason[:500]
        audit.record(self.session, kind=f"skill.{status.value.lower()}", entity_type="skill", entity_id=skill.id,
                     actor=actor, name=skill.name, version=skill.version, reason=reason)

    def success_rate(self, skill_id: uuid.UUID, since: datetime | None = None, limit: int | None = None) -> tuple[float, int]:
        q = select(SkillEpisode.success).where(
            cast(SkillEpisode.used_skill_ids, JSONB).op("@>")(cast(literal(json.dumps([str(skill_id)]), Text), JSONB)))
        if since:
            q = q.where(SkillEpisode.created_at >= since)
        rows = list(self.session.scalars(q.order_by(SkillEpisode.created_at.desc()).limit(limit)))
        return (sum(rows) / len(rows) if rows else 0.0), len(rows)

    def _watch_regression(self, skill_id, now: datetime) -> None:
        skill = self.session.get(Skill, uuid.UUID(str(skill_id)))
        if skill is None or skill.status != St.ACTIVE or not skill.parent_version_id:
            return
        rate, n = self.success_rate(skill.id, since=skill.activated_at)
        if n < self.sp.regression_window:
            return
        parent_rate, pn = self.success_rate(skill.parent_version_id)
        if pn and rate < parent_rate - self.sp.regression_margin:
            self.rollback(skill, actor=Origin.SYSTEM, now=now,
                          reason=f"regression: success {rate:.2f} vs parent {parent_rate:.2f} over {n} uses")
