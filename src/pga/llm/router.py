"""LLM router (spec §7 model tiers).

The router maps a tier to a concrete model and reports usage to a sink (the
budget ledger). It does NOT decide whether a call is allowed — that is the
Resource Allocator's job, which runs before any tier ≥ 2 call.
"""

from __future__ import annotations

import logging
import uuid
from collections.abc import Callable
from dataclasses import dataclass, field
from typing import Any, Protocol

from pga.config import LLMPolicy

log = logging.getLogger("pga.llm")


@dataclass
class LLMResult:
    text: str
    input_tokens: int
    output_tokens: int
    model: str
    provider: str
    tier: int


@dataclass
class UsageContext:
    """Who pays for a call. Passed through to the usage sink."""
    category: str
    proactive: bool
    user_id: uuid.UUID | None = None
    run_id: uuid.UUID | None = None
    exploration_scope: str | None = None


UsageSink = Callable[[LLMResult, UsageContext], None]


class LLMProvider(Protocol):
    name: str

    def complete(self, *, model: str, system: str, messages: list[dict[str, str]],
                 max_tokens: int, temperature: float | None) -> LLMResult: ...


class LLMError(RuntimeError):
    pass


class AnthropicProvider:
    name = "anthropic"

    def __init__(self, api_key: str | None = None, client: Any | None = None):
        if client is None:
            import anthropic  # imported lazily so the fake provider works without a key

            if not api_key:
                raise LLMError("ANTHROPIC_API_KEY is not set; set it or use PGA_LLM_PROVIDER=fake")
            client = anthropic.Anthropic(api_key=api_key)
        self._client = client

    def complete(self, *, model: str, system: str, messages: list[dict[str, str]],
                 max_tokens: int, temperature: float | None) -> LLMResult:
        kwargs: dict[str, Any] = {"model": model, "max_tokens": max_tokens, "messages": messages}
        if system:
            kwargs["system"] = system
        if temperature is not None:
            kwargs["temperature"] = temperature
        resp = self._client.messages.create(**kwargs)
        text = "".join(getattr(b, "text", "") for b in resp.content if getattr(b, "type", "") == "text")
        return LLMResult(text=text, input_tokens=resp.usage.input_tokens,
                         output_tokens=resp.usage.output_tokens, model=resp.model or model,
                         provider=self.name, tier=-1)


@dataclass
class FakeCall:
    model: str
    system: str
    messages: list[dict[str, str]]
    max_tokens: int


@dataclass
class FakeProvider:
    """Deterministic offline provider for development and tests.

    `handler(system, messages) -> str` produces the reply; by default it echoes
    the last user message prefixed with the model name.
    """
    handler: Callable[[str, list[dict[str, str]]], str] | None = None
    calls: list[FakeCall] = field(default_factory=list)
    name: str = "fake"

    def complete(self, *, model: str, system: str, messages: list[dict[str, str]],
                 max_tokens: int, temperature: float | None) -> LLMResult:
        self.calls.append(FakeCall(model, system, messages, max_tokens))
        if self.handler:
            text = self.handler(system, messages)
        else:
            text = default_fake_reply(model, system, messages)
        tokens_in = sum(len(m["content"]) for m in messages) // 4 + len(system) // 4 + 1
        return LLMResult(text=text, input_tokens=tokens_in, output_tokens=len(text) // 4 + 1,
                         model=model, provider=self.name, tier=-1)


def default_fake_reply(model: str, system: str, messages: list[dict[str, str]]) -> str:
    """Offline behaviour: translation requests come back untranslated (the gateway then reports
    FAILED and shows English, which is honest); everything else is echoed with the model name."""
    last = messages[-1]["content"] if messages else ""
    if system.startswith("You are the translation layer"):
        import re
        m = re.search(r"<text>\n?(.*?)\n?</text>", last, re.S)
        return m.group(1) if m else last
    return f"[{model} offline] {last}"


class LLMRouter:
    def __init__(self, policy: LLMPolicy, provider: LLMProvider, usage_sink: UsageSink | None = None):
        self.policy = policy
        self.provider = provider
        self.usage_sink = usage_sink

    @property
    def provider_name(self) -> str:
        return self.provider.name

    def model_for(self, tier: int) -> str:
        if tier <= 0:
            raise ValueError("tier 0 is deterministic code; it has no model")
        try:
            return self.policy.tiers[tier]
        except KeyError as exc:
            raise ValueError(f"no model configured for tier {tier}") from exc

    def complete(self, tier: int, *, system: str = "", messages: list[dict[str, str]],
                 max_tokens: int = 1024, temperature: float | None = None,
                 usage: UsageContext | None = None) -> LLMResult:
        model = self.model_for(tier)
        result = self.provider.complete(model=model, system=system, messages=messages,
                                        max_tokens=max_tokens, temperature=temperature)
        result.tier = tier
        log.debug("llm tier=%s model=%s in=%s out=%s", tier, model, result.input_tokens, result.output_tokens)
        if self.usage_sink and usage:
            self.usage_sink(result, usage)
        return result


def build_provider(name: str, api_key: str | None = None) -> LLMProvider:
    if name == "fake":
        return FakeProvider()
    if name == "anthropic":
        return AnthropicProvider(api_key=api_key)
    raise ValueError(f"unknown LLM provider {name!r}")
