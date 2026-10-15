"""Curated datasets: 用户 and 世界 always exist; each dataset is one document cut into title · summary · full."""

from __future__ import annotations

from datetime import datetime, timedelta, timezone

from pga.aims import AimService
from pga.db.models import AimNote, Body, Message
from pga.db.types import MessageRole, TranslationStatus
from pga.knowledge.datasets import NEWSNOW, Datasets
from pga.llm.router import default_fake_reply

from .test_bodies import client  # noqa: F401  (fixture)


def _said(user, en, at):
    return Message(user_id=user.id, conversation_id=user.id, role=MessageRole.USER, raw_text=en, raw_language="en", canonical_en=en,
                   translation_status=TranslationStatus.NOT_NEEDED, created_at=at)

DOC = "# Overview\n\nThe person builds a perpetual agent called PGA. " + "They care about clear, honest interfaces. " * 12


def _writer(system, messages):
    if system.startswith("You keep one curated knowledge document"):
        return DOC
    return default_fake_reply("m", system, messages)


def test_user_and_world_always_exist_once(rt, user):
    ds = Datasets(rt)
    a = ds.ensure(user)
    b = ds.ensure(user)
    assert set(a) == {"user", "world"} and a["user"].id == b["user"].id
    assert a["user"].title == "用户" and a["world"].title == "世界" and a["user"].aim_id is None


def test_world_is_compiled_from_hot_lists_and_cut_into_a_pyramid(rt, user, provider):
    seen = []

    def fetch(url):
        seen.append(url)
        if "weibo" in url:
            raise RuntimeError("down")                            # one platform down does not stop the rest
        return {"items": [{"title": f"headline {i} from {url[-20:]}"} for i in range(20)]}

    provider.handler = _writer
    w = Datasets(rt, fetch=fetch).ensure(user)["world"]
    out = Datasets(rt, fetch=fetch).compile(user, w)
    assert out.status == "compiled" and out.words > 50
    assert NEWSNOW.format(id="hackernews") in seen
    sent = next(c for c in provider.calls if c.system.startswith("You keep one curated knowledge document"))
    assert "Hacker News" in sent.messages[-1]["content"] and "微博热搜" not in sent.messages[-1]["content"]
    assert w.description_en == DOC.strip() and w.description.startswith("# Overview\n") and w.compiled_at is not None
    levels = rt.layers.rows([f"k:{w.id}"])[f"k:{w.id}"]
    assert set(levels) == {1, 2, 3}                               # title · summary · full


def test_nothing_reachable_means_no_world_document(rt, user):
    w = Datasets(rt, fetch=lambda url: {"items": []}).ensure(user)["world"]
    out = Datasets(rt, fetch=lambda url: {"items": []}).compile(user, w)
    assert out.status == "failed" and w.compiled_at is None


def test_the_user_dataset_reads_everything_the_user_wrote(rt, user, provider):
    now = datetime.now(timezone.utc)
    AimService(rt.session).create(user, "做一个不会停的 agent", "Build an agent that never stops")
    rt.session.add(_said(user, "I like clean interfaces", now))
    rt.session.flush()
    provider.handler = _writer
    u = Datasets(rt).ensure(user)["user"]
    assert Datasets(rt).compile(user, u, now).status == "compiled"
    sent = next(c for c in provider.calls if c.system.startswith("You keep one curated knowledge document"))
    assert "I like clean interfaces" in sent.messages[-1]["content"] and "Build an agent that never stops" in sent.messages[-1]["content"]
    # rebuilt only when something new arrived, and not too often
    ds = Datasets(rt)
    later = now + timedelta(days=2)
    assert u not in ds.due(user, later)
    rt.session.add(_said(user, "one more thing", now + timedelta(days=1)))
    rt.session.flush()
    assert u in ds.due(user, later)


def test_a_motivation_gets_its_knowledge_dataset_once_it_found_something(rt, user, provider):
    now = datetime.now(timezone.utc)
    aim = AimService(rt.session).create(user, "世界模型", "World models")
    ds = Datasets(rt)
    assert not [b for b in ds.due(user, now) if b.system == "aim"]
    rt.session.add(AimNote(user_id=user.id, aim_id=aim.id, kind="answer", text="JEPA 预测表征", text_en="JEPA predicts representations",
                           data={"code": "Q1", "question": "What is JEPA?"}, created_at=now))
    rt.session.flush()
    b = next(b for b in ds.due(user, now) if b.system == "aim")
    assert b.aim_id == aim.id and b.title.endswith("知识")
    provider.handler = _writer
    assert ds.compile(user, b, now).status == "compiled"
    sent = next(c for c in provider.calls if c.system.startswith("You keep one curated knowledge document"))
    assert "[answer Q1] (question: What is JEPA?) JEPA predicts representations" in sent.messages[-1]["content"]


def test_the_map_shows_datasets_not_fragments(client, rt, user):
    rt.session.commit()
    g = client.get(f"/v1/users/{user.id}/graph").json()
    mine = {n["system"]: n for n in g["nodes"] if n.get("system")}
    assert set(mine) == {"user", "world"} and mine["user"]["aim"] is None
    assert not [n for n in g["nodes"] if n["kind"] == "knowledge"]
    assert "free_slots" in g
    world = rt.session.get(Body, __import__("uuid").UUID(mine["world"]["body_id"]))
    assert client.delete(f"/v1/bodies/{world.id}").status_code == 409
    doc = client.get(f"/v1/bodies/{world.id}/document").json()
    assert doc["system"] == "world" and doc["gist"]
