"""评审与合成: several agents answered the same question — they are reviewed blind, ranked, and the best of them merged
into one answer; and every such comparison (and every version you pick) feeds an Elo leaderboard of the agents, which
nudges auto routing.

Three open-source designs:

* LLM Council (karpathy/llm-council) — stage 1 every model answers, stage 2 each reviews the anonymised answers
  ("Response A, B, C") and ends with a FINAL RANKING, stage 3 a chairman writes the final answer. The repository carries
  no licence, so nothing is copied: the flow is reimplemented here, with PGA's own model as reviewer and chairman (the
  agents themselves answered in stage 1; asking them to review too would spend their quota).
* Mixture-of-Agents (togethercomputer/MoA, Apache-2.0) — the aggregator prompt that synthesises reference answers;
  `AGGREGATOR` below is copied from it (notice below).
* Chatbot Arena (lm-sys/FastChat, Apache-2.0) — pairwise battles → Elo; `compute_elo` below is copied from
  fastchat/serve/monitor/elo_analysis.py (notice below), taking a list of battles instead of a pandas DataFrame.

----
Portions copyright Together Computer (MoA) and the LMSYS team (FastChat), licensed under the Apache License, Version 2.0
(http://www.apache.org/licenses/LICENSE-2.0); see third_party/moa/LICENSE and third_party/fastchat/LICENSE.
Modified by PGA (2026-10-22): the aggregator prompt says "agents" where it said "open-source models" and adds the
blind ranking as context; compute_elo takes (model_a, model_b, winner) tuples.
"""
from __future__ import annotations

import logging
import re
import uuid
from collections import defaultdict
from datetime import datetime
from typing import TYPE_CHECKING

from sqlalchemy import select

from pga.agent.common import UNTRUSTED_NOTE, fence
from pga.allocator import Estimates, Justification, RunRequest
from pga.db.models import AgentRun, User
from pga.db.types import utcnow

if TYPE_CHECKING:
    from pga.runtime import Runtime

log = logging.getLogger(__name__)

# ---- copied from togethercomputer/MoA (utils.py / moa.py), Apache-2.0; "open-source models" → "agents"
AGGREGATOR = """You have been provided with a set of responses from various agents to the latest user query. Your task is to synthesize these responses into a single, high-quality response. It is crucial to critically evaluate the information provided in these responses, recognizing that some of it may be biased or incorrect. Your response should not simply replicate the given answers but should offer a refined, accurate, and comprehensive reply to the instruction. Ensure your response is well-structured, coherent, and adheres to the highest standards of accuracy and reliability.

Responses from models:"""


# ---- copied from lm-sys/FastChat fastchat/serve/monitor/elo_analysis.py, Apache-2.0; battles as tuples
def compute_elo(battles, K=4, SCALE=400, BASE=10, INIT_RATING=1000):
    rating = defaultdict(lambda: INIT_RATING)

    for model_a, model_b, winner in battles:
        ra = rating[model_a]
        rb = rating[model_b]
        ea = 1 / (1 + BASE ** ((rb - ra) / SCALE))
        eb = 1 / (1 + BASE ** ((ra - rb) / SCALE))
        if winner == "model_a":
            sa = 1
        elif winner == "model_b":
            sa = 0
        elif winner == "tie" or winner == "tie (bothbad)":
            sa = 0.5
        else:
            raise Exception(f"unexpected vote {winner}")
        rating[model_a] += K * (sa - ea)
        rating[model_b] += K * (1 - sa - eb)

    return dict(rating)
# ---- end of copied code


REVIEW = """You are evaluating different responses to the following question. The responses are anonymised; judge only what they say.

First, evaluate each response in one or two sentences: what it gets right, what it gets wrong or misses.
Then, at the very end, give the final ranking, best first, exactly in this form and nothing after it:
FINAL RANKING:
1. Response B
2. Response A
...
Write the evaluations in the language of the question. """ + UNTRUSTED_NOTE


class CouncilError(ValueError):
    pass


