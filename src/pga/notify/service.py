"""Proactive communication (spec §16).

The agent picks one of: silent update, notification, brief, question, meeting
invitation. Anything louder than SILENT needs one of the five allowed reasons,
and is then rate-limited, deduplicated and held during quiet hours. Suppressed
messages are still stored, so "why didn't you tell me?" has an answer — but
nothing here optimizes for message count (invariant 6).
"""

from __future__ import annotations

import logging
import uuid
from collections.abc import Callable
from dataclasses import dataclass
from datetime import datetime, timedelta
from zoneinfo import ZoneInfo, ZoneInfoNotFoundError

from sqlalchemy import func, select
from sqlalchemy.orm import Session

from pga import audit
from pga.config import Policy
from pga.db.models import Decision, Notification, Responsibility, User
from pga.db.types import (
    CommKind, DecidedBy, NotificationStatus as N, NotifyReason, Origin, ResponsibilityStatus as S, utcnow,
)
from pga.translation import TranslationGateway

log = logging.getLogger("pga.notify")

LOUD = {CommKind.NOTIFICATION, CommKind.BRIEF, CommKind.QUESTION, CommKind.MEETING}
ASKS_USER = {CommKind.QUESTION, CommKind.MEETING}

# A channel delivers one notification to somewhere outside the database (phone push, webhook).
Channel = Callable[[User, Notification], None]


class NotifyError(ValueError):
    pass


@dataclass
class Proposal:
    kind: CommKind
    reasons: list[NotifyReason]
    title_en: str
    body_en: str = ""
    options: list[str] | None = None
    responsibility_id: uuid.UUID | None = None
    run_id: uuid.UUID | None = None
    artifact_id: uuid.UUID | None = None
    dedupe_key: str | None = None


