"""Agent links: the Codex app server, kept-alive sessions, link states and the keeper (stand-in processes, no network)."""

from __future__ import annotations

import os
import stat
import sys
import textwrap

import pytest
from sqlalchemy import select

from pga.agents import links
from pga.agents.adapters import ClaudeLocal, CodexLocal, Process
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


@pytest.mark.parametrize("name", ["chatgpt", "codex"])
def test_default_codex_pool_runs_four_isolated_conversations(tmp_path, monkeypatch, name):
    import threading
    import uuid
    from concurrent.futures import ThreadPoolExecutor

    from pga.agents import live, pool

    # Keep the real pool, adapter and thread/event routing; replace only the RPC peer.
    srv = links.CodexServer(name, [], {})
    turns = {}
    lock = threading.Lock()

    def complete_together():
        # Interleave messages from all four threads before any of them completes.
        for tid, prompt in turns.items():
            srv._notify({"method": "item/agentMessage/delta", "params": {"threadId": tid, "delta": prompt}})
        for tid in reversed(list(turns)):
            srv._notify({"method": "turn/completed", "params": {"threadId": tid, "turn": {"status": "completed"}}})

    ready = threading.Barrier(4, action=complete_together)

    class Peer:
        def request(self, method, params, timeout):
            if method == "thread/start":
                return {"thread": {"id": uuid.uuid4().hex}}
            assert method == "turn/start"
            tid = params["threadId"]
            with lock:
                turns[tid] = params["input"][0]["text"]
            ready.wait(timeout=3)  # fails if a single global slot serializes the windows
            return {"turn": {"id": tid}}

    srv.rpc = Peer()
    monkeypatch.setattr(links.CodexServer, "get", classmethod(lambda cls, ad, full=False: srv))
    p = AgentPool(None)
    with ThreadPoolExecutor(max_workers=4) as workers:
        futures = [workers.submit(p._call, name, AgentTask(prompt=f"window-{i}", workspace=str(tmp_path),
                    timeout_s=5, meta={"conversation": f"parallel-{i}"}), "test") for i in range(4)]
        results = [f.result(timeout=8).result for f in futures]
    assert all(r.ok and r.data["via"] == "app-server" for r in results)
    assert len({r.session_id for r in results}) == 4
    for i, r in enumerate(results):
        assert r.text.endswith(f"window-{i}")
        assert all(f"window-{j}" not in r.text for j in range(4) if j != i)
        assert live.text(r.data["live_id"]).strip() == r.text
        assert links.thread_for(name, f"parallel-{i}") == r.session_id
    assert not srv.listeners
    assert not pool.busy(name, 4)


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


def test_stream_session_applies_changed_turn_limit_on_resume(tmp_path):
    ad = ClaudeLocal("cl", {"command": _script(tmp_path, "claude", FAKE_STREAM_CLI)})
    task = AgentTask(prompt="first", workspace=str(tmp_path), max_turns=40, meta={"conversation": "u:limits"})
    first = ad.run(task)
    task.max_turns = 400
    task.meta["new_text"] = "second"
    second = ad.run(task)
    assert first.ok and second.ok and first.session_id == second.session_id
    assert first.text.split()[1] != second.text.split()[1]
    assert "msg 1 resumed True: second" in second.text
    assert links.StreamSession._ALL["cl|u:limits"].max_turns == 400


def test_stream_conversations_keep_replies_separate(tmp_path):
    from concurrent.futures import ThreadPoolExecutor

    ad = ClaudeLocal("cl", {"command": _script(tmp_path, "claude", FAKE_STREAM_CLI)})

    def ask(conv):
        return ad.run(AgentTask(prompt=conv, workspace=str(tmp_path), meta={"conversation": conv}))

    with ThreadPoolExecutor(max_workers=2) as workers:
        results = list(workers.map(ask, ["first-window", "second-window"]))
    assert all(r.ok for r in results)
    assert results[0].session_id != results[1].session_id
    assert results[0].text.endswith(": first-window")
    assert results[1].text.endswith(": second-window")


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


