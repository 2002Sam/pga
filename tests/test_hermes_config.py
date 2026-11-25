"""Hermes settings reach both transports without touching a real account."""
import json
import sys
from contextlib import contextmanager
from types import SimpleNamespace

import pytest

from pga.agents.adapters import HermesLocal
from pga.agents.base import AgentTask, AgentError
from pga.agents.hermes import selection
from pga.agents import links, options


def test_cli_session_choice_overrides_defaults_without_changing_them():
    cfg = {"model": "old", "provider": "openai-codex", "effort": "low"}
    ad = HermesLocal("hermes", cfg)
    task = AgentTask(prompt="test", workspace="/tmp/pga workspace", meta={"model": "chosen", "effort": "xhigh"})
    cmd = ad.command(task, "hermes")
    assert cmd[cmd.index("-m") + 1] == "chosen"
    assert cmd[cmd.index("--reasoning") + 1] == "xhigh"
    assert cmd[cmd.index("--provider") + 1] == "openai-codex"
    assert cmd[cmd.index("--in") + 1] == task.workspace
    assert cfg == {"model": "old", "provider": "openai-codex", "effort": "low"}
    assert "--yolo" not in cmd


@pytest.mark.parametrize("cfg,meta,expected", [
    ({}, {}, {"model": "", "provider": "", "effort": ""}),
    ({"model": "base", "reasoning": "high"}, {"model": "", "effort": ""}, {"model": "base", "provider": "", "effort": "high"}),
    ({"effort": "high"}, {"effort": "none"}, {"model": "", "provider": "", "effort": "none"}),
    ({"provider": "old"}, {"provider": "new"}, {"model": "", "provider": "new", "effort": ""}),
])
def test_selection_precedence_and_follow_defaults(cfg, meta, expected):
    assert selection(cfg, meta) == expected


def test_no_choices_leave_native_hermes_defaults_in_charge():
    cmd = HermesLocal("h", {}).command(AgentTask(prompt="test"), "hermes")
    assert not {"-m", "--provider", "--reasoning"}.intersection(cmd)


def test_invalid_effort_fails_before_starting_a_process():
    with pytest.raises(AgentError, match="思考强度无效"):
        HermesLocal("h", {}).command(AgentTask(prompt="test", meta={"effort": "typo"}), "hermes")


@pytest.mark.parametrize("meta", [{"model": "chosen", "effort": "none"}, {}])
def test_api_sends_same_effective_choices_as_cli(monkeypatch, meta):
    import httpx
    calls = []
    def post(url, **kw):
        calls.append(kw["json"])
        return SimpleNamespace(status_code=200, json=lambda: {"run_id": "fake-run"})
    @contextmanager
    def stream(*args, **kw):
        yield SimpleNamespace(iter_lines=lambda: iter(['data: ' + json.dumps({"event": "run.completed", "output": "done"})]))
    monkeypatch.setattr(httpx, "post", post)
    monkeypatch.setattr(httpx, "stream", stream)
    ad = HermesLocal("h", {"model": "base", "provider": "custom", "reasoning": "high"})
    result = links.HermesApi("http://unused", "fake-key").run(ad, AgentTask(prompt="hello", meta=meta))
    chosen = selection(ad.config, meta)
    assert result.ok and result.text == "done"
    assert calls[0]["model"] == chosen["model"]
    assert calls[0]["provider"] == chosen["provider"]
    assert calls[0]["model_options"] == {"reasoning_effort": chosen["effort"]}


def test_model_picker_exposes_effort_with_native_default_and_updates_cache():
    name = "hermes-test-options"
    options._CACHE.pop(name, None)
    cfg = {}
    ad = HermesLocal(name, cfg)
    first = options.options(name, ad, cfg)
    assert first["models"][0]["id"] == "" and first["default_model"] is None
    assert {e["id"] for e in first["models"][0]["efforts"]} == {"none", "minimal", "low", "medium", "high", "xhigh", "max", "ultra"}
    cfg.update(model="new-model", effort="high")
    updated = options.options(name, ad, cfg)
    assert updated["default_model"] == "new-model" and updated["default_effort"] == "high"
    assert first["default_model"] is None
    assert options.options(name, ad, cfg) is updated
    options._CACHE.pop(name)


def test_cli_process_receives_selected_parameters_and_literal_prompt(tmp_path):
    script = tmp_path / "fake-hermes"
    script.write_text(f'#!{sys.executable}\n' + 'import sys,json\nprint(json.dumps({"args":sys.argv[1:],"input":sys.stdin.read()}))\n')
    script.chmod(0o700)
    ad = HermesLocal("hermes", {"command": str(script), "connect": "cli", "model": "default"})
    result = ad.run(AgentTask(prompt='quote `literal` $(not-a-command)', workspace=str(tmp_path),
                              meta={"model": "selected-model", "effort": "high"}))
    assert result.ok
    received = json.loads(result.text)
    assert received["args"][received["args"].index("-m") + 1] == "selected-model"
    assert received["args"][received["args"].index("--reasoning") + 1] == "high"
    assert received["input"] == 'quote `literal` $(not-a-command)'
