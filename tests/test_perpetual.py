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
try:                                     # agents may run in parallel: a half-written counter is just a restart
    n = int(counter.read_text()) + 1
except (OSError, ValueError):
    n = 1
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
elif "Fold them together." in text:
    print(json.dumps({"answer": "综合：阈值 0.5 太低；另外两个样本指出时间窗也有影响。", "agreed": ["阈值太低"],
        "ideas": [{"idea": "按主题而不是全局设阈值", "from": [2]}], "evidence": [], "confidence": 0.7, "proposal": None, "follow_up": []}))
elif "Review them." in text:
    codes = sorted(set(re.findall(r"\n(P\d\d): ", text)))
    good = {"goal_alignment": 0.9, "evidence_strength": 0.9, "expected_gain": 0.9, "implementation_cost": 0.1,
            "regression_risk": 0.1, "reversibility": 0.9}
    print(json.dumps({"reviews": [{"id": c, "scores": good, "objections": [], "critical": False} for c in codes]}))
elif "Look back." in text:
    print(json.dumps({"summary": "阈值的问题已经查清，接下来看副作用。", "drop": [], "priorities": {}, "ask_user": "",
                      "shadows": {"A1": {"verdict": "promote", "why": "新的证据支持按主题设阈值"}, "A2": {"verdict": "drop", "why": "已被排除"}}}))
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
    t = eng.create(user, aim, proj, settings={"autonomy": "free", "auto_promote": False, "samples": 1})   # driven freely; one answer per question unless a test asks for more
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


def test_rest_stays_under_ten_percent_and_quota_pauses_then_rechecks(rt, user, setup):
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
    # a reset hours away is not slept through: it looks again after quota_recheck_s (another agent may free up)
    recheck = eng.cfg(t)["quota_recheck_s"]
    assert abs((t.next_at - datetime.now(timezone.utc)).total_seconds() - recheck) < 5 and t.pause_s >= recheck - 5
    assert t.rest_s <= 0.1 * t.work_s + 1e-9                                    # waiting for quota is not rest
    soon = datetime.now(timezone.utc) + timedelta(minutes=10)                   # a reset sooner than that: wait just for it
    eng.router.quota = lambda name: Quota(remaining=0.05, resets_at=soon.isoformat(), exhausted=False)
    t.next_at = None
    eng.cycle(t)
    assert abs((t.next_at - soon).total_seconds()) < 5


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


def test_an_implementation_interrupted_by_a_restart_is_retried_once(rt, user, setup):
    from pga.db.models import ProposalReview
    eng, t, aim, coding = setup
    svc = EvolutionService(rt, coding=coding)
    good = {"goal_alignment": 0.9, "evidence_strength": 0.9, "expected_gain": 0.9, "implementation_cost": 0.1, "regression_risk": 0.1, "reversibility": 0.9}
    p = ImprovementProposal(user_id=user.id, code="P01", title="One change", change="add a line", status="NEW", created_at=datetime.now(timezone.utc))
    rt.session.add(p)
    rt.session.flush()
    rnd = svc.start(user, trigger="perpetual", force=True, slate=[p])
    rt.session.add(ProposalReview(proposal_id=p.id, round_id=rnd.id, reviewer="t", scores=good, objections=[], critical=False,
                                  created_at=datetime.now(timezone.utc)))
    svc.step(rnd)                                           # control → implement
    ghost = AgentVersion(user_id=user.id, label="v1a", parent_id=svc.ensure_v0(user.id, datetime.now(timezone.utc)).id, proposal_id=p.id,
                         round_id=rnd.id, status="CANDIDATE", created_at=datetime.now(timezone.utc))   # what a restart leaves behind
    rt.session.add(ghost)
    rt.session.flush()
    svc.step(rnd)
    assert ghost.status == "FAILED" and ghost.note.startswith("interrupted")
    good_v = [v for v in rt.session.scalars(select(AgentVersion).where(AgentVersion.round_id == rnd.id)) if v.verification.get("ok")]
    assert len(good_v) == 1 and "+STEP_1" in good_v[0].patch


def test_a_busy_agent_is_passed_over_for_a_free_one(rt, user, setup):
    from pga.agents.pool import _slot
    eng, t, aim, _ = setup
    first, _ = eng.pick(aim, "researcher", 0.1, datetime.now(timezone.utc))
    s = _slot(first, 1)
    s.acquire()
    try:
        other, _ = eng.pick(aim, "researcher", 0.1, datetime.now(timezone.utc))
        assert other and other != first
    finally:
        s.release()


# ---------------------------------------------------------------- how free it is: free · checkpoint · driven


