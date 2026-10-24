"""联想召回: memories the question does not mention, reached through the themes your conversations share.

Full-text search only finds what shares words with the question. Someone who said three months ago that an exam is coming
and today says they are under pressure never typed "exam" again, so the old conversation never comes back. Here every
conversation in the world tree carries a few ordered tags (written with its gist, pga.worldtree.annotate). Tags that
appear in the same conversation are linked, and a question lights up the tags it touches; that energy flows a few hops
along the links, and the conversations whose tags end up lit are the associations.

The idea follows the tag co-occurrence propagation described for VCPToolBox's TagMemo (lioensky/VCPToolBox, CC BY-NC-SA);
nothing of its code is used, this is a small reimplementation from the published description:
- order carries a direction: an earlier tag points to a later one; flowing backwards costs more
- repeated co-occurrence is evidence, but compressed (log) so a frequent pair cannot take over
- every tag passes on at most a fixed share of its energy, split by its links
- tags that everything flows into (generic ones like "code") are damped by their inflow against the median
- a few hops only, nearer hops weigh more, and going straight back where it came from is mostly suppressed
No embeddings and no extra service: Postgres stays the source of truth, the graph is rebuilt in memory when the tree changes.
"""

from __future__ import annotations

import math
import re
import statistics
import uuid
from collections import defaultdict
from dataclasses import dataclass, field

from sqlalchemy import func, select

from pga.db.models import WorldNode

BACK = 0.5            # flowing against the written order costs this much
OUT_MASS = 0.8        # share of its energy a tag passes on, at most
HUB_ETA = 0.5         # how hard tags that everything flows into are damped
HUB_CLIP = (0.5, 1.5)
HOPS = 3
GAMMA = 0.6           # weight of hop t ∝ GAMMA**t
RETURN = 0.15         # going straight back (a → b → a)
FANOUT = 12           # links followed per tag
STATES = 400
FIRE = 0.01           # energy below this stops
MAX_TAGS = 8


def norm(tag: str) -> str:
    return re.sub(r"\s+", " ", str(tag or "")).strip().lower()[:40]


@dataclass
class Graph:
    sig: tuple
    out: dict[str, list[tuple[str, float]]] = field(default_factory=dict)       # tag → [(tag, share)], shares sum ≤ OUT_MASS
    leaves: dict[str, list[str]] = field(default_factory=dict)                  # leaf id → its tags in order
    by_tag: dict[str, set[str]] = field(default_factory=lambda: defaultdict(set))
    shown: dict[str, str] = field(default_factory=dict)                         # normalised → as written


def build(rows: list[tuple[str, list[str]]], sig: tuple = ()) -> Graph:
    """rows: (leaf id, ordered tags). Pairs in one leaf are linked: earlier → later at full weight, back at BACK."""
    g = Graph(sig=sig)
    w: dict[tuple[str, str], float] = defaultdict(float)
    for lid, tags in rows:
        ts: list[str] = []
        for t in tags[:MAX_TAGS]:
            n = norm(t)
            if n and n not in ts:
                ts.append(n)
                g.shown.setdefault(n, str(t).strip()[:40])
        if not ts:
            continue
        g.leaves[lid] = ts
        for t in ts:
            g.by_tag[t].add(lid)
        k = len(ts)
        for i in range(k):
            pot = 0.9 - 0.4 * i / max(1, k - 1)              # the first tags are what the conversation is most about
            for j in range(i + 1, k):
                near = 1 / (1 + 0.5 * (j - i - 1))
                w[(ts[i], ts[j])] += pot * near
                w[(ts[j], ts[i])] += pot * near * BACK
    ev = {e: math.log1p(x) for e, x in w.items()}
    inflow: dict[str, float] = defaultdict(float)
    for (_, b), x in ev.items():
        inflow[b] += x
    med = statistics.median(inflow.values()) if inflow else 1.0
    hub = {b: min(HUB_CLIP[1], max(HUB_CLIP[0], (x / (med + 1e-9)) ** -HUB_ETA)) for b, x in inflow.items()}
    nbrs: dict[str, list[tuple[str, float]]] = defaultdict(list)
    for (a, b), x in ev.items():
        nbrs[a].append((b, x * hub[b]))
    for a, xs in nbrs.items():
        xs = sorted(xs, key=lambda z: -z[1])[:FANOUT]
        tot = sum(x for _, x in xs) or 1.0
        g.out[a] = [(b, OUT_MASS * x / tot) for b, x in xs]
    return g


