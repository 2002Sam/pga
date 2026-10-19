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

HIDDEN = ("node:", "exchange:", "second:", "multi:")       # conversations that are not chats of their own

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


def fold(runs: list[AgentRun]) -> tuple[list[AgentRun], dict[str, list[AgentRun]]]:
    """The turns of a chat, with each answer's other versions (regenerated) put under the turn they redo."""
    alts: dict[str, list[AgentRun]] = {}
    turns = []
    for r in runs:
        root = (r.data or {}).get("regen_of")
        if root:
            alts.setdefault(str(root), []).append(r)
        else:
            turns.append(r)
    return turns, alts


def current(r: AgentRun, alts: dict[str, list[AgentRun]]) -> AgentRun:
    """Which version of an answer counts (the one you picked; else the latest)."""
    xs = [r, *alts.get(str(r.id), [])]
    pick = (r.data or {}).get("pick")
    return next((x for x in xs if str(x.id) == pick), xs[-1])


def branch_of(user: User, key: str) -> dict | None:
    return ((user.preferences or {}).get("chat_branches") or {}).get(key)


def history(rt: "Runtime", user: User, key: str, upto: uuid.UUID | None = None, depth: int = 0) -> list[dict]:
    """The turns of a chat (and of the chat it branched from, up to the branch point), oldest first."""
    from pga.tree import _answer
    out: list[dict] = []
    b = branch_of(user, key)
    if b and depth < 5:
        out += history(rt, user, b["from"], uuid.UUID(b["upto"]), depth + 1)
    turns, alts = fold(runs_of(rt, user.id, key))
    for r in turns:
        out.append({"role": "user", "text": (("[the user's own note] " if (r.data or {}).get("note") else "") + (r.prompt or "")), "run": str(r.id)})
        if not (r.data or {}).get("note"):
            a = current(r, alts)
            out.append({"role": "assistant", "text": _answer(a.output) or "", "agent": (a.data or {}).get("agent") or a.agent, "run": str(r.id)})
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


def regenerate(rt: "Runtime", user: User, run_id: uuid.UUID, agent: str | None = None) -> dict:
    """Another version of one answer: the same question, with what came before it (not the answer it replaces), in a
    fresh session; kept as a version of that turn (data["regen_of"]), not as a new turn."""
    from pga.agents.routing import AgentRouter
    run = rt.session.get(AgentRun, run_id)
    if run is None or run.user_id != user.id or run.workflow != "ask" or (run.data or {}).get("note"):
        raise ChatError("no such reply")
    root = rt.session.get(AgentRun, uuid.UUID(str(run.data["regen_of"]))) if (run.data or {}).get("regen_of") else run
    d = root.data or {}
    key = str(d.get("conversation") or f"run:{root.id}")
    before = history(rt, user, key, root.id)[:-2]
    n = len(fold(runs_of(rt, user.id, key))[1].get(str(root.id), [])) + 1
    reply = AgentRouter(rt).ask(user, root.prompt or "", agent=agent or "auto", history=[{"role": t["role"], "text": t["text"]} for t in before][-12:],
                                conversation=f"regen:{root.id}:{n}")
    new = rt.session.get(AgentRun, uuid.UUID(str(reply["run_id"]))) if reply.get("run_id") else None
    if new is not None:
        new.data = {**(new.data or {}), "conversation": key, "regen_of": str(root.id)}
        root.data = {**d, "pick": str(new.id)}
    return {"run": str(new.id) if new else None, "of": str(root.id), "text": reply.get("text"), "error": reply.get("error"), "agent": reply.get("agent")}


def fold_in(rt: "Runtime", user: User, root_id: uuid.UUID, runs: list[uuid.UUID], key: str) -> int:
    """Answers several agents gave to the same question at once: they become versions of the first one's turn."""
    root = rt.session.get(AgentRun, root_id)
    if root is None or root.user_id != user.id:
        raise ChatError("no such reply")
    n = 0
    for rid in runs:
        r = rt.session.get(AgentRun, rid)
        if r is None or r.user_id != user.id or r.id == root.id:
            continue
        r.data = {**(r.data or {}), "conversation": key, "regen_of": str(root.id), "multi": True}
        n += 1
    return n


