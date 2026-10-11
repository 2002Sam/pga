"""Information pyramid: every item at gist / brief / full; long input condensed, short input expanded."""

from __future__ import annotations

import json
import re
from datetime import timedelta

import pytest
from fastapi.testclient import TestClient
from sqlalchemy import select

from pga.aims import AimService
from pga.api.app import create_app
from pga.bodies import BodyService
from pga.db.models import Job, User
from pga.db.types import Origin, utcnow
from pga.layers import EXPANDED_NOTE, clip, words
from pga.llm.router import default_fake_reply
from pga.permissions import create_default_policy
from pga.runtime import Runtime

LONG = " ".join(f"Sentence {i} explains one more part of a very long ambition about building tools that last." for i in range(30))


def pyramid_handler(log: list[str] | None = None, *, gist_words: int = 8):
    """Fake model: writes exactly the levels it is asked for, each of a recognisable length."""
    def handler(system, messages):
        if not system.startswith("You turn one item"):
            return default_fake_reply("m", system, messages)
        ask = messages[-1]["content"].split("Write:")[-1]
        if log is not None:
            log.append(ask.strip())
        out = {}
        if "gist" in ask:
            out["gist"] = " ".join(["gist"] * gist_words) + "."
        if "brief" in ask:
            out["brief"] = " ".join(["brief"] * 60) + "."
        if "full" in ask:
            out["full"] = " ".join(["full"] * 300) + "."
        return json.dumps(out)
    return handler


@pytest.fixture
def en_user(session, policy) -> User:
    pp = create_default_policy(session, policy)
    u = User(locale="en", timezone="UTC", permission_policy_id=pp.id, preferences={})
    session.add(u)
    session.flush()
    return u


def test_measuring_and_cutting_text():
    assert words("build a perpetual agent") == 4
    assert words("建立一个永续代理") == 4                       # a CJK character counts half a word
    assert clip("One. Two three. Four five six.", 3) == "One. Two three."
    cut = clip("一二三四五六七八九十。后面", 3)
    assert cut == "一二三四五六…" and words(cut.rstrip("…")) <= 3
    assert clip("short", 10) == "short"
    assert clip("Build an agent that remembers, plans ahead, and acts on its own for years", 8) == "Build an agent that remembers, plans ahead…"


def test_short_aim_is_expanded_long_aim_condensed_medium_both(rt, en_user, provider):
    asked: list[str] = []
    provider.handler = pyramid_handler(asked)
    aims = AimService(rt.session)

    short = aims.create(en_user, "build a perpetual agent", "build a perpetual agent")
    p = rt.layers.build(en_user, f"aim:{short.id}")
    assert p.source_level == 1 and p.strict
    assert [p.levels[lv].mode for lv in (1, 2, 3)] == ["source", "expanded", "expanded"]
    assert p.levels[1].text_en == "build a perpetual agent"
    assert "brief (EXPAND)" in asked[-1] and "full (EXPAND)" in asked[-1] and "gist" not in asked[-1]

    medium_text = " ".join(["detail"] * 60)
    medium = aims.create(en_user, medium_text, medium_text)
    p = rt.layers.build(en_user, f"aim:{medium.id}")
    assert p.source_level == 2 and [p.levels[lv].mode for lv in (1, 2, 3)] == ["condensed", "source", "expanded"]
    assert "gist (CONDENSE)" in asked[-1] and "full (EXPAND)" in asked[-1]

    long = aims.create(en_user, LONG, LONG)
    p = rt.layers.build(en_user, f"aim:{long.id}")
    assert p.source_level == 3 and [p.levels[lv].mode for lv in (1, 2, 3)] == ["condensed", "condensed", "source"]
    assert p.levels[3].text_en == LONG and p.strict
    assert p.levels[1].words <= rt.policy.layers.gist_max_words

    # a fresh pyramid is not rebuilt; a changed item is
    n = len(provider.calls)
    rt.layers.build(en_user, f"aim:{short.id}")
    assert len(provider.calls) == n
    aims.update(short, "build a perpetual agent that never stops", "build a perpetual agent that never stops")
    assert rt.layers.get(f"aim:{short.id}").stale
    assert rt.layers.build(en_user, f"aim:{short.id}").levels[1].text_en.endswith("never stops")


def test_model_output_is_forced_into_a_pyramid(rt, en_user, provider):
    provider.handler = pyramid_handler(gist_words=200)                  # a "gist" far too long
    text = " ".join(["detail"] * 60)
    a = AimService(rt.session).create(en_user, text, text)
    p = rt.layers.build(en_user, f"aim:{a.id}")
    assert p.levels[1].words <= rt.policy.layers.gist_max_words * 1.5 and p.strict


def test_private_bodies_never_reach_the_model_and_failures_fall_back(rt, en_user, provider):
    provider.handler = pyramid_handler()
    a = AimService(rt.session).create(en_user, "stay healthy", "stay healthy")
    secret = BodyService(rt).create(en_user, kind="database", title="my diary", title_en="my diary",
                                    description=LONG, description_en=LONG, aim_id=a.id, private=True)
    n = len(provider.calls)
    p = rt.layers.build(en_user, f"k:{secret.id}")
    assert len(provider.calls) == n                                      # cut by rule, no model call
    assert p.levels[3].mode == "source" and p.levels[1].mode == "rule" and words(p.levels[1].text_en) <= 25

    provider.handler = lambda s, m: "not json" if s.startswith("You turn one item") else default_fake_reply("m", s, m)
    p = rt.layers.build(en_user, f"aim:{a.id}")
    assert {p.levels[lv].mode for lv in (2, 3)} == {"rule"} and not p.strict   # no model: a flat pyramid for now
    now = utcnow()
    assert f"aim:{a.id}" not in rt.layers.due(en_user.id, now, 10)                     # not retried at once…
    assert f"aim:{a.id}" in rt.layers.due(en_user.id, now + timedelta(hours=7), 10)    # …but after retry_hours
    provider.handler = pyramid_handler()
    assert rt.layers.build(en_user, f"aim:{a.id}").strict


