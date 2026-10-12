"""Agent links: the Codex app server, kept-alive sessions, link states and the keeper (stand-in processes, no network)."""

from __future__ import annotations

import os
import stat
import sys
import textwrap

import pytest
from sqlalchemy import select

from pga.agents import links
from pga.agents.adapters import ClaudeLocal, CodexLocal
from pga.agents.base import AgentTask
from pga.agents.pool import AgentPool
from pga.db.models import Notification
from pga.runtime import Runtime

FAKE_APP_SERVER = """
import json, sys, uuid
threads = {}
def send(m):
    sys.stdout.write(json.dumps(m) + "\\n"); sys.stdout.flush()
for line in sys.stdin:
    m = json.loads(line); meth, mid, p = m.get("method"), m.get("id"), m.get("params") or {}
    if meth == "initialize":
        send({"id": mid, "result": {"userAgent": "fake"}})
    elif meth == "account/read":
        send({"id": mid, "result": {"account": {"type": "chatgpt", "planType": "plus"}, "requiresOpenaiAuth": True}})
    elif meth == "account/rateLimits/read":
        send({"id": mid, "result": {"rateLimits": {"primary": {"usedPercent": 30, "windowDurationMins": 10080, "resetsAt": 1999999999}}}})
    elif meth == "thread/start":
        tid = "t-" + uuid.uuid4().hex[:6]; threads[tid] = 0
        send({"id": mid, "result": {"thread": {"id": tid}}})
    elif meth == "thread/resume":
        threads.setdefault(p["threadId"], 10)              # a resumed thread remembers its earlier turns
        send({"id": mid, "result": {"thread": {"id": p["threadId"]}}})
    elif meth == "turn/start":
        tid = p["threadId"]; threads[tid] += 1; turn = "u-" + uuid.uuid4().hex[:6]
        send({"id": mid, "result": {"turn": {"id": turn, "status": "inProgress"}}})
        reply = "turn %d heard: %s" % (threads[tid], p["input"][0]["text"])
        for piece in (reply[:5], reply[5:]):
            send({"method": "item/agentMessage/delta", "params": {"threadId": tid, "turnId": turn, "itemId": "i", "delta": piece}})
        send({"method": "item/completed", "params": {"threadId": tid, "turnId": turn, "item": {"type": "agentMessage", "id": "i", "text": reply}}})
        send({"method": "turn/completed", "params": {"threadId": tid, "turn": {"id": turn, "status": "completed"}}})
"""

FAKE_STREAM_CLI = """
import json, os, sys, uuid
args = sys.argv[1:]
assert "--input-format" in args and "--no-session-persistence" not in args
sid = args[args.index("--resume") + 1] if "--resume" in args else "s-" + uuid.uuid4().hex[:6]
n = 0
for line in sys.stdin:
    text = json.loads(line)["message"]["content"][0]["text"]; n += 1
    out = "pid %d msg %d resumed %s: %s" % (os.getpid(), n, "--resume" in args, text)
    for ev in ({"type": "system", "subtype": "init", "session_id": sid},
               {"type": "assistant", "session_id": sid, "message": {"content": [{"type": "text", "text": out}]}},
               {"type": "result", "subtype": "success", "is_error": False, "result": out, "session_id": sid, "num_turns": 1}):
        print(json.dumps(ev), flush=True)
"""


def _script(tmp_path, name: str, body: str) -> str:
    p = tmp_path / name
    p.write_text(f"#!{sys.executable}\n" + textwrap.dedent(body))
    p.chmod(p.stat().st_mode | stat.S_IEXEC)
    return str(p)


@pytest.fixture(autouse=True)
def _clean_links(tmp_path, monkeypatch):
    monkeypatch.setenv("PGA_LINKS_FILE", str(tmp_path / "links.json"))
    yield
    links.CodexServer.close_all()
    links.StreamSession.close_all()
    links._ACTIVE.clear()


