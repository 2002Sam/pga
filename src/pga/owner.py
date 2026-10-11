"""The installation's owner: the account that system-level work (R0, recovery notices) belongs to.

PGA runs one codebase for everyone on this machine, so self-improvement is one loop, not one per account. The
owner is `PGA_OWNER_USER_ID` if set, else the account marked `preferences.owner` (the web app claims it the first
time it opens, unless that account is a demo)."""

from __future__ import annotations

import uuid

from sqlalchemy import select
from sqlalchemy.orm import Session

from pga.config import get_settings
from pga.db.models import User


def owner_id(session: Session) -> uuid.UUID | None:
    s = get_settings()
    if s.owner_user_id:
        try:
            return uuid.UUID(s.owner_user_id)
        except ValueError:
            pass
    for u in session.scalars(select(User).order_by(User.created_at)):
        if (u.preferences or {}).get("owner"):
            return u.id
    return None


def claim(session: Session, user: User, *, force: bool = False) -> bool:
    """Make `user` the owner. Without `force`, only when there is none yet; demo accounts never claim."""
    prefs = user.preferences or {}
    if prefs.get("demo") and not force:
        return False
    current = owner_id(session)
    if current is not None and not force:
        return current == user.id
    for u in session.scalars(select(User)):
        p = dict(u.preferences or {})
        if p.pop("owner", None) and u.id != user.id:
            u.preferences = p
    user.preferences = {**prefs, "owner": True}
    session.flush()
    return True
