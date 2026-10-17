"""End-to-end through the HTTP API: Chinese user, Chinese responsibility, events, wake, audit."""

from __future__ import annotations

import pytest
from fastapi.testclient import TestClient

from pga.api.app import create_app
from pga.runtime import Runtime

from .conftest import has_cjk


@pytest.fixture
def client(session_factory, policy, provider, backend):
    app = create_app(session_factory=session_factory,
                     runtime_factory=lambda s: Runtime(s, policy=policy, provider=provider, translation_backend=backend))
    with TestClient(app) as c:
        yield c


def test_full_flow(client, provider):
    user = client.post("/v1/users", json={"locale": "zh-CN"}).json()
    uid = user["id"]

    r = client.post(f"/v1/users/{uid}/responsibilities",
                    json={"title": "世界模型研究", "keywords": ["world model", "genie"]})
    assert r.status_code == 201, r.text
    resp = r.json()
    assert resp["title_en"] == "world model research" and resp["raw_title"] == "世界模型研究"
    assert resp["status"] == "MONITORING"
    rid = resp["id"]

    chat = client.post("/v1/chat", json={"user_id": uid, "text": "你好"}).json()
    assert chat["user_message"]["canonical_en"] == "Hello"
    assert chat["reply"]["translation_status"] == "TRANSLATED" and has_cjk(chat["reply"]["display_text"])
    assert chat["allocation"]["outcome"] == "APPROVED" and chat["run_id"]
    assert "world model research" in provider.calls[-1].system   # the model sees the responsibility in English

    # three syndicated copies of one story: one event, sub-linear tension
    deltas = []
    for i in range(3):
        ev = client.post(f"/v1/users/{uid}/events", json={
            "text": "DeepMind releases Genie 4 world model for robot training", "source_uri": f"https://s{i}.com/g4"}).json()
        deltas.append(ev["effects"][0]["delta"])
    assert deltas[1] < deltas[0] * 0.5 and ev["cluster_sources"] == 3

    ev = client.post(f"/v1/users/{uid}/events", json={
        "text": "Benchmark contradicts world model sim-to-real claims",
        "signals": {rid: {"relevance": 0.9, "contradiction": 1.0, "decision_impact": 0.9}}}).json()
    assert ev["effects"][0]["transition"] == "wake"

    why = client.get(f"/v1/responsibilities/{rid}/why").json()
    assert why["status"] == "ACTIVE" and why["last_wake"]["why_now"]

    runs = client.get(f"/v1/users/{uid}/runs").json()
    assert runs[0]["kind"] == "user_interaction" and runs[0]["why_now"] and runs[0]["status"] == "SUCCEEDED"

    quota = client.get("/v1/quota").json()[0]
    assert quota["used"] > 0 and quota["reserve"] == 300_000

    alloc = client.post("/v1/allocations", json={"user_id": uid, "kind": "deep_research", "responsibility_id": rid}).json()
    assert alloc["outcome"] == "DENIED" and alloc["reasons"][0].startswith("missing justification")


def test_error_mapping(client):
    uid = client.post("/v1/users", json={}).json()["id"]
    rid = client.post(f"/v1/users/{uid}/responsibilities", json={"title": "Track AI policy"}).json()["id"]
    bad = client.post(f"/v1/responsibilities/{rid}/actions/archive")
    assert bad.status_code == 409 and bad.json()["error"] == "TransitionError"
    assert client.post(f"/v1/responsibilities/{rid}/actions/fly").status_code == 409
    assert client.get("/v1/responsibilities/00000000-0000-0000-0000-000000000000").status_code == 404
    pref = client.post(f"/v1/users/{uid}/situation", json={"type": "PREFERENCE", "text": "short reports"})
    assert pref.status_code == 422  # preferences need a topic
    ok = client.post(f"/v1/users/{uid}/situation",
                     json={"type": "PREFERENCE", "text": "short reports", "topic": "report_length"})
    assert ok.status_code == 201
    perms = client.patch(f"/v1/users/{uid}/permissions", json={"rules": {"SPEND": "deny"}}).json()
    assert perms["rules"]["SPEND"] == "deny" and perms["version"] == 2
    for i in range(2):
        client.post(f"/v1/users/{uid}/responsibilities", json={"title": f"r{i}"})
    limit = client.post(f"/v1/users/{uid}/responsibilities", json={"title": "fourth"})
    assert limit.status_code == 409 and limit.json()["error"] == "LimitExceeded"


