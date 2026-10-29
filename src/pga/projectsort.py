"""项目: every conversation filed under one of a few real projects, decided when it is imported.

The folder an agent ran in is a poor name for what the work was: Claude Code and Codex leave sessions in "New project",
"Desktop", a timestamped scratch folder, "g" or "y". So each conversation gets a project of its own here, from a short
list you keep (PGA, 简历投递, 论文思考 to start with): a folder that already names one of them goes there at once; the
rest are read by the model — title, folder and the opening words — and put under one of the list, under a new broad
project only when it is clearly a sustained piece of work of its own, or under 日常对话. What it decided is kept
(preferences.projects.of) and shown in place of the raw folder; nothing is moved on disk.

It runs in the import pipeline (after the local agents are synced) for the conversations not filed yet, and on ✦ 整理.
"""
from __future__ import annotations

import logging
import re
from datetime import datetime, timedelta
from typing import TYPE_CHECKING

from pga.agent.common import UNTRUSTED_NOTE, fence, parse_json
from pga.db.models import User
from pga.db.types import utcnow

if TYPE_CHECKING:
    from pga.runtime import Runtime

log = logging.getLogger(__name__)

DEFAULT = ["PGA", "简历投递", "论文思考"]
ABOUT = {"PGA": "the AI agent app being built here (PGA): its interface, canvas and chat pages, the agents and sub-agents it runs "
                "(Claude Code, Codex, Hermes, ChatGPT), importing conversations, translation, the world tree",
         "简历投递": "job hunting: CVs, cover letters, applications, interviews",
         "论文思考": "their research papers: drafts and LaTeX, related work, method, experiments, figures and tables, academic translation"}
EVERYDAY = "日常对话"
MAX_NEW = 4                       # broad projects the model may add beyond your list, in all
BATCH = 60
ALIASES = {"论文思考": ["paper", "论文", "densehap", "latex", "thesis"], "简历投递": ["简历", "求职", "resume", "cv", "job"],
           "PGA": ["pga"]}
MEANINGLESS = re.compile(r"^(new project|desktop|downloads|documents|home|tmp|temp|untitled|new-chat.*|scratch-.*|pga-agent-.*|"
                         r"\d{4}-\d{2}-\d{2}.*|[a-z0-9]{1,3}|~|x)$", re.I)

SYSTEM = """You file a person's AI conversations under their projects. Their projects:
{projects}
For each conversation (title, the folder the agent ran in, the opening words) pick where it belongs:
- one of their projects, when it is clearly part of that work;
- a new broad project name (2-6 words, in the conversation's language) only when several conversations here are clearly one
  sustained piece of work that none of their projects covers — reuse the same new name for all of them; at most {room} new;
- "{everyday}" for one-off questions and everything else.
The folder name is only a hint: "New project", "Desktop", a date or a single letter mean nothing.
Reply with JSON only: {{"i0": "project name", "i1": "..."}}"""


def state(user: User) -> dict:
    st = dict((user.preferences or {}).get("projects") or {})
    st.setdefault("mine", list(DEFAULT))          # yours; "list" adds the few the model opened
    st.setdefault("list", list(st["mine"]))
    st.setdefault("of", {})
    st.setdefault("about", dict(ABOUT))
    return st


def save(user: User, st: dict) -> None:
    user.preferences = {**(user.preferences or {}), "projects": st}


def by_rule(folder: str, projects: list[str]) -> str | None:
    """A folder that names one of your projects goes there; a meaningless one says nothing."""
    f = (folder or "").strip()
    low = f.lower()
    exact = [p for p in projects if p.lower() == low]
    if exact or not f or MEANINGLESS.match(f):          # "PGA" is a project, though a short name usually means nothing
        return exact[0] if exact else None
    for p in projects:
        if p.lower() == low or p.lower() in low or any(a in low for a in ALIASES.get(p, [])):
            return p
    return None


def project_of(st: dict, key: str, folder: str) -> str:
    """What a conversation is shown under: what was decided for it, else what its folder says, else 日常对话."""
    return st["of"].get(key) or by_rule(folder, st["list"]) or EVERYDAY


