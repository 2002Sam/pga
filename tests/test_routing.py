"""Dispatch across agents: category → preference × mode × remaining usage; the agent chat; long-term work."""

from __future__ import annotations

import json
import sys
from datetime import timedelta

import pytest

from pga.agents import AgentPool, quota
from pga.agents.routing import AgentRouter, classify
from pga.db.models import AgentRun
from pga.db.types import utcnow
from pga.llm.router import CURRENT_TASK, default_fake_reply

AGENT = r'''
import json, sys
label, prompt = sys.argv[1], sys.stdin.read()
if label == "limited":
    print("You've hit your usage limit. Try again later.", file=sys.stderr); sys.exit(1)
if '"beliefs"' in prompt or "Reply with JSON" in prompt:
    print(json.dumps({"beliefs": [], "by": label}) if label != "prose" else "Sure! Here are my thoughts in prose.")
else:
    print(f"{label} answered")
'''


@pytest.fixture
def cfg(tmp_path):
    script = tmp_path / "agent.py"
    script.write_text(AGENT)
    proc = lambda label, caps, t: {"adapter": "process", "command": [sys.executable, str(script), label], "capabilities": caps,  # noqa: E731
                                   "traits": t, "quota": {"source": "observed", "window_hours": 5, "window_runs": 10}}
    return {
        "agents": {"coder": proc("coder", ["code"], {"quality": 5, "speed": 3, "cost": 3}),
                   "thinker": proc("thinker", ["serious"], {"quality": 5, "speed": 2, "cost": 4}),
                   "prose": proc("prose", ["serious"], {"quality": 4, "speed": 4, "cost": 2}),
                   "office": proc("office", ["office"], {"quality": 4, "speed": 3, "cost": 2}),
                   "limited": proc("limited", ["serious"], {"quality": 5, "speed": 5, "cost": 1}),
                   "fast": {"adapter": "llm", "tier": 1, "capabilities": ["quick"], "traits": {"quality": 3, "speed": 5, "cost": 1}}},
        "workflows": {"general": {"pattern": "single", "agents": ["fast"]}},
        "routing": {"enabled": True, "mode": "performance", "long_tasks": True, "min_remaining": 0.1,
                    "categories": {"code": {"label": "代码", "prefer": ["coder", "thinker", "fast"]},
                                   "serious": {"label": "严肃问题", "prefer": ["thinker", "prose", "fast"]},
                                   "office": {"label": "办公", "prefer": ["office", "fast"]},
                                   "quick": {"label": "日常快速", "prefer": ["fast"]}},
                    "task_kinds": {"serious": ["synthesis"], "quick": ["translation"]}},
        "run": {"retries": 0, "max_backoff_s": 0, "daily_usd_cap": 5.0, "workspace_root": str(tmp_path / "ws")},
    }


def test_classify_by_kind_of_work():
    assert classify("这个 Python 函数为什么报错？```x=1```")[0] == "code"
    assert classify("帮我写一份周报，整理成表格")[0] == "office"
    assert classify("分析一下长期记忆的几种架构的利弊")[0] == "serious"
    assert classify("今天几号？")[0] == "quick"


def test_rank_follows_preference_then_mode_and_skips_exhausted(rt, user, provider, cfg):
    provider.handler = lambda s, m: "fast answered"
    r = AgentRouter(rt, AgentPool(rt, cfg))
    assert r.route("code")[0] == "coder" and r.route("office")[0] == "office" and r.route("quick") == ["fast"]
    assert r.route("serious")[:2] == ["thinker", "prose"]
    # economy mode: the cheaper "prose" overtakes the expensive "thinker"
    cfg["routing"]["mode"] = "economy"
    assert AgentRouter(rt, AgentPool(rt, cfg)).route("serious")[0] == "prose"
    cfg["routing"]["mode"] = "performance"
    # thinker used up its window (10 runs in 5 h) → it drops out with the reason
    for _ in range(10):
        rt.session.add(AgentRun(workflow="ask", pattern="single", step="run", agent="thinker", adapter="process", status="SUCCEEDED"))
    rt.session.flush()
    quota.clear()
    ranked = AgentRouter(rt, AgentPool(rt, cfg)).rank("serious")
    th = next(x for x in ranked if x["agent"] == "thinker")
    assert not th["usable"] and "剩余用量不足" in th["why_not"] and ranked[0]["agent"] == "prose"


