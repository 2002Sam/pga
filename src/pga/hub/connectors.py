"""Readers for the other AI agents a user works with.

Two kinds of source:

* export files the user uploads — ChatGPT (`conversations.json` / the export .zip), Claude.ai,
  DeepSeek, any OpenAI-style message list, or plain Markdown/text transcripts;
* agents that keep their history on this machine — Claude Code (`~/.claude/projects/**.jsonl`)
  and Hermes Agent (`~/.hermes/state.db`), read-only.

Everything is reduced to `Conv` records with a short, secret-redacted excerpt. Full transcripts
are never stored and never sent to a model.
"""

from __future__ import annotations

import io
import json
import re
import sqlite3
import zipfile
from dataclasses import dataclass, field
from datetime import datetime, timezone
from pathlib import Path
from typing import Any, Iterable

MAX_CONVERSATIONS = 3000
EXCERPT_CHARS = 1600


@dataclass
class Conv:
    external_id: str
    title: str
    started_at: datetime | None = None
    updated_at: datetime | None = None
    turns: list[tuple[str, str]] = field(default_factory=list)   # (user|assistant, text)
    project: str | None = None

    @property
    def message_count(self) -> int:
        return len(self.turns)


class ImportError_(ValueError):
    """The upload could not be understood."""


# ---------------------------------------------------------------- redaction & excerpts

_SECRETS: list[tuple[re.Pattern[str], str]] = [
    (re.compile(r"-----BEGIN [A-Z ]*PRIVATE KEY-----[\s\S]*?-----END [A-Z ]*PRIVATE KEY-----"), "[REDACTED_PRIVATE_KEY]"),
    (re.compile(r"\bsk-(?:ant-|proj-)?[A-Za-z0-9_\-]{16,}"), "[REDACTED_KEY]"),
    (re.compile(r"\b(?:AKIA|ASIA)[0-9A-Z]{16}\b"), "[REDACTED_KEY]"),
    (re.compile(r"\bgh[pousr]_[A-Za-z0-9]{30,}\b"), "[REDACTED_TOKEN]"),
    (re.compile(r"\bxox[abprs]-[A-Za-z0-9-]{10,}\b"), "[REDACTED_TOKEN]"),
    (re.compile(r"\bAIza[0-9A-Za-z_\-]{30,}\b"), "[REDACTED_KEY]"),
    (re.compile(r"\beyJ[A-Za-z0-9_\-]{10,}\.[A-Za-z0-9_\-]{10,}\.[A-Za-z0-9_\-]{10,}"), "[REDACTED_JWT]"),
    (re.compile(r"(?i)\b(password|passwd|pwd|secret|token|api[_-]?key|access[_-]?key)(\s*[:=]\s*)\S+"), r"\1\2[REDACTED]"),
    (re.compile(r"(?i)(postgres(?:ql)?(?:\+\w+)?|mysql|mongodb(?:\+srv)?|redis)://[^\s:@/]+:[^\s@/]+@"), r"\1://[REDACTED]@"),
]


def redact(text: str) -> str:
    for pat, repl in _SECRETS:
        text = pat.sub(repl, text)
    return text


_NOISE = re.compile(r"<(system-reminder|command-[a-z-]+|local-command-[a-z-]+|bash-[a-z-]+|ide_[a-z_]+)>[\s\S]*?</\1>")


def clean(text: str) -> str:
    text = _NOISE.sub("", text or "")
    return re.sub(r"\n{3,}", "\n\n", text).strip()


def excerpt(turns: list[tuple[str, str]], limit: int = EXCERPT_CHARS) -> str:
    """The opening request plus the latest turns — enough to tell what the conversation was about."""
    turns = [(r, clean(t)) for r, t in turns if clean(t)]
    if not turns:
        return ""
    def line(r: str, t: str, n: int) -> str:
        t = " ".join(t.split())
        return f"{'User' if r == 'user' else 'Assistant'}: {t[:n]}{'…' if len(t) > n else ''}"
    first = next((i for i, (r, _) in enumerate(turns) if r == "user"), 0)
    parts = [line(*turns[first], 500)]
    tail = [line(r, t, 260) for r, t in turns[max(first + 1, len(turns) - 6):]]
    if len(turns) - first - 1 > len(tail):
        parts.append(f"[… {len(turns) - first - 1 - len(tail)} more turns …]")
    parts += tail
    return redact("\n".join(parts))[:limit]


