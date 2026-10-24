"""LLM router (spec §7 model tiers).

The router maps a tier to a concrete model and reports usage to a sink (the
budget ledger). It does NOT decide whether a call is allowed — that is the
Resource Allocator's job, which runs before any tier ≥ 2 call.
"""

from __future__ import annotations

from contextvars import ContextVar

import json
import logging
import os
import shutil
import subprocess
import tempfile
import time
import uuid
from collections.abc import Callable
from dataclasses import dataclass, field
from datetime import datetime
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
    now: datetime | None = None              # logical time of the run; defaults to the wall clock


UsageSink = Callable[[LLMResult, UsageContext], None]


class LLMProvider(Protocol):
    name: str

    def complete(self, *, model: str, system: str, messages: list[dict[str, str]],
                 max_tokens: int, temperature: float | None) -> LLMResult: ...


class LLMError(RuntimeError):
    pass


class AnthropicProvider:
    name = "anthropic"

    def __init__(self, api_key: str | None = None, client: Any | None = None, base_url: str | None = None):
        if client is None:
            import anthropic  # imported lazily so the fake provider works without a key

            if not api_key:
                raise LLMError("ANTHROPIC_API_KEY is not set; set it or use PGA_LLM_PROVIDER=fake")
            client = anthropic.Anthropic(api_key=api_key, base_url=base_url) if base_url else anthropic.Anthropic(api_key=api_key)
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


class _Retry(Exception):
    def __init__(self, message: str, resp=None):
        super().__init__(message)
        self.message, self.resp = message, resp


