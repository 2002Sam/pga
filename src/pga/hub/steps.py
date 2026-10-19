"""How an agent worked, the way Claude Code shows it: each tool call as a step (what it did, how long, whether it
failed, its screenshots, the code it ran or wrote), what it said to itself in between, its thinking, and the tokens
each answer took.

Three kinds of records on this machine:
  claude   Claude Code / CodeBuddy / WorkBuddy transcripts (`~/.claude/projects/**/<session>.jsonl`)
  codex    Codex rollouts (`~/.codex/sessions/**/rollout-…-<thread>.jsonl`)
  hermes   Hermes' message table (`~/.hermes/state.db`)
The same records serve conversations imported from those apps and PGA's own runs of them. Steps carry a title and
references into the record; a step's full input and output (shown as code: a diff, a file, a command) and its
pictures are read again on demand, so a long session with hundreds of screenshots stays light.
"""

from __future__ import annotations

import base64
import difflib
import json
import re
import sqlite3
from datetime import datetime
from pathlib import Path
from typing import Any

HOME = str(Path.home())
TITLE_CHARS = 160
DETAIL_CHARS = 20000
IDLE_S = 300                     # a longer pause than this (waiting for you, a usage limit) is not time spent working
KINDS = ("claude", "codex", "hermes")


def _ts(v: Any) -> datetime | None:
    from pga.hub.connectors import _ts as ts
    return ts(v)


def _short(s: Any, n: int = TITLE_CHARS) -> str:
    s = " ".join(str(s or "").replace(HOME, "~").split())
    return s if len(s) <= n else s[: n - 1] + "…"


def _args(v: Any) -> Any:
    """Tool arguments as a dict when they are JSON text (Codex, Hermes)."""
    if isinstance(v, str):
        try:
            return json.loads(v)
        except (json.JSONDecodeError, ValueError):
            return v
    return v


def tool_parts(name: str, namespace: str = "") -> tuple[str, str]:
    """`mcp__Claude_Browser__computer` → ("computer", "Claude_Browser"); built-in tools have no server."""
    if name.startswith("mcp__"):
        bits = name.split("__")
        return (bits[-1], bits[1] if len(bits) > 2 else "")
    if namespace:
        return name, namespace[5:].split("__")[0] if namespace.startswith("mcp__") else namespace
    return name, ""


def _first_line(s: Any) -> str:
    return next((ln for ln in str(s or "").splitlines() if ln.strip() and not ln.strip().startswith(("//", "#"))), "")


def title_of(name: str, arg: Any) -> str:
    """One line saying what the call did, like Claude Code's step list."""
    a = arg if isinstance(arg, dict) else {}
    tool, _server = tool_parts(name)
    if isinstance(arg, str):                                  # Codex: exec / apply_patch take the code itself
        m = re.search(r"\*\*\* (?:Update|Add|Delete) File: (.+)", arg)
        return _short(m.group(1) if m else _first_line(arg))
    if tool in ("Bash", "BashOutput", "exec_command", "shell", "terminal"):
        cmd = a.get("command") or a.get("cmd")
        return _short(a.get("description") or (" ".join(cmd) if isinstance(cmd, list) else _first_line(cmd)))
    if tool in ("Read", "Write", "Edit", "MultiEdit", "NotebookEdit", "NotebookRead", "read_file", "write_file", "patch", "edit_file"):
        return _short(a.get("file_path") or a.get("notebook_path") or a.get("path"))
    if tool in ("Grep", "Glob", "search_files"):
        return _short(" ".join(str(x) for x in (a.get("pattern"), a.get("path") and f"in {a['path']}") if x))
    if tool == "WebFetch":
        return _short(a.get("url"))
    if tool == "WebSearch":
        return _short(a.get("query"))
    if tool in ("Agent", "Task"):
        return _short(a.get("description") or a.get("prompt"))
    if tool == "TodoWrite":
        todos = a.get("todos") if isinstance(a.get("todos"), list) else []
        cur = next((t.get("content") for t in todos if isinstance(t, dict) and t.get("status") == "in_progress"), "")
        return _short(cur or f"{len(todos)} items")
    if tool == "computer":
        return _short(a.get("action_summary") or " ".join(str(x) for x in (a.get("action"), a.get("coordinate") or a.get("text")) if x))
    for k in ("action_summary", "title", "description", "summary", "text", "query", "url", "path", "file_path", "command", "name", "action"):
        if isinstance(a.get(k), str) and a[k].strip():
            return _short(a[k])
    if isinstance(a.get("code"), str):
        return _short(_first_line(a["code"]))
    return ""


