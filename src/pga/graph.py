"""The memory graph (记忆图谱): everything PGA remembers about you, as one picture.

Nodes: you, the five sides of your personal model, the world model, each motivation (a tree), each line of work, each
conversation (PGA's own chats and the ones imported from other apps), each piece of knowledge (datasets, skills, your
documents, web pages, notes) and each agent. Edges: what is already known — you pursue a motivation, knowledge grew
from a tree, the links drawn between knowledge and trees (bridges: references, derived_from, depends_on, contradicts,
relates), a conversation belongs to a line, an agent answered in it, a chat branched from another. Nothing here is
sent to a model; private knowledge shows as a node without its text.
"""
from __future__ import annotations

from collections import Counter
from datetime import datetime, timedelta
from typing import TYPE_CHECKING

from sqlalchemy import select

from pga.db.models import Aim, Body, Bridge, PerpetualTask, User
from pga.db.types import utcnow

if TYPE_CHECKING:
    from pga.runtime import Runtime

DIMS = {"background": ("背景", "Background"), "goals": ("目标", "Goals"), "preferences": ("偏好", "Preferences"),
        "abilities": ("能力", "Knowledge & skills"), "state": ("状态", "Current state")}


def _iso(d: datetime | None) -> str | None:
    return d.isoformat() if d else None


def _kind(b: Body) -> str:
    src = (b.data or {}).get("source")
    if b.kind == "note" or src == "note":
        return "note"
    if src == "upload":
        return "doc"
    if src == "web":
        return "web"
    return "skill" if b.kind == "skill" else "data"


