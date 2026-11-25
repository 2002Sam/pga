"""Agents at work, right now: what each running agent has said so far.

The pool registers every agent call here; CLI adapters append their output line by line as it streams in (Claude
Code / CodeBuddy `stream-json`, Codex `--json` events, Hermes and processes as plain lines). The constellation
polls `snapshot()` to draw gold ripples around the planets that are working and the text beside them. Finished
runs stay visible for a little while. In-memory only: API and worker share one process (`python -m pga all`).
"""

from __future__ import annotations

import logging
import copy
from contextlib import contextmanager
import threading
import time
import uuid

_LOCK = threading.RLock()
_RUNS: dict[str, dict] = {}
_REVISION = 0
_RUN_SNAPSHOT_CACHE: dict[str, tuple[int, dict, str | None]] = {}
_FULL_PAYLOAD_CACHE: tuple[int, str] | None = None
KEEP_S = 40                      # how long a finished run stays on the map
MAX_TEXT = 12000


def _changed(run: dict | None = None) -> None:
    """Invalidate the changed run's immutable snapshot and joined full payload."""
    global _REVISION, _FULL_PAYLOAD_CACHE
    _REVISION += 1
    if run is not None:
        run["_revision"] = _REVISION
        _RUN_SNAPSHOT_CACHE.pop(run["id"], None)
    _FULL_PAYLOAD_CACHE = None


def start(agent: str, *, category: str = "", workflow: str = "", step: str = "", prompt: str = "", task_kind: str = "",
          tags: dict | None = None) -> str:
    """`tags` say what the run serves (aim, perpetual task, project, role) so the console can show it in place."""
    lid = uuid.uuid4().hex[:12]
    with _LOCK:
        _RUNS[lid] = {"id": lid, "agent": agent, "category": category, "workflow": workflow, "step": step, "task_kind": task_kind,
                      "prompt": prompt[:300], "text": "", "tr": "", "started": time.time(), "finished": None, "ok": None, "error": None,
                      "tags": copy.deepcopy(tags or {}), "_image_next": 0,
                      "code_progress": {"added": 0, "removed": 0, "files": 0, "edits": 0, "partial": False, "source": "tools"}}
        _changed(_RUNS[lid])
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


class SteerRejected(ValueError):
    """The native adapter explicitly rejected this input; it was not delivered."""


def bind_steering(lid, callback):
    if not lid:
        return
    with _LOCK:
        r = _RUNS.get(lid)
        if r is not None and r["finished"] is None:
            r["_steer"] = {"callback": callback, "lock": threading.Lock(), "receipts": {}}
            r["can_steer"] = True
            _changed(r)


def unbind_steering(lid):
    with _LOCK:
        state = (_RUNS.get(lid) or {}).get("_steer")
    if state:
        # Wait for an in-flight acknowledgement before the answer is recorded.
        with state["lock"], _LOCK:
            r = _RUNS.get(lid)
            if r:
                state["callback"] = None
                r["can_steer"] = False
                _changed(r)


def steering_inputs(lid):
    with _LOCK:
        return list((_RUNS.get(lid) or {}).get("steering", []))


def steer(lid: str, conversation: str, message_id: str, text: str) -> dict:
    with _LOCK:
        r = _RUNS.get(lid)
        if not r:
            return {"status": "uncertain", "error": "任务记录已过期或服务已重启，无法核实送达，请检查对话记录"}
        if r.get("tags", {}).get("conversation") != conversation:
            raise SteerRejected("找不到该对话的运行任务")
        state = r.get("_steer")
        if not state:
            raise SteerRejected("当前连接不支持运行中插入，消息仍保留在队列")
    with state["lock"]:
        receipt = state["receipts"].get(message_id)
        if receipt:
            if receipt["text"] != text:
                raise SteerRejected("同一条补充的内容已改变")
            return dict(receipt)
        with _LOCK:
            if r["finished"] is not None or lid in _STOP or not state["callback"]:
                raise SteerRejected("当前任务已结束或正在停止，消息仍保留在队列")
        receipt = {"id": message_id, "text": text, "status": "uncertain"}
        state["receipts"][message_id] = receipt
        try:
            result = state["callback"](text)
        except SteerRejected as exc:
            receipt.update(status="rejected", error=str(exc))
        except Exception as exc:
            # A lost acknowledgement must never trigger a second delivery.
            receipt["error"] = str(exc)
        else:
            receipt.update(status="accepted", turn_id=result.get("turnId"))
            with _LOCK:
                r.setdefault("steering", []).append({"id": message_id, "text": text, "at": time.time()})
                _changed(r)
        return dict(receipt)


