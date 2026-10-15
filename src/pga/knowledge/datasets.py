"""Curated datasets: knowledge kept as documents, not fragments.

A dataset is one long, carefully organised document that PGA rebuilds from what it has, and then cuts into the
information pyramid (layers.py): 1 title / gist · 2 summary / brief · 3 the full text. Two always exist:

    用户 (user)    who you are: what you told PGA about yourself, and what can be inferred from everything you
                   have written to it — your motivations, your conversations, your corrections and answers
    世界 (world)   what is happening: hot topics collected from many platforms (the way TrendRadar does it,
                   through the newsnow aggregator), grouped and summarised — a picture of the world right now

and every motivation gets one more, 「… 的知识」, compiled from what its agents found out (answers, insights,
decisions), organised by topic instead of left as a pile of answers.

Raw material goes to the model; the model writes the full text in English (canonical); the display copy is
translated; the pyramid is rebuilt from it. Rebuilding is bounded: the allocator has to approve each one.
"""

from __future__ import annotations

import logging
import re
import uuid
from dataclasses import dataclass
from datetime import datetime, timedelta
from typing import TYPE_CHECKING

from sqlalchemy import func, select

from pga.agent.common import UNTRUSTED_NOTE, fence
from pga.allocator import Estimates, Justification, RunRequest
from pga.db.models import AgentRun, Aim, AimNote, Body, Message, SituationFact, User
from pga.db.types import MessageRole, Origin, utcnow

if TYPE_CHECKING:
    from pga.runtime import Runtime

log = logging.getLogger("pga.datasets")

SYSTEM_SETS = {
    "user": ("用户", "The user", "你是谁：你告诉 PGA 的，和从你所有输入里推断出的情况"),
    "world": ("世界", "The world", "世界正在发生什么：从各平台热点汇总、整理出的现状"),
}
# hot lists, as TrendRadar collects them (newsnow aggregator ids)
WORLD_SOURCES = {"weibo": "微博热搜", "zhihu": "知乎热榜", "baidu": "百度热搜", "toutiao": "今日头条", "thepaper": "澎湃新闻",
                 "wallstreetcn-hot": "华尔街见闻", "cls-hot": "财联社", "bilibili-hot-search": "B 站热搜",
                 "hackernews": "Hacker News", "github-trending-today": "GitHub Trending"}
NEWSNOW = "https://newsnow.busiyi.world/api/s?id={id}&latest"
_WORLD_CACHE: list = []
EVERY = {"user": timedelta(hours=24), "world": timedelta(hours=6), "aim": timedelta(hours=12)}

WRITE = """You keep one curated knowledge document for a personal long-running agent. {what}
Write the FULL document: well organised with short headings, concrete, no filler, no speculation presented as fact
(mark inferences as inferences). It replaces the previous version, so carry over what is still true. Write in English.
{untrusted}
Reply with the document only (Markdown), at most {words} words."""

WHAT = {
    "user": ("The document describes the USER: their stated situation and preferences, then what can reasonably be "
             "inferred from everything they wrote (goals, working style, interests, constraints, recurring concerns). "
             "Separate 'Stated' from 'Inferred'. Never include passwords, keys or secrets.", 900),
    "world": ("The document describes what is happening in the WORLD right now, from today's hot lists on many "
              "platforms: group items into themes (technology & AI, economy & markets, society, culture), say what "
              "each theme is about and which items show it; keep the most telling item titles.", 1100),
    "aim": ("The document is everything a motivation's agents have found out: organise it by topic (not by question), "
            "state each finding with the question code(s) it came from, note open doubts and decisions made.", 1200),
}


class DatasetError(RuntimeError):
    pass


@dataclass
class Compiled:
    body_id: uuid.UUID
    system: str
    words: int
    status: str            # compiled | unchanged | deferred | failed
    note: str = ""


