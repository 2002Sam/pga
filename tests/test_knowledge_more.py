"""Batch 2: documents you upload, your own edits to the personal model, a conversation's instructions, ratings in routing."""
import base64
import json
from datetime import datetime, timezone

from fastapi.testclient import TestClient

import pga.knowledge.uploads as U
from pga.agents.routing import AgentRouter, rating_table
from pga.api.app import create_app
from pga.db.models import AgentRun, Body
from pga.db.types import Origin
from pga.knowledge.datasets import _apply_mine, edit_facts
from pga.runtime import Runtime


def test_passages_are_picked_by_the_question():
    text = "\n\n".join([f"第{i}节。" + ("无关的内容。" * 200) for i in range(8)] + ["提示词缓存按前缀命中，开头一字不差才能省钱。"] + ["别的。" * 80])
    parts = U.chunks(text)
    assert len(parts) > 6 and all(len(p) < 2000 for p in parts)
    picked = U.best(text, "前缀缓存怎么命中？", k=2)
    assert any("前缀命中" in p for _, p in picked)


def test_upload_reference_and_retrieval(session_factory, policy, provider, backend, user, session, monkeypatch, tmp_path):
    monkeypatch.setattr(U, "ROOT", tmp_path)
    doc = ("# 说明书\n\n" + "\n\n".join("填充段落。" * 200 for _ in range(10)) + "\n\n退货政策：收到货 30 天内可以无理由退货。\n\n" + "结尾。" * 100)
    data = "data:text/markdown;base64," + base64.b64encode(doc.encode()).decode()
    seen = []
    monkeypatch.setattr(AgentRouter, "ask", lambda self, u, text, **kw: seen.append(kw) or {"ok": True, "text": "ok"})
    app = create_app(session_factory=session_factory,
                     runtime_factory=lambda s: Runtime(s, policy=policy, provider=provider, translation_backend=backend))
    with TestClient(app) as c:
        r = c.post(f"/v1/users/{user.id}/knowledge/upload", json={"name": "说明书.md", "data": data})
        assert r.status_code == 201, r.text
        bid = r.json()["id"]
        assert r.json()["passages"] > 6 and list(tmp_path.glob("*/*说明书.md"))
        c.post(f"/v1/users/{user.id}/agents/ask", json={"text": "退货政策是什么？", "refs": [bid], "conversation": "chat:k"})
        tail = seen[0]["tail"]
        assert "30 天内" in tail and "referenced_document" in tail and len(tail) < 9000     # only the matching passages
        assert "退货" not in (seen[0].get("context") or "")                                    # after the question, not in the opening
        bad = c.post(f"/v1/users/{user.id}/knowledge/upload", json={"name": "x.bin", "data": "data:application/octet-stream;base64,AAAA"})
        assert bad.status_code == 422
        c.put(f"/v1/users/{user.id}/chat-system", json={"key": "chat:k", "text": "用英文回答。"})
        c.post(f"/v1/users/{user.id}/agents/ask", json={"text": "hi", "conversation": "chat:k"})
        assert "用英文回答" in seen[1]["context"] and c.get(f"/v1/users/{user.id}/chat-system", params={"key": "chat:k"}).json()["text"] == "用英文回答。"
        c.put(f"/v1/users/{user.id}/chat-context", json={"key": "chat:k", "text": "笔记：只看 2025 年以后的论文"})      # wired in on the stage
        c.post(f"/v1/users/{user.id}/agents/ask", json={"text": "hi", "conversation": "chat:k"})
        assert "只看 2025 年以后" in seen[2]["context"] and "context_wired_in_by_the_user" in seen[2]["context"]
        c.put(f"/v1/users/{user.id}/chat-context", json={"key": "chat:k", "text": ""})
        c.post(f"/v1/users/{user.id}/agents/ask", json={"text": "hi", "conversation": "chat:k"})
        assert "context_wired_in_by_the_user" not in seen[3]["context"]


