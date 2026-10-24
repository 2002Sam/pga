"""How much each agent has left — one of the two things routing weighs (the other is preference).

Sources (an agent's `quota.source` in agents.yaml):

    deepseek_balance  DeepSeek's balance API (GET /user/balance); remaining = balance / `full` (CNY)
    codex_sessions    the ChatGPT/Codex rate limits Codex writes into ~/.codex/sessions (5-hour and weekly windows,
                      `used_percent` and `resets_at`); ChatGPT, Codex and Hermes (openai-codex) share them
    observed          PGA's own count of this agent's runs in a window (`window_runs` per `window_hours`), and any
                      "usage limit" error seen recently — the agent is treated as exhausted until the window passes

Only the rate-limit fields are read from Codex session files, never the conversations.
"""

from __future__ import annotations

import json
import logging
import re
import time
from dataclasses import asdict, dataclass
from datetime import datetime, timedelta, timezone
from pathlib import Path
from typing import TYPE_CHECKING, Any

from sqlalchemy import func, select

from pga.db.models import AgentRun
from pga.db.types import utcnow

if TYPE_CHECKING:
    from sqlalchemy.orm import Session

log = logging.getLogger(__name__)
CODEX_SESSIONS = Path.home() / ".codex" / "sessions"
AUTH_ERROR = re.compile(r"(not logged in|authentication required|please run /login|unauthori[sz]ed|invalid api key|401|未登录)", re.I)
LIMIT_ERROR = re.compile(r"(usage limit|rate limit|quota|exceeded your|too many requests|429|limit reached|hit your [\w ]*limit|"
                         r"session limit|weekly limit|额度|用量已)", re.I)
_MONTHS = {m: i + 1 for i, m in enumerate(["jan", "feb", "mar", "apr", "may", "jun", "jul", "aug", "sep", "oct", "nov", "dec"])}


def limit_resets(error: str, at: datetime) -> datetime | None:
    """When a limit the error names ends: Claude Code says "resets 8:40pm (Asia/Shanghai)" or "resets Oct 17 at 6pm
    (Asia/Shanghai)"; the older form ends in "|<epoch seconds>". None when it does not say."""
    m = re.search(r"\|(\d{10})\b", error or "")
    if m:
        return datetime.fromtimestamp(int(m.group(1)), timezone.utc)
    m = re.search(r"resets\s+(?:([A-Za-z]{3})[a-z]*\s+(\d{1,2})\s+at\s+)?(\d{1,2})(?::(\d{2}))?\s*(am|pm)\s*(?:\(([^)]+)\))?", error or "", re.I)
    if not m:
        return None
    mon, day, hh, mm, ap, tzname = m.groups()
    try:
        from zoneinfo import ZoneInfo
        tz = ZoneInfo(tzname) if tzname else datetime.now().astimezone().tzinfo
    except Exception:  # noqa: BLE001 - an unknown zone: this machine's own
        tz = datetime.now().astimezone().tzinfo
    h = int(hh) % 12 + (12 if ap.lower() == "pm" else 0)
    local = at.astimezone(tz)
    if mon and _MONTHS.get(mon.lower()[:3]):
        t = local.replace(month=_MONTHS[mon.lower()[:3]], day=int(day), hour=h, minute=int(mm or 0), second=0, microsecond=0)
        if t < local - timedelta(days=1):                  # "Jan 2" said in late December
            t = t.replace(year=t.year + 1)
    else:
        t = local.replace(hour=h, minute=int(mm or 0), second=0, microsecond=0)
        if t <= local:
            t += timedelta(days=1)
    return t.astimezone(timezone.utc)
_CACHE: dict[str, tuple[float, "Quota"]] = {}


@dataclass
class Quota:
    remaining: float | None          # 0..1, None = unknown
    detail: str = ""
    source: str = ""
    resets_at: str | None = None
    exhausted: bool = False

    def as_dict(self) -> dict:
        return asdict(self)


