"""Information pyramid: every ambition, database, skill and agent is kept at three levels of detail.

    L1  gist   要点   one sentence: enough to recognise it and grasp the point
    L2  brief  概要   a short paragraph of the key points
    L3  full   全量   everything

Whatever the user writes becomes a pyramid. Where their own text sits depends on its length:

    short  (≤ gist_max words)   the text *is* the gist   → L2 and L3 are expanded from it
    medium (≤ brief_max words)  the text is the brief    → L1 is condensed, L3 expanded
    long                        the text is the full one → L2 and L1 are condensed

Long input is summarised upward, short input is spelled out downward, so the result is always a pyramid
(each level shorter than the one below). Expanded levels are the assistant's elaboration, never the user's
words: they are stored with mode "expanded" and labelled as such whenever a model reads them.

Processes take the level they need (policy `layers.needs`, e.g. `chat.focus_aim: 3`); `select()` then steps
the least important items down a level until a context fits its word budget.

Private bodies are never sent to a model: their pyramid is cut by rule from the user's own text.
If no model is available the same rule cut is stored (mode "rule") and the heartbeat retries later.
"""

from __future__ import annotations

import hashlib
import logging
import re
import uuid
from dataclasses import dataclass, field
from datetime import datetime, timedelta
from typing import TYPE_CHECKING

from sqlalchemy import delete, select

from pga.agent.common import UNTRUSTED_NOTE, ModelOutputError, parse_json
from pga.allocator import Estimates, Justification, RunRequest
from pga.db.models import Aim, Body, Layer, Responsibility, User
from pga.db.types import utcnow

if TYPE_CHECKING:
    from pga.runtime import Runtime

log = logging.getLogger(__name__)

LEVELS = (1, 2, 3)
NAMES = {1: "gist", 2: "brief", 3: "full"}
NAMES_ZH = {1: "要点", 2: "概要", 3: "全量"}
EXPANDED_NOTE = "[expanded by the assistant from the user's shorter statement — treat the detail as suggestions, not the user's words]"

KIND_SHAPE = {
    "ambition": "what it means, why it matters, sub-goals, milestones, how progress is measured, constraints and risks, open questions",
    "database": "what it holds, where the material comes from, how it is organised, how it serves the ambition, how it is kept current",
    "skill": "what it covers, its component sub-skills, a practice plan, how progress shows, useful resources",
    "agent": "what it tracks, which signals matter, what would change its view, what it produces for the user",
}

LAYER_SYSTEM = """You turn one item from a person's planning map into an information pyramid — the same item at three
levels of detail, each strictly shorter than the next:
- gist: ONE short sentence, at most {g} words (count them) — what it is and the point of it.
- brief: {b_lo}–{b} words — the key points.
- full: {f_lo}–{f} words — complete detail in short labelled paragraphs or bullets. For a {kind}, cover: {shape}.

You are given the person's text and told which levels to write.
- CONDENSE: keep their meaning and priorities, in plain words; nothing in a shorter level may be absent from the longer.
- EXPAND: stay faithful to what they wrote. Make implications explicit and propose concrete structure, but invent no
  personal facts; write assumptions as assumptions ("likely", "for example").
Write in English. {untrusted}

Reply with JSON only, containing exactly the requested keys: {{"gist": "...", "brief": "...", "full": "..."}}"""


class LayerError(ValueError):
    pass


# ---------------------------------------------------------------- measuring and cutting text

_CJK = re.compile(r"[぀-ヿ㐀-鿿豈-﫿가-힯]")
_TOKEN = re.compile(r"[぀-ヿ㐀-鿿豈-﫿가-힯]|[^\s぀-ヿ㐀-鿿豈-﫿가-힯]+")
_SENTENCE = re.compile(r"(?<=[.!?。！？；;])\s*|\n+")


def words(text: str) -> float:
    """Length in English-word equivalents: a Latin word counts 1, a CJK character ½."""
    return sum(.5 if _CJK.fullmatch(t) else 1 for t in _TOKEN.findall(text or ""))


def clip(text: str, max_words: float) -> str:
    """Whole sentences while they fit; otherwise the first sentence cut at the limit."""
    text = (text or "").strip()
    if words(text) <= max_words:
        return text
    out, used = [], 0.0
    for s in (x.strip() for x in _SENTENCE.split(text)):
        if not s:
            continue
        w = words(s)
        if used + w > max_words:
            break
        out.append(s)
        used += w
    if out:
        joiner = "" if _CJK.search(out[0]) else " "
        return joiner.join(out)
    clause, used = [], 0.0                               # one sentence is too long: whole clauses while they fit
    for c in re.split(r"(?<=[,，、:：—])\s*", text):
        w = words(c)
        if used + w > max_words:
            break
        clause.append(c)
        used += w
    if clause and used >= max_words * .5:
        return ("" if _CJK.search(clause[0]) else " ").join(clause).rstrip(" ,，、:：—") + "…"
    cut, used = [], 0.0
    for m in _TOKEN.finditer(text):
        t = m.group(0)
        w = .5 if _CJK.fullmatch(t) else 1
        if used + w > max_words:
            break
        cut.append((t, m.start()))
        used += w
    if not cut:
        return text[:40] + "…"
    end = cut[-1][1] + len(cut[-1][0])
    return text[:end].rstrip(" ,，、;；:：") + "…"