def append(lid: str | None, text: str) -> None:
    if not lid or not text:
        return
    with _LOCK:
        r = _RUNS.get(lid)
        if r is not None:
            updated = (r["text"] + text)[-MAX_TEXT:]
            if updated != r["text"]:
                r["text"] = updated
                _changed(r)
        callbacks = list(_OBSERVERS.get((r or {}).get("tags", {}).get("conversation"), []))
    _notify(lid, text, callbacks)


def set_extra(lid: str | None, key: str, value) -> None:
    """Something structured about a running answer, for the working card: the environment the agent reports (model,
    folder, tools, MCP servers), its to-do list, its token usage so far."""
    if not lid:
        return
    with _LOCK:
        r = _RUNS.get(lid)
        value = copy.deepcopy(value)
        if r is not None and r.get(key) != value:
            r[key] = value
            if key == "phase" and value == "running":
                r.setdefault("work_started", time.time())
            _changed(r)


MAX_STEPS = 400
MAX_IMAGES = 12                  # the latest screenshots of a running answer, kept in memory for its step list
MAX_TRANSLATION = 12000          # keep translated progress bounded like the source text


def step(lid: str | None, st: dict, *, code: dict | None = None) -> None:
    """A step as it starts (a tool call, a thought), for the working card's Claude-Code-like list."""
    if not lid:
        return
    with _LOCK:
        r = _RUNS.get(lid)
        if r is not None:
            if code and st.get("id") and st["id"] not in r.get("_code_counted", set()):
                r.setdefault("_code_pending", {})[st["id"]] = copy.deepcopy(code)
                if st.get("secs") is not None:
                    _complete_code(r, st["id"], bool(st.get("error")))
            xs = r.setdefault("steps", [])
            xs.append({**copy.deepcopy(st), "at": time.time()})
            del xs[:-MAX_STEPS]
            _changed(r)


def file_change(lid: str | None, item: dict, *, completed: bool) -> str:
    """Update one Codex edit row as its start and result arrive."""
    from pga.agents.code_progress import file_change_stats
    changes = file_change_stats(item.get("changes"))
    title = ", ".join(changes["paths"])[:200]
    call = item.get("id")
    row = {"t": "tool", "tool": "Edit", "id": call, "title": title}
    with _LOCK:
        run = _RUNS.get(lid)
        if run is None:
            return title
        prior = next((s for s in reversed(run.get("steps", [])) if call and s.get("id") == call), None)
        if prior is not None and (not completed or prior.get("secs") is not None):
            return prior["title"]
        if completed:
            error = item.get("status") in ("failed", "declined")
            if prior is not None:
                if title:
                    prior["title"] = title
                    run.setdefault("_code_pending", {})[call] = changes
                step_done(lid, call, error=error)
                return prior["title"]
            row.update(secs=0, error=error)
        step(lid, row, code=changes)
    return title


