"""常驻笔记: the notepad on the right of every page. You write in it, and a blank line starts a new idea. Any idea can
be handed to an agent, and its answer appears on the canvas.

The page is kept verbatim as a Markdown file; PGA never edits it. Every so often the previous text is copied into
history/, so nothing written is lost. What was handed to whom is kept beside it (meta.json), not in the page."""
from __future__ import annotations

import json
import re
import time
import uuid
from pathlib import Path

from pga.agents.pool import ROOT

PAD_DIR = ROOT.parent / "notes" / "pad"          # ~/Documents/PGA/notes/pad/<user>/pad.md
SNAPSHOT_EVERY_S = 600
MAX_BYTES = 2_000_000


class PadConflict(ValueError):
    """The page changed in another window since this one loaded it."""


def _dir(user_id: uuid.UUID) -> Path:
    return PAD_DIR / str(user_id)


def _meta(user_id: uuid.UUID) -> dict:
    try:
        return json.loads((_dir(user_id) / "meta.json").read_text())
    except (OSError, ValueError):
        return {}


def ideas(text: str) -> list[str]:
    """The ideas on the page: the paragraphs, a blank line (two Enters) between them."""
    return [p.strip() for p in re.split(r"\n\s*\n", text or "") if p.strip()]


def read(user_id: uuid.UUID) -> dict:
    p = _dir(user_id) / "pad.md"
    m = _meta(user_id)
    try:
        text = p.read_text()
    except OSError:
        text = ""
    return {"text": text, "rev": int(m.get("rev") or 0), "sent": m.get("sent") or [], "path": str(p), "saved_at": m.get("saved_at")}


def write(user_id: uuid.UUID, text: str | None = None, rev: int | None = None, sent: list | None = None) -> dict:
    """Save the page as it is (and/or the list of ideas handed out). A save from a window that loaded an older page is
    refused rather than written over the newer one."""
    d = _dir(user_id)
    d.mkdir(parents=True, exist_ok=True)
    m = _meta(user_id)
    cur = int(m.get("rev") or 0)
    if text is not None:
        if rev is not None and int(rev) != cur:
            raise PadConflict("the notepad changed in another window; reload it")
        if len(text.encode()) > MAX_BYTES:
            raise ValueError("the notepad is over 2 MB; start a new page")
        p = d / "pad.md"
        old = p.read_text() if p.exists() else ""
        if old != text:
            now = time.time()
            if old.strip() and now - float(m.get("snap_at") or 0) > SNAPSHOT_EVERY_S:
                h = d / "history"
                h.mkdir(exist_ok=True)
                (h / time.strftime("%Y%m%d-%H%M%S.md")).write_text(old)
                m["snap_at"] = now
            tmp = d / "pad.md.tmp"
            tmp.write_text(text)
            tmp.replace(p)
            m["rev"] = cur + 1
            m["saved_at"] = time.strftime("%Y-%m-%dT%H:%M:%S")
    if sent is not None:
        m["sent"] = [x for x in sent if isinstance(x, dict)][-500:]
    (d / "meta.json").write_text(json.dumps(m, ensure_ascii=False))
    return read(user_id)