def test_driven_does_nothing_on_its_own(rt, user, setup):
    eng, t, aim, _ = setup
    t.settings = {**t.settings, "autonomy": "driven"}
    out = eng.cycle(t)
    assert out["action"] == "driven" and t.cycles == 0 and t.phase == "driven"
    assert eng.backlog_for(t) == []


def test_checkpoint_stops_reports_and_waits_for_your_decision(rt, user, setup):
    from pga.perpetual import approved
    eng, t, aim, _ = setup
    t.settings = {**t.settings, "autonomy": "checkpoint", "checkpoint_every": 2, "evolve": True}
    eng.cycle(t)
    eng.cycle(t)                                                                # two cycles of thinking …
    assert eng.since_checkpoint(t) == 2 and eng.pending_checkpoint(t) is None
    out = eng.cycle(t)                                                          # … then it stops and reports
    cp = eng.pending_checkpoint(t)
    assert out["action"] == "checkpoint" and cp is not None and cp.data["summary"] and t.phase == "checkpoint"
    cycles = t.cycles
    assert eng.cycle(t)["action"] == "checkpoint" and t.cycles == cycles        # nothing more until you decide
    props = eng.backlog(t.user_id)
    assert all(not approved(p) for p in props) and eng.backlog_for(t) == []    # nothing gets implemented unapproved
    codes = [p.code for p in props][:1]
    eng.resolve_checkpoint(t, cp, "adjust", text="先关注提问质量", text_en="Focus on question quality first", approve=codes)
    assert cp.status == "adjusted" and eng.pending_checkpoint(t) is None and eng.since_checkpoint(t) == 0
    assert [p.code for p in eng.backlog_for(t)] == codes                       # only what you approved may be built
    assert "Focus on question quality" in eng.team.context(aim)               # your words guide every next step
    eng.cycle(t)
    assert t.cycles == cycles + 1


def test_stopping_at_a_checkpoint_pauses_and_a_stale_checkpoint_cannot_be_reused(rt, user, setup):
    import pytest as _pt
    eng, t, aim, _ = setup
    t.settings = {**t.settings, "autonomy": "checkpoint", "checkpoint_every": 1}
    eng.cycle(t)
    eng.cycle(t)
    cp = eng.pending_checkpoint(t)
    eng.resolve_checkpoint(t, cp, "stop")
    assert t.status == "paused" and cp.status == "stopped"
    with _pt.raises(ValueError):
        eng.resolve_checkpoint(t, cp, "continue")


def test_r0_waits_for_you_unless_pgas_own_motivation_is_free(rt, user, setup, repo, monkeypatch):
    from pga.perpetual import self_autonomy
    monkeypatch.setattr("pga.evolution.coding.REPO", repo)                       # "PGA's own repository" in this test
    eng, t, aim, _ = setup
    assert self_autonomy(rt, user.id) == "free"
    t.settings = {**t.settings, "autonomy": "checkpoint"}
    assert self_autonomy(rt, user.id) == "checkpoint"


# ---------------------------------------------------------------- sharing the work out among agents


def test_allocation_formula_follows_your_weights_and_preferences(rt, user, setup):
    from pga.allocation import Allocation, clean, softmax
    eng, t, aim, _ = setup
    al = Allocation(eng)
    t.settings = {**t.settings, "alloc": {"prefs": {"gpt": 1.0, "claudeish": 0.0}, "w_pref": 3.0, "temperature": .2}}
    rows = {r["agent"]: r for r in al.table(t, aim, "researcher", "investigate")}
    assert rows["gpt"]["share"] > rows["claudeish"]["share"] and abs(sum(r["share"] for r in rows.values()) - 1) < 1e-6
    t.settings = {**t.settings, "alloc": {"prefs": {"gpt": 0.0, "claudeish": 1.0}, "w_pref": 3.0, "temperature": .2}}
    al = Allocation(eng)
    rows = {r["agent"]: r for r in al.table(t, aim, "researcher", "investigate")}
    assert rows["claudeish"]["share"] > rows["gpt"]["share"]
    assert clean({"parallel": 9, "w_perf": -1, "bogus": 1}) == {**clean({}), "parallel": 4, "w_perf": 0.0}
    assert softmax([1, 1], 1) == [.5, .5]


