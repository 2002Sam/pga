"""Many answers to one question (多次生成), from many agents, with lightly disturbed prompts (提示词扰动).

A vague task has no single right answer. In a long self-exploration it pays to answer the same question several times —
by different agents, and with the prompt nudged a little each time — then fold the samples together, keeping what they
agree on AND the ideas that only one of them had (inspirations). How far the samples spread is itself a signal: a wide
spread means the question is open, a narrow one that the answer is settled.

When to fork (受控分叉): sampling every question N times is wasteful — a button colour needs one answer, the core
architecture of a long-running agent may deserve many. The number of samples follows a fork score
    P(fork) = f(U, D, I, C)
    U  uncertainty — how unsure the recent answers were (1 − their mean confidence)
    D  disagreement — how far recent sampled answers spread (mean divergence)
    I  impact — how much this question matters (its priority)
    C  cost — how little quota is left to spend (1 − the usable agents' mean remaining share)
and the samples are not merely folded into one answer: those that reach clearly different conclusions are kept as
shadow paths (影子路线, up to two beside the main line — a small beam of diverse, plausible directions, as in
Quality-Diversity search) that the reflection step revisits later: promote one when the evidence turns its way, drop it
when it dies. Nothing is lost to an early choice, and nothing runs forever.

Borrowed from:
    Mixture-of-Agents (Together AI, ICLR 2025)   several proposers, one aggregator that writes the final answer
    Universal Self-Consistency (Chen et al.)     the model itself picks what is consistent across free-form answers
    SPUQ (Intuit, EACL 2024)                     perturb the input; how much the answers move = how uncertain
    Verbalized Sampling (CHATS-lab, 2025)        ask for different, less typical answers to avoid mode collapse
    Tree of Thoughts / beam search / MAP-Elites  keep several distinct, good paths open instead of one winner
    OpenEvolve / AlphaEvolve                     varied prompt templates and "inspirations" to keep exploring

The perturbations here are cheap and need no model call: a framing (a stance to answer from), the order of the context
sections, and — when stronger — one context section left out. Sample 0 is never disturbed, so there is always an anchor.
"""

from __future__ import annotations

import random
import re

# a stance to answer from: (中文名, instruction added to the system prompt)
FRAMES: dict[str, tuple[str, str]] = {
    "skeptic": ("怀疑者", "Approach this as a skeptic: assume the most obvious answer is wrong and look for what it misses."),
    "first_principles": ("第一性原理", "Reason from first principles; set aside how this is usually done."),
    "analogy": ("跨领域类比", "Borrow an analogy from a different field and follow what it suggests."),
    "user": ("用户视角", "Answer from the point of view of the person who will live with the result."),
    "minimal": ("最小改动", "Prefer the smallest, cheapest change that would actually work."),
    "bold": ("大胆", "Give the most ambitious answer that still holds up."),
    "failure": ("从失败出发", "Start from the ways this could fail, then answer."),
    "unexplored": ("没走过的路", "Argue for an option that nobody on the board has considered yet."),
    "unusual": ("不典型的答案", "Do not give the most typical answer; give a less common one that is still correct."),
}
ANCHOR = "anchor"


def perturb(system: str, prompt: str, i: int, rng: random.Random, strength: float) -> tuple[str, str, list[str]]:
    """The i-th sample's system prompt and prompt, and the operators applied (names, for the record)."""
    if i == 0 or strength <= 0:
        return system, prompt, [ANCHOR]
    ops: list[str] = []
    frames = rng.sample(list(FRAMES), 2 if strength >= .5 else 1)
    system = system + "\n\nFor this answer: " + " ".join(FRAMES[f][1] for f in frames)
    ops += frames
    head, sep, tail = prompt.rpartition("\n\n<question")              # the question stays last; the context above it moves
    if sep:
        parts = [p for p in head.split("\n\n") if p.strip()]
        if len(parts) > 2:
            if strength >= .7:
                drop = rng.randrange(1, len(parts))                    # never the board itself (first section)
                parts.pop(drop)
                ops.append("drop_context")
            rest = parts[1:]
            rng.shuffle(rest)
            parts = parts[:1] + rest
            ops.append("reorder_context")
        prompt = "\n\n".join(parts) + sep + tail
    return system, prompt, ops


def label(ops: list[str]) -> str:
    return "原样" if ops == [ANCHOR] else " · ".join(FRAMES[o][0] if o in FRAMES else {"drop_context": "少一段上下文",
                                                                                     "reorder_context": "换上下文顺序"}.get(o, o) for o in ops)


_W = re.compile(r"[A-Za-z0-9_]+|[㐀-鿿]")


def _grams(t: str) -> set[str]:
    toks = [m.group(0).lower() for m in _W.finditer(t or "")]
    return set(toks) | {a + b for a, b in zip(toks, toks[1:])}


def fork_score(U: float, D: float, I: float, C: float) -> float:
    """0 … 1: how much one decision deserves several independent answers."""
    return round(max(0.0, min(1.0, .35 * U + .30 * D + .35 * I - .30 * C)), 3)


def fork_samples(score: float, max_samples: int) -> int:
    """1 when nothing calls for it; up to max_samples when the decision is uncertain, contested and important."""
    if max_samples <= 1:
        return 1
    return max(1, min(max_samples, 1 + round(score * (max_samples - 1) + .15)))


def clusters(texts: list[str], same: float = .22) -> list[list[int]]:
    """Group answers that say much the same (word overlap ≥ `same`); each group is one distinct conclusion."""
    grams = [_grams(t) for t in texts]
    groups: list[list[int]] = []
    for i, g in enumerate(grams):
        for grp in groups:
            h = grams[grp[0]]
            if len(g & h) / max(1, len(g | h)) >= same:
                grp.append(i)
                break
        else:
            groups.append([i])
    return groups


def divergence(texts: list[str]) -> float:
    """0 = the samples say the same thing, 1 = nothing in common (1 − mean pairwise Jaccard of words and word pairs)."""
    g = [_grams(t) for t in texts if (t or "").strip()]
    if len(g) < 2:
        return 0.0
    sims = [len(a & b) / max(1, len(a | b)) for i, a in enumerate(g) for b in g[i + 1:]]
    return round(1 - sum(sims) / len(sims), 3)


AGGREGATE = """You are {role} on a perpetual task. Several agents answered the SAME question independently, some from a
deliberately different angle. A vague task has no single right answer: do not just pick one or average them.
Write the best answer you can from all of them (keep what is well supported, resolve conflicts, say what stays open),
and separately list the ideas that only one or two samples had and that are worth keeping as inspiration.
If some samples reach a clearly DIFFERENT conclusion that you did not adopt but that is still plausible, keep it as an
alternative path (at most 2): its conclusion, and the core assumption that makes it different. Leave alternatives empty
when the samples agree.
{where} {proposal_rule}
Write "answer" and the ideas in {lang} (answer at most 300 words).
Reply with JSON only: {{"answer": "...", "agreed": ["what most samples agree on"], "ideas": [{{"idea": "...", "from": [1]}}],
"alternatives": [{{"conclusion": "...", "assumption": "...", "from": [2], "strength": 0.0-1.0}}],
"evidence": ["path or source"], "confidence": 0.0-1.0,
"proposal": null or {{"title": "≤8 words, English", "change": "...", "files": ["src/pga/…"], "expected_gain": "...", "risk": "...",
"evaluation_plan": "...", "rollback_condition": "..."}},
"follow_up": [{{"q": "...", "why": "...", "kind": "code|product|research|user", "priority": 0.0-1.0}}]}}"""
