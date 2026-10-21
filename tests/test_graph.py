"""The memory graph: what PGA remembers, as nodes and edges, and the lines you draw on it (pga.graph)."""
from __future__ import annotations

from pga.aims import AimService
from pga.db.models import Body, Bridge
from pga.db.types import Origin
from pga.graph import build, link


def test_the_graph_holds_you_your_motivations_knowledge_and_the_lines_you_draw(rt, user):
    aim = AimService(rt.session).create(user, "写完论文", "Finish the paper")
    grown = Body(user_id=user.id, aim_id=aim.id, kind="database", title="实验结果", title_en="Results", description="三组消融", description_en="x", origin=Origin.AGENT)
    doc = Body(user_id=user.id, kind="database", title="综述.pdf", title_en="survey", description="很长的综述", description_en="x", origin=Origin.USER,
               data={"source": "upload", "chars": 9000})
    secret = Body(user_id=user.id, kind="database", title="私密", title_en="p", description="不能给别人看", description_en="x", origin=Origin.USER, private=True)
    rt.session.add_all([grown, doc, secret])
    rt.session.flush()
    g = build(rt, user)
    ids = {n["id"]: n for n in g["nodes"]}
    assert "you" in ids and f"aim:{aim.id}" in ids and ids[f"k:{doc.id}"]["type"] == "doc"
    assert ids[f"k:{secret.id}"]["sub"] == "" and ids[f"k:{secret.id}"]["private"] is True        # its text never shows
    kinds = {(e["a"], e["b"]): e["kind"] for e in g["edges"]}
    assert kinds[("you", f"aim:{aim.id}")] == "pursues" and kinds[(f"aim:{aim.id}", f"k:{grown.id}")] == "grew"
    r = link(rt, user, f"aim:{aim.id}", f"k:{doc.id}")                    # a tree and knowledge: the tree references it
    assert r["kind"] == "references" and rt.session.query(Bridge).count() == 1
    assert link(rt, user, f"k:{doc.id}", f"k:{grown.id}")["kind"] == "relates"
    g = build(rt, user)
    assert any(e.get("bridge") and e["kind"] == "references" for e in g["edges"])
