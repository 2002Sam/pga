"""归档整理: a folder (project) with too many conversations is tidied down, with your say-so at each step.

Nothing is worked out from scratch: the world tree (pga.worldtree) already knows every conversation — which topic it sits
under, a one-line gist, and the fact graph (pga.kg) knows what is true now and what was superseded. So:

1. Stay: only what you pinned. Recent, marked or open conversations are tidied like the rest. If the folder holds LIMIT or fewer, nothing to do.
2. Group (free): an older conversation not on the world tree yet is placed first (the tree's own MemTree step, one call per
   70), so the tree stays whole. Then the conversations are cut at the finest level of the tree that fits the room: their
   own topic if that leaves few enough groups, else the topic above, and so on up.
3. Fit (one cheap model call, only when even the top level leaves more groups than room): the model is shown the groups —
   topic, its summary, a gist per member — and merges the ones about the same matter. If it cannot be reached, the
   closest groups (same parent topic first, smallest first) are merged by rule. Each group says how it was made.
4. Write up (one call per group, after you agree): the note is made from the members' gists and digests, the topic's summary
   and the fact graph (facts that hold now; facts superseded, so old versions do not come back as current), newest wins on
   a conflict. It becomes one new conversation in the folder.
5. The originals are archived, not deleted (已归档 puts them back); every tidy is logged and can be undone.
6. The tree is kept in step: the new conversation gets a leaf where most of its originals sat (no model), the originals'
   leaves are hidden (their facts still count for the topic), and the topics are marked to be re-summarised. Undo, or
   putting an original back from 已归档, reverses that.

The pattern is the usual one for agent memory: group by what is already known (RAPTOR / BERTopic cluster first, then label and
merge with a model), and let a model reconcile repeats and changes (Mem0's add / update / keep, Letta's sleep-time
defragmentation with a backup first). `ask` / `write` can be passed in (tests).
"""
from __future__ import annotations

import logging
import re
import uuid
from datetime import datetime, timedelta
from typing import TYPE_CHECKING, Callable

from pga.agent.common import UNTRUSTED_NOTE, fence, parse_json
from pga.db.models import AgentRun, User, WorldNode
from pga.db.types import utcnow

if TYPE_CHECKING:
    from pga.runtime import Runtime

log = logging.getLogger(__name__)

LIMIT = 10                       # conversations left in a folder at most
MEMBER_CHARS = 2500              # how much of one conversation the writer reads
GROUP_CHARS = 28000
KEEP_LOG = 60


class Deferred(RuntimeError):
    """No budget or no model right now: try later."""


def _log(user: User) -> list[dict]:
    return list((user.preferences or {}).get("consolidated") or [])


def _save_log(user: User, entries: list[dict]) -> None:
    user.preferences = {**(user.preferences or {}), "consolidated": entries[-KEEP_LOG:]}


def _archived(user: User) -> list[str]:
    return list((user.preferences or {}).get("archived_chats") or [])


def _set_archived(user: User, keys: list[str]) -> None:
    user.preferences = {**(user.preferences or {}), "archived_chats": keys[-2000:]}


def history(user: User) -> list[dict]:
    return [{k: e.get(k) for k in ("id", "kind", "at", "project", "title", "key", "n", "undone")} for e in reversed(_log(user))]


def merges_of(rt: "Runtime", user: User, key: str) -> dict:
    """The merges this conversation took part in (for its branch tree): what was folded into it, and what it was folded into."""
    titles = (user.preferences or {}).get("chat_titles") or {}
    live = [e for e in _log(user) if e.get("kind") == "group" and not e.get("undone")]

    def name(k: str) -> str:
        return titles.get(k) or ""
    into = next(({"key": e["key"], "title": name(e["key"]) or e.get("title") or ""} for e in reversed(live) if key in (e.get("members") or [])), None)
    mine = next((e for e in reversed(live) if e.get("key") == key), None)
    return {"into": into, "from": [{"key": k, "title": name(k)} for k in (mine.get("members") or [])] if mine else []}


