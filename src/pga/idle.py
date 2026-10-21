"""While you are away, your motivations keep going (空闲自动运转).

When you have not touched PGA for a while (an hour by default) — no clicks or typing in its pages, nothing sent, and no
session of your own in Claude Code or Codex on this machine — the perpetual tasks of your motivations that are paused
start on their own. The moment you are back (any of those again), the ones that started this way pause, and what they
are doing right now stops. A task you started yourself is yours: it keeps running. A task you stopped (not paused)
never starts on its own, and each motivation can opt out in its settings (`idle_auto`).

Only the owner's motivations run this way (a demo user's never do). Your choice is in your preferences (`idle_run` =
{on, minutes}), when you were last here too (`idle_state.last`); a task that started on its own carries the time it did
in its own settings (`_idle_since`), so nothing else written to your preferences can lose it.
"""
from __future__ import annotations

import json
import logging
import threading
import time
import uuid
from datetime import datetime, timedelta
from pathlib import Path
from typing import TYPE_CHECKING

from sqlalchemy import select

from pga.db.models import PerpetualTask, User
from pga.db.types import utcnow

if TYPE_CHECKING:
    from sqlalchemy.orm import Session

log = logging.getLogger(__name__)

DEFAULT = {"on": True, "minutes": 60}
WRITE_EVERY = 30                      # seconds: how often a touch is written down (a stop is always written at once)
_LOCK = threading.Lock()
_SEEN: dict[str, float] = {}          # user id → when a touch was last written
_MINE: dict[str, bool] = {}           # local session file → is it yours (not one PGA's own agents ran)


def cfg(user: User) -> dict:
    c = {**DEFAULT, **((user.preferences or {}).get("idle_run") or {})}
    c["minutes"] = max(5, min(24 * 60, int(c.get("minutes") or 60)))
    c["on"] = bool(c.get("on"))
    return c


def state(user: User) -> dict:
    return dict((user.preferences or {}).get("idle_state") or {})


def _save(user: User, st: dict) -> None:
    user.preferences = {**(user.preferences or {}), "idle_state": st}


def _ts(v) -> datetime | None:
    try:
        return datetime.fromisoformat(v) if v else None
    except (TypeError, ValueError):
        return None


def auto_tasks(session: "Session", user_id: uuid.UUID) -> list[PerpetualTask]:
    return [t for t in session.scalars(select(PerpetualTask).where(PerpetualTask.user_id == user_id, PerpetualTask.status == "running"))
            if (t.settings or {}).get("_idle_since")]


def _mark(t: PerpetualTask, since: str | None) -> None:
    st = {k: v for k, v in (t.settings or {}).items() if k != "_idle_since"}
    t.settings = {**st, "_idle_since": since} if since else st


def _engine(session: "Session", rt=None):
    from pga.perpetual import Perpetual
    from pga.runtime import Runtime
    return Perpetual(rt or Runtime(session))


def touch(session: "Session", user: User, now: datetime | None = None, *, force: bool = False, rt=None) -> list[str]:
    """You did something: note the time, and pause whatever started on its own while you were away (stopping what it is
    doing right now). Returns the ids of the tasks it paused."""
    now = now or utcnow()
    st = state(user)
    auto = auto_tasks(session, user.id)
    with _LOCK:
        if not auto and not force and time.time() - _SEEN.get(str(user.id), 0) < WRITE_EVERY:
            return []
        _SEEN[str(user.id)] = time.time()
    paused = []
    if auto:
        from pga.agents import live
        eng = _engine(session, rt)
        for t in auto:
            eng.set_status(t, "paused", now, auto=True)
            _mark(t, None)
            live.stop_where(perpetual=str(t.id))
            paused.append(str(t.id))
        log.info("you are back: paused %d motivation(s) that ran while you were away", len(paused))
    st.update(last=now.isoformat())
    _save(user, st)
    session.flush()
    return paused


def forget(session: "Session", t: PerpetualTask) -> None:
    """You started or paused this task yourself: it is no longer one that runs only while you are away."""
    if (t.settings or {}).get("_idle_since"):
        _mark(t, None)


def is_auto(session: "Session", t: PerpetualTask) -> bool:
    return t.status == "running" and bool((t.settings or {}).get("_idle_since"))


# ---------------------------------------------------------------- your own sessions in other apps on this machine