def test_glossary_correction_endpoint(client):
    uid = client.post("/v1/users", json={}).json()["id"]
    r = client.post(f"/v1/users/{uid}/glossary/corrections",
                    json={"source_lang": "en", "target_lang": "zh", "source_term": "artifact", "corrected": "产出物"})
    assert r.status_code == 201 and r.json()["target_term"] == "产出物"


def test_web_app_is_served_at_root(client):
    r = client.get("/")                                              # PGA opens on the forest
    assert r.status_code == 200 and "text/html" in r.headers["content-type"] and "森林" in r.text
    old = client.get("/console")                                     # the old workbench lives on as an archive
    assert old.status_code == 200 and old.url.path == "/archive/console" and "工作台" in old.text
    assert client.get("/archive/sky").status_code == 200
    assert "Agent" in client.get("/agents").text and client.get("/ui/shell.js").status_code == 200


def test_pressure_series_follows_the_tension_ledger(client):
    uid = client.post("/v1/users", json={}).json()["id"]
    rid = client.post(f"/v1/users/{uid}/responsibilities", json={"title": "world model research"}).json()["id"]
    client.post(f"/v1/responsibilities/{rid}/tension", json={"delta": 0.4, "reason": "test"})
    out = client.get(f"/v1/users/{uid}/pressure", params={"hours": 1, "buckets": 12}).json()
    assert len(out["points"]) == 12 and out["points"][-1]["p"] == out["now"]["p"] > 0
    assert set(out["now"]) >= {"p", "avg", "awake", "waiting", "wake_threshold", "units_last_2m"}


def test_graph_links_core_agents_and_free_slots(client):
    uid = client.post("/v1/users", json={}).json()["id"]
    rid = client.post(f"/v1/users/{uid}/responsibilities", json={"title": "world model research"}).json()["id"]
    client.post(f"/v1/responsibilities/{rid}/tension", json={"delta": 0.3, "reason": "test"})
    g = client.get(f"/v1/users/{uid}/graph").json()
    kinds = {n["id"]: n["kind"] for n in g["nodes"]}
    assert kinds["core"] == "core" and kinds["you"] == "user" and kinds[rid] == "agent" and kinds["aim:new"] == "aim"
    assert {"source": "aim:new", "target": rid, "kind": "agent"} in g["links"]
    assert g["free_slots"] == 2 and g["events"][0]["agent"] == rid


def test_pressure_has_candles_and_worker_status(client):
    uid = client.post("/v1/users", json={}).json()["id"]
    rid = client.post(f"/v1/users/{uid}/responsibilities", json={"title": "t"}).json()["id"]
    client.post(f"/v1/responsibilities/{rid}/tension", json={"delta": 0.4, "reason": "up"})
    client.post(f"/v1/responsibilities/{rid}/tension", json={"delta": -0.1, "reason": "down"})
    out = client.get(f"/v1/users/{uid}/pressure", params={"hours": 1, "buckets": 10}).json()
    last = out["points"][-1]
    assert last["h"] >= last["c"] >= last["l"] and last["h"] == 0.4 and last["c"] == 0.3
    assert out["now"]["worker"]["alive"] is False and out["now"]["last_event_at"]


def test_chat_can_address_one_agent(client, provider):
    uid = client.post("/v1/users", json={}).json()["id"]
    rid = client.post(f"/v1/users/{uid}/responsibilities", json={"title": "world model research"}).json()["id"]
    r = client.post("/v1/chat", json={"user_id": uid, "text": "status?", "responsibility_id": rid})
    assert r.status_code == 200
    assert "<focus>" in provider.calls[-1].system and "world model research" in provider.calls[-1].system


