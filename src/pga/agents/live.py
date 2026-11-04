"""Agents at work, right now: what each running agent has said so far.

The pool registers every agent call here; CLI adapters append their output line by line as it streams in (Claude
Code / CodeBuddy `stream-json`, Codex `--json` events, Hermes and processes as plain lines). The constellation
polls `snapshot()` to draw gold ripples around the planets that are working and the text beside them. Finished
runs stay visible for a little while. In-memory only: API and worker share one process (`python -m pga all`).
"""

from __future__ import annotations

import logging
from contextlib import contextmanager
import threading
import time
import uuid

_LOCK = threading.Lock()
_RUNS: dict[str, dict] = {}
KEEP_S = 40                      # how long a finished run stays on the map
MAX_TEXT = 12000


def start(agent: str, *, category: str = "", workflow: str = "", step: str = "", prompt: str = "", task_kind: str = "",
          tags: dict | None = None) -> str:
    """`tags` say what the run serves (aim, perpetual task, project, role) so the console can show it in place."""
    lid = uuid.uuid4().hex[:12]
    with _LOCK:
        _RUNS[lid] = {"id": lid, "agent": agent, "category": category, "workflow": workflow, "step": step, "task_kind": task_kind,
                      "prompt": prompt[:300], "text": "", "tr": "", "started": time.time(), "finished": None, "ok": None, "error": None,
                      "tags": dict(tags or {})}
        _prune()
    return lid


_OBSERVERS: dict[str, list] = {}


@contextmanager
def observe(conversation, callback):
    """Observe complete deltas before the UI tail is truncated; always detach on exit."""
    with _LOCK:
        _OBSERVERS.setdefault(conversation, []).append(callback)
    try:
        yield
    finally:
        with _LOCK:
            callbacks = _OBSERVERS.get(conversation, [])
            if callback in callbacks:
                callbacks.remove(callback)
            if not callbacks:
                _OBSERVERS.pop(conversation, None)


def _notify(lid, text, callbacks):
    for callback in callbacks:
        try:
            callback(lid, text)
        except Exception:
            logging.getLogger(__name__).exception("Live output observer failed")


def append(lid: str | None, text: str) -> None:
    if not lid or not text:
        return
    with _LOCK:
        r = _RUNS.get(lid)
        if r is not None:
            r["text"] = (r["text"] + text)[-MAX_TEXT:]
        callbacks = list(_OBSERVERS.get((r or {}).get("tags", {}).get("conversation"), []))
    _notify(lid, text, callbacks)


def set_extra(lid: str | None, key: str, value) -> None:
    """Something structured about a running answer, for the working card: the environment the agent reports (model,
    folder, tools, MCP servers), its to-do list, its token usage so far."""
    if not lid:
        return
    with _LOCK:
        r = _RUNS.get(lid)
        if r is not None:
            r[key] = value


MAX_STEPS = 400
MAX_IMAGES = 12                  # the latest screenshots of a running answer, kept in memory for its step list


def step(lid: str | None, st: dict) -> None:
    """A step as it starts (a tool call, a thought), for the working card's Claude-Code-like list."""
    if not lid:
        return
    with _LOCK:
        r = _RUNS.get(lid)
        if r is not None:
            xs = r.setdefault("steps", [])
            xs.append({**st, "at": time.time()})
            del xs[:-MAX_STEPS]


def step_done(lid: str | None, call: str, *, error: bool = False, images: list[tuple[bytes, str]] | None = None) -> None:
    """The tool call `call` came back: how long it took, whether it failed, its screenshots."""
    if not lid or not call:
        return
    with _LOCK:
        r = _RUNS.get(lid)
        st = next((x for x in reversed((r or {}).get("steps") or []) if x.get("id") == call), None)
        if st is None:
            return
        st["secs"] = round(time.time() - st["at"], 1)
        if error:
            st["error"] = True
        pics = r.setdefault("_images", [])
        for img in images or []:
            pics.append(img)
            st.setdefault("images", []).append(len(pics) - 1)
        if len(pics) > MAX_IMAGES:                                    # forget the oldest pictures, keep the numbering
            for i in range(len(pics) - MAX_IMAGES):
                pics[i] = None


def image(lid: str, n: int) -> tuple[bytes, str] | None:
    with _LOCK:
        pics = (_RUNS.get(lid) or {}).get("_images") or []
        return pics[n] if 0 <= n < len(pics) else None


def finish(lid: str | None, ok: bool, text: str | None = None, error: str | None = None) -> None:
    from pga.agents import approvals
    approvals.finish(lid)
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


def stop_where(**match) -> list[str]:
    """Stop every running answer whose agent / tags match (e.g. agent="claude", perpetual=<task id>)."""
    with _LOCK:
        ids = [r["id"] for r in _RUNS.values() if r["finished"] is None and all(
            (r["agent"] if k == "agent" else (r.get("tags") or {}).get(k)) == v for k, v in match.items())]
    return [lid for lid in ids if stop(lid)]


def stopped(lid: str | None) -> bool:
    return bool(lid) and lid in _STOP


def text(lid: str | None) -> str:
    """What the agent has said so far (kept when it is stopped)."""
    with _LOCK:
        r = _RUNS.get(lid or "")
        return r["text"] if r else ""


def translate_along(lid: str, translate) -> None:
    """While an agent writes, translate each finished paragraph (`translate(text) -> text`) into the run's `tr`, so the
    reader sees their own language almost in step. Stops when the run is finished and its last paragraph is done."""
    def work() -> None:
        done = 0
        while True:
            with _LOCK:
                r = _RUNS.get(lid)
                if r is None:
                    return
                txt, finished = r["text"], r["finished"] is not None
            cut = txt.rfind("\n", done) if not finished else len(txt)
            if cut > done and (finished or cut - done >= 60 or "\n\n" in txt[done:cut + 1]):
                piece = txt[done:cut + 1] if not finished else txt[done:]
                if piece.strip():
                    try:
                        out = translate(piece)
                    except Exception:  # noqa: BLE001 - the original is still there
                        out = piece
                    with _LOCK:
                        if lid in _RUNS:
                            _RUNS[lid]["tr"] += out if out.endswith("\n") or not piece.endswith("\n") else out + "\n"
                done = cut + 1 if not finished else len(txt)
            if finished and done >= len(txt):
                return
            time.sleep(0.6)
    threading.Thread(target=work, daemon=True, name=f"pga-tr-{lid}").start()


def snapshot() -> list[dict]:
    now = time.time()
    with _LOCK:
        _prune(now)
        return [{**{k: v for k, v in r.items() if not k.startswith("_")}, "elapsed_s": round((r["finished"] or now) - r["started"], 1),
                 "text": r["text"], "running": r["finished"] is None} for r in sorted(_RUNS.values(), key=lambda x: x["started"])]


def _prune(now: float | None = None) -> None:
    now = now or time.time()
    for k in [k for k, r in _RUNS.items() if r["finished"] and now - r["finished"] > KEEP_S]:
        _RUNS.pop(k, None)
    for k in [k for k, r in _RUNS.items() if not r["finished"] and now - r["started"] > 3 * 3600]:
        _RUNS.pop(k, None)                                            # a run that never reported back
