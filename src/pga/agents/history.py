"""Past conversations with an agent (or a kind of work), rebuilt from the ledger.

Every chat question is one parent AgentRun (workflow `ask`): the question is its prompt, the answer its output, and
`data.conversation` the card's conversation id (`agent:<name>:<id>` or `cat:<kind>:<id>`). Asks from before
conversation ids existed count as one-question conversations (`run:<uuid>`). Nothing here calls a model.
"""

from __future__ import annotations

import uuid
from typing import TYPE_CHECKING

from sqlalchemy import select

from pga.db.models import AgentRun

if TYPE_CHECKING:
    from sqlalchemy.orm import Session

SCAN = 600                       # how many recent questions are looked through


def _asks(session: "Session", user_id: uuid.UUID, limit: int = SCAN) -> list[AgentRun]:
    return list(session.scalars(select(AgentRun).where(AgentRun.user_id == user_id, AgentRun.parent_id.is_(None),
                                                       AgentRun.workflow == "ask")
                                .order_by(AgentRun.started_at.desc()).limit(limit)))


def _conv(r: AgentRun) -> str:
    return str((r.data or {}).get("conversation") or f"run:{r.id}")


def _belongs(r: AgentRun, card: str) -> bool:
    """Is this question part of the card's history? `card` is `agent:<name>` or `cat:<kind>`."""
    conv = (r.data or {}).get("conversation")
    if conv and not str(conv).startswith("run:"):                       # (a question that continued an old one keeps its run: id)
        return str(conv).startswith(card + ":")
    kind, _, key = card.partition(":")
    d = r.data or {}
    named = str(d.get("why") or "").startswith("你指定了")
    return (d.get("agent") == key and named) if kind == "agent" else (d.get("category") == key and not named)


def conversations(session: "Session", user_id: uuid.UUID, card: str, limit: int = 40) -> list[dict]:
    groups: dict[str, list[AgentRun]] = {}
    for r in _asks(session, user_id):
        if _belongs(r, card):
            groups.setdefault(_conv(r), []).append(r)
    out = []
    for conv, runs in groups.items():
        runs.sort(key=lambda x: x.started_at)
        first, last = runs[0], runs[-1]
        out.append({"id": conv, "title": " ".join(first.prompt.split())[:80], "turns": len(runs),
                    "started_at": first.started_at.isoformat(), "updated_at": (last.finished_at or last.started_at).isoformat(),
                    "agents": sorted({(r.data or {}).get("agent") for r in runs if (r.data or {}).get("agent")}),
                    "last": " ".join((last.output or last.error or "").split())[:120], "ok": last.status == "SUCCEEDED"})
    out.sort(key=lambda c: c["updated_at"], reverse=True)
    return out[:limit]


def messages(session: "Session", user_id: uuid.UUID, conversation: str) -> list[dict]:
    """The conversation as the talk shows it: your words, then each answer (or why there was none)."""
    if conversation.startswith("run:"):
        try:
            r = session.get(AgentRun, uuid.UUID(conversation[4:]))
        except ValueError:
            return []
        runs = [r] if r is not None and r.user_id == user_id else []
    else:
        runs = [r for r in _asks(session, user_id) if (r.data or {}).get("conversation") == conversation]
        runs.sort(key=lambda x: x.started_at)
    out: list[dict] = []
    for r in runs:
        d = r.data or {}
        out.append({"role": "user", "text": r.prompt, "at": r.started_at.isoformat(), "images": d.get("images") or 0})
        out.append({"role": "agent", "agent": d.get("agent") or (d.get("tried") or ["—"])[-1], "text": r.output or "",
                    "model": d.get("model"), "effort": d.get("effort"),
                    "ok": r.status == "SUCCEEDED", "error": r.error, "duration_s": r.duration_s, "files": d.get("files") or [],
                    "category": d.get("category"), "at": (r.finished_at or r.started_at).isoformat()})
    return out
