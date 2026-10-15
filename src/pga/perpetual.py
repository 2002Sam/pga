"""Perpetual tasks (永续任务): an aim its team works on without stopping, paced by pressure.

A perpetual task is an aim, optionally a project folder, and a team (teams.py). It never finishes. Its own thread
(`PerpetualRunner`, started with the worker) runs one cycle after another; each cycle measures the pressure on
every channel and does the one that pulls hardest:

    think        协调者 reads the project and the board and asks the questions whose answers would improve it most
    investigate  研究员 / 审阅者 answer the top question by reading the code (read-only); a concrete, safe improvement
                 becomes a proposal in the evolution backlog, and new questions come out of the answer
    evolve       审阅者 reviews the proposals, then an Evolution Round (evolution/round.py) implements the accepted
                 ones in an isolated worktree, runs the full test suite and puts each verified candidate on the
                 evolution line — stacked on the ones before it. Your live code only changes when you promote.
    reflect      审阅者 looks back over the board: what was learned, which questions are stale, what to ask you

Pressure (张力) is the core: every channel has a pull between 0 and 1 —

    think        hunger for questions: high when few questions are open
    investigate  open questions waiting, led by the most important one
    evolve       proposals waiting for review/implementation (strong: this is where the project actually changes),
                 plus R0's own tension (self-improvement pressure)
    reflect      cycles since the last look back

— and stagnation (time since the last real progress) adds to all of them. The pressure never falls below a floor
while the task runs: for a perpetual task, working is the normal state.

How much it may do on its own is your choice, per motivation (`autonomy`):

    free         完全自由   it thinks, answers, evolves and checks itself without stopping; verified code changes are
                            promoted on their own (as a canary that rolls back by itself if things get worse)
    checkpoint   检查点     it thinks and investigates for `checkpoint_every` cycles, then stops and reports what it
                            learned, its overall direction and the next steps as options. Nothing is implemented until
                            you approve; you continue, adjust (your words become guidance) or stop. (default)
    driven       用户驱动   it does nothing on its own; it works when you ask (the conversation in the console)

Rest is bounded: the task rests only when the pressure is below the rest line, and its total rest (including the
short breath between cycles and any back-off after an error) stays under `max_rest_ratio` (10%) of its working
time. It stops only when the agents' quota is used up — every agent it may use is exhausted or below the reserve
you keep for yourself — and then waits for the earliest reset; that wait is counted apart from rest. It works on
subscription quotas only (Claude Code, Codex/ChatGPT, Hermes, CodeBuddy…); pay-per-call models are left out unless
you allow them (`use_paid`), so running without end never runs up a bill.
"""

from __future__ import annotations

import logging
import random
import re
import subprocess
import threading
import time
import uuid
from datetime import datetime, timedelta
from pathlib import Path
from typing import TYPE_CHECKING, Any, Callable

from sqlalchemy import func, select

from pga.agent.common import ModelOutputError, clamp01, parse_json
from pga.db.models import Aim, AimNote, EvolutionRound, ImprovementProposal, PerpetualTask, Project, ProposalReview, User
from pga.db.types import CommKind, NotifyReason, utcnow

if TYPE_CHECKING:
    from sqlalchemy.orm import Session

    from pga.runtime import Runtime

log = logging.getLogger("pga.perpetual")

DEFAULTS: dict[str, Any] = {
    "max_rest_ratio": 0.10,     # total rest ≤ 10% of working time
    "reserve": 0.10,            # leave this share of every agent's quota for you
    "use_paid": False,          # pay-per-call models (PGA's own API model, http agents) only when you allow it
    "evolve": True,             # may change the code (only via the evolution line; you promote)
    "max_line": 6,              # unpromoted candidates on the line before evolving waits for you
    "open_target": 5,           # questions it likes to have open
    "max_open": 14,
    "reflect_every": 8,         # cycles
    "breath_s": 3,              # between cycles (counted as rest)
    "rest_line": 0.35,          # below this pressure it may rest…
    "rest_max_s": 900,          # …for at most this long at a time
    "error_backoff_s": 30,
    "quota_recheck_s": 1800,    # when a reset time is unknown
    "autonomy": "checkpoint",   # free | checkpoint | driven — how much it may do before you look
    "checkpoint_every": 6,      # checkpoint: cycles of thinking before it reports to you and waits
    "auto_promote": True,       # free: verified changes go live on their own (canary, rolls back on regression)
    "alloc": {},                # how the work is shared among agents (pga.allocation): your weights, preferences, parallelism
}
AUTONOMY = ("free", "checkpoint", "driven")
AUTONOMY_ZH = {"free": "完全自由", "checkpoint": "检查点", "driven": "用户驱动"}
FLOOR = 0.2
PAID = {"llm", "http"}          # billed per call; the subscriptions (Claude Code, Codex/ChatGPT, Hermes, CodeBuddy) have quotas
CHANNELS = ("think", "investigate", "evolve", "reflect")
PHASE_ZH = {"think": "思考：提出问题", "investigate": "研究：回答问题", "evolve": "进化：审核并实现改进", "reflect": "回顾：整理和反思",
            "rest": "休息", "quota": "等额度重置", "error": "出错后稍等", "starting": "启动中", "paused": "已暂停", "stopped": "已停止",
            "checkpoint": "检查点：等你看", "driven": "用户驱动：等你的要求", "promote": "推广已验证的改进"}
PROTECTED_NOTE = ("permissions, the user's aims/motivation, safety policy, spending or publishing authority, migrations, "
                  "the evolution loop itself (src/pga/evolution/), src/pga/policy.yaml, src/pga/config.py, tests/conftest.py")

THINK = """You are {role} on a perpetual task. The task never ends: the team keeps thinking about the project, asking the
questions whose answers would improve it most, answering them, and evolving the project. {where}
Look at the project and the board below. Ask up to 3 NEW questions that are not already on the board (open or answered).
Good questions are concrete, answerable, and lead to a real improvement toward the aim — about bugs, weak spots,
missing capabilities, what the user actually needs, how similar systems solve it. Kinds: code (answer by reading the
code), product (answer by reasoning about the user's aim), research (needs outside knowledge), user (only the user
can answer — use rarely, at most one). Write "q" and "why" in {lang}.
Reply with JSON only: {{"questions": [{{"q": "...", "why": "...", "kind": "code|product|research|user", "priority": 0.0-1.0}}],
"insight": "optional one-sentence observation in {lang}, or empty"}}"""

INVESTIGATE = """You are {role} on a perpetual task. Answer ONE question about the project. {where}
Be concrete; cite the files you rely on. {proposal_rule}
Write "answer" in {lang} (at most 250 words). Follow-up questions only if the answer opened something new (at most 2).
Reply with JSON only: {{"answer": "...", "evidence": ["path or source"], "confidence": 0.0-1.0,
"proposal": null or {{"title": "≤8 words, English", "change": "what to change, concretely (English)", "files": ["src/pga/…"],
"expected_gain": "...", "risk": "...", "evaluation_plan": "how a test shows it works", "rollback_condition": "..."}},
"follow_up": [{{"q": "...", "why": "...", "kind": "code|product|research|user", "priority": 0.0-1.0}}]}}"""