# ------------------------------------------------------------------------------------------------ one folder
def _in_project(rt: "Runtime", user: User, project: str, now: datetime) -> list:
    from pga import projectsort
    from pga.timeline import Timeline
    st = projectsort.state(user)
    items = Timeline(rt).items(user, now - timedelta(days=730))
    return [it for it in items if it.kind in ("chat", "import") and it.times and projectsort.project_of(st, it.key, it.project) == project]


def _tree(rt: "Runtime", user: User) -> tuple[dict, dict]:
    """The world tree: leaf by conversation key, and every node by id. Empty when it is not built (or unreachable)."""
    try:
        from pga.worldtree import WorldTree
        nodes = WorldTree(rt).nodes(user.id)
    except Exception as exc:  # noqa: BLE001 - the tree is a help, not a requirement
        log.info("consolidate: no world tree (%s)", exc)
        return {}, {}
    return {n.ref: n for n in nodes if n.kind == "leaf" and n.ref}, {n.id: n for n in nodes}


def _gist(leaf) -> str:
    return str(((leaf.data or {}).get("gist") if leaf is not None else "") or "")


def plan(rt: "Runtime", user: User, project: str, protect: list[str] | None = None, now: datetime | None = None,
         ask: Callable | None = None) -> dict:
    """What would change in this folder: which conversations stay and which groups the rest fall into."""
    now = now or utcnow()
    items = _in_project(rt, user, project, now)
    protect = set(protect or [])
    last = lambda it: max(it.times)                                            # noqa: E731
    keep = [it for it in items if it.key in protect]                          # only pinned ones are left alone
    old = sorted((it for it in items if it not in keep), key=last, reverse=True)
    out = {"project": project, "total": len(items), "keep": [_row(it) for it in keep], "groups": [], "limit": LIMIT, "by": ""}
    if len(items) <= LIMIT:
        out["note"] = "within"                                                 # already no more than LIMIT here
        return out
    if not old:
        out["note"] = "recent"                                                 # everything left is pinned
        return out
    room = max(1, LIMIT - len(keep))
    leaves, topics = _tree(rt, user)
    missing = [it.key for it in old if it.key not in leaves]
    if topics and missing and _place(rt, user, missing, now):                 # the tree is built: what is not on it yet goes on it first
        leaves, topics = _tree(rt, user)
        out["placed"] = len([k for k in missing if k in leaves])
    groups = _by_level(old, leaves, topics, room)
    out["by"] = "tree" if leaves else "none"
    if len(groups) > room:
        try:
            groups = _fit(rt, user, groups, room, now, ask)
            out["by"] = "model"
        except Deferred as exc:
            log.info("consolidate: merging by rule (%s)", exc)
            groups = _fit_by_rule(groups, room)
            out["by"] = "rule"
    out["groups"] = [{"id": g["id"], "title": g["title"], "about": g["about"], "how": g.get("how", "tree"), "path": g.get("path", ""),
                      "members": [_row(it, _gist(leaves.get(it.key))) for it in sorted(g["items"], key=last, reverse=True)]} for g in groups]
    return out


def _row(it, gist: str = "") -> dict:
    return {"key": it.key, "title": it.title, "gist": gist, "last": max(it.times).isoformat(),
            "turns": sum(it.turns) if it.turns else len(it.runs), "agent": it.agent, "kind": it.kind}


def _place(rt: "Runtime", user: User, keys: list[str], now: datetime) -> int:
    """Put these conversations on the world tree (its own routing step), so they are grouped by what they are about."""
    try:
        from pga.worldtree import BATCH, WorldTree
        wt = WorldTree(rt)
        if not wt.built(user):
            return 0
        want = set(keys[:140])
        xs = [x for x in wt.items(user) if x["key"] in want]
        n = 0
        for b in range(0, len(xs), BATCH):
            n += wt._assign(user, xs[b:b + BATCH], wt._paths(user), now, allow_new=True)
        rt.session.flush()
        return n
    except Exception as exc:  # noqa: BLE001 - no model now: they stay in the not-on-the-tree group
        log.info("consolidate: could not place on the tree (%s)", exc)
        return 0


def _chain(leaf, topics: dict) -> list:
    """The topics above a leaf, its own first, up to (not including) the root."""
    out = []
    n = topics.get(leaf.parent_id) if leaf is not None else None
    while n is not None and n.kind != "root" and len(out) < 12:
        out.append(n)
        n = topics.get(n.parent_id)
    return out


