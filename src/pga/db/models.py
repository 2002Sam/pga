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
    text,
    Boolean, Float, ForeignKey, Index, Integer, MetaData, String, Text, UniqueConstraint, Uuid,
)
from sqlalchemy.orm import DeclarativeBase, Mapped, mapped_column, relationship

from .types import (
    AllocationOutcome, ArtifactStatus, ArtifactType, BeliefStatus, BeliefType, CommKind, DecidedBy,
    FactType, JobStatus, JSONType, MessageRole, NotificationStatus, Origin, ResponsibilityStatus, RunStatus,
    SkillScope, SkillStatus, SourceKind, TensionChangeKind, TranslationStatus, Tz, enum_col, utcnow,
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


class Aim(Base):
    """A long-range aim — a motivation. Each one is a solar system in the UI; responsibilities serve one aim."""
    __tablename__ = "aims"
    id: Mapped[uuid.UUID] = _uuid_pk()
    user_id: Mapped[uuid.UUID] = mapped_column(ForeignKey("users.id", ondelete="CASCADE"), nullable=False)
    text: Mapped[str] = mapped_column(Text, nullable=False)          # as the user wrote it
    text_en: Mapped[str] = mapped_column(Text, nullable=False)       # canonical English for the model
    position: Mapped[int] = mapped_column(Integer, default=0, nullable=False)
    team: Mapped[dict[str, Any]] = mapped_column(JSONType, default=dict, nullable=False)   # role → agent you chose (teams.py)
    created_at: Mapped[datetime] = _created()

    __table_args__ = (Index("ix_aims_user_position", "user_id", "position"),)


class PerpetualTask(Base):
    """A perpetual task (永续任务): an aim its team works on without stopping, paced by pressure (perpetual.py)."""
    __tablename__ = "perpetual_tasks"
    id: Mapped[uuid.UUID] = _uuid_pk()
    user_id: Mapped[uuid.UUID] = mapped_column(ForeignKey("users.id", ondelete="CASCADE"), nullable=False)
    aim_id: Mapped[uuid.UUID] = mapped_column(ForeignKey("aims.id", ondelete="CASCADE"), nullable=False, unique=True)
    project_id: Mapped[uuid.UUID | None] = mapped_column(ForeignKey("projects.id", ondelete="SET NULL"))
    status: Mapped[str] = mapped_column(String(16), default="running", nullable=False)     # running | paused | stopped
    phase: Mapped[str] = mapped_column(String(16), default="starting", nullable=False)     # think | investigate | evolve | reflect | rest | quota | error
    phase_note: Mapped[str] = mapped_column(Text, default="", nullable=False)
    phase_since: Mapped[datetime | None] = mapped_column(Tz())
    next_at: Mapped[datetime | None] = mapped_column(Tz())
    pressure: Mapped[float] = mapped_column(Float, default=0.5, nullable=False)
    parts: Mapped[dict[str, Any]] = mapped_column(JSONType, default=dict, nullable=False)       # pressure by channel
    ledger: Mapped[list[Any]] = mapped_column(JSONType, default=list, nullable=False)           # each cycle: what, why, how long
    work_s: Mapped[float] = mapped_column(Float, default=0.0, nullable=False)
    rest_s: Mapped[float] = mapped_column(Float, default=0.0, nullable=False)
    pause_s: Mapped[float] = mapped_column(Float, default=0.0, nullable=False)                 # waiting for quota to reset
    cycles: Mapped[int] = mapped_column(Integer, default=0, nullable=False)
    settings: Mapped[dict[str, Any]] = mapped_column(JSONType, default=dict, nullable=False)
    created_at: Mapped[datetime] = _created()
    updated_at: Mapped[datetime | None] = mapped_column(Tz())


class ThoughtNode(Base):
    """One node of a motivation's thought tree (思考树): a stretch of the self-dialogue with one line of thought, cut where
    attention turned (tree.py). The root is the motivation itself (parent_id None). Branches are lines of thought that
    split off; a bud is an idea not yet followed."""
    __tablename__ = "thought_nodes"
    id: Mapped[uuid.UUID] = _uuid_pk()
    user_id: Mapped[uuid.UUID] = mapped_column(ForeignKey("users.id", ondelete="CASCADE"), nullable=False)
    aim_id: Mapped[uuid.UUID | None] = mapped_column(ForeignKey("aims.id", ondelete="CASCADE"))   # None: your conversation tree
    # aim: a motivation's self-dialogue (the agents talk) | user: your own conversations with agents (PGA's and imported)
    scope: Mapped[str] = mapped_column(String(16), default="aim", server_default="aim", nullable=False)
    parent_id: Mapped[uuid.UUID | None] = mapped_column(ForeignKey("thought_nodes.id", ondelete="CASCADE"))
    kind: Mapped[str] = mapped_column(String(16), default="segment", nullable=False)     # segment | user | exchange
    seq: Mapped[int] = mapped_column(Integer, default=0, nullable=False)                 # growth order within the tree
    title: Mapped[str] = mapped_column(Text, default="", nullable=False)
    summary: Mapped[str] = mapped_column(Text, default="", nullable=False)
    shift: Mapped[str] = mapped_column(Text, default="", nullable=False)                 # why attention turned here
    key_thoughts: Mapped[list[Any]] = mapped_column(JSONType, default=list, nullable=False)
    note_ids: Mapped[list[Any]] = mapped_column(JSONType, default=list, nullable=False)  # aim_notes in this stretch
    first_at: Mapped[datetime | None] = mapped_column(Tz())
    last_at: Mapped[datetime | None] = mapped_column(Tz())
    git: Mapped[dict[str, Any]] = mapped_column(JSONType, default=dict, nullable=False)  # commits, files, links
    data: Mapped[dict[str, Any]] = mapped_column(JSONType, default=dict, nullable=False)
    created_at: Mapped[datetime] = _created()
    updated_at: Mapped[datetime | None] = mapped_column(Tz())

    __table_args__ = (Index("ix_thought_nodes_aim_seq", "aim_id", "seq"),)


class Project(Base):
    """A folder agents work in. It belongs to a motivation (an aim) as one of its working folders, or stays free for
    one-off tasks; chosen per conversation, independent of which agent you use."""
    __tablename__ = "projects"
    id: Mapped[uuid.UUID] = _uuid_pk()
    user_id: Mapped[uuid.UUID] = mapped_column(ForeignKey("users.id", ondelete="CASCADE"), nullable=False)
    name: Mapped[str] = mapped_column(String(120), nullable=False)
    path: Mapped[str] = mapped_column(Text, nullable=False)
    notes: Mapped[str] = mapped_column(Text, default="", nullable=False)
    full_access: Mapped[bool] = mapped_column(Boolean, default=False, nullable=False)   # agents may run commands and edit files
    aim_id: Mapped[uuid.UUID | None] = mapped_column(ForeignKey("aims.id", ondelete="SET NULL"))   # the motivation it serves (none: a free folder)
    created_at: Mapped[datetime] = _created()
    last_used_at: Mapped[datetime | None] = mapped_column(Tz())

    __table_args__ = (UniqueConstraint("user_id", "path", name="uq_projects_user_path"),)

    aim: Mapped["Aim | None"] = relationship()


class AimNote(Base):
    """The aim's team board: your corrections, and each round's plan, work, review and summary by the agents."""
    __tablename__ = "aim_notes"
    id: Mapped[uuid.UUID] = _uuid_pk()
    user_id: Mapped[uuid.UUID] = mapped_column(ForeignKey("users.id", ondelete="CASCADE"), nullable=False)
    aim_id: Mapped[uuid.UUID] = mapped_column(ForeignKey("aims.id", ondelete="CASCADE"), nullable=False)
    round_id: Mapped[uuid.UUID | None] = mapped_column()
    kind: Mapped[str] = mapped_column(String(16), nullable=False)        # correction | plan | work | review | summary | change
    role: Mapped[str | None] = mapped_column(String(16))
    agent: Mapped[str | None] = mapped_column(String(64))
    text: Mapped[str] = mapped_column(Text, nullable=False)              # as written (yours in your language)
    text_en: Mapped[str] = mapped_column(Text, default="", nullable=False)
    data: Mapped[dict[str, Any]] = mapped_column(JSONType, default=dict, nullable=False)
    status: Mapped[str] = mapped_column(String(16), default="done", nullable=False)   # pending | applied | failed | done
    created_at: Mapped[datetime] = _created()

    __table_args__ = (Index("ix_aim_notes_aim_time", "aim_id", "created_at"),)


class Body(Base):
    """A body on an ambition's map that is not an agent: a database (a store of knowledge) or a skill.
    `private` bodies are shown to the user but never sent to a model."""
    __tablename__ = "bodies"
    id: Mapped[uuid.UUID] = _uuid_pk()
    user_id: Mapped[uuid.UUID] = mapped_column(ForeignKey("users.id", ondelete="CASCADE"), nullable=False)
    aim_id: Mapped[uuid.UUID | None] = mapped_column(ForeignKey("aims.id", ondelete="SET NULL"))
    kind: Mapped[str] = mapped_column(String(16), nullable=False)                 # database | skill
    title: Mapped[str] = mapped_column(Text, nullable=False)
    title_en: Mapped[str] = mapped_column(Text, nullable=False)
    description: Mapped[str] = mapped_column(Text, default="", nullable=False)
    description_en: Mapped[str] = mapped_column(Text, default="", nullable=False)
    private: Mapped[bool] = mapped_column(Boolean, default=False, nullable=False)
    origin: Mapped[Origin] = mapped_column(enum_col(Origin, "origin"), nullable=False)   # USER, or AGENT when auto-created
    # a dataset PGA keeps itself: "user" (who you are), "world" (what is happening), "aim" (what a motivation learned)
    system: Mapped[str | None] = mapped_column(String(16))
    compiled_at: Mapped[datetime | None] = mapped_column(Tz())               # when its full text was last rebuilt
    data: Mapped[dict[str, Any] | None] = mapped_column(JSONType)           # structure, e.g. the personal model's five dimensions
    created_at: Mapped[datetime] = _created()

    __table_args__ = (Index("ix_bodies_user_aim", "user_id", "aim_id"),)


class Layer(Base):
    """One level of an item's information pyramid (1 gist · 2 brief · 3 full). `ref` is a graph ref: `aim:<id>`,
    `k:<body id>` or a responsibility id. `mode`: source (the user's own text), condensed, expanded (the assistant's
    elaboration of a short text), or rule (cut without a model). `source_hash` tells when the item changed."""
    __tablename__ = "layers"
    id: Mapped[uuid.UUID] = _uuid_pk()
    user_id: Mapped[uuid.UUID] = mapped_column(ForeignKey("users.id", ondelete="CASCADE"), nullable=False)
    ref: Mapped[str] = mapped_column(String(80), nullable=False)
    level: Mapped[int] = mapped_column(Integer, nullable=False)
    text_en: Mapped[str] = mapped_column(Text, nullable=False)
    text: Mapped[str] = mapped_column(Text, nullable=False)                      # in the user's language
    mode: Mapped[str] = mapped_column(String(16), nullable=False)
    words: Mapped[int] = mapped_column(Integer, default=0, nullable=False)
    source_hash: Mapped[str] = mapped_column(String(64), nullable=False)
    updated_at: Mapped[datetime] = mapped_column(Tz(), default=utcnow, nullable=False)

    __table_args__ = (UniqueConstraint("user_id", "ref", "level", name="uq_layer_ref_level"), Index("ix_layers_ref", "ref"))


class Snapshot(Base):
    """What PGA was doing at a moment: written every few minutes, when it stops, and when it comes back (after
    recovering). `data` lists running/queued jobs, open runs, R0, open evolution rounds and the code version.
    Also mirrored as JSON files under ~/Documents/PGA/snapshots/."""
    __tablename__ = "snapshots"
    id: Mapped[uuid.UUID] = _uuid_pk()
    kind: Mapped[str] = mapped_column(String(16), nullable=False)          # start | periodic | shutdown | recovered
    worker_id: Mapped[str] = mapped_column(String(128), nullable=False)
    at: Mapped[datetime] = mapped_column(Tz(), default=utcnow, nullable=False)
    data: Mapped[dict[str, Any]] = mapped_column(JSONType, default=dict, nullable=False)

    __table_args__ = (Index("ix_snapshots_at", "at"),)


class AgentRun(Base):
    """One run of an external agent (Claude Code, Codex, Hermes, a process, an HTTP agent, or PGA's own model)
    through the agent pool. Council and convoy runs have children (answers, reviews, subtasks, the synthesis)."""
    __tablename__ = "agent_runs"
    id: Mapped[uuid.UUID] = _uuid_pk()
    user_id: Mapped[uuid.UUID | None] = mapped_column(ForeignKey("users.id", ondelete="CASCADE"))
    parent_id: Mapped[uuid.UUID | None] = mapped_column(ForeignKey("agent_runs.id", ondelete="CASCADE"))
    job_id: Mapped[uuid.UUID | None] = mapped_column(ForeignKey("jobs.id", ondelete="SET NULL"))
    workflow: Mapped[str] = mapped_column(String(40), nullable=False)
    pattern: Mapped[str] = mapped_column(String(16), nullable=False)       # single | council | convoy
    step: Mapped[str] = mapped_column(String(24), nullable=False)          # run | answer | review | synthesis | plan | work | merge
    agent: Mapped[str] = mapped_column(String(64), nullable=False)
    adapter: Mapped[str] = mapped_column(String(32), nullable=False)
    status: Mapped[str] = mapped_column(String(16), nullable=False)        # SUCCEEDED | FAILED | TIMEOUT | SKIPPED | INTERRUPTED
    prompt: Mapped[str] = mapped_column(Text, default="", nullable=False)
    output: Mapped[str] = mapped_column(Text, default="", nullable=False)
    data: Mapped[dict[str, Any]] = mapped_column(JSONType, default=dict, nullable=False)
    error: Mapped[str | None] = mapped_column(Text)
    workspace: Mapped[str | None] = mapped_column(Text)
    cost_usd: Mapped[float | None] = mapped_column(Float)
    duration_s: Mapped[float] = mapped_column(Float, default=0.0, nullable=False)
    attempt: Mapped[int] = mapped_column(Integer, default=1, nullable=False)
    started_at: Mapped[datetime] = mapped_column(Tz(), default=utcnow, nullable=False)
    finished_at: Mapped[datetime | None] = mapped_column(Tz())

    __table_args__ = (Index("ix_agent_runs_user_time", "user_id", "started_at"), Index("ix_agent_runs_parent", "parent_id"))


class KgEpisode(Base):
    """记忆里的一段原始材料 (graphiti's EpisodicNode, pga.kg): one stretch of a conversation that facts were read from."""
    __tablename__ = "kg_episodes"
    id: Mapped[uuid.UUID] = _uuid_pk()
    user_id: Mapped[uuid.UUID] = mapped_column(ForeignKey("users.id", ondelete="CASCADE"), nullable=False, index=True)
    ref: Mapped[str] = mapped_column(String(200), nullable=False, index=True)    # the conversation (timeline item key)
    part: Mapped[int] = mapped_column(Integer, default=0, nullable=False)        # which stretch of it (new turns → a new episode)
    content: Mapped[str] = mapped_column(Text, default="", nullable=False)
    valid_at: Mapped[datetime | None] = mapped_column(Tz())                       # graphiti's reference time
    data: Mapped[dict[str, Any]] = mapped_column(JSONType, default=dict, nullable=False)     # title, turns, counts, error
    created_at: Mapped[datetime] = _created()


class KgEntity(Base):
    """An entity in the fact graph (graphiti's EntityNode)."""
    __tablename__ = "kg_entities"
    id: Mapped[uuid.UUID] = _uuid_pk()
    user_id: Mapped[uuid.UUID] = mapped_column(ForeignKey("users.id", ondelete="CASCADE"), nullable=False, index=True)
    name: Mapped[str] = mapped_column(Text, nullable=False)
    label: Mapped[str] = mapped_column(String(40), default="Entity", nullable=False)
    summary: Mapped[str] = mapped_column(Text, default="", nullable=False)
    data: Mapped[dict[str, Any]] = mapped_column(JSONType, default=dict, nullable=False)     # episodes, refs
    created_at: Mapped[datetime] = _created()


class KgEdge(Base):
    """A fact between two entities, with when it held (graphiti's EntityEdge): valid_at / invalid_at are when it was
    true in the world, expired_at when PGA learned it no longer holds. Facts are never deleted, only invalidated."""
    __tablename__ = "kg_edges"
    id: Mapped[uuid.UUID] = _uuid_pk()
    user_id: Mapped[uuid.UUID] = mapped_column(ForeignKey("users.id", ondelete="CASCADE"), nullable=False, index=True)
    source_id: Mapped[uuid.UUID] = mapped_column(ForeignKey("kg_entities.id", ondelete="CASCADE"), nullable=False, index=True)
    target_id: Mapped[uuid.UUID] = mapped_column(ForeignKey("kg_entities.id", ondelete="CASCADE"), nullable=False, index=True)
    relation: Mapped[str] = mapped_column(String(80), nullable=False)
    fact: Mapped[str] = mapped_column(Text, nullable=False)
    episodes: Mapped[list[Any]] = mapped_column(JSONType, default=list, nullable=False)       # episode ids it was read from
    refs: Mapped[list[Any]] = mapped_column(JSONType, default=list, nullable=False)           # the conversations behind them
    valid_at: Mapped[datetime | None] = mapped_column(Tz())
    invalid_at: Mapped[datetime | None] = mapped_column(Tz())
    expired_at: Mapped[datetime | None] = mapped_column(Tz())
    invalidated_by: Mapped[uuid.UUID | None] = mapped_column(Uuid)                # the fact that made it false
    created_at: Mapped[datetime] = _created()


class Dream(Base):
    """做梦: while you are away PGA looks back over a few of your conversations, follows what they link to, writes down
    what it saw, and proposes tidying the world tree and your self knowledge. `ops` are proposals: each waits for you
    (status pending → done | rejected, with your reason) and only then is carried out (pga.dream)."""
    __tablename__ = "dreams"
    id: Mapped[uuid.UUID] = _uuid_pk()
    user_id: Mapped[uuid.UUID] = mapped_column(ForeignKey("users.id", ondelete="CASCADE"), nullable=False, index=True)
    narrative: Mapped[str] = mapped_column(Text, default="", nullable=False)
    seeds: Mapped[list[Any]] = mapped_column(JSONType, default=list, nullable=False)     # the world-tree nodes it started from
    recalled: Mapped[list[Any]] = mapped_column(JSONType, default=list, nullable=False)  # what it was led to
    ops: Mapped[list[Any]] = mapped_column(JSONType, default=list, nullable=False)
    status: Mapped[str] = mapped_column(String(12), default="pending", nullable=False)   # pending | done (nothing left to decide)
    created_at: Mapped[datetime] = _created()
    updated_at: Mapped[datetime | None] = mapped_column(Tz())


class Canvas(Base):
    """无限画布: a board for each topic of the world tree (and one for the top), laid out like a blueprint — input →
    assign → branches → output — with conversations, skills, pictures and notes as nodes wired together (pga.canvas).
    `data` keeps JSON Canvas's field names (nodes with x/y/width/height, edges with fromNode/toNode) plus PGA's own."""
    __tablename__ = "canvases"
    __table_args__ = (UniqueConstraint("user_id", "world", name="uq_canvases_user_world"),)
    id: Mapped[uuid.UUID] = _uuid_pk()
    user_id: Mapped[uuid.UUID] = mapped_column(ForeignKey("users.id", ondelete="CASCADE"), nullable=False, index=True)
    world: Mapped[str] = mapped_column(String(64), nullable=False)              # a world-tree node id, or "top"
    title: Mapped[str] = mapped_column(Text, default="", nullable=False)
    rev: Mapped[int] = mapped_column(Integer, default=0, nullable=False)          # bumped on each save: a stale tab cannot overwrite
    data: Mapped[dict[str, Any]] = mapped_column(JSONType, default=dict, nullable=False)
    created_at: Mapped[datetime] = _created()
    updated_at: Mapped[datetime | None] = mapped_column(Tz())


class WorldNode(Base):
    """世界树: everything you have talked about, as one hierarchy of topics (pga.worldtree). A root, then topics at each
    level (each with a summary written from what is under it), and leaves: one per conversation, motivation or piece of
    work (`ref` = its timeline key). New conversations find their place on their own; you can talk to any topic."""
    __tablename__ = "world_nodes"
    __table_args__ = (UniqueConstraint("user_id", "ref", name="uq_world_nodes_user_ref"),)
    id: Mapped[uuid.UUID] = _uuid_pk()
    user_id: Mapped[uuid.UUID] = mapped_column(ForeignKey("users.id", ondelete="CASCADE"), nullable=False, index=True)
    parent_id: Mapped[uuid.UUID | None] = mapped_column(ForeignKey("world_nodes.id", ondelete="CASCADE"), index=True)
    depth: Mapped[int] = mapped_column(Integer, default=0, nullable=False)
    kind: Mapped[str] = mapped_column(String(12), nullable=False)               # root | topic | leaf | plan
    title: Mapped[str] = mapped_column(Text, nullable=False)
    summary: Mapped[str] = mapped_column(Text, default="", nullable=False)
    ref: Mapped[str | None] = mapped_column(String(200))                          # a leaf: the timeline item it stands for
    position: Mapped[int] = mapped_column(Integer, default=0, nullable=False)
    data: Mapped[dict[str, Any]] = mapped_column(JSONType, default=dict, nullable=False)   # stale, count, first/last, agent, …
    created_at: Mapped[datetime] = _created()
    updated_at: Mapped[datetime | None] = mapped_column(Tz())


class Bridge(Base):
    """A link the user drew between two bodies (often in different orbits): one's knowledge may help the other.
    Ends are graph refs: a responsibility id, `k:<body id>` or `aim:<aim id>`."""
    __tablename__ = "bridges"
    id: Mapped[uuid.UUID] = _uuid_pk()
    user_id: Mapped[uuid.UUID] = mapped_column(ForeignKey("users.id", ondelete="CASCADE"), nullable=False)
    a_ref: Mapped[str] = mapped_column(String(80), nullable=False)
    b_ref: Mapped[str] = mapped_column(String(80), nullable=False)
    note: Mapped[str] = mapped_column(Text, default="", nullable=False)
    # what the line means — so the workspace is something agents can act on, not only a picture:
    # relates | references | derived_from | depends_on | contradicts
    kind: Mapped[str] = mapped_column(String(16), default="relates", server_default="relates", nullable=False)
    created_at: Mapped[datetime] = _created()

    __table_args__ = (UniqueConstraint("user_id", "a_ref", "b_ref", name="uq_bridge_pair"), Index("ix_bridges_user", "user_id"))


class Responsibility(Base):
    __tablename__ = "responsibilities"
    id: Mapped[uuid.UUID] = _uuid_pk()
    user_id: Mapped[uuid.UUID] = mapped_column(ForeignKey("users.id", ondelete="CASCADE"), nullable=False)
    parent_id: Mapped[uuid.UUID | None] = mapped_column(ForeignKey("responsibilities.id"))
    aim_id: Mapped[uuid.UUID | None] = mapped_column(ForeignKey("aims.id", ondelete="SET NULL"))  # ext: which motivation it serves
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
    # ext ------------------------------------------------------------------
    key: Mapped[str | None] = mapped_column(String(200))  # stable slug so a run can revise "the same" belief
    origin_run_id: Mapped[uuid.UUID | None] = mapped_column(ForeignKey("runs.id", ondelete="SET NULL"))
    needs_review: Mapped[bool] = mapped_column(Boolean, default=False, nullable=False)  # upstream evidence changed
    reviewed_at: Mapped[datetime | None] = mapped_column(Tz())  # conclusion freshness (§13)
    superseded_by_id: Mapped[uuid.UUID | None] = mapped_column(ForeignKey("beliefs.id"))

    __table_args__ = (Index("ix_beliefs_resp_status", "responsibility_id", "status"),
                      Index("ix_beliefs_fts", text("to_tsvector('english', statement_en)"), postgresql_using="gin"))


class BeliefEvidence(Base):
    """Evidence → belief edge of the dependency graph (spec §13)."""
    __tablename__ = "belief_evidence"
    belief_id: Mapped[uuid.UUID] = mapped_column(ForeignKey("beliefs.id", ondelete="CASCADE"), primary_key=True)
    evidence_id: Mapped[uuid.UUID] = mapped_column(ForeignKey("evidence.id", ondelete="CASCADE"), primary_key=True)
    stance: Mapped[str] = mapped_column(String(16), default="SUPPORTS", nullable=False)  # SUPPORTS | CONTRADICTS
    created_at: Mapped[datetime] = _created()


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
    source_id: Mapped[uuid.UUID | None] = mapped_column(ForeignKey("sources.id", ondelete="SET NULL"))  # ext
    retracted_at: Mapped[datetime | None] = mapped_column(Tz())  # ext: source withdrawn / found wrong
    revised_at: Mapped[datetime | None] = mapped_column(Tz())    # ext: content changed upstream (§13)

    __table_args__ = (Index("ix_evidence_fts", text("to_tsvector('english', canonical_summary_en)"), postgresql_using="gin"),)


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
    # ext ------------------------------------------------------------------
    task_kind: Mapped[str] = mapped_column(String(64), default="research", nullable=False)
    support: Mapped[int] = mapped_column(Integer, default=1, server_default="1", nullable=False)  # episodes behind it
    fingerprint: Mapped[list[Any]] = mapped_column(JSONType, default=list, nullable=False)  # MinHash, for dedupe
    activated_at: Mapped[datetime | None] = mapped_column(Tz())
    retired_at: Mapped[datetime | None] = mapped_column(Tz())
    retired_reason: Mapped[str | None] = mapped_column(Text)

    __table_args__ = (UniqueConstraint("scope", "owner_id", "name", "version", name="uq_skill_version",
                                       postgresql_nulls_not_distinct=True),)


class SkillEpisode(Base):
    """One piece of experience: a run, how it went, the lesson drawn, and which skills it was given."""
    __tablename__ = "skill_episodes"
    id: Mapped[uuid.UUID] = _uuid_pk()
    user_id: Mapped[uuid.UUID] = mapped_column(ForeignKey("users.id", ondelete="CASCADE"), nullable=False)
    responsibility_id: Mapped[uuid.UUID | None] = mapped_column(ForeignKey("responsibilities.id", ondelete="SET NULL"))
    run_id: Mapped[uuid.UUID | None] = mapped_column(ForeignKey("runs.id", ondelete="SET NULL"))
    task_kind: Mapped[str] = mapped_column(String(64), nullable=False)
    success: Mapped[float] = mapped_column(Float, nullable=False)          # 0..1
    lesson_en: Mapped[str] = mapped_column(Text, default="", nullable=False)
    lesson_skill_id: Mapped[uuid.UUID | None] = mapped_column(ForeignKey("skills.id", ondelete="SET NULL"))
    used_skill_ids: Mapped[list[Any]] = mapped_column(JSONType, default=list, nullable=False)
    created_at: Mapped[datetime] = _created()

    __table_args__ = (Index("ix_skill_episodes_user_kind", "user_id", "task_kind", "created_at"),)


class SkillEval(Base):
    __tablename__ = "skill_evals"
    id: Mapped[uuid.UUID] = _uuid_pk()
    skill_id: Mapped[uuid.UUID] = mapped_column(ForeignKey("skills.id", ondelete="CASCADE"), nullable=False)
    score: Mapped[float] = mapped_column(Float, nullable=False)
    n_cases: Mapped[int] = mapped_column(Integer, nullable=False)
    passed: Mapped[bool] = mapped_column(Boolean, nullable=False)
    evaluator: Mapped[str] = mapped_column(String(64), nullable=False)
    detail: Mapped[dict[str, Any]] = mapped_column(JSONType, default=dict, nullable=False)
    run_id: Mapped[uuid.UUID | None] = mapped_column(ForeignKey("runs.id", ondelete="SET NULL"))
    created_at: Mapped[datetime] = _created()


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


# ------------------------------------------------------------------ Phase 2: durable workflow, sources, notifications


class Job(Base):
    """One durable unit of background work (spec §9). Postgres-backed so it survives restarts:
    workers claim due jobs with SELECT … FOR UPDATE SKIP LOCKED and hold a lease while running."""
    __tablename__ = "jobs"
    id: Mapped[uuid.UUID] = _uuid_pk()
    kind: Mapped[str] = mapped_column(String(64), nullable=False)
    user_id: Mapped[uuid.UUID | None] = mapped_column(ForeignKey("users.id", ondelete="CASCADE"))
    responsibility_id: Mapped[uuid.UUID | None] = mapped_column(ForeignKey("responsibilities.id", ondelete="CASCADE"))
    payload: Mapped[dict[str, Any]] = mapped_column(JSONType, default=dict, nullable=False)
    status: Mapped[JobStatus] = mapped_column(enum_col(JobStatus, "job_status"), nullable=False)
    priority: Mapped[int] = mapped_column(Integer, default=100, nullable=False)  # lower runs first
    run_at: Mapped[datetime] = mapped_column(Tz(), default=utcnow, nullable=False)
    attempts: Mapped[int] = mapped_column(Integer, default=0, nullable=False)
    max_attempts: Mapped[int] = mapped_column(Integer, default=3, nullable=False)
    lease_owner: Mapped[str | None] = mapped_column(String(128))
    lease_until: Mapped[datetime | None] = mapped_column(Tz())
    wait_for: Mapped[str | None] = mapped_column(String(200))  # "user" | "event:<key>"
    wait_until: Mapped[datetime | None] = mapped_column(Tz())  # give up waiting after this
    dedupe_key: Mapped[str | None] = mapped_column(String(200))
    workflow_version: Mapped[int] = mapped_column(Integer, default=1, nullable=False)
    parent_job_id: Mapped[uuid.UUID | None] = mapped_column(ForeignKey("jobs.id", ondelete="SET NULL"))
    depth: Mapped[int] = mapped_column(Integer, default=0, nullable=False)  # spawn depth; bounded (§21)
    created_by: Mapped[Origin] = mapped_column(enum_col(Origin, "origin"), nullable=False)
    last_error: Mapped[str | None] = mapped_column(Text)
    result: Mapped[dict[str, Any]] = mapped_column(JSONType, default=dict, nullable=False)
    created_at: Mapped[datetime] = _created()
    updated_at: Mapped[datetime] = mapped_column(Tz(), default=utcnow, onupdate=utcnow, nullable=False)
    finished_at: Mapped[datetime | None] = mapped_column(Tz())

    __table_args__ = (
        Index("ix_jobs_due", "status", "run_at", "priority"),
        # at most one live job per dedupe key: recurring schedules can't pile up
        Index("uq_jobs_live_dedupe", "dedupe_key", unique=True,
              postgresql_where="dedupe_key IS NOT NULL AND status IN ('QUEUED', 'RUNNING', 'WAITING')"),
        Index("ix_jobs_user_kind", "user_id", "kind"),
    )


class Source(Base):
    """A user-approved place to watch (feed, arXiv query, web page). Only the user adds sources."""
    __tablename__ = "sources"
    id: Mapped[uuid.UUID] = _uuid_pk()
    user_id: Mapped[uuid.UUID] = mapped_column(ForeignKey("users.id", ondelete="CASCADE"), nullable=False)
    responsibility_id: Mapped[uuid.UUID | None] = mapped_column(ForeignKey("responsibilities.id", ondelete="CASCADE"))
    kind: Mapped[SourceKind] = mapped_column(enum_col(SourceKind, "source_kind"), nullable=False)
    uri: Mapped[str | None] = mapped_column(Text)
    query: Mapped[str | None] = mapped_column(Text)
    title: Mapped[str | None] = mapped_column(Text)
    interval_minutes: Mapped[int] = mapped_column(Integer, default=60, nullable=False)
    trust_score: Mapped[float] = mapped_column(Float, default=0.6, nullable=False)
    enabled: Mapped[bool] = mapped_column(Boolean, default=True, nullable=False)
    created_by: Mapped[Origin] = mapped_column(enum_col(Origin, "origin"), nullable=False)
    last_polled_at: Mapped[datetime | None] = mapped_column(Tz())
    last_status: Mapped[str | None] = mapped_column(Text)
    etag: Mapped[str | None] = mapped_column(Text)
    last_modified: Mapped[str | None] = mapped_column(Text)
    content_hash: Mapped[str | None] = mapped_column(String(64))
    seen_keys: Mapped[list[Any]] = mapped_column(JSONType, default=list, nullable=False)  # bounded
    consecutive_failures: Mapped[int] = mapped_column(Integer, default=0, nullable=False)
    created_at: Mapped[datetime] = _created()


class Notification(Base):
    """Everything the agent considered saying, including what it chose not to (spec §16)."""
    __tablename__ = "notifications"
    id: Mapped[uuid.UUID] = _uuid_pk()
    user_id: Mapped[uuid.UUID] = mapped_column(ForeignKey("users.id", ondelete="CASCADE"), nullable=False)
    responsibility_id: Mapped[uuid.UUID | None] = mapped_column(ForeignKey("responsibilities.id", ondelete="CASCADE"))
    run_id: Mapped[uuid.UUID | None] = mapped_column(ForeignKey("runs.id", ondelete="SET NULL"))
    artifact_id: Mapped[uuid.UUID | None] = mapped_column(ForeignKey("artifacts.id", ondelete="SET NULL"))
    kind: Mapped[CommKind] = mapped_column(enum_col(CommKind, "comm_kind"), nullable=False)
    reasons: Mapped[list[Any]] = mapped_column(JSONType, default=list, nullable=False)
    title_en: Mapped[str] = mapped_column(Text, nullable=False)
    body_en: Mapped[str] = mapped_column(Text, default="", nullable=False)
    display_title: Mapped[str | None] = mapped_column(Text)
    display_body: Mapped[str | None] = mapped_column(Text)
    display_language: Mapped[str | None] = mapped_column(String(16))
    options: Mapped[list[Any]] = mapped_column(JSONType, default=list, nullable=False)  # for QUESTION
    status: Mapped[NotificationStatus] = mapped_column(enum_col(NotificationStatus, "notification_status"), nullable=False)
    suppressed_reason: Mapped[str | None] = mapped_column(Text)
    channels: Mapped[list[Any]] = mapped_column(JSONType, default=list, nullable=False)
    dedupe_key: Mapped[str | None] = mapped_column(String(200))
    answer_text: Mapped[str | None] = mapped_column(Text)
    answer_en: Mapped[str | None] = mapped_column(Text)
    deliver_after: Mapped[datetime | None] = mapped_column(Tz())
    created_at: Mapped[datetime] = _created()
    delivered_at: Mapped[datetime | None] = mapped_column(Tz())
    read_at: Mapped[datetime | None] = mapped_column(Tz())
    answered_at: Mapped[datetime | None] = mapped_column(Tz())

    __table_args__ = (Index("ix_notifications_user_status", "user_id", "status", "created_at"),)


# ---------------------------------------------------------------- Agent Hub: the other AI agents the user uses


class LinkedAgent(Base):
    """An AI agent/assistant the user uses or used (ChatGPT, Claude, DeepSeek, Claude Code, Hermes …)."""
    __tablename__ = "linked_agents"
    id: Mapped[uuid.UUID] = _uuid_pk()
    user_id: Mapped[uuid.UUID] = mapped_column(ForeignKey("users.id", ondelete="CASCADE"), nullable=False)
    name: Mapped[str] = mapped_column(String(200), nullable=False)
    vendor: Mapped[str] = mapped_column(String(40), nullable=False)          # chatgpt | claude | deepseek | … | other
    connector: Mapped[str] = mapped_column(String(40), default="import", nullable=False)  # import | claude_code | hermes | manual
    usage: Mapped[str] = mapped_column(String(16), default="current", nullable=False)     # current | past
    config: Mapped[dict[str, Any]] = mapped_column(JSONType, default=dict, nullable=False)
    notes: Mapped[str] = mapped_column(Text, default="", nullable=False)
    conversation_count: Mapped[int] = mapped_column(Integer, default=0, nullable=False)
    message_count: Mapped[int] = mapped_column(Integer, default=0, nullable=False)
    first_activity_at: Mapped[datetime | None] = mapped_column(Tz())
    last_activity_at: Mapped[datetime | None] = mapped_column(Tz())
    last_synced_at: Mapped[datetime | None] = mapped_column(Tz())
    summary: Mapped[dict[str, Any]] = mapped_column(JSONType, default=dict, nullable=False)   # model JSON (English)
    summary_display: Mapped[dict[str, Any]] = mapped_column(JSONType, default=dict, nullable=False)  # rendered for the UI
    summary_at: Mapped[datetime | None] = mapped_column(Tz())
    summary_stale: Mapped[bool] = mapped_column(Boolean, default=True, nullable=False)
    created_at: Mapped[datetime] = _created()

    __table_args__ = (Index("ix_linked_agents_user", "user_id"),
                      # one link per account for each agent read from this machine (a sync racing a sync cannot add a second)
                      Index("uq_linked_agents_local", "user_id", "connector", unique=True,
                            postgresql_where=text("connector in ('claude_code', 'hermes', 'codex', 'workbuddy', 'codebuddy')")))


class AgentConversation(Base):
    __tablename__ = "agent_conversations"
    id: Mapped[uuid.UUID] = _uuid_pk()
    linked_agent_id: Mapped[uuid.UUID] = mapped_column(ForeignKey("linked_agents.id", ondelete="CASCADE"), nullable=False)
    external_id: Mapped[str] = mapped_column(String(300), nullable=False)
    title: Mapped[str] = mapped_column(Text, default="", nullable=False)
    started_at: Mapped[datetime | None] = mapped_column(Tz())
    updated_at: Mapped[datetime | None] = mapped_column(Tz())
    message_count: Mapped[int] = mapped_column(Integer, default=0, nullable=False)
    excerpt: Mapped[str] = mapped_column(Text, default="", nullable=False)   # secrets redacted, size-capped
    model: Mapped[str | None] = mapped_column(String(80))                    # which model answered (when the store says)
    project: Mapped[str | None] = mapped_column(String(200))
    spans: Mapped[list | None] = mapped_column(JSONType)                    # [[start, end, turns], …]: when it was going on
    created_at: Mapped[datetime] = _created()

    __table_args__ = (UniqueConstraint("linked_agent_id", "external_id", name="uq_agent_conversation"),
                      Index("ix_agent_conversations_agent_updated", "linked_agent_id", "updated_at"))


class HubDigest(Base):
    """A cross-agent synthesis of everything the user does with their AI agents."""
    __tablename__ = "hub_digests"
    id: Mapped[uuid.UUID] = _uuid_pk()
    user_id: Mapped[uuid.UUID] = mapped_column(ForeignKey("users.id", ondelete="CASCADE"), nullable=False)
    content: Mapped[dict[str, Any]] = mapped_column(JSONType, default=dict, nullable=False)          # English
    content_display: Mapped[dict[str, Any]] = mapped_column(JSONType, default=dict, nullable=False)  # user's language
    agent_ids: Mapped[list[Any]] = mapped_column(JSONType, default=list, nullable=False)
    run_id: Mapped[uuid.UUID | None] = mapped_column(ForeignKey("runs.id", ondelete="SET NULL"))
    created_at: Mapped[datetime] = _created()

    __table_args__ = (Index("ix_hub_digests_user_created", "user_id", "created_at"),)


# ---------------------------------------------------------------- Motivation Forward and the Evolution Loop (R0)


class MotivationDecision(Base):
    """One Motivation Forward: tension said "reconsider", this records whether acting was worth it and how (§4)."""
    __tablename__ = "motivation_decisions"
    id: Mapped[uuid.UUID] = _uuid_pk()
    user_id: Mapped[uuid.UUID] = mapped_column(ForeignKey("users.id", ondelete="CASCADE"), nullable=False)
    responsibility_id: Mapped[uuid.UUID | None] = mapped_column(ForeignKey("responsibilities.id", ondelete="CASCADE"))
    subject: Mapped[str] = mapped_column(String(16), default="responsibility", nullable=False)   # responsibility | R0
    tension: Mapped[float] = mapped_column(Float, nullable=False)
    decision: Mapped[str] = mapped_column(String(40), nullable=False)
    answers: Mapped[dict[str, Any]] = mapped_column(JSONType, default=dict, nullable=False)  # the nine questions
    budget: Mapped[dict[str, Any]] = mapped_column(JSONType, default=dict, nullable=False)
    stop_condition: Mapped[str] = mapped_column(Text, default="", nullable=False)
    fallback: Mapped[bool] = mapped_column(Boolean, default=False, nullable=False)   # model unavailable → rule-based
    run_id: Mapped[uuid.UUID | None] = mapped_column(ForeignKey("runs.id", ondelete="SET NULL"))
    created_at: Mapped[datetime] = _created()

    __table_args__ = (Index("ix_motivation_user_time", "user_id", "created_at"),)


class R0State(Base):
    """R0 — continuously improve the agent. One per user: it observes that user's agent through telemetry."""
    __tablename__ = "r0_state"
    user_id: Mapped[uuid.UUID] = mapped_column(ForeignKey("users.id", ondelete="CASCADE"), primary_key=True)
    tension: Mapped[float] = mapped_column(Float, default=0.0, nullable=False)
    telemetry: Mapped[dict[str, Any]] = mapped_column(JSONType, default=dict, nullable=False)    # latest snapshot
    baselines: Mapped[dict[str, Any]] = mapped_column(JSONType, default=dict, nullable=False)    # slow moving averages
    ledger: Mapped[list[Any]] = mapped_column(JSONType, default=list, nullable=False)            # why tension moved (bounded)
    paused: Mapped[bool] = mapped_column(Boolean, default=False, nullable=False)
    updated_at: Mapped[datetime] = mapped_column(Tz(), default=utcnow, nullable=False)


class EvolutionRound(Base):
    """One bounded Evolution Round: diagnose → propose → review → control → implement → verify (§6–§13)."""
    __tablename__ = "evolution_rounds"
    id: Mapped[uuid.UUID] = _uuid_pk()
    user_id: Mapped[uuid.UUID] = mapped_column(ForeignKey("users.id", ondelete="CASCADE"), nullable=False)
    decision_id: Mapped[uuid.UUID | None] = mapped_column(ForeignKey("motivation_decisions.id", ondelete="SET NULL"))
    phase: Mapped[str] = mapped_column(String(24), nullable=False)    # diagnose|propose|review|control|implement|verify|done|stopped
    trigger: Mapped[str] = mapped_column(String(16), default="r0", nullable=False)   # r0 | user
    problem: Mapped[dict[str, Any]] = mapped_column(JSONType, default=dict, nullable=False)
    objective: Mapped[dict[str, Any]] = mapped_column(JSONType, default=dict, nullable=False)
    budget: Mapped[dict[str, Any]] = mapped_column(JSONType, default=dict, nullable=False)
    log: Mapped[list[Any]] = mapped_column(JSONType, default=list, nullable=False)
    stop_reason: Mapped[str | None] = mapped_column(Text)
    created_at: Mapped[datetime] = _created()
    ended_at: Mapped[datetime | None] = mapped_column(Tz())

    __table_args__ = (Index("ix_evolution_rounds_user_time", "user_id", "created_at"),)


class ImprovementProposal(Base):
    """The persistent Improvement Backlog (§9): proposals survive rounds and are re-scored, not re-invented."""
    __tablename__ = "improvement_proposals"
    id: Mapped[uuid.UUID] = _uuid_pk()
    user_id: Mapped[uuid.UUID] = mapped_column(ForeignKey("users.id", ondelete="CASCADE"), nullable=False)
    code: Mapped[str] = mapped_column(String(8), nullable=False)       # P01, P02 …
    title: Mapped[str] = mapped_column(Text, nullable=False)
    problem: Mapped[str] = mapped_column(Text, default="", nullable=False)
    change: Mapped[str] = mapped_column(Text, default="", nullable=False)
    proposer: Mapped[str] = mapped_column(String(32), default="", nullable=False)
    expected_gain: Mapped[str] = mapped_column(Text, default="", nullable=False)
    expected_cost: Mapped[str] = mapped_column(Text, default="", nullable=False)
    risk: Mapped[str] = mapped_column(Text, default="", nullable=False)
    evaluation_plan: Mapped[str] = mapped_column(Text, default="", nullable=False)
    rollback_condition: Mapped[str] = mapped_column(Text, default="", nullable=False)
    files: Mapped[list[Any]] = mapped_column(JSONType, default=list, nullable=False)     # files it expects to touch
    evidence: Mapped[list[Any]] = mapped_column(JSONType, default=list, nullable=False)
    scores: Mapped[dict[str, Any]] = mapped_column(JSONType, default=dict, nullable=False)   # combined review scores
    value: Mapped[float] = mapped_column(Float, default=0.0, nullable=False)
    status: Mapped[str] = mapped_column(String(16), default="NEW", nullable=False)   # NEW|DEFERRED|ACCEPTED|REJECTED|IMPLEMENTED|PROMOTED|ROLLED_BACK|FAILED
    last_round_id: Mapped[uuid.UUID | None] = mapped_column(ForeignKey("evolution_rounds.id", ondelete="SET NULL"))
    last_reviewed_at: Mapped[datetime | None] = mapped_column(Tz())
    created_at: Mapped[datetime] = _created()

    __table_args__ = (Index("ix_improvement_proposals_user_status", "user_id", "status"),)


class ProposalReview(Base):
    """One specialised reviewer's structured scores for one proposal (§10)."""
    __tablename__ = "proposal_reviews"
    id: Mapped[uuid.UUID] = _uuid_pk()
    proposal_id: Mapped[uuid.UUID] = mapped_column(ForeignKey("improvement_proposals.id", ondelete="CASCADE"), nullable=False)
    round_id: Mapped[uuid.UUID] = mapped_column(ForeignKey("evolution_rounds.id", ondelete="CASCADE"), nullable=False)
    reviewer: Mapped[str] = mapped_column(String(32), nullable=False)
    scores: Mapped[dict[str, Any]] = mapped_column(JSONType, default=dict, nullable=False)
    objections: Mapped[list[Any]] = mapped_column(JSONType, default=list, nullable=False)
    critical: Mapped[bool] = mapped_column(Boolean, default=False, nullable=False)
    created_at: Mapped[datetime] = _created()


class AgentVersion(Base):
    """The agent's lineage (§14): every candidate is kept; nothing is destructively replaced."""
    __tablename__ = "agent_versions"
    id: Mapped[uuid.UUID] = _uuid_pk()
    user_id: Mapped[uuid.UUID] = mapped_column(ForeignKey("users.id", ondelete="CASCADE"), nullable=False)
    label: Mapped[str] = mapped_column(String(32), nullable=False)          # v0, v1a, v1b …
    parent_id: Mapped[uuid.UUID | None] = mapped_column(ForeignKey("agent_versions.id", ondelete="SET NULL"))
    proposal_id: Mapped[uuid.UUID | None] = mapped_column(ForeignKey("improvement_proposals.id", ondelete="SET NULL"))
    round_id: Mapped[uuid.UUID | None] = mapped_column(ForeignKey("evolution_rounds.id", ondelete="SET NULL"))
    status: Mapped[str] = mapped_column(String(16), nullable=False)   # ACTIVE|CANDIDATE|FAILED|REJECTED|CANARY|ROLLED_BACK|SUPERSEDED
    branch: Mapped[str | None] = mapped_column(String(200))
    worktree: Mapped[str | None] = mapped_column(Text)
    patch: Mapped[str] = mapped_column(Text, default="", nullable=False)
    files: Mapped[list[Any]] = mapped_column(JSONType, default=list, nullable=False)
    verification: Mapped[dict[str, Any]] = mapped_column(JSONType, default=dict, nullable=False)
    baseline: Mapped[dict[str, Any]] = mapped_column(JSONType, default=dict, nullable=False)   # telemetry at promotion
    canary_until: Mapped[datetime | None] = mapped_column(Tz())
    note: Mapped[str] = mapped_column(Text, default="", nullable=False)
    created_at: Mapped[datetime] = _created()
    promoted_at: Mapped[datetime | None] = mapped_column(Tz())

    __table_args__ = (Index("ix_agent_versions_user_time", "user_id", "created_at"),)