def _hash(text: str) -> str:
    return hashlib.sha256(text.strip().encode()).hexdigest()[:32]


# ---------------------------------------------------------------- what an item is


@dataclass
class Source:
    ref: str
    user_id: uuid.UUID
    kind: str                    # ambition | database | skill | agent
    en: str                      # canonical English text — what the model reads
    display: str                 # as the user wrote it
    private: bool = False
    context_en: str = ""         # e.g. the ambition a database belongs to (its gist)
    hash: str = ""


@dataclass
class Pyramid:
    ref: str
    source_level: int
    levels: dict[int, Layer] = field(default_factory=dict)
    stale: bool = False

    @property
    def strict(self) -> bool:
        w = [self.levels[lv].words for lv in LEVELS if lv in self.levels]
        return len(w) == 3 and w[0] < w[1] < w[2]

    def as_dict(self) -> dict:
        return {"ref": self.ref, "source_level": self.source_level, "strict": self.strict, "stale": self.stale,
                "ready": len(self.levels) == 3 and not self.stale and all(l.mode != "rule" for l in self.levels.values()),
                "levels": [{"level": lv, "name": NAMES[lv], "name_zh": NAMES_ZH[lv], "text": l.text, "text_en": l.text_en,
                            "mode": l.mode, "words": l.words, "updated_at": l.updated_at}
                           for lv, l in sorted(self.levels.items())]}


