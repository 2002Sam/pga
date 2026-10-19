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
    "user": ("个人模型", "Personal model", "你是谁：背景、目标、偏好、能力、状态五个维度，来自你告诉 PGA 的和从你所有输入里推断出的"),
    "world": ("世界模型", "World model", "世界正在发生什么：从各平台热点汇总、整理出的现状"),
}
# hot lists, as TrendRadar collects them (newsnow aggregator ids)
WORLD_SOURCES = {"weibo": "微博热搜", "zhihu": "知乎热榜", "baidu": "百度热搜", "toutiao": "今日头条", "thepaper": "澎湃新闻",
                 "wallstreetcn-hot": "华尔街见闻", "cls-hot": "财联社", "bilibili-hot-search": "B 站热搜",
                 "hackernews": "Hacker News", "github-trending-today": "GitHub Trending"}
NEWSNOW = "https://newsnow.busiyi.world/api/s?id={id}&latest"
_WORLD_CACHE: list = []
EVERY = {"user": timedelta(hours=24), "world": timedelta(hours=6), "aim": timedelta(hours=12),
         "branch": timedelta(days=36500)}       # a line of thought is distilled when you ask

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
    "branch": ("The document distills ONE line of thought from a motivation's thought tree so that other work can reuse it "
               "quickly: what it set out to find, what it concluded (with the evidence and question codes), what stays open, "
               "and what other lines of work could take from it. Plain words; explain rather than quote code names.", 1000),
}


