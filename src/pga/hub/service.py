"""Agent Hub: link the AI agents the user uses (or used), and keep one summary across all of them.

Per agent:   conversations (excerpts) → model → {headline, used_for, topics, projects, preferences, open_threads}
Across all:  agent summaries → model → digest {overview, agent_roles, projects, recurring_needs, overlaps, gaps,
             recommendations, open_threads}

Every model call goes through the allocator like any other run, so it is budgeted and audited.
Summaries are written in English and rendered into the user's language for display; the digest
overview is also given to the core assistant as context in chat.
"""

from __future__ import annotations

import logging
import re
import uuid
from datetime import datetime, timedelta
from typing import TYPE_CHECKING, Any

from sqlalchemy import func, select
from sqlalchemy.exc import IntegrityError

from pga.agent.common import UNTRUSTED_NOTE, ModelOutputError, parse_json
from pga.allocator import Estimates, Justification, RunRequest
from pga.db.models import AgentConversation, HubDigest, LinkedAgent, User
from pga.db.types import CommKind, NotifyReason, utcnow
from pga.hub.connectors import Conv, ImportError_, detect_local, excerpt, iter_corpus, parse_upload, read_local, read_local_split
from pga.notify.service import Proposal

if TYPE_CHECKING:
    from pga.runtime import Runtime

log = logging.getLogger("pga.hub")

LOCAL = {"claude_code", "hermes", "codex", "workbuddy", "codebuddy"}
# which local histories belong to which kind of pool agent (its own app); PGA's own model matches imports by vendor
AGENT_SOURCES = {"codex_local": ("codex",), "claude_local": ("claude_code",), "hermes_local": ("hermes",),
                 "codebuddy_local": ("workbuddy", "codebuddy")}
CONTINUE = {"codex": "thread", "claude_code": "session", "codebuddy": "session", "workbuddy": "session"}   # resumable natively

AGENT_SYSTEM = f"""You summarize how one person uses one AI agent/assistant, from excerpts of their conversations
with it. Be concrete: name real projects, topics and recurring requests; do not invent anything that is not in the
excerpts. {UNTRUSTED_NOTE}

Reply with JSON only:
{{"headline": "one sentence: what this person mainly uses this agent for",
  "used_for": ["3-6 short task types"],
  "topics": [{{"name": "...", "weight": 0.0-1.0}}],
  "projects": [{{"name": "...", "status": "active|paused|done|unknown", "last_seen": "YYYY-MM-DD", "note": "..."}}],
  "preferences": ["how the person likes to work / be answered, only if evident"],
  "open_threads": ["unfinished questions or tasks visible in the latest conversations"],
  "strengths": "what this agent seems to be good at for this person"}}"""

DIGEST_SYSTEM = f"""You combine per-agent usage summaries of one person into a single picture of their AI work.
Point out which agent plays which role, how projects span agents, needs that keep coming back, duplicated effort,
gaps, and practical next steps. Stay grounded in the summaries. {UNTRUSTED_NOTE}

Reply with JSON only:
{{"overview": "3-5 sentences",
  "agent_roles": [{{"agent": "...", "role": "..."}}],
  "projects": [{{"name": "...", "agents": ["..."], "status": "active|paused|done|unknown", "next_step": "..."}}],
  "recurring_needs": ["..."],
  "overlaps": ["work being repeated across agents"],
  "gaps": ["things no agent is covering"],
  "recommendations": ["concrete suggestions"],
  "open_threads": ["..."]}}"""


class HubError(ValueError):
    pass


