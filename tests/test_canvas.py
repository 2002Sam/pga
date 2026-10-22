"""无限画布 (pga.canvas): a board per world-tree topic, laid out input → assign → branches → output, kept in step with
the tree without losing anything; the notepad (pga.pad) kept verbatim."""
from __future__ import annotations

import pytest

from pga import canvas, pad
from pga.canvas import Boards, CanvasConflict, CanvasError
from pga.db.models import WorldNode


def world(rt, user):
    s = rt.session
    root = WorldNode(user_id=user.id, depth=0, kind="root", title="世界", summary="一切", data={"built_at": "x"})
    s.add(root)
    s.flush()
    res = WorldNode(user_id=user.id, parent_id=root.id, depth=1, kind="topic", title="研究", summary="做研究", data={"count": 2})
    dev = WorldNode(user_id=user.id, parent_id=root.id, depth=1, kind="topic", title="开发", summary="写代码", data={})
    s.add_all([res, dev])
    s.flush()
    sub = WorldNode(user_id=user.id, parent_id=res.id, depth=2, kind="topic", title="世界模型", summary="表征", data={})
    a = WorldNode(user_id=user.id, parent_id=res.id, depth=2, kind="leaf", title="引言怎么写", ref="chat:a", data={"gist": "改引言", "last": "2026-10-02"})
    b = WorldNode(user_id=user.id, parent_id=res.id, depth=2, kind="leaf", title="旧的", ref="chat:b", data={"hidden": True})
    s.add_all([sub, a, b])
    s.flush()
    return root, res, dev, sub, a


def test_a_topic_board_is_input_assign_branches_output(rt, user):
    root, res, dev, sub, a = world(rt, user)
    b = Boards(rt)
    top = b.board(user, "top")
    kinds = {n["id"]: n["kind"] for n in top.data["nodes"]}
    assert kinds["in"] == "input" and kinds["assign"] == "dispatch" and kinds["out"] == "output"
    assert {n["title"] for n in top.data["nodes"] if n["kind"] == "board"} == {"研究", "开发"}
    c = b.board(user, str(res.id))
    ns = c.data["nodes"]
    chat = next(n for n in ns if n["kind"] == "chat")
    assert chat["key"] == "chat:a" and chat["out"] == "改引言"                        # the hidden one is not a branch
    assert [n["title"] for n in ns if n["kind"] == "board"] == ["世界模型"]
    assert next(n for n in ns if n["id"] == "out")["out"] == "做研究"
    es = {(e["fromNode"], e["toNode"]) for e in c.data["edges"]}
    assert ("in", "assign") in es and ("assign", chat["id"]) in es and (chat["id"], "out") in es
    assert b.board(user, str(a.id)).id == c.id                                         # a conversation opens its topic's board
    assert [x["title"] for x in b.crumbs(user, c)] == ["顶层", "研究"]


def test_the_board_follows_the_tree_and_keeps_your_work(rt, user):
    root, res, dev, sub, a = world(rt, user)
    b = Boards(rt)
    c = b.board(user, str(res.id))
    data = c.data
    data["nodes"].append({"id": "mine", "kind": "note", "x": 0, "y": 400, "text": "我的笔记"})
    b.save(user, c.id, data, c.rev)
    with pytest.raises(CanvasConflict):
        b.save(user, c.id, data, c.rev - 1)
    new = WorldNode(user_id=user.id, parent_id=res.id, depth=2, kind="leaf", title="新对话", ref="chat:n", data={"last": "2026-10-03"})
    rt.session.add(new)
    a.parent_id = dev.id
    rt.session.flush()
    rev = c.rev
    c = b.board(user, str(res.id))
    assert c.rev == rev + 1
    ns = {n.get("key") or n["id"]: n for n in c.data["nodes"]}
    assert "chat:n" in ns and ns["chat:a"]["gone"] is True and "mine" in ns      # moved away: greyed out, not removed
    assert any(e["toNode"] == ns["chat:n"]["id"] and e["fromNode"] == "assign" for e in c.data["edges"])
    rev = c.rev
    assert b.board(user, str(res.id)).rev == rev                                   # nothing changed: not saved again
    with pytest.raises(CanvasError):
        b.board(user, "00000000-0000-0000-0000-000000000000")


