"""Bodies on an ambition's map, and the bridges the user draws between them.

Each long-range aim (an ambition) is a solar system. Besides the responsibility agents, it holds
databases (stores of knowledge) and skills. The user can drag one body onto another — usually across
orbits — to say "this knowledge may help that"; the bridge then reaches the model as context for the
agents on either end. Private bodies are drawn on the map but never sent to a model.

`expand` asks the model which databases and skills an ambition will need and adds them as bodies.
"""

from __future__ import annotations

import uuid
from datetime import datetime

from sqlalchemy import or_, select
from sqlalchemy.orm import Session

from pga.agent.common import UNTRUSTED_NOTE, ModelOutputError, parse_json
from pga.allocator import Estimates, Justification, RunRequest
from pga.db.models import Aim, Body, Bridge, Responsibility, User
from pga.db.types import Origin, utcnow

KINDS = ("database", "skill")
# what a line between two objects means (an explicit relation, not just "these are near each other")
RELATIONS = ("relates", "references", "derived_from", "depends_on", "contradicts")

EXPAND_SYSTEM = f"""You help a person pursue a long-range ambition. Name the knowledge bases (databases) they should
build up and the skills they should develop to get there. Be concrete and specific to this ambition; short titles
(at most 6 words), one-sentence descriptions. {UNTRUSTED_NOTE}

Reply with JSON only:
{{"databases": [{{"title": "...", "description": "..."}}], "skills": [{{"title": "...", "description": "..."}}]}}"""


class BodyError(ValueError):
    pass


def ref_of(body: Body) -> str:
    return f"k:{body.id}"


