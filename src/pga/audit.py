"""Structured, append-only audit log (spec §20, §21)."""

from __future__ import annotations

import json
import logging
import uuid
from typing import Any

from sqlalchemy.orm import Session

from pga.db.models import AuditLog
from pga.db.types import Origin

log = logging.getLogger("pga.audit")


def _jsonable(value: Any) -> Any:
    return json.loads(json.dumps(value, default=str))


def record(
    session: Session,
    *,
    kind: str,
    entity_type: str,
    entity_id: uuid.UUID | None,
    actor: Origin,
    user_id: uuid.UUID | None = None,
    **payload: Any,
) -> AuditLog:
    entry = AuditLog(kind=kind, entity_type=entity_type, entity_id=entity_id, actor=actor,
                     user_id=user_id, payload=_jsonable(payload))
    session.add(entry)
    log.info("%s %s:%s actor=%s %s", kind, entity_type, entity_id, actor.value, entry.payload)
    return entry
