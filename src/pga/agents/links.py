"""Links: how PGA stays connected to each agent, and whether it still is.

Each agent is reached the most direct way it offers, falling back to a one-off command when that fails:

    api          an HTTP API: DeepSeek (PGA's own model); Claude through the Anthropic API when a working key is set
                 (questions and text work — writing code still goes through Claude Code); Hermes through its own
                 local API server (`/v1/runs`, with session ids) when that server runs
    app-server   Codex's JSON-RPC app server (`codex app-server`): one long-lived process per agent; a chat keeps one
                 thread per conversation (resumed after a restart); the account and the rate limits are read live
    session      Claude Code / CodeBuddy kept running in stream-json mode, one process per conversation; it closes
                 after 20 idle minutes and is resumed by its session id on the next message
    cli          one process per call (`claude -p`, `codex exec`, `hermes chat -Q` …)

The keeper checks every link when PGA starts and every `run.heartbeat_minutes` (30) with the cheapest probe each one
has — no model call where a free status check exists (DeepSeek `/models`, Codex `account/read` + rate limits,
`claude auth status`, Hermes `/health`); CodeBuddy has none, so it gets a one-word prompt at most every 6 hours while
it works (a failed login fails before any model call). Each agent then has a state:

    online · expiring (a known token is near its end) · login (you need to sign in) · offline (cannot reach it)
    absent (not installed) · disabled · unknown (not checked yet)

Routing skips agents in login/offline; a change into login/offline/expiring tells the owner once; the star map shows
the state on each agent's planet. State, thread ids and session ids live in ~/Documents/PGA/state/links.json.
"""

from __future__ import annotations

import collections
import hashlib
import json
import logging
import os
import queue
import subprocess
import tempfile
import threading
import time
import uuid
from dataclasses import asdict, dataclass, field
from datetime import datetime, timedelta, timezone
from pathlib import Path
from typing import TYPE_CHECKING, Any, Callable

from pga.agents.base import FULL, WORKSPACE_WRITE, AgentResult, AgentTask

if TYPE_CHECKING:
    from pga.agents.base import Adapter

log = logging.getLogger("pga.agents.links")

HEARTBEAT_MIN = 30
IDLE_S = 20 * 60                  # a conversation's session process closes after this long unused
PROMPT_CHECK_H = 6                # CodeBuddy: re-verify a working login with a prompt at most this often
TOKEN_DAYS, WARN_DAYS = 365, 14   # `claude setup-token` tokens last a year; warn two weeks ahead
DOWN = ("login", "offline")
LABEL = {"online": "在线", "expiring": "登录将过期", "login": "需要登录", "offline": "已断开", "absent": "未安装",
         "disabled": "已停用", "unknown": "未检查"}
VIA = {"api": "API", "app-server": "app-server 常驻", "session": "常驻会话", "cli": "命令行"}
FIX_EN = {
    "codex_local": "Open the ChatGPT app and sign in, or run `codex login` in a terminal.",
    "claude_local": "Run `claude setup-token` in a terminal and paste the token into the Claude card's settings.",
    "codebuddy_local": "Run the CodeBuddy CLI bundled with WorkBuddy in a terminal and type /login, or set CODEBUDDY_API_KEY.",
    "hermes_local": "Check that Hermes is installed and signed in (`hermes status`).",
    "llm": "Check the API key in Settings → Models & API.",
}


class LinkDown(RuntimeError):
    """The link itself failed (could not start, connect or talk) — the caller may fall back to the command line."""


class RpcError(LinkDown):
    pass


def _now() -> datetime:
    return datetime.now(timezone.utc)


def _iso(d: datetime | None) -> str | None:
    return d.isoformat() if d else None


def _parse(s: str | None) -> datetime | None:
    try:
        return datetime.fromisoformat(s) if s else None
    except ValueError:
        return None


# ---------------------------------------------------------------- the state file

_LOCK = threading.RLock()
_STATE: dict[str, dict] = {"agents": {}, "threads": {}, "sessions": {}, "tokens": {}}
_LOADED: list[str] = []          # the file the state was loaded from (tests point PGA_LINKS_FILE elsewhere)
_ACTIVE = threading.Event()      # set while a keeper runs: only then do link states steer routing


def state_file() -> Path:
    return Path(os.environ.get("PGA_LINKS_FILE") or Path(__file__).resolve().parents[3].parent / "state" / "links.json")


def _load() -> None:
    with _LOCK:
        f = str(state_file())
        if _LOADED and _LOADED[0] == f:
            return
        _LOADED[:] = [f]
        for k in _STATE:
            _STATE[k] = {}
        try:
            data = json.loads(Path(f).read_text(encoding="utf-8"))
        except (OSError, ValueError):
            return
        for k in _STATE:
            if isinstance(data.get(k), dict):
                _STATE[k].update(data[k])


def _save() -> None:
    with _LOCK:
        f = state_file()
        try:
            f.parent.mkdir(parents=True, exist_ok=True)
            tmp = f.with_suffix(".tmp")
            tmp.write_text(json.dumps(_STATE, ensure_ascii=False, indent=1), encoding="utf-8")
            tmp.replace(f)
        except OSError as exc:
            log.warning("could not save link state: %s", exc)


def _get(kind: str, key: str) -> Any:
    _load()
    with _LOCK:
        return _STATE[kind].get(key)


def _put(kind: str, key: str, value: Any) -> None:
    _load()
    with _LOCK:
        if value is None:
            _STATE[kind].pop(key, None)
        else:
            _STATE[kind][key] = value
        _save()


def thread_for(agent: str, conv: str) -> str | None:
    return _get("threads", f"{agent}|{conv}")


def session_for(agent: str, conv: str) -> str | None:
    return _get("sessions", f"{agent}|{conv}")


def active() -> bool:
    return _ACTIVE.is_set()


def state(name: str) -> dict | None:
    """The agent's link state — only while a keeper runs (the service), so tests and scripts are never steered by it."""
    return _get("agents", name) if active() else None


def ok_at(name: str) -> datetime | None:
    s = state(name)
    return _parse(s.get("ok_at")) if s else None