class HubService:
    def __init__(self, rt: "Runtime"):
        self.rt = rt
        self.session = rt.session

    # ---------------------------------------------------------------- agents
    def list(self, user_id: uuid.UUID) -> list[LinkedAgent]:
        return list(self.session.scalars(select(LinkedAgent).where(LinkedAgent.user_id == user_id)
                                         .order_by(LinkedAgent.usage, LinkedAgent.last_activity_at.desc().nulls_last())))

    def create(self, user_id: uuid.UUID, *, name: str, vendor: str, connector: str = "import", usage: str = "current",
               notes: str = "") -> LinkedAgent:
        if connector in LOCAL and self.session.scalar(select(LinkedAgent).where(
                LinkedAgent.user_id == user_id, LinkedAgent.connector == connector)):
            raise HubError(f"{name} is already linked")
        a = LinkedAgent(user_id=user_id, name=name.strip()[:200] or vendor, vendor=vendor, connector=connector,
                        usage=usage if usage in ("current", "past") else "current", notes=notes, config={})
        self.session.add(a)
        self.session.flush()
        return a

    def conversations(self, agent: LinkedAgent, limit: int = 50) -> list[AgentConversation]:
        return list(self.session.scalars(select(AgentConversation).where(AgentConversation.linked_agent_id == agent.id)
                                         .order_by(AgentConversation.updated_at.desc().nulls_last()).limit(limit)))

    # ---------------------------------------------------------------- bringing history in
    def ingest(self, agent: LinkedAgent, convs: list[Conv], now: datetime | None = None) -> dict:
        now = now or utcnow()
        existing = {c.external_id: c for c in self.session.scalars(
            select(AgentConversation).where(AgentConversation.linked_agent_id == agent.id))}
        new = changed = 0
        for c in convs:
            if not c.turns:
                continue
            ex = excerpt(c.turns)
            title = (c.title or "").strip()[:300] or ex.split("\n", 1)[0][6:90]
            if c.project and c.project not in title:
                title = f"[{c.project}] {title}"
            row = existing.get(c.external_id)
            spans = c.spans()
            if row is None:
                row = AgentConversation(linked_agent_id=agent.id, external_id=c.external_id[:300])
                self.session.add(row)
                existing[c.external_id] = row
                new += 1
            elif (row.message_count == c.message_count and row.excerpt == ex and row.model == c.model and row.title == title
                  and row.spans == spans):
                continue
            else:
                changed += 1
            row.spans = spans
            row.title, row.started_at, row.updated_at = title, c.started_at, c.updated_at or c.started_at
            row.message_count, row.excerpt = c.message_count, ex
            row.model, row.project = (c.model or None) and c.model[:80], (c.project or None) and c.project[:200]
        self.session.flush()
        stats = self.session.execute(select(func.count(), func.coalesce(func.sum(AgentConversation.message_count), 0),
                                            func.min(AgentConversation.started_at), func.max(AgentConversation.updated_at))
                                     .where(AgentConversation.linked_agent_id == agent.id)).one()
        agent.conversation_count, agent.message_count = int(stats[0]), int(stats[1])
        agent.first_activity_at, agent.last_activity_at = stats[2], stats[3]
        agent.last_synced_at = now
        if new or changed:
            agent.summary_stale = True
            if agent.last_activity_at and now - agent.last_activity_at < timedelta(days=30) and agent.usage == "past":
                agent.usage = "current"
        self.session.flush()
        return {"new": new, "updated": changed, "total": agent.conversation_count}

    def import_bytes(self, agent: LinkedAgent, filename: str, raw: bytes, now: datetime | None = None) -> dict:
        if not raw:
            raise HubError("empty upload")
        try:
            convs, vendor = parse_upload(filename, raw)
        except ImportError_ as exc:
            raise HubError(str(exc)) from exc
        out = self.ingest(agent, convs, now)
        if vendor and agent.vendor == "other":
            agent.vendor = vendor
        return {**out, "vendor_guess": vendor}

    def sync_local(self, agent: LinkedAgent, now: datetime | None = None) -> dict:
        if agent.connector not in LOCAL:
            raise HubError("this agent is linked by file import; upload a new export instead")
        try:
            convs, own = read_local_split(agent.connector)
        except Exception as exc:  # unreadable store: report, don't crash the loop
            raise HubError(f"could not read {agent.name}: {exc}") from exc
        if own:                                          # imported before PGA could recognise its own sessions
            for row in self.session.scalars(select(AgentConversation).where(AgentConversation.linked_agent_id == agent.id,
                                                                           AgentConversation.external_id.in_(own))):
                self.session.delete(row)
            self.session.flush()
        return self.ingest(agent, convs, now)

    # ---------------------------------------------------------------- model work
    def _complete(self, user_id: uuid.UUID, *, system: str, prompt: str, background: bool, why: str,
                  max_tokens: int, now: datetime) -> tuple[dict | None, str | None, uuid.UUID | None]:
        kind = "hub_background" if background else "hub_summary"
        decision = self.rt.allocator.allocate(RunRequest(
            user_id=user_id, kind=kind,
            justification=Justification(why_now=why, expected_gain="an up-to-date picture of the user's AI work",
                                        decision_affected="what the core assistant knows about the user's other agents",
                                        budget={"max_output_tokens": max_tokens}, stop_condition="summary stored"),
            estimates=Estimates(information_gain=0.6, decision_impact=0.4, user_relevance=0.8, reuse_value=0.7,
                                input_tokens=len(prompt) // 3, output_tokens=max_tokens // 2)), now=now)
        if not decision.allowed:
            return None, "; ".join(decision.reasons), None
        with self.rt.runs.track(decision, now) as guard:
            result = self.rt.router.complete(decision.tier, system=system, messages=[{"role": "user", "content": prompt}],
                                             max_tokens=max_tokens, usage=guard.usage_context())
            try:
                data = parse_json(result.text)
            except ModelOutputError:
                guard.stop("model reply was not valid JSON")
                return None, "the model reply could not be parsed", guard.run.id
            guard.stop("summary stored")
            return data, None, guard.run.id

    def summarize(self, agent: LinkedAgent, *, background: bool = False, now: datetime | None = None) -> dict:
        now = now or utcnow()
        convs = self.conversations(agent, limit=80)
        if not convs:
            raise HubError("nothing to summarize yet: import or sync some conversations first")
        corpus = iter_corpus(((c.title, c.updated_at or c.started_at, c.excerpt) for c in convs), budget=22_000)
        span = (f"{agent.first_activity_at.date()} → {agent.last_activity_at.date()}"
                if agent.first_activity_at and agent.last_activity_at else "unknown")
        prompt = (f"Agent: {agent.name} ({agent.vendor}); the user {'still uses' if agent.usage == 'current' else 'used'} it.\n"
                  f"{agent.conversation_count} conversations, {agent.message_count} messages, active {span}.\n"
                  + (f"User's note: {agent.notes}\n" if agent.notes else "")
                  + f"\n<conversations>\n{corpus}\n</conversations>")
        data, err, run_id = self._complete(agent.user_id, system=AGENT_SYSTEM, prompt=prompt, background=background,
                                           why=f"summarize the user's use of {agent.name}", max_tokens=1600, now=now)
        if data is None:
            raise HubError(err or "summary failed")
        agent.summary = _shape_agent(data)
        agent.summary_display = self._render(agent.user_id, agent.summary)
        agent.summary_at, agent.summary_stale = now, False
        self.session.flush()
        return {"summary": agent.summary_display, "run_id": str(run_id) if run_id else None}

    def digest(self, user: User, *, background: bool = False, now: datetime | None = None) -> HubDigest:
        now = now or utcnow()
        agents = [a for a in self.list(user.id) if a.summary]
        if not agents:
            raise HubError("summarize at least one agent first")
        lines = []
        for a in agents:
            lines.append(f"## {a.name} ({a.vendor}, {'current' if a.usage == 'current' else 'past'}; "
                         f"{a.conversation_count} conversations; last active "
                         f"{a.last_activity_at.date() if a.last_activity_at else 'unknown'})\n{_json(a.summary)}")
        data, err, run_id = self._complete(user.id, system=DIGEST_SYSTEM, prompt="\n\n".join(lines),
                                           background=background, why="combine the user's agents into one picture",
                                           max_tokens=2000, now=now)
        if data is None:
            raise HubError(err or "digest failed")
        content = _shape_digest(data)
        d = HubDigest(user_id=user.id, content=content, content_display=self._render(user.id, content),
                      agent_ids=[str(a.id) for a in agents], run_id=run_id, created_at=now)
        self.session.add(d)
        self.session.flush()
        return d

    def latest_digest(self, user_id: uuid.UUID) -> HubDigest | None:
        return self.session.scalar(select(HubDigest).where(HubDigest.user_id == user_id)
                                   .order_by(HubDigest.created_at.desc()).limit(1))

    def context_block(self, user_id: uuid.UUID) -> str:
        """English context for the core assistant: what the user does with their other agents."""
        d = self.latest_digest(user_id)
        if d is None:
            return ""
        c = d.content
        projects = "; ".join(f"{p['name']} ({p.get('status', '?')}, via {', '.join(p.get('agents') or []) or '?'})"
                             for p in (c.get("projects") or [])[:8])
        roles = "; ".join(f"{r['agent']}: {r['role']}" for r in (c.get("agent_roles") or [])[:8])
        return (f"Overview: {c.get('overview', '')}\nAgent roles: {roles or '-'}\nProjects across agents: {projects or '-'}\n"
                f"Open threads: {'; '.join((c.get('open_threads') or [])[:6]) or '-'}")

    # ---------------------------------------------------------------- the background loop + notifications
    def link_local(self, user: User) -> list[str]:
        """Link every agent found on this machine that is not linked yet — never for a demo account."""
        if (user.preferences or {}).get("demo"):
            return []
        have = {a.connector for a in self.list(user.id)}
        made = []
        for c in detect_local():
            if c["connector"] in have:
                continue
            try:
                with self.session.begin_nested():             # another sync may be linking it at this very moment
                    self.create(user.id, name=c["name"], vendor=c["vendor"], connector=c["connector"], usage="current")
                made.append(c["name"])
            except (HubError, IntegrityError):
                continue
        return made

    def counts(self, user_id: uuid.UUID, now: datetime | None = None) -> dict[str, dict]:
        """For each pool agent: how many past conversations it had in its own app, how many in the last day."""
        now = now or utcnow()
        rows = self.session.execute(select(LinkedAgent.connector, LinkedAgent.vendor, func.count(AgentConversation.id),
                                           func.count(AgentConversation.id).filter(AgentConversation.updated_at >= now - timedelta(days=1)),
                                           func.max(AgentConversation.updated_at))
                                    .join(AgentConversation, AgentConversation.linked_agent_id == LinkedAgent.id)
                                    .where(LinkedAgent.user_id == user_id).group_by(LinkedAgent.connector, LinkedAgent.vendor)).all()
        return {f"{c}|{v}": {"count": n, "recent": r, "last": last.isoformat() if last else None} for c, v, n, r, last in rows}

    def timeline(self, user_id: uuid.UUID, *, limit: int = 300, agent: str | None = None, before: datetime | None = None,
                 connectors: tuple[str, ...] | None = None, vendor: str | None = None) -> list[dict]:
        """Every past conversation, from every agent, newest first — and which agent (and model) handled it."""
        q = (select(AgentConversation, LinkedAgent).join(LinkedAgent, AgentConversation.linked_agent_id == LinkedAgent.id)
             .where(LinkedAgent.user_id == user_id))
        if agent:
            q = q.where(LinkedAgent.id == uuid.UUID(agent)) if len(agent) == 36 else q.where(LinkedAgent.connector == agent)
        when = func.coalesce(AgentConversation.updated_at, AgentConversation.started_at, AgentConversation.created_at)
        if before:
            q = q.where(when < before)
        if connectors is not None or vendor:                  # one pool agent's own app (or a vendor's imports)
            from sqlalchemy import or_
            conds = ([LinkedAgent.connector.in_(connectors)] if connectors else []) + ([LinkedAgent.vendor == vendor] if vendor else [])
            q = q.where(or_(*conds)) if conds else q.where(False)
        out = []
        for c, a in self.session.execute(q.order_by(when.desc()).limit(limit)):
            out.append({"id": str(c.id), "agent": a.name, "agent_id": str(a.id), "vendor": a.vendor, "connector": a.connector,
                        "model": c.model, "project": c.project, "title": c.title, "messages": c.message_count, "excerpt": c.excerpt,
                        "started_at": c.started_at.isoformat() if c.started_at else None,
                        "at": (c.updated_at or c.started_at or c.created_at).isoformat()})
        return out

    def background_sync(self, user: User, now: datetime | None = None) -> dict:
        """Sync local agents; re-summarize what changed; refresh the digest; tell the user once."""
        now = now or utcnow()
        report: dict[str, Any] = {"synced": {}, "summarized": [], "errors": {}}
        from pga.owner import owner_id
        if owner_id(self.session) == user.id:            # the owner's machine: every local agent is imported on its own
            report["linked"] = self.link_local(user)
        changed: list[tuple[LinkedAgent, int]] = []
        for a in self.list(user.id):
            if a.connector not in LOCAL:
                continue
            try:
                r = self.sync_local(a, now)
                report["synced"][a.name] = r
                if r["new"] or r["updated"]:
                    changed.append((a, r["new"] + r["updated"]))
            except HubError as exc:
                report["errors"][a.name] = str(exc)
        for a, n in changed:
            try:
                self.summarize(a, background=True, now=now)
                report["summarized"].append(a.name)
            except HubError as exc:
                report["errors"][a.name] = str(exc)
        if report["summarized"]:
            try:
                self.digest(user, background=True, now=now)
                report["digest"] = True
            except HubError as exc:
                report["errors"]["digest"] = str(exc)
        if changed:
            what = ", ".join(f"{a.name} +{n}" for a, n in changed)
            headline = "; ".join((a.summary or {}).get("headline", "") for a, _ in changed if a.summary)[:600]
            n = self.notify(user, f"New activity in your AI agents: {what}",
                            (headline + ("\nThe cross-agent summary was refreshed." if report.get("digest") else "")).strip(),
                            dedupe_key=f"hub:{user.id}:{now.date()}:{what}", now=now)
            report["notification_id"] = str(n.id)
        return report

    def notify(self, user: User, title_en: str, body_en: str = "", *, dedupe_key: str | None = None,
               now: datetime | None = None):
        n = self.rt.notify.propose(user, Proposal(kind=CommKind.BRIEF, reasons=[NotifyReason.ARTIFACT_READY],
                                                  title_en=title_en, body_en=body_en, dedupe_key=dedupe_key), now=now)
        return n

    # ---------------------------------------------------------------- rendering
    def _render(self, user_id: uuid.UUID, data: dict) -> dict:
        """Translate every string in a summary into the user's language in one call (falls back per string)."""
        user = self.session.get(User, user_id)
        lang = ((user.preferences or {}).get("output_language") if user else None) or (user.locale if user else "en")
        if lang in ("mirror_input", None):
            lang = user.locale if user else "en"
        if lang.lower().startswith("en"):
            return data
        leaves: list[str] = []
        _collect(data, leaves)
        if not leaves:
            return data
        joined = "\n".join(f"⟦{i}⟧ {s.replace(chr(10), ' ')}" for i, s in enumerate(leaves))
        rendered = self.rt.gateway.render(joined, lang, user_id).text
        parts = {int(m.group(1)): m.group(2).strip() for m in re.finditer(r"⟦(\d+)⟧\s*(.*)", rendered)}
        if len(parts) != len(leaves):
            parts = {i: self.rt.gateway.render(s, lang, user_id).text for i, s in enumerate(leaves)}
        it = iter(range(len(leaves)))
        return _replace(data, lambda: parts.get(next(it), ""))


# ---------------------------------------------------------------- helpers

_SKIP_KEYS = {"status", "last_seen", "weight"}


def _collect(v: Any, out: list[str], key: str | None = None) -> None:
    if isinstance(v, str):
        if key not in _SKIP_KEYS and v.strip():
            out.append(v)
    elif isinstance(v, list):
        for x in v:
            _collect(x, out, key)
    elif isinstance(v, dict):
        for k, x in v.items():
            _collect(x, out, k)


def _replace(v: Any, nxt, key: str | None = None) -> Any:
    if isinstance(v, str):
        return nxt() if key not in _SKIP_KEYS and v.strip() else v
    if isinstance(v, list):
        return [_replace(x, nxt, key) for x in v]
    if isinstance(v, dict):
        return {k: _replace(x, nxt, k) for k, x in v.items()}
    return v


def _strs(v: Any, n: int) -> list[str]:
    return [str(x).strip()[:300] for x in (v or []) if str(x).strip()][:n] if isinstance(v, list) else []


def _shape_agent(d: dict) -> dict:
    return {"headline": str(d.get("headline") or "")[:400], "used_for": _strs(d.get("used_for"), 8),
            "topics": [{"name": str(t.get("name"))[:80], "weight": max(0.0, min(1.0, float(t.get("weight") or 0.5)))}
                       for t in (d.get("topics") or []) if isinstance(t, dict) and t.get("name")][:12],
            "projects": [{"name": str(p.get("name"))[:120], "status": str(p.get("status") or "unknown")[:16],
                          "last_seen": str(p.get("last_seen") or "")[:10], "note": str(p.get("note") or "")[:300]}
                         for p in (d.get("projects") or []) if isinstance(p, dict) and p.get("name")][:12],
            "preferences": _strs(d.get("preferences"), 8), "open_threads": _strs(d.get("open_threads"), 8),
            "strengths": str(d.get("strengths") or "")[:400]}


def _shape_digest(d: dict) -> dict:
    return {"overview": str(d.get("overview") or "")[:1500],
            "agent_roles": [{"agent": str(r.get("agent"))[:80], "role": str(r.get("role") or "")[:200]}
                            for r in (d.get("agent_roles") or []) if isinstance(r, dict) and r.get("agent")][:12],
            "projects": [{"name": str(p.get("name"))[:120], "agents": _strs(p.get("agents"), 6),
                          "status": str(p.get("status") or "unknown")[:16], "next_step": str(p.get("next_step") or "")[:300]}
                         for p in (d.get("projects") or []) if isinstance(p, dict) and p.get("name")][:14],
            "recurring_needs": _strs(d.get("recurring_needs"), 8), "overlaps": _strs(d.get("overlaps"), 8),
            "gaps": _strs(d.get("gaps"), 8), "recommendations": _strs(d.get("recommendations"), 8),
            "open_threads": _strs(d.get("open_threads"), 10)}


def _json(v: Any) -> str:
    import json

    return json.dumps(v, ensure_ascii=False)
