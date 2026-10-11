"""Beliefs and the evidence → belief edges of the dependency graph (spec §4, §13).

Hypotheses, conclusions and open uncertainties stay separate types
(invariant 5). Every belief the agent writes must cite evidence it was shown;
citations to anything else are dropped, and a belief left with no valid
citation is stored as a HYPOTHESIS at most — never as a CONCLUSION.
"""

from __future__ import annotations

import re
import uuid
from dataclasses import dataclass, field
from datetime import datetime

from sqlalchemy import select
from sqlalchemy.orm import Session

from pga import audit
from pga.db.models import Belief, BeliefEvidence, Evidence, Responsibility
from pga.db.types import BeliefStatus, BeliefType, Origin, utcnow

MATERIAL_CONFIDENCE_SHIFT = 0.2


@dataclass
class BeliefUpdate:
    key: str
    type: BeliefType
    statement_en: str
    confidence: float
    status: BeliefStatus = BeliefStatus.ACTIVE
    evidence: list[tuple[uuid.UUID, str]] = field(default_factory=list)  # (evidence_id, SUPPORTS|CONTRADICTS)


@dataclass
class BeliefChange:
    belief_id: uuid.UUID
    key: str
    type: str
    change: str                      # created | revised | refuted | resolved | confirmed
    statement_en: str
    confidence_before: float | None
    confidence_after: float
    material: bool                   # would a reasonable user want to know?

    def as_dict(self) -> dict:
        return {k: (str(v) if isinstance(v, uuid.UUID) else v) for k, v in self.__dict__.items()}


def slug(text: str) -> str:
    s = re.sub(r"[^a-z0-9]+", "-", text.lower()).strip("-")
    return s[:80] or "belief"


class BeliefService:
    def __init__(self, session: Session):
        self.session = session

    def active(self, r: Responsibility) -> list[Belief]:
        return list(self.session.scalars(select(Belief).where(
            Belief.responsibility_id == r.id, Belief.status == BeliefStatus.ACTIVE).order_by(Belief.created_at)))

    def by_key(self, r: Responsibility, key: str) -> Belief | None:
        return self.session.scalar(select(Belief).where(
            Belief.responsibility_id == r.id, Belief.key == key, Belief.superseded_by_id.is_(None))
            .order_by(Belief.created_at.desc()).limit(1))

    def evidence_for(self, belief_id: uuid.UUID) -> list[tuple[Evidence, str]]:
        rows = self.session.execute(select(Evidence, BeliefEvidence.stance).join(
            BeliefEvidence, BeliefEvidence.evidence_id == Evidence.id).where(BeliefEvidence.belief_id == belief_id))
        return [(e, stance) for e, stance in rows]

    def apply(self, r: Responsibility, updates: list[BeliefUpdate], *, allowed_evidence: set[uuid.UUID],
              run_id: uuid.UUID | None = None, now: datetime | None = None) -> list[BeliefChange]:
        now = now or utcnow()
        changes: list[BeliefChange] = []
        for u in updates:
            cites = [(eid, st if st in {"SUPPORTS", "CONTRADICTS"} else "SUPPORTS")
                     for eid, st in u.evidence if eid in allowed_evidence]
            btype = u.type
            if btype == BeliefType.CONCLUSION and not cites:
                btype = BeliefType.HYPOTHESIS  # an uncited "conclusion" is only a hypothesis (§13, inv. 9)
            conf = max(0.0, min(1.0, float(u.confidence)))
            key = slug(u.key or u.statement_en)
            old = self.by_key(r, key)
            if old is None:
                b = Belief(responsibility_id=r.id, type=btype, statement_en=u.statement_en[:2000], confidence=conf,
                           status=u.status, key=key, origin_run_id=run_id, reviewed_at=now, created_at=now,
                           updated_at=now)
                self.session.add(b)
                self.session.flush()
                self._link(b, cites, now)
                changes.append(BeliefChange(b.id, key, btype.value, "created", b.statement_en, None, conf,
                                            material=btype == BeliefType.CONCLUSION))
                continue
            shift = abs(conf - old.confidence)
            new_status = u.status
            if new_status == BeliefStatus.REFUTED and old.status != BeliefStatus.REFUTED:
                change = "refuted"
            elif new_status == BeliefStatus.RESOLVED and old.status != BeliefStatus.RESOLVED:
                change = "resolved"
            elif u.statement_en.strip() != old.statement_en.strip() or btype != old.type or shift >= 0.05:
                change = "revised"
            else:
                change = "confirmed"
            if change in {"revised"}:
                # keep history: the old belief is superseded, not edited in place
                b = Belief(responsibility_id=r.id, type=btype, statement_en=u.statement_en[:2000], confidence=conf,
                           status=new_status, key=key, origin_run_id=run_id, reviewed_at=now, created_at=now,
                           updated_at=now)
                self.session.add(b)
                self.session.flush()
                old.superseded_by_id = b.id
                old.status = BeliefStatus.STALE
                old.updated_at = now
                prior = {(e.id, st) for e, st in self.evidence_for(old.id)}
                self._link(b, list(prior | set(cites)), now)
            else:
                b = old
                b.status = new_status
                b.confidence = conf
                b.reviewed_at = now
                b.needs_review = False
                b.updated_at = now
                self._link(b, cites, now)
            material = (change in {"refuted", "resolved"} and old.type == BeliefType.CONCLUSION) or (
                btype == BeliefType.CONCLUSION and (change == "revised" and (
                    shift >= MATERIAL_CONFIDENCE_SHIFT or old.type != BeliefType.CONCLUSION)))
            if change != "confirmed":
                changes.append(BeliefChange(b.id, key, btype.value, change, b.statement_en, old.confidence, conf,
                                            material))
        if changes:
            audit.record(self.session, kind="beliefs.changed", entity_type="responsibility", entity_id=r.id,
                         actor=Origin.AGENT, user_id=r.user_id, run_id=str(run_id) if run_id else None,
                         changes=[c.as_dict() for c in changes])
        self.session.flush()
        return changes

    def _link(self, b: Belief, cites: list[tuple[uuid.UUID, str]], now: datetime) -> None:
        for eid, stance in cites:
            if self.session.get(BeliefEvidence, (b.id, eid)) is None:
                self.session.add(BeliefEvidence(belief_id=b.id, evidence_id=eid, stance=stance, created_at=now))
        self.session.flush()
