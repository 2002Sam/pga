"""世界树 (the world tree): every conversation you have had, in one hierarchy of topics, each topic summarised from what
is under it — so you (or an agent) can take up one conversation, or talk to the topic above it, or the one above that.

The design follows three published systems, reimplemented here (no code taken from them):

* RAPTOR (Sarthi et al., ICLR 2024, github.com/parthsarthi03/raptor, MIT) — a tree built bottom-up by grouping and
  summarising, so every level of abstraction can be read. Here the first build groups with a model (titles, lines and
  excerpts of your conversations → a taxonomy and an assignment), then writes each topic's summary from its children,
  deepest first, the way RAPTOR summarises clusters level by level.
* GraphRAG (Edge et al., Microsoft, arXiv 2404.16130, MIT) — hierarchical communities with a report per community, read
  at a chosen level for "global" questions and drilled into for local ones. Here: talking to a topic gives the agent that
  topic's summary, its parts' summaries, and the passages of the conversations under it that match what you ask
  (`context`), the way global search reads community reports and local search reads the text units.
* MemTree (Rezazadeh et al., ICLR 2025, arXiv 2410.14052) — new information is inserted online: it descends from the
  root, at each level into the child it fits, and opens a new child where none fits; the ancestors on the way are
  re-summarised. Here (`place`): a conversation of an already placed line goes where its line went (no model); the rest
  are routed by a model reading the topic paths, which may open a new topic; the ancestors are marked stale and their
  summaries rewritten in batches (`refresh`). MemTree routes with embeddings; PGA has none, so a model call does it.

Leaves stand for timeline items (`ref` = the item key: a chat key, `c:<imported conversation>`, `n:<thought node>`) and
motivations (`aim:<id>`, holding their thought-tree conversations). Nothing private is sent to a model: knowledge marked
private is not part of this tree, and conversations are read only as titles and short excerpts.
"""
from __future__ import annotations

import logging
import re
import uuid
from datetime import datetime, timezone
from typing import TYPE_CHECKING, Any

from sqlalchemy import select

from pga.agent.common import UNTRUSTED_NOTE, ModelOutputError, fence, parse_json
from pga.allocator import Estimates, Justification, RunRequest
from pga.db.models import Aim, User, WorldNode
from pga.db.types import utcnow

if TYPE_CHECKING:
    from pga.runtime import Runtime

log = logging.getLogger(__name__)

EPOCH = datetime(2000, 1, 1, tzinfo=timezone.utc)
BATCH = 70                     # conversations per assignment call


class WorldTreeDeferred(RuntimeError):
    """No budget or no model right now: try again later."""


def _clean(t: str, n: int = 160) -> str:
    return re.sub(r"\s+", " ", (t or "")).strip()[:n]