def test_codex_records_native_compaction_without_starting_another_thread(tmp_path):
    events = '''
        if "compact-me" in p["input"][0]["text"]:
            for method in ("item/started", "item/completed"):
                send({"method": method, "params": {"threadId": tid, "turnId": turn, "item": {"type": "contextCompaction", "id": "compact"}}})
'''
    script = FAKE_APP_SERVER.replace('        reply = ', events + '        reply = ', 1)
    ad = CodexLocal("cx", {"command": _script(tmp_path, "codex-compact", script)})
    first = ad.run(AgentTask(prompt="compact-me", workspace=str(tmp_path), meta={"conversation": "compact-test"}))
    assert first.ok and first.data["compaction"] == {"status": "completed"}
    second = ad.run(AgentTask(prompt="next", workspace=str(tmp_path), meta={"conversation": "compact-test", "new_text": "next"}))
    assert second.ok and second.session_id == first.session_id
    assert "compaction" not in second.data  # previous compression is not a permanent status


def test_codex_exec_honors_selected_model_and_effort(tmp_path):
    ad = CodexLocal("cx", {"model": "old-model", "reasoning": "low"})
    task = AgentTask(prompt="hello", workspace=str(tmp_path), meta={"model": "chosen-model", "effort": "high"})
    cmd = ad.command(task, "codex")
    assert cmd[cmd.index("-m") + 1] == "chosen-model"
    assert 'model_reasoning_effort="high"' in cmd
    assert 'model_reasoning_effort="low"' not in cmd


def test_claude_native_tool_request_waits_for_pga_response(tmp_path):
    from concurrent.futures import ThreadPoolExecutor
    import time
    from pga.agents import live, approvals
    from pga.agents.base import AUTO
    body = FAKE_STREAM_CLI.replace('    out = ', '''    print(json.dumps({"type":"control_request","request_id":"approval-1","request":{"subtype":"can_use_tool","tool_name":"Write","input":{"file_path":"notes.txt","content":"test"}}}),flush=True)
    response = json.loads(sys.stdin.readline())
    assert response["type"] == "control_response"
    assert response["response"]["request_id"] == "approval-1"
    assert response["response"]["response"]["behavior"] == "allow"
    out = ''', 1)
    ad = ClaudeLocal('approval-claude', {'command':_script(tmp_path,'claude-approval',body)})
    lid = live.start(ad.name,tags={'conversation':'user:chat:approval'})
    task = AgentTask(prompt='test',workspace=str(tmp_path),permissions=AUTO,timeout_s=5,
                     meta={'conversation':'user:chat:approval','live_id':lid})
    with ThreadPoolExecutor() as pool:
        f = pool.submit(ad.run,task)
        for _ in range(100):
            row = next(x for x in live.snapshot() if x['id']==lid)
            if row.get('approval'): break
            time.sleep(.01)
        assert row.get('approval') and not f.done()
        approvals.answer(row['approval']['id'],'user','allow')
        assert f.result(timeout=3).ok
    live.finish(lid,True)


def test_codex_turn_overrides_sandbox_and_folder_after_permission_changes(tmp_path):
    import json
    from pga.agents.base import AUTO, FULL, READ_ONLY
    peer = FAKE_APP_SERVER.replace(
        'reply = "turn %d heard: %s" % (threads[tid], p["input"][0]["text"])',
        'reply = json.dumps({k: p.get(k) for k in ("sandboxPolicy", "cwd", "approvalPolicy")})')
    ad = CodexLocal("permission-test", {"command": _script(tmp_path, "codex-access", peer)})
    seen = []
    for i, perm in enumerate((READ_ONLY, FULL, AUTO, READ_ONLY)):
        folder = tmp_path / str(i)
        folder.mkdir()
        result = ad.run(AgentTask(prompt="check", workspace=str(folder), permissions=perm,
                                 meta={"conversation": "u:permissions"}))
        assert result.ok, result.error
        seen.append(json.loads(result.text))
        assert seen[-1]["cwd"] == str(folder)
    assert [r["sandboxPolicy"]["type"] for r in seen] == ["readOnly", "dangerFullAccess", "workspaceWrite", "readOnly"]
    assert seen[2]["sandboxPolicy"]["writableRoots"] == [str(tmp_path / "2")]
    assert [r["approvalPolicy"] for r in seen] == ["never", "never", "on-request", "never"]