def build(rt: "Runtime", user: User, days: int = 90, now: datetime | None = None) -> dict:
    s, now = rt.session, now or utcnow()
    nodes: dict[str, dict] = {}
    edges: list[dict] = []

    def node(nid: str, type_: str, label: str, **kw) -> dict:
        n = nodes.get(nid)
        if n is None:
            n = nodes[nid] = {"id": nid, "type": type_, "label": (label or "")[:120], "at": None, "size": 1, **kw}
        return n

    def edge(a: str, b: str, kind: str, **kw) -> None:
        if a in nodes and b in nodes and a != b:
            edges.append({"a": a, "b": b, "kind": kind, **kw})

    node("you", "you", "你", size=6)
    # the two models
    for b in s.scalars(select(Body).where(Body.user_id == user.id, Body.system.in_(("user", "world")))):
        if b.system == "user":
            for k, v in ((b.data or {}).get("dims") or {}).items():
                if k in DIMS:
                    summ = v.get("summary") if isinstance(v, dict) else str(v)
                    node(f"dim:{k}", "dim", DIMS[k][0], label_en=DIMS[k][1], sub=(summ or "")[:400], at=_iso(b.compiled_at), size=2.2,
                         open={"doc": str(b.id)})
                    edge("you", f"dim:{k}", "is")
        else:
            node(f"k:{b.id}", "world", "世界模型", sub=(b.description or "")[:400], at=_iso(b.compiled_at), size=3, open={"doc": str(b.id)}, link=f"k:{b.id}")
            edge("you", f"k:{b.id}", "sees")
    # motivations
    tasks = {t.aim_id: t for t in s.scalars(select(PerpetualTask).where(PerpetualTask.user_id == user.id))}
    for a in s.scalars(select(Aim).where(Aim.user_id == user.id)):
        t = tasks.get(a.id)
        node(f"aim:{a.id}", "aim", a.text, at=_iso((t.updated_at if t else None) or a.created_at), size=4,
             sub=("运行中" if t and t.status == "running" else "已暂停" if t else "还没开始"), status=t.status if t else None,
             open={"tree": str(a.id)}, link=f"aim:{a.id}")
        edge("you", f"aim:{a.id}", "pursues")
    # knowledge
    for b in s.scalars(select(Body).where(Body.user_id == user.id, Body.system.is_(None) | Body.system.notin_(("user", "world")))):
        k = _kind(b)
        node(f"k:{b.id}", k, b.title, sub="" if b.private else (b.description or "")[:400], private=b.private,
             at=_iso(b.compiled_at or b.created_at), size=1.6 + min(2.0, ((b.data or {}).get("chars") or len(b.description or "")) / 20000),
             open={"doc": str(b.id)} if k not in ("note",) else {"note": str(b.id)}, link=f"k:{b.id}", url=(b.data or {}).get("url"))
        if b.aim_id and f"aim:{b.aim_id}" in nodes:
            edge(f"aim:{b.aim_id}", f"k:{b.id}", "grew")
    for br in s.scalars(select(Bridge).where(Bridge.user_id == user.id)):
        edge(br.a_ref, br.b_ref, br.kind or "relates", bridge=str(br.id), note=br.note or "")
    # lines and conversations (the same picture as 所有对话, for the last `days`)
    agents: Counter = Counter()
    try:
        from pga.timeline import Timeline
        tl = Timeline(rt).build(user, days, now)
    except Exception:  # noqa: BLE001 - the timeline may be busy organising; the rest of the graph still stands
        tl = {"lines": {}, "sessions": []}
    for lid, m in (tl.get("lines") or {}).items():
        if lid.startswith("aim:") and lid in nodes:
            continue
        if m.get("kind") in ("project", "topic", "tree") and m.get("items", 0) > 1:
            node(f"line:{lid}", "line", m.get("title") or lid, sub=f"{m.get('items')} 段 · {m.get('days')} 天", size=2 + min(3.0, (m.get("weight") or 0) / 3),
                 open={"line": lid})
            edge("you", f"line:{lid}", "works on")
    seen: dict[str, dict] = {}
    for x in tl.get("sessions") or []:
        key = x["item"]
        c = seen.get(key)
        if c is None:
            ref = x.get("ref") or {}
            opener = {"chat": ref["chat"]} if ref.get("chat") else {"import": ref["conversation"], "line": x["line"]} if ref.get("conversation") \
                else {"tree": ref["tree"], "node": ref.get("node")} if ref.get("tree") else {"line": x["line"]}
            c = seen[key] = node(f"conv:{key}", "conv", x.get("title") or "", sub=" · ".join(z for z in (x.get("agent"), x.get("project")) if z),
                                 at=x.get("end") or x.get("at"), size=1, kind=x.get("kind"), open=opener, turns=0)
            line = x["line"]
            if line.startswith("aim:") and line in nodes:
                edge(line, f"conv:{key}", "in")
            elif f"line:{line}" in nodes:
                edge(f"line:{line}", f"conv:{key}", "in")
            if x.get("agent"):
                agents[x["agent"]] += 1
                node(f"agent:{x['agent']}", "agent", x["agent"], size=2)
                edge(f"agent:{x['agent']}", f"conv:{key}", "answered")
        c["turns"] = c.get("turns", 0) + (x.get("turns") or 1)
        c["at"] = max(c["at"] or "", x.get("end") or x.get("at") or "")
        c["size"] = 1 + min(2.5, c["turns"] / 40)
    for name, n in agents.items():
        nodes[f"agent:{name}"].update(size=2 + min(3.0, n / 15), sub=f"{n} 段对话")
    for k, v in ((user.preferences or {}).get("chat_branches") or {}).items():
        edge(f"conv:{v.get('from')}", f"conv:{k}", "branched")
    # what changed in the last day glows
    day = (now - timedelta(days=1)).isoformat()
    for n in nodes.values():
        n["new"] = bool(n.get("at") and n["at"] >= day)
    deg = Counter([e["a"] for e in edges] + [e["b"] for e in edges])
    for n in nodes.values():
        n["degree"] = deg.get(n["id"], 0)
    return {"nodes": list(nodes.values()), "edges": edges, "days": days,
            "counts": dict(Counter(n["type"] for n in nodes.values())), "at": now.isoformat()}


def link(rt: "Runtime", user: User, a: str, b: str, note: str = "") -> dict:
    """You drew a line between two nodes: a tree and a piece of knowledge → the tree references it (its agents read it);
    two pieces of knowledge → they relate."""
    from pga.bodies import BodyService
    kind = "references" if (a.startswith("aim:") ^ b.startswith("aim:")) else "relates"
    br = BodyService(rt).bridge(user.id, a, b, note, kind)
    return {"id": str(br.id), "a": br.a_ref, "b": br.b_ref, "kind": br.kind}

