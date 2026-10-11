"""Phase 2 — the perpetual loop: durable jobs, sources, research steps, exploration, notifications."""

from __future__ import annotations

import json
from datetime import datetime, timedelta, timezone

import pytest

from pga.agent.explore import Explorer
from pga.agent.research import MARKER as RESEARCH, ResearchAgent
from pga.agent.explore import MARKER as EXPLORE
from pga.db.models import Belief, Job, Notification, Run
from pga.db.types import (
    BeliefType, CommKind, JobStatus, NotificationStatus, NotifyReason, Origin, ResponsibilityStatus as S,
    SourceKind,
)
from pga.llm import FakeProvider
from pga.notify import Proposal
from pga.research import FetchError, FetchResult, SearchHit, check_public_url, html_to_text, parse_feed
from pga.runtime import Runtime
from pga.sources import SourceError
from pga.tension import IncomingEvidence, Signals
from pga.workflow import SpawnLimitExceeded, WorkflowError
from pga.workflow.scheduler import heartbeat
from pga.workflow.worker import Worker

T0 = datetime(2026, 10, 12, 10, 0, tzinfo=timezone.utc)   # 18:00 in Asia/Shanghai — outside quiet hours


# ---------------------------------------------------------------- fakes


RSS = """<?xml version="1.0"?><rss version="2.0"><channel><title>Lab news</title>
{items}
</channel></rss>"""
ITEM = "<item><title>{t}</title><link>https://lab.example.com/{i}</link><guid>g{i}</guid><description>{d}</description></item>"


class FakeFetcher:
    def __init__(self):
        self.pages: dict[str, str] = {}
        self.calls: list[str] = []

    def get(self, url, headers=None):
        self.calls.append(url)
        for prefix, body in self.pages.items():
            if url.startswith(prefix):
                return FetchResult(url, 200, body, {})
        return FetchResult(url, 404, "", {})


class FakeSearch:
    name = "fake"

    def __init__(self):
        self.queries: list[str] = []

    def search(self, query, limit):
        self.queries.append(query)
        return [SearchHit(f"Result {i} for {query}", f"Snippet about {query} number {i}",
                          f"https://example.org/{abs(hash(query)) % 9999}/{i}", f"{query}-{i}") for i in range(2)]


class Brain:
    """Scriptable fake model: the research step and the explorer get JSON; everything else is echoed."""

    def __init__(self):
        self.research = {"beliefs": [], "communicate": {"kind": "SILENT"}, "next": {"state": "monitor"}}
        self.queries = {"queries": ["world model benchmarks", "robot simulators"]}

    def __call__(self, system, messages):
        if system.startswith(RESEARCH):
            return json.dumps(self.research)
        if system.startswith(EXPLORE):
            return json.dumps(self.queries)
        return "ok"


@pytest.fixture
def brain():
    return Brain()


@pytest.fixture
def fetcher():
    return FakeFetcher()


@pytest.fixture
def search():
    return FakeSearch()


@pytest.fixture
def sent():
    return []


@pytest.fixture
def make_rt(policy, backend, brain, fetcher, search, sent):
    provider = FakeProvider(handler=brain)

    def make(session):
        return Runtime(session, policy=policy, provider=provider, translation_backend=backend, fetcher=fetcher,
                       search=search, channels={"push": lambda u, n: sent.append(n.title_en)})
    return make


@pytest.fixture
def rt2(session, make_rt):
    return make_rt(session)


def awake(rt, user, title="world model research", keywords=("world model",)):
    r = rt.responsibilities.create(user_id=user.id, title_en=title, keywords=list(keywords), actor=Origin.USER)
    res = rt.tension.ingest(user.id, IncomingEvidence(
        text="New benchmark contradicts world model sim-to-real claims", source_uri="https://news.example.com/a",
        signals={r.id: Signals(relevance=0.9, contradiction=1.0, decision_impact=0.9)}), now=T0)
    assert r.status == S.ACTIVE
    return r, res


# ---------------------------------------------------------------- durable workflow (§9)


