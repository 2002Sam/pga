"""How a motivation shares its work out among agents (多 agent 分配).

Every usable agent that can do a role (its capabilities match) gets a score, from five things you can weigh yourself, per motivation:

    score = w_perf · performance + w_pref · your preference + w_balance · remaining balance
            − w_cost · cost + w_speed · speed

    performance  half its quality rating (agents.yaml traits), half how often its recent work for this kind of
                 step actually came back usable (learned from the ledger)
    preference   0–1 per agent, set by you (an agent you pinned to this role in the team counts as 1)
    balance      the share of its quota left (agents at or below your reserve are not used at all)
    cost, speed  its traits, 0–1

Scores become target shares with a softmax: share_i = exp(score_i / T) / Σ exp(score_j / T). A low temperature
T concentrates the work on the best agent; a high one spreads it. Each step draws its agent by those shares, so
over time the real split follows the target — the console shows both side by side.

Many motivations are many-sided: with `parallel` > 1, a research step answers several open questions at once,
each with a different agent drawn by share (fan-out, then each answer is folded back in on its own).
"""

from __future__ import annotations

import math
import random
from datetime import datetime, timedelta
from typing import TYPE_CHECKING

from sqlalchemy import select

from pga.db.models import AgentRun
from pga.db.types import utcnow

if TYPE_CHECKING:
    from pga.db.models import Aim, PerpetualTask

DEFAULT_ALLOC = {"w_perf": 1.0, "w_pref": 1.0, "w_balance": 1.0, "w_cost": 0.4, "w_speed": 0.3,
                 "temperature": 0.35, "parallel": 1, "prefs": {}}
WEIGHTS = ("w_perf", "w_pref", "w_balance", "w_cost", "w_speed")
LIMITS = {**{w: (0.0, 3.0) for w in WEIGHTS}, "temperature": (0.05, 2.0), "parallel": (1, 4)}


def clean(alloc: dict | None) -> dict:
    """Your settings, within bounds; unknown keys dropped."""
    a = {**DEFAULT_ALLOC, **{k: v for k, v in (alloc or {}).items() if k in DEFAULT_ALLOC}}
    for k, (lo, hi) in LIMITS.items():
        try:
            a[k] = max(lo, min(hi, float(a[k])))
        except (TypeError, ValueError):
            a[k] = DEFAULT_ALLOC[k]
    a["parallel"] = int(a["parallel"])
    a["prefs"] = {str(n): max(0.0, min(1.0, float(v))) for n, v in (a.get("prefs") or {}).items()
                  if isinstance(v, (int, float))}
    return a


def softmax(scores: list[float], temperature: float) -> list[float]:
    if not scores:
        return []
    m = max(scores)
    ex = [math.exp((s - m) / max(1e-6, temperature)) for s in scores]
    z = sum(ex)
    return [e / z for e in ex]