# ---------------------------------------------------------------- the code behind a step

LANG = {"py": "python", "js": "javascript", "mjs": "javascript", "cjs": "javascript", "ts": "typescript", "tsx": "tsx", "jsx": "jsx",
        "json": "json", "md": "markdown", "sh": "bash", "zsh": "bash", "bash": "bash", "css": "css", "html": "html", "htm": "html",
        "yaml": "yaml", "yml": "yaml", "toml": "toml", "sql": "sql", "go": "go", "rs": "rust", "java": "java", "c": "c", "h": "c",
        "cpp": "cpp", "hpp": "cpp", "swift": "swift", "kt": "kotlin", "rb": "ruby", "php": "php", "tex": "latex", "r": "r",
        "svelte": "html", "vue": "html", "xml": "xml", "ini": "ini", "cfg": "ini", "txt": "", "csv": ""}


def lang_of(path: Any) -> str:
    m = re.search(r"\.([A-Za-z0-9]+)$", str(path or ""))
    return LANG.get(m.group(1).lower(), "") if m else ""


def _udiff(old: str, new: str) -> str:
    return "\n".join(ln for ln in difflib.unified_diff(old.splitlines(), new.splitlines(), lineterm="", n=2)
                     if not ln.startswith(("---", "+++")))


def diff_stat(tool: str, a: Any) -> list[int] | None:
    """Lines added and removed by an editing call, for the badge on its step."""
    def n(s: Any) -> int:
        s = str(s or "")
        return s.count("\n") + 1 if s else 0
    if isinstance(a, str) and "*** Begin Patch" in a:                 # Codex apply_patch
        lines = a.splitlines()
        return [sum(1 for x in lines if x.startswith("+") and not x.startswith("+++")),
                sum(1 for x in lines if x.startswith("-") and not x.startswith("---"))]
    if not isinstance(a, dict):
        return None
    if tool == "Edit":
        return [n(a.get("new_string")), n(a.get("old_string"))]
    if tool == "MultiEdit" and isinstance(a.get("edits"), list):
        return [sum(n(e.get("new_string")) for e in a["edits"] if isinstance(e, dict)),
                sum(n(e.get("old_string")) for e in a["edits"] if isinstance(e, dict))]
    if tool in ("Write", "write_file"):
        return [n(a.get("content")), 0]
    if tool == "NotebookEdit":
        return [n(a.get("new_source")), 0]
    if tool == "patch" and isinstance(a.get("patch"), str):
        return diff_stat("", a["patch"])
    return None


def view_of(tool: str, a: Any, server: str = "") -> dict:
    """What a call asked for, as code to show: a diff, a whole file, a command, a script, or its arguments."""
    if isinstance(a, str):                                            # Codex: the code itself
        if "*** Begin Patch" in a:
            return {"kind": "diff", "code": a}
        return {"kind": "code", "lang": "javascript" if tool in ("exec", "js") else "bash" if tool in ("shell", "local_shell") else "", "code": a}
    a = a if isinstance(a, dict) else {}
    path = a.get("file_path") or a.get("notebook_path") or a.get("path")
    if tool == "Edit":
        return {"kind": "diff", "path": path, "code": _udiff(str(a.get("old_string") or ""), str(a.get("new_string") or ""))}
    if tool == "MultiEdit" and isinstance(a.get("edits"), list):
        return {"kind": "diff", "path": path, "code": "\n".join(_udiff(str(e.get("old_string") or ""), str(e.get("new_string") or ""))
                                                               for e in a["edits"] if isinstance(e, dict))}
    if tool in ("Write", "write_file") and isinstance(a.get("content"), str):
        return {"kind": "code", "path": path, "lang": lang_of(path), "code": a["content"]}
    if tool == "NotebookEdit":
        return {"kind": "code", "path": path, "lang": "python", "code": str(a.get("new_source") or "")}
    if tool in ("Bash", "BashOutput", "exec_command", "shell", "terminal"):
        cmd = a.get("command") or a.get("cmd") or ""
        return {"kind": "code", "lang": "bash", "code": " ".join(cmd) if isinstance(cmd, list) else str(cmd)}
    if isinstance(a.get("patch"), str):
        return {"kind": "diff", "path": path, "code": a["patch"]}
    if isinstance(a.get("code"), str):
        return {"kind": "code", "lang": a.get("language") or ("javascript" if tool == "js" or "repl" in server else "python"
                                                             if tool in ("execute_code", "python") else ""), "code": a["code"]}
    if tool in ("javascript_tool",) and isinstance(a.get("text"), str):
        return {"kind": "code", "lang": "javascript", "code": a["text"]}
    return {"kind": "code", "lang": "json", "code": json.dumps(a, ensure_ascii=False, indent=1)}


