"""Readers for the other AI agents a user works with.

Two kinds of source:

* export files the user uploads — ChatGPT (`conversations.json` / the export .zip), Claude.ai,
  DeepSeek, any OpenAI-style message list, or plain Markdown/text transcripts;
* agents that keep their history on this machine, read-only — Claude Code (`~/.claude/projects/**.jsonl`),
  Hermes Agent (`~/.hermes/state.db`), ChatGPT/Codex (`~/.codex/sessions/**.jsonl`), the WorkBuddy app
  (`~/.workbuddy/workbuddy.db` + its `projects/**.jsonl`) and the CodeBuddy CLI (`~/.codebuddy/projects`).
  Sessions PGA itself started (in its workspaces or a temp folder) are left out — they are already PGA's own.

Everything is reduced to `Conv` records with a short, secret-redacted excerpt. Full transcripts
are never stored and never sent to a model.
"""

from __future__ import annotations

import html
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
    turns: list[tuple[str, str]] = field(default_factory=list)   # (user|assistant|aside, text); aside: the agent thinking aloud
    project: str | None = None
    model: str | None = None                                     # the model that answered most (when the store says)
    stamps: list[datetime | None] = field(default_factory=list)  # when each turn was said, alongside turns (when the store says)
    extras: list[dict] = field(default_factory=list)             # alongside turns: an answer's "how" (steps, time, tokens), your "images"

    @property
    def message_count(self) -> int:
        return sum(1 for r, _ in self.turns if r != "aside")

    def spans(self, gap_s: float = 2 * 3600) -> list[list] | None:
        """When the conversation was actually going on: [start, end, turns] for each stretch of back-and-forth
        (a pause longer than `gap_s` starts a new one), or None when the store keeps no times per turn."""
        times = sorted(t for (r, _), t in zip(self.turns, self.stamps) if t is not None and r != "aside") if len(self.stamps) == len(self.turns) else []
        if not times:
            return None
        out: list[list] = []
        for t in times:
            if out and (t - out[-1][1]).total_seconds() <= gap_s:
                out[-1][1], out[-1][2] = t, out[-1][2] + 1
            else:
                out.append([t, t, 1])
        return [[a.isoformat(), b.isoformat(), n] for a, b, n in out]


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


_NOISE = re.compile(r"<(system-reminder|command-[a-z-]+|local-command-[a-z-]+|bash-[a-z-]+|ide_[a-z_]+|task-notification)>[\s\S]*?</\1>")


def clean(text: str) -> str:
    text = _NOISE.sub("", text or "")
    return re.sub(r"\n{3,}", "\n\n", text).strip()


def excerpt(turns: list[tuple[str, str]], limit: int = EXCERPT_CHARS) -> str:
    """The opening request plus the latest turns — enough to tell what the conversation was about."""
    turns = [(r, clean(t)) for r, t in turns if r != "aside" and clean(t)]
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
CODEBUDDY_DIR = Path.home() / ".codebuddy" / "projects"
WORKBUDDY_DB = Path.home() / ".workbuddy" / "workbuddy.db"
CODEX_DIRS = (Path.home() / ".codex" / "sessions", Path.home() / ".codex" / "archived_sessions")


PGA_HOME = Path.home() / "Documents" / "PGA"


def pga_started(cwd: str | None) -> bool:
    """A session PGA started itself (its workspaces, a temp folder): already in PGA's own history."""
    c = str(cwd or "")
    return bool(c) and ("/Documents/PGA/workspaces" in c or str(PGA_HOME / "workspaces") in c or "/Documents/PGA/evolution/" in c
                        or c.startswith(("/private/tmp", "/tmp", "/var/folders", "/private/var/folders")) or "pga-agent-" in c)


_PGA_SIGNS = ("[via PGA]", "on a perpetual task", "\nAsk the next questions.", "\nAnswer it.", "\nReview them.",
              "\nLook back.", "<open_questions>", "<your_task role=", "You are implementing one reviewed improvement")