def test_enqueue_dedupes_and_claim_leases(rt2, user):
    wf = rt2.workflow
    a = wf.enqueue("x", user_id=user.id, dedupe_key="k", now=T0)
    b = wf.enqueue("x", user_id=user.id, dedupe_key="k", now=T0)
    assert a.id == b.id
    jobs = wf.claim("w1", now=T0)
    assert [j.id for j in jobs] == [a.id] and a.status == JobStatus.RUNNING and a.attempts == 1
    assert wf.claim("w2", now=T0) == []                         # leased
    reclaimed = wf.claim("w2", now=T0 + timedelta(hours=1))     # lease expired: crashed worker
    assert reclaimed and reclaimed[0].lease_owner == "w2"
    wf.complete(a, {"ok": True}, now=T0)
    assert wf.enqueue("x", user_id=user.id, dedupe_key="k", now=T0).id != a.id  # finished → a new one may run


def test_fail_retries_with_backoff_then_retry_op(rt2, user):
    wf = rt2.workflow
    j = wf.enqueue("x", user_id=user.id, max_attempts=2, now=T0)
    wf.claim("w", now=T0)
    wf.fail(j, "boom", now=T0)
    assert j.status == JobStatus.QUEUED and j.run_at == T0 + timedelta(seconds=60)
    wf.claim("w", now=T0 + timedelta(seconds=61))
    wf.fail(j, "boom again", now=T0 + timedelta(seconds=61))
    assert j.status == JobStatus.FAILED
    wf.retry(j.id, actor=Origin.USER, now=T0 + timedelta(minutes=5))
    assert j.status == JobStatus.QUEUED and j.attempts == 0
    wf.cancel(j.id, actor=Origin.USER)
    assert j.status == JobStatus.CANCELLED
    with pytest.raises(WorkflowError):
        wf.cancel(j.id, actor=Origin.USER)


def test_wait_for_user_event_and_migrate_version(rt2, user):
    wf = rt2.workflow
    a = wf.enqueue("ask", user_id=user.id, now=T0)
    b = wf.enqueue("watch", user_id=user.id, payload={"v": 1}, now=T0)
    wf.claim("w", limit=2, now=T0)
    wf.wait_for_user(a, now=T0)
    wf.wait_for_event(b, "paper:123", timeout=timedelta(hours=2), now=T0)
    assert wf.claim("w", now=T0 + timedelta(minutes=1)) == []
    assert wf.signal_user(user.id, {"answer": "yes"}) == 1 and a.status == JobStatus.QUEUED
    assert a.payload["signal"]["user"]["answer"] == "yes"
    assert wf.migrate_version("watch", 2, lambda p: {**p, "v": 2}) == 1 and b.payload["v"] == 2
    assert wf.expire_waits(T0 + timedelta(hours=3)) == 1 and b.payload["signal"]["timed_out"]


def test_spawn_depth_is_bounded_and_external_cannot_schedule(rt2, user):
    wf = rt2.workflow
    parent = wf.enqueue("a", user_id=user.id, now=T0)
    child = wf.enqueue("b", user_id=user.id, parent=parent, now=T0)
    grandchild = wf.enqueue("c", user_id=user.id, parent=child, now=T0)
    with pytest.raises(SpawnLimitExceeded):
        wf.enqueue("d", user_id=user.id, parent=grandchild, now=T0)
    with pytest.raises(WorkflowError):
        wf.enqueue("e", user_id=user.id, created_by=Origin.EXTERNAL, now=T0)


# ---------------------------------------------------------------- tools and sources


def test_ssrf_guard_and_parsers():
    for bad in ["http://localhost:8000/x", "http://127.0.0.1/", "file:///etc/passwd", "http://10.0.0.5/"]:
        with pytest.raises(FetchError):
            check_public_url(bad)
    items = parse_feed(RSS.format(items=ITEM.format(t="A &amp; B", i=1, d="&lt;p&gt;hi&lt;/p&gt;")))
    assert items[0].key == "g1" and items[0].title == "A & B" and items[0].summary == "hi"
    atom = ('<feed xmlns="http://www.w3.org/2005/Atom"><entry><id>http://arxiv.org/abs/1</id><title>Paper</title>'
            '<summary>Abstract</summary><published>2026-10-01T00:00:00Z</published>'
            '<link href="http://arxiv.org/abs/1"/></entry></feed>')
    a = parse_feed(atom)[0]
    assert a.key == "http://arxiv.org/abs/1" and a.published_at.year == 2026
    title, text = html_to_text("<html><title>T</title><script>evil()</script><p>Hello</p><p>World</p></html>")
    assert title == "T" and "evil" not in text and "Hello" in text