def out_lang(tool: str, a: Any) -> str:
    """The language of what came back: a file read keeps the file's own."""
    if tool in ("Read", "read_file") and isinstance(a, dict):
        return lang_of(a.get("file_path") or a.get("path"))
    return ""


# ---------------------------------------------------------------- one answer's work

def _usage(u: dict) -> tuple[int, int, int]:
    """Claude's usage: (input including the cache, read from the cache, output)."""
    def n(k: str) -> int:
        try:
            return int(u.get(k) or 0)
        except (TypeError, ValueError):
            return 0
    cached = n("cache_read_input_tokens")
    return n("input_tokens") + cached + n("cache_creation_input_tokens"), cached, n("output_tokens")


class Work:
    """What happened between two answers. Feed it record entries in order; `take()` hands back the process of
    the answer that ends it and starts the next one."""

    def __init__(self) -> None:
        self.begin: datetime | None = None
        self.last: datetime | None = None              # the latest moment it was working
        self.calls: dict[str, dict] = {}               # tool call id → its step (for the result)
        self.seen_msgs: set[str] = set()
        self._reset()

    def _reset(self) -> None:
        self.steps: list[dict] = []
        self.active = 0.0                               # seconds spent working, pauses left out
        self.inp = self.cached = self.out = self.n = 0
        self.context = 0
        self.model: str | None = None

    def start(self, ts: datetime | None, *, keep: bool = False) -> None:
        """A new request: the clock of the next answer starts here (`keep`: work that has no answer yet goes on with it)."""
        if keep and self.begin is not None:
            return
        self.begin = self.last = ts
        self._reset()

    def tick(self, ts: datetime | None) -> None:
        if ts is None:
            return
        if self.begin is None:
            self.begin = self.last = ts
        if self.last is not None and 0 < (gap := (ts - self.last).total_seconds()) <= IDLE_S:
            self.active += gap
        self.last = ts if self.last is None or ts > self.last else self.last

    @property
    def pending(self) -> bool:
        return bool(self.steps or self.n)

    # what happened, whatever the record looks like
    def note(self, text: str, ts: datetime | None) -> None:
        """Words the agent wrote that were not its answer (commentary between tools, in a project thread)."""
        if str(text or "").strip():
            self.steps.append({"t": "note", "text": str(text).strip()[:4000], **({"at": ts.isoformat()} if ts else {})})

    def think(self, text: str, ts: datetime | None) -> None:
        if str(text or "").strip():
            self.steps.append({"t": "think", "text": str(text).strip()[:4000], **({"at": ts.isoformat()} if ts else {})})

    def tool(self, name: str, arg: Any, ref: str, ts: datetime | None, call: str = "", namespace: str = "") -> dict:
        tool, server = tool_parts(name, namespace)
        st = {"t": "tool", "tool": tool, **({"server": server} if server else {}), "title": title_of(name, arg), "ref": ref,
              **({"at": ts.isoformat()} if ts else {})}
        if (d := diff_stat(tool, arg)) and any(d):
            st["diff"] = d
        self.steps.append(st)
        if call:
            self.calls[call] = st
        if ts:
            st["_t0"] = ts
        return st

    def result(self, call: str, out: str, ts: datetime | None, *, error: bool = False, images: list[str] | None = None) -> None:
        st = self.calls.pop(call or "", None)
        if st is None:
            return
        st["out"] = out
        if error:
            st["error"] = True
        t0 = st.pop("_t0", None)
        if t0 and ts:
            st["secs"] = round(max(0.0, (ts - t0).total_seconds()), 1)
        if images:
            st["images"] = images[:12]

    def tokens(self, inp: int, cached: int, out: int, model: str | None = None) -> None:
        self.inp, self.cached, self.out, self.n = self.inp + inp, self.cached + cached, self.out + out, self.n + 1
        self.context = inp or self.context
        if model:
            self.model = model

    # Claude Code
    def feed(self, e: dict, line: int, *, skip_reply: bool = True) -> None:
        """One Claude Code entry: tool calls, thinking and usage from the assistant; tool results from the user side."""
        msg = e.get("message") if isinstance(e.get("message"), dict) else {}
        content = msg.get("content")
        ts = _ts(e.get("timestamp"))
        self.tick(ts)
        if e.get("type") == "assistant":
            mid = str(msg.get("id") or "")
            if isinstance(msg.get("usage"), dict) and (not mid or mid not in self.seen_msgs):   # one API call, several entries
                if mid:
                    self.seen_msgs.add(mid)
                self.tokens(*_usage(msg["usage"]))
            if msg.get("model") and not str(msg["model"]).startswith("<"):
                self.model = str(msg["model"])
            for b, blk in enumerate(content if isinstance(content, list) else []):
                if not isinstance(blk, dict):
                    continue
                if blk.get("type") == "thinking":
                    self.think(str(blk.get("thinking") or ""), ts)
                elif blk.get("type") == "tool_use":
                    name = str(blk.get("name") or "")
                    if skip_reply and name.endswith("__reply"):
                        continue                                     # the answer itself, not a step
                    self.tool(name, blk.get("input"), f"{line}.{b}", ts, str(blk.get("id") or ""))
        elif e.get("type") == "user" and isinstance(content, list):
            for b, blk in enumerate(content):
                if isinstance(blk, dict) and blk.get("type") == "tool_result":
                    sub = blk.get("content")
                    imgs = [f"{line}.{b}.{j}" for j, x in enumerate(sub if isinstance(sub, list) else []) if isinstance(x, dict) and x.get("type") == "image"]
                    self.result(str(blk.get("tool_use_id") or ""), f"{line}.{b}", ts, error=bool(blk.get("is_error")), images=imgs)

    # Codex
    def feed_codex(self, e: dict, line: int) -> None:
        """One Codex rollout line: reasoning, tool calls (`exec` scripts, functions, shell, patches) and their output, tokens."""
        p = e.get("payload") if isinstance(e.get("payload"), dict) else {}
        ts = _ts(e.get("timestamp"))
        self.tick(ts)
        kind = p.get("type")
        if e.get("type") == "response_item":
            if kind == "reasoning":
                self.think("\n".join(str(s.get("text") or "") for s in p.get("summary") or [] if isinstance(s, dict)), ts)
            elif kind in ("custom_tool_call", "function_call", "local_shell_call"):
                arg = p.get("input") if kind == "custom_tool_call" else _args(p.get("arguments")) if kind == "function_call" else p.get("action")
                self.tool(str(p.get("name") or ("shell" if kind == "local_shell_call" else kind)), arg, str(line), ts,
                          str(p.get("call_id") or p.get("id") or ""), str(p.get("namespace") or ""))
            elif kind in ("custom_tool_call_output", "function_call_output", "local_shell_call_output"):
                o = p.get("output")
                imgs = [f"{line}.{j}" for j, x in enumerate(o if isinstance(o, list) else []) if isinstance(x, dict) and x.get("type") == "input_image"]
                text = o if isinstance(o, str) else ""
                self.result(str(p.get("call_id") or ""), str(line), ts, images=imgs,
                            error=bool(re.search(r'"exit_code":\s*[1-9]|Process exited with code [1-9]|^Error', text[:400])))
        elif e.get("type") == "token_usage_record" and isinstance(p.get("usage"), dict):
            rid = str(p.get("response_id") or "")
            if rid and rid in self.seen_msgs:
                return
            self.seen_msgs.add(rid)
            u = p["usage"]
            self.tokens(int(u.get("input_tokens") or 0), int(u.get("cached_input_tokens") or 0), int(u.get("output_tokens") or 0))

    def take(self, ts: datetime | None) -> dict | None:
        """The process of the answer said at `ts`; the next answer's clock starts there."""
        for st in self.steps:
            st.pop("_t0", None)
        self.tick(ts)
        how = {"steps": self.steps, **({"seconds": round(self.active, 1)} if self.begin else {}),
               **({"usage": {"input": self.inp, "cached": self.cached, "output": self.out, "calls": self.n, "context": self.context}} if self.n else {}),
               **({"model": self.model} if self.model else {})}
        empty = not self.steps and not self.n
        self.begin = ts
        self._reset()
        return None if empty else how


