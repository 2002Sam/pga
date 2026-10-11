"""Motivation Forward (spec §4) and R0 — the self-improvement responsibility (§5).

    Tension decides when to reconsider.  Motivation Forward decides whether action is worth taking.

When a responsibility wakes, the research step no longer starts on its own: a cheap model first answers the
nine questions (still aligned? what changed? what uncertainty matters? what decision could more work change?
marginal value? what next? how much budget? stop condition? need the user?) and picks one constrained action.

R0 is built in and permanent. Its "environment" is the agent itself: telemetry signals push its tension up only
when they are measurably bad (with enough samples), and only as far as the worst signal justifies; time alone
just lets it fade. When R0 tension crosses its wake line, the same Motivation Forward decides whether an
Evolution Round is worth its budget.
"""

from __future__ import annotations

import logging
import math
import uuid
from datetime import datetime
from typing import TYPE_CHECKING

from sqlalchemy import func, select

from pga.agent.common import UNTRUSTED_NOTE, ModelOutputError, clamp01, fence, parse_json
from pga.aims import AimService
from pga.allocator import Estimates, Justification, RunRequest
from pga.db.models import Belief, EvolutionRound, ImprovementProposal, MotivationDecision, R0State, Responsibility, Run, User
from pga.db.types import BeliefType, utcnow
from pga.evolution.telemetry import SIGNALS, compute

if TYPE_CHECKING:
    from pga.runtime import Runtime

log = logging.getLogger("pga.evolution")

ALLOWED = ("DEEP_RESEARCH", "EXECUTE", "MONITOR", "GENERATE_ARTIFACT", "ASK_USER", "INVITE_MEETING",
           "CREATE_CANDIDATE_RESPONSIBILITY", "SELF_IMPROVE", "SLEEP", "ARCHIVE")
R0_ALLOWED = ("SELF_IMPROVE", "MONITOR", "SLEEP")

FORWARD_SYSTEM = f"""You are the Motivation Forward of a long-lived personal agent. A responsibility's tension crossed its
wake line, which only means "reconsider". Decide whether more work is worth it right now, and if so what kind.
Be frugal: if nothing material changed or no decision depends on more work, choose MONITOR or SLEEP.
Never change the user's goals. {UNTRUSTED_NOTE}

Reply with JSON only:
{{"aligned": true, "changed": "what materially changed", "uncertainty": "the unresolved uncertainty that matters",
  "decision_affected": "what decision more work could change", "marginal_value": 0.0-1.0,
  "decision": "{'|'.join(ALLOWED)}", "budget": {{"max_output_tokens": 1500, "tier": 1-3}},
  "stop_condition": "...", "needs_user": false, "question": "only if ASK_USER", "reason": "one sentence"}}"""

R0_SYSTEM = f"""You are the Motivation Forward of R0, the responsibility that continuously improves a personal agent.
Telemetry about the agent itself raised R0's tension. Decide whether a bounded Evolution Round (diagnose → propose →
review → implement in isolation → verify → user-approved promotion) is worth its budget now. Improvement may touch
routing, prompts, workflows, skills and code; it must never change the user's motivation, ambitions, permissions,
safety policy, spending or publishing authority. {UNTRUSTED_NOTE}

Reply with JSON only:
{{"decision": "SELF_IMPROVE|MONITOR|SLEEP", "problem": "short_slug", "evidence": {{"signal": value}},
  "objective": {{"metric": "target, e.g. reduce by >=30%"}}, "constraints": {{"no_permission_change": true,
  "no_user_motivation_change": true}}, "budget": {{"cheap_tokens": 60000, "premium_tokens": 15000, "wall_time": "2h"}},
  "stop_condition": ["candidate achieves target", "budget exhausted"], "reason": "one sentence"}}"""


