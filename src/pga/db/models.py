"""Canonical state (spec §4). PostgreSQL is the source of truth; embeddings,
if any, are secondary indexes and never live here as state.

Fields marked `# ext:` are additions to the spec's canonical types that the
Phase-1 mechanisms need (clustering, hysteresis bookkeeping, audit).
"""

from __future__ import annotations

import uuid
from datetime import datetime
from typing import Any

from sqlalchemy import (
    Boolean, Float, ForeignKey, Index, Integer, MetaData, String, Text, UniqueConstraint,
)
from sqlalchemy.orm import DeclarativeBase, Mapped, mapped_column, relationship

from .types import (
    AllocationOutcome, ArtifactStatus, ArtifactType, BeliefStatus, BeliefType, DecidedBy,
    FactType, JSONType, MessageRole, Origin, ResponsibilityStatus, RunStatus, SkillScope,
    SkillStatus, TensionChangeKind, TranslationStatus, Tz, enum_col, utcnow,
)


NAMING_CONVENTION = {
    "ix": "ix_%(column_0_label)s",
    "uq": "uq_%(table_name)s_%(column_0_name)s",
    "ck": "ck_%(table_name)s_%(constraint_name)s",
    "fk": "fk_%(table_name)s_%(column_0_name)s_%(referred_table_name)s",
    "pk": "pk_%(table_name)s",
}


class Base(DeclarativeBase):
    metadata = MetaData(naming_convention=NAMING_CONVENTION)
    type_annotation_map = {dict[str, Any]: JSONType, list[Any]: JSONType}


def _uuid_pk() -> Mapped[uuid.UUID]:
    return mapped_column(primary_key=True, default=uuid.uuid4)


def _created() -> Mapped[datetime]:
    return mapped_column(Tz(), default=utcnow, nullable=False)


# ------------------------------------------------------------------ users & policy


class PermissionPolicy(Base):
    __tablename__ = "permission_policies"
    id: Mapped[uuid.UUID] = _uuid_pk()
    rules: Mapped[dict[str, Any]] = mapped_column(JSONType, nullable=False)  # level -> auto|approval|deny
    version: Mapped[int] = mapped_column(Integer, default=1, nullable=False)
    created_at: Mapped[datetime] = _created()


class User(Base):
    __tablename__ = "users"
    id: Mapped[uuid.UUID] = _uuid_pk()
    locale: Mapped[str] = mapped_column(String(16), default="zh-CN", nullable=False)
    model_language: Mapped[str] = mapped_column(String(8), default="en", nullable=False)
    timezone: Mapped[str] = mapped_column(String(64), default="UTC", nullable=False)
    preferences: Mapped[dict[str, Any]] = mapped_column(JSONType, default=dict, nullable=False)
    permission_policy_id: Mapped[uuid.UUID] = mapped_column(ForeignKey("permission_policies.id"), nullable=False)
    created_at: Mapped[datetime] = _created()

    permission_policy: Mapped[PermissionPolicy] = relationship()


class SituationFact(Base):
    __tablename__ = "situation_facts"
    id: Mapped[uuid.UUID] = _uuid_pk()
    user_id: Mapped[uuid.UUID] = mapped_column(ForeignKey("users.id", ondelete="CASCADE"), nullable=False)
    type: Mapped[FactType] = mapped_column(enum_col(FactType, "fact_type"), nullable=False)
    canonical_en: Mapped[str] = mapped_column(Text, nullable=False)
    raw_text: Mapped[str | None] = mapped_column(Text)
    raw_language: Mapped[str | None] = mapped_column(String(16))
    source_uri: Mapped[str | None] = mapped_column(Text)
    origin: Mapped[Origin] = mapped_column(enum_col(Origin, "origin"), nullable=False)  # ext
    topic: Mapped[str | None] = mapped_column(String(200))  # ext: key for supersession, e.g. "preferred_report_length"
    confidence: Mapped[float] = mapped_column(Float, default=1.0, nullable=False)
    valid_from: Mapped[datetime | None] = mapped_column(Tz())
    valid_until: Mapped[datetime | None] = mapped_column(Tz())
    last_verified_at: Mapped[datetime | None] = mapped_column(Tz())
    superseded_by_id: Mapped[uuid.UUID | None] = mapped_column(ForeignKey("situation_facts.id"))  # ext
    created_at: Mapped[datetime] = _created()

    __table_args__ = (Index("ix_situation_facts_user_type", "user_id", "type"),)


