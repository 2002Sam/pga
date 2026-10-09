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


class ChatIn(BaseModel):
    user_id: uuid.UUID
    text: str = Field(min_length=1, max_length=50_000)
    conversation_id: uuid.UUID | None = None


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


class ResponsibilityPatch(BaseModel):
    title: str | None = None
    description: str | None = None
    keywords: list[str] | None = None
    priority_bias: float | None = None
    wake_threshold: float | None = Field(None, ge=0, le=1)
    sleep_threshold: float | None = Field(None, ge=0, le=1)
    compute_budget: dict[str, Any] | None = None
    next_review_at: datetime | None = None


class ResponsibilityOut(BaseModel):
    id: uuid.UUID
    parent_id: uuid.UUID | None
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
