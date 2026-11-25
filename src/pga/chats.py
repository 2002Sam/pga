"""Everyday chats, beyond one question and one answer.

- A second opinion: the same question, with the same conversation before it, put to another agent; then one model
  reads both answers and writes what they agree on, where they differ, and a combined answer. Kept on the turn it
  was asked about (the run's data["second"]); the other agent's run is filed under "second:<run>" so it does not show
  up as a chat of its own.
- A branch: a new chat that starts from one reply of another chat. It carries that chat's turns up to the reply as
  its history (shown greyed above it), and goes on the same line of the time tree.
"""
from __future__ import annotations

import logging
import uuid
from datetime import datetime
from typing import TYPE_CHECKING

from sqlalchemy import or_, select

from pga.agent.common import UNTRUSTED_NOTE, ModelOutputError, fence, parse_json
from pga.allocator import Estimates, Justification, RunRequest
from pga.db.models import AgentRun, User
from pga.db.types import utcnow

if TYPE_CHECKING:
    from pga.runtime import Runtime

log = logging.getLogger(__name__)

HIDDEN = ("node:", "exchange:", "second:", "multi:", "chat:mt-")       # conversations that are not chats of their own

COMPARE = """Two AI agents answered the same question from a person, with the same conversation before it. Compare them
for the person: what both say, where they really differ (facts, recommendations, assumptions — not wording), and one
combined answer that keeps what is well supported from each and says what stays open. Write in {lang}.
Reply with JSON only: {{"agree": ["…"], "differ": [{{"point": "…", "a": "what {a} says", "b": "what {b} says"}}],
"answer": "the combined answer, at most 250 words"}}. {untrusted}"""


class ChatError(ValueError):
    pass


def runs_of(rt: "Runtime", user_id: uuid.UUID, key: str, *, aggregate=False) -> list[AgentRun]:
    q = select(AgentRun).where(AgentRun.user_id == user_id, AgentRun.parent_id.is_(None), AgentRun.workflow == "ask")
    from pga.qa_pool import feed_filter, thread_filter
    same = feed_filter(key) if aggregate else thread_filter(key)
    if key.startswith("run:"):
        try:
            same = or_(AgentRun.id == uuid.UUID(key[4:]), same)
        except ValueError as exc:
            raise ChatError("no such chat") from exc
    return list(rt.session.scalars(q.where(same).order_by(AgentRun.started_at, AgentRun.id)))


def fold(runs: list[AgentRun]) -> tuple[list[AgentRun], dict[str, list[AgentRun]]]:
    """The turns of a chat, with each answer's other versions (regenerated) put under the turn they redo."""
    alts: dict[str, list[AgentRun]] = {}
    turns = []
    for r in runs:
        root = (r.data or {}).get("regen_of")
        if root:
            alts.setdefault(str(root), []).append(r)
        else:
            turns.append(r)
    return turns, alts


def current(r: AgentRun, alts: dict[str, list[AgentRun]]) -> AgentRun:
    """Which version of an answer counts (the one you picked; else the latest)."""
    xs = [r, *alts.get(str(r.id), [])]
    pick = (r.data or {}).get("pick")
    return next((x for x in xs if str(x.id) == pick), xs[-1])


def branch_of(user: User, key: str) -> dict | None:
    return ((user.preferences or {}).get("chat_branches") or {}).get(key)


IMPORTED = "imp:"                                    # a branch of a conversation imported from another app: from "imp:<its id>", upto = how many turns


def imported_turns(rt: "Runtime", user: User, cid: str) -> tuple[list[dict], str]:
    """An imported conversation's turns (yours and its answers, the thinking aloud left out) and its title: read in full
    from the app's own store when it is on this machine, else from the excerpt PGA keeps."""
    import re as _re
    from pga.db.models import AgentConversation, LinkedAgent
    from pga.hub.connectors import full_turns
    try:
        c = rt.session.get(AgentConversation, uuid.UUID(cid))
    except ValueError:
        return [], ""
    a = rt.session.get(LinkedAgent, c.linked_agent_id) if c else None
    if c is None or a is None or a.user_id != user.id:
        return [], ""
    turns = [{"role": "user" if t["role"] == "user" else "assistant", "text": t["text"], "agent": a.name,
              **({"image_source": {"import": cid, "refs": t["images"]}} if t.get("images") and t["role"] == "user" else {})}
             for t in full_turns(a.connector, c.external_id) if t.get("role") != "aside" and (t.get("text") or "").strip()]
    if not turns:                                                     # only the excerpt: "User: …" / "Assistant: …" lines
        for line in str(c.excerpt or "").split("\n"):
            m = _re.match(r"^(User|Assistant)\s*:\s?(.*)$", line)
            if m:
                turns.append({"role": "user" if m[1] == "User" else "assistant", "text": m[2], "agent": a.name})
            elif turns:
                turns[-1]["text"] += "\n" + line
    return turns, _re.sub(r"^\[[^\]]*\]\s*", "", c.title or "")