class Datasets:
    def __init__(self, rt: "Runtime", fetch=None):
        self.rt = rt
        self.s = rt.session
        self.fetch = fetch                       # url -> parsed JSON (tests pass a fake)

    # -------------------------------------------------------------- the standing ones

    def ensure(self, user: User, now: datetime | None = None) -> dict[str, Body]:
        """The user and world datasets always exist (one per account)."""
        now = now or utcnow()
        have = {b.system: b for b in self.s.scalars(select(Body).where(Body.user_id == user.id, Body.system.in_(list(SYSTEM_SETS))))}
        for key, (title, title_en, desc) in SYSTEM_SETS.items():
            if key not in have:
                b = Body(user_id=user.id, aim_id=None, kind="database", title=title, title_en=title_en, description=desc,
                         description_en=title_en, private=False, origin=Origin.SYSTEM, system=key, created_at=now)
                self.s.add(b)
                have[key] = b
        self.s.flush()
        return have

    def for_aim(self, user: User, aim: Aim, now: datetime | None = None) -> Body:
        b = self.s.scalar(select(Body).where(Body.user_id == user.id, Body.system == "aim", Body.aim_id == aim.id))
        if b is None:
            short = aim.text if len(aim.text) <= 18 else aim.text[:17] + "…"
            b = Body(user_id=user.id, aim_id=aim.id, kind="database", title=f"{short} · 知识", title_en=f"Knowledge: {aim.text_en[:80]}",
                     description="", description_en="", private=False, origin=Origin.SYSTEM, system="aim", created_at=now or utcnow())
            self.s.add(b)
            self.s.flush()
        return b

    def due(self, user: User, now: datetime | None = None) -> list[Body]:
        """Datasets worth rebuilding: never built, or old enough AND something new arrived since (the world is always new)."""
        now = now or utcnow()
        out = []
        for b in self.ensure(user, now).values():
            if b.compiled_at is None or (now - b.compiled_at >= EVERY[b.system] and
                                         (b.system == "world" or self._user_changed(user, b.compiled_at))):
                out.append(b)
        for aim in self.s.scalars(select(Aim).where(Aim.user_id == user.id)):
            last = self.s.scalar(select(func.max(AimNote.created_at)).where(
                AimNote.aim_id == aim.id, AimNote.kind.in_(["answer", "insight", "reflect", "correction"])))
            if last is None:
                continue
            b = self.for_aim(user, aim, now)
            if b.compiled_at is None or (now - b.compiled_at >= EVERY["aim"] and last > b.compiled_at):
                out.append(b)
        return out

    def _user_changed(self, user: User, since: datetime) -> bool:
        for col, where in ((Message.created_at, (Message.user_id == user.id, Message.role == MessageRole.USER)),
                           (SituationFact.created_at, (SituationFact.user_id == user.id,)),
                           (AgentRun.started_at, (AgentRun.user_id == user.id, AgentRun.workflow == "ask")),
                           (AimNote.created_at, (AimNote.user_id == user.id, AimNote.kind == "correction"))):
            last = self.s.scalar(select(func.max(col)).where(*where))
            if last is not None and last > since:
                return True
        return False

    # -------------------------------------------------------------- raw material

    def material(self, user: User, b: Body, now: datetime) -> str:
        if b.system == "user":
            return self._user_material(user)
        if b.system == "world":
            return self._world_material()
        aim = self.s.get(Aim, b.aim_id)
        return self._aim_material(aim) if aim else ""

    def _user_material(self, user: User) -> str:
        facts = [f"- [{f.type.value}] {f.canonical_en}" for f in self.s.scalars(select(SituationFact).where(
            SituationFact.user_id == user.id, SituationFact.superseded_by_id.is_(None)).order_by(SituationFact.created_at))]
        aims = [f"- {a.text_en}" for a in self.s.scalars(select(Aim).where(Aim.user_id == user.id))]
        said = [m.canonical_en or m.raw_text for m in self.s.scalars(select(Message).where(
            Message.user_id == user.id, Message.role == MessageRole.USER).order_by(Message.created_at.desc()).limit(120))]
        asks = [" ".join((r.prompt or "").split())[:400] for r in self.s.scalars(select(AgentRun).where(
            AgentRun.user_id == user.id, AgentRun.parent_id.is_(None), AgentRun.workflow == "ask")
            .order_by(AgentRun.started_at.desc()).limit(120))]
        corr = [n.text_en or n.text for n in self.s.scalars(select(AimNote).where(
            AimNote.user_id == user.id, AimNote.kind == "correction").order_by(AimNote.created_at.desc()).limit(60))]
        parts = ["Stated facts and preferences:\n" + ("\n".join(facts) or "(none)"),
                 "Long-range motivations:\n" + ("\n".join(aims) or "(none)"),
                 "Guidance and answers the user gave:\n" + ("\n".join(f"- {c[:400]}" for c in corr) or "(none)"),
                 fence("source", "\n".join(f"- {x[:400]}" for x in said + asks) or "(none)", 24000, kind="what the user wrote")]
        return "\n\n".join(parts)

    def _world_material(self) -> str:
        if self.fetch is None and _WORLD_CACHE and utcnow() - _WORLD_CACHE[0] < timedelta(hours=1):
            return _WORLD_CACHE[1]                # one collection serves every account for an hour
        fetch = self.fetch or _get_json
        out = []
        for sid, name in WORLD_SOURCES.items():
            try:
                items = (fetch(NEWSNOW.format(id=sid)) or {}).get("items") or []
            except Exception as exc:  # noqa: BLE001 - one platform down does not stop the rest
                log.info("world source %s failed: %s", sid, exc)
                continue
            titles = [" ".join(str(i.get("title") or "").split())[:120] for i in items[:15] if i.get("title")]
            if titles:
                out.append(f"## {name}\n" + "\n".join(f"- {t}" for t in titles))
        if not out:
            raise DatasetError("no hot list could be reached")
        text = fence("source", "\n\n".join(out), 30000, kind="today's hot lists")
        if self.fetch is None:
            _WORLD_CACHE[:] = [utcnow(), text]
        return text

    def _aim_material(self, aim: Aim) -> str:
        notes = list(self.s.scalars(select(AimNote).where(AimNote.aim_id == aim.id, AimNote.kind.in_(
            ["answer", "insight", "reflect", "checkpoint", "correction"])).order_by(AimNote.created_at.desc()).limit(80)))
        lines = []
        for n in reversed(notes):
            d = n.data or {}
            tag = n.kind + (f" {d.get('code')}" if d.get("code") else "")
            q = f" (question: {d.get('question')[:200]})" if d.get("question") else ""
            lines.append(f"[{tag}]{q} {(n.text_en or n.text)[:1500]}")
        return f"Motivation: {aim.text_en}\n\n" + fence("source", "\n\n".join(lines) or "(nothing yet)", 30000, kind="what the agents found")

    # -------------------------------------------------------------- compiling

    def compile(self, user: User, b: Body, now: datetime | None = None) -> Compiled:
        now = now or utcnow()
        key = b.system or "aim"
        try:
            material = self.material(user, b, now)
        except DatasetError as exc:
            return Compiled(b.id, key, 0, "failed", str(exc))
        what, words = WHAT[key]
        decision = self.rt.allocator.allocate(RunRequest(
            user_id=user.id, kind="synthesis",
            justification=Justification(
                why_now=f"the {key} dataset is due to be rebuilt", expected_gain="one curated document instead of fragments",
                decision_affected="what every agent reads about the " + ("user" if key == "user" else "world" if key == "world" else "motivation"),
                budget={"max_units": 80_000, "max_output_tokens": 2400}, stop_condition="the document is written once"),
            estimates=Estimates(information_gain=.6, decision_impact=.5, user_relevance=.7, reuse_value=.9,
                                input_tokens=min(12000, len(material) // 3), output_tokens=1600)), now=now)
        if not decision.allowed:
            return Compiled(b.id, key, 0, "deferred", "; ".join(decision.reasons))
        with self.rt.runs.track(decision) as guard:
            res = self.rt.router.complete(decision.tier, system=WRITE.format(what=what, untrusted=UNTRUSTED_NOTE, words=words),
                                          messages=[{"role": "user", "content": material}],
                                          max_tokens=decision.limits.get("max_output_tokens", 2400), usage=guard.usage_context())
            text = (res.text or "").strip()
            guard.stop(f"{key} dataset written ({len(text.split())} words)")
        if len(text) < 80:
            return Compiled(b.id, key, 0, "failed", "the model wrote almost nothing")
        b.description_en = text
        with self.rt.billing(guard.usage_context()):            # translation flattens line breaks: carry them through as ¶
            shown = self.rt.gateway.render(text.replace("\n", " ¶ "), user.locale or "zh-CN", user.id).text
        b.description = re.sub(r" ?¶ ?", "\n", shown).strip()
        b.compiled_at = now
        self.s.flush()
        try:
            self.rt.layers.build(user, f"k:{b.id}", force=True, now=now)     # title · summary · full
        except Exception as exc:  # noqa: BLE001 - the document is saved; the pyramid is retried by the heartbeat
            log.info("pyramid for %s not built: %s", b.id, exc)
        return Compiled(b.id, key, len(text.split()), "compiled")


def _get_json(url: str):
    import httpx

    r = httpx.get(url, timeout=15, headers={"User-Agent": "Mozilla/5.0 (PGA world collector)"})
    r.raise_for_status()
    return r.json()
