"""Shared column types and enums.

Enums are stored as constrained VARCHAR (not native PG enums) so adding a value
is a one-line migration rather than an ALTER TYPE dance.
"""

from __future__ import annotations

import enum
from datetime import datetime, timezone

from sqlalchemy import JSON, DateTime, Enum as SAEnum
from sqlalchemy.dialects.postgresql import JSONB

JSONType = JSON().with_variant(JSONB(), "postgresql")


def utcnow() -> datetime:
    return datetime.now(timezone.utc)


def Tz() -> DateTime:  # noqa: N802 - reads like a type
    return DateTime(timezone=True)


def enum_col(e: type[enum.Enum], name: str) -> SAEnum:
    return SAEnum(e, name=name, native_enum=False, create_constraint=True, length=32,
                  values_callable=lambda x: [m.value for m in x], validate_strings=True)


class StrEnum(str, enum.Enum):
    def __str__(self) -> str:  # pragma: no cover - cosmetic
        return self.value


class FactType(StrEnum):
    FACT = "FACT"
    USER_FACT = "USER_FACT"
    OBSERVATION = "OBSERVATION"
    PREFERENCE = "PREFERENCE"
    INFERRED_PREFERENCE = "INFERRED_PREFERENCE"


class Origin(StrEnum):
    """Who produced a record. External content may never change goals/policy (invariant 11)."""
    USER = "USER"
    AGENT = "AGENT"
    EXTERNAL = "EXTERNAL"
    SYSTEM = "SYSTEM"


class ResponsibilityStatus(StrEnum):
    ACTIVE = "ACTIVE"
    MONITORING = "MONITORING"
    SLEEPING = "SLEEPING"
    WAIT_USER = "WAIT_USER"
    WAIT_EXTERNAL = "WAIT_EXTERNAL"
    COMPLETED = "COMPLETED"
    ARCHIVED = "ARCHIVED"
    CANDIDATE = "CANDIDATE"


PERPETUAL_STATUSES = frozenset({
    ResponsibilityStatus.ACTIVE, ResponsibilityStatus.MONITORING, ResponsibilityStatus.SLEEPING,
    ResponsibilityStatus.WAIT_USER, ResponsibilityStatus.WAIT_EXTERNAL,
})
TERMINAL_STATUSES = frozenset({ResponsibilityStatus.COMPLETED, ResponsibilityStatus.ARCHIVED})


class BeliefType(StrEnum):
    HYPOTHESIS = "HYPOTHESIS"
    CONCLUSION = "CONCLUSION"
    UNCERTAINTY = "UNCERTAINTY"


class BeliefStatus(StrEnum):
    ACTIVE = "ACTIVE"
    REFUTED = "REFUTED"
    STALE = "STALE"
    RESOLVED = "RESOLVED"


class DecidedBy(StrEnum):
    USER = "USER"
    AGENT = "AGENT"
    JOINT = "JOINT"


class ArtifactType(StrEnum):
    BRIEF = "BRIEF"
    DASHBOARD = "DASHBOARD"
    PPT = "PPT"
    VIDEO = "VIDEO"
    AUDIO = "AUDIO"
    REPORT = "REPORT"
    CODE = "CODE"


class ArtifactStatus(StrEnum):
    CURRENT = "CURRENT"
    STALE = "STALE"
    RENDERING = "RENDERING"
    FAILED = "FAILED"


class SkillScope(StrEnum):
    GLOBAL = "GLOBAL"
    USER = "USER"
    PROJECT = "PROJECT"


class SkillStatus(StrEnum):
    CANDIDATE = "CANDIDATE"
    ACTIVE = "ACTIVE"
    DEPRECATED = "DEPRECATED"
    ROLLED_BACK = "ROLLED_BACK"


class MessageRole(StrEnum):
    USER = "user"
    ASSISTANT = "assistant"
    TOOL = "tool"
    SYSTEM = "system"


class TranslationStatus(StrEnum):
    NOT_NEEDED = "NOT_NEEDED"      # already in the target language
    TRANSLATED = "TRANSLATED"
    BYPASSED = "BYPASSED"          # user explicitly asked for the canonical language
    FAILED = "FAILED"              # fell back to the untranslated text
    PENDING = "PENDING"


class TensionChangeKind(StrEnum):
    EVENT = "EVENT"
    DECAY = "DECAY"
    RESOLUTION = "RESOLUTION"
    REJECTION = "REJECTION"
    EXPIRY = "EXPIRY"
    ABSORPTION = "ABSORPTION"
    MANUAL = "MANUAL"


class AllocationOutcome(StrEnum):
    APPROVED = "APPROVED"
    DOWNGRADED = "DOWNGRADED"
    DEFERRED = "DEFERRED"
    DENIED = "DENIED"


class RunStatus(StrEnum):
    RUNNING = "RUNNING"
    SUCCEEDED = "SUCCEEDED"
    FAILED = "FAILED"
    STOPPED = "STOPPED"
    BUDGET_EXCEEDED = "BUDGET_EXCEEDED"
    TIMEOUT = "TIMEOUT"


class PermissionLevel(StrEnum):
    READ = "READ"
    RESEARCH = "RESEARCH"
    PREPARE = "PREPARE"
    SUGGEST = "SUGGEST"
    EXECUTE = "EXECUTE"
    EXTERNAL_ACTION = "EXTERNAL_ACTION"
    SPEND = "SPEND"
    PUBLISH = "PUBLISH"


# ------------------------------------------------------------------ Phase 2: perpetual loop


class JobStatus(StrEnum):
    QUEUED = "QUEUED"
    RUNNING = "RUNNING"
    WAITING = "WAITING"            # parked on an external event or the user (wait_for_event / wait_for_user)
    SUCCEEDED = "SUCCEEDED"
    FAILED = "FAILED"              # out of attempts; `retry` re-queues it
    CANCELLED = "CANCELLED"


ACTIVE_JOB_STATUSES = frozenset({JobStatus.QUEUED, JobStatus.RUNNING, JobStatus.WAITING})


class SourceKind(StrEnum):
    FEED = "FEED"                  # RSS / Atom
    ARXIV = "ARXIV"                # arXiv search query (Atom API)
    WEB_PAGE = "WEB_PAGE"          # watch one page for changes


class CommKind(StrEnum):
    """What the agent decided to say (spec §16), from quietest to loudest."""
    SILENT = "SILENT"
    NOTIFICATION = "NOTIFICATION"
    BRIEF = "BRIEF"
    QUESTION = "QUESTION"
    MEETING = "MEETING"


class NotifyReason(StrEnum):
    """The only reasons the agent may interrupt the user (spec §16)."""
    CONCLUSION_CHANGED = "CONCLUSION_CHANGED"
    DEADLINE = "DEADLINE"
    DECISION_REQUIRED = "DECISION_REQUIRED"
    ARTIFACT_READY = "ARTIFACT_READY"
    UNCERTAINTY = "UNCERTAINTY"


class NotificationStatus(StrEnum):
    PENDING = "PENDING"            # held (quiet hours / rate limit) until it can be delivered
    DELIVERED = "DELIVERED"
    READ = "READ"
    ANSWERED = "ANSWERED"
    DISMISSED = "DISMISSED"
    SUPPRESSED = "SUPPRESSED"      # decided not to interrupt; kept for the "why so quiet?" view
