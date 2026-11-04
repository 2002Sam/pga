"""备忘: free-standing memos you open from the top-right (＋ 新备忘). Each is a Markdown file kept verbatim; paragraphs are
separated by a blank line (two Enters). A paragraph that is only `![](img/<name>)` is a picture, only `[[ref:<kind>:<key>|<title>]]`
is a link to something in PGA (a conversation, a document). Pictures sit beside the memos in img/. PGA never edits a memo."""
from __future__ import annotations

import base64
import json
import re
import time
import uuid
from pathlib import Path

from pga.agents.pool import ROOT

MEMO_DIR = ROOT.parent / "notes" / "memos"       # ~/Documents/PGA/notes/memos/<user>/<id>.md
MAX_BYTES = 1_000_000
MAX_IMG = 12_000_000
_ID = re.compile(r"^[a-z0-9]{6,20}$")
_IMG = re.compile(r"^[a-z0-9]{6,20}\.(png|jpg|gif|webp)$")
_MIME = {"image/png": "png", "image/jpeg": "jpg", "image/gif": "gif", "image/webp": "webp"}


class MemoConflict(ValueError):
    """The memo changed in another window since this one loaded it."""


def _dir(user_id: uuid.UUID) -> Path:
    return MEMO_DIR / str(user_id)


def _check(mid: str) -> str:
    if not _ID.match(mid or ""):
        raise ValueError("bad memo id")
    return mid


def _meta(d: Path, mid: str) -> dict:
    try:
        return json.loads((d / f"{mid}.json").read_text())
    except (OSError, ValueError):
        return {}


def _title(text: str) -> str:
    for line in (text or "").splitlines():
        line = re.sub(r"!\[\]\([^)]*\)|\[\[ref:[^|\]]*\|([^\]]*)\]\]", r"\1", line).strip().lstrip("#").strip()
        if line:
            return line[:60]
    return ""


def listing(user_id: uuid.UUID) -> list[dict]:
    d = _dir(user_id)
    out = []
    for p in d.glob("*.md") if d.exists() else []:
        m = _meta(d, p.stem)
        try:
            text = p.read_text()
        except OSError:
            continue
        out.append({"id": p.stem, "title": m.get("title") or _title(text) or "", "updated": m.get("updated") or "",
                    "ts": p.stat().st_mtime})
    return sorted(out, key=lambda x: -x["ts"])


def create(user_id: uuid.UUID) -> dict:
    mid = uuid.uuid4().hex[:10]
    return write(user_id, mid, "", None, new=True)


def read(user_id: uuid.UUID, mid: str) -> dict:
    d = _dir(user_id)
    p = d / f"{_check(mid)}.md"
    if not p.exists():
        raise FileNotFoundError(mid)
    m = _meta(d, mid)
    return {"id": mid, "text": p.read_text(), "rev": int(m.get("rev") or 0), "updated": m.get("updated") or "", "path": str(p)}


def write(user_id: uuid.UUID, mid: str, text: str, rev: int | None, new: bool = False) -> dict:
    d = _dir(user_id)
    d.mkdir(parents=True, exist_ok=True)
    p = d / f"{_check(mid)}.md"
    if not new and not p.exists():
        raise FileNotFoundError(mid)
    m = _meta(d, mid)
    cur = int(m.get("rev") or 0)
    if rev is not None and int(rev) != cur:
        raise MemoConflict("the memo changed in another window; reload it")
    if len(text.encode()) > MAX_BYTES:
        raise ValueError("the memo is over 1 MB")
    tmp = d / f"{mid}.md.tmp"
    tmp.write_text(text)
    tmp.replace(p)
    m.update({"rev": cur + 1, "updated": time.strftime("%Y-%m-%dT%H:%M:%S")})
    (d / f"{mid}.json").write_text(json.dumps(m, ensure_ascii=False))
    return read(user_id, mid)


def delete(user_id: uuid.UUID, mid: str) -> None:
    """Moved to .trash/ rather than erased."""
    d = _dir(user_id)
    t = d / ".trash"
    t.mkdir(parents=True, exist_ok=True)
    for ext in ("md", "json"):
        p = d / f"{_check(mid)}.{ext}"
        if p.exists():
            p.replace(t / f"{int(time.time())}-{p.name}")


def save_image(user_id: uuid.UUID, data_url: str) -> str:
    m = re.match(r"^data:(image/[a-z+.-]+);base64,(.*)$", data_url or "", re.S)
    if not m or m.group(1) not in _MIME:
        raise ValueError("only png, jpeg, gif and webp pictures")
    raw = base64.b64decode(m.group(2), validate=False)
    if len(raw) > MAX_IMG:
        raise ValueError("the picture is over 12 MB")
    d = _dir(user_id) / "img"
    d.mkdir(parents=True, exist_ok=True)
    name = f"{uuid.uuid4().hex[:12]}.{_MIME[m.group(1)]}"
    (d / name).write_bytes(raw)
    return name


def image_path(user_id: uuid.UUID, name: str) -> Path:
    if not _IMG.match(name or ""):
        raise FileNotFoundError(name)
    p = _dir(user_id) / "img" / name
    if not p.exists():
        raise FileNotFoundError(name)
    return p
