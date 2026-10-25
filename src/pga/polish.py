"""提示词润色: what you are about to send, rewritten a few ways with what PGA knows about you.

The personal model (your background, goals, preferences, abilities and current state — the self knowledge) and the
conversation you are in tell the model who is asking and why. It returns several polished versions, each with a
different emphasis (clearer and tighter, richer in your context, structured as a brief for an agent…), and you pick one;
nothing is sent until you do. It never invents facts about you: what it adds comes from the personal model, and what
it cannot know it leaves as a [placeholder] for you to fill."""
from __future__ import annotations

import logging
from datetime import datetime

from pga.agent.common import UNTRUSTED_NOTE, fence, parse_json
from pga.db.models import User
from pga.db.types import utcnow

log = logging.getLogger(__name__)

DIMS = ("background", "goals", "preferences", "abilities", "state")

SYSTEM = """You polish a prompt the person is about to send to an AI agent. You know them through their personal model below
(background, goals, preferences, abilities, current state) and, if given, the conversation it goes into.
Write {n} polished versions, each with a different emphasis, for example:
- "清晰精炼": the same request, unambiguous and tight
- "补全背景": the request plus the context from the personal model the agent needs (only what is relevant)
- "结构化任务": goal, context, constraints, expected output, as a brief for an agent
- or another angle that really fits this request (e.g. ask for options and trade-offs, step-by-step, critique)
Keep the person's intent and language (write in the language of their draft). Never invent facts about them: add only
what the personal model says; where something is missing that the agent would need, leave a short [placeholder].
Reply with JSON only: {{"versions": [{{"title": "2-6 words", "prompt": "the polished prompt", "why": "one sentence: what changed"}}]}}
""" + UNTRUSTED_NOTE


def profile(rt, user: User) -> str:
    from pga.knowledge.datasets import Datasets
    b = Datasets(rt).ensure(user).get("user")
    dims = ((b.data or {}).get("dims") or {}) if b is not None else {}
    lines = []
    for k in DIMS:
        d = dims.get(k) or {}
        facts = "; ".join([*(d.get("stated") or [])[:6], *(d.get("inferred") or [])[:4]])
        if d.get("summary") or facts:
            lines.append(f"{k}: {d.get('summary', '')}" + (f" | {facts}" if facts else ""))
    return "\n".join(lines)


def polish(rt, user: User, text: str, n: int = 3, conversation: str | None = None, now: datetime | None = None, ask=None) -> list[dict]:
    text = (text or "").strip()
    if not text:
        raise ValueError("nothing to polish")
    n = max(2, min(5, int(n or 3)))
    parts = [fence("personal_model", profile(rt, user) or "(empty: nothing known yet)", 8000, kind="what PGA knows about the person"),
             fence("draft", text[:8000], 9000, kind="the prompt the person wrote")]
    if conversation and conversation.startswith("chat:"):
        from pga.chats import history
        try:
            turns = history(rt, user, conversation)[-6:]
        except Exception:  # noqa: BLE001 - polishing works without it
            turns = []
        if turns:
            parts.insert(1, fence("conversation_so_far", "\n".join(f"{t['role']}: {str(t.get('text') or '')[:600]}" for t in turns), 6000,
                                  kind="the last turns of the conversation the prompt goes into"))
    d = (ask or _ask)(rt, user, SYSTEM.format(n=n), "\n\n".join(parts), now or utcnow())
    out = []
    for v in (d.get("versions") or [])[:n]:
        if isinstance(v, dict) and str(v.get("prompt") or "").strip():
            out.append({"title": str(v.get("title") or "")[:40], "prompt": str(v["prompt"]).strip()[:12000], "why": str(v.get("why") or "")[:300]})
    if not out:
        raise ValueError("the model gave no versions; try again")
    return out


def _ask(rt, user: User, system: str, prompt: str, now: datetime) -> dict:
    from pga.allocator import Estimates, Justification, RunRequest
    decision = rt.allocator.allocate(RunRequest(
        user_id=user.id, kind="synthesis",
        justification=Justification(why_now="the person asked to polish a prompt before sending it", expected_gain="a clearer prompt in their context",
                                    decision_affected="which version they send", budget={"max_units": 30_000, "max_output_tokens": 3000},
                                    stop_condition="versions written"),
        estimates=Estimates(information_gain=.3, decision_impact=.5, user_relevance=.9, reuse_value=.3, input_tokens=len(prompt) // 3, output_tokens=1500)), now=now)
    if not decision.allowed:
        raise ValueError("; ".join(decision.reasons))
    with rt.runs.track(decision, now) as guard:
        res = rt.router.complete(decision.tier, system=system, messages=[{"role": "user", "content": prompt}], max_tokens=3000,
                                 usage=guard.usage_context(), delegate=False)
        guard.stop("polished")
    return parse_json(res.text or "{}")
