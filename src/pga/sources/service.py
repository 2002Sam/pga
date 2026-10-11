"""Monitoring sources (spec §1.3, Phase 2 event ingestion).

A source is a place the user asked the agent to watch: an RSS/Atom feed, an
arXiv query, or a single web page. Only the user adds sources (invariant 11:
external content can't widen what the agent reads on its own). Polling turns
new items into evidence through the Tension Accumulator, which clusters
duplicates and decides how much each item matters.
"""

from __future__ import annotations

import hashlib
import logging
import uuid
from dataclasses import dataclass, field
from datetime import datetime, timedelta

from sqlalchemy import select
from sqlalchemy.orm import Session

from pga import audit
from pga.config import Policy
from pga.db.models import Responsibility, Source
from pga.db.types import Origin, SourceKind, utcnow
from pga.research import FetchError, Fetcher, html_to_text, parse_feed
from pga.research.tools import arxiv_url, check_public_url
from pga.tension import IncomingEvidence, TensionService

log = logging.getLogger("pga.sources")

SEEN_KEYS_MAX = 500
MIN_INTERVAL_MINUTES = 15


class SourceError(ValueError):
    pass


@dataclass
class PollResult:
    source_id: uuid.UUID
    status: str
    new_items: int = 0
    effects: list[dict] = field(default_factory=list)


