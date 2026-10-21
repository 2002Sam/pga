"""While you are away your motivations run on their own; the moment you are back they pause (pga.idle)."""
from __future__ import annotations

from datetime import datetime, timedelta, timezone

import pytest

from pga import idle
from pga.aims import AimService
from pga.db.models import Project
from pga.perpetual import Perpetual


@pytest.fixture
def owner_task(rt, user, monkeypatch, tmp_path):
    user.preferences = {**(user.preferences or {}), "owner": True}
    monkeypatch.setattr(idle, "local_activity", lambda within_s=3600: None)       # no Claude Code / Codex on the test machine
    aim = AimService(rt.session).create(user, "一直想下去", "Keep thinking")
    proj = Project(user_id=user.id, name="x", path=str(tmp_path), created_at=datetime.now(timezone.utc))
    rt.session.add(proj)
    rt.session.flush()
    eng = Perpetual(rt)
    t = eng.create(user, aim, proj)
    eng.set_status(t, "paused")
    return eng, t


def test_away_an_hour_it_starts_and_your_return_pauses_it(rt, user, owner_task):
    eng, t = owner_task
    t0 = datetime(2026, 10, 21, 8, 0, tzinfo=timezone.utc)
    assert idle.tick(rt.session, t0, rt=rt)["state"] == "started the clock"
    assert idle.tick(rt.session, t0 + timedelta(minutes=30), rt=rt)["state"] == "waiting"
    assert t.status == "paused"
    r = idle.tick(rt.session, t0 + timedelta(minutes=61), rt=rt)
    assert r["auto"] == [str(t.id)] and t.status == "running" and idle.is_auto(rt.session, t)
    assert eng.out(t)["auto_idle"] is True
    assert idle.tick(rt.session, t0 + timedelta(minutes=90), rt=rt)["state"] == "running while you are away"
    assert idle.touch(rt.session, user, t0 + timedelta(minutes=95), rt=rt) == [str(t.id)]      # you are back
    assert t.status == "paused" and not idle.is_auto(rt.session, t)
    assert idle.tick(rt.session, t0 + timedelta(minutes=100), rt=rt)["state"] == "waiting"     # the hour starts again


def test_what_you_start_yourself_is_yours_and_opting_out_or_switching_off_is_kept(rt, user, owner_task):
    eng, t = owner_task
    t0 = datetime(2026, 10, 21, 8, 0, tzinfo=timezone.utc)
    idle.tick(rt.session, t0, rt=rt)
    idle.tick(rt.session, t0 + timedelta(hours=2), rt=rt)
    assert t.status == "running"
    eng.set_status(t, "running")                          # you pressed start while it was running on its own
    assert not idle.is_auto(rt.session, t)
    assert idle.touch(rt.session, user, t0 + timedelta(hours=3), force=True, rt=rt) == [] and t.status == "running"
    eng.set_status(t, "stopped")                          # stopped, not paused: never starts on its own
    assert idle.tick(rt.session, t0 + timedelta(hours=6), rt=rt)["state"] == "nothing to start"
    eng.set_status(t, "paused")
    t.settings = {**t.settings, "idle_auto": False}        # this motivation opted out
    assert idle.tick(rt.session, t0 + timedelta(hours=9), rt=rt)["state"] == "nothing to start"
    t.settings = {**t.settings, "idle_auto": True}
    user.preferences = {**user.preferences, "idle_run": {"on": False, "minutes": 60}}
    assert idle.tick(rt.session, t0 + timedelta(hours=12), rt=rt)["state"] == "waiting"


def test_working_in_another_app_counts_as_being_here(rt, user, owner_task, monkeypatch):
    eng, t = owner_task
    t0 = datetime(2026, 10, 21, 8, 0, tzinfo=timezone.utc)
    idle.tick(rt.session, t0, rt=rt)
    idle.tick(rt.session, t0 + timedelta(minutes=70), rt=rt)
    assert t.status == "running"
    monkeypatch.setattr(idle, "local_activity", lambda within_s=3600: t0 + timedelta(minutes=72))   # a Claude Code session of yours
    r = idle.tick(rt.session, t0 + timedelta(minutes=73), rt=rt)
    assert r["paused"] == [str(t.id)] and t.status == "paused"

