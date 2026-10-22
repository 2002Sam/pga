"""无限画布: every topic of the world tree gets a board laid out like an Unreal Engine blueprint. An input node feeds an
assign node, which splits it into tasks. The branches are the conversations and sub-topics under the topic, plus the
tasks it assigned. An output node merges the branches. Conversations, skills (Hermes's own, Claude Code's), pictures you
uploaded and notes are all nodes, and wires carry what one node says into the next.

Cooking is non-destructive, after Houdini and ComfyUI:
* a node remembers what it was cooked from (its own settings and what its inputs said);
* when that changes, the node is marked stale instead of being redone or thrown away;
* re-cooking keeps the earlier outputs as versions;
* a locked node keeps its output, and a bypassed one passes its inputs through.

The board itself runs in the browser (web/app-canvas.js), where each node is a call PGA already has (ask an agent,
split, branch). This module keeps the boards, seeds and syncs them from the world tree, merges branches, and lists what
can become a node.

Designs drawn on (nothing is copied here; the one copied function is in app-canvas.js with its notice):
* JSON Canvas (obsidianmd/jsoncanvas, MIT) gives the shape of the data: nodes with x, y, width, height, and edges
  fromNode → toNode, so a board exports as a .canvas file.
* Unreal Engine Blueprints and LiteGraph.js (MIT) give pins, wires dragged off a pin into a node search, and the
  right-click palette.
* Houdini gives dirty flags propagated downstream, lock and bypass, and the Tab menu.
* ComfyUI (GPL-3.0, design only) gives the rule that a node re-runs only when the signature of its inputs changed.
* tldraw's branching-chat starter kit gives the rule that a conversation node's context is what flows into it along
  the wires.
"""
from __future__ import annotations

import hashlib
import json
import logging
import re
import uuid
from datetime import datetime
from pathlib import Path
from typing import TYPE_CHECKING

from sqlalchemy import select

from pga.agent.common import UNTRUSTED_NOTE, fence
from pga.db.models import Canvas, User, WorldNode
from pga.db.types import utcnow

if TYPE_CHECKING:
    from pga.runtime import Runtime

log = logging.getLogger(__name__)

TOP = "top"
COL = {"input": 0, "dispatch": 340, "branch": 680, "output": 1040}
SKILL_ROOTS = {"hermes": Path.home() / ".hermes" / "skills", "claude": Path.home() / ".claude" / "skills"}
IMAGE_EXT = {".png", ".jpg", ".jpeg", ".gif", ".webp"}


class CanvasError(ValueError):
    pass


class CanvasConflict(CanvasError):
    """The board changed since you loaded it (another tab saved it)."""


def _short(s: str) -> str:
    return hashlib.sha1(s.encode()).hexdigest()[:10]


def _clip(t: str | None, n: int) -> str:
    t = re.sub(r"\s+", " ", str(t or "")).strip()
    return t if len(t) <= n else t[: n - 1] + "…"


