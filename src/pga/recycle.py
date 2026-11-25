"""对话回收 (route A, rules only): the one-off conversations a category's manager dispatched leave the stage and the
lists once their work is done and you have seen it; nothing is deleted.

A dispatched conversation is one-off while it holds only the task it was given: one turn, nothing branched from it,
no later task reading its context (`history_from`), no wire on the stage drawing from it. Such a conversation is
archived when, after its answer succeeded and you saw it,

- its request is settled: every task the same manager paragraph gave out finished and was seen (or is archived),
  and `grace_min` passed since you saw it — after Linear, where an issue in a cycle archives with its cycle;
- or `idle_h` passed with nothing new in it (a sibling that failed must not hold the rest forever) — Discord's
  auto-archive of an idle thread;
- or, for what finished before PGA kept "seen", `backlog_d` passed and the stage does not show it as unread.

Never archived: still running or waiting for approval, failed, unread, in front of you, put back by you (`keep`),
or continued in any way. A new message in an archived conversation puts it back (as Discord unarchives a thread).
The manager's own record of the task stays where it was and says it is archived; archived chats stay searchable.
"""
from __future__ import annotations

from datetime import datetime, timedelta
from typing import TYPE_CHECKING

from sqlalchemy import select

from pga.db.models import AgentRun, User
from pga.db.types import utcnow

if TYPE_CHECKING:
    from pga.runtime import Runtime

DEFAULTS = {"enabled": True, "grace_min": 10, "idle_h": 24, "backlog_d": 3}
ARCHIVE_CAP = 10000            # archived keys kept (the oldest beyond it would quietly come back to the lists)
SEEN_CAP = 3000
REASONS = {"settled": "需求已完成", "idle": "完成后 {h} 小时无新消息", "backlog": "完成超过 {d} 天", "manual": "手动归档"}


def cfg(user: User) -> dict:
    return {**DEFAULTS, **((user.preferences or {}).get("recycle") or {})}


def _prefs(user: User) -> dict:
    return dict(user.preferences or {})


def _ts(x) -> datetime | None:
    try:
        return datetime.fromisoformat(str(x)) if x else None
    except ValueError:
        return None


def archived(user: User) -> list[str]:
    return list(_prefs(user).get("archived_chats") or [])


def meta(user: User) -> dict:
    return dict(_prefs(user).get("archive_meta") or {})


def set_archived(user: User, key: str, on: bool, *, reason: str = "manual", now: datetime | None = None, extra: dict | None = None) -> None:
    """The one place a chat goes in or out of the archive, with why and when (so the manager can say so)."""
    now = now or utcnow()
    p = _prefs(user)
    keys = [k for k in (p.get("archived_chats") or []) if k != key]
    m = dict(p.get("archive_meta") or {})
    keep = [k for k in (p.get("recycle_keep") or []) if k != key]
    if on:
        keys.append(key)
        m[key] = {"at": now.isoformat(), "reason": reason, "auto": reason != "manual", **(extra or {})}
    else:
        if (m.pop(key, None) or {}).get("auto"):
            keep.append(key)                                    # you put it back: the rules leave it alone from now on
    keys = keys[-ARCHIVE_CAP:]
    p.update(archived_chats=keys, archive_meta={k: v for k, v in m.items() if k in set(keys)}, recycle_keep=keep[-SEEN_CAP:])
    user.preferences = p


def seen(user: User, keys: list[str], now: datetime | None = None) -> None:
    """You looked at these conversations' latest answers (the stage tells: finished, in front of you)."""
    now = (now or utcnow()).isoformat()
    p = _prefs(user)
    s = dict(p.get("chat_seen") or {})
    for k in keys:
        if isinstance(k, str) and k:
            s.pop(k, None)
            s[k[:120]] = now
    p["chat_seen"] = dict(list(s.items())[-SEEN_CAP:])
    user.preferences = p


def touched(user: User, key: str, now: datetime | None = None) -> bool:
    """A new message in an archived conversation the rules archived: it comes back."""
    if key and key in set(archived(user)) and (meta(user).get(key) or {}).get("auto"):
        set_archived(user, key, False, now=now)
        return True
    return False


def _entries(rt: "Runtime", user: User) -> list[tuple[str, dict]]:
    """(manager conversation, dispatch entry) for every paragraph a manager handed out."""
    from pga.project_context import MANAGER
    out = []
    for r in rt.session.scalars(select(AgentRun).where(AgentRun.user_id == user.id, AgentRun.parent_id.is_(None),
                                                       AgentRun.data["conversation"].as_string().like(MANAGER + "%"))):
        e = (r.data or {}).get("dispatch")
        if isinstance(e, dict):
            out.append((str((r.data or {}).get("conversation")), e))
    seen_ids = {e.get("id") for _, e in out}
    for k, xs in ((_prefs(user).get("chat_dispatch") or {}).items()):
        if str(k).startswith(MANAGER):
            out += [(k, e) for e in xs or [] if isinstance(e, dict) and e.get("id") not in seen_ids]
    return out


