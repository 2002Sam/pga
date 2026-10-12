"""Memory and retrieval (spec §11, Phase 3).

PostgreSQL stays the source of truth. Retrieval only finds *candidate* context —
past conclusions and evidence of the same user that look related — and labels
it as such. It never decides what is true: a research step still has to cite
current evidence for anything it concludes.

Ranking is Postgres full-text search (English stemming over the canonical
English text, which every stored item has), so it needs no extra service or
model. The expression indexes live in the Phase 3 migration.
"""

from __future__ import annotations

import uuid
from dataclasses import dataclass
from datetime import datetime

from sqlalchemy import Text, cast, func, literal, select, union_all
from sqlalchemy.orm import Session

from pga.config import Policy
from pga.db.models import Belief, Evidence, Responsibility
from pga.db.types import BeliefStatus

TS_CONFIG = "english"


@dataclass
class Recalled:
    kind: str                      # belief | evidence
    id: uuid.UUID
    text: str
    rank: float
    responsibility_id: uuid.UUID | None
    at: datetime | None
    meta: str = ""


class MemoryService:
    def __init__(self, session: Session, policy: Policy):
        self.session = session
        self.mp = policy.memory

    def recall(self, user_id: uuid.UUID, query: str, *, limit: int | None = None,
               exclude_evidence: set[uuid.UUID] | None = None) -> list[Recalled]:
        query = (query or "").strip()
        if not query:
            return []
        limit = limit or self.mp.recall_limit
        # OR the terms together: related material rarely shares every word of the query
        tsq = func.to_tsquery(TS_CONFIG, func.replace(cast(func.plainto_tsquery(TS_CONFIG, query), Text),
                                                     " & ", " | "))
        b_vec = func.to_tsvector(TS_CONFIG, Belief.statement_en)
        e_vec = func.to_tsvector(TS_CONFIG, Evidence.canonical_summary_en)
        beliefs = (select(literal("belief").label("kind"), Belief.id, Belief.statement_en.label("text"),
                          func.ts_rank(b_vec, tsq).label("rank"), Belief.responsibility_id,
                          Belief.updated_at.label("at"),
                          (Belief.type + literal(" ") + Belief.status).label("meta"))
                   .join(Responsibility, Responsibility.id == Belief.responsibility_id)
                   .where(Responsibility.user_id == user_id, Belief.superseded_by_id.is_(None),
                          Belief.status.in_([BeliefStatus.ACTIVE, BeliefStatus.RESOLVED, BeliefStatus.REFUTED]),
                          b_vec.op("@@")(tsq)))
        ev = (select(literal("evidence").label("kind"), Evidence.id, Evidence.canonical_summary_en.label("text"),
                     func.ts_rank(e_vec, tsq).label("rank"), Evidence.responsibility_id,
                     Evidence.retrieved_at.label("at"), func.coalesce(Evidence.source_uri, "").label("meta"))
              .where(Evidence.user_id == user_id, Evidence.retracted_at.is_(None), e_vec.op("@@")(tsq)))
        if exclude_evidence:
            ev = ev.where(Evidence.id.notin_(exclude_evidence))
        u = union_all(beliefs, ev).subquery()
        rows = self.session.execute(select(u).where(u.c.rank >= self.mp.min_rank)
                                    .order_by(u.c.rank.desc()).limit(limit)).all()
        return [Recalled(r.kind, r.id, r.text, float(r.rank), r.responsibility_id, r.at, r.meta or "") for r in rows]

    def context(self, user_id: uuid.UUID, query: str, exclude_evidence: set[uuid.UUID] | None = None) -> str:
        items = self.recall(user_id, query, exclude_evidence=exclude_evidence)
        if not items:
            return ""
        lines = ["Retrieved from memory as candidate context only. It may be stale or wrong; "
                 "do not cite it as evidence and do not treat it as true without current evidence."]
        for it in items:
            when = it.at.date().isoformat() if it.at else "?"
            label = f"past {it.meta.lower()}" if it.kind == "belief" else "past evidence"
            lines.append(f"- ({label}, {when}) {it.text[:400]}")
        return "\n".join(lines)

