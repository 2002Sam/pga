"""Wires the Phase-1 services together for one database session."""

from __future__ import annotations

from collections.abc import Iterator
from contextlib import contextmanager
from functools import lru_cache

from sqlalchemy.orm import Session

from pga.allocator import ResourceAllocator
from pga.budget import BudgetLedger
from pga.config import Policy, get_policy, get_settings
from pga.llm import LLMProvider, LLMRouter, UsageContext, build_provider
from pga.responsibility import ResponsibilityService
from pga.runs import RunService
from pga.situation import SituationService
from pga.tension import LLMScorer, RuleScorer, TensionService
from pga.translation import LLMTranslationBackend, TranslationGateway
from pga.translation.translator import TranslationBackend

REACTIVE_TRANSLATION = UsageContext(category="user_reserve", proactive=False)
BACKGROUND_TRANSLATION = UsageContext(category="monitoring", proactive=True)


@lru_cache
def default_provider() -> LLMProvider:
    s = get_settings()
    return build_provider(get_policy().llm.provider, s.anthropic_api_key)


class Runtime:
    def __init__(self, session: Session, policy: Policy | None = None, provider: LLMProvider | None = None,
                 translation_backend: TranslationBackend | None = None, scorer: str = "rules"):
        self.session = session
        self.policy = policy or get_policy()
        self.provider = provider or default_provider()
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
