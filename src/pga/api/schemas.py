"""Request/response models for the HTTP API."""

from __future__ import annotations

import uuid
from datetime import datetime
from typing import Any, Literal

from pydantic import BaseModel, Field

from pga.allocator import Estimates, Justification
from pga.db.types import FactType


class UserCreate(BaseModel):
    locale: str = "zh-CN"
    timezone: str = "Asia/Shanghai"
    preferences: dict[str, Any] = {}


class UserOut(BaseModel):
    id: uuid.UUID
    locale: str
    model_language: str
    timezone: str
    preferences: dict[str, Any]


class PreferencesPatch(BaseModel):
    preferences: dict[str, Any]


class EvolutionPatch(BaseModel):
    paused: bool


class BodyIn(BaseModel):
    kind: Literal["database", "skill"]
    title: str = Field(min_length=1, max_length=300)
    description: str = Field("", max_length=8000)
    aim_id: uuid.UUID | None = None
    private: bool = False


class BodyPatch(BaseModel):
    title: str | None = Field(None, min_length=1, max_length=300)
    description: str | None = Field(None, max_length=2000)
    private: bool | None = None
    aim_id: uuid.UUID | Literal[""] | None = None


class BridgeIn(BaseModel):
    a: str = Field(min_length=1, max_length=80)   # graph refs: an agent id, "k:<body id>" or "aim:<aim id>"
    b: str = Field(min_length=1, max_length=80)
    note: str = Field("", max_length=500)


class LayersBuildIn(BaseModel):
    ref: str = Field(min_length=3, max_length=80)
    force: bool = False


class AimCreate(BaseModel):
    text: str = Field(min_length=1, max_length=20000)        # long aims are condensed, short ones expanded (pga.layers)


class AimIn(BaseModel):
    text: str = Field("", max_length=20000)  # the long-range aim at the centre of everything; "" clears it


class VaultExportIn(BaseModel):
    path: str | None = None  # default: PGA_VAULT_DIR, or the user's `vault_dir` preference


class ChatIn(BaseModel):
    user_id: uuid.UUID
    text: str = Field(min_length=1, max_length=50_000)
    conversation_id: uuid.UUID | None = None
    responsibility_id: uuid.UUID | None = Field(None, description="Talk to this responsibility's agent")


class MessageOut(BaseModel):
    id: uuid.UUID
    role: str
    display_text: str | None
    display_language: str | None
    canonical_en: str | None
    raw_language: str
    translation_status: str
    requested_output_language: str | None = None
    created_at: datetime


class ChatOut(BaseModel):
    conversation_id: uuid.UUID
    user_message: MessageOut
    reply: MessageOut
    allocation: dict[str, Any]
    run_id: uuid.UUID | None


class FactIn(BaseModel):
    type: FactType
    text: str = Field(min_length=1)
    topic: str | None = None
    source_uri: str | None = None
    confidence: float = Field(1.0, ge=0, le=1)
    valid_until: datetime | None = None


class ResponsibilityIn(BaseModel):
    title: str = Field(min_length=1, description="Any language; stored as raw_title + canonical English")
    description: str = ""
    keywords: list[str] = []
    priority_bias: float = 0.0
    wake_threshold: float | None = Field(None, ge=0, le=1)
    sleep_threshold: float | None = Field(None, ge=0, le=1)
    compute_budget: dict[str, Any] = {}
    initial_status: Literal["ACTIVE", "MONITORING"] = "MONITORING"
    aim_id: uuid.UUID | None = None  # which long-range aim it serves (default: the first one)


class ResponsibilityPatch(BaseModel):
    title: str | None = None
    description: str | None = None
    keywords: list[str] | None = None
    priority_bias: float | None = None
    wake_threshold: float | None = Field(None, ge=0, le=1)
    sleep_threshold: float | None = Field(None, ge=0, le=1)
    compute_budget: dict[str, Any] | None = None
    next_review_at: datetime | None = None
    aim_id: uuid.UUID | Literal[""] | None = None  # "" detaches it from any aim


