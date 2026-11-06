"""An agent's profile: read it (who it is, how it has done, where it ranks), change what is yours to change, and the
standing instructions written there reach the agent with every question."""
from fastapi.testclient import TestClient

from pga.agents import AgentPool, pool as ap
from pga.agents.routing import AgentRouter
from pga.api.app import create_app
from pga.db.models import AgentRun
from pga.runtime import Runtime


def test_profile_read_and_edit(session_factory, session, user, policy, provider, backend, tmp_path, monkeypatch):
    monkeypatch.setattr(ap, "CONFIG", tmp_path / "agents.yaml")
    parent = AgentRun(user_id=user.id, workflow="ask", pattern="single", step="run", agent="deepseek", adapter="llm", status="SUCCEEDED")
    session.add(parent); session.flush()
    for status in ("SUCCEEDED", "SUCCEEDED", "FAILED"):
        session.add(AgentRun(user_id=user.id, parent_id=parent.id, workflow="ask", pattern="single", step="run", agent="deepseek",
                             adapter="llm", status=status, duration_s=4.0))
    session.commit()
    c = TestClient(create_app(session_factory, lambda s: Runtime(s, policy=policy, provider=provider, translation_backend=backend)))
    p = c.get(f"/v1/users/{user.id}/agents/deepseek/profile").json()
    assert p["name"] == "deepseek" and p["stats"]["tries"] == 3 and p["stats"]["succeeded"] == 2 and p["stats"]["failed"] == 1
    assert p["ranking"] and all("label" in r for r in p["ranking"]) and "quick" in p["categories"]
    assert c.get(f"/v1/users/{user.id}/agents/nobody/profile").status_code == 404
    r = c.put("/v1/agents/deepseek/profile", json={"role": "快问快答", "instructions": "先给结论。", "capabilities": ["quick", "serious", "BAD!"],
                                                    "traits": {"quality": 9, "speed": 1}, "max_concurrent": 2, "account": "me@example.com"})
    assert r.status_code == 200, r.text
    a = ap.load()["agents"]["deepseek"]
    assert a["role"] == "快问快答" and a["instructions"] == "先给结论。" and a["capabilities"] == ["quick", "serious"]
    assert a["traits"]["quality"] == 5 and a["traits"]["speed"] == 1 and a["max_concurrent"] == 2 and a["account"] == "me@example.com"
    assert c.put("/v1/agents/deepseek/profile", json={"capabilities": []}).status_code == 422
    assert c.put("/v1/agents/deepseek/profile", json={"instructions": "", "account": ""}).status_code == 200
    assert "instructions" not in ap.load()["agents"]["deepseek"] and "account" not in ap.load()["agents"]["deepseek"]


def test_standing_instructions_reach_the_agent(rt, user, provider, tmp_path, monkeypatch):
    monkeypatch.setattr(ap, "CONFIG", tmp_path / "agents.yaml")
    cfg = ap.load()
    cfg["agents"]["deepseek"]["instructions"] = "回答前先说一句「收到」。"
    ap.save(cfg)
    seen = []
    provider.handler = lambda s, m: seen.append(s) or "收到。好的"
    out = AgentRouter(rt, AgentPool(rt)).ask(user, "你好", agent="deepseek")
    assert out["ok"] and any("回答前先说一句「收到」。" in s and "<your_standing_instructions_for_this_agent>" in s for s in seen)


def test_changing_an_agents_avatar(session_factory, policy, provider, backend, tmp_path, monkeypatch):
    import base64
    from pga.agents import avatars
    monkeypatch.setattr(ap, "CONFIG", tmp_path / "agents.yaml")
    monkeypatch.setattr(avatars, "ROOT", tmp_path / "avatars")
    c = TestClient(create_app(session_factory, lambda s: Runtime(s, policy=policy, provider=provider, translation_backend=backend)))
    png = b"\x89PNG\r\n\x1a\n" + b"\x00" * 64
    url = "data:image/png;base64," + base64.b64encode(png).decode()
    assert c.get("/v1/agents/avatars").json()["avatars"] == {}
    fake = "data:image/png;base64," + base64.b64encode(b"<svg onload=alert(1)>").decode()
    assert c.put("/v1/agents/claude/avatar", json={"image": fake}).status_code == 422          # not what it claims to be
    assert c.put("/v1/agents/claude/avatar", json={"text": "太长的名字"}).status_code == 422
    assert c.put("/v1/agents/claude/avatar", json={"color": "red"}).status_code == 422
    r = c.put("/v1/agents/claude/avatar", json={"image": url, "text": "🦊", "color": "#5E8B7E"})
    assert r.status_code == 200, r.text
    a = r.json()["avatar"]
    assert a["image"].startswith("/v1/agents/claude/avatar?v=") and a["text"] == "🦊" and a["color"] == "#5E8B7E"
    got = c.get("/v1/agents/claude/avatar")
    assert got.status_code == 200 and got.content == png and "immutable" in got.headers["cache-control"]
    assert c.get("/v1/agents/avatars").json()["avatars"]["claude"]["text"] == "🦊"
    assert c.put("/v1/agents/claude/avatar", json={"image": None, "text": "", "color": ""}).status_code == 200
    assert c.get("/v1/agents/claude/avatar").status_code == 404 and c.get("/v1/agents/avatars").json()["avatars"] == {}
    assert "avatar_text" not in ap.load()["agents"]["claude"]
    assert c.put("/v1/agents/nobody/avatar", json={"text": "A"}).status_code == 404
    assert c.get("/v1/agents/..%2Fx/avatar").status_code == 404