def api_ok(name: str) -> bool:
    s = state(name)
    return bool(s and (s.get("api") or {}).get("ok"))


def live_quota(name: str, max_age_min: float = 2 * HEARTBEAT_MIN + 5) -> dict | None:
    """Remaining usage the link itself reported (Codex rate limits), if fresh."""
    s = state(name)
    q = (s or {}).get("quota")
    if not q or not q.get("at"):
        return None
    at = _parse(q["at"])
    return q if at and _now() - at < timedelta(minutes=max_age_min) else None


def shared_quota(source: str) -> dict | None:
    """The freshest live quota of this kind from any agent (ChatGPT, Codex and Hermes share one ChatGPT account)."""
    _load()
    with _LOCK:
        names = [n for n, s in _STATE["agents"].items() if ((s.get("quota") or {}).get("source") == source)]
    best = [q for q in (live_quota(n) for n in names) if q]
    return max(best, key=lambda q: q["at"]) if best else None


def view() -> dict[str, dict]:
    _load()
    with _LOCK:
        out = {n: dict(s) for n, s in _STATE["agents"].items()}
    for n, s in out.items():
        s["label"] = LABEL.get(s.get("state", "unknown"), s.get("state"))
        s["via_label"] = VIA.get(s.get("via", ""), s.get("via", ""))
        s["sessions"] = StreamSession.count(n) + CodexServer.threads(n)
        s["warm"] = CodexServer.alive(n) or StreamSession.count(n) > 0
    return out


# ---------------------------------------------------------------- probes


@dataclass
class Check:
    state: str                          # online | expiring | login | offline | absent | disabled
    via: str = "cli"                    # api | app-server | session | cli
    detail: str = ""
    expires_at: str | None = None
    quota: dict | None = None           # remaining usage the link reported (Codex)
    api: dict | None = None             # {"ok": bool, "detail": str} when the agent also has a direct API
    extra: dict = field(default_factory=dict)


def record(name: str, c: Check, now: datetime | None = None) -> tuple[str | None, dict]:
    """Store a check; returns (previous state, new entry)."""
    now = now or _now()
    _load()
    with _LOCK:
        prev = dict(_STATE["agents"].get(name) or {})
        e = {**prev, "state": c.state, "via": c.via, "detail": c.detail[:400], "checked_at": _iso(now),
             "expires_at": c.expires_at, "api": c.api, **c.extra}
        if c.quota is not None:
            e["quota"] = {**c.quota, "at": _iso(now)}
        if c.state in ("online", "expiring"):
            e["ok_at"] = _iso(now)
        if prev.get("state") != c.state:
            e["since"] = _iso(now)
        _STATE["agents"][name] = e
        _save()
    return prev.get("state"), e


def probe(name: str, ad: "Adapter", cfg: dict, rt: Any) -> Check:
    if cfg.get("enabled", True) is False:
        return Check("disabled", _via_of(ad), "已停用")
    try:
        t = ad.type
        if t == "llm":
            return _probe_llm(rt)
        if t == "codex_local":
            return _probe_codex(ad)
        if t == "claude_local":
            return _probe_claude(name, ad, cfg)
        if t == "codebuddy_local":
            return _probe_codebuddy(name, ad)
        if t == "hermes_local":
            return _probe_hermes(ad, cfg)
        if t == "http":
            return _probe_http(cfg)
        ok, detail = ad.available()
        return Check("online" if ok else "absent", "cli", detail)
    except Exception as exc:  # noqa: BLE001 - a probe failing means "cannot reach it", never a crash
        return Check("offline", _via_of(ad), f"检查失败：{type(exc).__name__}: {exc}"[:300])


def _via_of(ad: "Adapter") -> str:
    return {"llm": "api", "codex_local": "app-server", "claude_local": "session", "codebuddy_local": "session"}.get(ad.type, "cli")


def _probe_llm(rt: Any) -> Check:
    import httpx
    prov = rt.router.provider
    if getattr(prov, "name", "") == "fake":
        return Check("online", "api", "离线测试模型")
    client = getattr(prov, "_client", None)
    if isinstance(client, httpx.Client):
        try:
            r = client.get("/models", timeout=15)
        except httpx.HTTPError as exc:
            return Check("offline", "api", f"连不上 {prov.name}：{exc}"[:200])
        if r.status_code in (401, 403):
            return Check("login", "api", f"{prov.name} 的 API key 无效（HTTP {r.status_code}）")
        if r.status_code >= 400:
            return Check("offline", "api", f"{prov.name} 返回 HTTP {r.status_code}")
        return Check("online", "api", f"{prov.name} API")
    if getattr(prov, "name", "") == "anthropic" and client is not None:
        try:
            client.models.list(limit=1)
        except Exception as exc:  # noqa: BLE001
            bad = "401" in str(exc) or "authentication" in str(exc).lower()
            return Check("login" if bad else "offline", "api", f"Anthropic API：{exc}"[:200])
        return Check("online", "api", "Anthropic API")
    return Check("online", "cli", getattr(prov, "name", ""))


def probe_api(api: dict | None) -> dict | None:
    """A direct provider API an agent may use instead of its CLI: {"ok", "detail"}; None when no key is set."""
    if not api:
        return None
    import httpx

    from pga.llm.catalog import get_key
    key = get_key(api.get("key_env") or "")
    if not key:
        return None
    kind = api.get("type", "anthropic")
    try:
        if kind == "anthropic":
            r = httpx.get((api.get("base_url") or "https://api.anthropic.com").rstrip("/") + "/v1/models",
                          headers={"x-api-key": key, "anthropic-version": "2023-06-01"}, timeout=15)
        else:
            r = httpx.get((api.get("base_url") or "https://api.openai.com/v1").rstrip("/") + "/models",
                          headers={"Authorization": f"Bearer {key}"}, timeout=15)
    except httpx.HTTPError as exc:
        return {"ok": False, "detail": f"{api.get('key_env')}：连不上（{type(exc).__name__}）"}
    if r.status_code in (401, 403):
        return {"ok": False, "detail": f"{api.get('key_env')} 无效（HTTP {r.status_code}）"}
    if r.status_code >= 400:
        return {"ok": False, "detail": f"{api.get('key_env')}：HTTP {r.status_code}"}
    return {"ok": True, "detail": f"{kind} API · {api.get('model', '')}"}


