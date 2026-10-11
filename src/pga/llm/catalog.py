"""Model providers and API keys, configured the way Hermes Agent does it.

`models.yaml` (next to `.env`) holds the active choice and the provider list:

    model:
      provider: deepseek          # which entry under providers: is active
      default: deepseek-chat      # the model used when a tier has none
      tiers: {1: deepseek-chat, 2: deepseek-chat, 3: deepseek-reasoner}   # cheap / standard / premium
    providers:
      deepseek:
        name: DeepSeek
        type: openai              # openai (chat-completions compatible) | anthropic | claude_cli | fake
        base_url: https://api.deepseek.com
        key_env: DEEPSEEK_API_KEY # the key itself lives in .env, never in this file
        models: {deepseek-chat: {}, deepseek-reasoner: {}}

It is read on every new Runtime, so a change applies to the next request without a restart. Key values are only
ever written to `.env` and never returned by the API (only whether one is set, and its last four characters).
"""

from __future__ import annotations

import os
import re
import time
from pathlib import Path
from typing import Any

import yaml

from pga.llm.router import AnthropicProvider, ClaudeCLIProvider, FakeProvider, LLMError, LLMProvider, OpenAICompatibleProvider

ROOT = Path(__file__).resolve().parents[3]                 # …/pga
CONFIG = Path(os.environ.get("PGA_MODELS_FILE") or ROOT / "models.yaml")
ENV_FILE = ROOT / ".env"
HERMES = Path.home() / ".hermes"
TYPES = ("openai", "anthropic", "claude_cli", "fake")
KEY_ENV_RE = re.compile(r"^[A-Z][A-Z0-9_]{1,63}$")

PRESETS: dict[str, dict[str, Any]] = {
    "deepseek": {"name": "DeepSeek", "type": "openai", "base_url": "https://api.deepseek.com", "key_env": "DEEPSEEK_API_KEY",
                 "tiers": {1: "deepseek-chat", 2: "deepseek-chat", 3: "deepseek-reasoner"}},
    "anthropic": {"name": "Anthropic API", "type": "anthropic", "base_url": "", "key_env": "ANTHROPIC_API_KEY",
                  "tiers": {1: "claude-haiku-5-5", 2: "claude-sonnet-5-5", 3: "claude-opus-5-5"}},
    "claude_cli": {"name": "Claude 订阅（Claude Code CLI）", "type": "claude_cli", "base_url": "", "key_env": "",
                   "tiers": {1: "haiku", 2: "sonnet", 3: "opus"}},
    "openai": {"name": "OpenAI", "type": "openai", "base_url": "https://api.openai.com/v1", "key_env": "OPENAI_API_KEY", "tiers": {}},
    "openrouter": {"name": "OpenRouter", "type": "openai", "base_url": "https://openrouter.ai/api/v1", "key_env": "OPENROUTER_API_KEY", "tiers": {}},
    "moonshot": {"name": "Kimi（Moonshot）", "type": "openai", "base_url": "https://api.moonshot.cn/v1", "key_env": "MOONSHOT_API_KEY", "tiers": {}},
    "qwen": {"name": "通义千问（DashScope）", "type": "openai", "base_url": "https://dashscope.aliyuncs.com/compatible-mode/v1",
             "key_env": "DASHSCOPE_API_KEY", "tiers": {}},
    "zhipu": {"name": "智谱 GLM", "type": "openai", "base_url": "https://open.bigmodel.cn/api/paas/v4", "key_env": "ZHIPU_API_KEY", "tiers": {}},
    "ollama": {"name": "Ollama（本机）", "type": "openai", "base_url": "http://localhost:11434/v1", "key_env": "", "tiers": {}},
    "custom": {"name": "自定义（OpenAI 兼容）", "type": "openai", "base_url": "http://localhost:8000/v1", "key_env": "", "tiers": {}},
    "fake": {"name": "离线测试（fake）", "type": "fake", "base_url": "", "key_env": "", "tiers": {1: "fake-1", 2: "fake-2", 3: "fake-3"}},
}


