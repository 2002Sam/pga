"""HTTP API (services/api in the spec's layout).

Phase 1 has no authentication: run it single-tenant on a trusted network.
Every endpoint here acts as the USER, except /events, which ingests external
content (Origin.EXTERNAL) that can raise tension but never change goals.
"""

from __future__ import annotations

import logging
import uuid
from collections.abc import Callable, Iterator
from contextlib import asynccontextmanager
from typing import Any

from fastapi import Depends, FastAPI, HTTPException, Query, Request
from fastapi.responses import JSONResponse
from sqlalchemy import select
from sqlalchemy.orm import Session, sessionmaker
from sqlalchemy.orm.exc import StaleDataError

from pga import permissions
from pga.allocator import AllocationError, RunRequest
from pga.api import schemas as sc
from pga.chat import chat_turn
from pga.config import get_policy
from pga.db.models import Message, Responsibility, Run, User
from pga.db.session import get_sessionmaker
from pga.db.types import FactType, Origin, ResponsibilityStatus
from pga.llm import UsageContext
from pga.responsibility import (
    LimitExceeded, PermissionDenied, PromotionError, ResponsibilityError, TransitionError,
)
from pga.runtime import Runtime
from pga.situation import SituationError
from pga.tension import IncomingEvidence, Signals
from pga.translation import GlossaryService

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
                             (AllocationError, 422), (ResponsibilityError, 422)]:
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

    # ---------------------------------------------------------------- health

    @app.get("/healthz")
    def healthz() -> dict:
        p = get_policy()
        return {"ok": True, "llm_provider": p.llm.provider}

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
        turn = chat_turn(rt, u, body.text, body.conversation_id)
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
            id=r.id, parent_id=r.parent_id, title_en=r.title_en, title_display=r.raw_title or r.title_en,
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
        for k in ("priority_bias", "wake_threshold", "sleep_threshold", "compute_budget", "next_review_at"):
            v = getattr(body, k)
            if v is not None:
                fields[k] = v
        rt.responsibilities.update(r, actor=Origin.USER, **fields)
        return r_out(r)

    @app.post("/v1/responsibilities/{rid}/actions/{op}", response_model=sc.ResponsibilityOut)
    def responsibility_action(rid: uuid.UUID, op: str, body: sc.ActionIn | None = None, rt: Runtime = Depends(get_rt)):
        r = resp_or_404(rt, rid)
        rt.tension.decay(r)
        rt.responsibilities.transition(r, op, actor=Origin.USER, reason=(body.reason if body else ""))
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

    _ = FactType  # re-exported for OpenAPI enum docs
    return app


app = create_app()
