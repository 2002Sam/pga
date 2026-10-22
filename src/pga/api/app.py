"""HTTP API (services/api in the spec's layout).

Phase 1 has no authentication: run it single-tenant on a trusted network.
Every endpoint here acts as the USER, except /events, which ingests external
content (Origin.EXTERNAL) that can raise tension but never change goals.
"""

from __future__ import annotations

import logging
import math
import os
import re
import threading
import urllib.parse
import uuid
from datetime import datetime, timedelta, timezone
from pathlib import Path
from collections.abc import Callable, Iterator
from contextlib import asynccontextmanager
from typing import Any

from fastapi import Depends, FastAPI, HTTPException, Query, Request
from fastapi import Path as Path_
from fastapi.responses import FileResponse, JSONResponse, RedirectResponse, Response
from sqlalchemy import func, or_, select
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


VENDOR_ADAPTER = {"claude_code": "claude_local", "chatgpt": "codex_local", "codex": "codex_local", "hermes": "hermes_local",
                  "workbuddy": "codebuddy_local", "codebuddy": "codebuddy_local", "gemini": "gemini_local"}


CONV_GAP = timedelta(hours=2)            # a pause longer than this starts a new conversation


def _conversation_planets(rt, u, add, links, nodes, aim_ids, now) -> None:
    """Each conversation is a small planet: your recent talks orbit the model you talked to; the questions a
    motivation's agents are discussing orbit its black hole, tied to the agents that asked and answered them."""
    from datetime import timedelta as _td

    from pga.db.models import AgentRun, AimNote
    try:
        from pga.agents.pool import load as _load_pool
        adapters = {n: (a or {}).get("adapter") for n, a in (_load_pool().get("agents") or {}).items()}
    except Exception:  # noqa: BLE001 - no pool config: no planets for it
        adapters = {}
    model_node = {}                                              # pool agent → the octahedron of the model it runs
    for n in nodes:
        if n.get("kind") == "ai":
            for name, ad in adapters.items():
                if VENDOR_ADAPTER.get(n.get("vendor")) == ad:
                    model_node.setdefault(name, n["id"])
    since = now - _td(hours=48)
    convs: dict[str, dict] = {}
    for r in rt.session.scalars(select(AgentRun).where(AgentRun.user_id == u.id, AgentRun.parent_id.is_(None),
                                                       AgentRun.workflow == "ask", AgentRun.started_at >= since)
                                .order_by(AgentRun.started_at.desc()).limit(200)):
        cid = (r.data or {}).get("conversation") or f"run:{r.id}"
        c = convs.setdefault(cid, {"agent": (r.data or {}).get("agent") or r.agent, "title": " ".join((r.prompt or "").split())[:60],
                                   "turns": 0, "at": r.started_at, "folder": ((r.data or {}).get("project") or {}).get("id")})
        c["turns"] += 1
        c["title"] = " ".join((r.prompt or "").split())[:60] or c["title"]       # the first thing you said
    for cid, c in list(convs.items())[:14]:
        parent = model_node.get(c["agent"], "you")
        add({"id": f"cv:{cid}"[:180], "kind": "conv", "label": c["title"] or "对话", "agent": c["agent"], "parent": parent,
             "conversation": cid, "turns": c["turns"], "at": c["at"].isoformat()})
        links.append({"source": parent, "target": f"cv:{cid}"[:180], "kind": "conv"})
        if c.get("folder"):                                      # it worked in this folder
            links.append({"source": f"cv:{cid}"[:180], "target": f"fd:{c['folder']}", "kind": "rel", "rel": "references"})
    # the agents' self-dialogue: one planet per continuous conversation (questions less than CONV_GAP apart), not per question
    qs = list(rt.session.scalars(select(AimNote).where(AimNote.user_id == u.id, AimNote.kind == "question",
                                                       AimNote.aim_id.in_(aim_ids) if aim_ids else AimNote.id.is_(None))
                                 .order_by(AimNote.aim_id, AimNote.created_at)))
    sessions: list[list] = []
    for q in qs:
        if sessions and sessions[-1][-1].aim_id == q.aim_id and q.created_at - sessions[-1][-1].created_at <= CONV_GAP:
            sessions[-1].append(q)
        else:
            sessions.append([q])
    per_aim: dict = {}
    for sess in sorted(sessions, key=lambda x: x[-1].created_at, reverse=True):
        aim_id = sess[0].aim_id
        if per_aim.get(aim_id, 0) >= 6:                          # the latest few conversations of each motivation
            continue
        per_aim[aim_id] = per_aim.get(aim_id, 0) + 1
        first, last = sess[0], sess[-1]
        qid = f"cq:{first.id}"
        open_n = sum(q.status in ("open", "for_you") for q in sess)
        agents = sorted({a for q in sess for a in (q.agent, (q.data or {}).get("answered_by")) if a and a != "you"})
        add({"id": qid, "kind": "conv", "label": first.text[:80], "parent": f"aim:{aim_id}", "turns": len(sess),
             "open": open_n, "agents": agents, "at": last.created_at.isoformat(), "question": str(first.id),
             "status": "open" if open_n else "answered", "codes": [(q.data or {}).get("code") for q in sess][:40]})
        for who in agents:                                       # the agents who took part
            if who in model_node:
                links.append({"source": model_node[who], "target": qid, "kind": "talk"})

    # what the agents found out is not drawn piece by piece: it is curated into the motivation's knowledge dataset


SOURCE = {"claude_code": "claude", "codebuddy": "claude", "workbuddy": "claude", "codex": "codex", "hermes": "hermes"}