# ------------------------------------------------------------------ responsibilities


class Responsibility(Base):
    __tablename__ = "responsibilities"
    id: Mapped[uuid.UUID] = _uuid_pk()
    user_id: Mapped[uuid.UUID] = mapped_column(ForeignKey("users.id", ondelete="CASCADE"), nullable=False)
    parent_id: Mapped[uuid.UUID | None] = mapped_column(ForeignKey("responsibilities.id"))
    title_en: Mapped[str] = mapped_column(Text, nullable=False)
    description_en: Mapped[str] = mapped_column(Text, default="", nullable=False)
    raw_title: Mapped[str | None] = mapped_column(Text)  # ext: as the user typed it
    status: Mapped[ResponsibilityStatus] = mapped_column(
        enum_col(ResponsibilityStatus, "responsibility_status"), nullable=False)
    tension: Mapped[float] = mapped_column(Float, default=0.0, nullable=False)
    wake_threshold: Mapped[float] = mapped_column(Float, default=0.75, nullable=False)
    sleep_threshold: Mapped[float] = mapped_column(Float, default=0.35, nullable=False)
    priority_bias: Mapped[float] = mapped_column(Float, default=0.0, nullable=False)
    compute_budget: Mapped[dict[str, Any]] = mapped_column(JSONType, default=dict, nullable=False)
    next_review_at: Mapped[datetime | None] = mapped_column(Tz())
    created_at: Mapped[datetime] = _created()
    updated_at: Mapped[datetime] = mapped_column(Tz(), default=utcnow, onupdate=utcnow, nullable=False)

    # ext ------------------------------------------------------------------
    created_by: Mapped[Origin] = mapped_column(enum_col(Origin, "origin"), nullable=False)
    paused_by_user: Mapped[bool] = mapped_column(Boolean, default=False, nullable=False)
    keywords: Mapped[list[Any]] = mapped_column(JSONType, default=list, nullable=False)
    tension_policy: Mapped[dict[str, Any]] = mapped_column(JSONType, default=dict, nullable=False)
    promotion_criteria: Mapped[dict[str, Any]] = mapped_column(JSONType, default=dict, nullable=False)
    candidate_expires_at: Mapped[datetime | None] = mapped_column(Tz())
    useful_outcomes: Mapped[int] = mapped_column(Integer, default=0, nullable=False)
    tension_updated_at: Mapped[datetime] = mapped_column(Tz(), default=utcnow, nullable=False)
    last_meaningful_change_at: Mapped[datetime] = mapped_column(Tz(), default=utcnow, nullable=False)
    stop_reason: Mapped[str | None] = mapped_column(Text)
    version: Mapped[int] = mapped_column(Integer, default=1, nullable=False)

    __mapper_args__ = {"version_id_col": version}
    __table_args__ = (Index("ix_responsibilities_user_status", "user_id", "status"),)

    parent: Mapped["Responsibility | None"] = relationship(remote_side=[id])


class Belief(Base):
    __tablename__ = "beliefs"
    id: Mapped[uuid.UUID] = _uuid_pk()
    responsibility_id: Mapped[uuid.UUID] = mapped_column(ForeignKey("responsibilities.id", ondelete="CASCADE"), nullable=False)
    type: Mapped[BeliefType] = mapped_column(enum_col(BeliefType, "belief_type"), nullable=False)
    statement_en: Mapped[str] = mapped_column(Text, nullable=False)
    confidence: Mapped[float] = mapped_column(Float, default=0.5, nullable=False)
    status: Mapped[BeliefStatus] = mapped_column(enum_col(BeliefStatus, "belief_status"), default=BeliefStatus.ACTIVE, nullable=False)
    created_at: Mapped[datetime] = _created()
    updated_at: Mapped[datetime] = mapped_column(Tz(), default=utcnow, onupdate=utcnow, nullable=False)


