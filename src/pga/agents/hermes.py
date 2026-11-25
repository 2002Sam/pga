"""Hermes run selections shared by the CLI, API and model picker.

Session choices override PGA agent defaults. Empty choices leave Hermes defaults
in charge; no global Hermes configuration or credentials are rewritten.
"""
from __future__ import annotations

from pga.agents.base import AgentError

EFFORTS = ["none", "minimal", "low", "medium", "high", "xhigh", "max", "ultra"]


def selection(config: dict, meta: dict | None = None) -> dict[str, str]:
    meta = meta or {}
    def clean(value):
        return value.strip() if isinstance(value, str) else ""
    chosen = {key: clean(meta.get(key)) or clean(config.get(key)) for key in ("model", "provider", "effort")}
    chosen["effort"] = (chosen["effort"] or clean(config.get("reasoning"))).lower()
    if chosen["effort"] and chosen["effort"] not in EFFORTS:
        raise AgentError("Hermes 思考强度无效，请选择 none / minimal / low / medium / high / xhigh / max / ultra")
    return chosen


# Terminal decoration must never become prose. Do not decode literal backslashes:
# JSON decoding already handles \uXXXX; a user's code/path must stay unchanged.
def clean_output(value) -> str:
    import json
    import re
    text = value if isinstance(value, str) else json.dumps(value, ensure_ascii=False) if value is not None else ""
    text = re.sub(r"\x1b\][^\x07\x1b]*(?:\x07|\x1b\\)", "", text)
    text = re.sub(r"\x1b\[[0-?]*[ -/]*[@-~]", "", text)
    text = re.sub(r"[^\n]\x08", "", text)
    return re.sub(r"[\x00-\x08\x0b-\x1f\x7f]", "", text.replace("\r\n", "\n").replace("\r", "\n"))


def event_from_line(line: str) -> dict | None:
    import json
    try:
        event = json.loads(clean_output(line))
    except (ValueError, TypeError):
        return None
    return event if isinstance(event, dict) and isinstance(event.get("type"), str) else None


def progress_event(event: dict, task) -> str | None:
    """Translate Hermes JSONL into the same display contract as other adapters."""
    from pga.agents import live
    from pga.hub.steps import title_of
    from pga.agents.code_progress import tool_stats
    state = task.meta.setdefault("_hermes_progress", {"text": "", "calls": [], "seq": 0})
    lid, kind = task.meta.get("live_id"), event.get("type")
    if kind == "system" and event.get("subtype") == "init":
        live.set_extra(lid, "env", {"model": event.get("model"), "session": event.get("session_id")})
    elif kind == "text":
        text = clean_output(event.get("text"))
        state["text"] += text
        return "\x00" + text if text else None
    elif kind in ("reasoning", "thinking"):
        text = clean_output(event.get("text") or event.get("thinking"))
        if text.strip():
            live.step(lid, {"t": "think", "text": text[:4000]})
    elif kind == "tool_use":
        state["seq"] += 1
        call = str(event.get("id") or event.get("tool_call_id") or f"hermes-tool-{state['seq']}")
        name = clean_output(event.get("name") or "工具")
        args = event.get("input") or {}
        state["calls"].append((call, name))
        live.step(lid, {"t": "tool", "tool": name, "id": call, "title": clean_output(title_of(name, args))}, code=tool_stats(name, args))
    elif kind == "tool_result":
        explicit = event.get("tool_call_id") or event.get("id")
        name = clean_output(event.get("name") or "工具")
        call = next((c for c, n in state["calls"] if c == explicit), None) if explicit else next((c for c, n in state["calls"] if n == name), None)
        if call:
            state["calls"] = [(c, n) for c, n in state["calls"] if c != call]
        else:
            state["seq"] += 1
            call = str(explicit or f"hermes-tool-{state['seq']}")
            live.step(lid, {"t": "tool", "tool": name, "id": call, "title": ""})
        live.step_output(lid, call, clean_output(event.get("output")))
        live.step_done(lid, call, error=bool(event.get("is_error")))
    elif kind == "result":
        tokens = event.get("tokens") or {}
        if isinstance(tokens, dict) and tokens:
            live.set_extra(lid, "usage", {"input_tokens": tokens.get("input", 0), "output_tokens": tokens.get("output", 0),
                                        "cache_read_input_tokens": tokens.get("cache_read", 0), "cache_creation_input_tokens": tokens.get("cache_write", 0)})
        text = clean_output(event.get("text"))
        # The final envelope repeats the full answer. Only forward missing text.
        # On a replay gap it can also supply the suffix missed by the live stream.
        if text.startswith(state["text"]):
            missing = text[len(state["text"]):]
            state["text"] = text
            return "\x00" + missing if missing else None
    return None


def parse_output(stdout: str, stderr: str):
    from pga.agents.base import AgentResult
    events = [event for line in stdout.splitlines() if (event := event_from_line(line))]
    if events:
        result = next((event for event in reversed(events) if event.get("type") == "result"), None)
        model = next((event.get("model") for event in events if event.get("type") == "system" and event.get("model")), None)
        text = clean_output(result.get("text")) if result else "".join(clean_output(event.get("text")) for event in events if event.get("type") == "text")
        code = result.get("exit_code", 1) if result else 1
        error = clean_output(result.get("error")) if result else "Hermes 输出中断，未收到完成事件"
        ok = code == 0 and not error and bool(text.strip())
        return AgentResult(ok=ok, text=text.strip(), model=model, session_id=result.get("session_id") if result else None,
                           status="STOPPED" if code == 130 else "SUCCEEDED" if ok else "FAILED",
                           error=None if ok else error or clean_output(stderr)[-500:] or "Hermes 未完成回答",
                           data={"via": "cli", "format": "stream-json"})
    # Compatibility with text-only wrappers; keep Unicode and code verbatim.
    lines = [line for line in clean_output(stdout).splitlines() if not line.strip().lower().startswith(("session_id", "session:", "resume with"))]
    text = "\n".join(lines).strip()
    return AgentResult(ok=bool(text), text=text, error=None if text else clean_output(stderr)[-500:])