def run_steps(run) -> dict | None:
    """How one of PGA's agent runs went step by step (secrets redacted), when its agent kept the session."""
    from pga.hub.connectors import redact_how
    from pga.hub.steps import run_how
    h = run_how(run)
    return redact_how(h) if h and h.get("steps") else None


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

    WEB = Path(__file__).resolve().parent.parent / "web"

    @app.get("/", include_in_schema=False)
    def web_app() -> FileResponse:
        """PGA: the trees as bars on the left; a tree beside its dialogue; everyday chats; the two models and the library."""
        return FileResponse(WEB / "app.html")

    # the pages before the forest, kept as they were (the old workbench embeds the old sky as its map)
    @app.get("/archive/console", include_in_schema=False)
    def web_archive_console() -> FileResponse:
        return FileResponse(WEB / "archive" / "console.html")

    @app.get("/archive/sky", include_in_schema=False)
    def web_archive_sky() -> FileResponse:
        return FileResponse(WEB / "archive" / "sky.html")

    @app.get("/console", include_in_schema=False)
    def web_console(request: Request):
        """Old links to the workbench land on its archived copy."""
        return RedirectResponse("/archive/console" + (f"?{request.url.query}" if request.url.query else ""))

    @app.get("/forest", include_in_schema=False)
    def web_forest(request: Request):
        return RedirectResponse("/" + (f"?{request.url.query}" if request.url.query else ""))

    @app.get("/agents", include_in_schema=False)
    def web_agents() -> FileResponse:
        """The agents PGA works with: connections, quota, what each is doing, and who gets each kind of work first."""
        return FileResponse(WEB / "agents.html")

    @app.get("/tree", include_in_schema=False)
    def web_tree(request: Request):
        """Old links to a tree open it in the app."""
        q = dict(request.query_params)
        tree = "you" if q.pop("you", None) else q.pop("aim", "")
        from urllib.parse import urlencode
        return RedirectResponse("/?" + urlencode({**({"tree": tree} if tree else {}), **q}))

    @app.get("/ui/{name}", include_in_schema=False)
    def web_script(name: str) -> FileResponse:
        f = WEB / name
        if "/" in name or name.startswith(".") or not name.endswith((".js", ".css")) or not f.is_file():
            raise HTTPException(404, "no such script")
        return FileResponse(f, media_type="text/css" if name.endswith(".css") else "text/javascript", headers={"Cache-Control": "no-cache"})

    @app.get("/v1/version", include_in_schema=False)
    def web_version() -> dict:
        """Which page the browser should be running: open pages compare it and refresh themselves when it changes."""
        fs = [WEB / "app.html", WEB / "app.css", WEB / "skins.css", WEB / "shell.js", WEB / "tree.js", *sorted(WEB.glob("app-*.js"))]
        sts = [f.stat() for f in fs if f.is_file()]
        return {"ui": f"{int(max(x.st_mtime for x in sts))}-{sum(x.st_size for x in sts)}"}

    ICONS = Path(__file__).resolve().parent.parent / "web" / "icons"

    @app.get("/icons/{name}", include_in_schema=False)
    def web_icon(name: str) -> FileResponse:
        f = ICONS / name
        if "/" in name or name.startswith(".") or not f.is_file():
            raise HTTPException(404, "no such icon")
        return FileResponse(f, headers={"Cache-Control": "public, max-age=86400"})

    @app.get("/manifest.webmanifest", include_in_schema=False)
    def web_manifest() -> JSONResponse:
        """So the app installed from the browser (and its Dock icon) gets the real icon, not a letter."""
        return JSONResponse({"name": "PGA 助理", "short_name": "PGA", "start_url": "/", "scope": "/", "display": "standalone",
                             "background_color": "#05070b", "theme_color": "#0b0f16",
                             "icons": [{"src": "/icons/icon-192.png?v=3", "sizes": "192x192", "type": "image/png"},
                                       {"src": "/icons/icon-512.png?v=3", "sizes": "512x512", "type": "image/png"}]},
                            media_type="application/manifest+json")

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

    # ---------------------------------------------------------------- 世界树: every conversation in one hierarchy of topics (pga.worldtree)
    WORLD_BUILD: dict[str, dict] = {}
    INPUTS_INDEX: dict[str, dict] = {}

    def world_node_or_404(rt, u, node_id):
        from pga.worldtree import WorldTree
        n = WorldTree(rt).get(u, node_id)
        if n is None:
            raise HTTPException(404, "no such topic")
        return n

    PLACING: dict[str, float] = {}

    def place_soon(uid: uuid.UUID, delay: float = 20.0) -> None:
        """A conversation just got a question: in a moment (once the answer is in) it is placed in the world tree."""
        import threading
        import time as _t
        key = str(uid)
        if _t.time() - PLACING.get(key, 0) < 15:
            return
        PLACING[key] = _t.time()
        sm = factory()

        def run() -> None:
            _t.sleep(delay)
            from pga.worldtree import WorldTree, WorldTreeDeferred
            with sm() as s2:
                try:
                    rt2 = make_runtime(s2)
                    user = s2.get(User, uid)
                    wt = WorldTree(rt2)
                    if user is not None and wt.built(user):
                        wt.place(user, limit=20)
                        s2.commit()
                except WorldTreeDeferred:
                    s2.rollback()
                except Exception:  # noqa: BLE001
                    log.exception("placing a new conversation failed")
                    s2.rollback()
        threading.Thread(target=run, daemon=True, name="pga-world-place").start()

    @app.get("/v1/users/{user_id}/world")
    def world_tree(user_id: uuid.UUID, rt: Runtime = Depends(get_rt)):
        from pga.worldtree import WorldTree
        u = user_or_404(rt, user_id)
        return {**WorldTree(rt).out(u), "building": WORLD_BUILD.get(str(u.id))}

    @app.post("/v1/users/{user_id}/world/build", status_code=202)
    def world_build(user_id: uuid.UUID, rt: Runtime = Depends(get_rt)):
        """Build the world tree from all your conversations (a model groups them and summarises each topic). Runs in the
        background; GET /world shows how far it is."""
        import threading
        u = user_or_404(rt, user_id)
        key = str(u.id)
        if (WORLD_BUILD.get(key) or {}).get("state") == "running":
            return WORLD_BUILD[key]
        WORLD_BUILD[key] = {"state": "running", "step": "start", "done": 0, "total": 0, "at": utcnow().isoformat()}
        sm = factory()

        def run() -> None:
            from pga.worldtree import WorldTree, WorldTreeDeferred
            def say(step, done, total):
                WORLD_BUILD[key].update(step=step, done=done, total=total)
            with sm() as s2:
                rt2 = make_runtime(s2)
                try:
                    user = s2.get(type(u), u.id)
                    with rt2.billing(user_ctx(user)):
                        r = WorldTree(rt2).build(user, progress=say)
                    s2.commit()
                    WORLD_BUILD[key].update(state="done", result=r)
                except WorldTreeDeferred as exc:
                    s2.rollback()
                    WORLD_BUILD[key].update(state="deferred", error=str(exc))
                except Exception as exc:  # noqa: BLE001
                    log.exception("world tree build failed")
                    s2.rollback()
                    WORLD_BUILD[key].update(state="error", error=str(exc)[:300])
        threading.Thread(target=run, daemon=True, name="pga-world-build").start()
        return WORLD_BUILD[key]

    @app.post("/v1/users/{user_id}/world/place")
    def world_place(user_id: uuid.UUID, rt: Runtime = Depends(get_rt)):
        """New conversations to their place now (it also happens on its own every few minutes), and stale summaries rewritten."""
        from pga.worldtree import WorldTree, WorldTreeDeferred
        u = user_or_404(rt, user_id)
        wt = WorldTree(rt)
        try:
            with rt.billing(user_ctx(u)):
                return {**wt.place(u), **wt.refresh(u, limit=24)}
        except WorldTreeDeferred as exc:
            raise HTTPException(429, str(exc)) from exc

    @app.patch("/v1/world/{node_id}")
    def world_edit(node_id: uuid.UUID, body: dict, rt: Runtime = Depends(get_rt)):
        """Rename a topic, or move a topic or conversation under another topic."""
        from pga.db.models import WorldNode
        from pga.worldtree import WorldTree
        n0 = rt.session.get(WorldNode, node_id)
        if n0 is None:
            raise HTTPException(404, "no such topic")
        u = user_or_404(rt, n0.user_id)
        wt = WorldTree(rt)
        wt.edit(u, n0, title=str(body.get("title") or "") or None,
                summary=str(body["summary"]) if "summary" in body else None, gist=str(body["gist"]) if "gist" in body else None)
        if body.get("parent"):
            try:
                wt.move(u, n0, world_node_or_404(rt, u, uuid.UUID(str(body["parent"]))))
            except ValueError as exc:
                raise HTTPException(422, str(exc)) from exc
        rt.session.flush()
        return {"id": str(n0.id), "title": n0.title, "parent": str(n0.parent_id) if n0.parent_id else None}

    @app.post("/v1/world/{node_id}/children", status_code=201)
    def world_add(node_id: uuid.UUID, body: dict, rt: Runtime = Depends(get_rt)):
        """A topic you add by hand, under this one."""
        from pga.db.models import WorldNode
        from pga.worldtree import WorldTree
        n0 = rt.session.get(WorldNode, node_id)
        if n0 is None or n0.kind == "leaf":
            raise HTTPException(404, "no such topic")
        title = str(body.get("title") or "").strip()
        if not title:
            raise HTTPException(422, "a title is needed")
        m = WorldTree(rt).add_topic(user_or_404(rt, n0.user_id), n0, title, str(body.get("summary") or ""))
        return {"id": str(m.id), "title": m.title}

    @app.delete("/v1/world/{node_id}")
    def world_remove(node_id: uuid.UUID, rt: Runtime = Depends(get_rt)):
        """A topic goes (its parts move up a level); a conversation leaves the tree (it stays in 所有对话)."""
        from pga.db.models import WorldNode
        from pga.worldtree import WorldTree
        n0 = rt.session.get(WorldNode, node_id)
        if n0 is None:
            raise HTTPException(404, "no such topic")
        try:
            return WorldTree(rt).remove(user_or_404(rt, n0.user_id), n0)
        except ValueError as exc:
            raise HTTPException(422, str(exc)) from exc

    @app.get("/v1/users/{user_id}/world/search")
    def world_search(user_id: uuid.UUID, q: str = Query(..., min_length=1, max_length=200), rt: Runtime = Depends(get_rt)):
        from pga.worldtree import WorldTree
        u = user_or_404(rt, user_id)
        wt = WorldTree(rt)
        return [{"id": str(n.id), "title": n.title, "kind": n.kind, "gist": (n.data or {}).get("gist"), "summary": n.summary[:200],
                 "path": " › ".join(x.title for x in wt.path(n)[1:-1])} for n in wt.search(u, q)]

    @app.post("/v1/world/{node_id}/expand")
    def world_expand(node_id: uuid.UUID, rt: Runtime = Depends(get_rt)):
        """Grow a topic one level down: directions worth taking next, as planned subtopics."""
        from pga.db.models import WorldNode
        from pga.worldtree import WorldTree, WorldTreeDeferred
        n0 = rt.session.get(WorldNode, node_id)
        if n0 is None:
            raise HTTPException(404, "no such topic")
        u = user_or_404(rt, n0.user_id)
        try:
            with rt.billing(user_ctx(u)):
                made = WorldTree(rt).expand(u, n0)
        except WorldTreeDeferred as exc:
            raise HTTPException(429, str(exc)) from exc
        return [{"id": str(m.id), "title": m.title, "summary": m.summary} for m in made]

    @app.get("/v1/world/{node_id}/context")
    def world_context(node_id: uuid.UUID, q: str = "", rt: Runtime = Depends(get_rt)):
        """What an agent reads when you talk to this topic."""
        from pga.db.models import WorldNode
        from pga.worldtree import WorldTree
        n0 = rt.session.get(WorldNode, node_id)
        if n0 is None:
            raise HTTPException(404, "no such topic")
        return {"context": WorldTree(rt).context(n0, q)}

    # ---------------------------------------------------------------- the finest level: segments, the data tree, every question
    @app.get("/v1/world/{node_id}/detail")
    def world_detail(node_id: uuid.UUID, split: bool = True, rt: Runtime = Depends(get_rt)):
        """A conversation in the world tree, in full: your questions, the segments they fall into (worked out once and
        kept), and its data tree (what it read, cited and did)."""
        from pga import segments as sg
        from pga.db.models import WorldNode
        n = rt.session.get(WorldNode, node_id)
        if n is None:
            raise HTTPException(404, "no such node")
        u = rt.session.get(User, n.user_id)
        if n.kind != "leaf":
            raise HTTPException(422, "only a conversation has segments")
        qs = sg.questions(rt, u, n.ref)
        with rt.billing(user_ctx(u)):
            segs = sg.segments(rt, u, n, qs, use_model=split)               # split=false: only what was worked out before
        rt.session.commit()
        return {"id": str(n.id), "ref": n.ref, "title": n.title, "questions": qs, "segments": segs,
                "context": sg.context(rt, u, n.ref) if split else None}

    @app.get("/v1/users/{user_id}/inputs-index")
    def inputs_index_get(user_id: uuid.UUID, rt: Runtime = Depends(get_rt)):
        from pga import segments as sg
        u = user_or_404(rt, user_id)
        p = sg.INDEX_DIR / f"{u.id}.md"
        return {**(INPUTS_INDEX.get(str(u.id)) or {}), "path": str(p), "exists": p.exists(),
                "updated": datetime.fromtimestamp(p.stat().st_mtime).isoformat() if p.exists() else None}

    @app.post("/v1/users/{user_id}/inputs-index", status_code=202)
    def inputs_index_build(user_id: uuid.UUID, rt: Runtime = Depends(get_rt)):
        """Write every question you asked into one file (notes/inputs/<you>.md), by topic, conversation and segment."""
        import threading
        u = user_or_404(rt, user_id)
        key = str(u.id)
        if (INPUTS_INDEX.get(key) or {}).get("state") == "running":
            return INPUTS_INDEX[key]
        INPUTS_INDEX[key] = {"state": "running"}
        sm = factory()

        def run() -> None:
            from pga import segments as sg
            with sm() as s2:
                try:
                    rt2 = make_runtime(s2)
                    INPUTS_INDEX[key] = {"state": "done", **sg.build_index(rt2, s2.get(User, u.id))}
                    s2.commit()
                except Exception as exc:  # noqa: BLE001
                    log.exception("the questions index failed")
                    s2.rollback()
                    INPUTS_INDEX[key] = {"state": "error", "error": str(exc)[:300]}
        threading.Thread(target=run, daemon=True, name="pga-inputs-index").start()
        return INPUTS_INDEX[key]

    # ---------------------------------------------------------------- 无限画布 (pga.canvas) and the notepad (pga.pad)
    @app.get("/v1/users/{user_id}/canvas")
    def canvas_board(user_id: uuid.UUID, world: str = "top", rt: Runtime = Depends(get_rt)):
        """The board for a topic of the world tree (`world` = its id, or "top"): made from the tree the first time."""
        from pga.canvas import Boards, CanvasError
        u = user_or_404(rt, user_id)
        try:
            b = Boards(rt)
            c = b.board(u, world)
            rt.session.commit()
            return b.out(u, c)
        except CanvasError as exc:
            raise HTTPException(404, str(exc)) from exc

    @app.put("/v1/users/{user_id}/canvas/{canvas_id}")
    def canvas_save(user_id: uuid.UUID, canvas_id: uuid.UUID, body: dict, rt: Runtime = Depends(get_rt)):
        from pga.canvas import Boards, CanvasConflict, CanvasError
        u = user_or_404(rt, user_id)
        try:
            c = Boards(rt).save(u, canvas_id, body.get("data"), body.get("rev"))
            rt.session.commit()
            return {"rev": c.rev}
        except CanvasConflict as exc:
            raise HTTPException(409, str(exc)) from exc
        except CanvasError as exc:
            raise HTTPException(422, str(exc)) from exc

    @app.post("/v1/users/{user_id}/canvas/merge")
    def canvas_merge(user_id: uuid.UUID, body: dict, rt: Runtime = Depends(get_rt)):
        """The output node: what its branches said, merged into one answer."""
        from pga.agents.council import CouncilError
        from pga.canvas import Boards, CanvasError
        u = user_or_404(rt, user_id)
        try:
            with rt.billing(user_ctx(u)):
                text = Boards(rt).merge(u, str(body.get("question") or ""), [p for p in body.get("parts") or [] if isinstance(p, dict)])
            rt.session.commit()
            return {"text": text}
        except (CanvasError, CouncilError) as exc:
            raise HTTPException(422, str(exc)) from exc

    @app.get("/v1/users/{user_id}/canvas-palette")
    def canvas_palette(user_id: uuid.UUID, rt: Runtime = Depends(get_rt)):
        """What can become a node besides conversations: the skills on this machine and the pictures you uploaded."""
        from pga import canvas
        user_or_404(rt, user_id)
        return {"skills": canvas.skills(), "images": canvas.images()}

    @app.get("/v1/users/{user_id}/canvas-skill")
    def canvas_skill(user_id: uuid.UUID, path: str, rt: Runtime = Depends(get_rt)):
        from pga import canvas
        user_or_404(rt, user_id)
        try:
            return canvas.skill_text(path)
        except canvas.CanvasError as exc:
            raise HTTPException(404, str(exc)) from exc

    @app.get("/v1/users/{user_id}/canvas-image")
    def canvas_image(user_id: uuid.UUID, path: str, rt: Runtime = Depends(get_rt)):
        from pga import canvas
        user_or_404(rt, user_id)
        try:
            return FileResponse(canvas.image_path(path), headers={"Cache-Control": "private, max-age=3600"})
        except canvas.CanvasError as exc:
            raise HTTPException(404, str(exc)) from exc

    @app.get("/v1/users/{user_id}/pad")
    def pad_read(user_id: uuid.UUID, rt: Runtime = Depends(get_rt)):
        from pga import pad
        u = user_or_404(rt, user_id)
        return pad.read(u.id)

    @app.put("/v1/users/{user_id}/pad")
    def pad_write(user_id: uuid.UUID, body: dict, rt: Runtime = Depends(get_rt)):
        """Keep the notepad as you wrote it (a Markdown file), and which of its ideas went to which agent."""
        from pga import pad
        u = user_or_404(rt, user_id)
        try:
            return pad.write(u.id, body["text"] if isinstance(body.get("text"), str) else None, body.get("rev"),
                             body["sent"] if isinstance(body.get("sent"), list) else None)
        except pad.PadConflict as exc:
            raise HTTPException(409, str(exc)) from exc
        except ValueError as exc:
            raise HTTPException(422, str(exc)) from exc

    @app.put("/v1/users/{user_id}/chat-world")
    def chat_world_set(user_id: uuid.UUID, body: dict, rt: Runtime = Depends(get_rt)):
        """Which level a conversation talks to: itself (node empty), or a topic above it in the world tree."""
        from pga.worldtree import set_chat_node
        u = user_or_404(rt, user_id)
        key = str(body.get("key") or "")[:120]
        if not key:
            raise HTTPException(422, "key is needed")
        node = str(body.get("node") or "") or None
        if node:
            world_node_or_404(rt, u, uuid.UUID(node))
        set_chat_node(u, key, node)
        rt.session.flush()
        return {"key": key, "node": node}

    # ---------------------------------------------------------------- the fact graph (pga.kg, after graphiti)
    FACT_FILL: dict[str, dict] = {}

    @app.get("/v1/users/{user_id}/facts")
    def facts_overview(user_id: uuid.UUID, rt: Runtime = Depends(get_rt)):
        """How much is in the fact graph, the newest facts, and the ones most recently found no longer true."""
        from pga.db.models import KgEdge, KgEntity
        from pga.kg.service import FactGraph
        u = user_or_404(rt, user_id)
        fg = FactGraph(rt)
        names = {x.id: x.name for x in rt.session.scalars(select(KgEntity).where(KgEntity.user_id == u.id))}
        cur = list(rt.session.scalars(select(KgEdge).where(KgEdge.user_id == u.id, KgEdge.expired_at.is_(None), KgEdge.invalid_at.is_(None))
                                      .order_by(KgEdge.created_at.desc()).limit(20)))
        old = list(rt.session.scalars(select(KgEdge).where(KgEdge.user_id == u.id, KgEdge.expired_at.is_not(None))
                                      .order_by(KgEdge.expired_at.desc()).limit(20)))
        return {**fg.stats(u), "pending": len(fg.pending(u)), "filling": FACT_FILL.get(str(u.id)),
                "recent": [fg.out_edge(e, names) for e in cur], "superseded": [fg.out_edge(e, names) for e in old]}

    @app.get("/v1/users/{user_id}/facts/search")
    def facts_search(user_id: uuid.UUID, q: str = Query(..., min_length=1, max_length=400), history: bool = False, rt: Runtime = Depends(get_rt)):
        from pga.db.models import KgEntity
        from pga.kg.service import FactGraph
        u = user_or_404(rt, user_id)
        fg = FactGraph(rt)
        names = {x.id: x.name for x in rt.session.scalars(select(KgEntity).where(KgEntity.user_id == u.id))}
        return [fg.out_edge(e, names) for e in fg.search(u, q, k=20, current_only=not history)]

    @app.post("/v1/users/{user_id}/facts/fill", status_code=202)
    def facts_fill(user_id: uuid.UUID, body: dict, rt: Runtime = Depends(get_rt)):
        """Read your conversations into the fact graph, newest first (in the background; GET /facts shows how far)."""
        import threading
        u = user_or_404(rt, user_id)
        key = str(u.id)
        if (FACT_FILL.get(key) or {}).get("state") == "running":
            return FACT_FILL[key]
        days = int(body.get("days") or 30)
        limit = max(1, min(400, int(body.get("limit") or 60)))
        FACT_FILL[key] = {"state": "running", "done": 0, "total": 0, "now": "", "days": days}
        sm = factory()

        def run() -> None:
            from pga.kg.service import FactGraph, FactGraphDeferred
            def say(i, total, title):
                FACT_FILL[key].update(done=i, total=total, now=title[:60])
            with sm() as s2:
                rt2 = make_runtime(s2)
                user = s2.get(type(u), u.id)
                fg = FactGraph(rt2)
                try:
                    todo = fg.pending(user, since=utcnow() - timedelta(days=days))[:limit]
                    for i, x in enumerate(todo):
                        say(i, len(todo), x.get("title") or "")
                        try:
                            fg.ingest(user, x)
                            s2.commit()
                        except FactGraphDeferred as exc:
                            s2.rollback()
                            FACT_FILL[key].update(state="deferred", error=str(exc))
                            return
                        except Exception:  # noqa: BLE001 - one conversation failing does not stop the rest
                            log.exception("fact graph: %s failed", x.get("key"))
                            s2.rollback()
                    FACT_FILL[key].update(state="done", done=len(todo), total=len(todo))
                except Exception as exc:  # noqa: BLE001
                    log.exception("fact graph fill failed")
                    FACT_FILL[key].update(state="error", error=str(exc)[:300])
        threading.Thread(target=run, daemon=True, name="pga-fact-fill").start()
        return FACT_FILL[key]

    @app.get("/v1/world/{node_id}/facts")
    def world_facts(node_id: uuid.UUID, rt: Runtime = Depends(get_rt)):
        """What the conversations under this topic established: what holds now, and what no longer does (and what replaced it)."""
        from pga.db.models import KgEntity, WorldNode
        from pga.kg.service import FactGraph
        from pga.worldtree import WorldTree
        n0 = rt.session.get(WorldNode, node_id)
        if n0 is None:
            raise HTTPException(404, "no such topic")
        u = user_or_404(rt, n0.user_id)
        fg = FactGraph(rt)
        refs = [n0.ref] if n0.kind == "leaf" and n0.ref else WorldTree(rt).refs_under(n0)
        cur, old = fg.topic_facts(u, refs, 40, 20)
        names = {x.id: x.name for x in rt.session.scalars(select(KgEntity).where(KgEntity.user_id == u.id))}
        return {"current": [fg.out_edge(e, names) for e in cur], "superseded": [fg.out_edge(e, names) for e in old]}

    # ---------------------------------------------------------------- the memory graph (pga.graph)
    @app.get("/v1/users/{user_id}/memory-graph")
    def memory_graph(user_id: uuid.UUID, days: int = Query(90, ge=1, le=3650), rt: Runtime = Depends(get_rt)):
        """Everything PGA remembers about you as nodes and edges: models, motivations, lines, conversations, knowledge, agents."""
        from pga.graph import build
        return build(rt, user_or_404(rt, user_id), days)

    @app.post("/v1/users/{user_id}/memory-graph/link", status_code=201)
    def memory_graph_link(user_id: uuid.UUID, body: dict, rt: Runtime = Depends(get_rt)):
        """A line you drew on the graph: a tree and knowledge → the tree references it; two pieces of knowledge → related."""
        from pga.bodies import BodyError
        from pga.graph import link
        try:
            return link(rt, user_or_404(rt, user_id), str(body.get("a") or ""), str(body.get("b") or ""), str(body.get("note") or "")[:500])
        except BodyError as exc:
            raise HTTPException(422, str(exc)) from exc

    # ---------------------------------------------------------------- while you are away (pga.idle)
    @app.post("/v1/users/{user_id}/activity")
    def user_activity(user_id: uuid.UUID, rt: Runtime = Depends(get_rt)):
        """You are here (a click, a key, a scroll in any PGA page): what started on its own while you were away pauses."""
        from pga import idle
        return {"paused": idle.touch(rt.session, user_or_404(rt, user_id))}

    @app.get("/v1/users/{user_id}/idle")
    def user_idle(user_id: uuid.UUID, rt: Runtime = Depends(get_rt)):
        from pga import idle
        u = user_or_404(rt, user_id)
        return {**idle.cfg(u), "last": idle.state(u).get("last"),
                "auto": [{"task": str(t.id), "aim": str(t.aim_id), "since": t.settings["_idle_since"]} for t in idle.auto_tasks(rt.session, u.id)]}

    @app.put("/v1/users/{user_id}/idle")
    def user_idle_set(user_id: uuid.UUID, body: dict, rt: Runtime = Depends(get_rt)):
        """Whether your motivations start on their own while you are away, and after how many minutes."""
        from pga import idle
        u = user_or_404(rt, user_id)
        cur = idle.cfg(u)
        new = {"on": bool(body.get("on", cur["on"])), "minutes": int(body.get("minutes") or cur["minutes"])}
        u.preferences = {**(u.preferences or {}), "idle_run": new}
        rt.session.flush()
        return idle.cfg(u)

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
                "system": b.system, "compiled_at": b.compiled_at, "created_at": b.created_at}

    def bridge_out(br) -> dict:
        return {"id": br.id, "a": br.a_ref, "b": br.b_ref, "note": br.note, "kind": br.kind, "created_at": br.created_at}

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
        if b.system in ("user", "world"):
            raise HTTPException(409, "用户和世界知识库一直存在，不能删除")
        BodyService(rt).delete(b)

    @app.get("/v1/bodies/{body_id}/document")
    def body_document(body_id: uuid.UUID, lang: str = "", rt: Runtime = Depends(get_rt)):
        """A dataset as its pyramid: title, summary and the full text."""
        from pga.db.models import Body
        b = rt.session.get(Body, body_id)
        if b is None:
            raise HTTPException(404, "body not found")
        lv = rt.layers.rows([f"k:{b.id}"]).get(f"k:{b.id}", {})
        en = lang.startswith("en")
        out = {"id": b.id, "title": b.title, "system": b.system, "compiled_at": b.compiled_at,
               "gist": (lv[1].text_en if en else lv[1].text) if 1 in lv else b.title,
               "summary": (lv[2].text_en if en else lv[2].text) if 2 in lv else None,
               "full": b.description_en if en and b.description_en else b.description, "words": len((b.description_en or "").split()),
               "dims": ((b.data or {}).get("dims_en" if en else "dims")) if b.system == "user" else None}
        if en:
            from pga.i18n import translate_many
            out["title"] = translate_many(rt, [b.title], "en")[0]
        return out

    @app.post("/v1/users/{user_id}/knowledge/upload", status_code=201)
    def knowledge_upload(user_id: uuid.UUID, body: dict, rt: Runtime = Depends(get_rt)):
        """Put a document into your knowledge base (text read on this machine; nothing is sent anywhere)."""
        from pga.knowledge.uploads import UploadError, save
        u = user_or_404(rt, user_id)
        try:
            b = save(rt, u.id, str(body.get("name") or ""), str(body.get("data") or ""),
                     uuid.UUID(str(body["aim_id"])) if body.get("aim_id") else None)
        except (UploadError, ValueError) as exc:
            raise HTTPException(422, str(exc)) from exc
        return {"id": str(b.id), "title": b.title, "chars": b.data["chars"], "passages": b.data["passages"]}

    @app.put("/v1/bodies/{body_id}/facts")
    def body_facts(body_id: uuid.UUID, body: dict, rt: Runtime = Depends(get_rt)):
        """Edit the personal model yourself: add something about you, take an item out, rewrite a dimension's summary.
        What you change is kept when the model is rebuilt."""
        from pga.db.models import Body
        from pga.knowledge.datasets import DatasetError, edit_facts
        b = rt.session.get(Body, body_id)
        if b is None or b.system != "user":
            raise HTTPException(404, "not the personal model")
        try:
            return edit_facts(b, str(body.get("dim") or ""), add=body.get("add"), remove=body.get("remove"), summary=body.get("summary"))
        except DatasetError as exc:
            raise HTTPException(422, str(exc)) from exc

    @app.post("/v1/bodies/{body_id}/compile")
    def compile_body(body_id: uuid.UUID, rt: Runtime = Depends(get_rt)):
        """Rebuild a curated dataset now (you asked), instead of waiting for its turn."""
        from pga.db.models import Body
        from pga.knowledge.datasets import Datasets
        b = rt.session.get(Body, body_id)
        if b is None or not b.system:
            raise HTTPException(404, "not a curated dataset")
        u = user_or_404(rt, b.user_id)
        with rt.billing(user_ctx(u)):
            out = Datasets(rt).compile(u, b)
        return {"status": out.status, "words": out.words, "note": out.note}

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
        return bridge_out(BodyService(rt).bridge(user_id, body.a, body.b, body.note, body.kind))

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
        _conversation_planets(rt, u, add, links, nodes, aim_ids, now)

        from pga.knowledge.datasets import Datasets
        Datasets(rt).ensure(u, now)                              # 用户 and 世界 always exist
        bodies = BodyService(rt)
        for b in bodies.list(user_id):
            kid = f"k:{b.id}"
            home = "you" if b.system in ("user", "world") else f"aim:{b.aim_id}" if b.aim_id in aim_ids else default_sun
            add({"id": kid, "kind": b.kind, "label": b.title, "label_en": b.title_en,
                 "description": b.description[:240] if b.system else b.description,
                 "aim": None if home == "you" else home, "private": b.private, "system": b.system,
                 "compiled_at": b.compiled_at.isoformat() if b.compiled_at else None,
                 "origin": b.origin.value, "body_id": str(b.id)})
            if b.system:                                         # who it describes / what it was compiled from
                links.append({"source": kid, "target": home, "kind": "rel", "rel": "derived_from" if b.system == "aim" else "relates"})
        # folders: a project folder serves a motivation (beside its sun) or stays free (near you)
        from pga.projects import Projects
        for p in Projects(rt.session).list(user_id):
            t = perp.get(p.aim_id) if p.aim_id else None
            add({"id": f"fd:{p.id}", "kind": "folder", "label": p.name, "path": p.path, "project_id": str(p.id),
                 "aim": f"aim:{p.aim_id}" if p.aim_id in aim_ids else None, "full_access": p.full_access,
                 "working": bool(t and t.project_id == p.id and t.status == "running")})
            links.append({"source": f"aim:{p.aim_id}" if p.aim_id in aim_ids else "you", "target": f"fd:{p.id}", "kind": "folder"})
        for br in bodies.bridges(user_id):
            if br.a_ref in seen and br.b_ref in seen:
                links.append({"source": br.a_ref, "target": br.b_ref, "kind": "bridge", "id": str(br.id), "note": br.note, "rel": br.kind})

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

    # ---------------------------------------------------------------- 时间树: every conversation on one time axis (timeline.py)
    @app.get("/v1/users/{user_id}/timeline")
    def time_tree(user_id: uuid.UUID, days: int = Query(90, ge=1, le=730), rt: Runtime = Depends(get_rt)):
        from pga.timeline import Timeline
        return Timeline(rt).build(user_or_404(rt, user_id), days)

    @app.post("/v1/users/{user_id}/timeline/organize", status_code=202)
    def time_tree_organize(user_id: uuid.UUID, body: dict | None = None, rt: Runtime = Depends(get_rt)):
        """Tidy the loose conversations into lines: same titles join at once; a model reads the rest in the background."""
        from pga.timeline import Timeline, _prefs, _save
        u = user_or_404(rt, user_id)
        out = Timeline(rt).organize_rules(u)
        if (body or {}).get("use_model", True):
            tl = _prefs(u)
            tl["pending"] = True
            _save(u, tl)
            rt.workflow.enqueue("timeline.organize", user_id=u.id, payload={}, dedupe_key=f"timeline:{u.id}", priority=60, created_by=Origin.USER)
        return {**out, "queued": bool((body or {}).get("use_model", True))}

    @app.put("/v1/users/{user_id}/timeline/items")
    def time_tree_move(user_id: uuid.UUID, body: dict, rt: Runtime = Depends(get_rt)):
        """Put a conversation on another line (`line`), or back on its own (`line` empty)."""
        from pga.timeline import Timeline
        key = str(body.get("key") or "")[:120]
        if not key:
            raise HTTPException(422, "key is needed")
        Timeline(rt).move(user_or_404(rt, user_id), key, str(body.get("line") or "") or None)
        return {"key": key, "line": body.get("line") or None}

    @app.put("/v1/users/{user_id}/timeline/pin")
    def time_tree_pin(user_id: uuid.UUID, body: dict, rt: Runtime = Depends(get_rt)):
        """Pin a line to the top of the list (or unpin it)."""
        from pga.timeline import _prefs, _save
        u = user_or_404(rt, user_id)
        line = str(body.get("line") or "")[:120]
        if not line:
            raise HTTPException(422, "line is needed")
        tl = _prefs(u)
        pins = [x for x in tl.get("pinned") or [] if x != line]
        if body.get("pinned", True):
            pins.insert(0, line)
        tl["pinned"] = pins[:50]
        _save(u, tl)
        return {"pinned": tl["pinned"]}

    @app.put("/v1/users/{user_id}/timeline/lines")
    def time_tree_rename(user_id: uuid.UUID, body: dict, rt: Runtime = Depends(get_rt)):
        from pga.timeline import Timeline
        if not str(body.get("line") or "") or not str(body.get("title") or "").strip():
            raise HTTPException(422, "line and title are needed")
        Timeline(rt).rename(user_or_404(rt, user_id), str(body["line"])[:120], str(body["title"]))
        return {"ok": True}

    @app.get("/v1/users/{user_id}/timeline/line")
    def time_tree_line(user_id: uuid.UUID, id: str = Query(..., max_length=160), rt: Runtime = Depends(get_rt)):
        """One line, whole: its conversations in order, each with the summary your conversation tree wrote for it."""
        from pga.timeline import Timeline
        return Timeline(rt).line_detail(user_or_404(rt, user_id), id)

    @app.post("/v1/users/{user_id}/timeline/line/summarize")
    def time_tree_line_summarize(user_id: uuid.UUID, body: dict, rt: Runtime = Depends(get_rt)):
        from pga.timeline import Timeline, TimelineDeferred
        u = user_or_404(rt, user_id)
        try:
            with rt.billing(user_ctx(u)):
                return {"summary": Timeline(rt).summarize_line(u, str(body.get("id") or "")[:160])}
        except TimelineDeferred as exc:
            raise HTTPException(429, str(exc)) from exc

    @app.post("/v1/users/{user_id}/timeline/line/steps")
    def time_tree_line_steps(user_id: uuid.UUID, body: dict, rt: Runtime = Depends(get_rt)):
        """A long discussion as a tree of steps (written by a model, then kept)."""
        from pga.timeline import Timeline, TimelineDeferred
        u = user_or_404(rt, user_id)
        try:
            with rt.billing(user_ctx(u)):
                return {"steps": Timeline(rt).steps_line(u, str(body.get("id") or "")[:160])}
        except TimelineDeferred as exc:
            raise HTTPException(429, str(exc)) from exc

    @app.get("/v1/users/{user_id}/dirs/recent")
    def dirs_recent(user_id: uuid.UUID, rt: Runtime = Depends(get_rt)):
        """Folders you are likely to want: your projects, and the folders you set for conversations (newest first)."""
        from pga.db.models import Project
        u = user_or_404(rt, user_id)
        out: list[dict] = []
        for k, v in reversed(list((((u.preferences or {}).get("agent_access") or {}).get("keys") or {}).items())):
            f = (v or {}).get("folder")
            if f and os.path.isdir(f) and f not in [x["path"] for x in out]:
                out.append({"path": f, "name": os.path.basename(f.rstrip("/")) or f, "from": "chat"})
        for p in rt.session.scalars(select(Project).where(Project.user_id == u.id).order_by(Project.last_used_at.desc().nulls_last())):
            if os.path.isdir(p.path) and p.path not in [x["path"] for x in out]:
                out.append({"path": p.path, "name": p.name, "from": "project"})
        return out[:12]

    @app.get("/v1/users/{user_id}/dirs")
    def dirs(user_id: uuid.UUID, path: str = Query("", max_length=1000), rt: Runtime = Depends(get_rt)):
        """Folders on this machine, for picking the one an agent works in: only folders (no files), only under your
        home folder, hidden ones left out."""
        user_or_404(rt, user_id)
        home = os.path.realpath(os.path.expanduser("~"))
        p = os.path.realpath(os.path.expanduser(path or "~"))
        if not (p == home or p.startswith(home + os.sep)) or not os.path.isdir(p):
            p = home
        try:
            kids = sorted((e.name for e in os.scandir(p) if e.is_dir(follow_symlinks=False) and not e.name.startswith(".")), key=str.lower)
        except OSError:
            kids = []
        return {"path": p, "home": home, "parent": os.path.dirname(p) if p != home else None, "dirs": kids[:400],
                "git": os.path.isdir(os.path.join(p, ".git")), "claude_md": os.path.isfile(os.path.join(p, "CLAUDE.md"))}

    @app.post("/v1/users/{user_id}/timeline/line/extract", status_code=201)
    def time_tree_line_extract(user_id: uuid.UUID, body: dict, rt: Runtime = Depends(get_rt)):
        """Pull a line out into a tree of its own (a new motivation, not started: nothing runs until you press Start)."""
        from pga.timeline import Timeline
        u = user_or_404(rt, user_id)
        line = str(body.get("id") or "")[:160]
        tl = Timeline(rt)
        d = tl.line_detail(u, line)
        if not d["items"]:
            raise HTTPException(404, "this line has no conversations")
        if line.startswith("aim:"):
            raise HTTPException(409, "this line is already a tree")
        title = str(body.get("title") or d["title"] or "").strip()[:200]
        aims = AimService(rt.session)
        aims.list(u)
        a = aims.create(u, title, canonical(rt, u, title)[0])
        relayer(rt, u, f"aim:{a.id}")
        return {**tl.extract(u, line, a), "title": a.text}

    @app.get("/v1/users/{user_id}/imported/{cid}")
    def imported_one(user_id: uuid.UUID, cid: uuid.UUID, rt: Runtime = Depends(get_rt)):
        """One conversation imported from another app: its title, where it ran, the excerpt PGA keeps, and the whole of it
        read again from the app's own store (when it is on this machine)."""
        from pga.db.models import AgentConversation, LinkedAgent
        c = rt.session.get(AgentConversation, cid)
        a = rt.session.get(LinkedAgent, c.linked_agent_id) if c else None
        if c is None or a is None or a.user_id != user_id:
            raise HTTPException(404, "conversation not found")
        from pga.hub.connectors import full_turns
        return {"id": str(c.id), "title": c.title, "agent": a.name, "agent_type": a.connector, "vendor": a.vendor, "project": c.project,
                "model": c.model, "messages": c.message_count, "excerpt": c.excerpt, "turns": full_turns(a.connector, c.external_id),
                **({"session": c.external_id, "source": SOURCE[a.connector]} if a.connector in SOURCE else {}),
                "started_at": c.started_at.isoformat() if c.started_at else None, "updated_at": c.updated_at.isoformat() if c.updated_at else None}

    # ---------------------------------------------------------------- how an answer got there, read again on demand
    @app.get("/v1/users/{user_id}/transcripts/{session}/step")
    def transcript_step(user_id: uuid.UUID, session: str = Path_(..., pattern=r"^[\w-]{1,80}$"),
                        ref: str = Query(..., pattern=r"^\d{1,9}(\.\d{1,4}){0,2}$"), out: str | None = Query(None, pattern=r"^\d{1,9}(\.\d{1,4}){0,2}$"),
                        kind: str = Query("claude", pattern=r"^(claude|codex|hermes)$"), rt: Runtime = Depends(get_rt)):
        """One step of a session in full (Claude Code, Codex, Hermes): the tool's input as code — a diff, a file, a
        command, a script — and what came back (secrets redacted), its pictures."""
        from pga.hub import steps
        user_or_404(rt, user_id)
        f = steps.transcript(session, kind)
        d = steps.detail(f, ref, out, kind, session) if f else None
        if d is None:
            raise HTTPException(404, "step not found")
        return d

    @app.get("/v1/users/{user_id}/transcripts/{session}/image")
    def transcript_image(user_id: uuid.UUID, session: str = Path_(..., pattern=r"^[\w-]{8,80}$"),
                         ref: str = Query(..., pattern=r"^\d{1,9}(\.\d{1,4}){1,2}$"), kind: str = Query("claude", pattern=r"^(claude|codex)$"),
                         rt: Runtime = Depends(get_rt)):
        """A screenshot (or a picture you sent) in a Claude Code or Codex session."""
        from pga.hub import steps
        user_or_404(rt, user_id)
        f = steps.transcript(session, kind)
        img = steps.image(f, ref, kind) if f else None
        if img is None:
            raise HTTPException(404, "image not found")
        return Response(content=img[0], media_type=img[1], headers={"Cache-Control": "private, max-age=86400"})

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

    @app.put("/v1/agents/{name}/account")
    def agents_account(name: str, body: dict, rt: Runtime = Depends(get_rt)):
        """Which account an agent copy is signed in with (e.g. the e-mail), as a label shown next to its name. A
        Claude Code token from `claude setup-token` cannot tell its own account, so you say which one it is."""
        from pga.agents import pool as ap
        cfg = ap.load()
        if name not in cfg["agents"]:
            raise HTTPException(404, "unknown agent")
        label = str(body.get("account") or "").strip()[:80]
        cfg["agents"][name] = {**cfg["agents"][name], **({"account": label} if label else {})}
        if not label:
            cfg["agents"][name].pop("account", None)
        try:
            ap.save(cfg)
        except ap.PoolError as exc:
            raise HTTPException(422, str(exc)) from exc
        return {"name": name, "account": label or None}

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

    @app.get("/v1/agents/live/{lid}/image/{n}")
    def agents_live_image(lid: str, n: int):
        """A screenshot a running answer took (the latest few are kept while it works)."""
        from pga.agents import live
        img = live.image(lid, n)
        if img is None or not re.fullmatch(r"image/(png|jpeg|gif|webp)", img[1]):
            raise HTTPException(404, "image not found")
        return Response(content=img[0], media_type=img[1], headers={"Cache-Control": "private, max-age=3600"})

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

    # ---------------------------------------------------------------- what an agent may do in your conversations
    # Per conversation (the button by the composer) and a default for new ones: the access level (read: read and search;
    # write: also edit files; full: also run commands and start subagents), the folder it works in, and whether your own
    # MCP servers are on. Read-only until you change it. PGA's own long-running work is not affected.
    ACCESS_DEFAULT = {"access": "read", "folder": "", "mcp": False}

    def _access_clean(d: dict) -> dict:
        from pga.agents.routing import ACCESS
        a = str(d.get("access") or "read")
        if a not in ACCESS:
            raise HTTPException(422, "access: read, write or full")
        folder = str(d.get("folder") or "").strip()
        if folder:
            folder = os.path.abspath(os.path.expanduser(folder))
            if not os.path.isdir(folder):
                raise HTTPException(422, f"no such folder: {folder}")
        return {"access": a, "folder": folder, "mcp": bool(d.get("mcp"))}

    def access_for(u, key: str, body: dict | None = None) -> dict:
        """What applies to this conversation: what you just sent with the message (and it is kept for the
        conversation), what you set for it before, or your default."""
        prefs = dict((u.preferences or {}).get("agent_access") or {})
        if body is not None and "access" in body:
            got = _access_clean(body)
            if key:
                keys = dict(prefs.get("keys") or {})
                keys[key[:120]] = got
                prefs["keys"] = dict(list(keys.items())[-500:])
                u.preferences = {**(u.preferences or {}), "agent_access": prefs}
            return got
        return {**ACCESS_DEFAULT, **(prefs.get("default") or {}), **((prefs.get("keys") or {}).get(key[:120]) or {})}

    @app.get("/v1/users/{user_id}/access")
    def access_get(user_id: uuid.UUID, key: str = Query("", max_length=120), rt: Runtime = Depends(get_rt)):
        from pga.agents.adapters import _mcp_rules
        u = user_or_404(rt, user_id)
        prefs = (u.preferences or {}).get("agent_access") or {}
        return {"default": {**ACCESS_DEFAULT, **(prefs.get("default") or {})}, "current": access_for(u, key),
                "mcp_servers": [x for x in _mcp_rules().split(",mcp__") if x]}

    @app.put("/v1/users/{user_id}/access")
    def access_put(user_id: uuid.UUID, body: dict, rt: Runtime = Depends(get_rt)):
        """Set it for one conversation (`key`), or as the default for new ones (`as_default`)."""
        u = user_or_404(rt, user_id)
        got = _access_clean(body)
        prefs = dict((u.preferences or {}).get("agent_access") or {})
        if body.get("as_default"):
            prefs["default"] = got
        if body.get("key"):
            keys = dict(prefs.get("keys") or {})
            keys[str(body["key"])[:120]] = got
            prefs["keys"] = dict(list(keys.items())[-500:])
        u.preferences = {**(u.preferences or {}), "agent_access": prefs}
        return got

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
            tail = None
            if body.get("web"):                                     # look it up on the web (agents with web tools only)
                tail = ("[The user turned on web search for this message: search the web (WebSearch / WebFetch) for current, "
                        "first-hand information before answering, and cite the pages you used as links.]")
            if body.get("refs"):                                    # datasets you pinned: after the question (the cached opening stays the same)
                from pga.tree import refs_context
                tail = "\n\n".join(x for x in [tail, refs_context(rt, [str(x) for x in body["refs"]][:8], u.id, text)] if x) or None
            ckey = str(body.get("conversation") or "")
            sysp = ((u.preferences or {}).get("chat_system") or {}).get(ckey) if ckey else None
            if sysp:                                               # your own instructions for this conversation
                context = ((context or "") + "\n\n<your_instructions_for_this_conversation>\n" + sysp + "\n</your_instructions_for_this_conversation>").strip()
            from pga.worldtree import WorldTree, chat_node
            wn = (chat_node(u, ckey) if ckey else None) or (str(body.get("world")) if body.get("world") else None)
            wt, node = WorldTree(rt), None
            if wn:
                try:
                    node = wt.get(u, uuid.UUID(wn))
                except ValueError:
                    node = None
                if node is not None:
                    context = ((context or "") + "\n\n" + wt.context(node)).strip()
                    rel = wt.related(node, text)
                    tail = "\n\n".join(x for x in [tail, rel] if x) or None
            from pga.segments import used_in_ask
            used = used_in_ask(wt, node, getattr(wt, "last_related", []), [str(x) for x in body.get("refs") or []], rt, u)
            acc = access_for(u, ckey, body)
            if ckey and not ckey.startswith(("node:", "exchange:", "second:", "regen:", "multi:")):
                place_soon(u.id)
            with rt.billing(user_ctx(u)):
                res = AgentRouter(rt).ask(u, text[:20000], agent=str(body.get("agent") or "auto"), context=context, tail=tail,
                                           access=acc["access"], folder=acc["folder"] or None, mcp=acc["mcp"], web=bool(body.get("web")),
                                           model=str(body["model"]) if body.get("model") else None,
                                           effort=str(body["effort"]) if body.get("effort") else None,
                                           images=[x for x in body.get("images") or [] if isinstance(x, dict)][:6],
                                           files=[x for x in body.get("files") or [] if isinstance(x, dict)][:6],
                                           translate=bool(body.get("translate")), project=project,
                                           history=body.get("history") if isinstance(body.get("history"), list) else None,
                                           category=str(body["category"]) if body.get("category") else None,
                                           conversation=str(body["conversation"]) if body.get("conversation") else None)
            if used and res.get("run_id"):                       # what this question was given, for the conversation's data tree
                from pga.db.models import AgentRun
                try:
                    run = rt.session.get(AgentRun, uuid.UUID(res["run_id"]))
                except ValueError:
                    run = None
                if run is not None:
                    run.data = {**(run.data or {}), "context_used": used}
                    rt.session.commit()
            return res
        except ValueError as exc:
            raise HTTPException(422, str(exc)) from exc

    @app.post("/v1/users/{user_id}/agents/translate")
    def agents_translate(user_id: uuid.UUID, body: dict, rt: Runtime = Depends(get_rt)):
        """Replies already on screen, into your language: what the live translation does, after the fact — turning
        译 on translates the answers that came before it too. Long ones go a few paragraphs at a time."""
        from pga.agents.routing import _live_translator, _reader_lang
        u = user_or_404(rt, user_id)
        texts = [str(t or "") for t in (body.get("texts") or [])][:20]
        if not texts:
            return {"texts": []}
        if sum(len(t) for t in texts) > 150_000:
            raise HTTPException(422, "too much text to translate at once")
        tr = _live_translator(rt, str(body.get("lang") or _reader_lang(u)))

        def one(text: str) -> str:
            if not text.strip():
                return text
            parts, cur = [], ""
            for para in text.split("\n\n"):                  # keep each call small enough for the model's reply
                if cur and len(cur) + len(para) > 3000:
                    parts.append(cur)
                    cur = ""
                cur += ("\n\n" if cur else "") + para
            parts.append(cur)
            try:
                return "\n\n".join(tr(p) if p.strip() else p for p in parts)
            except Exception as exc:  # noqa: BLE001 - the original stays on screen
                log.info("translating a reply failed: %s", exc)
                return text

        with rt.billing(user_ctx(u)):
            return {"texts": [one(t) for t in texts]}

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
                "aim_id": str(p.aim_id) if p.aim_id else None, "aim": p.aim.text if p.aim is not None else None,
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
                                                           notes=str(body.get("notes") or ""), full_access=bool(body.get("full_access")),
                                                           aim_id=body.get("aim_id")))
        except ProjectError as exc:
            raise HTTPException(422, str(exc)) from exc

    @app.patch("/v1/users/{user_id}/projects/{pid}")
    def projects_update(user_id: uuid.UUID, pid: uuid.UUID, body: dict, rt: Runtime = Depends(get_rt)):
        from pga.projects import ProjectError, Projects
        user_or_404(rt, user_id)
        try:
            ps = Projects(rt.session)
            extra = {"aim_id": body.get("aim_id"), "user_id": user_id} if "aim_id" in body else {}
            return project_out(ps.update(ps.get(user_id, pid), name=body.get("name"), notes=body.get("notes"),
                                         full_access=body.get("full_access") if "full_access" in body else None, **extra))
        except ProjectError as exc:
            raise HTTPException(422 if "抱负" in str(exc) else 404, str(exc)) from exc

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

    @app.get("/v1/users/{user_id}/projects/{pid}/tree")
    def projects_tree(user_id: uuid.UUID, pid: uuid.UUID, path: str = "", rt: Runtime = Depends(get_rt)):
        """One level of the folder, for the folder tree (read-only)."""
        from pga.projects import ProjectError, Projects, list_dir
        user_or_404(rt, user_id)
        try:
            return list_dir(Projects(rt.session).get(user_id, pid), path)
        except ProjectError as exc:
            raise HTTPException(404, str(exc)) from exc

    @app.get("/v1/users/{user_id}/projects/{pid}/file")
    def projects_file(user_id: uuid.UUID, pid: uuid.UUID, path: str, rt: Runtime = Depends(get_rt)):
        """A file in the folder, as text (read-only; large or binary files are described, not sent)."""
        from pga.projects import ProjectError, Projects, read_file
        user_or_404(rt, user_id)
        try:
            return read_file(Projects(rt.session).get(user_id, pid), path)
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
        from pga.hub.connectors import full_turns
        user_or_404(rt, user_id)
        c = rt.session.get(AgentConversation, cid)
        a = rt.session.get(LinkedAgent, c.linked_agent_id) if c else None
        if c is None or a is None or a.user_id != user_id:
            raise HTTPException(404, "conversation not found")
        turns = full_turns(a.connector, c.external_id)
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
        if body.get("project_id"):                            # the folder it works in (chosen from the motivation's dropdown)
            from pga.projects import ProjectError, Projects
            try:
                proj = Projects(rt.session).get(aim.user_id, uuid.UUID(str(body["project_id"])))
            except (ProjectError, ValueError) as exc:
                raise HTTPException(404, str(exc)) from exc
            if proj.aim_id not in (None, aim.id):
                raise HTTPException(409, "这个文件夹属于另一个抱负")
            proj.aim_id, t.project_id = aim.id, proj.id
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
            if "autonomy" in new:
                from pga.perpetual import AUTONOMY
                if new["autonomy"] not in AUTONOMY:
                    raise HTTPException(422, f"autonomy is one of {list(AUTONOMY)}")
                t.next_at = utcnow()                      # a new level takes effect at the next step
            if "alloc" in new:                                # your allocation weights: merged, then kept within bounds
                from pga.allocation import clean
                old = (t.settings or {}).get("alloc") or {}
                inc = new["alloc"] if isinstance(new["alloc"], dict) else {}
                new["alloc"] = clean({**old, **inc, "prefs": {**(old.get("prefs") or {}), **(inc.get("prefs") or {})}})
            if "samples" in new:
                new["samples"] = max(1, min(5, int(new["samples"])))
            if "perturb" in new:
                new["perturb"] = max(0.0, min(1.0, float(new["perturb"])))
            if "checkpoint_every" in new:
                new["checkpoint_every"] = max(1, min(50, int(new["checkpoint_every"])))
            t.settings = {**(t.settings or {}), **new}
        rt.session.flush()
        return perpetual_view(rt, aim)

    # ---------------------------------------------------------------- the thought tree (思考树)

    def tree_node_or_404(rt, node_id: uuid.UUID):
        from pga.db.models import ThoughtNode
        n = rt.session.get(ThoughtNode, node_id)
        if n is None:
            raise HTTPException(404, "node not found")
        return n

    @app.get("/v1/aims/{aim_id}/tree")
    def tree_view(aim_id: uuid.UUID, lang: str = "", rt: Runtime = Depends(get_rt)):
        """A motivation's thought tree: its dialogue cut into nodes, with branches, twigs (samples) and buds (ideas).
        `lang=en`: the English pages (translated once, cached)."""
        from pga.i18n import localize_tree
        from pga.tree import ThoughtTree
        return localize_tree(rt, ThoughtTree(rt).out(aim_or_404(rt, aim_id)), lang)

    @app.post("/v1/aims/{aim_id}/tree/curate", status_code=202)
    def tree_curate(aim_id: uuid.UUID, body: dict | None = None, rt: Runtime = Depends(get_rt)):
        """Grow the tree now: the curator places the pending dialogue, in the background."""
        from pga.tree import ThoughtTree
        aim = aim_or_404(rt, aim_id)
        windows = max(1, min(30, int((body or {}).get("windows") or 20)))
        rt.workflow.enqueue("tree.curate", user_id=aim.user_id, payload={"aim": str(aim.id), "windows": windows},
                            dedupe_key=f"tree:{aim.id}", priority=60, created_by=Origin.USER)
        return {"queued": True, "pending": ThoughtTree(rt).pending_count(aim)}

    @app.get("/v1/thought-nodes/{node_id}")
    def tree_node(node_id: uuid.UUID, full: bool = False, lang: str = "", rt: Runtime = Depends(get_rt)):
        """One node: its line of thought, the turns in it (with every sample), and the code meanwhile.
        `full`: every turn, uncut (the tree page); otherwise the latest 80, each cut at 4000 characters."""
        from pga.i18n import localize_node
        from pga.tree import ThoughtTree, node_out
        n = tree_node_or_404(rt, node_id)
        tree = ThoughtTree(rt)
        notes = tree.notes_of(n)
        shown = notes if full else notes[-80:]
        nodes = tree.nodes(tree.root_of(n))
        return {**node_out(n, full=True), "path": [{"id": str(x.id), "title": x.title} for x in tree.path(n)],
                "children": [{"id": str(x.id), "title": x.title, "kind": x.kind} for x in nodes if x.parent_id == n.id],
                "notes": [{"id": str(x.id), "kind": x.kind, "agent": x.agent, "role": x.role, "status": x.status,
                           "at": x.created_at.isoformat(), "text": x.text if full else x.text[:4000], "data": x.data or {}} for x in shown],
                "hidden": len(notes) - len(shown)} if not lang.startswith("en") else localize_node(rt, {
                **node_out(n, full=True), "path": [{"id": str(x.id), "title": x.title} for x in tree.path(n)],
                "children": [{"id": str(x.id), "title": x.title, "kind": x.kind} for x in nodes if x.parent_id == n.id],
                "notes": [{"id": str(x.id), "kind": x.kind, "agent": x.agent, "role": x.role, "status": x.status,
                           "at": x.created_at.isoformat(), "text": x.text if full else x.text[:4000], "data": x.data or {}} for x in shown],
                "hidden": len(notes) - len(shown)}, lang)

    @app.post("/v1/thought-nodes/{node_id}/continue")
    def tree_continue(node_id: uuid.UUID, body: dict, rt: Runtime = Depends(get_rt)):
        """Continue from this node (or one of its buds): your question and the agent's answer grow a branch of yours."""
        from pga.agents.routing import AgentRouter
        from pga.db.models import Aim
        from pga.tree import ThoughtTree, node_out
        n = tree_node_or_404(rt, node_id)
        text = str(body.get("text") or "").strip()
        if not text:
            raise HTTPException(422, "text is needed")
        tree = ThoughtTree(rt)
        aim = tree.root_of(n)
        u = user_or_404(rt, aim.user_id)
        branch = tree.branch_for(n, text, bud=str(body.get("bud") or "") or None, branch=bool(body.get("branch")))
        refs = [str(x) for x in (body.get("refs") or []) if x][:8]
        start = branch if branch.note_ids else n
        context, tail = tree.context_for(start), tree.tail_for(start, text, refs)
        acc = access_for(u, f"tree:{n.aim_id or 'you'}", body)           # one setting per tree
        try:
            with rt.billing(user_ctx(u)):
                reply = AgentRouter(rt).ask(u, text[:20000], agent=str(body.get("agent") or "auto"), context=context,
                                            category="serious" if str(body.get("agent") or "auto") == "auto" else None,
                                            conversation=f"node:{branch.id}", project=None, tail=tail or None,
                                            access=acc["access"], folder=acc["folder"] or None, mcp=acc["mcp"])
        except ValueError as exc:
            raise HTTPException(422, str(exc)) from exc
        tree.record(branch, aim, text, reply)
        if body.get("focus"):
            from pga.tree import TreeError
            try:
                tree.focus(aim, branch)
            except TreeError:
                pass
        return {"node": node_out(branch), "reply": {k: reply.get(k) for k in ("agent", "text", "error", "model")}}

    @app.get("/v1/thought-nodes/{node_id}/context")
    def tree_node_context(node_id: uuid.UUID, q: str = Query("", max_length=4000), refs: str = Query("", max_length=2000),
                          rt: Runtime = Depends(get_rt)):
        """What an agent would read if you sent `q` from this node now: the opening (the same for every branch started
        here, so it can come from the provider's cache) and what goes after your message. In a running branch of yours
        the agent already has the opening and hears only your message and what follows it."""
        from pga.tree import ThoughtTree
        n = tree_node_or_404(rt, node_id)
        tree = ThoughtTree(rt)
        warm = n.kind == "user" and bool(n.note_ids)
        opening = tree.context_for(n)
        tail = tree.tail_for(n, q, [x for x in refs.split(",") if x][:8]) if q.strip() or refs else ""
        est = lambda t: round(len(re.sub(r"[\u3400-\u9fff]", "", t)) / 4 + len(re.findall(r"[\u3400-\u9fff]", t)) * .8)
        return {"opening": opening, "tail": tail, "opening_tokens": est(opening), "tail_tokens": est(tail), "continues": warm,
                "related": [{"id": str(x.id), "title": x.title} for x in (tree.related(n, q) if q.strip() else [])]}

    def tree_err(exc) -> HTTPException:
        return HTTPException(409, str(exc))

    @app.patch("/v1/thought-nodes/{node_id}")
    def tree_node_update(node_id: uuid.UUID, body: dict, rt: Runtime = Depends(get_rt)):
        """Rename, rewrite, hide / show or move a node (parent_id null: onto the root)."""
        from pga.tree import ThoughtTree, TreeError, node_out
        n = tree_node_or_404(rt, node_id)
        parent = "keep"
        if "parent_id" in body:
            parent = tree_node_or_404(rt, uuid.UUID(str(body["parent_id"]))) if body["parent_id"] else None
        try:
            return node_out(ThoughtTree(rt).update(n, title=body.get("title"), summary=body.get("summary"),
                                                   key_thoughts=body.get("key_thoughts") if isinstance(body.get("key_thoughts"), list) else None,
                                                   hidden=body.get("hidden") if "hidden" in body else None, parent=parent,
                                                   pos=body["pos"] if "pos" in body and (body["pos"] is None or isinstance(body["pos"], dict)) else "keep"))
        except (TreeError, ValueError, TypeError) as exc:
            raise tree_err(exc) if isinstance(exc, TreeError) else HTTPException(422, str(exc)) from exc

    @app.post("/v1/thought-nodes/{node_id}/links")
    def tree_node_link(node_id: uuid.UUID, body: dict, rt: Runtime = Depends(get_rt)):
        """Link two nodes (dragged one onto the other)."""
        from pga.tree import ThoughtTree, TreeError, node_out
        try:
            other = tree_node_or_404(rt, uuid.UUID(str(body.get("to"))))
            return node_out(ThoughtTree(rt).link(tree_node_or_404(rt, node_id), other))
        except ValueError as exc:
            raise HTTPException(422, "to: a node id") from exc
        except TreeError as exc:
            raise tree_err(exc) from exc

    @app.delete("/v1/thought-nodes/{node_id}/links/{other_id}", status_code=204)
    def tree_node_unlink(node_id: uuid.UUID, other_id: uuid.UUID, rt: Runtime = Depends(get_rt)):
        """Cut a link (the scissors)."""
        from pga.tree import ThoughtTree
        ThoughtTree(rt).unlink(tree_node_or_404(rt, node_id), tree_node_or_404(rt, other_id))

    @app.post("/v1/thought-nodes/{node_id}/merge")
    def tree_node_merge(node_id: uuid.UUID, rt: Runtime = Depends(get_rt)):
        """Fold a node into its parent (cut too fine)."""
        from pga.tree import ThoughtTree, TreeError, node_out
        try:
            return node_out(ThoughtTree(rt).merge_up(tree_node_or_404(rt, node_id)))
        except TreeError as exc:
            raise tree_err(exc) from exc

    @app.delete("/v1/thought-nodes/{node_id}", status_code=204)
    def tree_node_delete(node_id: uuid.UUID, rt: Runtime = Depends(get_rt)):
        from pga.tree import ThoughtTree, TreeError
        try:
            ThoughtTree(rt).delete(tree_node_or_404(rt, node_id))
        except TreeError as exc:
            raise tree_err(exc) from exc

    @app.post("/v1/thought-nodes/{node_id}/branch", status_code=201)
    def tree_node_branch(node_id: uuid.UUID, body: dict, rt: Runtime = Depends(get_rt)):
        """Open an empty branch from here: a direction to think along, continued later."""
        from pga.tree import ThoughtTree, node_out
        title = str(body.get("title") or "").strip()
        if not title:
            raise HTTPException(422, "a branch needs a direction (title)")
        return node_out(ThoughtTree(rt).new_branch(tree_node_or_404(rt, node_id), title))

    @app.post("/v1/thought-nodes/{node_id}/distill")
    def tree_node_distill(node_id: uuid.UUID, rt: Runtime = Depends(get_rt)):
        """Distill this line of thought (the node and what grew from it) into a dataset other trees can use."""
        from pga.db.models import Aim
        from pga.tree import ThoughtTree
        n = tree_node_or_404(rt, node_id)
        u = user_or_404(rt, n.user_id)
        with rt.billing(user_ctx(u)):
            b, out = ThoughtTree(rt).distill(u, n)
        return {"dataset": body_out(b), "status": out.status, "words": out.words, "note": out.note}

    @app.get("/v1/thought-nodes/{node_id}/markdown", include_in_schema=False)
    def tree_node_markdown(node_id: uuid.UUID, rt: Runtime = Depends(get_rt)):
        from fastapi.responses import Response
        from pga.tree import ThoughtTree
        n = tree_node_or_404(rt, node_id)
        name = urllib.parse.quote(f"{n.title[:40]}.md")
        return Response(ThoughtTree(rt).markdown(n), media_type="text/markdown; charset=utf-8",
                        headers={"Content-Disposition": f"inline; filename*=UTF-8''{name}"})

    @app.post("/v1/thought-nodes/{node_id}/exchange")
    def tree_node_exchange(node_id: uuid.UUID, body: dict, rt: Runtime = Depends(get_rt)):
        """Two branches talk: an agent reads both lines of thought and writes what each can take from the other."""
        from pga.db.models import Aim
        from pga.tree import ThoughtTree, TreeError, node_out
        n = tree_node_or_404(rt, node_id)
        other = tree_node_or_404(rt, uuid.UUID(str(body.get("with") or "")))
        if other.user_id != n.user_id:
            raise HTTPException(404, "node not found")
        u = user_or_404(rt, n.user_id)
        try:
            with rt.billing(user_ctx(u)):
                x, reply = ThoughtTree(rt).exchange(u, n, other, str(body.get("text") or ""), str(body.get("agent") or "auto"))
        except TreeError as exc:
            raise tree_err(exc) from exc
        except ValueError as exc:
            raise HTTPException(422, str(exc)) from exc
        return {"node": node_out(x), "reply": {k: reply.get(k) for k in ("agent", "text", "error", "model")}}

    @app.post("/v1/aims/{aim_id}/references", status_code=201)
    def tree_reference(aim_id: uuid.UUID, body: dict, rt: Runtime = Depends(get_rt)):
        """Let this tree refer to a dataset (from another tree, or a shared one): every round reads its summary."""
        aim = aim_or_404(rt, aim_id)
        try:
            br = BodyService(rt).bridge(aim.user_id, f"aim:{aim.id}", f"k:{body.get('body_id')}", kind="references")
        except BodyError as exc:
            raise HTTPException(422, str(exc)) from exc
        return {"id": str(br.id)}

    @app.delete("/v1/aims/{aim_id}/references/{body_id}", status_code=204)
    def tree_unreference(aim_id: uuid.UUID, body_id: uuid.UUID, rt: Runtime = Depends(get_rt)):
        from pga.db.models import Bridge
        aim = aim_or_404(rt, aim_id)
        a, b = sorted((f"aim:{aim.id}", f"k:{body_id}"))
        br = rt.session.scalar(select(Bridge).where(Bridge.user_id == aim.user_id, Bridge.a_ref == a, Bridge.b_ref == b))
        if br is not None:
            rt.session.delete(br)

    @app.post("/v1/aims/{aim_id}/tree/rewrite", status_code=202)
    def tree_rewrite(aim_id: uuid.UUID, rt: Runtime = Depends(get_rt)):
        """Rewrite the hard-to-read summaries of this tree (in the background)."""
        aim = aim_or_404(rt, aim_id)
        rt.workflow.enqueue("tree.rewrite", user_id=aim.user_id, payload={"aim": str(aim.id)}, dedupe_key=f"tree-rewrite:{aim.id}",
                            priority=60, created_by=Origin.USER)
        return {"queued": True}

    @app.get("/v1/bodies/{body_id}/markdown", include_in_schema=False)
    def body_markdown(body_id: uuid.UUID, rt: Runtime = Depends(get_rt)):
        from fastapi.responses import Response
        from pga.db.models import Body
        b = rt.session.get(Body, body_id)
        if b is None:
            raise HTTPException(404, "body not found")
        lv = rt.layers.rows([f"k:{b.id}"]).get(f"k:{b.id}", {})
        text = f"# {b.title}\n\n" + (f"> {lv[1].text}\n\n" if 1 in lv else "") + (f"{lv[2].text}\n\n---\n\n" if 2 in lv else "") + (b.description or "")
        name = urllib.parse.quote(f"{b.title[:40]}.md")
        return Response(text + "\n", media_type="text/markdown; charset=utf-8", headers={"Content-Disposition": f"inline; filename*=UTF-8''{name}"})

    @app.get("/v1/users/{user_id}/forest")
    def forest(user_id: uuid.UUID, lang: str = "", rt: Runtime = Depends(get_rt)):
        """森林: every motivation's tree (its shape, its pressure, whether it runs), the two models, the shared knowledge."""
        from pga.db.models import AimNote, Body, Bridge, PerpetualTask
        from pga.knowledge.datasets import Datasets
        from pga.perpetual import PHASE_ZH
        from pga.tree import ThoughtTree
        u = user_or_404(rt, user_id)
        Datasets(rt).ensure(u)
        tree = ThoughtTree(rt)
        trees = []
        for a in AimService(rt.session).list(u):
            t = rt.session.scalar(select(PerpetualTask).where(PerpetualTask.aim_id == a.id))
            nodes = tree.nodes(a.id)
            p = tree.project(a)
            for_you = int(rt.session.scalar(select(func.count()).select_from(AimNote).where(
                AimNote.aim_id == a.id, AimNote.kind == "question", AimNote.status == "for_you")) or 0)
            trees.append({"id": str(a.id), "text": a.text, "pending": tree.pending_count(a), "for_you": for_you,
                          "project": {"id": str(p.id), "name": p.name} if p else None,
                          "task": None if t is None else {"status": t.status, "phase_zh": PHASE_ZH.get(t.phase, t.phase),
                                                          "auto_idle": t.status == "running" and bool((t.settings or {}).get("_idle_since")),
                                                          "pressure": round(t.pressure, 3), "cycles": t.cycles},
                          "last_growth": max((n.last_at or n.created_at for n in nodes), default=None),
                          "nodes": [{"id": str(n.id), "parent": str(n.parent_id) if n.parent_id else None, "seq": n.seq, "kind": n.kind,
                                     "turns": (n.data or {}).get("turns", 0), "tip": bool((n.data or {}).get("tip")),
                                     "hidden": bool((n.data or {}).get("hidden")), "title": n.title,
                                     "sampled": (n.data or {}).get("sampled", 0), "samples": (n.data or {}).get("samples", 0)}
                                    for n in nodes]})
        users = {}
        for br in rt.session.scalars(select(Bridge).where(Bridge.user_id == u.id, Bridge.kind == "references")):
            for x, y in ((br.a_ref, br.b_ref), (br.b_ref, br.a_ref)):
                if x.startswith("k:") and y.startswith("aim:"):
                    users.setdefault(x[2:], []).append(y[4:])
        shared = []
        for b in rt.session.scalars(select(Body).where(Body.user_id == u.id).order_by(Body.created_at)):
            lv = rt.layers.rows([f"k:{b.id}"]).get(f"k:{b.id}", {})
            shared.append({"id": str(b.id), "title": b.title, "kind": b.kind, "system": b.system, "aim_id": str(b.aim_id) if b.aim_id else None,
                           "gist": lv[1].text if 1 in lv else None, "brief": lv[2].text if 2 in lv else None,
                           "compiled_at": b.compiled_at, "used_by": users.get(str(b.id), []),
                           **({"source": (b.data or {})["source"], "chars": (b.data or {}).get("chars"), "url": (b.data or {}).get("url")}
                              if (b.data or {}).get("source") in ("upload", "web", "note") else {})})
        from pga.tree import YouRoot
        you = YouRoot(u)
        ynodes = tree.nodes(you)
        mine = {"id": "you", "text": "Your conversations" if lang.startswith("en") else "你的对话", "scope": "user", "pending": tree.pending_count(you),
                "last_growth": max((n.last_at or n.created_at for n in ynodes), default=None),
                "nodes": [{"id": str(n.id), "parent": str(n.parent_id) if n.parent_id else None, "seq": n.seq, "kind": n.kind,
                           "turns": (n.data or {}).get("turns", 0), "tip": bool((n.data or {}).get("tip")), "hidden": bool((n.data or {}).get("hidden")),
                           "title": n.title, "sampled": 0, "samples": 0} for n in ynodes]}
        from pga.i18n import localize_forest
        personal = next((b for b in rt.session.scalars(select(Body).where(Body.user_id == u.id, Body.system == "user"))), None)
        dims = (personal.data or {}).get("dims_en" if lang.startswith("en") else "dims") if personal else None
        return localize_forest(rt, {"trees": trees, "you": mine, "knowledge": shared, "personal": dims}, lang)

    # your own conversations, as a tree of their own
    @app.get("/v1/users/{user_id}/tree")
    def tree_you(user_id: uuid.UUID, lang: str = "", rt: Runtime = Depends(get_rt)):
        from pga.i18n import localize_tree
        from pga.tree import ThoughtTree, YouRoot
        out = ThoughtTree(rt).out(YouRoot(user_or_404(rt, user_id)))
        if lang.startswith("en"):
            out["aim"]["text"] = "Your conversations"
        return localize_tree(rt, out, lang)

    @app.post("/v1/users/{user_id}/tree/curate", status_code=202)
    def tree_you_curate(user_id: uuid.UUID, body: dict | None = None, rt: Runtime = Depends(get_rt)):
        from pga.tree import ThoughtTree, YouRoot
        u = user_or_404(rt, user_id)
        windows = max(1, min(30, int((body or {}).get("windows") or 20)))
        rt.workflow.enqueue("tree.curate", user_id=u.id, payload={"you": str(u.id), "windows": windows},
                            dedupe_key=f"tree:you:{u.id}", priority=60, created_by=Origin.USER)
        return {"queued": True, "pending": ThoughtTree(rt).pending_count(YouRoot(u))}

    @app.post("/v1/users/{user_id}/tree/rewrite", status_code=202)
    def tree_you_rewrite(user_id: uuid.UUID, rt: Runtime = Depends(get_rt)):
        u = user_or_404(rt, user_id)
        rt.workflow.enqueue("tree.rewrite", user_id=u.id, payload={"you": str(u.id)}, dedupe_key=f"tree-rewrite:you:{u.id}",
                            priority=60, created_by=Origin.USER)
        return {"queued": True}

    @app.post("/v1/aims/{aim_id}/tree/refresh")
    def tree_refresh(aim_id: uuid.UUID, rt: Runtime = Depends(get_rt)):
        """Recount every node (behaviour, code, twigs) — no model involved."""
        from pga.tree import ThoughtTree
        return {"nodes": ThoughtTree(rt).refresh(aim_or_404(rt, aim_id))}

    @app.get("/v1/users/{user_id}/usage/split")
    def usage_split(user_id: uuid.UUID, days: int = Query(3, ge=1, le=30), rt: Runtime = Depends(get_rt)):
        """Where the agents' tokens went: your own chats, or PGA's background work (tree, datasets, research), per agent;
        and the conversations that read the most (a long resumed session rereads its whole history every turn)."""
        from datetime import timedelta

        from pga.agents import pool as ap
        from pga.db.models import AgentRun
        from pga.tree import usage_of
        user_or_404(rt, user_id)
        since = utcnow() - timedelta(days=days)
        rows = rt.session.execute(select(AgentRun.agent, AgentRun.workflow, AgentRun.data, AgentRun.parent_id).where(
            AgentRun.started_at >= since, AgentRun.parent_id.isnot(None), AgentRun.data["usage"].isnot(None))).all()
        parents = {}
        pids = list({p for *_x, p in rows})
        if pids:
            parents = {r.id: r for r in rt.session.scalars(select(AgentRun).where(AgentRun.id.in_(pids), AgentRun.user_id == user_id))}
        per: dict = {}
        convs: dict = {}
        for agent, wf, data, pid in rows:
            par = parents.get(pid)
            if par is None and wf == "ask":
                continue
            u = usage_of(data) or {}
            side = "yours" if wf == "ask" else "background"
            g = per.setdefault(agent, {"yours": {"calls": 0, "input": 0, "output": 0}, "background": {"calls": 0, "input": 0, "output": 0}})
            g[side]["calls"] += 1
            g[side]["input"] += u.get("input", 0)
            g[side]["output"] += u.get("output", 0)
            if side == "yours" and par is not None:
                k = str((par.data or {}).get("conversation") or "")
                c = convs.setdefault(k, {"key": k, "agent": agent, "calls": 0, "input": 0, "title": " ".join((par.prompt or "").split())[:60]})
                c["calls"] += 1
                c["input"] += u.get("input", 0)
        r = ap.load()["routing"]
        return {"days": days, "agents": per, "heavy": sorted(convs.values(), key=lambda c: -c["input"])[:5],
                "long_tasks": bool(r.get("long_tasks")), "keep_for_me": r.get("keep_for_me") or []}

    @app.put("/v1/agents/background")
    def agents_background(body: dict, rt: Runtime = Depends(get_rt)):
        """Whether PGA's own background work may use agents at all, and which agent kinds it leaves for you."""
        from pga.agents import pool as ap
        cfg = ap.load()
        if "long_tasks" in body:
            cfg["routing"]["long_tasks"] = bool(body["long_tasks"])
        if isinstance(body.get("keep_for_me"), list):
            cfg["routing"]["keep_for_me"] = [str(x)[:40] for x in body["keep_for_me"]][:20]
        try:
            ap.save(cfg)
        except ap.PoolError as exc:
            raise HTTPException(422, str(exc)) from exc
        return {"long_tasks": cfg["routing"]["long_tasks"], "keep_for_me": cfg["routing"].get("keep_for_me") or []}

    @app.get("/v1/users/{user_id}/cache")
    def cache_stats(user_id: uuid.UUID, days: int = Query(7, ge=1, le=90), rt: Runtime = Depends(get_rt)):
        """How much of what the agents read came from the providers' prompt caches, per agent, over the last days."""
        from datetime import timedelta

        from pga.db.models import AgentRun
        from pga.tree import cache_totals
        user_or_404(rt, user_id)
        since = utcnow() - timedelta(days=days)
        rows = rt.session.execute(select(AgentRun.agent, AgentRun.data).where(AgentRun.user_id == user_id, AgentRun.started_at >= since,
                                                                                AgentRun.data["usage"].isnot(None))).all()
        per: dict[str, list] = {}
        for agent, data in rows:
            per.setdefault(agent, []).append(data)
        return {"days": days, "all": cache_totals([d for _, d in rows]), "agents": {a: cache_totals(ds) for a, ds in sorted(per.items())}}

    @app.get("/v1/thought-nodes/{node_id}/behavior")
    def tree_node_behavior(node_id: uuid.UUID, rt: Runtime = Depends(get_rt)):
        """行为树: who did what in this node — each agent, its runs (step, question, outcome), the actions in them."""
        from pga.tree import ThoughtTree
        return ThoughtTree(rt).behavior(tree_node_or_404(rt, node_id))

    @app.put("/v1/thought-nodes/{node_id}/refs")
    def tree_node_refs(node_id: uuid.UUID, body: dict, rt: Runtime = Depends(get_rt)):
        """The datasets this node refers to: continuing from it (or anything that grows from it) reads them."""
        from pga.tree import ThoughtTree, node_out
        return node_out(ThoughtTree(rt).set_refs(tree_node_or_404(rt, node_id), [str(x) for x in body.get("refs") or []]))

    @app.post("/v1/bodies/{body_id}/move")
    def body_move(body_id: uuid.UUID, body: dict, rt: Runtime = Depends(get_rt)):
        """Move a dataset to another node (it becomes that line of thought's knowledge) or to another tree."""
        from pga.db.models import Body
        from pga.tree import ThoughtTree
        b = rt.session.get(Body, body_id)
        if b is None:
            raise HTTPException(404, "body not found")
        if b.system in ("user", "world"):
            raise HTTPException(409, "用户和世界模型属于所有的树，不能移动")
        node = tree_node_or_404(rt, uuid.UUID(str(body["node_id"]))) if body.get("node_id") else None
        aim = aim_or_404(rt, uuid.UUID(str(body["aim_id"]))) if body.get("aim_id") else None
        if node is None and aim is None:
            raise HTTPException(422, "move it to a node or a tree")
        if (node and node.user_id != b.user_id) or (aim and aim.user_id != b.user_id):
            raise HTTPException(404, "not found")
        return body_out(ThoughtTree(rt).move_dataset(b, node=node, aim=aim))

    # everyday short conversations: chats that do not belong to any tree
    @app.get("/v1/users/{user_id}/chats")
    def chats_list(user_id: uuid.UUID, limit: int = Query(80, le=300), archived: bool = False, rt: Runtime = Depends(get_rt)):
        """Your one-off conversations with agents, newest first (a conversation = the chats that share one key)."""
        from pga.db.models import AgentRun
        from pga.tree import _answer
        u = user_or_404(rt, user_id)
        gone = set((u.preferences or {}).get("archived_chats") or [])
        convs: dict[str, dict] = {}
        for r in rt.session.scalars(select(AgentRun).where(AgentRun.user_id == user_id, AgentRun.parent_id.is_(None),
                                                           AgentRun.workflow == "ask").order_by(AgentRun.started_at.desc()).limit(2000)):
            d = r.data or {}
            key = str(d.get("conversation") or f"run:{r.id}")
            if key.startswith(("node:", "exchange:", "second:", "regen:", "multi:")) or d.get("node") or d.get("regen_of"):
                continue
            c = convs.setdefault(key, {"key": key, "agent": d.get("agent") or r.agent, "turns": 0, "last_at": r.started_at.isoformat(),
                                       "title": "", "last": ""})
            c["turns"] += 1
            c["title"] = " ".join((r.prompt or "").split())[:80] or c["title"]          # the first thing you said (oldest wins)
            if not c["last"]:
                c["last"] = " ".join(_answer(r.output).split())[:120]
        titles = (u.preferences or {}).get("chat_titles") or {}
        for c in convs.values():
            c["archived"] = c["key"] in gone
            if titles.get(c["key"]):
                c["title"] = titles[c["key"]]
        return [c for c in sorted(convs.values(), key=lambda c: c["last_at"], reverse=True) if archived or not c["archived"]][:limit]

    @app.post("/v1/users/{user_id}/chats/archive")
    def chats_archive(user_id: uuid.UUID, body: dict, rt: Runtime = Depends(get_rt)):
        """Archive an everyday chat (it leaves the list; nothing is deleted), or bring it back."""
        u = user_or_404(rt, user_id)
        key = str(body.get("key") or "")[:120]
        if not key:
            raise HTTPException(422, "key is needed")
        keys = [k for k in ((u.preferences or {}).get("archived_chats") or []) if k != key]
        if body.get("archived", True):
            keys.append(key)
        u.preferences = {**(u.preferences or {}), "archived_chats": keys[-2000:]}
        return {"key": key, "archived": key in keys}

    @app.get("/v1/users/{user_id}/chats/{key:path}")
    def chats_one(user_id: uuid.UUID, key: str, rt: Runtime = Depends(get_rt)):
        """One short conversation, turn by turn (each answer with its second opinion, if you asked for one); a branch
        also carries the turns it grew from."""
        from pga.chats import ChatError, branch_of, history, runs_of
        from pga.tree import _answer
        u = user_or_404(rt, user_id)
        try:
            runs = runs_of(rt, user_id, key)
        except ChatError as exc:
            raise HTTPException(404, str(exc)) from exc
        from pga.db.models import AgentRun
        from pga.tree import parse_actions, usage_of
        kids: dict = {}
        if runs:
            for k in rt.session.scalars(select(AgentRun).where(AgentRun.parent_id.in_([r.id for r in runs])).order_by(AgentRun.started_at)):
                kids[k.parent_id] = k                                   # the step that answered (the last one)

        def how(r) -> dict:
            k = kids.get(r.id)
            kd = (k.data or {}) if k is not None else {}
            u = usage_of(kd) or {}
            win = ((kd.get("usage") or {}).get("modelContextWindow") if isinstance(kd.get("usage"), dict) else None)
            out = {"seconds": round(float(k.duration_s or 0), 1) if k is not None else None, "usage": u or None, "window": win,
                   "via": kd.get("via"), "continued": kd.get("continued"), "model": (r.data or {}).get("model"),
                   "actions": parse_actions(kd.get("trace") or "")[:80]}
            full = run_steps(k) if k is not None else None                  # the agent kept its session: every step
            if full:
                out.update(steps=full["steps"], src=full["src"], calls=(full.get("usage") or {}).get("calls"))
            return out
        from pga.chats import current, fold
        turns, alts = fold(runs)
        out = []

        def answer(a) -> dict:
            return {"agent": (a.data or {}).get("agent") or a.agent, "text": _answer(a.output) or "", "error": a.error, "run": str(a.id),
                    "at": (a.finished_at or a.started_at).isoformat(), "model": (a.data or {}).get("model"), "how": how(a),
                    "rating": ((a.data or {}).get("rating") or {}).get("value", 0)}
        for r in turns:
            out.append({"role": "user", "text": r.prompt or "", "at": r.started_at.isoformat(), "run": str(r.id), **({"note": True} if (r.data or {}).get("note") else {})})
            if (r.data or {}).get("note"):                       # your own note: no answer to show
                continue
            vs = [r, *alts.get(str(r.id), [])]
            cur = current(r, alts)
            out.append({"role": "agent", **answer(cur), "run": str(r.id), "version": str(cur.id),
                        "versions": [answer(v) for v in vs] if len(vs) > 1 else [],
                        **({"second": r.data["second"]} if (r.data or {}).get("second") else {}),
                        **({"council": {k: r.data["council"].get(k) for k in ("ranking", "review", "merged", "labels")}} if (r.data or {}).get("council") else {})})
        b = branch_of(u, key)
        ctx = history(rt, u, b["from"], uuid.UUID(b["upto"])) if b else []
        from pga.chats import children
        kids = children(u, key)
        if kids:                                                   # their first message, as a name
            firsts = {}
            for k in kids:
                r0 = next(iter(runs_of(rt, user_id, k["key"])), None) if not k["title"] else None
                firsts[k["key"]] = k["title"] or (" ".join((r0.prompt or "").split())[:40] if r0 else "")
            kids = [{**k, "title": firsts[k["key"]]} for k in kids]
        from pga.worldtree import WorldTree, chat_node
        wt = WorldTree(rt)
        leaf = wt.leaf_of(u, key)
        bound = chat_node(u, key)
        bnode = wt.get(u, uuid.UUID(bound)) if bound else None
        anchor_n = leaf or bnode
        world = {"leaf": str(leaf.id) if leaf else None, "talks_to": bound,
                 "path": [{"id": str(x.id), "title": x.title, "kind": x.kind} for x in wt.path(anchor_n)] if anchor_n else []}
        from pga.dispatch import of as dispatch_of
        dispatches = [r.data["dispatch"] for r in runs if (r.data or {}).get("dispatch")] or dispatch_of(u, key)
        return {"key": key, "turns": out, "branch": b, "context": ctx, "title": ((u.preferences or {}).get("chat_titles") or {}).get(key), "children": kids, "world": world,
                "dispatch": dispatches,
                "system": ((u.preferences or {}).get("chat_system") or {}).get(key)}

    @app.post("/v1/users/{user_id}/chats/regen")
    def chats_regen(user_id: uuid.UUID, body: dict, rt: Runtime = Depends(get_rt)):
        """Another version of an answer (the turn keeps all its versions; you flip between them)."""
        from pga.chats import ChatError, regenerate
        u = user_or_404(rt, user_id)
        try:
            with rt.billing(user_ctx(u)):
                return regenerate(rt, u, uuid.UUID(str(body.get("run"))), str(body.get("agent") or "") or None)
        except (ChatError, ValueError) as exc:
            raise HTTPException(422, str(exc)) from exc

    @app.post("/v1/users/{user_id}/chats/fold")
    def chats_fold(user_id: uuid.UUID, body: dict, rt: Runtime = Depends(get_rt)):
        """Several agents answered one question at once: file the others under the first answer, as versions."""
        from pga.chats import ChatError, fold_in
        try:
            n = fold_in(rt, user_or_404(rt, user_id), uuid.UUID(str(body.get("root"))), [uuid.UUID(str(x)) for x in body.get("runs") or []][:6],
                        str(body.get("key") or "")[:120])
        except (ChatError, ValueError) as exc:
            raise HTTPException(422, str(exc)) from exc
        return {"folded": n}

    @app.post("/v1/users/{user_id}/knowledge/web", status_code=201)
    def knowledge_web(user_id: uuid.UUID, body: dict, rt: Runtime = Depends(get_rt)):
        """A web page into the knowledge base: fetched here, its readable text kept, cited like a document."""
        from pga.knowledge.uploads import UploadError, fetch_page
        u = user_or_404(rt, user_id)
        try:
            b = fetch_page(rt, u.id, str(body.get("url") or ""))
        except UploadError as exc:
            raise HTTPException(422, str(exc)) from exc
        return {"id": str(b.id), "title": b.title, "chars": b.data["chars"], "passages": b.data["passages"], "url": b.data["url"]}

    @app.get("/v1/users/{user_id}/notes")
    def notes_list(user_id: uuid.UUID, rt: Runtime = Depends(get_rt)):
        """Your notes, newest first (they are knowledge too: cite one with #)."""
        from pga.db.models import Body
        user_or_404(rt, user_id)
        xs = rt.session.scalars(select(Body).where(Body.user_id == user_id, Body.kind == "note").order_by(Body.compiled_at.desc().nulls_last()))
        return [{"id": str(b.id), "title": b.title, "text": b.description, "at": (b.compiled_at or b.created_at).isoformat(), "chars": len(b.description or "")} for b in xs]

    @app.post("/v1/users/{user_id}/notes", status_code=201)
    def notes_create(user_id: uuid.UUID, body: dict, rt: Runtime = Depends(get_rt)):
        from pga.db.models import Body
        from pga.db.types import Origin
        u = user_or_404(rt, user_id)
        text = str(body.get("text") or "")[:400000]
        title = str(body.get("title") or "").strip()[:200] or (text.strip().split("\n", 1)[0].lstrip("# ").strip()[:60] if text.strip() else "") or "未命名笔记"
        b = Body(user_id=u.id, kind="note", title=title, title_en=title, description=text, description_en=text, origin=Origin.USER,
                 compiled_at=utcnow(), data={"source": "note", "chars": len(text), "passages": max(1, len(text) // 1200 + 1)})
        rt.session.add(b)
        rt.session.flush()
        return {"id": str(b.id), "title": b.title, "text": b.description, "at": b.compiled_at.isoformat()}

    @app.put("/v1/notes/{note_id}")
    def notes_update(note_id: uuid.UUID, body: dict, rt: Runtime = Depends(get_rt)):
        from pga.db.models import Body
        b = rt.session.get(Body, note_id)
        if b is None or b.kind != "note":
            raise HTTPException(404, "no such note")
        if "text" in body:
            t = str(body.get("text") or "")[:400000]
            if body.get("append"):
                t = (b.description or "").rstrip() + "\n\n" + t
            b.description = b.description_en = t
            b.data = {**(b.data or {}), "chars": len(t), "passages": max(1, len(t) // 1200 + 1)}
        if str(body.get("title") or "").strip():
            b.title = b.title_en = str(body["title"]).strip()[:200]
        b.compiled_at = utcnow()
        return {"id": str(b.id), "title": b.title, "text": b.description, "at": b.compiled_at.isoformat()}

    @app.post("/v1/users/{user_id}/chats/pick")
    def chats_pick(user_id: uuid.UUID, body: dict, rt: Runtime = Depends(get_rt)):
        """Which version of an answer the conversation goes on from."""
        from pga.agents.council import picked
        from pga.chats import ChatError, pick
        try:
            u = user_or_404(rt, user_id)
            pick(rt, u, uuid.UUID(str(body.get("run"))), uuid.UUID(str(body.get("version"))))
            picked(rt, u, uuid.UUID(str(body.get("run"))), uuid.UUID(str(body.get("version"))))   # a vote in the arena
        except (ChatError, ValueError) as exc:
            raise HTTPException(422, str(exc)) from exc
        return {"ok": True}

    @app.post("/v1/users/{user_id}/chats/split")
    def chats_split(user_id: uuid.UUID, body: dict, rt: Runtime = Depends(get_rt)):
        """分工: the points of one message as tasks that different agents can do at the same time."""
        from pga.dispatch import DispatchError, split
        u = user_or_404(rt, user_id)
        try:
            with rt.billing(user_ctx(u)):
                return {"tasks": split(rt, u, str(body.get("text") or ""), str(body.get("context") or ""))}
        except DispatchError as exc:
            raise HTTPException(422, str(exc)) from exc

    @app.put("/v1/users/{user_id}/chats/dispatch")
    def chats_dispatch(user_id: uuid.UUID, body: dict, rt: Runtime = Depends(get_rt)):
        """Which branches (and agents) the tasks of one message went to, so the conversation can follow them. Kept on
        the message's own run (`run`), not in your preferences: the agents answering at the same moment write those."""
        from pga.db.models import AgentRun
        from pga.dispatch import record
        u = user_or_404(rt, user_id)
        key = str(body.get("key") or "")[:120]
        e = body.get("entry") if isinstance(body.get("entry"), dict) else None
        if not key or not e:
            raise HTTPException(422, "key and entry are needed")
        entry = {"id": str(e.get("id") or uuid.uuid4().hex[:8])[:20], "text": str(e.get("text") or "")[:4000], "at": utcnow().isoformat(),
                 "tasks": [{"title": str(t.get("title") or "")[:60], "key": str(t.get("key") or "")[:120], "agent": str(t.get("agent") or "")[:40]}
                           for t in (e.get("tasks") or [])[:8] if isinstance(t, dict)], "merged": str(e.get("merged") or "")[:120],
                 "run": str(body.get("run") or e.get("run") or "")[:40]}
        try:
            r = rt.session.get(AgentRun, uuid.UUID(str(body.get("run") or "")))
        except ValueError:
            r = None
        if r is not None and r.user_id == u.id:
            r.data = {**(r.data or {}), "dispatch": entry}
            return {"dispatch": [entry]}
        return {"dispatch": record(u, key, entry)}

    @app.post("/v1/users/{user_id}/chats/council")
    def chats_council(user_id: uuid.UUID, body: dict, rt: Runtime = Depends(get_rt)):
        """评审与合成: the answers several agents gave to one question, reviewed blind and ranked, then merged into one
        answer (a new version of the turn). After LLM Council (design), Mixture-of-Agents (aggregator) and Chatbot Arena (Elo)."""
        from pga.agents.council import CouncilError, convene
        u = user_or_404(rt, user_id)
        try:
            with rt.billing(user_ctx(u)):
                return convene(rt, u, uuid.UUID(str(body.get("run"))))
        except (CouncilError, ValueError) as exc:
            raise HTTPException(422, str(exc)) from exc

    @app.get("/v1/users/{user_id}/arena")
    def arena(user_id: uuid.UUID, rt: Runtime = Depends(get_rt)):
        """The agents' Elo from blind reviews and the versions you picked."""
        from pga.agents.council import leaderboard
        return leaderboard(user_or_404(rt, user_id))

    @app.post("/v1/users/{user_id}/chats/rate")
    def chats_rate(user_id: uuid.UUID, body: dict, rt: Runtime = Depends(get_rt)):
        from pga.chats import ChatError, rate
        try:
            return rate(rt, user_or_404(rt, user_id), uuid.UUID(str(body.get("run"))), int(body.get("rating") or 0), str(body.get("note") or ""))
        except (ChatError, ValueError) as exc:
            raise HTTPException(422, str(exc)) from exc

    @app.get("/v1/users/{user_id}/chats-search")
    def chats_search(user_id: uuid.UUID, q: str = Query("", max_length=200), rt: Runtime = Depends(get_rt)):
        from pga.chats import search
        return search(rt, user_or_404(rt, user_id), q)

    @app.get("/v1/users/{user_id}/chat-system")
    def chats_system_get(user_id: uuid.UUID, key: str = Query("", max_length=120), rt: Runtime = Depends(get_rt)):
        u = user_or_404(rt, user_id)
        return {"key": key, "text": ((u.preferences or {}).get("chat_system") or {}).get(key, "")}

    @app.put("/v1/users/{user_id}/chat-system")
    def chats_system_put(user_id: uuid.UUID, body: dict, rt: Runtime = Depends(get_rt)):
        """Your own instructions for one conversation (a system prompt): every agent in it reads them."""
        u = user_or_404(rt, user_id)
        key, text = str(body.get("key") or "")[:120], str(body.get("text") or "").strip()[:6000]
        if not key:
            raise HTTPException(422, "key is needed")
        cs = dict((u.preferences or {}).get("chat_system") or {})
        if text:
            cs[key] = text
        else:
            cs.pop(key, None)
        u.preferences = {**(u.preferences or {}), "chat_system": dict(list(cs.items())[-1000:])}
        return {"key": key, "text": text}

    @app.get("/v1/users/{user_id}/ratings")
    def ratings(user_id: uuid.UUID, rt: Runtime = Depends(get_rt)):
        """How you rated each agent, per kind of question — what auto routing now takes into account."""
        from pga.agents.routing import rating_table
        user_or_404(rt, user_id)
        return rating_table(rt, user_id)

    @app.put("/v1/users/{user_id}/chats/title")
    def chats_title(user_id: uuid.UUID, body: dict, rt: Runtime = Depends(get_rt)):
        """Rename a chat (empty: back to its first message)."""
        from pga.chats import set_title
        key = str(body.get("key") or "")[:120]
        if not key:
            raise HTTPException(422, "key is needed")
        set_title(user_or_404(rt, user_id), key, str(body.get("title") or ""))
        return {"key": key, "title": str(body.get("title") or "").strip()[:80] or None}

    PROMPTS_MAX = 200

    @app.get("/v1/users/{user_id}/prompts")
    def prompts_get(user_id: uuid.UUID, rt: Runtime = Depends(get_rt)):
        """Your prompt library: type / in the composer to use one."""
        return (user_or_404(rt, user_id).preferences or {}).get("prompts") or []

    @app.put("/v1/users/{user_id}/prompts")
    def prompts_put(user_id: uuid.UUID, body: dict, rt: Runtime = Depends(get_rt)):
        u = user_or_404(rt, user_id)
        out = []
        for x in (body.get("prompts") or [])[:PROMPTS_MAX]:
            cmd = re.sub(r"[^\w\-\u3400-\u9fff]", "", str((x or {}).get("command") or ""))[:40]
            if cmd and str(x.get("text") or "").strip():
                out.append({"command": cmd, "title": str(x.get("title") or cmd)[:80], "text": str(x["text"])[:8000]})
        u.preferences = {**(u.preferences or {}), "prompts": out}
        return out

    @app.post("/v1/users/{user_id}/chats/second")
    def chats_second(user_id: uuid.UUID, body: dict, rt: Runtime = Depends(get_rt)):
        """A second opinion on one reply: another agent answers the same question; then both are compared."""
        from pga.chats import ChatError, second_opinion
        u = user_or_404(rt, user_id)
        try:
            with rt.billing(user_ctx(u)):
                return second_opinion(rt, u, uuid.UUID(str(body.get("run"))), str(body.get("agent") or "") or None)
        except (ChatError, ValueError) as exc:
            raise HTTPException(422, str(exc)) from exc

    @app.post("/v1/users/{user_id}/chats/note", status_code=201)
    def chats_note(user_id: uuid.UUID, body: dict, rt: Runtime = Depends(get_rt)):
        """Your own response or next step, written into a conversation without asking any agent. It stays in the
        conversation (agents read it next time) and on its line of the time tree."""
        from pga.db.models import AgentRun
        from pga.timeline import Timeline
        u = user_or_404(rt, user_id)
        text = str(body.get("text") or "").strip()
        key = str(body.get("conversation") or "")[:120] or f"chat:{uuid.uuid4().hex[:10]}"
        if not text:
            raise HTTPException(422, "text is needed")
        now = utcnow()
        r = AgentRun(user_id=u.id, workflow="ask", pattern="single", step="note", agent="you", adapter="note", status="SUCCEEDED",
                     prompt=text[:20000], output="", data={"conversation": key, "note": True, "agent": "you"}, started_at=now, finished_at=now)
        rt.session.add(r)
        if body.get("line"):
            Timeline(rt).move(u, key, str(body["line"])[:120])
        rt.session.flush()
        return {"key": key, "run": str(r.id)}

    @app.post("/v1/users/{user_id}/chats/branch", status_code=201)
    def chats_branch(user_id: uuid.UUID, body: dict, rt: Runtime = Depends(get_rt)):
        """A new chat that grows from one reply of another; it goes on the same line of the time tree."""
        from pga.chats import set_branch
        from pga.timeline import Timeline
        u = user_or_404(rt, user_id)
        parent, upto = str(body.get("from") or ""), str(body.get("upto") or "")
        if not parent or not upto:
            raise HTTPException(422, "from and upto are needed")
        key = str(body.get("key") or f"chat:{uuid.uuid4().hex[:10]}")[:120]
        b = set_branch(u, key, parent, upto)
        tl = Timeline(rt)
        line = tl.lines_of(u, [it for it in tl.items(u, utcnow() - timedelta(days=730)) if it.key == parent]).get(parent, parent)
        tl.move(u, key, line)
        return {"key": key, **b, "line": line}

    @app.post("/v1/users/{user_id}/i18n")
    def i18n_texts(user_id: uuid.UUID, body: dict, rt: Runtime = Depends(get_rt)):
        """The English pages: the dialogue on screen, in English (each piece translated once, then kept)."""
        from pga.i18n import translate_many
        user_or_404(rt, user_id)
        texts = [str(t or "")[:6000] for t in (body.get("texts") or [])][:40]
        return {"texts": translate_many(rt, texts, str(body.get("lang") or "en"))}

    @app.post("/v1/aims/{aim_id}/tree/focus")
    def tree_focus(aim_id: uuid.UUID, body: dict, rt: Runtime = Depends(get_rt)):
        """Tell the team which branch to keep thinking along (or none)."""
        from pga.tree import ThoughtTree, TreeError
        aim = aim_or_404(rt, aim_id)
        node = tree_node_or_404(rt, uuid.UUID(str(body["node_id"]))) if body.get("node_id") else None
        if node is not None and node.aim_id != aim.id:
            raise HTTPException(422, "that node belongs to another motivation")
        try:
            return ThoughtTree(rt).focus(aim, node)
        except TreeError as exc:
            raise HTTPException(409, str(exc)) from exc

    @app.get("/v1/aims/{aim_id}/allocation")
    def perpetual_allocation(aim_id: uuid.UUID, role: str = "researcher", rt: Runtime = Depends(get_rt)):
        """How this motivation shares its work out: your weights, every agent's parts, score and target share,
        and how the work really went over the last 24 hours."""
        from pga.allocation import Allocation
        from pga.db.models import PerpetualTask
        from pga.perpetual import Perpetual
        from pga.teams import ROLES
        aim = aim_or_404(rt, aim_id)
        t = rt.session.scalar(select(PerpetualTask).where(PerpetualTask.aim_id == aim.id))
        if t is None:
            raise HTTPException(404, "this aim is not a perpetual task")
        if role not in ROLES:
            raise HTTPException(422, f"role is one of {list(ROLES)}")
        al = Allocation(Perpetual(rt))
        step = {"lead": "think", "researcher": "investigate", "critic": "reflect"}.get(role, "investigate")
        return {"settings": al.settings(t), "role": role, "rows": al.table(t, aim, role, step), "actual": al.actual(t),
                "roles": {k: v["label"] for k, v in ROLES.items()}}

    @app.post("/v1/aims/{aim_id}/perpetual/checkpoint")
    def perpetual_checkpoint(aim_id: uuid.UUID, body: dict, rt: Runtime = Depends(get_rt)):
        """Your decision at a checkpoint: continue (approving proposals), adjust (your words become guidance) or stop."""
        from pga.db.models import AimNote, PerpetualTask
        from pga.perpetual import Perpetual
        aim = aim_or_404(rt, aim_id)
        u = user_or_404(rt, aim.user_id)
        t = rt.session.scalar(select(PerpetualTask).where(PerpetualTask.aim_id == aim.id))
        try:
            n = rt.session.get(AimNote, uuid.UUID(str(body.get("note_id"))))
        except ValueError:
            n = None
        if t is None or n is None or n.aim_id != aim.id:
            raise HTTPException(404, "checkpoint not found")
        text = str(body.get("text") or "").strip()[:4000]
        option = body.get("option")
        try:
            Perpetual(rt).resolve_checkpoint(t, n, str(body.get("decision") or ""), text=text,
                                             text_en=canonical(rt, u, text)[0] if text else "",
                                             approve=[str(c) for c in body.get("approve") or []][:20],
                                             option=int(option) if option is not None else None)
        except ValueError as exc:
            raise HTTPException(409, str(exc)) from exc
        relayer(rt, u, f"aim:{aim.id}")
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
    # ---------------------------------------------------------------- the console (工作台)

    def console_err(exc: Exception) -> HTTPException:
        return HTTPException(422 if "抱负" in str(exc) or "action" in str(exc) else 404, str(exc))

    @app.get("/v1/users/{user_id}/console")
    def console_overview(user_id: uuid.UUID, rt: Runtime = Depends(get_rt)):
        """Motivations with their project folders and what each is doing, every agent, and what is running now."""
        from pga.console import Console
        return Console(rt).overview(user_or_404(rt, user_id))

    @app.get("/v1/users/{user_id}/console/aims/{aim_id}")
    def console_process(user_id: uuid.UUID, aim_id: uuid.UUID, limit: int = Query(60, le=200), rt: Runtime = Depends(get_rt)):
        """One motivation's process: who is working now, and its self-dialogue (questions, answers, reviews, reflections)."""
        from pga.console import Console, ConsoleError
        try:
            return Console(rt).process(user_or_404(rt, user_id), aim_id, limit)
        except ConsoleError as exc:
            raise console_err(exc) from exc

    @app.get("/v1/users/{user_id}/console/runs/{run_id}")
    def console_run(user_id: uuid.UUID, run_id: uuid.UUID, rt: Runtime = Depends(get_rt)):
        """One step in full: the prompt, the answer, and the trace (files it read, commands, its thinking)."""
        from pga.console import Console, ConsoleError
        try:
            return Console(rt).run_detail(user_or_404(rt, user_id), run_id)
        except ConsoleError as exc:
            raise console_err(exc) from exc

    @app.post("/v1/users/{user_id}/projects/{pid}/run")
    def console_project_run(user_id: uuid.UUID, pid: uuid.UUID, body: dict, rt: Runtime = Depends(get_rt)):
        """▶ start / ⏸ pause the work on a project (its motivation's perpetual task, in this folder)."""
        from pga.console import Console, ConsoleError
        from pga.projects import ProjectError
        u = user_or_404(rt, user_id)
        if (u.preferences or {}).get("demo"):
            raise HTTPException(403, "a demo account cannot run perpetual tasks")
        try:
            return Console(rt).project_run(u, pid, str(body.get("action") or ""))
        except (ConsoleError, ProjectError) as exc:
            raise console_err(exc) from exc

    @app.post("/v1/agents/{name}/enabled")
    def console_agent_enabled(name: str, body: dict, rt: Runtime = Depends(get_rt)):
        """Switch an agent off (what it is doing stops; nothing new is sent to it) or back on."""
        from pga.console import Console, ConsoleError
        try:
            return Console(rt).set_agent_enabled(name, bool(body.get("enabled")))
        except ConsoleError as exc:
            raise HTTPException(404, str(exc)) from exc

    @app.post("/v1/agents/{name}/stop")
    def console_agent_stop(name: str):
        """Stop everything this agent is doing right now (it stays switched on)."""
        from pga.console import stop_agent
        return {"stopped": stop_agent(name)}

    return app


app = create_app()