def _codex_quota(lim: dict) -> dict | None:
    rl = (lim or {}).get("rateLimits") or {}
    parts, used, reset = [], 0.0, None
    for key in ("primary", "secondary"):
        w = rl.get(key)
        if not isinstance(w, dict) or w.get("usedPercent") is None:
            continue
        u, mins = float(w["usedPercent"]), int(w.get("windowDurationMins") or 0)
        span = "每周" if mins >= 7 * 24 * 60 else f"{round(mins / 60)} 小时" if mins else "窗口"
        parts.append(f"{span}已用 {u:.0f}%")
        if u >= used:
            used = u
            reset = datetime.fromtimestamp(w["resetsAt"], timezone.utc) if w.get("resetsAt") else None
    if not parts:
        return None
    blocked = lim.get("ordinaryUsageAllowed") is False or bool(rl.get("spendControlReached"))
    return {"remaining": max(0.0, 1 - used / 100), "detail": " · ".join(parts) + " · 实时", "source": "codex_live",
            "resets_at": _iso(reset), "exhausted": used >= 100 or blocked}


def _probe_codex(ad: "Adapter") -> Check:
    try:
        srv = CodexServer.get(ad)
        acct = srv.rpc.request("account/read", {"refreshToken": True}, 40)     # also keeps the login fresh
    except LinkDown as exc:
        ok, detail = ad.available()
        if not ok:
            return Check("absent", "cli", detail)
        try:
            out = subprocess.run([ad.exe(), "login", "status"], capture_output=True, text=True, timeout=20, env=ad.env())
            logged = out.returncode == 0 and "logged in" in (out.stdout + out.stderr).lower()
        except (OSError, subprocess.SubprocessError):
            logged = False
        return Check("online" if logged else "login", "cli", f"app-server 不可用（{exc}），用命令行" if logged
                     else "ChatGPT 未登录：打开 ChatGPT 应用登录，或在终端运行 codex login")
    a = acct.get("account")
    if not a:
        return Check("login", "app-server", "ChatGPT 未登录：打开 ChatGPT 应用登录，或在终端运行 codex login")
    q = None
    try:
        q = _codex_quota(srv.rpc.request("account/rateLimits/read", None, 30))
        if q and (ad.config.get("env") or {}).get("CODEX_HOME"):    # another ChatGPT account: never shared with the first
            q["source"] = f"codex_live:{ad.name}"
    except LinkDown:
        pass
    plan = a.get("planType") or ""
    who = a.get("email") or ""                                     # which account, once there is more than one
    return Check("online", "app-server", f"{'ChatGPT' if a.get('type') == 'chatgpt' else a.get('type', '')}{' · ' + plan if plan else ''}"
                 f"{' · ' + who if who else ''}", quota=q)


def _token_expiry(name: str, token: str | None) -> datetime | None:
    """A long-lived token's end: first seen + a year (the CLI does not say)."""
    if not token:
        return None
    sha = hashlib.sha256(token.encode()).hexdigest()[:16]
    t = _get("tokens", name) or {}
    if t.get("sha") != sha:
        t = {"sha": sha, "first_seen": _iso(_now())}
        _put("tokens", name, t)
    first = _parse(t.get("first_seen"))
    return first + timedelta(days=TOKEN_DAYS) if first else None


def _probe_claude(name: str, ad: "Adapter", cfg: dict) -> Check:
    api = probe_api(cfg.get("api"))
    exe, logged, method = ad.exe(), False, ""
    env = ad.env() if exe else {}
    if exe:
        try:
            out = subprocess.run([exe, "auth", "status", "--json"], capture_output=True, text=True, timeout=25, env=env)
            d = json.loads(out.stdout or "{}")
            logged, method = bool(d.get("loggedIn")), str(d.get("authMethod") or "")
        except (OSError, subprocess.SubprocessError, ValueError):
            pass
    ends = _token_expiry(name, env.get("CLAUDE_CODE_OAUTH_TOKEN")) if logged else None
    state = "expiring" if ends and ends - _now() < timedelta(days=WARN_DAYS) else "online"
    cli = (f"Claude Code 已登录（{method}）" if logged else "Claude Code 未登录（写代码的任务需要它：在终端运行 claude setup-token）"
           if exe else "Claude Code 未安装")
    if api and api["ok"]:
        return Check(state if logged else "online", "api", f"{api['detail']} · {cli}", expires_at=_iso(ends), api=api)
    if not exe:
        return Check("absent", "cli", "claude 未安装" + (f" · {api['detail']}" if api else ""), api=api)
    if logged:
        return Check(state, "session", cli + (f" · {api['detail']}" if api else ""), expires_at=_iso(ends), api=api)
    return Check("login", "session", "Claude Code 未登录：在终端运行 claude setup-token，把令牌粘贴到这张卡片的设置里"
                 + (f" · {api['detail']}" if api else ""), api=api)


def _probe_codebuddy(name: str, ad: "Adapter") -> Check:
    prev = _get("agents", name) or {}
    verified = _parse(prev.get("verified_at"))
    if prev.get("state") == "online" and verified and _now() - verified < timedelta(hours=PROMPT_CHECK_H):
        return Check("online", "session", f"CodeBuddy 已登录 · {verified.astimezone().strftime('%H:%M')} 验证过",
                     extra={"verified_at": prev["verified_at"]})
    ok, detail = ad.available()
    if not ok:
        return Check("absent", "cli", detail)
    r = ad.run(AgentTask(prompt="Reply with the single word OK.", timeout_s=90, max_turns=1))
    if r.ok:
        return Check("online", "session", "CodeBuddy 已登录", extra={"verified_at": _iso(_now())})
    from pga.agents.quota import AUTH_ERROR
    if AUTH_ERROR.search(r.error or ""):
        return Check("login", "session", r.error or "需要登录")
    return Check("offline", "session", (r.error or r.status)[:300])


