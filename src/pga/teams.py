"""Teams: several agents from different sources working on one long-range aim together — and your corrections to it.

Every aim has a team of four roles. Each role is filled by an agent from the pool; by default the roles go to
different sources (ChatGPT, Claude, Hermes, WorkBuddy, PGA's own model…) so the work is checked by someone who does
not think the same way. You can pin any role to an agent you prefer.

    lead        协调者  plans each round, hands out the work, merges what comes back, applies your corrections
    researcher  研究员  finds and checks what is new and what it means for the aim
    critic      审阅者  challenges the others' work: gaps, weak evidence, wrong turns
    maker       执行者  turns conclusions into concrete drafts, plans and documents

A round (`team.round` job, or the 开一轮协作 button): the lead plans up to three tasks for the others → they work in
parallel → the critic reviews what came back → the lead writes the summary and the next steps. Every step is a note
on the aim's board (AimNote) and an AgentRun in the ledger, so you can read it and talk to any member about it.

The responsibilities serving the aim use the team too: research of a responsibility goes to the aim's researcher
first, Motivation Forward to its lead, validation to its critic, artifacts to its maker (then routing as before).

Corrections: you add your own idea or correction to an aim. It counts at once — every prompt that reads the aim
(chat, Motivation Forward, research, the team) gets it as "the user's later guidance", newest last; the aim's own
words are never rewritten. Then the lead works out what should change (`aim.revise` job): safe changes are applied
(a responsibility's description, priority or keywords; a bounded candidate responsibility), anything that stops,
resumes, finishes or adds a perpetual responsibility is proposed for you to apply with one click.
"""

from __future__ import annotations

import logging
import uuid
from datetime import datetime, timedelta
from typing import TYPE_CHECKING, Any

from sqlalchemy import select

from pga.agent.common import ModelOutputError, parse_json
from pga.db.models import Aim, AimNote, Responsibility, User
from pga.db.types import Origin, ResponsibilityStatus as S, utcnow

if TYPE_CHECKING:
    from pga.runtime import Runtime

log = logging.getLogger("pga.teams")

ROLES: dict[str, dict[str, Any]] = {
    "lead": {"label": "协调者", "category": "serious", "caps": ("serious", "plan"),
             "en": "the coordinator: you plan each round, hand out the work, merge what comes back and keep the team on the aim"},
    "researcher": {"label": "研究员", "category": "serious", "caps": ("research",),
                   "en": "the researcher: you find and check what is new and what it means for the aim; cite what you rely on"},
    "critic": {"label": "审阅者", "category": "serious", "caps": ("review",),
               "en": "the reviewer: you challenge the others' work — gaps, weak evidence, wrong turns — and say what would fix it"},
    "maker": {"label": "执行者", "category": "office", "caps": ("write", "office"),
              "en": "the maker: you turn conclusions into concrete drafts, plans and documents the user can use"},
}
ORDER = ("lead", "researcher", "critic", "maker")
TASK_ROLE = {"synthesis": "researcher", "deep_research": "researcher", "exploration": "researcher", "comparison": "researcher",
             "motivation_forward": "lead", "aim_expand": "lead", "critical_validation": "critic", "evolution_review": "critic",
             "high_priority_artifact": "maker"}
FAMILY = {"codex_local": "openai", "claude_local": "anthropic", "codebuddy_local": "codebuddy", "hermes_local": "hermes",
          "llm": "pga", "gemini_local": "google", "opencode_local": "opencode"}

PLAN = """You coordinate a small team of AI agents from different makers working for one user on a long-range aim.
Plan this round: pick at most three concrete tasks that move the aim forward now, each for one teammate role
(researcher, critic, maker). Prefer what the user's corrections ask for. Do not repeat finished work.
Reply with JSON only: {"focus": "one sentence: what this round is about",
"tasks": [{"role": "researcher|critic|maker", "task": "what exactly to do and what to hand back"}]}"""

WORK = """You are {role_en} You work in a team of agents from different makers for one user's long-range aim.
Do your task well and concretely; say plainly what you are unsure of. Write in the user's language ({lang})."""

