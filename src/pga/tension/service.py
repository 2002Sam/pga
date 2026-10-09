"""Tension Accumulator (spec §5).

    T_r(t+1) = Decay(T_r(t)) + Σ ΔT(e_i, r),   clamped to [0, 1]

Incoming information is clustered into events first (duplicates are one event),
scored against every live responsibility, and applied with diminishing returns.
Tension falls when uncertainty is resolved, the user rejects a direction, an
opportunity expires, information is absorbed by a run, or nothing meaningful
happens (decay, faster when stagnant). Wake/sleep uses hysteresis.
"""

from __future__ import annotations

import logging
import math
import uuid
from collections.abc import Callable
from dataclasses import dataclass, field
from datetime import datetime, timedelta

from sqlalchemy import select
from sqlalchemy.orm import Session

from pga.config import Policy, TensionPolicy
from pga.db.models import (
    AuditLog, Belief, EventCluster, Evidence, Responsibility, ResponsibilityCluster, TensionChange,
)
from pga.db.types import (
    TERMINAL_STATUSES, BeliefStatus, BeliefType, Origin, ResponsibilityStatus as S, TensionChangeKind as K,
    utcnow,
)
from pga.responsibility import ResponsibilityService

from .fingerprint import MinHasher, canonical_uri, content_hash, shingles, similarity
from .scoring import DeltaBreakdown, EventScorer, RuleScorer, Signals, compute_delta

log = logging.getLogger("pga.tension")

Normalizer = Callable[[str], tuple[str, str]]  # raw text -> (canonical_en, raw_language)


@dataclass
class IncomingEvidence:
    text: str
    source_type: str = "web"
    source_uri: str | None = None
    title: str | None = None
    published_at: datetime | None = None
    trust_score: float | None = None
    event_key: str | None = None            # upstream dedupe key (feed GUID, LLM-assigned id …)
    expires_at: datetime | None = None      # opportunity deadline, if any
    signals: dict[uuid.UUID, Signals] | None = None  # explicit per-responsibility signals
    origin: Origin = Origin.EXTERNAL


@dataclass
class Effect:
    responsibility_id: uuid.UUID
    delta: float
    tension_before: float
    tension_after: float
    transition: str | None
    breakdown: dict


@dataclass
class IngestResult:
    evidence: Evidence
    cluster: EventCluster
    new_cluster: bool
    effects: list[Effect] = field(default_factory=list)