def _probe_hermes(ad: "Adapter", cfg: dict) -> Check:
    api = HermesApi.of(cfg)
    note = ""
    if api.key:
        try:
            api.health(fresh=True)
            return Check("online", "api", f"Hermes 本地 API · {api.base}")
        except LinkDown as exc:
            note = f" · 本地 API 连不上（{exc}）"
    else:
        note = " · 本地 API 未开启"
    ok, detail = ad.available()
    return Check("online" if ok else "absent", "cli", f"命令行 · {detail}{note}")


def _probe_http(cfg: dict) -> Check:
    import httpx
    url = str(cfg.get("url") or "")
    if not url.startswith(("http://", "https://")):
        return Check("absent", "api", "url 未设置")
    try:
        r = httpx.head(url, timeout=10)
    except httpx.HTTPError as exc:
        return Check("offline", "api", f"连不上：{exc}"[:200])
    return Check("online" if r.status_code < 500 else "offline", "api", f"HTTP {r.status_code}")


# ---------------------------------------------------------------- JSON-RPC over stdio (Codex app-server)


class RpcProcess:
    def __init__(self, argv: list[str], env: dict, cwd: str, on_notify: Callable[[dict], None],
                 on_request: Callable[[dict], dict]):
        try:
            self.p = subprocess.Popen(argv, stdin=subprocess.PIPE, stdout=subprocess.PIPE, stderr=subprocess.PIPE,
                                      text=True, bufsize=1, env=env, cwd=cwd)
        except OSError as exc:
            raise LinkDown(f"cannot start {argv[0]}: {exc}") from exc
        self.on_notify, self.on_request = on_notify, on_request
        self._id, self._pending = 0, {}
        self._lock, self._wlock = threading.Lock(), threading.Lock()
        self.err: collections.deque[str] = collections.deque(maxlen=40)
        threading.Thread(target=self._read, daemon=True, name="pga-rpc-out").start()
        threading.Thread(target=lambda: [self.err.append(x) for x in self.p.stderr], daemon=True, name="pga-rpc-err").start()

    def _read(self) -> None:
        for line in self.p.stdout:
            try:
                m = json.loads(line)
            except ValueError:
                continue
            if not isinstance(m, dict):
                continue
            if "method" in m and "id" in m:                          # the server asks us something (approvals)
                threading.Thread(target=self._answer, args=(m,), daemon=True).start()
            elif "method" in m:
                try:
                    self.on_notify(m)
                except Exception:  # noqa: BLE001
                    log.exception("rpc notification handler")
            elif "id" in m:
                slot = self._pending.pop(m["id"], None)
                if slot:
                    slot["msg"] = m
                    slot["ev"].set()
        why = "".join(list(self.err)[-3:]).strip()[-300:]
        for slot in list(self._pending.values()):
            slot["msg"] = {"error": {"message": f"process exited {why}".strip()}}
            slot["ev"].set()
        self._pending.clear()
        self.on_notify({"method": "_closed", "params": {}})

    def _answer(self, m: dict) -> None:
        try:
            self._send({"id": m["id"], "result": self.on_request(m)})
        except Exception as exc:  # noqa: BLE001
            self._send({"id": m["id"], "error": {"code": -32601, "message": str(exc)[:200]}})

    def _send(self, msg: dict) -> None:
        try:
            with self._wlock:
                self.p.stdin.write(json.dumps(msg) + "\n")
                self.p.stdin.flush()
        except (BrokenPipeError, OSError, ValueError) as exc:
            raise RpcError(f"app-server is gone: {exc}") from exc

    def request(self, method: str, params: dict | None = None, timeout: float = 60) -> dict:
        with self._lock:
            self._id += 1
            rid = self._id
            slot = self._pending[rid] = {"ev": threading.Event()}
        self._send({"id": rid, "method": method, **({"params": params} if params is not None else {})})
        if not slot["ev"].wait(timeout):
            self._pending.pop(rid, None)
            raise RpcError(f"{method}: no reply within {timeout:.0f}s")
        m = slot["msg"]
        if "error" in m:
            raise RpcError(f"{method}: {(m['error'] or {}).get('message', m['error'])}")
        return m.get("result") or {}

    def notify(self, method: str, params: dict | None = None) -> None:
        self._send({"method": method, **({"params": params} if params is not None else {})})

    def alive(self) -> bool:
        return self.p.poll() is None

    def close(self) -> None:
        if self.p.poll() is None:
            self.p.terminate()
            try:
                self.p.wait(timeout=5)
            except subprocess.TimeoutExpired:
                self.p.kill()


def _codex_answer(m: dict) -> dict:
    """Codex asks before something the sandbox does not allow: PGA never widens it."""
    meth = m.get("method", "")
    if meth in ("item/commandExecution/requestApproval", "item/fileChange/requestApproval"):
        return {"decision": "decline"}
    if meth in ("applyPatchApproval", "execCommandApproval"):
        return {"decision": "denied"}
    if meth == "item/tool/requestUserInput":
        return {"answers": {}}
    raise RpcError(f"{meth} is not supported by PGA")