def branch_context(rt: "Runtime", user: User, b: dict, depth: int = 0) -> list[dict]:
    """What a branch grew from: the turns of its parent up to the branch point (and of the parent's parent, and so on)."""
    if "snapshot" in b:
        import copy
        return copy.deepcopy(b["snapshot"])
    src, upto = str(b.get("from") or ""), str(b.get("upto") or "")
    if depth >= 32:
        return []
    if upto.startswith("context:"):
        # The index is in this parent's frozen inherited history, never live ancestor data.
        parent = branch_of(user, src)
        inherited = branch_context(rt, user, parent, depth + 1) if parent else []
        count = upto[len("context:"):]
        if not count.isdigit() or not 0 < int(count) <= len(inherited):
            raise ChatError("invalid continuation point")
        return inherited[:int(count)]
    if src.startswith(IMPORTED):
        turns, _ = imported_turns(rt, user, src[len(IMPORTED):])
        if not upto.isdigit() or int(upto) > len(turns):
            raise ChatError("invalid continuation point")
        return turns[:int(upto)]
    if upto == "0":
        parent = branch_of(user, src)
        return branch_context(rt, user, parent, depth + 1) if parent else []
    try:
        return history(rt, user, src, uuid.UUID(upto), depth + 1)
    except ValueError as exc:
        raise ChatError("invalid continuation point") from exc


def branch_title(rt: "Runtime", user: User, b: dict) -> str:
    src = str(b.get("from") or "")
    if src.startswith(IMPORTED):
        return imported_turns(rt, user, src[len(IMPORTED):])[1]
    return ((user.preferences or {}).get("chat_titles") or {}).get(src) or next(
        (" ".join(t["text"].split())[:60] for t in history(rt, user, src) if t["role"] == "user" and t["text"].strip()), "")


def question_fork(rt: "Runtime", user: User, parent: str, point: str):
    """Resolve the clicked question and the history strictly before it, including inherited turns."""
    if parent.startswith(IMPORTED):
        turns, _ = imported_turns(rt, user, parent[len(IMPORTED):])
        index = point
    elif point.startswith("context:"):
        turns = branch_context(rt, user, branch_of(user, parent) or {"snapshot": []})
        index = point.removeprefix("context:")
    else:
        turns = history(rt, user, parent, uuid.UUID(point))
        index = str(next((i for i, t in enumerate(turns, 1)
                          if t.get("run") == point and t["role"] == "user"), 0))
    if not index.isascii() or not index.isdigit() or not 1 <= int(index) <= len(turns):
        raise ChatError("invalid question")
    pos = int(index) - 1
    turn = turns[pos]
    if turn["role"] != "user":
        raise ChatError("select a question")
    source = rt.session.get(AgentRun, uuid.UUID(turn["run"])) if turn.get("run") else None
    if source and (source.user_id != user.id or (source.data or {}).get("note")):
        raise ChatError("select a question")
    if parent.startswith(IMPORTED):
        upto = str(pos)
    elif point.startswith("context:"):
        upto = f"context:{pos}" if pos else "0"
    else:
        upto = turns[pos - 1].get("run") if pos else None
        upto = upto or "0"
    text = turn["text"]
    if source and (text == source.prompt or text.startswith((source.prompt or "") + "\n\n[运行中补充]\n")):
        text = source.prompt
    else:
        source = None  # the frozen text takes precedence if the original record has changed
    return turns[:pos], upto, text, source, turn.get("image_source")