def test_a_usage_limit_error_takes_the_agent_out_until_its_window_passes(rt, user, provider, cfg):
    provider.handler = lambda s, m: "fast answered"
    cfg["routing"]["categories"]["serious"]["prefer"] = ["limited", "prose", "fast"]
    r = AgentRouter(rt, AgentPool(rt, cfg))
    out = r.ask(user, "分析一下这个决策的风险")
    assert out["ok"] and out["agent"] == "prose" and [t["agent"] for t in out["tried"]] == ["limited", "prose"]
    quota.clear()
    q = AgentRouter(rt, AgentPool(rt, cfg)).quota("limited")
    assert q.exhausted and q.remaining == 0.0 and "用量上限" in q.detail
    assert "limited" not in AgentRouter(rt, AgentPool(rt, cfg)).route("serious")


def test_the_chat_can_name_an_agent_or_route_automatically(rt, user, provider, cfg):
    provider.handler = lambda s, m: "fast answered" if not s.startswith("You turn") else default_fake_reply("m", s, m)
    r = AgentRouter(rt, AgentPool(rt, cfg))
    auto = r.ask(user, "帮我起草一封会议邮件")
    assert auto["agent"] == "office" and auto["category"] == "office" and "办公 → office" in auto["why"]
    named = r.ask(user, "帮我起草一封会议邮件", agent="fast")
    assert named["agent"] == "fast" and named["text"] == "fast answered" and named["why"] == "你指定了 fast"
    quick = r.ask(user, "你好", history=[{"role": "user", "text": "hi"}, {"role": "assistant", "text": "hello"}])
    assert quick["agent"] == "fast"                    # PGA's own model gets the chat as real turns, not pasted text
    assert [(m["role"], m["content"]) for m in provider.calls[-1].messages] == [("user", "hi"), ("assistant", "hello"), ("user", "你好")]


def test_long_term_work_goes_to_the_routed_agent_and_falls_back(rt, user, provider, cfg):
    provider.handler = lambda s, m: json.dumps({"beliefs": [], "by": "pga-model"})
    r = AgentRouter(rt, AgentPool(rt, cfg))
    out = r.delegate("synthesis", 2, "Reply with JSON only.", [{"role": "user", "content": "evidence…"}], 800)
    assert json.loads(out.text)["by"] == "thinker" and out.provider == "thinker"
    assert r.delegate("translation", 1, "", [{"role": "user", "content": "x"}], 100) is None      # quick stays on our model
    # an agent that answers in prose where JSON is required is skipped; then our own model takes over (None)
    cfg["routing"]["categories"]["serious"]["prefer"] = ["prose", "fast"]
    assert AgentRouter(rt, AgentPool(rt, cfg)).delegate("synthesis", 2, "Reply with JSON only.", [{"role": "user", "content": "e"}], 800) is None
    logged = rt.session.query(AgentRun).filter(AgentRun.workflow == "task:synthesis", AgentRun.parent_id.is_(None)).all()
    assert {x.status for x in logged} == {"SUCCEEDED", "FAILED"}

    # wired into the LLM router: inside a "synthesis" run the call is routed, outside it is not
    rt.router.delegate = lambda kind, tier, system, messages, max_tokens: AgentRouter(rt, AgentPool(rt, cfg)).delegate(kind, tier, system, messages, max_tokens)
    cfg["routing"]["categories"]["serious"]["prefer"] = ["thinker", "fast"]
    token = CURRENT_TASK.set("synthesis")
    try:
        res = rt.router.complete(2, system="Reply with JSON only.", messages=[{"role": "user", "content": "e"}])
    finally:
        CURRENT_TASK.reset(token)
    assert res.provider == "thinker"
    assert rt.router.complete(2, system="Reply with JSON only.", messages=[{"role": "user", "content": "e"}]).provider == "fake"