def children(user: User, key: str) -> list[dict]:
    """The chats that branched from this one, and where (the turn they grew from)."""
    titles = (user.preferences or {}).get("chat_titles") or {}
    return [{"key": k, "upto": v.get("upto"), "title": titles.get(k)} for k, v in ((user.preferences or {}).get("chat_branches") or {}).items()
            if v.get("from") == key]


def pick(rt: "Runtime", user: User, run_id: uuid.UUID, version: uuid.UUID) -> None:
    run = rt.session.get(AgentRun, run_id)
    if run is None or run.user_id != user.id:
        raise ChatError("no such reply")
    run.data = {**(run.data or {}), "pick": str(version)}


def rate(rt: "Runtime", user: User, run_id: uuid.UUID, rating: int, note: str = "") -> dict:
    """Good (1) / bad (-1) / none (0) on an answer — kept on the run, for learning which agent you trust for what."""
    run = rt.session.get(AgentRun, run_id)
    if run is None or run.user_id != user.id:
        raise ChatError("no such reply")
    d = dict(run.data or {})
    if rating:
        d["rating"] = {"value": 1 if rating > 0 else -1, "note": note[:500], "at": utcnow().isoformat()}
    else:
        d.pop("rating", None)
    run.data = d
    return {"run": str(run.id), "rating": (d.get("rating") or {}).get("value", 0)}


def search(rt: "Runtime", user: User, q: str, limit: int = 30) -> list[dict]:
    """Your chats and imported conversations whose words match, newest first, each with a snippet."""
    import re as _re

    from pga.db.models import AgentConversation, LinkedAgent
    from pga.tree import _answer
    q = q.strip()
    if len(q) < 2:
        return []
    like = f"%{q}%"
    out, seen = [], set()
    rows = rt.session.scalars(select(AgentRun).where(AgentRun.user_id == user.id, AgentRun.parent_id.is_(None), AgentRun.workflow == "ask",
                                                     or_(AgentRun.prompt.ilike(like), AgentRun.output.ilike(like)))
                              .order_by(AgentRun.started_at.desc()).limit(200))
    titles = ((user.preferences or {}).get("chat_titles") or {})

    def snip(text: str) -> str:
        i = text.lower().find(q.lower())
        return ("…" if i > 40 else "") + _re.sub(r"\s+", " ", text[max(0, i - 40): i + 80]).strip() + "…" if i >= 0 else ""
    for r in rows:
        d = r.data or {}
        key = str(d.get("conversation") or f"run:{r.id}")
        if key.startswith(HIDDEN + ("regen:",)) or d.get("node") or key in seen:
            continue
        seen.add(key)
        text = r.prompt or ""
        hit = snip(text) or snip(_answer(r.output) or "")
        out.append({"key": key, "kind": "chat", "title": titles.get(key) or " ".join(text.split())[:60], "snippet": hit, "at": r.started_at.isoformat(),
                    "agent": d.get("agent") or r.agent})
    for c, a in rt.session.execute(select(AgentConversation, LinkedAgent).join(LinkedAgent, AgentConversation.linked_agent_id == LinkedAgent.id)
                                   .where(LinkedAgent.user_id == user.id, or_(AgentConversation.title.ilike(like), AgentConversation.excerpt.ilike(like)))
                                   .order_by(AgentConversation.updated_at.desc().nulls_last()).limit(40)):
        out.append({"key": f"c:{c.id}", "kind": "import", "cid": str(c.id), "title": titles.get(f"c:{c.id}") or _re.sub(r"^\[[^\]]*\]\s*", "", c.title or "")[:60],
                    "snippet": snip(c.excerpt or "") or snip(c.title or ""), "at": (c.updated_at or c.started_at or c.created_at).isoformat(), "agent": a.name})
    return sorted(out, key=lambda x: x["at"], reverse=True)[:limit]


def set_title(user: User, key: str, title: str) -> None:
    titles = dict((user.preferences or {}).get("chat_titles") or {})
    if title.strip():
        titles[key[:120]] = title.strip()[:80]
    else:
        titles.pop(key[:120], None)
    user.preferences = {**(user.preferences or {}), "chat_titles": dict(list(titles.items())[-2000:])}


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