def test_select_steps_down_least_important_first(rt, en_user, provider):
    provider.handler = pyramid_handler()
    aims = AimService(rt.session)
    refs = []
    for t in ("first aim", "second aim", "third aim"):
        a = aims.create(en_user, t, t)
        rt.layers.build(en_user, f"aim:{a.id}")
        refs.append(f"aim:{a.id}")
    every_full = rt.layers.select([(r, 3, w) for r, w in zip(refs, (3, 2, 1))], 10_000)
    assert [lv for _, lv, _ in every_full] == [3, 3, 3]
    assert every_full[0][2].startswith(EXPANDED_NOTE)                  # expansions are labelled for the model
    tight = rt.layers.select([(r, 3, w) for r, w in zip(refs, (3, 2, 1))], 400)
    levels = {r: lv for r, lv, _ in tight}
    assert levels[refs[0]] == 3 and levels[refs[2]] < levels[refs[0]]   # the important one keeps its detail
    assert sum(words(t) for _, _, t in tight) <= 400
    tiny = rt.layers.select([(r, 3, w) for r, w in zip(refs, (3, 2, 1))], 3)
    assert [r for r, _, _ in tiny] == [refs[0]]                         # all at gist and still too long: drop the least


def test_processes_read_the_level_they_need(session_factory, policy, provider, backend):
    provider.handler = pyramid_handler()
    app = create_app(session_factory=session_factory,
                     runtime_factory=lambda s: Runtime(s, policy=policy, provider=provider, translation_backend=backend))
    with TestClient(app) as client:
        uid = client.post("/v1/users", json={"locale": "en"}).json()["id"]
        a1 = client.post(f"/v1/users/{uid}/aims", json={"text": "build a perpetual agent"}).json()
        a2 = client.post(f"/v1/users/{uid}/aims", json={"text": LONG}).json()
        agent = client.post(f"/v1/users/{uid}/responsibilities", json={"title": "world models", "aim_id": a1["id"]}).json()

        # saving cut the pyramid by rule at once and queued the model build
        got = client.get(f"/v1/users/{uid}/layers", params={"ref": f"aim:{a2['id']}"}).json()
        assert got["source_level"] == 3 and not got["ready"] and got["levels"][2]["mode"] == "source"
        with session_factory() as s:
            keys = set(s.scalars(select(Job.dedupe_key).where(Job.kind == "layers.build")))
        assert keys >= {f"layers:aim:{a1['id']}", f"layers:aim:{a2['id']}", f"layers:{agent['id']}"}

        for ref in (f"aim:{a1['id']}", f"aim:{a2['id']}", agent["id"]):
            built = client.post(f"/v1/users/{uid}/layers/build", json={"ref": ref}).json()
            assert built["ready"] and built["strict"] and [l["name_zh"] for l in built["levels"]] == ["要点", "概要", "全量"]

        g = {n["id"]: n for n in client.get(f"/v1/users/{uid}/graph").json()["nodes"]}
        assert g[f"aim:{a2['id']}"]["gist"].startswith("gist") and g[f"aim:{a2['id']}"]["layers"]["source_level"] == 3
        assert g[f"aim:{a1['id']}"]["gist"] == "build a perpetual agent"

        # chat as the agent: its own ambition in full (with the expansion labelled), the other one at its brief
        client.post("/v1/chat", json={"user_id": uid, "text": "status?", "responsibility_id": agent["id"]})
        system = provider.calls[-1].system
        block = re.search(r"<long_range_aims>(.*)</long_range_aims>", system, re.S).group(1)
        assert "1. " + EXPANDED_NOTE in block and "full full full" in block
        assert "2. brief brief" in block and "Sentence 29" not in block
        assert "serves aim 1" in block

        assert client.get(f"/v1/users/{uid}/layers", params={"ref": "aim:00000000-0000-0000-0000-000000000000"}).status_code == 404
        client.delete(f"/v1/aims/{a2['id']}")
        assert client.get(f"/v1/users/{uid}/layers", params={"ref": f"aim:{a2['id']}"}).status_code == 404


def test_a_motivation_over_two_thousand_words(rt, en_user, provider):
    """The prepared long motivation (tests/fixtures/long_motivation_zh.md): kept whole at L3, condensed above it,
    and a chat that needs it in full steps it down to fit the context budget."""
    from pathlib import Path

    text = (Path(__file__).parent / "fixtures" / "long_motivation_zh.md").read_text(encoding="utf-8").strip()
    assert words(text) > 2000
    asked: list[str] = []
    provider.handler = pyramid_handler(asked)
    a = AimService(rt.session).create(en_user, text, text)
    p = rt.layers.build(en_user, f"aim:{a.id}")
    assert p.source_level == 3 and p.strict
    assert [p.levels[lv].mode for lv in (1, 2, 3)] == ["condensed", "condensed", "source"]
    assert p.levels[3].text == text and p.levels[3].words > 2000           # nothing of the original is lost
    assert "gist (CONDENSE)" in asked[-1] and "brief (CONDENSE)" in asked[-1] and "full" not in asked[-1]

    r = rt.responsibilities.create(user_id=en_user.id, title_en="agent memory research", actor=Origin.USER)
    r.aim_id = a.id
    block = AimService(rt.session).context_block(en_user, r, layers=rt.layers, purpose="chat")
    assert words(block) <= rt.policy.layers.budgets["chat.aims"] + 20      # full (3000 words) does not fit: brief is used
    assert "brief brief" in block and "第一阶段" not in block
