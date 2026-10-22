"""评审与合成 and the arena (agents/council.py): blind review → ranking → merged answer; picks and reviews → Elo."""
from __future__ import annotations

import json
from datetime import datetime, timezone

from pga.agents import council
from pga.db.models import AgentRun

T = datetime(2026, 10, 22, tzinfo=timezone.utc)


def run(rt, user, agent, text, regen_of=None):
    r = AgentRun(user_id=user.id, workflow="ask", pattern="single", step="run", agent=agent, adapter="x", status="succeeded",
                 prompt="天空为什么是蓝的？", output=json.dumps({"answer": text}, ensure_ascii=False), started_at=T, finished_at=T,
                 data={"conversation": "chat:x", "agent": agent, **({"regen_of": str(regen_of), "multi": True} if regen_of else {})})
    rt.session.add(r)
    rt.session.flush()
    return r


def test_blind_review_ranks_merges_and_feeds_the_arena(rt, user, monkeypatch):
    a = run(rt, user, "deepseek", "因为瑞利散射。")
    b = run(rt, user, "codex", "蓝光波长短，被空气分子散射得更多。", regen_of=a.id)
    seen = []

    def fake(rt_, user_, system, prompt, why, max_tokens, now):
        seen.append(system[:40])
        if system.startswith("You are evaluating"):
            assert "deepseek" not in prompt and "codex" not in prompt          # blind: no agent names
            return "Response A 太短。Response B 解释了原因。\nFINAL RANKING:\n1. Response B\n2. Response A"
        assert system.startswith("You have been provided with a set of responses from various agents")
        assert system.index("蓝光波长短") < system.index("因为瑞利散射")       # best first
        return "合成：蓝光波长短，瑞利散射更强。"
    monkeypatch.setattr(council, "_call", fake)
    r = council.convene(rt, user, a.id, T)
    assert r["ranking"] == ["codex", "deepseek"] and r["answer"].startswith("合成")
    merged = rt.session.get(AgentRun, __import__("uuid").UUID(r["merged"]))
    assert merged.data["regen_of"] == str(a.id) and merged.data["agent"] == "council"     # a new version of the turn
    council.picked(rt, user, a.id, a.id)                                                  # you still preferred DeepSeek's
    board = {x["agent"]: x for x in council.leaderboard(user)}
    assert board["codex"]["games"] == 2 and board["deepseek"]["wins"] == 2 and "council" not in board
    assert council.parse_ranking("bla\nFINAL RANKING:\n1. Response C\n2. Response A", ["A", "B", "C"]) == ["C", "A", "B"]
    assert council.compute_elo([("x", "y", "model_a")] * 3)["x"] > 1000