def test_asking_inside_a_category_routes_by_that_category(rt, user, provider, cfg):
    provider.handler = lambda s, m: "fast answered"
    r = AgentRouter(rt, AgentPool(rt, cfg))
    out = r.ask(user, "你好", category="code")                     # a short greeting would be "quick" — the category wins
    assert out["category"] == "code" and out["agent"] == "coder" and "你在这一类里提问" in out["why"]
    with pytest.raises(ValueError):
        r.ask(user, "x", category="nope")


def test_past_conversations_are_rebuilt_per_card_from_the_ledger(rt, user, provider, cfg):
    from pga.agents import history
    provider.handler = lambda s, m: "fast answered"
    r = AgentRouter(rt, AgentPool(rt, cfg))
    r.ask(user, "第一问", agent="fast", conversation="agent:fast:c1")
    r.ask(user, "第二问", agent="fast", conversation="agent:fast:c1")
    old = r.ask(user, "以前的一问", agent="fast")                             # from before conversation ids
    r.ask(user, "别的卡片", conversation="cat:quick:z")
    convs = history.conversations(rt.session, user.id, "agent:fast")
    assert sorted(c["id"] for c in convs) == sorted(["agent:fast:c1", f"run:{old['run_id']}"])
    c1 = next(c for c in convs if c["id"] == "agent:fast:c1")
    assert c1["title"] == "第一问" and c1["turns"] == 2 and c1["agents"] == ["fast"] and c1["last"] == "fast answered"
    msgs = history.messages(rt.session, user.id, "agent:fast:c1")
    assert [(m["role"], m["text"]) for m in msgs] == [("user", "第一问"), ("agent", "fast answered"), ("user", "第二问"), ("agent", "fast answered")]
    assert [c["id"] for c in history.conversations(rt.session, user.id, "cat:quick")] == ["cat:quick:z"]
    assert history.messages(rt.session, user.id, f"run:{old['run_id']}")[0]["text"] == "以前的一问"


def test_you_can_pick_the_model_and_attach_pictures(rt, user, provider, cfg, tmp_path):
    import base64

    from pga.agents.options import options
    from pga.agents.routing import _save_images
    provider.handler = lambda s, m: "fine"
    pool = AgentPool(rt, cfg)
    opts = options("fast", pool.adapters["fast"], cfg["agents"]["fast"], rt)
    assert opts["images"] is False and opts["default_model"] and all(m["efforts"] == [] for m in opts["models"])
    r = AgentRouter(rt, pool)
    out = r.ask(user, "你好", agent="fast", model="fake-3")
    assert out["ok"] and out["model"] == "fake-3" and provider.calls[-1].model == "fake-3"        # the model you picked answered
    png = "data:image/png;base64," + base64.b64encode(b"\x89PNG\r\n\x1a\n" + b"0" * 20).decode()
    with pytest.raises(ValueError, match="不能看图片"):
        r.ask(user, "看看这张图", agent="fast", images=[{"name": "a.png", "data": png}])
    saved = _save_images([{"name": "shot one.png", "data": png}, {"name": "x", "data": "not an image"}], str(tmp_path))
    assert len(saved) == 1 and saved[0].endswith(".png") and "uploads" in saved[0]


def test_stop_keeps_what_was_said_and_nobody_takes_over(rt, user, provider, cfg, tmp_path):
    import threading
    import time as _t

    from pga.agents import live
    slow = tmp_path / "slow.py"
    slow.write_text("import sys, time\nsys.stdin.read()\nprint('part one', flush=True)\ntime.sleep(30)\nprint('never', flush=True)\n")
    cfg["agents"]["slow"] = {"adapter": "process", "command": [sys.executable, str(slow)], "capabilities": ["serious"]}
    cfg["routing"]["categories"]["serious"]["prefer"] = ["slow", "fast"]
    r = AgentRouter(rt, AgentPool(rt, cfg))
    out = {}
    th = threading.Thread(target=lambda: out.update(r.ask(user, "分析一下这个决策的风险")))
    t0 = _t.time()
    th.start()
    lid = None
    while _t.time() - t0 < 10 and not lid:
        lid = next((x["id"] for x in live.snapshot() if x["agent"] == "slow" and x["running"] and "part one" in x["text"]), None)
        _t.sleep(0.05)
    assert lid and live.stop(lid)
    th.join(15)
    assert out["stopped"] and out["agent"] == "slow" and "part one" in out["text"] and "never" not in out["text"]
    assert _t.time() - t0 < 12 and [t["agent"] for t in out["tried"]] == ["slow"]        # stopped, not handed to "fast"


