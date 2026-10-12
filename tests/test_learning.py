"""Phase 3 — learning: candidate skills, evaluation, versions, rollback, scope isolation, memory recall (§11, §12, §26)."""

from __future__ import annotations

import json
from datetime import timedelta

import pytest

from pga.agent.research import ResearchAgent
from pga.db.models import Skill, SkillEpisode, User
from pga.db.types import Origin, SkillScope, SkillStatus as St
from pga.knowledge import BeliefUpdate
from pga.db.types import BeliefType
from pga.permissions import create_default_policy
from pga.skills import SkillError
from pga.skills.service import MARKER as EVAL
from pga.workflow.scheduler import heartbeat

from .test_loop import T0, awake, brain, fetcher, make_rt, rt2, search, sent  # noqa: F401  (fixtures)

LESSON = "Check the benchmark's methodology before trusting a headline claim about world models"
LESSON_2 = "Check the benchmark methodology before trusting headline claims about world models"
OTHER = "Prefer primary sources such as the arXiv paper over press releases and blog summaries"


@pytest.fixture
def judge(brain):
    """The fake model also answers skill evaluations, with scores the test sets."""
    state = {"scores": [0.9, 0.9, 0.9], "verdict": "test"}
    brain.extra[EVAL] = state
    return state


def episode(rt, user, lesson="", success=1.0, used=None, when=T0):
    return rt.skills.record_episode(user_id=user.id, task_kind="research", success=success, lesson=lesson,
                                    used_skill_ids=used, now=when)


def other_user(session, policy):
    u = User(locale="zh-CN", timezone="UTC", permission_policy_id=create_default_policy(session, policy).id,
             preferences={})
    session.add(u)
    session.flush()
    return u


def test_one_episode_never_becomes_a_rule(rt2, user, judge):
    ep = episode(rt2, user, LESSON, success=0.0)
    s = rt2.session.get(Skill, ep.lesson_skill_id)
    assert s.status == St.CANDIDATE and s.support == 1 and s.scope == SkillScope.USER and s.owner_id == user.id
    res = rt2.skills.evaluate(s, user.id, T0)
    assert not res.passed and not res.activated and s.status == St.CANDIDATE
    assert rt2.skills.due_for_eval(user.id) == []
    with pytest.raises(SkillError):
        rt2.skills.activate(s, actor=Origin.USER)              # no eval, no activation


def test_similar_lessons_merge_and_different_ones_do_not(rt2, user):
    a = episode(rt2, user, LESSON)
    b = episode(rt2, user, LESSON_2)
    c = episode(rt2, user, OTHER)
    assert a.lesson_skill_id == b.lesson_skill_id != c.lesson_skill_id
    assert rt2.session.get(Skill, a.lesson_skill_id).support == 2
    assert [s.id for s in rt2.skills.due_for_eval(user.id)] == [a.lesson_skill_id]


def test_eval_activates_and_skill_reaches_research_but_not_other_users(rt2, user, judge, session, policy):
    episode(rt2, user, LESSON)
    sid = episode(rt2, user, LESSON_2).lesson_skill_id
    s = session.get(Skill, sid)
    res = rt2.skills.evaluate(s, user.id, T0)
    assert res.passed and res.activated and s.status == St.ACTIVE and res.evaluator.startswith("llm")
    r, _ = awake(rt2, user)
    assert LESSON in rt2.skill_context(r)
    stranger = other_user(session, policy)
    r2 = rt2.responsibilities.create(user_id=stranger.id, title_en="other", actor=Origin.USER)
    assert rt2.skill_context(r2) == ""                         # a user's skill never leaks to someone else


def test_failing_eval_retires_the_candidate(rt2, user, judge):
    episode(rt2, user, LESSON, success=0.2)
    s = rt2.session.get(Skill, episode(rt2, user, LESSON_2, success=0.1).lesson_skill_id)
    judge["scores"] = [0.1, 0.2]
    res = rt2.skills.evaluate(s, user.id, T0)
    assert not res.passed and s.status == St.DEPRECATED


