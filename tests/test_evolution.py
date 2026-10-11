"""Motivation Forward, R0 and the bounded Evolution Round (Motivation_Evolution_Architecture.md)."""

from __future__ import annotations

import json
import subprocess
from datetime import datetime, timedelta, timezone

import pytest
from sqlalchemy import select

from pga.db.models import User, AgentVersion, ImprovementProposal, MotivationDecision, ProposalReview, Run
from pga.db.types import Origin, ResponsibilityStatus as S, RunStatus
from pga.evolution import CodingAgent, EvolutionService, r0_state, r0_tick
from pga.evolution.coding import SuiteResult
from pga.llm import FakeProvider
from pga.runtime import Runtime
from pga.tension import IncomingEvidence, Signals
from pga.workflow.worker import HANDLERS

T0 = datetime(2026, 10, 1, 9, 0, tzinfo=timezone.utc)


def brain_factory(script: dict[str, object]):
    """Reply by system-prompt marker; each value is a dict (JSON) or a callable(system, messages) -> str."""
    def brain(system, messages):
        for marker, reply in script.items():
            if marker in system:
                return reply(system, messages) if callable(reply) else json.dumps(reply)
        from pga.llm.router import default_fake_reply
        return default_fake_reply("m", system, messages)
    return brain


@pytest.fixture
def make(policy, backend):
    def build(session, script):
        policy.motivation.enabled = True
        return Runtime(session, policy=policy, provider=FakeProvider(handler=brain_factory(script)), translation_backend=backend)
    return build


def awake(rt, user):
    r = rt.responsibilities.create(user_id=user.id, title_en="world model research", keywords=["world model"], actor=Origin.USER)
    rt.tension.ingest(user.id, IncomingEvidence(text="New benchmark contradicts world model sim-to-real claims",
                                                source_uri="https://news.example.com/a",
                                                signals={r.id: Signals(relevance=0.9, contradiction=1.0, decision_impact=0.9)}), now=T0)
    assert r.status == S.ACTIVE
    return r


# ---------------------------------------------------------------- Motivation Forward


def test_motivation_forward_can_decide_that_work_is_not_worth_it(session, user, make):
    rt = make(session, {"Motivation Forward of a long-lived": {"decision": "MONITOR", "marginal_value": 0.1, "aligned": True,
                                                               "reason": "the new benchmark repeats last week's result"}})
    r = awake(rt, user)
    job = rt.workflow.enqueue("responsibility.research", user_id=user.id, responsibility_id=r.id, now=T0)
    out = HANDLERS["responsibility.research"](rt, job, T0)
    assert out["decision"] == "MONITOR" and out["stop"] is True
    assert r.status == S.MONITORING                                           # no research happened
    d = session.scalar(select(MotivationDecision).where(MotivationDecision.responsibility_id == r.id))
    assert d.decision == "MONITOR" and not d.fallback and "benchmark" in d.answers["reason"]
    assert not session.scalar(select(Run).where(Run.responsibility_id == r.id, Run.kind == "synthesis"))


def test_motivation_forward_falls_back_to_rules_when_the_model_fails(session, user, make):
    rt = make(session, {"Motivation Forward of a long-lived": lambda s, m: "not json at all",
                        "PGA_RESEARCH_SYNTHESIS": {"beliefs": [], "communicate": {"kind": "SILENT"}, "next": {"state": "monitor"}}})
    r = awake(rt, user)
    job = rt.workflow.enqueue("responsibility.research", user_id=user.id, responsibility_id=r.id, now=T0)
    out = HANDLERS["responsibility.research"](rt, job, T0)
    assert out["forward"]["decision"] == "DEEP_RESEARCH" and out["forward"]["fallback"] is True   # pending events → research


def test_ask_user_parks_the_responsibility_and_asks(session, user, make):
    rt = make(session, {"Motivation Forward of a long-lived": {"decision": "ASK_USER", "question": "Track sim-to-real too?",
                                                               "reason": "scope question"}})
    r = awake(rt, user)
    job = rt.workflow.enqueue("responsibility.research", user_id=user.id, responsibility_id=r.id, now=T0)
    assert HANDLERS["responsibility.research"](rt, job, T0)["stop"]
    assert r.status == S.WAIT_USER


# ---------------------------------------------------------------- R0 tension


def _runs(session, user, n, status, now, kind="synthesis"):
    for i in range(n):
        session.add(Run(user_id=user.id, kind=kind, category="active_responsibilities", proactive=True, status=status,
                        started_at=now - timedelta(hours=i + 1), ended_at=now - timedelta(hours=i + 1) + timedelta(seconds=30),
                        error="tool timeout" if status == RunStatus.FAILED else None))
    session.flush()


