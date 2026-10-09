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

    database_url: str = "postgresql+psycopg://postgres:postgres@localhost:5432/pga"
    policy_file: str | None = None
    llm_provider: str | None = None  # overrides policy.llm.provider
    anthropic_api_key: str | None = Field(default=None, validation_alias="ANTHROPIC_API_KEY")
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

    def quota_for_tier(self, tier: int) -> QuotaPolicy | None:
        for q in self.quotas:
            if tier in q.applies_to_tiers:
                return q
        return None


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
        policy.llm.provider = s.llm_provider
    return policy