def test_only_user_adds_sources_and_feed_polls_are_deduped(rt2, user, fetcher):
    with pytest.raises(SourceError):
        rt2.sources.add(user_id=user.id, kind=SourceKind.FEED, uri="https://lab.example.com/rss",
                        actor=Origin.EXTERNAL, validate_url=False)
    r = rt2.responsibilities.create(user_id=user.id, title_en="world model research",
                                    keywords=["world model"], actor=Origin.USER)
    src = rt2.sources.add(user_id=user.id, kind=SourceKind.FEED, uri="https://lab.example.com/rss",
                          actor=Origin.USER, validate_url=False)
    fetcher.pages["https://lab.example.com/rss"] = RSS.format(items="".join(
        ITEM.format(t=f"world model update {i}", i=i, d=f"details {i} about the world model") for i in range(8)))
    first = rt2.sources.poll(src, T0)
    assert first.new_items == 5        # first poll: only the newest few, no back-catalogue flood
    assert rt2.sources.poll(src, T0 + timedelta(hours=1)).new_items == 0
    fetcher.pages["https://lab.example.com/rss"] = RSS.format(items=ITEM.format(
        t="world model breakthrough", i=99, d="a world model result"))
    assert rt2.sources.poll(src, T0 + timedelta(hours=2)).new_items == 1
    assert r.tension > 0


def test_web_page_source_reports_changes_only(rt2, user, fetcher):
    src = rt2.sources.add(user_id=user.id, kind=SourceKind.WEB_PAGE, uri="https://grants.example.com/call",
                          actor=Origin.USER, validate_url=False)
    fetcher.pages["https://grants.example.com/call"] = "<p>Deadline: 1 Dec</p>"
    assert rt2.sources.poll(src, T0).status == "baseline recorded"
    assert rt2.sources.poll(src, T0).status == "unchanged"
    fetcher.pages["https://grants.example.com/call"] = "<p>Deadline moved: 15 Nov</p>"
    assert rt2.sources.poll(src, T0).status == "changed"


def test_failing_source_backs_off_then_disables(rt2, user, policy):
    src = rt2.sources.add(user_id=user.id, kind=SourceKind.FEED, uri="https://dead.example.com/rss",
                          actor=Origin.USER, validate_url=False)
    t = T0
    for _ in range(policy.workflow.source_failure_disable_after):
        rt2.sources.poll(src, t)
        t += timedelta(days=1)
    assert not src.enabled and src.last_status.startswith("error")


# ---------------------------------------------------------------- the research step


def test_research_updates_beliefs_absorbs_and_notifies(rt2, user, brain, sent, session):
    user.preferences = {"notify": {"channels": ["in_app", "push"]}}
    r, res = awake(rt2, user)
    before = r.tension
    brain.research = {
        "beliefs": [{"key": "sim2real", "type": "CONCLUSION", "statement": "Sim-to-real claims are overstated",
                     "confidence": 0.8, "evidence": [{"id": "E1", "stance": "SUPPORTS"}]},
                    {"key": "uncited", "type": "CONCLUSION", "statement": "Everything will change", "confidence": 0.9,
                     "evidence": [{"id": "E99"}]}],
        "communicate": {"kind": "NOTIFICATION", "reasons": ["CONCLUSION_CHANGED", "DEADLINE"],
                        "title": "Sim-to-real claims look overstated", "body": "A new benchmark contradicts them."},
        "next": {"state": "monitor"}, "useful": True, "lesson": "check benchmarks before press releases"}
    out = ResearchAgent(rt2).run(r, T0 + timedelta(minutes=5))
    assert out.status == "done" and out.next_state == "monitor" and r.status == S.MONITORING
    beliefs = {b.key: b for b in session.query(Belief).filter_by(responsibility_id=r.id)}
    assert beliefs["sim2real"].type == BeliefType.CONCLUSION
    assert beliefs["uncited"].type == BeliefType.HYPOTHESIS          # no valid citation → not a conclusion
    assert [e.id for e, _ in rt2.beliefs.evidence_for(beliefs["sim2real"].id)] == [res.evidence.id]
    assert r.tension < before                                         # absorbed information stops pulling
    n = session.get(Notification, out.notification_id)
    assert n.status == NotificationStatus.DELIVERED and n.reasons == ["CONCLUSION_CHANGED"]  # DEADLINE unverified
    assert sent == ["Sim-to-real claims look overstated"] and "push" in n.channels
    run = session.get(Run, out.run_id)
    assert run.why_now and run.stop_condition and run.belief_changes and r.useful_outcomes == 1


