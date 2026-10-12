"""Perpetual tasks: pressure picks the work, rest stays under 10%, quota pauses it, evolution stacks on a line."""

from __future__ import annotations

import json
import re
import subprocess
import sys
from datetime import datetime, timedelta, timezone
from pathlib import Path

import pytest
from sqlalchemy import select

from pga.agents.pool import AgentPool
from pga.agents.quota import Quota
from pga.aims import AimService
from pga.db.models import AgentVersion, AimNote, ImprovementProposal, Project
from pga.evolution import CodingAgent, EvolutionService
from pga.evolution.coding import SuiteResult
from pga.perpetual import Perpetual, alike

AGENT = r'''
import json, pathlib, re, sys
text = sys.stdin.read()
counter = pathlib.Path(__file__).with_name("n.txt")
n = int(counter.read_text()) + 1 if counter.exists() else 1
counter.write_text(str(n))
topics = ["去重阈值 0.5 太低会重复研究吗", "研究冷却时间多久合适", "通知每天发几次才不打扰", "翻译缓存命中率怎样",
          "给用户预留多少额度", "调度先后次序对不对", "失败以后该不该重试", "图谱什么时候刷新"]
if "Ask the next questions." in text:
    print(json.dumps({"questions": [
        {"q": topics[n % 8] + "？", "why": "浪费额度", "kind": "code", "priority": 0.9},
        {"q": "你最希望它先在哪方面变强？", "why": "方向只有你能定", "kind": "user", "priority": 0.6}],
        "insight": "去重发生得太晚"}))
elif "Answer it." in text:
    print(json.dumps({"answer": "是的：dedupe.py 把阈值写死成 0.5。", "evidence": ["src/pga/dedupe.py:1"], "confidence": 0.8,
        "proposal": {"title": ["Raise dedupe threshold", "Shorten research cooldown", "Batch notifications daily", "Cache translations longer",
                               "Reserve quota for user", "Reorder dispatch fallbacks", "Retry failed runs once", "Refresh graph lazily"][n % 8],
                     "change": "raise THRESHOLD",
                     "files": ["src/pga/dedupe.py"], "evaluation_plan": "a test"},
        "follow_up": [{"q": ["误合并", "冷启动", "漏通知", "缓存过期", "抢额度", "绕远路", "雪崩", "卡顿"][n % 8] + "风险呢？", "why": "副作用", "kind": "code", "priority": 0.7}]}))
elif "Review them." in text:
    codes = sorted(set(re.findall(r"\n(P\d\d): ", text)))
    good = {"goal_alignment": 0.9, "evidence_strength": 0.9, "expected_gain": 0.9, "implementation_cost": 0.1,
            "regression_risk": 0.1, "reversibility": 0.9}
    print(json.dumps({"reviews": [{"id": c, "scores": good, "objections": [], "critical": False} for c in codes]}))
elif "Look back." in text:
    print(json.dumps({"summary": "阈值的问题已经查清，接下来看副作用。", "drop": [], "priorities": {}, "ask_user": ""}))
else:
    print("{}")
'''


@pytest.fixture
def cfg(tmp_path):
    script = tmp_path / "agent.py"
    script.write_text(AGENT)
    proc = lambda label, caps: {"adapter": "process", "command": [sys.executable, str(script), label], "capabilities": caps,  # noqa: E731
                                "traits": {"quality": 4, "speed": 3, "cost": 2}, "quota": {"source": "observed", "window_hours": 5, "window_runs": 500}}
    return {
        "agents": {"gpt": proc("gpt", ["serious", "plan", "research"]), "claudeish": proc("claudeish", ["review", "serious", "research"]),
                   "office": proc("office", ["office", "write"])},
        "workflows": {"general": {"pattern": "single", "agents": ["gpt"]}},
        "routing": {"enabled": True, "mode": "performance", "long_tasks": True, "min_remaining": 0.1,
                    "categories": {"serious": {"label": "严肃", "prefer": ["gpt", "claudeish"]}, "office": {"label": "办公", "prefer": ["office"]}}},
        "run": {"retries": 0, "max_backoff_s": 0, "daily_usd_cap": 5.0, "workspace_root": str(tmp_path / "ws")},
    }