def pga_made(c: "Conv") -> bool:
    """A session PGA's own agents ran (marked, or the perpetual / team prompts from before the mark): PGA has it already."""
    first = next((t for r, t in c.turns if r == "user"), "")
    return any(s in first[:20000] for s in _PGA_SIGNS) or first.lstrip().startswith("<aim>")


_REMINDER = re.compile(r"<system-reminder[^>]*>[\s\S]*?</system-reminder>")

# A Claude Code session that works a claude.ai project thread: your words arrive wrapped (<wake>, a coordinator's
# <relay>), and what you see in the thread is the session's `…__reply` tool calls, not its own running commentary.
_THREAD_WRAP = ("<wake", "<project_claude_message", "<relay")
_THREAD_SAID = re.compile(r"<(message|cited)\b([^>]*)>([\s\S]*?)</\1>")
# the harness talking, not you: resuming after a usage limit or a full context, an interrupted turn
_MACHINE = ("[auto-continue]", "[Request interrupted", "[Usage limit reached", "This session is being continued from a previous conversation")
_PGA_NOTE = re.compile(r"^\s*\[PGA note[^\]]*\]\s*")


def _thread_said(text: str, seen: set[str]) -> list[tuple[str, datetime | None]] | None:
    """Your own messages inside a project-thread wrapper (each once, with when you sent it), or None when the turn is not wrapped."""
    if not text.lstrip().startswith(_THREAD_WRAP):
        return None
    out = []
    for m in _THREAD_SAID.finditer(text):
        attrs = m.group(2)
        if not re.search(r'\bfrom="human"|\bauthor="user"', attrs):
            continue
        mid = re.search(r'(?<![\w-])id="([^"]+)"', attrs)
        if mid and mid.group(1) in seen:                  # the coordinator cites a message again
            continue
        if mid:
            seen.add(mid.group(1))
        said = html.unescape(m.group(3)).strip()
        sent = re.search(r'\b(?:sent-at|at)="([^"]+)"', attrs)
        if said:
            out.append((said, _ts(sent.group(1)) if sent else None))
    return out


def _thread_replies(content: Any) -> list[str]:
    return [str((x.get("input") or {}).get("text") or "") for x in (content if isinstance(content, list) else [])
            if isinstance(x, dict) and x.get("type") == "tool_use" and str(x.get("name", "")).endswith("__reply")]


