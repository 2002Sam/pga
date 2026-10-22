"""The finest level of the world tree: a conversation split into segments by what you were asking about. One matter is
one segment; a conversation that moved between several matters splits where you moved. The cut follows your own
messages, since the answers to one question stay on it.

Each conversation also has a data tree behind it, its context:
- what it read and used: the topic it talked to, the conversations pulled in as related, datasets you cited, files
  you attached, the conversation it branched from;
- what its agents did: files read and changed, pages fetched, skills used, tools from MCP servers.

And every question you asked goes into one index file, by topic, conversation and segment, so they can be found
again quickly (notes/inputs/<you>.md)."""
from __future__ import annotations

import hashlib
import json
import logging
import re
import time
import uuid
from datetime import datetime
from pathlib import Path
from typing import TYPE_CHECKING

from sqlalchemy import select

from pga.agent.common import UNTRUSTED_NOTE, fence, parse_json
from pga.db.models import AgentRun, User, WorldNode
from pga.db.types import utcnow

if TYPE_CHECKING:
    from pga.runtime import Runtime

log = logging.getLogger(__name__)

from pga.agents.pool import ROOT

INDEX_DIR = ROOT.parent / "notes" / "inputs"          # ~/Documents/PGA/notes/inputs/<you>.md
INDEX_STATE: dict[str, dict] = {}

SPLIT = """You split a conversation into segments by what the user was working on. You see only the user's messages, numbered.
- Consecutive messages about the same matter form one segment. Refining, correcting, following up or asking "why" about
  the same thing stays in its segment.
- Start a new segment when the user moves to a different matter.
- A conversation about one thing is one segment.
Reply with JSON only: {"segments": [{"from": 1, "to": 3, "title": "a few words naming the matter, in the language of the messages"}]}
The segments must be in order and cover every message once. """ + UNTRUSTED_NOTE


def _clip(t: str | None, n: int) -> str:
    t = re.sub(r"\s+", " ", str(t or "")).strip()
    return t if len(t) <= n else t[: n - 1] + "…"


def _unwrap(t: str) -> str:
    return re.sub(r"^\s*<(\w+)>\s*([\s\S]*?)\s*</\1>\s*$", r"\2", t or "")


HARNESS = re.compile(r"^\s*(<(codex_internal_context|environment_context|system-reminder|command-|local-command|turn_aborted|user_instructions)|Caveat: )")


def _yours(text: str) -> bool:
    """A user turn you typed, not one the app put there (Codex's goal continuations, Claude Code's command echoes…)."""
    return bool(text.strip()) and not HARNESS.match(text)


# ------------------------------------------------------------------ what you asked
def questions(rt: "Runtime", user: User, ref: str | None) -> list[dict]:
    """Your messages in a conversation, oldest first: {i, text, at, run} (run: the turn to jump to, for PGA's own)."""
    if not ref:
        return []
    if ref.startswith("c:"):
        return _imported(rt, user, ref[2:])
    from pga.chats import ChatError, fold, runs_of
    try:
        turns, _ = fold(runs_of(rt, user.id, ref))
    except ChatError:
        return []
    out = []
    for r in turns:
        if (r.prompt or "").strip():
            out.append({"i": len(out), "text": _unwrap(r.prompt)[:4000], "at": r.started_at.isoformat() if r.started_at else None,
                        "run": str(r.id), **({"note": True} if (r.data or {}).get("note") else {})})
    return out


def _imported(rt: "Runtime", user: User, cid: str) -> list[dict]:
    from pga.db.models import AgentConversation, LinkedAgent
    from pga.hub.connectors import full_turns
    try:
        c = rt.session.get(AgentConversation, uuid.UUID(cid))
    except ValueError:
        return []
    a = rt.session.get(LinkedAgent, c.linked_agent_id) if c else None
    if a is None or a.user_id != user.id:
        return []
    try:
        turns = full_turns(a.connector, c.external_id)
    except Exception:  # noqa: BLE001 - the app's own store is gone or unreadable
        turns = []
    if not turns and c.excerpt:                            # its session file is gone: what PGA kept when it imported it
        turns = [{"role": "user", "text": re.sub(r"\s*\[… \d+ more turns …\]\s*", " ", m.group(1))}
                 for m in re.finditer(r"^User: (.+?)(?=^\w+: |\Z)", c.excerpt, re.M | re.S)]
    out = []
    for t in turns:
        if t.get("role") == "user" and _yours(t.get("text") or ""):
            out.append({"i": len(out), "text": _unwrap(t["text"]).strip()[:4000], "at": t.get("at")})
    return out


# ------------------------------------------------------------------ segments
def _sig(qs: list[dict]) -> str:
    return hashlib.sha1("\n".join(q["text"][:300] for q in qs).encode()).hexdigest()[:16]