def _path(t, topics: dict) -> str:
    return " › ".join(reversed([x.title for x in [t, *_chain(t, topics)]]))[:160]


def _by_level(old: list, leaves: dict, topics: dict, room: int) -> list[dict]:
    """Cut at the finest level of the world tree that fits the room: each conversation goes to its own topic, or, when that
    makes too many groups, to the topic above it at that depth. When even the top level does not fit, its groups are
    returned (to be merged). Those not on the tree share one group."""
    chains = {it.key: _chain(leaves.get(it.key), topics) for it in old}
    depths = sorted({t.depth for c in chains.values() for t in c}, reverse=True)

    def cut(d: int | None) -> list[dict]:
        by: dict = {}
        for it in old:
            c = chains[it.key]
            t = next((x for x in c if d is None or x.depth <= d), c[-1] if c else None)
            by.setdefault(t.id if t is not None else None, (t, []))[1].append(it)
        groups = []
        for t, its in by.values():
            groups.append({"id": uuid.uuid4().hex[:8], "title": (t.title if t is not None else "还没进世界树的")[:60],
                           "parent": t.parent_id if t is not None else None, "about": (t.summary if t is not None else "")[:300],
                           "how": "tree" if t is not None else "untreed", "path": _path(t, topics) if t is not None else "", "items": its})
        return sorted(groups, key=lambda g: -len(g["items"]))

    groups = cut(None)
    for d in depths:
        groups = cut(d)
        if len(groups) <= room:
            break
    return groups


FIT_SYSTEM = """A person's older AI conversations in one folder are already grouped by the topic they sit under in their own world tree. There are
more groups than the folder should keep, so merge the groups that are about the same matter (or clearly belong together) until
there are at most {room}. Keep a group apart if it is about something of its own. Name each merged group in 2-8 words in the
conversations' language (a group left alone keeps its name). Reply with JSON only:
{{"groups": [{{"title": "...", "from": ["g0", "g3"]}}]}}   (every g appears in exactly one entry)"""


def _fit(rt, user, groups: list[dict], room: int, now, ask) -> list[dict]:
    rows = "\n".join(f"g{i} | {g['title']} | {re.sub(r'\s+', ' ', g['about'])[:160]} | " + " / ".join(
        f"{max(it.times).date()} {(it.title or '')[:40]}" for it in sorted(g["items"], key=lambda it: max(it.times), reverse=True)[:4]) + f" | {len(g['items'])} conversations"
        for i, g in enumerate(groups[:60]))
    d = (ask or _ask)(rt, user, FIT_SYSTEM.format(room=room) + " " + UNTRUSTED_NOTE,
                      fence("groups", "group | topic | what the topic holds | newest members | size\n" + rows, 30000, kind="the person's conversation groups"), now)
    taken: set[int] = set()
    merged = []
    for e in d.get("groups") or []:
        idx = [int(m[1:]) for m in (e.get("from") or []) if re.fullmatch(r"g\d+", str(m)) and int(str(m)[1:]) < len(groups[:60]) and int(str(m)[1:]) not in taken]
        if not idx:
            continue
        taken.update(idx)
        merged.append(_join([groups[i] for i in idx], str(e.get("title") or "")[:60], "model"))
    merged += [groups[i] for i in range(len(groups)) if i not in taken]        # left out by the model: stay as they were
    return _fit_by_rule(merged, room)


def _join(gs: list[dict], title: str = "", how: str = "rule") -> dict:
    if len(gs) == 1 and not title:
        return gs[0]
    big = max(gs, key=lambda g: len(g["items"]))
    return {"id": uuid.uuid4().hex[:8], "title": (title or big["title"])[:60], "parent": big.get("parent"), "how": how,
            "about": big["about"], "path": " + ".join(dict.fromkeys(g.get("path") or g["title"] for g in gs))[:200],
            "items": [it for g in gs for it in g["items"]]}


