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

import shutil
import subprocess

from pga.llm.router import AnthropicProvider, ClaudeCLIProvider, FakeProvider, GeminiCLIProvider, LLMError, LLMProvider, OpenAICompatibleProvider

ROOT = Path(__file__).resolve().parents[3]                 # …/pga
CONFIG = Path(os.environ.get("PGA_MODELS_FILE") or ROOT / "models.yaml")
ENV_FILE = ROOT / ".env"
HERMES = Path.home() / ".hermes"
TYPES = ("openai", "anthropic", "claude_cli", "gemini_cli", "fake")
HARNESS_TYPES: dict[str, dict[str, Any]] = {
    "gemini_cli": {"adapter": "gemini_local", "binary": "gemini", "default_agent": "gemini",
                   "default_key_env": "GEMINI_API_KEY", "install_hint": "npm install -g @google/gemini-cli",
                   "approval_modes": ("default", "auto_edit", "yolo")},
    "claude_cli": {"adapter": "claude_local", "binary": "claude", "default_agent": "claude",
                   "default_key_env": "CLAUDE_CODE_OAUTH_TOKEN", "install_hint": "npm install -g @anthropic-ai/claude-code",
                   "approval_modes": ("default", "auto_edit", "yolo")},
}
GEMINI_CLI_MODELS = ["gemini-2.5-pro", "gemini-2.5-flash", "gemini-2.5-flash-lite", "gemini-2.0-flash"]
KEY_ENV_RE = re.compile(r"^[A-Z][A-Z0-9_]{1,63}$")