class ModelConfigError(ValueError):
    pass


# ---------------------------------------------------------------- .env keys


def _env_lines() -> list[str]:
    return ENV_FILE.read_text(encoding="utf-8").splitlines() if ENV_FILE.exists() else []


def get_key(key_env: str | None) -> str | None:
    if not key_env:
        return None
    for line in _env_lines():
        k, sep, v = line.partition("=")
        if sep and k.strip() == key_env:
            return v.strip().strip('"').strip("'") or None
    return os.environ.get(key_env) or None


def key_hint(key_env: str | None) -> dict:
    v = get_key(key_env)
    return {"key_env": key_env or "", "key_set": bool(v), "key_hint": ("···" + v[-4:]) if v and len(v) > 8 else ("···" if v else "")}


def set_key(key_env: str, value: str) -> None:
    if not KEY_ENV_RE.match(key_env or ""):
        raise ModelConfigError("key_env must look like MY_PROVIDER_API_KEY")
    value = (value or "").strip()
    if "\n" in value or "\r" in value:
        raise ModelConfigError("a key cannot contain line breaks")
    lines, done = _env_lines(), False
    for i, line in enumerate(lines):
        if line.partition("=")[0].strip() == key_env:
            lines[i] = f"{key_env}={value}" if value else ""
            done = True
    if not done and value:
        lines.append(f"{key_env}={value}")
    ENV_FILE.write_text("\n".join(l for l in lines if l is not None) + "\n", encoding="utf-8")
    try:
        os.chmod(ENV_FILE, 0o600)
    except OSError:
        pass
    if value:
        os.environ[key_env] = value
    else:
        os.environ.pop(key_env, None)


# ---------------------------------------------------------------- models.yaml


def _from_policy() -> dict:
    """First run: describe what policy.yaml / PGA_LLM_PROVIDER are doing today, in the Hermes-style shape."""
    from pga.config import get_policy, get_settings
    pol, s = get_policy(), get_settings()
    active = pol.llm.provider
    providers = {}
    for pid in ("deepseek", "anthropic", "claude_cli", "fake"):
        p = PRESETS[pid]
        tiers = {int(k): v for k, v in (pol.llm.provider_tiers.get(pid) or (pol.llm.tiers if pid == "anthropic" else p["tiers"])).items()}
        base = s.deepseek_base_url if pid == "deepseek" else (s.anthropic_base_url or "") if pid == "anthropic" else p["base_url"]
        providers[pid] = {"name": p["name"], "type": p["type"], "base_url": base, "key_env": p["key_env"], "tiers": tiers}
    tiers = providers.get(active, {}).get("tiers") or {}
    return {"model": {"provider": active, "default": tiers.get(2, ""), "tiers": tiers}, "providers": providers}


def load() -> dict:
    if CONFIG.exists():
        data = yaml.safe_load(CONFIG.read_text(encoding="utf-8")) or {}
    else:
        data = _from_policy()
    data.setdefault("model", {})
    data.setdefault("providers", {})
    for pid, p in data["providers"].items():
        p.setdefault("name", pid)
        p.setdefault("type", "openai")
        p["tiers"] = {int(k): str(v) for k, v in (p.get("tiers") or {}).items() if v}
    data["model"]["tiers"] = {int(k): str(v) for k, v in (data["model"].get("tiers") or {}).items() if v}
    return data


def validate(data: dict) -> dict:
    model, providers = data.get("model") or {}, data.get("providers") or {}
    if not isinstance(providers, dict) or not providers:
        raise ModelConfigError("at least one provider is needed")
    for pid, p in providers.items():
        if not re.match(r"^[a-z0-9][a-z0-9_-]{0,39}$", pid):
            raise ModelConfigError(f"provider id {pid!r}: use lowercase letters, digits, - or _")
        if p.get("type") not in TYPES:
            raise ModelConfigError(f"provider {pid}: type must be one of {TYPES}")
        if p.get("type") == "openai" and not str(p.get("base_url") or "").startswith(("http://", "https://")):
            raise ModelConfigError(f"provider {pid}: base_url must start with http:// or https://")
        if p.get("key_env") and not KEY_ENV_RE.match(p["key_env"]):
            raise ModelConfigError(f"provider {pid}: key_env must look like MY_PROVIDER_API_KEY")
    if model.get("provider") not in providers:
        raise ModelConfigError("model.provider must name one of the providers")
    return data