def _repair(raw: list, n: int, title: str) -> list[dict]:
    """In order, covering 1…n once, whatever the model returned."""
    segs, nxt = [], 1
    for s in sorted([s for s in raw if isinstance(s, dict)], key=lambda s: int(s.get("from") or 0)):
        try:
            a, b = int(s.get("from")), int(s.get("to"))
        except (TypeError, ValueError):
            continue
        a, b = max(a, nxt), min(b, n)
        if b < a:
            continue
        if a > nxt and segs:                                   # a gap: the messages in it stay with the segment before
            segs[-1]["to"] = a - 1
        elif a > nxt:
            a = nxt
        segs.append({"from": a, "to": b, "title": _clip(s.get("title"), 40) or title})
        nxt = b + 1
    if not segs:
        return [{"from": 1, "to": n, "title": title}]
    segs[-1]["to"] = n
    return segs


def _ask(rt: "Runtime", user: User, prompt: str, n: int, now: datetime) -> dict:
    from pga.allocator import Estimates, Justification, RunRequest
    decision = rt.allocator.allocate(RunRequest(
        user_id=user.id, kind="classification",
        justification=Justification(why_now=f"splitting a conversation of {n} questions by matter", expected_gain="the finest level of the world tree",
                                    decision_affected="where each question is found", budget={"max_units": 20_000, "max_output_tokens": 800},
                                    stop_condition="split"),
        estimates=Estimates(information_gain=.3, decision_impact=.3, user_relevance=.7, reuse_value=.7, input_tokens=len(prompt) // 3, output_tokens=300)), now=now)
    if not decision.allowed:
        raise ValueError("; ".join(decision.reasons))
    with rt.runs.track(decision, now) as guard:
        res = rt.router.complete(decision.tier, system=SPLIT, messages=[{"role": "user", "content": prompt}], max_tokens=800,
                                 usage=guard.usage_context(), delegate=False)
        guard.stop("split")
    return parse_json(res.text or "{}")


def segments(rt: "Runtime", user: User, leaf: WorldNode, qs: list[dict] | None = None, use_model: bool = True, now: datetime | None = None) -> list[dict]:
    """The conversation's segments, each with its questions: worked out once per version of the conversation and kept
    on its leaf (data.segments)."""
    qs = questions(rt, user, leaf.ref) if qs is None else qs
    asked = [q for q in qs if not q.get("note")]
    if not asked:
        return []
    sig, title = _sig(asked), _clip(leaf.title, 40)
    kept = (leaf.data or {}).get("segments") or {}
    if kept.get("sig") == sig:
        raw = kept.get("list") or []
    elif len(asked) == 1 or not use_model:
        raw = [{"from": 1, "to": len(asked), "title": title}]
    else:
        prompt = fence("messages", "\n".join(f"{i + 1}. {_clip(q['text'], 300)}" for i, q in enumerate(asked[:120])), 40000, kind="the user's messages")
        try:
            raw = _repair(_ask(rt, user, prompt, len(asked), now or utcnow()).get("segments") or [], len(asked), title)
        except Exception as exc:  # noqa: BLE001 - no model: the conversation stays one segment for now
            log.info("splitting %s failed: %s", leaf.ref, exc)
            raw = None
        if raw is not None:
            leaf.data = {**(leaf.data or {}), "segments": {"sig": sig, "list": raw, "at": (now or utcnow()).isoformat()}}
            rt.session.flush()
        else:
            raw = [{"from": 1, "to": len(asked), "title": title}]
    raw = _repair(raw, len(asked), title)
    return [{**s, "questions": asked[s["from"] - 1:s["to"]]} for s in raw]


# ------------------------------------------------------------------ the data tree: what a conversation used
def context(rt: "Runtime", user: User, ref: str | None) -> dict:
    """What the conversation read, cited and did, from its runs and their agents' traces."""
    out: dict = {"topic": None, "related": [], "datasets": [], "attachments": [], "branched_from": None,
                 "read": [], "changed": [], "web": [], "skills": [], "tools": [], "commands": 0}
    if not ref or ref.startswith("c:"):
        return out
    from pga.chats import ChatError, branch_of, runs_of
    from pga.tree import parse_actions
    from pga.worldtree import WorldTree, chat_node
    try:
        runs = runs_of(rt, user.id, ref)
    except ChatError:
        return out
    wn = chat_node(user, ref)
    if wn:
        try:
            t = WorldTree(rt).get(user, uuid.UUID(wn))
            out["topic"] = {"id": wn, "title": t.title} if t else None
        except ValueError:
            pass
    b = branch_of(user, ref)
    if b:
        out["branched_from"] = {"key": b.get("from"), "upto": b.get("upto")}
    seen: dict[str, set] = {k: set() for k in ("related", "datasets", "attachments", "read", "changed", "web", "skills", "tools")}

    def add(k: str, v, key: str | None = None) -> None:
        key = key or (v if isinstance(v, str) else json.dumps(v, ensure_ascii=False, sort_keys=True))
        if key and key not in seen[k] and len(out[k]) < 40:
            seen[k].add(key)
            out[k].append(v)
    kids = {}
    if runs:
        for k in rt.session.scalars(select(AgentRun).where(AgentRun.parent_id.in_([r.id for r in runs]))):
            kids.setdefault(k.parent_id, []).append(k)
    for r in runs:
        d = r.data or {}
        used = d.get("context_used") or {}
        if used.get("topic") and not out["topic"]:
            out["topic"] = used["topic"]
        for x in used.get("related") or []:
            add("related", x, x.get("ref"))
        for x in used.get("datasets") or []:
            add("datasets", x, x.get("id"))
        for p in d.get("attachments") or []:
            add("attachments", Path(str(p)).name if isinstance(p, str) else str(p))
        for k in kids.get(r.id, []):
            for a in parse_actions((k.data or {}).get("trace") or ""):
                tool, tgt, kind = a["tool"], a["target"], a["kind"]
                if tool == "Skill":
                    add("skills", tgt.split()[0] if tgt else tgt)
                elif tool.startswith("mcp__"):
                    add("tools", tool.split("__", 2)[-1] if tool.count("__") >= 2 else tool)
                elif kind == "read":
                    add("read", tgt.split()[0] if tgt else tgt)
                elif kind == "edit":
                    add("changed", tgt.split()[0] if tgt else tgt)
                elif kind == "web":
                    add("web", tgt)
                elif kind == "command":
                    out["commands"] += 1
    return out


def used_in_ask(wt, node: WorldNode | None, related: list[WorldNode], refs: list[str], rt: "Runtime", user: User) -> dict:
    """What a question was given besides itself, kept on its run (data.context_used) for the data tree."""
    from pga.db.models import Body
    out: dict = {}
    if node is not None:
        out["topic"] = {"id": str(node.id), "title": node.title}
    if related:
        out["related"] = [{"ref": x.ref, "title": _clip(x.title, 80), "world": str(x.id)} for x in related if x.ref]
    ds = []
    for i in refs[:8]:
        try:
            b = rt.session.get(Body, uuid.UUID(str(i)))
        except ValueError:
            continue
        if b is not None and b.user_id == user.id:
            ds.append({"id": str(b.id), "title": _clip(b.title or b.title_en, 80)})
    if ds:
        out["datasets"] = ds
    return out


# ------------------------------------------------------------------ every question, in one file
def build_index(rt: "Runtime", user: User, path: Path | None = None) -> dict:
    """notes/inputs/<you>.md: by world-tree topic, each conversation, each of its segments (where worked out), every
    question with when it was asked. No model is called: conversations not split yet are listed whole."""
    from pga.worldtree import WorldTree
    wt = WorldTree(rt)
    nodes = wt.nodes(user.id)
    kids: dict = {}
    for n in nodes:
        kids.setdefault(n.parent_id, []).append(n)
    root = next((n for n in nodes if n.kind == "root"), None)
    lines = [f"# 我问过的所有问题", "", f"按世界树的主题、对话和分段排列。生成于 {time.strftime('%Y-%m-%d %H:%M')}。", ""]
    count = {"conversations": 0, "questions": 0}

    def walk(n: WorldNode, depth: int) -> None:
        for c in sorted(kids.get(n.id, []), key=lambda x: (x.kind == "leaf", x.position)):
            if (c.data or {}).get("hidden"):
                continue
            if c.kind != "leaf":
                lines.extend([f"{'#' * min(6, depth + 1)} {c.title}", ""])
                walk(c, depth + 1)
                continue
            qs = [q for q in questions(rt, user, c.ref) if not q.get("note")]
            if not qs:
                continue
            count["conversations"] += 1
            count["questions"] += len(qs)
            lines.append(f"- **{c.title}** `{c.ref}`")
            segs = segments(rt, user, c, qs, use_model=False) if ((c.data or {}).get("segments") or {}).get("sig") == _sig(qs) else [{"title": "", "questions": qs}]
            for s in segs:
                if s.get("title") and len(segs) > 1:
                    lines.append(f"  - *{s['title']}*")
                pad = "    " if s.get("title") and len(segs) > 1 else "  "
                for q in s["questions"]:
                    lines.append(f"{pad}- {(q.get('at') or '')[:16].replace('T', ' ')} {_clip(q['text'], 300)}")
            lines.append("")
    if root is not None:
        walk(root, 1)
    path = path or INDEX_DIR / f"{user.id}.md"
    path.parent.mkdir(parents=True, exist_ok=True)
    tmp = path.with_suffix(".md.tmp")
    tmp.write_text("\n".join(lines))
    tmp.replace(path)
    return {"path": str(path), **count, "at": time.strftime("%Y-%m-%dT%H:%M:%S")}