def merge(how: dict | None, more: dict | None) -> dict | None:
    """Work the agent did after it answered (it went on before you spoke again) belongs to that answer."""
    if not more:
        return how
    if not how:
        return more
    out = {**how, "steps": how.get("steps", []) + more.get("steps", [])}
    if more.get("seconds"):
        out["seconds"] = round((how.get("seconds") or 0) + more["seconds"], 1)
    if more.get("usage"):
        u, v = how.get("usage") or {}, more["usage"]
        out["usage"] = {k: (u.get(k) or 0) + (v.get(k) or 0) for k in ("input", "cached", "output", "calls")} | {"context": v.get("context") or u.get("context", 0)}
    return out


def images_in(content: Any, line: int) -> list[str]:
    """Pictures you attached to a message (`line.block`)."""
    return [f"{line}.{b}" for b, x in enumerate(content if isinstance(content, list) else []) if isinstance(x, dict) and x.get("type") == "image"][:12]


# ---------------------------------------------------------------- finding a record, reading a step or a picture again

def transcript(session: str, kind: str = "claude") -> Path | None:
    """The record of a session on this machine (a file; Hermes keeps one database)."""
    from pga.hub.connectors import CLAUDE_CODE_DIR, CODEBUDDY_DIR, CODEX_DIRS, HERMES_DB, WORKBUDDY_DB
    sid = re.sub(r"[^\w-]", "", session or "")[:80]
    if len(sid) < 8 and kind != "hermes":
        return None
    if kind == "hermes":
        return HERMES_DB if HERMES_DB.exists() and sid else None
    if kind == "codex":
        return next((p for r in CODEX_DIRS if r.exists() for p in r.glob(f"**/*{sid}.jsonl")), None)
    for root in (CLAUDE_CODE_DIR, CODEBUDDY_DIR, WORKBUDDY_DB.parent / "projects"):
        f = next(iter(root.glob(f"*/{sid}.jsonl")), None) if root.exists() else None
        if f:
            return f
    return None