class EventCluster(Base):
    """One real-world event, however many sources reported it (spec §5 rule 1)."""
    __tablename__ = "event_clusters"
    id: Mapped[uuid.UUID] = _uuid_pk()
    user_id: Mapped[uuid.UUID] = mapped_column(ForeignKey("users.id", ondelete="CASCADE"), nullable=False)
    title_en: Mapped[str] = mapped_column(Text, nullable=False)
    fingerprint: Mapped[list[Any]] = mapped_column(JSONType, nullable=False)  # MinHash signature
    canonical_uris: Mapped[list[Any]] = mapped_column(JSONType, default=list, nullable=False)
    content_hashes: Mapped[list[Any]] = mapped_column(JSONType, default=list, nullable=False)
    source_count: Mapped[int] = mapped_column(Integer, default=1, nullable=False)
    confidence: Mapped[float] = mapped_column(Float, default=0.5, nullable=False)  # noisy-OR of source trust
    expires_at: Mapped[datetime | None] = mapped_column(Tz())
    first_seen_at: Mapped[datetime] = _created()
    last_seen_at: Mapped[datetime] = mapped_column(Tz(), default=utcnow, nullable=False)

    __table_args__ = (Index("ix_event_clusters_user_seen", "user_id", "last_seen_at"),)


class Evidence(Base):
    __tablename__ = "evidence"
    id: Mapped[uuid.UUID] = _uuid_pk()
    user_id: Mapped[uuid.UUID] = mapped_column(ForeignKey("users.id", ondelete="CASCADE"), nullable=False)  # ext
    responsibility_id: Mapped[uuid.UUID | None] = mapped_column(ForeignKey("responsibilities.id", ondelete="SET NULL"))
    canonical_summary_en: Mapped[str] = mapped_column(Text, nullable=False)
    raw_content_ref: Mapped[str | None] = mapped_column(Text)
    raw_language: Mapped[str | None] = mapped_column(String(16))  # ext
    source_uri: Mapped[str | None] = mapped_column(Text)
    canonical_uri: Mapped[str | None] = mapped_column(Text)  # ext: tracking params stripped
    content_hash: Mapped[str] = mapped_column(String(64), nullable=False)  # ext
    source_type: Mapped[str] = mapped_column(String(64), nullable=False)
    published_at: Mapped[datetime | None] = mapped_column(Tz())
    retrieved_at: Mapped[datetime] = mapped_column(Tz(), default=utcnow, nullable=False)
    trust_score: Mapped[float | None] = mapped_column(Float)
    event_cluster_id: Mapped[uuid.UUID | None] = mapped_column(ForeignKey("event_clusters.id", ondelete="SET NULL"))
    origin: Mapped[Origin] = mapped_column(enum_col(Origin, "origin"), default=Origin.EXTERNAL, nullable=False)  # ext


class ResponsibilityCluster(Base):
    """How an event cluster has affected one responsibility (diminishing returns, absorption)."""
    __tablename__ = "responsibility_clusters"
    responsibility_id: Mapped[uuid.UUID] = mapped_column(ForeignKey("responsibilities.id", ondelete="CASCADE"), primary_key=True)
    cluster_id: Mapped[uuid.UUID] = mapped_column(ForeignKey("event_clusters.id", ondelete="CASCADE"), primary_key=True)
    contributions: Mapped[int] = mapped_column(Integer, default=0, nullable=False)
    contradiction_contributions: Mapped[int] = mapped_column(Integer, default=0, nullable=False)
    absorbed_at: Mapped[datetime | None] = mapped_column(Tz())
    rejected_at: Mapped[datetime | None] = mapped_column(Tz())
    expired_at: Mapped[datetime | None] = mapped_column(Tz())
    last_contribution_at: Mapped[datetime] = mapped_column(Tz(), default=utcnow, nullable=False)


