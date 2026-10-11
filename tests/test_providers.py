"""Provider adapters: the Claude subscription route through the `claude` CLI."""

from __future__ import annotations

import json
import subprocess

import pytest

from pga.config import load_policy
from pga.llm import ClaudeCLIProvider, LLMError


class FakeCLI:
    def __init__(self, payload, returncode=0, stderr=""):
        self.payload, self.returncode, self.stderr = payload, returncode, stderr
        self.calls = []

    def __call__(self, cmd, **kw):
        self.calls.append((cmd, kw))
        out = self.payload if isinstance(self.payload, str) else json.dumps(self.payload)
        return subprocess.CompletedProcess(cmd, self.returncode, out, self.stderr)


OK = {"type": "result", "subtype": "success", "is_error": False, "result": "hello",
      "usage": {"input_tokens": 10, "cache_read_input_tokens": 5, "output_tokens": 3},
      "modelUsage": {"claude-sonnet-5-5": {}}}


def test_cli_call_is_stateless_toolless_and_never_uses_an_api_key(monkeypatch):
    monkeypatch.setenv("ANTHROPIC_API_KEY", "sk-should-not-leak")
    cli = FakeCLI(OK)
    res = ClaudeCLIProvider(binary="claude", run=cli).complete(
        model="sonnet", system="be brief", messages=[{"role": "user", "content": "hi"}], max_tokens=50, temperature=None)
    assert (res.text, res.input_tokens, res.output_tokens, res.model, res.provider) == \
        ("hello", 15, 3, "claude-sonnet-5-5", "claude_cli")
    cmd, kw = cli.calls[0]
    assert cmd[:2] == ["claude", "-p"] and cmd[cmd.index("--tools") + 1] == ""
    assert cmd[cmd.index("--system-prompt") + 1] == "be brief" and "--no-session-persistence" in cmd
    assert kw["input"] == "hi" and "ANTHROPIC_API_KEY" not in kw["env"]


def test_cli_renders_history_into_one_prompt():
    cli = FakeCLI(OK)
    ClaudeCLIProvider(run=cli).complete(model="haiku", system="", max_tokens=10, temperature=None, messages=[
        {"role": "user", "content": "A"}, {"role": "assistant", "content": "B"}, {"role": "user", "content": "C"}])
    prompt = cli.calls[0][1]["input"]
    assert "<user>\nA\n</user>" in prompt and "<assistant>\nB\n</assistant>" in prompt and prompt.endswith("C")


@pytest.mark.parametrize("cli", [
    FakeCLI({**OK, "is_error": True, "result": "Claude AI usage limit reached"}),
    FakeCLI("not json", returncode=1, stderr="Invalid API key · Please run /login"),
])
def test_cli_failures_raise_llm_error(cli):
    with pytest.raises(LLMError):
        ClaudeCLIProvider(run=cli).complete(model="opus", system="", messages=[{"role": "user", "content": "x"}],
                                            max_tokens=10, temperature=None)


def test_premium_quota_follows_the_active_provider():
    shipped = load_policy()
    assert shipped.quota_for_tier(3, "anthropic").key == "anthropic-premium"
    assert shipped.quota_for_tier(3, "claude_cli").key == "claude-subscription"
    assert shipped.quota_for_tier(2, "claude_cli").key == "claude-subscription"
    assert shipped.quota_for_tier(1, "claude_cli") is None