class WorldTree:
    def __init__(self, rt: "Runtime"):
        self.rt, self.s = rt, rt.session

    # -------------------------------------------------------------- the nodes
    def nodes(self, user_id: uuid.UUID) -> list[WorldNode]:
        return list(self.s.scalars(select(WorldNode).where(WorldNode.user_id == user_id).order_by(WorldNode.depth, WorldNode.position, WorldNode.created_at)))

    def root(self, user: User, create: bool = True) -> WorldNode | None:
        r = self.s.scalar(select(WorldNode).where(WorldNode.user_id == user.id, WorldNode.kind == "root"))
        if r is None and create:
            r = WorldNode(user_id=user.id, depth=0, kind="root", title="世界", summary="", data={})
            self.s.add(r)
            self.s.flush()
        return r

    def built(self, user: User) -> bool:
        r = self.root(user, create=False)
        return bool(r and (r.data or {}).get("built_at"))

    def get(self, user: User, nid: uuid.UUID) -> WorldNode | None:
        n = self.s.get(WorldNode, nid)
        return n if n is not None and n.user_id == user.id else None

    def path(self, n: WorldNode) -> list[WorldNode]:
        out = [n]
        while out[-1].parent_id:
            p = self.s.get(WorldNode, out[-1].parent_id)
            if p is None:
                break
            out.append(p)
        return list(reversed(out))

    def children(self, n: WorldNode) -> list[WorldNode]:
        return list(self.s.scalars(select(WorldNode).where(WorldNode.parent_id == n.id).order_by(WorldNode.position, WorldNode.created_at)))

    def leaves_under(self, n: WorldNode, limit: int = 400) -> list[WorldNode]:
        out, todo = [], [n]
        while todo and len(out) < limit:
            x = todo.pop()
            for c in self.children(x):
                if c.kind == "leaf":
                    out.append(c)
                else:
                    if c.kind == "aim":
                        out.append(c)
                    todo.append(c)
        return out

    def _add(self, user: User, parent: WorldNode, kind: str, title: str, *, ref: str | None = None, data: dict | None = None,
             summary: str = "") -> WorldNode:
        n = WorldNode(user_id=user.id, parent_id=parent.id, depth=parent.depth + 1, kind=kind, title=_clean(title, 200) or "…",
                      summary=summary, ref=ref, data=data or {}, position=len(self.children(parent)), updated_at=utcnow())
        self.s.add(n)
        self.s.flush()
        return n

    def _stale(self, n: WorldNode | None) -> None:
        while n is not None:
            n.data = {**(n.data or {}), "stale": True}
            n = self.s.get(WorldNode, n.parent_id) if n.parent_id else None

    # -------------------------------------------------------------- what is to be placed: the timeline's items, and motivations
    def items(self, user: User) -> list[dict]:
        from pga.timeline import Timeline, _prefs
        tl = Timeline(self.rt)
        its = tl.items(user, EPOCH)
        lines = tl.lines_of(user, its)
        titles = {k: v.get("title") for k, v in (_prefs(user).get("lines") or {}).items()}
        aims = {f"aim:{a.id}": a.text for a in self.s.scalars(select(Aim).where(Aim.user_id == user.id))}
        out = []
        for it in its:
            lid = lines.get(it.key, it.line)
            out.append({"key": it.key, "kind": it.kind, "title": _clean(it.title, 120), "agent": it.agent, "project": it.project,
                        "excerpt": _clean(it.excerpt, 400), "line": lid,
                        "line_title": titles.get(lid) or aims.get(lid) or (lid[5:] if lid.startswith("proj:") else ""),
                        "first": min(it.times).isoformat() if it.times else None, "last": max(it.times).isoformat() if it.times else None,
                        "turns": sum(it.turns) if it.turns else len(it.times), "ref": it.ref})
        for a in self.s.scalars(select(Aim).where(Aim.user_id == user.id)):
            out.append({"key": f"aim:{a.id}", "kind": "aim", "title": _clean(a.text, 160), "agent": "", "project": "", "excerpt": "",
                        "line": f"aim:{a.id}", "line_title": a.text, "first": a.created_at.isoformat(), "last": None, "turns": 0,
                        "ref": {"tree": str(a.id)}})
        return out

    # -------------------------------------------------------------- a model call
    def _ask(self, user: User, system: str, prompt: str, why: str, max_tokens: int = 3000, now: datetime | None = None) -> dict:
        now = now or utcnow()
        decision = self.rt.allocator.allocate(RunRequest(
            user_id=user.id, kind="synthesis",
            justification=Justification(
                why_now=why, expected_gain="your conversations sit in one tree of topics, each summarised",
                decision_affected="which topic you or an agent take up, and what context it reads",
                budget={"max_units": 80_000, "max_output_tokens": max_tokens}, stop_condition="this step of the world tree is written"),
            estimates=Estimates(information_gain=.4, decision_impact=.4, user_relevance=.8, reuse_value=.8,
                                input_tokens=len(prompt) // 3, output_tokens=max_tokens // 2)), now=now)
        if not decision.allowed:
            raise WorldTreeDeferred("; ".join(decision.reasons))
        try:
            with self.rt.runs.track(decision, now) as guard:
                res = self.rt.router.complete(decision.tier, system=system + " " + UNTRUSTED_NOTE,
                                              messages=[{"role": "user", "content": prompt}], max_tokens=max_tokens, usage=guard.usage_context())
                try:
                    d = parse_json(res.text)
                except ModelOutputError:
                    guard.stop("world tree reply was not JSON")
                    return {}
                guard.stop("world tree step written")
        except WorldTreeDeferred:
            raise
        except Exception as exc:  # noqa: BLE001
            log.warning("world tree: model call failed: %s", exc)
            raise WorldTreeDeferred(f"the model could not be reached: {exc}"[:300]) from exc
        return d if isinstance(d, dict) else {}

    # -------------------------------------------------------------- the first build (RAPTOR / GraphRAG: group, then summarise up)
    def _paths(self, user: User) -> dict[str, WorldNode]:
        """Topic nodes by a path code: 1, 1.2, 1.2.3 (the order they are shown in)."""
        out: dict[str, WorldNode] = {}
        r = self.root(user)

        def walk(n: WorldNode, code: str) -> None:
            i = 0
            for c in self.children(n):
                if c.kind not in ("topic", "plan"):
                    continue
                i += 1
                cc = f"{code}.{i}" if code else str(i)
                out[cc] = c
                walk(c, cc)
        walk(r, "")
        return out

    def _path_list(self, paths: dict[str, WorldNode], summaries: bool = False) -> str:
        return "\n".join(f"{code} {'  ' * code.count('.')}{n.title}" + (f" — {_clean(n.summary, 90)}" if summaries and n.summary else "")
                         for code, n in paths.items())

    def build(self, user: User, now: datetime | None = None, progress=None) -> dict:
        """The whole tree from your conversations (again from scratch if it exists; your own moves are lost)."""
        now = now or utcnow()
        say = progress or (lambda *_: None)
        everything = self.items(user)
        items = [x for x in everything if x["kind"] == "aim" or not x["line"].startswith("aim:")]
        tree_items = [x for x in everything if x["kind"] != "aim" and x["line"].startswith("aim:")]
        if not items:
            return {"topics": 0, "placed": 0}
        say("taxonomy", 0, len(items))
        # 1. a taxonomy from the lines (with a few of their titles) and the conversations on no line
        by_line: dict[str, list[dict]] = {}
        loose = []
        for x in items:
            if x["line"] and not x["line"].startswith("c:") and x["line_title"] and x["kind"] != "aim":
                by_line.setdefault(x["line"], []).append(x)
            else:
                loose.append(x)
        rows = [f"- line «{_clean(v[0]['line_title'], 60)}» ({len(v)} conversations): " + " / ".join(_clean(y["title"], 40) for y in v[:4])
                for v in sorted(by_line.values(), key=len, reverse=True)]
        rows += [f"- {'motivation' if x['kind'] == 'aim' else 'conversation'}: {_clean(x['title'], 60)}" for x in loose[:400]]
        system = ("You organise one person's whole history of conversations with AI agents into a tree of topics, like a "
                  "library's subject tree. Top level: 4 to 8 broad activities in the person's own terms (e.g. 进行研究, "
                  "开发软件, 求职, 生活与杂事). Under each: topics (2 to 8), and under a topic, subtopics only where there are "
                  "clearly several distinct things. At most 3 levels. Titles are short (at most 10 Chinese characters or 6 "
                  "English words), in the language most of the conversations use. Greetings and tests go under one "
                  "'杂项' topic. Reply with JSON only: {\"tree\": [{\"title\": \"...\", \"children\": [{\"title\": \"...\", "
                  "\"children\": []}]}]}.")
        d = self._ask(user, system, fence("history", "\n".join(rows), 60000, kind="titles of the person's conversations and lines"),
                      f"you asked for the world tree: a taxonomy of {len(items)} conversations", 4000, now)
        tree = d.get("tree") if isinstance(d.get("tree"), list) else []
        if not tree:
            raise WorldTreeDeferred("the model did not give a taxonomy")
        # replace the old tree (leaves and topics) with the new one
        r = self.root(user)
        for c in self.children(r):
            self.s.delete(c)
        self.s.flush()

        def make(parent: WorldNode, kids: list, depth: int) -> None:
            for k in kids[:12]:
                if not isinstance(k, dict) or not str(k.get("title") or "").strip():
                    continue
                n = self._add(user, parent, "topic", str(k["title"]))
                if depth < 3 and isinstance(k.get("children"), list):
                    make(n, k["children"], depth + 1)
        make(r, tree, 1)
        # 2. each conversation (and motivation) to the deepest topic it fits
        paths = self._paths(user)
        placed = 0
        for b in range(0, len(items), BATCH):
            part = items[b:b + BATCH]
            say("assign", b, len(items))
            placed += self._assign(user, part, paths, now, allow_new=False)
        for x in tree_items:                                   # a motivation's own conversations go under it, no model needed
            placed += self._put_under_aim(user, x)
        # 3. empty topics go; summaries from the bottom up
        self._prune(user)
        say("summaries", 0, 0)
        self.refresh(user, now, limit=10_000)
        r = self.root(user)
        r.data = {**(r.data or {}), "built_at": now.isoformat(), "stale": False}
        self.s.flush()
        return {"topics": len(self._paths(user)), "placed": placed}

    def _leaf_data(self, x: dict) -> dict:
        return {"type": x["kind"], "agent": x["agent"], "project": x["project"], "excerpt": x["excerpt"], "line": x["line"],
                "first": x["first"], "last": x["last"], "turns": x["turns"], "open": x["ref"],
                "who": "agent" if x["kind"] == "tree" else "me"}       # a motivation's own thinking vs a conversation you were in

    def _put(self, user: User, parent: WorldNode, x: dict) -> WorldNode:
        n = self.s.scalar(select(WorldNode).where(WorldNode.user_id == user.id, WorldNode.ref == x["key"]))
        kind = "aim" if x["kind"] == "aim" else "leaf"
        if n is None:
            n = self._add(user, parent, kind, x["title"], ref=x["key"], data={**self._leaf_data(x), **({"gist": x["gist"]} if x.get("gist") else {})})
        else:
            n.parent_id, n.depth, n.title, n.data, n.updated_at = parent.id, parent.depth + 1, _clean(x["title"], 200) or n.title, {**(n.data or {}), **self._leaf_data(x)}, utcnow()
        self._stale(parent)
        return n

    def _put_under_aim(self, user: User, x: dict) -> int:
        a = self.s.scalar(select(WorldNode).where(WorldNode.user_id == user.id, WorldNode.ref == x["line"]))
        if a is None:
            return 0
        self._put(user, a, x)
        return 1

    def _assign(self, user: User, part: list[dict], paths: dict[str, WorldNode], now: datetime, allow_new: bool = True) -> int:
        names = {f"i{i}": x for i, x in enumerate(part)}
        rows = "\n".join(f"i{i} | {(x['first'] or '')[:10]} | {x['kind']} | {_clean(x['line_title'], 40) or '-'} | {_clean(x['title'], 80)} | {_clean(x['excerpt'], 140)}"
                         for i, x in enumerate(part))
        system = ("You place a person's conversations into their tree of topics. For each item, give the code of the deepest "
                  "topic it clearly belongs to (a broader topic when unsure), and a gist: one short line (at most 25 Chinese "
                  "characters or 15 English words, the conversation's language) saying what the conversation is about and "
                  "where it got to. "
                  + ("If a group of items clearly needs a topic that does not exist, open one under the closest topic: "
                     "\"new\": [{\"under\": \"<code>\", \"title\": \"...\", \"items\": [\"i3\"]}] (short title, the conversations' language). "
                     if allow_new else "")
                  + "Reply with JSON only: {\"assign\": {\"i0\": \"1.2\", \"i1\": \"3\"}, \"gist\": {\"i0\": \"...\", \"i1\": \"...\"}" + (", \"new\": []" if allow_new else "") + "}.")
        prompt = "Topics:\n" + self._path_list(paths, summaries=allow_new) + "\n\n" + fence(
            "conversations", "item | date | kind | line | title | excerpt\n" + rows, 40000, kind="titles and excerpts of the person's conversations")
        d = self._ask(user, system, prompt, f"placing {len(part)} conversations in the world tree", 2500, now)
        placed = 0
        gists = d.get("gist") if isinstance(d.get("gist"), dict) else {}
        for k, x in names.items():
            if isinstance(gists.get(k), str) and gists[k].strip():
                x["gist"] = _clean(gists[k], 80)
        for g in (d.get("new") or []) if allow_new else []:
            under = paths.get(str(g.get("under") or ""))
            if under is None or not str(g.get("title") or "").strip():
                continue
            t = self._add(user, under, "topic", str(g["title"]))
            for k in g.get("items") or []:
                if k in names:
                    self._put(user, t, names.pop(k))
                    placed += 1
        assign = d.get("assign") if isinstance(d.get("assign"), dict) else {}
        r = self.root(user)
        for k, x in names.items():
            target = paths.get(str(assign.get(k) or "")) or self._misc(user, r)
            self._put(user, target, x)
            placed += 1
        return placed

    def _misc(self, user: User, r: WorldNode) -> WorldNode:
        for c in self.children(r):
            if c.kind == "topic" and c.title in ("杂项", "其他", "Misc", "Other"):
                return c
        return self._add(user, r, "topic", "杂项")

    def _prune(self, user: User) -> None:
        changed = True
        while changed:
            changed = False
            for n in self.nodes(user.id):
                if n.kind == "topic" and not self.children(n):
                    self.s.delete(n)
                    changed = True
            self.s.flush()

    # -------------------------------------------------------------- new conversations find their place (MemTree)
    def place(self, user: User, now: datetime | None = None, limit: int = 140) -> dict:
        """Conversations and motivations not in the tree yet go to their place; ones that changed refresh their leaf."""
        now = now or utcnow()
        if not self.built(user):
            return {"placed": 0, "why": "not built"}
        have = {n.ref: n for n in self.nodes(user.id) if n.ref}
        todo, quick = [], 0
        for x in self.items(user):
            n = have.get(x["key"])
            if n is not None:
                if (n.data or {}).get("last") != x["last"] or n.title != _clean(x["title"], 200):
                    n.title, n.data = _clean(x["title"], 200) or n.title, {**(n.data or {}), **self._leaf_data(x)}
                    self._stale(self.s.get(WorldNode, n.parent_id) if n.parent_id else None)
                continue
            if x["kind"] != "aim" and x["line"].startswith("aim:") and self._put_under_aim(user, x):
                quick += 1
                continue
            sib = [have[k] for k in (y for y in have if y) if (have[k].data or {}).get("line") == x["line"] and x["line"] and not x["line"].startswith("c:")]
            if len(sib) >= 2:                                # its line already has a place: it goes there too
                parents = {}
                for s_ in sib:
                    parents[s_.parent_id] = parents.get(s_.parent_id, 0) + 1
                pid = max(parents, key=parents.get)
                p = self.s.get(WorldNode, pid) if pid else None
                if p is not None:
                    have[x["key"]] = self._put(user, p, x)
                    quick += 1
                    continue
            todo.append(x)
        placed = 0
        for b in range(0, min(len(todo), limit), BATCH):
            placed += self._assign(user, todo[b:b + BATCH], self._paths(user), now, allow_new=True)
        self.s.flush()
        noted = self.annotate(user, now, limit=60)
        return {"placed": placed + quick, "by_line": quick, "left": max(0, len(todo) - limit), "annotated": noted}

    def annotate(self, user: User, now: datetime | None = None, limit: int = 60) -> int:
        """标注: a one-line gist on each conversation that has none (what it is about, where it got to)."""
        now = now or utcnow()
        ls = [n for n in self.nodes(user.id) if n.kind == "leaf" and not (n.data or {}).get("gist") and not (n.data or {}).get("hidden")]
        ls.sort(key=lambda n: (n.data or {}).get("last") or "", reverse=True)
        done = 0
        for b in range(0, min(len(ls), limit), BATCH):
            part = ls[b:b + BATCH]
            rows = "\n".join(f"i{i} | {_clean(n.title, 80)} | {_clean((n.data or {}).get('excerpt', ''), 200)}" for i, n in enumerate(part))
            d = self._ask(user, "For each conversation write a gist: one short line (at most 25 Chinese characters or 15 English words, "
                                "the conversation's language) on what it is about and where it got to. Reply with JSON only: {\"i0\": \"...\"}.",
                          fence("conversations", "item | title | excerpt\n" + rows, 30000, kind="titles and excerpts of the person's conversations"),
                          f"writing the gist of {len(part)} conversations", 2000, now)
            for i, n in enumerate(part):
                g = d.get(f"i{i}")
                if isinstance(g, str) and g.strip():
                    n.data = {**(n.data or {}), "gist": _clean(g, 80)}
                    done += 1
            self.s.flush()
        return done

    # -------------------------------------------------------------- your hands on it (增删改查)
    def add_topic(self, user: User, parent: WorldNode, title: str, summary: str = "") -> WorldNode:
        n = self._add(user, parent, "topic", title, summary=summary.strip()[:1200], data={"manual": True, **({"manual_summary": True} if summary.strip() else {})})
        self._stale(parent)
        return n

    def remove(self, user: User, n: WorldNode) -> dict:
        """A topic goes, its parts move up to its parent; a conversation leaves the tree (it stays in 所有对话)."""
        if n.kind == "root":
            raise ValueError("the root stays")
        parent = self.s.get(WorldNode, n.parent_id) if n.parent_id else self.root(user)
        if n.kind == "leaf":
            n.data = {**(n.data or {}), "hidden": True}
            self._stale(parent)
            self.s.flush()
            return {"hidden": str(n.id)}
        kids = self.children(n)
        for c in kids:
            self.move(user, c, parent)
        self.s.delete(n)
        self._stale(parent)
        self.s.flush()
        return {"removed": str(n.id), "moved_up": len(kids)}

    def edit(self, user: User, n: WorldNode, *, title: str | None = None, summary: str | None = None, gist: str | None = None) -> WorldNode:
        if title and title.strip():
            n.title = title.strip()[:200]
        if summary is not None:                              # your own words: summaries written later leave it alone
            n.summary = summary.strip()[:2000]
            n.data = {**(n.data or {}), "manual_summary": bool(summary.strip())}
        if gist is not None:
            n.data = {**(n.data or {}), "gist": gist.strip()[:120], "manual_gist": True}
        n.updated_at = utcnow()
        self.s.flush()
        return n

    def search(self, user: User, q: str, k: int = 30) -> list[WorldNode]:
        from pga.kg.search import bm25
        ns = {str(n.id): n for n in self.nodes(user.id) if not (n.data or {}).get("hidden")}
        ids = bm25({i: f"{n.title} {n.summary} {(n.data or {}).get('gist', '')}" for i, n in ns.items()}, q, k=k)
        return [ns[i] for i in ids]

    # -------------------------------------------------------------- summaries, deepest first (RAPTOR)
    def refresh(self, user: User, now: datetime | None = None, limit: int = 40) -> dict:
        now = now or utcnow()
        topics = [n for n in self.nodes(user.id) if n.kind in ("topic", "root") and ((n.data or {}).get("stale") or not n.summary)
                  and not (n.data or {}).get("manual_summary")]
        topics.sort(key=lambda n: -n.depth)
        done = 0
        while topics and done < limit:
            depth = topics[0].depth
            level = [n for n in topics if n.depth == depth][:12]
            blocks = []
            for i, n in enumerate(level):
                kids = self.children(n)
                lines = [f"  - {'topic' if k.kind in ('topic', 'plan') else 'motivation' if k.kind == 'aim' else 'conversation'}: {_clean(k.title, 70)}"
                         + (f" — {_clean(k.summary, 160)}" if k.summary else f" — {_clean((k.data or {}).get('excerpt', ''), 120)}" if (k.data or {}).get("excerpt") else "")
                         for k in kids[:40]]
                more = f"  … and {len(kids) - 40} more" if len(kids) > 40 else ""
                facts = self._facts_lines(n)
                blocks.append(f"t{i}: «{n.title}» ({len(kids)} parts)\n" + "\n".join(lines) + ("\n" + more if more else "") + (("\n" + facts) if facts else ""))
            system = ("You write the summary of each topic in a person's tree of conversations, from what is under it: what "
                      "the person has been doing and asking about there, what came out of it, what is still open. 1 to 3 "
                      "sentences each, concrete (names, decisions), in the language of the conversations. Where facts are "
                      "given, say what holds NOW; a fact marked 'no longer holds' is history — mention it only as a change "
                      "(\"switched from X to Y\"), never as current. Reply with JSON only: {\"t0\": \"...\", \"t1\": \"...\"}.")
            d = self._ask(user, system, fence("topics", "\n\n".join(blocks), 50000, kind="topics with their parts"),
                          f"summarising {len(level)} topics of the world tree", 2500, now)
            for i, n in enumerate(level):
                s = d.get(f"t{i}")
                if isinstance(s, str) and s.strip():
                    n.summary = s.strip()[:1200]
                n.data = {**(n.data or {}), "stale": False, "count": len(self.leaves_under(n)), "summarised_at": now.isoformat()}
                n.updated_at = now
                done += 1
            ids = {n.id for n in level}
            topics = [n for n in topics if n.id not in ids]
            self.s.flush()
        return {"summarised": done, "left": len(topics)}

    def _facts_lines(self, n: WorldNode) -> str:
        try:
            from pga.kg.service import FactGraph
            fg = FactGraph(self.rt)
            cur, old = fg.topic_facts(self.s.get(User, n.user_id), self.refs_under(n), 8, 4)
        except Exception:  # noqa: BLE001 - facts are a help, not a requirement
            return ""
        if not cur and not old:
            return ""
        return "  facts: " + " | ".join(fg.describe(e, with_replacement=False) for e in cur + old)

    # -------------------------------------------------------------- talking to a topic (GraphRAG: its report, its parts, the matching text)
    def context(self, n: WorldNode, question: str = "") -> str:
        """What an agent reads when you talk to this topic: where it sits, its summary, its parts, and the conversations
        under it that match what you ask."""
        path = self.path(n)
        kids = self.children(n)
        head = " › ".join(x.title for x in path)
        parts = "\n".join(f"- {k.title}" + (f": {_clean(k.summary, 300)}" if k.summary else
                                            f" ({(k.data or {}).get('agent') or ''} {((k.data or {}).get('last') or '')[:10]}): {_clean((k.data or {}).get('excerpt', ''), 160)}")
                          for k in kids[:40])
        out = (f"<world_tree_topic path=\"{head}\">\nYou are talking with the person about this whole topic of their life and work, "
               f"not one conversation. What it holds, summarised from everything under it:\n{n.summary or '(not summarised yet)'}\n\n"
               f"Its parts:\n{parts or '(none)'}\n</world_tree_topic>")
        facts = self.facts_block(n)
        rel = self.related(n, question) if question else ""
        return out + ("\n\n" + facts if facts else "") + ("\n\n" + rel if rel else "")

    def refs_under(self, n: WorldNode) -> list[str]:
        return [x.ref for x in self.leaves_under(n) if x.ref]

    def facts_block(self, n: WorldNode, current: int = 15, past: int = 6) -> str:
        """The fact graph under this topic: what holds now (newest first), and what was true before but no longer is."""
        from pga.kg.service import FactGraph
        user = self.s.get(User, n.user_id)
        fg = FactGraph(self.rt)
        cur, old = fg.topic_facts(user, self.refs_under(n), current, past)
        if not cur and not old:
            return ""
        return ("<facts_under_this_topic note=\"from the person's conversations; each with when it started to hold\">\n"
                + "\n".join(f"- {fg.describe(e)}" for e in cur)
                + ("\nNo longer true (superseded — do not treat as current):\n" + "\n".join(f"- {fg.describe(e)}" for e in old) if old else "")
                + "\n</facts_under_this_topic>")

    def related(self, n: WorldNode, question: str, k: int = 6) -> str:
        from pga.kg.service import FactGraph
        from pga.knowledge.uploads import _grams
        facts = FactGraph(self.rt).search(self.s.get(User, n.user_id), question, refs=self.refs_under(n), k=8) if question else []
        fact_block = ("<facts_matching_the_question>\n" + "\n".join(f"- {FactGraph(self.rt).describe(e)}" for e in facts)
                      + "\n</facts_matching_the_question>") if facts else ""
        leaves = [x for x in self.leaves_under(n) if x.kind == "leaf"]
        q = set(_grams(question))
        if not leaves or not q:
            return fact_block
        scored = []
        for x in leaves:
            text = f"{x.title} {(x.data or {}).get('excerpt', '')}"
            g = _grams(text)
            s = sum(1 for t in g if t in q) / (1 + len(g) ** 0.5)
            if s > 0:
                scored.append((s, x))
        scored.sort(key=lambda z: -z[0])
        self.last_related = [x for _, x in scored[:k]]             # for the data tree: which conversations went in (pga.segments)
        if not scored:
            return fact_block
        body = "\n".join(f"- «{x.title}» ({((x.data or {}).get('last') or '')[:10]}, {(x.data or {}).get('agent') or ''}): {_clean((x.data or {}).get('excerpt', ''), 400)}"
                         for _, x in scored[:k])
        return ((fact_block + "\n\n") if fact_block else "") + "<conversations_under_this_topic note=\"the ones closest to what is asked\">\n" + body + "\n</conversations_under_this_topic>"

    def leaf_of(self, user: User, ref: str) -> WorldNode | None:
        return self.s.scalar(select(WorldNode).where(WorldNode.user_id == user.id, WorldNode.ref == ref))

    # -------------------------------------------------------------- your hands on it
    def move(self, user: User, n: WorldNode, parent: WorldNode) -> WorldNode:
        if any(x.id == n.id for x in self.path(parent)):
            raise ValueError("a topic cannot go under itself")
        old = self.s.get(WorldNode, n.parent_id) if n.parent_id else None
        n.parent_id, n.updated_at = parent.id, utcnow()
        def redepth(x: WorldNode, d: int) -> None:
            x.depth = d
            for c in self.children(x):
                redepth(c, d + 1)
        redepth(n, parent.depth + 1)
        self._stale(old)
        self._stale(parent)
        self.s.flush()
        return n

    def expand(self, user: User, n: WorldNode, now: datetime | None = None) -> list[WorldNode]:
        """Grow this topic downwards: a few directions worth taking next, as planned subtopics (for you, or a motivation
        that works through them layer by layer)."""
        now = now or utcnow()
        have = "\n".join(f"- {k.title}" for k in self.children(n) if k.kind in ("topic", "plan"))
        system = ("You suggest how a topic of a person's work should grow next: 3 to 5 concrete directions (subtopics or "
                  "questions) that build on what is there and are not already covered. Short titles in the topic's language, "
                  "each with one sentence on why. Reply with JSON only: {\"next\": [{\"title\": \"...\", \"why\": \"...\"}]}.")
        prompt = f"Topic: {' › '.join(x.title for x in self.path(n))}\nSummary: {n.summary}\nAlready under it:\n{have or '(nothing)'}"
        d = self._ask(user, system, prompt, f"growing the topic «{n.title}» one level down", 1200, now)
        made = []
        for x in (d.get("next") or [])[:6]:
            if isinstance(x, dict) and str(x.get("title") or "").strip():
                made.append(self._add(user, n, "plan", str(x["title"]), summary=_clean(str(x.get("why") or ""), 400), data={"plan": True, "at": now.isoformat()}))
        return made

    def out(self, user: User) -> dict:
        ns = self.nodes(user.id)
        r = self.root(user, create=False)
        return {"built": bool(r and (r.data or {}).get("built_at")), "built_at": (r.data or {}).get("built_at") if r else None,
                "nodes": [{"id": str(n.id), "parent": str(n.parent_id) if n.parent_id else None, "depth": n.depth, "kind": n.kind,
                           "title": n.title, "summary": n.summary, "ref": n.ref, "stale": bool((n.data or {}).get("stale")),
                           "count": (n.data or {}).get("count"), "agent": (n.data or {}).get("agent"), "last": (n.data or {}).get("last"),
                           "turns": (n.data or {}).get("turns"), "open": (n.data or {}).get("open"), "type": (n.data or {}).get("type"),
                           "excerpt": _clean((n.data or {}).get("excerpt", ""), 200) if n.kind == "leaf" else None,
                           "gist": (n.data or {}).get("gist"), "who": (n.data or {}).get("who") or ("agent" if (n.data or {}).get("type") == "tree" else "me"),
                           "hidden": bool((n.data or {}).get("hidden")), "manual": bool((n.data or {}).get("manual") or (n.data or {}).get("manual_summary"))}
                          for n in ns]}


def chat_node(user: User, key: str) -> str | None:
    """The topic a conversation is talking to (you chose a level above it), if any."""
    return ((user.preferences or {}).get("chat_world") or {}).get(key)


def set_chat_node(user: User, key: str, node_id: str | None) -> None:
    cw = dict((user.preferences or {}).get("chat_world") or {})
    if node_id:
        cw[key] = node_id
    else:
        cw.pop(key, None)
    user.preferences = {**(user.preferences or {}), "chat_world": dict(list(cw.items())[-2000:])}
