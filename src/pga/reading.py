"""Durable document conversations, using ordinary chat history and branch identities."""
from __future__ import annotations

import uuid
from pathlib import Path
from urllib.parse import urldefrag, urlsplit

from pydantic import BaseModel, ConfigDict, Field, field_validator
from sqlalchemy import select

from pga.db.models import AgentRun, User
from pga.db.types import utcnow
from pga.reader_ai import ReaderQuestion, ReadingConversationQuestion, HistoryTurn, ask_conversation


class OpenReading(BaseModel):
    model_config = ConfigDict(extra="forbid", strict=True)
    parent: str = Field(min_length=1, max_length=120)
    source: str = Field(min_length=1, max_length=4096)
    web: bool = True


class ReadingSelection(BaseModel):
    model_config = ConfigDict(extra="forbid", strict=True)
    text: str = Field(max_length=8000)
    id: str = Field(default="", max_length=80)
    page: int | None = Field(default=None, ge=1, le=100000)


class ReadingState(BaseModel):
    model_config = ConfigDict(extra="forbid", strict=True)
    page: int | None = Field(default=None, ge=1, le=100000)
    ratio: float | None = Field(default=None, ge=0, le=1, allow_inf_nan=False)
    anchor: str | None = Field(default=None, max_length=80)
    draft: str | None = Field(default=None, max_length=2000)
    title: str | None = Field(default=None, max_length=500)
    selection: ReadingSelection | None = None
    revision: int | None = Field(default=None, ge=0, le=9007199254740991)


class ReadingAsk(BaseModel):
    model_config = ConfigDict(extra="forbid", strict=True)
    request_id: str = Field(min_length=36, max_length=36)
    question: str = Field(min_length=1, max_length=2000)
    selection: str = Field(default="", max_length=8000)
    context: str = Field(default="", max_length=24000)
    page: int | None = Field(default=None, ge=1, le=100000)
    anchor: str = Field(default="", max_length=80)

    @field_validator("request_id")
    @classmethod
    def valid_id(cls, value):
        return str(uuid.UUID(value))


def get(rt, user, key, *, lock=False):
    try:
        ident = uuid.UUID(key.removeprefix("chat:"))
    except ValueError:
        return None
    query = select(AgentRun).where(AgentRun.id == ident, AgentRun.user_id == user.id,
                                   AgentRun.workflow == "reading")
    if lock:
        query = query.with_for_update().execution_options(populate_existing=True)
    return rt.session.scalar(query)


def public(row):
    if row is None:
        return None
    data = row.data or {}
    return {"key": f"chat:{row.id}", **{k: data.get(k) for k in ("parent", "source", "web", "title")},
            "state": data.get("state") or {}}


def open_reading(rt, user, body: OpenReading):
    source = body.source
    if body.web:
        source = ReaderQuestion.article_url(source)
        source = urldefrag(source)[0]
        title = urlsplit(source).hostname
    else:
        title = Path(source).name
    ident = uuid.uuid5(user.id, "reading\n" + body.parent + "\n" + source)
    key = f"chat:{ident}"
    # Serialize preference updates and simultaneous opens of the same source.
    rt.session.refresh(user, with_for_update=True)
    old = get(rt, user, key)
    if old:
        return public(old)
    now = utcnow()
    row = AgentRun(id=ident, user_id=user.id, workflow="reading", pattern="direct", step="source",
                   agent="reader", adapter="reader", status="completed", started_at=now, finished_at=now,
                   data={"conversation": key, "parent": body.parent, "source": source,
                         "web": body.web, "title": title, "state": {}})
    rt.session.add(row)
    from pga.chats import set_branch, set_title
    from pga import projectsort
    branch = set_branch(user, key, body.parent, "0")
    branch.update(snapshot=[], reading=True, manual_title=True)
    set_title(user, key, title)
    state = projectsort.state(user)
    if category := state["of"].get(body.parent):
        projectsort.save(user, {**state, "of": {**state["of"], key: category}})
    rt.session.flush()
    return public(row)


def update_state(row, state: ReadingState):
    data = dict(row.data or {})
    changes = state.model_dump(exclude_unset=True)
    revision = changes.pop("revision", None)
    if revision is not None:
        if revision < data.get("state_revision", 0):
            return public(row)
        data["state_revision"] = revision
    if title := changes.pop("title", None):
        data["title"] = title
    data["state"] = {**(data.get("state") or {}), **changes}
    row.data = data
    return public(row)


def answer(rt, user, row, body: ReadingAsk):
    """Caller holds this reading's row lock. A retry cannot create duplicate paid answers."""
    key = f"chat:{row.id}"
    ident = uuid.uuid5(row.id, body.request_id)
    old = rt.session.get(AgentRun, ident)
    if old:
        return {"answer": old.output, "run": str(old.id)}
    data = row.data or {}
    prior = list(rt.session.scalars(select(AgentRun).where(
        AgentRun.user_id == user.id, AgentRun.workflow == "ask", AgentRun.parent_id.is_(None),
        AgentRun.data["conversation"].as_string() == key).order_by(AgentRun.started_at.desc()).limit(3)))
    history = []
    for turn in reversed(prior):
        history.extend([HistoryTurn(role="user", content=turn.prompt[:2000]),
                        HistoryTurn(role="assistant", content=(turn.output or "（无回答）")[:2000])])
    question = ReadingConversationQuestion(url=data["source"] if data["web"] else f"https://pga.local/documents/{row.id}",
                              title=data["title"], selection=body.selection, context=body.context,
                              question=body.question, history=history)
    started = utcnow()
    output = ask_conversation(rt, user, question)
    if not output.strip():
        from pga.reader_ai import ReaderModelError
        raise ReaderModelError("AI 没有返回回答，请重试")
    ref = {"source": data["source"], "title": data["title"], "selection": body.selection,
           "page": body.page, "anchor": body.anchor}
    citation = (f"\n\n> {body.selection.replace(chr(10), chr(10) + '> ')}" if body.selection else "")
    location = f" · 第 {body.page} 页" if body.page else ""
    prompt = body.question + citation + f"\n\n来源：{data['source']}{location}"
    run = AgentRun(id=ident, user_id=user.id, workflow="ask", pattern="direct", step="answer",
                   agent="reader", adapter="reader", status="completed", prompt=prompt, output=output,
                   started_at=started, finished_at=utcnow(),
                   data={"conversation": key, "agent": "reader", "reader_reference": ref,
                         "reader_question": body.question})
    rt.session.add(run)
    rt.session.flush()
    return {"answer": output, "run": str(run.id)}
