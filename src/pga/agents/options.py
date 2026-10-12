"""What you can choose when you talk to an agent: its models, its reasoning effort, and whether it takes images.

Read from each agent itself where it can say: Codex's app server lists its models with their efforts and input
kinds (`model/list`); CodeBuddy's `--help` lists its model ids; Claude Code takes its aliases or a full model name
and `--effort low…max`; PGA's own model offers the provider's tiers. Cached for ten minutes.
"""

from __future__ import annotations

import re
import subprocess
import time
from pathlib import Path
from typing import TYPE_CHECKING, Any

if TYPE_CHECKING:
    from pga.agents.base import Adapter

_CACHE: dict[str, tuple[float, dict]] = {}
TTL = 600
CLAUDE_MODELS = [("fable", "Claude Fable（最新最强）"), ("opus", "Claude Opus"), ("sonnet", "Claude Sonnet"), ("haiku", "Claude Haiku（快）")]
CLAUDE_API_MODELS = [("claude-fable-5-1", "Claude Fable 5.1"), ("claude-opus-5-5", "Claude Opus 5.5"),
                     ("claude-sonnet-5-5", "Claude Sonnet 5.5"), ("claude-haiku-5-5", "Claude Haiku 5.5")]
CLAUDE_EFFORTS = ["low", "medium", "high", "xhigh", "max"]
CODEBUDDY_EFFORTS = ["minimal", "low", "medium", "high", "xhigh", "max"]
EFFORT_ZH = {"minimal": "极低", "low": "低", "medium": "中", "high": "高", "xhigh": "很高", "max": "最高", "ultra": "极限"}


def _codex_default() -> tuple[str | None, str | None]:
    try:
        txt = (Path.home() / ".codex" / "config.toml").read_text(encoding="utf-8")
    except OSError:
        return None, None
    m = re.search(r'^model\s*=\s*"([^"]+)"', txt, re.M)
    e = re.search(r'^model_reasoning_effort\s*=\s*"([^"]+)"', txt, re.M)
    return (m.group(1) if m else None), (e.group(1) if e else None)


def options(name: str, ad: "Adapter", cfg: dict, rt: Any = None) -> dict:
    hit = _CACHE.get(name)
    if hit and time.monotonic() - hit[0] < TTL:
        return hit[1]
    out = _look(name, ad, cfg, rt)
    for m in out["models"]:
        m["efforts"] = [{"id": e, "label": EFFORT_ZH.get(e, e)} for e in m.get("efforts") or []]
    _CACHE[name] = (time.monotonic(), out)
    return out


def _look(name: str, ad: "Adapter", cfg: dict, rt: Any) -> dict:
    t = ad.type
    if t == "codex_local":
        dm, de = _codex_default()
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
                "default_effort": None, "images": True, "via": "api" if api else "claude code"}
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
    if t == "llm" and rt is not None:
        tiers = getattr(rt.router.policy, "tiers", {}) or {}
        ids = list(dict.fromkeys(str(v) for v in (tiers.values() if isinstance(tiers, dict) else [])))
        if not ids:
            ids = [rt.router.model_for(int(cfg.get("tier", 2)))]
        return {"models": [{"id": i, "label": i, "efforts": [], "images": False} for i in ids],
                "default_model": rt.router.model_for(int(cfg.get("tier", 2))), "default_effort": None, "images": False, "via": "api"}
    return {"models": [], "default_model": cfg.get("model"), "default_effort": None, "images": False, "via": t}