class BodyService:
    def __init__(self, rt):
        self.rt = rt
        self.session: Session = rt.session

    # -------------------------------------------------------------- bodies

    def list(self, user_id: uuid.UUID) -> list[Body]:
        return list(self.session.scalars(select(Body).where(Body.user_id == user_id).order_by(Body.created_at)))

    def get(self, user_id: uuid.UUID, body_id: uuid.UUID) -> Body:
        b = self.session.get(Body, body_id)
        if b is None or b.user_id != user_id:
            raise BodyError("body not found for this user")
        return b

    def create(self, user: User, *, kind: str, title: str, title_en: str, description: str = "", description_en: str = "",
               aim_id: uuid.UUID | None = None, private: bool = False, origin: Origin = Origin.USER) -> Body:
        if kind not in KINDS:
            raise BodyError(f"kind must be one of {KINDS}")
        if not title.strip():
            raise BodyError("a body needs a title")
        if aim_id is not None:
            aim = self.session.get(Aim, aim_id)
            if aim is None or aim.user_id != user.id:
                raise BodyError("aim not found for this user")
        b = Body(user_id=user.id, aim_id=aim_id, kind=kind, title=title.strip()[:300], title_en=(title_en or title).strip()[:300],
                 description=description.strip()[:8000], description_en=(description_en or description).strip()[:8000],
                 private=private, origin=origin)
        self.session.add(b)
        self.session.flush()
        return b

    def delete(self, b: Body) -> None:
        ref = ref_of(b)
        for br in self.session.scalars(select(Bridge).where(Bridge.user_id == b.user_id, or_(Bridge.a_ref == ref, Bridge.b_ref == ref))):
            self.session.delete(br)
        self.session.delete(b)
        self.rt.layers.forget(ref)
        self.session.flush()

    # -------------------------------------------------------------- bridges

    def _exists(self, user_id: uuid.UUID, ref: str) -> bool:
        try:
            if ref.startswith("k:"):
                b = self.session.get(Body, uuid.UUID(ref[2:]))
                return b is not None and b.user_id == user_id
            if ref.startswith("aim:"):
                a = self.session.get(Aim, uuid.UUID(ref[4:]))
                return a is not None and a.user_id == user_id
            if ref.startswith("fd:"):                           # a project folder (shared across this Mac's accounts)
                from pga.projects import ProjectError, Projects
                try:
                    Projects(self.session).get(user_id, uuid.UUID(ref[3:]))
                    return True
                except ProjectError:
                    return False
            r = self.session.get(Responsibility, uuid.UUID(ref))
            return r is not None and r.user_id == user_id
        except ValueError:
            return False

    def bridges(self, user_id: uuid.UUID) -> list[Bridge]:
        return list(self.session.scalars(select(Bridge).where(Bridge.user_id == user_id).order_by(Bridge.created_at)))

    def bridge(self, user_id: uuid.UUID, a: str, b: str, note: str = "", kind: str = "relates") -> Bridge:
        if a == b:
            raise BodyError("a body cannot be linked to itself")
        if kind not in RELATIONS:
            raise BodyError(f"a link is one of {', '.join(RELATIONS)}")
        for ref in (a, b):
            if not self._exists(user_id, ref):
                raise BodyError(f"unknown body {ref!r}")
        a, b = sorted((a, b))
        found = self.session.scalar(select(Bridge).where(Bridge.user_id == user_id, Bridge.a_ref == a, Bridge.b_ref == b))
        if found:
            found.kind = kind
            return found
        br = Bridge(user_id=user_id, a_ref=a, b_ref=b, note=note[:500], kind=kind)
        self.session.add(br)
        self.session.flush()
        return br

    # -------------------------------------------------------------- what the model may see

    def _kind(self, ref: str) -> str | None:
        """What a ref is, for the model — or None if it is private or gone (never sent to a model)."""
        try:
            if ref.startswith("k:"):
                b = self.session.get(Body, uuid.UUID(ref[2:]))
                return None if b is None or b.private else b.kind
            if ref.startswith("aim:"):
                return "ambition" if self.session.get(Aim, uuid.UUID(ref[4:])) else None
            return "agent" if self.session.get(Responsibility, uuid.UUID(ref)) else None
        except ValueError:
            return None

    def context_for(self, r: Responsibility) -> str:
        """Bodies the user bridged to this agent (directly), links to its ambition, and the non-private bodies of
        its own ambition — each read at the pyramid level the chat needs, stepped down to fit the budget."""
        ref = str(r.id)
        items: list[tuple[str, str, int, float, str]] = []          # (ref, prefix, level, importance, note)
        layers = self.rt.layers
        for br in self.session.scalars(select(Bridge).where(Bridge.user_id == r.user_id, or_(Bridge.a_ref == ref, Bridge.b_ref == ref))):
            other = br.b_ref if br.a_ref == ref else br.a_ref
            items.append((other, "bridged by the user", layers.need("chat.linked"), 3.0, br.note))
        if r.aim_id:
            aim_ref = f"aim:{r.aim_id}"                              # links the user drew to this agent's ambition
            for br in self.session.scalars(select(Bridge).where(Bridge.user_id == r.user_id, or_(Bridge.a_ref == aim_ref, Bridge.b_ref == aim_ref))):
                items.append((br.b_ref if br.a_ref == aim_ref else br.a_ref, "linked to this agent's ambition",
                              layers.need("chat.linked"), 2.0, br.note))
            for b in self.session.scalars(select(Body).where(Body.aim_id == r.aim_id, Body.private.is_(False)).limit(16)):
                items.append((f"k:{b.id}", "in the same ambition", layers.need("chat.same_aim", 1), 1.0, ""))
        seen, kept = set(), []
        for it in items:
            kind = self._kind(it[0])
            if kind and it[0] not in seen and it[0] != ref:
                seen.add(it[0])
                kept.append((it, kind))
        if not kept:
            return ""
        picked = {x: text for x, _lv, text in layers.select([(it[0], it[2], it[3]) for it, _ in kept],
                                                             layers.lp.budgets.get("chat.linked", 500))}
        lines = []
        for (other, prefix, _lv, _w, note), kind in kept:
            if other in picked:
                text = picked[other].replace("\n", "\n  ")
                lines.append(f"- {prefix}: {kind}: {text}" + (f" (note: {note})" if note else ""))
        return "\n".join(lines)

    # -------------------------------------------------------------- auto-expansion

    def expand(self, user: User, aim: Aim, *, per_kind: int = 5, now: datetime | None = None) -> list[Body]:
        now = now or utcnow()
        existing = [b.title_en for b in self.session.scalars(select(Body).where(Body.aim_id == aim.id))]
        agents = [r.title_en for r in self.session.scalars(select(Responsibility).where(Responsibility.aim_id == aim.id))]
        prompt = (f"Ambition: {self.rt.layers.text(f'aim:{aim.id}', self.rt.layers.need('expand.aim', 3))}\n"
                  + (f"Agents already working on it: {', '.join(agents)}\n" if agents else "")
                  + (f"Already on the map (do not repeat): {', '.join(existing)}\n" if existing else "")
                  + f"Give {per_kind} databases and {per_kind} skills.")
        decision = self.rt.allocator.allocate(RunRequest(
            user_id=user.id, kind="aim_expand",
            justification=Justification(why_now="the user asked to fill in an ambition's map", expected_gain="relevant knowledge bases and skills",
                                        decision_affected="what the user builds and learns toward this ambition",
                                        budget={"max_output_tokens": 1200}, stop_condition="bodies created"),
            estimates=Estimates(information_gain=0.6, decision_impact=0.5, user_relevance=1.0, urgency=0.6,
                                input_tokens=len(prompt) // 3 + 300, output_tokens=600)), now=now)
        if not decision.allowed:
            raise BodyError("; ".join(decision.reasons) or "no budget for this right now")
        with self.rt.runs.track(decision, now) as guard:
            result = self.rt.router.complete(decision.tier, system=EXPAND_SYSTEM, messages=[{"role": "user", "content": prompt}],
                                             max_tokens=1200, usage=guard.usage_context())
            try:
                data = parse_json(result.text)
            except ModelOutputError:
                guard.stop("model reply was not valid JSON")
                raise BodyError("the model's reply could not be read; try again")
            guard.stop("bodies created")
        items: list[tuple[str, str, str]] = []
        seen = {t.lower() for t in existing}
        for kind, key in (("database", "databases"), ("skill", "skills")):
            for it in (data.get(key) or [])[:per_kind + 2] if isinstance(data, dict) else []:
                t = str((it or {}).get("title") or "").strip()[:120] if isinstance(it, dict) else ""
                if t and t.lower() not in seen:
                    seen.add(t.lower())
                    items.append((kind, t, str(it.get("description") or "").strip()[:400]))
        if not items:
            raise BodyError("the model did not suggest anything new")
        shown = self.rt.hub._render(user.id, {"items": [[t, d] for _, t, d in items]})["items"]
        out = []
        for (kind, t, d), pair in zip(items, shown):
            title = (pair[0] if isinstance(pair, list) and pair and pair[0] else t)
            desc = (pair[1] if isinstance(pair, list) and len(pair) > 1 and pair[1] else d)
            out.append(self.create(user, kind=kind, title=title, title_en=t, description=desc, description_en=d,
                                   aim_id=aim.id, origin=Origin.AGENT))
        return out
