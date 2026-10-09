"""Glossary / translation memory (spec §10.9–10.10)."""

from __future__ import annotations

import hashlib
import uuid
from dataclasses import dataclass

from sqlalchemy import or_, select
from sqlalchemy.orm import Session

from pga import audit
from pga.db.models import GlossaryEntry
from pga.db.types import Origin

from .detect import base_lang

# Stable product vocabulary, both directions are derived from one entry.
SEED_GLOSSARY: list[tuple[str, str, str, str]] = [
    ("zh", "en", "责任紧张度", "Responsibility Tension"),
    ("zh", "en", "处境模型", "Situation Model"),
    ("zh", "en", "资源分配器", "Resource Allocator"),
    ("zh", "en", "自由探索", "free exploration"),
    ("zh", "en", "候选责任", "candidate responsibility"),
    ("zh", "en", "长期责任", "perpetual responsibility"),
    ("zh", "en", "证据", "evidence"),
    ("zh", "en", "假设", "hypothesis"),
    ("zh", "en", "成果物", "artifact"),
]


@dataclass(frozen=True)
class Term:
    source: str
    target: str
    origin: str


def _is_ascii_word(term: str) -> bool:
    return term.isascii()


def _appears(term: str, text: str) -> bool:
    if _is_ascii_word(term):
        return term.lower() in text.lower()
    return term in text


class GlossaryService:
    def __init__(self, session: Session, default_dnt: list[str] | None = None):
        self.session = session
        self.default_dnt = list(default_dnt or [])

    def seed(self) -> int:
        added = 0
        for src, tgt, s, t in SEED_GLOSSARY:
            exists = self.session.scalar(select(GlossaryEntry.id).where(
                GlossaryEntry.user_id.is_(None), GlossaryEntry.source_lang == src,
                GlossaryEntry.target_lang == tgt, GlossaryEntry.source_term == s))
            if not exists:
                self.session.add(GlossaryEntry(source_lang=src, target_lang=tgt, source_term=s,
                                               target_term=t, origin="seed"))
                added += 1
        self.session.flush()
        return added

    def _entries(self, user_id: uuid.UUID | None) -> list[GlossaryEntry]:
        cond = GlossaryEntry.user_id.is_(None)
        if user_id:
            cond = or_(cond, GlossaryEntry.user_id == user_id)
        return list(self.session.scalars(select(GlossaryEntry).where(cond)))

    def terms_for(self, user_id: uuid.UUID | None, source_lang: str, target_lang: str, text: str) -> list[Term]:
        """Entries relevant to `text`, in either stored direction. User entries beat global ones."""
        src, tgt = base_lang(source_lang), base_lang(target_lang)
        chosen: dict[str, tuple[int, Term]] = {}
        for e in self._entries(user_id):
            if e.do_not_translate:
                continue
            es, et = base_lang(e.source_lang), base_lang(e.target_lang)
            if (es, et) == (src, tgt):
                pair = (e.source_term, e.target_term)
            elif (es, et) == (tgt, src):
                pair = (e.target_term, e.source_term)
            else:
                continue
            if not _appears(pair[0], text):
                continue
            rank = 2 if e.user_id else 1
            key = pair[0].lower() if _is_ascii_word(pair[0]) else pair[0]
            if key not in chosen or chosen[key][0] < rank:
                chosen[key] = (rank, Term(pair[0], pair[1], e.origin))
        return [t for _, t in sorted(chosen.values(), key=lambda x: -len(x[1].source))][:50]

    def do_not_translate(self, user_id: uuid.UUID | None) -> list[str]:
        terms = set(self.default_dnt)
        for e in self._entries(user_id):
            if e.do_not_translate:
                terms.add(e.source_term)
        return sorted(terms)

    @staticmethod
    def fingerprint(terms: list[Term], dnt: list[str]) -> str:
        h = hashlib.sha256()
        for t in sorted(terms, key=lambda x: x.source):
            h.update(f"{t.source}\x1f{t.target}\x1e".encode())
        h.update("\x1d".join(sorted(dnt)).encode())
        return h.hexdigest()[:16]

    def correct(self, user_id: uuid.UUID, source_lang: str, target_lang: str,
                source_term: str, corrected_target: str) -> GlossaryEntry:
        """A user's translation correction becomes a user-scoped glossary entry (§10.10)."""
        src, tgt = base_lang(source_lang), base_lang(target_lang)
        entry = self.session.scalar(select(GlossaryEntry).where(
            GlossaryEntry.user_id == user_id, GlossaryEntry.source_lang == src,
            GlossaryEntry.target_lang == tgt, GlossaryEntry.source_term == source_term))
        previous = entry.target_term if entry else None
        if entry:
            entry.target_term = corrected_target
            entry.origin = "user_correction"
        else:
            entry = GlossaryEntry(user_id=user_id, source_lang=src, target_lang=tgt,
                                  source_term=source_term, target_term=corrected_target,
                                  origin="user_correction")
            self.session.add(entry)
        self.session.flush()
        audit.record(self.session, kind="glossary.correction", entity_type="glossary_entry",
                     entity_id=entry.id, actor=Origin.USER, user_id=user_id,
                     source_term=source_term, previous=previous, corrected=corrected_target,
                     direction=f"{src}->{tgt}")
        return entry

    def add_do_not_translate(self, user_id: uuid.UUID | None, term: str) -> GlossaryEntry:
        entry = GlossaryEntry(user_id=user_id, source_lang="*", target_lang="*", source_term=term,
                              target_term=term, do_not_translate=True,
                              origin="user_correction" if user_id else "seed")
        self.session.add(entry)
        self.session.flush()
        return entry