class TensionChange(Base):
    """Append-only ledger: every tension change and why. Answers 'why did it wake up?' (§17)."""
    __tablename__ = "tension_changes"
    id: Mapped[uuid.UUID] = _uuid_pk()
    responsibility_id: Mapped[uuid.UUID] = mapped_column(ForeignKey("responsibilities.id", ondelete="CASCADE"), nullable=False)
    kind: Mapped[TensionChangeKind] = mapped_column(enum_col(TensionChangeKind, "tension_change_kind"), nullable=False)
    delta: Mapped[float] = mapped_column(Float, nullable=False)
    tension_before: Mapped[float] = mapped_column(Float, nullable=False)
    tension_after: Mapped[float] = mapped_column(Float, nullable=False)
    cluster_id: Mapped[uuid.UUID | None] = mapped_column(ForeignKey("event_clusters.id", ondelete="SET NULL"))
    evidence_id: Mapped[uuid.UUID | None] = mapped_column(ForeignKey("evidence.id", ondelete="SET NULL"))
    signals: Mapped[dict[str, Any]] = mapped_column(JSONType, default=dict, nullable=False)
    explanation_en: Mapped[str] = mapped_column(Text, default="", nullable=False)
    created_at: Mapped[datetime] = _created()

    __table_args__ = (Index("ix_tension_changes_resp_time", "responsibility_id", "created_at"),)


class Decision(Base):
    __tablename__ = "decisions"
    id: Mapped[uuid.UUID] = _uuid_pk()
    user_id: Mapped[uuid.UUID] = mapped_column(ForeignKey("users.id", ondelete="CASCADE"), nullable=False)
    responsibility_id: Mapped[uuid.UUID | None] = mapped_column(ForeignKey("responsibilities.id", ondelete="SET NULL"))
    decision_en: Mapped[str] = mapped_column(Text, nullable=False)
    decided_by: Mapped[DecidedBy] = mapped_column(enum_col(DecidedBy, "decided_by"), nullable=False)
    rationale_en: Mapped[str | None] = mapped_column(Text)
    created_at: Mapped[datetime] = _created()


class Artifact(Base):
    __tablename__ = "artifacts"
    id: Mapped[uuid.UUID] = _uuid_pk()
    responsibility_id: Mapped[uuid.UUID] = mapped_column(ForeignKey("responsibilities.id", ondelete="CASCADE"), nullable=False)
    type: Mapped[ArtifactType] = mapped_column(enum_col(ArtifactType, "artifact_type"), nullable=False)
    status: Mapped[ArtifactStatus] = mapped_column(enum_col(ArtifactStatus, "artifact_status"), nullable=False)
    canonical_spec: Mapped[dict[str, Any]] = mapped_column(JSONType, default=dict, nullable=False)
    rendered_uri: Mapped[str | None] = mapped_column(Text)
    locale: Mapped[str] = mapped_column(String(16), nullable=False)
    version: Mapped[int] = mapped_column(Integer, default=1, nullable=False)
    created_at: Mapped[datetime] = _created()
    updated_at: Mapped[datetime] = mapped_column(Tz(), default=utcnow, onupdate=utcnow, nullable=False)