PROPOSAL_RULE = ("If the answer shows a concrete, small, safe improvement to PGA's code, add it as a proposal: it is reviewed, "
                 "implemented in an isolated copy, tested with the full suite, and reaches the live code only when the user "
                 f"approves. Never propose touching: {PROTECTED_NOTE}. Otherwise proposal is null.")
NO_PROPOSAL_RULE = "Set proposal to null; put any suggestion for the project in the answer."

REVIEW = """You are {role} on a perpetual task, reviewing proposed changes to PGA's own code before an isolated coding agent
implements them (the full test suite runs afterwards and the user approves before anything reaches the live code).
{where} Check each proposal against the code: is the problem real, will the change help, what could break?
Mark "critical": true if it must not proceed (unsafe, touches {protected}, expands autonomy or permissions, or is wrong).
Scores 0.0–1.0 (implementation_cost and regression_risk: higher = worse).
Reply with JSON only: {{"reviews": [{{"id": "P01", "scores": {{"goal_alignment": 0.0, "evidence_strength": 0.0, "expected_gain": 0.0,
"implementation_cost": 0.0, "regression_risk": 0.0, "reversibility": 0.0}}, "objections": ["..."], "critical": false}}]}}"""

CHECKPOINT = """You are {role} on a long-running task for the user's motivation. The team has been thinking on its own for a
while; now it stops and reports to the user, who decides whether the direction is right before anything is done.
Read the board below (questions, answers, insights, proposals since the last checkpoint). Write in {lang}:
- "summary": what the team found out (≤150 words, concrete, cite question codes like Q12)
- "direction": the overall approach it would take next and why (≤100 words)
- "proposals": for each pending proposal listed, whether you recommend implementing it now
- "options": 2–4 concrete ways forward the user can pick from (the first one = your recommendation)
- "question": the one thing you most need the user to judge (or empty)
Reply with JSON only: {{"summary": "...", "direction": "...", "proposals": [{{"code": "P07", "recommend": true, "why": "..."}}],
"options": [{{"label": "≤12 words", "detail": "≤40 words"}}], "question": ""}}"""

REFLECT = """You are {role} on a perpetual task. Look back over the board: what has the team learned, what changed, which
open questions are stale or answered already (drop them), which matter most now (re-prioritise), and is there one thing
only the user can decide? Write "summary" and "ask_user" in {lang}; ask_user may be empty.
Reply with JSON only: {{"summary": "≤150 words", "drop": ["Q3"], "priorities": {{"Q5": 0.9}}, "ask_user": ""}}"""


def _cjk_grams(t: str) -> set[str]:
    t = re.sub(r"\s+", "", t.lower())
    words = set(re.findall(r"[a-z0-9]{3,}", t))
    han = re.sub(r"[^一-鿿]", "", t)
    return words | {han[i:i + 2] for i in range(len(han) - 1)}


def self_autonomy(rt: "Runtime", user_id: uuid.UUID) -> str:
    """How free PGA's own motivation is (the perpetual task working in PGA's repository); checkpoint when there is none."""
    eng = Perpetual(rt)
    for t in rt.session.scalars(select(PerpetualTask).where(PerpetualTask.user_id == user_id)):
        if eng.self_project(t):
            mode = eng.cfg(t)["autonomy"]
            return mode if mode in AUTONOMY else "checkpoint"
    return "checkpoint"


def approved(p: ImprovementProposal) -> bool:
    """You approved this proposal at a checkpoint."""
    return any(isinstance(e, dict) and e.get("approved_by") == "user" for e in (p.evidence or []))


def alike(a: str, b: str) -> bool:
    x, y = _cjk_grams(a), _cjk_grams(b)
    return bool(x and y) and len(x & y) / len(x | y) >= 0.5


def snapshot(path: str | None) -> str:
    """What the project looks like now: its recent history, uncommitted changes and top-level files."""
    if not path or not Path(path).is_dir():
        return ""
    def git(*a: str) -> str:
        try:
            return subprocess.run(["git", *a], cwd=path, capture_output=True, text=True, timeout=20).stdout.strip()
        except (OSError, subprocess.SubprocessError):
            return ""
    top = sorted(p.name + ("/" if p.is_dir() else "") for p in Path(path).iterdir() if not p.name.startswith("."))[:40]
    parts = [f"<project path=\"{path}\">", "top level: " + ", ".join(top)]
    if (Path(path) / ".git").exists():
        parts += ["recent commits:\n" + git("log", "--oneline", "-12"), "uncommitted:\n" + (git("status", "--short")[:800] or "none")]
    return "\n".join(parts) + "\n</project>"


