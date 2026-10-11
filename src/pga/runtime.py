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