def test_codex_command_output_arrives_before_completion(tmp_path):
    from pga.agents import live
    script = FAKE_APP_SERVER.replace('        reply = ', '''        send({"method":"item/started","params":{"threadId":tid,"turnId":turn,"item":{"type":"commandExecution","id":"cmd","command":"echo hello"}}})
        send({"method":"item/commandExecution/outputDelta","params":{"threadId":tid,"turnId":turn,"itemId":"cmd","delta":"hello\\n"}})
        send({"method":"item/completed","params":{"threadId":tid,"turnId":turn,"item":{"type":"commandExecution","id":"cmd","command":"echo hello","exitCode":0}}})
        reply = ''')
    lid = live.start('stream-test')
    try:
        ad = CodexLocal('stream-test', {'command': _script(tmp_path, 'stream-peer', script)})
        result = ad.run(AgentTask(prompt='test', workspace=str(tmp_path), meta={'conversation':'stream:test','live_id':lid}))
        assert result.ok, result.error
        row = next(x for x in live.snapshot() if x['id'] == lid)
        assert row['steps'][0]['output'] == 'hello\n'
        assert row['steps'][0]['secs'] is not None
        assert '\nhello\n' not in row['text']
    finally:
        live.finish(lid, True)


def test_resume_context_is_bound_to_native_session():
    task = AgentTask(prompt='fresh history', meta={'new_text': 'question',
                     'resume_context': {'session': 'old', 'text': 'missed turns plus question'}})
    assert links._resume_text(task, 'old') == 'missed turns plus question'
    assert links._resume_text(task, 'new') == 'fresh history'


@pytest.mark.parametrize('adapter,script', [(CodexLocal, FAKE_APP_SERVER), (ClaudeLocal, FAKE_STREAM_CLI)])
def test_native_transport_delivers_catchup_after_restart(tmp_path, adapter, script):
    ad = adapter('handoff', {'command': _script(tmp_path, 'agent', script)})
    first = ad.run(AgentTask(prompt='first', workspace=str(tmp_path), meta={'conversation': 'u:handoff'}))
    assert first.ok
    links.CodexServer.close_all()
    links.StreamSession.close_all()
    task = AgentTask(prompt='recent history', workspace=str(tmp_path), meta={
        'conversation': 'u:handoff', 'new_text': 'continue',
        'resume_context': {'session': first.session_id, 'text': 'other agent changed plan\ncontinue'}})
    reply = ad.run(task)
    assert reply.ok and reply.session_id == first.session_id
    assert reply.text.endswith('other agent changed plan\ncontinue')


@pytest.mark.parametrize('adapter,script,marker', [
    (CodexLocal, FAKE_APP_SERVER, '        reply = '),
    (ClaudeLocal, FAKE_STREAM_CLI, '    out = '),
    (Process, 'import sys\nreply = sys.stdin.read()\nprint(reply)\n', 'print(reply)'),
])
@pytest.mark.parametrize('mode', ['conversation', 'bounded', 'stop'])
def test_long_conversations_complete_and_remain_stoppable(tmp_path, adapter, script, marker, mode):
    from pga.agents import live

    # Delay the fake agent beyond a tiny deadline instead of waiting 15 minutes.
    script = script.replace(marker, marker[:len(marker) - len(marker.lstrip())] +
                            '__import__("time").sleep(0.15)\n' + marker)
    ad = adapter('long-reply', {'command': _script(tmp_path, 'slow-agent', script)})
    lid = live.start('long-reply')
    meta = {'live_id': lid}
    if mode != 'bounded':
        meta['conversation'] = 'u:long-reply'
    task = AgentTask(prompt='finish naturally', workspace=str(tmp_path), timeout_s=0.01, meta=meta)
    if mode == 'stop':
        live.stop(lid)
    result = ad.run(task)
    if mode == 'bounded':
        assert result.status == 'TIMEOUT'
    elif mode == 'stop':
        assert result.status == 'STOPPED'
    else:
        assert result.ok and 'finish naturally' in result.text
        assert '秒内没有完成' not in live.text(lid)
