"""分工 (pga/dispatch.py): a message with several points becomes tasks; dispatches are kept per conversation."""
from __future__ import annotations

from pga import dispatch


def test_points_are_seen_and_dispatches_are_kept(user):
    assert dispatch.looks_multi("几个问题：1. 加按钮 2. 改排序")
    assert dispatch.looks_multi("- 第一件\n- 第二件")
    assert not dispatch.looks_multi("帮我看看这个报错是怎么回事")
    dispatch.record(user, "chat:a", {"id": "d1", "text": "1. x 2. y", "tasks": [{"title": "x", "key": "chat:b", "agent": "deepseek"}]})
    dispatch.record(user, "chat:a", {"id": "d1", "text": "1. x 2. y", "tasks": [{"title": "x", "key": "chat:b", "agent": "deepseek"}], "merged": "1"})
    xs = dispatch.of(user, "chat:a")
    assert len(xs) == 1 and xs[0]["merged"] == "1" and dispatch.of(user, "chat:z") == []
