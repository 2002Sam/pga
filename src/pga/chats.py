"""Everyday chats, beyond one question and one answer.

- A second opinion: the same question, with the same conversation before it, put to another agent; then one model
  reads both answers and writes what they agree on, where they differ, and a combined answer. Kept on the turn it
  was asked about (the run's data["second"]); the other agent's run is filed under "second:<run>" so it does not show
  up as a chat of its own.
- A branch: a new chat that starts from one reply of another chat. It carries that chat's turns up to the reply as
  its history (shown greyed above it), and goes on the same line of the time tree.
"""
from __future__ import annotations

import logging
import uuid
from datetime import datetime
from typing import TYPE_CHECKING

from sqlalchemy import or_, select

from pga.agent.common import UNTRUSTED_NOTE, ModelOutputError, fence, parse_json
from pga.allocator import Estimates, Justification, RunRequest
from pga.db.models import AgentRun, User
from pga.db.types import utcnow

if TYPE_CHECKING:
    from pga.runtime import Runtime

log = logging.getLogger(__name__)

HIDDEN = ("node:", "exchange:", "second:")       # conversations that are not chats of their own

COMPARE = """Two AI agents answered the same question from a person, with the same conversation before it. Compare them
for the person: what both say, where they really differ (facts, recommendations, assumptions — not wording), and one
combined answer that keeps what is well supported from each and says what stays open. Write in {lang}.
Reply with JSON only: {{"agree": ["…"], "differ": [{{"point": "…", "a": "what {a} says", "b": "what {b} says"}}],
"answer": "the combined answer, at most 250 words"}}. {untrusted}"""


class ChatError(ValueError):
    pass


def runs_of(rt: "Runtime", user_id: uuid.UUID, key: str) -> list[AgentRun]:
    q = select(AgentRun).where(AgentRun.user_id == user_id, AgentRun.parent_id.is_(None), AgentRun.workflow == "ask")
    same = AgentRun.data["conversation"].as_string() == key
    if key.startswith("run:"):
        try:
            same = or_(AgentRun.id == uuid.UUID(key[4:]), same)
        except ValueError as exc:
            raise ChatError("no such chat") from exc
    return list(rt.session.scalars(q.where(same).order_by(AgentRun.started_at)))


def branch_of(user: User, key: str) -> dict | None:
    return ((user.preferences or {}).get("chat_branches") or {}).get(key)


def history(rt: "Runtime", user: User, key: str, upto: uuid.UUID | None = None, depth: int = 0) -> list[dict]:
    """The turns of a chat (and of the chat it branched from, up to the branch point), oldest first."""
    from pga.tree import _answer
    out: list[dict] = []
    b = branch_of(user, key)
    if b and depth < 5:
        out += history(rt, user, b["from"], uuid.UUID(b["upto"]), depth + 1)
    for r in runs_of(rt, user.id, key):
        out += [{"role": "user", "text": r.prompt or "", "run": str(r.id)},
                {"role": "assistant", "text": _answer(r.output) or "", "agent": (r.data or {}).get("agent") or r.agent, "run": str(r.id)}]
        if upto is not None and r.id == upto:
            break
    return out


def set_branch(user: User, key: str, parent: str, upto: str) -> dict:
    branches = dict((user.preferences or {}).get("chat_branches") or {})
    branches[key[:120]] = {"from": parent[:120], "upto": upto}
    user.preferences = {**(user.preferences or {}), "chat_branches": dict(list(branches.items())[-1000:])}
    return branches[key[:120]]


def second_opinion(rt: "Runtime", user: User, run_id: uuid.UUID, agent: str | None = None, now: datetime | None = None) -> dict:
    from pga.agents.routing import AgentRouter, classify
    from pga.tree import _answer, _lang
    now = now or utcnow()
    run = rt.session.get(AgentRun, run_id)
    if run is None or run.user_id != user.id or run.workflow != "ask":
        raise ChatError("no such reply")
    d = run.data or {}
    first = str(d.get("agent") or run.agent)
    key = str(d.get("conversation") or f"run:{run.id}")
    turns = history(rt, user, key, run.id)[:-2]                   # what came before this question
    router = AgentRouter(rt)
    if not agent or agent == "auto":
        cat = d.get("category") or classify(run.prompt or "")[0]
        ranked = [x["agent"] for x in router.rank(cat) if x["usable"] and x["agent"] != first]
        if not ranked:
            raise ChatError("no other agent is available right now")
        agent = ranked[0]
    reply = router.ask(user, run.prompt or "", agent=agent, history=[{"role": t["role"], "text": t["text"]} for t in turns][-12:],
                       conversation=f"second:{run.id}")
    if not reply.get("text"):
        raise ChatError(reply.get("error") or f"{agent} did not answer")
    out = {"agent": reply.get("agent") or agent, "text": reply["text"], "model": reply.get("model"), "at": now.isoformat()}
    try:
        out.update(_compare(rt, user, run.prompt or "", first, _answer(run.output), out["agent"], reply["text"], _lang(user)[0], now))
    except Exception as exc:  # noqa: BLE001 - the two answers are worth showing even without the comparison
        log.info("second opinion compare failed: %s", exc)
        out["compare_error"] = str(exc)[:200]
    run.data = {**d, "second": out}
    return out


def _compare(rt: "Runtime", user: User, question: str, a: str, ta: str, b: str, tb: str, lang: str, now: datetime) -> dict:
    system = COMPARE.format(lang=lang, a=a, b=b, untrusted=UNTRUSTED_NOTE)
    prompt = (fence("question", question, 4000, kind="the person's question") + "\n\n"
              + fence(f"answer_{a}", ta, 12000, kind=f"{a}'s answer") + "\n\n" + fence(f"answer_{b}", tb, 12000, kind=f"{b}'s answer"))
    decision = rt.allocator.allocate(RunRequest(
        user_id=user.id, kind="synthesis",
        justification=Justification(why_now="you asked for a second opinion", expected_gain="where two agents agree and differ",
                                    decision_affected="which answer you act on",
                                    budget={"max_units": 20_000, "max_output_tokens": 900}, stop_condition="compared"),
        estimates=Estimates(information_gain=.5, decision_impact=.5, user_relevance=.9, reuse_value=.3,
                            input_tokens=len(prompt) // 3, output_tokens=600)), now=now)
    if not decision.allowed:
        raise ChatError("; ".join(decision.reasons))
    with rt.runs.track(decision, now) as guard:
        res = rt.router.complete(decision.tier, system=system, messages=[{"role": "user", "content": prompt}],
                                 max_tokens=900, usage=guard.usage_context())
        try:
            d = parse_json(res.text)
        except ModelOutputError:
            guard.stop("comparison was not JSON")
            return {}
        guard.stop("compared")
    if not isinstance(d, dict):
        return {}
    return {"agree": [str(x) for x in d.get("agree") or []][:6],
            "differ": [{k: str(x.get(k) or "") for k in ("point", "a", "b")} for x in d.get("differ") or [] if isinstance(x, dict)][:6],
            "answer": str(d.get("answer") or "")[:3000]}