def _mine_claude(f: Path) -> bool:
    from pga.hub.connectors import _PGA_SIGNS, pga_started
    cwd, said = None, ""
    try:
        with f.open(encoding="utf-8", errors="replace") as fh:
            for n, ln in enumerate(fh):
                if n > 400:
                    break
                try:
                    e = json.loads(ln)
                except json.JSONDecodeError:
                    continue
                cwd = cwd or e.get("cwd")
                if e.get("type") == "user" and not e.get("isMeta"):
                    c = (e.get("message") or {}).get("content")
                    said = c if isinstance(c, str) else " ".join(str(x.get("text", "")) for x in c or [] if isinstance(x, dict))
                    if said.strip():
                        break
    except OSError:
        return False
    return not pga_started(cwd) and not any(s in said[:20000] for s in _PGA_SIGNS) and not said.lstrip().startswith("<aim>")


def _mine_codex(f: Path) -> bool:
    from pga.hub.connectors import _PGA_SIGNS, pga_started
    cwd, said = None, []
    try:
        with f.open(encoding="utf-8", errors="replace") as fh:
            for n, ln in enumerate(fh):
                if n > 200:
                    break
                try:
                    e = json.loads(ln)
                except json.JSONDecodeError:
                    continue
                p = e.get("payload") or {}
                cwd = cwd or p.get("cwd")
                if p.get("type") == "message" and p.get("role") == "user":
                    said.append(" ".join(str(x.get("text", "")) for x in p.get("content") or [] if isinstance(x, dict)))
                    if len(said) >= 3:
                        break
    except OSError:
        return False
    text = "\n".join(said)
    return not pga_started(cwd) and not any(s in text[:40000] for s in _PGA_SIGNS)


def local_activity(within_s: float = 3600) -> datetime | None:
    """When you last worked in Claude Code or Codex on this machine (sessions PGA's own agents ran do not count)."""
    from pga.hub.connectors import CLAUDE_CODE_DIR, CODEX_DIRS
    cutoff, best = time.time() - within_s, 0.0
    files: list[tuple[Path, str]] = []
    if CLAUDE_CODE_DIR.is_dir():
        files += [(f, "claude") for f in CLAUDE_CODE_DIR.glob("*/*.jsonl")]
    for r in CODEX_DIRS[:1]:
        if r.is_dir():
            files += [(f, "codex") for f in r.glob("**/*.jsonl")]
    for f, kind in files:
        try:
            m = f.stat().st_mtime
        except OSError:
            continue
        if m < cutoff or m <= best:
            continue
        key = str(f)
        if key not in _MINE:
            _MINE[key] = _mine_claude(f) if kind == "claude" else _mine_codex(f)
        if _MINE[key]:
            best = m
    from datetime import timezone
    return datetime.fromtimestamp(best, timezone.utc) if best else None


# ---------------------------------------------------------------- the check, every half minute (from the perpetual runner)

def tick(session: "Session", now: datetime | None = None, rt=None) -> dict:
    from pga.owner import owner_id
    now = now or utcnow()
    uid = owner_id(session)
    u = session.get(User, uid) if uid else None
    if u is None:
        return {"state": "no owner"}
    c, st = cfg(u), state(u)
    last = _ts(st.get("last"))
    if last is None:                                     # the clock starts now, not at the beginning of time
        st["last"] = now.isoformat()
        _save(u, st)
        return {"state": "started the clock"}
    there = local_activity(within_s=max(120.0, (now - last).total_seconds() + 60))
    if there and there > last + timedelta(seconds=5):    # you are working elsewhere on this machine: that counts
        paused = touch(session, u, max(there, last), force=True, rt=rt)
        return {"state": "you are here (another app)", "paused": paused}
    running = auto_tasks(session, u.id)
    if running:
        return {"state": "running while you are away", "auto": [str(t.id) for t in running]}
    if not c["on"] or now - last < timedelta(minutes=c["minutes"]):
        return {"state": "waiting", "idle_min": round((now - last).total_seconds() / 60, 1)}
    eng = _engine(session, rt)
    started = []
    for t in session.scalars(select(PerpetualTask).where(PerpetualTask.user_id == u.id, PerpetualTask.status == "paused")):
        if not eng.cfg(t).get("idle_auto", True) or t.project_id is None:
            continue
        eng.set_status(t, "running", now, auto=True)
        _mark(t, now.isoformat())
        started.append(str(t.id))
    if started:
        log.info("you have been away %s min: %d motivation(s) start on their own", c["minutes"], len(started))
    session.flush()
    return {"state": "started" if started else "nothing to start", "auto": started}