def branch_reply_title(rt: "Runtime", user: User, parent: str, upto: str) -> str:
    """Name a fork from the selected reply, not the parent's first question."""
    import re
    turns = branch_context(rt, user, {"from": parent, "upto": upto})
    answer = next((t.get("text", "") for t in reversed(turns)
                   if t.get("role") == "assistant" and t.get("text", "").strip()), "")
    text = re.sub(r"!?\[([^\]]+)\]\([^)]*\)", r"\1", answer)
    text = re.sub(r"(?m)^\s*(?:#{1,6}\s+|>\s*|[-*+]\s+|```[^\n]*)", "", text)
    text = " ".join(re.sub(r"[*`~]", "", text).split())
    return (text[:60] + ("…" if len(text) > 60 else "")) if text else branch_title(rt, user, {"from": parent}) or "新分支"


def prompt_with_steering(run: AgentRun) -> str:
    """Keep accepted supplements visible and in catch-up context, beyond the prompt's storage cap."""
    return (run.prompt or "") + "".join("\n\n[运行中补充]\n" + x["text"]
                                      for x in (run.data or {}).get("steering", []))


def history(rt: "Runtime", user: User, key: str, upto: uuid.UUID | None = None, depth: int = 0) -> list[dict]:
    """The turns of a chat (and of the chat it branched from, up to the branch point), oldest first."""
    from pga.tree import _answer
    out: list[dict] = []
    b = branch_of(user, key)
    if b and depth < 32:                                               # a branch of a branch of …: deep trees too (the bound only stops a loop)
        out += branch_context(rt, user, b, depth)
    if upto is not None:
        inherited = [i for i, t in enumerate(out) if t.get("run") == str(upto)]
        if inherited:
            return out[:inherited[-1] + 1]
    turns, alts = fold(runs_of(rt, user.id, key))
    if upto is not None and not any(r.id == upto for r in turns):
        raise ChatError("continuation point does not belong to this conversation")
    for r in turns:
        out.append({"role": "user", "text": (("[the user's own note] " if (r.data or {}).get("note") else "") + prompt_with_steering(r)), "run": str(r.id)})
        if not (r.data or {}).get("note"):
            a = current(r, alts)
            out.append({"role": "assistant", "text": _answer(a.output) or "", "agent": (a.data or {}).get("agent") or a.agent, "effort": (a.data or {}).get("effort"), "run": str(r.id)})
        if upto is not None and r.id == upto:
            break
    return out


def set_branch(user: User, key: str, parent: str, upto: str, copy: bool = False) -> dict:
    branches = dict((user.preferences or {}).get("chat_branches") or {})
    branches[key[:120]] = {"from": parent[:120], "upto": upto, **({"copy": True} if copy else {})}
    user.preferences = {**(user.preferences or {}), "chat_branches": dict(list(branches.items())[-1000:])}
    return branches[key[:120]]


def name_branch_question(rt: "Runtime", user: User, key: str, text: str) -> bool:
    b = branch_of(user, key)
    named = (((user.preferences or {}).get("chat_title_state") or {}).get(key) or {}).get("mode") == "manual"
    if not b or b.get("split_lane") or b.get("manual_title") or named or runs_of(rt, user.id, key):
        return False
    title = " ".join(text.split())[:60]
    if not title:
        return False
    set_title(user, key, title)
    return True


def copy_chat(rt: "Runtime", user: User, key: str, parent: str, upto: str) -> dict:
    """A copy of a whole chat: a branch after its last answer, under the same name (· 副本), with its instructions and
    its answerers. The original goes on as it was."""
    b = set_branch(user, key, parent, upto, copy=True)
    title = branch_title(rt, user, {"from": parent})
    set_title(user, key, f"{title} · 副本" if title else "副本")
    for name in ("chat_system", "chat_multi", "chat_ctx", "chat_options"):  # conversation settings come along
        d = dict((user.preferences or {}).get(name) or {})
        if parent in d:
            d[key[:120]] = d[parent]
            user.preferences = {**(user.preferences or {}), name: dict(list(d.items())[-1000:])}
    return b


MULTI_MAX = 4


def set_multi(user: User, key: str, agents: list[str]) -> list[str]:
    """Who answers every message of one chat at once: several agents, or one agent more than once. Fewer than two:
    back to one answer at a time."""
    names = [str(a)[:40] for a in agents if isinstance(a, str) and a.strip()][:MULTI_MAX]
    d = dict((user.preferences or {}).get("chat_multi") or {})
    if len(names) >= 2:
        d[key[:120]] = names
    else:
        d.pop(key[:120], None)
        names = []
    user.preferences = {**(user.preferences or {}), "chat_multi": dict(list(d.items())[-1000:])}
    return names