def _complete_code(run: dict, call: str, error: bool) -> None:
    change = run.get("_code_pending", {}).pop(call, None)
    if not change or error or call in run.get("_code_counted", set()):
        return
    run.setdefault("_code_counted", set()).add(call)
    paths = run.setdefault("_code_paths", set())
    paths.update(change["paths"])
    totals = run.setdefault("_code_totals", {"added": 0, "removed": 0, "edits": 0, "partial": False})
    for key in ("added", "removed"):
        totals[key] += change[key]
    totals["edits"] += 1
    totals["partial"] |= change["partial"]
    if not run.get("_code_turn_diff"):
        run["code_progress"] = {**totals, "files": len(paths), "source": "tools"}


def code_diff(lid: str | None, diff: str) -> None:
    """Codex supplies a replacement aggregate for this turn, not a new patch."""
    from pga.agents.code_progress import diff_stats
    measured = diff_stats(diff)
    if not lid or measured is None:
        return
    value = {k: measured[k] for k in ("added", "removed", "partial")}
    value.update(files=len(measured["paths"]), source="turn_diff")
    with _LOCK:
        r = _RUNS.get(lid)
        if r is not None:
            r["_code_turn_diff"] = True
            if r.get("code_progress") != value:
                r["code_progress"] = value
                _changed(r)


def step_output(lid: str | None, call: str, delta: str) -> None:
    """Keep command output separate from the assistant's answer."""
    if not lid or not call or not delta:
        return
    with _LOCK:
        r = _RUNS.get(lid)
        st = next((x for x in reversed((r or {}).get("steps") or []) if x.get("id") == call), None)
        if st is not None:
            updated = (st.get("output", "") + delta)[-12000:]
            if updated != st.get("output", ""):
                st["output"] = updated
                _changed(r)


def step_done(lid: str | None, call: str, *, error: bool = False, images: list[tuple[bytes, str]] | None = None) -> None:
    """The tool call `call` came back: how long it took, whether it failed, its screenshots."""
    if not lid or not call:
        return
    with _LOCK:
        r = _RUNS.get(lid)
        if r is not None:
            _complete_code(r, call, error)
        st = next((x for x in reversed((r or {}).get("steps") or []) if x.get("id") == call), None)
        if st is None:
            if r is not None:
                _changed(r)
            return
        st["secs"] = round(time.time() - st["at"], 1)
        if error:
            st["error"] = True
        pics = r.setdefault("_images", {})
        for img in images or []:
            # Sequence numbers are public image URLs and cache keys, so never
            # renumber them when old screenshot bytes are evicted.
            if len(pics) >= MAX_IMAGES:
                pics.pop(next(iter(pics)))
            n = r["_image_next"]
            r["_image_next"] = n + 1
            pics[n] = img
            st.setdefault("images", []).append(n)
        _changed(r)


def image(lid: str, n: int) -> tuple[bytes, str] | None:
    with _LOCK:
        pics = (_RUNS.get(lid) or {}).get("_images") or {}
        return pics.get(n)


def finish(lid: str | None, ok: bool, text: str | None = None, error: str | None = None) -> None:
    unbind_steering(lid)
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
            _changed(r)


_STOP: set[str] = set()


def stop(lid: str) -> bool:
    """You pressed stop: the agent working on this run is told to stop (each adapter checks `stopped`)."""
    with _LOCK:
        r = _RUNS.get(lid)
        if r is None or r["finished"] is not None:
            return False
        _STOP.add(lid)
        r["stopping"] = True
        _changed(r)
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
                            translated = out if out.endswith("\n") or not piece.endswith("\n") else out + "\n"
                            _RUNS[lid]["tr"] = (_RUNS[lid]["tr"] + translated)[-MAX_TRANSLATION:]
                            _changed(_RUNS[lid])
                done = cut + 1 if not finished else len(txt)
            if finished and done >= len(txt):
                return
            time.sleep(0.6)
    threading.Thread(target=work, daemon=True, name=f"pga-tr-{lid}").start()