def save(data: dict) -> dict:
    data = validate(data)
    clean = {"model": {"provider": data["model"]["provider"], "default": str(data["model"].get("default") or ""),
                       "tiers": {int(k): str(v) for k, v in (data["model"].get("tiers") or {}).items() if v}},
             "providers": {pid: {k: v for k, v in {
                 "name": p.get("name") or pid, "type": p["type"], "base_url": p.get("base_url") or "", "key_env": p.get("key_env") or "",
                 "tiers": {int(k): str(v) for k, v in (p.get("tiers") or {}).items() if v},
                 "models": {m: {} for m in (p.get("models") or [])} if isinstance(p.get("models"), list) else (p.get("models") or {}),
                 "discover_models": bool(p.get("discover_models", p["type"] == "openai"))}.items() if v not in ("", None, {})}
                 for pid, p in data["providers"].items()}}
    # the active provider's tiers are what the agent uses
    act = clean["providers"][clean["model"]["provider"]]
    if not clean["model"]["tiers"]:
        clean["model"]["tiers"] = dict(act.get("tiers") or {})
    header = ("# PGA model providers — same shape as Hermes Agent's config.yaml (model: + providers:).\n"
              "# Keys are not stored here: each provider names its key in .env via key_env.\n"
              "# Tiers: 1 = cheap (classification, routine), 2 = standard, 3 = premium (deep research).\n")
    CONFIG.write_text(header + yaml.safe_dump(clean, allow_unicode=True, sort_keys=False), encoding="utf-8")
    clear_cache()
    return load()


# ---------------------------------------------------------------- building the active provider

_cache: dict[str, Any] = {}


def clear_cache() -> None:
    _cache.clear()


def _signature() -> tuple:
    def m(p: Path) -> float:
        try:
            return p.stat().st_mtime
        except OSError:
            return 0.0
    return (m(CONFIG), m(ENV_FILE))


def build(pid: str, p: dict) -> LLMProvider:
    t = p.get("type")
    key = get_key(p.get("key_env"))
    if t == "fake":
        return FakeProvider()
    if t == "claude_cli":
        return ClaudeCLIProvider()
    if t == "anthropic":
        prov = AnthropicProvider(api_key=key, base_url=p.get("base_url") or None)
        prov.name = pid if pid != "anthropic" else "anthropic"
        return prov
    if t == "openai":
        if not key and not p.get("key_env"):
            key = "none"                                       # local servers (Ollama, LM Studio) take any token
        return OpenAICompatibleProvider(pid, key, p.get("base_url") or "")
    raise ModelConfigError(f"unknown provider type {t!r}")


def active() -> tuple[LLMProvider, dict[int, str]] | None:
    """The configured provider and tier→model map, or None when there is no models.yaml (policy decides)."""
    if not CONFIG.exists():
        return None
    sig = _signature()
    if _cache.get("sig") == sig:
        return _cache["value"]
    data = load()
    pid = data["model"]["provider"]
    p = data["providers"][pid]
    tiers = dict(p.get("tiers") or {})
    tiers.update(data["model"].get("tiers") or {})
    default = data["model"].get("default") or tiers.get(2) or next(iter(tiers.values()), "")
    for t in (1, 2, 3):
        tiers.setdefault(t, default)
    value = (build(pid, p), tiers)
    _cache.update(sig=sig, value=value)
    return value


# ---------------------------------------------------------------- tools for the settings page


