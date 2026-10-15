"""Ambition maps: databases and skills as bodies, bridges the user drags between them, auto-expansion."""

from __future__ import annotations

import json

import pytest
from fastapi.testclient import TestClient

from pga.api.app import create_app
from pga.runtime import Runtime


@pytest.fixture
def client(session_factory, policy, provider, backend):
    app = create_app(session_factory=session_factory,
                     runtime_factory=lambda s: Runtime(s, policy=policy, provider=provider, translation_backend=backend))
    with TestClient(app) as c:
        yield c


def _setup(client):
    uid = client.post("/v1/users", json={"locale": "en"}).json()["id"]
    a1 = client.post(f"/v1/users/{uid}/aims", json={"text": "build a perpetual agent"}).json()
    a2 = client.post(f"/v1/users/{uid}/aims", json={"text": "stay healthy"}).json()
    agent = client.post(f"/v1/users/{uid}/responsibilities", json={"title": "world models", "aim_id": a1["id"]}).json()
    return uid, a1, a2, agent


def test_bodies_sit_in_their_ambition_and_can_be_bridged(client, provider):
    uid, a1, a2, agent = _setup(client)
    db = client.post(f"/v1/users/{uid}/bodies", json={"kind": "database", "title": "sleep studies", "aim_id": a2["id"]}).json()
    secret = client.post(f"/v1/users/{uid}/bodies", json={"kind": "skill", "title": "my diary", "aim_id": a2["id"], "private": True}).json()
    assert db["ref"] == f"k:{db['id']}" and db["origin"] == "USER"

    g = client.get(f"/v1/users/{uid}/graph").json()
    nodes = {n["id"]: n for n in g["nodes"]}
    assert nodes[db["ref"]]["kind"] == "database" and nodes[db["ref"]]["aim"] == f"aim:{a2['id']}"
    assert nodes[secret["ref"]]["private"] is True

    # drag the agent onto the database in the other orbit, and onto the private skill
    br = client.post(f"/v1/users/{uid}/bridges", json={"a": agent["id"], "b": db["ref"], "note": "rest helps focus"}).json()
    client.post(f"/v1/users/{uid}/bridges", json={"a": secret["ref"], "b": agent["id"]})
    again = client.post(f"/v1/users/{uid}/bridges", json={"a": db["ref"], "b": agent["id"]}).json()
    assert again["id"] == br["id"]                                       # same pair, either direction
    links = client.get(f"/v1/users/{uid}/graph").json()["links"]
    assert sum(l["kind"] == "bridge" for l in links) == 2

    client.post("/v1/chat", json={"user_id": uid, "text": "status?", "responsibility_id": agent["id"]})
    system = provider.calls[-1].system
    assert "<linked_knowledge>" in system and "sleep studies" in system and "rest helps focus" in system
    assert "my diary" not in system                                      # private bodies never reach the model

    # a database linked to an ambition reaches every agent in that ambition
    other = client.post(f"/v1/users/{uid}/bodies", json={"kind": "database", "title": "robotics datasets", "aim_id": a2["id"]}).json()
    client.post(f"/v1/users/{uid}/bridges", json={"a": other["ref"], "b": f"aim:{a1['id']}"})
    client.post("/v1/chat", json={"user_id": uid, "text": "status?", "responsibility_id": agent["id"]})
    assert "linked to this agent's ambition" in provider.calls[-1].system and "robotics datasets" in provider.calls[-1].system

    assert client.post(f"/v1/users/{uid}/bridges", json={"a": agent["id"], "b": agent["id"]}).status_code == 422
    assert client.post(f"/v1/users/{uid}/bridges", json={"a": agent["id"], "b": "k:00000000-0000-0000-0000-000000000000"}).status_code == 422
    assert client.delete(f"/v1/bridges/{br['id']}").status_code == 204
    assert client.delete(f"/v1/bodies/{secret['id']}").status_code == 204
    assert sum(l["kind"] == "bridge" for l in client.get(f"/v1/users/{uid}/graph").json()["links"]) == 1   # the ambition link remains


def test_expand_fills_an_ambition_with_databases_and_skills(client, provider):
    uid, a1, _a2, _agent = _setup(client)

    def handler(system, messages):
        if system.startswith("You help a person pursue a long-range ambition"):
            assert "build a perpetual agent" in messages[-1]["content"]
            return json.dumps({"databases": [{"title": "Agent papers", "description": "research on long-running agents"},
                                             {"title": "Failure log", "description": "what broke and why"}],
                               "skills": [{"title": "Evaluation design", "description": "measure agent quality"}]})
        from pga.llm.router import default_fake_reply
        return default_fake_reply("m", system, messages)

    provider.handler = handler
    made = client.post(f"/v1/aims/{a1['id']}/expand").json()
    assert sorted((b["kind"], b["title_en"]) for b in made) == [
        ("database", "Agent papers"), ("database", "Failure log"), ("skill", "Evaluation design")]
    assert all(b["origin"] == "AGENT" and b["aim_id"] == a1["id"] for b in made)
    # asking again does not repeat what is already on the map
    provider.handler = lambda s, m: json.dumps({"databases": [{"title": "Agent papers"}], "skills": []})
    assert client.post(f"/v1/aims/{a1['id']}/expand").status_code == 422


def test_links_say_what_they_mean(rt, user):
    import pytest

    from pga.aims import AimService
    from pga.bodies import BodyError, BodyService

    aim = AimService(rt.session).create(user, "世界模型", "World models")
    svc = BodyService(rt)
    a = svc.create(user, kind="database", title="论文库", title_en="Paper library", aim_id=aim.id)
    br = svc.bridge(user.id, f"k:{a.id}", f"aim:{aim.id}", kind="derived_from")
    assert br.kind == "derived_from"
    assert svc.bridge(user.id, f"aim:{aim.id}", f"k:{a.id}", kind="contradicts").kind == "contradicts"   # same pair: updated
    with pytest.raises(BodyError):
        svc.bridge(user.id, f"k:{a.id}", f"aim:{aim.id}", kind="vibes")