def _fit_by_rule(groups: list[dict], room: int) -> list[dict]:
    """Merge until there is room: groups under the same parent topic first, the smallest first."""
    gs = list(groups)
    while len(gs) > room:
        best = min(((a, b) for i, a in enumerate(gs) for b in gs[i + 1:]),
                   key=lambda p: (p[0].get("parent") != p[1].get("parent"), len(p[0]["items"]) + len(p[1]["items"])))
        gs = [g for g in gs if g is not best[0] and g is not best[1]] + [_join(list(best))]
    return gs


# ------------------------------------------------------------------------------------------------ writing one group up
WRITE_SYSTEM = """You write the archive note for a group of a person's older AI conversations on one matter, so they can drop the
originals and still find what mattered. Write in the conversations' language, as Markdown, under {words} words, with these parts
(leave out a part with nothing in it):
## 做了什么 / What it was — the matter and how it went, in a few lines (dates where they help)
## 结论与可复用的内容 / What to keep — decisions, findings, final versions, commands, links, numbers, names: the specifics
## 还没做完的 / Still open — loose ends
Merge repeats into one statement. Where versions differ, the newest wins: say what holds now, and mention an older version only
if it explains something. "Facts that hold now" and "No longer true" come from the person's fact graph: trust them over
a guess. Do not invent anything that is not in the conversations. {untrusted}"""


def _turns(rt: "Runtime", user: User, it_key: str, ref: dict) -> list[dict]:
    from pga import chats
    try:
        if it_key.startswith("c:"):
            return chats.imported_turns(rt, user, str(ref.get("conversation") or it_key[2:]))[0]
        return chats.history(rt, user, it_key)
    except Exception as exc:  # noqa: BLE001 - one unreadable conversation does not stop the rest
        log.info("consolidate: cannot read %s (%s)", it_key, exc)
        return []


def _segs(leaf) -> list[str]:
    """The matters the conversation went through (pga.segments, kept on its leaf), if worked out already."""
    lst = (((leaf.data or {}).get("segments") or {}).get("list") or []) if leaf is not None else []
    return [str(x.get("title") or "")[:40] for x in lst if isinstance(x, dict) and x.get("title")][:8]


def _digest(title: str, turns: list[dict], last: str, excerpt: str, gist: str = "", segs: list[str] | None = None) -> str:
    head = f"### {title} ({last[:10]})" + (f" — {gist}" if gist else "") + (f"\nMatters in it: {' / '.join(segs)}" if segs and len(segs) > 1 else "")
    if not turns:
        return f"{head}\n{re.sub(r'\s+', ' ', excerpt)[:MEMBER_CHARS]}"
    asked = [re.sub(r"\s+", " ", t["text"])[:260] for t in turns if t["role"] == "user" and t["text"].strip()]
    said = [re.sub(r"\s+", " ", t["text"])[:700] for t in turns if t["role"] != "user" and t["text"].strip()]
    body = "Asked: " + " | ".join(asked[:8]) + (" | …" if len(asked) > 8 else "") + "\nLatest answers: " + " || ".join(said[-3:])
    return f"{head}\n{body}"[:MEMBER_CHARS]


def _facts(rt: "Runtime", user: User, keys: list[str]) -> str:
    """What the fact graph says about these conversations: what holds now, and what was superseded."""
    try:
        from pga.kg.service import FactGraph
        fg = FactGraph(rt)
        cur, old = fg.topic_facts(user, keys, 12, 5)
        if not cur and not old:
            return ""
        return ("Facts that hold now:\n" + "\n".join(f"- {fg.describe(e)}" for e in cur)
                + ("\nNo longer true:\n" + "\n".join(f"- {fg.describe(e)}" for e in old) if old else ""))
    except Exception:  # noqa: BLE001 - facts are a help, not a requirement
        return ""