def _cc_file(f: Path, *, skip_pga: bool = True) -> Conv | None:
    """One Claude-Code-format transcript (Claude Code, CodeBuddy, WorkBuddy): user/assistant turns, title, model.
    Like Open WebUI's importers, the turns are what you and the agent said to each other (no harness notes); like
    Claude Code itself, each answer carries how it got there: its tool calls, commentary, thinking, time and tokens."""
    from pga.hub.steps import Work, images_in, merge
    turns, stamps, title, started, updated, project, cwd = [], [], None, None, None, None, None
    extras: list[dict] = []
    models: dict[str, int] = {}
    seen: set[str] = set()
    in_thread = False                                     # answering a project thread: its replies are the agent's turns
    work, last_ts = Work(), None

    def add(role: str, text: str, when: datetime | None, extra: dict | None = None) -> None:
        turns.append((role, text))
        stamps.append(when)
        extras.append({k: v for k, v in (extra or {}).items() if v})

    def settle() -> None:                                 # work after the round's last answer is part of that answer
        if work.pending and turns and turns[-1][0] == "assistant":
            extras[-1]["how"] = merge(extras[-1].get("how"), work.take(last_ts))

    try:
        lines = f.read_text(encoding="utf-8", errors="replace").splitlines()
    except OSError:
        return None
    for i, ln in enumerate(lines):
        try:
            e = json.loads(ln)
        except json.JSONDecodeError:
            continue
        if not isinstance(e, dict):
            continue
        if e.get("type") == "summary" and e.get("summary"):
            title = title or str(e["summary"])
            continue
        if e.get("type") == "message" and e.get("role") in ("user", "assistant"):          # CodeBuddy / WorkBuddy 2.x
            role, msg = e["role"], {"content": e.get("content"), "model": (e.get("providerData") or {}).get("model")}
        elif (e.get("type") in ("user", "assistant") and not e.get("isMeta") and not e.get("isSidechain")
              and not e.get("isCompactSummary")):                                          # Claude Code
            role, msg = e["type"], e.get("message") or {}
        else:
            cwd = cwd or e.get("cwd")
            if e.get("isMeta") and _text((e.get("message") or {}).get("content")).lstrip().startswith(_THREAD_WRAP):
                in_thread = True                          # a coordinator handing the session a project thread
            continue
        ts = _ts(e.get("timestamp"))
        started, updated = started or ts, ts or updated
        cwd = cwd or e.get("cwd")
        project = project or (Path(e["cwd"]).name if e.get("cwd") else None)
        content = msg.get("content") if isinstance(msg, dict) else msg
        if role == "assistant" and isinstance(msg, dict) and msg.get("model") and not str(msg["model"]).startswith("<"):
            models[str(msg["model"])] = models.get(str(msg["model"]), 0) + 1
        if e.get("type") in ("user", "assistant"):
            work.feed(e, i)
        last_ts = ts or last_ts
        text = clean(_REMINDER.sub("", _text(content)))
        if role == "user":
            imgs = images_in(content, i)
            if (not text and not imgs) or text.lstrip().startswith(_MACHINE):
                continue
            said = _thread_said(text, seen)
            if said is not None:
                in_thread = True
            else:
                in_thread = False                         # you are talking to the session directly again (e.g. through PGA)
                said = [(_PGA_NOTE.sub("", text) or "🖼", None)]
            if said:
                settle()
            for k, (t, sent) in enumerate(said):
                if t:
                    add("user", t, sent or ts, {"images": imgs if k == 0 else None})
            if said:
                work.start(ts, keep=work.pending)
            continue
        if in_thread:                                     # its commentary goes into the process, then what it told you
            if text:
                work.note(text, ts)
            for t in _thread_replies(content):
                if t.strip():
                    add("assistant", t.strip(), ts, {"how": work.take(ts) if work.pending else None})
        elif text:
            add(role, text, ts, {"how": work.take(ts) if role == "assistant" and work.pending else None})
    settle()
    if not turns or (skip_pga and pga_started(cwd)):
        return None
    if seen and all(stamps):                              # a thread message can reach the session after it already answered:
        order = sorted(range(len(turns)), key=lambda i: stamps[i])   # put each turn at the time it was said
        turns, stamps, extras = [turns[i] for i in order], [stamps[i] for i in order], [extras[i] for i in order]
        started = min(started, stamps[0]) if started else stamps[0]
    first_user = next((t for r, t in turns if r == "user" and not t.lstrip().startswith("<")), "") or next((t for r, t in turns if r == "user"), "")
    return Conv(f.stem, (title or " ".join(first_user.split())[:90]), started, updated, turns,
                project or f.parent.name.strip("-").split("-")[-1], max(models, key=models.get) if models else None, stamps, extras)


def claude_code_sessions(root: Path = CLAUDE_CODE_DIR) -> list[Conv]:
    return [c for c in (_cc_file(f) for f in sorted(root.glob("*/*.jsonl"))) if c]


def codebuddy_sessions(root: Path = CODEBUDDY_DIR) -> list[Conv]:
    return [c for c in (_cc_file(f) for f in sorted(root.glob("*/*.jsonl"))) if c]


