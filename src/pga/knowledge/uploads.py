"""Documents you put into the knowledge base yourself (the way Open WebUI's knowledge collections work, without a
vector store): the file is kept on this machine, its text read here (agents/files.extract), and stored as a dataset
(a Body with data.source = "upload"). When a conversation refers to it, only the passages that match what you are
asking go to the agent — lexical scoring over words and Chinese character pairs, like tree.related — so a long
document does not flood the context.
"""
from __future__ import annotations

import base64
import math
import re
import uuid
from pathlib import Path
from typing import TYPE_CHECKING

from pga.db.models import Body
from pga.db.types import Origin, utcnow

if TYPE_CHECKING:
    from pga.runtime import Runtime

ROOT = Path.home() / "Documents" / "PGA" / "state" / "uploads"
MAX_BYTES = 30_000_000
CHUNK = 1200                                     # characters per passage
TOP = 6                                          # passages per referenced document


class UploadError(ValueError):
    pass


def save(rt: "Runtime", user_id: uuid.UUID, name: str, data_url: str, aim_id: uuid.UUID | None = None) -> Body:
    from pga.agents.files import extract
    m = re.match(r"data:[^;,]*(;[^,]*)?;base64,(.+)", data_url or "", re.S)
    if not m:
        raise UploadError("the file did not come through")
    raw = base64.b64decode(m.group(2), validate=False)
    if len(raw) > MAX_BYTES:
        raise UploadError("the file is over 30 MB")
    safe = re.sub(r"[^\w.\-一-鿿]", "_", name or "document")[:100] or "document"
    d = ROOT / str(user_id)
    d.mkdir(parents=True, exist_ok=True)
    p = d / f"{utcnow():%Y%m%d-%H%M%S}-{safe}"
    p.write_bytes(raw)
    text, how = extract(p)
    text = re.sub(r"\n{3,}", "\n\n", (text or "").replace("\r", "")).strip()
    if not text:
        p.unlink(missing_ok=True)
        raise UploadError(f"cannot read {safe} here ({how})")
    title = re.sub(r"\.[A-Za-z0-9]{1,5}$", "", safe).replace("_", " ").strip() or safe
    b = Body(user_id=user_id, aim_id=aim_id, kind="database", title=title[:200], title_en=title[:200], description=text,
             description_en=text, origin=Origin.USER, compiled_at=utcnow(),
             data={"source": "upload", "file": str(p), "name": safe, "chars": len(text), "how": how, "passages": math.ceil(len(text) / CHUNK)})
    rt.session.add(b)
    rt.session.flush()
    return b


def chunks(text: str) -> list[str]:
    """Passages of about CHUNK characters, cut at paragraph ends where possible."""
    out, cur = [], ""
    for para in re.split(r"\n\s*\n", text):
        para = para.strip()
        if not para:
            continue
        while len(para) > CHUNK * 1.5:              # a very long paragraph: cut it at a sentence end near the limit
            cut = max(para.rfind(x, 0, CHUNK) for x in ("。", ". ", "！", "？", "\n", "; "))
            cut = cut + 1 if cut > CHUNK // 2 else CHUNK
            out.append((cur + "\n\n" + para[:cut]).strip() if cur else para[:cut])
            cur, para = "", para[cut:].strip()
        if cur and len(cur) + len(para) > CHUNK:
            out.append(cur)
            cur = ""
        cur = (cur + "\n\n" + para).strip()
    if cur:
        out.append(cur)
    return out


def _grams(t: str) -> list[str]:
    t = (t or "").lower()
    words = re.findall(r"[a-z0-9_]{2,}", t)
    han = re.sub(r"[^㐀-鿿]", "", t)
    return words + [han[i:i + 2] for i in range(len(han) - 1)]


def best(text: str, question: str, k: int = TOP) -> list[tuple[int, str]]:
    """The passages that answer the question best (BM25 over words and character pairs), in document order.
    Without a question (or nothing matching): the first passages."""
    parts = chunks(text)
    q = set(_grams(question))
    if not q or len(parts) <= k:
        return list(enumerate(parts[:k]))
    docs = [_grams(p) for p in parts]
    n, avg = len(docs), sum(len(d) for d in docs) / max(1, len(docs))
    df = {g: sum(1 for d in docs if g in d) for g in q}
    scored = []
    for i, d in enumerate(docs):
        tf: dict[str, int] = {}
        for g in d:
            if g in q:
                tf[g] = tf.get(g, 0) + 1
        s = sum(math.log(1 + (n - df[g] + .5) / (df[g] + .5)) * (c * 2.2) / (c + 1.2 * (.25 + .75 * len(d) / avg)) for g, c in tf.items())
        scored.append((s, i))
    top = [i for s, i in sorted(scored, reverse=True)[:k] if s > 0]
    if not top:
        return list(enumerate(parts[:k]))
    return [(i, parts[i]) for i in sorted(top)]


def context(b: Body, question: str) -> str:
    picks = best(b.description_en or b.description, question)
    total = (b.data or {}).get("passages") or len(chunks(b.description_en or b.description))
    head = f'<referenced_document title="{b.title[:80]}" passages="{len(picks)} of {total}" note="the passages most related to the question">'
    return head + "\n" + "\n\n".join(f"[passage {i + 1}]\n{p}" for i, p in picks) + "\n</referenced_document>"