def test_r0_tension_rises_only_for_measured_problems_and_explains_why(session, user, make):
    rt = make(session, {})
    rt.policy.evolution.r0_idle_drift_per_day = 0                                 # problem signals only (drift: next test)
    st = r0_tick(rt, user.id, T0)
    assert st.tension == 0.0                                                  # no data → no pressure
    _runs(session, user, 3, RunStatus.FAILED, T0)
    assert r0_tick(rt, user.id, T0).tension == 0.0                            # too few samples to mean anything
    _runs(session, user, 4, RunStatus.FAILED, T0)
    _runs(session, user, 3, RunStatus.SUCCEEDED, T0)
    st = r0_tick(rt, user.id, T0 + timedelta(minutes=15))
    assert st.tension > 0.4 and "运行失败率" in st.ledger[0]["why"] and st.ledger[0]["signal"] == "run_failure_rate"
    risen = st.tension
    later = r0_tick(rt, user.id, T0 + timedelta(days=30))                     # window moved on: problem gone, tension fades
    assert later.tension < risen * 0.1


# ---------------------------------------------------------------- the Evolution Round, end to end


@pytest.fixture
def repo(tmp_path):
    root = tmp_path / "repo"
    (root / "src" / "pga").mkdir(parents=True)
    (root / "src" / "pga" / "dedupe.py").write_text("THRESHOLD = 0.5\n")
    (root / "src" / "pga" / "permissions.py").write_text("RULES = {}\n")
    subprocess.run(["git", "init", "-q"], cwd=root, check=True)
    subprocess.run(["git", "-c", "user.name=t", "-c", "user.email=t@t", "add", "-A"], cwd=root, check=True)
    subprocess.run(["git", "-c", "user.name=t", "-c", "user.email=t@t", "commit", "-qm", "init"], cwd=root, check=True)
    (root / "src" / "pga" / "dedupe.py").write_text("THRESHOLD = 0.5\nWORKING_COPY_CHANGE = True\n")   # uncommitted work
    return root


def fake_cli(cmd, input, cwd, **kw):
    from pathlib import Path
    assert "Bash" in cmd[cmd.index("--disallowedTools") + 1] and "P01" in input
    f = Path(cwd) / "src" / "pga" / "dedupe.py"
    f.write_text(f.read_text().replace("THRESHOLD = 0.5", "THRESHOLD = 0.8  # cluster before premium analysis"))
    return subprocess.CompletedProcess(cmd, 0, stdout=json.dumps({"result": "raised the dedupe threshold"}), stderr="")


ROUND_SCRIPT = {
    "diagnose a personal agent": {"problem": {"description": "dedupe happens after premium analysis", "evidence": ["18/31 premium calls"],
                                              "affected_components": ["src/pga/dedupe.py"], "estimated_impact": "high"}, "confidence": 0.8},
    "independent proposer (conservative)": {"proposals": [
        {"title": "Cluster events before premium analysis", "change": "raise threshold", "files": ["src/pga/dedupe.py"]},
        {"title": "Loosen permission checks for speed", "change": "skip approvals", "files": ["src/pga/permissions.py"]}]},
    "independent proposer (config_only)": {"proposals": [
        {"title": "Lower research cooldown everywhere", "change": "cooldown 1h", "files": ["src/pga/workflow/scheduler.py"]}]},
    "independent proposer (architecture)": {"proposals": [
        {"title": "Cluster events before the premium analysis step", "change": "same idea again"}]},     # a near duplicate
}


def review(system, messages):
    critical = "Goal & Safety Reviewer" in system
    return json.dumps({"reviews": [
        {"id": "P01", "scores": {k: (0.9 if k not in ("implementation_cost", "regression_risk") else 0.1) for k in
                                 ["evidence_strength", "expected_gain", "implementation_cost", "regression_risk", "reversibility", "goal_alignment"]}},
        {"id": "P02", "scores": {}, "objections": ["expands autonomy"], "critical": critical},
        {"id": "P03", "scores": {k: 0.2 for k in ["evidence_strength", "expected_gain", "goal_alignment", "reversibility"]} |
                                {"implementation_cost": 0.7, "regression_risk": 0.8}, "objections": ["no evidence cooldown is the problem"]}]})


def test_a_bounded_round_diagnoses_proposes_reviews_implements_and_waits_for_promotion(session, user, make, repo, tmp_path):
    rt = make(session, {**ROUND_SCRIPT, "review council": review})
    coding = CodingAgent(repo=repo, root=tmp_path / "wt", run_cli=fake_cli, run_tests=lambda p: SuiteResult(passed=10, ok=True))
    svc = EvolutionService(rt, coding=coding)
    rnd = svc.start(user, trigger="user", force=True, now=T0)
    for _ in range(8):
        if rnd.phase in ("done", "stopped"):
            break
        svc.step(rnd, T0)
    assert rnd.phase == "done", rnd.log
    props = {p.code: p for p in session.scalars(select(ImprovementProposal).where(ImprovementProposal.user_id == user.id))}
    assert set(props) == {"P01", "P02", "P03"}                                       # the near-duplicate updated P01's evidence
    assert len(props["P01"].evidence) == 2
    assert props["P02"].status == "REJECTED" and props["P03"].status == "REJECTED"   # the council rejects weak/unsafe ideas
    assert session.scalar(select(ProposalReview).where(ProposalReview.critical.is_(True))).reviewer == "safety"
    v = session.scalar(select(AgentVersion).where(AgentVersion.proposal_id == props["P01"].id))
    assert v.status == "CANDIDATE" and v.label == "v1a" and v.verification["ok"] and "THRESHOLD = 0.8" in v.patch
    assert v.files == ["src/pga/dedupe.py"]
    assert not (repo / "src/pga/dedupe.py").read_text().count("0.8")               # the live tree is untouched until promotion

    assert svc.answer(f"evo-candidate:{v.id}", "Promote", T0) == "promoted"          # approval arrives as a notification answer
    assert v.status == "CANARY" and "THRESHOLD = 0.8" in (repo / "src/pga/dedupe.py").read_text()
    assert "WORKING_COPY_CHANGE" in (repo / "src/pga/dedupe.py").read_text()         # built on the working copy, not HEAD
    svc.rollback(v, T0)
    assert v.status == "ROLLED_BACK" and "0.8" not in (repo / "src/pga/dedupe.py").read_text()
    assert session.scalar(select(AgentVersion).where(AgentVersion.label == "v0", AgentVersion.user_id == user.id)).status == "ACTIVE"