def _ts(v: Any) -> datetime | None:
    if v in (None, "", 0):
        return None
    try:
        if isinstance(v, (int, float)):
            return datetime.fromtimestamp(v / 1000 if v > 1e12 else v, tz=timezone.utc)
        s = str(v).strip().replace("Z", "+00:00")
        d = datetime.fromisoformat(s)
        return d if d.tzinfo else d.replace(tzinfo=timezone.utc)
    except (ValueError, OverflowError, OSError):
        return None


def _text(content: Any) -> str:
    """Pull plain text out of the many shapes chat exports use."""
    if content is None:
        return ""
    if isinstance(content, str):
        return content
    if isinstance(content, list):
        return "\n".join(t for t in (_text(c) for c in content) if t)
    if isinstance(content, dict):
        if content.get("type") in ("tool_use", "tool_result", "image", "thinking", "redacted_thinking"):
            return ""
        for k in ("text", "content", "parts", "value"):
            if k in content:
                return _text(content[k])
    return ""


def _role(v: Any) -> str | None:
    r = str(v or "").lower()
    if r in ("user", "human", "request"):
        return "user"
    if r in ("assistant", "ai", "model", "bot", "gpt", "response", "chatbot"):
        return "assistant"
    return None


# ---------------------------------------------------------------- export formats


def parse_chatgpt(items: list[dict]) -> list[Conv]:
    """ChatGPT `conversations.json` (and DeepSeek exports, which use the same mapping tree)."""
    out = []
    for c in items:
        msgs = []
        for node in (c.get("mapping") or {}).values():
            m = (node or {}).get("message") or {}
            if not m:
                continue
            role = _role((m.get("author") or {}).get("role") or m.get("role"))
            if m.get("fragments"):            # DeepSeek: REQUEST / RESPONSE / THINK fragments
                for f in m["fragments"]:
                    fr = _role(f.get("type"))
                    if fr and f.get("content"):
                        msgs.append((m.get("inserted_at") or 0, fr, str(f["content"])))
                continue
            text = _text((m.get("content") or {}).get("parts") or m.get("content"))
            if role and text.strip():
                msgs.append((m.get("create_time") or 0, role, text))
        msgs.sort(key=lambda x: _ts(x[0]) or datetime.min.replace(tzinfo=timezone.utc))
        cid = str(c.get("id") or c.get("conversation_id") or c.get("uuid") or hash(json.dumps(c, sort_keys=True, default=str)))
        out.append(Conv(cid, str(c.get("title") or ""), _ts(c.get("create_time") or c.get("inserted_at")),
                        _ts(c.get("update_time") or c.get("updated_at")), [(r, t) for _, r, t in msgs]))
    return out


def parse_claude(items: list[dict]) -> list[Conv]:
    """Claude.ai data export `conversations.json`."""
    out = []
    for c in items:
        turns = []
        for m in c.get("chat_messages") or []:
            role = _role(m.get("sender"))
            text = m.get("text") or _text(m.get("content"))
            if role and text:
                turns.append((role, text))
        out.append(Conv(str(c.get("uuid") or c.get("id")), str(c.get("name") or ""), _ts(c.get("created_at")),
                        _ts(c.get("updated_at")), turns))
    return out


def parse_messages_list(items: list[dict], cid: str, title: str = "") -> Conv:
    turns = [(r, _text(m.get("content") if "content" in m else m.get("text"))) for m in items
             if (r := _role(m.get("role") or m.get("sender") or m.get("author")))]
    return Conv(cid, title, _ts(items[0].get("created_at") or items[0].get("timestamp")) if items else None,
                _ts(items[-1].get("created_at") or items[-1].get("timestamp")) if items else None, turns)