def workbuddy_sessions(db: Path = WORKBUDDY_DB) -> list[Conv]:
    """The WorkBuddy app: its session list (title, model) and each session's transcript."""
    files = {f.stem: f for f in (db.parent / "projects").glob("*/*.jsonl")}
    con = sqlite3.connect(f"file:{db}?mode=ro", uri=True, timeout=5)
    try:
        rows = con.execute("select id, coalesce(custom_title, title, ''), model, created_at, coalesce(last_activity_at, updated_at), cwd "
                           "from sessions where coalesce(deleted_at, -1) <= 0 order by created_at").fetchall()
    finally:
        con.close()
    out = []
    for sid, title, model, created, last, cwd in rows:
        f = files.get(str(sid))
        c = _cc_file(f, skip_pga=False) if f else None
        if c is None:
            continue
        c.external_id, c.title = str(sid), title or c.title
        c.started_at, c.updated_at = _ts(created) or c.started_at, _ts(last) or c.updated_at
        c.model = c.model or model                     # the transcript's model; the app's mode name only as a fallback
        c.project = Path(cwd).name if cwd else c.project
        out.append(c)
    return out


_CODEX_PREAMBLE = ("# AGENTS.md instructions", "<environment_context>", "<user_instructions>", "<app-context>", "<permissions",
                   "<turn_aborted>", "<user_shell_command>")


def codex_sessions(roots: tuple[Path, ...] = CODEX_DIRS) -> list[Conv]:
    """ChatGPT / Codex threads (the desktop app and the CLI); the instruction preamble is not a message."""
    return [c for c in (_codex_file(f) for f in sorted(p for r in roots for p in r.glob("**/*.jsonl"))) if c]


def _codex_file(f: Path, *, skip_pga: bool = True) -> Conv | None:
    """One Codex rollout: your messages and its answers, each answer with its tool calls (scripts, functions, shell,
    patches), reasoning summaries, time and tokens."""
    from pga.hub.steps import Work, merge
    turns, stamps, extras, started, updated, cwd, origin, sid = [], [], [], None, None, None, "", f.stem
    models: dict[str, int] = {}
    work, last_ts = Work(), None
    try:
        fh = f.open(encoding="utf-8", errors="replace")
    except OSError:
        return None
    with fh:
        for i, ln in enumerate(fh):
            try:
                e = json.loads(ln)
            except json.JSONDecodeError:
                continue
            if not isinstance(e, dict):
                continue
            p = e.get("payload") or {}
            ts = _ts(e.get("timestamp"))
            if e.get("type") == "session_meta":
                sid, cwd, origin = str(p.get("id") or sid), p.get("cwd"), str(p.get("originator") or "")
                started = started or _ts(p.get("timestamp")) or ts
                continue
            if e.get("type") == "turn_context" and p.get("model"):
                models[str(p["model"])] = models.get(str(p["model"]), 0) + 1
            work.feed_codex(e, i)
            last_ts = ts or last_ts
            if e.get("type") == "response_item" and p.get("type") == "message" and p.get("role") in ("user", "assistant"):
                text = clean(_text(p.get("content")))
                if not text or (p["role"] == "user" and (text.lstrip().startswith(_CODEX_PREAMBLE) or text.lstrip().startswith("<external_"))):
                    continue                                       # instructions and the app's own internal messages
                if p["role"] == "user":
                    if work.pending and turns and turns[-1][0] == "assistant":
                        extras[-1]["how"] = merge(extras[-1].get("how"), work.take(last_ts))
                    turns.append(("user", text))
                    stamps.append(ts)
                    extras.append({})
                    work.start(ts, keep=work.pending)
                else:
                    how = work.take(ts) if work.pending else None
                    if how is not None and models:
                        how["model"] = max(models, key=models.get)
                    turns.append(("assistant", text))
                    stamps.append(ts)
                    extras.append({"how": how} if how else {})
                updated = ts or updated
    if work.pending and turns and turns[-1][0] == "assistant":
        extras[-1]["how"] = merge(extras[-1].get("how"), work.take(last_ts))
    if not turns or (skip_pga and (pga_started(cwd) or origin.lower() == "pga")):
        return None
    first_user = next((t for r, t in turns if r == "user" and not t.lstrip().startswith("<")), "") or next((t for r, t in turns if r == "user"), "")
    return Conv(sid, " ".join(first_user.split())[:90], started, updated or started, turns,
                Path(cwd).name if cwd else None, max(models, key=models.get) if models else None, stamps, extras)