def test_research_without_real_reason_stays_silent(rt2, user, brain, session):
    r, _ = awake(rt2, user)
    brain.research = {"beliefs": [], "communicate": {"kind": "NOTIFICATION", "reasons": ["CONCLUSION_CHANGED"],
                                                     "title": "Just FYI"}, "next": {"state": "sleep",
                                                                                     "review_in_hours": 48}}
    out = ResearchAgent(rt2).run(r, T0)
    n = session.get(Notification, out.notification_id)
    assert n.kind == CommKind.SILENT and n.status == NotificationStatus.SUPPRESSED
    assert r.status == S.SLEEPING and r.next_review_at == T0 + timedelta(hours=48)


def test_question_waits_for_user_and_answer_records_decision(rt2, user, brain, session):
    r, _ = awake(rt2, user)
    brain.research = {"beliefs": [{"key": "pick", "type": "UNCERTAINTY", "statement": "A or B?", "confidence": 0.5,
                                   "evidence": [{"id": "E1"}]}],
                      "communicate": {"kind": "QUESTION", "reasons": ["DECISION_REQUIRED"], "title": "A or B?",
                                      "options": ["A", "B"]}, "next": {"state": "continue"}}
    out = ResearchAgent(rt2).run(r, T0)
    assert r.status == S.WAIT_USER
    n = session.get(Notification, out.notification_id)
    d = rt2.notify.answer(user, n, "B")
    assert n.status == NotificationStatus.ANSWERED and "A: B" in d.decision_en
    assert rt2.allocator.allocate(__import__("pga.allocator", fromlist=["RunRequest"]).RunRequest(
        user_id=user.id, kind="monitoring", responsibility_id=r.id)).outcome.value == "DENIED"  # waits: no compute


def test_research_is_deferred_when_budget_says_no(rt2, user, policy):
    r, _ = awake(rt2, user)
    r.compute_budget = {"max_units_per_period": 1}
    out = ResearchAgent(rt2).run(r, T0)
    assert out.status == "deferred" and out.retry_after is not None


def test_candidates_are_bounded_and_never_change_state_themselves(rt2, user, brain):
    r, _ = awake(rt2, user)
    brain.research = {"beliefs": [], "communicate": {"kind": "SILENT"}, "next": {"state": "continue"},
                      "candidates": [{"title": "Track robot simulators", "why": "keeps coming up",
                                      "keywords": ["simulator"]}]}
    ResearchAgent(rt2).run(r, T0)
    kids = [c for c in rt2.responsibilities.list(user.id) if c.parent_id == r.id]
    assert len(kids) == 1 and kids[0].status == S.CANDIDATE and kids[0].candidate_expires_at
    assert kids[0].compute_budget["exploration"]["max_units"] > 0


# ---------------------------------------------------------------- exploration (§6)


def test_exploration_is_anchored_bounded_and_follows_the_mix(rt2, user, search, session):
    ex = Explorer(rt2)
    assert ex.run(user, T0).status == "skipped"                        # nothing to anchor on
    rt2.responsibilities.create(user_id=user.id, title_en="world model research", keywords=["world model"],
                                actor=Origin.USER)
    out = ex.run(user, T0)
    assert out.status == "done" and out.scope == "neighborhood" and out.ingested == 4
    assert search.queries == ["world model benchmarks", "robot simulators"]
    run = session.get(Run, out.run_id)
    assert run.category == "free_exploration" and run.exploration_scope == "neighborhood" and len(run.tools) == 2
    scopes = [ex.run(user, T0 + timedelta(minutes=i)).scope for i in range(1, 10)]
    assert set(scopes) == {"neighborhood", "adjacent", "distant"}     # spend converges on 70/20/10


def test_exploration_stops_when_its_budget_is_spent(rt2, user, policy):
    rt2.responsibilities.create(user_id=user.id, title_en="t", keywords=["k"], actor=Origin.USER)
    policy.budget.total_units = 5_000  # free_exploration = 10% → 500 units; neighborhood 350 < tier-1 estimate (600)
    out = Explorer(rt2).run(user, T0)
    assert out.status == "deferred" and "budget" in out.reason


# ---------------------------------------------------------------- notifications (§16)