REVIEW = """You review your teammates' work for one user's long-range aim. Be specific and fair: what is wrong or
missing, which claims are weak, and what would fix it. Keep it short. Write in the user's language ({lang})."""

SUMMARY = """You coordinate the team. Merge this round into a short report for the user: what was found or made,
what the reviewer flagged, and the next steps. Write in the user's language ({lang}).
Reply with JSON only: {{"summary": "the report", "next": ["next step", "…"], "ask_user": "a question only if you need one"}}"""

REVISE = """The user added a correction or idea to their long-range aim. Work out what should change so the system
follows it. You may: update a responsibility's description, priority (-1..1) or keywords; open a bounded candidate
responsibility (the user approves it later); propose to pause, resume or complete a responsibility, or to add a new
perpetual one (the user applies these). Change only what the correction implies. Never rewrite the aim itself.
Reply with JSON only:
{"understanding": "what the user wants, in one sentence, in the user's language",
 "changes": [{"action": "update", "id": "R1", "description": "new description (optional)", "priority": 0.0, "keywords": ["…"], "why": "…"},
             {"action": "candidate", "parent": "R1", "title": "…", "description": "…", "why": "…"},
             {"action": "pause|resume|complete", "id": "R2", "why": "…"},
             {"action": "new", "title": "…", "description": "…", "why": "…"}],
 "note_for_team": "what the team should keep in mind from now on",
 "summary_for_user": "what will change, in the user's language"}"""


class TeamError(ValueError):
    pass


def _lang(user: User | None) -> str:
    loc = (user.locale if user else "") or "en"
    return "Chinese" if loc.lower().startswith("zh") else "English"