class Skill(Base):
    __tablename__ = "skills"
    id: Mapped[uuid.UUID] = _uuid_pk()
    scope: Mapped[SkillScope] = mapped_column(enum_col(SkillScope, "skill_scope"), nullable=False)
    owner_id: Mapped[uuid.UUID | None] = mapped_column()  # ext: user or project id for non-GLOBAL scope
    name: Mapped[str] = mapped_column(String(200), nullable=False)
    version: Mapped[int] = mapped_column(Integer, default=1, nullable=False)
    instructions_en: Mapped[str] = mapped_column(Text, nullable=False)
    eval_score: Mapped[float | None] = mapped_column(Float)
    status: Mapped[SkillStatus] = mapped_column(enum_col(SkillStatus, "skill_status"), nullable=False)
    parent_version_id: Mapped[uuid.UUID | None] = mapped_column(ForeignKey("skills.id"))
    created_at: Mapped[datetime] = _created()

    __table_args__ = (UniqueConstraint("scope", "owner_id", "name", "version", name="uq_skill_version",
                                       postgresql_nulls_not_distinct=True),)


# ------------------------------------------------------------------ translation


class Message(Base):
    __tablename__ = "messages"
    id: Mapped[uuid.UUID] = _uuid_pk()
    user_id: Mapped[uuid.UUID] = mapped_column(ForeignKey("users.id", ondelete="CASCADE"), nullable=False)
    conversation_id: Mapped[uuid.UUID] = mapped_column(nullable=False)
    role: Mapped[MessageRole] = mapped_column(enum_col(MessageRole, "message_role"), nullable=False)
    raw_text: Mapped[str] = mapped_column(Text, nullable=False)
    raw_language: Mapped[str] = mapped_column(String(16), nullable=False)
    canonical_en: Mapped[str | None] = mapped_column(Text)
    display_text: Mapped[str | None] = mapped_column(Text)
    display_language: Mapped[str | None] = mapped_column(String(16))
    protected_spans: Mapped[list[Any]] = mapped_column(JSONType, default=list, nullable=False)
    source_message_id: Mapped[uuid.UUID | None] = mapped_column(ForeignKey("messages.id"))
    translation_status: Mapped[TranslationStatus] = mapped_column(
        enum_col(TranslationStatus, "translation_status"), nullable=False)
    requested_output_language: Mapped[str | None] = mapped_column(String(16))  # ext
    created_at: Mapped[datetime] = _created()

    __table_args__ = (Index("ix_messages_conversation_time", "conversation_id", "created_at"),)


class GlossaryEntry(Base):
    __tablename__ = "glossary_entries"
    id: Mapped[uuid.UUID] = _uuid_pk()
    user_id: Mapped[uuid.UUID | None] = mapped_column(ForeignKey("users.id", ondelete="CASCADE"))  # NULL = global
    source_lang: Mapped[str] = mapped_column(String(16), nullable=False)
    target_lang: Mapped[str] = mapped_column(String(16), nullable=False)
    source_term: Mapped[str] = mapped_column(Text, nullable=False)
    target_term: Mapped[str] = mapped_column(Text, nullable=False)
    do_not_translate: Mapped[bool] = mapped_column(Boolean, default=False, nullable=False)
    origin: Mapped[str] = mapped_column(String(32), default="seed", nullable=False)  # seed|user_correction|agent
    created_at: Mapped[datetime] = _created()
    updated_at: Mapped[datetime] = mapped_column(Tz(), default=utcnow, onupdate=utcnow, nullable=False)

    __table_args__ = (UniqueConstraint("user_id", "source_lang", "target_lang", "source_term",
                                       name="uq_glossary_term", postgresql_nulls_not_distinct=True),)


class TranslationCacheEntry(Base):
    __tablename__ = "translation_cache"
    key: Mapped[str] = mapped_column(String(64), primary_key=True)  # sha256(src|tgt|glossary_version|text)
    source_lang: Mapped[str] = mapped_column(String(16), nullable=False)
    target_lang: Mapped[str] = mapped_column(String(16), nullable=False)
    result: Mapped[str] = mapped_column(Text, nullable=False)
    hits: Mapped[int] = mapped_column(Integer, default=0, nullable=False)
    created_at: Mapped[datetime] = _created()


# ------------------------------------------------------------------ budget, quota, runs, audit