def spread(g: Graph, seeds: dict[str, float]) -> dict[str, float]:
    """Energy field over the tags: Σ_t w_t · energy at hop t, w_t = γ^t / Σ γ^r. States remember where they came from."""
    ws = [GAMMA ** t for t in range(HOPS + 1)]
    ws = [x / sum(ws) for x in ws]
    field_: dict[str, float] = defaultdict(float)
    states: dict[tuple[str | None, str], float] = {(None, s): e for s, e in seeds.items() if s in g.out or s in g.by_tag}
    for t in range(HOPS + 1):
        for (_, node), e in states.items():
            field_[node] += ws[t] * e
        if t == HOPS:
            break
        nxt: dict[tuple[str | None, str], float] = defaultdict(float)
        for (prev, node), e in states.items():
            for b, share in g.out.get(node, []):
                x = e * share * (RETURN if b == prev else 1.0)
                if x >= FIRE:
                    nxt[(node, b)] += x
        states = dict(sorted(nxt.items(), key=lambda z: -z[1])[:STATES])
        if not states:
            break
    return dict(field_)


def _grams(t: str) -> set[str]:
    t = (t or "").lower()
    han = re.sub(r"[^㐀-鿿]", "", t)
    return set(re.findall(r"[a-z0-9_+#.-]{2,}", t)) | {han[i:i + 2] for i in range(len(han) - 1)}


def seeds_for(g: Graph, text: str) -> dict[str, float]:
    """The tags the question touches: written in it, or most of their words / character pairs are."""
    low, q = (text or "").lower(), _grams(text)
    hit: dict[str, float] = {}
    for t in g.by_tag:
        if t in low:
            hit[t] = 1.0
            continue
        tg = _grams(t)
        if tg and len(tg & q) / len(tg) >= 0.6:
            hit[t] = 0.6
    if not hit:
        return {}
    tot = sum(hit.values())
    return {t: x / tot for t, x in hit.items()}


def recall(g: Graph, text: str, k: int = 5, exclude: set[str] | None = None) -> list[dict]:
    """Conversations reached through the field, best first; `via` names the lit tags that brought each one."""
    seeds = seeds_for(g, text)
    if not seeds:
        return []
    f = spread(g, seeds)
    exclude = exclude or set()
    scored = []
    for lid, ts in g.leaves.items():
        if lid in exclude:
            continue
        lit = [(t, f.get(t, 0.0) * (1.0 - 0.4 * i / max(1, len(ts) - 1))) for i, t in enumerate(ts)]
        s = sum(x for _, x in lit) / math.sqrt(len(ts))
        if s <= 0:
            continue
        direct = any(t in seeds for t in ts)
        via = [g.shown.get(t, t) for t, x in sorted(lit, key=lambda z: -z[1]) if x > 0][:3]
        scored.append({"id": lid, "score": round(s, 4), "direct": direct, "via": via})
    scored.sort(key=lambda z: -z["score"])
    return scored[:k]


# -------------------------------------------------------------- the person's world tree

_CACHE: dict[uuid.UUID, Graph] = {}


def graph_for(rt, user_id: uuid.UUID) -> Graph:
    s = rt.session
    sig = tuple(s.execute(select(func.count(WorldNode.id), func.max(WorldNode.updated_at))
                          .where(WorldNode.user_id == user_id, WorldNode.kind == "leaf")).one())
    g = _CACHE.get(user_id)
    if g is not None and g.sig == sig:
        return g
    rows = [(str(i), (d or {}).get("tags") or []) for i, d in s.execute(
        select(WorldNode.id, WorldNode.data).where(WorldNode.user_id == user_id, WorldNode.kind == "leaf"))]
    g = _CACHE[user_id] = build([(i, t) for i, t in rows if t and not (isinstance(t, dict))], sig)
    return g


def associated(rt, user_id: uuid.UUID, text: str, k: int = 4, exclude: set[str] | None = None) -> list[tuple[WorldNode, dict]]:
    """Associations only: conversations that share no tag with the question itself but are reached through others."""
    g = graph_for(rt, user_id)
    out = []
    for r in recall(g, text, k=k * 3, exclude=exclude):
        if r["direct"]:
            continue
        n = rt.session.get(WorldNode, uuid.UUID(r["id"]))
        if n is not None and not (n.data or {}).get("hidden"):
            out.append((n, r))
        if len(out) >= k:
            break
    return out


def block(rt, user_id: uuid.UUID, text: str, exclude: set[str] | None = None, k: int = 4) -> tuple[str, list[WorldNode]]:
    """For an ask: the associations as a labelled context block (they are candidates, not facts)."""
    xs = associated(rt, user_id, text, k=k, exclude=exclude)
    if not xs:
        return "", []
    from pga.worldtree import _clean
    lines = "\n".join(f"- «{n.title}» ({((n.data or {}).get('last') or '')[:10]}; linked through: {', '.join(r['via'])}): "
                      f"{_clean((n.data or {}).get('gist') or (n.data or {}).get('excerpt', ''), 300)}" for n, r in xs)
    return ("<associated_memories note=\"earlier conversations of the person the question does not mention, reached through themes "
            "they share with it; they may or may not matter — use one only if it really bears on the question\">\n"
            + lines + "\n</associated_memories>"), [n for n, _ in xs]
