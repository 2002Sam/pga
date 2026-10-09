"""Situation Model (spec §1.1, invariant 5).

Facts, user facts, observations, explicit preferences and inferred preferences are
kept as separate types. Rules:
- External content may only contribute FACT or OBSERVATION (invariant 11).
- USER_FACT and PREFERENCE come from the user; INFERRED_PREFERENCE from the agent.
- An explicit preference supersedes inferred ones on the same topic; an inferred
  preference never overrides an explicit one.
"""

from __future__ import annotations

import uuid
from collections import defaultdict
from datetime import datetime

from sqlalchemy import or_, select
from sqlalchemy.orm import Session

from pga import audit
from pga.db.models import SituationFact
from pga.db.types import FactType, Origin, utcnow


class SituationError(ValueError):
    pass


ALLOWED_ORIGINS: dict[FactType, set[Origin]] = {
    FactType.FACT: {Origin.USER, Origin.AGENT, Origin.EXTERNAL, Origin.SYSTEM},
    FactType.OBSERVATION: {Origin.AGENT, Origin.EXTERNAL, Origin.SYSTEM},
    FactType.USER_FACT: {Origin.USER},
    FactType.PREFERENCE: {Origin.USER},
    FactType.INFERRED_PREFERENCE: {Origin.AGENT},
}


class SituationService:
    def __init__(self, session: Session):
        self.session = session

    def add(self, *, user_id: uuid.UUID, type: FactType, canonical_en: str, origin: Origin,
            raw_text: str | None = None, raw_language: str | None = None, source_uri: str | None = None,
            confidence: float = 1.0, topic: str | None = None, valid_from: datetime | None = None,
            valid_until: datetime | None = None) -> SituationFact:
        if origin not in ALLOWED_ORIGINS[type]:
            raise SituationError(f"{origin.value} cannot record a {type.value}")
        if not 0.0 <= confidence <= 1.0:
            raise SituationError("confidence must be in [0, 1]")
        if type in {FactType.PREFERENCE, FactType.INFERRED_PREFERENCE} and not topic:
            raise SituationError("preferences need a topic so they can supersede each other")
        now = utcnow()
        fact = SituationFact(user_id=user_id, type=type, canonical_en=canonical_en, origin=origin,
                             raw_text=raw_text, raw_language=raw_language, source_uri=source_uri,
                             confidence=confidence, topic=topic, valid_from=valid_from or now,
                             valid_until=valid_until, last_verified_at=now)
        self.session.add(fact)
        self.session.flush()

        if topic:
            prior = self._active_on_topic(user_id, topic, exclude=fact.id)
            explicit = [p for p in prior if p.type == FactType.PREFERENCE]
            if type == FactType.INFERRED_PREFERENCE and explicit:
                # keep it as evidence of what we inferred, but the user's own word wins
                fact.superseded_by_id = explicit[-1].id
            else:
                for p in prior:
                    if p.type in {FactType.PREFERENCE, FactType.INFERRED_PREFERENCE} or p.type == type:
                        p.superseded_by_id = fact.id
        audit.record(self.session, kind="situation.fact_added", entity_type="situation_fact",
                     entity_id=fact.id, actor=origin, user_id=user_id, type=type.value, topic=topic,
                     superseded_by=str(fact.superseded_by_id) if fact.superseded_by_id else None)
        self.session.flush()
        return fact

    def _active_on_topic(self, user_id: uuid.UUID, topic: str, exclude: uuid.UUID) -> list[SituationFact]:
        return list(self.session.scalars(select(SituationFact).where(
            SituationFact.user_id == user_id, SituationFact.topic == topic,
            SituationFact.superseded_by_id.is_(None), SituationFact.id != exclude)
            .order_by(SituationFact.created_at)))

    def current(self, user_id: uuid.UUID, types: set[FactType] | None = None,
                at: datetime | None = None) -> list[SituationFact]:
        at = at or utcnow()
        q = select(SituationFact).where(
            SituationFact.user_id == user_id, SituationFact.superseded_by_id.is_(None),
            or_(SituationFact.valid_until.is_(None), SituationFact.valid_until > at),
            or_(SituationFact.valid_from.is_(None), SituationFact.valid_from <= at))
        if types:
            q = q.where(SituationFact.type.in_(types))
        return list(self.session.scalars(q.order_by(SituationFact.created_at)))

    def snapshot(self, user_id: uuid.UUID) -> dict[str, list[str]]:
        """Grouped, typed view for prompts — types stay separate so the model can't conflate them."""
        out: dict[str, list[str]] = defaultdict(list)
        for f in self.current(user_id):
            out[f.type.value].append(f.canonical_en)
        return dict(out)
