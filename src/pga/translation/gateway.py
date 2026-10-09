"""Translation Gateway (spec §10): Chinese UI ⇄ canonical English agent.

Translation is middleware. The main agent only ever sees `canonical_en`; users
only ever see `display_text`. Model history is always rebuilt from canonical
text, which is what prevents translation loops (zh→en→zh→en drift).
"""

from __future__ import annotations

import hashlib
import uuid
from dataclasses import dataclass

from sqlalchemy import select
from sqlalchemy.orm import Session

from pga.config import Policy
from pga.db.models import Message, TranslationCacheEntry, User
from pga.db.types import MessageRole, TranslationStatus

from .detect import base_lang, detect_language, is_english, requested_output_language
from .glossary import GlossaryService
from .translator import TranslationBackend, TranslationOutcome, translate_text


@dataclass
class Rendered:
    text: str
    language: str
    status: TranslationStatus
    spans: list[dict]
    error: str | None = None


class TranslationGateway:
    def __init__(self, session: Session, backend: TranslationBackend, policy: Policy):
        self.session = session
        self.backend = backend
        self.policy = policy
        self.glossary = GlossaryService(session, policy.translation.do_not_translate)

    # ---------------------------------------------------------------- core

    def translate(self, text: str, source_lang: str, target_lang: str,
                  user_id: uuid.UUID | None = None) -> TranslationOutcome:
        terms = self.glossary.terms_for(user_id, source_lang, target_lang, text)
        dnt = self.glossary.do_not_translate(user_id)
        key = None
        if self.policy.translation.cache:
            fp = GlossaryService.fingerprint(terms, dnt)
            key = hashlib.sha256(f"{base_lang(source_lang)}|{target_lang}|{fp}|{text}".encode()).hexdigest()
            hit = self.session.get(TranslationCacheEntry, key)
            if hit:
                hit.hits += 1
                return TranslationOutcome(text=hit.result, ok=True, spans=[], attempts=0)
        outcome = translate_text(self.backend, text, source_lang, target_lang, glossary=terms,
                                 do_not_translate=dnt,
                                 visible_span_max_chars=self.policy.translation.visible_span_max_chars,
                                 max_retries=self.policy.translation.max_retries)
        if key and outcome.ok and not outcome.skipped:
            self.session.merge(TranslationCacheEntry(key=key, source_lang=base_lang(source_lang),
                                                     target_lang=target_lang, result=outcome.text))
        return outcome

    def render(self, canonical_en: str, target_lang: str, user_id: uuid.UUID | None = None) -> Rendered:
        """English canonical text → user locale. Used for replies, notifications and artifacts."""
        if is_english(target_lang):
            return Rendered(canonical_en, target_lang, TranslationStatus.NOT_NEEDED, [])
        out = self.translate(canonical_en, "en", target_lang, user_id)
        if out.skipped:
            return Rendered(canonical_en, target_lang, TranslationStatus.NOT_NEEDED, _spans(out))
        if not out.ok:
            # fail safe: show the English rather than nothing or a half-translation
            return Rendered(canonical_en, "en", TranslationStatus.FAILED, _spans(out), out.error)
        return Rendered(out.text, target_lang, TranslationStatus.TRANSLATED, _spans(out))

    def to_canonical(self, text: str, user_id: uuid.UUID | None = None,
                     language: str | None = None) -> tuple[str, str, TranslationStatus, list[dict]]:
        """Any-language text → canonical English. Returns (canonical, detected_lang, status, spans)."""
        lang = language or detect_language(text)
        if is_english(lang) or lang == "und":
            return text, lang, TranslationStatus.NOT_NEEDED, []
        out = self.translate(text, lang, "en", user_id)
        if out.skipped:
            return text, lang, TranslationStatus.NOT_NEEDED, _spans(out)
        if not out.ok:
            # the primary model reads Chinese well enough to proceed; flag it for review
            return text, lang, TranslationStatus.FAILED, _spans(out)
        return out.text, lang, TranslationStatus.TRANSLATED, _spans(out)

    # ---------------------------------------------------------------- messages

    def inbound(self, user: User, conversation_id: uuid.UUID, raw_text: str) -> Message:
        canonical, lang, status, spans = self.to_canonical(raw_text, user.id)
        msg = Message(user_id=user.id, conversation_id=conversation_id, role=MessageRole.USER,
                      raw_text=raw_text, raw_language=lang, canonical_en=canonical,
                      display_text=raw_text, display_language=lang, protected_spans=spans,
                      translation_status=status, requested_output_language=requested_output_language(raw_text))
        self.session.add(msg)
        self.session.flush()
        return msg

    def output_language(self, user: User, reply_to: Message | None) -> tuple[str, bool]:
        """(language, explicit). Explicit request > stored preference > UI locale (§10.7)."""
        if reply_to is not None and reply_to.requested_output_language:
            return reply_to.requested_output_language, True
        pref = (user.preferences or {}).get("output_language")
        if pref == "mirror_input" and reply_to is not None and reply_to.raw_language not in (None, "und"):
            return reply_to.raw_language, False
        if pref and pref != "mirror_input":
            return pref, True
        return user.locale, False

    def outbound(self, user: User, conversation_id: uuid.UUID, canonical_en: str,
                 reply_to: Message | None = None) -> Message:
        target, explicit = self.output_language(user, reply_to)
        rendered = self.render(canonical_en, target, user.id)
        status = rendered.status
        if is_english(target) and explicit and not is_english(user.locale):
            status = TranslationStatus.BYPASSED
        msg = Message(user_id=user.id, conversation_id=conversation_id, role=MessageRole.ASSISTANT,
                      raw_text=canonical_en, raw_language="en", canonical_en=canonical_en,
                      display_text=rendered.text, display_language=rendered.language,
                      protected_spans=rendered.spans, translation_status=status,
                      source_message_id=reply_to.id if reply_to else None)
        self.session.add(msg)
        self.session.flush()
        return msg

    def model_history(self, conversation_id: uuid.UUID, limit: int = 40) -> list[dict[str, str]]:
        """Conversation as the model sees it: canonical English only, never display text."""
        rows = list(self.session.scalars(
            select(Message).where(Message.conversation_id == conversation_id,
                                  Message.role.in_([MessageRole.USER, MessageRole.ASSISTANT]))
            .order_by(Message.created_at.desc()).limit(limit)))
        rows.reverse()
        return [{"role": m.role.value, "content": m.canonical_en or m.raw_text} for m in rows]

    def normalize_external(self, text: str, user_id: uuid.UUID | None = None) -> tuple[str, str, TranslationStatus]:
        """Non-English tool results / sources → English before the main model sees them (§10.4).
        Callers keep the raw source reference separately."""
        canonical, lang, status, _ = self.to_canonical(text, user_id)
        return canonical, lang, status


def _spans(out: TranslationOutcome) -> list[dict]:
    return [{"id": s.id, "kind": s.kind, "start": s.start, "end": s.end, "text": s.text} for s in out.spans]