def apply_group(rt: "Runtime", user: User, project: str, title: str, keys: list[str], now: datetime | None = None,
                write: Callable | None = None) -> dict:
    """Write the group up as one new conversation in the folder and archive the originals."""
    now = now or utcnow()
    mine = {it.key: it for it in _in_project(rt, user, project, now)}
    keys = [k for k in dict.fromkeys(keys) if k in mine]
    if not keys:
        raise ValueError("none of those conversations is in this folder any more")
    leaves, topics = _tree(rt, user)
    blocks = []
    for k in sorted(keys, key=lambda k: max(mine[k].times), reverse=True):             # newest first: if there is no room, the oldest go
        g = _gist(leaves.get(k))
        blocks.append(_digest(mine[k].title, _turns(rt, user, k, mine[k].ref), max(mine[k].times).isoformat(), mine[k].excerpt, g, _segs(leaves.get(k))))
    text = ""
    for b in blocks:
        if len(text) + len(b) > GROUP_CHARS:
            break
        text += b + "\n\n"
    about = next((topics[l.parent_id].summary for l in (leaves.get(k) for k in keys) if l is not None and l.parent_id in topics and topics[l.parent_id].summary), "")
    if about:
        text = f"What the world tree says this matter is:\n{about[:500]}\n\n" + text
    facts = _facts(rt, user, keys)
    if facts:
        text += facts
    words = min(500, 120 + 60 * len(keys))
    system = WRITE_SYSTEM.format(words=words, untrusted=UNTRUSTED_NOTE)
    note = (write or _write)(rt, user, system, fence("conversations", f"Group: {title}\n\n{text}", GROUP_CHARS + 500, kind="older conversations, newest first"), now).strip()
    if not note:
        raise Deferred("the model wrote nothing")
    members = "\n".join(f"- {mine[k].title[:70]}（{max(mine[k].times).date()}）" for k in keys)
    note += f"\n\n---\n合并自 {len(keys)} 段对话（已归档，可在「已归档」里放回）：\n{members}"
    key = f"chat:{uuid.uuid4().hex[:10]}"
    first = min(min(mine[k].times) for k in keys)
    rt.session.add(AgentRun(user_id=user.id, workflow="ask", pattern="single", step="run", agent="pga", adapter="llm", status="SUCCEEDED",
                            prompt=f"🗃 {title[:60]}\n\n归档整理：{len(keys)} 段对话合成一段", output=note, started_at=now, finished_at=now,
                            data={"conversation": key, "agent": "pga", "consolidated": keys, "since": first.isoformat()}))
    titles = dict((user.preferences or {}).get("chat_titles") or {})
    titles[key] = f"🗃 {title[:60]}"
    from pga import projectsort
    pst = projectsort.state(user)
    pst["of"][key] = project
    projectsort.save(user, pst)
    user.preferences = {**(user.preferences or {}), "chat_titles": titles}
    _set_archived(user, [k for k in _archived(user) if k not in keys] + keys)
    rt.session.flush()
    where = _tree_merge(rt, user, key, keys, f"🗃 {title[:60]}", note, project, first, now)
    eid = uuid.uuid4().hex[:10]
    _save_log(user, _log(user) + [{"id": eid, "kind": "group", "at": now.isoformat(), "project": project, "title": title[:60], "key": key,
                                   "members": keys, "n": len(keys), "tree": where}])
    rt.session.flush()
    return {"id": eid, "key": key, "title": title, "n": len(keys), "summary": note, "tree": where}


# ------------------------------------------------------------------------------------------------ keeping the world tree in step
def _wt(rt: "Runtime", user: User):
    from pga.worldtree import WorldTree
    wt = WorldTree(rt)
    return wt if wt.built(user) else None


def _tree_merge(rt: "Runtime", user: User, key: str, keys: list[str], title: str, note: str, project: str, first: datetime, now: datetime) -> str:
    """The new conversation takes a leaf where most of its originals sat; the originals' leaves are hidden (their facts still
    count for the topic above); the topics are marked stale, so their summaries are rewritten from what is there now."""
    from collections import Counter
    try:
        wt = _wt(rt, user)
        if wt is None:
            return ""
        olds = [n for n in (wt.leaf_of(user, k) for k in keys) if n is not None]
        pid = Counter(n.parent_id for n in olds if n.parent_id).most_common(1)
        parent = (rt.session.get(WorldNode, pid[0][0]) if pid else None) or wt.root(user)
        gist = re.sub(r"\s+", " ", re.sub(r"^#+.*$", "", note, flags=re.M)).strip()[:60]
        leaf = wt._add(user, parent, "leaf", title, ref=key, data={
            "type": "chat", "agent": "pga", "project": project, "excerpt": re.sub(r"\s+", " ", note)[:400], "line": key,
            "first": first.isoformat(), "last": now.isoformat(), "turns": 1, "open": {"chat": key}, "who": "me",
            "gist": gist, "consolidated": keys})
        for n in olds:
            n.data = {**(n.data or {}), "hidden": True, "merged_into": key}
            wt._stale(rt.session.get(WorldNode, n.parent_id) if n.parent_id else None)
        wt._stale(parent)
        rt.session.flush()
        return str(leaf.id)
    except Exception as exc:  # noqa: BLE001 - the tree catches up on its next pass (place)
        log.info("consolidate: tree not updated (%s)", exc)
        return ""


