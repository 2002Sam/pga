"""The thought tree (思考树) of a motivation: its long self-dialogue, cut into a few meaningful nodes.

Root: the motivation. A node is one stretch of the dialogue that follows one line of thought — never one node per
question, which would bury the line in noise. A curator agent reads the new stretch of dialogue and cuts it where
attention turned (a new problem, a new angle, a decision, a return to an older thread), and says which node each new
one grows from: usually the node just before it (the trunk grows), sometimes an older one (a branch).

Multi-sampling makes the tree grow sideways: each node keeps how many of its answers were sampled several times and how
far the samples spread (twigs), and the ideas only one sample had (buds). You can pick any node — or bud — and continue
from there: your question and the agent's answer become a new branch, and PGA can be told to keep thinking along it.

For a project in a git repository each node also carries what happened in the code meanwhile: the commits made while
the node was being thought through, and the files its answers relied on, linked to GitHub at that commit.

Related work: Loom (socketteer: a tree of N continuations you navigate and branch), Sensecape / Graphologue (UIST '23:
non-linear, hierarchical exploration of LLM answers), Tree of Thoughts (search over branching thoughts), and dialogue
topic segmentation (SuperDialseg, EMNLP '23: cut where the topic or focus shifts).
"""

from __future__ import annotations

import logging
import re
import subprocess
import uuid
from dataclasses import dataclass, field
from datetime import datetime, timedelta
from pathlib import Path
from typing import TYPE_CHECKING

from sqlalchemy import func, select

from pga.agent.common import UNTRUSTED_NOTE, ModelOutputError, fence, parse_json
from pga.allocator import Estimates, Justification, RunRequest
from pga.db.models import AgentConversation, AgentRun, Aim, AimNote, LinkedAgent, PerpetualTask, Project, ThoughtNode, User
from pga.db.types import utcnow

if TYPE_CHECKING:
    from pga.runtime import Runtime

log = logging.getLogger("pga.tree")

WINDOW = 90                         # turns the curator reads at a time
GAP = timedelta(hours=2)            # the rule cut (when no model can curate): a pause this long starts a node
TURNS = ("question", "answer", "insight", "reflect", "correction", "checkpoint", "evolve", "summary", "plan", "alternative")
MAX_BUDS = 6

STYLE = {
    "zh": ("title: a short noun phrase, at most 16 Chinese characters. summary: exactly three lines, each starting with its "
           "label — \"问：\" what this stretch tried to find out (one sentence); \"发现：\" what it found (one or two short sentences "
           "in plain words: explain what a thing does instead of quoting code names, unless the name is essential); \"定：\" what "
           "was decided or what comes next (one sentence). key_thoughts: up to 4 items, each a plain statement of at most 25 "
           "Chinese characters. shift: one short sentence, why attention turned here. Write for a reader who was not there."),
    "en": ("title: a short noun phrase, at most 8 words. summary: exactly three lines, each starting with its label — "
           "\"Asked:\" what this stretch tried to find out (one sentence); \"Found:\" what it found (one or two short sentences in "
           "plain words: explain what a thing does instead of quoting code names, unless the name is essential); \"Next:\" what "
           "was decided or what comes next (one sentence). key_thoughts: up to 4 items, each a plain statement of at most 12 "
           "words. shift: one short sentence, why attention turned here. Write for a reader who was not there."),
}

CURATE = """You keep the thought tree of a long-running agent team that works on one motivation. The root of the tree is
the motivation; each node is ONE stretch of the team's self-dialogue that follows one line of thought. Cut the new
stretch of dialogue below into nodes, where attention clearly turned: a new problem, a new angle, a decision, or a return
to an older thread.
Rules:
- Few, meaningful nodes. A node usually spans 25-90 turns: one problem the team worked through, not one sub-question.
  Start a node only where attention really turned; small detours belong to the node they happened in. If the first turns
  still follow the latest node's line of thought, extend that node instead of starting a new one.
- Each new node grows from a parent: the node whose line of thought it continues. Usually that is the node just before it;
  when the dialogue picks up an older thread, the parent is that older node (this is how branches appear). Use "root" only
  for a line of thought that has nothing to do with any node on the tree.
- {style}
Write title, summary, key_thoughts and shift in {lang}.
{untrusted}
Reply with JSON only: {{"extend_latest_until": <index of the last turn that still belongs to the latest node, or -1>,
"nodes": [{{"from": <first turn index>, "to": <last turn index>, "parent": "root" | "<existing node id>" | "new:<k>",
"title": "...", "summary": "...", "key_thoughts": ["..."], "shift": "..."}}]}}
"new:<k>" is the k-th new node of this reply (0-based). Turns not covered are attached to the node before them."""

REWRITE = """You keep the thought tree of a long-running agent team. Rewrite the title, summary, key thoughts and shift of the
nodes below so that someone who was not there understands them at a glance. Keep the meaning; drop jargon; be concrete.
{style}
Write in {lang}. {untrusted}
Reply with JSON only: {{"nodes": [{{"id": "<node id>", "title": "...", "summary": "...", "key_thoughts": ["..."], "shift": "..."}}]}}"""

EXCHANGE = """Two lines of thought from a long-running agent team's thought trees are put side by side (A and B below; they
may belong to different motivations). Let them talk to each other: what A can take from B, what B can take from A, where
they disagree or conflict, and one concrete next step that uses both. Be specific and short; plain words.
Answer in {lang}, as Markdown with four short sections."""


class TreeError(RuntimeError):
    pass


def _lang(user: User) -> tuple[str, str]:
    zh = (user.locale or "zh").lower().startswith("zh")
    return ("Simplified Chinese", "zh") if zh else ("English", "en")


class YouRoot:
    """The root of your conversation tree: you — your own conversations with agents, in PGA and imported from other apps."""
    scope = "user"

    def __init__(self, user: User):
        self.id, self.user_id = user.id, user.id
        self.text, self.text_en = "你的对话", "The user's own conversations with AI agents (in PGA and imported from other apps)"


def _scope(root) -> str:
    return getattr(root, "scope", "aim")


@dataclass
class Turn:
    """One turn of your conversation tree: your message, an agent's answer, or a conversation imported from another app."""
    id: str
    kind: str
    agent: str | None
    text: str
    created_at: datetime
    data: dict = field(default_factory=dict)
    status: str = "done"
    role: str | None = None

    @property
    def text_en(self) -> str:
        return self.text


def _answer(output: str) -> str:
    try:
        d = parse_json(output)
        if isinstance(d, dict) and d.get("answer"):
            return str(d["answer"])
    except ModelOutputError:
        pass
    return output or ""


def _short(u: uuid.UUID | str) -> str:
    return str(u)[:8]


def _clip(t: str, n: int) -> str:
    t = " ".join(str(t or "").split())
    return t if len(t) <= n else t[: n - 1] + "…"


