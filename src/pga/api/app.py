"""HTTP API (services/api in the spec's layout).

Phase 1 has no authentication: run it single-tenant on a trusted network.
Every endpoint here acts as the USER, except /events, which ingests external
content (Origin.EXTERNAL) that can raise tension but never change goals.
"""

from __future__ import annotations

import logging
import math
import os
import threading
import uuid
from datetime import datetime, timedelta, timezone
from pathlib import Path
from collections.abc import Callable, Iterator
from contextlib import asynccontextmanager
from typing import Any

from fastapi import Depends, FastAPI, HTTPException, Query, Request
from fastapi.responses import FileResponse, JSONResponse, Response
from sqlalchemy import func, select
from sqlalchemy.orm import Session, sessionmaker
from sqlalchemy.orm.exc import StaleDataError

from pga import permissions
from pga.aims import AimError, AimService
from pga.bodies import BodyError, BodyService
from pga.evolution import EvolutionError, EvolutionService, r0_state, r0_tick
from pga.evolution.telemetry import SIGNALS
from pga.allocator import AllocationError, RunRequest
from pga.api import schemas as sc
from pga.chat import chat_turn
from pga.config import get_policy, get_settings
from pga.db.models import (Belief, Evidence, LinkedAgent, Job, Message, Notification, Responsibility, Run, Source,
                           TensionChange, UsageRecord, User)
from pga.db.session import get_sessionmaker
from pga.db.types import (PERPETUAL_STATUSES, TERMINAL_STATUSES, CommKind, FactType, JobStatus, NotificationStatus,
                          Origin, ResponsibilityStatus, RunStatus, SourceKind, utcnow)
from pga.llm import UsageContext, catalog
from pga.responsibility import (
    LimitExceeded, PermissionDenied, PromotionError, ResponsibilityError, TransitionError,
)
from pga.runtime import Runtime
from pga.notify import NotifyError
from pga.situation import SituationError
from pga.sources import SourceError
from pga.tension import IncomingEvidence, Signals
from pga.translation import GlossaryService
from pga.vault import VaultExportError, build_vault, export_vault, vault_zip
from pga.workflow import WorkflowError
from pga.workflow.scheduler import heartbeat

log = logging.getLogger("pga.api")

RuntimeFactory = Callable[[Session], Runtime]