def _cached(key: str, ttl: float, fn) -> Quota:
    hit = _CACHE.get(key)
    if hit and time.monotonic() - hit[0] < ttl:
        return hit[1]
    try:
        q = fn()
    except Exception as exc:  # noqa: BLE001 - a quota lookup failing leaves the agent usable, just "unknown"
        log.info("quota %s failed: %s", key, exc)
        q = Quota(None, f"读取失败：{str(exc)[:80]}", key.split(":")[0])
    _CACHE[key] = (time.monotonic(), q)
    return q


def clear() -> None:
    _CACHE.clear()


def deepseek_balance(full: float = 50.0) -> Quota:
    def look() -> Quota:
        import httpx

        from pga.llm.catalog import get_key
        key = get_key("DEEPSEEK_API_KEY")
        if not key:
            return Quota(None, "没有 DEEPSEEK_API_KEY", "deepseek_balance")
        r = httpx.get("https://api.deepseek.com/user/balance", headers={"Authorization": f"Bearer {key}"}, timeout=10)
        r.raise_for_status()
        d = r.json()
        infos = d.get("balance_infos") or []
        cny = next((i for i in infos if i.get("currency") == "CNY"), infos[0] if infos else {})
        total = float(cny.get("total_balance") or 0)
        sym = "¥" if cny.get("currency", "CNY") == "CNY" else "$"
        rem = max(0.0, min(1.0, total / full)) if full else None
        return Quota(rem, f"余额 {sym}{total:.2f}" + ("" if d.get("is_available", True) else " · 不可用"), "deepseek_balance",
                     exhausted=not d.get("is_available", True) or total <= 0)
    return _cached(f"deepseek_balance:{full}", 300, look)


def codex_sessions(root: Path | None = None) -> Quota:
    root = root or CODEX_SESSIONS

    def look() -> Quota:
        files = sorted(root.glob("*/*/*/*.jsonl"), key=lambda p: p.stat().st_mtime, reverse=True)[:6]
        best, when = None, None
        for f in files:
            last = None
            with f.open("rb") as fh:
                for raw in fh:
                    if b'"rate_limits"' in raw:
                        last = raw
            if last:
                best, when = _find_limits(json.loads(last)), datetime.fromtimestamp(f.stat().st_mtime, timezone.utc)
                if best:
                    break
        if not best:
            return Quota(None, "还没有 Codex 额度记录（用一次 ChatGPT/Codex 后出现）", "codex_sessions")
        parts, used, reset = [], 0.0, None
        for name, label in (("primary", "主窗口"), ("secondary", "次窗口")):
            w = best.get(name)
            if not isinstance(w, dict) or w.get("used_percent") is None:
                continue
            u = float(w["used_percent"])
            mins = w.get("window_minutes") or 0
            span = "每周" if mins >= 7 * 24 * 60 else f"{round(mins / 60)} 小时" if mins else label
            ra = datetime.fromtimestamp(w["resets_at"], timezone.utc) if w.get("resets_at") else None
            if ra and ra < utcnow():
                u = 0.0                                              # that window has already reset
            parts.append(f"{span}已用 {u:.0f}%")
            if u >= used:
                used, reset = u, ra
        stale = f" · 截至 {when.astimezone().strftime('%m-%d %H:%M')}" if when and utcnow() - when > timedelta(hours=6) else ""
        return Quota(max(0.0, 1 - used / 100), " · ".join(parts) + stale, "codex_sessions",
                     resets_at=reset.isoformat() if reset else None, exhausted=used >= 100)
    return _cached(f"codex_sessions:{root}", 120, look)


def _find_limits(o: Any) -> dict | None:
    if isinstance(o, dict):
        if isinstance(o.get("rate_limits"), dict):
            return o["rate_limits"]
        for v in o.values():
            r = _find_limits(v)
            if r:
                return r
    elif isinstance(o, list):
        for v in o:
            r = _find_limits(v)
            if r:
                return r
    return None