def _busy(user: User) -> set[str]:
    from pga.agents import live
    pre = f"{user.id}:"
    return {str((r.get("tags") or {}).get("conversation") or "")[len(pre):] for r in live.snapshot()
            if r.get("running") and str((r.get("tags") or {}).get("conversation") or "").startswith(pre)}


def plan(rt: "Runtime", user: User, *, unread=(), visible=(), now: datetime | None = None) -> list[dict]:
    """What the rules would archive now, each with why (nothing is changed)."""
    from pga.chats import children
    from pga.project_context import MANAGER
    now = now or utcnow()
    c = cfg(user)
    if not c.get("enabled"):
        return []
    p = _prefs(user)
    gone, keep = set(p.get("archived_chats") or []), set(p.get("recycle_keep") or [])
    seen_at = {k: _ts(v) for k, v in (p.get("chat_seen") or {}).items()}
    unread, visible, busy = set(unread or ()), set(visible or ()), _busy(user)
    entries = _entries(rt, user)
    tasks = {}                                                   # task key → (manager key, entry)
    used = set()                                                 # read by a later task or a wire on the stage
    for mk, e in entries:
        for t in e.get("tasks") or []:
            if t.get("from"):
                used.add(str(t["from"]))
            if t.get("key") and not t.get("manager") and not str(t["key"]).startswith((MANAGER, "chat:summary-")):
                tasks.setdefault(str(t["key"]), (mk, e))
    for frm in (p.get("chat_refs") or {}).values():
        used.update(frm or [])
    if not tasks:
        return []
    runs: dict[str, list[AgentRun]] = {}
    for r in rt.session.scalars(select(AgentRun).where(AgentRun.user_id == user.id, AgentRun.parent_id.is_(None), AgentRun.workflow == "ask",
                                                       AgentRun.data["conversation"].as_string().in_(list(tasks)))):
        runs.setdefault(str((r.data or {}).get("conversation")), []).append(r)

    def state(k: str) -> dict:
        """Where one task stands: done and seen (and since when), or why not."""
        if k in gone:
            return {"st": "archived"}
        rs = [r for r in runs.get(k, []) if not (r.data or {}).get("regen_of")]
        if k in busy or not rs:
            return {"st": "running"}
        turns = len(rs) + sum(len((r.data or {}).get("steering") or []) for r in rs)   # what you added while it worked counts too
        last = max(runs[k], key=lambda r: r.finished_at or r.started_at)
        if last.status != "SUCCEEDED":
            return {"st": "failed"}
        done = last.finished_at or last.started_at
        if k in unread:
            return {"st": "unread"}
        s = seen_at.get(k)
        if s and s >= done - timedelta(seconds=5):
            return {"st": "seen", "since": s, "turns": turns}
        if now - done >= timedelta(days=c["backlog_d"]):
            return {"st": "seen", "since": done, "turns": turns, "backlog": True}
        return {"st": "unread"}

    states = {k: state(k) for k in tasks}
    out = []
    for k, (mk, e) in tasks.items():
        s = states[k]
        if s["st"] != "seen" or k in keep or k in visible or k in used or s["turns"] != 1 or children(user, k):
            continue
        since, reason = s["since"], ""
        settled = all(states.get(str(t.get("key")), {}).get("st") in ("seen", "archived")
                      for t in e.get("tasks") or [] if t.get("key") and not t.get("manager"))
        if s.get("backlog"):
            reason = "backlog"
        elif settled and now - since >= timedelta(minutes=c["grace_min"]):
            reason = "settled"
        elif now - since >= timedelta(hours=c["idle_h"]):
            reason = "idle"
        if reason:
            title = next((t.get("title") for t in e.get("tasks") or [] if t.get("key") == k), "") or ""
            out.append({"key": k, "reason": reason, "why": REASONS[reason].format(h=c["idle_h"], d=c["backlog_d"]),
                        "manager": mk, "entry": str(e.get("id") or ""), "title": str(title)[:60]})
    return out


def sweep(rt: "Runtime", user: User, *, unread=(), visible=(), now: datetime | None = None, dry: bool = False) -> list[dict]:
    """Archive what `plan` finds; the batch is remembered so one click can undo it."""
    now = now or utcnow()
    xs = plan(rt, user, unread=unread, visible=visible, now=now)
    if dry or not xs:
        return xs
    for x in xs:
        set_archived(user, x["key"], True, reason=x["reason"], now=now,
                     extra={"why": x["why"], "manager": x["manager"], "entry": x["entry"], "title": x["title"]})
    p = _prefs(user)
    p["recycle_last"] = {"at": now.isoformat(), "keys": [x["key"] for x in xs]}
    user.preferences = p
    return xs


def undo(user: User, now: datetime | None = None) -> list[str]:
    """Put back the last batch the rules archived (they will not take those again)."""
    p = _prefs(user)
    keys = list((p.get("recycle_last") or {}).get("keys") or [])
    for k in keys:
        if k in set(archived(user)):
            set_archived(user, k, False, now=now)
    p = _prefs(user)
    p.pop("recycle_last", None)
    user.preferences = p
    return keys
