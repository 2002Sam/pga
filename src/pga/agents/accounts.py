"""More than one account per agent — every kind of agent the way it actually supports it.

    Claude Code      a token per account (`claude setup-token`) → a copy of the agent (claude-2) with its own token
    WorkBuddy        an API key per account → a copy with its own key
    Gemini           an API key per account → a copy with its own key
    ChatGPT / Codex  a login per account. Codex keeps its login in CODEX_HOME, so the copy (chatgpt-2) gets its own
                     folder (~/Documents/PGA/accounts/chatgpt-2) and PGA runs `codex login --device-auth` there:
                     you open the link, enter the code, sign in with the other ChatGPT account.
    Hermes           its own account pool: `hermes auth add openai-codex` adds a second ChatGPT login to Hermes,
                     which moves to the next one by itself when one runs out — no copy needed.

A login runs in the background and prints a link and a one-time code; PGA shows both and watches the process until
the sign-in finishes (or fails, or 15 minutes pass). The code is shown to you only; it is never logged.
"""

from __future__ import annotations

import re
import shutil
import subprocess
import threading
import time
import uuid
from pathlib import Path

ACCOUNTS_DIR = Path.home() / "Documents" / "PGA" / "accounts"
CODEX_HOME = Path.home() / ".codex"
_ANSI = re.compile(r"\x1b\[[0-9;]*m")
_URL = re.compile(r"https?://[^\s\x1b]+")
_CODE = re.compile(r"\b([A-Z0-9]{4}-[A-Z0-9]{4,5})\b")
TIMEOUT_S = 15 * 60


class Login:
    def __init__(self, agent: str, kind: str, argv: list[str], env: dict, note: str = ""):
        self.id, self.agent, self.kind, self.note = uuid.uuid4().hex[:12], agent, kind, note
        self.url: str | None = None
        self.code: str | None = None
        self.status = "starting"            # starting | waiting | done | failed | cancelled
        self.detail = ""
        self.started = time.monotonic()
        self._tail: list[str] = []
        self.proc = subprocess.Popen(argv, stdin=subprocess.DEVNULL, stdout=subprocess.PIPE, stderr=subprocess.STDOUT,
                                     text=True, env=env, bufsize=1)
        threading.Thread(target=self._read, daemon=True, name=f"login-{agent}").start()

    def _read(self) -> None:
        assert self.proc.stdout is not None
        for raw in self.proc.stdout:
            line = _ANSI.sub("", raw).strip()
            if not line:
                continue
            if not self.url and (m := _URL.search(line)):
                self.url = m.group(0).rstrip(".,)")
            if not self.code and (m := _CODE.search(line)):
                self.code = m.group(1)
            if self.url and self.code and self.status == "starting":
                self.status = "waiting"
            if not _CODE.search(line):                     # keep the code out of anything stored
                self._tail = (self._tail + [line[:200]])[-8:]
        rc = self.proc.wait()
        if self.status != "cancelled":
            self.status = "done" if rc == 0 else "failed"
            self.detail = "" if rc == 0 else (" ".join(self._tail[-3:]) or f"exited with {rc}")

    def expire(self) -> None:
        if self.status in ("starting", "waiting") and time.monotonic() - self.started > TIMEOUT_S:
            self.cancel("the one-time code expired (15 minutes)")

    def cancel(self, why: str = "cancelled") -> None:
        if self.proc.poll() is None:
            self.proc.terminate()
        self.status, self.detail = "cancelled", why

    def view(self) -> dict:
        self.expire()
        return {"id": self.id, "agent": self.agent, "kind": self.kind, "status": self.status, "url": self.url, "code": self.code,
                "detail": self.detail, "note": self.note, "seconds": round(time.monotonic() - self.started)}


LOGINS: dict[str, Login] = {}


def start(agent: str, kind: str, argv: list[str], env: dict, note: str = "") -> Login:
    for old in LOGINS.values():                            # one sign-in per agent at a time
        if old.agent == agent and old.status in ("starting", "waiting"):
            old.cancel("replaced by a new sign-in")
    lg = Login(agent, kind, argv, env, note)
    LOGINS[lg.id] = lg
    return lg


def get(lid: str) -> Login | None:
    return LOGINS.get(lid)


def codex_home(clone: str) -> Path:
    """A fresh Codex folder for another account: your settings (config.toml) come along, your login does not."""
    home = ACCOUNTS_DIR / clone
    home.mkdir(parents=True, exist_ok=True)
    cfg = CODEX_HOME / "config.toml"
    if cfg.exists() and not (home / "config.toml").exists():
        shutil.copy2(cfg, home / "config.toml")
    return home


def codex_logged_in(home: str | Path) -> bool:
    return (Path(home).expanduser() / "auth.json").exists()


_POOL: dict[str, tuple[float, list[dict]]] = {}
HERMES_AUTH = Path.home() / ".hermes" / "auth.json"


def hermes_pool(exe: str | None = None, provider: str = "openai-codex", ttl: float = 30) -> list[dict]:
    """The accounts in Hermes' own pool for its provider, read from ~/.hermes/auth.json — only the label, priority and
    status (never the tokens), and without `hermes auth list`, which waits for Hermes' lock while Hermes is working."""
    import json
    hit = _POOL.get(provider)
    if hit and time.monotonic() - hit[0] < ttl:
        return hit[1]
    try:
        data = json.loads(HERMES_AUTH.read_text(encoding="utf-8"))
    except (OSError, ValueError):
        return hit[1] if hit else []
    creds = sorted((data.get("credential_pool") or {}).get(provider) or [], key=lambda c: (c.get("priority") or 0))
    rows = []
    for i, c in enumerate(creds):
        if not isinstance(c, dict):
            continue
        status = str(c.get("last_status") or "")
        label = str(c.get("label") or c.get("source") or "账号")
        label = {"device_code": "ChatGPT 登录"}.get(label, label)
        rows.append({"n": i + 1, "label": label[:60], "type": str(c.get("auth_type") or ""),
                     "id": str(c.get("id") or ""), "current": i == 0,
                     "exhausted": bool(c.get("last_error_reset_at")) or status in ("exhausted", "rate_limited", "cooldown")})
    _POOL[provider] = (time.monotonic(), rows)
    return rows


def forget_pool() -> None:
    _POOL.clear()