def _tree_unmerge(rt: "Runtime", user: User, key: str, keys: list[str]) -> None:
    try:
        wt = _wt(rt, user)
        if wt is None:
            return
        for k in keys:
            restored(rt, user, k, wt)
        n = wt.leaf_of(user, key)
        if n is not None:
            n.data = {**(n.data or {}), "hidden": True}
            wt._stale(rt.session.get(WorldNode, n.parent_id) if n.parent_id else None)
        rt.session.flush()
    except Exception as exc:  # noqa: BLE001
        log.info("consolidate: tree not updated on undo (%s)", exc)


def restored(rt: "Runtime", user: User, key: str, wt=None) -> bool:
    """An original put back (undo, or 已归档 → 放回): its leaf shows again, if a tidy had hidden it."""
    try:
        wt = wt or _wt(rt, user)
        n = wt.leaf_of(user, key) if wt is not None else None
        if n is None or not (n.data or {}).get("merged_into"):
            return False
        n.data = {k: v for k, v in (n.data or {}).items() if k not in ("hidden", "merged_into")}
        wt._stale(rt.session.get(WorldNode, n.parent_id) if n.parent_id else None)
        return True
    except Exception as exc:  # noqa: BLE001
        log.info("consolidate: leaf not restored (%s)", exc)
        return False


def undo(rt: "Runtime", user: User, eid: str, now: datetime | None = None) -> dict:
    """Bring the originals back and put the written-up conversation away."""
    entries = _log(user)
    e = next((x for x in entries if x.get("id") == eid), None)
    if e is None or e.get("undone"):
        raise ValueError("nothing to undo")
    if e["kind"] == "group":
        gone = set(e.get("members") or [])
        _set_archived(user, [k for k in _archived(user) if k not in gone] + [e["key"]])
        _tree_unmerge(rt, user, e["key"], list(gone))
    else:
        from pga import projectsort
        st = projectsort.state(user)
        snap = e.get("before") or {}
        st["of"] = {**st["of"], **{k: v for k, v in (snap.get("of") or {}).items()}}
        for k in snap.get("unset") or []:
            st["of"].pop(k, None)
        for f in ("list", "mine", "about", "merged"):
            if f in snap:
                st[f] = snap[f]
        projectsort.save(user, st)
    e["undone"] = (now or utcnow()).isoformat()
    _save_log(user, entries)
    return {"id": eid, "kind": e["kind"]}


# ------------------------------------------------------------------------------------------------ the folders themselves
STRUCT_SYSTEM = """You look at how a person's AI conversations are filed in folders (projects) and propose a tidier top level.
Each folder: name | how many conversations | last used | the topics of their world tree its conversations sit under (with counts) | a few
titles. Folders marked [own] were made by the person: never merge them away (they may be merged INTO, and renamed only if their
name is clearly wrong). "日常对话" is the catch-all: leave it. Below the table, pairs of folders whose conversations sit under the
same world-tree topics are listed: those are the best candidates to merge. Propose only changes that are clearly better:
- merge: several small or overlapping folders into one broader folder (an existing one, or a new name in 2-6 words)
- rename: a folder whose name does not say what is in it (the topics column says what is in it)
Few, confident changes; none is fine. Reply with JSON only:
{{"merges": [{{"from": ["folder", "folder"], "to": "folder", "why": "one short sentence"}}], "renames": [{{"from": "folder", "to": "new name", "why": "..."}}]}}"""