class Boards:
    def __init__(self, rt: "Runtime"):
        from pga.worldtree import WorldTree
        self.rt, self.s, self.wt = rt, rt.session, WorldTree(rt)

    # -------------------------------------------------------------- which board
    def topic(self, user: User, world: str | None) -> WorldNode | None:
        """The world-tree topic a board stands for: None for the top board (the root, or no tree yet). A conversation
        (a leaf) opens its topic's board."""
        if not world or world == TOP:
            return None
        try:
            n = self.wt.get(user, uuid.UUID(str(world)))
        except ValueError:
            n = None
        if n is None:
            raise CanvasError("no such topic")
        while n is not None and n.kind == "leaf":
            n = self.s.get(WorldNode, n.parent_id) if n.parent_id else None
        return None if n is None or n.kind == "root" else n

    def board(self, user: User, world: str | None = None) -> Canvas:
        """The board for a topic: made and laid out from the world tree the first time, then kept in step with it (new
        conversations and sub-topics are added as branches; ones that left are greyed out, never removed)."""
        topic = self.topic(user, world)
        key = str(topic.id) if topic else TOP
        c = self.s.scalar(select(Canvas).where(Canvas.user_id == user.id, Canvas.world == key))
        if c is None:
            c = Canvas(user_id=user.id, world=key, title=topic.title if topic else "顶层", rev=1, data=self.seed(user, topic))
            self.s.add(c)
            self.s.flush()
            return c
        data = self.sync(user, topic, c.data or {})
        if data is not None:
            c.data, c.rev, c.updated_at = data, (c.rev or 0) + 1, utcnow()
            if topic and c.title != topic.title:
                c.title = topic.title
            self.s.flush()
        return c

    def get(self, user: User, cid: uuid.UUID) -> Canvas:
        c = self.s.get(Canvas, cid)
        if c is None or c.user_id != user.id:
            raise CanvasError("no such board")
        return c

    def save(self, user: User, cid: uuid.UUID, data: dict, rev: int | None) -> Canvas:
        c = self.get(user, cid)
        if rev is not None and int(rev) != int(c.rev or 0):
            raise CanvasConflict("this board changed in another window; reload it")
        if not isinstance(data, dict) or not isinstance(data.get("nodes"), list) or not isinstance(data.get("edges"), list):
            raise CanvasError("a board is {nodes: [...], edges: [...]}")
        if len(json.dumps(data, ensure_ascii=False)) > 4_000_000:
            raise CanvasError("this board is too large to keep (over 4 MB)")
        c.data, c.rev, c.updated_at = data, (c.rev or 0) + 1, utcnow()
        self.s.flush()
        return c

    def crumbs(self, user: User, c: Canvas) -> list[dict]:
        out = [{"world": TOP, "title": "顶层"}]
        if c.world == TOP:
            return out
        try:
            n = self.wt.get(user, uuid.UUID(c.world))
        except ValueError:
            n = None
        if n is None:
            return out
        return out + [{"world": str(x.id), "title": x.title} for x in self.wt.path(n) if x.kind != "root"]

    def out(self, user: User, c: Canvas) -> dict:
        return {"id": str(c.id), "world": c.world, "title": c.title, "rev": c.rev, "data": c.data, "crumbs": self.crumbs(user, c),
                "updated_at": c.updated_at.isoformat() if c.updated_at else None}

    # -------------------------------------------------------------- laying a board out from the world tree
    def _children(self, user: User, topic: WorldNode | None) -> list[WorldNode]:
        parent = topic or self.wt.root(user, create=False)
        if parent is None:
            return []
        kids = [k for k in self.wt.children(parent) if not (k.data or {}).get("hidden")]
        groups = [k for k in kids if k.kind != "leaf"]
        leaves = sorted([k for k in kids if k.kind == "leaf"], key=lambda k: str((k.data or {}).get("last") or ""), reverse=True)
        return groups + leaves[:60]

    def _convo(self, user: User, ref: str | None) -> dict | None:
        """What a conversation asked last and what came back. Only PGA's own conversations have their turns here; an
        imported session has just the tree's gist."""
        from pga.chats import current, fold, runs_of
        from pga.tree import _answer
        if not ref:
            return None
        if ref.startswith("c:"):                                   # imported from another app (Claude Code, Codex…): read from its own store
            return self._imported(user, ref[2:])
        try:
            turns, alts = fold(runs_of(self.rt, user.id, ref))
        except Exception:  # noqa: BLE001 - a key PGA cannot read turns for
            return None
        turns = [t for t in turns if not (t.data or {}).get("note")]
        if not turns:
            return None
        a = current(turns[-1], alts)
        return {"ask": (turns[-1].prompt or "")[:3000], "answer": (_answer(a.output) or "")[:6000], "turns": len(turns),
                "prev": str(turns[-2].id) if len(turns) > 1 else None, "agent": (a.data or {}).get("agent") or a.agent}

    def _imported(self, user: User, cid: str) -> dict | None:
        from pga.db.models import AgentConversation, LinkedAgent
        from pga.hub.connectors import full_turns
        try:
            c = self.s.get(AgentConversation, uuid.UUID(cid))
            a = self.s.get(LinkedAgent, c.linked_agent_id) if c else None
            if a is None or a.user_id != user.id:
                return None
            turns = [t for t in full_turns(a.connector, c.external_id) if (t.get("text") or "").strip()]
        except Exception:  # noqa: BLE001 - the app's store is gone or unreadable: the tree's gist stands
            return None
        qs = [i for i, t in enumerate(turns) if t["role"] == "user"]
        if not qs:
            return None
        ans = next((t["text"] for t in reversed(turns[qs[-1]:]) if t["role"] != "user"), "")
        ask = re.sub(r"^\s*<(\w+)>\s*([\s\S]*?)\s*</\1>\s*$", r"\2", turns[qs[-1]]["text"])       # the app's own wrapper tag around what you typed
        return {"ask": ask[:3000], "answer": ans[:6000], "turns": len(qs), "prev": None, "agent": a.name}

    def _fill(self, user: User, k: WorldNode, q: dict, c: dict) -> None:
        """The conversation as it stands: its question in the input, its answer in the conversation node."""
        d, cv = k.data or {}, self._convo(user, k.ref)
        ask = cv["ask"] if cv else _clip(k.title, 300)
        q.update(text=ask, title="提问" + (f" · 第 {cv['turns']} 轮" if cv and cv["turns"] > 1 else ""))
        c.update(out=cv["answer"] if cv and cv["answer"] else _clip(d.get("gist") or d.get("excerpt") or k.summary, 600), ask0=ask,
                 prev=cv["prev"] if cv else None, turns=cv["turns"] if cv else None, last=d.get("last"), gist=_clip(d.get("gist"), 200),
                 agent=(cv or {}).get("agent") or d.get("agent") or "auto", cin=None)

    def _branch(self, user: User, k: WorldNode, row: int) -> list[dict]:
        """A sub-topic is one node (its own board); a conversation is two: what was asked → the conversation, showing its answer."""
        d = k.data or {}
        if k.kind != "leaf":
            return [{"id": "w-" + str(k.id)[:10], "kind": "board", "world": str(k.id), "title": _clip(k.title, 80), "plan": k.kind == "plan",
                     "out": _clip(k.summary, 600), "count": d.get("count"), "seeded": True, "width": 270, "row": row,
                     "x": COL["branch"], "y": 200 + row * 240}]
        cid = "c-" + _short(k.ref or str(k.id))
        q = {"id": "q-" + cid[2:], "kind": "input", "seeded": True, "askOf": cid, "width": 280, "row": row, "x": COL["dispatch"], "y": 200 + row * 240}
        c = {"id": cid, "kind": "chat", "key": k.ref, "world": str(k.id), "title": _clip(k.title, 80), "seeded": True, "askIn": q["id"],
             "who": d.get("who") or ("agent" if d.get("type") == "tree" else "me"), "width": 290, "row": row, "x": COL["branch"], "y": 200 + row * 240}
        self._fill(user, k, q, c)
        return [q, c]

    @staticmethod
    def _wire(nodes: list[dict]) -> list[dict]:
        out = []
        for n in nodes:
            if n["kind"] == "input":
                out.append({"id": "e-q-" + n["id"], "fromNode": n["id"], "toNode": n["askOf"]})
            else:
                out.append({"id": "e-o-" + n["id"], "fromNode": n["id"], "toNode": "out"})
        return out

    def seed(self, user: User, topic: WorldNode | None) -> dict:
        """A row for each sub-topic and conversation (what was asked → its answer), all flowing into the output, which starts
        as the topic's summary; above them, a new input and the assign node for what you ask next."""
        root = topic or self.wt.root(user, create=False)
        rows = [n for i, k in enumerate(self._children(user, topic)) for n in self._branch(user, k, i)]
        nodes = [{"id": "in", "kind": "input", "x": COL["input"], "y": 0, "width": 280, "title": "新的输入", "text": "", "row": -1},
                 {"id": "assign", "kind": "dispatch", "x": COL["dispatch"], "y": 0, "width": 280, "title": "指派", "row": -1},
                 *rows,
                 {"id": "out", "kind": "output", "x": COL["output"], "y": 0, "width": 310, "title": "输出",
                  "out": _clip(root.summary if root else "", 1600), "seeded": True}]
        edges = [{"id": "e-in", "fromNode": "in", "toNode": "assign"}, {"id": "e-a-out", "fromNode": "assign", "toNode": "out"}] + self._wire(rows)
        return {"v": 3, "title": topic.title if topic else "顶层", "nodes": nodes, "edges": edges, "view": None}

    def sync(self, user: User, topic: WorldNode | None, data: dict) -> dict | None:
        """Keep the board in step with the world tree and the conversations themselves:
        - new conversations and sub-topics join as new rows;
        - ones that moved away are greyed out (gone), never removed;
        - a conversation that went on elsewhere shows its latest question and answer, unless you changed that row here
          (then yours stays, and the conversation is not touched)."""
        nodes, edges = list(data.get("nodes") or []), list(data.get("edges") or [])
        kids = {str(k.id): k for k in self._children(user, topic)}
        have = {n.get("world"): n for n in nodes if n.get("seeded") and n.get("world") and n.get("kind") in ("chat", "board")}
        by_id = {n.get("id"): n for n in nodes}
        keys = {n.get("key") for n in nodes if n.get("key")}
        changed = False
        for w, n in have.items():
            gone = w not in kids
            q = by_id.get(n.get("askIn"))
            for x in (n, q):
                if x is not None and bool(x.get("gone")) != gone:
                    x["gone"] = gone
                    changed = True
            if gone:
                continue
            k = kids[w]
            if n["kind"] == "board":
                if n.get("out") != _clip(k.summary, 600):
                    n["out"], n["count"] = _clip(k.summary, 600), (k.data or {}).get("count")
                    changed = True
                continue
            if q is None:                                           # a board laid out before conversations had their question
                q = {"id": "q-" + n["id"][2:], "kind": "input", "seeded": True, "askOf": n["id"], "width": 280, "row": n.get("row"),
                     "x": float(n.get("x") or COL["branch"]) - (COL["branch"] - COL["dispatch"]), "y": n.get("y") or 0}
                nodes.append(q)
                by_id[q["id"]] = q
                n["askIn"] = q["id"]
                edges = [e for e in edges if not (e.get("fromNode") == "assign" and e.get("toNode") == n["id"])]
                edges.append({"id": "e-q-" + q["id"], "fromNode": q["id"], "toNode": n["id"]})
                self._fill(user, k, q, n)
                changed = True
            elif not n.get("hist") and not (n.get("text") or "").strip() and q.get("text") == n.get("ask0") and n.get("last") != (k.data or {}).get("last"):
                self._fill(user, k, q, n)
                changed = True
        root = topic or self.wt.root(user, create=False)
        out = next((n for n in nodes if n.get("id") == "out" and n.get("seeded") and not n.get("hist")), None)
        if out is not None and (changed or out.get("out") != _clip(root.summary if root else "", 1600)):
            out["out"], out["cin"] = _clip(root.summary if root else "", 1600), None     # never run by you: it follows the topic's summary
            changed = True
        new = [k for w, k in kids.items() if w not in have and not (k.ref and k.ref in keys)]
        if new:
            row = max((int(n.get("row") or 0) for n in nodes if n.get("row") is not None), default=-1) + 1
            ids = {n.get("id") for n in nodes}
            for i, k in enumerate(new):
                made = self._branch(user, k, row + i)
                nodes += made
                edges += [e for e in self._wire(made) if e["toNode"] != "out" or "out" in ids]
            changed = True
        return {**data, "nodes": nodes, "edges": edges} if changed else None

    # -------------------------------------------------------------- the output node: branches merged into one answer
    def merge(self, user: User, question: str, parts: list[dict], now: datetime | None = None) -> str:
        """Mixture-of-Agents' aggregator (pga.agents.council) over what the branches said."""
        from pga.agents.council import AGGREGATOR
        parts = [p for p in parts if str(p.get("text") or "").strip()][:16]
        if not parts:
            raise CanvasError("nothing flows into this node yet")
        system = (AGGREGATOR + "".join(f"\n{i + 1}. [{_clip(p.get('title'), 80)}] {str(p.get('text'))[:8000]}" for i, p in enumerate(parts))
                  + "\n\nWrite in the language of the request, in Markdown prose (headings and lists where they help). " + UNTRUSTED_NOTE)
        ask = fence("request", question.strip() or "把这些分支的结果合成一个完整、清楚的回答：结论、各自的要点、彼此的分歧、还需要决定的事。", 6000, kind="what to merge them into")
        return self._call(user, system, ask, len(parts), now or utcnow()).strip()

    def _call(self, user: User, system: str, prompt: str, n: int, now: datetime) -> str:
        """PGA's own model, directly: the branches were the agents' work; merging them should take seconds, not go to
        another agent as a long task."""
        from pga.agents.council import CouncilError
        from pga.allocator import Estimates, Justification, RunRequest
        decision = self.rt.allocator.allocate(RunRequest(
            user_id=user.id, kind="synthesis",
            justification=Justification(why_now=f"merging {n} branches of a board", expected_gain="one answer built from every branch",
                                        decision_affected="what you take from this board", budget={"max_units": 40_000, "max_output_tokens": 3000},
                                        stop_condition="merged"),
            estimates=Estimates(information_gain=.5, decision_impact=.6, user_relevance=.9, reuse_value=.5,
                                input_tokens=(len(system) + len(prompt)) // 3, output_tokens=1500)), now=now)
        if not decision.allowed:
            raise CouncilError("; ".join(decision.reasons))
        with self.rt.runs.track(decision, now) as guard:
            res = self.rt.router.complete(decision.tier, system=system, messages=[{"role": "user", "content": prompt}], max_tokens=3000,
                                          usage=guard.usage_context(), delegate=False)
            guard.stop("merged")
        return res.text or ""


# ------------------------------------------------------------------ what can become a node
def _frontmatter(text: str) -> dict:
    m = re.match(r"\s*---\s*\n(.*?)\n---", text, re.S)
    out = {}
    for line in (m.group(1) if m else "").splitlines():
        mm = re.match(r"^(name|description):\s*(.*)$", line)
        if mm:
            out[mm.group(1)] = mm.group(2).strip().strip("\"'")
    return out


def skills(limit: int = 400) -> list[dict]:
    """Skills on this machine: Hermes's (including the ones it wrote itself) and Claude Code's, newest first."""
    out = []
    for src, root in SKILL_ROOTS.items():
        if not root.is_dir():
            continue
        for p in root.rglob("SKILL.md"):
            try:
                meta = _frontmatter(p.read_text(errors="ignore")[:4000])
                st = p.stat()
            except OSError:
                continue
            rel = p.parent.relative_to(root).parts
            out.append({"source": src, "name": meta.get("name") or p.parent.name, "description": _clip(meta.get("description"), 240),
                        "category": rel[0] if len(rel) > 1 else "", "path": str(p), "mtime": st.st_mtime})
    return sorted(out, key=lambda x: -x["mtime"])[:limit]


def skill_text(path: str) -> dict:
    p = Path(path).expanduser().resolve()
    if p.name != "SKILL.md" or not any(p.is_relative_to(r.resolve()) for r in SKILL_ROOTS.values() if r.exists()):
        raise CanvasError("not a skill on this machine")
    text = p.read_text(errors="ignore")
    return {"name": _frontmatter(text).get("name") or p.parent.name, "path": str(p), "text": text[:16000]}


def image_roots() -> list[Path]:
    from pga.agents import pool
    try:
        root = Path(str(pool.load()["run"]["workspace_root"])).expanduser()
    except Exception:  # noqa: BLE001 - no agents.yaml yet
        root = Path(pool.DEFAULT["run"]["workspace_root"]).expanduser()
    return [root / "conversations"]


def images(limit: int = 200) -> list[dict]:
    """Pictures you attached to conversations before (each conversation's uploads/ folder), newest first."""
    out = []
    for root in image_roots():
        if not root.is_dir():
            continue
        for d in root.iterdir():
            up = d / "uploads"
            if not up.is_dir():
                continue
            for p in up.iterdir():
                if p.suffix.lower() in IMAGE_EXT and p.is_file():
                    st = p.stat()
                    out.append({"path": str(p), "name": re.sub(r"^\d+-\d+-", "", p.name), "mtime": st.st_mtime, "size": st.st_size})
    return sorted(out, key=lambda x: -x["mtime"])[:limit]


def image_path(path: str) -> Path:
    p = Path(path).expanduser().resolve()
    if p.suffix.lower() not in IMAGE_EXT or p.parent.name != "uploads" or not any(p.is_relative_to(r.resolve()) for r in image_roots() if r.exists()):
        raise CanvasError("not an uploaded picture")
    if not p.is_file():
        raise CanvasError("that picture is gone")
    return p
