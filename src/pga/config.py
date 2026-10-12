"""Policy and settings.

Policy (budgets, thresholds, weights, tiers) lives in YAML so every number in the
spec stays a configurable default (spec §6, §8). Environment settings carry
deployment details (database URL, API keys).
"""

from __future__ import annotations

import copy
import os
from functools import lru_cache
from pathlib import Path
from typing import Any, Literal

import yaml
from pydantic import BaseModel, Field, model_validator
from pydantic_settings import BaseSettings, SettingsConfigDict

DEFAULT_POLICY_FILE = Path(__file__).resolve().parent / "policy.yaml"  # shipped as package data


class Settings(BaseSettings):
    model_config = SettingsConfigDict(env_prefix="PGA_", env_file=".env", extra="ignore")

    owner_user_id: str | None = None  # the installation's owner (R0, recovery notices); else the account marked owner

    database_url: str = "postgresql+psycopg://postgres:postgres@localhost:5432/pga"
    policy_file: str | None = None
    llm_provider: str | None = None  # overrides policy.llm.provider
    anthropic_api_key: str | None = Field(default=None, validation_alias="ANTHROPIC_API_KEY")
    anthropic_base_url: str | None = Field(default=None, validation_alias="ANTHROPIC_BASE_URL")  # relay/proxy
    deepseek_api_key: str | None = Field(default=None, validation_alias="DEEPSEEK_API_KEY")
    deepseek_base_url: str = Field(default="https://api.deepseek.com", validation_alias="DEEPSEEK_BASE_URL")
    brave_api_key: str | None = Field(default=None, validation_alias="BRAVE_API_KEY")  # optional web search
    vault_dir: str = "~/PGA Vault"  # PGA_VAULT_DIR: where "export to Obsidian" writes the notes
    obsidian_vault: str | None = None  # PGA_OBSIDIAN_VAULT: your own vault, shown read-only next to PGA's notes
    api_token: str | None = None  # PGA_API_TOKEN: when set, the HTTP API requires `Authorization: Bearer <token>`
    log_level: str = "INFO"


# ---------------------------------------------------------------- policy models


class LocalePolicy(BaseModel):
    default_ui_locale: str = "zh-CN"
    model_language: str = "en"


class LimitsPolicy(BaseModel):
    max_perpetual_responsibilities_per_user: int = 3
    max_candidate_depth: int = 2
    max_open_candidates_per_parent: int = 3


class BudgetPolicy(BaseModel):
    period_hours: float = 24
    total_units: float = 2_000_000
    shares: dict[str, float]
    reactive_may_use_unspent: bool = True
    exploration_mix: dict[str, float]

    @model_validator(mode="after")
    def _shares_sum(self) -> "BudgetPolicy":
        total = sum(self.shares.values())
        if abs(total - 1.0) > 1e-6:
            raise ValueError(f"budget.shares must sum to 1.0 (got {total})")
        if "user_reserve" not in self.shares:
            raise ValueError("budget.shares must define user_reserve")
        mix = sum(self.exploration_mix.values())
        if abs(mix - 1.0) > 1e-6:
            raise ValueError(f"budget.exploration_mix must sum to 1.0 (got {mix})")
        return self


class AfterTarget(BaseModel):
    allow: list[str] = []
    pause: list[str] = []


class QuotaPolicy(BaseModel):
    key: str
    provider: str
    applies_to_tiers: list[int]
    window_mode: Literal["fixed", "rolling"] = "fixed"
    window_seconds: int
    capacity_units: float
    proactive_target_ratio: float = 0.70
    reserve_ratio: float = 0.30
    after_target: AfterTarget = AfterTarget()

    @model_validator(mode="after")
    def _ratios(self) -> "QuotaPolicy":
        if not 0 < self.proactive_target_ratio <= 1:
            raise ValueError("proactive_target_ratio must be in (0, 1]")
        if not 0 <= self.reserve_ratio < 1:
            raise ValueError("reserve_ratio must be in [0, 1)")
        return self


class UnitCost(BaseModel):
    input: float
    output: float


class LLMPolicy(BaseModel):
    provider: str = "anthropic"
    tiers: dict[int, str]
    unit_costs: dict[int, UnitCost]
    # per-provider model ids; the active provider's entry replaces `tiers`
    provider_tiers: dict[str, dict[int, str]] = {}

    def for_provider(self, provider: str) -> "LLMPolicy":
        tiers = self.provider_tiers.get(provider)
        return self.model_copy(update={"provider": provider, "tiers": dict(tiers) if tiers else dict(self.tiers)})

    def cost_units(self, tier: int, input_tokens: int, output_tokens: int) -> float:
        c = self.unit_costs.get(tier, UnitCost(input=1.0, output=1.0))
        return c.input * input_tokens + c.output * output_tokens


class TaskPolicy(BaseModel):
    tier: int
    category: str
    reactive: bool = False
    quota_class: str | None = None
    min_tier: int | None = None  # lowest tier the task may be downgraded to (None = tier)