def hermes_sessions(db: Path = HERMES_DB) -> list[Conv]:
    from pga.hub.steps import Work
    con = sqlite3.connect(f"file:{db}?mode=ro", uri=True, timeout=5)
    try:
        cols = {r[1] for r in con.execute("pragma table_info(sessions)")}
        mcols = {r[1] for r in con.execute("pragma table_info(messages)")}
        title_expr = "coalesce(title, display_name, '')" if "title" in cols else "coalesce(display_name, '')"
        last_expr = "coalesce(last_activity_at, ended_at, started_at)" if "last_activity_at" in cols else "coalesce(ended_at, started_at)"
        where = "where coalesce(hidden, 0) = 0" if "hidden" in cols else ""
        model_expr = "coalesce(model, '')" if "model" in cols else "''"
        opt = lambda c: c if c in mcols else "null"                     # older Hermes: no tool columns
        sessions = con.execute(f"select id, {title_expr}, started_at, {last_expr}, coalesce(cwd, ''), {model_expr} from sessions {where} "
                               f"order by started_at").fetchall()
        out = []
        for sid, title, started, last, cwd, model in sessions:
            rows = con.execute(f"select id, role, content, {opt('tool_calls')}, {opt('tool_call_id')}, {opt('reasoning')}, timestamp from messages "
                               "where session_id = ? and role in ('user','assistant','tool') and coalesce(active, 1) = 1 order by timestamp, id",
                               (sid,)).fetchall()
            turns, stamps, extras, work = [], [], [], Work()
            for mid, role, content, calls, call_id, reasoning, at in rows:
                ts = _ts(at)
                work.tick(ts)
                if role == "tool":                                  # a tool came back
                    work.result(str(call_id or ""), str(mid), ts)
                    continue
                if role == "user":
                    if content and content.strip():
                        turns.append(("user", content))
                        stamps.append(ts)
                        extras.append({})
                        work.start(ts, keep=work.pending)
                    continue
                work.think(reasoning or "", ts)
                tc = []
                try:
                    tc = json.loads(calls) if calls else []
                except (json.JSONDecodeError, TypeError):
                    tc = []
                if isinstance(tc, list) and tc:                     # it calls tools: its words so far are commentary
                    work.note(content or "", ts)
                    for k, c in enumerate(tc):
                        fn = (c or {}).get("function") or {} if isinstance(c, dict) else {}
                        from pga.hub.steps import _args
                        work.tool(str(fn.get("name") or ""), _args(fn.get("arguments")), f"{mid}.{k}", ts, str((c or {}).get("id") or ""))
                    continue
                if content and content.strip():
                    how = work.take(ts) if work.pending else None
                    turns.append(("assistant", content))
                    stamps.append(ts)
                    extras.append({"how": how} if how else {})
            if not turns or pga_started(cwd):
                continue
            first_user = next((t for r, t in turns if r == "user"), "")
            out.append(Conv(str(sid), title or " ".join(first_user.split())[:90], _ts(started), _ts(last), turns,
                            Path(cwd).name if cwd else None, model or None, stamps, extras))
        return out
    finally:
        con.close()


LOCAL_CONNECTORS = {
    "claude_code": {"vendor": "claude_code", "name": "Claude Code", "path": CLAUDE_CODE_DIR, "read": claude_code_sessions},
    "hermes": {"vendor": "hermes", "name": "Hermes Agent", "path": HERMES_DB, "read": hermes_sessions},
    "codex": {"vendor": "chatgpt", "name": "ChatGPT · Codex", "path": CODEX_DIRS[0], "read": codex_sessions},
    "workbuddy": {"vendor": "workbuddy", "name": "WorkBuddy", "path": WORKBUDDY_DB, "read": workbuddy_sessions},
    "codebuddy": {"vendor": "workbuddy", "name": "CodeBuddy CLI", "path": CODEBUDDY_DIR, "read": codebuddy_sessions},
}