def _topic_of(n, topics: dict, depth: int = 2):
    """The ancestor of a node at this depth of the world tree (or the highest below it)."""
    while n is not None and n.depth > depth and n.parent_id in topics:
        n = topics[n.parent_id]
    return n


def structure_plan(rt: "Runtime", user: User, now: datetime | None = None, ask: Callable | None = None) -> dict:
    from collections import Counter
    from pga import projectsort
    now = now or utcnow()
    from pga.timeline import Timeline
    st = projectsort.state(user)
    items = [it for it in Timeline(rt).items(user, now - timedelta(days=730)) if it.kind in ("chat", "import") and it.times]
    by: dict[str, list] = {}
    for it in items:
        by.setdefault(projectsort.project_of(st, it.key, it.project), []).append(it)
    folders = [{"name": n, "count": len(v), "last": max(max(i.times) for i in v).isoformat(), "own": n in st["mine"]} for n, v in by.items()]
    out = {"folders": sorted(folders, key=lambda f: -f["count"]), "merges": [], "renames": []}
    if len([f for f in folders if f["name"] != projectsort.EVERYDAY]) < 2:
        out["note"] = "few"
        return out
    leaves, topics = _tree(rt, user)
    spread: dict[str, Counter] = {}
    for n, v in by.items():
        c: Counter = Counter()
        for it in v:
            t = _topic_of(leaves.get(it.key), topics)
            if t is not None and t.kind == "topic":
                c[t.title] += 1
        spread[n] = c
    pairs = []
    for a in by:
        for b in by:
            if a < b and a != projectsort.EVERYDAY and b != projectsort.EVERYDAY and spread[a] and spread[b]:
                share = sum(min(spread[a][t], spread[b][t]) for t in spread[a]) / max(1, min(sum(spread[a].values()), sum(spread[b].values())))
                if share >= .4:
                    pairs.append((share, a, b))
    out["overlaps"] = [{"a": a, "b": b, "share": round(s_, 2)} for s_, a, b in sorted(pairs, reverse=True)[:12]]
    rows = "\n".join(f"{n} | {len(v)} | {max(max(i.times) for i in v).date()} | " + ", ".join(f"{t} ×{k}" for t, k in spread[n].most_common(4)) + " | "
                     + " / ".join(i.title[:40] for i in sorted(v, key=lambda i: max(i.times), reverse=True)[:3]) + (" [own]" if n in st["mine"] else "")
                     for n, v in sorted(by.items(), key=lambda kv: -len(kv[1])))
    hint = "\n".join(f"- {a} and {b}: {int(s_ * 100)}% of the smaller one sits under the same topics" for s_, a, b in sorted(pairs, reverse=True)[:12])
    d = (ask or _ask)(rt, user, STRUCT_SYSTEM + " " + UNTRUSTED_NOTE,
                      fence("folders", rows + ("\n\nOverlapping pairs:\n" + hint if hint else ""), 24000, kind="the person's folders"), now)
    names = set(by)
    for m in d.get("merges") or []:
        src = [s_ for s_ in (m.get("from") or []) if s_ in names and s_ not in st["mine"] and s_ != projectsort.EVERYDAY]
        to = str(m.get("to") or "").strip()[:40]
        if src and to and to != projectsort.EVERYDAY and any(s_ != to for s_ in src):
            out["merges"].append({"id": uuid.uuid4().hex[:8], "from": [s_ for s_ in src if s_ != to], "to": to, "why": str(m.get("why") or "")[:160],
                                  "n": sum(len(by[s_]) for s_ in src if s_ != to)})
    taken = {s_ for m in out["merges"] for s_ in m["from"]}
    for r in d.get("renames") or []:
        a, b = str(r.get("from") or ""), str(r.get("to") or "").strip()[:40]
        if a in names and a not in taken and b and b != a and b not in names and a != projectsort.EVERYDAY:
            out["renames"].append({"id": uuid.uuid4().hex[:8], "from": a, "to": b, "why": str(r.get("why") or "")[:160], "n": len(by[a])})
    return out


