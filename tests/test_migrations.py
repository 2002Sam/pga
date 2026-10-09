"""The Alembic migration builds exactly the schema the models describe, and downgrades cleanly."""

from __future__ import annotations

import os
import uuid
from pathlib import Path

import pytest
from alembic import command
from alembic.config import Config
from sqlalchemy import create_engine, text
from sqlalchemy.engine import make_url

from .conftest import TEST_DB

ROOT = Path(__file__).resolve().parents[1]


@pytest.fixture
def scratch_db():
    url = make_url(TEST_DB)
    name = f"pga_migr_{uuid.uuid4().hex[:8]}"
    admin = create_engine(url.set(database="postgres"), isolation_level="AUTOCOMMIT")
    try:
        with admin.connect() as c:
            c.execute(text(f'CREATE DATABASE "{name}"'))
    except Exception as exc:  # pragma: no cover - environment without CREATEDB
        pytest.skip(f"cannot create scratch database: {exc}")
    yield url.set(database=name).render_as_string(hide_password=False)
    with admin.connect() as c:
        c.execute(text(f'DROP DATABASE IF EXISTS "{name}" WITH (FORCE)'))
    admin.dispose()


def test_upgrade_check_downgrade(scratch_db, monkeypatch):
    cfg = Config(str(ROOT / "alembic.ini"))
    cfg.set_main_option("script_location", str(ROOT / "migrations"))
    cfg.set_main_option("sqlalchemy.url", scratch_db)
    command.upgrade(cfg, "head")
    command.check(cfg)  # raises if models and migrations disagree
    command.downgrade(cfg, "base")
    eng = create_engine(scratch_db)
    with eng.connect() as c:
        left = c.execute(text("select count(*) from information_schema.tables where table_schema='public' "
                              "and table_name <> 'alembic_version'")).scalar()
    eng.dispose()
    assert left == 0
    assert os.path.exists(ROOT / "migrations" / "versions")