def test_codex_keeps_one_thread_per_conversation_and_resumes_it_after_a_restart(tmp_path):
    ad = CodexLocal("cx", {"command": _script(tmp_path, "codex", FAKE_APP_SERVER)})
    ask = lambda new, prompt: ad.run(AgentTask(prompt=prompt, workspace=str(tmp_path), meta={"conversation": "u:card", "new_text": new}))  # noqa: E731
    r1 = ask("first", "Earlier: hello\nNow the user says:\nfirst")
    assert r1.ok and r1.text == "turn 1 heard: Earlier: hello\nNow the user says:\nfirst"     # a new thread gets the history
    assert r1.data["via"] == "app-server"
    r2 = ask("second", "the whole history again")
    assert r2.text == "turn 2 heard: second" and r2.session_id == r1.session_id            # the thread remembers: only the new words
    links.CodexServer.close_all()                                                         # PGA restarts …
    r3 = ask("third", "the whole history again")
    assert r3.text == "turn 11 heard: third" and r3.session_id == r1.session_id           # … and resumes the same thread
    one_off = ad.run(AgentTask(prompt="a task", workspace=str(tmp_path)))
    assert one_off.text == "turn 1 heard: a task" and one_off.session_id != r1.session_id
    c = links.probe("cx", ad, {}, None)                                                   # the heartbeat: no model call
    assert c.state == "online" and c.via == "app-server" and "plus" in c.detail
    assert c.quota["remaining"] == pytest.approx(0.7) and c.quota["source"] == "codex_live"


def test_a_conversation_stays_in_one_running_session_and_is_resumed_after_it_idles_out(tmp_path):
    ad = ClaudeLocal("cl", {"command": _script(tmp_path, "claude", FAKE_STREAM_CLI)})
    ask = lambda new: ad.run(AgentTask(prompt=f"history … {new}", workspace=str(tmp_path), meta={"conversation": "u:c", "new_text": new}))  # noqa: E731
    r1, r2 = ask("one"), ask("two")
    assert r1.ok and "msg 1" in r1.text and r1.text.endswith("history … one") and r1.data["via"] == "session"
    pid = r1.text.split()[1]
    assert r2.text == f"pid {pid} msg 2 resumed False: two"                                 # same process, only the new words
    assert links.StreamSession.reap(idle_s=0) == 1
    r3 = ask("three")
    assert r3.text.split()[1] != pid and "msg 1 resumed True: three" in r3.text           # a new process, same session id
    assert r3.session_id == r1.session_id
    plain = ad.run(AgentTask(prompt="no conversation", workspace=str(tmp_path)))           # tasks still run one-off
    assert plain.data.get("via") != "session"


def test_link_states_steer_routing_only_while_the_keeper_runs(rt):
    pool = AgentPool(rt)
    name = next(n for n, a in pool.adapters.items() if a.type == "llm")
    links.record(name, links.Check("login", "api", "key 无效"))
    assert pool.usable(name, 0)[0]                                                         # no keeper: never steered
    links._ACTIVE.set()
    ok, why = pool.usable(name, 0)
    assert not ok and "需要登录" in why
    links.record(name, links.Check("online", "api", "ok"))
    assert pool.usable(name, 0)[0] and links.ok_at(name) is not None


def test_the_keeper_tells_the_owner_once_when_a_link_drops(session_factory, session, user, policy, provider, backend, monkeypatch):
    user.preferences = {"owner": True}
    session.flush()
    make_rt = lambda s: Runtime(s, policy=policy, provider=provider, translation_backend=backend, channels={})  # noqa: E731
    k = links.Keeper(session_factory, make_rt)
    name = next(iter(AgentPool(make_rt(session)).adapters))
    seen = []
    monkeypatch.setattr(links, "probe", lambda n, ad, cfg, rt: seen.append(n) or links.Check("login", "session", "登录过期了"))
    assert k.check(name)["state"] == "login"
    k.check(name)                                                                          # still down: no second message
    notes = list(session.scalars(select(Notification).where(Notification.user_id == user.id)))
    assert len(notes) == 1 and name in notes[0].title_en and notes[0].dedupe_key == f"link:{name}:login"
    monkeypatch.setattr(links, "probe", lambda n, ad, cfg, rt: links.Check("online", "session", "ok"))
    assert k.check(name)["state"] == "online"
    assert len(list(session.scalars(select(Notification).where(Notification.user_id == user.id)))) == 1
    assert os.path.exists(links.state_file())