_OFFSETS: dict[str, tuple[float, int, list[int]]] = {}


def _line(f: Path, n: int) -> dict | None:
    """Entry `n` (0-based line) of a record, by a cached index of line offsets."""
    try:
        st = f.stat()
    except OSError:
        return None
    key = str(f)
    cached = _OFFSETS.get(key)
    if cached is None or cached[0] != st.st_mtime or cached[1] != st.st_size:
        offs, pos = [], 0
        with f.open("rb") as fh:
            for raw in fh:
                offs.append(pos)
                pos += len(raw)
        if len(_OFFSETS) > 16:
            _OFFSETS.clear()
        _OFFSETS[key] = cached = (st.st_mtime, st.st_size, offs)
    offs = cached[2]
    if not 0 <= n < len(offs):
        return None
    with f.open("rb") as fh:
        fh.seek(offs[n])
        try:
            e = json.loads(fh.readline().decode("utf-8", errors="replace"))
        except json.JSONDecodeError:
            return None
    return e if isinstance(e, dict) else None


REF = re.compile(r"\d{1,9}(?:\.\d{1,4}){0,2}")


def _nums(ref: str | None) -> list[int] | None:
    return [int(x) for x in ref.split(".")] if ref and REF.fullmatch(ref) else None


def _block(f: Path, ref: str | None) -> Any:
    """Claude: `line.block` (a tool call, a result, a picture you sent) or `line.block.item` (a picture in a result)."""
    n = _nums(ref)
    if not n or len(n) < 2:
        return None
    e = _line(f, n[0])
    content = ((e or {}).get("message") or {}).get("content")
    if not isinstance(content, list) or n[1] >= len(content):
        return None
    blk = content[n[1]]
    if len(n) > 2:
        sub = blk.get("content") if isinstance(blk, dict) else None
        if not isinstance(sub, list) or n[2] >= len(sub):
            return None
        blk = sub[n[2]]
    return blk


