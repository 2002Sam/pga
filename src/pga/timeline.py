"""时间树 (the time tree): every conversation you had, on one time axis.

Each point is a *session*: a stretch of talk in one conversation (turns less than two hours apart), placed at its time.
Sessions belong to *lines*. A line is one piece of ongoing work: an everyday chat, a conversation imported from another
app, a motivation's thought tree, or a project folder the imported sessions were held in. When a line comes back after
a pause (you pick up a project three days later), the time tree draws a path from its last session to the new one.

Where a session goes is decided in three steps, each overriding the one before:
  1. rules — a branch of a thought tree belongs to that tree; an imported session held in a project folder belongs to
     the motivation that works in that folder, or else to the folder's own line;
  2. tidying (`organize`) — a model (or, without one, matching titles) reads the loose conversations and says which
     ones continue an existing line, and which ones together form a new topic line;
  3. you — a session moved to another line by hand stays there.
What tidying and you decide is kept in the user's preferences under "timeline"; nothing is deleted or rewritten.
"""
from __future__ import annotations

import logging
import re
import uuid
from dataclasses import dataclass, field
from datetime import datetime, timedelta
from typing import TYPE_CHECKING

from sqlalchemy import select

from pga.agent.common import UNTRUSTED_NOTE, ModelOutputError, fence, parse_json
from pga.allocator import Estimates, Justification, RunRequest
from pga.db.models import AgentConversation, AgentRun, Aim, LinkedAgent, Project, ThoughtNode, User
from pga.db.types import utcnow

if TYPE_CHECKING:
    from pga.runtime import Runtime

log = logging.getLogger(__name__)

GAP = timedelta(hours=2)                       # turns closer than this are one session
NOISE = {"", "new project", "desktop", "downloads", "documents", "home", "x", "tmp", "temp", "untitled", "~"}


class TimelineDeferred(RuntimeError):
    """No budget or no model right now: tidy later."""


@dataclass
class Item:
    key: str
    kind: str                                  # chat | import | tree
    title: str
    agent: str = ""
    project: str = ""
    excerpt: str = ""
    line: str = ""                             # by rule
    ref: dict = field(default_factory=dict)
    runs: list[str] = field(default_factory=list)
    times: list[datetime] = field(default_factory=list)
    turns: list[int] = field(default_factory=list)


def _prefs(user: User) -> dict:
    return dict((user.preferences or {}).get("timeline") or {})


def _save(user: User, tl: dict) -> None:
    user.preferences = {**(user.preferences or {}), "timeline": tl}


def _norm(p: str | None) -> str:
    return re.sub(r"\s+", " ", (p or "").strip().lower())


def _sessions(times: list[datetime]) -> list[tuple[datetime, datetime, int]]:
    out: list[list] = []
    for t in sorted(times):
        if out and t - out[-1][1] <= GAP:
            out[-1][1], out[-1][2] = t, out[-1][2] + 1
        else:
            out.append([t, t, 1])
    return [tuple(x) for x in out]