def test_pressure_buckets_are_aligned_between_polls(client):
    uid = client.post("/v1/users", json={}).json()["id"]
    a = client.get(f"/v1/users/{uid}/pressure", params={"hours": 1, "buckets": 60}).json()
    b = client.get(f"/v1/users/{uid}/pressure", params={"hours": 1, "buckets": 60}).json()
    assert a["step_seconds"] == 60 and a["points"][0]["t0"] == b["points"][0]["t0"]
    assert all(p["t0"].endswith(":00+00:00") for p in a["points"])            # on whole minutes
    assert a["points"][-1]["t"] > a["end"]                                    # the last candle is still forming


def test_aims_are_solar_systems_and_reach_the_chat(client, provider):
    uid = client.post("/v1/users", json={}).json()["id"]
    a1 = client.post(f"/v1/users/{uid}/aims", json={"text": "build an agent that never stops"}).json()
    a2 = client.post(f"/v1/users/{uid}/aims", json={"text": "stay healthy"}).json()
    assert [a["position"] for a in client.get(f"/v1/users/{uid}/aims").json()] == [0, 1]
    r1 = client.post(f"/v1/users/{uid}/responsibilities", json={"title": "world models"}).json()
    r2 = client.post(f"/v1/users/{uid}/responsibilities", json={"title": "sleep", "aim_id": a2["id"]}).json()
    assert r1["aim_id"] == a1["id"] and r2["aim_id"] == a2["id"]   # default: the first aim
    g = client.get(f"/v1/users/{uid}/graph").json()
    suns = {n["id"]: n for n in g["nodes"] if n["kind"] == "aim"}
    assert set(suns) == {f"aim:{a1['id']}", f"aim:{a2['id']}"} and suns[f"aim:{a2['id']}"]["label"] == "stay healthy"
    assert {"source": f"aim:{a2['id']}", "target": r2["id"], "kind": "agent"} in g["links"]
    assert {"source": "you", "target": f"aim:{a1['id']}", "kind": "aim"} in g["links"]

    moved = client.patch(f"/v1/responsibilities/{r2['id']}", json={"aim_id": a1["id"]}).json()
    assert moved["aim_id"] == a1["id"]
    client.post("/v1/chat", json={"user_id": uid, "text": "hi"})
    system = provider.calls[-1].system
    assert "<long_range_aims>" in system and "never stops" in system and "stay healthy" in system

    assert client.delete(f"/v1/aims/{a1['id']}").status_code == 204
    assert client.get(f"/v1/responsibilities/{r1['id']}").json()["aim_id"] is None


def test_single_aim_endpoint_still_works(client):
    uid = client.post("/v1/users", json={}).json()["id"]
    assert client.put(f"/v1/users/{uid}/aim", json={"text": "one aim"}).json()["aim"] == "one aim"
    assert [a["text"] for a in client.get(f"/v1/users/{uid}/aims").json()] == ["one aim"]
    assert client.put(f"/v1/users/{uid}/aim", json={"text": ""}).json()["aim"] is None
    assert client.get(f"/v1/users/{uid}/aims").json() == []


def test_linked_ai_agents_orbit_the_aim(client):
    uid = client.post("/v1/users", json={}).json()["id"]
    a = client.post(f"/v1/users/{uid}/hub/agents", json={"name": "ChatGPT", "vendor": "chatgpt"}).json()
    g = client.get(f"/v1/users/{uid}/graph").json()
    assert any(n["id"] == f"ai:{a['id']}" and n["kind"] == "ai" for n in g["nodes"])
    assert {"source": f"ai:{a['id']}", "target": "you", "kind": "ai"} in g["links"]


def test_icons_and_manifest_are_served(session_factory, policy, provider, backend):
    from fastapi.testclient import TestClient as _TC
    from pga.api.app import create_app as _create
    from pga.runtime import Runtime as _RT
    c = _TC(_create(session_factory, lambda s: _RT(s, policy=policy, provider=provider, translation_backend=backend)))
    m = c.get("/manifest.webmanifest").json()
    assert {i["sizes"] for i in m["icons"]} >= {"192x192", "512x512"}
    for i in m["icons"]:
        assert c.get(i["src"]).status_code == 200
    assert c.get("/icons/apple-touch-icon.png").headers["content-type"] == "image/png"
    assert c.get("/icons/..%2Fapp.py").status_code == 404 and c.get("/icons/nope.png").status_code == 404