class CodexServer:
    _ALL: dict[str, "CodexServer"] = {}
    _ALL_LOCK = threading.Lock()

    def __init__(self, name: str, argv: list[str], env: dict):
        self.name, self.argv, self.env = name, argv, env
        self.rpc: RpcProcess | None = None
        self.loaded: set[str] = set()
        self.listeners: dict[str, queue.Queue] = {}
        self.lock = threading.Lock()
        self.started_at = 0.0

    @classmethod
    def get(cls, ad: "Adapter", full: bool = False) -> "CodexServer":
        """One app server per agent (and a second one, with commands allowed, for projects you opened up)."""
        argv = ad.server_command(full=full) if full else ad.server_command()
        key = ad.name + (":full" if full else "")
        with cls._ALL_LOCK:
            s = cls._ALL.get(key)
            if s is None or s.argv != argv:
                if s:
                    s.close()
                s = cls._ALL[key] = cls(ad.name, argv, ad.env())
        s.ensure()
        return s

    @classmethod
    def alive(cls, name: str) -> bool:
        s = cls._ALL.get(name)
        return bool(s and s.rpc and s.rpc.alive())

    @classmethod
    def threads(cls, name: str) -> int:
        s = cls._ALL.get(name)
        return len(s.loaded) if s and s.rpc and s.rpc.alive() else 0

    @classmethod
    def close_all(cls) -> None:
        with cls._ALL_LOCK:
            for s in cls._ALL.values():
                s.close()
            cls._ALL.clear()

    def ensure(self) -> None:
        with self.lock:
            if self.rpc and self.rpc.alive():
                return
            self.loaded.clear()
            self.rpc = RpcProcess(self.argv, self.env, str(Path.home()), self._notify, _codex_answer)
            try:
                self.rpc.request("initialize", {"clientInfo": {"name": "pga", "title": "PGA", "version": "0.1"}}, 30)
                self.rpc.notify("initialized")
            except LinkDown:
                self.rpc.close()
                raise
            self.started_at = time.time()

    def _notify(self, m: dict) -> None:
        if m.get("method") == "_closed":
            for q in list(self.listeners.values()):
                q.put(m)
            return
        tid = (m.get("params") or {}).get("threadId")
        q = self.listeners.get(tid) if tid else None
        if q is not None:
            q.put(m)

    def close(self) -> None:
        if self.rpc:
            self.rpc.close()

    def turn(self, ad: "Adapter", task: AgentTask) -> AgentResult:
        """One turn on a thread: the conversation's own thread (kept, resumable) or a fresh ephemeral one."""
        from pga.agents import live
        lid, conv = task.meta.get("live_id"), task.meta.get("conversation")
        sandbox = "workspace-write" if task.permissions in (WORKSPACE_WRITE, FULL) else "read-only"
        cwd = task.workspace or tempfile.mkdtemp(prefix="pga-agent-")
        model = task.meta.get("model") or ad.config.get("model")
        effort = task.meta.get("effort") or ad.config.get("reasoning")
        used_model = None
        tid, fresh = (thread_for(self.name, conv) if conv else None), True
        if tid and tid in self.loaded:
            fresh = False
        elif tid:
            try:
                self.rpc.request("thread/resume", {"threadId": tid, "cwd": cwd, "sandbox": sandbox, "approvalPolicy": "never",
                                                   "excludeTurns": True}, 60)
                self.loaded.add(tid)
                fresh = False
            except RpcError as exc:
                log.info("codex thread %s not resumed (%s): a new one", tid, exc)
                tid = None
        if not tid:
            params: dict[str, Any] = {"cwd": cwd, "sandbox": sandbox, "approvalPolicy": "never", "ephemeral": not conv,
                                      "serviceName": "PGA"}
            if task.system.strip():
                params["developerInstructions"] = task.system.strip()
            if model:
                params["model"] = str(model)
            started = self.rpc.request("thread/start", params, 60)
            tid, used_model = started["thread"]["id"], started.get("model")
            self.loaded.add(tid)
            if conv:
                _put("threads", f"{self.name}|{conv}", tid)
        text = (task.meta.get("new_text") if not fresh and task.meta.get("new_text") else task.prompt).strip()
        if task.want_json:
            text += "\n\nReply with JSON only."
        q: queue.Queue = queue.Queue()
        self.listeners[tid] = q
        try:
            params = {"threadId": tid, "input": [{"type": "text", "text": text}]
                      + [{"type": "localImage", "path": str(p)} for p in task.meta.get("images") or []]}
            if model:
                params["model"] = str(model)
            if effort:
                params["effort"] = str(effort)
            turn_id = self.rpc.request("turn/start", params, 60)["turn"]["id"]
            finals, deltas, err, usage = [], [], None, None
            deadline = time.monotonic() + task.timeout_s
            while True:
                left = deadline - time.monotonic()
                if left <= 0:
                    try:
                        self.rpc.request("turn/interrupt", {"threadId": tid, "turnId": turn_id}, 10)
                    except LinkDown:
                        pass
                    live.append(lid, f"\n（{task.timeout_s:.0f} 秒内没有完成）")
                    return AgentResult(ok=False, status="TIMEOUT", error=f"no answer within {task.timeout_s:.0f}s")
                if live.stopped(lid):                          # you pressed stop: interrupt the turn, keep what it said
                    try:
                        self.rpc.request("turn/interrupt", {"threadId": tid, "turnId": turn_id}, 10)
                    except LinkDown:
                        pass
                    said = (live.text(lid) or "".join(deltas)).strip()       # exactly what you saw so far
                    return AgentResult(ok=bool(said), text=said, status="STOPPED", error=None if said else "你停止了生成",
                                       session_id=tid, model=str(model or used_model or "") or None, data={"stopped": True, "via": "app-server"})
                try:
                    m = q.get(timeout=min(left, 0.5))
                except queue.Empty:
                    continue
                meth, p = m.get("method"), m.get("params") or {}
                if meth == "_closed":
                    err = "app-server 中途退出"
                    break
                if p.get("turnId") not in (None, turn_id):
                    continue
                if meth == "item/agentMessage/delta":
                    deltas.append(p.get("delta") or "")
                    live.append(lid, p.get("delta") or "")
                elif meth == "item/completed":
                    item = p.get("item") or {}
                    kind = item.get("type")
                    if kind == "agentMessage":
                        finals.append(str(item.get("text") or ""))
                        live.append(lid, "\n")
                    elif kind == "commandExecution":
                        live.append(lid, f"$ {str(item.get('command') or '')[:200]}\n")
                    elif kind == "webSearch":
                        live.append(lid, f"（搜索）{str(item.get('query') or '')[:200]}\n")
                elif meth == "thread/tokenUsage/updated":
                    usage = p.get("tokenUsage")
                elif meth == "error" and not p.get("willRetry"):
                    err = str((p.get("error") or {}).get("message") or "error")[:500]
                elif meth == "turn/completed":
                    t = p.get("turn") or {}
                    if t.get("status") != "completed":
                        err = err or str((t.get("error") or {}).get("message") or t.get("status"))[:500]
                    break
        finally:
            self.listeners.pop(tid, None)
        out = (finals[-1] if finals else "".join(deltas)).strip()
        ok = bool(out) and not err
        return AgentResult(ok=ok, text=out, error=None if ok else (err or "no answer"), status="SUCCEEDED" if ok else "FAILED",
                           session_id=tid, model=str(model or used_model or "") or None,
                           data={"via": "app-server", "thread": tid, **({"effort": effort} if effort else {}), **({"usage": usage} if usage else {})})


