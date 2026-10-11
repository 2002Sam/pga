"""Background side of the Agent Hub: keep local agents (Claude Code, Hermes) in sync on a schedule."""

from __future__ import annotations

from datetime import datetime, timedelta
from typing import TYPE_CHECKING

from sqlalchemy import select

from pga.db.models import Job, LinkedAgent, User
from pga.workflow.scheduler import register_planner
from pga.workflow.worker import _user, handler

if TYPE_CHECKING:
    from pga.runtime import Runtime


@register_planner
def plan_hub_sync(rt: "Runtime", user: User, now: datetime) -> list[dict]:
    every = timedelta(hours=rt.policy.workflow.hub_sync_hours)
    oldest = rt.session.scalar(select(LinkedAgent.last_synced_at).where(
        LinkedAgent.user_id == user.id, LinkedAgent.connector.in_(["claude_code", "hermes"]))
        .order_by(LinkedAgent.last_synced_at.asc().nulls_first()).limit(1))
    has_local = rt.session.scalar(select(LinkedAgent.id).where(
        LinkedAgent.user_id == user.id, LinkedAgent.connector.in_(["claude_code", "hermes"])).limit(1))
    if has_local is None or (oldest is not None and now - oldest < every):
        return []
    return [{"kind": "hub.sync", "key": f"hub:{user.id}", "priority": 160}]


@handler("hub.sync")
def _hub_sync(rt: "Runtime", job: Job, now: datetime) -> dict:
    return rt.hub.background_sync(_user(rt, job), now)