class Timeline:
    def __init__(self, rt: "Runtime"):
        self.rt, self.s = rt, rt.session

    # -------------------------------------------------------------- what happened
    def items(self, user: User, since: datetime) -> list[Item]:
        archived = set((user.preferences or {}).get("archived_chats") or [])
        items: dict[str, Item] = {}
        aims = {a.id: a for a in self.s.scalars(select(Aim).where(Aim.user_id == user.id))}
        nodes: dict[str, ThoughtNode | None] = {}
        for r in self.s.scalars(select(AgentRun).where(AgentRun.user_id == user.id, AgentRun.parent_id.is_(None),
                                                       AgentRun.workflow == "ask", AgentRun.started_at >= since)
                                .order_by(AgentRun.started_at)):
            d = r.data or {}
            conv = str(d.get("conversation") or "")
            nid = d.get("node") or (conv[5:] if conv.startswith("node:") else None)
            if conv.startswith("exchange:"):
                continue
            if nid:                                                 # a branch of a thought tree
                if nid not in nodes:
                    try:
                        nodes[nid] = self.s.get(ThoughtNode, uuid.UUID(str(nid)))
                    except ValueError:
                        nodes[nid] = None
                n = nodes[nid]
                if n is None:
                    continue
                key = f"n:{n.id}"
                it = items.get(key)
                if it is None:
                    aim = aims.get(n.aim_id) if n.aim_id else None
                    it = items[key] = Item(key, "tree", n.title, line=f"aim:{n.aim_id}" if n.aim_id else "you",
                                           ref={"tree": str(n.aim_id) if n.aim_id else "you", "node": str(n.id),
                                                "tree_title": (aim.text if aim else "")})
            else:                                                   # an everyday chat
                key = conv or f"run:{r.id}"
                if key in archived:
                    continue
                it = items.get(key)
                if it is None:
                    it = items[key] = Item(key, "chat", " ".join((r.prompt or "").split())[:80], agent=str(d.get("agent") or r.agent or ""),
                                           line=key, ref={"chat": key})
            it.times.append(r.started_at)
            it.runs.append(str(r.id))
        folders = {}
        for p in self.s.scalars(select(Project).where(Project.user_id == user.id)):
            if p.aim_id:
                folders[_norm(p.name)] = f"aim:{p.aim_id}"
                folders[_norm(p.path.rstrip("/").rsplit("/", 1)[-1])] = f"aim:{p.aim_id}"
        q = (select(AgentConversation, LinkedAgent).join(LinkedAgent, AgentConversation.linked_agent_id == LinkedAgent.id)
             .where(LinkedAgent.user_id == user.id))
        for c, a in self.s.execute(q):
            start = c.started_at or c.updated_at or c.created_at
            end = c.updated_at or start
            if end < since:
                continue
            key = f"c:{c.id}"
            if key in archived:
                continue
            proj = _norm(c.project)
            line = folders.get(proj) or (f"proj:{proj}" if proj not in NOISE else key)
            title = re.sub(r"^\[[^\]]*\]\s*", "", c.title or "") or (c.excerpt or "")[:60]
            it = items[key] = Item(key, "import", title[:120], agent=a.name, project=c.project or "", excerpt=(c.excerpt or "")[:400],
                                   line=line, ref={"conversation": str(c.id), "messages": c.message_count})
            it.times = [start] + ([end] if end - start > GAP else [])
            it.turns = [c.message_count] if len(it.times) == 1 else [max(1, c.message_count // 2), c.message_count - max(1, c.message_count // 2)]
        return list(items.values())

    def lines_of(self, user: User, items: list[Item]) -> dict[str, str]:
        """item key → line: rules, then what tidying decided, then what you decided."""
        tl = _prefs(user)
        out = {it.key: it.line for it in items}
        for src in ("auto", "items"):                               # tidying, then you
            for k, v in (tl.get(src) or {}).items():
                if k in out and v:
                    out[k] = v
        return out

    def build(self, user: User, days: int = 90, now: datetime | None = None) -> dict:
        now = now or utcnow()
        items = self.items(user, now - timedelta(days=days))
        lines = self.lines_of(user, items)
        tl = _prefs(user)
        titles = {k: v.get("title") for k, v in (tl.get("lines") or {}).items()}
        aims = {str(a.id): a.text for a in self.s.scalars(select(Aim).where(Aim.user_id == user.id))}
        by_line: dict[str, list[Item]] = {}
        for it in items:
            by_line.setdefault(lines[it.key], []).append(it)
        meta = {}
        for lid, its in by_line.items():
            kind = lid.split(":", 1)[0]
            title = (titles.get(lid) or (aims.get(lid[4:], "") if kind == "aim" else "") or ("你的对话树" if lid == "you" else "")
                     or (lid[5:] if kind == "proj" else "") or min(its, key=lambda x: min(x.times)).title)
            k2 = {"aim": "tree", "you": "tree", "proj": "project", "topic": "topic"}.get(kind, "single")
            if k2 == "project" and len(its) == 1:                    # a folder used once is not yet a line of work
                k2 = "single"
            meta[lid] = {"id": lid, "title": title[:80], "kind": k2,
                         "items": len(its), **({"tree": lid[4:]} if kind == "aim" else {"tree": "you"} if lid == "you" else {})}
        sessions = []
        for it in items:
            spans = _sessions(it.times) if it.kind != "import" else [(t, t, n) for t, n in zip(it.times, it.turns or [1])]
            for i, (a, b, n) in enumerate(spans):
                sessions.append({"id": f"{it.key}#{i}", "item": it.key, "line": lines[it.key], "kind": it.kind, "title": it.title,
                                 "agent": it.agent, "project": it.project, "at": a.isoformat(), "end": b.isoformat(), "turns": n,
                                 "first": i == 0, "ref": it.ref})
        sessions.sort(key=lambda x: x["at"])
        hidden = [k for k in ((user.preferences or {}).get("archived_chats") or []) if str(k).startswith("c:")]
        return {"days": days, "lines": meta, "sessions": sessions, "organized_at": tl.get("organized_at"), "hidden": hidden,
                "pending": tl.get("pending", False)}

    # -------------------------------------------------------------- one line, whole: what it was about, and pulling it out
    def _you_index(self, user: User) -> dict[str, ThoughtNode]:
        """Your conversation tree, read backwards: which of its nodes holds a given chat run or imported conversation."""
        from pga.tree import ThoughtTree, YouRoot
        idx: dict[str, ThoughtNode] = {}
        for n in ThoughtTree(self.rt).nodes(YouRoot(user)):
            for x in n.note_ids or []:
                idx[str(x)] = n
        return idx

    def line_items(self, user: User, line: str, days: int = 730, now: datetime | None = None) -> list[Item]:
        items = self.items(user, (now or utcnow()) - timedelta(days=days))
        lines = self.lines_of(user, items)
        return sorted((it for it in items if lines[it.key] == line), key=lambda it: min(it.times))

    def line_detail(self, user: User, line: str, days: int = 730) -> dict:
        its = self.line_items(user, line, days)
        idx = self._you_index(user)
        tl = _prefs(user)
        meta = (tl.get("lines") or {}).get(line) or {}
        out = []
        for it in its:
            ids = [f"r:{r}" for r in it.runs] + ([f"c:{it.ref['conversation']}"] if it.ref.get("conversation") else [])
            n = next((idx[i] for i in ids if i in idx), None)
            out.append({"key": it.key, "kind": it.kind, "title": it.title, "agent": it.agent, "first": min(it.times).isoformat(),
                        "last": max(it.times).isoformat(), "turns": len(it.runs) or (it.ref.get("messages") or 0),
                        "summary": (n.summary if n is not None else "") or "", "node": str(n.id) if n is not None else None,
                        "node_title": n.title if n is not None else None, "ref": it.ref})
        built = self.build(user, days)
        return {"line": line, "title": (built["lines"].get(line) or {}).get("title") or meta.get("title") or (its[0].title if its else ""),
                "kind": (built["lines"].get(line) or {}).get("kind", "single"), "items": out, "summary": meta.get("summary") or "",
                "summarized_at": meta.get("summarized_at"), "extracted": meta.get("extracted"),
                "first": out[0]["first"] if out else None, "last": out[-1]["last"] if out else None}

    def summarize_line(self, user: User, line: str, now: datetime | None = None) -> str:
        """The whole line in a few readable lines (问 / 发现 / 定), from its conversations' summaries and openings."""
        from pga.tree import STYLE, _lang
        now = now or utcnow()
        d = self.line_detail(user, line)
        if not d["items"]:
            return ""
        lang, style = _lang(user)
        its = {it.key: it for it in self.line_items(user, line)}
        rows = "\n".join(f"- {x['first'][:10]} {x['title']}: " + (x["summary"] or re.sub(r"\s+", " ", its[x["key"]].excerpt)[:300])
                         for x in d["items"][-40:])
        system = ("Summarize one line of a person's work with AI agents: several conversations about one thing, over time. "
                  f"Write in {lang}, for the person, in this style: {STYLE[style]} Keep it under 120 words. "
                  "Say where it started, what was found or decided, and where it stands now. Plain text only. " + UNTRUSTED_NOTE)
        prompt = fence("conversations", f"Line: {d['title']}\n{rows}", 30000, kind="the person's conversations, oldest first")
        decision = self.rt.allocator.allocate(RunRequest(
            user_id=user.id, kind="synthesis",
            justification=Justification(why_now="you asked what this line of conversations was about",
                                        expected_gain="one readable summary instead of reading every conversation",
                                        decision_affected="whether you pick this line up again or pull it out as a tree",
                                        budget={"max_units": 20_000, "max_output_tokens": 600}, stop_condition="the summary is written"),
            estimates=Estimates(information_gain=.4, decision_impact=.4, user_relevance=.9, reuse_value=.6,
                                input_tokens=len(prompt) // 3, output_tokens=400)), now=now)
        if not decision.allowed:
            raise TimelineDeferred("; ".join(decision.reasons))
        try:
            with self.rt.runs.track(decision, now) as guard:
                res = self.rt.router.complete(decision.tier, system=system, messages=[{"role": "user", "content": prompt}],
                                              max_tokens=600, usage=guard.usage_context())
                guard.stop("line summarized")
        except Exception as exc:  # noqa: BLE001
            raise TimelineDeferred(f"the model could not be reached: {exc}"[:300]) from exc
        text = (res.text or "").strip()[:2000]
        tl = _prefs(user)
        lines = dict(tl.get("lines") or {})
        lines[line] = {**lines.get(line, {}), "summary": text, "summarized_at": now.isoformat()}
        tl["lines"] = lines
        _save(user, tl)
        return text

    def extract(self, user: User, line: str, aim: Aim) -> dict:
        """Pull a line out into a tree of its own: the motivation `aim` (made by the caller) gets one node per
        conversation, chained in time, each holding that conversation's turns; the line now draws as that tree."""
        its = self.line_items(user, line)
        idx = self._you_index(user)
        parent, seq, made = None, 0, []
        for it in its:
            ids = [f"r:{r}" for r in it.runs] + ([f"c:{it.ref['conversation']}"] if it.ref.get("conversation") else [])
            if not ids:
                continue
            src = next((idx[i] for i in ids if i in idx), None)
            seq += 1
            n = ThoughtNode(user_id=user.id, aim_id=aim.id, scope="aim", kind="segment", seq=seq, parent_id=parent.id if parent else None,
                            title=(it.title or "…")[:60], summary=(src.summary if src is not None else "") or "", note_ids=ids,
                            key_thoughts=list(src.key_thoughts or []) if src is not None else [],
                            first_at=min(it.times), last_at=max(it.times),
                            data={"turns": len(it.runs) or 1, "from_line": line, "tip": False}, created_at=utcnow())
            self.s.add(n)
            self.s.flush()
            made.append(n)
            parent = n
        if made:
            made[-1].data = {**made[-1].data, "tip": True}
        tl = _prefs(user)
        items = dict(tl.get("items") or {})
        for it in its:
            items[it.key] = f"aim:{aim.id}"
        lines = dict(tl.get("lines") or {})
        lines[line] = {**lines.get(line, {}), "extracted": str(aim.id)}
        tl.update(items=items, lines=lines)
        _save(user, tl)
        self.s.flush()
        return {"aim": str(aim.id), "nodes": len(made)}

    # -------------------------------------------------------------- you, by hand
    def move(self, user: User, key: str, line: str | None) -> None:
        tl = _prefs(user)
        items = dict(tl.get("items") or {})
        if line:
            items[key] = line[:120]
        else:
            items.pop(key, None)
        tl["items"] = items
        _save(user, tl)

    def rename(self, user: User, line: str, title: str) -> None:
        tl = _prefs(user)
        lines = dict(tl.get("lines") or {})
        lines[line] = {**lines.get(line, {}), "title": title.strip()[:80]}
        tl["lines"] = lines
        _save(user, tl)

    # -------------------------------------------------------------- tidying
    def loose(self, user: User, days: int = 120, now: datetime | None = None) -> tuple[list[Item], dict[str, str], dict]:
        """The conversations still on a line of their own, and the lines they could join."""
        now = now or utcnow()
        items = self.items(user, now - timedelta(days=days))
        lines = self.lines_of(user, items)
        tl = _prefs(user)
        decided = set((tl.get("items") or {}).keys()) | set((tl.get("auto") or {}).keys()) | set(tl.get("seen") or [])
        count: dict[str, int] = {}
        for it in items:
            count[lines[it.key]] = count.get(lines[it.key], 0) + 1
        loose = [it for it in items if it.kind != "tree" and it.key not in decided
                 and (lines[it.key] == it.key or (lines[it.key].startswith("proj:") and count[lines[it.key]] == 1))]
        built = self.build(user, days, now)
        targets = {lid: m for lid, m in built["lines"].items() if m["kind"] != "single"}
        for a in self.s.scalars(select(Aim).where(Aim.user_id == user.id)):     # every motivation can take a conversation
            targets.setdefault(f"aim:{a.id}", {"id": f"aim:{a.id}", "title": a.text[:80], "kind": "tree"})
        return loose, lines, targets

    def organize_rules(self, user: User, now: datetime | None = None) -> dict:
        """Without a model: conversations with the same (non-trivial) title become one topic line."""
        loose, _lines, _t = self.loose(user, now=now)
        groups: dict[str, list[Item]] = {}
        for it in loose:
            t = re.sub(r"[\s\W_]+", "", it.title.lower())[:24]
            if len(t) >= 6:
                groups.setdefault(t, []).append(it)
        tl = _prefs(user)
        auto, lines = dict(tl.get("auto") or {}), dict(tl.get("lines") or {})
        made = 0
        for t, its in groups.items():
            if len(its) < 2:
                continue
            lid = f"topic:{uuid.uuid4().hex[:8]}"
            lines[lid] = {"title": its[0].title[:60]}
            for it in its:
                auto[it.key] = lid
            made += 1
        tl.update(auto=auto, lines=lines, organized_at=(now or utcnow()).isoformat())
        _save(user, tl)
        return {"new_lines": made, "joined": sum(len(v) for v in groups.values() if len(v) >= 2)}

    def organize(self, user: User, now: datetime | None = None, batches: int = 4, size: int = 70) -> dict:
        """A model reads the loose conversations (title, date, a short excerpt) and the lines that exist, and says
        which conversation continues which line and which ones belong together under a new topic."""
        now = now or utcnow()
        loose, _lines, targets = self.loose(user, now=now)
        loose.sort(key=lambda it: min(it.times))
        joined = made = 0
        tl = _prefs(user)
        auto, lines, seen = dict(tl.get("auto") or {}), dict(tl.get("lines") or {}), list(tl.get("seen") or [])
        for b in range(batches):
            part = loose[b * size:(b + 1) * size]
            if not part:
                break
            d = self._ask(user, part, targets, now)
            names = {f"i{i}": it for i, it in enumerate(part)}
            for a in d.get("assign") or []:
                it, lid = names.get(str(a.get("item"))), str(a.get("line") or "")
                if it is not None and lid in targets:
                    auto[it.key] = lid
                    joined += 1
            for g in d.get("new") or []:
                its = [names[k] for k in (g.get("items") or []) if k in names]
                if len(its) < 2 or not str(g.get("title") or "").strip():
                    continue
                lid = f"topic:{uuid.uuid4().hex[:8]}"
                lines[lid] = {"title": str(g["title"]).strip()[:60]}
                targets[lid] = {"id": lid, "title": lines[lid]["title"], "kind": "topic"}
                for it in its:
                    auto[it.key] = lid
                made += 1
                joined += len(its)
            seen += [it.key for it in part]
        tl.update(auto=auto, lines=lines, seen=seen[-3000:], organized_at=now.isoformat(), pending=False)
        _save(user, tl)
        return {"looked_at": min(len(loose), batches * size), "joined": joined, "new_lines": made, "left": max(0, len(loose) - batches * size)}

    def _ask(self, user: User, part: list[Item], targets: dict, now: datetime) -> dict:
        lines = "\n".join(f"- {lid}: {m['title']}" for lid, m in list(targets.items())[:80]) or "(none yet)"
        rows = "\n".join(f"i{i} | {min(it.times):%Y-%m-%d} | {it.agent or it.kind} | {it.project or '-'} | {it.title} | "
                         + re.sub(r"\s+", " ", it.excerpt)[:160] for i, it in enumerate(part))
        system = ("You tidy a person's history of conversations with AI agents into lines of work. A line is one piece of "
                  "ongoing work or one topic: a motivation's thought tree, a project folder, or a topic. For each "
                  "conversation, decide: it clearly continues an existing line (same project, same task, same question "
                  "taken up again) → assign it; several conversations clearly share one topic not in the list → put "
                  "them under a new line with a short title (in the language of the conversations, at most 12 words); "
                  "otherwise leave it out. Greetings, tests and one-word chats stay out. Be conservative: a wrong join "
                  "is worse than none. Reply with JSON only: "
                  '{"assign": [{"item": "i3", "line": "<line id>"}], "new": [{"title": "...", "items": ["i4", "i9"]}]}. '
                  + UNTRUSTED_NOTE)
        prompt = f"Lines that exist:\n{lines}\n\n" + fence("conversations", "item | date | agent | folder | title | excerpt\n" + rows, 40000,
                                                           kind="titles and excerpts of the person's past conversations")
        decision = self.rt.allocator.allocate(RunRequest(
            user_id=user.id, kind="synthesis",
            justification=Justification(
                why_now=f"you asked to tidy {len(part)} conversations into the time tree",
                expected_gain="conversations that belong together are drawn on one line",
                decision_affected="which conversation you pick up and where it connects",
                budget={"max_units": 60_000, "max_output_tokens": 2000}, stop_condition="this batch is placed"),
            estimates=Estimates(information_gain=.4, decision_impact=.4, user_relevance=.8, reuse_value=.6,
                                input_tokens=len(prompt) // 3, output_tokens=1200)), now=now)
        if not decision.allowed:
            raise TimelineDeferred("; ".join(decision.reasons))
        try:
            with self.rt.runs.track(decision, now) as guard:
                res = self.rt.router.complete(decision.tier, system=system, messages=[{"role": "user", "content": prompt}],
                                              max_tokens=2000, usage=guard.usage_context())
                try:
                    d = parse_json(res.text)
                except ModelOutputError:
                    guard.stop("tidying reply was not JSON")
                    return {}
                guard.stop("time tree batch placed")
        except TimelineDeferred:
            raise
        except Exception as exc:  # noqa: BLE001 - try again later rather than join blindly
            log.warning("timeline organize failed: %s", exc)
            raise TimelineDeferred(f"the model could not be reached: {exc}"[:300]) from exc
        return d if isinstance(d, dict) else {}
