"""A busy or briefly unreachable provider is asked again; a real error is not (pga.llm.router.OpenAICompatibleProvider)."""
from __future__ import annotations

import json

import httpx
import pytest

from pga.llm.router import LLMError, OpenAICompatibleProvider

OK = {"choices": [{"message": {"content": "好"}}], "usage": {"prompt_tokens": 3, "completion_tokens": 1}, "model": "m"}


def provider(script):
    calls = []

    def handle(request):
        calls.append(request)
        step = script[min(len(calls) - 1, len(script) - 1)]
        if isinstance(step, Exception):
            raise step
        return step
    p = OpenAICompatibleProvider("deepseek", None, "https://x", client=httpx.Client(base_url="https://x", transport=httpx.MockTransport(handle)))
    waits = []
    p._sleep = waits.append
    return p, calls, waits


def ask(p):
    return p.complete(model="m", system="s", messages=[{"role": "user", "content": "q"}], max_tokens=10, temperature=None)


def test_busy_and_dropped_connections_are_asked_again():
    p, calls, waits = provider([httpx.Response(429, headers={"retry-after": "2"}), httpx.ConnectError("down"),
                                httpx.Response(503), httpx.Response(200, json=OK)])
    assert ask(p).text == "好" and len(calls) == 4 and waits == [2.0, 3.0, 6.0]


def test_a_real_error_is_not_retried_and_retries_end():
    p, calls, _ = provider([httpx.Response(400, text="bad request")])
    with pytest.raises(LLMError, match="400"):
        ask(p)
    assert len(calls) == 1
    p, calls, _ = provider([httpx.Response(429)])
    with pytest.raises(LLMError, match="429"):
        ask(p)
    assert len(calls) == 4


def test_a_stream_is_asked_again_only_before_anything_was_shown():
    sse = "data: " + json.dumps({"choices": [{"delta": {"content": "流"}}]}) + "\n\ndata: [DONE]\n\n"
    p, calls, _ = provider([httpx.Response(503), httpx.Response(200, text=sse)])
    seen = []
    r = p.stream(model="m", system="", messages=[{"role": "user", "content": "q"}], max_tokens=10, temperature=None, on_delta=seen.append)
    assert r.text == "流" and seen == ["流"] and len(calls) == 2


def test_background_model_calls_never_carry_a_secret():
    from pga.llm.router import LLMResult, LLMRouter

    seen = {}

    class Stub:
        name = "stub"

        def complete(self, *, model, system, messages, max_tokens, temperature):
            seen.update(system=system, messages=messages)
            return LLMResult(text="ok", input_tokens=1, output_tokens=1, model=model, provider="stub", tier=-1)
    pol = type("P", (), {"tiers": {1: "m"}})()
    LLMRouter(pol, Stub()).complete(1, system="db at postgresql://me:hunter2@localhost/x",
                                    messages=[{"role": "user", "content": "我的 key 是 sk-abcdefghijklmnopqrstuvwx，帮我分段"}], delegate=False)
    assert "hunter2" not in seen["system"] and "[REDACTED]" in seen["system"]
    assert "sk-abc" not in seen["messages"][0]["content"] and "[REDACTED_KEY]" in seen["messages"][0]["content"]
