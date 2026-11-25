"""采用 one side of a two-agent split: the conversation carries on with it; nothing from the other side is lost."""
import itertools
import json
import uuid
from types import SimpleNamespace

import pytest
import pga.chats as chats

clock = itertools.count()


def setup(monkeypatch):
    user = SimpleNamespace(id=uuid.uuid4(), preferences={})
    runs = []

    def add(key, question, answer, agent="a", **data):
        r = SimpleNamespace(id=uuid.uuid4(), data={"conversation": key, "agent": agent, **data}, prompt=question,
                            output=json.dumps({"answer": answer}), agent=agent, at=next(clock))
        runs.append(r)
        return r
    monkeypatch.setattr(chats, "runs_of", lambda rt, uid, key: sorted((r for r in runs if r.data.get("conversation") == key), key=lambda r: r.at))
    monkeypatch.setattr(chats, "inherit", lambda *a, **kw: {})
    from pga.agents.routing import AgentRouter
    monkeypatch.setattr(AgentRouter, "__init__", lambda self, rt: setattr(self, "pool", SimpleNamespace(adapters={"a": 1, "b": 1})))
    return user, add


def texts(user, key):
    return [t["text"] for t in chats.history(None, user, key)]


def test_you_choose_each_side_even_one_agent_with_two_models(monkeypatch):
    user, add = setup(monkeypatch)
    add("chat:p", "q1", "a1")
    s = chats.start_split(None, user, "chat:p", ["a", "a"], options=[{"model": "opus", "effort": "high"}, {"model": "sonnet"}])
    assert [(l["agent"], l.get("model"), l.get("effort")) for l in s["lanes"]] == [("a", "opus", "high"), ("a", "sonnet", None)]
    assert [user.preferences["chat_options"][l["key"]] for l in s["lanes"]] == [
        {"agent": "a", "model": "opus", "effort": "high"}, {"agent": "a", "model": "sonnet", "effort": ""}]
    user.preferences["chat_splits"] = {}
    with pytest.raises(chats.ChatError):
        chats.start_split(None, user, "chat:p", ["a", "a"], options=[{"model": "opus"}, {"model": "opus"}])


def test_adopting_a_side_carries_on_with_it_and_keeps_the_other_as_versions(monkeypatch):
    user, add = setup(monkeypatch)
    add("chat:p", "q1", "a1")
    s = chats.start_split(None, user, "chat:p", ["a", "b"], options=[{}, {"model": "m2", "effort": "high"}])
    left, right = [l["key"] for l in s["lanes"]]
    add(left, "q2", "LEFT 2")
    r2 = add(right, "q2", "RIGHT 2", agent="b")
    add(left, "only left", "LEFT 3")
    r3 = add(right, "q4", "RIGHT 4", agent="b")
    r4 = add(left, "q4", "LEFT 4")
    out = chats.adopt_split(None, user, "chat:p", right)
    assert out == {"key": "chat:p", "agent": "b", "model": "m2", "effort": "high", "turns": 2, "moved": None}
    assert texts(user, "chat:p") == ["q1", "a1", "q2", "RIGHT 2", "q4", "RIGHT 4"]
    turns, alts = chats.fold(chats.runs_of(None, user.id, "chat:p"))
    assert [a.output for a in alts[str(r2.id)]] == [json.dumps({"answer": "LEFT 2"})] and alts[str(r2.id)][0].data["split_alt"]
    assert alts[str(r3.id)] == [r4] and chats.current(r3, alts) is r3          # the later answer of the other side is not in use
    assert texts(user, left)[-2:] == ["only left", "LEFT 3"]                  # asked of one side only: stays on that side
    assert "chat:p" not in user.preferences["chat_splits"]
    assert user.preferences["chat_options"]["chat:p"] == {"agent": "b", "model": "m2", "effort": "high"}
    with pytest.raises(chats.ChatError):
        chats.adopt_split(None, user, "chat:p", right)


def test_redoing_the_last_answer_files_the_old_one_as_a_version(monkeypatch):
    user, add = setup(monkeypatch)
    add("chat:p", "q1", "a1")
    old = add("chat:p", "q2", "OLD 2")
    s = chats.start_split(None, user, "chat:p", ["a", "b"], old.id)
    left, right = [l["key"] for l in s["lanes"]]
    mine = add(left, "q2", "LEFT 2")
    add(right, "q2", "RIGHT 2", agent="b")
    chats.adopt_split(None, user, "chat:p", left)
    assert texts(user, "chat:p") == ["q1", "a1", "q2", "LEFT 2"]
    turns, alts = chats.fold(chats.runs_of(None, user.id, "chat:p"))
    assert [t.id for t in turns][-1] == mine.id and {a.prompt for a in alts[str(mine.id)]} == {"q2"} and len(alts[str(mine.id)]) == 2
    assert old in alts[str(mine.id)] and chats.current(mine, alts) is mine


def test_redoing_an_earlier_answer_moves_what_followed_to_a_branch(monkeypatch):
    user, add = setup(monkeypatch)
    q1 = add("chat:p", "q1", "a1")
    old = add("chat:p", "q2", "OLD 2")
    add("chat:p", "q3", "OLD 3")
    user.preferences["chat_titles"] = {"chat:p": "题目"}
    s = chats.start_split(None, user, "chat:p", ["a", "b"], old.id)
    left = s["lanes"][0]["key"]
    add(left, "q2", "LEFT 2")
    add(left, "q5", "LEFT 5")
    out = chats.adopt_split(None, user, "chat:p", left)
    assert texts(user, "chat:p") == ["q1", "a1", "q2", "LEFT 2", "q5", "LEFT 5"]
    assert texts(user, out["moved"]) == ["q1", "a1", "q2", "OLD 2", "q3", "OLD 3"]
    assert user.preferences["chat_branches"][out["moved"]] == {"from": "chat:p", "upto": str(q1.id)}
    assert user.preferences["chat_titles"][out["moved"]] == "题目 · 原来的后续"
    assert [k["key"] for k in chats.children(user, "chat:p")] == [out["moved"]]


def test_either_side_can_change_who_answers_at_any_time(monkeypatch):
    user, add = setup(monkeypatch)
    add("chat:p", "q1", "a1")
    s = chats.start_split(None, user, "chat:p", ["a", "b"])
    left, right = [l["key"] for l in s["lanes"]]
    add(right, "q2", "B answered", agent="b")
    got = chats.set_split_side(None, user, "chat:p", right, "a", "opus", "high")
    assert got["lanes"][1] == {"key": right, "agent": "a", "model": "opus", "effort": "high"} and got["lanes"][0] == s["lanes"][0]
    assert user.preferences["chat_splits"]["chat:p"] == got
    assert user.preferences["chat_options"][right] == {"agent": "a", "model": "opus", "effort": "high"}
    assert texts(user, right) == ["q1", "a1", "q2", "B answered"]           # its history stays; the new answerer reads it
    with pytest.raises(chats.ChatError):
        chats.set_split_side(None, user, "chat:p", left, "a", "opus", "high")  # the same as the other side
    with pytest.raises(chats.ChatError):
        chats.set_split_side(None, user, "chat:p", left, "nobody")
    with pytest.raises(chats.ChatError):
        chats.set_split_side(None, user, "chat:x", left, "a")
    chats.adopt_split(None, user, "chat:p", right)
    assert user.preferences["chat_options"]["chat:p"] == {"agent": "a", "model": "opus", "effort": "high"}   # adopting goes on with the new one
