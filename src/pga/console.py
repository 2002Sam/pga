"""The console (工作台): one place to see and steer the work.

    motivations (aims) → their project folders → whether each is being worked on
    the process of one motivation: who is working right now and what they are saying, and the self-dialogue so far —
        questions it asked itself, which agent answered, who reviewed, what it reflected — each with its full trace
    every agent: what it is doing, how much quota is left; stop it, switch it off or on

Everything here is read from what already exists (perpetual tasks, the agent ledger, the aim's board, the live
registry); the only new state is the trace each run now keeps (`AgentRun.data["trace"]`).
"""

from __future__ import annotations

import json
import uuid
from datetime import datetime
from typing import TYPE_CHECKING

from sqlalchemy import select

from pga.db.models import AgentRun, Aim, AimNote, PerpetualTask, Project, User
from pga.db.types import utcnow

if TYPE_CHECKING:
    from pga.runtime import Runtime

NOTE_KINDS = ("question", "answer", "insight", "evolve", "reflect", "correction", "checkpoint")


class ConsoleError(ValueError):
    pass


def _iso(d: datetime | None) -> str | None:
    return d.isoformat() if d else None


def _answer_text(raw: str) -> str:
    """Agents reply in JSON for the perpetual loop; show the human part of it."""
    s = (raw or "").strip()
    if s.startswith("{"):
        try:
            d = json.loads(s)
            for k in ("answer", "summary", "reflection", "text", "verdict", "thought"):
                if isinstance(d.get(k), str) and d[k].strip():
                    return d[k]
            if isinstance(d.get("questions"), list):
                return "\n".join(f"· {q.get('q') if isinstance(q, dict) else q}" for q in d["questions"])
        except (ValueError, AttributeError):
            pass
    return s


