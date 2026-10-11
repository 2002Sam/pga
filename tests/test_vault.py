"""Knowledge vault: PGA state rendered as Obsidian notes, exported safely, and the user's own vault read back."""

from __future__ import annotations

import io
import json
import zipfile

import yaml
from fastapi.testclient import TestClient

from pga.api.app import create_app
from pga.db.models import Belief, BeliefEvidence, Evidence, LinkedAgent
from pga.db.types import BeliefType, Origin
from pga.runtime import Runtime
from pga.vault import build_vault, export_vault, read_obsidian_vault
from pga.vault.builder import note_title


def _seed(rt, user):
    r = rt.responsibilities.create(user_id=user.id, title_en="World model research", raw_title="世界模型研究",
                                   keywords=["world model", "genie"], actor=Origin.USER)
    e = Evidence(user_id=user.id, responsibility_id=r.id, canonical_summary_en="Genie 3 generates playable worlds. More text.",
                 content_hash="h1", source_type="arxiv", source_uri="https://arxiv.org/abs/1")
    rt.session.add(e)
    rt.session.flush()
    b = Belief(responsibility_id=r.id, type=BeliefType.CONCLUSION, statement_en="World models can be trained from video",
               confidence=0.8)
    rt.session.add(b)
    rt.session.flush()
    rt.session.add(BeliefEvidence(belief_id=b.id, evidence_id=e.id, stance="SUPPORTS"))
    rt.session.add(LinkedAgent(user_id=user.id, name="ChatGPT", vendor="chatgpt", conversation_count=3,
                               summary={"headline": "coding help", "projects": [{"name": "PGA", "status": "active"}],
                                        "topics": [{"name": "Python", "weight": 0.9}]}))
    rt.session.flush()
    return r, b, e


def _note(v, nid):
    return next(n for n in v.notes if n.id == nid)


def test_notes_are_linked_obsidian_markdown(rt, user):
    r, b, e = _seed(rt, user)
    v = build_vault(rt.session, user.id)
    resp, belief, ev = _note(v, f"r:{r.id}"), _note(v, f"b:{b.id}"), _note(v, f"e:{e.id}")

    assert resp.path == "Responsibilities/世界模型研究.md"
    assert f"[[{belief.title}]]" in resp.body and "[[PGA Home]]" == resp.props["up"]
    assert f"supports:: [[{ev.title}]]" in belief.body and "> [!success]" in belief.body

    md = belief.markdown()
    assert md.startswith("---\n")
    props = yaml.safe_load(md.split("---\n")[1])
    assert props["type"] == "belief" and props["responsibility"] == "[[世界模型研究]]"
    assert "belief/conclusion" in props["tags"]

    back = v.backlinks()
    assert f"b:{b.id}" in back[f"e:{e.id}"] and f"r:{r.id}" in back[f"b:{b.id}"]
    project = _note(v, "p:pga")
    assert project.kind == "project" and "p:pga" in _note(v, next(n.id for n in v.notes if n.kind == "agent")).links
    assert "topic/python" in next(n for n in v.notes if n.kind == "agent").tags


def test_titles_are_safe_and_unique(rt, user):
    assert note_title('a/b: c?*"d"[x]#y') == "a b c d x y"
    for _ in range(2):
        rt.responsibilities.create(user_id=user.id, title_en="Same", actor=Origin.USER)
    titles = [n.title for n in build_vault(rt.session, user.id).notes if n.kind == "responsibility"]
    assert sorted(titles) == ["Same", "Same (2)"]


def test_export_keeps_user_files_and_cleans_its_own(rt, user, tmp_path):
    r, *_ = _seed(rt, user)
    (tmp_path / "PGA Home.md").write_text("my own note")
    out = export_vault(build_vault(rt.session, user.id), tmp_path)
    assert out["conflicts"] == ["PGA Home.md"] and (tmp_path / "PGA Home.md").read_text() == "my own note"
    assert (tmp_path / "Responsibilities" / "世界模型研究.md").exists()
    assert (tmp_path / ".obsidian" / "graph.json").exists()
    manifest = json.loads((tmp_path / ".pga-manifest.json").read_text())
    assert "Responsibilities/世界模型研究.md" in manifest["files"]

    r.raw_title = "世界模型"
    rt.session.flush()
    out = export_vault(build_vault(rt.session, user.id), tmp_path)
    assert out["removed"] >= 1 and not (tmp_path / "Responsibilities" / "世界模型研究.md").exists()
    assert (tmp_path / "Responsibilities" / "世界模型.md").exists()


def test_reads_the_users_obsidian_vault(tmp_path):
    (tmp_path / ".obsidian").mkdir()
    (tmp_path / ".obsidian" / "x.md").write_text("ignored")
    (tmp_path / "Ideas").mkdir()
    (tmp_path / "Ideas" / "Alpha.md").write_text("---\ntags: [idea]\n---\nSee [[Beta|the beta]] #research/ai\n```\n#notatag [[NoLink]]\n```")
    (tmp_path / "Beta.md").write_text("back to [[Alpha#Heading]]")
    notes = read_obsidian_vault(tmp_path)
    alpha = next(n for n in notes if n.title == "Alpha")
    assert len(notes) == 2 and alpha.folder == "Obsidian/Ideas"
    assert alpha.tags == ["idea", "research/ai"] and alpha.link_targets == ["Beta"]


def test_vault_api_and_zip(session_factory, policy, provider, backend, tmp_path):
    app = create_app(session_factory=session_factory,
                     runtime_factory=lambda s: Runtime(s, policy=policy, provider=provider, translation_backend=backend))
    with TestClient(app) as c:
        own = tmp_path / "own"
        own.mkdir()
        (own / "Mine.md").write_text("links [[PGA Home]]")
        uid = c.post("/v1/users", json={"preferences": {"obsidian_vault": str(own)}}).json()["id"]
        rid = c.post(f"/v1/users/{uid}/responsibilities", json={"title": "world model research"}).json()["id"]
        v = c.get(f"/v1/users/{uid}/vault").json()
        ids = {n["id"]: n for n in v["notes"]}
        assert f"r:{rid}" in ids and "home" in ids and ids["x:Mine.md"]["links"] == ["home"]
        assert "x:Mine.md" in ids["home"]["backlinks"] and v["stats"]["external"] == 1

        z = zipfile.ZipFile(io.BytesIO(c.get(f"/v1/users/{uid}/vault.zip").content))
        assert "PGA Vault/PGA Home.md" in z.namelist() and not any("Mine" in n for n in z.namelist())

        out = c.post(f"/v1/users/{uid}/vault/export", json={"path": str(tmp_path / "v")}).json()
        assert out["notes"] >= 2 and (tmp_path / "v" / "PGA Home.md").exists()