class OpenAICompatibleProvider:
    """Chat-completions providers such as DeepSeek. The system prompt goes in as the first message."""

    def __init__(self, name: str, api_key: str | None, base_url: str, client: Any | None = None,
                 timeout_s: float = 300.0):
        if client is None:
            import httpx

            if not api_key:
                raise LLMError(f"no API key for provider {name!r}")
            client = httpx.Client(base_url=base_url.rstrip("/"), timeout=timeout_s,
                                  headers={"Authorization": f"Bearer {api_key}"})
        self.name = name
        self._client = client
        self._sleep = time.sleep

    # a busy or briefly unreachable provider (429, 5xx, a timeout, a dropped connection) is asked again a few times,
    # after the wait it asks for (Retry-After) or a growing pause; anything else fails at once
    RETRY_STATUS = (429, 500, 502, 503, 504)
    RETRIES = 3

    def _wait(self, attempt: int, resp=None) -> None:
        after = None
        try:
            after = float(resp.headers.get("retry-after")) if resp is not None and resp.headers.get("retry-after") else None
        except (TypeError, ValueError):
            after = None
        self._sleep(min(30.0, after if after is not None else 1.5 * 2 ** attempt))

    @staticmethod
    def _transient(exc: Exception) -> bool:
        import httpx
        return isinstance(exc, (httpx.TimeoutException, httpx.TransportError))

    def complete(self, *, model: str, system: str, messages: list[dict[str, str]],
                 max_tokens: int, temperature: float | None) -> LLMResult:
        body: dict[str, Any] = {"model": model, "max_tokens": max_tokens,
                                "messages": ([{"role": "system", "content": system}] if system else []) + messages}
        if temperature is not None:
            body["temperature"] = temperature
        for attempt in range(self.RETRIES + 1):
            try:
                resp = self._client.post("/chat/completions", json=body)
            except Exception as exc:  # noqa: BLE001 - only network trouble is retried
                if attempt < self.RETRIES and self._transient(exc):
                    log.info("%s: %s, asking again", self.name, type(exc).__name__)
                    self._wait(attempt)
                    continue
                raise
            if resp.status_code in self.RETRY_STATUS and attempt < self.RETRIES:
                log.info("%s: HTTP %s, asking again", self.name, resp.status_code)
                self._wait(attempt, resp)
                continue
            break
        if resp.status_code >= 400:
            raise LLMError(f"{self.name} returned HTTP {resp.status_code}: {resp.text[:300]}")
        data = resp.json()
        usage = data.get("usage") or {}
        return LLMResult(text=data["choices"][0]["message"].get("content") or "",
                         input_tokens=int(usage.get("prompt_tokens", 0)),
                         output_tokens=int(usage.get("completion_tokens", 0)),
                         model=data.get("model") or model, provider=self.name, tier=-1)

    def stream(self, *, model: str, system: str, messages: list[dict[str, str]], max_tokens: int,
               temperature: float | None, on_delta: Callable[[str], None]) -> LLMResult:
        """Same as complete(), but the text arrives piece by piece (server-sent events) and each piece is passed
        to `on_delta` as it comes — the agent chat shows the answer flowing."""
        body: dict[str, Any] = {"model": model, "max_tokens": max_tokens, "stream": True, "stream_options": {"include_usage": True},
                                "messages": ([{"role": "system", "content": system}] if system else []) + messages}
        if temperature is not None:
            body["temperature"] = temperature
        parts: list[str] = []
        for attempt in range(self.RETRIES + 1):         # asked again only while nothing has been shown yet
            try:
                return self._stream_once(body, model, on_delta, parts)
            except _Retry as r:
                if attempt >= self.RETRIES or parts:
                    raise LLMError(r.message) from r
                log.info("%s: %s, asking again", self.name, r.message[:80])
                self._wait(attempt, r.resp)
            except Exception as exc:  # noqa: BLE001
                if attempt >= self.RETRIES or parts or not self._transient(exc):
                    raise
                log.info("%s: %s, asking again", self.name, type(exc).__name__)
                self._wait(attempt)
        raise LLMError(f"{self.name}: no answer")

    def _stream_once(self, body: dict, model: str, on_delta: Callable[[str], None], parts: list[str]) -> LLMResult:
        usage: dict = {}
        used_model = model
        with self._client.stream("POST", "/chat/completions", json=body) as resp:
            if resp.status_code in self.RETRY_STATUS:
                raise _Retry(f"{self.name} returned HTTP {resp.status_code}: {resp.read()[:300]!r}", resp)
            if resp.status_code >= 400:
                raise LLMError(f"{self.name} returned HTTP {resp.status_code}: {resp.read()[:300]!r}")
            for line in resp.iter_lines():
                if not line.startswith("data:"):
                    continue
                payload = line[5:].strip()
                if payload == "[DONE]":
                    break
                try:
                    chunk = json.loads(payload)
                except json.JSONDecodeError:
                    continue
                used_model = chunk.get("model") or used_model
                usage = chunk.get("usage") or usage
                for ch in chunk.get("choices") or []:
                    piece = (ch.get("delta") or {}).get("content") or ""
                    if piece:
                        parts.append(piece)
                        on_delta(piece)
        return LLMResult(text="".join(parts), input_tokens=int(usage.get("prompt_tokens", 0)),
                         output_tokens=int(usage.get("completion_tokens", 0)), model=used_model, provider=self.name, tier=-1)