def test_documents_are_read_here_and_go_with_the_question(rt, user, provider, cfg, tmp_path):
    import base64
    import zipfile

    from pga.agents.files import attachments_block, extract
    x = tmp_path / "t.xlsx"
    with zipfile.ZipFile(x, "w") as z:
        z.writestr("xl/sharedStrings.xml", '<sst xmlns="http://schemas.openxmlformats.org/spreadsheetml/2006/main"><si><t>城市</t></si><si><t>杭州</t></si></sst>')
        z.writestr("xl/worksheets/sheet1.xml", '<worksheet xmlns="http://schemas.openxmlformats.org/spreadsheetml/2006/main"><sheetData>'
                   '<row><c t="s"><v>0</v></c><c><v>42</v></c></row><row><c t="s"><v>1</v></c></row></sheetData></worksheet>')
    assert extract(x)[0].splitlines()[1:] == ["城市\t42", "杭州"]
    block, info = attachments_block([str(x)])
    assert "杭州" in block and info[0]["how"] == "xlsx"
    provider.handler = lambda s, m: "read it"
    note = "data:text/plain;base64," + base64.b64encode("会议在周三下午三点".encode()).decode()
    out = AgentRouter(rt, AgentPool(rt, cfg)).ask(user, "会议是什么时候？", agent="fast", files=[{"name": "notes.txt", "data": note}])
    assert out["ok"] and out["attachments"][0]["name"] == "notes.txt"
    assert "周三下午三点" in provider.calls[-1].messages[-1]["content"]          # the document's text went with the question


def test_translate_sends_english_and_brings_back_the_readers_language(rt, user, provider, cfg):
    agent_call = lambda s: "Reply in English; it is translated back" in s  # noqa: E731
    provider.handler = lambda s, m: "Here is the summary." if agent_call(s) else m[-1]["content"]
    out = AgentRouter(rt, AgentPool(rt, cfg)).ask(user, "你好", agent="fast", translate=True)
    asked = [c for c in provider.calls if agent_call(c.system)][-1]
    assert out["ok"] and out["sent"] == "Hello" and asked.messages[-1]["content"] == "Hello"                # the agent heard English
    assert out["original"] == "Here is the summary." and out["text"] == "以下是摘要。"                         # you read Chinese
    from pga.agents import history
    msgs = history.messages(rt.session, user.id, f"run:{out['run_id']}")
    assert msgs[0]["text"] == "你好" and msgs[1]["original"] == "Here is the summary." and msgs[1]["sent"] == "Hello"


def test_earlier_replies_can_be_translated_after_the_fact(session_factory, policy, provider, backend, monkeypatch):
    from fastapi.testclient import TestClient as _TC
    from pga.agents import routing
    from pga.api.app import create_app as _create
    from pga.runtime import Runtime as _RT
    calls = []

    def fake(rt, lang):
        def tr(piece):
            calls.append(piece)
            if "boom" in piece:
                raise RuntimeError("model down")
            return "译：" + piece
        return tr
    monkeypatch.setattr(routing, "_live_translator", fake)
    c = _TC(_create(session_factory, lambda s: _RT(s, policy=policy, provider=provider, translation_backend=backend)))
    uid = c.post("/v1/users", json={"locale": "zh-CN", "timezone": "Asia/Shanghai"}).json()["id"]
    long = "\n\n".join(["para " + "x" * 1400] * 4)                                   # ~5.6k chars → split into calls
    out = c.post(f"/v1/users/{uid}/agents/translate", json={"texts": ["Hello", "", long, "boom"]}).json()["texts"]
    assert out[0] == "译：Hello" and out[1] == ""                                   # empty stays empty, no call
    assert out[2].count("译：") == len([p for p in calls if p.startswith("para")]) >= 2
    assert out[3] == "boom"                                                       # a failed call leaves the original
    assert c.post(f"/v1/users/{uid}/agents/translate", json={"texts": []}).json() == {"texts": []}