class TierLimits(BaseModel):
    max_output_tokens: int
    timeout_s: int
    max_tool_calls: int


class AllocatorPolicy(BaseModel):
    weights: dict[str, float]
    min_score_by_tier: dict[int, float]
    justification_required_from_tier: int = 2
    reference_cost_units: float = 200_000
    default_limits_by_tier: dict[int, TierLimits]
    tasks: dict[str, TaskPolicy]


class TensionWeights(BaseModel):
    deadline: float = 0.25
    dependency: float = 0.15
    user_interest: float = 0.15
    contradiction: float = 0.55
    opportunity: float = 0.25


class TensionDefaults(BaseModel):
    uncertainty: float = 0.5
    decision_impact: float = 0.5
    novelty: float = 1.0


class ClusteringPolicy(BaseModel):
    num_perm: int = 64
    shingle_words: int = 3
    shingle_chars: int = 3
    similarity_threshold: float = 0.55
    lookback_days: int = 14


class TensionPolicy(BaseModel):
    default_wake_threshold: float = 0.75
    default_sleep_threshold: float = 0.35
    deep_sleep_threshold: float = 0.10
    half_life_hours: float = 72
    stagnation_hours: float = 168
    stagnation_half_life_hours: float = 24
    min_relevance: float = 0.15
    core_gain: float = 1.0
    weights: TensionWeights = TensionWeights()
    duplicate_decay: float = 0.30
    absorbed_factor: float = 0.10
    absorption_relief: float = 0.80
    rejection_relief: float = 0.60
    meaningful_delta: float = 0.02
    defaults: TensionDefaults = TensionDefaults()
    clustering: ClusteringPolicy = ClusteringPolicy()

    def merged(self, overrides: dict[str, Any] | None) -> "TensionPolicy":
        """Per-responsibility overrides (Responsibility.tension_policy)."""
        if not overrides:
            return self
        return TensionPolicy.model_validate(_deep_merge(self.model_dump(), overrides))


class TranslationPolicy(BaseModel):
    visible_span_max_chars: int = 80
    max_retries: int = 1
    cache: bool = True
    do_not_translate: list[str] = []


class WorkflowPolicy(BaseModel):
    heartbeat_minutes: float = 15          # how often each user's tension/sources/plans are looked at
    worker_poll_seconds: float = 5
    lease_seconds: int = 900               # a crashed worker's job is picked up again after this
    retry_backoff_seconds: list[int] = [60, 300, 1800]
    max_spawn_depth: int = 2               # jobs may enqueue follow-ups at most this deep (§18, §21)
    max_jobs_per_heartbeat: int = 10
    research_cooldown_hours: float = 6     # an ACTIVE responsibility is researched at most this often
    max_evidence_per_research: int = 12
    exploration_every_hours: float = 12
    exploration_queries: int = 2
    exploration_results_per_query: int = 5
    candidate_budget_units: float = 60_000
    candidate_ttl_hours: float = 168
    source_failure_disable_after: int = 10
    hub_sync_hours: float = 0.5            # Agent Hub: re-read local agents (Claude Code, Codex, Hermes…) every 30 min
    snapshot_every_minutes: float = 5      # a snapshot of what PGA is doing, so a stop (even a crash) can be resumed
    snapshots_kept: int = 500              # in the database; JSON files under ~/Documents/PGA/snapshots keep the last 100


class MotivationPolicy(BaseModel):
    """Motivation Forward: when tension wakes a responsibility, decide whether more work is worth it (§4)."""
    enabled: bool = True
    tier: int = 1                           # a cheap model is enough to decide; the work itself is allocated later


class SkillsPolicy(BaseModel):
    """Hermes-style self-improvement (spec §12): versioned, evaluated, deduplicated, reversible."""
    min_support: int = 2                 # episodes behind a lesson before it may become a rule (one failure never does)
    eval_threshold: float = 0.6          # eval score needed to activate
    max_eval_cases: int = 6
    similarity: float = 0.45             # lessons this similar are the same skill (dedupe)
    auto_activate: bool = True           # activate after a passing eval; always audited and reversible
    regression_window: int = 5           # uses of a new version before it is compared with its parent
    regression_margin: float = 0.2       # success-rate drop that triggers an automatic rollback
    context_max: int = 3                 # active skills shown to a research step


class MemoryPolicy(BaseModel):
    """Retrieval (spec §11): candidate context only — it never decides what is true."""
    recall_limit: int = 5
    min_rank: float = 0.01


class LayersPolicy(BaseModel):
    """Information pyramid (pga.layers): every item at three levels of detail; processes take the level they need."""
    enabled: bool = True                    # build gist / brief / full with the model (off → rule cuts only)
    background: bool = True                 # the heartbeat builds missing or stale pyramids
    gist_max_words: int = 25                # L1: one sentence
    brief_max_words: int = 120              # L2: the key points
    full_min_words: int = 220               # L3 when expanded from a short text
    full_max_words: int = 600
    builds_per_heartbeat: int = 4
    retry_hours: float = 6.0                # rule-cut pyramids (model unavailable) are retried this often
    # how much detail each process reads: 1 gist · 2 brief · 3 full
    needs: dict[str, int] = {
        "chat.aims": 2, "chat.focus_aim": 3, "chat.agents": 1, "chat.linked": 2, "chat.same_aim": 1,
        "motivation.aims": 1, "motivation.focus_aim": 2,
        "research.aim": 2, "expand.aim": 3, "map.label": 1,
    }
    # word budgets per context block; items step down a level (least important first) to fit
    budgets: dict[str, int] = {"chat.aims": 700, "chat.linked": 500, "chat.agents": 400, "motivation.aims": 300}