class SourceService:
    def __init__(self, session: Session, policy: Policy, tension: TensionService, fetcher: Fetcher):
        self.session = session
        self.policy = policy
        self.tension = tension
        self.fetcher = fetcher

    def add(self, *, user_id: uuid.UUID, kind: SourceKind, actor: Origin, uri: str | None = None,
            query: str | None = None, title: str | None = None, responsibility_id: uuid.UUID | None = None,
            interval_minutes: int = 60, trust_score: float = 0.6, validate_url: bool = True) -> Source:
        if actor != Origin.USER:
            raise SourceError("only the user can add a source")
        if kind in {SourceKind.FEED, SourceKind.WEB_PAGE}:
            if not uri:
                raise SourceError(f"{kind.value} needs a uri")
            if validate_url:
                try:
                    check_public_url(uri)
                except FetchError as exc:
                    raise SourceError(str(exc)) from exc
        if kind == SourceKind.ARXIV and not query:
            raise SourceError("ARXIV needs a query")
        if responsibility_id:
            r = self.session.get(Responsibility, responsibility_id)
            if r is None or r.user_id != user_id:
                raise SourceError("responsibility not found")
        if not 0 <= trust_score <= 1:
            raise SourceError("trust_score must be in [0, 1]")
        s = Source(user_id=user_id, responsibility_id=responsibility_id, kind=kind, uri=uri, query=query,
                   title=title, interval_minutes=max(MIN_INTERVAL_MINUTES, interval_minutes),
                   trust_score=trust_score, created_by=actor, seen_keys=[])
        self.session.add(s)
        self.session.flush()
        audit.record(self.session, kind="source.added", entity_type="source", entity_id=s.id, actor=actor,
                     user_id=user_id, source_kind=kind.value, uri=uri, query=query)
        return s

    def list(self, user_id: uuid.UUID) -> list[Source]:
        return list(self.session.scalars(select(Source).where(Source.user_id == user_id).order_by(Source.created_at)))

    def due(self, user_id: uuid.UUID, now: datetime | None = None) -> list[Source]:
        now = now or utcnow()
        return [s for s in self.list(user_id) if s.enabled and (
            s.last_polled_at is None or s.last_polled_at + self._interval(s) <= now)]

    def _interval(self, s: Source) -> timedelta:
        # back off on repeated failures: 1×, 2×, 4× … up to 16× the normal interval
        return timedelta(minutes=s.interval_minutes * min(16, 2 ** s.consecutive_failures))

    # ---------------------------------------------------------------- polling

    def poll(self, s: Source, now: datetime | None = None) -> PollResult:
        now = now or utcnow()
        s.last_polled_at = now
        try:
            if s.kind == SourceKind.WEB_PAGE:
                result = self._poll_page(s, now)
            else:
                result = self._poll_feed(s, now)
            s.consecutive_failures = 0
            s.last_status = f"ok: {result.new_items} new"
        except FetchError as exc:
            s.consecutive_failures += 1
            s.last_status = f"error: {exc}"[:500]
            if s.consecutive_failures >= self.policy.workflow.source_failure_disable_after:
                s.enabled = False
                audit.record(self.session, kind="source.disabled", entity_type="source", entity_id=s.id,
                             actor=Origin.SYSTEM, user_id=s.user_id, reason=s.last_status)
            result = PollResult(s.id, s.last_status)
        self.session.flush()
        return result

    def _poll_feed(self, s: Source, now: datetime) -> PollResult:
        url = arxiv_url(s.query or "", 20) if s.kind == SourceKind.ARXIV else s.uri
        headers = {}
        if s.etag:
            headers["If-None-Match"] = s.etag
        if s.last_modified:
            headers["If-Modified-Since"] = s.last_modified
        res = self.fetcher.get(url, headers)
        if res.not_modified:
            return PollResult(s.id, "not modified")
        if res.status >= 400:
            raise FetchError(f"HTTP {res.status}")
        s.etag = res.headers.get("etag") or res.headers.get("ETag")
        s.last_modified = res.headers.get("last-modified") or res.headers.get("Last-Modified")
        items = parse_feed(res.text)
        seen = set(s.seen_keys or [])
        first_poll = not seen and s.last_status is None
        fresh = [i for i in items if i.key not in seen]
        out = PollResult(s.id, "ok")
        # On the very first poll only the newest few items count, so subscribing to a
        # busy feed doesn't flood the tension accumulator with its whole back catalogue.
        to_ingest = fresh[:5] if first_poll else fresh
        for item in to_ingest:
            text = f"{item.title}\n\n{item.summary}".strip()
            res_ = self.tension.ingest(s.user_id, IncomingEvidence(
                text=text, title=item.title, source_type=f"source:{s.kind.value.lower()}",
                source_uri=item.link, published_at=item.published_at, trust_score=s.trust_score,
                event_key=f"{s.kind.value}:{item.key}", origin=Origin.EXTERNAL), now=now)
            res_.evidence.source_id = s.id
            out.new_items += 1
            out.effects += [{"responsibility_id": str(e.responsibility_id), "delta": round(e.delta, 4),
                             "transition": e.transition} for e in res_.effects]
        s.seen_keys = ([i.key for i in fresh] + list(s.seen_keys or []))[:SEEN_KEYS_MAX]
        return out

    def _poll_page(self, s: Source, now: datetime) -> PollResult:
        res = self.fetcher.get(s.uri)
        if res.status >= 400:
            raise FetchError(f"HTTP {res.status}")
        title, text = html_to_text(res.text)
        digest = hashlib.sha256(text.encode()).hexdigest()
        if digest == s.content_hash:
            return PollResult(s.id, "unchanged")
        first = s.content_hash is None
        s.content_hash = digest
        if first:
            return PollResult(s.id, "baseline recorded")  # nothing "changed" yet
        out = PollResult(s.id, "changed", new_items=1)
        r = self.tension.ingest(s.user_id, IncomingEvidence(
            text=f"Page updated: {title or s.title or s.uri}\n\n{text[:4000]}", title=title or s.title,
            source_type="source:web_page", source_uri=s.uri, trust_score=s.trust_score,
            event_key=f"page:{s.uri}:{digest[:16]}", origin=Origin.EXTERNAL), now=now)
        r.evidence.source_id = s.id
        out.effects = [{"responsibility_id": str(e.responsibility_id), "delta": round(e.delta, 4),
                        "transition": e.transition} for e in r.effects]
        return out
