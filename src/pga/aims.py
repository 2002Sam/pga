"""Long-range aims: the motivations everything else serves. Each aim is one solar system in the UI;
responsibilities point at the aim they serve. Only the user creates or changes aims."""

from __future__ import annotations

import uuid

from sqlalchemy import delete, func, select
from sqlalchemy.orm import Session

from pga.db.models import Aim, Layer, Responsibility, User


class AimError(ValueError):
    pass


class AimService:
    def __init__(self, session: Session):
        self.session = session

    def list(self, user: User) -> list[Aim]:
        rows = list(self.session.scalars(select(Aim).where(Aim.user_id == user.id).order_by(Aim.position, Aim.created_at)))
        prefs = user.preferences or {}
        if not rows and prefs.get("aim"):                       # adopt the single aim kept in preferences before aims existed
            rows = [self.create(user, prefs["aim"], prefs.get("aim_en") or prefs["aim"])]
            user.preferences = {k: v for k, v in prefs.items() if k not in ("aim", "aim_en")}
            self.session.flush()
        return rows

    def primary(self, user: User) -> Aim | None:
        rows = self.list(user)
        return rows[0] if rows else None

    def get(self, user_id: uuid.UUID, aim_id: uuid.UUID) -> Aim:
        a = self.session.get(Aim, aim_id)
        if a is None or a.user_id != user_id:
            raise AimError("aim not found for this user")
        return a

    def create(self, user: User, text: str, text_en: str) -> Aim:
        text = text.strip()
        if not text:
            raise AimError("an aim needs some text")
        pos = self.session.scalar(select(func.coalesce(func.max(Aim.position), -1)).where(Aim.user_id == user.id)) + 1
        a = Aim(user_id=user.id, text=text, text_en=text_en.strip() or text, position=pos)
        self.session.add(a)
        self.session.flush()
        return a

    def update(self, a: Aim, text: str, text_en: str) -> Aim:
        if not text.strip():
            raise AimError("an aim needs some text")
        a.text, a.text_en = text.strip(), text_en.strip() or text.strip()
        self.session.flush()
        return a

    def delete(self, a: Aim) -> None:
        for r in self.session.scalars(select(Responsibility).where(Responsibility.aim_id == a.id)):
            r.aim_id = None
        self.session.execute(delete(Layer).where(Layer.ref == f"aim:{a.id}"))
        self.session.delete(a)
        self.session.flush()

    def context_block(self, user: User, focus: Responsibility | None = None, *, layers=None, purpose: str = "chat") -> str:
        """English context for the model: every aim, and which one the focused agent serves.

        With `layers` (pga.layers), each aim is read at the level the process needs — the aim the focused agent
        serves at `<purpose>.focus_aim`, the others at `<purpose>.aims` — stepping down to fit `<purpose>.aims` words."""
        rows = self.list(user)
        if not rows:
            return ""
        served = next((i for i, a in enumerate(rows) if focus is not None and a.id == focus.aim_id), None)
        if layers is None:
            lines = [f"{i + 1}. {a.text_en}" for i, a in enumerate(rows)]
        else:
            wanted = [(f"aim:{a.id}", layers.need(f"{purpose}.focus_aim" if i == served else f"{purpose}.aims"),
                       2.0 if i == served else 1.0 / (i + 1)) for i, a in enumerate(rows)]
            index = {f"aim:{a.id}": i for i, a in enumerate(rows)}
            picked = layers.select(wanted, layers.lp.budgets.get(f"{purpose}.aims", 700))
            lines = [f"{index[ref] + 1}. " + text.replace("\n", "\n   ") for ref, _lv, text in picked]
        from pga.teams import corrections_block
        for i, a in enumerate(rows):                     # the user's later corrections count for every reader
            extra = corrections_block(self.session, a.id)
            if extra:
                lines.append(f"   (aim {i + 1}) {extra}")
        if served is not None:
            lines.append(f"The agent you are speaking as serves aim {served + 1}.")
        return "\n".join(lines)