class Perpetual:
    def __init__(self, rt: "Runtime", pool=None, commit: Callable[[], None] | None = None, coding=None):
        from pga.agents.pool import AgentPool
        from pga.agents.routing import AgentRouter
        from pga.teams import TeamService
        self.rt, self.s = rt, rt.session
        self.pool = pool or AgentPool(rt)
        self.router = AgentRouter(rt, self.pool)
        self.team = TeamService(rt, self.pool)
        self.commit = commit or (lambda: self.s.flush())
        self.coding = coding

    # -------------------------------------------------------------- create / settings

    def create(self, user: User, aim: Aim, project: Project | None = None, settings: dict | None = None,
               now: datetime | None = None) -> PerpetualTask:
        now = now or utcnow()
        t = self.s.scalar(select(PerpetualTask).where(PerpetualTask.aim_id == aim.id))
        if t is None:
            t = PerpetualTask(user_id=user.id, aim_id=aim.id, created_at=now)
            self.s.add(t)
        t.project_id = project.id if project else None
        t.status, t.phase, t.phase_since, t.next_at, t.updated_at = "running", "starting", now, now, now
        t.settings = {**(t.settings or {}), **{k: v for k, v in (settings or {}).items() if k in DEFAULTS}}
        self.s.flush()
        return t

    def cfg(self, t: PerpetualTask) -> dict:
        return {**DEFAULTS, **(t.settings or {})}

    def set_status(self, t: PerpetualTask, status: str, now: datetime | None = None) -> PerpetualTask:
        now = now or utcnow()
        if status not in ("running", "paused", "stopped"):
            raise ValueError(status)
        t.status, t.updated_at = status, now
        t.phase, t.phase_since, t.phase_note = (status if status != "running" else "starting"), now, ""
        if status == "running":
            t.next_at = now
        self.s.flush()
        return t

    # -------------------------------------------------------------- what is on the board

    def questions(self, t: PerpetualTask, statuses: tuple[str, ...] = ("open",)) -> list[AimNote]:
        return list(self.s.scalars(select(AimNote).where(AimNote.aim_id == t.aim_id, AimNote.kind == "question",
                                                         AimNote.status.in_(statuses)).order_by(AimNote.created_at)))

    def _qcode(self, t: PerpetualTask) -> str:
        n = self.s.scalar(select(func.count()).select_from(AimNote).where(AimNote.aim_id == t.aim_id, AimNote.kind == "question")) or 0
        return f"Q{n + 1}"

    def project(self, t: PerpetualTask) -> Project | None:
        return self.s.get(Project, t.project_id) if t.project_id else None

    def self_project(self, t: PerpetualTask) -> bool:
        """Evolving code goes through the evolution line, which is PGA's own repository."""
        from pga.evolution.coding import REPO
        p = self.project(t)
        repo = getattr(self.coding, "repo", None) or REPO
        try:
            return bool(p) and Path(p.path).resolve() == Path(repo).resolve() and t.user_id == self._owner()
        except OSError:
            return False

    def _owner(self) -> uuid.UUID | None:
        from pga.owner import owner_id
        try:
            return owner_id(self.s)
        except Exception:  # noqa: BLE001
            return None

    def backlog(self, user_id: uuid.UUID) -> list[ImprovementProposal]:
        return list(self.s.scalars(select(ImprovementProposal).where(ImprovementProposal.user_id == user_id,
                                                                     ImprovementProposal.status.in_(["NEW", "DEFERRED"]))
                                   .order_by(ImprovementProposal.value.desc(), ImprovementProposal.created_at)))

    def backlog_for(self, t: PerpetualTask) -> list[ImprovementProposal]:
        """What it may implement now: everything when it is free; with checkpoints only what you approved."""
        mode = self.cfg(t)["autonomy"]
        if mode == "driven":
            return []
        items = self.backlog(t.user_id)
        return items if mode == "free" else [p for p in items if approved(p)]

    def _evo(self):
        from pga.evolution import EvolutionService
        return EvolutionService(self.rt, coding=self.coding) if self.coding else EvolutionService(self.rt)

    # -------------------------------------------------------------- pressure

    def measure(self, t: PerpetualTask, now: datetime) -> dict:
        from pga.evolution.motivation import open_round, r0_state
        c = self.cfg(t)
        qs = self.questions(t)
        target = max(1, int(c["open_target"]))
        top = max((clamp01((q.data or {}).get("priority"), .5) for q in qs), default=0.0)
        parts = {"think": 0.25 + 0.6 * max(0.0, (target - len(qs)) / target) - (0.2 if len(qs) >= c["max_open"] else 0.0),
                 "investigate": (0.35 + 0.55 * top + 0.1 * min(1.0, len(qs) / target)) if qs else 0.0, "evolve": 0.0,
                 "reflect": min(0.9, 0.7 * self._since_reflect(t) / max(1, int(c["reflect_every"])))}
        blocked = ""
        if c["evolve"] and self.self_project(t):
            backlog = self.backlog_for(t)
            line = self._evo().line(t.user_id)
            r0 = r0_state(self.rt, t.user_id).tension
            if open_round(self.rt, t.user_id):
                blocked = "一轮进化正在进行"
                self._evo().revive(t.user_id, now)
            elif len(line) >= int(c["max_line"]):
                blocked = f"进化线上已有 {len(line)} 个候选等你推广"
            elif backlog:
                parts["evolve"] = min(1.0, 0.7 + 0.25 * min(1.0, len(backlog) / 2) + 0.1 * r0)
        last = self.s.scalar(select(func.max(AimNote.created_at)).where(AimNote.aim_id == t.aim_id,
                                                                         AimNote.kind.in_(["answer", "evolve", "insight"])))
        stagnant_h = max(0.0, (now - (last or t.created_at)).total_seconds() / 3600)
        stagnation = min(0.3, 0.1 * stagnant_h)
        best = max(CHANNELS, key=lambda k: parts[k])
        pressure = round(max(FLOOR, min(1.0, parts[best] + stagnation)), 3)
        return {"parts": {k: round(max(0.0, v), 3) for k, v in parts.items()}, "stagnation": round(stagnation, 3),
                "pressure": pressure, "choice": best, "open": len(qs), "blocked": blocked}

    def _since_reflect(self, t: PerpetualTask) -> int:
        n = 0
        for e in t.ledger or []:
            if e.get("action") == "reflect":
                break
            if e.get("action") in CHANNELS:
                n += 1
        return n

    # -------------------------------------------------------------- choosing an agent within the quota

    cfg_paid = False

    def pick(self, aim: Aim, role: str, reserve: float, now: datetime) -> tuple[str | None, datetime | None]:
        """The team member for this role if it has quota left above the reserve; else another member; else any usable
        agent. (None, earliest reset) when everything is used up."""
        spent = self.pool.spent_today()
        roster = self.team.roster(aim)
        names = [m["agent"] for m in roster if m["role"] == role] + [m["agent"] for m in roster if m["role"] != role]
        names += [x["agent"] for x in self.router.rank("serious") if x.get("usable")]
        names += [n for n in self.pool.adapters if n not in names]
        from pga.agents.pool import busy
        resets: list[datetime] = []
        waiting: str | None = None                       # usable but busy elsewhere (e.g. implementing a change): last resort
        for n in dict.fromkeys(x for x in names if x):
            if not self.cfg_paid and self.pool.adapters[n].type in PAID:
                continue                                     # a subscription's quota, not your money
            ok, _ = self.pool.usable(n, spent)
            if not ok:
                continue
            q = self.router.quota(n)
            if q.exhausted or (q.remaining is not None and q.remaining <= reserve):
                if q.resets_at:
                    try:
                        resets.append(datetime.fromisoformat(q.resets_at))
                    except ValueError:
                        pass
                continue
            if busy(n, int(self.pool.cfg["agents"][n].get("max_concurrent", 1))):
                waiting = waiting or n
                continue
            return n, None
        if waiting:
            return waiting, None
        return None, (min(resets) if resets else None)

    def _task_for(self, t: PerpetualTask, aim: Aim, role: str, agent: str, prompt: str, system: str, step: str):
        """The agent task for one step (DB reads only; safe to build before running steps in parallel)."""
        from pga.teams import ROLES
        proj = self.project(t)
        ad = self.pool.adapters[agent]
        ws = proj.path if proj and ad.type != "llm" else self.pool._workspace(t.id, "perpetual", f"{role}-{agent}")
        return self.pool._task(agent, prompt, system=system, kind="perpetual", workspace=ws, permissions="read_only",
                               timeout_s=None, want_json=True,
                               meta={"category": ROLES[role]["category"], "workflow": "perpetual",
                                     "task_kind": f"perpetual:{step}", "aim": str(aim.id),
                                     "perpetual": str(t.id), "role": role,
                                     **({"project": {"id": str(proj.id), "name": proj.name, "path": proj.path}} if proj else {})})

    def _ask(self, t: PerpetualTask, aim: Aim, role: str, agent: str, prompt: str, system: str, step: str) -> tuple[str, str | None]:
        t0 = utcnow()
        st = self.pool._call(agent, self._task_for(t, aim, role, agent, prompt, system, step), step)
        return self._record_step(t, aim, role, agent, st, prompt, step, t0)

    def _record_step(self, t: PerpetualTask, aim: Aim, role: str, agent: str, st, prompt: str, step: str, t0: datetime) -> tuple[str, str | None]:
        from pga.agents.pool import PoolResult
        user = self.s.get(User, t.user_id)
        proj = self.project(t)
        ok = bool(st.result.ok and st.result.text.strip())
        res = PoolResult(ok, st.result.text if ok else "", "perpetual", "single",
                         {"agent": agent, "role": role, "aim": str(aim.id), "step": step, "perpetual": str(t.id),
                          **({"project": {"id": str(proj.id), "name": proj.name, "full": False}} if proj else {})}, [st],
                         error=None if ok else f"{agent}: {st.result.error}"[:800])
        res.run_id = uuid.uuid4()
        self.pool._record(res, prompt[:4000], user, None, None, t0)
        return (st.result.text if ok else ""), (None if ok else (st.result.error or "no answer"))

    # -------------------------------------------------------------- one cycle

    def due(self, now: datetime) -> list[uuid.UUID]:
        return list(self.s.scalars(select(PerpetualTask.id).where(PerpetualTask.status == "running")
                                   .where((PerpetualTask.next_at.is_(None)) | (PerpetualTask.next_at <= now))))

    def _phase(self, t: PerpetualTask, phase: str, note: str, now: datetime) -> None:
        t.phase, t.phase_note, t.phase_since, t.updated_at = phase, note[:300], now, now
        self.commit()

    def _ledger(self, t: PerpetualTask, entry: dict) -> None:
        t.ledger = ([entry] + list(t.ledger or []))[:80]

    def cycle(self, t: PerpetualTask, now: datetime | None = None) -> dict:
        now = now or utcnow()
        c = self.cfg(t)
        aim = self.s.get(Aim, t.aim_id)
        if aim is None or t.status != "running":
            return {"skipped": True}
        m = self.measure(t, now)
        t.pressure, t.parts = m["pressure"], {**m["parts"], "stagnation": m["stagnation"], "open": m["open"], "blocked": m["blocked"]}
        # rest only when nothing pulls, and only within the allowance
        allowance = c["max_rest_ratio"] * t.work_s - t.rest_s
        if m["pressure"] < c["rest_line"] and allowance >= 30:
            d = min(allowance, c["rest_max_s"])
            return self._wait(t, "rest", f"张力 {m['pressure']:.2f} 低于休息线 {c['rest_line']}：休息 {d:.0f} 秒", d, now, m)
        mode = c["autonomy"] if c["autonomy"] in AUTONOMY else "checkpoint"
        if mode == "driven":                                  # works only when you ask
            return self._wait(t, "driven", "用户驱动：只在你提出要求时工作", c["quota_recheck_s"], now, m, pause=True)
        if mode == "checkpoint":
            pending = self.pending_checkpoint(t)
            if pending is not None:
                return self._wait(t, "checkpoint", "检查点：等你看过它的思路，再决定继续、调整还是停下", c["quota_recheck_s"], now, m, pause=True)
            if self.since_checkpoint(t) >= max(1, int(c["checkpoint_every"])):
                return self._checkpoint(t, aim, now, m)
        if mode == "free" and c["auto_promote"]:
            done = self._auto_promote(t, aim, now)
            if done:
                return done
        action = m["choice"]
        role = {"think": "lead", "investigate": "researcher", "evolve": "critic", "reflect": "critic"}[action]
        if action == "investigate" and t.cycles % 3 == 2:
            role = "critic"                                   # a second mind answers every third question
        self.cfg_paid = bool(c["use_paid"])
        agent, reset = self.pick(aim, role, float(c["reserve"]), now)
        if agent is None:
            # look again after quota_recheck_s even when a reset is days away: another agent may free up (a 5-hour
            # window resets, a new account or token is added) long before the earliest known reset
            recheck = now + timedelta(seconds=c["quota_recheck_s"])
            until = min(reset, recheck) if reset and reset > now else recheck
            d = (until - now).total_seconds()
            note = "所有可用 agent 的额度都用完了（或只剩给你保留的部分）"
            note += (f"：最早 {reset.astimezone().strftime('%m-%d %H:%M')} 重置，" if reset and reset > now else "：")
            note += f"{until.astimezone().strftime('%H:%M')} 再查一次"
            return self._wait(t, "quota", note, d, now, m, pause=True)
        from pga.allocation import Allocation
        alloc = Allocation(self)
        a = alloc.settings(t)
        rows = alloc.table(t, aim, role, action, now)
        k = min(a["parallel"], max(1, len(self.questions(t)))) if action == "investigate" else 1
        drawn = alloc.draw(rows, k, random.Random(f"{t.id}:{t.cycles}"))      # by your weights; reproducible per cycle
        agents = drawn or [agent]
        agent = agents[0]
        self._phase(t, action, f"{PHASE_ZH[action]} · {'、'.join(agents)}", now)
        started = time.monotonic()
        try:
            out = (self._investigate_many(t, aim, role, agents, now) if len(agents) > 1
                   else getattr(self, "_" + action)(t, aim, role, agent, now))
        except Exception as exc:  # noqa: BLE001 - one bad cycle must not end a perpetual task
            log.exception("perpetual cycle failed")
            out = {"ok": False, "error": f"{type(exc).__name__}: {exc}"[:300]}
        spent = time.monotonic() - started
        t.work_s += spent
        t.cycles += 1
        self._ledger(t, {"at": now.isoformat(), "action": action, "agent": agent, "agents": out.get("agents") or [agent],
                         "seconds": round(spent, 1), "pressure": m["pressure"],
                         "parts": m["parts"], "ok": bool(out.get("ok")), "result": str(out.get("summary") or out.get("error") or "")[:200]})
        end = utcnow()
        if not out.get("ok"):
            back = min(c["error_backoff_s"], max(0.0, c["max_rest_ratio"] * t.work_s - t.rest_s))
            t.rest_s += back
            t.phase, t.phase_note, t.phase_since = "error", str(out.get("error") or "")[:300], end
            t.next_at = end + timedelta(seconds=back)
        else:
            breath = min(c["breath_s"], max(0.0, c["max_rest_ratio"] * t.work_s - t.rest_s))
            t.rest_s += breath
            t.next_at = end + timedelta(seconds=breath)
        t.updated_at = end
        self.s.flush()
        return {"action": action, "agent": agent, **out}

    def _wait(self, t: PerpetualTask, phase: str, note: str, seconds: float, now: datetime, m: dict, pause: bool = False) -> dict:
        seconds = max(1.0, seconds)
        if pause:
            t.pause_s += seconds
        else:
            t.rest_s += seconds
        t.phase, t.phase_note, t.phase_since, t.next_at, t.updated_at = phase, note, now, now + timedelta(seconds=seconds), now
        self._ledger(t, {"at": now.isoformat(), "action": phase, "seconds": round(seconds), "pressure": m["pressure"], "parts": m["parts"],
                         "ok": True, "result": note[:200]})
        self.s.flush()
        return {"action": phase, "seconds": seconds, "note": note}

    # -------------------------------------------------------------- context

    def _lang(self, t: PerpetualTask) -> str:
        from pga.teams import _lang
        return _lang(self.s.get(User, t.user_id))

    def _where(self, t: PerpetualTask, agent: str) -> str:
        p = self.project(t)
        if not p:
            return "There is no project folder; work from the aim and the board."
        if self.pool.adapters[agent].type == "llm":
            return f"The project is {p.name} at {p.path}; you cannot open its files — rely on the snapshot below."
        return f"You are inside the project folder {p.path} ({p.name}): read any file you need, but never modify anything."

    def context(self, t: PerpetualTask, aim: Aim, *, answers: int = 6) -> str:
        parts = [self.team.context(aim)]
        p = self.project(t)
        if p:
            parts.append(snapshot(p.path))
        qs = self.questions(t, ("open", "for_you"))
        if qs:
            parts.append("<open_questions>\n" + "\n".join(
                f"{(q.data or {}).get('code')} [{(q.data or {}).get('kind', 'code')}, priority {clamp01((q.data or {}).get('priority'), .5):.1f}"
                f"{', waiting for the user' if q.status == 'for_you' else ''}] {q.text}" for q in qs[-20:]) + "\n</open_questions>")
        done = list(self.s.scalars(select(AimNote).where(AimNote.aim_id == t.aim_id, AimNote.kind.in_(["answer", "insight"]))
                                   .order_by(AimNote.created_at.desc()).limit(answers)))
        if done:
            parts.append("<recent_findings>\n" + "\n".join(f"- {(n.data or {}).get('code', '')} {n.text[:500]}" for n in reversed(done))
                         + "\n</recent_findings>")
        answered = self.questions(t, ("answered", "dropped"))
        if answered:
            parts.append("<already_answered_or_dropped>\n" + "\n".join(f"- {q.text[:160]}" for q in answered[-30:]) + "\n</already_answered_or_dropped>")
        if self.self_project(t):
            evo = self._evo()
            line = evo.line(t.user_id)
            parts.append("<evolution>\nline (verified, waiting for the user's promotion): "
                         + (", ".join(f"{v.label} {(self.s.get(ImprovementProposal, v.proposal_id).title if v.proposal_id else '')}" for v in line) or "empty")
                         + "\nbacklog: " + ("; ".join(f"{p.code} {p.title} ({p.status})" for p in self.backlog(t.user_id)[:8]) or "empty") + "\n</evolution>")
        return "\n\n".join(x for x in parts if x)

    def _json(self, text: str) -> dict:
        try:
            d = parse_json(text) if text else {}
            return d if isinstance(d, dict) else {}
        except ModelOutputError:
            return {}

    def _role_en(self, role: str) -> str:
        from pga.teams import ROLES
        return ROLES[role]["en"]

    def _add_questions(self, t: PerpetualTask, aim: Aim, items: list, agent: str, role: str, now: datetime, parent: str | None = None) -> list[str]:
        c = self.cfg(t)
        existing = [q.text for q in self.questions(t, ("open", "for_you", "answered", "dropped"))]
        open_n = len(self.questions(t))
        added = []
        for it in items[:3]:
            if not isinstance(it, dict) or not str(it.get("q") or "").strip():
                continue
            q = str(it["q"]).strip()[:600]
            if any(alike(q, e) for e in existing) or open_n >= c["max_open"]:
                continue
            kind = str(it.get("kind") or "code").lower()
            kind = kind if kind in ("code", "product", "research", "user") else "code"
            if kind == "user" and self.questions(t, ("for_you",)):
                continue                                     # one question for you at a time
            code = self._qcode(t)
            self.team._note(aim, "question", q, role=role, agent=agent, status="for_you" if kind == "user" else "open", now=now,
                            data={"code": code, "kind": kind, "why": str(it.get("why") or "")[:400],
                                  "priority": clamp01(it.get("priority"), .5), "parent": parent, "perpetual": str(t.id)})
            existing.append(q)
            open_n += kind != "user"
            added.append(code)
            if kind == "user":
                self._tell_user(t, aim, q, now)
        return added

    def _tell_user(self, t: PerpetualTask, aim: Aim, q: str, now: datetime) -> None:
        from pga.notify import Proposal
        user = self.s.get(User, t.user_id)
        try:
            self.rt.notify.propose(user, Proposal(kind=CommKind.QUESTION, reasons=[NotifyReason.DECISION_REQUIRED],
                                                  title_en="Your perpetual task has a question only you can answer",
                                                  body_en=q[:600], dedupe_key=f"perpetual-ask:{t.id}"), now)
        except Exception as exc:  # noqa: BLE001 - the question stays on the board either way
            log.info("could not notify: %s", exc)

    # -------------------------------------------------------------- the four actions

    def _think(self, t: PerpetualTask, aim: Aim, role: str, agent: str, now: datetime) -> dict:
        system = THINK.format(role=self._role_en(role), where=self._where(t, agent), lang=self._lang(t))
        text, err = self._ask(t, aim, role, agent, self.context(t, aim) + "\n\nAsk the next questions.", system, "think")
        d = self._json(text)
        if not d:
            return {"ok": False, "error": err or "the reply was not the JSON this step needs"}
        added = self._add_questions(t, aim, d.get("questions") or [], agent, role, utcnow())
        ins = str(d.get("insight") or "").strip()
        if ins:
            self.team._note(aim, "insight", ins[:1500], role=role, agent=agent, now=utcnow(), data={"perpetual": str(t.id)})
        return {"ok": True, "summary": f"新问题 {', '.join(added) or '无（都和已有的重复）'}" + (f"；想法：{ins[:80]}" if ins else "")}

    def _investigate(self, t: PerpetualTask, aim: Aim, role: str, agent: str, now: datetime) -> dict:
        qs = sorted(self.questions(t), key=lambda q: (-clamp01((q.data or {}).get("priority"), .5), q.created_at))
        if not qs:
            return {"ok": True, "summary": "没有待回答的问题"}
        q = qs[0]
        system, prompt = self._investigate_prompt(t, aim, role, agent, q)
        text, err = self._ask(t, aim, role, agent, prompt, system, "investigate")
        return self._apply_answer(t, aim, role, agent, q, text, err)

    def _investigate_prompt(self, t: PerpetualTask, aim: Aim, role: str, agent: str, q: AimNote) -> tuple[str, str]:
        code = (q.data or {}).get("code")
        evolve = self.cfg(t)["evolve"] and self.self_project(t)
        system = INVESTIGATE.format(role=self._role_en(role), where=self._where(t, agent), lang=self._lang(t),
                                    proposal_rule=PROPOSAL_RULE if evolve else NO_PROPOSAL_RULE)
        return system, (self.context(t, aim) + f"\n\n<question code=\"{code}\">\n{q.text}\n"
                        f"(why it matters: {(q.data or {}).get('why', '')})\n</question>\nAnswer it.")

    def _investigate_many(self, t: PerpetualTask, aim: Aim, role: str, agents: list[str], now: datetime) -> dict:
        """Several open questions at once, one agent each (fan-out), then each answer folded back in (in order)."""
        from concurrent.futures import ThreadPoolExecutor
        qs = sorted(self.questions(t), key=lambda q: (-clamp01((q.data or {}).get("priority"), .5), q.created_at))[:len(agents)]
        if not qs:
            return {"ok": True, "summary": "没有待回答的问题"}
        jobs = []
        for q, ag in zip(qs, agents):
            system, prompt = self._investigate_prompt(t, aim, role, ag, q)
            jobs.append((q, ag, prompt, self._task_for(t, aim, role, ag, prompt, system, "investigate")))
        t0 = utcnow()
        threaded = [j for j in jobs if self.pool.adapters[j[1]].type not in PAID]     # PGA's own model shares this session
        with ThreadPoolExecutor(max_workers=max(1, len(threaded))) as ex:
            futs = {id(j): ex.submit(self.pool._call, j[1], j[3], "investigate") for j in threaded}
            steps = {k: f.result() for k, f in futs.items()}
        for j in jobs:
            if id(j) not in steps:
                steps[id(j)] = self.pool._call(j[1], j[3], "investigate")
        outs = []
        for j in jobs:
            q, ag, prompt, _task = j
            text, err = self._record_step(t, aim, role, ag, steps[id(j)], prompt, "investigate", t0)
            outs.append((ag, self._apply_answer(t, aim, role, ag, q, text, err)))
        return {"ok": any(o["ok"] for _, o in outs), "agents": [ag for ag, _ in outs],
                "summary": "并行研究：" + "；".join(f"{ag} {o.get('summary') or o.get('error') or ''}" for ag, o in outs),
                "error": None if any(o["ok"] for _, o in outs) else "; ".join(str(o.get("error")) for _, o in outs)}

    def _apply_answer(self, t: PerpetualTask, aim: Aim, role: str, agent: str, q: AimNote, text: str, err: str | None) -> dict:
        code = (q.data or {}).get("code")
        evolve = self.cfg(t)["evolve"] and self.self_project(t)
        d = self._json(text)
        ans = str(d.get("answer") or "").strip()
        if not ans:
            q.data = {**(q.data or {}), "tries": int((q.data or {}).get("tries", 0)) + 1}
            if q.data["tries"] >= 3:
                q.status = "dropped"
            return {"ok": False, "error": err or "no answer"}
        later = utcnow()
        prop_code = None
        p = d.get("proposal")
        if evolve and isinstance(p, dict) and str(p.get("title") or "").strip():
            prop_code = self._propose(t, p, q, agent, later)
        self.team._note(aim, "answer", ans[:6000], role=role, agent=agent, now=later,
                        data={"code": code, "question": q.text[:300], "evidence": [str(x)[:200] for x in (d.get("evidence") or [])][:8],
                              "confidence": clamp01(d.get("confidence"), .5), "proposal": prop_code, "perpetual": str(t.id)})
        q.status = "answered"
        q.data = {**(q.data or {}), "answered_by": agent, "answered_at": later.isoformat()}
        follow = self._add_questions(t, aim, d.get("follow_up") or [], agent, role, later, parent=code)
        return {"ok": True, "summary": f"回答了 {code}" + (f"，提出改进 {prop_code}" if prop_code else "") + (f"，追问 {', '.join(follow)}" if follow else "")}

    def _propose(self, t: PerpetualTask, p: dict, q: AimNote, agent: str, now: datetime) -> str | None:
        from pga.evolution.round import _similar
        title = str(p["title"]).strip()[:160]
        existing = list(self.s.scalars(select(ImprovementProposal).where(ImprovementProposal.user_id == t.user_id)))
        dup = next((x for x in existing if _similar(x.title, title)), None)
        ev = {"perpetual": str(t.id), "question": (q.data or {}).get("code"), "by": agent, "note": str(p.get("change") or "")[:300]}
        if dup is not None:
            dup.evidence = list(dup.evidence or []) + [ev]
            return dup.code
        n = self.s.scalar(select(func.count()).select_from(ImprovementProposal).where(ImprovementProposal.user_id == t.user_id)) or 0
        x = ImprovementProposal(user_id=t.user_id, code=f"P{n + 1:02d}", title=title, problem=q.text[:2000],
                                change=str(p.get("change") or "")[:4000], proposer=f"perpetual:{agent}"[:32],
                                expected_gain=str(p.get("expected_gain") or "")[:1000], expected_cost="",
                                risk=str(p.get("risk") or "")[:1000], evaluation_plan=str(p.get("evaluation_plan") or "")[:1000],
                                rollback_condition=str(p.get("rollback_condition") or "")[:1000],
                                files=[str(f)[:200] for f in (p.get("files") or [])][:8], evidence=[ev], status="NEW", created_at=now)
        self.s.add(x)
        self.s.flush()
        return x.code

    def _evolve(self, t: PerpetualTask, aim: Aim, role: str, agent: str, now: datetime) -> dict:
        from pga.evolution.motivation import open_round
        if open_round(self.rt, t.user_id):
            return {"ok": True, "summary": "已有一轮进化在进行"}
        slate = self.backlog_for(t)[:3]
        if not slate:
            return {"ok": True, "summary": "没有待实现的改进"}
        listing = "\n\n".join(f"{p.code}: {p.title}\nchange: {p.change}\nfiles: {', '.join(p.files) or '?'}\nexpected gain: {p.expected_gain}\n"
                              f"risk: {p.risk}\nevaluation: {p.evaluation_plan}\nwhy: {p.problem[:400]}" for p in slate)
        system = REVIEW.format(role=self._role_en(role), where=self._where(t, agent), protected=PROTECTED_NOTE)
        text, err = self._ask(t, aim, role, agent, self.context(t, aim, answers=3) + f"\n\n<proposals>\n{listing}\n</proposals>\nReview them.",
                              system, "review")
        d = self._json(text)
        by_code = {p.code: p for p in slate}
        reviews = []
        for it in d.get("reviews") or []:
            p = by_code.get(str((it or {}).get("id") or "").strip().upper())
            if p is None:
                continue
            dims = ("goal_alignment", "evidence_strength", "expected_gain", "implementation_cost", "regression_risk", "reversibility")
            reviews.append((p, {k: clamp01((it.get("scores") or {}).get(k), .5) for k in dims},
                            [str(o)[:300] for o in (it.get("objections") or [])][:5], bool(it.get("critical"))))
        if not reviews:
            for p in slate:                                  # keep it from blocking the queue forever
                p.status = "DEFERRED"
            return {"ok": False, "error": err or "the review returned nothing usable"}
        user = self.s.get(User, t.user_id)
        reviewed = [p for p, *_ in reviews]
        later = utcnow()
        rnd = self._evo().start(user, trigger="perpetual", force=True, slate=reviewed, now=later,
                                problem={"description": "; ".join(p.problem[:200] for p in reviewed),
                                         "evidence": [e for p in reviewed for e in (p.evidence or [])][:6], "hint": "perpetual task"})
        for p, scores, objections, critical in reviews:
            self.s.add(ProposalReview(proposal_id=p.id, round_id=rnd.id, reviewer=f"perpetual:{agent}"[:32], scores=scores,
                                      objections=objections, critical=critical, created_at=later))
        self.s.flush()
        listing_zh = "、".join(f"{p.code} {p.title}" for p in reviewed)
        self.team._note(aim, "evolve", f"送进一轮进化：{listing_zh}。审核通过的会在隔离的副本里实现、跑完整测试，通过后放上进化线，等你推广。",
                        role=role, agent=agent, now=later, data={"round": str(rnd.id), "proposals": [p.code for p in reviewed], "perpetual": str(t.id)})
        return {"ok": True, "summary": f"进化轮 {str(rnd.id)[:8]}：{listing_zh}"}

    def _reflect(self, t: PerpetualTask, aim: Aim, role: str, agent: str, now: datetime) -> dict:
        system = REFLECT.format(role=self._role_en(role), lang=self._lang(t))
        recent = list(self.s.scalars(select(AimNote).where(AimNote.aim_id == t.aim_id).order_by(AimNote.created_at.desc()).limit(30)))
        board = "\n".join(f"[{n.kind}{' ' + str((n.data or {}).get('code')) if (n.data or {}).get('code') else ''}] {n.text[:400]}" for n in reversed(recent))
        text, err = self._ask(t, aim, role, agent, self.context(t, aim, answers=3) + f"\n\n<board_recent>\n{board}\n</board_recent>\nLook back.",
                              system, "reflect")
        d = self._json(text)
        summary = str(d.get("summary") or "").strip()
        if not summary:
            return {"ok": False, "error": err or "no summary"}
        by_code = {(q.data or {}).get("code"): q for q in self.questions(t, ("open",))}
        dropped = []
        for code in d.get("drop") or []:
            q = by_code.get(str(code).strip().upper())
            if q is not None:
                q.status = "dropped"
                dropped.append(q.data.get("code"))
        for code, pr in (d.get("priorities") or {}).items() if isinstance(d.get("priorities"), dict) else []:
            q = by_code.get(str(code).strip().upper())
            if q is not None and q.status == "open":
                q.data = {**(q.data or {}), "priority": clamp01(pr, .5)}
        later = utcnow()
        self.team._note(aim, "reflect", summary[:3000], role=role, agent=agent, now=later,
                        data={"dropped": dropped, "perpetual": str(t.id)})
        ask = str(d.get("ask_user") or "").strip()
        if ask:
            self._add_questions(t, aim, [{"q": ask, "kind": "user", "priority": 0.8, "why": "回顾时发现只有你能决定"}], agent, role, later)
        return {"ok": True, "summary": f"回顾：{summary[:80]}" + (f"；放下 {', '.join(dropped)}" if dropped else "")}

    # -------------------------------------------------------------- checkpoints (autonomy: checkpoint)

    def pending_checkpoint(self, t: PerpetualTask) -> AimNote | None:
        return self.s.scalar(select(AimNote).where(AimNote.aim_id == t.aim_id, AimNote.kind == "checkpoint",
                                                   AimNote.status == "pending").order_by(AimNote.created_at.desc()).limit(1))

    def since_checkpoint(self, t: PerpetualTask) -> int:
        """Working cycles since the last checkpoint (or since it started)."""
        n = 0
        for e in t.ledger or []:
            if e.get("action") in ("checkpoint", "checkpoint_ok"):
                break
            if e.get("action") in CHANNELS:
                n += 1
        return n

    def _checkpoint(self, t: PerpetualTask, aim: Aim, now: datetime, m: dict) -> dict:
        """Stop, report what it thought and where it would go next, and wait for you."""
        c = self.cfg(t)
        self.cfg_paid = bool(c["use_paid"])
        agent, _reset = self.pick(aim, "lead", float(c["reserve"]), now)
        since = None
        for e in t.ledger or []:
            if e.get("action") in ("checkpoint", "checkpoint_ok"):
                since = e.get("at")
                break
        q = select(AimNote).where(AimNote.aim_id == t.aim_id, AimNote.kind.in_(["question", "answer", "insight", "evolve", "reflect"]))
        if since:
            q = q.where(AimNote.created_at > datetime.fromisoformat(since))
        recent = list(self.s.scalars(q.order_by(AimNote.created_at.desc()).limit(40)))
        pending = [p for p in self.backlog(t.user_id) if not approved(p)][:8]
        board = "\n".join(f"[{n.kind}{' ' + str((n.data or {}).get('code')) if (n.data or {}).get('code') else ''}] {n.text[:500]}"
                          for n in reversed(recent))
        props = "\n".join(f"{p.code}: {p.title} — {p.change[:300]}" for p in pending) or "(none)"
        d: dict = {}
        if agent is not None:
            system = CHECKPOINT.format(role=self._role_en("lead"), lang=self._lang(t))
            text, _err = self._ask(t, aim, "lead", agent, self.context(t, aim, answers=2)
                                   + f"\n\n<board_since_last_checkpoint>\n{board}\n</board_since_last_checkpoint>"
                                   + f"\n\n<pending_proposals>\n{props}\n</pending_proposals>\nReport to the user.", system, "checkpoint")
            d = self._json(text)
        summary = str(d.get("summary") or "").strip()
        if not summary:                                      # no model: a plain account from the ledger, so the stop still holds
            done = [e for e in (t.ledger or []) if e.get("action") in CHANNELS][: max(1, int(c["checkpoint_every"]))]
            summary = "；".join(f"{PHASE_ZH.get(e['action'], e['action'])}：{e.get('result', '')}" for e in reversed(done))[:1200] or "（没有可汇报的内容）"
        options = [{"label": str(o.get("label") or "")[:80], "detail": str(o.get("detail") or "")[:300]}
                   for o in (d.get("options") or []) if isinstance(o, dict) and o.get("label")][:4]
        recs = {str((x or {}).get("code") or "").upper(): {"recommend": bool((x or {}).get("recommend")), "why": str((x or {}).get("why") or "")[:300]}
                for x in (d.get("proposals") or []) if isinstance(x, dict)}
        data = {"summary": summary, "direction": str(d.get("direction") or "")[:1200], "question": str(d.get("question") or "")[:600],
                "options": options, "agent": agent, "cycles": t.cycles,
                "proposals": [{"code": p.code, "title": p.title, "change": p.change[:400], "risk": p.risk[:200],
                               **recs.get(p.code, {"recommend": False, "why": ""})} for p in pending]}
        self.team._note(aim, "checkpoint", summary, role="lead", agent=agent, status="pending", now=now, data=data)
        self._tell_checkpoint(t, aim, summary, now)
        return self._wait(t, "checkpoint", "检查点：等你看过它的思路，再决定继续、调整还是停下", c["quota_recheck_s"], now, m, pause=True) | {
            "action": "checkpoint", "summary": summary[:200]}

    def _tell_checkpoint(self, t: PerpetualTask, aim: Aim, summary: str, now: datetime) -> None:
        from pga.notify import Proposal
        user = self.s.get(User, t.user_id)
        try:
            self.rt.notify.propose(user, Proposal(kind=CommKind.QUESTION, reasons=[NotifyReason.DECISION_REQUIRED],
                                                  title_en=f"Checkpoint: is this the right direction? ({aim.text_en[:60]})",
                                                  body_en=summary[:600], dedupe_key=f"perpetual-checkpoint:{t.id}:{t.cycles}"), now)
        except Exception as exc:  # noqa: BLE001 - the checkpoint stays on the board either way
            log.info("could not notify: %s", exc)

    def resolve_checkpoint(self, t: PerpetualTask, note: AimNote, decision: str, *, text: str = "", text_en: str = "",
                           approve: list[str] | None = None, option: int | None = None, now: datetime | None = None) -> AimNote:
        """continue (with the proposals you approve) · adjust (your words become guidance, then continue) · stop."""
        now = now or utcnow()
        if note.kind != "checkpoint" or note.status != "pending" or note.aim_id != t.aim_id:
            raise ValueError("this checkpoint is not waiting for you")
        if decision not in ("continue", "adjust", "stop"):
            raise ValueError("decision is continue, adjust or stop")
        aim = self.s.get(Aim, t.aim_id)
        data = dict(note.data or {})
        picked = (data.get("options") or [])[option] if option is not None and 0 <= option < len(data.get("options") or []) else None
        codes = {c.upper() for c in (approve or [])}
        for p in self.backlog(t.user_id):
            if p.code in codes:
                p.evidence = list(p.evidence or []) + [{"approved_by": "user", "at": now.isoformat(), "checkpoint": str(note.id)}]
        guidance = " ".join(x for x in [f"（检查点：选了「{picked['label']}」）" if picked else "", text] if x).strip()
        guidance_en = " ".join(x for x in [f"(Checkpoint: the user chose \"{picked['label']}\")" if picked else "", text_en] if x).strip()
        if guidance:
            self.team.add_correction(aim, guidance, guidance_en or guidance, now)
        note.status = {"continue": "approved", "adjust": "adjusted", "stop": "stopped"}[decision]
        note.data = {**data, "decision": decision, "approved": sorted(codes), "picked": picked, "decided_at": now.isoformat()}
        self._ledger(t, {"at": now.isoformat(), "action": "checkpoint_ok", "ok": True, "seconds": 0, "pressure": t.pressure,
                         "parts": t.parts or {}, "result": f"你：{note.status}" + (f"，批准 {', '.join(sorted(codes))}" if codes else "")})
        if decision == "stop":
            self.set_status(t, "paused", now)
        else:
            t.next_at = now
            if t.status == "running":
                t.phase, t.phase_note, t.phase_since = "starting", "", now
        self.s.flush()
        return note

    # -------------------------------------------------------------- free: verified changes go live on their own

    def _auto_promote(self, t: PerpetualTask, aim: Aim, now: datetime) -> dict | None:
        if not self.self_project(t) or not self.cfg(t)["evolve"]:
            return None
        evo = self._evo()
        line = evo.line(t.user_id)
        if not line:
            return None
        top = line[-1]
        try:
            v = evo.promote(top, now)
        except Exception as exc:  # noqa: BLE001 - e.g. the per-round limit: leave it for the user
            log.info("auto-promote skipped: %s", exc)
            return None
        msg = f"完全自由：自动推广了 {v.label}（已通过完整测试；先作为 canary 运行，变差会自动回滚；重启 PGA 后生效）"
        self.team._note(aim, "evolve", msg, role="lead", agent=None, now=now, data={"version": str(v.id), "auto": True, "perpetual": str(t.id)})
        self._ledger(t, {"at": now.isoformat(), "action": "promote", "ok": True, "seconds": 0, "pressure": t.pressure,
                         "parts": t.parts or {}, "result": msg[:200]})
        t.phase, t.phase_note, t.phase_since, t.next_at, t.updated_at = "promote", msg[:300], now, now, now
        self.s.flush()
        return {"action": "promote", "ok": True, "summary": msg}

    # -------------------------------------------------------------- your answer

    def answer(self, t: PerpetualTask, note: AimNote, text: str, text_en: str, now: datetime | None = None) -> AimNote:
        """You answer a question it asked you: the answer becomes your correction on the aim (every prompt reads it)."""
        now = now or utcnow()
        aim = self.s.get(Aim, t.aim_id)
        note.status = "answered"
        note.data = {**(note.data or {}), "answered_by": "you", "answered_at": now.isoformat()}
        c = self.team.add_correction(aim, f"（回答 {(note.data or {}).get('code')}：{note.text[:200]}）{text}",
                                     f"(Answer to {(note.data or {}).get('code')}: {note.text[:200]}) {text_en}", now)
        t.next_at = now
        self.s.flush()
        return c

    # -------------------------------------------------------------- for the UI

    def out(self, t: PerpetualTask, now: datetime | None = None) -> dict:
        now = now or utcnow()
        aim = self.s.get(Aim, t.aim_id)
        p = self.project(t)
        c = self.cfg(t)
        total = t.work_s + t.rest_s
        line = []
        if self.self_project(t):
            for v in self._evo().line(t.user_id):
                pr = self.s.get(ImprovementProposal, v.proposal_id) if v.proposal_id else None
                line.append({"id": str(v.id), "label": v.label, "title": pr.title if pr else "", "code": pr.code if pr else None,
                             "files": v.files[:8], "tests": (v.verification or {}).get("candidate_tests", {}).get("passed"),
                             "at": v.created_at.isoformat()})
        from pga.evolution.motivation import open_round
        rnd = open_round(self.rt, t.user_id) or self.s.scalar(select(EvolutionRound).where(EvolutionRound.user_id == t.user_id)
                                                              .order_by(EvolutionRound.created_at.desc()).limit(1))
        return {"id": str(t.id), "aim_id": str(t.aim_id), "aim": aim.text if aim else "", "status": t.status, "phase": t.phase,
                "phase_zh": PHASE_ZH.get(t.phase, t.phase), "phase_note": t.phase_note,
                "phase_since": t.phase_since.isoformat() if t.phase_since else None, "next_at": t.next_at.isoformat() if t.next_at else None,
                "pressure": t.pressure, "parts": t.parts or {}, "cycles": t.cycles, "work_s": round(t.work_s), "rest_s": round(t.rest_s),
                "pause_s": round(t.pause_s), "rest_ratio": round(t.rest_s / total, 4) if total else 0.0,
                "project": {"id": str(p.id), "name": p.name, "path": p.path} if p else None, "settings": c,
                "evolves": bool(c["evolve"] and self.self_project(t)), "line": line,
                "round": {"id": str(rnd.id), "phase": rnd.phase, "trigger": rnd.trigger, "log": (rnd.log or [])[-4:]} if rnd and self.self_project(t) else None,
                "ledger": (t.ledger or [])[:20], "created_at": t.created_at.isoformat(),
                "autonomy": c["autonomy"], "autonomy_zh": AUTONOMY_ZH.get(c["autonomy"], c["autonomy"]),
                "since_checkpoint": self.since_checkpoint(t)}


