"""Agents at work, right now: what each running agent has said so far.

The pool registers every agent call here; CLI adapters append their output line by line as it streams in (Claude
Code / CodeBuddy `stream-json`, Codex `--json` events, Hermes and processes as plain lines). The constellation
polls `snapshot()` to draw gold ripples around the planets that are working and the text beside them. Finished
runs stay visible for a little while. In-memory only: API and worker share one process (`python -m pga all`).
"""

from __future__ import annotations

import threading
import time
import uuid

_LOCK = threading.Lock()
_RUNS: dict[str, dict] = {}
KEEP_S = 40                      # how long a finished run stays on the map
MAX_TEXT = 12000


def start(agent: str, *, category: str = "", workflow: str = "", step: str = "", prompt: str = "", task_kind: str = "") -> str:
    lid = uuid.uuid4().hex[:12]
    with _LOCK:
        _RUNS[lid] = {"id": lid, "agent": agent, "category": category, "workflow": workflow, "step": step, "task_kind": task_kind,
                      "prompt": prompt[:300], "text": "", "started": time.time(), "finished": None, "ok": None, "error": None}
        _prune()
    return lid


def append(lid: str | None, text: str) -> None:
    if not lid or not text:
        return
    with _LOCK:
        r = _RUNS.get(lid)
        if r is not None:
            r["text"] = (r["text"] + text)[-MAX_TEXT:]


def finish(lid: str | None, ok: bool, text: str | None = None, error: str | None = None) -> None:
    if not lid:
        return
    with _LOCK:
        r = _RUNS.get(lid)
        _STOP.discard(lid)
        if r is not None:
            r["finished"], r["ok"], r["error"] = time.time(), ok, error
            if text and not r["text"].strip():
                r["text"] = text[-MAX_TEXT:]


_STOP: set[str] = set()


def stop(lid: str) -> bool:
    """You pressed stop: the agent working on this run is told to stop (each adapter checks `stopped`)."""
    with _LOCK:
        r = _RUNS.get(lid)
        if r is None or r["finished"] is not None:
            return False
        _STOP.add(lid)
        return True


def stopped(lid: str | None) -> bool:
    return bool(lid) and lid in _STOP


def text(lid: str | None) -> str:
    """What the agent has said so far (kept when it is stopped)."""
    with _LOCK:
        r = _RUNS.get(lid or "")
        return r["text"] if r else ""


def snapshot() -> list[dict]:
    now = time.time()
    with _LOCK:
        _prune(now)
        return [{**r, "elapsed_s": round((r["finished"] or now) - r["started"], 1), "text": r["text"],
                 "running": r["finished"] is None} for r in sorted(_RUNS.values(), key=lambda x: x["started"])]


def _prune(now: float | None = None) -> None:
    now = now or time.time()
    for k in [k for k, r in _RUNS.items() if r["finished"] and now - r["finished"] > KEEP_S]:
        _RUNS.pop(k, None)
    for k in [k for k, r in _RUNS.items() if not r["finished"] and now - r["started"] > 3 * 3600]:
        _RUNS.pop(k, None)                                            # a run that never reported back
