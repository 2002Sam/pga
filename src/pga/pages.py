"""页面: a saved state of the stage — which conversations stand on it, where (order, widths, small pages, wires,
workspaces), how far each had got (its turns, where you were reading, what you had typed and not sent) and when.
You work on one page at a time and switch between them; each page is one JSON file, so they outlive the browser
and are the same in the desktop app and a browser tab.

PGA never reads inside a page's `snap`: the stage writes it and lays it out again. Only its size is checked."""
from __future__ import annotations

import json
import re
import time
from pathlib import Path

from pga.agents.pool import ROOT

PAGES_DIR = ROOT.parent / "state" / "pages"      # ~/Documents/PGA/state/pages/<user>/<page>.json
MAX_BYTES = 2_000_000
MAX_PAGES = 200
_ID = re.compile(r"^[A-Za-z0-9_-]{1,40}$")


class PageError(ValueError):
    """A page id that is not one, a page that is not there, or one too big to keep."""


def _dir(user_id) -> Path:
    return PAGES_DIR / str(user_id)


def _path(user_id, page_id: str) -> Path:
    if not _ID.match(page_id or ""):
        raise PageError("not a page id")
    return _dir(user_id) / f"{page_id}.json"


def _now() -> str:
    return time.strftime("%Y-%m-%dT%H:%M:%S")


def _summary(p: dict) -> dict:
    """A page as the list shows it: its name and times, and its conversations (their keys and how far each had got)."""
    nodes = (p.get("snap") or {}).get("nodes") or []
    wins = [n for n in nodes if isinstance(n, dict) and n.get("type") == "win" and not n.get("pad")]
    wins.sort(key=lambda n: n.get("ord") or 0)
    return {"id": p["id"], "name": p.get("name") or "", "created_at": p.get("created_at"), "updated_at": p.get("updated_at"),
            "chats": [{"key": n.get("key"), "mini": bool(n.get("mini")), "w": n.get("bw"), "ws": n.get("ws"),
                       "prog": n.get("prog") if isinstance(n.get("prog"), dict) else None} for n in wins],
            "ws": (p.get("snap") or {}).get("ws") or {}}


def get(user_id, page_id: str) -> dict:
    try:
        return json.loads(_path(user_id, page_id).read_text())
    except (OSError, ValueError) as exc:
        raise PageError("no such page") from exc


def list_pages(user_id) -> list[dict]:
    """Every page, the one changed last first."""
    out, d = [], _dir(user_id)
    for f in d.glob("*.json") if d.is_dir() else []:
        try:
            out.append(_summary(json.loads(f.read_text())))
        except (OSError, ValueError, KeyError):
            continue
    out.sort(key=lambda p: p.get("updated_at") or "", reverse=True)
    return out


def put(user_id, page_id: str, name: str | None = None, snap: dict | None = None) -> dict:
    """Make a page, or change its name and/or what it holds. Whatever is not given stays as it was."""
    path = _path(user_id, page_id)
    try:
        p = json.loads(path.read_text())
    except (OSError, ValueError):
        if _dir(user_id).is_dir() and len(list(_dir(user_id).glob("*.json"))) >= MAX_PAGES:
            raise PageError(f"already {MAX_PAGES} pages; delete some first") from None
        p = {"id": page_id, "name": "", "created_at": _now(), "snap": {"v": 5, "nodes": [], "ws": {}}}
    if name is not None:
        name = name.strip()[:60]
        if not name:
            raise PageError("a page needs a name")
        p["name"] = name
    if snap is not None:
        if not isinstance(snap, dict) or not isinstance(snap.get("nodes", []), list):
            raise PageError("not a stage")
        p["snap"] = snap
    if not p.get("name"):
        p["name"] = "页面"
    p["updated_at"] = _now()
    text = json.dumps(p, ensure_ascii=False)
    if len(text.encode()) > MAX_BYTES:
        raise PageError("the page is over 2 MB")
    path.parent.mkdir(parents=True, exist_ok=True)
    tmp = path.with_suffix(".json.tmp")
    tmp.write_text(text)
    tmp.replace(path)
    return _summary(p)


def delete(user_id, page_id: str) -> None:
    path = _path(user_id, page_id)
    if not path.exists():
        raise PageError("no such page")
    path.unlink()
