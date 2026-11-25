"""What you can choose when you talk to an agent: its models, its reasoning effort, and whether it takes images.

Read from each agent itself where it can say: Codex's app server lists its models with their efforts and input
kinds (`model/list`); CodeBuddy's `--help` lists its model ids; Claude Code takes its aliases or a full model name
and `--effort low…max`; PGA's own model offers the provider's tiers. Cached for ten minutes.
"""

from __future__ import annotations

import re
import subprocess
import time
import os
import tomllib
from copy import deepcopy
from pathlib import Path
from typing import TYPE_CHECKING, Any

if TYPE_CHECKING:
    from pga.agents.base import Adapter

_CACHE: dict[str, tuple[float, dict, dict]] = {}
TTL = 600
CLAUDE_MODELS = [("fable", "Claude Fable（最新最强）"), ("opus", "Claude Opus"), ("sonnet", "Claude Sonnet"), ("haiku", "Claude Haiku（快）")]
CLAUDE_API_MODELS = [("claude-fable-5-1", "Claude Fable 5.1"), ("claude-opus-5-5", "Claude Opus 5.5"),
                     ("claude-sonnet-5-5", "Claude Sonnet 5.5"), ("claude-haiku-5-5", "Claude Haiku 5.5")]
GEMINI_MODELS = [("gemini-2.5-pro", "Gemini 2.5 Pro（强推理）"), ("gemini-2.5-flash", "Gemini 2.5 Flash（均衡快）"),
                 ("gemini-2.5-flash-lite", "Gemini 2.5 Flash-Lite（轻量）"), ("gemini-2.0-flash", "Gemini 2.0 Flash")]
CLAUDE_EFFORTS = ["low", "medium", "high", "xhigh", "max"]
CODEBUDDY_EFFORTS = ["minimal", "low", "medium", "high", "xhigh", "max"]
EFFORT_ZH = {"none": "关闭", "minimal": "极低", "low": "低", "medium": "中", "high": "高", "xhigh": "很高", "max": "最高", "ultra": "极限"}


def codex_defaults() -> tuple[str | None, str | None]:
    home = Path(os.environ.get("CODEX_HOME") or Path.home() / ".codex")
    try:
        with (home / "config.toml").open("rb") as stream:
            config = tomllib.load(stream)
    except (OSError, tomllib.TOMLDecodeError):
        return None, None
    return config.get("model"), config.get("model_reasoning_effort")


def options(name: str, ad: "Adapter", cfg: dict, rt: Any = None) -> dict:
    hit = _CACHE.get(name)
    if hit and time.monotonic() - hit[0] < TTL and hit[2] == cfg:
        return hit[1]
    out = _look(name, ad, cfg, rt)
    for m in out["models"]:
        m["efforts"] = [{"id": e, "label": EFFORT_ZH.get(e, e)} for e in m.get("efforts") or []]
    _CACHE[name] = (time.monotonic(), out, deepcopy(cfg))
    return out


def _look(name: str, ad: "Adapter", cfg: dict, rt: Any) -> dict:
    t = ad.type
    if t == "codex_local":
        dm, de = codex_defaults()
        models = []
        try:
            from pga.agents.links import CodexServer
            r = CodexServer.get(ad).rpc.request("model/list", {}, 30)
            for m in r.get("data") or []:
                if m.get("hidden"):
                    continue
                models.append({"id": m["id"], "label": m.get("displayName") or m["id"],
                               "efforts": [e["reasoningEffort"] for e in m.get("supportedReasoningEfforts") or []],
                               "default_effort": m.get("defaultReasoningEffort"), "images": "image" in (m.get("inputModalities") or ["text"])})
        except Exception:  # noqa: BLE001 - without the list you can still talk; it uses the default
            pass
        default = cfg.get("model") or dm or next((m["id"] for m in models), None)
        return {"models": models, "default_model": default, "default_effort": cfg.get("reasoning") or de,
                "images": any(m["images"] for m in models) if models else True, "via": "app-server"}
    if t == "claude_local":
        from pga.agents import links
        api = links.api_ok(name)
        ids = CLAUDE_API_MODELS if api else CLAUDE_MODELS
        return {"models": [{"id": i, "label": lbl, "efforts": [] if api else CLAUDE_EFFORTS, "images": True} for i, lbl in ids],
                "default_model": (cfg.get("api") or {}).get("model") if api else cfg.get("model") or None,
                "default_effort": None if api else cfg.get("effort"), "images": True, "via": "api" if api else "claude code"}
    if t == "codebuddy_local":
        ids: list[str] = []
        exe = ad.exe()
        if exe:
            try:
                h = subprocess.run([exe, "--help"], capture_output=True, text=True, timeout=20).stdout
                m = re.search(r"Currently supported: \(([^)]*)\)", h)
                ids = [x.strip() for x in m.group(1).split(",")] if m else []
            except (OSError, subprocess.SubprocessError):
                pass
        return {"models": [{"id": i, "label": i, "efforts": CODEBUDDY_EFFORTS, "images": True} for i in ids],
                "default_model": cfg.get("model") or ("auto" if "auto" in ids else None), "default_effort": None, "images": True, "via": "codebuddy"}
    if t == "hermes_local":
        from pga.agents.hermes import EFFORTS, selection
        chosen = selection(cfg)
        model = chosen["model"]
        return {"models": [{"id": model, "label": model or "Hermes 默认模型", "efforts": list(EFFORTS), "images": False}],
                "default_model": model or None, "default_effort": chosen["effort"] or None,
                "images": False, "via": "hermes"}
    if t == "gemini_local":
        known = dict(GEMINI_MODELS)
        ordered = [m for m, _ in GEMINI_MODELS]
        default = str(cfg.get("model") or "").strip() or "gemini-2.5-pro"
        if default and default not in known:
            ordered.insert(0, default)
            known[default] = default
        try:
            from pga.llm import catalog
            for p in (catalog.load().get("providers") or {}).values():
                if p.get("type") == "gemini_cli":
                    for v in (p.get("tiers") or {}).values():
                        sv = str(v or "").strip()
                        if sv and sv not in known:
                            ordered.append(sv)
                            known[sv] = sv
        except Exception:  # noqa: BLE001 - fall back to curated Gemini CLI models
            pass
        return {"models": [{"id": i, "label": known[i], "efforts": [], "images": True} for i in ordered],
                "default_model": default, "default_effort": None, "images": True, "via": "gemini cli"}
    if t == "llm" and rt is not None:
        tiers = getattr(rt.router.policy, "tiers", {}) or {}
        ids = list(dict.fromkeys(str(v) for v in (tiers.values() if isinstance(tiers, dict) else [])))
        if not ids:
            ids = [rt.router.model_for(int(cfg.get("tier", 2)))]
        return {"models": [{"id": i, "label": i, "efforts": [], "images": False} for i in ids],
                "default_model": rt.router.model_for(int(cfg.get("tier", 2))), "default_effort": None, "images": False, "via": "api"}
    return {"models": [], "default_model": cfg.get("model"), "default_effort": None, "images": False, "via": t}