class NotificationService:
    def __init__(self, session: Session, policy: Policy, gateway: TranslationGateway,
                 channels: dict[str, Channel] | None = None):
        self.session = session
        self.policy = policy
        self.np = policy.notify
        self.gateway = gateway
        self.channels = channels or {}

    # ---------------------------------------------------------------- decide

    def propose(self, user: User, p: Proposal, now: datetime | None = None) -> Notification:
        now = now or utcnow()
        if p.kind in LOUD and not p.reasons:
            p.kind = CommKind.SILENT  # no allowed reason → it stays a silent update
        if p.kind == CommKind.QUESTION and not (set(p.reasons) & {NotifyReason.DECISION_REQUIRED,
                                                                   NotifyReason.UNCERTAINTY}):
            p.reasons = [*p.reasons, NotifyReason.DECISION_REQUIRED]
        n = Notification(user_id=user.id, responsibility_id=p.responsibility_id, run_id=p.run_id,
                         artifact_id=p.artifact_id, kind=p.kind, reasons=[r.value for r in p.reasons],
                         title_en=p.title_en[:500], body_en=p.body_en[:8000], options=list(p.options or []),
                         dedupe_key=p.dedupe_key, status=N.PENDING, channels=[], created_at=now)
        why_not = self._suppress_reason(user, p, now)
        if why_not:
            n.status = N.SUPPRESSED
            n.suppressed_reason = why_not
        else:
            n.deliver_after = self._after_quiet_hours(user, now)
        self.session.add(n)
        self.session.flush()
        audit.record(self.session, kind="notify.proposed", entity_type="notification", entity_id=n.id,
                     actor=Origin.AGENT, user_id=user.id, comm_kind=n.kind.value, reasons=n.reasons,
                     status=n.status.value, suppressed_reason=n.suppressed_reason)
        if n.status == N.PENDING and (n.deliver_after is None or n.deliver_after <= now):
            self.deliver(user, n, now)
        return n

    def _suppress_reason(self, user: User, p: Proposal, now: datetime) -> str | None:
        if p.kind == CommKind.SILENT:
            return "silent update"
        day_ago = now - timedelta(hours=24)
        sent = self._count(user.id, since=day_ago)
        if sent >= self.np.hard_max_per_day:
            return f"hard daily limit of {self.np.hard_max_per_day} reached"
        urgent = bool({r.value for r in p.reasons} & set(self.np.urgent_reasons))
        if not urgent and sent >= self.np.max_per_day:
            return f"daily limit of {self.np.max_per_day} non-urgent messages reached"
        if p.dedupe_key:
            dup = self.session.scalar(select(func.count()).select_from(Notification).where(
                Notification.user_id == user.id, Notification.dedupe_key == p.dedupe_key,
                Notification.status != N.SUPPRESSED,
                Notification.created_at >= now - timedelta(hours=self.np.dedupe_hours)))
            if dup:
                return "already told the user about this"
        if p.responsibility_id and not urgent:
            recent = self.session.scalar(select(func.count()).select_from(Notification).where(
                Notification.responsibility_id == p.responsibility_id,
                Notification.status.notin_([N.SUPPRESSED]),
                Notification.created_at >= now - timedelta(hours=self.np.min_hours_between_per_responsibility)))
            if recent:
                return "spoke about this responsibility recently"
        return None

    def _count(self, user_id: uuid.UUID, since: datetime) -> int:
        return self.session.scalar(select(func.count()).select_from(Notification).where(
            Notification.user_id == user_id, Notification.created_at >= since,
            Notification.status.notin_([N.SUPPRESSED]))) or 0

    def _after_quiet_hours(self, user: User, now: datetime) -> datetime | None:
        qh = (user.preferences or {}).get("notify", {}).get("quiet_hours") or self.np.quiet_hours
        if not qh:
            return None
        try:
            tz = ZoneInfo(user.timezone or "UTC")
        except ZoneInfoNotFoundError:
            tz = ZoneInfo("UTC")
        local = now.astimezone(tz)
        start, end = int(qh.get("start", 23)), int(qh.get("end", 8))
        h = local.hour
        quiet = (start <= h or h < end) if start > end else (start <= h < end)
        if not quiet:
            return None
        wake = local.replace(hour=end, minute=0, second=0, microsecond=0)
        if wake <= local:
            wake += timedelta(days=1)
        return wake.astimezone(now.tzinfo)

    # ---------------------------------------------------------------- deliver

    def deliver(self, user: User, n: Notification, now: datetime | None = None) -> Notification:
        now = now or utcnow()
        lang = (user.preferences or {}).get("output_language") or user.locale
        if lang == "mirror_input":
            lang = user.locale
        title = self.gateway.render(n.title_en, lang, user.id)
        body = self.gateway.render(n.body_en, lang, user.id) if n.body_en else None
        n.display_title, n.display_body = title.text, (body.text if body else "")
        n.display_language = title.language
        delivered = ["in_app"]
        wanted = (user.preferences or {}).get("notify", {}).get("channels") or self.np.default_channels
        for name in wanted:
            ch = self.channels.get(name)
            if ch is None or name == "in_app":
                continue
            try:
                ch(user, n)
                delivered.append(name)
            except Exception as exc:  # a broken phone hook must not lose the in-app copy
                log.warning("channel %s failed: %s", name, exc)
        n.channels = delivered
        n.status = N.DELIVERED
        n.delivered_at = now
        self.session.flush()
        return n

    def deliver_due(self, user: User, now: datetime | None = None) -> int:
        now = now or utcnow()
        due = list(self.session.scalars(select(Notification).where(
            Notification.user_id == user.id, Notification.status == N.PENDING,
            (Notification.deliver_after.is_(None)) | (Notification.deliver_after <= now))))
        for n in due:
            self.deliver(user, n, now)
        return len(due)

    # ---------------------------------------------------------------- user side

    def list(self, user_id: uuid.UUID, include_suppressed: bool = False, limit: int = 50) -> list[Notification]:
        q = select(Notification).where(Notification.user_id == user_id)
        if not include_suppressed:
            q = q.where(Notification.status != N.SUPPRESSED)
        return list(self.session.scalars(q.order_by(Notification.created_at.desc()).limit(limit)))

    def mark_read(self, n: Notification, now: datetime | None = None) -> Notification:
        if n.status == N.DELIVERED:
            n.status = N.READ
            n.read_at = now or utcnow()
        self.session.flush()
        return n

    def dismiss(self, n: Notification, now: datetime | None = None) -> Notification:
        n.status = N.DISMISSED
        n.read_at = n.read_at or (now or utcnow())
        audit.record(self.session, kind="notify.dismissed", entity_type="notification", entity_id=n.id,
                     actor=Origin.USER, user_id=n.user_id, comm_kind=n.kind.value)  # feeds "false notification" metric
        self.session.flush()
        return n

    def answer(self, user: User, n: Notification, text: str, now: datetime | None = None) -> Decision:
        """The user's answer to a question / meeting invite becomes a recorded Decision."""
        now = now or utcnow()
        if n.kind not in ASKS_USER:
            raise NotifyError("only questions and meeting invitations take an answer")
        en, _lang, _st, _ = self.gateway.to_canonical(text, user.id)
        n.answer_text, n.answer_en = text, en
        n.status = N.ANSWERED
        n.answered_at = now
        d = Decision(user_id=user.id, responsibility_id=n.responsibility_id, decided_by=DecidedBy.USER,
                     decision_en=f"Q: {n.title_en}\nA: {en}", rationale_en=None, created_at=now)
        self.session.add(d)
        self.session.flush()
        audit.record(self.session, kind="notify.answered", entity_type="notification", entity_id=n.id,
                     actor=Origin.USER, user_id=user.id, decision_id=str(d.id))
        return d

    def open_questions(self, responsibility_id: uuid.UUID) -> list[Notification]:
        return list(self.session.scalars(select(Notification).where(
            Notification.responsibility_id == responsibility_id, Notification.kind.in_(ASKS_USER),
            Notification.status.in_([N.PENDING, N.DELIVERED, N.READ]))))