# ---------------------------------------------------------------- stream-json sessions (Claude Code / CodeBuddy)


class StreamSession:
    """One conversation kept running: `claude -p --input-format stream-json …` reads a user message per line and
    answers each with events ending in a `result`. Idle ones close; the next message resumes them by session id."""
    _ALL: dict[str, "StreamSession"] = {}
    _ALL_LOCK = threading.Lock()

    def __init__(self, ad: "Adapter", conv: str, task: AgentTask):
        self.agent, self.conv = ad.name, conv
        self.session_id = session_for(ad.name, conv)
        self.resumed = bool(self.session_id)
        self.permissions, self.cwd = task.permissions, task.workspace or tempfile.mkdtemp(prefix="pga-agent-")
        self.choice = (task.meta.get("model"), task.meta.get("effort"))
        exe = ad.exe()
        if not exe:
            raise LinkDown(f"{ad.binary} is not installed")
        try:
            self.p = subprocess.Popen(ad.session_command(task, exe, self.session_id), stdin=subprocess.PIPE,
                                      stdout=subprocess.PIPE, stderr=subprocess.PIPE, text=True, bufsize=1,
                                      env=ad.env(), cwd=self.cwd)
        except OSError as exc:
            raise LinkDown(str(exc)) from exc
        self.lines: queue.Queue = queue.Queue()
        self.err: collections.deque[str] = collections.deque(maxlen=40)
        threading.Thread(target=lambda: ([self.lines.put(x) for x in self.p.stdout], self.lines.put(None)), daemon=True).start()
        threading.Thread(target=lambda: [self.err.append(x) for x in self.p.stderr], daemon=True).start()
        self.used = time.monotonic()
        self.busy = threading.Lock()

    @classmethod
    def ask(cls, ad: "Adapter", task: AgentTask) -> AgentResult:
        conv = str(task.meta["conversation"])
        key = f"{ad.name}|{conv}"
        with cls._ALL_LOCK:
            s = cls._ALL.get(key)
            if s and (not s.alive() or s.permissions != task.permissions or s.choice != (task.meta.get("model"), task.meta.get("effort"))
                      or (task.workspace and s.cwd != task.workspace)):
                s.close()
                s = None
            warm = s is not None
            if s is None:
                s = cls._ALL[key] = cls(ad, conv, task)
        cont = warm or s.resumed
        text = task.meta.get("new_text") if cont and task.meta.get("new_text") else None
        return s.send(ad, task, text)

    @classmethod
    def count(cls, name: str) -> int:
        return sum(1 for s in list(cls._ALL.values()) if s.agent == name and s.alive())

    @classmethod
    def reap(cls, idle_s: float = IDLE_S) -> int:
        with cls._ALL_LOCK:
            old = [k for k, s in cls._ALL.items() if not s.alive() or (time.monotonic() - s.used > idle_s and not s.busy.locked())]
            for k in old:
                cls._ALL.pop(k).close()
        return len(old)

    @classmethod
    def close_all(cls) -> None:
        with cls._ALL_LOCK:
            for s in cls._ALL.values():
                s.close()
            cls._ALL.clear()

    def alive(self) -> bool:
        return self.p.poll() is None

    def close(self) -> None:
        if self.p.poll() is None:
            try:
                self.p.stdin.close()
                self.p.wait(timeout=5)
            except (OSError, subprocess.TimeoutExpired):
                self.p.kill()

    def send(self, ad: "Adapter", task: AgentTask, text: str | None) -> AgentResult:
        from pga.agents import live
        from pga.agents.adapters import _prompt
        lid = task.meta.get("live_id")
        pics = list(task.meta.get("images") or [])
        task.meta["images"] = []                                       # sent as pictures below, not as paths
        body = text if text else _prompt(task)
        task.meta["images"] = pics
        if task.want_json and text:
            body += "\n\nReply with JSON only."
        content = [*_image_blocks(pics), {"type": "text", "text": body}]
        with self.busy:
            self.used = time.monotonic()
            while not self.lines.empty():                                  # nothing left over from an earlier turn
                if self.lines.get_nowait() is None:
                    self.lines.put(None)
                    break
            try:
                self.p.stdin.write(json.dumps({"type": "user", "message": {"role": "user", "content": content}}, ensure_ascii=False) + "\n")
                self.p.stdin.flush()
            except (BrokenPipeError, OSError, ValueError) as exc:
                raise LinkDown(f"session closed: {exc}") from exc
            out: list[str] = []
            deadline = time.monotonic() + task.timeout_s
            done = False
            while not done:
                left = deadline - time.monotonic()
                if left <= 0:
                    self.p.kill()
                    live.append(lid, f"\n（{task.timeout_s:.0f} 秒内没有完成）")
                    return AgentResult(ok=False, status="TIMEOUT", error=f"no answer within {task.timeout_s:.0f}s")
                if live.stopped(lid):                          # stop: end this process; the next message resumes the session
                    self.p.kill()
                    said = live.text(lid).strip()
                    return AgentResult(ok=bool(said), text=said, status="STOPPED", error=None if said else "你停止了生成",
                                       session_id=self.session_id, data={"stopped": True, "via": "session"})
                try:
                    line = self.lines.get(timeout=min(left, 0.5))
                except queue.Empty:
                    continue
                if line is None:
                    break
                out.append(line)
                try:
                    ev = json.loads(line)
                except ValueError:
                    ev = None
                if isinstance(ev, dict):
                    if ev.get("session_id") and ev.get("session_id") != self.session_id:
                        self.session_id = ev["session_id"]
                        _put("sessions", f"{self.agent}|{self.conv}", self.session_id)
                    done = ev.get("type") == "result"
                shown = ad.progress(line, task)
                if shown:
                    live.append(lid, shown[1:] if shown.startswith("\x00") else shown if shown.endswith("\n") else shown + "\n")
            self.used = time.monotonic()
        if not out:
            raise LinkDown("session ended without an answer: " + "".join(list(self.err)[-3:]).strip()[-300:])
        res = ad.parse("".join(out), "".join(self.err), task)
        res.data = {**(res.data or {}), "via": "session", "session": self.session_id, "continued": bool(text)}
        res.session_id = self.session_id
        return res