def test_your_edits_to_the_personal_model_survive_a_rebuild(session):
    b = Body(user_id=None, kind="database", title="个人模型", title_en="Personal model", description="", description_en="", origin=Origin.SYSTEM, system="user",
             data={"dims": {"goals": {"summary": "想做 PGA", "stated": ["做 PGA"], "inferred": ["喜欢工具"], "confidence": .5}},
                   "dims_en": {"goals": {"summary": "wants PGA", "stated": ["build PGA"], "inferred": ["likes tools"], "confidence": .5}}})
    edit_facts(b, "goals", add="今年要毕业")
    edit_facts(b, "goals", remove={"list": "inferred", "i": 0})
    edit_facts(b, "goals", summary="毕业和 PGA 两件事")
    d = b.data
    assert d["dims"]["goals"]["stated"][0] == "今年要毕业" and d["dims"]["goals"]["inferred"] == [] and d["dims"]["goals"]["summary"] == "毕业和 PGA 两件事"
    assert "今年要毕业" in b.description_en
    rebuilt = {"goals": {"summary": "model wrote this", "stated": ["build PGA"], "inferred": ["likes tools", "new guess"], "confidence": .6}}
    out = _apply_mine(rebuilt, d)
    assert out["goals"]["stated"][0] == "今年要毕业" and "likes tools" not in out["goals"]["inferred"] and out["goals"]["summary"] == "毕业和 PGA 两件事"


def test_ratings_move_an_agent_up(rt, user):
    now = datetime.now(timezone.utc)
    for v in (1, 1, 1):
        rt.session.add(AgentRun(user_id=user.id, workflow="ask", pattern="single", step="workflow", agent="beta", adapter="pool", status="SUCCEEDED",
                                prompt="q", output=json.dumps({"answer": "a"}), started_at=now,
                                data={"agent": "beta", "category": "general", "rating": {"value": v}}))
    rt.session.flush()
    import pga.agents.routing as R
    R._RATINGS["at"] = 0
    assert rating_table(rt, user.id)["general"]["beta"] == [3, 0]


def test_multi_answers_fold_notes_web_and_children(session_factory, policy, provider, backend, user, session, monkeypatch):
    import httpx
    from pga.chats import set_branch
    now = datetime.now(timezone.utc)
    a = AgentRun(user_id=user.id, workflow="ask", pattern="single", step="workflow", agent="claude", adapter="pool", status="SUCCEEDED", prompt="同一问",
                 output=json.dumps({"answer": "A"}), data={"conversation": "chat:m", "agent": "claude"}, started_at=now)
    b = AgentRun(user_id=user.id, workflow="ask", pattern="single", step="workflow", agent="codex", adapter="pool", status="SUCCEEDED", prompt="同一问",
                 output=json.dumps({"answer": "B"}), data={"conversation": "multi:x:codex", "agent": "codex"}, started_at=now)
    session.add_all([a, b])
    session.flush()
    set_branch(session.get(type(user), user.id), "chat:child", "chat:m", str(a.id))
    session.commit()
    page = "<html><head><title>测试页</title><script>x()</script></head><body><nav>菜单</nav><h1>标题</h1><p>" + "正文内容。" * 80 + "</p></body></html>"
    monkeypatch.setattr(httpx, "get", lambda url, **kw: httpx.Response(200, text=page, request=httpx.Request("GET", url)))
    app = create_app(session_factory=session_factory,
                     runtime_factory=lambda s: Runtime(s, policy=policy, provider=provider, translation_backend=backend))
    with TestClient(app) as c:
        assert [x["key"] for x in c.get(f"/v1/users/{user.id}/chats").json()] == ["chat:m"]               # the second answer is not a chat
        assert c.post(f"/v1/users/{user.id}/chats/fold", json={"root": str(a.id), "runs": [str(b.id)], "key": "chat:m"}).json()["folded"] == 1
        one = c.get(f"/v1/users/{user.id}/chats/chat:m").json()
        assert [v["text"] for v in one["turns"][1]["versions"]] == ["A", "B"] and one["children"][0]["key"] == "chat:child"
        w = c.post(f"/v1/users/{user.id}/knowledge/web", json={"url": "https://example.com/x"})
        assert w.status_code == 201 and w.json()["title"] == "测试页"
        d = c.get(f"/v1/bodies/{w.json()['id']}/document").json()
        assert "正文内容" in d["full"] and "x()" not in d["full"] and "菜单" not in d["full"]
        assert c.post(f"/v1/users/{user.id}/knowledge/web", json={"url": "ftp://x"}).status_code == 422
        n = c.post(f"/v1/users/{user.id}/notes", json={"text": "# 我的笔记\n第一行"}).json()
        assert n["title"] == "我的笔记"
        c.put(f"/v1/notes/{n['id']}", json={"text": "追加的一段", "append": True})
        assert c.get(f"/v1/users/{user.id}/notes").json()[0]["text"].endswith("追加的一段")
        kinds = {k["id"]: k.get("source") for k in c.get(f"/v1/users/{user.id}/forest").json()["knowledge"]}
        assert kinds[n["id"]] == "note" and kinds[w.json()["id"]] == "web"