class LayerService:
    def __init__(self, rt: "Runtime"):
        self.rt = rt
        self.session = rt.session
        self.lp = rt.policy.layers

    # -------------------------------------------------------------- sources

    def source(self, ref: str) -> Source:
        s = self.session
        try:
            if ref.startswith("aim:"):
                a = s.get(Aim, uuid.UUID(ref[4:]))
                if a is None:
                    raise LayerError("aim not found")
                src = Source(ref, a.user_id, "ambition", a.text_en, a.text)
            elif ref.startswith("k:"):
                b = s.get(Body, uuid.UUID(ref[2:]))
                if b is None:
                    raise LayerError("body not found")
                src = Source(ref, b.user_id, b.kind, _join(b.title_en, b.description_en), _join(b.title, b.description, zh=True),
                             private=b.private, context_en=self._aim_gist(b.aim_id))
            else:
                r = s.get(Responsibility, uuid.UUID(ref))
                if r is None:
                    raise LayerError("agent not found")
                src = Source(ref, r.user_id, "agent", _join(r.title_en, r.description_en),
                             _join(r.raw_title or r.title_en, r.description_en), context_en=self._aim_gist(r.aim_id))
        except ValueError as exc:
            if isinstance(exc, LayerError):
                raise
            raise LayerError(f"unknown ref {ref!r}") from exc
        src.hash = _hash(src.en)
        return src

    def _aim_gist(self, aim_id: uuid.UUID | None) -> str:
        if not aim_id:
            return ""
        return f"It belongs to the ambition: {self.text(f'aim:{aim_id}', 1)}"

    def source_level(self, n_words: float) -> int:
        """Where the user's own text sits in the pyramid."""
        if n_words <= self.lp.gist_max_words:
            return 1
        if n_words <= self.lp.brief_max_words:
            return 2
        return 3

    def refs(self, user_id: uuid.UUID) -> list[str]:
        out = [f"aim:{a.id}" for a in self.session.scalars(select(Aim).where(Aim.user_id == user_id))]
        out += [f"k:{b.id}" for b in self.session.scalars(select(Body).where(Body.user_id == user_id))]
        from pga.db.types import TERMINAL_STATUSES
        out += [str(r.id) for r in self.session.scalars(select(Responsibility).where(Responsibility.user_id == user_id))
                if r.status not in TERMINAL_STATUSES]
        return out

    # -------------------------------------------------------------- reading

    def rows(self, refs: list[str]) -> dict[str, dict[int, Layer]]:
        out: dict[str, dict[int, Layer]] = {}
        if not refs:
            return out
        for l in self.session.scalars(select(Layer).where(Layer.ref.in_(refs))):
            out.setdefault(l.ref, {})[l.level] = l
        return out

    def get(self, ref: str) -> Pyramid:
        src = self.source(ref)
        have = self.rows([ref]).get(ref, {})
        stale = any(l.source_hash != src.hash for l in have.values())
        p = Pyramid(ref, self.source_level(words(src.en)), have, stale=stale or len(have) < 3)
        if len(have) < 3:                                      # not built yet: show the rule cut, unsaved
            for lv, (en, disp, mode) in self._rule(src).items():
                p.levels.setdefault(lv, Layer(user_id=src.user_id, ref=ref, level=lv, text_en=en, text=disp, mode=mode,
                                              words=round(words(en)), source_hash=src.hash, updated_at=utcnow()))
        return p

    def text(self, ref: str, level: int, *, display: bool = False, mark: bool = True, rows: dict | None = None) -> str:
        """The text of one level. Falls back to the closest built level, then to a rule cut of the source."""
        have = (rows if rows is not None else self.rows([ref])).get(ref, {})
        layer = have.get(level) or next((have[lv] for lv in sorted(have, key=lambda x: abs(x - level)) if lv in have), None)
        if layer is None:
            try:
                src = self.source(ref)
            except LayerError:
                return ""
            en, disp, mode = self._rule(src)[level]
            return disp if display else en
        t = layer.text if display else layer.text_en
        if mark and not display and layer.mode == "expanded":
            t = f"{EXPANDED_NOTE}\n{t}"
        return t

    def need(self, purpose: str, default: int = 2) -> int:
        return max(1, min(3, int(self.lp.needs.get(purpose, default))))

    def select(self, wanted: list[tuple[str, int, float]], budget_words: int) -> list[tuple[str, int, str]]:
        """`wanted` = (ref, level needed, importance). Every item starts at the level it needs; while the total is
        over budget, the least important item above L1 steps down a level; if all are at L1, the least important
        ones are dropped. Returns (ref, level, English text) in the original order."""
        rows = self.rows([r for r, _, _ in wanted])
        level = {r: lv for r, lv, _ in wanted}
        weight = {r: w for r, _, w in wanted}
        cache: dict[tuple[str, int], str] = {}

        def t(r: str, lv: int) -> str:
            if (r, lv) not in cache:
                cache[(r, lv)] = self.text(r, lv, rows=rows)
            return cache[(r, lv)]

        alive = [r for r, _, _ in wanted]
        while alive and sum(words(t(r, level[r])) for r in alive) > budget_words:
            above = [r for r in alive if level[r] > 1]
            if above:
                r = min(above, key=lambda x: (weight[x], -level[x]))
                level[r] -= 1
            else:
                alive.remove(min(alive, key=lambda x: weight[x]))
        return [(r, level[r], t(r, level[r])) for r in alive]

    # -------------------------------------------------------------- building

    def _rule(self, src: Source) -> dict[int, tuple[str, str, str]]:
        """No model: the source sits at its level, shorter levels are cut from it, longer ones repeat it."""
        at = self.source_level(words(src.en))
        lim = {1: self.lp.gist_max_words, 2: self.lp.brief_max_words, 3: 10 ** 6}
        out = {}
        for lv in LEVELS:
            if lv == at:
                out[lv] = (src.en, src.display, "source")
            elif lv < at:
                out[lv] = (clip(src.en, lim[lv]), clip(src.display, lim[lv]), "rule")
            else:
                out[lv] = (src.en, src.display, "rule")
        return out

    def build(self, user: User, ref: str, *, force: bool = False, use_model: bool = True, now: datetime | None = None) -> Pyramid:
        now = now or utcnow()
        src = self.source(ref)
        if src.user_id != user.id:
            raise LayerError("not this user's item")
        have = self.rows([ref]).get(ref, {})
        fresh = len(have) == 3 and all(l.source_hash == src.hash for l in have.values())
        model_ok = use_model and self.lp.enabled and not src.private
        if fresh and not force and (not model_ok or all(l.mode != "rule" for l in have.values())):
            return self.get(ref)

        made = self._rule(src)
        at = self.source_level(words(src.en))
        if model_ok:
            got = self._from_model(user, src, at, now)
            if got:
                made.update(got)
        for lv, (en, disp, mode) in made.items():
            row = have.get(lv) or Layer(user_id=src.user_id, ref=ref, level=lv)
            row.text_en, row.text, row.mode = en, disp, mode
            row.words, row.source_hash, row.updated_at = round(words(en)), src.hash, now
            if lv not in have:
                self.session.add(row)
        self.session.flush()
        return self.get(ref)

    def _from_model(self, user: User, src: Source, at: int, now: datetime) -> dict[int, tuple[str, str, str]] | None:
        lp = self.lp
        todo = {lv: ("CONDENSE" if lv < at else "EXPAND") for lv in LEVELS if lv != at}
        system = LAYER_SYSTEM.format(g=lp.gist_max_words, b_lo=max(lp.gist_max_words + 10, lp.brief_max_words // 2),
                                     b=lp.brief_max_words, f_lo=lp.full_min_words, f=lp.full_max_words, kind=src.kind,
                                     shape=KIND_SHAPE.get(src.kind, KIND_SHAPE["ambition"]), untrusted=UNTRUSTED_NOTE)
        prompt = "\n".join([
            f"Item type: {src.kind}",
            *( [src.context_en] if src.context_en else []),
            f"The person's text ({round(words(src.en))} words) is the {NAMES[at]} level:",
            f"<text>\n{src.en}\n</text>",
            "Write: " + "; ".join(f"{NAMES[lv]} ({how})" for lv, how in todo.items()),
        ])
        decision = self.rt.allocator.allocate(RunRequest(
            user_id=user.id, kind="layers_build",
            justification=Justification(why_now="an item on the map changed or has no pyramid yet",
                                        expected_gain="gist, brief and full versions every process can choose from",
                                        decision_affected="how much detail each process reads about this item",
                                        budget={"max_output_tokens": 1500}, stop_condition="pyramid stored"),
            estimates=Estimates(information_gain=0.4, decision_impact=0.4, user_relevance=0.8, urgency=0.3,
                                input_tokens=len(prompt) // 3 + 500, output_tokens=900)), now=now)
        if not decision.allowed:
            log.info("layers for %s: no budget (%s)", src.ref, "; ".join(decision.reasons))
            return None
        try:
            with self.rt.runs.track(decision, now) as guard:
                result = self.rt.router.complete(decision.tier, system=system, messages=[{"role": "user", "content": prompt}],
                                                 max_tokens=1500, usage=guard.usage_context())
                try:
                    data = parse_json(result.text)
                except ModelOutputError:
                    guard.stop("model reply was not valid JSON")
                    return None
                guard.stop("pyramid stored")
        except Exception as exc:  # noqa: BLE001 - a failed build falls back to the rule cut; the heartbeat retries
            log.warning("layers for %s failed: %s", src.ref, exc)
            return None
        if not isinstance(data, dict):
            return None
        en = {lv: str(data.get(NAMES[lv]) or "").strip() for lv in todo}
        if not all(en.values()):
            return None
        # keep the pyramid: every level within its limit (with some slack — a whole sentence slightly over the limit
        # reads better than a cut one) and shorter than the one below
        lim = {1: lp.gist_max_words * 1.5, 2: lp.brief_max_words * 1.5, 3: lp.full_max_words * 1.5}
        for lv in todo:
            en[lv] = clip(en[lv], lim[lv])
        full = {**en, at: src.en}
        for lv in (1, 2):
            if lv in todo and words(full[lv]) >= words(full[lv + 1]):
                en[lv] = full[lv] = clip(full[lv + 1], max(3, words(full[lv + 1]) * .6))
        # translation flattens line breaks; carry them through as ¶ so the full level keeps its structure
        shown = self.rt.hub._render(user.id, {NAMES[lv]: t.replace("\n", " ¶ ") for lv, t in en.items()})
        disp = {lv: re.sub(r"\s*¶\s*", "\n", str(shown.get(NAMES[lv]) or en[lv])).strip() for lv in todo}
        return {lv: (en[lv], disp[lv], "condensed" if lv < at else "expanded") for lv in todo}

    # -------------------------------------------------------------- upkeep

    def due(self, user_id: uuid.UUID, now: datetime, limit: int) -> list[str]:
        """Items whose pyramid is missing, stale, or only rule-cut (retried at most every few hours)."""
        refs = self.refs(user_id)
        rows = self.rows(refs)
        out = []
        for ref in refs:
            have = rows.get(ref, {})
            try:
                src = self.source(ref)
            except LayerError:
                continue
            if len(have) < 3 or any(l.source_hash != src.hash for l in have.values()):
                out.append(ref)
            elif not src.private and any(l.mode == "rule" for l in have.values()) and \
                    min(l.updated_at for l in have.values()) < now - timedelta(hours=self.lp.retry_hours):
                out.append(ref)
            if len(out) >= limit:
                break
        return out

    def forget(self, ref: str) -> None:
        self.session.execute(delete(Layer).where(Layer.ref == ref))


def _join(title: str, description: str, zh: bool = False) -> str:
    title, description = (title or "").strip(), (description or "").strip()
    if not description:
        return title
    sep = "：" if zh and _CJK.search(title + description) else ": "
    return f"{title}{sep}{description}"
