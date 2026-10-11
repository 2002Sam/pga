"""Run with the same network as the user's terminal.

Under launchd (or any service manager) PGA does not inherit the shell's HTTP(S)_PROXY. When the Mac has a system
proxy (System Settings → Network → Proxies, e.g. a local Clash/V2Ray port), adopt it so PGA's own HTTP clients and
the agent CLIs it starts (Codex, Hermes, Claude Code) reach the same endpoints the terminal can."""

from __future__ import annotations

import logging
import os
import re
import subprocess

log = logging.getLogger(__name__)
NO_PROXY = "localhost,127.0.0.1,::1,.local"


def system_proxy() -> dict[str, str]:
    try:
        out = subprocess.run(["/usr/sbin/scutil", "--proxy"], capture_output=True, text=True, timeout=5).stdout
    except (OSError, subprocess.SubprocessError):
        return {}
    kv = dict(re.findall(r"^\s*(\w+)\s*:\s*(\S+)\s*$", out, re.M))
    env = {}
    if kv.get("HTTPSEnable") == "1" and kv.get("HTTPSProxy"):
        env["HTTPS_PROXY"] = f"http://{kv['HTTPSProxy']}:{kv.get('HTTPSPort', '80')}"
    if kv.get("HTTPEnable") == "1" and kv.get("HTTPProxy"):
        env["HTTP_PROXY"] = f"http://{kv['HTTPProxy']}:{kv.get('HTTPPort', '80')}"
    if env:
        env.setdefault("HTTPS_PROXY", env.get("HTTP_PROXY", ""))
        env.setdefault("HTTP_PROXY", env.get("HTTPS_PROXY", ""))
        env["NO_PROXY"] = NO_PROXY
    return env


def adopt_system_proxy() -> dict[str, str]:
    """If no proxy is set in the environment, use the macOS system proxy. Returns what was adopted."""
    if any(os.environ.get(k) for k in ("HTTPS_PROXY", "https_proxy", "HTTP_PROXY", "http_proxy", "ALL_PROXY", "all_proxy")):
        return {}
    env = system_proxy()
    for k, v in env.items():
        os.environ[k] = v
        os.environ[k.lower()] = v
    if env:
        log.info("using the system proxy %s", env.get("HTTPS_PROXY"))
    return env