class ThoughtTree:
    def __init__(self, rt: "Runtime"):
        self.rt = rt
        self.s = rt.session

    # -------------------------------------------------------------- reading

    def _where(self, root) -> tuple:
        if isinstance(root, uuid.UUID):
            return (ThoughtNode.aim_id == root,)
        if _scope(root) == "user":
            return (ThoughtNode.scope == "user", ThoughtNode.user_id == root.id)
        return (ThoughtNode.aim_id == root.id,)

    def root_of(self, node: ThoughtNode):
        if node.aim_id:
            return self.s.get(Aim, node.aim_id)
        return YouRoot(self.s.get(User, node.user_id))

    def _make(self, root, **kw) -> ThoughtNode:
        return ThoughtNode(user_id=root.user_id, aim_id=None if _scope(root) == "user" else root.id, scope=_scope(root), **kw)

    def _max_seq(self, root) -> int:
        return int(self.s.scalar(select(func.max(ThoughtNode.seq)).where(*self._where(root))) or 0)

    def nodes(self, root) -> list[ThoughtNode]:
        return list(self.s.scalars(select(ThoughtNode).where(*self._where(root)).order_by(ThoughtNode.seq)))

    def latest(self, root) -> ThoughtNode | None:
        return self.s.scalar(select(ThoughtNode).where(*self._where(root), ThoughtNode.kind == "segment")
                             .order_by(ThoughtNode.seq.desc()).limit(1))

    def placed_until(self, root) -> datetime | None:
        return self.s.scalar(select(func.max(ThoughtNode.last_at)).where(*self._where(root), ThoughtNode.kind == "segment"))

    # your conversations: PGA's own chats (each a message and an answer) and the ones imported from other apps
    def _your_turns(self, user_id: uuid.UUID, placed: set[str] | None = None) -> list[Turn]:
        out: list[Turn] = []
        for r in self.s.scalars(select(AgentRun).where(AgentRun.user_id == user_id, AgentRun.parent_id.is_(None), AgentRun.workflow == "ask")
                                .order_by(AgentRun.started_at)):
            d = r.data or {}
            conv = str(d.get("conversation") or "")
            if d.get("node") or conv.startswith(("node:", "exchange:")) or (placed is not None and f"r:{r.id}" in placed):
                continue
            out += self._run_turns(r)
        for c, la in self.s.execute(select(AgentConversation, LinkedAgent).join(LinkedAgent, LinkedAgent.id == AgentConversation.linked_agent_id)
                                    .where(LinkedAgent.user_id == user_id)):
            if placed is not None and f"c:{c.id}" in placed:
                continue
            out.append(self._conv_turn(c, la))
        return sorted(out, key=lambda t: t.created_at)

    def _run_turns(self, r: AgentRun) -> list[Turn]:
        d = r.data or {}
        meta = {"conversation": d.get("conversation"), "run": str(r.id), "project": (d.get("project") or {}).get("name")}
        out = [Turn(f"r:{r.id}", "question", "you", " ".join((r.prompt or "").split())[:4000], r.started_at, meta)]
        ans = _answer(r.output) or r.error or ""
        if ans:
            out.append(Turn(f"r:{r.id}", "answer", r.agent, ans[:12000], r.finished_at or r.started_at, {**meta, "status": r.status},
                            status=r.status.lower() if r.status else "done"))
        return out

    def _conv_turn(self, c: AgentConversation, la: LinkedAgent) -> Turn:
        at = c.updated_at or c.started_at or c.created_at
        return Turn(f"c:{c.id}", "conversation", la.name or la.vendor, f"{c.title}\n{c.excerpt}".strip()[:6000], at,
                    {"vendor": la.vendor, "project": c.project, "messages": c.message_count, "model": c.model,
                     "started_at": c.started_at.isoformat() if c.started_at else None})

    def _placed(self, root) -> set[str]:
        out: set[str] = set()
        for ids in self.s.scalars(select(ThoughtNode.note_ids).where(*self._where(root))):
            out.update(str(x) for x in ids or [])
        return out

    def pending(self, aim, limit: int = WINDOW) -> list:
        """Turns not in the tree yet (oldest first). Your own branches are placed when you make them."""
        if _scope(aim) == "user":
            return self._your_turns(aim.id, self._placed(aim))[:limit]
        since = self.placed_until(aim.id)
        q = select(AimNote).where(AimNote.aim_id == aim.id, AimNote.kind.in_(TURNS))
        if since is not None:
            q = q.where(AimNote.created_at > since)
        return [n for n in self.s.scalars(q.order_by(AimNote.created_at).limit(limit * 2)) if not (n.data or {}).get("node")][:limit]

    def pending_count(self, aim) -> int:
        if _scope(aim) == "user":
            return len(self._your_turns(aim.id, self._placed(aim)))
        since = self.placed_until(aim.id)
        q = select(func.count()).select_from(AimNote).where(AimNote.aim_id == aim.id, AimNote.kind.in_(TURNS))
        if since is not None:
            q = q.where(AimNote.created_at > since)
        return int(self.s.scalar(q) or 0)

    def path(self, node: ThoughtNode) -> list[ThoughtNode]:
        out, seen, n = [], set(), node
        while n is not None and n.id not in seen:
            seen.add(n.id)
            out.append(n)
            n = self.s.get(ThoughtNode, n.parent_id) if n.parent_id else None
        return list(reversed(out))

    def notes_of(self, node: ThoughtNode) -> list:
        if node.scope == "user" or any(str(x).startswith(("r:", "c:")) for x in node.note_ids or []):
            return self._turns_of(node)
        ids = [uuid.UUID(str(x)) for x in (node.note_ids or [])]
        if not ids:
            return []
        return list(self.s.scalars(select(AimNote).where(AimNote.id.in_(ids)).order_by(AimNote.created_at)))

    def _turns_of(self, node: ThoughtNode) -> list:
        runs = [uuid.UUID(x[2:]) for x in node.note_ids or [] if str(x).startswith("r:")]
        convs = [uuid.UUID(x[2:]) for x in node.note_ids or [] if str(x).startswith("c:")]
        notes = [uuid.UUID(str(x)) for x in node.note_ids or [] if not str(x).startswith(("r:", "c:"))]
        out: list = []
        if runs:
            for r in self.s.scalars(select(AgentRun).where(AgentRun.id.in_(runs))):
                out += self._run_turns(r)
        if convs:
            for c, la in self.s.execute(select(AgentConversation, LinkedAgent).join(LinkedAgent, LinkedAgent.id == AgentConversation.linked_agent_id)
                                        .where(AgentConversation.id.in_(convs))):
                out.append(self._conv_turn(c, la))
        if notes:
            out += list(self.s.scalars(select(AimNote).where(AimNote.id.in_(notes))))
        return sorted(out, key=lambda t: t.created_at)

    # -------------------------------------------------------------- curating

    def curate(self, user: User, aim: Aim, now: datetime | None = None, *, windows: int = 1, use_model: bool = True,
               after_window=None) -> dict:
        """Place the pending dialogue into the tree, one window at a time (after_window: e.g. commit, so the tree
        visibly grows window by window). Returns what was done."""
        now = now or utcnow()
        made = extended = 0
        mode = "model"
        for _ in range(max(1, windows)):
            turns = self.pending(aim)
            if not turns:
                break
            got = self._curate_window(user, aim, turns, now) if use_model else None
            if got is None:
                mode = "rule"
                got = self._rule_window(aim, turns)
            made += got[0]
            extended += got[1]
            self._refresh_growth(aim)
            self.s.flush()
            if after_window:
                after_window()
        self._refresh_growth(aim)
        return {"new_nodes": made, "extended": extended, "pending": self.pending_count(aim), "mode": mode}

    def _turn_line(self, i: int, n: AimNote) -> str:
        d = n.data or {}
        who = "you" if n.kind == "correction" or n.agent == "you" else (n.agent or n.role or "agent")
        tag = n.kind + (f" {d.get('code')}" if d.get("code") else "")
        extra = ""
        if n.kind == "answer" and d.get("samples"):
            extra = f" [{len(d['samples'])} samples, spread {float(d.get('divergence') or 0):.2f}]"
        if d.get("inspiration"):
            tag = "inspiration"
        lim = 140 if n.kind == "question" else 320
        return f"[{i}] {n.created_at.strftime('%m-%d %H:%M')} {tag} ({who}){extra}: {_clip(n.text_en or n.text, lim)}"

    def _outline(self, aim: Aim) -> str:
        rows = [n for n in self.nodes(aim) if n.kind != "bud"][-40:]
        if not rows:
            return "(the tree is empty: only the root)"
        return "\n".join(f"node {_short(n.id)} (parent {_short(n.parent_id) if n.parent_id else 'root'}): {_clip(n.title, 90)}"
                         for n in rows)

    def _focus_hint(self, aim) -> str:
        if _scope(aim) == "user":
            return ""
        t = self.s.scalar(select(PerpetualTask).where(PerpetualTask.aim_id == aim.id))
        fid = ((t.settings or {}).get("focus_node") if t else None)
        if not fid:
            return ""
        return (f"\nSince {(t.settings or {}).get('focus_since', '')[:16]} the user asked the team to continue along node "
                f"{_short(fid)}: new lines of thought from then on most likely grow from it.")

    def _curate_window(self, user: User, aim: Aim, turns: list[AimNote], now: datetime) -> tuple[int, int] | None:
        lang, style = _lang(user)
        system = CURATE.format(lang=lang, style=STYLE[style], untrusted=UNTRUSTED_NOTE)
        latest = self.latest(aim)
        body = "\n".join(self._turn_line(i, n) for i, n in enumerate(turns))
        head = (f"Motivation: {aim.text_en or aim.text}" if _scope(aim) == "aim" else
                "Root: the user's OWN conversations with AI agents (not an agent team): their messages and the answers in PGA, "
                "and whole conversations imported from other apps (a title and an excerpt each). Cut them by topic and purpose; "
                "a conversation that returns to an older topic grows from that topic's node.")
        prompt = (f"{head}\n\nThe tree so far:\n{self._outline(aim)}\n"
                  f"Latest node: {_short(latest.id) if latest else 'none'}{self._focus_hint(aim)}\n\n"
                  + fence("source", body, 60000, kind="new stretch of the team's dialogue"))
        decision = self.rt.allocator.allocate(RunRequest(
            user_id=user.id, kind="synthesis",
            justification=Justification(
                why_now=f"{len(turns)} turns of the self-dialogue are not in the thought tree yet",
                expected_gain="a few meaningful nodes instead of hundreds of single questions",
                decision_affected="which line of thought you and the team continue from",
                budget={"max_units": 80_000, "max_output_tokens": 2500}, stop_condition="this window is placed"),
            estimates=Estimates(information_gain=.5, decision_impact=.5, user_relevance=.8, reuse_value=.8,
                                input_tokens=len(prompt) // 3, output_tokens=1500)), now=now)
        if not decision.allowed:
            log.info("tree curate deferred: %s", "; ".join(decision.reasons))
            raise TreeDeferred("; ".join(decision.reasons))
        try:
            with self.rt.runs.track(decision, now) as guard:
                res = self.rt.router.complete(decision.tier, system=system, messages=[{"role": "user", "content": prompt}],
                                              max_tokens=2500, usage=guard.usage_context())
                try:
                    d = parse_json(res.text)
                except ModelOutputError:
                    guard.stop("curator reply was not JSON")
                    return None
                guard.stop("thought tree window placed")
        except TreeDeferred:
            raise
        except Exception as exc:  # noqa: BLE001 - the model could not be reached: try again later rather than cut blindly
            log.warning("tree curate failed: %s", exc)
            raise TreeDeferred(f"the curator could not be reached: {exc}"[:300]) from exc
        if not isinstance(d, dict):
            return None
        return self._apply(aim, turns, d)

    def _apply(self, aim: Aim, turns: list[AimNote], d: dict) -> tuple[int, int] | None:
        n = len(turns)
        latest = self.latest(aim)
        try:
            ext = int(d.get("extend_latest_until", -1))
        except (TypeError, ValueError):
            ext = -1
        ext = min(max(-1, ext), n - 1) if latest else -1
        specs = []
        for x in d.get("nodes") or []:
            if not isinstance(x, dict) or not str(x.get("title") or "").strip():
                continue
            try:
                a, b = int(x.get("from")), int(x.get("to", x.get("from")))
            except (TypeError, ValueError):
                continue
            a = max(ext + 1, min(a, n - 1))
            specs.append({**x, "from": a, "to": max(a, min(b, n - 1))})
        specs.sort(key=lambda x: x["from"])
        dedup = []
        for x in specs:                                     # one node per starting turn
            if dedup and dedup[-1]["from"] == x["from"]:
                continue
            dedup.append(x)
        specs = dedup
        cap = max(1, n // 25)                               # never many small nodes: merge the shortest into the one before
        while len(specs) > cap:
            spans = [(specs[i + 1]["from"] if i + 1 < len(specs) else n) - s["from"] for i, s in enumerate(specs)]
            i = min(range(1, len(specs)), key=lambda k: spans[k]) if len(specs) > 1 else 0
            specs.pop(i)
        if not specs and ext < 0 and latest is None:
            return None
        # turn → node: extend the latest up to `ext`, each spec owns its turns up to the next spec
        owner: list[ThoughtNode | int | None] = [None] * n
        for i in range(0, ext + 1):
            owner[i] = latest
        for k, x in enumerate(specs):
            end = specs[k + 1]["from"] if k + 1 < len(specs) else n
            for i in range(x["from"], end):
                owner[i] = k
        first_spec = specs[0]["from"] if specs else n
        for i in range(ext + 1, first_spec):             # not covered before the first new node: the latest node (or the first new one)
            owner[i] = latest if latest is not None else 0
        seq = self._max_seq(aim)
        by_short = {_short(x.id): x for x in self.nodes(aim)}
        made: list[ThoughtNode] = []
        for k, x in enumerate(specs):
            par = str(x.get("parent") or "").strip()
            if par == "root":
                parent = None
            elif par.startswith("new:"):
                try:
                    j = int(par[4:])
                except ValueError:
                    j = k - 1
                parent = made[j] if 0 <= j < len(made) else (made[-1] if made else latest)
            else:
                parent = by_short.get(par[:8]) or (made[-1] if made else latest)
            seq += 1
            node = self._make(aim, parent_id=parent.id if parent else None, kind="segment", seq=seq,
                               title=_clip(x.get("title"), 120), summary=str(x.get("summary") or "")[:1500],
                               shift=str(x.get("shift") or "")[:400],
                               key_thoughts=[_clip(t, 200) for t in (x.get("key_thoughts") or []) if str(t).strip()][:4],
                               note_ids=[], data={"mode": "model", "style": 2}, created_at=utcnow())
            self.s.add(node)
            self.s.flush()
            made.append(node)
        extended = 0
        for i, o in enumerate(owner):
            node = made[o] if isinstance(o, int) else o
            if node is None:
                continue
            extended += node is latest
            self._attach(node, turns[i])
        for node in made + ([latest] if latest is not None and extended else []):
            self._grow_details(aim, node)
        return len(made), int(bool(extended))

    def _rule_window(self, aim: Aim, turns: list[AimNote]) -> tuple[int, int]:
        """No model: cut where the dialogue paused for a while; a node is named after its first question."""
        latest = self.latest(aim)
        seq = self._max_seq(aim)
        touched: dict[uuid.UUID, ThoughtNode] = {}
        made = extended = 0
        cur, prev_at = latest, (latest.last_at if latest else None)
        gap = GAP if _scope(aim) == "aim" else timedelta(days=3)   # your conversations are spread over months
        for n in turns:
            if cur is None or (prev_at and n.created_at - prev_at > gap) or len(cur.note_ids or []) >= 60:
                seq += 1
                title = n.text if n.kind in ("question", "conversation") else f"{n.created_at.strftime('%m-%d %H:%M')} 起的思考"
                cur = self._make(aim, parent_id=cur.id if cur else None, kind="segment", seq=seq,
                                  title=_clip(title, 60), note_ids=[], data={"mode": "rule"}, created_at=utcnow())
                self.s.add(cur)
                self.s.flush()
                made += 1
            elif cur is latest:
                extended = 1
            self._attach(cur, n)
            touched[cur.id] = cur
            prev_at = n.created_at
        for node in touched.values():
            self._grow_details(aim, node)
        return made, extended

    def _attach(self, node: ThoughtNode, n) -> None:
        if str(n.id) not in (node.note_ids or [])[-2:]:          # a run's message and answer share one id
            node.note_ids = list(node.note_ids or []) + [str(n.id)]
        node.first_at = min(node.first_at or n.created_at, n.created_at)
        node.last_at = max(node.last_at or n.created_at, n.created_at)
        node.updated_at = utcnow()

    def _grow_details(self, aim: Aim, node: ThoughtNode) -> None:
        """Twigs (sampled answers), buds (ideas only one sample had), counts — and the code meanwhile."""
        notes = self.notes_of(node)
        sampled = [n for n in notes if n.kind == "answer" and (n.data or {}).get("samples")]
        buds = [{"note": str(n.id), "idea": _clip(n.text, 160)} for n in notes if n.kind == "insight" and (n.data or {}).get("inspiration")]
        node.data = {**(node.data or {}),
                     "turns": len(notes), "questions": sum(n.kind == "question" for n in notes),
                     "answers": sum(n.kind == "answer" for n in notes),
                     "open": sum(n.kind == "question" and n.status in ("open", "for_you") for n in notes),
                     "codes": (lambda cs: [cs[0], cs[-1]] if len(cs) > 1 else cs)(
                         [c for c in ((n.data or {}).get("code") for n in notes if n.kind == "question") if c]),
                     "sampled": len(sampled), "samples": sum(len((n.data or {}).get("samples") or []) for n in sampled),
                     "spread": round(sum(float((n.data or {}).get("divergence") or 0) for n in sampled) / len(sampled), 3) if sampled else None,
                     "buds": buds[-MAX_BUDS:],
                     "shadows": [{"note": str(n.id), "alt": (n.data or {}).get("alt"), "conclusion": _clip(n.text, 200),
                                  "assumption": _clip((n.data or {}).get("assumption") or "", 160), "status": n.status}
                                 for n in notes if n.kind == "alternative"][-4:],
                     "proposals": sorted({p for p in ((n.data or {}).get("proposal") for n in notes) if p})[:8]}
        if not node.title.strip():
            q = next((n for n in notes if n.kind == "question"), None)
            node.title = _clip(q.text if q else "思考", 60)
        node.git = self._git(aim, node, notes)
        try:
            node.data = {**(node.data or {}), "behavior": self._behavior_counts(node)}
        except Exception as exc:  # noqa: BLE001 - counts are a nicety; the node is fine without them
            log.info("behaviour for %s: %s", node.id, exc)

    def _refresh_growth(self, aim: Aim) -> None:
        """The newest node is the growing tip."""
        latest = self.latest(aim)
        for n in self.nodes(aim):
            tip = latest is not None and n.id == latest.id
            if bool((n.data or {}).get("tip")) != tip:
                n.data = {**(n.data or {}), "tip": tip}

    # -------------------------------------------------------------- the code meanwhile

    def project(self, aim) -> Project | None:
        if _scope(aim) == "user":
            return None
        t = self.s.scalar(select(PerpetualTask).where(PerpetualTask.aim_id == aim.id))
        if t and t.project_id:
            return self.s.get(Project, t.project_id)
        return self.s.scalar(select(Project).where(Project.aim_id == aim.id).limit(1))

    def _git(self, aim: Aim, node: ThoughtNode, notes: list[AimNote]) -> dict:
        p = self.project(aim)
        if not p or not node.first_at or not (Path(p.path) / ".git").exists():
            return {}
        try:
            repo = github_url(_git(p.path, "remote", "get-url", "origin").strip())
            log_out = _git(p.path, "log", f"--since={node.first_at.isoformat()}", f"--until={(node.last_at or node.first_at).isoformat()}",
                           "--format=%H%x09%aI%x09%s", "-n", "12")
            head = _git(p.path, "rev-list", "-1", f"--before={(node.last_at or node.first_at).isoformat()}", "HEAD").strip()
        except (OSError, subprocess.SubprocessError, ValueError) as exc:
            log.info("git for %s: %s", p.path, exc)
            return {}
        commits = []
        for line in log_out.splitlines():
            sha, at, subj = (line.split("\t", 2) + ["", ""])[:3]
            if sha:
                commits.append({"sha": sha[:10], "at": at, "subject": _clip(subj, 120), "url": f"{repo}/commit/{sha}" if repo else None})
        files: dict[str, dict] = {}
        for n in notes:
            for ev in (n.data or {}).get("evidence") or []:
                m = re.match(r"^\s*([\w./-]+\.\w+)(?::(\d+))?", str(ev))
                if not m or m.group(1).startswith(("http", "/")) or ".." in m.group(1):
                    continue
                path = m.group(1).lstrip("./")
                if not (Path(p.path) / path).exists():
                    continue
                f = files.setdefault(path, {"path": path, "refs": 0, "url": f"{repo}/blob/{head}/{path}" if repo and head else None})
                f["refs"] += 1
                if m.group(2) and f["url"] and "#L" not in f["url"]:
                    f["url"] += f"#L{m.group(2)}"
        return {"repo": repo, "head": head[:10] if head else None, "head_url": f"{repo}/tree/{head}" if repo and head else None,
                "commits": commits, "files": sorted(files.values(), key=lambda f: -f["refs"])[:10]}

    # -------------------------------------------------------------- continuing from a branch

    def context_for(self, node: ThoughtNode, intro: bool = True) -> str:
        """What an agent reads when a conversation starts on this node. Ordered from what changes least to what
        changes most, and written the same way every time (no clocks, fixed order), so that every branch started from
        the same node opens with the same text and the providers' prompt caches can serve it: the motivation, the two
        models and the knowledge the tree refers to, the path from the root, the links, the code, and last this node's
        latest turns. What belongs to one message only (knowledge you pinned to it, related bits of other branches)
        goes after the question instead: see `tail_for`. Inside a running session the agent hears only the new message."""
        aim = self.root_of(node)
        what = "the user's motivation" if _scope(aim) == "aim" else "the user's own conversations"
        lines = [f"You are continuing one branch of the thought tree of {what}: {aim.text_en or aim.text}" if intro
                 else f"Root: {aim.text_en or aim.text}"]
        if intro:
            lines.append(knowledge_context(self.rt, aim))
            refs = [r for n in self.path(node) for r in ((n.data or {}).get("refs") or [])]
            lines.append(refs_context(self.rt, list(dict.fromkeys(refs)), node.user_id))
        lines.append("The branch, from the root to the chosen node:")
        for i, n in enumerate(self.path(node)):
            lines.append(f"{'  ' * i}- {n.title}" + (f": {n.summary}" if n.summary else "")
                         + (f" (key: {'; '.join(n.key_thoughts)})" if n.key_thoughts else ""))
        links = sorted((x for x in (self.s.get(ThoughtNode, i) for i in self.linked(node)) if x is not None), key=lambda x: x.seq)
        if links:
            lines.append("Lines of thought the user linked to this node:")
            lines += [f"- {x.title}" + (f": {x.summary}" if x.summary else "") for x in links[:6]]
        if (node.git or {}).get("head"):
            lines.append(f"The code at that point: commit {node.git['head']}" +
                         (f"; files it relied on: {', '.join(f['path'] for f in node.git.get('files') or [])}" if node.git.get("files") else ""))
        recent = [n for n in self.notes_of(node) if n.kind in ("answer", "insight", "question", "conversation")][-6:]
        if recent:
            lines.append("The latest turns on this node:")
            lines += [f"- {n.kind}: {_clip(n.text, 500)}" for n in recent]
        if intro:
            lines.append("Continue this line of thought with the user. Answer in the user's language.")
        return "\n".join(x for x in lines if x)

    def related(self, node: ThoughtNode, question: str, k: int = 3) -> list[ThoughtNode]:
        """Nodes elsewhere in the tree (not on this path, not linked) that talk about what the question asks: by shared
        words and character pairs — cheap, no model."""
        def grams(t: str) -> set[str]:
            t = (t or "").lower()
            words = set(re.findall(r"[a-z0-9_]{3,}", t))
            han = re.sub(r"[^\u3400-\u9fff]", "", t)
            return words | {han[i:i + 2] for i in range(len(han) - 1)}
        q = grams(question)
        if len(q) < 2:
            return []
        skip = {x.id for x in self.path(node)} | set(self.linked(node))
        scored = []
        for n in self.nodes(self.root_of(node)):
            if n.id in skip or (n.data or {}).get("hidden"):
                continue
            g = grams(" ".join([n.title, n.summary or "", " ".join(n.key_thoughts or [])]))
            hit = len(q & g)
            if hit >= 2:
                scored.append((hit / (len(q) ** .5 * max(1, len(g)) ** .5), n))
        return [n for _, n in sorted(scored, key=lambda x: -x[0])[:k]]

    def tail_for(self, node: ThoughtNode, question: str, refs: list[str] | None = None) -> str:
        """What goes after this one message: the knowledge you pinned to it and up to three related nodes from other
        branches. It sits at the end, so the cached opening stays the same."""
        parts = []
        if refs:
            parts.append(refs_context(self.rt, refs, node.user_id, question))
        rel = self.related(node, question)
        if rel:
            parts.append("<related_branches note=\"other branches of this tree that touched on the same thing\">\n" + "\n".join(
                f"- {n.title}" + (f": {_clip(n.summary, 300)}" if n.summary else "") for n in rel) + "\n</related_branches>")
        return "\n\n".join(p for p in parts if p)

    def branch_for(self, node: ThoughtNode, text: str, bud: str | None = None, branch: bool = False) -> ThoughtNode:
        """Where your turn goes: a branch of yours continues in place; anywhere else (or when you ask to branch) a new
        branch grows from the node."""
        if node.kind == "user" and not bud and not branch:
            if not node.note_ids and node.title in NEW_NODE:             # a node made with the +: its first question names it
                node.title = _clip(text, 40)
            return node
        seq = self._max_seq(self.root_of(node)) + 1
        title = _clip(bud or text, 40)
        b = ThoughtNode(user_id=node.user_id, aim_id=node.aim_id, scope=node.scope, parent_id=node.id, kind="user", seq=seq, title=title,
                        summary="", note_ids=[], data={"from_bud": bud} if bud else {}, created_at=utcnow())
        self.s.add(b)
        self.s.flush()
        return b

    def record(self, branch: ThoughtNode, aim, question: str, reply: dict) -> list:
        if _scope(aim) == "user" or not branch.aim_id:            # your tree: the reply is a run of the chat itself
            run = self.s.get(AgentRun, uuid.UUID(str(reply["run_id"]))) if reply.get("run_id") else None
            if run is None:
                return []
            run.data = {**(run.data or {}), "node": str(branch.id)}
            turns = self._run_turns(run)
            for t in turns:
                self._attach(branch, t)
            self._grow_details(aim, branch)
            if not branch.summary and len(turns) > 1:
                branch.summary = _clip(turns[1].text, 280)
            return turns
        from pga.teams import TeamService
        team = TeamService(self.rt)
        now = utcnow()
        q = team._note(aim, "question", question[:6000], role=None, agent="you", now=now, status="answered",
                       data={"node": str(branch.id), "by_user": True})
        out = [q]
        if (reply.get("text") or "").strip():
            out.append(team._note(aim, "answer", str(reply["text"])[:12000], role="researcher", agent=reply.get("agent"), now=utcnow(),
                                  data={"node": str(branch.id), "question": question[:300]}))
        for n in out:
            self._attach(branch, n)
        self._grow_details(aim, branch)
        if not branch.summary and len(out) > 1:
            branch.summary = _clip(out[1].text, 280)
        return out

    def focus(self, aim, node: ThoughtNode | None) -> dict:
        if _scope(aim) == "user":
            raise TreeError("你的对话树没有长期任务可以引导")
        t = self.s.scalar(select(PerpetualTask).where(PerpetualTask.aim_id == aim.id))
        if t is None:
            raise TreeError("这个抱负还没有在长期运行：先按 ▶ 开始")
        st = dict(t.settings or {})
        if node is None:
            st.pop("focus_node", None)
            st.pop("focus_since", None)
        else:
            st["focus_node"], st["focus_since"] = str(node.id), utcnow().isoformat()
        t.settings = st
        self.s.flush()
        return {"focus": st.get("focus_node")}

    def focus_context(self, aim: Aim, node_id: str) -> str:
        try:
            node = self.s.get(ThoughtNode, uuid.UUID(str(node_id)))
        except ValueError:
            return ""
        if node is None or node.aim_id != aim.id:
            return ""
        path = " → ".join(_clip(n.title, 60) for n in self.path(node))
        return (f"<focus_branch>\nThe user chose this branch of the thought tree to continue: {path}\n"
                f"{node.summary}\nPrefer questions that continue this line of thought.\n</focus_branch>")

    # -------------------------------------------------------------- readable again

    def rewrite(self, user: User, aim: Aim, now: datetime | None = None, *, batch: int = 4, limit: int = 40) -> dict:
        """Rewrite older or hard-to-read summaries in the readable style (nodes you edited are left alone)."""
        now = now or utcnow()
        todo = [n for n in self.nodes(aim) if n.kind == "segment" and (n.data or {}).get("style") != 2
                and not (n.data or {}).get("edited")][:limit]
        lang, style = _lang(user)
        done = 0
        for i in range(0, len(todo), batch):
            group = todo[i:i + batch]
            parts = []
            for n in group:
                turns = [x for x in self.notes_of(n) if x.kind in ("question", "answer", "insight", "correction")]
                step = max(1, len(turns) // 24)
                lines = "\n".join(f"- {x.kind}: {_clip(x.text_en or x.text, 220)}" for x in turns[::step][:24])
                parts.append(f"<node id=\"{_short(n.id)}\">\nCurrent title: {n.title}\nCurrent summary: {n.summary}\n"
                             f"Current shift: {n.shift}\nSome of its turns:\n{lines}\n</node>")
            prompt = fence("source", "\n\n".join(parts), 40000, kind="nodes to rewrite")
            decision = self.rt.allocator.allocate(RunRequest(
                user_id=user.id, kind="synthesis",
                justification=Justification(why_now="node summaries are hard to read", expected_gain="a tree you can read at a glance",
                                            decision_affected="which branch you continue from",
                                            budget={"max_units": 60_000, "max_output_tokens": 2000}, stop_condition="these nodes rewritten"),
                estimates=Estimates(information_gain=.3, decision_impact=.3, user_relevance=.9, reuse_value=.6,
                                    input_tokens=len(prompt) // 3, output_tokens=1200)), now=now)
            if not decision.allowed:
                raise TreeDeferred("; ".join(decision.reasons))
            try:
                with self.rt.runs.track(decision, now) as guard:
                    res = self.rt.router.complete(decision.tier, system=REWRITE.format(style=STYLE[style], lang=lang, untrusted=UNTRUSTED_NOTE),
                                                  messages=[{"role": "user", "content": prompt}], max_tokens=2000, usage=guard.usage_context())
                    d = parse_json(res.text)
                    guard.stop("nodes rewritten")
            except (ModelOutputError, Exception) as exc:  # noqa: BLE001 - leave these as they are; try the next group
                log.info("rewrite failed: %s", exc)
                continue
            by = {_short(n.id): n for n in group}
            for x in (d.get("nodes") or []) if isinstance(d, dict) else []:
                n = by.get(str(x.get("id") or "")[:8])
                if n is None or not str(x.get("title") or "").strip():
                    continue
                n.title, n.summary = _clip(x["title"], 60), str(x.get("summary") or n.summary)[:1500]
                n.key_thoughts = [_clip(t, 80) for t in (x.get("key_thoughts") or []) if str(t).strip()][:4] or n.key_thoughts
                n.shift = str(x.get("shift") or n.shift)[:400]
                n.data = {**(n.data or {}), "style": 2}
                done += 1
            self.s.flush()
        return {"rewritten": done, "left": max(0, len(todo) - done)}

    # -------------------------------------------------------------- operations on a node

    def update(self, node: ThoughtNode, *, title: str | None = None, summary: str | None = None,
               key_thoughts: list | None = None, hidden: bool | None = None, parent: ThoughtNode | None | str = "keep",
               pos: dict | None | str = "keep") -> ThoughtNode:
        """Rename, rewrite, hide / show, or move a node (in the tree, or only where it is drawn: `pos`, an offset from
        its place in the layout; None puts it back). What you write is never overwritten by the curator."""
        edited = False
        if title is not None and title.strip():
            node.title, edited = _clip(title, 120), True
        if summary is not None:
            node.summary, edited = summary.strip()[:3000], True
        if key_thoughts is not None:
            node.key_thoughts, edited = [_clip(t, 120) for t in key_thoughts if str(t).strip()][:6], True
        d = dict(node.data or {})
        if edited:
            d["edited"] = True
        if hidden is not None:
            d["hidden"] = bool(hidden)
        if pos != "keep":
            if pos:
                d["pos"] = {"dx": round(max(-4000.0, min(4000.0, float(pos.get("dx") or 0))), 1),
                            "dy": round(max(-4000.0, min(4000.0, float(pos.get("dy") or 0))), 1)}
            else:
                d.pop("pos", None)
        node.data = d
        if parent != "keep":
            if parent is not None:
                if parent.aim_id != node.aim_id or parent.scope != node.scope:
                    raise TreeError("只能挂到同一棵树的节点下")
                if any(x.id == node.id for x in self.path(parent)):
                    raise TreeError("不能挂到它自己的子孙下面")
            node.parent_id = parent.id if parent is not None else None
        node.updated_at = utcnow()
        self.s.flush()
        return node

    def link(self, a: ThoughtNode, b: ThoughtNode) -> ThoughtNode:
        """Link two nodes of one tree that are not parent and child: each is read when continuing from the other."""
        if a.id == b.id:
            raise TreeError("不能链接到自己")
        if a.aim_id != b.aim_id or a.scope != b.scope:
            raise TreeError("只能链接同一棵树里的节点")
        if b.id in self.linked(a):
            return a
        a.data = {**(a.data or {}), "links": [*((a.data or {}).get("links") or []), str(b.id)][-20:]}
        self.s.flush()
        return a

    def unlink(self, a: ThoughtNode, b: ThoughtNode) -> None:
        for x, y in ((a, b), (b, a)):
            links = (x.data or {}).get("links") or []
            if str(y.id) in links:
                x.data = {**(x.data or {}), "links": [i for i in links if i != str(y.id)]}
        self.s.flush()

    def linked(self, node: ThoughtNode) -> list[uuid.UUID]:
        """The nodes linked to this one, either way."""
        out = [uuid.UUID(i) for i in ((node.data or {}).get("links") or [])]
        for n in self.nodes(self.root_of(node)):
            if str(node.id) in ((n.data or {}).get("links") or []) and n.id not in out:
                out.append(n.id)
        return out

    def merge_up(self, node: ThoughtNode) -> ThoughtNode:
        """Fold a node into its parent: its turns join the parent, its children hang from the parent."""
        if node.parent_id is None:
            raise TreeError("直接长在根上的节点没有上一级可以合并")
        parent = self.s.get(ThoughtNode, node.parent_id)
        aim = self.root_of(node)
        for n in self.notes_of(node):
            self._attach(parent, n)
        for c in self.nodes(self.root_of(node)):
            if c.parent_id == node.id:
                c.parent_id = parent.id
        if (node.data or {}).get("dataset") and not (parent.data or {}).get("dataset"):
            parent.data = {**(parent.data or {}), "dataset": node.data["dataset"]}
        self.s.flush()                                        # children re-hung before the node goes (its FK cascades)
        self.s.delete(node)
        self.s.flush()
        self._grow_details(aim, parent)
        self._refresh_growth(aim)
        return parent

    def delete(self, node: ThoughtNode) -> None:
        """Only a branch of yours can go away (its turns stay on the motivation's board); a stretch of the team's
        dialogue can be hidden or merged, never deleted."""
        if node.kind == "segment":
            raise TreeError("这是团队对话的一段：可以隐藏或合并到上一级，不能删除")
        for c in self.nodes(self.root_of(node)):
            if c.parent_id == node.id:
                c.parent_id = node.parent_id
        self.s.flush()
        self.s.delete(node)
        self.s.flush()

    def new_branch(self, node: ThoughtNode, title: str, kind: str = "user", data: dict | None = None) -> ThoughtNode:
        seq = self._max_seq(self.root_of(node)) + 1
        b = ThoughtNode(user_id=node.user_id, aim_id=node.aim_id, scope=node.scope, parent_id=node.id, kind=kind, seq=seq, title=_clip(title, 60),
                        summary="", note_ids=[], data=data or {}, created_at=utcnow())
        self.s.add(b)
        self.s.flush()
        return b

    # -------------------------------------------------------------- a line of thought, distilled

    def subtree(self, node: ThoughtNode) -> list[ThoughtNode]:
        all_ = self.nodes(self.root_of(node))
        kids: dict = {}
        for n in all_:
            kids.setdefault(n.parent_id, []).append(n)
        out, stack = [], [node]
        while stack:
            n = stack.pop()
            out.append(n)
            stack.extend(kids.get(n.id, []))
        return sorted(out, key=lambda n: n.seq)

    def branch_material(self, node: ThoughtNode) -> str:
        """What the distiller reads: the path to this node, then the node and everything that grew from it."""
        aim = self.root_of(node)
        path = "\n".join(f"- {n.title}: {n.summary}" for n in self.path(node)[:-1])
        body = []
        for n in self.subtree(node):
            body.append(f"## {n.title}\n{n.summary}\nKey: {'; '.join(n.key_thoughts or [])}")
            for x in self.notes_of(n):
                if x.kind in ("question", "answer", "insight", "correction"):
                    d = x.data or {}
                    body.append(f"[{x.kind}{(' ' + d['code']) if d.get('code') else ''}] {_clip(x.text_en or x.text, 900)}")
        return (f"Motivation: {aim.text_en or aim.text}\nHow this line of thought was reached:\n{path or '(it starts at the root)'}\n\n"
                + fence("source", "\n".join(body), 30000, kind="the line of thought and everything that grew from it"))

    def distill(self, user: User, node: ThoughtNode, now: datetime | None = None):
        """Write this line of thought (the node and its subtree) into a curated dataset other trees can use."""
        from pga.db.models import Body
        from pga.db.types import Origin
        from pga.knowledge.datasets import Datasets
        b = None
        if (node.data or {}).get("dataset"):
            b = self.s.get(Body, uuid.UUID(str(node.data["dataset"])))
        if b is None:
            b = Body(user_id=node.user_id, aim_id=node.aim_id, kind="database", title=_clip(f"思路 · {node.title}", 120),
                     title_en=_clip(f"Line of thought: {node.title}", 200), description="", description_en="", private=False,
                     origin=Origin.SYSTEM, system="branch", created_at=now or utcnow())
            self.s.add(b)
            self.s.flush()
            node.data = {**(node.data or {}), "dataset": str(b.id)}
            self.s.flush()
        out = Datasets(self.rt).compile(user, b, now)
        return b, out

    def node_of_dataset(self, body_id: uuid.UUID) -> ThoughtNode | None:
        return self.s.scalar(select(ThoughtNode).where(ThoughtNode.data["dataset"].as_string() == str(body_id)).limit(1))

    def markdown(self, node: ThoughtNode) -> str:
        aim = self.root_of(node)
        out = [f"# {node.title}", "", f"> 抱负：{aim.text}", f"> 路径：{' › '.join(n.title for n in self.path(node))}"]
        if node.first_at:
            out.append(f"> 时间：{node.first_at:%Y-%m-%d %H:%M} – {(node.last_at or node.first_at):%Y-%m-%d %H:%M}")
        if node.shift:
            out += ["", f"**注意力为什么转到这里**：{node.shift}"]
        if node.summary:
            out += ["", node.summary]
        if node.key_thoughts:
            out += ["", "## 关键想法", *[f"- {k}" for k in node.key_thoughts]]
        buds = (node.data or {}).get("buds") or []
        if buds:
            out += ["", "## 还没走的灵感", *[f"- {b['idea']}" for b in buds]]
        g = node.git or {}
        if g.get("head"):
            out += ["", "## 代码", f"- 当时的代码：[{g['head']}]({g.get('head_url')})",
                    *[f"- [{c['sha'][:7]}]({c.get('url')}) {c['subject']}" for c in g.get("commits") or []],
                    *[f"- 引用：[{f['path']}]({f.get('url')})" for f in g.get("files") or []]]
        out += ["", "## 对话"]
        for x in self.notes_of(node):
            d = x.data or {}
            who = "你" if x.agent == "you" or x.kind == "correction" else (x.agent or x.role or "agent")
            out += ["", f"**{who} · {x.kind}{(' ' + d['code']) if d.get('code') else ''}** · {x.created_at:%m-%d %H:%M}", "", x.text]
        return "\n".join(out) + "\n"

    # -------------------------------------------------------------- branches talking to each other

    def exchange(self, user: User, node: ThoughtNode, other: ThoughtNode, text: str = "", agent: str = "auto") -> tuple[ThoughtNode, dict]:
        from pga.agents.routing import AgentRouter
        if other.id == node.id:
            raise TreeError("选另一个节点来交流")
        lang, _ = _lang(user)
        aim = self.root_of(node)
        a, b = self.context_for(node, intro=False), self.context_for(other, intro=False)
        context = (EXCHANGE.format(lang=lang) + "\n\n<line_A>\n" + a + "\n</line_A>\n\n<line_B>\n" + b + "\n</line_B>\n\n"
                   + knowledge_context(self.rt, aim))
        ask = text.strip() or f"让「{node.title}」和「{other.title}」交流。"
        reply = AgentRouter(self.rt).ask(user, ask[:4000], agent=agent or "auto", context=context,
                                         category="serious" if (agent or "auto") == "auto" else None,
                                         conversation=f"exchange:{node.id}:{other.id}", project=None)
        x = self.new_branch(node, f"↔ {other.title}", kind="exchange",
                            data={"with": str(other.id), "with_aim": str(other.aim_id) if other.aim_id else "you", "with_title": other.title})
        self.record(x, aim, ask, reply)
        if (reply.get("text") or "").strip():
            x.summary = _clip(reply["text"], 600)
        other.data = {**(other.data or {}), "exchanges": list(dict.fromkeys(((other.data or {}).get("exchanges") or []) + [str(x.id)]))[-12:]}
        self.s.flush()
        return x, reply

    # -------------------------------------------------------------- what the agents did (行为树)

    def runs_of(self, node: ThoughtNode) -> list[AgentRun]:
        """The agent runs behind a node: the team's steps while it was being thought through, or the chats that made it."""
        ids = [uuid.UUID(x[2:]) for x in node.note_ids or [] if str(x).startswith("r:")]
        q = None
        if node.scope == "aim" and node.kind == "segment" and node.first_at:
            q = select(AgentRun).where(AgentRun.parent_id.is_(None), AgentRun.workflow == "perpetual",
                                       AgentRun.data["aim"].as_string() == str(node.aim_id),
                                       AgentRun.started_at >= node.first_at - timedelta(minutes=10),
                                       AgentRun.started_at <= (node.last_at or node.first_at) + timedelta(minutes=1))
        elif node.kind in ("user", "exchange") and node.scope == "aim":
            q = select(AgentRun).where(AgentRun.parent_id.is_(None), AgentRun.user_id == node.user_id,
                                       AgentRun.data["conversation"].as_string().like(f"node:{node.id}%")
                                       | AgentRun.data["conversation"].as_string().like(f"exchange:{node.parent_id}:%")
                                       | (AgentRun.data["node"].as_string() == str(node.id)))
        runs = list(self.s.scalars(q.order_by(AgentRun.started_at).limit(400))) if q is not None else []
        if ids:
            runs += list(self.s.scalars(select(AgentRun).where(AgentRun.id.in_(ids)).order_by(AgentRun.started_at)))
        return sorted({r.id: r for r in runs}.values(), key=lambda r: r.started_at)

    def behavior(self, node: ThoughtNode) -> dict:
        """Who did what: per agent, each run (which step, which question, how it went) and the actions in it."""
        runs = self.runs_of(node)
        steps: dict[uuid.UUID, list[AgentRun]] = {}
        if runs:
            for c in self.s.scalars(select(AgentRun).where(AgentRun.parent_id.in_([r.id for r in runs])).order_by(AgentRun.started_at)):
                steps.setdefault(c.parent_id, []).append(c)
        agents: dict[str, dict] = {}
        totals: dict[str, int] = {}
        for r in runs:
            d = r.data or {}
            actions = []
            for c in steps.get(r.id, []):
                actions += parse_actions((c.data or {}).get("trace") or "")
            for a in actions:
                totals[a["kind"]] = totals.get(a["kind"], 0) + 1
            code = re.search(r'<question code="([^"]+)"', r.prompt or "")
            step = str(d.get("step") or r.step or "run")
            totals[f"step:{step}"] = totals.get(f"step:{step}", 0) + 1
            who = d.get("agent") or r.agent
            ag = agents.setdefault(who, {"agent": who, "runs": [], "ok": 0, "failed": 0, "seconds": 0.0})
            ok = r.status == "SUCCEEDED"
            ag["ok" if ok else "failed"] += 1
            ag["seconds"] = round(ag["seconds"] + float(r.duration_s or 0), 1)
            ag["runs"].append({"id": str(r.id), "step": step, "step_zh": STEP_ZH.get(step, step), "code": code.group(1) if code else None,
                               "status": r.status, "seconds": round(float(r.duration_s or 0), 1), "at": r.started_at.isoformat(),
                               "role": d.get("role"), "error": _clip(r.error or "", 200) if not ok else None,
                               "conversation": d.get("conversation"), "actions": actions[:80], "more": max(0, len(actions) - 80)})
        g = node.git or {}
        cache = cache_totals([c.data for r in runs for c in (steps.get(r.id) or [r])])
        return {"agents": sorted(agents.values(), key=lambda a: -len(a["runs"])), "totals": totals, "runs": len(runs), "cache": cache,
                "proposals": (node.data or {}).get("proposals") or [], "commits": g.get("commits") or [],
                "traced": sum(1 for r in runs if any((c.data or {}).get("trace") for c in steps.get(r.id, [])))}

    def _behavior_counts(self, node: ThoughtNode) -> dict:
        b = self.behavior(node)
        t = b["totals"]
        return {"runs": b["runs"], "agents": len(b["agents"]), **{k: v for k, v in t.items() if not k.startswith("step:")},
                "commits": len(b["commits"]), "steps": {k[5:]: v for k, v in t.items() if k.startswith("step:")}}

    def refresh(self, root) -> int:
        """Recount every node's details (behaviour, git, twigs) without asking any model."""
        n = 0
        for node in self.nodes(root):
            self._grow_details(root, node)
            n += 1
        self._refresh_growth(root)
        self.s.flush()
        return n

    # -------------------------------------------------------------- knowledge: references and moving it

    def set_refs(self, node: ThoughtNode, refs: list[str]) -> ThoughtNode:
        from pga.db.models import Body
        ok = []
        for r in refs:
            try:
                b = self.s.get(Body, uuid.UUID(str(r)))
            except ValueError:
                continue
            if b is not None and b.user_id == node.user_id:
                ok.append(str(b.id))
        node.data = {**(node.data or {}), "refs": list(dict.fromkeys(ok))[:12]}
        self.s.flush()
        return node

    def move_dataset(self, body, *, node: ThoughtNode | None = None, aim: Aim | None = None):
        """Move a dataset: to another node (it becomes that line of thought's knowledge) or to another tree."""
        if node is not None:
            for n in self.s.scalars(select(ThoughtNode).where(ThoughtNode.data["dataset"].as_string() == str(body.id))):
                if n.id != node.id:
                    n.data = {k: v for k, v in (n.data or {}).items() if k != "dataset"}
            node.data = {**(node.data or {}), "dataset": str(body.id)}
            body.aim_id = node.aim_id
        elif aim is not None:
            for n in self.s.scalars(select(ThoughtNode).where(ThoughtNode.data["dataset"].as_string() == str(body.id))):
                if n.aim_id != aim.id:
                    n.data = {k: v for k, v in (n.data or {}).items() if k != "dataset"}
            body.aim_id = aim.id
        self.s.flush()
        return body

    # -------------------------------------------------------------- for the UI

    def out(self, aim: Aim) -> dict:
        t = self.s.scalar(select(PerpetualTask).where(PerpetualTask.aim_id == aim.id))
        p = self.project(aim)
        repo = None
        if p and (Path(p.path) / ".git").exists():
            try:
                repo = github_url(_git(p.path, "remote", "get-url", "origin").strip())
            except (OSError, subprocess.SubprocessError):
                repo = None
        task = None
        if t is not None:
            from pga.perpetual import AUTONOMY_ZH, DEFAULTS, PHASE_ZH
            st = {**DEFAULTS, **(t.settings or {})}
            task = {"id": str(t.id), "status": t.status, "phase": t.phase, "phase_zh": PHASE_ZH.get(t.phase, t.phase),
                    "phase_note": t.phase_note, "pressure": round(t.pressure, 3), "parts": t.parts or {}, "cycles": t.cycles,
                    "autonomy": st.get("autonomy"), "autonomy_zh": AUTONOMY_ZH.get(st.get("autonomy"), ""),
                    "samples": st.get("samples"), "project_id": str(t.project_id) if t.project_id else None,
                    "next_at": t.next_at.isoformat() if t.next_at else None}
        for_you = int(self.s.scalar(select(func.count()).select_from(AimNote).where(
            AimNote.aim_id == aim.id, AimNote.kind == "question", AimNote.status == "for_you")) or 0)
        return {"aim": {"id": str(aim.id), "text": aim.text, "scope": _scope(aim)}, "focus": ((t.settings or {}).get("focus_node") if t else None),
                "pending": self.pending_count(aim), "repo": repo, "task": task, "for_you": for_you,
                "project": {"id": str(p.id), "name": p.name} if p else None,
                "knowledge": knowledge_of(self.rt, aim),
                "nodes": [node_out(n) for n in self.nodes(aim)]}


class TreeDeferred(Exception):
    """The allocator said not now; the planner tries again later."""


NEW_NODE = ("新节点", "New node")


def usage_of(data: dict | None) -> dict | None:
    """One call's tokens, whatever shape the agent reported them in: all input (cached included), the part read from
    the provider's prompt cache, the part written to it, and output. Claude reports input without the cache; Codex with it."""
    u = (data or {}).get("usage")
    if not isinstance(u, dict):
        return None
    if isinstance(u.get("last"), dict):                      # Codex app-server: this turn, and the thread's running total
        u = u["last"]

    def g(*keys) -> int:
        return next((int(u[k]) for k in keys if isinstance(u.get(k), (int, float))), 0)
    cached = g("cache_read_input_tokens", "cachedInputTokens", "cached_input_tokens", "prompt_cache_hit_tokens")
    written = g("cache_creation_input_tokens", "cacheWriteInputTokens")
    inp = g("input_tokens", "inputTokens", "prompt_tokens", "input")
    if "cache_read_input_tokens" in u or "cache_creation_input_tokens" in u:
        inp += cached + written
    if not inp:
        return None
    return {"input": inp, "cached": cached, "written": written, "output": g("output_tokens", "outputTokens", "completion_tokens", "output")}


def cache_totals(rows) -> dict:
    t = {"calls": 0, "input": 0, "cached": 0, "written": 0, "output": 0}
    for d in rows:
        u = usage_of(d)
        if u:
            t["calls"] += 1
            for k in ("input", "cached", "written", "output"):
                t[k] += u[k]
    t["hit"] = round(t["cached"] / t["input"], 3) if t["input"] else None
    return t


def node_out(n: ThoughtNode, full: bool = False) -> dict:
    d = n.data or {}
    out = {"id": str(n.id), "parent": str(n.parent_id) if n.parent_id else None, "kind": n.kind, "seq": n.seq,
           "title": n.title, "summary": n.summary, "shift": n.shift, "key_thoughts": n.key_thoughts or [],
           "first_at": n.first_at.isoformat() if n.first_at else None, "last_at": n.last_at.isoformat() if n.last_at else None,
           "turns": d.get("turns", len(n.note_ids or [])), "questions": d.get("questions", 0), "open": d.get("open", 0),
           "codes": d.get("codes") or [], "sampled": d.get("sampled", 0), "samples": d.get("samples", 0), "spread": d.get("spread"),
           "buds": d.get("buds") or [], "proposals": d.get("proposals") or [], "tip": bool(d.get("tip")), "mode": d.get("mode"),
           "hidden": bool(d.get("hidden")), "edited": bool(d.get("edited")), "dataset": d.get("dataset"), "style": d.get("style"),
           "behavior": d.get("behavior") or {}, "refs": d.get("refs") or [], "scope": n.scope, "shadows": d.get("shadows") or [],
           "with": d.get("with"), "with_aim": d.get("with_aim"), "with_title": d.get("with_title"), "exchanges": d.get("exchanges") or [],
           "pos": d.get("pos"), "links": d.get("links") or [],
           "git": {"commits": len((n.git or {}).get("commits") or []), "files": len((n.git or {}).get("files") or []),
                   "head": (n.git or {}).get("head")}}
    if full:
        out["git"] = n.git or {}
    return out


STEP_ZH = {"think": "思考", "investigate": "研究", "aggregate": "合成", "evolve": "进化", "reflect": "回顾", "checkpoint": "检查点",
           "run": "对话", "answer": "回答", "review": "审阅", "synthesis": "综合", "plan": "计划", "work": "实现"}
_TOOLS = {"Read": "read", "Glob": "read", "LS": "read", "NotebookRead": "read", "Grep": "search", "ToolSearch": "search",
          "Bash": "command", "BashOutput": "command", "Edit": "edit", "Write": "edit", "MultiEdit": "edit", "NotebookEdit": "edit",
          "WebSearch": "web", "WebFetch": "web", "Task": "delegate", "Agent": "delegate"}


def parse_actions(trace: str) -> list[dict]:
    """The tool lines an agent's trace shows (→ Read path, → Grep pattern, $ command …) as actions."""
    out = []
    for line in (trace or "").splitlines():
        line = line.strip()
        m = re.match(r"^(?:→|⚙|›)\s*([A-Za-z_][\w.-]*)\s*(.*)$", line)
        if m:
            tool, target = m.group(1), m.group(2)
        elif line.startswith("$ "):
            tool, target = "Bash", line[2:]
        else:
            continue
        kind = _TOOLS.get(tool, "edit" if tool.lower().startswith(("write", "edit")) else "other")
        target = target.replace(str(Path.home()), "~")
        out.append({"tool": tool, "kind": kind, "target": _clip(target, 160)})
    return out


def refs_context(rt: "Runtime", ids: list[str], user_id: uuid.UUID | None = None, question: str = "") -> str:
    """Datasets pinned to this node or conversation: their summary and the start of the full text; a document you
    uploaded gives the passages that match the question instead (knowledge/uploads.py)."""
    from pga.db.models import Body
    from pga.knowledge import uploads
    parts = []
    for i in ids[:8]:
        try:
            b = rt.session.get(Body, uuid.UUID(str(i)))
        except ValueError:
            continue
        if b is None or (user_id and b.user_id != user_id) or not (b.description_en or b.description):
            continue
        if (b.data or {}).get("source") in ("upload", "web", "note"):
            parts.append(uploads.context(b, question))
            continue
        parts.append(f"<referenced_knowledge title=\"{_clip(b.title_en or b.title, 80)}\">\n{_brief(rt, b)}\n"
                     f"{_clip(b.description_en or b.description, 2500)}\n</referenced_knowledge>")
    return "\n\n".join(parts)


def _brief(rt: "Runtime", b) -> str:
    """The summary (L2) of a dataset if its pyramid is built, else the start of its full text."""
    lv = rt.layers.rows([f"k:{b.id}"]).get(f"k:{b.id}", {})
    if 2 in lv:
        return lv[2].text_en or lv[2].text
    return _clip(b.description_en or b.description, 900)


def knowledge_of(rt: "Runtime", aim: Aim) -> dict:
    """What a tree knows besides its own dialogue: the two models, its own datasets and skills, what it references."""
    from pga.db.models import Body, Bridge
    s = rt.session
    models = {b.system: b for b in s.scalars(select(Body).where(Body.user_id == aim.user_id, Body.system.in_(["user", "world"])))}
    own = list(s.scalars(select(Body).where(Body.aim_id == aim.id).order_by(Body.created_at)))
    ref = f"aim:{aim.id}"
    refs = []
    for br in s.scalars(select(Bridge).where(Bridge.user_id == aim.user_id, Bridge.kind == "references",
                                             (Bridge.a_ref == ref) | (Bridge.b_ref == ref))):
        other = br.b_ref if br.a_ref == ref else br.a_ref
        if other.startswith("k:"):
            try:
                b = s.get(Body, uuid.UUID(other[2:]))
            except ValueError:
                b = None
            if b is not None:
                refs.append(b)

    def row(b) -> dict:
        lv = rt.layers.rows([f"k:{b.id}"]).get(f"k:{b.id}", {})
        return {"id": str(b.id), "title": b.title, "kind": b.kind, "system": b.system, "aim_id": str(b.aim_id) if b.aim_id else None,
                "gist": lv[1].text if 1 in lv else None, "compiled_at": b.compiled_at.isoformat() if b.compiled_at else None}
    return {"user": row(models["user"]) if "user" in models else None, "world": row(models["world"]) if "world" in models else None,
            "datasets": [row(b) for b in own if b.kind == "database"], "skills": [row(b) for b in own if b.kind == "skill"],
            "references": [row(b) for b in refs]}


def knowledge_context(rt: "Runtime", aim: Aim) -> str:
    """For every prompt of this tree: the user model, the world model, and the datasets it was told to refer to."""
    from pga.db.models import Body, Bridge
    s = rt.session
    parts = []
    for b in s.scalars(select(Body).where(Body.user_id == aim.user_id, Body.system.in_(["user", "world"]), Body.compiled_at.is_not(None))):
        tag = "user_model" if b.system == "user" else "world_model"
        what = "who the user is (stated and inferred)" if b.system == "user" else "what is happening in the world right now"
        parts.append(f"<{tag} what=\"{what}\">\n{_brief(rt, b)}\n</{tag}>")
    ref = f"aim:{aim.id}"
    for br in s.scalars(select(Bridge).where(Bridge.user_id == aim.user_id, Bridge.kind == "references",
                                             (Bridge.a_ref == ref) | (Bridge.b_ref == ref)).limit(6)):
        other = br.b_ref if br.a_ref == ref else br.a_ref
        if other.startswith("k:"):
            b = s.get(Body, uuid.UUID(other[2:]))
            if b is not None and (b.description_en or b.description):
                parts.append(f"<referenced_knowledge title=\"{_clip(b.title_en or b.title, 80)}\">\n{_brief(rt, b)}\n</referenced_knowledge>")
    return "\n\n".join(parts)


def _git(path: str, *args: str) -> str:
    r = subprocess.run(["git", "-C", path, *args], capture_output=True, text=True, timeout=10)
    if r.returncode != 0:
        raise ValueError(r.stderr.strip()[:200])
    return r.stdout


def github_url(remote: str) -> str | None:
    """git@github.com:owner/repo.git · https://github.com/owner/repo · ssh://git@ssh.github.com:443/owner/repo.git → https URL."""
    m = re.search(r"github\.com[:/](?:\d+/)?([\w.-]+)/([\w.-]+?)(?:\.git)?/?$", remote.strip())
    return f"https://github.com/{m.group(1)}/{m.group(2)}" if m else None