def _projects(st: dict, items: list) -> str:
    """Each project with what it is about and a few conversations already under it."""
    titles = {it.key: it.title for it in items}
    out = []
    for p in st["list"]:
        seen = [titles[k][:60] for k, v in st["of"].items() if v == p and k in titles][:4]
        out.append(f"- {p}" + (f": {st['about'][p]}" if st["about"].get(p) else "") + (f" (already here: {' / '.join(seen)})" if seen else ""))
    return "\n".join(out)


def sort(rt: "Runtime", user: User, items: list | None = None, limit: int = 240, now: datetime | None = None, ask=None,
         again: bool = False) -> dict:
    """File the conversations not filed yet (again: all of them, from your own list). `items`: pga.timeline Items (all of
    the last year by default)."""
    now = now or utcnow()
    if items is None:
        from pga.timeline import Timeline
        items = Timeline(rt).items(user, now - timedelta(days=365))
    st = state(user)
    if again:
        st["of"], st["list"] = {}, list(st["mine"])
    todo, ruled = [], 0
    for it in items:
        if it.key in st["of"]:
            continue
        p = by_rule(it.project, st["list"])
        if p:
            st["of"][it.key] = p
            ruled += 1
        else:
            todo.append(it)
    waiting = len(todo)
    todo = sorted(todo, key=lambda it: max(it.times) if it.times else now, reverse=True)[:limit]
    asked = 0
    for b in range(0, len(todo), BATCH):
        part = todo[b:b + BATCH]
        new = [p for p in st["list"] if p not in st["mine"]]
        rows = "\n".join(f"i{i} | {it.title[:90]} | {it.project or '-'} | {re.sub(r'\s+', ' ', it.excerpt or '')[:160]}" for i, it in enumerate(part))
        system = SYSTEM.format(projects=_projects(st, items), room=max(0, MAX_NEW - len(new)), everyday=EVERYDAY) + " " + UNTRUSTED_NOTE
        try:
            d = (ask or _ask)(rt, user, system, fence("conversations", "item | title | folder | opening words\n" + rows, 30000,
                                                       kind="the person's conversations"), now)
        except Exception as exc:  # noqa: BLE001 - the rest waits for the next pass
            log.info("projects: not sorted now (%s)", exc)
            break
        for i, it in enumerate(part):
            p = str(d.get(f"i{i}") or "").strip()[:40]
            if not p:
                continue
            if p != EVERYDAY and p not in st["list"]:
                if len([x for x in st["list"] if x not in st["mine"]]) >= MAX_NEW:
                    p = EVERYDAY
                else:
                    st["list"].append(p)
            st["of"][it.key] = p
            asked += 1
    st["at"] = now.isoformat()
    save(user, st)
    return {"ruled": ruled, "sorted": asked, "left": max(0, waiting - asked), "projects": st["list"]}


def _ask(rt: "Runtime", user: User, system: str, prompt: str, now: datetime) -> dict:
    from pga.allocator import Estimates, Justification, RunRequest
    decision = rt.allocator.allocate(RunRequest(
        user_id=user.id, kind="classification",
        justification=Justification(why_now="filing imported conversations under projects", expected_gain="conversations found by project",
                                    decision_affected="which project a conversation is shown under", budget={"max_units": 40_000, "max_output_tokens": 2500},
                                    stop_condition="filed"),
        estimates=Estimates(information_gain=.2, decision_impact=.3, user_relevance=.8, reuse_value=.8, input_tokens=len(prompt) // 3, output_tokens=800)), now=now)
    if not decision.allowed:
        raise ValueError("; ".join(decision.reasons))
    with rt.runs.track(decision, now) as guard:
        res = rt.router.complete(decision.tier, system=system, messages=[{"role": "user", "content": prompt}], max_tokens=2500,
                                 usage=guard.usage_context(), delegate=False)
        guard.stop("filed")
    return parse_json(res.text or "{}")