def test_notification_limits_quiet_hours_and_dedupe(rt2, user, session):
    def say(title, reasons=(NotifyReason.CONCLUSION_CHANGED,), when=T0, key=None, kind=CommKind.NOTIFICATION):
        return rt2.notify.propose(user, Proposal(kind=kind, reasons=list(reasons), title_en=title, dedupe_key=key),
                                  now=when)
    assert say("no reason", reasons=()).status == NotificationStatus.SUPPRESSED
    assert [say(f"n{i}").status for i in range(4)] == [NotificationStatus.DELIVERED] * 3 + [NotificationStatus.SUPPRESSED]
    assert say("deadline!", reasons=(NotifyReason.DEADLINE,)).status == NotificationStatus.DELIVERED  # urgent passes
    night = datetime(2026, 10, 12, 16, 0, tzinfo=timezone.utc)        # 00:00 in Shanghai
    held = say("at night", reasons=(NotifyReason.DECISION_REQUIRED,), when=night, kind=CommKind.QUESTION)
    assert held.status == NotificationStatus.PENDING and held.deliver_after.astimezone(timezone.utc).hour == 0
    assert rt2.notify.deliver_due(user, night + timedelta(hours=9)) == 1
    k1 = say("same", reasons=(NotifyReason.DEADLINE,), key="dup", when=T0 + timedelta(days=2))
    k2 = say("same", reasons=(NotifyReason.DEADLINE,), key="dup", when=T0 + timedelta(days=2, hours=1))
    assert k1.status == NotificationStatus.DELIVERED and k2.suppressed_reason == "already told the user about this"


# ---------------------------------------------------------------- the loop end to end


def test_worker_runs_heartbeat_poll_research_and_exploration(session_factory, make_rt, user, fetcher, brain, session):
    rt = make_rt(session)
    r = rt.responsibilities.create(user_id=user.id, title_en="world model research", keywords=["world model"],
                                   actor=Origin.USER)
    rt.sources.add(user_id=user.id, kind=SourceKind.FEED, uri="https://lab.example.com/rss", actor=Origin.USER,
                   validate_url=False)
    fetcher.pages["https://lab.example.com/rss"] = RSS.format(items=ITEM.format(
        t="world model contradicted", i=1, d="A benchmark contradicts the world model claims"))
    session.commit()
    brain.research = {"beliefs": [{"key": "k", "type": "HYPOTHESIS", "statement": "claims may be weak",
                                   "confidence": 0.6, "evidence": [{"id": "E1"}]}],
                      "communicate": {"kind": "SILENT"}, "next": {"state": "monitor"}}

    worker = Worker(session_factory, make_rt, worker_id="test")
    steps = worker.run_once(T0)
    kinds = [(s.kind, s.outcome) for s in steps]
    assert ("user.heartbeat", "succeeded") in kinds and ("source.poll", "succeeded") in kinds
    assert ("exploration.run", "succeeded") in kinds
    assert all(o != "failed" for _, o in kinds), kinds

    # push the responsibility awake, then the next heartbeat queues a research step
    with session_factory() as s:
        rt_ = make_rt(s)
        rr = rt_.responsibilities.get(r.id)
        rt_.tension.ingest(user.id, IncomingEvidence(text="Major contradiction in world model results",
                                                     signals={rr.id: Signals(relevance=1, contradiction=1,
                                                                             decision_impact=1)}), now=T0)
        assert rr.status == S.ACTIVE
        s.commit()
    later = T0 + timedelta(minutes=20)
    steps = worker.run_once(later)
    assert ("responsibility.research", "succeeded") in [(s.kind, s.outcome) for s in steps]
    with session_factory() as s:
        rr = make_rt(s).responsibilities.get(r.id)
        assert rr.status == S.MONITORING
        assert s.query(Belief).filter_by(responsibility_id=r.id).count() == 1
        assert s.query(Job).filter_by(kind="user.heartbeat", status=JobStatus.QUEUED).count() == 1  # next beat


def test_heartbeat_is_cheap_and_pause_cancels_queued_work(rt2, user, session):
    r, _ = awake(rt2, user)
    report = heartbeat(rt2, user, T0)
    assert {"kind": "responsibility.research", "key": f"research:{r.id}"} in report["queued"]
    assert session.query(Run).count() == 0                            # the heartbeat itself never calls a model
    rt2.responsibilities.transition(r, "pause", actor=Origin.USER)
    assert rt2.workflow.cancel_for_responsibility(r.id, actor=Origin.USER, reason="paused") == 1
    report = heartbeat(rt2, user, T0 + timedelta(hours=7))
    assert not [q for q in report["queued"] if q["kind"] == "responsibility.research"]
