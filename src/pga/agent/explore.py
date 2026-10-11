"""Bounded free exploration (spec §6).

Exploration finds things the user did not know to ask for, but it is never a
random walk: every query is derived from the user's responsibilities and
situation, at one of three distances —

    neighborhood (~70%)   direct responsibility neighborhood
    adjacent     (~20%)   adjacent domains
    distant      (~10%)   distant / serendipitous, still anchored to the user

The scope for each run is the one furthest below its configured share, so the
spend converges on the mix. Every run is billed to `free_exploration` and goes
through the allocator, so it stops when that budget is spent. Results enter as
ordinary external evidence: tension decides whether any of it matters.
"""

from __future__ import annotations

import logging
import uuid
from dataclasses import dataclass, field
from datetime import datetime
from typing import TYPE_CHECKING

from pga.agent.common import UNTRUSTED_NOTE, ModelOutputError, parse_json
from pga.allocator import Estimates, Justification, RunRequest
from pga.db.models import Responsibility, User
from pga.db.types import TERMINAL_STATUSES, Origin, ResponsibilityStatus as S, utcnow
from pga.research import FetchError
from pga.tension import IncomingEvidence

if TYPE_CHECKING:
    from pga.runtime import Runtime

log = logging.getLogger("pga.explore")

MARKER = "PGA_EXPLORATION_QUERIES"

SCOPE_GUIDE = {
    "neighborhood": "directly about the responsibilities' own topics: new results, releases, competitors, deadlines",
    "adjacent": "neighbouring fields or methods that could plausibly change how the user approaches these topics",
    "distant": "a surprising but defensible connection between the user's situation and a far-away domain",
}

SYSTEM = f"""{MARKER}
You plan one small, bounded exploration step for the user's personal agent. Propose search queries that
might surface something the user would want to know but did not ask for. Stay anchored to the user's
responsibilities and situation; never propose random or generic queries. {UNTRUSTED_NOTE}

Reply with JSON only: {{"queries": ["...", "..."], "rationale": "..."}}"""


@dataclass
class ExploreOutcome:
    status: str                                 # done | deferred | skipped
    scope: str | None = None
    reason: str = ""
    queries: list[str] = field(default_factory=list)
    ingested: int = 0
    run_id: uuid.UUID | None = None
    retry_after: datetime | None = None


class Explorer:
    def __init__(self, rt: "Runtime"):
        self.rt = rt

    def pick_scope(self, user_id: uuid.UUID, now: datetime) -> str:
        mix = self.rt.policy.budget.exploration_mix
        spent = {s: self.rt.ledger.spend(user_id, category="free_exploration", exploration_scope=s, now=now)
                 for s in mix}
        total = sum(spent.values())
        if total <= 0:
            return max(mix, key=mix.get)
        # the scope furthest below its target share goes next
        return max(mix, key=lambda s: mix[s] - spent[s] / total)

    def run(self, user: User, now: datetime | None = None, scope: str | None = None) -> ExploreOutcome:
        rt = self.rt
        now = now or utcnow()
        anchors = [r for r in rt.responsibilities.list(user.id)
                   if r.status not in TERMINAL_STATUSES and r.status != S.CANDIDATE and not r.paused_by_user]
        if not anchors:
            return ExploreOutcome("skipped", reason="no live responsibilities to anchor exploration")
        scope = scope or self.pick_scope(user.id, now)
        n_q = rt.policy.workflow.exploration_queries
        per_q = rt.policy.workflow.exploration_results_per_query
        decision = rt.allocator.allocate(RunRequest(
            user_id=user.id, kind="exploration", exploration_scope=scope,
            justification=Justification(
                why_now=f"scheduled bounded exploration ({scope})",
                expected_gain=f"discover {scope} information the user did not ask for",
                decision_affected="which responsibilities should gain tension or new candidate directions",
                budget={"max_units": 40_000, "max_tool_calls": n_q + 1, "max_output_tokens": 600},
                stop_condition=f"{n_q} queries run and results ingested"),
            estimates=Estimates(information_gain=0.5, decision_impact=0.3, user_relevance=0.5,
                                reuse_value=0.3, input_tokens=1500, output_tokens=300)), now=now)
        if not decision.allowed:
            return ExploreOutcome("deferred", scope, "; ".join(decision.reasons), retry_after=decision.retry_after)

        with rt.runs.track(decision, now) as guard:
            queries = self._queries(user, anchors, scope, n_q, decision, guard)
            ingested = 0
            for q in queries:
                guard.tool_call("search", query=q, scope=scope)
                try:
                    hits = rt.search.search(q, per_q)
                except FetchError as exc:
                    log.warning("exploration search failed: %s", exc)
                    continue
                for h in hits:
                    res = rt.tension.ingest(user.id, IncomingEvidence(
                        text=f"{h.title}\n\n{h.snippet}", title=h.title, source_type=f"exploration:{scope}",
                        source_uri=h.url, published_at=h.published_at, trust_score=0.5,
                        event_key=f"{h.source}:{h.key}", origin=Origin.EXTERNAL), now=now)
                    guard.new_evidence.append(str(res.evidence.id))
                    ingested += 1
            guard.stop(f"{len(queries)} {scope} queries, {ingested} results ingested")
            return ExploreOutcome("done", scope, queries=queries, ingested=ingested, run_id=guard.run.id)

    def _queries(self, user: User, anchors: list[Responsibility], scope: str, n: int, decision, guard) -> list[str]:
        rt = self.rt
        if not decision.tier:
            return self._keyword_queries(anchors, n)
        snap = rt.situation.snapshot(user.id)
        prompt = (f"Scope: {scope} — {SCOPE_GUIDE[scope]}\nNumber of queries: {n}\n\n<responsibilities>\n"
                  + "\n".join(f"- {r.title_en} (keywords: {', '.join(r.keywords or []) or '-'})" for r in anchors)
                  + "\n</responsibilities>\n"
                  + ("<situation>\n" + "\n".join(f"{k}: " + "; ".join(v) for k, v in snap.items())
                     + "\n</situation>" if snap else ""))
        result = rt.router.complete(decision.tier, system=SYSTEM, messages=[{"role": "user", "content": prompt}],
                                    max_tokens=decision.limits.get("max_output_tokens", 600),
                                    usage=guard.usage_context())
        try:
            data = parse_json(result.text)
            qs = [str(q).strip()[:200] for q in data.get("queries") or [] if str(q).strip()]
        except ModelOutputError:
            qs = []
        return qs[:n] or self._keyword_queries(anchors, n)

    @staticmethod
    def _keyword_queries(anchors: list[Responsibility], n: int) -> list[str]:
        qs = []
        for r in anchors:
            kws = [k for k in (r.keywords or []) if k]
            qs.append(" ".join(kws[:3]) if kws else r.title_en[:120])
        return qs[:n]
