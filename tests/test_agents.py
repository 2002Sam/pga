"""The agent pool: many agents behind one interface, run single / as a council / as a convoy."""

from __future__ import annotations

import json
import sys

import pytest
from fastapi.testclient import TestClient
from sqlalchemy import select

from pga.agents import AgentPool, pool
from pga.api.app import create_app
from pga.db.models import AgentRun, Job
from pga.llm.router import default_fake_reply
from pga.runtime import Runtime
from pga.workflow.worker import HANDLERS

AGENT = r'''
import json, sys
label, prompt = sys.argv[1], sys.stdin.read()
if label == "broken":
    sys.exit(3)
if "anonymised answers" in prompt:                     # the council's peer review: everyone prefers B
    print(json.dumps({"ranking": ["B", "A", "C"], "notes": "B is most specific"}))
elif "Your part" in prompt:
    print(f"{label} did: " + prompt.split("Your part")[1].strip()[:40])
else:
    print(f"{label} says: the answer is {len(prompt) % 7}")
'''


def brain(system, messages):
    if system.startswith("You chair a council"):
        return "SYNTHESIS: B wins, with A's caveat"
    if system.startswith("You plan a convoy"):
        return json.dumps({"subtasks": [{"title": "papers", "prompt": "find the papers"},
                                        {"title": "code", "prompt": "find the code"}]})
    if system.startswith("You are the refinery"):
        return "MERGED: " + " + ".join(l for l in messages[-1]["content"].splitlines() if " did: " in l)
    return default_fake_reply("m", system, messages)


@pytest.fixture
def cfg(tmp_path):
    script = tmp_path / "agent.py"
    script.write_text(AGENT)
    proc = lambda label: {"adapter": "process", "command": [sys.executable, str(script), label], "capabilities": ["general"]}  # noqa: E731
    return {
        "agents": {"broken": proc("broken"), "alpha": proc("alpha"), "beta": proc("beta"), "gamma": proc("gamma"),
                   "missing": {"adapter": "process", "command": ["/no/such/agent"]},
                   "model": {"adapter": "llm", "tier": 2, "max_concurrent": 3}},
        "workflows": {
            "general": {"pattern": "single", "agents": ["missing", "broken", "alpha"]},
            "review": {"pattern": "council", "members": ["alpha", "beta", "gamma"], "chair": "model", "peer_review": True},
            "deep_dive": {"pattern": "convoy", "planner": "model", "workers": ["alpha", "beta"], "merge": "model", "max_subtasks": 3},
        },
        "run": {"retries": 1, "max_backoff_s": 0, "daily_usd_cap": 1.0, "workspace_root": str(tmp_path / "ws")},
    }


def test_single_falls_back_and_everything_is_recorded(rt, user, provider, cfg):
    provider.handler = brain
    res = AgentPool(rt, cfg).run("general", "what is 2+2?", user=user)
    assert res.ok and res.text.startswith("alpha says") and res.data["agent"] == "alpha"
    seen = [(s.step, s.result.agent, s.result.status) for s in res.steps]
    assert seen == [("skip", "missing", "SKIPPED"), ("run", "broken", "FAILED"), ("run", "broken", "FAILED"), ("run", "alpha", "SUCCEEDED")]
    rows = list(rt.session.scalars(select(AgentRun).where(AgentRun.parent_id == res.run_id)))
    assert len(rows) == 4 and rt.session.get(AgentRun, res.run_id).status == "SUCCEEDED"


def test_council_answers_ranks_and_synthesises(rt, user, provider, cfg):
    provider.handler = brain
    res = AgentPool(rt, cfg).run("review", "is this patch safe?", user=user)
    assert res.ok and res.text.startswith("SYNTHESIS") and res.data["chair"] == "model"
    steps = [s.step for s in res.steps]
    assert steps.count("answer") == 3 and steps.count("review") == 3 and steps[-1] == "synthesis"
    top = res.data["answers"][0]
    assert top["label"] == "B" and top["agent"] == "beta" and top["score"] == 2         # first for both others (own vote ignored)
    assert [a["agent"] for a in res.data["answers"]] == ["beta", "alpha", "gamma"]
    assert res.data["agreement"] > 0
    chair_prompt = provider.calls[-1].messages[-1]["content"]
    assert "<answer label=\"A\">" in chair_prompt and "peer score" in chair_prompt


def test_convoy_plans_works_in_parallel_and_merges(rt, user, provider, cfg):
    provider.handler = brain
    res = AgentPool(rt, cfg).run("deep_dive", "survey world models", user=user)
    assert res.ok and res.text.startswith("MERGED")
    assert [p["title"] for p in res.data["plan"]] == ["papers", "code"]
    assert {p["agent"] for p in res.data["parts"]} == {"alpha", "beta"} and all(p["ok"] for p in res.data["parts"])
    assert [s.step for s in res.steps][0] == "plan" and [s.step for s in res.steps][-1] == "merge"


def test_the_daily_cap_stops_external_agents_not_the_own_model(rt, user, provider, cfg):
    provider.handler = brain
    rt.session.add(AgentRun(workflow="x", pattern="single", step="run", agent="alpha", adapter="process", status="SUCCEEDED",
                            cost_usd=5.0))
    rt.session.flush()
    p = AgentPool(rt, cfg)
    assert p.usable("alpha", p.spent_today()) == (False, "daily cost cap reached ($5.00)")
    assert p.usable("model", p.spent_today())[0]


def test_api_config_status_background_run_and_history(session_factory, policy, provider, backend, cfg):
    provider.handler = brain
    app = create_app(session_factory=session_factory,
                     runtime_factory=lambda s: Runtime(s, policy=policy, provider=provider, translation_backend=backend))
    with TestClient(app) as c:
        uid = c.post("/v1/users", json={"locale": "en"}).json()["id"]
        view = c.get("/v1/agents").json()
        assert view["configured"] is False and {"claude", "codex", "hermes", "model"} <= set(view["agents"])
        assert c.put("/v1/agents", json={**cfg, "agents": {"x": {"adapter": "nope"}}}).status_code == 422
        bad_flow = {**cfg, "workflows": {"w": {"pattern": "single", "agents": ["ghost"]}}}
        assert c.put("/v1/agents", json=bad_flow).status_code == 422
        view = c.put("/v1/agents", json=cfg).json()
        assert view["configured"] and view["status"]["alpha"]["available"] and not view["status"]["missing"]["available"]
        assert pool.CONFIG.exists()

        t = c.post("/v1/agents/test", json={"agent": "alpha"}).json()
        assert t["ok"] and "alpha says" in t["reply"]
        queued = c.post(f"/v1/users/{uid}/agents/run", json={"workflow": "review", "prompt": "ship it?"}).json()
        with session_factory() as s:
            job = s.get(Job, queued["job_id"])
            rt = Runtime(s, policy=policy, provider=provider, translation_backend=backend)
            out = HANDLERS["agents.run"](rt, job, job.run_at)
            s.commit()
        assert out["ok"] and out["text"].startswith("SYNTHESIS")
        hist = c.get(f"/v1/users/{uid}/agents/runs").json()
        assert hist[0]["workflow"] == "review" and hist[0]["pattern"] == "council" and len(hist[0]["steps"]) == 7
        now = c.post(f"/v1/users/{uid}/agents/run", json={"workflow": "general", "prompt": "hi", "wait": True}).json()
        assert now["ok"] and now["text"].startswith("alpha says")
        assert c.post(f"/v1/users/{uid}/agents/run", json={"workflow": "nope", "prompt": "x"}).status_code == 422
