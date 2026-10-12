"""Wires the Phase-1 services together for one database session."""

from __future__ import annotations

from collections.abc import Iterator
from contextlib import contextmanager
from functools import lru_cache

from sqlalchemy.orm import Session

from pga.allocator import ResourceAllocator
from pga.budget import BudgetLedger
from pga.config import Policy, get_policy, get_settings
from pga.llm import LLMProvider, LLMRouter, UsageContext, build_provider, catalog
from pga.responsibility import ResponsibilityService
from pga.runs import RunService
from pga.situation import SituationService
from pga.tension import LLMScorer, RuleScorer, TensionService
from pga.knowledge.beliefs import BeliefService
from pga.notify import Channel, NotificationService, default_channels
from pga.research import Fetcher, HttpFetcher, SearchProvider, default_search
from pga.sources import SourceService
from pga.translation import LLMTranslationBackend, TranslationGateway
from pga.translation.translator import TranslationBackend
from pga.workflow.engine import WorkflowEngine
from pga.hub import HubService
from pga.layers import LayerService

REACTIVE_TRANSLATION = UsageContext(category="user_reserve", proactive=False)
BACKGROUND_TRANSLATION = UsageContext(category="monitoring", proactive=True)


@lru_cache
def default_provider() -> LLMProvider:
    s = get_settings()
    name = get_policy().llm.provider
    if name == "deepseek":
        return build_provider(name, s.deepseek_api_key, s.deepseek_base_url)
    return build_provider(name, s.anthropic_api_key, s.anthropic_base_url)


class Runtime:
    def __init__(self, session: Session, policy: Policy | None = None, provider: LLMProvider | None = None,
                 translation_backend: TranslationBackend | None = None, scorer: str = "rules",
                 fetcher: Fetcher | None = None, search: SearchProvider | None = None,
                 channels: dict[str, Channel] | None = None):
        self.session = session
        self.policy = policy or get_policy()
        if provider is None:
            configured = catalog.active()                      # models.yaml (Settings → 模型与 API) wins over policy.yaml
            if configured is None:
                provider = default_provider()
            else:
                provider, tiers = configured
                self.policy = self.policy.model_copy(update={"llm": self.policy.llm.model_copy(
                    update={"provider": provider.name, "tiers": tiers})})
        self.provider = provider
        self.ledger = BudgetLedger(session, self.policy, self.provider.name)
        self.router = LLMRouter(self.policy.llm, self.provider, usage_sink=self.ledger.record_llm)
        self._billing = REACTIVE_TRANSLATION
        self.translation_backend = translation_backend or LLMTranslationBackend(self.router, usage=self._usage)
        self.gateway = TranslationGateway(session, self.translation_backend, self.policy)
        self.allocator = ResourceAllocator(session, self.policy, self.ledger)
        self.runs = RunService(session, self.ledger)
        self.responsibilities = ResponsibilityService(session, self.policy)
        self.situation = SituationService(session)
        event_scorer = (LLMScorer(self.router, usage=UsageContext(category="monitoring", proactive=True))
                        if scorer == "llm" else RuleScorer())
        self.tension = TensionService(session, self.policy, scorer=event_scorer, normalizer=self._normalize)
        # Phase 2: the perpetual loop
        self.fetcher = fetcher or HttpFetcher()
        self.search = search or default_search(self.fetcher, get_settings().brave_api_key)
        self.beliefs = BeliefService(session)
        self.notify = NotificationService(session, self.policy, self.gateway,
                                          channels if channels is not None else default_channels())
        self.workflow = WorkflowEngine(session, self.policy)
        self.sources = SourceService(session, self.policy, self.tension, self.fetcher)
        self.hub = HubService(self)
        self.layers = LayerService(self)              # gist / brief / full of every aim, body and agent
        if provider is None or getattr(provider, "name", "") != "fake":
            # long-term work → Claude / ChatGPT / WorkBuddy… by agents.yaml routing (falls back to the provider)
            from pga.agents.routing import make_delegate
            self.router.delegate = make_delegate(self)

    # ---------------------------------------------------------------- Phase 3: learning hooks

    @property
    def skills(self):
        if getattr(self, "_skills", None) is None:
            from pga.skills import SkillService
            self._skills = SkillService(self.session, self)
        return self._skills

    @property
    def memory(self):
        if getattr(self, "_memory", None) is None:
            from pga.memory import MemoryService
            self._memory = MemoryService(self.session, self.policy)
        return self._memory

    def skill_context(self, r, task_kind: str = "research") -> str:
        """Active skills for a step; remembered so the episode can credit or blame them."""
        text, ids = self.skills.context(r, task_kind)
        self._offered = {**getattr(self, "_offered", {}), r.id: ids}
        return text

    def memory_context(self, r, query: str) -> str:
        return self.memory.context(r.user_id, query)

    def learn_from(self, r, outcome) -> None:
        """A finished research step becomes an episode; its lesson feeds the candidate-skill loop."""
        success = 1.0 if outcome.status == "done" and (outcome.belief_changes or r.useful_outcomes) else 0.4
        if outcome.status == "failed":
            success = 0.0
        self.skills.record_episode(user_id=r.user_id, task_kind="research", success=success,
                                   lesson=outcome.lesson, responsibility_id=r.id, run_id=outcome.run_id,
                                   used_skill_ids=getattr(self, "_offered", {}).pop(r.id, []))

    def _usage(self) -> UsageContext:
        return self._billing

    @contextmanager
    def billing(self, ctx: UsageContext) -> Iterator[None]:
        """Bill translation calls made inside the block to `ctx` (e.g. a user, a run)."""
        prev, self._billing = self._billing, ctx
        try:
            yield
        finally:
            self._billing = prev

    def _normalize(self, text: str) -> tuple[str, str]:
        # billed to whatever context the caller set (ingestion sets a per-user monitoring context)
        canonical, lang, _ = self.gateway.normalize_external(text)
        return canonical, lang
