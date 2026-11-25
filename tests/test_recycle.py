"""对话回收 (pga.recycle): which one-off conversations a manager dispatched get archived, when, and what brings them back."""
import uuid
from datetime import datetime, timedelta, timezone

from pga import project_context as P, projectsort, recycle
from pga.agents import live
from pga.db.models import AgentRun

NOW = datetime(2026, 11, 12, 12, 0, tzinfo=timezone.utc)
PM = "chat:pm-test"


def run(session, user, key, *, at, status="SUCCEEDED", **data):
    r = AgentRun(user_id=user.id, workflow="ask", pattern="single", step="workflow", agent="codex", adapter="pool",
                 status=status, prompt="任务", output="完成", data={"conversation": key, **data}, started_at=at, finished_at=at)
    session.add(r)
    session.flush()
    return r


def dispatch(session, user, keys, *, at, **extra):
    """The manager's paragraph (a note in its conversation) and the tasks it gave out."""
    tasks = [{"title": k, "key": k, "agent": "codex", **extra.get(k, {})} for k in keys]
    return run(session, user, PM, at=at, step="note", dispatch={"id": uuid.uuid4().hex[:8], "text": "需求", "tasks": tasks})


def keys(xs):
    return {x["key"]: x["reason"] for x in xs}


def test_settled_request_goes_after_grace_once_seen(rt, user, session, monkeypatch):
    monkeypatch.setattr(live, "_RUNS", {})
    done = NOW - timedelta(hours=1)
    dispatch(session, user, ["chat:a", "chat:b"], at=done - timedelta(minutes=5))
    run(session, user, "chat:a", at=done)
    run(session, user, "chat:b", at=done)
    assert recycle.plan(rt, user, now=NOW) == []                       # nothing seen yet
    recycle.seen(user, ["chat:a"], now=NOW - timedelta(minutes=30))
    assert recycle.plan(rt, user, now=NOW) == []                       # its sibling is not seen: the request is open
    recycle.seen(user, ["chat:b"], now=NOW - timedelta(minutes=3))
    assert keys(recycle.plan(rt, user, now=NOW)) == {"chat:a": "settled"}       # b was seen 3 minutes ago: not yet
    assert keys(recycle.plan(rt, user, now=NOW + timedelta(minutes=10))) == {"chat:a": "settled", "chat:b": "settled"}
    # in front of you, or still marked unread on the stage: stays
    assert "chat:a" not in keys(recycle.plan(rt, user, visible=["chat:a"], now=NOW + timedelta(minutes=10)))
    assert "chat:b" not in keys(recycle.plan(rt, user, unread=["chat:b"], now=NOW + timedelta(minutes=10)))


def test_failed_sibling_does_not_hold_the_rest_forever(rt, user, session, monkeypatch):
    monkeypatch.setattr(live, "_RUNS", {})
    done = NOW - timedelta(hours=30)
    dispatch(session, user, ["chat:ok", "chat:bad"], at=done)
    run(session, user, "chat:ok", at=done)
    run(session, user, "chat:bad", at=done, status="FAILED")
    recycle.seen(user, ["chat:ok", "chat:bad"], now=done + timedelta(minutes=1))
    assert keys(recycle.plan(rt, user, now=NOW)) == {"chat:ok": "idle"}  # a failed task is never archived by the rules


def test_continued_conversations_stay(rt, user, session, monkeypatch):
    monkeypatch.setattr(live, "_RUNS", {})
    old = NOW - timedelta(days=10)
    dispatch(session, user, ["chat:talk", "chat:read", "chat:wired", "chat:grown", "chat:steered", "chat:busy", "chat:one"], at=old)
    for k in ("chat:talk", "chat:read", "chat:wired", "chat:grown", "chat:busy", "chat:one"):
        run(session, user, k, at=old)
    run(session, user, "chat:talk", at=old + timedelta(hours=1))                       # you asked again
    run(session, user, "chat:steered", at=old, steering=[{"id": "s", "text": "再加一点"}])  # you added while it worked
    dispatch(session, user, ["chat:later"], at=old + timedelta(days=1), **{"chat:later": {"from": "chat:read"}})  # its context read later
    user.preferences = {**user.preferences, "chat_refs": {"chat:x": ["chat:wired"]},          # a wire on the stage draws from it
                        "chat_branches": {"chat:kid": {"from": "chat:grown", "upto": "0"}}}    # something grew from it
    lid = live.start("codex", tags={"conversation": f"{user.id}:chat:busy"})                  # an agent is at it again
    assert live.snapshot()[0]["running"]
    assert keys(recycle.plan(rt, user, now=NOW)) == {"chat:one": "backlog"}
    live.finish(lid, True)


def test_archive_keeps_the_trace_and_a_new_message_brings_it_back(rt, user, session, monkeypatch):
    monkeypatch.setattr(live, "_RUNS", {})
    projectsort.assign(user, "chat:a", "PGA")
    old = NOW - timedelta(days=5)
    dispatch(session, user, ["chat:a"], at=old)
    run(session, user, "chat:a", at=old)
    assert keys(recycle.sweep(rt, user, now=NOW)) == {"chat:a": "backlog"}
    assert "chat:a" in user.preferences["archived_chats"]
    assert "chat:a" not in P.members(user, "PGA")                      # out of the category's list …
    row = next(r for r in P.activity(rt, user, "PGA") if r["key"] == "chat:a")
    assert row["archived"]["auto"] and "天" in row["archived"]["why"]  # … the manager's record stays and says why
    assert recycle.touched(user, "chat:a")                             # you wrote in it again
    assert "chat:a" not in user.preferences["archived_chats"]
    assert recycle.plan(rt, user, now=NOW) == []                       # and the rules leave it alone from now on


def test_undo_puts_the_batch_back_and_manual_archives_are_not_reopened(rt, user, session, monkeypatch):
    monkeypatch.setattr(live, "_RUNS", {})
    old = NOW - timedelta(days=5)
    dispatch(session, user, ["chat:a", "chat:b"], at=old)
    run(session, user, "chat:a", at=old)
    run(session, user, "chat:b", at=old)
    recycle.set_archived(user, "chat:m", True, now=NOW)                 # archived by you
    assert set(keys(recycle.sweep(rt, user, now=NOW))) == {"chat:a", "chat:b"}
    assert set(recycle.undo(user)) == {"chat:a", "chat:b"}
    assert user.preferences["archived_chats"] == ["chat:m"]
    assert recycle.sweep(rt, user, now=NOW) == []
    assert not recycle.touched(user, "chat:m")                          # a message does not reopen what you archived yourself


def test_turned_off(rt, user, session, monkeypatch):
    monkeypatch.setattr(live, "_RUNS", {})
    old = NOW - timedelta(days=5)
    dispatch(session, user, ["chat:a"], at=old)
    run(session, user, "chat:a", at=old)
    user.preferences = {**user.preferences, "recycle": {"enabled": False}}
    assert recycle.plan(rt, user, now=NOW) == []