def test_the_output_node_merges_what_its_branches_said(rt, user, monkeypatch):
    seen = {}

    def fake(self, user_, system, prompt, n, now):
        seen["system"], seen["prompt"] = system, prompt
        return " 合起来的答案 "
    monkeypatch.setattr(Boards, "_call", fake)
    out = Boards(rt).merge(user, "这个主题的结论是什么", [{"title": "A", "text": "甲说"}, {"title": "B", "text": "乙说"}, {"title": "C", "text": " "}])
    assert out == "合起来的答案" and "甲说" in seen["system"] and "乙说" in seen["system"] and "这个主题的结论" in seen["prompt"]
    with pytest.raises(CanvasError):
        Boards(rt).merge(user, "", [])


def test_skills_and_pictures_on_this_machine_and_nothing_else(tmp_path, monkeypatch):
    h = tmp_path / "hermes"
    (h / "research" / "lit-review").mkdir(parents=True)
    (h / "research" / "lit-review" / "SKILL.md").write_text('---\nname: lit-review\ndescription: "Find and read papers"\n---\nSteps…')
    (tmp_path / "secret.env").write_text("KEY=1")
    monkeypatch.setattr(canvas, "SKILL_ROOTS", {"hermes": h, "claude": tmp_path / "none"})
    xs = canvas.skills()
    assert xs[0]["name"] == "lit-review" and xs[0]["category"] == "research" and xs[0]["description"] == "Find and read papers"
    assert "Steps" in canvas.skill_text(xs[0]["path"])["text"]
    with pytest.raises(CanvasError):
        canvas.skill_text(str(tmp_path / "secret.env"))
    ws = tmp_path / "ws"
    (ws / "deepseek-abc" / "uploads").mkdir(parents=True)
    (ws / "deepseek-abc" / "uploads" / "1700000000-1-fig.png").write_bytes(b"\x89PNG")
    (ws / "deepseek-abc" / "uploads" / "notes.txt").write_text("x")
    monkeypatch.setattr(canvas, "image_roots", lambda: [ws])
    ims = canvas.images()
    assert [i["name"] for i in ims] == ["fig.png"]
    assert canvas.image_path(ims[0]["path"]).name.endswith("fig.png")
    for bad in [str(ws / "deepseek-abc" / "uploads" / "notes.txt"), str(tmp_path / "secret.env")]:
        with pytest.raises(CanvasError):
            canvas.image_path(bad)


def test_the_notepad_is_kept_verbatim_with_its_earlier_versions(tmp_path, monkeypatch, user):
    monkeypatch.setattr(pad, "PAD_DIR", tmp_path / "pad")
    monkeypatch.setattr(pad, "SNAPSHOT_EVERY_S", 0)
    assert pad.read(user.id)["text"] == "" and pad.read(user.id)["rev"] == 0
    p = pad.write(user.id, "第一个想法\n还是第一个\n\n\n第二个想法  \n", 0)
    assert p["rev"] == 1 and pad.ideas(p["text"]) == ["第一个想法\n还是第一个", "第二个想法"]
    assert open(p["path"]).read() == "第一个想法\n还是第一个\n\n\n第二个想法  \n"     # exactly as written
    with pytest.raises(pad.PadConflict):
        pad.write(user.id, "别的窗口", 0)
    p = pad.write(user.id, "改过了", 1, sent=[{"text": "第二个想法", "node": "n1", "board": "top", "agent": "deepseek"}])
    assert p["rev"] == 2 and p["sent"][0]["node"] == "n1"
    hist = list((tmp_path / "pad" / str(user.id) / "history").iterdir())
    assert len(hist) == 1 and hist[0].read_text().startswith("第一个想法")
    assert pad.write(user.id, sent=[])["text"] == "改过了"                             # only the handed-out list
