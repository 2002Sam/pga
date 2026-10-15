"""The console (工作台): motivations → projects → the agents' process, and the controls over them."""

from __future__ import annotations

from datetime import datetime, timezone

import pytest
from fastapi.testclient import TestClient

from pga.agents import live
from pga.api.app import create_app
from pga.console import Console, ConsoleError
from pga.db.models import Project
from pga.runtime import Runtime

from .test_perpetual import cfg, repo, setup  # noqa: F401  (fixtures)


def test_overview_puts_projects_under_their_motivation(rt, user, setup):
    eng, t, aim, _ = setup
    proj = rt.session.get(Project, t.project_id)
    proj.aim_id = aim.id
    rt.session.add(Project(user_id=user.id, name="Loose", path="/x/loose", created_at=datetime.now(timezone.utc)))
    rt.session.flush()
    eng.cycle(t)                                                  # one step of self-dialogue
    view = Console(rt).overview(user)
    a = next(x for x in view["aims"] if x["id"] == str(aim.id))
    assert a["task"]["status"] == "running" and a["task"]["cycles"] == 1
    assert [p["name"] for p in a["projects"]] == ["PGA"] and a["projects"][0]["state"] == "running"
    assert [p["name"] for p in view["free_projects"]] == ["Loose"] and view["free_projects"][0]["state"] == "idle"
    assert any(x["name"] for x in view["agents"])


def test_process_shows_the_self_dialogue_with_each_step_in_full(rt, user, setup):
    eng, t, aim, _ = setup
    eng.cycle(t)                                                  # think: asks questions
    eng.cycle(t)                                                  # investigate: an agent answers one
    proc = Console(rt).process(user, aim.id)
    kinds = {(e["type"], e.get("kind") or e.get("step")) for e in proc["events"]}
    assert ("note", "question") in kinds and ("run", "think") in kinds and ("run", "investigate") in kinds
    assert [q["text"] for q in proc["for_you"]] == [q.text for q in eng.questions(t, ("for_you",))]   # yours, however old
    run = next(e for e in proc["events"] if e["type"] == "run")
    d = Console(rt).run_detail(user, __import__("uuid").UUID(run["id"]))
    assert d["prompt"] and d["answer"] is not None and d["agent"] == run["agent"]
    with pytest.raises(ConsoleError):
        Console(rt).process(user, __import__("uuid").uuid4())


def test_start_and_pause_a_project(rt, user, setup):
    eng, t, aim, _ = setup
    proj = rt.session.get(Project, t.project_id)
    c = Console(rt)
    with pytest.raises(ConsoleError):                             # a free folder has nothing to work towards
        c.project_run(user, proj.id, "start")
    proj.aim_id = aim.id
    lid = live.start("gpt", tags={"perpetual": str(t.id), "aim": str(aim.id)})
    other = live.start("gpt", tags={"perpetual": "someone-else"})
    out = c.project_run(user, proj.id, "pause")
    assert out["state"] == "paused" and t.status == "paused" and out["stopped"] == [lid]   # what it was doing stops too
    assert live.stopped(lid) and not live.stopped(other)
    assert c.project_run(user, proj.id, "start")["state"] == "running" and t.status == "running" and t.next_at
    live.finish(lid, True)
    live.finish(other, True)


def test_switch_an_agent_off_and_stop_it(rt, user, setup, monkeypatch, tmp_path):
    from pga.agents import pool

    data = pool.load()
    data["agents"]["gpt"] = {"adapter": "process", "command": ["true"]}
    pool.save(data)
    lid = live.start("gpt")
    out = Console(rt).set_agent_enabled("gpt", False)
    assert out["stopped"] == [lid] and pool.load()["agents"]["gpt"]["enabled"] is False
    assert Console(rt).set_agent_enabled("gpt", True)["enabled"] and "enabled" not in pool.load()["agents"]["gpt"]
    with pytest.raises(ConsoleError):
        Console(rt).set_agent_enabled("nobody", True)
    live.finish(lid, True)


def test_console_api_and_page(session_factory, policy, provider, backend, user, session):
    session.commit()
    app = create_app(session_factory=session_factory,
                     runtime_factory=lambda s: Runtime(s, policy=policy, provider=provider, translation_backend=backend))
    with TestClient(app) as c:
        assert "工作台" in c.get("/console").text
        r = c.get(f"/v1/users/{user.id}/console")
        assert r.status_code == 200 and set(r.json()) >= {"aims", "free_projects", "agents", "live"}
        lid = live.start("anyone")
        assert c.post("/v1/agents/anyone/stop").json()["stopped"] == [lid]
        live.finish(lid, False)