def test_versions_activate_and_roll_back(rt2, user, judge):
    episode(rt2, user, LESSON)
    v1 = rt2.session.get(Skill, episode(rt2, user, LESSON_2).lesson_skill_id)
    rt2.skills.evaluate(v1, user.id, T0)
    v2 = rt2.skills.revise(v1, LESSON + ", and look for an independent replication", actor=Origin.AGENT)
    assert v2.version == 2 and v2.parent_version_id == v1.id and v2.status == St.CANDIDATE
    rt2.skills.evaluate(v2, user.id, T0)
    assert v2.status == St.ACTIVE and v1.status == St.DEPRECATED   # previous version kept, not deleted
    back = rt2.skills.rollback(v2, actor=Origin.USER, reason="worse in practice")
    assert back.id == v1.id and v1.status == St.ACTIVE and v2.status == St.ROLLED_BACK


def test_regression_rolls_back_automatically(rt2, user, judge, policy):
    episode(rt2, user, LESSON)
    v1 = rt2.session.get(Skill, episode(rt2, user, LESSON_2).lesson_skill_id)
    rt2.skills.evaluate(v1, user.id, T0)
    for i in range(3):
        episode(rt2, user, success=1.0, used=[v1.id], when=T0 + timedelta(minutes=i))
    v2 = rt2.skills.revise(v1, "Trust headline claims if they come from a big lab", actor=Origin.AGENT)
    rt2.skills.evaluate(v2, user.id, T0 + timedelta(hours=1))
    assert v2.status == St.ACTIVE
    for i in range(policy.skills.regression_window):
        episode(rt2, user, success=0.0, used=[v2.id], when=T0 + timedelta(hours=2, minutes=i))
    assert v2.status == St.ROLLED_BACK and "regression" in v2.retired_reason and v1.status == St.ACTIVE


def test_only_the_user_shares_a_skill_globally(rt2, user, judge, session, policy):
    episode(rt2, user, LESSON)
    s = session.get(Skill, episode(rt2, user, LESSON_2).lesson_skill_id)
    rt2.skills.evaluate(s, user.id, T0)
    with pytest.raises(SkillError):
        rt2.skills.promote_to_global(s, actor=Origin.AGENT)
    g = rt2.skills.promote_to_global(s, actor=Origin.USER)
    assert g.scope == SkillScope.GLOBAL and g.status == St.ACTIVE
    stranger = other_user(session, policy)
    r2 = rt2.responsibilities.create(user_id=stranger.id, title_en="other", actor=Origin.USER)
    assert LESSON in rt2.skill_context(r2)


def test_memory_recalls_related_past_material_for_this_user_only(rt2, user, session, policy):
    r, res = awake(rt2, user)
    rt2.beliefs.apply(r, [BeliefUpdate(key="sim", type=BeliefType.CONCLUSION, confidence=.8,
                                       statement_en="Simulation benchmarks overstate robot transfer",
                                       evidence=[(res.evidence.id, "SUPPORTS")])],
                      allowed_evidence={res.evidence.id})
    hits = rt2.memory.recall(user.id, "robot simulation benchmark transfer")
    kinds = {h.kind for h in hits}
    assert "belief" in kinds and "evidence" in kinds
    ctx = rt2.memory_context(r, "benchmark claims")
    assert "candidate context only" in ctx and "Simulation benchmarks" in ctx
    assert rt2.memory.recall(other_user(session, policy).id, "robot simulation benchmark") == []
    assert rt2.memory.recall(user.id, "") == []


def test_research_steps_become_episodes_and_candidates_get_evaluated(rt2, user, brain, judge, session):
    r, _ = awake(rt2, user)
    brain.research = {"beliefs": [{"key": "k", "type": "HYPOTHESIS", "statement": "claims may be weak",
                                   "confidence": .6, "evidence": [{"id": "E1"}]}],
                      "communicate": {"kind": "SILENT"}, "next": {"state": "continue"}, "useful": True,
                      "lesson": LESSON}
    out = ResearchAgent(rt2).run(r, T0)
    rt2.learn_from(r, out)
    episode(rt2, user, LESSON_2)                                # the same lesson from another step
    eps = session.query(SkillEpisode).filter_by(user_id=user.id).all()
    mine = [e for e in eps if e.run_id == out.run_id]                   # rows come back in no particular order
    assert len(eps) == 2 and len(mine) == 1 and mine[0].success == 1.0
    report = heartbeat(rt2, user, T0 + timedelta(hours=7))
    assert any(q["kind"] == "skill.evaluate" for q in report["queued"])
