"""做梦: while you are away, PGA looks back over a few of your conversations and tidies — with your say-so.

Once a day at most, after you have been away a while, it picks a couple of conversations from the world tree (the ones
it has not looked at for longest come first), follows what they link to (pga.associate), and writes down what it saw:
what they share, what changed, what is still open. Then it proposes a few changes:
- group: conversations that belong together go under one topic (an existing one, or a new one it names)
- archive: a finished conversation leaves the tree (it stays in 所有对话; you can bring it back)
- insight: one sentence about you for your self knowledge, from what the conversations show

Nothing changes until you approve it. When you reject one you can say why; the next dream reads your reasons, so it does
not propose the same thing again.

The idea follows VCPToolBox's AgentDream (lioensky/VCPToolBox, CC BY-NC-SA): only the outline is borrowed, none of its code.
"""

from __future__ import annotations

import logging
import random
import uuid
from datetime import datetime, timedelta
from typing import TYPE_CHECKING

from sqlalchemy import select

from pga.agent.common import fence
from pga.db.models import Dream, User, WorldNode
from pga.db.types import utcnow

if TYPE_CHECKING:
    from pga.runtime import Runtime

log = logging.getLogger(__name__)

EVERY = timedelta(hours=20)
SEEDS = 2
RECALL = 10
DIMS = ("background", "goals", "preferences", "abilities", "state")
DEFAULT = {"on": True}

SYSTEM = """You are PGA, the person's long-running agent. While they are away you look back over a few of their conversations
and the ones they lead to, the way a dream sorts the day's memories. Below: the conversations (L-codes, with the topic each
sits under, its gist and themes), the topics of their world tree (T-codes), what their self knowledge already says, and
proposals of yours they turned down before (with their reasons — do not propose those again).
Write "narrative" in {lang}, first person as PGA, at most 150 words: what these conversations have in common, what
changed over time, what seems unresolved. Then propose at most 4 changes, only ones clearly worth making:
- {{"type": "group", "leaves": ["L2", "L5"], "topic": "T3"}} or {{"type": "group", "leaves": [...], "new": "topic title", "under": "T1"}}:
  conversations that belong together but sit apart
- {{"type": "archive", "leaves": ["L4"]}}: finished conversations unlikely to matter again
- {{"type": "insight", "dim": "background|goals|preferences|abilities|state", "text": "one sentence about the person",
  "from": ["L1"]}}: something the conversations show that the self knowledge does not say yet
Each change has "why" in {lang} (one sentence). No change is better than a weak one.
Reply with JSON only: {{"narrative": "...", "ops": [...]}}"""


def cfg(user: User) -> dict:
    return {**DEFAULT, **((user.preferences or {}).get("dream") or {})}