def test_parallel_research_answers_several_questions_with_different_agents(rt, user, setup):
    eng, t, aim, _ = setup
    eng.cycle(t)                                                                # think: questions to answer
    eng._add_questions(t, aim, [{"q": "Is the cache TTL too short for the dedupe index?", "why": "w", "kind": "code", "priority": .7}],
                       "gpt", "lead", datetime.now(timezone.utc))
    answered = lambda: len(eng.questions(t, ("answered",)))  # noqa: E731
    before = answered()
    assert len(eng.questions(t)) >= 2
    t.settings = {**t.settings, "alloc": {"parallel": 2}, "samples": 1}
    t.next_at = None
    out = eng.cycle(t)
    assert out["action"] == "investigate" and out["ok"], out
    assert len(set(out["agents"])) == 2 and answered() == before + 2              # two answered at once, by two agents
    assert "office" not in out["agents"]                                          # only agents that can research
    assert t.ledger[0]["agents"] == out["agents"]


def test_one_question_many_samples_folded_together(rt, user, setup):
    """多次生成: several agents answer the same question, prompts lightly disturbed, then one aggregator folds them."""
    eng, t, aim, _ = setup
    eng.cycle(t)                                                                # think: questions to answer
    t.settings = {**t.settings, "samples": 3, "perturb": 0.8, "fork": "always"}
    t.next_at = None
    out = eng.cycle(t)
    assert out["action"] == "investigate" and out["ok"], out
    assert "3 次生成" in out["summary"] and "1 个新想法" in out["summary"], out
    ans = rt.session.scalars(select(AimNote).where(AimNote.aim_id == aim.id, AimNote.kind == "answer")
                             .order_by(AimNote.created_at.desc())).first()
    d = ans.data
    assert ans.text.startswith("综合") and d["aggregated"] and len(d["samples"]) == 3
    assert d["samples"][0]["ops"] == ["anchor"] and all(s["ops"] != ["anchor"] for s in d["samples"][1:])   # sample 0 is the anchor
    assert 0.0 <= d["divergence"] <= 1.0 and d["ideas"][0]["from"] == [2]
    idea = rt.session.scalars(select(AimNote).where(AimNote.aim_id == aim.id, AimNote.kind == "insight")
                              .order_by(AimNote.created_at.desc())).first()
    assert idea.text == "按主题而不是全局设阈值" and idea.data["inspiration"]


def test_perturbation_keeps_the_question_last_and_the_anchor_untouched():
    import random

    from pga.sampling import divergence, perturb
    prompt = "board\n\nsnapshot\n\nopen\n\nfindings\n\n<question code=\"Q1\">\nwhy?\n</question>\nAnswer it."
    assert perturb("S", prompt, 0, random.Random(1), 1.0) == ("S", prompt, ["anchor"])
    s, p, ops = perturb("S", prompt, 1, random.Random(1), 1.0)
    assert s.startswith("S\n\nFor this answer:") and p.startswith("board\n\n") and p.endswith("</question>\nAnswer it.")
    assert "drop_context" in ops and p.count("\n\n") == prompt.count("\n\n") - 1
    assert divergence(["a b c", "a b c"]) == 0.0 and divergence(["a b c", "x y z"]) == 1.0


def test_fork_only_when_it_matters_and_keep_the_paths_not_taken():
    """P(fork) = f(U, D, I, C): an unsure, contested, important question gets several answers; a settled cheap one gets one."""
    from pga.sampling import clusters, fork_samples, fork_score
    hot, cold = fork_score(U=.7, D=.8, I=.9, C=.1), fork_score(U=.1, D=.1, I=.2, C=.8)
    assert hot > .6 and cold == 0.0 and fork_samples(hot, 5) >= 4 and fork_samples(cold, 5) == 1 and fork_samples(hot, 1) == 1
    g = clusters(["缓存 太 短 要 加长 TTL", "缓存 太 短 要 加长 TTL 到 一天", "完全 换成 事件 驱动 失效"])
    assert g == [[0, 1], [2]]


def test_reflection_revisits_the_shadow_paths(rt, user, setup):
    eng, t, aim, _ = setup
    for i, alt in enumerate(("A1", "A2")):
        eng.team._note(aim, "alternative", f"另一条路 {alt}", role="lead", agent="gpt", status="shadow",
                       data={"alt": alt, "assumption": "假设不同", "code": "Q1"})
    out = eng._reflect(t, aim, "critic", "claudeish", datetime.now(timezone.utc))
    assert out["ok"], out
    st = {(n.data or {}).get("alt"): n.status for n in eng.shadows(aim, ("shadow", "promoted", "dropped"))}
    assert st == {"A1": "promoted", "A2": "dropped"}
    promoted = rt.session.scalars(select(AimNote).where(AimNote.aim_id == aim.id, AimNote.kind == "insight")
                                  .order_by(AimNote.created_at.desc())).first()
    assert promoted.data["promoted"] == "A1" and "A1" in promoted.text