def test_claude_codes_own_limit_message_is_understood_and_its_reset_time_kept(rt, user):
    from datetime import datetime, timedelta, timezone

    from pga.db.models import AgentRun
    at = datetime(2026, 10, 13, 12, 5, tzinfo=timezone.utc)                    # 20:05 in Shanghai
    rt.session.add(AgentRun(user_id=user.id, workflow="ask", pattern="single", step="answer", agent="claude-x", adapter="claude_local",
                            status="FAILED", prompt="q", started_at=at, finished_at=at,
                            error="You've hit your weekly limit · resets Oct 17 at 6pm (Asia/Shanghai)"))
    rt.session.flush()
    q = quota.observed(rt.session, "claude-x", now=at + timedelta(hours=6))
    assert q.exhausted and q.resets_at.startswith("2026-10-17T10:00")          # not just five hours
    assert not quota.observed(rt.session, "claude-x", now=datetime(2026, 10, 17, 10, 1, tzinfo=timezone.utc)).exhausted
    rt.session.add(AgentRun(user_id=user.id, workflow="ask", pattern="single", step="answer", agent="claude-x", adapter="claude_local",
                            status="SUCCEEDED", prompt="q", started_at=at + timedelta(hours=7), finished_at=at + timedelta(hours=7)))
    rt.session.flush()
    assert not quota.observed(rt.session, "claude-x", now=at + timedelta(hours=8)).exhausted   # it got through: the limit is gone
    assert quota.limit_resets("You've hit your session limit · resets 8:40pm (Asia/Shanghai)", at) == datetime(2026, 10, 13, 12, 40, tzinfo=timezone.utc)


def test_a_follow_up_in_auto_mode_stays_with_the_agent_that_answered(rt, user, provider, cfg):
    provider.handler = lambda s, m: "fast answered" if not s.startswith("You turn") else default_fake_reply("m", s, m)
    r = AgentRouter(rt, AgentPool(rt, cfg))
    first = r.ask(user, "帮我起草一封会议邮件", conversation="chat:sticky")
    assert first["agent"] == "office"
    again = AgentRouter(rt, AgentPool(rt, cfg)).ask(user, "再短一点", conversation="chat:sticky")
    assert again["agent"] == "office" and "接着这段对话上一轮的 office" in again["why"] and again["category"] == "office"
    other = AgentRouter(rt, AgentPool(rt, cfg)).ask(user, "再短一点", conversation="chat:elsewhere")
    assert other["agent"] != "office"                                        # a new conversation is routed afresh
    switch = AgentRouter(rt, AgentPool(rt, cfg)).ask(user, "这段 python 代码报错了怎么办", conversation="chat:sticky")
    assert switch["category"] == "code" and "接着" not in switch["why"]     # a different kind of question is routed by itself


@pytest.mark.parametrize('access,project_full,expected', [('full',False,'full'), ('read',True,'read_only'), ('auto',False,'auto')])
def test_conversation_permission_overrides_project_default(rt, user, cfg, tmp_path, monkeypatch, access, project_full, expected):
    from types import SimpleNamespace
    import uuid
    pool = AgentPool(rt, cfg)
    original = pool._call
    seen = []
    def call(name, task, *args, **kwargs):
        seen.append(task)
        return original(name, task, *args, **kwargs)
    monkeypatch.setattr(pool, '_call', call)
    project = SimpleNamespace(id=uuid.uuid4(), name='test', path=str(tmp_path), full_access=project_full, notes='', aim=None)
    result = AgentRouter(rt, pool).ask(user, 'write a file', agent='coder', project=project, access=access)
    assert result['ok']
    assert seen[0].permissions == expected
    assert ('You may read its files but not change them' in seen[0].system) == (access == 'read')


