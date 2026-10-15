"""Merging one local account into another (pga/merge.py)."""

from __future__ import annotations

from datetime import datetime, timezone

from sqlalchemy import select

from pga.aims import AimService
from pga.db.models import AimNote, LinkedAgent, Project, R0State, User
from pga.merge import merge_accounts


def test_merging_moves_the_work_and_leaves_a_pointer(rt, user):
    s = rt.session
    now = datetime.now(timezone.utc)
    old = User(locale="zh-CN", timezone="Asia/Shanghai", permission_policy_id=user.permission_policy_id, preferences={"owner": True})
    s.add(old)
    s.flush()
    aim = AimService(s).create(old, "让 PGA 不断进化", "Keep PGA evolving")
    s.add(AimNote(user_id=old.id, aim_id=aim.id, kind="question", text="Q?", created_at=now))
    s.add_all([Project(user_id=old.id, name="PGA", path="/x/pga", created_at=now),
               Project(user_id=old.id, name="Dup", path="/x/dup", created_at=now),
               Project(user_id=user.id, name="Dup", path="/x/dup", created_at=now),
               LinkedAgent(user_id=old.id, name="Claude Code", vendor="claude_code", connector="claude_code"),
               R0State(user_id=old.id, tension=.5, telemetry={}, baselines={}, ledger=[{"why": "a"}, {"why": "b"}], updated_at=now),
               R0State(user_id=user.id, tension=0, telemetry={}, baselines={}, ledger=[], updated_at=now)])
    s.flush()
    rep = merge_accounts(s, old.id, user.id)
    s.expire_all()
    assert s.get(type(aim), aim.id).user_id == user.id
    assert s.scalar(select(AimNote.user_id).where(AimNote.aim_id == aim.id)) == user.id
    assert sorted(p.path for p in s.scalars(select(Project).where(Project.user_id == user.id))) == ["/x/dup", "/x/pga"]
    assert not list(s.scalars(select(LinkedAgent).where(LinkedAgent.user_id == old.id)))     # duplicate imports dropped
    assert len(s.get(R0State, user.id).ledger) == 2 and s.get(R0State, old.id) is None        # the one with the history
    o, n = s.get(User, old.id), s.get(User, user.id)
    assert o.preferences["merged_into"] == str(user.id) and "owner" not in o.preferences and n.preferences["owner"] is True
    assert rep["aims"] == 1


def test_a_folder_belongs_to_a_motivation_or_stays_free(rt, user, tmp_path, monkeypatch):
    import pytest

    from pga.agents.routing import _project_note
    from pga.projects import ProjectError, Projects

    monkeypatch.setattr("pga.projects.Path.home", lambda: tmp_path)
    (tmp_path / "work").mkdir()
    (tmp_path / "free").mkdir()
    aim = AimService(rt.session).create(user, "让 PGA 不断进化", "Keep PGA evolving")
    ps = Projects(rt.session)
    p = ps.create(user.id, path=str(tmp_path / "work"), aim_id=str(aim.id))
    free = ps.create(user.id, path=str(tmp_path / "free"))
    assert p.aim_id == aim.id and free.aim_id is None
    assert [x.id for x in ps.for_aim(user.id, aim.id)] == [p.id]
    rt.session.refresh(p)
    assert "Keep PGA evolving" in _project_note(p, "claude_local") and "long-range aim" not in _project_note(free, "claude_local")
    ps.update(p, aim_id=None)
    assert p.aim_id is None
    ps.update(p, name="renamed")                       # leaving aim_id out keeps it as it is
    with pytest.raises(ProjectError):
        ps.update(p, aim_id="00000000-0000-0000-0000-000000000000")


def test_folder_tree_and_files_stay_inside_the_folder(rt, user, tmp_path, monkeypatch):
    import pytest

    from pga.projects import ProjectError, Projects, list_dir, read_file

    monkeypatch.setattr("pga.projects.Path.home", lambda: tmp_path)
    root = tmp_path / "proj"
    (root / "src").mkdir(parents=True)
    (root / "src" / "a.py").write_text("print('hi')\n")
    (root / "README.md").write_text("# hello\n")
    (root / "blob.bin").write_bytes(b"\0\1\2")
    (tmp_path / "secret.txt").write_text("no")
    p = Projects(rt.session).create(user.id, path=str(root))
    top = list_dir(p)
    assert [e["name"] for e in top["entries"]] == ["src", "blob.bin", "README.md"] and top["entries"][0]["dir"]
    assert [e["path"] for e in list_dir(p, "src")["entries"]] == ["src/a.py"]
    assert read_file(p, "src/a.py")["text"] == "print('hi')\n" and read_file(p, "blob.bin")["binary"]
    for bad in ("../secret.txt", "/etc/passwd", "src/../../secret.txt"):
        with pytest.raises(ProjectError):
            read_file(p, bad)


def test_secret_files_are_not_shown(rt, user, tmp_path, monkeypatch):
    from pga.projects import Projects, read_file

    monkeypatch.setattr("pga.projects.Path.home", lambda: tmp_path)
    root = tmp_path / "proj2"
    root.mkdir()
    (root / ".env").write_text("ANTHROPIC_API_KEY=sk-secret\n")
    p = Projects(rt.session).create(user.id, path=str(root))
    out = read_file(p, ".env")
    assert out["secret"] and out["text"] is None
