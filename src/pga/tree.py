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
from datetime import datetime, timedelta
from pathlib import Path
from typing import TYPE_CHECKING

from sqlalchemy import func, select

from pga.agent.common import UNTRUSTED_NOTE, ModelOutputError, fence, parse_json
from pga.allocator import Estimates, Justification, RunRequest
from pga.db.models import Aim, AimNote, PerpetualTask, Project, ThoughtNode, User
from pga.db.types import utcnow

if TYPE_CHECKING:
    from pga.runtime import Runtime

log = logging.getLogger("pga.tree")

WINDOW = 90                         # turns the curator reads at a time
GAP = timedelta(hours=2)            # the rule cut (when no model can curate): a pause this long starts a node
TURNS = ("question", "answer", "insight", "reflect", "correction", "checkpoint", "evolve", "summary", "plan")
MAX_BUDS = 6

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
- title: at most 14 words naming the line of thought. summary: 2-4 sentences — what was asked, found and decided.
  key_thoughts: up to 4 short items, the pivotal findings or decisions. shift: one sentence, why attention turned here.
Write title, summary, key_thoughts and shift in {lang}.
{untrusted}
Reply with JSON only: {{"extend_latest_until": <index of the last turn that still belongs to the latest node, or -1>,
"nodes": [{{"from": <first turn index>, "to": <last turn index>, "parent": "root" | "<existing node id>" | "new:<k>",
"title": "...", "summary": "...", "key_thoughts": ["..."], "shift": "..."}}]}}
"new:<k>" is the k-th new node of this reply (0-based). Turns not covered are attached to the node before them."""


class TreeError(RuntimeError):
    pass


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

    def nodes(self, aim_id: uuid.UUID) -> list[ThoughtNode]:
        return list(self.s.scalars(select(ThoughtNode).where(ThoughtNode.aim_id == aim_id).order_by(ThoughtNode.seq)))

    def latest(self, aim_id: uuid.UUID) -> ThoughtNode | None:
        return self.s.scalar(select(ThoughtNode).where(ThoughtNode.aim_id == aim_id, ThoughtNode.kind == "segment")
                             .order_by(ThoughtNode.seq.desc()).limit(1))

    def placed_until(self, aim_id: uuid.UUID) -> datetime | None:
        return self.s.scalar(select(func.max(ThoughtNode.last_at)).where(ThoughtNode.aim_id == aim_id, ThoughtNode.kind == "segment"))

    def pending(self, aim: Aim, limit: int = WINDOW) -> list[AimNote]:
        """Turns of the self-dialogue not in the tree yet (oldest first). Your own branches are placed when you make them."""
        since = self.placed_until(aim.id)
        q = select(AimNote).where(AimNote.aim_id == aim.id, AimNote.kind.in_(TURNS))
        if since is not None:
            q = q.where(AimNote.created_at > since)
        return [n for n in self.s.scalars(q.order_by(AimNote.created_at).limit(limit * 2)) if not (n.data or {}).get("node")][:limit]

    def pending_count(self, aim: Aim) -> int:
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

    def notes_of(self, node: ThoughtNode) -> list[AimNote]:
        ids = [uuid.UUID(str(x)) for x in (node.note_ids or [])]
        if not ids:
            return []
        return list(self.s.scalars(select(AimNote).where(AimNote.id.in_(ids)).order_by(AimNote.created_at)))

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
        rows = [n for n in self.nodes(aim.id) if n.kind != "bud"][-40:]
        if not rows:
            return "(the tree is empty: only the root)"
        return "\n".join(f"node {_short(n.id)} (parent {_short(n.parent_id) if n.parent_id else 'root'}): {_clip(n.title, 90)}"
                         for n in rows)

    def _focus_hint(self, aim: Aim) -> str:
        t = self.s.scalar(select(PerpetualTask).where(PerpetualTask.aim_id == aim.id))
        fid = ((t.settings or {}).get("focus_node") if t else None)
        if not fid:
            return ""
        return (f"\nSince {(t.settings or {}).get('focus_since', '')[:16]} the user asked the team to continue along node "
                f"{_short(fid)}: new lines of thought from then on most likely grow from it.")

    def _curate_window(self, user: User, aim: Aim, turns: list[AimNote], now: datetime) -> tuple[int, int] | None:
        lang = "Simplified Chinese" if (user.locale or "zh").lower().startswith("zh") else "English"
        system = CURATE.format(lang=lang, untrusted=UNTRUSTED_NOTE)
        latest = self.latest(aim.id)
        body = "\n".join(self._turn_line(i, n) for i, n in enumerate(turns))
        prompt = (f"Motivation: {aim.text_en or aim.text}\n\nThe tree so far:\n{self._outline(aim)}\n"
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
        except Exception as exc:  # noqa: BLE001 - fall back to the rule cut; the next window tries the model again
            log.warning("tree curate failed: %s", exc)
            return None
        if not isinstance(d, dict):
            return None
        return self._apply(aim, turns, d)

    def _apply(self, aim: Aim, turns: list[AimNote], d: dict) -> tuple[int, int] | None:
        n = len(turns)
        latest = self.latest(aim.id)
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
        seq = int(self.s.scalar(select(func.max(ThoughtNode.seq)).where(ThoughtNode.aim_id == aim.id)) or 0)
        by_short = {_short(x.id): x for x in self.nodes(aim.id)}
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
            node = ThoughtNode(user_id=aim.user_id, aim_id=aim.id, parent_id=parent.id if parent else None, kind="segment", seq=seq,
                               title=_clip(x.get("title"), 120), summary=str(x.get("summary") or "")[:1500],
                               shift=str(x.get("shift") or "")[:400],
                               key_thoughts=[_clip(t, 200) for t in (x.get("key_thoughts") or []) if str(t).strip()][:4],
                               note_ids=[], data={"mode": "model"}, created_at=utcnow())
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
        latest = self.latest(aim.id)
        seq = int(self.s.scalar(select(func.max(ThoughtNode.seq)).where(ThoughtNode.aim_id == aim.id)) or 0)
        touched: dict[uuid.UUID, ThoughtNode] = {}
        made = extended = 0
        cur, prev_at = latest, (latest.last_at if latest else None)
        for n in turns:
            if cur is None or (prev_at and n.created_at - prev_at > GAP) or len(cur.note_ids or []) >= 60:
                seq += 1
                title = n.text if n.kind == "question" else f"{n.created_at.strftime('%m-%d %H:%M')} 起的思考"
                cur = ThoughtNode(user_id=aim.user_id, aim_id=aim.id, parent_id=cur.id if cur else None, kind="segment", seq=seq,
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

    def _attach(self, node: ThoughtNode, n: AimNote) -> None:
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
                     "proposals": sorted({p for p in ((n.data or {}).get("proposal") for n in notes) if p})[:8]}
        if not node.title.strip():
            q = next((n for n in notes if n.kind == "question"), None)
            node.title = _clip(q.text if q else "思考", 60)
        node.git = self._git(aim, node, notes)

    def _refresh_growth(self, aim: Aim) -> None:
        """The newest node is the growing tip."""
        latest = self.latest(aim.id)
        for n in self.nodes(aim.id):
            tip = latest is not None and n.id == latest.id
            if bool((n.data or {}).get("tip")) != tip:
                n.data = {**(n.data or {}), "tip": tip}

    # -------------------------------------------------------------- the code meanwhile

    def project(self, aim: Aim) -> Project | None:
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

    def context_for(self, node: ThoughtNode) -> str:
        aim = self.s.get(Aim, node.aim_id)
        lines = [f"You are continuing one branch of the thought tree of the user's motivation: {aim.text_en or aim.text}",
                 "The branch, from the root to the chosen node:"]
        for i, n in enumerate(self.path(node)):
            lines.append(f"{'  ' * i}- {n.title}" + (f": {n.summary}" if n.summary else "")
                         + (f" (key: {'; '.join(n.key_thoughts)})" if n.key_thoughts else ""))
        recent = [n for n in self.notes_of(node) if n.kind in ("answer", "insight", "question")][-6:]
        if recent:
            lines.append("The latest turns on this node:")
            lines += [f"- {n.kind}: {_clip(n.text, 500)}" for n in recent]
        if (node.git or {}).get("head"):
            lines.append(f"The code at that point: commit {node.git['head']}" +
                         (f"; files it relied on: {', '.join(f['path'] for f in node.git.get('files') or [])}" if node.git.get("files") else ""))
        lines.append("Continue this line of thought with the user. Answer in the user's language.")
        return "\n".join(lines)

    def branch_for(self, node: ThoughtNode, text: str, bud: str | None = None) -> ThoughtNode:
        """Where your turn goes: a branch of yours continues in place; anywhere else a new branch grows."""
        if node.kind == "user" and not bud:
            return node
        seq = int(self.s.scalar(select(func.max(ThoughtNode.seq)).where(ThoughtNode.aim_id == node.aim_id)) or 0) + 1
        title = _clip(bud or text, 40)
        b = ThoughtNode(user_id=node.user_id, aim_id=node.aim_id, parent_id=node.id, kind="user", seq=seq, title=title,
                        summary="", note_ids=[], data={"from_bud": bud} if bud else {}, created_at=utcnow())
        self.s.add(b)
        self.s.flush()
        return b

    def record(self, branch: ThoughtNode, aim: Aim, question: str, reply: dict) -> list[AimNote]:
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

    def focus(self, aim: Aim, node: ThoughtNode | None) -> dict:
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
        return {"aim": {"id": str(aim.id), "text": aim.text}, "focus": ((t.settings or {}).get("focus_node") if t else None),
                "pending": self.pending_count(aim), "repo": repo,
                "nodes": [node_out(n) for n in self.nodes(aim.id)]}


class TreeDeferred(Exception):
    """The allocator said not now; the planner tries again later."""


def node_out(n: ThoughtNode, full: bool = False) -> dict:
    d = n.data or {}
    out = {"id": str(n.id), "parent": str(n.parent_id) if n.parent_id else None, "kind": n.kind, "seq": n.seq,
           "title": n.title, "summary": n.summary, "shift": n.shift, "key_thoughts": n.key_thoughts or [],
           "first_at": n.first_at.isoformat() if n.first_at else None, "last_at": n.last_at.isoformat() if n.last_at else None,
           "turns": d.get("turns", len(n.note_ids or [])), "questions": d.get("questions", 0), "open": d.get("open", 0),
           "codes": d.get("codes") or [], "sampled": d.get("sampled", 0), "samples": d.get("samples", 0), "spread": d.get("spread"),
           "buds": d.get("buds") or [], "proposals": d.get("proposals") or [], "tip": bool(d.get("tip")), "mode": d.get("mode"),
           "git": {"commits": len((n.git or {}).get("commits") or []), "files": len((n.git or {}).get("files") or []),
                   "head": (n.git or {}).get("head")}}
    if full:
        out["git"] = n.git or {}
    return out


def _git(path: str, *args: str) -> str:
    r = subprocess.run(["git", "-C", path, *args], capture_output=True, text=True, timeout=10)
    if r.returncode != 0:
        raise ValueError(r.stderr.strip()[:200])
    return r.stdout


def github_url(remote: str) -> str | None:
    """git@github.com:owner/repo.git · https://github.com/owner/repo · ssh://git@ssh.github.com:443/owner/repo.git → https URL."""
    m = re.search(r"github\.com[:/](?:\d+/)?([\w.-]+)/([\w.-]+?)(?:\.git)?/?$", remote.strip())
    return f"https://github.com/{m.group(1)}/{m.group(2)}" if m else None