class TeamService:
    def __init__(self, rt: "Runtime", pool=None, commit_steps: bool = False):
        from pga.agents.pool import AgentPool
        from pga.agents.routing import AgentRouter
        self.rt = rt
        self.pool = pool or AgentPool(rt)
        self.commit_steps = commit_steps                 # in a job: each note is saved as it is written, so you see the round live
        self.router = AgentRouter(rt, self.pool)

    # -------------------------------------------------------------- who is on the team

    def roster(self, aim: Aim) -> list[dict]:
        spent = self.pool.spent_today()
        pinned = dict(aim.team or {})
        used: list[str] = []
        families: set[str] = set()
        out = []
        for role in ORDER:
            spec = ROLES[role]
            ranked = [x["agent"] for x in self.router.rank(spec["category"]) if x["usable"]]
            extra = [n for n, a in self.pool.cfg["agents"].items() if set(spec["caps"]) & set(a.get("capabilities") or [])
                     and n not in ranked and self.pool.usable(n, spent)[0]]
            choices = ranked + extra
            want, why = pinned.get(role), ""
            if want and want in self.pool.adapters:
                ok, why = self.pool.usable(want, spent)
                agent, by = (want, "you") if ok else (None, "you")
            else:
                agent, by = None, "auto"
            if agent is None:
                fam = lambda n: FAMILY.get(self.pool.adapters[n].type, n)  # noqa: E731
                agent = (next((n for n in choices if n not in used and fam(n) not in families), None)
                         or next((n for n in choices if n not in used), None) or (choices[0] if choices else None))
            if agent:
                used.append(agent)
                families.add(FAMILY.get(self.pool.adapters[agent].type, agent))
            out.append({"role": role, "label": spec["label"], "does": spec["en"], "agent": agent, "pinned": want,
                        "chosen_by": by if agent == want else "auto", "pinned_unusable": why if want and agent != want else ""})
        return out

    def member(self, aim: Aim, role: str) -> str | None:
        return next((m["agent"] for m in self.roster(aim) if m["role"] == role), None)

    def set_member(self, aim: Aim, role: str, agent: str | None) -> list[dict]:
        if role not in ROLES:
            raise TeamError(f"unknown role {role!r}")
        if agent and agent not in self.pool.adapters:
            raise TeamError(f"unknown agent {agent!r}")
        team = dict(aim.team or {})
        if agent:
            team[role] = agent
        else:
            team.pop(role, None)
        aim.team = team
        self.rt.session.flush()
        return self.roster(aim)

    # -------------------------------------------------------------- the board

    def notes(self, aim: Aim, limit: int = 60, kinds: tuple[str, ...] | None = None) -> list[AimNote]:
        q = select(AimNote).where(AimNote.aim_id == aim.id)
        if kinds:
            q = q.where(AimNote.kind.in_(kinds))
        return list(reversed(list(self.rt.session.scalars(q.order_by(AimNote.created_at.desc()).limit(limit)))))

    def _note(self, aim: Aim, kind: str, text: str, *, role: str | None = None, agent: str | None = None, text_en: str = "",
              data: dict | None = None, status: str = "done", round_id: uuid.UUID | None = None, now: datetime | None = None) -> AimNote:
        n = AimNote(user_id=aim.user_id, aim_id=aim.id, kind=kind, role=role, agent=agent, text=text[:20000], text_en=text_en[:20000],
                    data=data or {}, status=status, round_id=round_id, created_at=now or utcnow())
        self.rt.session.add(n)
        self.rt.session.flush()
        if self.commit_steps:
            self.rt.session.commit()
        return n

    def responsibilities(self, aim: Aim) -> list[Responsibility]:
        return list(self.rt.session.scalars(select(Responsibility).where(
            Responsibility.aim_id == aim.id, Responsibility.status.notin_([S.ARCHIVED])).order_by(Responsibility.created_at)))

    def context(self, aim: Aim, *, corrections: int = 8, summaries: int = 1) -> str:
        """The aim as the team sees it: its words, your corrections (newest last), its responsibilities, the last report."""
        parts = [f"<aim>\n{aim.text_en}\n</aim>"]
        cs = self.notes(aim, corrections, ("correction",))
        if cs:
            parts.append("<user_corrections>\nThe user's later guidance on this aim (newest last; it wins over older text):\n"
                         + "\n".join(f"- [{c.created_at.date().isoformat()}] {c.text_en or c.text}" for c in cs) + "\n</user_corrections>")
        rs = self.responsibilities(aim)
        if rs:
            parts.append("<responsibilities>\n" + "\n".join(
                f"R{i + 1}. {r.title_en} — {r.status.value}, tension {r.tension:.2f}, priority {r.priority_bias:+.1f}"
                + (f"\n    {r.description_en[:300]}" if r.description_en else "") for i, r in enumerate(rs)) + "\n</responsibilities>")
        sm = self.notes(aim, summaries, ("summary",))
        if sm:
            parts.append("<last_team_report>\n" + "\n".join(s.text[:1500] for s in sm) + "\n</last_team_report>")
        return "\n\n".join(parts)

    # -------------------------------------------------------------- calling one member

    def _ask(self, aim: Aim, role: str, prompt: str, system: str, *, want_json: bool, step: str, round_id: uuid.UUID) -> tuple[str, str | None]:
        """One member does one step; if it fails, PGA's own model stands in. Returns (text, agent)."""
        from pga.agents.pool import PoolResult
        user = self.rt.session.get(User, aim.user_id)
        agent = self.member(aim, role)
        names = [n for n in [agent] + [n for n, a in self.pool.adapters.items() if a.type == "llm"] if n]
        steps, t0 = [], utcnow()
        for name in dict.fromkeys(names):
            st = self.pool._call(name, self.pool._task(name, prompt, system=system, kind="team", workspace=self.pool._workspace(round_id, "team", f"{role}-{name}"),
                                                       permissions="read_only", timeout_s=None, want_json=want_json,
                                                       meta={"category": ROLES[role]["category"], "workflow": "team", "task_kind": f"team:{role}"}), step)
            steps.append(st)
            ok = st.result.ok and st.result.text.strip()
            if ok and want_json:
                try:
                    parse_json(st.result.text)
                except ModelOutputError:
                    st.result.ok, st.result.status, st.result.error, ok = False, "FAILED", "reply was not the JSON the step needs", False
            if ok:
                res = PoolResult(True, st.result.text, "team", "single", {"agent": name, "role": role, "aim": str(aim.id), "step": step}, steps)
                res.run_id = uuid.uuid4()
                self.pool._record(res, prompt[:4000], user, None, None, t0)
                return st.result.text, name
        res = PoolResult(False, "", "team", "single", {"role": role, "aim": str(aim.id), "step": step}, steps,
                         error="; ".join(f"{s.result.agent}: {s.result.error}" for s in steps)[:800])
        res.run_id = uuid.uuid4()
        self.pool._record(res, prompt[:4000], user, None, None, t0)
        return "", None

    # -------------------------------------------------------------- a round

    def round(self, aim: Aim, now: datetime | None = None) -> dict:
        now = now or utcnow()
        user = self.rt.session.get(User, aim.user_id)
        lang, rid, ctx = _lang(user), uuid.uuid4(), self.context(aim)
        out: dict[str, Any] = {"round_id": str(rid), "tasks": [], "summary": None}
        text, who = self._ask(aim, "lead", f"{ctx}\n\nPlan this round.", PLAN, want_json=True, step="plan", round_id=rid)
        try:
            plan = parse_json(text) if text else {}
        except ModelOutputError:
            plan = {}
        tasks = [t for t in (plan.get("tasks") or []) if isinstance(t, dict) and t.get("role") in ROLES and t.get("role") != "lead" and t.get("task")][:3]
        if not tasks:
            tasks = [{"role": "researcher", "task": "What changed or matters most for this aim now? Report the 3 most useful findings."}]
        self._note(aim, "plan", str(plan.get("focus") or "本轮：先看现在最重要的变化"), role="lead", agent=who, data={"tasks": tasks}, round_id=rid, now=now)
        jobs = []
        for t in tasks:
            role = t["role"]
            agent = self.member(aim, role)
            if not agent:
                continue
            jobs.append((role, agent, t["task"]))
        results = []
        for role, _agent, task in jobs:                     # one at a time: each member may be a slow local agent with its own limits
            body = f"{ctx}\n\n<your_task role=\"{role}\">\n{task}\n</your_task>"
            txt, who2 = self._ask(aim, role, body, WORK.format(role_en=ROLES[role]["en"] + ".", lang=lang), want_json=False, step="work", round_id=rid)
            self._note(aim, "work", txt or "（这一步没有完成）", role=role, agent=who2, data={"task": task}, status="done" if txt else "failed", round_id=rid, now=utcnow())
            results.append({"role": role, "agent": who2, "task": task, "ok": bool(txt)})
            out["tasks"].append(results[-1])
        done = [n for n in self.notes(aim, 10, ("work",)) if n.round_id == rid and n.status == "done"]
        if done and not any(r["role"] == "critic" for r in results):
            listing = "\n\n".join(f"<work role=\"{n.role}\" agent=\"{n.agent}\">\n{n.text[:5000]}\n</work>" for n in done)
            txt, who3 = self._ask(aim, "critic", f"{ctx}\n\n{listing}", REVIEW.format(lang=lang), want_json=False, step="review", round_id=rid)
            if txt:
                self._note(aim, "review", txt, role="critic", agent=who3, round_id=rid, now=utcnow())
        board = "\n\n".join(f"<{n.kind} role=\"{n.role}\">\n{n.text[:4000]}\n</{n.kind}>" for n in self.notes(aim, 12) if n.round_id == rid)
        txt, who4 = self._ask(aim, "lead", f"{ctx}\n\n<this_round>\n{board}\n</this_round>", SUMMARY.format(lang=lang), want_json=True, step="summary", round_id=rid)
        try:
            sm = parse_json(txt) if txt else {}
        except ModelOutputError:
            sm = {}
        summary = str(sm.get("summary") or "").strip()
        if summary:
            nxt = [str(x) for x in (sm.get("next") or []) if str(x).strip()][:5]
            self._note(aim, "summary", summary + ("\n\n下一步：\n" + "\n".join(f"- {x}" for x in nxt) if nxt else ""), role="lead", agent=who4,
                       data={"next": nxt, "ask_user": sm.get("ask_user") or ""}, round_id=rid, now=utcnow())
            out["summary"] = summary
        return out

    # -------------------------------------------------------------- corrections

    def add_correction(self, aim: Aim, text: str, text_en: str, now: datetime | None = None) -> AimNote:
        if not text.strip():
            raise TeamError("a correction needs some words")
        return self._note(aim, "correction", text.strip(), text_en=text_en.strip(), status="pending", now=now)

    def revise(self, aim: Aim, note: AimNote, now: datetime | None = None) -> dict:
        """The lead turns one correction into changes: the safe ones applied now, the rest proposed to you."""
        now = now or utcnow()
        user = self.rt.session.get(User, aim.user_id)
        rs = self.responsibilities(aim)
        ids = {f"R{i + 1}": r for i, r in enumerate(rs)}
        prompt = f"{self.context(aim)}\n\n<new_correction>\n{note.text_en or note.text}\n</new_correction>\nThe user writes in {_lang(user)}."
        txt, who = self._ask(aim, "lead", prompt, REVISE, want_json=True, step="revise", round_id=note.id)
        try:
            d = parse_json(txt) if txt else None
        except ModelOutputError:
            d = None
        if not isinstance(d, dict):
            note.status, note.data = "applied", {**(note.data or {}), "understanding": "", "applied": [], "proposed": [],
                                                 "error": "没有得到可用的调整方案；这条修正已经写进了所有读取这个抱负的地方"}
            return note.data
        applied, proposed = [], []
        for c in (d.get("changes") or [])[:8]:
            if not isinstance(c, dict):
                continue
            act, r = str(c.get("action") or ""), ids.get(str(c.get("id") or ""))
            why = str(c.get("why") or "")[:300]
            try:
                if act == "update" and r is not None:
                    did = []
                    if c.get("description"):
                        r.description_en = str(c["description"])[:2000]
                        did.append("说明")
                    if isinstance(c.get("priority"), (int, float)):
                        r.priority_bias = max(-1.0, min(1.0, float(c["priority"])))
                        did.append(f"优先级 {r.priority_bias:+.1f}")
                    if isinstance(c.get("keywords"), list):
                        r.keywords = list(dict.fromkeys([*(r.keywords or []), *[str(k)[:40] for k in c["keywords"]]]))[:20]
                        did.append("关键词")
                    if did:
                        applied.append({"action": "update", "id": str(r.id), "title": r.title_en, "what": "、".join(did), "why": why})
                elif act == "candidate":
                    parent = ids.get(str(c.get("parent") or "")) or next((x for x in rs if x.status != S.CANDIDATE), None)
                    if parent is not None and c.get("title"):
                        cand = self.rt.responsibilities.create_candidate(parent, title_en=str(c["title"])[:200], description_en=str(c.get("description") or "")[:2000],
                                                                        actor=Origin.AGENT, exploration_budget={"max_units": 60000}, now=now)
                        cand.aim_id = aim.id
                        applied.append({"action": "candidate", "id": str(cand.id), "title": cand.title_en, "what": "开了一个候选职责（需要你批准才会长期运行）", "why": why})
                    elif c.get("title"):
                        proposed.append({"action": "new", "title": str(c["title"])[:200], "description": str(c.get("description") or "")[:2000], "why": why})
                elif act in ("pause", "resume", "complete") and r is not None:
                    proposed.append({"action": act, "id": str(r.id), "title": r.title_en, "why": why})
                elif act == "new" and c.get("title"):
                    proposed.append({"action": "new", "title": str(c["title"])[:200], "description": str(c.get("description") or "")[:2000], "why": why})
            except Exception as exc:  # noqa: BLE001 - one change failing must not drop the others
                log.info("revise change %s failed: %s", act, exc)
        for p in proposed:
            p["applied"] = False
        note.status = "applied"
        note.data = {**(note.data or {}), "understanding": str(d.get("understanding") or "")[:600], "applied": applied, "proposed": proposed,
                     "summary": str(d.get("summary_for_user") or "")[:1500], "by": who}
        if d.get("note_for_team"):
            self._note(aim, "change", str(d["note_for_team"])[:2000], role="lead", agent=who, data={"correction": str(note.id)}, round_id=note.id, now=now)
        self.rt.session.flush()
        return note.data

    def apply_proposal(self, aim: Aim, note: AimNote, index: int, now: datetime | None = None) -> dict:
        """You clicked one of the lead's proposals: it runs as your action."""
        props = list((note.data or {}).get("proposed") or [])
        if not 0 <= index < len(props) or props[index].get("applied"):
            raise TeamError("no such proposal, or already applied")
        p = dict(props[index])
        if p["action"] == "new":
            r = self.rt.responsibilities.create(user_id=aim.user_id, title_en=p["title"], description_en=p.get("description", ""), actor=Origin.USER)
            r.aim_id = aim.id
            p["id"] = str(r.id)
        else:
            r = self.rt.session.get(Responsibility, uuid.UUID(p["id"]))
            if r is None or r.user_id != aim.user_id:
                raise TeamError("that responsibility is gone")
            op = {"pause": "pause", "complete": "complete", "resume": "unpause" if r.paused_by_user else "resume"}[p["action"]]
            self.rt.responsibilities.transition(r, op, actor=Origin.USER, reason=f"from a correction: {p.get('why', '')}"[:300], now=now)
        p["applied"] = True
        props[index] = p
        note.data = {**note.data, "proposed": props}
        self.rt.session.flush()
        return p

    # -------------------------------------------------------------- talking to one member

    def ask_context(self, aim: Aim, role: str) -> str:
        if role not in ROLES:
            raise TeamError(f"unknown role {role!r}")
        board = self.notes(aim, 6, ("plan", "work", "review", "summary", "change"))
        recent = "\n".join(f"- [{n.kind} · {n.role or ''} · {n.agent or ''}] {n.text[:600]}" for n in board)
        return (f"You are {ROLES[role]['en']}, in the user's team for this long-range aim. The user is talking to you directly "
                f"about it. Answer from what the team knows; say what you would do next.\n\n{self.context(aim)}"
                + (f"\n\n<recent_team_board>\n{recent}\n</recent_team_board>" if recent else ""))