class PerpetualRunner:
    """Runs the cycles of every running perpetual task, one after another, in its own thread (next to the worker)."""

    def __init__(self, sessionmaker, runtime_factory):
        self.sm, self.factory = sessionmaker, runtime_factory
        self.current: dict | None = None

    def tick(self, now: datetime | None = None) -> int:
        with self.sm() as s:
            ids = Perpetual(self.factory(s)).due(now or utcnow())
            s.commit()
        for tid in ids:
            with self.sm() as s:
                rt = self.factory(s)
                eng = Perpetual(rt, commit=s.commit)
                t = s.get(PerpetualTask, tid)
                if t is None or t.status != "running":
                    continue
                self.current = {"task": str(tid), "since": utcnow().isoformat()}
                try:
                    eng.cycle(t)
                    s.commit()
                except Exception:  # noqa: BLE001
                    log.exception("perpetual task %s: cycle crashed", tid)
                    s.rollback()
                    t = s.get(PerpetualTask, tid)
                    if t is not None:
                        t.phase, t.phase_note, t.next_at = "error", "cycle crashed; see the log", utcnow() + timedelta(seconds=60)
                        t.rest_s += 60
                        s.commit()
                finally:
                    self.current = None
        return len(ids)

    def run_forever(self, stop: threading.Event) -> None:
        log.info("perpetual runner started")
        while not stop.is_set():
            try:
                n = self.tick()
            except Exception:  # noqa: BLE001 - e.g. the database restarting; try again shortly
                log.exception("perpetual runner tick failed")
                n = 0
            stop.wait(0.5 if n else 2)
