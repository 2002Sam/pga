"""Show PGA's own words in another language (the English version of the forest and the trees).

Nodes, summaries, the personal model and the dialogue are written in your language (Chinese); the English pages ask for
them in English. Each piece is translated once and kept (translation_cache, keyed by text and target language), several
pieces per model call, so opening a tree in English the second time costs nothing.
"""

from __future__ import annotations

import hashlib
import logging
import re
from typing import TYPE_CHECKING

from pga.db.models import TranslationCacheEntry

if TYPE_CHECKING:
    from pga.runtime import Runtime

log = logging.getLogger("pga.i18n")

_CJK = re.compile(r"[㐀-鿿]")
BATCH_ITEMS, BATCH_CHARS = 24, 9000
NAMES = {"en": "English", "zh": "Simplified Chinese"}


def _key(text: str, lang: str) -> str:
    return hashlib.sha256(f"pga-i18n|{lang}|{text}".encode()).hexdigest()


def needs(text: str, lang: str) -> bool:
    """English pages need translating only what is written in Chinese (and the other way round)."""
    if not (text or "").strip():
        return False
    has_cjk = bool(_CJK.search(text))
    return has_cjk if lang == "en" else not has_cjk and lang == "zh" and bool(re.search(r"[A-Za-z]{3,}", text))


def translate_many(rt: "Runtime", texts: list[str], lang: str = "en") -> list[str]:
    """The texts in `lang`, in order; anything already in that language comes back as it is."""
    lang = "en" if lang.lower().startswith("en") else "zh"
    out = list(texts)
    todo: list[int] = []
    s = rt.session
    for i, t in enumerate(texts):
        if not needs(t, lang):
            continue
        hit = s.get(TranslationCacheEntry, _key(t, lang))
        if hit is not None:
            out[i] = hit.result
            hit.hits += 1
        else:
            todo.append(i)
    batch: list[int] = []
    size = 0
    for i in todo + [-1]:
        if i >= 0 and len(batch) < BATCH_ITEMS and size + len(texts[i]) < BATCH_CHARS:
            batch.append(i)
            size += len(texts[i])
            continue
        if batch:
            done = _call(rt, [texts[j] for j in batch], lang)
            for j, r in zip(batch, done):
                if r:
                    out[j] = r
                    s.merge(TranslationCacheEntry(key=_key(texts[j], lang), source_lang="zh" if lang == "en" else "en",
                                                  target_lang=lang, result=r))
        batch, size = ([i], len(texts[i])) if i >= 0 else ([], 0)
    s.flush()
    return out


def _call(rt: "Runtime", items: list[str], lang: str) -> list[str | None]:
    """One model call for several pieces, marked ⟦0⟧ ⟦1⟧ …; pieces that do not come back are retried one by one."""
    prov, model = rt.router.provider, rt.router.model_for(1)
    system = (f"Translate each numbered piece into {NAMES[lang]}. Keep the markers ⟦n⟧ exactly, one piece per marker, in order. "
              "Keep Markdown, code, file paths, commands, product and model names unchanged. Output only the translated pieces.")

    def ask(text: str) -> str:
        return prov.complete(model=model, system=system, messages=[{"role": "user", "content": text}],
                             max_tokens=min(8000, len(text) * 3 + 200), temperature=None).text

    joined = "\n".join(f"⟦{i}⟧ {t}" for i, t in enumerate(items))
    try:
        res = ask(joined)
    except Exception as exc:  # noqa: BLE001 - shown in the original language this time
        log.info("translation failed: %s", exc)
        return [None] * len(items)
    parts = {int(m.group(1)): m.group(2).strip() for m in re.finditer(r"⟦(\d+)⟧\s*(.*?)(?=⟦\d+⟧|\Z)", res, re.S)}
    out: list[str | None] = []
    for i, t in enumerate(items):
        r = parts.get(i)
        if not r and len(items) > 1:
            try:
                r = ask(f"⟦0⟧ {t}")
                r = re.sub(r"^\s*⟦0⟧\s*", "", r).strip()
            except Exception:  # noqa: BLE001
                r = None
        out.append(r or None)
    return out


# ---------------------------------------------------------------- whole responses, for the English pages

def localize_tree(rt: "Runtime", out: dict, lang: str) -> dict:
    """A tree as /tree returns it, with titles, summaries, key thoughts, shifts, buds and shadow paths in `lang`."""
    if not lang or lang.startswith("zh"):
        return out
    texts: list[str] = [out.get("aim", {}).get("text") or ""]
    for n in out.get("nodes") or []:
        texts += [n.get("title") or "", n.get("summary") or "", n.get("shift") or "", *(n.get("key_thoughts") or []),
                  *(b.get("idea") or "" for b in n.get("buds") or []), *(x.get("conclusion") or "" for x in n.get("shadows") or []),
                  *(x.get("assumption") or "" for x in n.get("shadows") or []), n.get("with_title") or ""]
    k = out.get("knowledge") or {}
    bodies = [b for b in [k.get("user"), k.get("world"), *(k.get("datasets") or []), *(k.get("skills") or []), *(k.get("references") or [])] if b]
    for b in bodies:
        texts += [b.get("title") or "", b.get("gist") or ""]
    tr = iter(translate_many(rt, texts, lang))
    out["aim"]["text"] = next(tr)
    for n in out.get("nodes") or []:
        n["title"], n["summary"], n["shift"] = next(tr), next(tr), next(tr)
        n["key_thoughts"] = [next(tr) for _ in n.get("key_thoughts") or []]
        for b in n.get("buds") or []:
            b["idea"] = next(tr)
        for x in n.get("shadows") or []:
            x["conclusion"] = next(tr)
        for x in n.get("shadows") or []:
            x["assumption"] = next(tr)
        n["with_title"] = next(tr) or n.get("with_title")
    for b in bodies:
        b["title"], b["gist"] = next(tr), next(tr) or None
    return out


def localize_node(rt: "Runtime", out: dict, lang: str) -> dict:
    """A node's detail: its own words and the path in `lang` (the turns are translated as they are shown)."""
    if not lang or lang.startswith("zh"):
        return out
    texts = [out.get("title") or "", out.get("summary") or "", out.get("shift") or "", *(out.get("key_thoughts") or []),
             *(p.get("title") or "" for p in out.get("path") or []), *(c.get("title") or "" for c in out.get("children") or [])]
    tr = iter(translate_many(rt, texts, lang))
    out["title"], out["summary"], out["shift"] = next(tr), next(tr), next(tr)
    out["key_thoughts"] = [next(tr) for _ in out.get("key_thoughts") or []]
    for p in out.get("path") or []:
        p["title"] = next(tr)
    for c in out.get("children") or []:
        c["title"] = next(tr)
    return out


def localize_forest(rt: "Runtime", out: dict, lang: str) -> dict:
    if not lang or lang.startswith("zh"):
        return out
    trees = list(out.get("trees") or []) + ([out["you"]] if out.get("you") else [])
    texts: list[str] = []
    for t in trees:
        texts += [t.get("text") or "", *(n.get("title") or "" for n in t.get("nodes") or [])]
    for k in out.get("knowledge") or []:
        texts += [k.get("title") or "", k.get("gist") or "", k.get("brief") or ""]
    tr = iter(translate_many(rt, texts, lang))
    for t in trees:
        t["text"] = next(tr)
        for n in t.get("nodes") or []:
            n["title"] = next(tr)
    for k in out.get("knowledge") or []:
        k["title"], k["gist"], k["brief"] = next(tr), next(tr) or None, next(tr) or None
    return out
