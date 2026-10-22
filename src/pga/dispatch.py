"""分工: one message that lists several things to do becomes several tasks, each handed to its own agent at the same
time, instead of one agent working through all of them for minutes.

`split` asks PGA's own model whether the message holds independent points and, if so, what each one is (keeping
whatever context the point needs to stand alone, and which kind of agent suits it). The page then starts each task as a
branch of the conversation (so every agent sees what came before) and asks them all at once; `record` keeps which
branches belong to which message, so the conversation can show their progress and merge their results.
"""
from __future__ import annotations

import re
from datetime import datetime
from typing import TYPE_CHECKING

from pga.agent.common import UNTRUSTED_NOTE, ModelOutputError, fence, parse_json
from pga.allocator import Estimates, Justification, RunRequest
from pga.db.models import User
from pga.db.types import utcnow

if TYPE_CHECKING:
    from pga.runtime import Runtime

POINTS = re.compile(r"(?m)^\s*(?:\d{1,2}[.、)）]|[-*•·]|[a-zA-Z][.、)）]|[一二三四五六七八九十][、.])\s*\S")


class DispatchError(ValueError):
    pass


def looks_multi(text: str) -> bool:
    """Two or more list items (1. … 2. …, - …, a. …), or numbered points inline (1. … 2. …)."""
    if len(POINTS.findall(text or "")) >= 2:
        return True
    return len(re.findall(r"(?:^|[\s：:，,；;。])(\d{1,2})[.、)）]\s*\S", text or "")) >= 2


SYSTEM = ("The person sent one message to an AI agent that may hold several separate requests. Split it into tasks "
          "that different agents can do AT THE SAME TIME without waiting for each other. Rules: keep requests that depend "
          "on each other (one needs the other's result, or both change the same thing) in ONE task; give each task its "
          "own words plus whatever context from the message it needs to stand alone (do not invent anything); keep the "
          "person's language; a short title (at most 12 Chinese characters or 8 English words); kind is one of code, "
          "research, write, quick. If the message is really one request, return a single task. Reply with JSON only: "
          "{\"tasks\": [{\"title\": \"...\", \"text\": \"...\", \"kind\": \"code\"}]}. " + UNTRUSTED_NOTE)


def split(rt: "Runtime", user: User, text: str, context: str = "", now: datetime | None = None) -> list[dict]:
    now = now or utcnow()
    prompt = (fence("conversation_so_far", context, 6000, kind="the end of the conversation, for context") + "\n\n" if context else "") + \
        fence("message", text, 16000, kind="the person's message to split")
    decision = rt.allocator.allocate(RunRequest(
        user_id=user.id, kind="synthesis",
        justification=Justification(why_now="you sent several points at once", expected_gain="each point handled by its own agent in parallel",
                                    decision_affected="how the work is shared among agents",
                                    budget={"max_units": 20_000, "max_output_tokens": 1500}, stop_condition="split"),
        estimates=Estimates(information_gain=.3, decision_impact=.6, user_relevance=.9, reuse_value=.2,
                            input_tokens=len(prompt) // 3, output_tokens=800)), now=now)
    if not decision.allowed:
        raise DispatchError("; ".join(decision.reasons))
    with rt.runs.track(decision, now) as guard:
        res = rt.router.complete(decision.tier, system=SYSTEM, messages=[{"role": "user", "content": prompt}], max_tokens=1500, usage=guard.usage_context())
        try:
            d = parse_json(res.text)
        except ModelOutputError:
            guard.stop("split reply was not JSON")
            raise DispatchError("the model did not answer in the expected form") from None
        guard.stop("split")
    tasks = [t for t in (d.get("tasks") if isinstance(d, dict) else None) or [] if isinstance(t, dict) and str(t.get("text") or "").strip()]
    return [{"title": str(t.get("title") or "")[:40] or str(t["text"])[:24], "text": str(t["text"])[:8000],
             "kind": str(t.get("kind") or "quick") if str(t.get("kind") or "") in ("code", "research", "write", "quick") else "quick"} for t in tasks[:8]]


def record(user: User, key: str, entry: dict) -> list[dict]:
    """A dispatch from conversation `key`: its message, and the branch and agent of each task."""
    d = dict((user.preferences or {}).get("chat_dispatch") or {})
    xs = list(d.get(key) or [])
    xs = [x for x in xs if x.get("id") != entry.get("id")] + [entry]
    d[key] = xs[-20:]
    user.preferences = {**(user.preferences or {}), "chat_dispatch": dict(list(d.items())[-500:])}
    return d[key]


def of(user: User, key: str) -> list[dict]:
    return list(((user.preferences or {}).get("chat_dispatch") or {}).get(key) or [])
