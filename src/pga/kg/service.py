"""The fact graph: what your conversations established, as entities and facts that know when they held.

The pipeline is graphiti's `add_episode` (getzep/graphiti, Apache-2.0; the copied parts are in this package's
prompts.py, dedup.py, temporal.py and search.py, each with its notice), on PGA's Postgres and model router:

1. a stretch of a conversation becomes an episode (its reference time = when it was said);
2. one model call extracts entities and facts, with their dates (graphiti's combined extraction prompt);
3. entities are resolved against the ones known: exact names, then MinHash/LSH over shingles, then — only for what is
   still ambiguous — a model call (graphiti's dedupe_nodes);
4. each new fact is compared with the facts between the same entities (duplicates?) and with the facts around either
   entity (contradicted?) — graphiti's resolve_edge, asked for all of an episode's facts in one call;
5. a contradicted older fact is not deleted: it gets invalid_at (when it stopped holding) and expired_at (when PGA
   learned it), and points to the fact that replaced it (graphiti's temporal invalidation).

PGA's own choices: a whole conversation is read a stretch at a time (new turns → a new episode) instead of message by
message; a fact without a date counts from its episode's reference time; for a long conversation seen for the first
time only its most recent stretches are read (`FIRST_PARTS`), so filling the graph costs a bounded number of calls.
Text sent to the model has secrets redacted.
"""
from __future__ import annotations

import logging
import re
import uuid
from datetime import datetime, timedelta
from typing import TYPE_CHECKING, Any

from sqlalchemy import or_, select

from pga.agent.common import UNTRUSTED_NOTE, ModelOutputError, parse_json
from pga.allocator import Estimates, Justification, RunRequest
from pga.db.models import AgentConversation, KgEdge, KgEntity, KgEpisode, LinkedAgent, User
from pga.db.types import utcnow
from pga.kg import dedup, prompts, temporal
from pga.kg.search import bm25, search_edges

if TYPE_CHECKING:
    from pga.runtime import Runtime

log = logging.getLogger(__name__)

PART_CHARS = 9000          # one episode: about this much of a conversation
FIRST_PARTS = 2            # a conversation seen for the first time: its last few stretches only
RESOLVE_BATCH = 14         # new facts per resolve call


class FactGraphDeferred(RuntimeError):
    """No budget or no model right now: later."""


def _iso(d: datetime | None) -> str | None:
    return d.isoformat() if d else None