def parse_generic(data: Any, name: str) -> list[Conv]:
    if isinstance(data, dict):
        for k in ("conversations", "chats", "data", "items", "sessions"):
            if isinstance(data.get(k), list):
                return parse_generic(data[k], name)
        if isinstance(data.get("messages"), list):
            return [parse_messages_list(data["messages"], str(data.get("id") or name), str(data.get("title") or name))]
        raise ImportError_("JSON 结构无法识别")
    if not isinstance(data, list) or not data:
        raise ImportError_("文件里没有找到对话")
    first = data[0] if isinstance(data[0], dict) else {}
    if "mapping" in first:
        return parse_chatgpt(data)
    if "chat_messages" in first:
        return parse_claude(data)
    if "messages" in first:
        return [parse_messages_list(c.get("messages") or [], str(c.get("id") or c.get("uuid") or f"{name}#{i}"),
                                    str(c.get("title") or c.get("name") or "")) for i, c in enumerate(data)]
    if "role" in first or "sender" in first:
        return [parse_messages_list(data, name, name)]
    raise ImportError_("JSON 结构无法识别")


_SPEAKER = re.compile(r"^\s*(?:#+\s*|\*\*)?(user|you|me|human|我|用户|assistant|ai|chatgpt|claude|deepseek|gemini|kimi|豆包|助手|bot)\s*(?:\*\*)?\s*[:：]\s*(.*)$", re.I)


def parse_text(text: str, name: str) -> list[Conv]:
    """A pasted/Markdown transcript. Speaker lines like 'User:' / '我：' / 'Assistant:' split turns."""
    turns: list[tuple[str, str]] = []
    for raw in text.splitlines():
        m = _SPEAKER.match(raw)
        if m:
            who = m.group(1).lower()
            turns.append(("user" if who in ("user", "you", "me", "human", "我", "用户") else "assistant", m.group(2)))
        elif turns:
            turns[-1] = (turns[-1][0], turns[-1][1] + "\n" + raw)
    if not turns and text.strip():
        turns = [("user", text.strip())]
    title = next((ln.lstrip("# ").strip() for ln in text.splitlines() if ln.strip()), name)[:120]
    return [Conv(name, title, None, None, turns)]


def guess_vendor(convs_source: Any) -> str | None:
    first = convs_source[0] if isinstance(convs_source, list) and convs_source and isinstance(convs_source[0], dict) else {}
    if "chat_messages" in first:
        return "claude"
    if "mapping" in first:
        nodes = [n for n in (first.get("mapping") or {}).values() if (n or {}).get("message")]
        return "deepseek" if any((n["message"] or {}).get("fragments") for n in nodes) else "chatgpt"
    return None


def parse_upload(filename: str, raw: bytes) -> tuple[list[Conv], str | None]:
    """Any supported upload → (conversations, vendor guess)."""
    name = Path(filename or "upload").name
    low = name.lower()
    if low.endswith(".zip") or raw[:2] == b"PK":
        try:
            z = zipfile.ZipFile(io.BytesIO(raw))
        except zipfile.BadZipFile as exc:
            raise ImportError_("压缩包已损坏") from exc
        names = [n for n in z.namelist() if not n.endswith("/")]
        main = next((n for n in names if Path(n).name.lower() == "conversations.json"), None)
        if main:
            return parse_upload(main, z.read(main))
        convs, vendor = [], None
        for n in names:
            if n.lower().endswith((".json", ".jsonl", ".md", ".markdown", ".txt")) and z.getinfo(n).file_size < 50_000_000:
                try:
                    c, v = parse_upload(n, z.read(n))
                    convs += c
                    vendor = vendor or v
                except ImportError_:
                    continue
        if not convs:
            raise ImportError_("压缩包里没有可识别的对话文件")
        return convs[:MAX_CONVERSATIONS], vendor
    text = raw.decode("utf-8-sig", errors="replace")
    if low.endswith((".json", ".jsonl")) or text.lstrip()[:1] in ("[", "{"):
        try:
            data = json.loads(text)
        except json.JSONDecodeError:
            try:
                data = [json.loads(ln) for ln in text.splitlines() if ln.strip()]
            except json.JSONDecodeError as exc:
                raise ImportError_("JSON 解析失败") from exc
        return parse_generic(data, name)[:MAX_CONVERSATIONS], guess_vendor(data)
    return parse_text(text, name), None


# ---------------------------------------------------------------- agents that live on this machine

CLAUDE_CODE_DIR = Path.home() / ".claude" / "projects"
HERMES_DB = Path.home() / ".hermes" / "state.db"