class Dreamer:
    def __init__(self, rt: "Runtime", rng: random.Random | None = None):
        self.rt, self.s = rt, rt.session
        self.rng = rng or random.Random()
        from pga.worldtree import WorldTree
        self.wt = WorldTree(rt)

    # -------------------------------------------------------------- when
    def last(self, user: User) -> Dream | None:
        return self.s.scalar(select(Dream).where(Dream.user_id == user.id).order_by(Dream.created_at.desc()).limit(1))

    def due(self, user: User, now: datetime | None = None) -> bool:
        """You have been away long enough, it is on, the tree exists and the last dream was a while ago."""
        from pga import idle
        now = now or utcnow()
        if not cfg(user).get("on") or not self.wt.built(user):
            return False
        last_seen = idle._ts(idle.state(user).get("last"))
        if last_seen is None or now - last_seen < timedelta(minutes=idle.cfg(user)["minutes"]):
            return False
        d = self.last(user)
        return d is None or now - d.created_at >= EVERY

    # -------------------------------------------------------------- the dream
    def _seeds(self, leaves: list[WorldNode], k: int) -> list[WorldNode]:
        pool = [n for n in leaves if (n.data or {}).get("tags") or (n.data or {}).get("gist")]
        pool.sort(key=lambda n: (n.data or {}).get("dreamt_at") or "")         # the ones it looked at longest ago first
        head = pool[:max(k * 6, 12)]
        return self.rng.sample(head, min(k, len(head)))

    def _recall(self, user: User, seeds: list[WorldNode], leaves: list[WorldNode]) -> list[WorldNode]:
        from pga.associate import graph_for, recall
        from pga.fold import closeness
        by_id = {str(n.id): n for n in leaves}
        out: list[WorldNode] = []
        g = graph_for(self.rt, user.id)
        for sd in seeds:
            text = " ".join([sd.title, *((sd.data or {}).get("tags") or [])])
            for r in recall(g, text, k=6, exclude={str(sd.id)}):
                n = by_id.get(r["id"])
                if n is not None and n not in out and n not in seeds:
                    out.append(n)
            sibs = [x for x in leaves if x.parent_id == sd.parent_id and x is not sd and x not in out and x not in seeds]
            sibs.sort(key=lambda x: -closeness(sd.title + " " + (sd.data or {}).get("gist", ""), x.title + " " + (x.data or {}).get("gist", "")))
            out += sibs[:2]                                   # near neighbours under the same topic: duplicates show up here
        return out[:RECALL]

    def dream(self, user: User, now: datetime | None = None) -> Dream | None:
        from pga.teams import _lang
        from pga.worldtree import _clean
        now = now or utcnow()
        nodes = self.wt.nodes(user.id)
        leaves = [n for n in nodes if n.kind == "leaf" and not (n.data or {}).get("hidden")]
        seeds = self._seeds(leaves, SEEDS)
        if not seeds:
            return None
        recalled = self._recall(user, seeds, leaves)
        shown = seeds + recalled
        by = {str(n.id): n for n in nodes}
        topics = [n for n in nodes if n.kind in ("topic", "root") and not (n.data or {}).get("hidden")]
        topics.sort(key=lambda n: (n.depth, n.position))
        topics = topics[:60]
        tcode = {str(n.id): f"T{i + 1}" for i, n in enumerate(topics)}
        lcode = {str(n.id): f"L{i + 1}" for i, n in enumerate(shown)}
        convs = "\n".join(
            f"{lcode[str(n.id)]}{' (starting point)' if n in seeds else ''} | under {by[str(n.parent_id)].title if n.parent_id and str(n.parent_id) in by else '-'} "
            f"| {_clean(n.title, 80)} | {_clean((n.data or {}).get('gist', ''), 100)} | themes: {', '.join((n.data or {}).get('tags') or [])} "
            f"| last {((n.data or {}).get('last') or '')[:10]} | {_clean((n.data or {}).get('excerpt', ''), 300)}" for n in shown)
        tree = "\n".join(f"{tcode[str(n.id)]} {'  ' * max(0, n.depth - 1)}{_clean(n.title, 60)}" for n in topics)
        from pga.knowledge.datasets import Datasets
        me = Datasets(self.rt).ensure(user, now).get("user")
        dims = ((me.data or {}).get("dims") or {}) if me is not None else {}
        selfk = "\n".join(f"{k}: {(dims.get(k) or {}).get('summary', '')} | " + "; ".join((dims.get(k) or {}).get("stated", [])[:6]) for k in DIMS)
        turned = [o for d in self.s.scalars(select(Dream).where(Dream.user_id == user.id).order_by(Dream.created_at.desc()).limit(8))
                  for o in d.ops or [] if o.get("status") == "rejected"][:8]
        no = "\n".join(f"- {o.get('type')}: {o.get('label', '')} — their reason: {o.get('reason') or '(none given)'}" for o in turned)
        prompt = "\n\n".join(x for x in [
            fence("conversations", "code | topic | title | gist | themes | last | excerpt\n" + convs, 30000, kind="the person's conversations"),
            fence("world_tree_topics", tree, 8000, kind="the topics of the person's world tree"),
            fence("self_knowledge", selfk, 6000, kind="what the person's self knowledge says"),
            fence("turned_down_before", no, 4000, kind="your earlier proposals the person rejected") if no else ""] if x)
        d = self.wt._ask(user, SYSTEM.format(lang=_lang(user)), prompt, f"dreaming over {len(shown)} conversations", 2500, now)
        narrative = str(d.get("narrative") or "").strip()
        if not narrative:
            return None
        inv_l = {v: k for k, v in lcode.items()}
        inv_t = {v: k for k, v in tcode.items()}
        ops = []
        for o in (d.get("ops") or [])[:4]:
            op = self._op(o, inv_l, inv_t, by)
            if op:
                ops.append(op)
        for n in seeds:
            n.data = {**(n.data or {}), "dreamt_at": now.isoformat()}
        dr = Dream(user_id=user.id, narrative=narrative[:3000], seeds=[str(n.id) for n in seeds], recalled=[str(n.id) for n in recalled],
                   ops=ops, status="pending" if ops else "done", created_at=now, updated_at=now)
        self.s.add(dr)
        self.s.flush()
        return dr

    def _op(self, o, inv_l: dict, inv_t: dict, by: dict) -> dict | None:
        """A proposal from the model, checked and written with ids (and readable labels) instead of codes."""
        if not isinstance(o, dict):
            return None
        t, why = str(o.get("type") or ""), str(o.get("why") or "")[:300]
        codes = [str(c).strip().upper() for c in (o.get("leaves") or o.get("from") or []) if isinstance(c, str)]
        ids = list(dict.fromkeys(inv_l[c] for c in codes if c in inv_l))
        names = [by[i].title[:40] for i in ids if i in by]
        if t == "group" and ids:
            topic = inv_t.get(str(o.get("topic") or "").strip().upper())
            new = str(o.get("new") or "").strip()[:80]
            under = inv_t.get(str(o.get("under") or "").strip().upper())
            if topic:
                return {"type": "group", "leaves": ids, "topic": topic, "why": why, "status": "pending",
                        "label": f"{'、'.join(names)} → {by[topic].title[:40]}"}
            if new:
                return {"type": "group", "leaves": ids, "new": new, "under": under, "why": why, "status": "pending",
                        "label": f"{'、'.join(names)} → 新主题「{new}」"}
        if t == "archive" and ids:
            return {"type": "archive", "leaves": ids, "why": why, "status": "pending", "label": "、".join(names)}
        if t == "insight" and str(o.get("text") or "").strip() and str(o.get("dim") or "") in DIMS:
            return {"type": "insight", "dim": o["dim"], "text": str(o["text"]).strip()[:200], "from": ids, "why": why, "status": "pending",
                    "label": str(o["text"]).strip()[:80]}
        return None

    # -------------------------------------------------------------- your answer
    def decide(self, user: User, dr: Dream, i: int, approve: bool, reason: str = "", now: datetime | None = None) -> dict:
        now = now or utcnow()
        ops = [dict(o) for o in dr.ops or []]
        if not 0 <= i < len(ops) or ops[i].get("status") != "pending":
            raise ValueError("no such proposal waiting")
        o = ops[i]
        if approve:
            o["result"] = self._apply(user, o, now)
            o["status"] = "done"
        else:
            o["status"], o["reason"] = "rejected", reason.strip()[:400]
        o["at"] = now.isoformat()
        ops[i] = o
        dr.ops, dr.updated_at = ops, now
        if not any(x.get("status") == "pending" for x in ops):
            dr.status = "done"
        self.s.flush()
        return o

    def _apply(self, user: User, o: dict, now: datetime) -> dict:
        leaves = [n for n in (self.s.get(WorldNode, uuid.UUID(i)) for i in o.get("leaves") or []) if n is not None and n.user_id == user.id]
        if o["type"] == "group":
            if o.get("topic"):
                topic = self.s.get(WorldNode, uuid.UUID(o["topic"]))
            else:
                parent = self.s.get(WorldNode, uuid.UUID(o["under"])) if o.get("under") else None
                parent = parent if parent is not None and parent.user_id == user.id else self.wt.root(user)
                topic = self.wt.add_topic(user, parent, o["new"])
            if topic is None or topic.user_id != user.id:
                raise ValueError("the topic is gone")
            for n in leaves:
                self.wt.move(user, n, topic)
            return {"topic": str(topic.id), "moved": len(leaves)}
        if o["type"] == "archive":
            for n in leaves:
                self.wt.remove(user, n)
            return {"hidden": len(leaves)}
        if o["type"] == "insight":
            from pga.knowledge.datasets import Datasets, edit_facts
            b = Datasets(self.rt).ensure(user, now)["user"]
            edit_facts(b, o["dim"], add=o["text"])
            return {"dim": o["dim"]}
        raise ValueError(f"unknown proposal {o['type']!r}")

    def view(self, dr: Dream) -> dict:
        return {"id": str(dr.id), "narrative": dr.narrative, "at": dr.created_at.isoformat(), "status": dr.status,
                "seeds": [self._name(i) for i in dr.seeds or []], "recalled": [self._name(i) for i in dr.recalled or []],
                "ops": [{k: v for k, v in o.items() if k not in ("leaves", "topic", "under", "from")} | {"i": i} for i, o in enumerate(dr.ops or [])]}

    def _name(self, i: str) -> dict:
        n = self.s.get(WorldNode, uuid.UUID(i))
        return {"id": i, "title": n.title if n else "?", "ref": n.ref if n else None}
