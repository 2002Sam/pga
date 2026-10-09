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