class ResponsibilityOut(BaseModel):
    id: uuid.UUID
    parent_id: uuid.UUID | None
    aim_id: uuid.UUID | None = None
    title_en: str
    title_display: str | None = None
    raw_title: str | None
    description_en: str
    status: str
    tension: float
    wake_threshold: float
    sleep_threshold: float
    paused_by_user: bool
    created_by: str
    keywords: list[str]
    useful_outcomes: int
    candidate_expires_at: datetime | None
    next_review_at: datetime | None
    updated_at: datetime


class ActionIn(BaseModel):
    reason: str = ""


class RejectIn(BaseModel):
    cluster_id: uuid.UUID | None = None
    note: str = ""


class AdjustIn(BaseModel):
    delta: float = Field(ge=-1, le=1)
    reason: str = Field(min_length=1)


class SignalsIn(BaseModel):
    relevance: float = Field(ge=0, le=1)
    novelty: float | None = Field(None, ge=0, le=1)
    uncertainty: float | None = Field(None, ge=0, le=1)
    decision_impact: float | None = Field(None, ge=0, le=1)
    deadline: float = Field(0.0, ge=0, le=1)
    dependency: float = Field(0.0, ge=0, le=1)
    user_interest: float = Field(0.0, ge=0, le=1)
    contradiction: float = Field(0.0, ge=0, le=1)
    opportunity: float = Field(0.0, ge=0, le=1)
    rationale: str = ""


class EventIn(BaseModel):
    text: str = Field(min_length=1)
    source_type: str = "web"
    source_uri: str | None = None
    title: str | None = None
    published_at: datetime | None = None
    trust_score: float | None = Field(None, ge=0, le=1)
    event_key: str | None = None
    expires_at: datetime | None = None
    signals: dict[uuid.UUID, SignalsIn] | None = Field(
        None, description="Optional per-responsibility signals from an upstream classifier")


class AllocationIn(BaseModel):
    user_id: uuid.UUID
    kind: str
    responsibility_id: uuid.UUID | None = None
    preferred_tier: int | None = Field(None, ge=0, le=3)
    category: str | None = None
    exploration_scope: str | None = None
    justification: Justification = Justification()
    estimates: Estimates = Estimates()


class QuotaObserveIn(BaseModel):
    remaining: float = Field(ge=0)
    reset_time: datetime | None = None


class GlossaryCorrectionIn(BaseModel):
    source_lang: str
    target_lang: str
    source_term: str = Field(min_length=1)
    corrected: str = Field(min_length=1)


class TermIn(BaseModel):
    term: str = Field(min_length=1)


class PermissionsPatch(BaseModel):
    rules: dict[str, Literal["auto", "approval", "deny"]]


class UserResponseIn(BaseModel):
    response: str = Field(min_length=1)


# ---------------------------------------------------------------- Phase 2


class SourceIn(BaseModel):
    kind: Literal["FEED", "ARXIV", "WEB_PAGE"]
    uri: str | None = None
    query: str | None = None
    title: str | None = None
    responsibility_id: uuid.UUID | None = None
    interval_minutes: int = Field(60, ge=15, le=7 * 24 * 60)
    trust_score: float = Field(0.6, ge=0, le=1)


class SourcePatch(BaseModel):
    enabled: bool | None = None
    interval_minutes: int | None = Field(None, ge=15, le=7 * 24 * 60)
    title: str | None = None


class AnswerIn(BaseModel):
    text: str = Field(min_length=1, max_length=10_000)


# ---------------------------------------------------------------- Agent Hub


class HubAgentIn(BaseModel):
    name: str = Field(min_length=1, max_length=200)
    vendor: str = Field("other", max_length=40)
    connector: Literal["import", "manual", "claude_code", "hermes"] = "import"
    usage: Literal["current", "past"] = "current"
    notes: str = Field("", max_length=2000)


class HubAgentPatch(BaseModel):
    name: str | None = Field(None, min_length=1, max_length=200)
    usage: Literal["current", "past"] | None = None
    notes: str | None = Field(None, max_length=2000)