class TensionService:
    def __init__(self, session: Session, policy: Policy, *, scorer: EventScorer | None = None,
                 normalizer: Normalizer | None = None):
        self.session = session
        self.policy = policy
        self.scorer = scorer or RuleScorer()
        self.normalizer = normalizer
        self.responsibilities = ResponsibilityService(session, policy)
        cp = policy.tension.clustering
        self.hasher = MinHasher(cp.num_perm)

    def tp(self, r: Responsibility) -> TensionPolicy:
        return self.policy.tension.merged(r.tension_policy)

    # ---------------------------------------------------------------- decay

    def decay(self, r: Responsibility, now: datetime | None = None) -> float:
        """Bring tension forward to `now`. Returns the (non-positive) delta."""
        now = now or utcnow()
        last = r.tension_updated_at
        if last is None or now <= last:
            r.tension_updated_at = now if last is None else last
            return 0.0
        tp = self.tp(r)
        stagnant_from = r.last_meaningful_change_at + timedelta(hours=tp.stagnation_hours)
        normal_h = max(0.0, (min(now, stagnant_from) - last).total_seconds() / 3600)
        stagnant_h = max(0.0, (now - max(last, stagnant_from)).total_seconds() / 3600)
        factor = 0.5 ** (normal_h / tp.half_life_hours) * 0.5 ** (stagnant_h / tp.stagnation_half_life_hours)
        before = r.tension
        r.tension = before * factor
        r.tension_updated_at = now
        delta = r.tension - before
        if delta <= -0.005:
            self._ledger(r, K.DECAY, before, r.tension, now=now,
                         explanation=f"decay over {normal_h + stagnant_h:.1f}h"
                                     + (" (stagnant: faster decay)" if stagnant_h else ""),
                         signals={"hours": round(normal_h + stagnant_h, 3), "stagnant_hours": round(stagnant_h, 3)})
        return delta

    # ---------------------------------------------------------------- ingestion

    def ingest(self, user_id: uuid.UUID, item: IncomingEvidence, now: datetime | None = None) -> IngestResult:
        now = now or utcnow()
        if self.normalizer:
            canonical, lang = self.normalizer(item.text)
        else:
            canonical, lang = item.text, None
        if item.title and item.title not in canonical:
            canonical_for_fp = f"{item.title}\n{canonical}"
        else:
            canonical_for_fp = canonical
        c_uri = canonical_uri(item.source_uri)
        c_hash = content_hash(canonical_for_fp)
        sig = self.hasher.signature(shingles(canonical_for_fp, self.policy.tension.clustering.shingle_words,
                                             self.policy.tension.clustering.shingle_chars))
        cluster, is_new = self._assign_cluster(user_id, sig, c_uri, c_hash, item, canonical, now)

        ev = Evidence(user_id=user_id, canonical_summary_en=canonical[:8000],
                      raw_content_ref=item.text if lang and lang != "en" else None, raw_language=lang,
                      source_uri=item.source_uri, canonical_uri=c_uri, content_hash=c_hash,
                      source_type=item.source_type, published_at=item.published_at, retrieved_at=now,
                      trust_score=item.trust_score, event_cluster_id=cluster.id, origin=item.origin)
        self.session.add(ev)
        self.session.flush()

        targets = [r for r in self.responsibilities.list(user_id) if r.status not in TERMINAL_STATUSES]
        result = IngestResult(ev, cluster, is_new)
        if not targets:
            return result

        context = {"novelty": self._novelty(targets, cluster, sig, now),
                   "uncertainty": self._uncertainty(targets),
                   "beliefs": self._beliefs(targets)}
        scored = dict(self.scorer.score(targets, canonical, context=context))
        if item.signals:
            scored.update(item.signals)  # explicit upstream signals win
        for r in targets:
            s = scored.get(r.id)
            if s is not None:
                result.effects.append(self._apply_event(r, cluster, ev, s, now))
        return result

    def _assign_cluster(self, user_id: uuid.UUID, sig: list[int], c_uri: str | None, c_hash: str,
                        item: IncomingEvidence, canonical: str, now: datetime) -> tuple[EventCluster, bool]:
        cp = self.policy.tension.clustering
        recent = list(self.session.scalars(select(EventCluster).where(
            EventCluster.user_id == user_id, EventCluster.last_seen_at >= now - timedelta(days=cp.lookback_days))))
        key = f"key:{item.event_key}" if item.event_key else None
        best, best_sim = None, 0.0
        for c in recent:
            if (c_uri and c_uri in c.canonical_uris) or c_hash in c.content_hashes or (key and key in c.content_hashes):
                best, best_sim = c, 1.0
                break
            s = similarity(sig, c.fingerprint)
            if s > best_sim:
                best, best_sim = c, s
        trust = 0.5 if item.trust_score is None else max(0.0, min(1.0, item.trust_score))
        if best is not None and best_sim >= cp.similarity_threshold:
            best.source_count += 1
            best.confidence = 1 - (1 - best.confidence) * (1 - trust)  # more sources → more confidence
            best.last_seen_at = now
            if c_uri and c_uri not in best.canonical_uris:
                best.canonical_uris = [*best.canonical_uris, c_uri]
            hashes = [h for h in (c_hash, key) if h and h not in best.content_hashes]
            if hashes:
                best.content_hashes = [*best.content_hashes, *hashes]
            if item.expires_at and (best.expires_at is None or item.expires_at < best.expires_at):
                best.expires_at = item.expires_at
            self.session.flush()
            return best, False
        title = (item.title or canonical.strip().split("\n", 1)[0])[:300]
        c = EventCluster(user_id=user_id, title_en=title, fingerprint=sig,
                         canonical_uris=[c_uri] if c_uri else [],
                         content_hashes=[h for h in (c_hash, key) if h], source_count=1, confidence=trust,
                         expires_at=item.expires_at, first_seen_at=now, last_seen_at=now)
        self.session.add(c)
        self.session.flush()
        return c, True

    def _novelty(self, targets: list[Responsibility], cluster: EventCluster, sig: list[int],
                 now: datetime) -> dict[uuid.UUID, float]:
        """1 − similarity to what each responsibility has already absorbed."""
        out: dict[uuid.UUID, float] = {}
        rows = self.session.execute(select(ResponsibilityCluster.responsibility_id, EventCluster.fingerprint)
                                    .join(EventCluster, EventCluster.id == ResponsibilityCluster.cluster_id)
                                    .where(ResponsibilityCluster.responsibility_id.in_([r.id for r in targets]),
                                           ResponsibilityCluster.absorbed_at.is_not(None),
                                           ResponsibilityCluster.cluster_id != cluster.id)).all()
        for rid, fp in rows:
            out[rid] = min(out.get(rid, 1.0), 1.0 - similarity(sig, fp))
        return out

    def _uncertainty(self, targets: list[Responsibility]) -> dict[uuid.UUID, float]:
        out: dict[uuid.UUID, float] = {}
        rows = self.session.execute(select(Belief.responsibility_id, Belief.type, Belief.confidence).where(
            Belief.responsibility_id.in_([r.id for r in targets]), Belief.status == BeliefStatus.ACTIVE)).all()
        by_r: dict[uuid.UUID, list[tuple[BeliefType, float]]] = {}
        for rid, btype, conf in rows:
            by_r.setdefault(rid, []).append((btype, conf))
        for rid, items in by_r.items():
            open_q = sum(1 for t, _ in items if t == BeliefType.UNCERTAINTY)
            shaky = sum(1 - c for t, c in items if t == BeliefType.HYPOTHESIS)
            out[rid] = min(1.0, 0.25 + 0.2 * open_q + 0.1 * shaky)
        return out

    def _beliefs(self, targets: list[Responsibility]) -> dict[uuid.UUID, list[str]]:
        out: dict[uuid.UUID, list[str]] = {}
        rows = self.session.execute(select(Belief.responsibility_id, Belief.type, Belief.statement_en).where(
            Belief.responsibility_id.in_([r.id for r in targets]), Belief.status == BeliefStatus.ACTIVE)).all()
        for rid, btype, stmt in rows:
            out.setdefault(rid, []).append(f"{btype.value}: {stmt}")
        return out

    def _link(self, r: Responsibility, cluster: EventCluster, now: datetime) -> ResponsibilityCluster:
        link = self.session.get(ResponsibilityCluster, (r.id, cluster.id))
        if link is None:
            link = ResponsibilityCluster(responsibility_id=r.id, cluster_id=cluster.id, contributions=0,
                                         contradiction_contributions=0, last_contribution_at=now)
            self.session.add(link)
        return link

    def _apply_event(self, r: Responsibility, cluster: EventCluster, ev: Evidence, s: Signals,
                     now: datetime) -> Effect:
        self.decay(r, now)
        tp = self.tp(r)
        link = self._link(r, cluster, now)
        blocked = None
        if link.rejected_at:
            blocked = "user rejected this direction"
        elif link.expired_at or (cluster.expires_at and cluster.expires_at <= now):
            blocked = "opportunity expired"
        bd = compute_delta(s, tp, prior_sources=link.contributions,
                           prior_contradictions=link.contradiction_contributions,
                           absorbed=link.absorbed_at is not None, blocked=blocked)
        before = r.tension
        if bd.delta > 0:
            link.contributions += 1
            if s.contradiction > 0:
                link.contradiction_contributions += 1
            link.last_contribution_at = now
            r.tension = min(1.0, before + bd.delta)
            r.tension_updated_at = now
            if r.tension - before >= tp.meaningful_delta:
                r.last_meaningful_change_at = now
            self._ledger(r, K.EVENT, before, r.tension, now=now, cluster_id=cluster.id, evidence_id=ev.id,
                         signals={**s.as_dict(), "breakdown": bd.as_dict(), "source_count": cluster.source_count},
                         explanation=_explain(cluster, s, bd))
        self.session.flush()
        transition = self.evaluate(r, now, cause=f"event: {cluster.title_en[:120]}")
        return Effect(r.id, r.tension - before, before, r.tension, transition, bd.as_dict())

    # ---------------------------------------------------------------- reductions

    def resolve_uncertainty(self, r: Responsibility, *, amount: float = 0.25, belief_id: uuid.UUID | None = None,
                            note: str = "", actor: Origin = Origin.AGENT, now: datetime | None = None) -> float:
        now = now or utcnow()
        self.decay(r, now)
        if belief_id:
            b = self.session.get(Belief, belief_id)
            if b is None or b.responsibility_id != r.id:
                raise ValueError("belief does not belong to this responsibility")
            b.status = BeliefStatus.RESOLVED
            if b.type == BeliefType.UNCERTAINTY:
                # resolving an open question the agent was unsure about relieves more
                amount = max(amount, 0.15 + 0.25 * (1 - b.confidence))
        return self._reduce(r, K.RESOLUTION, amount, now, f"uncertainty resolved: {note}".strip(": "),
                            actor=actor, extra={"belief_id": str(belief_id) if belief_id else None})

    def reject_direction(self, r: Responsibility, *, cluster_id: uuid.UUID | None = None, note: str = "",
                         actor: Origin = Origin.USER, now: datetime | None = None) -> float:
        if actor != Origin.USER:
            raise PermissionError("only the user can reject a direction")
        now = now or utcnow()
        self.decay(r, now)
        if cluster_id:
            cluster = self.session.get(EventCluster, cluster_id)
            if cluster is None:
                raise ValueError("unknown event cluster")
            self._link(r, cluster, now).rejected_at = now
        amount = r.tension * self.tp(r).rejection_relief
        return self._reduce(r, K.REJECTION, amount, now, f"user rejected direction: {note}".strip(": "),
                            actor=actor, cluster_id=cluster_id)

    def expire_cluster(self, cluster: EventCluster, now: datetime | None = None) -> list[Effect]:
        """An opportunity/deadline passed: remove what it still contributes, everywhere."""
        now = now or utcnow()
        cluster.expires_at = min(cluster.expires_at or now, now)
        effects = []
        links = list(self.session.scalars(select(ResponsibilityCluster).where(
            ResponsibilityCluster.cluster_id == cluster.id, ResponsibilityCluster.expired_at.is_(None))))
        for link in links:
            r = self.session.get(Responsibility, link.responsibility_id)
            link.expired_at = now
            if r is None or r.status in TERMINAL_STATUSES:
                continue
            self.decay(r, now)
            before = r.tension
            live = 0.0 if link.absorbed_at else self.live_contribution(r, cluster.id, now)
            self._reduce(r, K.EXPIRY, live, now, f"opportunity expired: {cluster.title_en[:120]}",
                         actor=Origin.SYSTEM, cluster_id=cluster.id)
            effects.append(Effect(r.id, r.tension - before, before, r.tension, None, {}))
        return effects

    def absorb(self, r: Responsibility, cluster_ids: list[uuid.UUID], *, run_id: uuid.UUID | None = None,
               now: datetime | None = None) -> float:
        """A run has taken this information in; it should stop pulling on the responsibility."""
        now = now or utcnow()
        self.decay(r, now)
        tp = self.tp(r)
        total = 0.0
        for cid in cluster_ids:
            link = self.session.get(ResponsibilityCluster, (r.id, cid))
            if link is None or link.absorbed_at:
                continue
            total += self.live_contribution(r, cid, now) * tp.absorption_relief
            link.absorbed_at = now
        if total <= 0:
            return 0.0
        return self._reduce(r, K.ABSORPTION, total, now, f"absorbed {len(cluster_ids)} event(s)",
                            actor=Origin.AGENT, extra={"run_id": str(run_id) if run_id else None,
                                                       "clusters": [str(c) for c in cluster_ids]})

    def live_contribution(self, r: Responsibility, cluster_id: uuid.UUID, now: datetime) -> float:
        """What a cluster still adds to tension today (its positive deltas, decayed)."""
        hl = self.tp(r).half_life_hours
        rows = self.session.execute(select(TensionChange.delta, TensionChange.created_at).where(
            TensionChange.responsibility_id == r.id, TensionChange.cluster_id == cluster_id,
            TensionChange.kind == K.EVENT)).all()
        live = sum(d * 0.5 ** (max(0.0, (now - t).total_seconds()) / 3600 / hl) for d, t in rows if d > 0)
        return min(live, r.tension)

    def _reduce(self, r: Responsibility, kind: K, amount: float, now: datetime, explanation: str, *,
                actor: Origin, cluster_id: uuid.UUID | None = None, extra: dict | None = None) -> float:
        before = r.tension
        r.tension = max(0.0, before - max(0.0, amount))
        r.tension_updated_at = now
        if before - r.tension >= self.tp(r).meaningful_delta:
            r.last_meaningful_change_at = now
        if r.tension != before:
            self._ledger(r, kind, before, r.tension, now=now, cluster_id=cluster_id, explanation=explanation,
                         signals={"actor": actor.value, **(extra or {})})
        self.session.flush()
        self.evaluate(r, now, cause=explanation)
        return r.tension - before

    def adjust(self, r: Responsibility, delta: float, *, reason: str, actor: Origin,
               now: datetime | None = None) -> float:
        """Manual nudge (e.g. the user says 'this matters more now')."""
        if actor == Origin.EXTERNAL:
            raise PermissionError("external content cannot set tension directly")
        now = now or utcnow()
        self.decay(r, now)
        before = r.tension
        r.tension = max(0.0, min(1.0, before + delta))
        r.tension_updated_at = now
        r.last_meaningful_change_at = now
        self._ledger(r, K.MANUAL, before, r.tension, now=now, explanation=reason, signals={"actor": actor.value})
        self.session.flush()
        self.evaluate(r, now, cause=reason)
        return r.tension - before

    # ---------------------------------------------------------------- hysteresis

    def evaluate(self, r: Responsibility, now: datetime | None = None, cause: str = "") -> str | None:
        """Apply wake/sleep rules. Wake above wake_threshold, sleep below sleep_threshold, else hold."""
        now = now or utcnow()
        if r.status == S.CANDIDATE or r.paused_by_user:
            return None
        tp = self.tp(r)
        op, reason = None, ""
        if r.status in {S.MONITORING, S.SLEEPING} and r.tension >= r.wake_threshold:
            op, reason = "wake", f"tension {r.tension:.2f} ≥ wake {r.wake_threshold:.2f}"
        elif r.status == S.ACTIVE and r.tension <= r.sleep_threshold:
            op, reason = "monitor", f"tension {r.tension:.2f} ≤ sleep {r.sleep_threshold:.2f}"
        elif (r.status == S.MONITORING and r.tension <= tp.deep_sleep_threshold
              and now - r.last_meaningful_change_at >= timedelta(hours=tp.stagnation_hours)):
            op, reason = "sleep", f"tension {r.tension:.2f} ≤ {tp.deep_sleep_threshold:.2f} and stagnant"
        if op is None:
            return None
        details = {"cause": cause}
        if op == "wake":
            since = now - timedelta(hours=2 * tp.half_life_hours)
            details["why_now"] = [c.explanation_en for c in self.top_contributors(r, limit=3, since=since)]
        self.responsibilities.transition(r, op, actor=Origin.SYSTEM, reason=reason, now=now, **details)
        return op

    def tick(self, user_id: uuid.UUID, now: datetime | None = None) -> dict:
        """Periodic housekeeping a scheduler calls (Phase 2 runs this from a durable workflow)."""
        now = now or utcnow()
        report = {"decayed": 0, "transitions": [], "expired_candidates": [], "expired_clusters": []}
        for c in self.responsibilities.expire_candidates(now):
            if c.user_id == user_id:
                report["expired_candidates"].append(str(c.id))
        for cl in self.session.scalars(select(EventCluster).where(
                EventCluster.user_id == user_id, EventCluster.expires_at.is_not(None), EventCluster.expires_at <= now)):
            if self.expire_cluster(cl, now):
                report["expired_clusters"].append(str(cl.id))
        for r in self.responsibilities.list(user_id):
            if r.status in TERMINAL_STATUSES:
                continue
            if self.decay(r, now) < 0:
                report["decayed"] += 1
            if (r.status == S.SLEEPING and not r.paused_by_user and r.next_review_at
                    and r.next_review_at <= now):
                self.responsibilities.transition(r, "monitor", actor=Origin.SYSTEM, now=now,
                                                 reason="scheduled review is due")
                r.next_review_at = None
                report["transitions"].append({"id": str(r.id), "op": "monitor"})
                continue
            op = self.evaluate(r, now, cause="tick")
            if op:
                report["transitions"].append({"id": str(r.id), "op": op})
        self.session.flush()
        return report

    # ---------------------------------------------------------------- explanation

    def top_contributors(self, r: Responsibility, limit: int = 5, since: datetime | None = None) -> list[TensionChange]:
        q = select(TensionChange).where(TensionChange.responsibility_id == r.id, TensionChange.delta > 0)
        if since:
            q = q.where(TensionChange.created_at >= since)
        else:
            q = q.where(TensionChange.created_at >= utcnow() - timedelta(hours=2 * self.tp(r).half_life_hours))
        return list(self.session.scalars(q.order_by(TensionChange.delta.desc()).limit(limit)))

    def why_awake(self, r: Responsibility) -> dict:
        """'Why did the agent wake up?' (spec §17): last wake and what pushed tension over the line."""
        wake = self.session.scalar(
            select(AuditLog).where(AuditLog.entity_type == "responsibility", AuditLog.entity_id == r.id,
                                   AuditLog.kind == "responsibility.transition",
                                   AuditLog.payload["op"].as_string() == "wake")
            .order_by(AuditLog.created_at.desc()).limit(1))
        ledger = self.session.scalars(select(TensionChange).where(TensionChange.responsibility_id == r.id)
                                      .order_by(TensionChange.created_at.desc()).limit(20))
        return {
            "status": r.status.value, "tension": round(r.tension, 4), "wake_threshold": r.wake_threshold,
            "sleep_threshold": r.sleep_threshold, "paused_by_user": r.paused_by_user,
            "last_wake": None if wake is None else {"at": wake.created_at.isoformat(), **wake.payload},
            "recent_changes": [{"at": c.created_at.isoformat(), "kind": c.kind.value, "delta": round(c.delta, 4),
                                "tension_after": round(c.tension_after, 4), "why": c.explanation_en}
                               for c in ledger],
        }

    def _ledger(self, r: Responsibility, kind: K, before: float, after: float, *, now: datetime,
                explanation: str, cluster_id: uuid.UUID | None = None, evidence_id: uuid.UUID | None = None,
                signals: dict | None = None) -> TensionChange:
        tc = TensionChange(responsibility_id=r.id, kind=kind, delta=after - before, tension_before=before,
                           tension_after=after, cluster_id=cluster_id, evidence_id=evidence_id,
                           signals=_finite(signals or {}), explanation_en=explanation, created_at=now)
        self.session.add(tc)
        return tc


def _explain(cluster: EventCluster, s: Signals, bd: DeltaBreakdown) -> str:
    parts = [f"'{cluster.title_en[:100]}'", f"+{bd.delta:.3f}"]
    if s.contradiction:
        parts.append(f"contradiction {s.contradiction:.2f}")
    if s.deadline:
        parts.append(f"deadline {s.deadline:.2f}")
    if s.opportunity:
        parts.append(f"opportunity {s.opportunity:.2f}")
    if bd.duplicate_factor < 1:
        parts.append(f"source #{cluster.source_count} of same event (×{bd.duplicate_factor:.2f})")
    if bd.absorbed_factor < 1:
        parts.append("already absorbed")
    if s.rationale:
        parts.append(s.rationale)
    return "; ".join(parts)


def _finite(d: dict) -> dict:
    def fix(v):
        if isinstance(v, float) and not math.isfinite(v):
            return None
        if isinstance(v, dict):
            return {k: fix(x) for k, x in v.items()}
        return v
    return {k: fix(v) for k, v in d.items()}