class EvolutionPolicy(BaseModel):
    """R0 and the bounded Evolution Round (§5–§14, §21). Every bound here is a hard limit."""
    enabled: bool = True
    r0_wake: float = 0.35                   # R0 tension that triggers its Motivation Forward — low: for a perpetual
                                            # agent, running and improving all the time is the normal state
    r0_sleep: float = 0.15
    r0_decay_per_day: float = 0.25          # problem signals fade unless they persist
    r0_idle_drift_per_day: float = 0.05     # …while time since the last round slowly raises R0 on its own (0 = off)
    r0_scope: str = "system"                # system: one R0 for the installation (owner account, everyone's telemetry) | user
    telemetry_window_days: float = 7
    min_hours_between_rounds: float = 24
    max_proposers: int = 3
    max_new_proposals: int = 5
    max_reviewers: int = 4
    max_implementations: int = 2
    max_promotions: int = 1
    accept_score: float = 0.55              # controller threshold on the combined review score
    canary_hours: float = 24
    coding_agent: str = "pool"              # pool (agents.yaml "implement": Claude Code, else Codex) | claude_cli | none
    coding_timeout_s: float = 600         # must leave room for two test suites inside one job lease
    coding_max_turns: int = 40
    max_patch_lines: int = 600
    protected_paths: list[str] = [          # changes here are never accepted from an evolution round (§20)
        "src/pga/permissions.py", "src/pga/aims.py", "src/pga/evolution/", "migrations/", ".env",
        "src/pga/policy.yaml", "src/pga/config.py", "tests/conftest.py"]


class NotifyPolicy(BaseModel):
    max_per_day: int = 3                    # non-urgent interruptions per user per day
    hard_max_per_day: int = 8               # nothing gets past this, urgent or not
    urgent_reasons: list[str] = ["DEADLINE", "DECISION_REQUIRED"]
    min_hours_between_per_responsibility: float = 6
    dedupe_hours: float = 24
    quiet_hours: dict[str, int] = {"start": 23, "end": 8}  # user's local time; held until morning
    default_channels: list[str] = ["in_app"]


class Policy(BaseModel):
    locale: LocalePolicy = LocalePolicy()
    limits: LimitsPolicy = LimitsPolicy()
    budget: BudgetPolicy
    quotas: list[QuotaPolicy]
    llm: LLMPolicy
    allocator: AllocatorPolicy
    tension: TensionPolicy = TensionPolicy()
    permissions: dict[str, Literal["auto", "approval", "deny"]]
    translation: TranslationPolicy = TranslationPolicy()
    workflow: WorkflowPolicy = WorkflowPolicy()
    notify: NotifyPolicy = NotifyPolicy()
    motivation: MotivationPolicy = MotivationPolicy()
    evolution: EvolutionPolicy = EvolutionPolicy()
    layers: LayersPolicy = LayersPolicy()
    skills: SkillsPolicy = SkillsPolicy()
    memory: MemoryPolicy = MemoryPolicy()

    def quota_for_tier(self, tier: int, provider: str | None = None) -> QuotaPolicy | None:
        matches = [q for q in self.quotas if tier in q.applies_to_tiers]
        return next((q for q in matches if q.provider == provider), matches[0] if matches else None)


# ---------------------------------------------------------------- loading


def _deep_merge(base: dict[str, Any], override: dict[str, Any]) -> dict[str, Any]:
    out = copy.deepcopy(base)
    for k, v in override.items():
        if isinstance(v, dict) and isinstance(out.get(k), dict):
            out[k] = _deep_merge(out[k], v)
        else:
            out[k] = copy.deepcopy(v)
    return out


def load_policy(path: str | os.PathLike[str] | None = None, overrides: dict[str, Any] | None = None) -> Policy:
    with open(DEFAULT_POLICY_FILE, encoding="utf-8") as f:
        data = yaml.safe_load(f)
    if path and Path(path).resolve() != DEFAULT_POLICY_FILE:
        with open(path, encoding="utf-8") as f:
            data = _deep_merge(data, yaml.safe_load(f) or {})
    if overrides:
        data = _deep_merge(data, overrides)
    return Policy.model_validate(data)


@lru_cache
def get_settings() -> Settings:
    return Settings()


@lru_cache
def get_policy() -> Policy:
    s = get_settings()
    policy = load_policy(s.policy_file)
    if s.llm_provider:
        policy.llm = policy.llm.for_provider(s.llm_provider)
    return policy