class Allocation:
    def __init__(self, eng):
        self.eng = eng                          # pga.perpetual.Perpetual
        self.s = eng.s
        self._perf: dict[tuple[str, str], tuple[float, int]] = {}

    def settings(self, t: "PerpetualTask") -> dict:
        return clean((t.settings or {}).get("alloc"))

    def performance(self, agent: str, step: str) -> tuple[float, int]:
        """(0–1, runs seen): half its quality trait, half its recent success at this step."""
        key = (agent, step)
        if key not in self._perf:
            q = float(((self.eng.pool.cfg["agents"].get(agent) or {}).get("traits") or {}).get("quality", 3)) / 5
            rows = list(self.s.execute(select(AgentRun.status, AgentRun.output).where(
                AgentRun.agent == agent, AgentRun.parent_id.is_not(None), AgentRun.workflow == "perpetual",
                AgentRun.started_at >= utcnow() - timedelta(days=14)).order_by(AgentRun.started_at.desc()).limit(40)))
            n = len(rows)
            ok = sum(1 for st, out in rows if st == "SUCCEEDED" and (out or "").strip())
            rate = ok / n if n else q                        # nothing seen yet: trust the rating
            self._perf[key] = (round(.5 * q + .5 * rate, 3), n)
        return self._perf[key]

    def table(self, t: "PerpetualTask", aim: "Aim", role: str, step: str, now: datetime | None = None) -> list[dict]:
        """Every agent this motivation could use for a role: its five parts, score and target share."""
        now = now or utcnow()
        a = self.settings(t)
        c = self.eng.cfg(t)
        pinned = (aim.team or {}).get(role)
        spent = self.eng.pool.spent_today()
        from pga.agents.pool import busy
        from pga.perpetual import PAID
        from pga.teams import ROLES
        want = set(ROLES.get(role, {}).get("caps", ())) | {ROLES.get(role, {}).get("category", "")}
        fit = [n for n in self.eng.pool.adapters if want & set((self.eng.pool.cfg["agents"].get(n) or {}).get("capabilities") or [])]
        rows = []
        for name in fit or list(self.eng.pool.adapters):                  # only agents that can do this role
            ad = self.eng.pool.adapters[name]
            spec = self.eng.pool.cfg["agents"].get(name) or {}
            tr = spec.get("traits") or {}
            ok, why = self.eng.pool.usable(name, spent)
            if ok and not c["use_paid"] and ad.type in PAID:
                ok, why = False, "按次付费的模型：在设置里允许后才会用"
            q = self.eng.router.quota(name)
            bal = q.remaining if q.remaining is not None else 0.7
            if ok and (q.exhausted or (q.remaining is not None and q.remaining <= float(c["reserve"]))):
                ok, why = False, f"额度只剩给你保留的部分（{q.detail}）"
            perf, n = self.performance(name, step)
            pref = 1.0 if pinned == name else a["prefs"].get(name, 0.5)
            parts = {"performance": perf, "preference": pref, "balance": round(bal, 3),
                     "cost": tr.get("cost", 3) / 5, "speed": tr.get("speed", 3) / 5}
            score = (a["w_perf"] * parts["performance"] + a["w_pref"] * parts["preference"] + a["w_balance"] * parts["balance"]
                     - a["w_cost"] * parts["cost"] + a["w_speed"] * parts["speed"])
            rows.append({"agent": name, "usable": ok, "why_not": why, "parts": parts, "score": round(score, 3), "seen": n,
                         "busy": busy(name, int(spec.get("max_concurrent", 1))), "pinned": pinned == name,
                         "quota": q.as_dict(), "share": 0.0})
        usable = [r for r in rows if r["usable"]]
        for r, sh in zip(usable, softmax([r["score"] for r in usable], a["temperature"])):
            r["share"] = round(sh, 4)
        rows.sort(key=lambda r: (not r["usable"], -r["share"], -r["score"]))
        return rows

    def draw(self, rows: list[dict], k: int = 1, rng: random.Random | None = None) -> list[str]:
        """k different agents, drawn by share (busy ones only if nothing else is free)."""
        rng = rng or random
        pool = [r for r in rows if r["usable"] and not r["busy"]] or [r for r in rows if r["usable"]]
        out: list[str] = []
        while pool and len(out) < k:
            total = sum(r["share"] for r in pool) or 1.0
            x, acc = rng.random() * total, 0.0
            for r in pool:
                acc += r["share"]
                if x <= acc:
                    break
            out.append(r["agent"])
            pool = [p for p in pool if p["agent"] != r["agent"]]
        return out

    def actual(self, t: "PerpetualTask", hours: float = 24) -> dict[str, float]:
        """How the work really went out over the last `hours` (share of steps per agent)."""
        since = utcnow() - timedelta(hours=hours)
        counts: dict[str, int] = {}
        for e in t.ledger or []:
            try:
                if datetime.fromisoformat(e.get("at")) < since:
                    break
            except (TypeError, ValueError):
                continue
            for ag in (e.get("agents") or ([e["agent"]] if e.get("agent") else [])):
                counts[ag] = counts.get(ag, 0) + 1
        z = sum(counts.values())
        return {k: round(v / z, 4) for k, v in counts.items()} if z else {}