PRESETS: dict[str, dict[str, Any]] = {
    "gemini_cli": {
        "name": "Gemini CLI（官方 Harness）", "type": "gemini_cli", "base_url": "", "key_env": "GEMINI_API_KEY",
        "command": "gemini",
        "tiers": {1: "gemini-2.5-flash", 2: "gemini-2.5-pro", 3: "gemini-2.5-pro"},
        "harness": {
            "enabled": True, "agent_id": "gemini", "adapter": "gemini_local",
            "role": "Gemini CLI · 官方 Harness", "command": "gemini",
            "approval_mode": "auto_edit", "sandbox": False, "mcp": True,
            "capabilities": ["research", "review", "code", "write", "general"],
            "categories": ["serious", "code", "quick"],
            "timeout_s": 600, "max_turns": 30, "max_concurrent": 3,
        },
    },
    "deepseek": {"name": "DeepSeek", "type": "openai", "base_url": "https://api.deepseek.com", "key_env": "DEEPSEEK_API_KEY",
                 "tiers": {1: "deepseek-chat", 2: "deepseek-chat", 3: "deepseek-reasoner"}},
    "anthropic": {"name": "Anthropic API", "type": "anthropic", "base_url": "", "key_env": "ANTHROPIC_API_KEY",
                  "tiers": {1: "claude-haiku-5-5", 2: "claude-sonnet-5-5", 3: "claude-opus-5-5"}},
    "claude_cli": {"name": "Claude 订阅（Claude Code CLI）", "type": "claude_cli", "base_url": "", "key_env": "",
                   "command": "claude", "tiers": {1: "haiku", 2: "sonnet", 3: "opus"},
                   "harness": {"enabled": True, "agent_id": "claude", "adapter": "claude_local",
                               "role": "代码 · Claude Code（订阅）", "command": "claude",
                               "approval_mode": "auto_edit", "sandbox": False, "mcp": True,
                               "capabilities": ["code", "serious", "review", "research", "write", "plan", "general"],
                               "categories": ["code", "serious"], "timeout_s": 3600, "max_turns": 400, "max_concurrent": 4}},
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


def _clean_harness(ptype: str, raw: dict | None, command: str = "") -> dict:
    if ptype not in HARNESS_TYPES or not isinstance(raw, dict):
        return {}
    meta = HARNESS_TYPES[ptype]
    agent_id = str(raw.get("agent_id") or meta["default_agent"]).strip().lower()
    if agent_id and not re.match(r"^[a-z0-9][a-z0-9_-]{0,39}$", agent_id):
        raise ModelConfigError(f"harness.agent_id {agent_id!r}: use lowercase letters, digits, - or _")
    mode = str(raw.get("approval_mode") or "auto_edit").strip()
    if mode not in meta["approval_modes"]:
        mode = "auto_edit"
    caps = [str(c).strip() for c in (raw.get("capabilities") or ["research", "review", "code", "general"]) if str(c).strip()]
    cats = [str(c).strip() for c in (raw.get("categories") or []) if str(c).strip()]
    return {
        "enabled": bool(raw.get("enabled", True)),
        "agent_id": agent_id or meta["default_agent"],
        "adapter": str(raw.get("adapter") or meta["adapter"]),
        "role": str(raw.get("role") or "").strip()[:120],
        "command": str(raw.get("command") or command or meta["binary"]).strip(),
        "approval_mode": mode,
        "sandbox": bool(raw.get("sandbox", False)),
        "mcp": bool(raw.get("mcp", True)),
        "capabilities": list(dict.fromkeys(caps))[:16],
        "categories": list(dict.fromkeys(cats))[:8],
        "timeout_s": max(30, min(7200, int(raw.get("timeout_s") or 600))),
        "max_turns": max(1, min(1000, int(raw.get("max_turns") or 30))),
        "max_concurrent": max(1, min(16, int(raw.get("max_concurrent") or 3))),
    }


def save(data: dict) -> dict:
    data = validate(data)
    clean = {"model": {"provider": data["model"]["provider"], "default": str(data["model"].get("default") or ""),
                       "tiers": {int(k): str(v) for k, v in (data["model"].get("tiers") or {}).items() if v}},
             "providers": {pid: {k: v for k, v in {
                 "name": p.get("name") or pid, "type": p["type"], "base_url": p.get("base_url") or "", "key_env": p.get("key_env") or "",
                 "command": str(p.get("command") or "").strip(),
                 "tiers": {int(k): str(v) for k, v in (p.get("tiers") or {}).items() if v},
                 "models": {m: {} for m in (p.get("models") or [])} if isinstance(p.get("models"), list) else (p.get("models") or {}),
                 "harness": _clean_harness(p["type"], p.get("harness"), str(p.get("command") or "")),
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
        binary = str(p.get("command") or (p.get("harness") or {}).get("command") or "").strip() or None
        return ClaudeCLIProvider(binary=binary)
    if t == "gemini_cli":
        binary = str(p.get("command") or (p.get("harness") or {}).get("command") or "").strip() or None
        return GeminiCLIProvider(binary=binary, api_key=key)
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


# ---------------------------------------------------------------- standardized harness onboarding pipeline


def _cli_exe(cmd: str) -> str | None:
    from pga.agents.adapters import find_cli_binary
    return find_cli_binary(cmd)


def _cli_version(exe: str) -> str:
    from pga.agents.adapters import cli_env
    try:
        out = subprocess.run([exe, "--version"], capture_output=True, text=True, timeout=6, env=cli_env(exe))
        text = (out.stdout or "").strip() or (out.stderr or "").strip()
        return text.splitlines()[0][:80] if text else ""
    except (OSError, subprocess.SubprocessError):
        return ""


def probe_harness(pid: str, p: dict) -> dict:
    """Inspect a CLI/harness provider's readiness across the standardized pipeline:
    1. CLI executable availability & version
    2. Auth readiness (API key in .env or local CLI login)
    3. Sync status in agents.yaml
    """
    ptype = str(p.get("type") or "")
    meta = HARNESS_TYPES.get(ptype)
    if not meta:
        return {"supported": False}
    harness = p.get("harness") if isinstance(p.get("harness"), dict) else {}
    cmd = str(harness.get("command") or p.get("command") or meta["binary"]).strip()
    exe = _cli_exe(cmd)
    version = _cli_version(exe) if exe else ""
    key_env = str(p.get("key_env") or meta["default_key_env"]).strip()
    key_set = bool(get_key(key_env)) if key_env else False
    oauth_found = False
    if ptype == "gemini_cli":
        gemini_dir = Path.home() / ".gemini"
        oauth_found = any((gemini_dir / name).exists() for name in ("oauth_creds.json", "google_accounts.json", "settings.json"))
    elif ptype == "claude_cli":
        oauth_found = (Path.home() / ".claude").exists()
    auth_ready = key_set or oauth_found
    if key_set:
        auth_detail = "已填写临时密钥" if key_env == "PGA_UNSAVED_TEST_KEY" else f"已配置 {key_env}"
    elif oauth_found:
        auth_detail = "检测到本机 CLI 登录凭据"
    else:
        auth_detail = f"未检测到 {key_env} 或本机登录（可填密钥或运行 {meta['binary']} 登录）"
    agent_id = str(harness.get("agent_id") or meta["default_agent"]).strip().lower()
    agent_synced, agent_categories = False, []
    try:
        from pga.agents import pool as ap
        acfg = ap.load()
        existing = (acfg.get("agents") or {}).get(agent_id)
        if isinstance(existing, dict) and existing.get("adapter") == meta["adapter"]:
            agent_categories = [c for c, v in (acfg.get("routing", {}).get("categories") or {}).items()
                                if agent_id in ((v or {}).get("prefer") or [])]
            is_placeholder = (
                "本机未安装" in str(existing.get("link") or "")
                and not existing.get("model")
                and not existing.get("approval_mode")
                and not agent_categories
            )
            agent_synced = (
                not is_placeholder
                and existing.get("enabled", True) is not False
                and (not existing.get("command") or existing.get("command") == cmd or cmd == meta["binary"])
            )
    except Exception:  # noqa: BLE001 - best-effort status check
        pass
    return {
        "supported": True,
        "type": ptype,
        "adapter": meta["adapter"],
        "command": cmd,
        "cli_found": bool(exe),
        "exe": exe or "",
        "version": version,
        "install_hint": meta["install_hint"],
        "auth_ready": auth_ready,
        "key_set": key_set,
        "oauth_found": oauth_found,
        "auth_detail": auth_detail,
        "agent_id": agent_id,
        "agent_synced": agent_synced,
        "agent_categories": agent_categories,
    }


def sync_harness_to_pool(pid: str, p: dict) -> dict:
    """Register or update this provider's CLI harness in agents.yaml and routing categories."""
    ptype = str(p.get("type") or "")
    meta = HARNESS_TYPES.get(ptype)
    if not meta:
        raise ModelConfigError(f"provider type {ptype!r} does not have a CLI harness pipeline")
    harness = _clean_harness(ptype, p.get("harness") or {}, str(p.get("command") or ""))
    agent_id = harness["agent_id"]
    from pga.agents import options as agent_options, pool as ap
    acfg = ap.load()
    agents = acfg.setdefault("agents", {})
    prev = dict(agents.get(agent_id) or {})
    tiers = p.get("tiers") or {}
    default_model = str(tiers.get(2) or tiers.get("2") or tiers.get(1) or tiers.get("1") or prev.get("model") or "").strip()
    cmd = harness["command"]
    entry: dict[str, Any] = {
        **prev,
        "adapter": meta["adapter"],
        "enabled": bool(harness["enabled"]),
        "role": harness["role"] or prev.get("role") or p.get("name") or agent_id,
        "capabilities": harness["capabilities"] or prev.get("capabilities") or ["research", "review", "code", "general"],
        "approval_mode": harness["approval_mode"],
        "sandbox": bool(harness["sandbox"]),
        "mcp": bool(harness["mcp"]),
        "timeout_s": harness["timeout_s"],
        "max_turns": harness["max_turns"],
        "max_concurrent": harness["max_concurrent"],
        "traits": prev.get("traits") or {"quality": 4, "speed": 3, "cost": 2},
        "quota": prev.get("quota") or {"source": "observed", "window_hours": 24, "window_runs": 100},
        "link": f"{p.get('name') or agent_id}（{cmd} · 由模型与 API 流水线接入）",
    }
    if cmd and cmd != meta["binary"]:
        entry["command"] = cmd
    else:
        entry.pop("command", None)
    if default_model:
        entry["model"] = default_model
    key_env = str(p.get("key_env") or "").strip()
    if key_env and key_env != meta["default_key_env"]:
        entry["secret_keys"] = {**(prev.get("secret_keys") or {}), meta["default_key_env"]: key_env}
    agents[agent_id] = entry

    wanted_cats = set(harness["categories"])
    cats = (acfg.get("routing") or {}).get("categories") or {}
    for cname, cdata in cats.items():
        if not isinstance(cdata, dict):
            continue
        prefer = list(cdata.get("prefer") or [])
        if cname in wanted_cats:
            if agent_id not in prefer:
                prefer.append(agent_id)
        elif agent_id in prefer and "categories" in (p.get("harness") or {}):
            prefer = [x for x in prefer if x != agent_id]
        cdata["prefer"] = prefer

    try:
        ap.save(acfg)
    except ap.PoolError as exc:
        raise ModelConfigError(str(exc)) from exc
    agent_options._CACHE.pop(agent_id, None)
    return {"agent_id": agent_id, "adapter": meta["adapter"], "enabled": entry["enabled"],
            "model": default_model, "categories": sorted(wanted_cats), "file": str(ap.CONFIG)}


# ---------------------------------------------------------------- tools for the settings page


def discover(p: dict, timeout_s: float = 15) -> list[str]:
    if p.get("type") == "claude_cli":
        return ["haiku", "sonnet", "opus"]
    if p.get("type") == "gemini_cli":
        return list(GEMINI_CLI_MODELS)
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
