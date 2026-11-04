"""Pool capacity and cancellation, without real agents or external requests."""

import threading
import time
import uuid
from concurrent.futures import ThreadPoolExecutor

import pytest

from pga.agents import live, pool
from pga.agents.base import AgentResult, AgentTask


def make_pool(capacity=4):
    name = "test-" + uuid.uuid4().hex
    p = pool.AgentPool(None, {"agents": {name: {"adapter": "claude_local", "max_concurrent": capacity}}, "run": {}})
    return p, name


def test_distinct_conversations_execute_concurrently(monkeypatch):
    p, name = make_pool()
    rendezvous = threading.Barrier(4)

    def answer(task):
        rendezvous.wait(timeout=3)  # cannot pass if calls are serialized
        return AgentResult(ok=True, text=task.meta["conversation"])

    monkeypatch.setattr(p.adapters[name], "run", answer)
    with ThreadPoolExecutor(max_workers=4) as workers:
        fs = [workers.submit(p._call, name, AgentTask(prompt="hi", meta={"conversation": str(i)}), "run") for i in range(4)]
        assert [f.result(timeout=5).result.text for f in fs] == ["0", "1", "2", "3"]


@pytest.mark.parametrize("cancel", [True, False])
def test_capacity_wait_is_visible_bounded_and_cancellable(monkeypatch, cancel):
    p, name = make_pool(1)
    calls = []
    monkeypatch.setattr(p.adapters[name], "run", lambda task: calls.append(task) or AgentResult(ok=True, text="ready"))
    slot = pool._slot(name, 1)
    assert slot.acquire(blocking=False)
    try:
        with ThreadPoolExecutor(max_workers=1) as workers:
            f = workers.submit(p._call, name, AgentTask(prompt="hi", timeout_s=2 if cancel else 0.3), "run")
            deadline = time.monotonic() + 1
            row = None
            while time.monotonic() < deadline:
                row = next((r for r in live.snapshot() if r["agent"] == name and r.get("phase") == "queued"), None)
                if row:
                    break
                time.sleep(0.01)
            assert row is not None
            if cancel:
                assert live.stop(row["id"])
            result = f.result(timeout=1).result
            assert result.status == ("STOPPED" if cancel else "TIMEOUT")
            assert result.agent == name and not result.ok and not calls
            assert not slot.acquire(blocking=False)  # a waiter must not release another call's slot
    finally:
        slot.release()
    assert p._call(name, AgentTask(prompt="next"), "run").result.ok
    assert len(calls) == 1


def test_slot_is_released_when_adapter_raises(monkeypatch):
    p, name = make_pool(1)

    def fail(task):
        raise RuntimeError("broken adapter")

    monkeypatch.setattr(p.adapters[name], "run", fail)
    with pytest.raises(RuntimeError, match="broken adapter"):
        p._call(name, AgentTask(prompt="hi"), "run")
    slot = pool._slot(name, 1)
    assert slot.acquire(blocking=False)
    slot.release()


@pytest.mark.parametrize("adapter", ["claude_local", "codex_local"])
def test_capacity_defaults_preserve_explicit_limits(adapter):
    pool.CONFIG.write_text(f"agents:\n  another:\n    adapter: {adapter}\n  limited:\n    adapter: {adapter}\n    max_concurrent: 1\n")
    cfg = pool.load()
    assert cfg["agents"]["another"]["max_concurrent"] == 4
    assert cfg["agents"]["limited"]["max_concurrent"] == 1


@pytest.mark.parametrize("cancel", [False, True])
def test_same_conversation_waits_without_blocking_other_windows(monkeypatch, cancel):
    p, name = make_pool(2)
    entered, release = threading.Event(), threading.Event()
    calls = []

    def answer(task):
        label = task.meta["label"]
        calls.append(label)
        if label == "first":
            live.append(task.meta["live_id"], "original work is still here")
            entered.set()
            assert release.wait(timeout=3)
            assert not live.stopped(task.meta["live_id"])
        return AgentResult(ok=True, text=label)

    monkeypatch.setattr(p.adapters[name], "run", answer)
    task = lambda label, conv: AgentTask(prompt=label, timeout_s=3, meta={"conversation": conv, "label": label})
    with ThreadPoolExecutor(max_workers=3) as workers:
        first = workers.submit(p._call, name, task("first", "same"), "run")
        try:
            assert entered.wait(timeout=1)
            follow = workers.submit(p._call, name, task("follow-up", "same"), "run")
            deadline = time.monotonic() + 1
            while time.monotonic() < deadline:
                row = next((r for r in live.snapshot() if r["agent"] == name and r.get("phase") == "queued"
                            and r.get("queue_reason") == "conversation"), None)
                if row:
                    break
                time.sleep(0.01)
            assert row is not None and calls == ["first"]
            other = workers.submit(p._call, name, task("other-window", "other"), "run")
            assert other.result(timeout=1).result.text == "other-window"
            if cancel:
                assert live.stop(row["id"])
                assert follow.result(timeout=1).result.status == "STOPPED"
            assert not first.done()
        finally:
            release.set()
        result = first.result(timeout=1).result
        assert result.text == "first" and result.data["trace"] == "original work is still here"
        if not cancel:
            assert follow.result(timeout=1).result.text == "follow-up"
        assert calls == (["first", "other-window"] if cancel else ["first", "other-window", "follow-up"])