def _image_blocks(paths: list) -> list[dict]:
    """Pictures as Anthropic-style content blocks (Claude Code / CodeBuddy stream-json, the Anthropic API)."""
    import base64
    import mimetypes
    out = []
    for p in paths or []:
        try:
            data = Path(p).read_bytes()
        except OSError:
            continue
        mt = mimetypes.guess_type(str(p))[0] or "image/png"
        out.append({"type": "image", "source": {"type": "base64", "media_type": mt, "data": base64.b64encode(data).decode()}})
    return out


# ---------------------------------------------------------------- direct APIs


def api_chat(ad: "Adapter", task: AgentTask) -> AgentResult:
    """An agent's provider API (Claude via Anthropic), streamed onto the live board; history as real messages."""
    from pga.agents import live
    from pga.llm.catalog import get_key
    api = ad.config.get("api") or {}
    key = get_key(api.get("key_env") or "")
    if not key:
        raise LinkDown("no API key")
    messages = [{"role": "user" if h.get("role") == "user" else "assistant", "content": str(h.get("text") or "")}
                for h in (task.meta.get("history") or []) if str(h.get("text") or "").strip()]
    ask = (task.meta.get("new_text") or task.prompt) + ("\n\nReply with JSON only." if task.want_json else "")
    pics = _image_blocks(task.meta.get("images") or [])
    messages.append({"role": "user", "content": [*pics, {"type": "text", "text": ask}] if pics else ask})
    while len(messages) > 1 and messages[0]["role"] != "user":
        messages.pop(0)
    lid, model = task.meta.get("live_id"), str(task.meta.get("model") or api.get("model") or "claude-sonnet-5-5")
    if api.get("type", "anthropic") != "anthropic":
        raise LinkDown("only the Anthropic API is wired for agents")
    import anthropic
    client = anthropic.Anthropic(api_key=key, base_url=api.get("base_url") or None, timeout=task.timeout_s)
    parts: list[str] = []
    try:
        with client.messages.stream(model=model, max_tokens=int(api.get("max_tokens", 4000)), messages=messages,
                                    **({"system": task.system} if task.system.strip() else {})) as s:
            for piece in s.text_stream:
                parts.append(piece)
                live.append(lid, piece)
                if live.stopped(lid):
                    break
            final = None if live.stopped(lid) else s.get_final_message()
    except anthropic.AuthenticationError as exc:
        raise LinkDown(f"API key 无效：{exc}") from exc
    except anthropic.APIConnectionError as exc:
        raise LinkDown(f"连不上 Anthropic API：{exc}") from exc
    text = "".join(parts).strip()
    if final is None:
        return AgentResult(ok=bool(text), text=text, status="STOPPED", model=model, error=None if text else "你停止了生成", data={"stopped": True, "via": "api"})
    u = final.usage
    cost = (u.input_tokens * float(api.get("usd_per_mtok_in", 3)) + u.output_tokens * float(api.get("usd_per_mtok_out", 15))) / 1e6
    return AgentResult(ok=bool(text), text=text, model=final.model, cost_usd=round(cost, 6), error=None if text else "empty answer",
                       data={"via": "api", "usage": {"input": u.input_tokens, "output": u.output_tokens}})


class HermesApi:
    """Hermes Agent's local API server (`API_SERVER_ENABLED=true` in ~/.hermes/.env): runs with session ids, events
    as a stream, and dangerous-command approvals — which PGA always denies, as with the CLI (never --yolo)."""
    _health: dict[str, float] = {}

    def __init__(self, base: str, key: str | None):
        self.base, self.key = base.rstrip("/"), key

    @classmethod
    def of(cls, cfg: dict) -> "HermesApi":
        from pga.llm.catalog import get_key
        return cls(str(cfg.get("api_url") or "http://127.0.0.1:8642"), get_key(cfg.get("api_key_env") or "HERMES_API_SERVER_KEY"))

    def _h(self) -> dict:
        return {"Authorization": f"Bearer {self.key}"}

    def health(self, fresh: bool = False) -> None:
        import httpx
        if not self.key:
            raise LinkDown("本地 API 未开启")
        if not fresh and time.monotonic() - self._health.get(self.base, -1e9) < 60:
            return
        try:
            r = httpx.get(self.base + "/health", headers=self._h(), timeout=5)
        except httpx.HTTPError as exc:
            self._health.pop(self.base, None)
            raise LinkDown(type(exc).__name__) from exc
        if r.status_code >= 400:
            self._health.pop(self.base, None)
            raise LinkDown(f"HTTP {r.status_code}")
        self._health[self.base] = time.monotonic()

    def usable(self) -> bool:
        try:
            self.health()
            return True
        except LinkDown:
            return False

    def run(self, ad: "Adapter", task: AgentTask) -> AgentResult:
        import httpx

        from pga.agents import live
        lid, conv = task.meta.get("live_id"), task.meta.get("conversation")
        sid = f"pga-{hashlib.sha256(f'{ad.name}|{conv}'.encode()).hexdigest()[:20]}" if conv else f"pga-{uuid.uuid4().hex[:20]}"
        cont = bool(conv and session_for(ad.name, conv))
        body: dict[str, Any] = {"input": (task.meta.get("new_text") if cont and task.meta.get("new_text") else task.prompt)
                                + ("\n\nReply with JSON only." if task.want_json else ""), "session_id": sid}
        if task.system.strip():
            body["instructions"] = task.system.strip()
        try:
            r = httpx.post(self.base + "/v1/runs", json=body, headers=self._h(), timeout=30)
        except httpx.HTTPError as exc:
            raise LinkDown(f"Hermes API：{type(exc).__name__}") from exc
        if r.status_code >= 400:
            raise LinkDown(f"Hermes API HTTP {r.status_code}: {r.text[:200]}")
        run_id = r.json().get("run_id")
        if conv:
            _put("sessions", f"{ad.name}|{conv}", sid)
        parts, out, err, usage = [], None, None, None
        try:
            with httpx.stream("GET", f"{self.base}/v1/runs/{run_id}/events", headers=self._h(),
                              timeout=httpx.Timeout(task.timeout_s, connect=10)) as resp:
                for line in resp.iter_lines():
                    if not line.startswith("data:"):
                        continue
                    try:
                        ev = json.loads(line[5:].strip())
                    except ValueError:
                        continue
                    name = ev.get("event", "")
                    if live.stopped(lid):
                        httpx.post(f"{self.base}/v1/runs/{run_id}/stop", headers=self._h(), timeout=5)
                        out, err = "".join(parts), None
                        break
                    if name == "message.delta":
                        parts.append(ev.get("delta") or "")
                        live.append(lid, ev.get("delta") or "")
                    elif name == "tool.started":
                        live.append(lid, f"\n→ {ev.get('tool')} {str(ev.get('preview') or '')[:120]}\n")
                    elif name == "approval.request":
                        httpx.post(f"{self.base}/v1/runs/{run_id}/approval", headers=self._h(), timeout=10,
                                   json={"choice": "deny", **({"request_id": ev["request_id"]} if ev.get("request_id") else {})})
                        live.append(lid, "\n（拒绝了一个需要批准的命令）\n")
                    elif name == "run.completed":
                        out, usage = ev.get("output"), ev.get("usage")
                        break
                    elif name in ("run.failed", "run.cancelled", "run.interrupted"):
                        err = str(ev.get("error") or name)[:500]
                        break
        except httpx.TimeoutException:
            try:
                httpx.post(f"{self.base}/v1/runs/{run_id}/stop", headers=self._h(), timeout=5)
            except httpx.HTTPError:
                pass
            return AgentResult(ok=False, status="TIMEOUT", error=f"no answer within {task.timeout_s:.0f}s")
        text = str(out if out is not None else "".join(parts)).strip()
        ok = bool(text) and not err
        return AgentResult(ok=ok, text=text, error=None if ok else (err or "no answer"), status="SUCCEEDED" if ok else "FAILED",
                           session_id=sid, data={"via": "api", "run": run_id, **({"usage": usage} if usage else {})})