class Console:
    def __init__(self, rt: "Runtime"):
        self.rt = rt
        self.s = rt.session

    # -------------------------------------------------------------- the overview

    def overview(self, user: User) -> dict:
        from pga.agents import live
        from pga.perpetual import PHASE_ZH, Perpetual
        from pga.projects import Projects

        eng = Perpetual(self.rt)
        projects = Projects(self.s).list(user.id)
        running = live.snapshot()
        tasks = {t.aim_id: t for t in self.s.scalars(select(PerpetualTask).where(PerpetualTask.user_id == user.id))}
        aims = list(self.s.scalars(select(Aim).where(Aim.user_id == user.id).order_by(Aim.position, Aim.created_at)))
        open_q = {}
        for n in self.s.scalars(select(AimNote).where(AimNote.user_id == user.id, AimNote.kind == "question",
                                                      AimNote.status == "for_you")):     # questions only you can answer
            open_q[n.aim_id] = open_q.get(n.aim_id, 0) + 1

        def task_out(t: PerpetualTask | None) -> dict | None:
            if t is None:
                return None
            working = [r for r in running if r["running"] and (r.get("tags") or {}).get("perpetual") == str(t.id)]
            cfg = eng.cfg(t)
            return {"id": str(t.id), "status": t.status, "phase": t.phase, "phase_zh": PHASE_ZH.get(t.phase, t.phase),
                    "autonomy": cfg["autonomy"], "checkpoint_every": cfg["checkpoint_every"],
                    "since_checkpoint": eng.since_checkpoint(t), "checkpoint_pending": eng.pending_checkpoint(t) is not None,
                    "phase_note": t.phase_note, "pressure": t.pressure, "parts": t.parts or {}, "cycles": t.cycles,
                    "next_at": _iso(t.next_at), "phase_since": _iso(t.phase_since),
                    "project_id": str(t.project_id) if t.project_id else None,
                    "working": [{"id": r["id"], "agent": r["agent"], "step": r["step"], "role": (r.get("tags") or {}).get("role"),
                                 "elapsed_s": r["elapsed_s"]} for r in working]}

        def proj_out(p: Project) -> dict:
            t = tasks.get(p.aim_id) if p.aim_id else None
            on = t is not None and t.project_id == p.id
            return {"id": str(p.id), "name": p.name, "path": p.path, "full_access": p.full_access,
                    "aim_id": str(p.aim_id) if p.aim_id else None, "last_used_at": _iso(p.last_used_at),
                    "state": (t.status if on else "idle"), "phase_zh": PHASE_ZH.get(t.phase, t.phase) if on else None,
                    "working": sum(1 for r in running if r["running"] and (r.get("tags") or {}).get("project") == str(p.id))}

        out_aims = []
        for a in aims:
            t = tasks.get(a.id)
            out_aims.append({"id": str(a.id), "text": a.text, "position": a.position, "task": task_out(t),
                             "projects": [proj_out(p) for p in projects if p.aim_id == a.id],
                             "open_questions": open_q.get(a.id, 0),
                             "stats": eng.out(t) and {k: eng.out(t).get(k) for k in ("work_s", "rest_s", "pause_s", "rest_ratio")}
                             if t else None})
        return {"aims": out_aims, "free_projects": [proj_out(p) for p in projects if not p.aim_id],
                "agents": self.agents(running), "live": running, "now": utcnow().isoformat()}

    def agents(self, running: list[dict] | None = None) -> list[dict]:
        from pga.agents import live

        running = running if running is not None else live.snapshot()
        try:
            from pga.agents.pool import AgentPool
            pool = AgentPool(self.rt)
            status = pool.status()
        except Exception as exc:  # noqa: BLE001 - the console still shows the work if the pool cannot be read
            return [{"name": "?", "error": str(exc)}]
        out = []
        for name, st in status.items():
            mine = [r for r in running if r["agent"] == name]
            last = self.s.scalar(select(AgentRun).where(AgentRun.agent == name, AgentRun.parent_id.is_not(None))
                                 .order_by(AgentRun.started_at.desc()).limit(1))
            out.append({"name": name, "role": st.get("role"), "adapter": st.get("adapter"), "enabled": st.get("enabled", True),
                        "available": st.get("available"), "detail": st.get("detail"), "quota": st.get("quota"),
                        "external": st.get("external"),
                        "working": [{"id": r["id"], "step": r["step"], "workflow": r["workflow"], "elapsed_s": r["elapsed_s"],
                                     "tags": r.get("tags") or {}, "tail": r["text"][-400:]} for r in mine if r["running"]],
                        "last": None if last is None else {"at": _iso(last.started_at), "status": last.status,
                                                           "workflow": last.workflow, "step": last.step,
                                                           "duration_s": last.duration_s}})
        return out

    # -------------------------------------------------------------- the process of one motivation

    def process(self, user: User, aim_id: uuid.UUID, limit: int = 60) -> dict:
        """The self-dialogue: cycles, the questions it asked, who answered and reviewed, each with its trace."""
        from pga.agents import live
        from pga.perpetual import PHASE_ZH, Perpetual

        aim = self.s.get(Aim, aim_id)
        if aim is None or aim.user_id != user.id:
            raise ConsoleError("没有这个抱负")
        t = self.s.scalar(select(PerpetualTask).where(PerpetualTask.aim_id == aim.id))
        events: list[dict] = []
        runs = list(self.s.scalars(select(AgentRun).where(AgentRun.parent_id.is_not(None), AgentRun.workflow == "perpetual")
                                   .order_by(AgentRun.started_at.desc()).limit(limit * 3)))
        for r in runs:
            d = r.data or {}
            parent = self.s.get(AgentRun, r.parent_id)
            pd = (parent.data or {}) if parent is not None else {}
            if pd.get("aim") != str(aim.id):
                continue
            events.append({"type": "run", "at": _iso(r.started_at), "id": str(r.id), "agent": r.agent, "role": pd.get("role"),
                           "step": pd.get("step") or r.step, "step_zh": PHASE_ZH.get(pd.get("step") or r.step, r.step),
                           "status": r.status, "duration_s": r.duration_s, "summary": _answer_text(r.output)[:600],
                           "error": r.error, "has_trace": bool(d.get("trace"))})
            if len([e for e in events if e["type"] == "run"]) >= limit:
                break
        said = {" ".join(e["summary"].split())[:60] for e in events if e["type"] == "run" and e["summary"]}
        for n in self.s.scalars(select(AimNote).where(AimNote.aim_id == aim.id, AimNote.kind.in_(NOTE_KINDS))
                                .order_by(AimNote.created_at.desc()).limit(limit)):
            if n.kind in ("answer", "reflect", "insight") and not (n.data or {}).get("samples") and " ".join(n.text.split())[:60] in said:
                continue                                  # the step that wrote it is already on the timeline
            events.append({"type": "note", "at": _iso(n.created_at), "id": str(n.id), "kind": n.kind, "status": n.status,
                           "role": n.role, "agent": n.agent, "text": n.text[:1500], "data": n.data or {}})
        events.sort(key=lambda e: e["at"] or "", reverse=True)
        working = [r for r in live.snapshot() if t is not None and (r.get("tags") or {}).get("perpetual") == str(t.id)]
        eng = Perpetual(self.rt) if t is not None else None
        cp = eng.pending_checkpoint(t) if eng else None
        cfg = eng.cfg(t) if eng else {}
        return {"aim": {"id": str(aim.id), "text": aim.text}, "task": None if t is None else {
                    "id": str(t.id), "status": t.status, "phase": t.phase, "phase_zh": PHASE_ZH.get(t.phase, t.phase),
                    "phase_note": t.phase_note, "pressure": t.pressure, "parts": t.parts or {}, "cycles": t.cycles,
                    "next_at": _iso(t.next_at), "ledger": (t.ledger or [])[:30],
                    "project_id": str(t.project_id) if t.project_id else None, "autonomy": cfg.get("autonomy"),
                    "checkpoint_every": cfg.get("checkpoint_every"), "since_checkpoint": eng.since_checkpoint(t),
                    "samples": cfg.get("samples"), "perturb": cfg.get("perturb")},
                "checkpoint": None if cp is None else {"id": str(cp.id), "at": _iso(cp.created_at), "agent": cp.agent, **(cp.data or {})},
                "live": working, "events": events[: limit * 2],
                "for_you": [{"id": str(n.id), "text": n.text, "agent": n.agent, "role": n.role, "data": n.data or {},
                             "at": _iso(n.created_at)}
                            for n in self.s.scalars(select(AimNote).where(AimNote.aim_id == aim.id, AimNote.kind == "question",
                                                                          AimNote.status == "for_you")
                                                    .order_by(AimNote.created_at))]}

    def run_detail(self, user: User, run_id: uuid.UUID) -> dict:
        r = self.s.get(AgentRun, run_id)
        if r is None or (r.user_id and r.user_id != user.id):
            raise ConsoleError("没有这条记录")
        return {"id": str(r.id), "agent": r.agent, "adapter": r.adapter, "step": r.step, "status": r.status,
                "started_at": _iso(r.started_at), "duration_s": r.duration_s, "prompt": r.prompt, "output": r.output,
                "answer": _answer_text(r.output), "trace": (r.data or {}).get("trace") or "", "error": r.error,
                "model": (r.data or {}).get("model")}

    # -------------------------------------------------------------- control

    def project_run(self, user: User, project_id: uuid.UUID, action: str) -> dict:
        """▶ / ⏸ for a project: its motivation's perpetual task works in this folder, or pauses."""
        from pga.agents import live
        from pga.perpetual import Perpetual
        from pga.projects import Projects

        p = Projects(self.s).get(user.id, project_id)
        if action not in ("start", "pause"):
            raise ConsoleError("action is start or pause")
        if p.aim_id is None:
            raise ConsoleError("这个文件夹还不属于任何抱负：先在「属于」里选一个抱负，它才知道要为什么而工作")
        aim = self.s.get(Aim, p.aim_id)
        eng = Perpetual(self.rt)
        t = self.s.scalar(select(PerpetualTask).where(PerpetualTask.aim_id == aim.id))
        stopped: list[str] = []
        if action == "start":
            if t is None or t.project_id != p.id:
                t = eng.create(user, aim, p)            # (re)aims the motivation's work at this folder
            else:
                eng.set_status(t, "running")
        else:
            if t is None:
                return {"state": "idle"}
            eng.set_status(t, "paused")
            stopped = live.stop_where(perpetual=str(t.id))   # what it is doing right now stops too
        self.s.flush()
        return {"state": t.status, "task_id": str(t.id), "stopped": stopped}

    def set_agent_enabled(self, name: str, enabled: bool) -> dict:
        from pga.agents import pool as poolmod

        data = poolmod.load()
        agents = data.get("agents") or {}
        if name not in agents:
            raise ConsoleError(f"没有这个 agent：{name}")
        if enabled:
            agents[name].pop("enabled", None)
        else:
            agents[name]["enabled"] = False
        poolmod.save(data)
        stopped = [] if enabled else stop_agent(name)
        return {"name": name, "enabled": enabled, "stopped": stopped}


def stop_agent(name: str) -> list[str]:
    from pga.agents import live

    return live.stop_where(agent=name)