def second_opinion(rt: "Runtime", user: User, run_id: uuid.UUID, agent: str | None = None, now: datetime | None = None) -> dict:
    from pga.agents.routing import AgentRouter, classify
    from pga.tree import _answer, _lang
    now = now or utcnow()
    run = rt.session.get(AgentRun, run_id)
    if run is None or run.user_id != user.id or run.workflow != "ask":
        raise ChatError("no such reply")
    d = run.data or {}
    first = str(d.get("agent") or run.agent)
    key = str(d.get("conversation") or f"run:{run.id}")
    turns = history(rt, user, key, run.id)[:-2]                   # what came before this question
    router = AgentRouter(rt)
    agent = other_agent(rt, run, agent)
    reply = router.ask(user, run.prompt or "", agent=agent, history=[{"role": t["role"], "text": t["text"]} for t in turns][-12:],
                       conversation=f"second:{run.id}")
    if not reply.get("text"):
        raise ChatError(reply.get("error") or f"{agent} did not answer")
    out = {"agent": reply.get("agent") or agent, "text": reply["text"], "model": reply.get("model"), "effort": reply.get("effort"), "at": now.isoformat()}
    try:
        out.update(_compare(rt, user, run.prompt or "", first, _answer(run.output), out["agent"], reply["text"], _lang(user)[0], now))
    except Exception as exc:  # noqa: BLE001 - the two answers are worth showing even without the comparison
        log.info("second opinion compare failed: %s", exc)
        out["compare_error"] = str(exc)[:200]
    run.data = {**d, "second": out}
    return out


def inherit_settings(user: User, key: str, parent: str) -> None:
    import copy
    from pga.agents.access import effective_access
    source_access = effective_access(user, parent)
    for name in ("chat_system", "chat_multi", "chat_ctx", "chat_options"):
        values = dict((user.preferences or {}).get(name) or {})
        if parent in values:
            values[key] = copy.deepcopy(values[parent])
            user.preferences = {**(user.preferences or {}), name: values}
    access = copy.deepcopy((user.preferences or {}).get("agent_access") or {})
    access["keys"] = {**(access.get("keys") or {}), key: source_access}
    user.preferences = {**(user.preferences or {}), "agent_access": access}


def inherit(rt: "Runtime", user: User, key: str, parent: str, now: datetime | None = None) -> dict:
    """A conversation derived from another (a branch, a copy, an edited question, a second opinion) stays on its topic: the
    same line of the time tree, the same project folder, and — when the world tree places it — the same topic as the one it
    came from (preferences.derived_from tells pga.worldtree whose place to take)."""
    from datetime import timedelta

    from pga import projectsort
    from pga.timeline import Timeline
    now = now or utcnow()
    src = "c:" + parent[len(IMPORTED):] if parent.startswith(IMPORTED) else parent          # an imported conversation's timeline key
    tl = Timeline(rt)
    it = next((x for x in tl.items(user, now - timedelta(days=730)) if x.key == src), None)
    line = tl.lines_of(user, [it]).get(src, src) if it is not None else src
    tl.move(user, key, line)
    st = projectsort.state(user)
    project = projectsort.project_of(st, src, it.project if it is not None else "")
    st["of"][key] = project
    projectsort.save(user, st)
    d = dict((user.preferences or {}).get("derived_from") or {})
    d[key] = src
    user.preferences = {**(user.preferences or {}), "derived_from": dict(list(d.items())[-3000:])}
    return {"line": line, "project": project}


def other_agent(rt: "Runtime", run: AgentRun, agent: str | None) -> str:
    """Who gives the second opinion: the one you named, else the best-ranked agent for this kind of question other than the first."""
    from pga.agents.routing import AgentRouter, classify
    d = run.data or {}
    first = str(d.get("agent") or run.agent)
    if agent and agent != "auto":
        return agent
    cat = d.get("category") or classify(run.prompt or "")[0]
    ranked = [x["agent"] for x in AgentRouter(rt).rank(cat) if x["usable"] and x["agent"] != first]
    if not ranked:
        raise ChatError("no other agent is available right now")
    return ranked[0]