def create_app(session_factory: sessionmaker[Session] | None = None,
               runtime_factory: RuntimeFactory | None = None) -> FastAPI:
    make_runtime = runtime_factory or (lambda s: Runtime(s))

    def factory() -> sessionmaker[Session]:
        return session_factory or get_sessionmaker()

    @asynccontextmanager
    async def lifespan(_: FastAPI):
        with factory()() as s:
            GlossaryService(s).seed()
            s.commit()
        yield

    app = FastAPI(title="Perpetual Generalist Agent", version="0.1.0", lifespan=lifespan,
                  description="Phase 1 core: translation gateway, responsibilities, tension, allocator, quota, audit.")

    def get_rt() -> Iterator[Runtime]:
        session = factory()()
        try:
            yield make_runtime(session)
            session.commit()
        except Exception:
            session.rollback()
            raise
        finally:
            session.close()

    # ---------------------------------------------------------------- errors

    def _err(status: int):
        async def handler(_: Request, exc: Exception) -> JSONResponse:
            body: dict[str, Any] = {"error": type(exc).__name__, "detail": str(exc)}
            if isinstance(exc, PromotionError):
                body["failures"] = exc.failures
            return JSONResponse(status_code=status, content=body)
        return handler

    for exc_type, status in [(PermissionDenied, 403), (permissions.PermissionChangeDenied, 403),
                             (PermissionError, 403), (TransitionError, 409), (PromotionError, 409),
                             (LimitExceeded, 409), (StaleDataError, 409), (SituationError, 422),
                             (AllocationError, 422), (ResponsibilityError, 422), (SourceError, 422),
                             (NotifyError, 422), (WorkflowError, 409), (VaultExportError, 422), (AimError, 422), (BodyError, 422), (EvolutionError, 409)]:
        app.add_exception_handler(exc_type, _err(status))

    def user_or_404(rt: Runtime, user_id: uuid.UUID) -> User:
        u = rt.session.get(User, user_id)
        if u is None:
            raise HTTPException(404, "user not found")
        return u

    def resp_or_404(rt: Runtime, rid: uuid.UUID) -> Responsibility:
        r = rt.session.get(Responsibility, rid)
        if r is None:
            raise HTTPException(404, "responsibility not found")
        return r

    def user_ctx(user: User) -> UsageContext:
        return UsageContext(category="user_reserve", proactive=False, user_id=user.id)

    def canonical(rt: Runtime, user: User, text: str) -> tuple[str, str | None]:
        """User-typed text → (canonical_en, raw_text-if-translated)."""
        if not text:
            return text, None
        with rt.billing(user_ctx(user)):
            en, _lang, _status, _ = rt.gateway.to_canonical(text, user.id)
        return en, (text if en != text else None)

    def relayer(rt: Runtime, user: User, ref: str) -> None:
        """An item changed: cut its pyramid by rule now (so every process has something), and queue the model build."""
        rt.layers.build(user, ref, use_model=False)
        rt.workflow.enqueue("layers.build", user_id=user.id, payload={"ref": ref}, dedupe_key=f"layers:{ref}",
                            created_by=Origin.USER, priority=60)

    # ---------------------------------------------------------------- web app

    @app.get("/", include_in_schema=False)
    def web_app() -> FileResponse:
        return FileResponse(Path(__file__).resolve().parent.parent / "web" / "index.html")

    # ---------------------------------------------------------------- health

    @app.get("/healthz")
    def healthz() -> dict:
        p = get_policy()
        out = {"ok": True, "llm_provider": p.llm.provider, **_system_brief()}
        if catalog.CONFIG.exists():                                  # Settings → 模型与 API
            m = catalog.load()
            pid = m["model"]["provider"]
            out.update(llm_provider=pid, llm_provider_name=m["providers"].get(pid, {}).get("name", pid))
        return out

    def _system_brief() -> dict:
        """The owner and the last recovery (shown once in the UI after PGA comes back)."""
        from pga import snapshot
        from pga.owner import owner_id
        with factory()() as s:
            own = owner_id(s)
            rec = snapshot.last(s, "recovered")
            r = (rec.data or {}).get("recovery") if rec else None
            return {"owner": str(own) if own else None,
                    "recovery": {"id": str(rec.id), "at": rec.at.isoformat(), "downtime_s": r.get("downtime_s"),
                                 "clean_stop": r.get("clean_stop"), "requeued": len(r.get("requeued_jobs") or []),
                                 "interrupted": (r.get("interrupted_runs") or 0) + (r.get("interrupted_agent_runs") or 0),
                                 "overdue": r.get("overdue_jobs")} if rec and r else None}

    # ---------------------------------------------------------------- users

    @app.post("/v1/users", response_model=sc.UserOut, status_code=201)
    def create_user(body: sc.UserCreate, rt: Runtime = Depends(get_rt)):
        pp = permissions.create_default_policy(rt.session, rt.policy)
        u = User(locale=body.locale, timezone=body.timezone, preferences=body.preferences,
                 model_language=rt.policy.locale.model_language, permission_policy_id=pp.id)
        rt.session.add(u)
        rt.session.flush()
        return u

    @app.get("/v1/users/{user_id}", response_model=sc.UserOut)
    def get_user(user_id: uuid.UUID, rt: Runtime = Depends(get_rt)):
        return user_or_404(rt, user_id)

    @app.patch("/v1/users/{user_id}/preferences", response_model=sc.UserOut)
    def patch_preferences(user_id: uuid.UUID, body: sc.PreferencesPatch, rt: Runtime = Depends(get_rt)):
        u = user_or_404(rt, user_id)
        u.preferences = {**(u.preferences or {}), **body.preferences}
        rt.session.flush()
        return u

    # ---------------------------------------------------------------- long-range aims (one solar system each)

    def aim_out(a) -> dict:
        return {"id": a.id, "text": a.text, "text_en": a.text_en, "position": a.position, "created_at": a.created_at}

    @app.get("/v1/users/{user_id}/aims")
    def list_aims(user_id: uuid.UUID, rt: Runtime = Depends(get_rt)):
        return [aim_out(a) for a in AimService(rt.session).list(user_or_404(rt, user_id))]

    @app.post("/v1/users/{user_id}/aims", status_code=201)
    def create_aim(user_id: uuid.UUID, body: sc.AimCreate, rt: Runtime = Depends(get_rt)):
        u = user_or_404(rt, user_id)
        aims = AimService(rt.session)
        aims.list(u)                                     # adopt a legacy single aim first, so positions stay in order
        a = aims.create(u, body.text, canonical(rt, u, body.text.strip())[0])
        relayer(rt, u, f"aim:{a.id}")
        return aim_out(a)

    @app.patch("/v1/aims/{aim_id}")
    def update_aim(aim_id: uuid.UUID, body: sc.AimCreate, rt: Runtime = Depends(get_rt)):
        from pga.db.models import Aim
        a = rt.session.get(Aim, aim_id)
        if a is None:
            raise HTTPException(404, "aim not found")
        u = user_or_404(rt, a.user_id)
        a = AimService(rt.session).update(a, body.text, canonical(rt, u, body.text.strip())[0])
        relayer(rt, u, f"aim:{a.id}")
        return aim_out(a)

    @app.delete("/v1/aims/{aim_id}", status_code=204)
    def delete_aim(aim_id: uuid.UUID, rt: Runtime = Depends(get_rt)):
        from pga.db.models import Aim
        a = rt.session.get(Aim, aim_id)
        if a is None:
            raise HTTPException(404, "aim not found")
        AimService(rt.session).delete(a)

    # ---------------------------------------------------------------- information pyramid (gist · brief · full)

    def layer_ref(rt: Runtime, user_id: uuid.UUID, ref: str):
        from pga.layers import LayerError
        try:
            src = rt.layers.source(ref)
        except LayerError as exc:
            raise HTTPException(404, str(exc)) from exc
        if src.user_id != user_id:
            raise HTTPException(404, "not found for this user")
        return src

    @app.get("/v1/users/{user_id}/layers")
    def get_layers(user_id: uuid.UUID, ref: str, rt: Runtime = Depends(get_rt)):
        """One item at three levels of detail: 1 gist (要点), 2 brief (概要), 3 full (全量)."""
        user_or_404(rt, user_id)
        layer_ref(rt, user_id, ref)
        return rt.layers.get(ref).as_dict()

    @app.post("/v1/users/{user_id}/layers/build")
    def build_layers(user_id: uuid.UUID, body: sc.LayersBuildIn, rt: Runtime = Depends(get_rt)):
        """Build the pyramid now (the user asked); otherwise the worker does it after every change."""
        u = user_or_404(rt, user_id)
        layer_ref(rt, user_id, body.ref)
        with rt.billing(user_ctx(u)):
            return rt.layers.build(u, body.ref, force=body.force).as_dict()

    # ---------------------------------------------------------------- bodies (databases, skills) and bridges

    def body_out(b) -> dict:
        return {"id": b.id, "ref": f"k:{b.id}", "kind": b.kind, "title": b.title, "title_en": b.title_en,
                "description": b.description, "aim_id": b.aim_id, "private": b.private, "origin": b.origin.value,
                "created_at": b.created_at}

    def bridge_out(br) -> dict:
        return {"id": br.id, "a": br.a_ref, "b": br.b_ref, "note": br.note, "created_at": br.created_at}

    @app.get("/v1/users/{user_id}/bodies")
    def list_bodies(user_id: uuid.UUID, rt: Runtime = Depends(get_rt)):
        user_or_404(rt, user_id)
        return [body_out(b) for b in BodyService(rt).list(user_id)]

    @app.post("/v1/users/{user_id}/bodies", status_code=201)
    def create_body(user_id: uuid.UUID, body: sc.BodyIn, rt: Runtime = Depends(get_rt)):
        u = user_or_404(rt, user_id)
        title_en = canonical(rt, u, body.title)[0]
        desc_en = canonical(rt, u, body.description)[0] if body.description and not body.private else body.description
        b = BodyService(rt).create(u, kind=body.kind, title=body.title, title_en=title_en, description=body.description,
                                   description_en=desc_en, aim_id=body.aim_id, private=body.private)
        relayer(rt, u, f"k:{b.id}")
        return body_out(b)

    @app.patch("/v1/bodies/{body_id}")
    def patch_body(body_id: uuid.UUID, body: sc.BodyPatch, rt: Runtime = Depends(get_rt)):
        from pga.db.models import Body
        b = rt.session.get(Body, body_id)
        if b is None:
            raise HTTPException(404, "body not found")
        u = user_or_404(rt, b.user_id)
        if body.title is not None:
            b.title, b.title_en = body.title.strip(), canonical(rt, u, body.title.strip())[0]
        if body.description is not None:
            b.description = body.description.strip()
            b.description_en = canonical(rt, u, b.description)[0] if b.description and not b.private else b.description
        if body.private is not None:
            b.private = body.private
        if body.aim_id is not None:
            b.aim_id = AimService(rt.session).get(u.id, body.aim_id).id if body.aim_id else None
        rt.session.flush()
        if body.title is not None or body.description is not None or body.private is not None:
            relayer(rt, u, f"k:{b.id}")
        return body_out(b)

    @app.delete("/v1/bodies/{body_id}", status_code=204)
    def delete_body(body_id: uuid.UUID, rt: Runtime = Depends(get_rt)):
        from pga.db.models import Body
        b = rt.session.get(Body, body_id)
        if b is None:
            raise HTTPException(404, "body not found")
        BodyService(rt).delete(b)

    @app.post("/v1/aims/{aim_id}/expand")
    def expand_aim(aim_id: uuid.UUID, per_kind: int = Query(5, ge=1, le=8), rt: Runtime = Depends(get_rt)):
        """Ask the model which databases and skills this ambition needs, and add them to its map."""
        from pga.db.models import Aim
        a = rt.session.get(Aim, aim_id)
        if a is None:
            raise HTTPException(404, "aim not found")
        u = user_or_404(rt, a.user_id)
        with rt.billing(user_ctx(u)):
            made = BodyService(rt).expand(u, a, per_kind=per_kind)
        return [body_out(b) for b in made]

    @app.get("/v1/users/{user_id}/bridges")
    def list_bridges(user_id: uuid.UUID, rt: Runtime = Depends(get_rt)):
        user_or_404(rt, user_id)
        return [bridge_out(br) for br in BodyService(rt).bridges(user_id)]

    @app.post("/v1/users/{user_id}/bridges", status_code=201)
    def create_bridge(user_id: uuid.UUID, body: sc.BridgeIn, rt: Runtime = Depends(get_rt)):
        user_or_404(rt, user_id)
        return bridge_out(BodyService(rt).bridge(user_id, body.a, body.b, body.note))

    @app.delete("/v1/bridges/{bridge_id}", status_code=204)
    def delete_bridge(bridge_id: uuid.UUID, rt: Runtime = Depends(get_rt)):
        from pga.db.models import Bridge
        br = rt.session.get(Bridge, bridge_id)
        if br is None:
            raise HTTPException(404, "bridge not found")
        rt.session.delete(br)

    # ---------------------------------------------------------------- R0 and the Evolution Loop

    def version_out(v, full: bool = False) -> dict:
        out = {"id": v.id, "label": v.label, "status": v.status, "parent_id": v.parent_id, "proposal_id": v.proposal_id,
               "round_id": v.round_id, "files": v.files, "verification": v.verification, "note": v.note, "branch": v.branch,
               "canary_until": v.canary_until, "created_at": v.created_at, "promoted_at": v.promoted_at,
               "patch_lines": len(v.patch.splitlines()) if v.patch else 0}
        if full:
            out["patch"] = v.patch
        return out

    def proposal_out(p) -> dict:
        return {"id": p.id, "code": p.code, "title": p.title, "problem": p.problem, "change": p.change, "proposer": p.proposer,
                "expected_gain": p.expected_gain, "risk": p.risk, "evaluation_plan": p.evaluation_plan, "files": p.files,
                "scores": p.scores, "value": p.value, "status": p.status, "evidence": p.evidence[-5:],
                "last_reviewed_at": p.last_reviewed_at, "created_at": p.created_at}

    @app.get("/v1/users/{user_id}/evolution")
    def evolution(user_id: uuid.UUID, rt: Runtime = Depends(get_rt)):
        from pga.db.models import AgentVersion, EvolutionRound, ImprovementProposal, MotivationDecision
        user_or_404(rt, user_id)
        st = r0_state(rt, user_id)
        tele = []
        for k, sig in SIGNALS.items():
            v = (st.telemetry or {}).get(k, {})
            tele.append({"key": k, "label": sig.label_zh, "value": v.get("value"), "n": v.get("n", 0), "good": sig.good, "bad": sig.bad,
                         "severity": round(sig.severity(v.get("value"), v.get("n", 0)), 3)})
        rounds = list(rt.session.scalars(select(EvolutionRound).where(EvolutionRound.user_id == user_id)
                                         .order_by(EvolutionRound.created_at.desc()).limit(5)))
        decisions = list(rt.session.scalars(select(MotivationDecision).where(MotivationDecision.user_id == user_id, MotivationDecision.subject == "R0")
                                            .order_by(MotivationDecision.created_at.desc()).limit(5)))
        return {"r0": {"tension": st.tension, "wake": rt.policy.evolution.r0_wake, "paused": st.paused, "enabled": rt.policy.evolution.enabled,
                       "telemetry": tele, "counts": (st.telemetry or {}).get("_counts", {}), "ledger": (st.ledger or [])[:12],
                       "updated_at": st.updated_at, "can_start": EvolutionService(rt).can_start(user_id, utcnow()),
                       "coding_agent": rt.policy.evolution.coding_agent},
                "rounds": [{"id": r.id, "phase": r.phase, "trigger": r.trigger, "problem": r.problem, "log": r.log[-14:],
                            "stop_reason": r.stop_reason, "created_at": r.created_at, "ended_at": r.ended_at} for r in rounds],
                "decisions": [{"decision": d.decision, "answers": d.answers, "fallback": d.fallback, "tension": d.tension,
                               "created_at": d.created_at} for d in decisions],
                "backlog": [proposal_out(p) for p in rt.session.scalars(select(ImprovementProposal).where(ImprovementProposal.user_id == user_id)
                                                                         .order_by(ImprovementProposal.value.desc(), ImprovementProposal.created_at))],
                "versions": [version_out(v) for v in rt.session.scalars(select(AgentVersion).where(AgentVersion.user_id == user_id)
                                                                         .order_by(AgentVersion.created_at))]}

    @app.post("/v1/users/{user_id}/evolution/tick")
    def evolution_tick(user_id: uuid.UUID, rt: Runtime = Depends(get_rt)):
        user_or_404(rt, user_id)
        st = r0_tick(rt, user_id)
        return {"tension": st.tension, "ledger": (st.ledger or [])[:3]}

    @app.patch("/v1/users/{user_id}/evolution")
    def evolution_patch(user_id: uuid.UUID, body: sc.EvolutionPatch, rt: Runtime = Depends(get_rt)):
        user_or_404(rt, user_id)
        st = r0_state(rt, user_id)
        st.paused = body.paused
        return {"paused": st.paused}

    @app.post("/v1/users/{user_id}/evolution/round", status_code=201)
    def evolution_round(user_id: uuid.UUID, rt: Runtime = Depends(get_rt)):
        """Start one bounded round now (the user asked; the minimum interval is waived, the other bounds are not)."""
        u = user_or_404(rt, user_id)
        r0_tick(rt, user_id)
        rnd = EvolutionService(rt).start(u, trigger="user", force=True)
        return {"id": rnd.id, "phase": rnd.phase}

    def version_or_404(rt: Runtime, vid: uuid.UUID):
        from pga.db.models import AgentVersion
        v = rt.session.get(AgentVersion, vid)
        if v is None:
            raise HTTPException(404, "version not found")
        return v

    @app.get("/v1/evolution/versions/{vid}")
    def get_version(vid: uuid.UUID, rt: Runtime = Depends(get_rt)):
        return version_out(version_or_404(rt, vid), full=True)

    @app.post("/v1/evolution/versions/{vid}/{op}")
    def version_action(vid: uuid.UUID, op: str, rt: Runtime = Depends(get_rt)):
        """promote / reject / rollback — every change to the live code goes through the user here."""
        svc, v = EvolutionService(rt), version_or_404(rt, vid)
        try:
            if op == "promote":
                svc.promote(v)
            elif op == "reject":
                svc.reject(v)
            elif op == "rollback":
                svc.rollback(v)
            else:
                raise HTTPException(404, f"unknown operation {op!r}")
        except EvolutionError as exc:
            raise HTTPException(409, str(exc)) from exc
        return version_out(v)

    @app.get("/v1/responsibilities/{rid}/motivation")
    def motivation_history(rid: uuid.UUID, rt: Runtime = Depends(get_rt)):
        from pga.db.models import MotivationDecision
        resp_or_404(rt, rid)
        return [{"decision": d.decision, "answers": d.answers, "budget": d.budget, "stop_condition": d.stop_condition,
                 "fallback": d.fallback, "tension": d.tension, "created_at": d.created_at}
                for d in rt.session.scalars(select(MotivationDecision).where(MotivationDecision.responsibility_id == rid)
                                            .order_by(MotivationDecision.created_at.desc()).limit(10))]

    @app.put("/v1/users/{user_id}/aim")
    def set_aim(user_id: uuid.UUID, body: sc.AimIn, rt: Runtime = Depends(get_rt)):
        """Set (or, with "", remove) the first long-range aim. Kept for clients that only know one aim."""
        u = user_or_404(rt, user_id)
        aims = AimService(rt.session)
        first, text = aims.primary(u), body.text.strip()
        if not text:
            if first:
                aims.delete(first)
            return {"aim": None, "aim_en": None}
        en = canonical(rt, u, text)[0]
        a = aims.update(first, text, en) if first else aims.create(u, text, en)
        relayer(rt, u, f"aim:{a.id}")
        return {"id": a.id, "aim": a.text, "aim_en": a.text_en}

    @app.get("/v1/users/{user_id}/permissions")
    def get_permissions(user_id: uuid.UUID, rt: Runtime = Depends(get_rt)):
        u = user_or_404(rt, user_id)
        return {"version": u.permission_policy.version, "rules": u.permission_policy.rules}

    @app.patch("/v1/users/{user_id}/permissions")
    def patch_permissions(user_id: uuid.UUID, body: sc.PermissionsPatch, rt: Runtime = Depends(get_rt)):
        u = user_or_404(rt, user_id)
        pp = permissions.update_rules(rt.session, u, body.rules, actor=Origin.USER)
        return {"version": pp.version, "rules": pp.rules}

    # ---------------------------------------------------------------- chat

    def msg_out(m: Message) -> sc.MessageOut:
        return sc.MessageOut(id=m.id, role=m.role.value, display_text=m.display_text,
                             display_language=m.display_language, canonical_en=m.canonical_en,
                             raw_language=m.raw_language, translation_status=m.translation_status.value,
                             requested_output_language=m.requested_output_language, created_at=m.created_at)

    @app.post("/v1/chat", response_model=sc.ChatOut)
    def chat(body: sc.ChatIn, rt: Runtime = Depends(get_rt)):
        u = user_or_404(rt, body.user_id)
        focus = None
        if body.responsibility_id:
            focus = resp_or_404(rt, body.responsibility_id)
            if focus.user_id != u.id:
                raise HTTPException(404, "responsibility not found")
        turn = chat_turn(rt, u, body.text, body.conversation_id, focus=focus)
        return sc.ChatOut(conversation_id=turn.user_message.conversation_id, user_message=msg_out(turn.user_message),
                          reply=msg_out(turn.reply), allocation=turn.decision.as_dict(),
                          run_id=turn.run.id if turn.run else None)

    @app.get("/v1/conversations/{conversation_id}/messages", response_model=list[sc.MessageOut])
    def conversation(conversation_id: uuid.UUID, rt: Runtime = Depends(get_rt)):
        rows = rt.session.scalars(select(Message).where(Message.conversation_id == conversation_id)
                                  .order_by(Message.created_at))
        return [msg_out(m) for m in rows]

    # ---------------------------------------------------------------- situation

    @app.post("/v1/users/{user_id}/situation", status_code=201)
    def add_fact(user_id: uuid.UUID, body: sc.FactIn, rt: Runtime = Depends(get_rt)):
        u = user_or_404(rt, user_id)
        en, raw = canonical(rt, u, body.text)
        f = rt.situation.add(user_id=u.id, type=body.type, canonical_en=en, origin=Origin.USER, raw_text=raw or body.text,
                             raw_language=None, source_uri=body.source_uri, confidence=body.confidence,
                             topic=body.topic, valid_until=body.valid_until)
        return {"id": f.id, "type": f.type.value, "canonical_en": f.canonical_en, "topic": f.topic}

    @app.get("/v1/users/{user_id}/situation")
    def situation(user_id: uuid.UUID, rt: Runtime = Depends(get_rt)):
        user_or_404(rt, user_id)
        return [{"id": f.id, "type": f.type.value, "canonical_en": f.canonical_en, "raw_text": f.raw_text,
                 "topic": f.topic, "origin": f.origin.value, "confidence": f.confidence,
                 "valid_until": f.valid_until} for f in rt.situation.current(user_id)]

    # ---------------------------------------------------------------- responsibilities

    def r_out(r: Responsibility) -> sc.ResponsibilityOut:
        return sc.ResponsibilityOut(
            id=r.id, parent_id=r.parent_id, aim_id=r.aim_id, title_en=r.title_en, title_display=r.raw_title or r.title_en,
            raw_title=r.raw_title, description_en=r.description_en, status=r.status.value, tension=round(r.tension, 4),
            wake_threshold=r.wake_threshold, sleep_threshold=r.sleep_threshold, paused_by_user=r.paused_by_user,
            created_by=r.created_by.value, keywords=list(r.keywords or []), useful_outcomes=r.useful_outcomes,
            candidate_expires_at=r.candidate_expires_at, next_review_at=r.next_review_at, updated_at=r.updated_at)

    @app.post("/v1/users/{user_id}/responsibilities", response_model=sc.ResponsibilityOut, status_code=201)
    def create_responsibility(user_id: uuid.UUID, body: sc.ResponsibilityIn, rt: Runtime = Depends(get_rt)):
        u = user_or_404(rt, user_id)
        title_en, raw_title = canonical(rt, u, body.title)
        desc_en, _ = canonical(rt, u, body.description)
        keywords = [canonical(rt, u, k)[0] for k in body.keywords]
        r = rt.responsibilities.create(
            user_id=u.id, title_en=title_en, raw_title=raw_title, description_en=desc_en, keywords=keywords,
            priority_bias=body.priority_bias, compute_budget=body.compute_budget, actor=Origin.USER,
            wake_threshold=body.wake_threshold, sleep_threshold=body.sleep_threshold,
            initial_status=ResponsibilityStatus(body.initial_status))
        aims = AimService(rt.session)
        if body.aim_id:
            r.aim_id = aims.get(u.id, body.aim_id).id
        elif (first := aims.primary(u)) is not None:
            r.aim_id = first.id
        rt.session.flush()
        relayer(rt, u, str(r.id))
        return r_out(r)

    @app.get("/v1/users/{user_id}/responsibilities", response_model=list[sc.ResponsibilityOut])
    def list_responsibilities(user_id: uuid.UUID, include_closed: bool = False, rt: Runtime = Depends(get_rt)):
        user_or_404(rt, user_id)
        rows = rt.responsibilities.list(user_id)
        if not include_closed:
            rows = [r for r in rows if r.status not in {ResponsibilityStatus.COMPLETED, ResponsibilityStatus.ARCHIVED}]
        return [r_out(r) for r in rows]

    @app.get("/v1/responsibilities/{rid}", response_model=sc.ResponsibilityOut)
    def get_responsibility(rid: uuid.UUID, rt: Runtime = Depends(get_rt)):
        return r_out(resp_or_404(rt, rid))

    @app.patch("/v1/responsibilities/{rid}", response_model=sc.ResponsibilityOut)
    def patch_responsibility(rid: uuid.UUID, body: sc.ResponsibilityPatch, rt: Runtime = Depends(get_rt)):
        r = resp_or_404(rt, rid)
        u = user_or_404(rt, r.user_id)
        fields: dict[str, Any] = {}
        if body.title is not None:
            fields["title_en"], fields["raw_title"] = canonical(rt, u, body.title)
        if body.description is not None:
            fields["description_en"] = canonical(rt, u, body.description)[0]
        if body.keywords is not None:
            fields["keywords"] = [canonical(rt, u, k)[0] for k in body.keywords]
        if body.aim_id is not None:
            fields["aim_id"] = AimService(rt.session).get(u.id, body.aim_id).id if body.aim_id else None
        for k in ("priority_bias", "wake_threshold", "sleep_threshold", "compute_budget", "next_review_at"):
            v = getattr(body, k)
            if v is not None:
                fields[k] = v
        rt.responsibilities.update(r, actor=Origin.USER, **fields)
        if body.title is not None or body.description is not None:
            relayer(rt, u, str(r.id))
        return r_out(r)

    @app.post("/v1/responsibilities/{rid}/actions/{op}", response_model=sc.ResponsibilityOut)
    def responsibility_action(rid: uuid.UUID, op: str, body: sc.ActionIn | None = None, rt: Runtime = Depends(get_rt)):
        r = resp_or_404(rt, rid)
        rt.tension.decay(r)
        rt.responsibilities.transition(r, op, actor=Origin.USER, reason=(body.reason if body else ""))
        if op in {"pause", "cancel", "complete", "archive"}:
            rt.workflow.cancel_for_responsibility(r.id, actor=Origin.USER, reason=f"responsibility {op}d by the user")
        elif op in {"resume", "unpause"}:
            rt.workflow.signal_user(r.user_id, {"op": op}, responsibility_id=r.id)
        return r_out(r)

    @app.get("/v1/responsibilities/{rid}/why")
    def why(rid: uuid.UUID, rt: Runtime = Depends(get_rt)):
        """Why is this responsibility awake (or not)? Tension ledger + last wake reason."""
        r = resp_or_404(rt, rid)
        rt.tension.decay(r)
        return rt.tension.why_awake(r)

    @app.post("/v1/responsibilities/{rid}/reject", response_model=sc.ResponsibilityOut)
    def reject(rid: uuid.UUID, body: sc.RejectIn, rt: Runtime = Depends(get_rt)):
        r = resp_or_404(rt, rid)
        rt.tension.reject_direction(r, cluster_id=body.cluster_id, note=body.note, actor=Origin.USER)
        return r_out(r)

    @app.post("/v1/responsibilities/{rid}/tension", response_model=sc.ResponsibilityOut)
    def adjust_tension(rid: uuid.UUID, body: sc.AdjustIn, rt: Runtime = Depends(get_rt)):
        r = resp_or_404(rt, rid)
        rt.tension.adjust(r, body.delta, reason=body.reason, actor=Origin.USER)
        return r_out(r)

    # ---------------------------------------------------------------- events & tension

    @app.post("/v1/users/{user_id}/events")
    def ingest_event(user_id: uuid.UUID, body: sc.EventIn, rt: Runtime = Depends(get_rt)):
        u = user_or_404(rt, user_id)
        signals = ({rid: Signals(**s.model_dump()) for rid, s in body.signals.items()} if body.signals else None)
        item = IncomingEvidence(text=body.text, source_type=body.source_type, source_uri=body.source_uri,
                                title=body.title, published_at=body.published_at, trust_score=body.trust_score,
                                event_key=body.event_key, expires_at=body.expires_at, signals=signals,
                                origin=Origin.EXTERNAL)
        with rt.billing(UsageContext(category="monitoring", proactive=True, user_id=u.id)):
            res = rt.tension.ingest(u.id, item)
        return {
            "evidence_id": res.evidence.id, "cluster_id": res.cluster.id, "new_cluster": res.new_cluster,
            "cluster_sources": res.cluster.source_count, "cluster_confidence": round(res.cluster.confidence, 4),
            "effects": [{"responsibility_id": e.responsibility_id, "delta": round(e.delta, 4),
                         "tension_before": round(e.tension_before, 4), "tension_after": round(e.tension_after, 4),
                         "transition": e.transition} for e in res.effects],
        }

    @app.post("/v1/users/{user_id}/tick")
    def tick(user_id: uuid.UUID, rt: Runtime = Depends(get_rt)):
        user_or_404(rt, user_id)
        return rt.tension.tick(user_id)

    # ---------------------------------------------------------------- allocation, budget, quota, runs

    @app.post("/v1/allocations")
    def allocate(body: sc.AllocationIn, rt: Runtime = Depends(get_rt)):
        user_or_404(rt, body.user_id)
        return rt.allocator.allocate(RunRequest(**body.model_dump())).as_dict()

    @app.get("/v1/users/{user_id}/budget")
    def budget(user_id: uuid.UUID, rt: Runtime = Depends(get_rt)):
        user_or_404(rt, user_id)
        return rt.ledger.summary(user_id)

    def worker_status(rt: Runtime, user_id: uuid.UUID, now) -> dict:
        """Is anything processing this user's jobs? (drives the heartbeat vs. flatline)"""
        from pga.workflow import worker as worker_mod

        beat = worker_mod.LAST_BEAT
        counts = dict(rt.session.execute(select(Job.status, func.count()).where(
            Job.user_id == user_id, Job.status.in_([JobStatus.RUNNING, JobStatus.QUEUED, JobStatus.WAITING]))
            .group_by(Job.status)).all())
        last_hb = rt.session.scalar(select(func.max(Job.finished_at)).where(
            Job.user_id == user_id, Job.kind == "user.heartbeat", Job.status == JobStatus.SUCCEEDED))
        every = timedelta(minutes=rt.policy.workflow.heartbeat_minutes)
        in_process = beat is not None and now - beat < timedelta(seconds=30)
        alive = in_process or counts.get(JobStatus.RUNNING, 0) > 0 or (last_hb is not None and now - last_hb < every * 2)
        thinking = rt.session.scalar(select(func.count()).select_from(Run).where(
            Run.user_id == user_id, Run.status == RunStatus.RUNNING)) or 0
        return {"alive": bool(alive), "running_jobs": counts.get(JobStatus.RUNNING, 0),
                "queued_jobs": counts.get(JobStatus.QUEUED, 0) + counts.get(JobStatus.WAITING, 0),
                "running_runs": thinking, "last_beat": (beat or last_hb).isoformat() if (beat or last_hb) else None}

    @app.get("/v1/users/{user_id}/pressure")
    def pressure(user_id: uuid.UUID, hours: float = Query(24, gt=0, le=24 * 30), buckets: int = Query(120, ge=10, le=500),
                 rt: Runtime = Depends(get_rt)):
        """Pressure over time, stock-chart style: the line (and OHLC candles) is the highest tension among
        live responsibilities, replayed from the tension ledger; the volume is compute units spent."""
        user_or_404(rt, user_id)
        now = utcnow()
        # bucket edges sit on fixed multiples of the step, so successive polls agree on every finished candle;
        # the last bucket is the one still forming (it ends in the future and closes at the live value)
        step = timedelta(hours=hours) / buckets
        step_s = step.total_seconds()
        end_edge = datetime.fromtimestamp(math.ceil(now.timestamp() / step_s) * step_s, tz=timezone.utc)
        if end_edge <= now:
            end_edge += step
        start = end_edge - step * buckets
        live = [r for r in rt.responsibilities.list(user_id) if r.status not in TERMINAL_STATUSES]
        ids = [r.id for r in live]
        current: dict[Any, float] = {}
        created: dict[Any, datetime] = {}
        for r in live:
            before = rt.session.scalar(select(TensionChange.tension_after).where(
                TensionChange.responsibility_id == r.id, TensionChange.created_at < start)
                .order_by(TensionChange.created_at.desc()).limit(1))
            if before is not None:
                current[r.id] = before
            elif r.created_at < start:
                current[r.id] = 0.0
        changes = list(rt.session.execute(select(TensionChange.responsibility_id, TensionChange.created_at,
                                                 TensionChange.tension_after)
                                          .where(TensionChange.responsibility_id.in_(ids),
                                                 TensionChange.created_at >= start)
                                          .order_by(TensionChange.created_at))) if ids else []
        # a perpetual task's pressure is part of the system's pressure: it is what keeps that task working
        from pga.db.models import PerpetualTask
        perp = list(rt.session.scalars(select(PerpetualTask).where(PerpetualTask.user_id == user_id, PerpetualTask.status == "running")))
        for t in perp:
            key = f"perpetual:{t.id}"
            for e in reversed(t.ledger or []):
                try:
                    at = datetime.fromisoformat(e["at"])
                except (KeyError, ValueError):
                    continue
                if at < start:
                    current[key] = float(e.get("pressure") or 0.0)
                else:
                    changes.append((key, at, float(e.get("pressure") or 0.0)))
            created[key] = t.created_at
        changes.sort(key=lambda c: c[1])
        usage = list(rt.session.execute(select(UsageRecord.created_at, UsageRecord.units).where(
            UsageRecord.user_id == user_id, UsageRecord.created_at >= start)))
        created.update({r.id: r.created_at for r in live})

        def level() -> float:
            return max(current.values(), default=0.0)

        points, ci = [], 0
        for i in range(1, buckets + 1):
            edge = start + step * i
            for rid, at in created.items():
                if at <= edge:
                    current.setdefault(rid, 0.0)
            o = hi = lo = level()
            while ci < len(changes) and changes[ci][1] <= edge:
                current[changes[ci][0]] = changes[ci][2]
                ci += 1
                v = level()
                hi, lo = max(hi, v), min(lo, v)
            vals = list(current.values())
            units = sum(u for at, u in usage if edge - step < at <= edge)
            c = level()
            points.append({"t0": (edge - step).isoformat(), "t": edge.isoformat(), "p": round(c, 4), "o": round(o, 4), "h": round(hi, 4),
                           "l": round(lo, 4), "c": round(c, 4),
                           "avg": round(sum(vals) / len(vals), 4) if vals else 0.0, "units": round(units, 1)})
        tensions = [r.tension for r in live] + [t.pressure for t in perp]
        recent = sum(u for at, u in usage if at >= now - timedelta(minutes=2))
        last_change = rt.session.scalar(select(func.max(TensionChange.created_at)).where(
            TensionChange.responsibility_id.in_(ids))) if ids else None
        return {"start": start.isoformat(), "end": now.isoformat(), "step_seconds": step_s,
                "points": points,
                "now": {"p": round(max(tensions, default=0.0), 4),
                        "avg": round(sum(tensions) / len(tensions), 4) if tensions else 0.0,
                        "awake": sum(r.status == ResponsibilityStatus.ACTIVE for r in live),
                        "waiting": sum(r.status == ResponsibilityStatus.WAIT_USER for r in live),
                        "wake_threshold": min((r.wake_threshold for r in live), default=0.75),
                        "units_last_2m": round(recent, 1),
                        "last_event_at": last_change.isoformat() if last_change else None,
                        "worker": worker_status(rt, user_id, now),
                        "perpetual": [{"pressure": t.pressure, "phase": t.phase, "cycles": t.cycles} for t in perp]}}

    @app.get("/v1/users/{user_id}/graph")
    def graph(user_id: uuid.UUID, evidence_per_agent: int = Query(10, ge=0, le=40), rt: Runtime = Depends(get_rt)):
        """The network for the 3D view: you (with the core assistant beside you) → your long-range aims, each aim
        → the responsibility agents serving it → beliefs → evidence; sources feeding agents; the other AI agents
        you use; plus recent activity so the client can animate what just happened."""
        u = user_or_404(rt, user_id)
        now = utcnow()
        agents = [r for r in rt.responsibilities.list(user_id) if r.status not in TERMINAL_STATUSES]
        aim_rows = AimService(rt.session).list(u)
        nodes: list[dict] = [{"id": "you", "kind": "user", "label": "你"}, {"id": "core", "kind": "core", "label": "总助理"}]
        links: list[dict] = [{"source": "you", "target": "core", "kind": "talk"}]
        seen: set[str] = {"core", "you"}
        aim_ids = {a.id for a in aim_rows}
        from pga.db.models import PerpetualTask
        perp = {t.aim_id: t for t in rt.session.scalars(select(PerpetualTask).where(PerpetualTask.user_id == user_id))}
        for i, a in enumerate(aim_rows):
            t = perp.get(a.id)
            nodes.append({"id": f"aim:{a.id}", "kind": "aim", "aim_id": str(a.id), "label": a.text, "label_en": a.text_en,
                          "position": i, **({"tension": t.pressure if t.status == "running" else 0.0,
                                             "perpetual": {"pressure": t.pressure, "phase": t.phase, "status": t.status}} if t else {})})
            links.append({"source": "you", "target": f"aim:{a.id}", "kind": "aim"})
        if not aim_rows:
            nodes.append({"id": "aim:new", "kind": "aim", "aim_id": None, "label": "设定长期目标", "placeholder": True, "position": 0})
            links.append({"source": "you", "target": "aim:new", "kind": "aim"})
        seen.update(n["id"] for n in nodes)
        default_sun = nodes[2]["id"]

        def add(node: dict) -> None:
            if node["id"] not in seen:
                seen.add(node["id"])
                nodes.append(node)

        for r in agents:
            rid = str(r.id)
            add({"id": rid, "kind": "agent", "label": r.raw_title or r.title_en, "label_en": r.title_en,
                 "status": r.status.value, "tension": round(r.tension, 4), "wake": r.wake_threshold,
                 "paused": r.paused_by_user, "parent": str(r.parent_id) if r.parent_id else None,
                 "aim": f"aim:{r.aim_id}" if r.aim_id in aim_ids else default_sun})
            parent = str(r.parent_id) if r.parent_id and any(a.id == r.parent_id for a in agents) else \
                (f"aim:{r.aim_id}" if r.aim_id in aim_ids else default_sun)
            links.append({"source": parent, "target": rid, "kind": "candidate" if r.parent_id else "agent"})
            beliefs = list(rt.session.scalars(select(Belief).where(Belief.responsibility_id == r.id,
                                                                   Belief.superseded_by_id.is_(None))
                                              .order_by(Belief.confidence.desc()).limit(8)))
            for b in beliefs:
                bid = f"b:{b.id}"
                add({"id": bid, "kind": "belief", "label": b.statement_en[:160], "type": b.type.value,
                     "confidence": round(b.confidence, 3), "needs_review": b.needs_review, "agent": rid})
                links.append({"source": rid, "target": bid, "kind": "belief"})
                for e, stance in rt.beliefs.evidence_for(b.id)[:4]:
                    eid = f"e:{e.id}"
                    add({"id": eid, "kind": "evidence", "label": e.canonical_summary_en[:160], "url": e.source_uri,
                         "agent": rid})
                    links.append({"source": bid, "target": eid, "kind": "contradicts" if stance == "CONTRADICTS" else "supports"})
            if evidence_per_agent:
                recent = rt.session.execute(select(Evidence, TensionChange.delta).join(
                    TensionChange, TensionChange.evidence_id == Evidence.id).where(TensionChange.responsibility_id == r.id)
                    .order_by(TensionChange.created_at.desc()).limit(evidence_per_agent))
                for e, delta in recent:
                    eid = f"e:{e.id}"
                    if eid in seen:
                        continue
                    add({"id": eid, "kind": "evidence", "label": e.canonical_summary_en[:160], "url": e.source_uri,
                         "delta": round(delta, 3), "agent": rid})
                    links.append({"source": eid, "target": rid, "kind": "signal"})
        for src in rt.sources.list(user_id):
            sid = f"s:{src.id}"
            add({"id": sid, "kind": "source", "label": src.title or src.uri or src.query or src.kind.value,
                 "source_kind": src.kind.value, "enabled": src.enabled})
            target = str(src.responsibility_id) if src.responsibility_id and str(src.responsibility_id) in seen else "core"
            links.append({"source": sid, "target": target, "kind": "feed"})

        for a in rt.hub.list(user_id):
            aid = f"ai:{a.id}"
            summ = a.summary_display or a.summary or {}
            add({"id": aid, "kind": "ai", "label": a.name, "vendor": a.vendor, "usage": a.usage,
                 "conversations": a.conversation_count, "headline": summ.get("headline") if isinstance(summ, dict) else None})
            links.append({"source": aid, "target": "you", "kind": "ai"})

        bodies = BodyService(rt)
        for b in bodies.list(user_id):
            kid = f"k:{b.id}"
            add({"id": kid, "kind": b.kind, "label": b.title, "label_en": b.title_en, "description": b.description,
                 "aim": f"aim:{b.aim_id}" if b.aim_id in aim_ids else default_sun, "private": b.private,
                 "origin": b.origin.value, "body_id": str(b.id)})
        for br in bodies.bridges(user_id):
            if br.a_ref in seen and br.b_ref in seen:
                links.append({"source": br.a_ref, "target": br.b_ref, "kind": "bridge", "id": str(br.id), "note": br.note})

        # the information pyramid: each item's gist (L1) for labels, and whether its pyramid is built
        layered = [n for n in nodes if n.get("kind") in ("aim", "agent", "database", "skill") and not n.get("placeholder")]
        rows = rt.layers.rows([n["id"] for n in layered])
        for n in layered:
            have = rows.get(n["id"], {})
            if 1 in have:
                n["gist"] = have[1].text
                n["layers"] = {"source_level": next((lv for lv, l in have.items() if l.mode == "source"), None),
                               "ready": len(have) == 3 and all(l.mode != "rule" for l in have.values()),
                               "words": [have[lv].words for lv in sorted(have)]}

        from pga.db.models import MotivationDecision
        for n in nodes:
            if n.get("kind") == "agent":
                d = rt.session.scalar(select(MotivationDecision).where(MotivationDecision.responsibility_id == uuid.UUID(n["id"]))
                                      .order_by(MotivationDecision.created_at.desc()).limit(1))
                if d:
                    n["forward"] = {"decision": d.decision, "reason": (d.answers or {}).get("reason"), "at": d.created_at.isoformat(),
                                    "fallback": d.fallback}

        ids = [r.id for r in agents]
        events = [] if not ids else [
            {"id": str(c.id), "at": c.created_at.isoformat(), "agent": str(c.responsibility_id),
             "evidence": f"e:{c.evidence_id}" if c.evidence_id else None, "kind": c.kind.value, "delta": round(c.delta, 4)}
            for c in rt.session.scalars(select(TensionChange).where(TensionChange.responsibility_id.in_(ids))
                                        .order_by(TensionChange.created_at.desc()).limit(30))]
        runs = [{"id": str(x.id), "kind": x.kind, "agent": str(x.responsibility_id) if x.responsibility_id else None,
                 "status": x.status.value, "at": x.started_at.isoformat()}
                for x in rt.session.scalars(select(Run).where(Run.user_id == user_id, Run.started_at >= now - timedelta(hours=1))
                                            .order_by(Run.started_at.desc()).limit(20))]
        perpetual = sum(r.status in PERPETUAL_STATUSES for r in agents)
        return {"nodes": nodes, "links": links, "events": events, "runs": runs,
                "free_slots": max(0, rt.policy.limits.max_perpetual_responsibilities_per_user - perpetual)}

    @app.get("/v1/quota")
    def quota(rt: Runtime = Depends(get_rt)):
        return [rt.ledger.quota(q).as_dict() for q in rt.policy.quotas]

    @app.post("/v1/quota/{quota_key}/observe")
    def observe_quota(quota_key: str, body: sc.QuotaObserveIn, rt: Runtime = Depends(get_rt)):
        try:
            return rt.ledger.observe_provider(quota_key, remaining=body.remaining, reset_time=body.reset_time).as_dict()
        except KeyError as exc:
            raise HTTPException(404, str(exc)) from exc

    def run_out(run: Run) -> dict:
        return {c.name: getattr(run, c.name) for c in Run.__table__.columns}

    @app.get("/v1/users/{user_id}/runs")
    def list_runs(user_id: uuid.UUID, limit: int = Query(50, le=500), rt: Runtime = Depends(get_rt)):
        user_or_404(rt, user_id)
        rows = rt.session.scalars(select(Run).where(Run.user_id == user_id).order_by(Run.started_at.desc()).limit(limit))
        return [run_out(r) for r in rows]

    @app.get("/v1/runs/{run_id}")
    def get_run(run_id: uuid.UUID, rt: Runtime = Depends(get_rt)):
        run = rt.session.get(Run, run_id)
        if run is None:
            raise HTTPException(404, "run not found")
        return run_out(run)

    @app.post("/v1/runs/{run_id}/user-response")
    def user_response(run_id: uuid.UUID, body: sc.UserResponseIn, rt: Runtime = Depends(get_rt)):
        try:
            return run_out(rt.runs.record_user_response(run_id, body.response))
        except KeyError as exc:
            raise HTTPException(404, "run not found") from exc

    # ---------------------------------------------------------------- glossary

    @app.post("/v1/users/{user_id}/glossary/corrections", status_code=201)
    def glossary_correction(user_id: uuid.UUID, body: sc.GlossaryCorrectionIn, rt: Runtime = Depends(get_rt)):
        user_or_404(rt, user_id)
        e = rt.gateway.glossary.correct(user_id, body.source_lang, body.target_lang, body.source_term, body.corrected)
        return {"id": e.id, "source_term": e.source_term, "target_term": e.target_term,
                "direction": f"{e.source_lang}->{e.target_lang}"}

    @app.post("/v1/users/{user_id}/glossary/do-not-translate", status_code=201)
    def glossary_dnt(user_id: uuid.UUID, body: sc.TermIn, rt: Runtime = Depends(get_rt)):
        user_or_404(rt, user_id)
        e = rt.gateway.glossary.add_do_not_translate(user_id, body.term)
        return {"id": e.id, "term": e.source_term}

    # ---------------------------------------------------------------- Phase 2: sources

    def source_out(src: Source) -> dict:
        return {"id": src.id, "kind": src.kind.value, "uri": src.uri, "query": src.query, "title": src.title,
                "responsibility_id": src.responsibility_id, "interval_minutes": src.interval_minutes,
                "trust_score": src.trust_score, "enabled": src.enabled, "last_polled_at": src.last_polled_at,
                "last_status": src.last_status, "consecutive_failures": src.consecutive_failures}

    def source_or_404(rt: Runtime, sid: uuid.UUID) -> Source:
        src = rt.session.get(Source, sid)
        if src is None:
            raise HTTPException(404, "source not found")
        return src

    @app.post("/v1/users/{user_id}/sources", status_code=201)
    def add_source(user_id: uuid.UUID, body: sc.SourceIn, rt: Runtime = Depends(get_rt)):
        u = user_or_404(rt, user_id)
        src = rt.sources.add(user_id=u.id, kind=SourceKind(body.kind), actor=Origin.USER, uri=body.uri,
                             query=body.query, title=body.title, responsibility_id=body.responsibility_id,
                             interval_minutes=body.interval_minutes, trust_score=body.trust_score)
        return source_out(src)

    @app.get("/v1/users/{user_id}/sources")
    def list_sources(user_id: uuid.UUID, rt: Runtime = Depends(get_rt)):
        user_or_404(rt, user_id)
        return [source_out(x) for x in rt.sources.list(user_id)]

    @app.patch("/v1/sources/{source_id}")
    def patch_source(source_id: uuid.UUID, body: sc.SourcePatch, rt: Runtime = Depends(get_rt)):
        src = source_or_404(rt, source_id)
        for k in ("enabled", "interval_minutes", "title"):
            v = getattr(body, k)
            if v is not None:
                setattr(src, k, v)
        if body.enabled:
            src.consecutive_failures = 0
        rt.session.flush()
        return source_out(src)

    @app.post("/v1/sources/{source_id}/poll")
    def poll_source(source_id: uuid.UUID, rt: Runtime = Depends(get_rt)):
        src = source_or_404(rt, source_id)
        with rt.billing(UsageContext(category="monitoring", proactive=True, user_id=src.user_id)):
            res = rt.sources.poll(src)
        return {"status": res.status, "new_items": res.new_items, "effects": res.effects}

    # ---------------------------------------------------------------- Phase 2: beliefs

    @app.get("/v1/responsibilities/{rid}/beliefs")
    def beliefs(rid: uuid.UUID, include_history: bool = False, rt: Runtime = Depends(get_rt)):
        from sqlalchemy import select as _select

        from pga.db.models import Belief

        r = resp_or_404(rt, rid)
        q = _select(Belief).where(Belief.responsibility_id == r.id)
        if not include_history:
            q = q.where(Belief.superseded_by_id.is_(None))
        out = []
        for b in rt.session.scalars(q.order_by(Belief.created_at)):
            out.append({"id": b.id, "key": b.key, "type": b.type.value, "status": b.status.value,
                        "statement_en": b.statement_en, "confidence": b.confidence, "needs_review": b.needs_review,
                        "reviewed_at": b.reviewed_at, "superseded_by_id": b.superseded_by_id,
                        "evidence": [{"id": e.id, "stance": st, "summary": e.canonical_summary_en[:300],
                                      "source_uri": e.source_uri, "retrieved_at": e.retrieved_at}
                                     for e, st in rt.beliefs.evidence_for(b.id)]})
        return out

    # ---------------------------------------------------------------- Phase 2: notifications

    def note_out(n: Notification) -> dict:
        return {"id": n.id, "kind": n.kind.value, "status": n.status.value, "reasons": n.reasons,
                "title": n.display_title or n.title_en, "body": n.display_body if n.display_body is not None else n.body_en,
                "title_en": n.title_en, "body_en": n.body_en, "options": n.options,
                "responsibility_id": n.responsibility_id, "artifact_id": n.artifact_id, "run_id": n.run_id,
                "suppressed_reason": n.suppressed_reason, "channels": n.channels, "created_at": n.created_at,
                "delivered_at": n.delivered_at, "deliver_after": n.deliver_after, "answer_text": n.answer_text}

    def note_or_404(rt: Runtime, nid: uuid.UUID) -> Notification:
        n = rt.session.get(Notification, nid)
        if n is None:
            raise HTTPException(404, "notification not found")
        return n

    @app.get("/v1/users/{user_id}/notifications")
    def notifications(user_id: uuid.UUID, include_suppressed: bool = False, limit: int = Query(50, le=500),
                      rt: Runtime = Depends(get_rt)):
        user_or_404(rt, user_id)
        return [note_out(n) for n in rt.notify.list(user_id, include_suppressed, limit)]

    @app.post("/v1/notifications/{nid}/read")
    def read_note(nid: uuid.UUID, rt: Runtime = Depends(get_rt)):
        return note_out(rt.notify.mark_read(note_or_404(rt, nid)))

    @app.post("/v1/notifications/{nid}/dismiss")
    def dismiss_note(nid: uuid.UUID, rt: Runtime = Depends(get_rt)):
        return note_out(rt.notify.dismiss(note_or_404(rt, nid)))

    @app.post("/v1/notifications/{nid}/answer")
    def answer_note(nid: uuid.UUID, body: sc.AnswerIn, rt: Runtime = Depends(get_rt)):
        n = note_or_404(rt, nid)
        u = user_or_404(rt, n.user_id)
        with rt.billing(user_ctx(u)):
            d = rt.notify.answer(u, n, body.text)
        if n.responsibility_id:
            r = rt.session.get(Responsibility, n.responsibility_id)
            if r is not None and r.status == ResponsibilityStatus.WAIT_USER and not rt.notify.open_questions(r.id):
                rt.responsibilities.transition(r, "resume", actor=Origin.USER, reason="user answered")
            rt.workflow.signal_user(u.id, {"notification_id": str(n.id)}, responsibility_id=n.responsibility_id)
        if n.run_id:
            rt.runs.record_user_response(n.run_id, body.text)
        done = EvolutionService(rt).answer(n.dedupe_key, body.text)      # R0's approvals arrive as answers
        return {**note_out(n), "decision_id": d.id, "evolution": done}

    # ---------------------------------------------------------------- Phase 2: the loop

    def job_out(j: Job) -> dict:
        return {"id": j.id, "kind": j.kind, "status": j.status.value, "responsibility_id": j.responsibility_id,
                "run_at": j.run_at, "attempts": j.attempts, "max_attempts": j.max_attempts, "wait_for": j.wait_for,
                "last_error": j.last_error, "result": j.result, "created_at": j.created_at,
                "finished_at": j.finished_at, "workflow_version": j.workflow_version}

    @app.get("/v1/users/{user_id}/jobs")
    def jobs(user_id: uuid.UUID, limit: int = Query(50, le=500), rt: Runtime = Depends(get_rt)):
        user_or_404(rt, user_id)
        rows = rt.session.scalars(select(Job).where(Job.user_id == user_id)
                                  .order_by(Job.created_at.desc()).limit(limit))
        return [job_out(j) for j in rows]

    @app.post("/v1/jobs/{job_id}/cancel")
    def cancel_job(job_id: uuid.UUID, rt: Runtime = Depends(get_rt)):
        return job_out(rt.workflow.cancel(job_id, actor=Origin.USER, reason="cancelled by the user"))

    @app.post("/v1/jobs/{job_id}/retry")
    def retry_job(job_id: uuid.UUID, rt: Runtime = Depends(get_rt)):
        return job_out(rt.workflow.retry(job_id, actor=Origin.USER))

    @app.post("/v1/users/{user_id}/heartbeat")
    def run_heartbeat(user_id: uuid.UUID, rt: Runtime = Depends(get_rt)):
        """Run the deterministic planning step now (the worker does this on a schedule)."""
        return heartbeat(rt, user_or_404(rt, user_id))

    @app.post("/v1/responsibilities/{rid}/research")
    def queue_research(rid: uuid.UUID, rt: Runtime = Depends(get_rt)):
        r = resp_or_404(rt, rid)
        return job_out(rt.workflow.enqueue("responsibility.research", user_id=r.user_id, responsibility_id=r.id,
                                           dedupe_key=f"research:{r.id}", created_by=Origin.USER, priority=20))

    # ---------------------------------------------------------------- Agent Hub

    from pga.hub import HubError, detect_local

    def agent_out(a: LinkedAgent) -> dict:
        return {"id": a.id, "name": a.name, "vendor": a.vendor, "connector": a.connector, "usage": a.usage,
                "notes": a.notes, "conversation_count": a.conversation_count, "message_count": a.message_count,
                "first_activity_at": a.first_activity_at, "last_activity_at": a.last_activity_at,
                "last_synced_at": a.last_synced_at, "summary": a.summary_display or a.summary or None,
                "summary_en": a.summary or None, "summary_at": a.summary_at, "summary_stale": a.summary_stale}

    def digest_out(d) -> dict | None:
        return None if d is None else {"id": d.id, "content": d.content_display or d.content, "content_en": d.content,
                                       "agent_ids": d.agent_ids, "created_at": d.created_at}

    def hub_agent_or_404(rt: Runtime, aid: uuid.UUID) -> LinkedAgent:
        a = rt.session.get(LinkedAgent, aid)
        if a is None:
            raise HTTPException(404, "linked agent not found")
        return a

    app.add_exception_handler(HubError, _err(422))

    @app.get("/v1/users/{user_id}/hub")
    def hub(user_id: uuid.UUID, rt: Runtime = Depends(get_rt)):
        user_or_404(rt, user_id)
        agents = rt.hub.list(user_id)
        linked = {a.connector for a in agents}
        return {"agents": [agent_out(a) for a in agents], "digest": digest_out(rt.hub.latest_digest(user_id)),
                "local": [c for c in detect_local() if c["connector"] not in linked],
                "provider": rt.provider.name}

    @app.post("/v1/users/{user_id}/hub/agents", status_code=201)
    def hub_add(user_id: uuid.UUID, body: sc.HubAgentIn, rt: Runtime = Depends(get_rt)):
        user_or_404(rt, user_id)
        a = rt.hub.create(user_id, name=body.name, vendor=body.vendor, connector=body.connector, usage=body.usage,
                          notes=body.notes)
        result = rt.hub.sync_local(a) if a.connector in ("claude_code", "hermes") else None
        return {**agent_out(a), "sync": result}

    @app.patch("/v1/hub/agents/{aid}")
    def hub_patch(aid: uuid.UUID, body: sc.HubAgentPatch, rt: Runtime = Depends(get_rt)):
        a = hub_agent_or_404(rt, aid)
        for k in ("name", "usage", "notes"):
            v = getattr(body, k)
            if v is not None:
                setattr(a, k, v)
        rt.session.flush()
        return agent_out(a)

    @app.delete("/v1/hub/agents/{aid}", status_code=204)
    def hub_delete(aid: uuid.UUID, rt: Runtime = Depends(get_rt)):
        rt.session.delete(hub_agent_or_404(rt, aid))

    @app.post("/v1/hub/agents/{aid}/import")
    async def hub_import(aid: uuid.UUID, request: Request, filename: str = Query("upload.json", max_length=300),
                         rt: Runtime = Depends(get_rt)):
        """Upload an export (ChatGPT/Claude/DeepSeek conversations.json or .zip, JSON, Markdown, text) as the raw body."""
        from starlette.concurrency import run_in_threadpool

        a = hub_agent_or_404(rt, aid)
        raw = await request.body()
        if len(raw) > 300 * 1024 * 1024:
            raise HTTPException(413, "file too large (300 MB max)")
        result = await run_in_threadpool(rt.hub.import_bytes, a, filename, raw)
        return {**agent_out(a), "import": result}

    @app.post("/v1/hub/agents/{aid}/sync")
    def hub_sync(aid: uuid.UUID, rt: Runtime = Depends(get_rt)):
        a = hub_agent_or_404(rt, aid)
        return {**agent_out(a), "sync": rt.hub.sync_local(a)}

    @app.post("/v1/hub/agents/{aid}/summarize")
    def hub_summarize(aid: uuid.UUID, rt: Runtime = Depends(get_rt)):
        a = hub_agent_or_404(rt, aid)
        with rt.billing(UsageContext(category="user_reserve", proactive=False, user_id=a.user_id)):
            rt.hub.summarize(a)
        return agent_out(a)

    @app.get("/v1/hub/agents/{aid}/conversations")
    def hub_conversations(aid: uuid.UUID, limit: int = Query(40, le=200), rt: Runtime = Depends(get_rt)):
        a = hub_agent_or_404(rt, aid)
        return [{"id": c.id, "title": c.title, "started_at": c.started_at, "updated_at": c.updated_at,
                 "message_count": c.message_count, "preview": c.excerpt[:280]} for c in rt.hub.conversations(a, limit)]

    @app.post("/v1/users/{user_id}/hub/digest")
    def hub_digest(user_id: uuid.UUID, rt: Runtime = Depends(get_rt)):
        u = user_or_404(rt, user_id)
        with rt.billing(user_ctx(u)):
            d = rt.hub.digest(u)
        return digest_out(d)

    @app.post("/v1/users/{user_id}/hub/sync")
    def hub_sync_all(user_id: uuid.UUID, rt: Runtime = Depends(get_rt)):
        """What the background job does: sync local agents, re-summarize changes, refresh the digest, notify."""
        u = user_or_404(rt, user_id)
        linked = rt.hub.link_local(u)                       # you pressed it: everything on this machine is brought in
        with rt.billing(user_ctx(u)):
            return {**rt.hub.background_sync(u), "linked": linked}

    @app.get("/v1/users/{user_id}/hub/timeline")
    def hub_timeline(user_id: uuid.UUID, limit: int = Query(300, le=1000), agent: str | None = None, pga: bool = True,
                     rt: Runtime = Depends(get_rt)):
        """Past conversations from every agent (and PGA's own chats), newest first, each labelled with its agent and model."""
        from pga.agents import history
        user_or_404(rt, user_id)
        rows = rt.hub.timeline(user_id, limit=limit, agent=agent if agent and agent != "pga" else None) if agent != "pga" else []
        if pga and (not agent or agent == "pga"):
            rows += history.everything(rt.session, user_id, limit)
        rows.sort(key=lambda r: r["at"] or "", reverse=True)
        sources: dict[str, dict] = {}
        for a in rt.hub.list(user_id):
            sources[str(a.id)] = {"id": str(a.id), "name": a.name, "vendor": a.vendor, "connector": a.connector,
                                  "count": a.conversation_count, "synced": a.last_synced_at.isoformat() if a.last_synced_at else None}
        return {"items": rows[:limit], "sources": list(sources.values()), "sync_hours": rt.policy.workflow.hub_sync_hours}

    @app.post("/v1/users/{user_id}/notify/test")
    def notify_test(user_id: uuid.UUID, rt: Runtime = Depends(get_rt)):
        """Send a test message through every channel the user has switched on (bypasses daily limits)."""
        u = user_or_404(rt, user_id)
        n = Notification(user_id=u.id, kind=CommKind.NOTIFICATION, reasons=[], title_en="Test notification from PGA",
                         body_en="If you can see this, this notification method works.", options=[], channels=[],
                         status=NotificationStatus.PENDING, created_at=utcnow())
        rt.session.add(n)
        rt.session.flush()
        rt.notify.deliver(u, n)
        return {"channels": n.channels, "title": n.display_title, "body": n.display_body}

    # ---------------------------------------------------------------- knowledge vault (Obsidian format)

    def vault_dirs(u: User) -> tuple[str, str | None]:
        st, prefs = get_settings(), u.preferences or {}
        return (prefs.get("vault_dir") or st.vault_dir), (prefs.get("obsidian_vault") or st.obsidian_vault or None)

    @app.get("/v1/users/{user_id}/vault")
    def vault(user_id: uuid.UUID, external: bool = True, rt: Runtime = Depends(get_rt)):
        """Everything PGA knows as Obsidian notes (frontmatter, [[wikilinks]], #tags), plus — read-only — the
        user's own Obsidian vault when one is configured."""
        u = user_or_404(rt, user_id)
        out_dir, own = vault_dirs(u)
        v = build_vault(rt.session, u.id, obsidian_dir=own if external else None)
        return {**v.as_json(), "export_dir": str(Path(out_dir).expanduser()), "obsidian_vault": own}

    @app.post("/v1/users/{user_id}/vault/export")
    def vault_export(user_id: uuid.UUID, body: sc.VaultExportIn | None = None, rt: Runtime = Depends(get_rt)):
        u = user_or_404(rt, user_id)
        target = (body.path if body and body.path else None) or vault_dirs(u)[0]
        return export_vault(build_vault(rt.session, u.id), target)

    @app.get("/v1/users/{user_id}/vault.zip")
    def vault_download(user_id: uuid.UUID, rt: Runtime = Depends(get_rt)):
        u = user_or_404(rt, user_id)
        return Response(vault_zip(build_vault(rt.session, u.id)), media_type="application/zip",
                        headers={"Content-Disposition": 'attachment; filename="pga-vault.zip"'})

    # ---------------------------------------------------------------- model providers (Hermes-style models.yaml + .env)

    def _models_view() -> dict:
        data = catalog.load()
        for p in data["providers"].values():
            p.update(catalog.key_hint(p.get("key_env")))
            if isinstance(p.get("models"), dict):
                p["models"] = list(p["models"].keys())
        return {**data, "configured": catalog.CONFIG.exists(), "file": str(catalog.CONFIG),
                "presets": catalog.PRESETS, "types": list(catalog.TYPES)}

    def _models_call(fn, *a, **kw):
        try:
            return fn(*a, **kw)
        except catalog.ModelConfigError as exc:
            raise HTTPException(422, str(exc)) from exc

    @app.get("/v1/models")
    def models_get():
        """The active provider, tier models and provider list. Keys are never returned, only whether one is set."""
        return _models_view()

    @app.put("/v1/models")
    def models_put(body: dict):
        """Save models.yaml; `keys` ({KEY_ENV: value}) go to .env. An empty value removes a key; a missing one keeps it."""
        for env, value in (body.pop("keys", None) or {}).items():
            if value is not None:
                _models_call(catalog.set_key, env, value)
        _models_call(catalog.save, {"model": body.get("model") or {}, "providers": body.get("providers") or {}})
        return _models_view()

    def _provider_from(body: dict) -> tuple[str, dict]:
        pid = str(body.get("id") or "")
        p = dict(body.get("provider") or catalog.load()["providers"].get(pid) or {})
        if not p:
            raise HTTPException(404, "unknown provider")
        if body.get("key"):                                  # a key typed but not yet saved
            env = "PGA_UNSAVED_TEST_KEY"
            os.environ[env] = body["key"]
            p["key_env"] = env
        return pid or "test", p

    @app.post("/v1/models/test")
    def models_test(body: dict):
        pid, p = _provider_from(body)
        try:
            return catalog.test(pid, p, str(body.get("model") or (p.get("tiers") or {}).get(1) or (p.get("tiers") or {}).get("1") or ""))
        finally:
            os.environ.pop("PGA_UNSAVED_TEST_KEY", None)

    @app.post("/v1/models/discover")
    def models_discover(body: dict):
        pid, p = _provider_from(body)
        try:
            return {"models": catalog.discover(p)}
        except Exception as exc:  # noqa: BLE001
            raise HTTPException(502, f"could not list models: {str(exc)[:200]}") from exc
        finally:
            os.environ.pop("PGA_UNSAVED_TEST_KEY", None)

    @app.get("/v1/models/hermes")
    def models_hermes():
        return {"found": (h := catalog.hermes()) is not None, **(h or {})}

    @app.post("/v1/models/hermes/import")
    def models_hermes_import(copy_keys: bool = False):
        _models_call(catalog.import_hermes, copy_keys=copy_keys)
        return _models_view()

    # ---------------------------------------------------------------- owner, snapshots

    @app.post("/v1/users/{user_id}/owner")
    def claim_owner(user_id: uuid.UUID, force: bool = False, rt: Runtime = Depends(get_rt)):
        """Make this account the installation's owner (R0 lives here). Without force, only if there is none yet."""
        from pga.owner import claim, owner_id
        u = user_or_404(rt, user_id)
        claimed = claim(rt.session, u, force=force)
        return {"owner": str(owner_id(rt.session) or ""), "claimed": claimed}

    @app.get("/v1/system")
    def system_status(rt: Runtime = Depends(get_rt)):
        from pga import snapshot
        from pga.workflow import worker as wk
        snaps = list(rt.session.scalars(select(snapshot.Snapshot).order_by(snapshot.Snapshot.at.desc()).limit(12)))
        return {**_system_brief(), "worker_alive": wk.LAST_BEAT is not None, "last_beat": wk.LAST_BEAT,
                "snapshot_dir": str(snapshot.SNAP_DIR),
                "snapshots": [{"id": str(x.id), "kind": x.kind, "at": x.at, "worker": x.worker_id,
                               "running": len((x.data or {}).get("jobs", {}).get("running", [])),
                               "due": (x.data or {}).get("jobs", {}).get("due_now")} for x in snaps]}

    # ---------------------------------------------------------------- the agent pool (agents.yaml)

    def _pool_view(rt: Runtime, rank: bool = True) -> dict:
        from pga.agents import pool as ap
        from pga.agents.routing import AgentRouter
        import time as _t
        marks, t0 = [], _t.monotonic()
        mark = lambda what: marks.append((what, round(_t.monotonic() - t0, 2)))  # noqa: E731
        p = ap.AgentPool(rt)
        router = AgentRouter(rt, p)
        status = p.status()
        mark("status")
        from pga.agents import links
        lv = links.view() if links.active() else {}
        mark("links")
        for n in status:
            status[n]["quota"] = router.quota(n).as_dict()
            mark(f"quota:{n}")
            status[n]["link"] = lv.get(n)
        ranking = {c: router.rank(c) for c in (p.cfg["routing"].get("categories") or {})} if rank else {}
        mark("rank")
        if marks[-1][1] > 3:                                 # slow: say where the time went
            logging.getLogger("pga.api").warning("agents view took %.1fs: %s", marks[-1][1], marks)
        return {"links_active": links.active(), "agents": p.cfg["agents"], "workflows": p.cfg["workflows"], "routing": p.cfg["routing"], "run": p.cfg["run"],
                "status": status, "configured": ap.CONFIG.exists(), "file": str(ap.CONFIG), "spent_today": round(p.spent_today(), 4),
                "adapters": sorted(ap.ADAPTERS), "patterns": list(ap.PATTERNS), "modes": list(ap.MODES),
                "ranking": ranking}

    @app.get("/v1/agents")
    def agents_get(rt: Runtime = Depends(get_rt)):
        """Every agent the pool knows (installed or not), the workflows, and today's spend."""
        return _pool_view(rt)

    @app.put("/v1/agents")
    def agents_put(body: dict, rt: Runtime = Depends(get_rt)):
        from pga.agents import pool as ap
        try:
            ap.save(body)
        except ap.PoolError as exc:
            raise HTTPException(422, str(exc)) from exc
        return _pool_view(rt)

    @app.put("/v1/agents/secrets")
    def agents_secrets(body: dict, rt: Runtime = Depends(get_rt)):
        """Tokens an agent CLI needs (e.g. CLAUDE_CODE_OAUTH_TOKEN): written to pga/.env only, never returned."""
        from pga.agents import pool as ap
        allowed = {n for ad in ap.AgentPool(rt).adapters.values() if hasattr(ad, "secret_names") for n in ad.secret_names()}
        for name, value in body.items():
            if name not in allowed:
                raise HTTPException(422, f"{name} is not a secret any agent declares")
            try:
                catalog.set_key(name, str(value or ""))
            except catalog.ModelConfigError as exc:
                raise HTTPException(422, str(exc)) from exc
        return _pool_view(rt)

    @app.post("/v1/agents/{name}/clone", status_code=201)
    def agents_clone(name: str, body: dict | None = None, rt: Runtime = Depends(get_rt)):
        """A second copy of an agent (another account or API key): same kind and settings, its own token / key, its own
        quota and history; it joins every category right after the original."""
        new = _clone(rt, name, body or {})
        return {"name": new, **_pool_view(rt)}

    def _clone(rt: Runtime, name: str, body: dict, env_for=None) -> str:
        import copy
        import re as _re

        from pga.agents import pool as ap
        data = ap.load()
        agents = data["agents"]
        if name not in agents:
            raise HTTPException(404, "unknown agent")
        new = str((body or {}).get("name") or "").strip().lower()
        if not new:
            i = 2
            while f"{name}-{i}" in agents:
                i += 1
            new = f"{name}-{i}"
        if not _re.match(r"^[a-z0-9][a-z0-9_-]{0,39}$", new) or new in agents:
            raise HTTPException(422, f"name {new!r} is taken or not allowed (lowercase letters, digits, - or _)")
        a = copy.deepcopy(agents[name])
        suffix = _re.sub(r"[^A-Z0-9]", "_", new.upper())
        ad = ap.AgentPool(rt).adapters[name]
        a["secret_keys"] = {env: f"{env}__{suffix}" for env in ad.secret_map()}
        if isinstance(a.get("api"), dict) and a["api"].get("key_env"):
            a["api"]["key_env"] = f"{str(a['api']['key_env']).split('__')[0]}__{suffix}"
        a["role"] = f"{a.get('role') or name} · #{new.rsplit('-', 1)[-1]}"
        a["link"] = (a.get("link") or "") + f"（{new} 是 {name} 的第二份：自己的令牌 / key、自己的额度）"
        a["clone_of"] = name
        if env_for is not None:                          # e.g. its own CODEX_HOME: a login of its own
            a["env"] = {**(a.get("env") or {}), **env_for(new)}
        # the new account's token(s), given with the same names as the original's (e.g. CLAUDE_CODE_OAUTH_TOKEN): saved
        # under the copy's own names before anything else, so a rejected token leaves no half-made agent behind
        given = (body or {}).get("secrets") or {}
        if not isinstance(given, dict):
            raise HTTPException(422, "secrets must be an object")
        names = dict(a["secret_keys"])
        api_orig = (agents[name].get("api") or {}).get("key_env")
        if api_orig and isinstance(a.get("api"), dict):
            names[str(api_orig)] = a["api"]["key_env"]
        for env, value in given.items():
            if env not in names:
                raise HTTPException(422, f"{name} has no secret called {env}")
            if not str(value or "").strip():
                raise HTTPException(422, "the token is empty")
            try:
                catalog.set_key(names[env], str(value).strip())
            except catalog.ModelConfigError as exc:
                raise HTTPException(422, str(exc)) from exc
        agents[new] = a
        for c in (data["routing"].get("categories") or {}).values():
            pref = c.get("prefer") or []
            if name in pref and new not in pref:
                pref.insert(pref.index(name) + 1, new)
        try:
            ap.save(data)
        except ap.PoolError as exc:
            raise HTTPException(422, str(exc)) from exc
        return new

    # ---------------------------------------------------------------- another account by signing in (Codex, Hermes)

    @app.post("/v1/agents/{name}/accounts/login", status_code=201)
    def agents_account_login(name: str, rt: Runtime = Depends(get_rt)):
        """Sign in another account: ChatGPT / Codex gets a copy with its own Codex folder; Hermes adds the login to its
        own account pool. Returns the link and one-time code to show; poll GET /v1/agents/logins/{id}."""
        from pga.agents import accounts
        from pga.agents import pool as ap
        p = ap.AgentPool(rt)
        ad = p.adapters.get(name)
        if ad is None:
            raise HTTPException(404, "unknown agent")
        exe = ad.exe()
        if not exe:
            raise HTTPException(422, f"{name} is not installed on this Mac")
        cfg = p.cfg["agents"][name]
        if ad.type == "codex_local":
            home = (cfg.get("env") or {}).get("CODEX_HOME")
            target = name
            if not (cfg.get("clone_of") and home):               # the original: make the copy with a folder of its own
                target = _clone(rt, name, {}, env_for=lambda new: {"CODEX_HOME": str(accounts.codex_home(new))})
                ad = ap.AgentPool(rt).adapters[target]
            lg = accounts.start(target, "codex", [exe, "login", "--device-auth"], ad.env(),
                                note=f"在打开的页面登录另一个 ChatGPT 账号；登录后它就是 {target}")
        elif ad.type == "hermes_local":
            lg = accounts.start(name, "hermes", [exe, "auth", "add", "openai-codex", "--no-browser"], ad.env(),
                                note="登录另一个 ChatGPT 账号：它会加进 Hermes 自己的账号池，一个用完自动换下一个")
        else:
            raise HTTPException(422, "this agent adds accounts with a token or key (＋ beside it)")
        import time as _time
        for _ in range(80):                                      # the link and code appear within a few seconds
            if lg.status != "starting":
                break
            _time.sleep(0.25)
        return {**lg.view(), **_pool_view(rt)}

    @app.get("/v1/agents/logins/{lid}")
    def agents_login_status(lid: str, rt: Runtime = Depends(get_rt)):
        from pga.agents import accounts, links
        lg = accounts.get(lid)
        if lg is None:
            raise HTTPException(404, "no such sign-in")
        v = lg.view()
        if v["status"] == "done" and not getattr(lg, "_after", False):
            lg._after = True
            accounts.forget_pool()
            try:
                if links.KEEPER:
                    links.KEEPER[0].check(lg.agent)             # see the new login at once
            except Exception:  # noqa: BLE001 - the heartbeat will look again
                pass
        return v

    @app.delete("/v1/agents/logins/{lid}")
    def agents_login_cancel(lid: str):
        from pga.agents import accounts
        lg = accounts.get(lid)
        if lg is None:
            raise HTTPException(404, "no such sign-in")
        lg.cancel()
        return lg.view()

    @app.get("/v1/agents/{name}/pool")
    def agents_pool_accounts(name: str, rt: Runtime = Depends(get_rt)):
        """Hermes' own account pool (the ChatGPT logins it rotates through)."""
        from pga.agents import accounts
        from pga.agents import pool as ap
        ad = ap.AgentPool(rt).adapters.get(name)
        if ad is None or ad.type != "hermes_local" or not ad.exe():
            return {"accounts": []}
        return {"accounts": accounts.hermes_pool(ad.exe())}

    @app.delete("/v1/agents/{name}")
    def agents_delete(name: str, rt: Runtime = Depends(get_rt)):
        """Remove an agent you added (a copy); the built-in ones can only be disabled."""
        from pga.agents import pool as ap
        data = ap.load()
        a = data["agents"].get(name)
        if a is None:
            raise HTTPException(404, "unknown agent")
        if not a.get("clone_of"):
            raise HTTPException(422, "only an agent you added can be removed; disable this one instead")
        del data["agents"][name]
        for c in (data["routing"].get("categories") or {}).values():
            c["prefer"] = [n for n in c.get("prefer") or [] if n != name]
        for w in data["workflows"].values():
            for k in ("agents", "members", "workers"):
                if isinstance(w.get(k), list):
                    w[k] = [n for n in w[k] if n != name]
            for k in ("chair", "planner", "merge"):
                if w.get(k) == name:
                    w[k] = a["clone_of"]
        try:
            ap.save(data)
        except ap.PoolError as exc:
            raise HTTPException(422, str(exc)) from exc
        return _pool_view(rt)

    @app.post("/v1/agents/live/{lid}/stop")
    def agents_stop(lid: str):
        """Stop an answer while it is being written: the agent is interrupted, what it said so far is kept."""
        from pga.agents import live
        if not live.stop(lid):
            raise HTTPException(409, "that answer is not running")
        return {"stopping": lid}

    @app.get("/v1/agents/{name}/options")
    def agent_options(name: str, rt: Runtime = Depends(get_rt)):
        """What you can choose when talking to this agent: models (with their efforts), and whether it takes images."""
        from pga.agents import pool as ap
        from pga.agents.options import options
        p = ap.AgentPool(rt)
        if name not in p.adapters:
            raise HTTPException(404, "unknown agent")
        return options(name, p.adapters[name], p.cfg["agents"][name], rt)

    @app.get("/v1/agents/links")
    def agents_links():
        """How each agent is connected right now (API / app-server / session / CLI) and whether it is reachable."""
        from pga.agents import links
        return {"active": links.active(), "links": links.view(), "heartbeat_minutes": links.HEARTBEAT_MIN}

    @app.post("/v1/agents/links/check")
    def agents_links_check(body: dict | None = None):
        """Check one agent's link now (or all of them): the same probe the heartbeat runs."""
        from pga.agents import links
        if not links.KEEPER:
            raise HTTPException(409, "the link keeper is not running (start PGA with `python -m pga all`)")
        name = str((body or {}).get("agent") or "")
        k = links.KEEPER[0]
        done = {name: k.check(name)} if name else k.check_all()
        return {"checked": list(done), "links": links.view()}

    @app.post("/v1/agents/test")
    def agents_test(body: dict, rt: Runtime = Depends(get_rt)):
        """Paperclip's "test environment": is it installed, and does it answer a one-word prompt?"""
        from pga.agents import AgentTask
        from pga.agents import pool as ap
        p = ap.AgentPool(rt)
        name = str(body.get("agent") or "")
        if name not in p.adapters:
            raise HTTPException(404, "unknown agent")
        ok, detail = p.adapters[name].available()
        if not ok:
            return {"ok": False, "available": False, "detail": detail}
        r = p.adapters[name].run(AgentTask(prompt="Reply with the single word OK.", timeout_s=float(body.get("timeout_s") or 120), max_turns=2))
        from pga.db.models import AgentRun
        rt.session.add(AgentRun(workflow="test", pattern="single", step="run", agent=name, adapter=r.adapter, status=r.status,
                                prompt="Reply with the single word OK.", output=r.text[:500], error=r.error, cost_usd=r.cost_usd,
                                duration_s=r.duration_s, finished_at=utcnow()))      # a passing test clears a "needs login" mark
        from pga.agents import links
        from pga.agents import quota as aq
        aq.clear()
        if links.KEEPER:                                   # the link state follows what the test just found
            threading.Thread(target=links.KEEPER[0].check, args=(name,), daemon=True).start()
        return {"ok": r.ok, "available": True, "detail": detail, "reply": r.text[:200], "error": r.error, "duration_s": r.duration_s,
                "cost_usd": r.cost_usd, "via": (r.data or {}).get("via", "cli")}

    @app.post("/v1/users/{user_id}/agents/run", status_code=202)
    def agents_run(user_id: uuid.UUID, body: dict, rt: Runtime = Depends(get_rt)):
        """Give work to the pool. In the background by default (a job); `wait: true` runs it now."""
        from pga.agents import pool as ap
        u = user_or_404(rt, user_id)
        flow, prompt = str(body.get("workflow") or "general"), str(body.get("prompt") or "").strip()
        if not prompt:
            raise HTTPException(422, "a prompt is needed")
        if flow not in ap.load()["workflows"]:
            raise HTTPException(422, f"unknown workflow {flow!r}")
        if body.get("wait"):
            with rt.billing(user_ctx(u)):
                return ap.AgentPool(rt).run(flow, prompt, user=u, system=str(body.get("system") or "")).as_dict()
        job = rt.workflow.enqueue("agents.run", user_id=u.id, payload={"workflow": flow, "prompt": prompt[:20000],
                                                                       "system": str(body.get("system") or "")[:4000]},
                                  created_by=Origin.USER, priority=40)
        return {"job_id": str(job.id), "status": job.status.value}

    @app.get("/v1/agents/live")
    def agents_live():
        """Agents working right now (and just finished): what each has said so far — the constellation polls this."""
        from pga.agents import live
        return live.snapshot()

    @app.get("/v1/agents/route")
    def agents_route(text: str = "", category: str | None = None, rt: Runtime = Depends(get_rt)):
        """Which agent a request would go to, and why (no agent is run)."""
        from pga.agents.routing import AgentRouter, classify
        cat, why = (category, "指定的类别") if category else classify(text)
        return {"category": cat, "why": why, "ranking": AgentRouter(rt).rank(cat)}

    @app.post("/v1/users/{user_id}/agents/ask")
    def agents_ask(user_id: uuid.UUID, body: dict, rt: Runtime = Depends(get_rt)):
        """The agent chat: ask one agent (or `auto`: routed by category, preference and remaining usage)."""
        from pga.agents.routing import AgentRouter
        u = user_or_404(rt, user_id)
        text = str(body.get("text") or "").strip()
        if not text:
            raise HTTPException(422, "text is needed")
        context, project = None, None
        if body.get("project_id"):                          # your project, whichever agent works in it
            from pga.projects import ProjectError, Projects
            try:
                ps = Projects(rt.session)
                project = ps.get(u.id, uuid.UUID(str(body["project_id"])))
                ps.touch(project)
            except (ProjectError, ValueError) as exc:
                raise HTTPException(404, str(exc)) from exc
        if body.get("aim_id") and body.get("role"):              # talking to one member of an aim's team
            from pga.db.models import Aim
            from pga.teams import TeamError, TeamService
            aim = rt.session.get(Aim, uuid.UUID(str(body["aim_id"])))
            if aim is None or aim.user_id != u.id:
                raise HTTPException(404, "aim not found")
            try:
                ts = TeamService(rt)
                context = ts.ask_context(aim, str(body["role"]))
                body["agent"] = body.get("agent") if body.get("agent") not in (None, "", "auto") else (ts.member(aim, str(body["role"])) or "auto")
            except TeamError as exc:
                raise HTTPException(422, str(exc)) from exc
        try:
            with rt.billing(user_ctx(u)):
                return AgentRouter(rt).ask(u, text[:20000], agent=str(body.get("agent") or "auto"), context=context,
                                           model=str(body["model"]) if body.get("model") else None,
                                           effort=str(body["effort"]) if body.get("effort") else None,
                                           images=[x for x in body.get("images") or [] if isinstance(x, dict)][:6],
                                           files=[x for x in body.get("files") or [] if isinstance(x, dict)][:6],
                                           translate=bool(body.get("translate")), project=project,
                                           history=body.get("history") if isinstance(body.get("history"), list) else None,
                                           category=str(body["category"]) if body.get("category") else None,
                                           conversation=str(body["conversation"]) if body.get("conversation") else None)
        except ValueError as exc:
            raise HTTPException(422, str(exc)) from exc

    @app.get("/v1/users/{user_id}/agents/runs")
    def agents_runs(user_id: uuid.UUID, limit: int = Query(20, le=100), rt: Runtime = Depends(get_rt)):
        from pga.agents import AgentPool
        user_or_404(rt, user_id)
        return AgentPool(rt).history(user_id, limit)

    def _agent_sources(rt: Runtime, name: str) -> tuple[tuple[str, ...], str | None, str]:
        """Which past histories belong to this pool agent: its own app's (by adapter), or a vendor's imports."""
        from pga.agents import pool as ap
        from pga.hub.service import AGENT_SOURCES
        p = ap.AgentPool(rt)
        if name not in p.adapters:
            raise HTTPException(404, "unknown agent")
        t = p.adapters[name].type
        conns = tuple(p.cfg["agents"][name].get("history_from") or AGENT_SOURCES.get(t, ()))
        vendor = "deepseek" if t == "llm" and "deepseek" in name else None
        return conns, vendor, t

    def project_out(p) -> dict:
        return {"id": str(p.id), "name": p.name, "path": p.path, "notes": p.notes, "full_access": p.full_access,
                "created_at": p.created_at.isoformat(), "last_used_at": p.last_used_at.isoformat() if p.last_used_at else None}

    @app.get("/v1/users/{user_id}/projects")
    def projects_list(user_id: uuid.UUID, rt: Runtime = Depends(get_rt)):
        """Your projects: folders agents may work in, chosen per conversation, with any agent."""
        from pga.projects import Projects
        user_or_404(rt, user_id)
        return [project_out(p) for p in Projects(rt.session).list(user_id)]

    @app.post("/v1/users/{user_id}/projects", status_code=201)
    def projects_create(user_id: uuid.UUID, body: dict, rt: Runtime = Depends(get_rt)):
        from pga.projects import ProjectError, Projects
        u = user_or_404(rt, user_id)
        if (u.preferences or {}).get("demo"):
            raise HTTPException(403, "a demo account cannot open folders on this machine")
        try:
            return project_out(Projects(rt.session).create(user_id, path=str(body.get("path") or ""), name=str(body.get("name") or ""),
                                                           notes=str(body.get("notes") or ""), full_access=bool(body.get("full_access"))))
        except ProjectError as exc:
            raise HTTPException(422, str(exc)) from exc

    @app.patch("/v1/users/{user_id}/projects/{pid}")
    def projects_update(user_id: uuid.UUID, pid: uuid.UUID, body: dict, rt: Runtime = Depends(get_rt)):
        from pga.projects import ProjectError, Projects
        user_or_404(rt, user_id)
        try:
            ps = Projects(rt.session)
            return project_out(ps.update(ps.get(user_id, pid), name=body.get("name"), notes=body.get("notes"),
                                         full_access=body.get("full_access") if "full_access" in body else None))
        except ProjectError as exc:
            raise HTTPException(404, str(exc)) from exc

    @app.delete("/v1/users/{user_id}/projects/{pid}", status_code=204)
    def projects_delete(user_id: uuid.UUID, pid: uuid.UUID, rt: Runtime = Depends(get_rt)):
        """Forget a project (the folder itself is untouched)."""
        from pga.projects import ProjectError, Projects
        user_or_404(rt, user_id)
        try:
            ps = Projects(rt.session)
            ps.delete(ps.get(user_id, pid))
        except ProjectError as exc:
            raise HTTPException(404, str(exc)) from exc

    @app.get("/v1/users/{user_id}/projects/{pid}/activity")
    def projects_activity(user_id: uuid.UUID, pid: uuid.UUID, rt: Runtime = Depends(get_rt)):
        """Which agents worked in this project and what they changed, newest first."""
        from pga.projects import ProjectError, Projects
        user_or_404(rt, user_id)
        try:
            ps = Projects(rt.session)
            return ps.activity(ps.get(user_id, pid))
        except ProjectError as exc:
            raise HTTPException(404, str(exc)) from exc

    @app.get("/v1/users/{user_id}/agents/past-counts")
    def agents_past_counts(user_id: uuid.UUID, rt: Runtime = Depends(get_rt)):
        """How many past conversations each pool agent had in its own app (for the dust around its planet)."""
        from pga.agents import pool as ap
        user_or_404(rt, user_id)
        by = rt.hub.counts(user_id)
        out = {}
        for name in ap.AgentPool(rt).adapters:
            conns, vendor, _t = _agent_sources(rt, name)
            hits = [v for k, v in by.items() if k.split("|")[0] in conns or (vendor and k.split("|")[1] == vendor)]
            if hits:
                out[name] = {"count": sum(h["count"] for h in hits), "recent": sum(h["recent"] for h in hits),
                             "last": max((h["last"] for h in hits if h["last"]), default=None)}
        return out

    @app.get("/v1/users/{user_id}/agents/{name}/past")
    def agents_past(user_id: uuid.UUID, name: str, limit: int = Query(120, le=500), rt: Runtime = Depends(get_rt)):
        """This agent's conversations in its own app (Codex, Claude Code, Hermes, WorkBuddy…), newest first."""
        user_or_404(rt, user_id)
        conns, vendor, _t = _agent_sources(rt, name)
        return rt.hub.timeline(user_id, limit=limit, connectors=conns, vendor=vendor)

    @app.get("/v1/users/{user_id}/agents/{name}/past/{cid}")
    def agents_past_one(user_id: uuid.UUID, name: str, cid: uuid.UUID, rt: Runtime = Depends(get_rt)):
        """One past conversation in full, read again from its own app (secrets redacted); excerpt if it is gone."""
        from pga.db.models import AgentConversation, LinkedAgent
        from pga.hub.connectors import read_one, redact
        user_or_404(rt, user_id)
        c = rt.session.get(AgentConversation, cid)
        a = rt.session.get(LinkedAgent, c.linked_agent_id) if c else None
        if c is None or a is None or a.user_id != user_id:
            raise HTTPException(404, "conversation not found")
        full = read_one(a.connector, c.external_id) if a.connector in ("claude_code", "codebuddy", "workbuddy", "codex", "hermes") else None
        turns = [{"role": r, "text": redact(t)[:20000]} for r, t in (full.turns if full else [])][-200:]
        return {"id": str(c.id), "agent": a.name, "connector": a.connector, "model": c.model, "title": c.title, "project": c.project,
                "at": (c.updated_at or c.started_at or c.created_at).isoformat(), "turns": turns, "excerpt": c.excerpt if not turns else "",
                "resumable": a.connector in ("codex", "claude_code", "codebuddy", "workbuddy")}

    @app.post("/v1/users/{user_id}/agents/{name}/past/{cid}/continue")
    def agents_past_continue(user_id: uuid.UUID, name: str, cid: uuid.UUID, rt: Runtime = Depends(get_rt)):
        """Carry on a past conversation in PGA: Codex resumes the very thread, Claude Code / CodeBuddy the very session;
        anything else gets the conversation's last turns as history."""
        import secrets as _secrets

        from pga.agents import links
        from pga.db.models import AgentConversation, LinkedAgent
        from pga.hub.service import CONTINUE
        user_or_404(rt, user_id)
        conns, _vendor, _t = _agent_sources(rt, name)
        c = rt.session.get(AgentConversation, cid)
        a = rt.session.get(LinkedAgent, c.linked_agent_id) if c else None
        if c is None or a is None or a.user_id != user_id:
            raise HTTPException(404, "conversation not found")
        conversation = f"agent:{name}:past-{_secrets.token_hex(4)}"
        how = CONTINUE.get(a.connector) if a.connector in conns else None
        if how:
            links._put("threads" if how == "thread" else "sessions", f"{name}|{user_id}:{conversation}", c.external_id)
        return {"conversation": conversation, "resumes": how or "history"}

    @app.get("/v1/users/{user_id}/agents/conversations")
    def agents_conversations(user_id: uuid.UUID, card: str = Query(..., pattern=r"^((agent|cat):[A-Za-z0-9_-]{1,40}|team:[0-9a-f-]{36}:[a-z]{2,16})$"),
                             limit: int = Query(40, le=100), rt: Runtime = Depends(get_rt)):
        """Past conversations on one card (an agent, or a kind of work), newest first."""
        from pga.agents import history
        user_or_404(rt, user_id)
        return history.conversations(rt.session, user_id, card, limit)

    @app.get("/v1/users/{user_id}/agents/conversation")
    def agents_conversation(user_id: uuid.UUID, id: str = Query(..., max_length=120), rt: Runtime = Depends(get_rt)):
        """One past conversation, message by message."""
        from pga.agents import history
        user_or_404(rt, user_id)
        return {"id": id, "messages": history.messages(rt.session, user_id, id)}

    # ---------------------------------------------------------------- an aim's team and your corrections (teams.py)

    def aim_or_404(rt: Runtime, aim_id: uuid.UUID):
        from pga.db.models import Aim
        a = rt.session.get(Aim, aim_id)
        if a is None:
            raise HTTPException(404, "aim not found")
        return a

    def team_view(rt: Runtime, aim) -> dict:
        from pga.teams import ORDER, ROLES, TeamService
        ts = TeamService(rt)
        notes = ts.notes(aim, 80)
        return {"aim_id": str(aim.id), "auto": bool((aim.team or {}).get("auto")), "roster": ts.roster(aim),
                "roles": {r: {"label": ROLES[r]["label"], "does": ROLES[r]["en"]} for r in ORDER},
                "agents": sorted(ts.pool.adapters),
                "notes": [{"id": str(n.id), "kind": n.kind, "role": n.role, "agent": n.agent, "text": n.text, "status": n.status,
                           "data": n.data, "round_id": str(n.round_id) if n.round_id else None, "at": n.created_at.isoformat()} for n in notes],
                "running": [j.kind for j in rt.session.scalars(select(Job).where(
                    Job.kind.in_(["team.round", "aim.revise"]), Job.user_id == aim.user_id,
                    Job.status.in_([JobStatus.QUEUED, JobStatus.RUNNING]))) if (j.payload or {}).get("aim_id") == str(aim.id)]}

    @app.get("/v1/aims/{aim_id}/team")
    def aim_team(aim_id: uuid.UUID, rt: Runtime = Depends(get_rt)):
        """The aim's team (who plays which role), its board (corrections, plans, work, reviews, reports)."""
        return team_view(rt, aim_or_404(rt, aim_id))

    @app.put("/v1/aims/{aim_id}/team")
    def aim_team_set(aim_id: uuid.UUID, body: dict, rt: Runtime = Depends(get_rt)):
        """Pin a role to an agent ({"role", "agent"}; agent null = automatic), or let the team meet on its own ({"auto"})."""
        from pga.teams import TeamError, TeamService
        aim = aim_or_404(rt, aim_id)
        if "auto" in body:
            aim.team = {**(aim.team or {}), "auto": bool(body["auto"])}
        if body.get("role"):
            try:
                TeamService(rt).set_member(aim, str(body["role"]), body.get("agent") or None)
            except TeamError as exc:
                raise HTTPException(422, str(exc)) from exc
        rt.session.flush()
        return team_view(rt, aim)

    @app.post("/v1/aims/{aim_id}/team/round", status_code=202)
    def aim_team_round(aim_id: uuid.UUID, rt: Runtime = Depends(get_rt)):
        """Hold a round now: the lead plans, the members work, the reviewer reviews, the lead reports."""
        aim = aim_or_404(rt, aim_id)
        job = rt.workflow.enqueue("team.round", user_id=aim.user_id, payload={"aim_id": str(aim.id)}, dedupe_key=f"team:{aim.id}",
                                  priority=60, created_by=Origin.USER)
        return job_out(job)

    @app.post("/v1/aims/{aim_id}/corrections", status_code=201)
    def aim_correct(aim_id: uuid.UUID, body: dict, rt: Runtime = Depends(get_rt)):
        """Your own idea or correction to the aim: it counts at once; the lead then works out what should change."""
        from pga.teams import TeamError, TeamService
        aim = aim_or_404(rt, aim_id)
        u = user_or_404(rt, aim.user_id)
        text = str(body.get("text") or "").strip()[:4000]
        try:
            note = TeamService(rt).add_correction(aim, text, canonical(rt, u, text)[0] if text else "")
        except TeamError as exc:
            raise HTTPException(422, str(exc)) from exc
        rt.workflow.enqueue("aim.revise", user_id=aim.user_id, payload={"note_id": str(note.id), "aim_id": str(aim.id)}, priority=55,
                            created_by=Origin.USER)
        relayer(rt, u, f"aim:{aim.id}")
        return team_view(rt, aim)

    @app.post("/v1/aims/{aim_id}/corrections/{note_id}/apply")
    def aim_correct_apply(aim_id: uuid.UUID, note_id: uuid.UUID, body: dict, rt: Runtime = Depends(get_rt)):
        """Apply one change the lead proposed for a correction (pause, resume, complete, a new responsibility) — as you."""
        from pga.db.models import AimNote
        from pga.teams import TeamError, TeamService
        aim = aim_or_404(rt, aim_id)
        note = rt.session.get(AimNote, note_id)
        if note is None or note.aim_id != aim.id:
            raise HTTPException(404, "correction not found")
        try:
            TeamService(rt).apply_proposal(aim, note, int(body.get("index", -1)))
        except (TeamError, ValueError) as exc:
            raise HTTPException(422, str(exc)) from exc
        return team_view(rt, aim)

    # ---------------------------------------------------------------- perpetual tasks (永续任务)

    def perpetual_view(rt: Runtime, aim) -> dict:
        from pga.db.models import AimNote, PerpetualTask
        from pga.perpetual import Perpetual
        t = rt.session.scalar(select(PerpetualTask).where(PerpetualTask.aim_id == aim.id))
        if t is None:
            return {"task": None}
        eng = Perpetual(rt)
        notes = list(rt.session.scalars(select(AimNote).where(AimNote.aim_id == aim.id, AimNote.kind.in_(
            ["question", "answer", "insight", "evolve", "reflect"])).order_by(AimNote.created_at.desc()).limit(120)))
        note = lambda n: {"id": str(n.id), "kind": n.kind, "status": n.status, "text": n.text, "role": n.role, "agent": n.agent,  # noqa: E731
                          "data": n.data or {}, "at": n.created_at.isoformat()}
        return {"task": eng.out(t), "questions": [note(n) for n in notes if n.kind == "question"],
                "findings": [note(n) for n in notes if n.kind != "question"][:40]}

    @app.get("/v1/users/{user_id}/perpetual")
    def perpetual_list(user_id: uuid.UUID, rt: Runtime = Depends(get_rt)):
        from pga.db.models import PerpetualTask
        from pga.perpetual import Perpetual
        user_or_404(rt, user_id)
        eng = Perpetual(rt)
        return [eng.out(t) for t in rt.session.scalars(select(PerpetualTask).where(PerpetualTask.user_id == user_id)
                                                        .order_by(PerpetualTask.created_at))]

    @app.get("/v1/aims/{aim_id}/perpetual")
    def perpetual_get(aim_id: uuid.UUID, rt: Runtime = Depends(get_rt)):
        """The aim as a perpetual task: what it is doing now, its pressure, rest and quota, its questions and findings."""
        return perpetual_view(rt, aim_or_404(rt, aim_id))

    @app.post("/v1/aims/{aim_id}/perpetual", status_code=201)
    def perpetual_start(aim_id: uuid.UUID, body: dict, rt: Runtime = Depends(get_rt)):
        """Make the aim a perpetual task (or restart it): its team works on it without stopping, paced by pressure."""
        from pga.perpetual import Perpetual
        from pga.projects import ProjectError, Projects
        aim = aim_or_404(rt, aim_id)
        u = user_or_404(rt, aim.user_id)
        if (u.preferences or {}).get("demo"):
            raise HTTPException(403, "a demo account cannot run perpetual tasks")
        proj = None
        if body.get("project_id"):
            try:
                proj = Projects(rt.session).get(u.id, uuid.UUID(str(body["project_id"])))
            except (ProjectError, ValueError) as exc:
                raise HTTPException(404, str(exc)) from exc
        Perpetual(rt).create(u, aim, proj, settings=body.get("settings") or {})
        return perpetual_view(rt, aim)

    @app.patch("/v1/aims/{aim_id}/perpetual")
    def perpetual_patch(aim_id: uuid.UUID, body: dict, rt: Runtime = Depends(get_rt)):
        """Pause, resume or stop it; change its settings (rest share, quota reserve, whether it may evolve code)."""
        from pga.db.models import PerpetualTask
        from pga.perpetual import DEFAULTS, Perpetual
        aim = aim_or_404(rt, aim_id)
        t = rt.session.scalar(select(PerpetualTask).where(PerpetualTask.aim_id == aim.id))
        if t is None:
            raise HTTPException(404, "this aim is not a perpetual task")
        eng = Perpetual(rt)
        if body.get("status"):
            try:
                eng.set_status(t, str(body["status"]))
            except ValueError as exc:
                raise HTTPException(422, "status is running, paused or stopped") from exc
        if isinstance(body.get("settings"), dict):
            new = {k: v for k, v in body["settings"].items() if k in DEFAULTS}
            if "max_rest_ratio" in new:
                new["max_rest_ratio"] = max(0.0, min(0.1, float(new["max_rest_ratio"])))     # never more than 10%
            if "reserve" in new:
                new["reserve"] = max(0.0, min(0.9, float(new["reserve"])))
            t.settings = {**(t.settings or {}), **new}
        rt.session.flush()
        return perpetual_view(rt, aim)

    @app.post("/v1/aims/{aim_id}/perpetual/answer")
    def perpetual_answer(aim_id: uuid.UUID, body: dict, rt: Runtime = Depends(get_rt)):
        """Answer a question it asked you; the answer becomes your guidance on the aim."""
        from pga.db.models import AimNote, PerpetualTask
        from pga.perpetual import Perpetual
        aim = aim_or_404(rt, aim_id)
        u = user_or_404(rt, aim.user_id)
        t = rt.session.scalar(select(PerpetualTask).where(PerpetualTask.aim_id == aim.id))
        try:
            n = rt.session.get(AimNote, uuid.UUID(str(body.get("note_id"))))
        except ValueError:
            n = None
        if t is None or n is None or n.aim_id != aim.id or n.kind != "question":
            raise HTTPException(404, "question not found")
        text = str(body.get("text") or "").strip()[:4000]
        if not text:
            if body.get("drop"):
                n.status = "dropped"
                rt.session.flush()
                return perpetual_view(rt, aim)
            raise HTTPException(422, "an answer needs some words")
        Perpetual(rt).answer(t, n, text, canonical(rt, u, text)[0])
        relayer(rt, u, f"aim:{aim.id}")
        return perpetual_view(rt, aim)

    _ = FactType  # re-exported for OpenAPI enum docs
    return app


app = create_app()