# ---------------------------------------------------------------- channels


def ntfy_channel(post: Callable[..., object] | None = None, base_url: str = "https://ntfy.sh") -> Channel:
    """Push to the user's phone via ntfy (topic set in preferences.notify.ntfy_topic)."""
    def send(user: User, n: Notification) -> None:
        topic = (user.preferences or {}).get("notify", {}).get("ntfy_topic")
        if not topic:
            raise NotifyError("no ntfy_topic configured")
        poster = post or _httpx_post
        poster(f"{base_url.rstrip('/')}/{topic}", content=(n.display_body or n.display_title or "").encode(),
               headers={"Title": (n.display_title or n.title_en).encode("utf-8").decode("latin-1", "ignore")[:200],
                        "Tags": n.kind.value.lower()})
    return send


def webhook_channel(post: Callable[..., object] | None = None) -> Channel:
    """POST a JSON copy to the user's own webhook (preferences.notify.webhook_url)."""
    def send(user: User, n: Notification) -> None:
        url = (user.preferences or {}).get("notify", {}).get("webhook_url")
        if not url:
            raise NotifyError("no webhook_url configured")
        poster = post or _httpx_post
        poster(url, json={"id": str(n.id), "kind": n.kind.value, "reasons": n.reasons, "title": n.display_title,
                          "body": n.display_body, "options": n.options,
                          "responsibility_id": str(n.responsibility_id) if n.responsibility_id else None})
    return send


def _httpx_post(url: str, **kw) -> None:
    import httpx

    r = httpx.post(url, timeout=15, **kw)
    r.raise_for_status()


def macos_channel(run: Callable[..., object] | None = None) -> Channel:
    """A native macOS notification (Notification Center). Works because the server runs on the user's Mac."""
    def send(user: User, n: Notification) -> None:
        import json
        import subprocess
        import sys

        if sys.platform != "darwin" and run is None:
            raise NotifyError("macOS notifications need the server to run on a Mac")
        title = (n.display_title or n.title_en or "")[:150]
        body = (n.display_body if n.display_body is not None else n.body_en or "")[:300]
        q = lambda s: json.dumps(s, ensure_ascii=False)  # AppleScript string literal: "…" with \" and \\ escapes
        script = f'display notification {q(body or title)} with title "PGA 助理" subtitle {q(title)} sound name "Glass"'
        (run or subprocess.run)(["osascript", "-e", script], check=True, timeout=10, capture_output=True)
    return send


def default_channels() -> dict[str, Channel]:
    return {"ntfy": ntfy_channel(), "webhook": webhook_channel(), "macos": macos_channel()}


def resume_after_answer(session: Session, n: Notification) -> Responsibility | None:
    """Helper for callers: an answered question lets a WAIT_USER responsibility continue."""
    if not n.responsibility_id:
        return None
    r = session.get(Responsibility, n.responsibility_id)
    return r if r is not None and r.status == S.WAIT_USER else None