class ClaudeCLIProvider:
    """Runs each call through the official Claude Code CLI (`claude -p`), so it draws on the
    Claude Pro/Max subscription the CLI is logged in with instead of an API key.

    This is the route Hermes Agent's proposed `claude-code` provider takes: it never reads or
    reuses the CLI's OAuth credentials, it only invokes Anthropic's own client. Each call is
    one stateless turn with tools, MCP servers, skills and user settings disabled, so the
    model sees only our system prompt and messages. The CLI has no max_tokens/temperature
    flags; those arguments are ignored.
    """

    name = "claude_cli"

    def __init__(self, binary: str | None = None, timeout_s: float = 600.0,
                 run: Callable[..., subprocess.CompletedProcess] | None = None):
        self.binary = binary or shutil.which("claude") or "claude"
        self.timeout_s = timeout_s
        self._run = run or subprocess.run
        self._cwd = tempfile.mkdtemp(prefix="pga-claude-")  # keep project CLAUDE.md files out of the context

    @staticmethod
    def render(messages: list[dict[str, str]]) -> str:
        if len(messages) == 1:
            return messages[0]["content"]
        turns = "\n\n".join(f"<{m['role']}>\n{m['content']}\n</{m['role']}>" for m in messages[:-1])
        return (f"<conversation_so_far>\n{turns}\n</conversation_so_far>\n\n"
                f"Reply to this latest {messages[-1]['role']} message:\n{messages[-1]['content']}")

    def complete(self, *, model: str, system: str, messages: list[dict[str, str]],
                 max_tokens: int, temperature: float | None) -> LLMResult:
        cmd = [self.binary, "-p", "--output-format", "json", "--model", model, "--tools", "",
               "--no-session-persistence", "--setting-sources", "", "--strict-mcp-config",
               "--disable-slash-commands", "--system-prompt", system or "You are a helpful assistant."]
        # an API key in the environment would make the CLI bill it instead of the subscription
        env = {k: v for k, v in os.environ.items() if k not in {"ANTHROPIC_API_KEY", "ANTHROPIC_AUTH_TOKEN"}}
        try:
            proc = self._run(cmd, input=self.render(messages), capture_output=True, text=True,
                             timeout=self.timeout_s, env=env, cwd=self._cwd)
        except FileNotFoundError as exc:
            raise LLMError("the `claude` CLI is not installed; install Claude Code and run `claude` once to log in") from exc
        except subprocess.TimeoutExpired as exc:
            raise LLMError(f"claude CLI timed out after {self.timeout_s:.0f}s") from exc
        try:
            data = json.loads(proc.stdout)
        except json.JSONDecodeError as exc:
            raise LLMError(f"claude CLI exited {proc.returncode}: {(proc.stderr or proc.stdout)[:300]}") from exc
        if data.get("is_error") or data.get("subtype") not in (None, "success"):
            raise LLMError(f"claude CLI error: {str(data.get('result') or data.get('subtype'))[:300]}")
        usage = data.get("usage") or {}
        tokens_in = sum(int(usage.get(k) or 0) for k in
                        ("input_tokens", "cache_creation_input_tokens", "cache_read_input_tokens"))
        used = list((data.get("modelUsage") or {}).keys())
        return LLMResult(text=data.get("result") or "", input_tokens=tokens_in,
                         output_tokens=int(usage.get("output_tokens") or 0),
                         model=used[0] if len(used) == 1 else model, provider=self.name, tier=-1)


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


# the kind of run the current call belongs to (set by RunTracker.track), so a delegate can route it to an agent
CURRENT_TASK: ContextVar[str | None] = ContextVar("pga_current_task", default=None)
CURRENT_RESP: ContextVar[object | None] = ContextVar("pga_current_responsibility", default=None)   # its aim's team goes first


class LLMRouter:
    def __init__(self, policy: LLMPolicy, provider: LLMProvider, usage_sink: UsageSink | None = None):
        self.policy = policy
        self.provider = provider
        self.usage_sink = usage_sink
        # optional: (task kind, tier, system, messages, max_tokens) → LLMResult | None. The agent router plugs in here
        # so long-term work can go to Claude / ChatGPT / WorkBuddy; None means "use the provider".
        self.delegate: Callable[..., LLMResult | None] | None = None

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
                 usage: UsageContext | None = None, delegate: bool = True) -> LLMResult:
        model = self.model_for(tier)
        from pga.redact import redact, redact_messages
        system, messages = redact(system or ""), redact_messages(messages)     # no secret leaves in background work
        result = None
        kind = CURRENT_TASK.get()
        if delegate and self.delegate is not None and kind:
            try:
                result = self.delegate(kind, tier, system, messages, max_tokens)
            except Exception as exc:  # noqa: BLE001 - routing must never break the work; fall back to the provider
                log.warning("agent routing failed for %s: %s", kind, exc)
                result = None
        if result is None:
            result = self.provider.complete(model=model, system=system, messages=messages,
                                            max_tokens=max_tokens, temperature=temperature)
        result.tier = tier
        log.debug("llm tier=%s model=%s in=%s out=%s", tier, model, result.input_tokens, result.output_tokens)
        if self.usage_sink and usage:
            self.usage_sink(result, usage)
        return result


def build_provider(name: str, api_key: str | None = None, base_url: str | None = None) -> LLMProvider:
    if name == "fake":
        return FakeProvider()
    if name == "anthropic":
        return AnthropicProvider(api_key=api_key, base_url=base_url)
    if name == "deepseek":
        return OpenAICompatibleProvider("deepseek", api_key, base_url or "https://api.deepseek.com")
    if name == "claude_cli":
        return ClaudeCLIProvider()
    raise ValueError(f"unknown LLM provider {name!r}")