def structure_apply(rt: "Runtime", user: User, merges: list[dict], renames: list[dict], now: datetime | None = None) -> dict:
    """Move whole folders: every conversation under a merged-away folder is filed under the target; a rename is a merge into
    a new name. Nothing on disk moves; only how conversations are shown."""
    from pga import projectsort
    from pga.timeline import Timeline
    now = now or utcnow()
    st = projectsort.state(user)
    before = {"of": {}, "unset": [], "list": list(st["list"]), "mine": list(st["mine"]), "about": dict(st["about"]), "merged": dict(st.get("merged") or {})}
    items = [it for it in Timeline(rt).items(user, now - timedelta(days=730)) if it.kind in ("chat", "import")]
    plan_ = [(list(m.get("from") or []), str(m.get("to") or "").strip()[:40]) for m in merges] + [([str(r.get("from") or "")], str(r.get("to") or "").strip()[:40]) for r in renames]
    moved = 0
    for src, to in plan_:
        src = [s for s in src if s and s != to and s != projectsort.EVERYDAY]
        if not src or not to or to == projectsort.EVERYDAY:
            continue
        for it in items:
            cur = projectsort.project_of(st, it.key, it.project)
            if cur in src:
                if it.key in st["of"]:
                    before["of"][it.key] = st["of"][it.key]
                else:
                    before["unset"].append(it.key)
                st["of"][it.key] = to
                moved += 1
        for k, v in list(st["of"].items()):                                     # filed before and not in the list any more (archived ones too)
            if v in src:
                before["of"].setdefault(k, v)
                st["of"][k] = to
        if to not in st["list"]:
            st["list"].append(to)
        for s in src:
            if s in st["mine"]:
                st["mine"] = [to if x == s else x for x in st["mine"]]
            st["list"] = [x for x in st["list"] if x != s]
            if st["about"].get(s) and not st["about"].get(to):
                st["about"][to] = st["about"][s]
            st["merged"] = {**(st.get("merged") or {}), s: to}
    projectsort.save(user, st)
    eid = uuid.uuid4().hex[:10]
    _save_log(user, _log(user) + [{"id": eid, "kind": "structure", "at": now.isoformat(), "project": "", "title": f"{len(merges)} 合并 · {len(renames)} 改名",
                                   "key": "", "n": moved, "before": before}])
    return {"id": eid, "moved": moved}


# ------------------------------------------------------------------------------------------------ the model
def _allocate(rt: "Runtime", user: User, why: str, gain: str, decision_affected: str, prompt: str, max_tokens: int, kind: str, now: datetime):
    from pga.allocator import Estimates, Justification, RunRequest
    decision = rt.allocator.allocate(RunRequest(
        user_id=user.id, kind=kind,
        justification=Justification(why_now=why, expected_gain=gain, decision_affected=decision_affected,
                                    budget={"max_units": 40_000, "max_output_tokens": max_tokens}, stop_condition="done"),
        estimates=Estimates(information_gain=.3, decision_impact=.4, user_relevance=.9, reuse_value=.8,
                            input_tokens=len(prompt) // 3, output_tokens=max_tokens // 2)), now=now)
    if not decision.allowed:
        raise Deferred("; ".join(decision.reasons))
    return decision


def _complete(rt, user, system, prompt, now, *, why, gain, affected, max_tokens, kind) -> str:
    decision = _allocate(rt, user, why, gain, affected, prompt, max_tokens, kind, now)
    try:
        with rt.runs.track(decision, now) as guard:
            res = rt.router.complete(decision.tier, system=system, messages=[{"role": "user", "content": prompt}], max_tokens=max_tokens,
                                     usage=guard.usage_context(), delegate=False)
            guard.stop("done")
    except Exception as exc:  # noqa: BLE001
        raise Deferred(f"the model could not be reached: {exc}"[:300]) from exc
    return res.text or ""


def _ask(rt, user, system, prompt, now) -> dict:
    return parse_json(_complete(rt, user, system, prompt, now, why="you asked to tidy a folder of conversations",
                                gain="fewer, clearer conversations", affected="which conversations are merged or filed together",
                                max_tokens=3000, kind="classification") or "{}")


def _write(rt, user, system, prompt, now) -> str:
    return _complete(rt, user, system, prompt, now, why="writing up older conversations before they are archived",
                     gain="what mattered in them kept in one place", affected="whether the originals can be dropped",
                     max_tokens=1400, kind="synthesis")