def corrections_block(session, aim_id: uuid.UUID, limit: int = 6) -> str:
    """For any prompt that reads an aim: the user's later guidance on it (newest last)."""
    rows = list(session.scalars(select(AimNote).where(AimNote.aim_id == aim_id, AimNote.kind == "correction")
                                .order_by(AimNote.created_at.desc()).limit(limit)))
    if not rows:
        return ""
    return "The user's later guidance on this aim (newest last; it wins over older text): " + " | ".join(
        (n.text_en or n.text)[:400] for n in reversed(rows))


def due_rounds(session, user_id: uuid.UUID, now: datetime, every_h: float = 24) -> list[Aim]:
    """Aims whose team runs on its own (`team.auto`) and has not met for `every_h` hours."""
    out = []
    for a in session.scalars(select(Aim).where(Aim.user_id == user_id)):
        if not (a.team or {}).get("auto"):
            continue
        last = session.scalar(select(AimNote.created_at).where(AimNote.aim_id == a.id, AimNote.kind == "summary")
                              .order_by(AimNote.created_at.desc()).limit(1))
        if last is None or now - last >= timedelta(hours=every_h):
            out.append(a)
    return out


def _register() -> None:
    """A team set to meet on its own (`team.auto`) holds a round about once a day."""
    from pga.workflow.scheduler import register_planner

    @register_planner
    def plan_team_rounds(rt: "Runtime", user: User, now: datetime) -> list[dict]:
        return [{"kind": "team.round", "key": f"team:{a.id}", "priority": 150, "payload": {"aim_id": str(a.id)}}
                for a in due_rounds(rt.session, user.id, now)]


_register()