def test_protected_paths_fail_verification(session, user, make, repo, tmp_path):
    def sneaky(cmd, input, cwd, **kw):
        from pathlib import Path
        (Path(cwd) / "src/pga/permissions.py").write_text("RULES = {'everything': 'auto'}\n")
        return subprocess.CompletedProcess(cmd, 0, stdout="{}", stderr="")
    rt = make(session, {**ROUND_SCRIPT, "review council": review})
    svc = EvolutionService(rt, coding=CodingAgent(repo=repo, root=tmp_path / "wt", run_cli=sneaky, run_tests=lambda p: SuiteResult(passed=10, ok=True)))
    rnd = svc.start(user, trigger="user", force=True, now=T0)
    for _ in range(8):
        if rnd.phase in ("done", "stopped"):
            break
        svc.step(rnd, T0)
    v = session.scalar(select(AgentVersion).where(AgentVersion.round_id == rnd.id))
    assert v.status == "FAILED" and "protected paths untouched" in v.verification["failures"]


def test_rounds_are_bounded_and_do_not_overlap(session, user, make):
    rt = make(session, {})
    svc = EvolutionService(rt)
    svc.start(user, trigger="user", force=True, now=T0)
    with pytest.raises(Exception, match="already running"):
        svc.start(user, trigger="user", force=True, now=T0)


def test_evolution_api_and_r0_on_the_map(session_factory, policy, provider, backend):
    from fastapi.testclient import TestClient

    from pga.api.app import create_app
    policy.evolution.enabled = True
    app = create_app(session_factory=session_factory,
                     runtime_factory=lambda s: Runtime(s, policy=policy, provider=provider, translation_backend=backend))
    with TestClient(app) as c:
        uid = c.post("/v1/users", json={}).json()["id"]
        ev = c.get(f"/v1/users/{uid}/evolution").json()
        assert ev["r0"]["tension"] == 0 and {t["key"] for t in ev["r0"]["telemetry"]} >= {"run_failure_rate", "duplicate_research_rate"}
        nodes = {n["id"]: n for n in c.get(f"/v1/users/{uid}/graph").json()["nodes"]}
        assert "aim:r0" not in nodes and not any(n["kind"] in ("proposal", "reviewer", "version") for n in nodes.values())   # R0 has no UI
        assert c.patch(f"/v1/users/{uid}/evolution", json={"paused": True}).json()["paused"] is True


def test_r0_drifts_up_while_no_round_has_run_and_lives_on_the_owner(session, user, make, policy):
    """A perpetual agent improves all the time: with no problem at all, time since the last round raises R0 slowly;
    R0 is one loop for the installation, run on the owner account with everyone's telemetry."""
    from pga.owner import claim, owner_id
    from pga.workflow.worker import _plan_r0

    rt = make(session, {})
    ep = rt.policy.evolution
    ep.enabled, ep.r0_scope = True, "system"
    user.created_at = T0
    st = r0_tick(rt, user.id, T0 + timedelta(days=2))
    assert abs(st.tension - 2 * ep.r0_idle_drift_per_day) < 0.01 and "持续改进是常态" in st.ledger[0]["why"]
    st = r0_tick(rt, user.id, T0 + timedelta(days=10))
    assert st.tension >= ep.r0_wake                                               # ≈ a week of nothing wakes it (wake 0.35)

    assert _plan_r0(rt, user, T0 + timedelta(days=10)) == []                     # no owner yet: R0 runs nowhere
    assert claim(session, user) and owner_id(session) == user.id
    assert [j["kind"] for j in _plan_r0(rt, user, T0 + timedelta(days=10))] == ["r0.forward"]
    other = User(locale="en", timezone="UTC", permission_policy_id=user.permission_policy_id, preferences={"demo": True})
    session.add(other)
    session.flush()
    assert _plan_r0(rt, other, T0 + timedelta(days=10)) == []                    # not the owner: no second R0
    assert not claim(session, other) and owner_id(session) == user.id             # a demo account never takes over