def check_start(lid: str) -> dict:
    """Observe once; silence never authorizes a duplicate execution."""
    with _LOCK:
        r = _RUNS.get(lid)
        if not r:
            return {"state": "unknown", "message": "状态未知，未重复派发"}
        if r.get("start_check"):
            return dict(r["start_check"])
        if r["finished"] is not None:
            state = "done" if r["ok"] else "failed"
            message = "已完成" if r["ok"] else (r.get("error") or "执行失败")
        elif r.get("phase") == "queued":
            state, message = "queued", "仍在排队，未重复派发"
        elif r.get("text") or r.get("steps"):
            state, message = "started", "已开始执行"
        else:
            state, message = "unknown", "已调用 agent，尚无执行反馈，未重复派发"
        result = {"state": state, "message": message, "agent": r["agent"], "at": time.time()}
        r["start_check"] = result
        _changed(r)
        return dict(result)


def _manager_progress(row: dict) -> list[dict]:
    """Public tool/status events only. Native private reasoning stays out of the document."""
    out = []
    for step in row.get("steps") or []:
        kind = str(step.get("t") or step.get("type") or "").lower()
        if kind not in {"tool", "note", "status", "commentary", "text"}:
            continue
        out.append({"type": kind, "text": str(step.get("title") or step.get("text") or "")[:4000],
                    **({"output": str(step["output"])[-4000:]} if step.get("output") else {}),
                    **{k: step[k] for k in ("tool", "status", "secs", "error") if k in step}})
    # Live text is the adapter's public commentary/answer stream, separate from reasoning steps.
    if row.get("text"):
        out.append({"type": "commentary", "text": row["text"][-4000:]})
    return out[-MAX_STEPS:]


def manager_record(lid: str) -> dict:
    """A bounded snapshot to persist before live records expire; no native transcript reads."""
    with _LOCK:
        row = _RUNS.get(lid) or {}
        env = row.get("env") or {}
        return {"manager_progress": _manager_progress(row),
                "reported_model": env.get("model") or row.get("model") or "",
                "actual_effort": env.get("effort") or env.get("reasoning_effort") or row.get("effort") or "",
                "requested_effort": (row.get("_manager_activity") or {}).get("requested_effort") or ""}


def manager_activity(user_id: str) -> list[dict]:
    """Full user inputs, private to the category feed; never exposed in the live broadcast."""
    with _LOCK:
        _prune()
        return [{**r["_manager_activity"], "status": "RUNNING" if r["finished"] is None else "SUCCEEDED" if r["ok"] else "FAILED",
                 "answer": "", "error": r.get("error") or "", "agent": r["agent"], "start_check": r.get("start_check"),
                 "model": (r.get("env") or {}).get("model") or r.get("model") or "",
                 "effort": (r.get("env") or {}).get("effort") or (r.get("env") or {}).get("reasoning_effort") or r.get("effort") or "",
                 "requested_effort": (r.get("_manager_activity") or {}).get("requested_effort") or "",
                 "progress": _manager_progress(r),
                 "dispatch_reports": list(r.get("_dispatch_reports", [])), "steering": [dict(x) for x in r.get("steering", [])]}
                for r in _RUNS.values() if r.get("_manager_activity", {}).get("user_id") == user_id]


def snapshot() -> list[dict]:
    rows = _snapshot_rows()
    now = time.time()
    return [{**row, "elapsed_s": round((row.get("finished") or now) - row["started"], 1)} for row in rows]


def snapshot_cached() -> tuple[list[dict], str]:
    """Compatibility helper; rows are deep copies and encoded JSON is shared."""
    with _LOCK:
        return _snapshot_rows(), snapshot_payload()