def second_branch(rt: "Runtime", user: User, run_id: uuid.UUID, agent: str | None = None) -> dict:
    """A second opinion as a conversation of its own: a branch from just before this question (so the other agent hears what
    came before it), to be asked the same question. It stays on the topic of the conversation it came from. The caller asks it."""
    run = rt.session.get(AgentRun, run_id)
    if run is None or run.user_id != user.id or run.workflow != "ask" or (run.data or {}).get("note"):
        raise ChatError("no such reply")
    if (run.data or {}).get("regen_of"):                                   # a regenerated version: the question is the root turn's
        run = rt.session.get(AgentRun, uuid.UUID(str(run.data["regen_of"]))) or run
    key = str((run.data or {}).get("conversation") or f"run:{run.id}")
    who = other_agent(rt, run, agent)
    turns, _ = fold(runs_of(rt, user.id, key))
    i = next((j for j, r in enumerate(turns) if r.id == run.id), 0)
    prev = turns[i - 1] if i > 0 else None
    new = f"chat:{uuid.uuid4().hex[:10]}"
    if prev is not None:
        set_branch(user, new, key, str(prev.id))
    base = ((user.preferences or {}).get("chat_titles") or {}).get(key) or " ".join((turns[0].prompt if turns else run.prompt or "").split())[:40]
    title = f"{base} · 第二意见 · {who}"[:80]
    set_title(user, new, title)
    inherit_settings(user, new, key)
    topic = inherit(rt, user, new, key)
    return {"key": new, "agent": who, "question": run.prompt or "", "from": key, "upto": str(prev.id) if prev is not None else None,
            "title": title, **topic}


def regenerate(rt: "Runtime", user: User, run_id: uuid.UUID, agent: str | None = None) -> dict:
    """Another version of one answer: the same question, with what came before it (not the answer it replaces), in a
    fresh session; kept as a version of that turn (data["regen_of"]), not as a new turn."""
    from pga.agents.routing import AgentRouter
    run = rt.session.get(AgentRun, run_id)
    if run is None or run.user_id != user.id or run.workflow != "ask" or (run.data or {}).get("note"):
        raise ChatError("no such reply")
    root = rt.session.get(AgentRun, uuid.UUID(str(run.data["regen_of"]))) if (run.data or {}).get("regen_of") else run
    d = root.data or {}
    key = str(d.get("conversation") or f"run:{root.id}")
    before = history(rt, user, key, root.id)[:-2]
    n = len(fold(runs_of(rt, user.id, key))[1].get(str(root.id), [])) + 1
    reply = AgentRouter(rt).ask(user, root.prompt or "", agent=agent or "auto", history=[{"role": t["role"], "text": t["text"]} for t in before][-12:],
                                conversation=f"regen:{root.id}:{n}")
    new = rt.session.get(AgentRun, uuid.UUID(str(reply["run_id"]))) if reply.get("run_id") else None
    if new is not None:
        new.data = {**(new.data or {}), "conversation": key, "regen_of": str(root.id)}
        root.data = {**d, "pick": str(new.id)}
    return {"run": str(new.id) if new else None, "of": str(root.id), "text": reply.get("text"), "error": reply.get("error"), "agent": reply.get("agent")}


def fold_in(rt: "Runtime", user: User, root_id: uuid.UUID, runs: list[uuid.UUID], key: str) -> int:
    """Answers several agents gave to the same question at once: they become versions of the first one's turn."""
    root = rt.session.get(AgentRun, root_id)
    if root is None or root.user_id != user.id:
        raise ChatError("no such reply")
    n = 0
    for rid in runs:
        r = rt.session.get(AgentRun, rid)
        if r is None or r.user_id != user.id or r.id == root.id:
            continue
        r.data = {**(r.data or {}), "conversation": key, "regen_of": str(root.id), "multi": True}
        n += 1
    return n


def children(user: User, key: str) -> list[dict]:
    """The chats that branched from this one, and where (the turn they grew from)."""
    titles = (user.preferences or {}).get("chat_titles") or {}
    return [{"key": k, "upto": v.get("upto"), "title": titles.get(k)} for k, v in ((user.preferences or {}).get("chat_branches") or {}).items()
            if v.get("from") == key and not v.get("split_lane")]


def pick(rt: "Runtime", user: User, run_id: uuid.UUID, version: uuid.UUID) -> None:
    run = rt.session.get(AgentRun, run_id)
    if run is None or run.user_id != user.id:
        raise ChatError("no such reply")
    run.data = {**(run.data or {}), "pick": str(version)}