def test_native_session_catches_up_across_switches(rt, user, cfg, monkeypatch, tmp_path):
    from pga.agents import links
    monkeypatch.setenv('PGA_LINKS_FILE', str(tmp_path / 'links.json'))
    pool = AgentPool(rt, cfg)
    call = pool._call
    heard = []
    fail = [False]

    def native(name, task, *args, **kwargs):
        conv = task.meta['conversation']
        sid = links.session_for(name, conv)
        heard.append((name, links._resume_text(task, sid) if sid else task.prompt))
        step = call(name, task, *args, **kwargs)
        sid = sid or 'session-' + name
        links._put('sessions', name + '|' + conv, sid)
        step.result.session_id = sid
        if fail[0]:
            step.result.ok = False
            step.result.status = 'FAILED'
        return step

    monkeypatch.setattr(pool, '_call', native)
    def ask(name, text):
        # A new router represents a later HTTP request; no UI history is supplied.
        return AgentRouter(rt, pool).ask(user, text, agent=name, conversation='chat:handoff')

    assert ask('coder', 'initial plan')['ok']
    for i in range(8):
        assert ask('thinker', f'changed plan {i}')['ok']
    # Re-reading the persisted link state simulates process restart.
    links._LOADED.clear()
    assert ask('coder', 'continue now')['ok']
    assert all(f'changed plan {i}' in heard[-1][1] for i in range(8))
    assert 'initial plan' not in heard[-1][1]
    assert ask('coder', 'same agent')['ok']
    assert heard[-1][1] == 'same agent'
    assert ask('thinker', 'back again')['ok']
    assert 'continue now' in heard[-1][1] and 'same agent' in heard[-1][1]
    fail[0] = True
    assert not ask('coder', 'failed attempt')['ok']
    fail[0] = False
    assert ask('coder', 'retry')['ok']
    assert 'back again' in heard[-1][1]  # a failed delivery must not advance the checkpoint
    assert ask('coder', 'settled')['ok']
    assert heard[-1][1] == 'settled'


def test_legacy_native_session_replays_untruncated_history(rt, user, cfg, monkeypatch, tmp_path):
    from pga.agents import links
    monkeypatch.setenv('PGA_LINKS_FILE', str(tmp_path / 'links.json'))
    router = AgentRouter(rt, AgentPool(rt, cfg))
    text = 'x' * 4500 + 'important correction'
    router.ask(user, text, agent='coder', conversation='chat:legacy')
    conv = f'{user.id}:chat:legacy'
    links._put('sessions', 'coder|' + conv, 'old-session')
    catchup = router._resume_context(user, 'chat:legacy', 'coder', conv, 'continue')
    assert text in catchup['text']
    assert catchup['text'].endswith('Now the user says:\ncontinue')
    assert router._resume_context(user, 'chat:other', 'coder', f'{user.id}:chat:other', 'next') == {}


def test_native_steer_is_saved_with_answer_and_in_history(rt, user, cfg, monkeypatch):
    from pga.agents import live
    from pga.agents.base import AgentResult
    from pga.chats import history, runs_of, prompt_with_steering
    pool=AgentPool(rt,cfg)
    def run(task):
        lid=task.meta['live_id']
        live.bind_steering(lid,lambda text:{'turnId':'t'})
        live.steer(lid,f'{user.id}:chat:steer','supplement','保留这个补充')
        live.unbind_steering(lid)
        return AgentResult(ok=True,text='好的',status='SUCCEEDED')
    monkeypatch.setattr(pool.adapters['coder'],'run',run)
    result=AgentRouter(rt,pool).ask(user,'最初的问题',agent='coder',conversation='chat:steer')
    assert result['ok']
    saved=runs_of(rt,user.id,'chat:steer')[0]
    assert saved.data['steering'][0]['text']=='保留这个补充'
    assert saved.prompt=='最初的问题'
    assert '[运行中补充]\n保留这个补充' in prompt_with_steering(saved)
    assert '保留这个补充' in history(rt,user,'chat:steer')[0]['text']