class QuotaState(Base):
    """Per provider window: what the spec §8 says to store."""
    __tablename__ = "quota_states"
    quota_key: Mapped[str] = mapped_column(String(64), primary_key=True)
    provider: Mapped[str] = mapped_column(String(64), nullable=False)
    quota_window_seconds: Mapped[int] = mapped_column(Integer, nullable=False)
    window_start: Mapped[datetime | None] = mapped_column(Tz())
    reset_time: Mapped[datetime | None] = mapped_column(Tz())
    capacity_units: Mapped[float] = mapped_column(Float, nullable=False)
    reserved_capacity: Mapped[float] = mapped_column(Float, nullable=False)
    remaining_estimate: Mapped[float | None] = mapped_column(Float)  # provider-observed, if any
    observed_at: Mapped[datetime | None] = mapped_column(Tz())
    updated_at: Mapped[datetime] = mapped_column(Tz(), default=utcnow, onupdate=utcnow, nullable=False)


class UsageRecord(Base):
    __tablename__ = "usage_records"
    id: Mapped[uuid.UUID] = _uuid_pk()
    user_id: Mapped[uuid.UUID | None] = mapped_column(ForeignKey("users.id", ondelete="CASCADE"))
    run_id: Mapped[uuid.UUID | None] = mapped_column(ForeignKey("runs.id", ondelete="SET NULL"))
    responsibility_id: Mapped[uuid.UUID | None] = mapped_column(ForeignKey("responsibilities.id", ondelete="SET NULL"))
    provider: Mapped[str] = mapped_column(String(64), nullable=False)
    model: Mapped[str | None] = mapped_column(String(128))
    tier: Mapped[int] = mapped_column(Integer, nullable=False)
    input_tokens: Mapped[int] = mapped_column(Integer, default=0, nullable=False)
    output_tokens: Mapped[int] = mapped_column(Integer, default=0, nullable=False)
    units: Mapped[float] = mapped_column(Float, nullable=False)
    category: Mapped[str] = mapped_column(String(64), nullable=False)
    exploration_scope: Mapped[str | None] = mapped_column(String(32))
    quota_key: Mapped[str | None] = mapped_column(String(64))
    proactive: Mapped[bool] = mapped_column(Boolean, nullable=False)
    created_at: Mapped[datetime] = _created()

    __table_args__ = (
        Index("ix_usage_user_cat_time", "user_id", "category", "created_at"),
        Index("ix_usage_quota_time", "quota_key", "created_at"),
        Index("ix_usage_responsibility", "responsibility_id"),
    )


class AllocationRecord(Base):
    __tablename__ = "allocations"
    id: Mapped[uuid.UUID] = _uuid_pk()
    user_id: Mapped[uuid.UUID] = mapped_column(ForeignKey("users.id", ondelete="CASCADE"), nullable=False)
    responsibility_id: Mapped[uuid.UUID | None] = mapped_column(ForeignKey("responsibilities.id", ondelete="SET NULL"))
    kind: Mapped[str] = mapped_column(String(64), nullable=False)
    category: Mapped[str] = mapped_column(String(64), nullable=False)
    proactive: Mapped[bool] = mapped_column(Boolean, nullable=False)
    outcome: Mapped[AllocationOutcome] = mapped_column(enum_col(AllocationOutcome, "allocation_outcome"), nullable=False)
    tier_requested: Mapped[int] = mapped_column(Integer, nullable=False)
    tier_granted: Mapped[int | None] = mapped_column(Integer)
    model: Mapped[str | None] = mapped_column(String(128))
    score: Mapped[float] = mapped_column(Float, nullable=False)
    score_breakdown: Mapped[dict[str, Any]] = mapped_column(JSONType, default=dict, nullable=False)
    justification: Mapped[dict[str, Any]] = mapped_column(JSONType, default=dict, nullable=False)
    limits: Mapped[dict[str, Any]] = mapped_column(JSONType, default=dict, nullable=False)
    reasons: Mapped[list[Any]] = mapped_column(JSONType, default=list, nullable=False)
    retry_after: Mapped[datetime | None] = mapped_column(Tz())
    created_at: Mapped[datetime] = _created()


