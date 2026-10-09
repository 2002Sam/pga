"""Permission levels (spec §19). Only the user can change their permission policy (invariant 11)."""

from __future__ import annotations

import uuid
from typing import Literal

from sqlalchemy.orm import Session

from pga import audit
from pga.config import Policy
from pga.db.models import PermissionPolicy, User
from pga.db.types import Origin, PermissionLevel

Verdict = Literal["auto", "approval", "deny"]


class PermissionChangeDenied(PermissionError):
    pass


def create_default_policy(session: Session, policy: Policy) -> PermissionPolicy:
    pp = PermissionPolicy(rules=dict(policy.permissions))
    session.add(pp)
    session.flush()
    return pp


def check(session: Session, user: User, level: PermissionLevel, *, actor: Origin, action: str,
          entity_id: uuid.UUID | None = None) -> Verdict:
    rules = user.permission_policy.rules
    verdict: Verdict = rules.get(level.value, "approval")
    if actor == Origin.EXTERNAL and verdict == "auto" and level not in {PermissionLevel.READ}:
        verdict = "approval"  # external content never auto-authorizes anything beyond reading
    audit.record(session, kind="permission.check", entity_type="permission", entity_id=entity_id,
                 actor=actor, user_id=user.id, level=level.value, action=action, verdict=verdict)
    return verdict


def update_rules(session: Session, user: User, changes: dict[str, Verdict], *, actor: Origin) -> PermissionPolicy:
    if actor != Origin.USER:
        raise PermissionChangeDenied("only the user can change permissions")
    bad = set(changes) - {lv.value for lv in PermissionLevel}
    if bad:
        raise ValueError(f"unknown permission levels {sorted(bad)}")
    pp = user.permission_policy
    before = dict(pp.rules)
    pp.rules = {**pp.rules, **changes}
    pp.version += 1
    audit.record(session, kind="permission.policy_changed", entity_type="permission_policy",
                 entity_id=pp.id, actor=actor, user_id=user.id, before=before, after=pp.rules)
    session.flush()
    return pp