def _plain(content: Any) -> str:
    if isinstance(content, str):
        return content
    if isinstance(content, list):
        return "\n".join(_plain(x) for x in content if not (isinstance(x, dict) and x.get("type") in ("image", "input_image")))
    if isinstance(content, dict):
        return str(content.get("text") or "") if content.get("type") in (None, "text", "input_text", "output_text") else ""
    return ""


def _hermes(db: Path, sql: str, args: tuple) -> list[tuple]:
    con = sqlite3.connect(f"file:{db}?mode=ro", uri=True, timeout=5)
    try:
        return con.execute(sql, args).fetchall()
    finally:
        con.close()


def detail(f: Path, ref: str, out: str | None, kind: str = "claude", session: str = "") -> dict | None:
    """A step in full: what was asked of the tool, shown as code, and what came back (secrets redacted), its pictures."""
    from pga.hub.connectors import redact
    name, ns, arg, res_text, err, imgs = "", "", None, "", False, []
    if kind == "claude":
        call = _block(f, ref)
        if not isinstance(call, dict) or call.get("type") != "tool_use":
            return None
        name, arg = str(call.get("name") or ""), call.get("input")
        res = _block(f, out) if out else None
        if isinstance(res, dict):
            res_text, err = _plain(res.get("content")), bool(res.get("is_error"))
            if isinstance(res.get("content"), list):
                imgs = [f"{out}.{j}" for j, x in enumerate(res["content"]) if isinstance(x, dict) and x.get("type") == "image"]
    elif kind == "codex":
        n = _nums(ref)
        p = ((_line(f, n[0]) or {}).get("payload") or {}) if n else {}
        if p.get("type") not in ("custom_tool_call", "function_call", "local_shell_call"):
            return None
        name, ns = str(p.get("name") or "shell"), str(p.get("namespace") or "")
        arg = p.get("input") if p["type"] == "custom_tool_call" else _args(p.get("arguments")) if p["type"] == "function_call" else p.get("action")
        o = n2 = _nums(out)
        if n2:
            o = ((_line(f, n2[0]) or {}).get("payload") or {}).get("output")
            res_text = _plain(o)
            imgs = [f"{out}.{j}" for j, x in enumerate(o if isinstance(o, list) else []) if isinstance(x, dict) and x.get("type") == "input_image"]
    elif kind == "hermes":
        n, n2 = _nums(ref), _nums(out)
        if not n or len(n) < 2:
            return None
        row = _hermes(f, "select tool_calls from messages where id = ? and session_id = ?", (n[0], session))
        calls = _args(row[0][0]) if row and row[0][0] else []
        if not isinstance(calls, list) or n[1] >= len(calls):
            return None
        fn = (calls[n[1]] or {}).get("function") or {}
        name, arg = str(fn.get("name") or ""), _args(fn.get("arguments"))
        if n2:
            r2 = _hermes(f, "select content from messages where id = ? and session_id = ?", (n2[0], session))
            res_text = str(r2[0][0] or "") if r2 else ""
            err = bool(re.match(r'\s*\{\s*"(success)":\s*false|\s*\{\s*"error"', res_text))
    else:
        return None
    tool, server = tool_parts(name, ns)
    view = view_of(tool, arg, server)
    view["code"] = redact(str(view.get("code") or ""))[:DETAIL_CHARS]
    return {"tool": tool, "server": server, "view": view, "output": redact(res_text)[:DETAIL_CHARS], "output_lang": out_lang(tool, arg),
            "cut": len(res_text) > DETAIL_CHARS, "error": err, "images": imgs[:12]}


def _data_url(u: str) -> tuple[bytes, str] | None:
    m = re.match(r"data:(image/(?:png|jpeg|gif|webp));base64,(.+)$", u or "", re.S)
    if not m:
        return None
    try:
        return base64.b64decode(m.group(2)), m.group(1)
    except (ValueError, TypeError):
        return None


