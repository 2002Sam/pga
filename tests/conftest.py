"""Test fixtures. Tests run against real PostgreSQL (the spec's source of truth).

Set PGA_TEST_DATABASE_URL to point elsewhere; each test runs inside a
transaction that is rolled back, so the database stays clean.
"""

from __future__ import annotations

import os
import re
from collections.abc import Iterator
from pathlib import Path

import pytest
from sqlalchemy import Engine
from sqlalchemy.orm import Session, sessionmaker

from pga.config import Policy, load_policy
from pga.db import Base, make_engine
from pga.db.models import User
from pga.llm import FakeProvider
from pga.permissions import create_default_policy
from pga.runtime import Runtime
from pga.translation import DictionaryBackend, GlossaryService

def _dotenv(name: str) -> str | None:
    env = Path(__file__).resolve().parents[1] / ".env"
    if env.exists():
        for line in env.read_text().splitlines():
            key, sep, value = line.partition("=")
            if sep and key.strip() == name and value.strip():
                return value.strip()
    return None


TEST_DB = (os.environ.get("PGA_TEST_DATABASE_URL") or _dotenv("PGA_TEST_DATABASE_URL")
           or "postgresql+psycopg://postgres:postgres@localhost:5432/pga_test")

# Small, round numbers so budget arithmetic in tests is easy to follow.
TEST_POLICY_OVERRIDES = {
    "budget": {"total_units": 10_000_000},
    "quotas": [{
        "key": "anthropic-premium", "provider": "anthropic", "applies_to_tiers": [3], "window_mode": "fixed",
        "window_seconds": 18000, "capacity_units": 1_000_000, "proactive_target_ratio": 0.70, "reserve_ratio": 0.30,
        "after_target": {"allow": ["deterministic_tools", "cache", "cheap_models", "monitoring", "retrieval"],
                         "pause": ["deep_research", "expensive_multi_agent", "nonurgent_video_render"]},
    }],
    "llm": {"provider": "fake"},
    # the older loop tests exercise research directly; Motivation Forward and R0 have their own tests
    "motivation": {"enabled": False},
    "evolution": {"enabled": False}, "layers": {"background": False},
}

# A tiny phrase table standing in for a real translator.
ZH_EN = {
    "请帮我跟踪世界模型的最新研究": "Please help me track the latest research on world models",
    "世界模型研究": "world model research",
    "请用英文回答": "Please answer in English",
    "这个怎么样": "What do you think of this",
    "你好": "Hello",
    "谢谢": "Thanks",
    "我想": "I want to",
    "看看": "take a look at",
    "运行": "run",
    "然后": "then",
    "文件在": "the file is at",
    "公式": "the formula",
}
EN_ZH = {
    "I found three new papers.": "我找到了三篇新论文。",
    "Here is the summary.": "以下是摘要。",
    "Run": "运行",
    "then open": "然后打开",
    "The formula": "公式",
    "is important.": "很重要。",
    "offline": "离线",
}


class TwoWayDictionary(DictionaryBackend):
    def translate_marked(self, marked, source_lang, target_lang, *, glossary, feedback=None):
        self.phrases = EN_ZH if target_lang.lower().startswith("zh") else ZH_EN
        return super().translate_marked(marked, source_lang, target_lang, glossary=glossary, feedback=feedback)


@pytest.fixture(autouse=True)
def _isolated_model_config(tmp_path, monkeypatch):
    """Tests never read or write the real models.yaml / .env (Settings → 模型与 API)."""
    from pga.llm import catalog
    monkeypatch.setattr(catalog, "CONFIG", tmp_path / "models.yaml")
    monkeypatch.setattr(catalog, "ENV_FILE", tmp_path / ".env")
    monkeypatch.setattr(catalog, "HERMES", tmp_path / "hermes")
    catalog.clear_cache()
    from pga import snapshot
    from pga.agents import pool
    monkeypatch.setattr(pool, "CONFIG", tmp_path / "agents.yaml")          # …nor the real agents.yaml or snapshot folder
    monkeypatch.setattr(snapshot, "SNAP_DIR", tmp_path / "snapshots")
    monkeypatch.setitem(pool.DEFAULT["routing"], "enabled", False)          # …nor call real agent CLIs
    from pga.agents import quota
    monkeypatch.setattr(quota, "CODEX_SESSIONS", tmp_path / "codex-sessions")
    quota.clear()


@pytest.fixture(scope="session")
def engine() -> Iterator[Engine]:
    eng = make_engine(TEST_DB)
    Base.metadata.drop_all(eng)
    Base.metadata.create_all(eng)
    yield eng
    eng.dispose()


@pytest.fixture
def connection(engine):
    conn = engine.connect()
    trans = conn.begin()
    yield conn
    trans.rollback()
    conn.close()


@pytest.fixture
def session_factory(connection) -> sessionmaker[Session]:
    # commits inside the code under test become SAVEPOINT releases; the outer transaction is rolled back
    return sessionmaker(bind=connection, join_transaction_mode="create_savepoint", expire_on_commit=False)


@pytest.fixture
def session(session_factory) -> Iterator[Session]:
    s = session_factory()
    GlossaryService(s).seed()
    yield s
    s.close()


@pytest.fixture
def policy() -> Policy:
    return load_policy(overrides=TEST_POLICY_OVERRIDES)


@pytest.fixture
def provider() -> FakeProvider:
    return FakeProvider()


@pytest.fixture
def backend() -> TwoWayDictionary:
    return TwoWayDictionary()


@pytest.fixture
def rt(session, policy, provider, backend) -> Runtime:
    return Runtime(session, policy=policy, provider=provider, translation_backend=backend)


@pytest.fixture
def user(session, policy) -> User:
    pp = create_default_policy(session, policy)
    u = User(locale="zh-CN", timezone="Asia/Shanghai", permission_policy_id=pp.id, preferences={})
    session.add(u)
    session.flush()
    return u


CJK = re.compile(r"[㐀-鿿]")


def has_cjk(text: str) -> bool:
    return bool(CJK.search(text))
