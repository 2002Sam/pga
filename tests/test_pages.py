"""页面 (pga.pages): saved states of the stage — made, listed, read, renamed, written over and deleted."""

from __future__ import annotations

import uuid

import pytest

from pga import pages


def test_a_page_is_kept_listed_changed_and_deleted(tmp_path, monkeypatch):
    monkeypatch.setattr(pages, "PAGES_DIR", tmp_path / "pages")
    uid = uuid.uuid4()
    assert pages.list_pages(uid) == []
    snap = {"v": 5, "nodes": [{"id": "a", "type": "win", "key": "chat:1", "ord": 1, "bw": 600, "prog": {"turns": 4, "msg": 7, "off": 12}},
                              {"id": "pad", "type": "win", "pad": True, "ord": -1}, {"id": "world", "type": "world", "win": "a"}],
            "ws": {}, "view": {"sl": 40, "focus": "a"}}
    s = pages.put(uid, "p1", "调研", snap)
    assert s["name"] == "调研" and [c["key"] for c in s["chats"]] == ["chat:1"] and s["chats"][0]["prog"]["turns"] == 4
    assert pages.get(uid, "p1")["snap"]["view"] == {"sl": 40, "focus": "a"}

    pages.put(uid, "p1", name="调研 2")                     # a new name: what it holds stays
    assert pages.get(uid, "p1")["snap"]["nodes"][0]["bw"] == 600
    pages.put(uid, "p1", snap={"v": 5, "nodes": [], "ws": {}})   # written over: its name stays
    p = pages.get(uid, "p1"); assert p["name"] == "调研 2" and p["snap"]["nodes"] == []

    pages.put(uid, "p2", "空白")
    assert {x["id"] for x in pages.list_pages(uid)} == {"p1", "p2"}
    pages.delete(uid, "p1")
    assert [x["id"] for x in pages.list_pages(uid)] == ["p2"]
    with pytest.raises(pages.PageError):
        pages.get(uid, "p1")
    with pytest.raises(pages.PageError):
        pages.put(uid, "../x", "bad")
    with pytest.raises(pages.PageError):
        pages.put(uid, "p3", "   ")