def _call(rt: "Runtime", user: User, *, kind: str, system: str, prompt: str, why: str, max_tokens: int, now: datetime,
          responsibility_id: uuid.UUID | None = None) -> tuple[dict | None, uuid.UUID | None, str]:
    decision = rt.allocator.allocate(RunRequest(
        user_id=user.id, kind=kind, responsibility_id=responsibility_id,
        justification=Justification(why_now=why, expected_gain="a justified decision about whether to spend more compute",
                                    decision_affected="whether and how this responsibility works next",
                                    budget={"max_output_tokens": max_tokens}, stop_condition="decision recorded"),
        estimates=Estimates(information_gain=0.5, decision_impact=0.7, user_relevance=0.6, urgency=0.4,
                            input_tokens=len(prompt) // 3 + 400, output_tokens=max_tokens // 2)), now=now)
    if not decision.allowed:
        return None, None, "; ".join(decision.reasons) or "no budget"
    try:
        with rt.runs.track(decision, now) as guard:
            result = rt.router.complete(decision.tier, system=system, messages=[{"role": "user", "content": prompt}],
                                        max_tokens=max_tokens, usage=guard.usage_context())
            try:
                data = parse_json(result.text)
            except ModelOutputError:
                guard.stop("model reply was not valid JSON")
                return None, guard.run.id, "unreadable model reply"
            guard.stop("decision recorded")
            return data, guard.run.id, ""
    except Exception as exc:  # noqa: BLE001 - a failed forward must fall back, never block the loop
        log.warning("motivation forward failed: %s", exc)
        return None, None, str(exc)[:200]


class MotivationForward:
    def __init__(self, rt: "Runtime"):
        self.rt = rt

    def decide(self, r: Responsibility, pending: list[str], now: datetime | None = None) -> MotivationDecision:
        rt, now = self.rt, now or utcnow()
        user = rt.session.get(User, r.user_id)
        aims = AimService(rt.session).context_block(user, r, layers=rt.layers, purpose="motivation") or "(no long-range aims set)"
        beliefs = list(rt.session.scalars(select(Belief).where(Belief.responsibility_id == r.id, Belief.superseded_by_id.is_(None))
                                          .order_by(Belief.confidence.desc()).limit(8)))
        past = list(rt.session.scalars(select(Run).where(Run.responsibility_id == r.id).order_by(Run.started_at.desc()).limit(3)))
        top = rt.tension.top_contributors(r, limit=3)
        prompt = "\n".join([
            f"<user_motivation>\n{aims}\n</user_motivation>",
            f"Responsibility: {r.title_en}\nDescription: {r.description_en or '-'}\nStatus: {r.status.value}",
            f"Tension {r.tension:.2f} (wake {r.wake_threshold:.2f}); why: " + ("; ".join(c.explanation_en[:140] for c in top) or "-"),
            "Beliefs:\n" + ("\n".join(f"- [{b.type.value} {b.confidence:.2f}] {b.statement_en[:200]}" for b in beliefs) or "(none)"),
            "Open uncertainties: " + (", ".join(b.statement_en[:120] for b in beliefs if b.type == BeliefType.UNCERTAINTY) or "none"),
            fence("evidence", "\n".join(f"- {t[:200]}" for t in pending[:10]) or "(no new events)"),
            "Past outcomes: " + ("; ".join(f"{x.kind} {x.status.value}, {len(x.belief_changes)} belief changes" for x in past) or "none"),
        ])
        data, run_id, err = _call(rt, user, kind="motivation_forward", system=FORWARD_SYSTEM, prompt=prompt,
                                  why=f"tension woke '{r.title_en[:60]}'", max_tokens=600, now=now, responsibility_id=r.id)
        fallback = data is None or str(data.get("decision", "")).upper() not in ALLOWED
        if fallback:
            data = {"decision": "DEEP_RESEARCH" if pending else "MONITOR", "reason": f"rule-based fallback ({err or 'invalid decision'})",
                    "marginal_value": 0.5 if pending else 0.1, "aligned": True, "needs_user": False}
        dec = str(data.get("decision")).upper()
        d = MotivationDecision(
            user_id=r.user_id, responsibility_id=r.id, subject="responsibility", tension=round(r.tension, 4), decision=dec,
            answers={k: data.get(k) for k in ("aligned", "changed", "uncertainty", "decision_affected", "marginal_value",
                                             "needs_user", "question", "reason")},
            budget=data.get("budget") if isinstance(data.get("budget"), dict) else {},
            stop_condition=str(data.get("stop_condition") or "")[:400], fallback=fallback, run_id=run_id, created_at=now)
        rt.session.add(d)
        rt.session.flush()
        return d


# ---------------------------------------------------------------- R0


def r0_state(rt: "Runtime", user_id: uuid.UUID) -> R0State:
    st = rt.session.get(R0State, user_id)
    if st is None:
        st = R0State(user_id=user_id, tension=0.0, telemetry={}, baselines={}, ledger=[], updated_at=utcnow())
        rt.session.add(st)
        rt.session.flush()
    return st


def r0_tick(rt: "Runtime", user_id: uuid.UUID, now: datetime | None = None) -> R0State:
    """Recompute telemetry; tension fades with time and rises only toward what the worst real signal justifies."""
    now = now or utcnow()
    ep = rt.policy.evolution
    st = r0_state(rt, user_id)
    tele = compute(rt.session, None if ep.r0_scope == "system" else user_id, now, ep.telemetry_window_days)
    days = max(0.0, (now - st.updated_at).total_seconds() / 86400) if st.updated_at else 0.0
    before = st.tension
    t = before * math.exp(-ep.r0_decay_per_day * days)
    worst, worst_key = 0.0, None
    for key, sig in SIGNALS.items():
        v = tele.get(key, {})
        pressure = sig.weight * sig.severity(v.get("value"), v.get("n", 0))
        if pressure > worst:
            worst, worst_key = pressure, key
    if worst > t:
        t = t + (worst - t) * 0.5
    # a perpetual agent improves all the time: the longer since the last round, the more R0 wants one
    if ep.r0_idle_drift_per_day > 0:
        last = rt.session.scalar(select(func.max(EvolutionRound.created_at)).where(EvolutionRound.user_id == user_id))
        if last is None:
            u = rt.session.get(User, user_id)
            last = u.created_at if u else now
        idle_days = max(0.0, (now - last).total_seconds() / 86400)
        drift = min(0.6, idle_days * ep.r0_idle_drift_per_day)
        if drift > t:
            t, worst_key = drift, "_idle"
            tele = {**tele, "_idle": {"value": round(idle_days, 2), "n": 1}}
    t = round(min(1.0, t), 4)
    base = dict(st.baselines or {})
    for key in SIGNALS:
        v = tele.get(key, {}).get("value")
        if v is not None:
            base[key] = round(v if key not in base else base[key] * 0.9 + v * 0.1, 4)
    if abs(t - before) >= 0.01:
        sig = SIGNALS.get(worst_key) if worst_key else None
        val = tele.get(worst_key, {}).get("value") if worst_key else None
        why = (f"{sig.label_zh} = {val:.2f}（样本 {tele[worst_key]['n']}，阈值 {sig.good}–{sig.bad}）" if sig and t > before
               else f"距离上次自我改进已 {val:.1f} 天：持续改进是常态" if worst_key == "_idle" and t > before
               else "没有新的问题信号，张力随时间回落")
        st.ledger = ([{"at": now.isoformat(), "from": round(before, 3), "to": t, "signal": worst_key if t > before else None,
                       "value": val, "why": why}] + list(st.ledger or []))[:40]
    st.tension, st.telemetry, st.baselines, st.updated_at = t, tele, base, now
    rt.session.flush()
    return st


def bump_r0(rt: "Runtime", user_id: uuid.UUID, delta: float, why: str, now: datetime | None = None) -> None:
    """An explicit request for self-improvement (e.g. a Motivation Forward chose SELF_IMPROVE)."""
    now = now or utcnow()
    st = r0_state(rt, user_id)
    before = st.tension
    st.tension = round(min(1.0, st.tension + delta), 4)
    st.ledger = ([{"at": now.isoformat(), "from": round(before, 3), "to": st.tension, "signal": "request", "why": why[:200]}]
                 + list(st.ledger or []))[:40]
    rt.session.flush()


def open_round(rt: "Runtime", user_id: uuid.UUID) -> EvolutionRound | None:
    return rt.session.scalar(select(EvolutionRound).where(EvolutionRound.user_id == user_id,
                                                          EvolutionRound.phase.notin_(["done", "stopped"]))
                             .order_by(EvolutionRound.created_at.desc()).limit(1))


def r0_forward(rt: "Runtime", user: User, now: datetime | None = None) -> MotivationDecision:
    now = now or utcnow()
    st = r0_state(rt, user.id)
    tele = {k: v for k, v in (st.telemetry or {}).items() if not k.startswith("_")}
    backlog = list(rt.session.scalars(select(ImprovementProposal).where(
        ImprovementProposal.user_id == user.id, ImprovementProposal.status.in_(["NEW", "DEFERRED"]))
        .order_by(ImprovementProposal.value.desc()).limit(6)))
    prompt = "\n".join([
        f"R0 tension {st.tension:.2f} (wake {rt.policy.evolution.r0_wake}).",
        "Telemetry (value, samples): " + "; ".join(f"{k}={v.get('value') if v.get('value') is None else round(v['value'], 3)} (n={v.get('n')})"
                                                   for k, v in tele.items()),
        "Why tension moved: " + ("; ".join(e.get("why", "") for e in (st.ledger or [])[:5]) or "-"),
        "Improvement backlog: " + ("; ".join(f"{p.code} {p.title} (value {p.value:.2f}, {p.status})" for p in backlog) or "empty"),
    ])
    data, run_id, err = _call(rt, user, kind="r0_forward", system=R0_SYSTEM, prompt=prompt,
                              why="R0 tension crossed its wake line", max_tokens=700, now=now)
    fallback = data is None or str(data.get("decision", "")).upper() not in R0_ALLOWED
    if fallback:
        worst = max(SIGNALS, key=lambda k: SIGNALS[k].severity(tele.get(k, {}).get("value"), tele.get(k, {}).get("n", 0)))
        sev = SIGNALS[worst].severity(tele.get(worst, {}).get("value"), tele.get(worst, {}).get("n", 0))
        data = {"decision": "SELF_IMPROVE" if sev >= 0.5 else "MONITOR", "problem": worst,
                "evidence": {worst: tele.get(worst, {}).get("value")}, "reason": f"rule-based fallback ({err or 'invalid decision'})",
                "constraints": {"no_permission_change": True, "no_user_motivation_change": True}}
    data.setdefault("constraints", {}).update({"no_permission_change": True, "no_user_motivation_change": True})
    d = MotivationDecision(
        user_id=user.id, responsibility_id=None, subject="R0", tension=st.tension, decision=str(data["decision"]).upper(),
        answers={k: data.get(k) for k in ("problem", "evidence", "objective", "constraints", "reason")},
        budget=data.get("budget") if isinstance(data.get("budget"), dict) else {},
        stop_condition="; ".join(data.get("stop_condition") or []) if isinstance(data.get("stop_condition"), list)
        else str(data.get("stop_condition") or ""), fallback=fallback, run_id=run_id, created_at=now)
    rt.session.add(d)
    rt.session.flush()
    return d