def _run_snapshot(run: dict, *, encode: bool) -> tuple[int, dict, str | None]:
    """Get one isolated public row and optional cached JSON fragment (caller holds _LOCK)."""
    import json

    revision = int(run.get("_revision", 0))
    cached = _RUN_SNAPSHOT_CACHE.get(run["id"])
    if cached is None or cached[0] != revision:
        row = copy.deepcopy({**{k: v for k, v in run.items() if not k.startswith("_")},
                             "text": run["text"], "running": run["finished"] is None,
                             "revision": revision})
        cached = (revision, row, None)
    if encode and cached[2] is None:
        cached = (cached[0], cached[1], json.dumps(cached[1], ensure_ascii=False, separators=(",", ":")))
    _RUN_SNAPSHOT_CACHE[run["id"]] = cached
    return cached


def _snapshot_rows(*, encode: bool = False) -> list[dict]:
    """Build/reuse immutable per-run snapshots, returning isolated copies to callers."""
    result = []
    with _LOCK:
        _prune()
        for r in sorted(_RUNS.values(), key=lambda x: x["started"]):
            cached = _run_snapshot(r, encode=encode)
            result.append(copy.deepcopy(cached[1]))
    return result


def snapshot_revisions() -> dict[str, int]:
    with _LOCK:
        _prune()
        return {lid: int(row.get("_revision", 0)) for lid, row in _RUNS.items()}


def snapshot_full_delta() -> tuple[str, dict[str, int]]:
    """Atomic initial full payload and revision cursor for a delta-stream client."""
    with _LOCK:
        payload = snapshot_payload()
        revisions = {lid: int(row.get("_revision", 0)) for lid, row in _RUNS.items()}
        return payload, revisions


def snapshot_payload() -> str:
    """Full WebSocket payload composed from cached per-run JSON fragments."""
    import json

    global _FULL_PAYLOAD_CACHE
    with _LOCK:
        _prune()
        rows = []
        for run in sorted(_RUNS.values(), key=lambda x: x["started"]):
            cached = _run_snapshot(run, encode=True)
            rows.append(run["id"])
        if _FULL_PAYLOAD_CACHE is not None and _FULL_PAYLOAD_CACHE[0] == _REVISION:
            return _FULL_PAYLOAD_CACHE[1]
        parts = [_RUN_SNAPSHOT_CACHE[lid][2] for lid in rows]
        payload = "[" + ",".join(parts) + "]" if parts else "[]"
        _FULL_PAYLOAD_CACHE = (_REVISION, payload)
        return payload


def snapshot_delta(previous: dict[str, int]) -> tuple[list[dict], dict[str, int], list[str]]:
    """Rows changed since a client's last snapshot, plus its next revision map and removals."""
    rows = _snapshot_rows()
    current = {str(row["id"]): int(row.get("revision", 0)) for row in rows}
    changed = [row for row in rows if previous.get(str(row["id"])) != current[str(row["id"])] ]
    removed = [run_id for run_id in previous if run_id not in current]
    return changed, current, removed


def snapshot_delta_payload(previous: dict[str, int]) -> tuple[str, dict[str, int]]:
    """Encode a delta by joining only changed runs' already-cached JSON fragments."""
    import json

    with _LOCK:
        _prune()
        current, fragments = {}, []
        for run in sorted(_RUNS.values(), key=lambda x: x["started"]):
            lid = run["id"]
            revision = int(run.get("_revision", 0))
            current[lid] = revision
            cached = _run_snapshot(run, encode=True)
            if previous.get(lid) != revision:
                fragments.append(cached[2])
        removed = [lid for lid in previous if lid not in current]
    payload = ('{"type":"live_delta","runs":[' + ",".join(fragments)
               + '],"removed":' + json.dumps(removed, ensure_ascii=False, separators=(",", ":")) + "}")
    return payload, current


def _prune(now: float | None = None) -> None:
    now = now or time.time()
    for k in [k for k, r in _RUNS.items() if r["finished"] and now - r["finished"] > KEEP_S]:
        _RUNS.pop(k, None)
        _RUN_SNAPSHOT_CACHE.pop(k, None)
        _changed()
    # Active conversations have no wall-clock limit. Removing one here loses
    # its stop handle while its adapter still runs; only finish() retires it.