def observed(session: "Session", agent: str, window_hours: float = 5, window_runs: int = 40, now: datetime | None = None) -> Quota:
    now = now or utcnow()
    since = now - timedelta(hours=window_hours)
    n = session.scalar(select(func.count()).select_from(AgentRun).where(
        AgentRun.agent == agent, AgentRun.started_at >= since, AgentRun.status.in_(["SUCCEEDED", "FAILED", "TIMEOUT"]),
        AgentRun.adapter != "pool")) or 0
    # the latest limit error in the last week; it holds until the time it names (or the window), unless a run got through since
    fails = session.scalars(select(AgentRun).where(AgentRun.agent == agent, AgentRun.started_at >= now - timedelta(days=8),
                                                   AgentRun.status == "FAILED", AgentRun.error.is_not(None))
                            .order_by(AgentRun.started_at.desc()).limit(20))
    hit = next((r for r in fails if LIMIT_ERROR.search(r.error or "")), None)
    if hit is not None:
        until = limit_resets(hit.error or "", hit.started_at) or hit.started_at + timedelta(hours=window_hours)
        later = session.scalar(select(func.count()).select_from(AgentRun).where(
            AgentRun.agent == agent, AgentRun.started_at > hit.started_at, AgentRun.status == "SUCCEEDED", AgentRun.adapter != "pool")) or 0
        if now < until and not later:
            return Quota(0.0, f"触到用量上限（{hit.started_at.astimezone().strftime('%m-%d %H:%M')}），{until.astimezone().strftime('%m-%d %H:%M')} 重置",
                         "observed", until.isoformat(), exhausted=True)
    rem = max(0.0, 1 - n / window_runs) if window_runs else None
    return Quota(rem, f"{window_hours:g} 小时内用了 {n} / {window_runs} 次", "observed")


def needs_login(session: "Session", agent: str, now: datetime | None = None, cleared: datetime | None = None) -> Quota | None:
    """The agent's latest run (within 6 h) failed for want of a login or token: skip it until a run succeeds — or
    until a link check (`cleared`) found it signed in again."""
    now = now or utcnow()
    since = max(now - timedelta(hours=6), cleared) if cleared else now - timedelta(hours=6)
    latest = session.scalar(select(AgentRun).where(AgentRun.agent == agent, AgentRun.adapter != "pool",
                                                   AgentRun.started_at >= since)
                            .order_by(AgentRun.started_at.desc()).limit(1))
    if latest and latest.status == "FAILED" and AUTH_ERROR.search(latest.error or ""):
        return Quota(0.0, "需要登录或令牌：" + (latest.error or "")[:60], "login",
                     (latest.started_at + timedelta(hours=6)).isoformat(), exhausted=True)
    return None


def for_agent(session: "Session", name: str, cfg: dict, adapter_type: str) -> Quota:
    from pga.agents import links
    if adapter_type != "llm":
        blocked = needs_login(session, name, cleared=links.ok_at(name))
        if blocked:
            return blocked
    q = cfg.get("quota") or {}
    src = q.get("source") or ("observed" if adapter_type != "llm" else "none")
    if src == "deepseek_balance":
        return deepseek_balance(float(q.get("full", 50)))
    if src == "codex_sessions" and (cfg.get("env") or {}).get("CODEX_HOME"):   # another ChatGPT account: its own limits
        live = links.live_quota(name)
        if live:
            return Quota(live.get("remaining"), live.get("detail", ""), "codex_live", live.get("resets_at"), bool(live.get("exhausted")))
        return codex_sessions(Path(str(cfg["env"]["CODEX_HOME"])).expanduser() / "sessions")
    if src == "codex_sessions":
        live = links.live_quota(name) or links.shared_quota("codex_live")      # read from the app server, if fresh
        if live:
            return Quota(live.get("remaining"), live.get("detail", ""), "codex_live", live.get("resets_at"), bool(live.get("exhausted")))
        return codex_sessions()
    if src == "observed":
        return observed(session, name, float(q.get("window_hours", 5)), int(q.get("window_runs", 40)))
    return Quota(None, "", src)