@pytest.fixture
def repo(tmp_path):
    root = tmp_path / "pga"
    (root / "src" / "pga").mkdir(parents=True)
    (root / "src" / "pga" / "dedupe.py").write_text("THRESHOLD = 0.5\n")
    g = ["git", "-c", "user.name=t", "-c", "user.email=t@t"]
    subprocess.run(["git", "init", "-q"], cwd=root, check=True)
    subprocess.run(g + ["add", "-A"], cwd=root, check=True)
    subprocess.run(g + ["commit", "-qm", "init"], cwd=root, check=True)
    return root


def stacking_cli(cmd, input, cwd, **kw):
    """Each implementation adds one line, so a stacked worktree already has the lines before it."""
    f = Path(cwd) / "src" / "pga" / "dedupe.py"
    n = f.read_text().count("STEP")
    f.write_text(f.read_text() + f"STEP_{n + 1} = True\n")
    return subprocess.CompletedProcess(cmd, 0, stdout=json.dumps({"result": f"step {n + 1}"}), stderr="")


@pytest.fixture
def setup(rt, user, cfg, repo, tmp_path, monkeypatch):
    user.preferences = {**(user.preferences or {}), "owner": True}       # evolution is the owner's (one codebase)
    aim = AimService(rt.session).create(user, "让这个项目能不断思考，提出问题，自我进化", "Keep this project thinking, asking and evolving")
    proj = Project(user_id=user.id, name="PGA", path=str(repo), created_at=datetime.now(timezone.utc))
    rt.session.add(proj)
    rt.session.flush()
    coding = CodingAgent(repo=repo, root=tmp_path / "wt", run_cli=stacking_cli, run_tests=lambda p: SuiteResult(passed=10, ok=True))
    eng = Perpetual(rt, AgentPool(rt, cfg), coding=coding)
    t = eng.create(user, aim, proj)
    return eng, t, aim, coding


def kinds(rt, aim):
    return [n.kind for n in rt.session.scalars(select(AimNote).where(AimNote.aim_id == aim.id).order_by(AimNote.created_at))]


def test_alike_handles_chinese():
    assert alike("去重阈值 0.5 是不是太低？", "去重阈值0.5是否太低")
    assert not alike("去重阈值是不是太低？", "用户最想要什么功能？")


def test_pressure_picks_the_work_and_the_team_answers_and_proposes(rt, user, setup):
    eng, t, aim, _ = setup
    m = eng.measure(t, datetime.now(timezone.utc))
    assert m["choice"] == "think" and m["parts"]["investigate"] == 0.0           # nothing open: hunger for questions
    out = eng.cycle(t)
    assert out["action"] == "think" and out["ok"], out
    qs = eng.questions(t, ("open", "for_you"))
    assert [q.status for q in qs] == ["open", "for_you"]                         # the user question waits for you
    assert eng.measure(t, datetime.now(timezone.utc))["choice"] == "investigate"
    out = eng.cycle(t)
    assert out["action"] == "investigate" and "P01" in out["summary"], out
    p = rt.session.scalar(select(ImprovementProposal).where(ImprovementProposal.user_id == user.id))
    assert p.status == "NEW" and p.proposer.startswith("perpetual:")
    assert "answer" in kinds(rt, aim) and len(eng.questions(t)) == 1             # the follow-up question is open now
    assert eng.measure(t, datetime.now(timezone.utc))["choice"] == "evolve"      # a proposal waits: evolution pulls hardest
    assert t.rest_s <= 0.1 * t.work_s + 1e-9


def test_evolution_stacks_on_the_line_and_promotion_brings_the_line(rt, user, setup, repo):
    eng, t, aim, coding = setup
    svc = EvolutionService(rt, coding=coding)
    labels = []
    for _ in range(2):                                    # two rounds, each from a fresh finding
        for _ in range(6):
            out = eng.cycle(t)
            if out["action"] == "evolve":
                break
        assert out["action"] == "evolve" and out["ok"], out
        from pga.evolution.motivation import open_round
        rnd = open_round(rt, user.id)
        assert rnd.trigger == "perpetual" and rnd.phase == "control"
        for _ in range(6):
            if rnd.phase in ("done", "stopped"):
                break
            svc.step(rnd)
        assert rnd.phase == "done", rnd.log
        labels.append([v.label for v in svc.line(user.id)])
    line = svc.line(user.id)
    assert len(line) >= 2 and line[1].parent_id == line[0].id                    # stacked, not side by side
    assert "+STEP_1" not in line[1].patch and "+STEP_2" in line[1].patch          # only its own change
    assert "STEP" not in (repo / "src/pga/dedupe.py").read_text()                # live code untouched
    eng_out = eng.out(t)
    assert [x["label"] for x in eng_out["line"]] == [v.label for v in line]
    top = line[-1]
    svc.promote(top)
    live = (repo / "src/pga/dedupe.py").read_text()
    assert all(f"STEP_{i + 1}" in live for i in range(len(line)))               # everything below came along
    assert line[0].status == "SUPERSEDED" and top.status == "CANARY"