def image(f: Path, ref: str, kind: str = "claude") -> tuple[bytes, str] | None:
    if kind == "codex":
        n = _nums(ref)
        if not n or len(n) != 2:
            return None
        o = ((_line(f, n[0]) or {}).get("payload") or {}).get("output")
        x = o[n[1]] if isinstance(o, list) and n[1] < len(o) else None
        return _data_url(str(x.get("image_url") or "")) if isinstance(x, dict) and x.get("type") == "input_image" else None
    if kind != "claude":
        return None
    blk = _block(f, ref)
    src = blk.get("source") if isinstance(blk, dict) and blk.get("type") == "image" else None
    if not isinstance(src, dict) or src.get("type") != "base64" or not src.get("data"):
        return None
    mt = str(src.get("media_type") or "image/png")
    if not re.fullmatch(r"image/(png|jpeg|gif|webp)", mt):
        return None
    try:
        return base64.b64decode(src["data"]), mt
    except (ValueError, TypeError):
        return None


# ---------------------------------------------------------------- one run of PGA's own agents

_ENTRIES: dict[str, tuple[float, int, list[tuple[int, dict]]]] = {}


def _entries(f: Path) -> list[tuple[int, dict]]:
    """The record's entries, cached until the file changes."""
    st = f.stat()
    c = _ENTRIES.get(str(f))
    if c and c[0] == st.st_mtime and c[1] == st.st_size:
        return c[2]
    out = []
    with f.open(encoding="utf-8", errors="replace") as fh:
        for i, ln in enumerate(fh):
            try:
                e = json.loads(ln)
            except json.JSONDecodeError:
                continue
            if isinstance(e, dict) and not e.get("isSidechain"):
                out.append((i, e))
    if len(_ENTRIES) > 8:
        _ENTRIES.clear()
    _ENTRIES[str(f)] = (st.st_mtime, st.st_size, out)
    return out


def window(session: str, start: datetime | None, end: datetime | None, kind: str = "claude") -> dict | None:
    """How one run went: the steps between when it was asked and when it finished. The words it wrote before its
    last ones are commentary (the answer is its last text)."""
    f = transcript(session, kind)
    if f is None or kind == "hermes":
        return None
    try:
        entries = _entries(f)
    except OSError:
        return None
    w = Work()
    w.start(start)
    last = None
    for i, e in entries:
        ts = _ts(e.get("timestamp"))
        if ts is None or (start is not None and ts < start) or (end is not None and ts > end):
            continue
        if kind == "codex":
            w.feed_codex(e, i)
            p = e.get("payload") or {}
            if e.get("type") == "response_item" and p.get("type") == "message" and p.get("role") == "assistant":
                w.note(_plain(p.get("content")), ts)
        elif e.get("type") in ("user", "assistant"):
            w.feed(e, i, skip_reply=False)
            msg = e.get("message") if isinstance(e.get("message"), dict) else {}
            if e.get("type") == "assistant" and isinstance(msg.get("content"), list):
                for blk in msg["content"]:
                    if isinstance(blk, dict) and blk.get("type") == "text":
                        w.note(str(blk.get("text") or ""), ts)
        last = ts or last
    if w.steps and w.steps[-1]["t"] == "note":
        w.steps.pop()                                   # its last words are the answer shown below
    how = w.take(end or last)
    if how is not None:
        how["src"] = {"kind": kind, "session": session}
        for st in how["steps"]:                          # each step knows its record, so runs can be put together
            if st["t"] == "tool":
                st["src"] = f"{kind}:{session}"
    return how


SESSION_ADAPTERS = {"claude_local": "claude", "codebuddy_local": "claude", "codex_local": "codex"}


def run_how(run: Any) -> dict | None:
    """How one of PGA's agent runs went, step by step, when the agent kept its session on this machine."""
    kind = SESSION_ADAPTERS.get(getattr(run, "adapter", "") or "")
    d = getattr(run, "data", None) or {}
    sid = d.get("session") or d.get("thread") or getattr(run, "session_id", None)
    if not kind or not sid:
        return None
    try:
        return window(str(sid), run.started_at, run.finished_at, kind)
    except Exception:  # a record that cannot be read is just not shown
        return None
