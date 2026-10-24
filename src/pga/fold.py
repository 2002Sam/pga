"""上下文折叠: the older part of a long conversation, folded by topic instead of cut off.

An agent that does not hold the conversation's own session hears only the last few exchanges (the composer sends six).
Everything before that used to vanish. Here the older turns are grouped by the conversation's segments (pga.segments,
one per matter you worked on): a segment far from the question folds to its title, your questions in it and where the
answer got to; the segments the question comes back to unfold in full. Folding costs no model call — it reads the
segments already worked out for the world tree, and without them treats the older part as one segment.

The idea follows VCPToolBox's context folding (lioensky/VCPToolBox, CC BY-NC-SA): only the outline of the idea is
borrowed, none of its code.
"""

from __future__ import annotations

import math
import re

from pga.knowledge.uploads import _grams

RECENT = 6           # exchanges the composer already sends verbatim
OPEN = 2             # segments that may unfold in full
OPEN_MIN = 0.1       # how close to the question a segment must be to unfold
FULL_CHARS = 1800    # per answer, when unfolded
BUDGET = 24000       # characters for the whole block


def _clip(t: str, n: int) -> str:
    t = re.sub(r"\s+", " ", str(t or "")).strip()
    return t if len(t) <= n else t[: n - 1] + "…"


COMMON = {"什么", "怎么", "一下", "一个", "这个", "那个", "可以", "我们", "你的", "我的", "没有", "现在", "是不", "不是", "就是", "还有",
          "the", "and", "for", "you", "this", "that", "what", "how"}


def closeness(question: str, text: str) -> float:
    """Shared words and character pairs (common ones aside), against the size of both; 0 below two shared."""
    q, g = set(_grams(question)) - COMMON, set(_grams(text)) - COMMON
    shared = len(q & g)
    if shared < 2:
        return 0.0
    return shared / math.sqrt(len(g) * len(q))


def fold_turns(turns: list[dict], segs: list[dict], question: str, recent: int = RECENT) -> str:
    """turns: [{role, text}] oldest first; segs: [{from, to, title}] over your questions (1-based). The older turns,
    folded or unfolded by how close each segment is to the question."""
    exchanges: list[tuple[str, str]] = []
    for t in turns:
        if t.get("role") == "user":
            exchanges.append((str(t.get("text") or ""), ""))
        elif exchanges and not exchanges[-1][1]:
            exchanges[-1] = (exchanges[-1][0], str(t.get("text") or ""))
    older = exchanges[:-recent] if recent else exchanges
    if not older:
        return ""
    n = len(older)
    segs = [s for s in (segs or []) if isinstance(s, dict) and int(s.get("from") or 0) <= n] or [{"from": 1, "to": n, "title": ""}]
    parts = []
    for s in segs:
        a, b = max(1, int(s["from"])), min(n, int(s.get("to") or n))
        if b < a:
            continue
        xs = older[a - 1:b]
        text = " ".join([s.get("title") or ""] + [q for q, _ in xs])
        parts.append({"from": a, "to": b, "title": s.get("title") or "", "xs": xs, "score": closeness(question, text)})
    for p in sorted(parts, key=lambda p: -p["score"])[:OPEN]:
        p["open"] = p["score"] >= OPEN_MIN
    out, used = [], 0
    for p in parts:
        head = f"[{p['from']}–{p['to']}] {p['title'] or 'earlier'}"
        if p.get("open"):
            body = "\n".join(f"User: {_clip(q, 1200)}\nAssistant: {_clip(a, FULL_CHARS)}" for q, a in p["xs"])
            block = f"{head} (shown in full: the question comes back to it)\n{body}"
        else:
            qs = " / ".join(_clip(q, 90) for q, _ in p["xs"][:5]) + (f" / … {len(p['xs']) - 5} more" if len(p["xs"]) > 5 else "")
            block = f"{head} (folded) — asked: {qs}; it got to: {_clip(p['xs'][-1][1], 220)}"
        if used + len(block) > BUDGET:
            block = f"{head} (folded)"
        out.append(block)
        used += len(block)
    return ("<earlier_in_this_conversation note=\"the part before the recent turns, by topic: far topics are folded to what was asked "
            "and where it got to, the ones the question comes back to are in full\">\n" + "\n\n".join(out) + "\n</earlier_in_this_conversation>")


def earlier(rt, user, key: str, question: str, recent: int = RECENT) -> str:
    """For an ask in a conversation of PGA's own: its older turns, folded (empty when it is short)."""
    if not key or not key.startswith("chat:"):
        return ""
    from pga.chats import history
    turns = history(rt, user, key)
    if sum(1 for t in turns if t.get("role") == "user") <= recent:
        return ""
    from pga.worldtree import WorldTree
    leaf = WorldTree(rt).leaf_of(user, key)
    segs = (((leaf.data or {}).get("segments") or {}).get("list") or []) if leaf is not None else []
    return fold_turns(turns, segs, question, recent)