# ---------------------------------------------------------------- the keeper


class Keeper:
    """Checks every link at start and on the heartbeat, closes idle sessions, and tells the owner when one drops."""

    def __init__(self, session_factory: Callable[[], Any], runtime_factory: Callable[[Any], Any]):
        self.sf, self.make_rt = session_factory, runtime_factory
        self.stop_ev = threading.Event()
        self.thread: threading.Thread | None = None
        self.next: dict[str, float] = {}
        self.check_lock = threading.Lock()

    def start(self) -> "Keeper":
        _load()
        _ACTIVE.set()
        self.thread = threading.Thread(target=self._loop, daemon=True, name="pga-links")
        self.thread.start()
        return self

    def stop(self) -> None:
        self.stop_ev.set()
        _ACTIVE.clear()
        StreamSession.close_all()
        CodexServer.close_all()

    def _every_s(self, pool: Any) -> float:
        return 60 * float((pool.cfg.get("run") or {}).get("heartbeat_minutes") or HEARTBEAT_MIN)

    def _loop(self) -> None:
        self.stop_ev.wait(3)
        while not self.stop_ev.is_set():
            try:
                StreamSession.reap()
                self.check_all(due_only=True)
            except Exception:  # noqa: BLE001 - the keeper must outlive any one bad check
                log.exception("link heartbeat")
            self.stop_ev.wait(60)

    def check_all(self, due_only: bool = False) -> dict[str, dict]:
        from pga.agents.pool import AgentPool
        with self.sf() as s:
            names = list(AgentPool(self.make_rt(s)).adapters)
        out = {}
        for n in names:
            if due_only and time.monotonic() < self.next.get(n, 0):
                continue
            out[n] = self.check(n)
        return out

    def check(self, name: str) -> dict:
        from pga.agents.pool import AgentPool
        with self.check_lock, self.sf() as s:
            rt = self.make_rt(s)
            pool = AgentPool(rt)
            ad, cfg = pool.adapters.get(name), pool.cfg["agents"].get(name)
            if ad is None:
                return {}
            c = probe(name, ad, cfg, rt)
            prev, e = record(name, c)
            self.next[name] = time.monotonic() + self._every_s(pool)
            if prev != c.state and c.state in DOWN + ("expiring",):
                try:
                    self._tell(rt, name, ad.type, c)
                    s.commit()
                except Exception:  # noqa: BLE001
                    log.exception("could not tell the owner about %s", name)
            if prev != c.state:
                log.info("link %s: %s → %s (%s)", name, prev, c.state, c.detail)
        return e

    def _tell(self, rt: Any, name: str, adapter_type: str, c: Check) -> None:
        from pga.db.models import User
        from pga.db.types import CommKind, NotifyReason
        from pga.notify.service import Proposal
        from pga.owner import owner_id
        uid = owner_id(rt.session)
        user = rt.session.get(User, uid) if uid else None
        if user is None:
            return
        if c.state == "expiring":
            title, reason = f"The {name} agent's login ends soon", NotifyReason.DEADLINE
        elif c.state == "login":
            title, reason = f"The {name} agent needs you to sign in again", NotifyReason.DECISION_REQUIRED
        else:
            title, reason = f"PGA cannot reach the {name} agent", NotifyReason.DECISION_REQUIRED
        body = f"{c.detail}\n{FIX_EN.get(adapter_type, '')}\nUntil then PGA routes its work to the other agents."
        rt.notify.propose(user, Proposal(kind=CommKind.NOTIFICATION, reasons=[reason], title_en=title, body_en=body.strip(),
                                         dedupe_key=f"link:{name}:{c.state}"))


KEEPER: list[Keeper] = []


def start_keeper(session_factory: Callable[[], Any], runtime_factory: Callable[[Any], Any]) -> Keeper:
    k = Keeper(session_factory, runtime_factory).start()
    KEEPER[:] = [k]
    return k


def stop_keeper() -> None:
    for k in KEEPER:
        k.stop()
    KEEPER.clear()


def as_dict(c: Check) -> dict:
    return asdict(c)