def claude_code_sessions(root: Path = CLAUDE_CODE_DIR) -> list[Conv]:
    out = []
    for f in sorted(root.glob("*/*.jsonl")):
        turns, title, started, updated, project = [], None, None, None, None
        try:
            lines = f.read_text(encoding="utf-8", errors="replace").splitlines()
        except OSError:
            continue
        for ln in lines:
            try:
                e = json.loads(ln)
            except json.JSONDecodeError:
                continue
            if e.get("type") == "summary" and e.get("summary"):
                title = title or str(e["summary"])
                continue
            if e.get("type") not in ("user", "assistant") or e.get("isMeta"):
                continue
            ts = _ts(e.get("timestamp"))
            started, updated = started or ts, ts or updated
            project = project or (Path(e["cwd"]).name if e.get("cwd") else None)
            text = clean(_text((e.get("message") or {}).get("content")))
            if text:
                turns.append((e["type"], text))
        if turns:
            first_user = next((t for r, t in turns if r == "user"), "")
            out.append(Conv(f.stem, (title or " ".join(first_user.split())[:90]), started, updated, turns,
                            project or f.parent.name.strip("-").split("-")[-1]))
    return out


def hermes_sessions(db: Path = HERMES_DB) -> list[Conv]:
    con = sqlite3.connect(f"file:{db}?mode=ro", uri=True, timeout=5)
    try:
        cols = {r[1] for r in con.execute("pragma table_info(sessions)")}
        title_expr = "coalesce(title, display_name, '')" if "title" in cols else "coalesce(display_name, '')"
        last_expr = "coalesce(last_activity_at, ended_at, started_at)" if "last_activity_at" in cols else "coalesce(ended_at, started_at)"
        where = "where coalesce(hidden, 0) = 0" if "hidden" in cols else ""
        sessions = con.execute(f"select id, {title_expr}, started_at, {last_expr}, coalesce(cwd, '') from sessions {where} "
                               f"order by started_at").fetchall()
        out = []
        for sid, title, started, last, cwd in sessions:
            rows = con.execute("select role, content from messages where session_id = ? and role in ('user','assistant') "
                               "and content is not null and coalesce(active, 1) = 1 order by timestamp", (sid,)).fetchall()
            turns = [(r, c) for r, c in rows if c and c.strip()]
            if not turns:
                continue
            first_user = next((t for r, t in turns if r == "user"), "")
            out.append(Conv(str(sid), title or " ".join(first_user.split())[:90], _ts(started), _ts(last), turns,
                            Path(cwd).name if cwd else None))
        return out
    finally:
        con.close()


LOCAL_CONNECTORS = {
    "claude_code": {"vendor": "claude_code", "name": "Claude Code", "path": CLAUDE_CODE_DIR, "read": claude_code_sessions},
    "hermes": {"vendor": "hermes", "name": "Hermes Agent", "path": HERMES_DB, "read": hermes_sessions},
}


def detect_local() -> list[dict]:
    """Which local agents exist on this machine, and roughly how much history each has."""
    found = []
    for key, c in LOCAL_CONNECTORS.items():
        p: Path = c["path"]
        if not p.exists():
            continue
        try:
            if key == "claude_code":
                count = sum(1 for _ in p.glob("*/*.jsonl"))
            else:
                con = sqlite3.connect(f"file:{p}?mode=ro", uri=True, timeout=5)
                try:
                    count = con.execute("select count(*) from sessions").fetchone()[0]
                finally:
                    con.close()
        except (OSError, sqlite3.Error):
            continue
        if count:
            found.append({"connector": key, "vendor": c["vendor"], "name": c["name"], "sessions": count,
                          "path": str(p).replace(str(Path.home()), "~")})
    return found


def read_local(connector: str) -> list[Conv]:
    c = LOCAL_CONNECTORS.get(connector)
    if c is None:
        raise ImportError_(f"unknown local connector {connector!r}")
    return c["read"]()


def iter_corpus(convs: Iterable[tuple[str, datetime | None, str]], budget: int) -> str:
    """Pack (title, date, excerpt) records into one block for a model, newest first, within budget chars."""
    out, used = [], 0
    for title, when, ex in convs:
        block = f"### {title or '(untitled)'} — {when.date().isoformat() if when else 'unknown date'}\n{ex}\n"
        if used + len(block) > budget:
            break
        out.append(block)
        used += len(block)
    return "\n".join(out)