class Run(Base):
    """Audit record of every meaningful run (spec §20)."""
    __tablename__ = "runs"
    id: Mapped[uuid.UUID] = _uuid_pk()
    user_id: Mapped[uuid.UUID] = mapped_column(ForeignKey("users.id", ondelete="CASCADE"), nullable=False)
    responsibility_id: Mapped[uuid.UUID | None] = mapped_column(ForeignKey("responsibilities.id", ondelete="SET NULL"))
    allocation_id: Mapped[uuid.UUID | None] = mapped_column(ForeignKey("allocations.id", ondelete="SET NULL"))
    kind: Mapped[str] = mapped_column(String(64), nullable=False)
    category: Mapped[str] = mapped_column(String(64), nullable=False)
    exploration_scope: Mapped[str | None] = mapped_column(String(32))
    proactive: Mapped[bool] = mapped_column(Boolean, nullable=False)
    status: Mapped[RunStatus] = mapped_column(enum_col(RunStatus, "run_status"), nullable=False)
    why_now: Mapped[str | None] = mapped_column(Text)
    expected_gain: Mapped[str | None] = mapped_column(Text)
    decision_affected: Mapped[str | None] = mapped_column(Text)
    budget: Mapped[dict[str, Any]] = mapped_column(JSONType, default=dict, nullable=False)
    stop_condition: Mapped[str | None] = mapped_column(Text)
    tension_before: Mapped[float | None] = mapped_column(Float)
    tension_after: Mapped[float | None] = mapped_column(Float)
    provider: Mapped[str | None] = mapped_column(String(64))
    model: Mapped[str | None] = mapped_column(String(128))
    tier: Mapped[int | None] = mapped_column(Integer)
    input_tokens: Mapped[int] = mapped_column(Integer, default=0, nullable=False)
    output_tokens: Mapped[int] = mapped_column(Integer, default=0, nullable=False)
    cost_units: Mapped[float] = mapped_column(Float, default=0.0, nullable=False)
    tools: Mapped[list[Any]] = mapped_column(JSONType, default=list, nullable=False)
    new_evidence: Mapped[list[Any]] = mapped_column(JSONType, default=list, nullable=False)
    belief_changes: Mapped[list[Any]] = mapped_column(JSONType, default=list, nullable=False)
    artifact_changes: Mapped[list[Any]] = mapped_column(JSONType, default=list, nullable=False)
    stop_reason: Mapped[str | None] = mapped_column(Text)
    user_notified: Mapped[bool] = mapped_column(Boolean, default=False, nullable=False)
    user_response: Mapped[str | None] = mapped_column(Text)
    error: Mapped[str | None] = mapped_column(Text)
    started_at: Mapped[datetime] = _created()
    ended_at: Mapped[datetime | None] = mapped_column(Tz())

    __table_args__ = (Index("ix_runs_user_time", "user_id", "started_at"),)


class AuditLog(Base):
    """Append-only structured audit log: transitions, permission checks, policy changes."""
    __tablename__ = "audit_log"
    id: Mapped[uuid.UUID] = _uuid_pk()
    user_id: Mapped[uuid.UUID | None] = mapped_column(ForeignKey("users.id", ondelete="CASCADE"))
    actor: Mapped[Origin] = mapped_column(enum_col(Origin, "origin"), nullable=False)
    kind: Mapped[str] = mapped_column(String(64), nullable=False)
    entity_type: Mapped[str] = mapped_column(String(64), nullable=False)
    entity_id: Mapped[uuid.UUID | None] = mapped_column()
    payload: Mapped[dict[str, Any]] = mapped_column(JSONType, default=dict, nullable=False)
    created_at: Mapped[datetime] = _created()

    __table_args__ = (Index("ix_audit_entity", "entity_type", "entity_id", "created_at"),)