def rate(rt: "Runtime", user: User, run_id: uuid.UUID, rating: int, note: str = "") -> dict:
    """Good (1) / bad (-1) / none (0) on an answer — kept on the run, for learning which agent you trust for what."""
    run = rt.session.get(AgentRun, run_id)
    if run is None or run.user_id != user.id:
        raise ChatError("no such reply")
    d = dict(run.data or {})
    if rating:
        d["rating"] = {"value": 1 if rating > 0 else -1, "note": note[:500], "at": utcnow().isoformat()}
    else:
        d.pop("rating", None)
    run.data = d
    return {"run": str(run.id), "rating": (d.get("rating") or {}).get("value", 0)}


def search(rt: "Runtime", user: User, q: str, limit: int = 30) -> list[dict]:
    """Your chats and imported conversations whose words match, newest first, each with a snippet."""
    import re as _re

    from pga.db.models import AgentConversation, LinkedAgent
    from pga.tree import _answer
    q = q.strip()
    if len(q) < 2:
        return []
    like = f"%{q}%"
    out, seen = [], set()
    rows = rt.session.scalars(select(AgentRun).where(AgentRun.user_id == user.id, AgentRun.parent_id.is_(None), AgentRun.workflow == "ask",
                                                     or_(AgentRun.prompt.ilike(like), AgentRun.output.ilike(like)))
                              .order_by(AgentRun.started_at.desc()).limit(200))
    titles = ((user.preferences or {}).get("chat_titles") or {})

    def snip(text: str) -> str:
        i = text.lower().find(q.lower())
        return ("…" if i > 40 else "") + _re.sub(r"\s+", " ", text[max(0, i - 40): i + 80]).strip() + "…" if i >= 0 else ""
    for r in rows:
        d = r.data or {}
        key = str(d.get("conversation") or f"run:{r.id}")
        if key.startswith(HIDDEN + ("regen:",)) or d.get("node") or key in seen:
            continue
        seen.add(key)
        text = r.prompt or ""
        hit = snip(text) or snip(_answer(r.output) or "")
        out.append({"key": key, "kind": "chat", "title": titles.get(key) or " ".join(text.split())[:60], "snippet": hit, "at": r.started_at.isoformat(),
                    "agent": d.get("agent") or r.agent})
    for c, a in rt.session.execute(select(AgentConversation, LinkedAgent).join(LinkedAgent, AgentConversation.linked_agent_id == LinkedAgent.id)
                                   .where(LinkedAgent.user_id == user.id, or_(AgentConversation.title.ilike(like), AgentConversation.excerpt.ilike(like)))
                                   .order_by(AgentConversation.updated_at.desc().nulls_last()).limit(40)):
        out.append({"key": f"c:{c.id}", "kind": "import", "cid": str(c.id), "title": titles.get(f"c:{c.id}") or _re.sub(r"^\[[^\]]*\]\s*", "", c.title or "")[:60],
                    "snippet": snip(c.excerpt or "") or snip(c.title or ""), "at": (c.updated_at or c.started_at or c.created_at).isoformat(), "agent": a.name})
    return sorted(out, key=lambda x: x["at"], reverse=True)[:limit]


def set_title(user: User, key: str, title: str, *, source: str = "seed") -> None:
    titles = dict((user.preferences or {}).get("chat_titles") or {})
    if title.strip():
        titles[key[:120]] = title.strip()[:80]
    else:
        titles.pop(key[:120], None)
    states = dict((user.preferences or {}).get("chat_title_state") or {})
    states[key[:120]] = {"mode": "manual" if title.strip() and source == "manual" else "seed",
                        "revision": uuid.uuid4().hex}
    user.preferences = {**(user.preferences or {}), "chat_titles": dict(list(titles.items())[-2000:]),
                        "chat_title_state": states}