def discover(p: dict, timeout_s: float = 15) -> list[str]:
    if p.get("type") == "claude_cli":
        return ["haiku", "sonnet", "opus"]
    if p.get("type") == "fake":
        return ["fake-1", "fake-2", "fake-3"]
    import httpx
    key = get_key(p.get("key_env"))
    if p.get("type") == "anthropic":
        r = httpx.get((p.get("base_url") or "https://api.anthropic.com").rstrip("/") + "/v1/models", timeout=timeout_s,
                      headers={"x-api-key": key or "", "anthropic-version": "2023-06-01"})
    else:
        r = httpx.get((p.get("base_url") or "").rstrip("/") + "/models", timeout=timeout_s,
                      headers={"Authorization": f"Bearer {key}"} if key else {})
    if r.status_code >= 400:
        raise LLMError(f"HTTP {r.status_code}: {r.text[:200]}")
    data = r.json()
    items = data.get("data") if isinstance(data, dict) else data
    return sorted({str(m.get("id")) for m in (items or []) if isinstance(m, dict) and m.get("id")})[:300]


def test(pid: str, p: dict, model: str) -> dict:
    t0 = time.monotonic()
    try:
        prov = build(pid, p)
        r = prov.complete(model=model, system="Reply with the single word OK.", messages=[{"role": "user", "content": "ping"}],
                          max_tokens=8, temperature=None)
        return {"ok": True, "ms": round((time.monotonic() - t0) * 1000), "reply": (r.text or "")[:80], "model": r.model}
    except Exception as exc:  # noqa: BLE001 - report any failure to the user
        return {"ok": False, "ms": round((time.monotonic() - t0) * 1000), "error": str(exc)[:300]}


def hermes() -> dict | None:
    """Hermes Agent's model setup (no key values): what an import would bring in."""
    f = HERMES / "config.yaml"
    if not f.exists():
        return None
    try:
        d = yaml.safe_load(f.read_text(encoding="utf-8")) or {}
    except yaml.YAMLError:
        return None
    env_keys = set()
    if (HERMES / ".env").exists():
        for line in (HERMES / ".env").read_text(encoding="utf-8", errors="replace").splitlines():
            k, sep, v = line.partition("=")
            if sep and v.strip():
                env_keys.add(k.strip())
    model = d.get("model") or {}
    providers = {}
    for pid, p in (d.get("providers") or {}).items():
        if isinstance(p, dict) and p.get("base_url"):
            providers[re.sub(r"[^a-z0-9_-]", "-", str(pid).lower())[:40]] = {
                "name": p.get("name") or pid, "type": "openai", "base_url": p["base_url"], "key_env": p.get("key_env") or "",
                "models": list((p.get("models") or {}).keys()) or ([p["model"]] if p.get("model") else []),
                "tiers": {1: p.get("model"), 2: p.get("model"), 3: p.get("model")} if p.get("model") else {},
                "key_in_hermes": bool(p.get("key_env") and p.get("key_env") in env_keys)}
    return {"model": {"provider": model.get("provider"), "default": model.get("default"), "base_url": model.get("base_url"),
                      "api_mode": model.get("api_mode")}, "providers": providers,
            "keys_in_hermes": sorted(k for k in env_keys if k.endswith(("_API_KEY", "_KEY", "_TOKEN")))}


def import_hermes(copy_keys: bool = False) -> dict:
    h = hermes()
    if h is None:
        raise ModelConfigError("no Hermes Agent config found at ~/.hermes/config.yaml")
    data = load()
    for pid, p in h["providers"].items():
        p = {k: v for k, v in p.items() if k != "key_in_hermes"}
        if p.get("key_env") and not KEY_ENV_RE.match(p["key_env"]):
            p["key_env"] = ""
        data["providers"][pid] = p
        if copy_keys and p.get("key_env"):
            for line in (HERMES / ".env").read_text(encoding="utf-8", errors="replace").splitlines():
                k, sep, v = line.partition("=")
                if sep and k.strip() == p["key_env"] and v.strip():
                    set_key(p["key_env"], v.strip())
    return save(data)