class FactGraph:
    def __init__(self, rt: "Runtime"):
        self.rt, self.s = rt, rt.session

    # -------------------------------------------------------------- a model call
    def _ask(self, user: User, system: str, prompt: str, why: str, max_tokens: int = 3000, now: datetime | None = None) -> dict:
        now = now or utcnow()
        decision = self.rt.allocator.allocate(RunRequest(
            user_id=user.id, kind="synthesis",
            justification=Justification(
                why_now=why, expected_gain="what your conversations established is remembered, with when it held",
                decision_affected="what an agent knows to be current when you talk to it",
                budget={"max_units": 60_000, "max_output_tokens": max_tokens}, stop_condition="this episode is in the fact graph"),
            estimates=Estimates(information_gain=.4, decision_impact=.4, user_relevance=.7, reuse_value=.8,
                                input_tokens=len(prompt) // 3, output_tokens=max_tokens // 2)), now=now)
        if not decision.allowed:
            raise FactGraphDeferred("; ".join(decision.reasons))
        try:
            with self.rt.runs.track(decision, now) as guard:
                res = self.rt.router.complete(decision.tier, system=system + " " + UNTRUSTED_NOTE,
                                              messages=[{"role": "user", "content": prompt}], max_tokens=max_tokens, usage=guard.usage_context())
                try:
                    d = parse_json(res.text)
                except ModelOutputError:
                    guard.stop("fact graph reply was not JSON")
                    return {}
                guard.stop("fact graph step done")
        except FactGraphDeferred:
            raise
        except Exception as exc:  # noqa: BLE001
            log.warning("fact graph: model call failed: %s", exc)
            raise FactGraphDeferred(f"the model could not be reached: {exc}"[:300]) from exc
        return d if isinstance(d, dict) else {}

    # -------------------------------------------------------------- conversations, turn by turn
    def turns(self, user: User, key: str) -> list[dict]:
        from pga.hub.connectors import redact
        out: list[dict] = []
        if key.startswith(("n:", "aim:", "run:")):
            return out
        if key.startswith("c:"):
            try:
                c = self.s.get(AgentConversation, uuid.UUID(key[2:]))
            except ValueError:
                return out
            a = self.s.get(LinkedAgent, c.linked_agent_id) if c else None
            if c is None or a is None or a.user_id != user.id:
                return out
            from pga.hub.connectors import full_turns
            full = [t for t in full_turns(a.connector, c.external_id) if t.get("role") in ("user", "assistant")]
            if full:
                return [{"role": t["role"], "text": t["text"], "at": t.get("at") or _iso(c.updated_at)} for t in full]
            for line in (c.excerpt or "").split("\n"):                     # only the excerpt is kept for this app
                m = re.match(r"^(User|Assistant):\s?(.*)$", line)
                if m:
                    out.append({"role": "user" if m.group(1) == "User" else "assistant", "text": redact(m.group(2)), "at": _iso(c.updated_at)})
                elif out:
                    out[-1]["text"] += "\n" + line
            return out
        from pga.chats import current, fold, runs_of
        from pga.tree import _answer
        turns, alts = fold(runs_of(self.rt, user.id, key))
        for r in turns:
            out.append({"role": "user", "text": redact(r.prompt or ""), "at": _iso(r.started_at)})
            a = current(r, alts)
            if a.output:
                out.append({"role": "assistant", "text": redact(_answer(a.output) or ""), "at": _iso(a.finished_at or a.started_at)})
        return out

    def _done_upto(self, user: User, key: str) -> int:
        return max((int((e.data or {}).get("upto") or 0) for e in self.s.scalars(select(KgEpisode).where(KgEpisode.user_id == user.id, KgEpisode.ref == key))), default=0)

    def pending(self, user: User, since: datetime | None = None) -> list[dict]:
        """Conversations with turns not read into the graph yet, the most recent first."""
        from pga.worldtree import WorldTree
        done: dict[str, datetime] = {}
        for e in self.s.scalars(select(KgEpisode).where(KgEpisode.user_id == user.id)):
            if e.valid_at and (e.ref not in done or e.valid_at > done[e.ref]):
                done[e.ref] = e.valid_at
        out = []
        for x in WorldTree(self.rt).items(user):
            if x["kind"] not in ("chat", "import") or (since and (x["last"] or "") < since.isoformat()):
                continue
            last = _parse(x.get("last"))
            if x["key"] not in done or (last and last > done[x["key"]] + timedelta(seconds=1)):
                out.append(x)
        out.sort(key=lambda x: x["last"] or "", reverse=True)
        return out

    def ingest(self, user: User, x: dict, now: datetime | None = None, max_parts: int = 4) -> dict:
        """New turns of one conversation → episodes → entities and facts."""
        now = now or utcnow()
        ts = [t for t in self.turns(user, x["key"]) if (t.get("text") or "").strip()]
        start = self._done_upto(user, x["key"])
        new = ts[start:]
        if not new:
            return {"episodes": 0}
        parts, cur, size = [], [], 0
        for i, t in enumerate(new):
            line = f"{'User' if t['role'] == 'user' else 'Assistant'}: {t['text'][:3000]}"
            if cur and size + len(line) > PART_CHARS:
                parts.append(cur)
                cur, size = [], 0
            cur.append((start + i, t, line))
            size += len(line)
        if cur:
            parts.append(cur)
        skipped = 0
        if start == 0 and len(parts) > FIRST_PARTS:              # seen for the first time: its latest stretches
            skipped = len(parts) - FIRST_PARTS
            parts = parts[-FIRST_PARTS:]
        parts = parts[:max_parts]
        made = {"episodes": 0, "entities": 0, "facts": 0, "duplicates": 0, "invalidated": 0, "skipped_parts": skipped}
        for p in parts:
            first = p[0][0]
            prev = [f"{'User' if t['role'] == 'user' else 'Assistant'}: {t['text'][:400]}" for t in ts[max(0, first - 2):first]]
            ref_time = _parse(p[-1][1].get("at")) or now
            r = self.add_episode(user, x["key"], x.get("title") or "", "\n\n".join(ln for _, _, ln in p), ref_time,
                                 previous=prev, upto=p[-1][0] + 1, part=first, now=now)
            for k in ("entities", "facts", "duplicates", "invalidated"):
                made[k] += r.get(k, 0)
            made["episodes"] += 1
        return made

    # -------------------------------------------------------------- graphiti's add_episode
    def add_episode(self, user: User, ref: str, title: str, content: str, ref_time: datetime, *, previous: list[str] | None = None,
                    upto: int = 0, part: int = 0, now: datetime | None = None) -> dict:
        now = now or utcnow()
        ep = KgEpisode(user_id=user.id, ref=ref, part=part, content=content[:20000], valid_at=ref_time,
                       data={"title": title[:200], "upto": upto}, created_at=now)
        self.s.add(ep)
        self.s.flush()
        system, prompt = prompts.extract_message(content, ref_time.isoformat(), previous)
        d = self._ask(user, system, prompt, f"reading facts out of «{title[:40]}»", 4000, now)
        ents = [e for e in (d.get("extracted_entities") or []) if isinstance(e, dict) and str(e.get("name") or "").strip()][:40]
        raw_edges = [e for e in (d.get("edges") or []) if isinstance(e, dict) and str(e.get("fact") or "").strip()][:60]
        if not ents:
            ep.data = {**ep.data, "entities": 0, "facts": 0}
            return {"entities": 0, "facts": 0}
        resolved = self._resolve_entities(user, ents, content, now)
        by_name = {dedup._normalize_string_exact(str(e["name"])): resolved[i] for i, e in enumerate(ents)}
        new_edges: list[KgEdge] = []
        for e in raw_edges:
            src = by_name.get(dedup._normalize_string_exact(str(e.get("source_entity_name") or "")))
            dst = by_name.get(dedup._normalize_string_exact(str(e.get("target_entity_name") or "")))
            if src is None or dst is None:
                continue
            edge = KgEdge(id=uuid.uuid4(), user_id=user.id, source_id=src.id, target_id=dst.id,
                          relation=re.sub(r"[^A-Z0-9_]", "_", str(e.get("relation_type") or "RELATES_TO").upper())[:80] or "RELATES_TO",
                          fact=str(e["fact"]).strip()[:2000], episodes=[str(ep.id)], refs=[ref], created_at=now)
            edge.valid_at = edge.invalid_at = edge.expired_at = None
            temporal.apply_extracted_timestamps(edge, e.get("valid_at"), e.get("invalid_at"), ref_time)
            if edge.valid_at is None:                         # PGA: a fact counts from when it was said
                edge.valid_at = ref_time
            new_edges.append(edge)
        kept, dup, inval = self._resolve_edges(user, new_edges, ep, ref, now)
        for x in kept:
            self.s.add(x)
        for ent in set(resolved):
            refs = list(dict.fromkeys([*((ent.data or {}).get("refs") or []), ref]))[-50:]
            ent.data = {**(ent.data or {}), "refs": refs, "last": now.isoformat()}
        ep.data = {**ep.data, "entities": len(set(resolved)), "facts": len(kept), "duplicates": dup, "invalidated": inval}
        self.s.flush()
        return {"entities": len(set(resolved)), "facts": len(kept), "duplicates": dup, "invalidated": inval}

    def _resolve_entities(self, user: User, ents: list[dict], content: str, now: datetime) -> list[KgEntity]:
        existing = list(self.s.scalars(select(KgEntity).where(KgEntity.user_id == user.id)))
        names = [str(e["name"]).strip()[:200] for e in ents]
        state = dedup.DedupResolutionState(resolved_nodes=[None] * len(names))
        dedup._resolve_with_similarity(names, dedup._build_candidate_indexes(existing), state)
        todo = [i for i in state.unresolved_indices]
        if todo and existing:                                 # ambiguous ones: graphiti's dedupe_nodes, with the closest candidates
            cand_ids: list[str] = []
            for i in todo:
                cand_ids += bm25({str(x.id): x.name for x in existing}, names[i], k=6)
            cands = [x for x in existing if str(x.id) in dict.fromkeys(cand_ids)][:40]
            if cands:
                system, prompt = prompts.dedupe_nodes(content[:6000], [{"id": j, "name": names[i], "entity_type": _label(ents[i])} for j, i in enumerate(todo)],
                                                      [{"candidate_id": k, "name": c.name, "entity_types": [c.label], "summary": c.summary[:200]} for k, c in enumerate(cands)])
                d = self._ask(user, system, prompt, "telling apart entities with similar names", 1500, now)
                for r in d.get("entity_resolutions") or []:
                    try:
                        j, k = int(r.get("id")), int(r.get("duplicate_candidate_id"))
                    except (TypeError, ValueError):
                        continue
                    if 0 <= j < len(todo) and 0 <= k < len(cands):
                        state.resolved_nodes[todo[j]] = cands[k]
        out: list[KgEntity] = []
        for i, name in enumerate(names):
            n = state.resolved_nodes[i]
            if n is None:                                     # a new entity (or the same new name twice in one episode)
                n = next((x for x in out if dedup._normalize_string_exact(x.name) == dedup._normalize_string_exact(name)), None)
            if n is None:
                n = KgEntity(id=uuid.uuid4(), user_id=user.id, name=name, label=_label(ents[i]), summary="", data={}, created_at=now)
                self.s.add(n)
            out.append(n)
        self.s.flush()
        return out

    def _resolve_edges(self, user: User, new: list[KgEdge], ep: KgEpisode, ref: str, now: datetime) -> tuple[list[KgEdge], int, int]:
        if not new:
            return [], 0, 0
        ids = {e.source_id for e in new} | {e.target_id for e in new}
        around = list(self.s.scalars(select(KgEdge).where(KgEdge.user_id == user.id, KgEdge.expired_at.is_(None),
                                                         or_(KgEdge.source_id.in_(ids), KgEdge.target_id.in_(ids)))))
        items, plan = [], []
        for e in new:
            same = [x for x in around if {x.source_id, x.target_id} == {e.source_id, e.target_id}][:10]
            others = [x for x in around if x not in same and (e.source_id in (x.source_id, x.target_id) or e.target_id in (x.source_id, x.target_id))]
            ranked = bm25({str(x.id): x.fact for x in others}, e.fact, k=8)
            cands = [x for x in others if str(x.id) in ranked]
            if same or cands:
                items.append({"new_fact": e.fact, "existing_facts": [{"idx": i, "fact": x.fact} for i, x in enumerate(same)],
                              "invalidation_candidates": [{"idx": len(same) + i, "fact": x.fact} for i, x in enumerate(cands)]})
                plan.append((e, same, cands))
        verdicts: dict[int, dict] = {}
        for b in range(0, len(items), RESOLVE_BATCH):
            system, prompt = prompts.resolve_edges(items[b:b + RESOLVE_BATCH])
            d = self._ask(user, system, prompt, "checking new facts against what was known", 2000, now)
            for v in d.get("items") or []:
                try:
                    verdicts[b + int(v.get("n"))] = v
                except (TypeError, ValueError):
                    continue
        kept, dup, inval = [], 0, 0
        planned = {id(e): i for i, (e, _, _) in enumerate(plan)}
        for e in new:
            i = planned.get(id(e))
            if i is None:
                kept.append(e)
                continue
            _, same, cands = plan[i]
            v = verdicts.get(i) or {}
            both = same + cands
            dups = [same[k] for k in _ints(v.get("duplicate_facts")) if 0 <= k < len(same)]
            contra = [both[k] for k in _ints(v.get("contradicted_facts")) if 0 <= k < len(both)]
            if dups and not contra:                           # the same fact again: it gains this episode, no new fact
                d0 = dups[0]
                d0.episodes = list(dict.fromkeys([*(d0.episodes or []), str(ep.id)]))
                d0.refs = list(dict.fromkeys([*(d0.refs or []), ref]))
                dup += 1
                continue
            for x in temporal.apply_temporal_invalidation(e, contra):
                x.invalidated_by = e.id
                inval += 1
            kept.append(e)
        return kept, dup, inval

    # -------------------------------------------------------------- reading it
    def edges_for_refs(self, user: User, refs: list[str]) -> list[KgEdge]:
        rs = set(refs)
        return [e for e in self.s.scalars(select(KgEdge).where(KgEdge.user_id == user.id)) if rs.intersection(e.refs or [])]

    def topic_facts(self, user: User, refs: list[str], current: int = 15, past: int = 6) -> tuple[list[KgEdge], list[KgEdge]]:
        es = self.edges_for_refs(user, refs)
        cur = sorted([e for e in es if e.expired_at is None and e.invalid_at is None], key=lambda e: e.valid_at or e.created_at, reverse=True)
        old = sorted([e for e in es if e.expired_at is not None or e.invalid_at is not None], key=lambda e: e.expired_at or e.invalid_at or e.created_at, reverse=True)
        return cur[:current], old[:past]

    def search(self, user: User, query: str, refs: list[str] | None = None, k: int = 12, current_only: bool = True) -> list[KgEdge]:
        es = self.edges_for_refs(user, refs) if refs is not None else list(self.s.scalars(select(KgEdge).where(KgEdge.user_id == user.id)))
        ents = {str(x.id): x for x in self.s.scalars(select(KgEntity).where(KgEntity.user_id == user.id))}
        return search_edges(es, ents, query, k=k, current_only=current_only)

    def describe(self, e: KgEdge, with_replacement: bool = True) -> str:
        when = f"since {e.valid_at:%Y-%m-%d}" if e.valid_at else ""
        if e.invalid_at or e.expired_at:
            end = e.invalid_at or e.expired_at
            rep = self.s.get(KgEdge, e.invalidated_by) if (with_replacement and e.invalidated_by) else None
            return f"{e.fact} ({(e.valid_at.strftime('%Y-%m-%d') + ' – ') if e.valid_at else ''}{end:%Y-%m-%d}, no longer holds" + (f"; replaced by: {rep.fact}" if rep else "") + ")"
        return f"{e.fact} ({when})" if when else e.fact

    def out_edge(self, e: KgEdge, names: dict | None = None) -> dict:
        rep = self.s.get(KgEdge, e.invalidated_by) if e.invalidated_by else None
        return {"id": str(e.id), "fact": e.fact, "relation": e.relation, "valid_at": _iso(e.valid_at), "invalid_at": _iso(e.invalid_at),
                "expired_at": _iso(e.expired_at), "current": e.expired_at is None and e.invalid_at is None, "refs": e.refs,
                "replaced_by": {"id": str(rep.id), "fact": rep.fact} if rep else None,
                **({"source": names.get(e.source_id), "target": names.get(e.target_id)} if names else {})}

    def stats(self, user: User) -> dict:
        from sqlalchemy import func
        n = lambda m, *w: self.s.scalar(select(func.count()).select_from(m).where(m.user_id == user.id, *w)) or 0  # noqa: E731
        return {"episodes": n(KgEpisode), "entities": n(KgEntity), "facts": n(KgEdge, KgEdge.expired_at.is_(None), KgEdge.invalid_at.is_(None)),
                "invalidated": n(KgEdge, or_(KgEdge.expired_at.is_not(None), KgEdge.invalid_at.is_not(None)))}

    def fill(self, user: User, *, days: int | None = None, limit: int = 10, now: datetime | None = None, progress=None) -> dict:
        """Read pending conversations into the graph, most recent first (`limit` conversations)."""
        now = now or utcnow()
        todo = self.pending(user, since=now - timedelta(days=days) if days else None)
        total = {"conversations": 0, "episodes": 0, "facts": 0, "invalidated": 0, "left": max(0, len(todo) - limit)}
        for i, x in enumerate(todo[:limit]):
            if progress:
                progress(i, min(limit, len(todo)), x.get("title") or "")
            r = self.ingest(user, x, now)
            total["conversations"] += 1
            for k in ("episodes", "facts", "invalidated"):
                total[k] += r.get(k, 0)
            self.s.flush()
        return total


def _label(e: dict) -> str:
    try:
        return prompts.ENTITY_TYPES[int(e.get("entity_type_id") or 0)]["entity_type_name"]
    except (ValueError, IndexError, TypeError):
        return "Entity"


def _ints(v: Any) -> list[int]:
    out = []
    for x in v or []:
        try:
            out.append(int(x))
        except (TypeError, ValueError):
            continue
    return out


def _parse(v: Any) -> datetime | None:
    try:
        return temporal.ensure_utc(datetime.fromisoformat(str(v))) if v else None
    except ValueError:
        return None