# the personal model: five dimensions about you
DIMENSIONS = [
    ("background", "背景", "Background", "who the user is: role, field, situation, the projects they carry"),
    ("goals", "目标", "Goals", "what the user wants, long and short term, and why it matters to them"),
    ("preferences", "偏好", "Preferences", "how the user likes things done: taste, style, communication, what they dislike"),
    ("abilities", "能力", "Knowledge & skills", "what the user knows and can do well, and where they need help"),
    ("state", "状态", "Current state", "what is going on now: constraints, resources, time, open decisions"),
]
PERSONAL = """You keep the PERSONAL MODEL of one user for their long-running personal agent: five dimensions about the user.
{dims}
For each dimension: "summary" (1-2 plain sentences), "stated" (what the user said themselves, up to 5 short items),
"inferred" (what can reasonably be inferred from what they wrote, up to 5 short items, each a careful inference, not a fact),
"confidence" (0-1, how well the material supports this dimension). Never include passwords, keys or secrets. Write in English.
{untrusted}
Reply with JSON only: {{"dimensions": {{"background": {{"summary": "...", "stated": ["..."], "inferred": ["..."], "confidence": 0.0}}, ...}}}}"""


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
        for key, b in have.items():                           # the names they had before they were models
            if b.title in ("用户", "世界"):
                b.title, b.title_en = SYSTEM_SETS[key][0], SYSTEM_SETS[key][1]
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
        if b.system == "branch":
            from pga.tree import ThoughtTree
            tree = ThoughtTree(self.rt)
            node = tree.node_of_dataset(b.id)
            if node is None:
                raise DatasetError("the line of thought it came from is gone")
            return tree.branch_material(node)
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
        from pga.db.models import AgentConversation, LinkedAgent, ThoughtNode
        convs = [f"- [{la.name or la.vendor}] {c.title}" for c, la in self.s.execute(
            select(AgentConversation, LinkedAgent).join(LinkedAgent, LinkedAgent.id == AgentConversation.linked_agent_id)
            .where(LinkedAgent.user_id == user.id).order_by(AgentConversation.updated_at.desc().nulls_last()).limit(150))]
        lines = [f"- {n.title}: {n.summary}" for n in self.s.scalars(select(ThoughtNode).where(
            ThoughtNode.user_id == user.id, ThoughtNode.scope == "user").order_by(ThoughtNode.seq))]
        parts = ["Stated facts and preferences:\n" + ("\n".join(facts) or "(none)"),
                 "Long-range motivations:\n" + ("\n".join(aims) or "(none)"),
                 "Topics of the user's own conversations (their conversation tree):\n" + ("\n".join(lines) or "(none)"),
                 "Titles of conversations the user had with other AI apps:\n" + ("\n".join(convs) or "(none)"),
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
        system = WRITE.format(what=what, untrusted=UNTRUSTED_NOTE, words=words)
        if key == "user":
            system = PERSONAL.format(dims="\n".join(f"- {k} ({en}): {why}" for k, _zh, en, why in DIMENSIONS), untrusted=UNTRUSTED_NOTE)
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
            res = self.rt.router.complete(decision.tier, system=system,
                                          messages=[{"role": "user", "content": material}],
                                          max_tokens=decision.limits.get("max_output_tokens", 2400), usage=guard.usage_context())
            text = (res.text or "").strip()
            guard.stop(f"{key} dataset written ({len(text.split())} words)")
        dims = None
        if key == "user":                                     # five dimensions, kept as structure and written out as a document
            dims = _dimensions(text)
            if dims is None:
                return Compiled(b.id, key, 0, "failed", "the model did not write the five dimensions")
            dims = _apply_mine(dims, b.data)
            text = _dims_markdown(dims)
        if len(text) < 80:
            return Compiled(b.id, key, 0, "failed", "the model wrote almost nothing")
        b.description_en = text
        with self.rt.billing(guard.usage_context()):            # translation flattens line breaks: carry them through as ¶
            shown = self.rt.gateway.render(text.replace("\n", " ¶ "), user.locale or "zh-CN", user.id).text
        b.description = re.sub(r" ?¶ ?", "\n", shown).strip()
        b.compiled_at = now
        if dims is not None:
            b.data = {**(b.data or {}), "dims_en": dims, "dims": _apply_mine(_dims_shown(self.rt, dims, user.locale or "zh-CN"), b.data)}
        self.s.flush()
        try:
            self.rt.layers.build(user, f"k:{b.id}", force=True, now=now)     # title · summary · full
        except Exception as exc:  # noqa: BLE001 - the document is saved; the pyramid is retried by the heartbeat
            log.info("pyramid for %s not built: %s", b.id, exc)
        return Compiled(b.id, key, len(text.split()), "compiled")


def edit_facts(b: Body, dim: str, *, add=None, remove=None, summary=None) -> dict:
    """`add`: a sentence about you (kept as stated); `remove`: {"list": "stated"|"inferred", "i": n}; `summary`: your own
    wording of the dimension. Kept in data.mine / data.removed / data.mine_summary and applied again after every rebuild."""
    keys = [k for k, *_ in DIMENSIONS]
    if dim not in keys:
        raise DatasetError(f"unknown dimension {dim!r}")
    d = dict(b.data or {})
    dims, dims_en = dict(d.get("dims") or {}), dict(d.get("dims_en") or {})
    for x in (dims, dims_en):
        x.setdefault(dim, {"summary": "", "stated": [], "inferred": [], "confidence": 0.0})
        x[dim] = dict(x[dim])
    mine, removed, msum = dict(d.get("mine") or {}), dict(d.get("removed") or {}), dict(d.get("mine_summary") or {})
    if add and str(add).strip():
        t = str(add).strip()[:200]
        mine[dim] = [*mine.get(dim, []), t][-20:]
        for x in (dims, dims_en):
            if t not in x[dim]["stated"]:
                x[dim]["stated"] = [t, *x[dim]["stated"]]
    if isinstance(remove, dict) and remove.get("list") in ("stated", "inferred"):
        lst, i = remove["list"], int(remove.get("i", -1))
        if 0 <= i < len(dims[dim][lst]):
            gone = [dims[dim][lst][i], *(dims_en[dim][lst][i:i + 1] if i < len(dims_en[dim].get(lst, [])) else [])]
            removed[dim] = [*removed.get(dim, []), *gone][-60:]
            mine[dim] = [m for m in mine.get(dim, []) if m not in gone]
            for x in (dims, dims_en):
                x[dim][lst] = [v for j, v in enumerate(x[dim][lst]) if v not in gone and not (x is dims and j == i)]
    if summary is not None:
        t = str(summary).strip()[:600]
        if t:
            msum[dim] = t
            dims[dim]["summary"] = dims_en[dim]["summary"] = t
        else:
            msum.pop(dim, None)
    b.data = {**d, "dims": dims, "dims_en": dims_en, "mine": mine, "removed": removed, "mine_summary": msum}
    b.description_en = _dims_markdown({k: dims_en.get(k) or {"summary": "", "stated": [], "inferred": [], "confidence": 0} for k in keys})
    b.description = _dims_markdown({k: dims.get(k) or {"summary": "", "stated": [], "inferred": [], "confidence": 0} for k in keys})
    return {"dim": dim, "dims": dims}


def _apply_mine(dims: dict, data: dict | None) -> dict:
    """What you wrote or took out stays that way after the model rebuilds the five dimensions."""
    d = data or {}
    mine, removed, msum = d.get("mine") or {}, d.get("removed") or {}, d.get("mine_summary") or {}
    for k, x in dims.items():
        gone = set(removed.get(k) or [])
        x["stated"] = [*[m for m in mine.get(k, []) if m not in x["stated"]], *[v for v in x["stated"] if v not in gone]][:12]
        x["inferred"] = [v for v in x["inferred"] if v not in gone]
        if msum.get(k):
            x["summary"] = msum[k]
    return dims


def _dimensions(text: str) -> dict | None:
    from pga.agent.common import ModelOutputError, parse_json
    try:
        d = parse_json(text)
    except ModelOutputError:
        return None
    raw = (d or {}).get("dimensions") if isinstance(d, dict) else None
    if not isinstance(raw, dict):
        return None
    out = {}
    for k, _zh, _en, _why in DIMENSIONS:
        x = raw.get(k) if isinstance(raw.get(k), dict) else {}
        try:
            conf = max(0.0, min(1.0, float(x.get("confidence") or 0)))
        except (TypeError, ValueError):
            conf = 0.0
        out[k] = {"summary": str(x.get("summary") or "").strip()[:600],
                  "stated": [str(i).strip()[:200] for i in (x.get("stated") or []) if str(i).strip()][:5],
                  "inferred": [str(i).strip()[:200] for i in (x.get("inferred") or []) if str(i).strip()][:5],
                  "confidence": round(conf, 2)}
    return out if any(v["summary"] for v in out.values()) else None


def _dims_markdown(dims: dict) -> str:
    lines = ["# Personal model", ""]
    for k, _zh, en, _why in DIMENSIONS:
        x = dims[k]
        lines += [f"## {en} (confidence {x['confidence']:.1f})", "", x["summary"] or "(not enough to say)", ""]
        if x["stated"]:
            lines += ["Stated:", *[f"- {i}" for i in x["stated"]], ""]
        if x["inferred"]:
            lines += ["Inferred:", *[f"- {i}" for i in x["inferred"]], ""]
    return "\n".join(lines).strip()


def _dims_shown(rt: "Runtime", dims: dict, locale: str) -> dict:
    """The five dimensions in your language (one batch of translations, cached)."""
    from pga.i18n import translate_many
    if locale.lower().startswith("en"):
        return dims
    flat: list[str] = []
    for k, *_ in DIMENSIONS:
        flat += [dims[k]["summary"], *dims[k]["stated"], *dims[k]["inferred"]]
    shown = iter(translate_many(rt, flat, "zh"))
    return {k: {"summary": next(shown), "stated": [next(shown) for _ in dims[k]["stated"]],
                "inferred": [next(shown) for _ in dims[k]["inferred"]], "confidence": dims[k]["confidence"]}
            for k, *_ in DIMENSIONS}


def _get_json(url: str):
    import httpx

    r = httpx.get(url, timeout=15, headers={"User-Agent": "Mozilla/5.0 (PGA world collector)"})
    r.raise_for_status()
    return r.json()
