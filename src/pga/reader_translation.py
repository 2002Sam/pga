"""Translate reader paragraphs with embedded offline or direct cloud translation and a durable cache."""
from __future__ import annotations

import hashlib
import json
import re
from collections.abc import Callable
from contextlib import nullcontext
from functools import partial
from typing import Literal

from pydantic import BaseModel, ConfigDict, Field, model_validator
from sqlalchemy import select, text

from pga.db.models import TranslationCacheEntry
from pga.translation.reader_local import translate_local
from pga.translation.reader_providers import ReaderTranslationError, cloud_translator
from pga.translation.spans import Span, SpanIntegrityError, find_spans, mark_up, restore


class Paragraph(BaseModel):
    model_config = ConfigDict(extra="forbid", strict=True)
    id: str = Field(pattern=r"^p[0-9]+$", max_length=20)
    text: str = Field(min_length=1, max_length=3000)


class ReaderTranslation(BaseModel):
    model_config = ConfigDict(extra="forbid", strict=True)
    engine: Literal["builtin"] = "builtin"
    service: Literal["Local", "Bing", "Google", "Youdao"] = "Local"
    target: Literal["zh-CN", "en"] = "zh-CN"
    title: str = Field(default="", max_length=500)
    blocks: list[Paragraph] = Field(min_length=1, max_length=6)

    @model_validator(mode="after")
    def bounded(self):
        if len({b.id for b in self.blocks}) != len(self.blocks):
            raise ValueError("duplicate paragraph IDs")
        if sum(len(b.text) for b in self.blocks) > 6000 or any(not b.text.strip() for b in self.blocks):
            raise ValueError("empty or excessive translation text")
        return self


def translate(rt, user, body: ReaderTranslation) -> list[dict]:
    body = ReaderTranslation.model_validate(body.model_dump())
    # Keep the old reader key. A service switch affects only text with no saved translation.
    keys = {b.text: hashlib.sha256(json.dumps(
        ["reader", str(user.id), body.target, b.text], ensure_ascii=False
    ).encode()).hexdigest() for b in body.blocks}
    session = rt.session

    def saved(keys_to_read):
        return dict(session.execute(select(TranslationCacheEntry.key, TranslationCacheEntry.result)
                                    .where(TranslationCacheEntry.key.in_(keys_to_read))).all())

    cached = saved(keys.values())
    missing = sorted(set(keys.values()) - cached.keys())
    if missing and session.get_bind().dialect.name == "postgresql":
        # Two tabs can request overlapping batches. Lock in a stable order until the request commits.
        for key in missing:
            lock_id = int.from_bytes(bytes.fromhex(key[:16]), "big", signed=True)
            session.execute(text("SELECT pg_advisory_xact_lock(:id)"), {"id": lock_id})
        cached.update(saved(missing))

    pending = {}
    for block in body.blocks:
        if keys[block.text] not in cached:
            pending.setdefault(block.text, block)
    errors = {}
    if pending:
        batch = body.model_copy(update={"blocks": list(pending.values())})
        try:
            results = _translate_batch(batch)
        except ReaderTranslationError as exc:
            if not cached:
                raise
            results = [{"error": str(exc)} for _ in batch.blocks]
        for block, result in zip(batch.blocks, results, strict=True):
            key = keys[block.text]
            if "error" in result:
                errors[key] = result["error"]
            else:
                cached[key] = result["text"]
                session.add(TranslationCacheEntry(key=key, source_lang="auto", target_lang=body.target, result=result["text"]))
        session.flush()
    return [{"id": b.id, **({"text": cached[keys[b.text]]} if keys[b.text] in cached
                            else {"error": errors[keys[b.text]]})} for b in body.blocks]


# Numeric citation markers survive ordinary text translation. find_spans also protects
# literal source citations, so an original [9010] will itself be escaped and restored.
_TAG = re.compile(r'<ph id="(\d+)"/>')
_MARK = re.compile(r'\[901([0-9]+)\]')


def _translate_paragraph(request: Callable[[str], str], source: str, spans: list[Span]) -> dict[str, str]:
    try:
        translated = request(source)
        if not translated.strip() or len(translated) > 16000:
            raise ValueError("未能返回完整译文，请重试或切换翻译服务。")
        return {"text": restore(_MARK.sub(r'<ph id="\1"/>', translated), spans)}
    except SpanIntegrityError:
        return {"error": "公式、代码或引用未能完整还原，请切换翻译服务后重试。"}
    except ValueError as exc:
        return {"error": str(exc)}


def _translate_batch(body: ReaderTranslation) -> list[dict]:
    results, pending = {}, {}
    for block in body.blocks:
        spans = find_spans(block.text)
        source = _TAG.sub(r'[901\1]', mark_up(block.text, spans, visible_max_chars=0))
        if any(ch.isalpha() for ch in source):
            pending[block.id] = (source, spans)
        else:
            results[block.id] = {"text": block.text}

    if pending:
        translator = (nullcontext(partial(translate_local, target=body.target)) if body.service == "Local"
                      else cloud_translator(body.service, body.target))
        try:
            with translator as request:
                for block_id, (source, spans) in pending.items():
                    results[block_id] = _translate_paragraph(request, source, spans)
        except ReaderTranslationError as exc:
            if not results:
                raise
            for block_id in pending:
                results.setdefault(block_id, {"error": str(exc)})
    return [{"id": b.id, **results[b.id]} for b in body.blocks]
