"""Unit tests for Gemini CLI provider and standardized Harness onboarding pipeline."""

from __future__ import annotations

import subprocess
import yaml

from pga.agents import options as agent_options
from pga.agents import pool as ap
from pga.agents.adapters import GeminiLocal
from pga.agents.base import AUTO, FULL, AgentTask
from pga.llm import catalog
from pga.llm.router import GeminiCLIProvider


def test_gemini_cli_provider_and_standardized_harness_pipeline(tmp_path, monkeypatch):
    monkeypatch.setattr(catalog, "CONFIG", tmp_path / "models.yaml")
    monkeypatch.setattr(catalog, "ENV_FILE", tmp_path / ".env")
    monkeypatch.setattr(ap, "CONFIG", tmp_path / "agents.yaml")
    catalog.clear_cache()

    # 1. Preset and discover expose official Gemini CLI + harness metadata
    assert "gemini_cli" in catalog.TYPES and "gemini_cli" in catalog.HARNESS_TYPES
    assert "gemini_cli" in catalog.PRESETS
    discovered = catalog.discover({"type": "gemini_cli"})
    assert "gemini-2.5-pro" in discovered and "gemini-2.5-flash" in discovered

    # 2. GeminiCLIProvider parses JSON output (with token stats) and passes GEMINI_API_KEY
    def fake_run_json(cmd, **kw):
        assert "-m" in cmd and "gemini-2.5-pro" in cmd
        assert kw["env"].get("GEMINI_API_KEY") == "gk-test-123"
        payload = '{"response": "OK", "stats": {"models": {"gemini-2.5-pro": {"tokens": {"prompt": 12, "candidates": 4}}}}}'
        return subprocess.CompletedProcess(cmd, 0, stdout=payload, stderr="")

    prov = GeminiCLIProvider(binary="gemini", api_key="gk-test-123", run=fake_run_json)
    res = prov.complete(model="gemini-2.5-pro", system="Be concise.", messages=[{"role": "user", "content": "ping"}],
                        max_tokens=16, temperature=None)
    assert res.text == "OK" and res.input_tokens == 12 and res.output_tokens == 4 and res.model == "gemini-2.5-pro"

    # 3. Plain-text stdout fallback also works
    def fake_run_plain(cmd, **kw):
        return subprocess.CompletedProcess(cmd, 0, stdout="plain reply\n", stderr="")

    res_plain = GeminiCLIProvider(binary="gemini", run=fake_run_plain).complete(
        model="gemini-2.5-flash", system="", messages=[{"role": "user", "content": "hi"}], max_tokens=16, temperature=None
    )
    assert res_plain.text == "plain reply" and res_plain.model == "gemini-2.5-flash"

    # 4. Standardized pipeline probe + sync writes models.yaml, .env, and agents.yaml together
    fake_cli = tmp_path / "gemini"
    fake_cli.write_text("#!/bin/sh\necho '0.1.0-test'\n", encoding="utf-8")
    fake_cli.chmod(0o755)
    preset = dict(catalog.PRESETS["gemini_cli"])
    preset["command"] = str(fake_cli)
    preset["harness"] = {**preset["harness"], "command": str(fake_cli), "sandbox": True, "approval_mode": "auto_edit",
                         "categories": ["serious", "code"]}
    catalog.set_key("GEMINI_API_KEY", "gk-live-9876")
    probe = catalog.probe_harness("gemini_cli", preset)
    assert probe["supported"] is True and probe["cli_found"] is True and probe["auth_ready"] is True

    catalog.save({"model": {"provider": "gemini_cli", "default": "gemini-2.5-pro", "tiers": preset["tiers"]},
                  "providers": {"gemini_cli": preset}})
    sync = catalog.sync_harness_to_pool("gemini_cli", catalog.load()["providers"]["gemini_cli"])
    assert sync["agent_id"] == "gemini" and sync["adapter"] == "gemini_local"
    assert catalog.probe_harness("gemini_cli", catalog.load()["providers"]["gemini_cli"])["agent_synced"] is True

    saved_pool = yaml.safe_load((tmp_path / "agents.yaml").read_text(encoding="utf-8"))
    assert saved_pool["agents"]["gemini"]["command"] == str(fake_cli)
    assert saved_pool["agents"]["gemini"]["sandbox"] is True
    assert saved_pool["agents"]["gemini"]["model"] == "gemini-2.5-pro"
    assert "gemini" in saved_pool["routing"]["categories"]["serious"]["prefer"]
    assert "gemini" in saved_pool["routing"]["categories"]["code"]["prefer"]

    # 5. GeminiLocal builds CLI flags and options() exposes Gemini models
    ad = GeminiLocal("gemini", saved_pool["agents"]["gemini"])
    cmd_auto = ad.command(AgentTask(prompt="hi", permissions=AUTO, meta={"model": "gemini-2.5-flash"}), str(fake_cli))
    assert "--approval-mode" in cmd_auto and "auto_edit" in cmd_auto and "-s" in cmd_auto and "gemini-2.5-flash" in cmd_auto
    cmd_full = ad.command(AgentTask(prompt="hi", permissions=FULL), str(fake_cli))
    assert "yolo" in cmd_full
    opts = agent_options.options("gemini", ad, saved_pool["agents"]["gemini"])
    assert any(m["id"] == "gemini-2.5-pro" for m in opts["models"]) and opts["via"] == "gemini cli"


