"""Settings → 模型与 API: a Hermes-style models.yaml + .env picks the provider the agent uses."""

from __future__ import annotations

import pytest
import yaml
from fastapi.testclient import TestClient

from pga.api.app import create_app
from pga.llm import catalog
from pga.runtime import Runtime


@pytest.fixture
def client(session_factory, policy, backend):
    # no provider passed: the runtime takes whatever models.yaml says
    app = create_app(session_factory=session_factory, runtime_factory=lambda s: Runtime(s, policy=policy, translation_backend=backend))
    with TestClient(app) as c:
        yield c


def test_settings_save_keys_to_env_and_switch_the_runtime(client, session_factory, policy):
    view = client.get("/v1/models").json()
    assert view["configured"] is False and "deepseek" in view["presets"] and "openrouter" in view["presets"]

    cfg = {"model": {"provider": "fake", "default": "fake-2", "tiers": {"1": "fake-1", "2": "fake-2", "3": "fake-3"}},
           "providers": {"fake": {"name": "offline", "type": "fake"},
                         "openrouter": {"name": "OpenRouter", "type": "openai", "base_url": "https://openrouter.ai/api/v1",
                                        "key_env": "OPENROUTER_API_KEY", "tiers": {"2": "some/model"}}},
           "keys": {"OPENROUTER_API_KEY": "sk-or-secret-123456"}}
    out = client.put("/v1/models", json=cfg).json()
    assert out["configured"] is True and out["model"]["provider"] == "fake"
    o = out["providers"]["openrouter"]
    assert o["key_set"] is True and o["key_hint"] == "···3456" and "sk-or-secret" not in str(out)   # never echoed back
    assert "OPENROUTER_API_KEY=sk-or-secret-123456" in catalog.ENV_FILE.read_text()
    saved = yaml.safe_load(catalog.CONFIG.read_text())
    assert saved["providers"]["openrouter"]["key_env"] == "OPENROUTER_API_KEY" and "sk-or" not in catalog.CONFIG.read_text()

    with session_factory() as s:
        rt = Runtime(s, policy=policy)
        assert rt.provider.name == "fake" and rt.router.model_for(3) == "fake-3"

    # switch to the OpenAI-compatible provider: the next runtime uses it, with its tier models
    cfg["model"] = {"provider": "openrouter", "default": "some/model"}
    cfg.pop("keys")
    client.put("/v1/models", json=cfg)
    with session_factory() as s:
        rt = Runtime(s, policy=policy)
        assert rt.provider.name == "openrouter" and rt.router.model_for(1) == "some/model"

    # an empty value removes a key
    client.put("/v1/models", json={**cfg, "keys": {"OPENROUTER_API_KEY": ""}})
    assert client.get("/v1/models").json()["providers"]["openrouter"]["key_set"] is False


def test_settings_validate_and_test_connection(client):
    bad = {"model": {"provider": "nope"}, "providers": {"fake": {"type": "fake"}}}
    assert client.put("/v1/models", json=bad).status_code == 422
    bad = {"model": {"provider": "x"}, "providers": {"x": {"type": "openai", "base_url": "ftp://x"}}}
    assert client.put("/v1/models", json=bad).status_code == 422
    assert client.put("/v1/models", json={"model": {"provider": "fake"}, "providers": {"fake": {"type": "fake"}},
                                          "keys": {"bad key": "x"}}).status_code == 422

    r = client.post("/v1/models/test", json={"id": "fake", "provider": {"type": "fake"}, "model": "fake-1"}).json()
    assert r["ok"] is True
    r = client.post("/v1/models/test", json={"id": "x", "provider": {"type": "openai", "base_url": "http://127.0.0.1:9/v1",
                                                                   "key_env": "NO_SUCH_KEY_ENV"}, "model": "m"}).json()
    assert r["ok"] is False and "no API key" in r["error"]
    assert client.post("/v1/models/discover", json={"id": "fake", "provider": {"type": "fake"}}).json()["models"] == ["fake-1", "fake-2", "fake-3"]


def test_import_from_hermes_without_copying_keys(client):
    catalog.HERMES.mkdir()
    (catalog.HERMES / "config.yaml").write_text(yaml.safe_dump({
        "model": {"default": "claude Opus", "provider": "omnirouter"},
        "providers": {"omnirouter": {"name": "omnirouter", "base_url": "http://localhost:20128/v1", "model": "claude Opus",
                                     "models": {"claude Opus": {}}, "key_env": "HERMES_CUSTOM_OMNIROUTER_API_KEY"}}}))
    (catalog.HERMES / ".env").write_text("HERMES_CUSTOM_OMNIROUTER_API_KEY=hk-123456789\n")
    h = client.get("/v1/models/hermes").json()
    assert h["found"] and h["providers"]["omnirouter"]["key_in_hermes"] is True and "hk-1234" not in str(h)

    client.put("/v1/models", json={"model": {"provider": "fake"}, "providers": {"fake": {"type": "fake"}}})
    out = client.post("/v1/models/hermes/import").json()
    o = out["providers"]["omnirouter"]
    assert o["base_url"] == "http://localhost:20128/v1" and o["tiers"] == {"1": "claude Opus", "2": "claude Opus", "3": "claude Opus"}
    assert o["key_set"] is False and out["model"]["provider"] == "fake"                 # keys stay in Hermes unless asked
    out = client.post("/v1/models/hermes/import?copy_keys=true").json()
    assert out["providers"]["omnirouter"]["key_set"] is True