def _compare(rt: "Runtime", user: User, question: str, a: str, ta: str, b: str, tb: str, lang: str, now: datetime) -> dict:
    system = COMPARE.format(lang=lang, a=a, b=b, untrusted=UNTRUSTED_NOTE)
    prompt = (fence("question", question, 4000, kind="the person's question") + "\n\n"
              + fence(f"answer_{a}", ta, 12000, kind=f"{a}'s answer") + "\n\n" + fence(f"answer_{b}", tb, 12000, kind=f"{b}'s answer"))
    decision = rt.allocator.allocate(RunRequest(
        user_id=user.id, kind="synthesis",
        justification=Justification(why_now="you asked for a second opinion", expected_gain="where two agents agree and differ",
                                    decision_affected="which answer you act on",
                                    budget={"max_units": 20_000, "max_output_tokens": 900}, stop_condition="compared"),
        estimates=Estimates(information_gain=.5, decision_impact=.5, user_relevance=.9, reuse_value=.3,
                            input_tokens=len(prompt) // 3, output_tokens=600)), now=now)
    if not decision.allowed:
        raise ChatError("; ".join(decision.reasons))
    with rt.runs.track(decision, now) as guard:
        res = rt.router.complete(decision.tier, system=system, messages=[{"role": "user", "content": prompt}],
                                 max_tokens=900, usage=guard.usage_context())
        try:
            d = parse_json(res.text)
        except ModelOutputError:
            guard.stop("comparison was not JSON")
            return {}
        guard.stop("compared")
    if not isinstance(d, dict):
        return {}
    return {"agree": [str(x) for x in d.get("agree") or []][:6],
            "differ": [{k: str(x.get(k) or "") for k in ("point", "a", "b")} for x in d.get("differ") or [] if isinstance(x, dict)][:6],
            "answer": str(d.get("answer") or "")[:3000]}


def start_split(rt, user, key, agents, run_id=None, options=None):
    """Two persistent hidden lanes in one visible chat; never reuse a parent's native session. You choose who answers on
    each side: two agents, or one agent with two models (`options`: [{model, effort}] beside `agents`)."""
    existing = ((user.preferences or {}).get("chat_splits") or {}).get(key)
    if existing:
        return existing
    if not isinstance(agents, list) or len(agents) != 2 or not all(isinstance(a, str) and a for a in agents):
        raise ChatError("choose two agents")
    opts = [o if isinstance(o, dict) else {} for o in (options if isinstance(options, list) else [])][:2]
    opts += [{}] * (2 - len(opts))
    picks = [{"agent": a, **{k: str(o[k])[:200] for k in ("model", "effort") if isinstance(o.get(k), str) and o[k]}}
             for a, o in zip(agents, opts)]
    if picks[0] == picks[1]:
        raise ChatError("choose two different agents or models")
    from pga.agents.routing import AgentRouter
    router = AgentRouter(rt)
    if any(p["agent"] not in router.pool.adapters for p in picks):
        raise ChatError("unknown agent")
    snapshot = history(rt, user, key)
    question = anchor = None
    if run_id:
        run = next((r for r in runs_of(rt, user.id, key) if str(r.id) == str(run_id)), None)
        if run is None:
            raise ChatError("reply does not belong to this conversation")
        snapshot = history(rt, user, key, run.id)[:-2]
        question, anchor = run.prompt, str(run.id)
    lanes = []
    for p in picks:
        lane = f"second:{uuid.uuid4().hex}"
        set_branch(user, lane, key, "0")
        branches = dict(user.preferences["chat_branches"])
        branches[lane] = {**branches[lane], "snapshot": snapshot, "split_lane": True}
        user.preferences = {**user.preferences, "chat_branches": branches}
        inherit(rt, user, lane, key)
        inherit_settings(user, lane, key)
        chosen = dict(user.preferences.get("chat_options") or {})         # the side's own answerer, not the one it came from
        chosen[lane] = {"agent": p["agent"], "model": p.get("model", ""), "effort": p.get("effort", "")}
        user.preferences = {**user.preferences, "chat_options": chosen}
        lanes.append({"key": lane, **p})
    split = {"lanes": lanes, "question": question, **({"run": anchor} if anchor else {})}
    user.preferences = {**user.preferences, "chat_splits": {**(user.preferences.get("chat_splits") or {}), key: split}}
    return split


def set_split_side(rt, user, key, lane_key, agent, model="", effort="") -> dict:
    """Change who answers on one side of a split, at any time: that side carries on with its own history (a new agent is
    given all of it). The two sides may not become the same agent with the same model."""
    split = ((user.preferences or {}).get("chat_splits") or {}).get(key)
    if not split:
        raise ChatError("no split here")
    lanes = [dict(l) for l in split.get("lanes") or []]
    i = next((n for n, l in enumerate(lanes) if l.get("key") == lane_key), None)
    if i is None:
        raise ChatError("no such side")
    if not isinstance(agent, str) or not agent:
        raise ChatError("choose an agent")
    from pga.agents.routing import AgentRouter
    if agent not in AgentRouter(rt).pool.adapters:
        raise ChatError("unknown agent")
    pick = {"agent": agent, **{k: str(v)[:200] for k, v in (("model", model), ("effort", effort)) if isinstance(v, str) and v}}
    who = lambda l: (l.get("agent"), l.get("model") or "", l.get("effort") or "")
    if any(n != i and who(l) == who(pick) for n, l in enumerate(lanes)):
        raise ChatError("the other side already answers with this")
    lanes[i] = {"key": lane_key, **pick}
    prefs = user.preferences or {}
    split = {**split, "lanes": lanes}
    user.preferences = {**prefs, "chat_splits": {**(prefs.get("chat_splits") or {}), key: split},
                        "chat_options": {**(prefs.get("chat_options") or {}),
                                         lane_key: {"agent": agent, "model": pick.get("model", ""), "effort": pick.get("effort", "")}}}
    return split


def adopt_split(rt, user, key, lane_key) -> dict:
    """Carry on with one side of a split (采用): its turns become this conversation's own, after what both sides shared, and
    its agent (and model) answers from now on. The other side's answers to the same questions stay as versions of those
    turns, not in use: flip to them, or read them side by side. A split that redid an earlier answer: when nothing came
    after that answer, it becomes a version of the redone turn too; when something did, that answer and what followed move
    to a branch of their own (原来的后续), so nothing is lost."""
    split = ((user.preferences or {}).get("chat_splits") or {}).get(key)
    if not split:
        raise ChatError("no split here")
    lane = next((l for l in split.get("lanes") or [] if l.get("key") == lane_key), None)
    if lane is None:
        raise ChatError("no such side")
    mine, mine_alts = fold(runs_of(rt, user.id, lane_key))
    main, main_alts = fold(runs_of(rt, user.id, key))
    group = lambda r, alts: [r, *alts.get(str(r.id), [])]                # a turn and its other versions
    asked = lambda r: " ".join((r.prompt or "").split())
    picked = {str(m.id): str(current(m, mine_alts).id) for m in mine}    # the side's own choice among its regenerated versions
    anchor = None
    if split.get("question"):
        rid = str(split.get("run") or "")
        anchor = next((r for r in main if str(r.id) == rid), None) if rid else next(
            (r for r in reversed(main) if asked(r) == " ".join(split["question"].split())), None)
    moved = None
    if anchor is not None:
        i = main.index(anchor)
        if main[i + 1:]:
            moved = f"chat:{uuid.uuid4().hex[:10]}"
            set_branch(user, moved, key, str(main[i - 1].id) if i else "0")
            base = ((user.preferences or {}).get("chat_titles") or {}).get(key) or asked(main[0])[:40]
            set_title(user, moved, f"{base} · 原来的后续")
            inherit(rt, user, moved, key)
            inherit_settings(user, moved, key)
            for r in main[i:]:
                for x in group(r, main_alts):
                    x.data = {**(x.data or {}), "conversation": moved}
        elif mine and asked(mine[0]) == asked(anchor):
            for x in group(anchor, main_alts):
                x.data = {**(x.data or {}), "regen_of": str(mine[0].id), "split_alt": True}
    for m in mine:
        for x in group(m, mine_alts):
            x.data = {**(x.data or {}), "conversation": key}
    for other in split["lanes"]:
        if other["key"] == lane_key:
            continue
        theirs, theirs_alts = fold(runs_of(rt, user.id, other["key"]))
        j = 0
        for t in theirs:
            if (t.data or {}).get("note"):
                continue
            k = next((n for n, m in enumerate(mine[j:], j) if asked(m) == asked(t) and not (m.data or {}).get("note")), None)
            if k is None:
                continue
            j = k + 1
            for x in group(t, theirs_alts):
                x.data = {**(x.data or {}), "conversation": key, "regen_of": str(mine[k].id), "split_alt": True}
    for m in mine:
        m.data = {**(m.data or {}), "pick": picked[str(m.id)]}
    prefs = user.preferences or {}
    chosen = {"agent": lane["agent"], "model": lane.get("model", ""), "effort": lane.get("effort", "")}
    user.preferences = {**prefs, "chat_splits": {k: v for k, v in (prefs.get("chat_splits") or {}).items() if k != key},
                        "chat_multi": {k: v for k, v in (prefs.get("chat_multi") or {}).items() if k != key},
                        "chat_options": {**(prefs.get("chat_options") or {}), key: chosen}}
    return {"key": key, **chosen, "turns": len(mine), "moved": moved}