def _call(rt: "Runtime", user: User, system: str, prompt: str, why: str, max_tokens: int, now: datetime) -> str:
    decision = rt.allocator.allocate(RunRequest(
        user_id=user.id, kind="synthesis",
        justification=Justification(why_now=why, expected_gain="which answer is best, and one answer built from all of them",
                                    decision_affected="which answer you act on, and which agent gets this kind of question next",
                                    budget={"max_units": 40_000, "max_output_tokens": max_tokens}, stop_condition="reviewed and merged"),
        estimates=Estimates(information_gain=.5, decision_impact=.6, user_relevance=.9, reuse_value=.5,
                            input_tokens=len(prompt) // 3, output_tokens=max_tokens // 2)), now=now)
    if not decision.allowed:
        raise CouncilError("; ".join(decision.reasons))
    with rt.runs.track(decision, now) as guard:
        res = rt.router.complete(decision.tier, system=system, messages=[{"role": "user", "content": prompt}], max_tokens=max_tokens, usage=guard.usage_context())
        guard.stop("council step done")
    return res.text or ""


def parse_ranking(text: str, labels: list[str]) -> list[str]:
    """The labels in the order of the FINAL RANKING (what follows it; else every 'Response X' in order of mention)."""
    tail = text.split("FINAL RANKING:", 1)[1] if "FINAL RANKING:" in text else text
    seen = []
    for m in re.finditer(r"Response\s+([A-Z])\b", tail):
        lab = m.group(1)
        if lab in labels and lab not in seen:
            seen.append(lab)
    return seen + [x for x in labels if x not in seen]


def versions(rt: "Runtime", user: User, root_id: uuid.UUID) -> tuple[AgentRun, list[AgentRun]]:
    root = rt.session.get(AgentRun, root_id)
    if root is None or root.user_id != user.id:
        raise CouncilError("no such answer")
    alts = list(rt.session.scalars(select(AgentRun).where(AgentRun.user_id == user.id, AgentRun.parent_id.is_(None),
                                                         AgentRun.data["regen_of"].as_string() == str(root.id))))
    return root, alts


def convene(rt: "Runtime", user: User, root_id: uuid.UUID, now: datetime | None = None) -> dict:
    """Stage 2 and 3 for the answers already given to one question: a blind review and ranking, then a merged answer that
    becomes another version of the turn (agent "council"); the ranking goes into the arena."""
    from pga.tree import _answer
    now = now or utcnow()
    root, alts = versions(rt, user, root_id)
    answers = [(r, (r.data or {}).get("agent") or r.agent, _answer(r.output) or "") for r in [root, *alts]
               if (r.data or {}).get("agent") != "council" and (_answer(r.output) or "").strip()]
    if len(answers) < 2:
        raise CouncilError("at least two answers are needed")
    labels = [chr(65 + i) for i in range(len(answers))]
    question = root.prompt or ""
    block = "\n\n".join(fence(f"response_{lab}", text, 12000, kind=f"Response {lab}") for lab, (_, _, text) in zip(labels, answers))
    review = _call(rt, user, REVIEW, fence("question", question, 4000, kind="the question") + "\n\n" + block,
                   f"reviewing {len(answers)} answers blind", 1500, now)
    order = parse_ranking(review, labels)
    by_label = dict(zip(labels, answers))
    ranked = [by_label[x] for x in order]
    system = AGGREGATOR + "".join(f"\n{i + 1}. {text}" for i, (_, _, text) in enumerate(ranked)) + \
        "\n\n(The responses are listed best first, by a blind review.) " + UNTRUSTED_NOTE
    merged = _call(rt, user, system, question, "merging the answers into one", 3000, now).strip()
    import json
    run = AgentRun(user_id=user.id, workflow="ask", pattern="single", step="council", agent="council", adapter="llm", status="succeeded",
                   prompt=question, output=json.dumps({"answer": merged}, ensure_ascii=False), started_at=now, finished_at=utcnow(),
                   data={"conversation": (root.data or {}).get("conversation"), "regen_of": str(root.id), "multi": True, "agent": "council",
                         "council": {"ranking": [a for _, a, _ in ranked], "review": review[:6000], "labels": {lab: a for lab, (_, a, _) in by_label.items()}}})
    rt.session.add(run)
    root.data = {**(root.data or {}), "council": {"ranking": [a for _, a, _ in ranked], "review": review[:6000], "merged": str(run.id),
                                                  "labels": {lab: a for lab, (_, a, _) in by_label.items()}, "at": now.isoformat()}}
    record(user, [(ranked[i][1], ranked[j][1], "model_a") for i in range(len(ranked)) for j in range(i + 1, len(ranked)) if ranked[i][1] != ranked[j][1]], "review")
    rt.session.flush()
    return {"ranking": [a for _, a, _ in ranked], "review": review, "merged": str(run.id), "answer": merged}


# ---- the arena: battles from blind reviews and from the versions you pick
def record(user: User, battles: list[tuple[str, str, str]], source: str) -> None:
    arena = list((user.preferences or {}).get("arena") or [])
    arena += [[a, b, w, source] for a, b, w in battles]
    user.preferences = {**(user.preferences or {}), "arena": arena[-3000:]}


def picked(rt: "Runtime", user: User, root_id: uuid.UUID, chosen_id: uuid.UUID) -> None:
    """You chose one of several agents' answers: it beat each of the others (a battle each, like Chatbot Arena's votes)."""
    try:
        root, alts = versions(rt, user, root_id)
    except CouncilError:
        return
    rows = [r for r in [root, *alts] if (r.data or {}).get("multi") or r is root]
    if len(rows) < 2 or not any((r.data or {}).get("multi") for r in alts):
        return
    win = next((r for r in rows if r.id == chosen_id), None)
    if win is None:
        return
    wa = (win.data or {}).get("agent") or win.agent
    record(user, [(wa, (r.data or {}).get("agent") or r.agent, "model_a") for r in rows if r.id != win.id
                  and ((r.data or {}).get("agent") or r.agent) != wa], "pick")


def leaderboard(user: User) -> list[dict]:
    rows = [(a, b, w) for a, b, w, *_ in (user.preferences or {}).get("arena") or [] if a and b]
    elo = compute_elo(rows, K=16)          # PGA has tens of battles, not millions: a larger step than the arena's K=4
    games: dict[str, int] = defaultdict(int)
    wins: dict[str, int] = defaultdict(int)
    for a, b, w in rows:
        games[a] += 1
        games[b] += 1
        if w == "model_a":
            wins[a] += 1
        elif w == "model_b":
            wins[b] += 1
    out = [{"agent": k, "elo": round(v), "games": games[k], "wins": wins[k]} for k, v in elo.items() if k != "council"]
    return sorted(out, key=lambda x: -x["elo"])


def elo_bonus(user: User | None) -> dict[str, float]:
    """For auto routing: how far each agent's Elo is from the start, as a small nudge (±0.5 at ±100 points)."""
    if user is None:
        return {}
    return {x["agent"]: max(-1.0, min(1.0, (x["elo"] - 1000) / 200)) for x in leaderboard(user) if x["games"] >= 3}