def test_rest_stays_under_ten_percent_and_quota_pauses_until_reset(rt, user, setup):
    eng, t, aim, _ = setup
    t.settings = {**t.settings, "evolve": False}
    for _ in range(5):
        eng.cycle(t)
    assert t.cycles == 5 and t.rest_s <= 0.1 * t.work_s + 1e-9
    reset = datetime.now(timezone.utc) + timedelta(hours=2)
    eng.router.quota = lambda name: Quota(remaining=0.05, resets_at=reset.isoformat(), exhausted=False)   # all below the 10% reserve
    t.next_at = None
    out = eng.cycle(t)
    assert out["action"] == "quota" and t.phase == "quota"
    assert abs((t.next_at - reset).total_seconds()) < 5 and t.pause_s > 7000
    assert t.rest_s <= 0.1 * t.work_s + 1e-9                                    # waiting for quota is not rest


def test_you_answer_its_question_and_the_answer_becomes_guidance(rt, user, setup):
    eng, t, aim, _ = setup
    eng.cycle(t)
    q = eng.questions(t, ("for_you",))[0]
    c = eng.answer(t, q, "先让它更会提问题", "Make it better at asking questions first")
    assert q.status == "answered" and c.kind == "correction" and "Q" in c.text
    assert "Make it better at asking" in eng.team.context(aim)


def test_a_round_with_two_accepted_proposals_implements_both_and_a_stalled_round_is_revived(rt, user, setup):
    """Regression: the second "implement" step used the same dedupe key as the job running it and was swallowed."""
    from pga.db.models import ProposalReview
    from pga.workflow.worker import HANDLERS
    eng, t, aim, coding = setup
    rt.coding = coding                                   # the worker's handler must use the stand-in, never the real repo
    svc = EvolutionService(rt, coding=coding)
    good = {"goal_alignment": 0.9, "evidence_strength": 0.9, "expected_gain": 0.9, "implementation_cost": 0.1, "regression_risk": 0.1, "reversibility": 0.9}
    ps = [ImprovementProposal(user_id=user.id, code=f"P0{i}", title=title, change="add a line", files=["src/pga/dedupe.py"], status="NEW",
                              created_at=datetime.now(timezone.utc)) for i, title in ((1, "First small change"), (2, "Second different improvement"))]
    rt.session.add_all(ps)
    rt.session.flush()
    rnd = svc.start(user, trigger="perpetual", force=True, slate=ps)
    for p in ps:
        rt.session.add(ProposalReview(proposal_id=p.id, round_id=rnd.id, reviewer="t", scores=good, objections=[], critical=False,
                                      created_at=datetime.now(timezone.utc)))
    rt.session.flush()
    for _ in range(8):                                     # the worker: claim → run → complete
        jobs = rt.workflow.claim("w", limit=1)
        if not jobs:
            break
        out = HANDLERS[jobs[0].kind](rt, jobs[0], datetime.now(timezone.utc))
        rt.workflow.complete(jobs[0], out or {})
    assert rnd.phase == "done", rnd.log
    assert sorted(v.label for v in rt.session.scalars(select(AgentVersion).where(AgentVersion.round_id == rnd.id))) == ["v1a", "v2a"]

    stuck = svc.start(user, trigger="perpetual", force=True, slate=[])  # an open round whose job got lost
    stuck.phase = "control"
    for j in rt.workflow.claim("w", limit=5):
        rt.workflow.complete(j, {})
    assert svc.revive(user.id) is None                                   # not stale yet
    later = datetime.now(timezone.utc) + timedelta(minutes=30)
    assert svc.revive(user.id, later) is stuck and rt.workflow.claim("w", limit=1, now=later)