def test_gemini_link_probe_and_placeholder_sync_status(tmp_path, monkeypatch):
    from pga.agents import links

    monkeypatch.setattr(catalog, "CONFIG", tmp_path / "models.yaml")
    monkeypatch.setattr(catalog, "ENV_FILE", tmp_path / ".env")
    monkeypatch.setattr(ap, "CONFIG", tmp_path / "agents.yaml")
    monkeypatch.setenv("HOME", str(tmp_path))
    monkeypatch.delenv("GEMINI_API_KEY", raising=False)
    catalog.clear_cache()

    # Factory default placeholder in agents.yaml is NOT counted as synced
    preset = dict(catalog.PRESETS["gemini_cli"])
    preset["command"] = str(tmp_path / "no-gemini")
    preset["harness"] = {**preset["harness"], "command": str(tmp_path / "no-gemini")}
    probe_before = catalog.probe_harness("gemini_cli", preset)
    assert probe_before["agent_synced"] is False

    # Link probe reports absent -> login -> online (OAuth or API key)
    missing = GeminiLocal("gemini", {"adapter": "gemini_local", "command": str(tmp_path / "no-gemini")})
    assert links.probe("gemini", missing, missing.config, None).state == "absent"

    fake_cli = tmp_path / "gemini"
    fake_cli.write_text("#!/bin/sh\necho '0.2.0-test'\n", encoding="utf-8")
    fake_cli.chmod(0o755)
    installed = GeminiLocal("gemini", {"adapter": "gemini_local", "command": str(fake_cli)})
    assert links.probe("gemini", installed, installed.config, None).state == "login"

    (tmp_path / ".gemini").mkdir(exist_ok=True)
    (tmp_path / ".gemini" / "oauth_creds.json").write_text("{}", encoding="utf-8")
    assert links.probe("gemini", installed, installed.config, None).state == "online"

    (tmp_path / ".gemini" / "oauth_creds.json").unlink()
    catalog.set_key("GEMINI_API_KEY", "gk-link-probe")
    assert links.probe("gemini", installed, installed.config, None).state == "online"


def test_gemini_pipeline_http_endpoints(session_factory, policy, backend, tmp_path, monkeypatch):
    from fastapi.testclient import TestClient
    from pga.api.app import create_app
    from pga.runtime import Runtime

    monkeypatch.setenv("HOME", str(tmp_path))
    monkeypatch.delenv("GEMINI_API_KEY", raising=False)

    fake_cli = tmp_path / "gemini"
    fake_cli.write_text("#!/bin/sh\necho '0.2.0-api'\n", encoding="utf-8")
    fake_cli.chmod(0o755)

    app = create_app(session_factory=session_factory,
                     runtime_factory=lambda s: Runtime(s, policy=policy, translation_backend=backend))
    with TestClient(app) as client:
        preset = dict(catalog.PRESETS["gemini_cli"])
        preset["command"] = str(fake_cli)
        preset["harness"] = {**preset["harness"], "command": str(fake_cli), "categories": ["serious", "code"]}

        pr = client.post("/v1/models/pipeline/probe", json={"id": "gemini_cli", "provider": preset, "key": "gk-temp-1"}).json()
        assert pr["cli_found"] is True and pr["auth_ready"] is True and pr["auth_detail"] == "已填写临时密钥"

        synced = client.post("/v1/models/pipeline/sync", json={
            "id": "gemini_cli",
            "model": {"provider": "fake", "default": "fake-2"},
            "providers": {"fake": {"name": "offline", "type": "fake"}, "gemini_cli": preset},
            "keys": {"GEMINI_API_KEY": "gk-saved-9999"},
        }).json()
        assert synced["sync"]["agent_id"] == "gemini"
        assert synced["providers"]["gemini_cli"]["pipeline"]["agent_synced"] is True
        assert synced["providers"]["gemini_cli"]["key_hint"] == "···9999"

        opts = client.get("/v1/agents/gemini/options").json()
        assert opts["via"] == "gemini cli" and any(m["id"] == "gemini-2.5-pro" for m in opts["models"])


def test_clean_env_desktop_bundle_falls_back_to_standalone_cli(tmp_path, monkeypatch):
    from pga.agents.adapters import CodexLocal, find_cli_binary

    bin_dir = tmp_path / "bin"
    bin_dir.mkdir()
    standalone = bin_dir / "codex"
    standalone.write_text("#!/bin/sh\necho ok\n", encoding="utf-8")
    standalone.chmod(0o755)
    monkeypatch.setenv("PATH", str(bin_dir))

    # Missing macOS desktop bundle falls back to standalone CLI on PATH
    ad = CodexLocal("codex", {"adapter": "codex_local", "command": "/Applications/NoSuchChatGPT.app/Contents/Resources/codex"})
    assert ad.exe() == str(standalone)

    # Explicit non-desktop custom path does not silently fall back
    assert find_cli_binary(str(tmp_path / "missing-custom-cli"), "codex") is None