def detect_local() -> list[dict]:
    """Which local agents exist on this machine, and roughly how much history each has."""
    found = []
    for key, c in LOCAL_CONNECTORS.items():
        p: Path = c["path"]
        if not p.exists():
            continue
        try:
            if key in ("claude_code", "codebuddy"):
                count = sum(1 for _ in p.glob("*/*.jsonl"))
            elif key == "codex":
                count = sum(1 for r in CODEX_DIRS for _ in r.glob("**/*.jsonl"))
            elif key == "workbuddy":
                con = sqlite3.connect(f"file:{p}?mode=ro", uri=True, timeout=5)
                try:
                    count = con.execute("select count(*) from sessions where coalesce(deleted_at, -1) <= 0").fetchone()[0]
                finally:
                    con.close()
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


def read_one(connector: str, external_id: str) -> Conv | None:
    """One conversation in full, read again from its own store (PGA keeps only excerpts)."""
    eid = re.sub(r"[^\w.\-]", "", external_id)[:200]
    if not eid:
        return None
    if connector in ("claude_code", "codebuddy"):
        root = CLAUDE_CODE_DIR if connector == "claude_code" else CODEBUDDY_DIR
        f = next(iter(root.glob(f"*/{eid}.jsonl")), None)
        return _cc_file(f, skip_pga=False) if f else None
    if connector == "workbuddy":
        return next((c for c in workbuddy_sessions() if c.external_id == eid), None)
    if connector == "codex":
        f = next((p for r in CODEX_DIRS for p in r.glob(f"**/*{eid}*.jsonl")), None)
        return _codex_file(f, skip_pga=False) if f else None             # that one thread, not the first of its folder
    if connector == "hermes":
        return next((c for c in hermes_sessions() if c.external_id == eid), None)
    return None


LOCAL_FULL = ("claude_code", "codebuddy", "workbuddy", "codex", "hermes")


def full_turns(connector: str, external_id: str, limit: int = 2000) -> list[dict]:
    """The whole conversation from its own app, secrets redacted, each turn with when it was said (Open WebUI keeps
    every message of an import, not an excerpt); [] when the app does not keep it here."""
    full = read_one(connector, external_id) if connector in LOCAL_FULL else None
    if not full:
        return []
    n = len(full.turns)
    stamps = full.stamps if len(full.stamps) == n else [None] * n
    extras = full.extras if len(full.extras) == n else [{}] * n
    return [{"role": r, "text": redact(t)[:20000], **({"at": s.isoformat()} if s else {}),
             **({"how": redact_how(x["how"])} if x.get("how") else {}), **({"images": x["images"]} if x.get("images") else {})}
            for (r, t), s, x in zip(full.turns, stamps, extras)][-limit:]


def redact_how(how: dict) -> dict:
    """An answer's process as it goes to the page: no secrets in step titles, commentary or thinking."""
    steps = [{**st, **({"title": redact(st["title"])} if st.get("title") else {}), **({"text": redact(st["text"])} if st.get("text") else {})}
             for st in how.get("steps") or []]
    return {**how, "steps": steps}


def read_local(connector: str) -> list[Conv]:
    c = LOCAL_CONNECTORS.get(connector)
    if c is None:
        raise ImportError_(f"unknown local connector {connector!r}")
    return read_local_split(connector)[0]


def read_local_split(connector: str) -> tuple[list[Conv], set[str]]:
    """Your sessions, and the ids of the sessions PGA's own agents ran (left out)."""
    c = LOCAL_CONNECTORS.get(connector)
    if c is None:
        raise ImportError_(f"unknown local connector {connector!r}")
    mine, own = [], set()
    for x in c["read"]():
        if pga_made(x):
            own.add(x.external_id)
        else:
            mine.append(x)
    return mine, own


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
