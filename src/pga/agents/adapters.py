"""Adapters: how each kind of agent is reached.

Local CLIs run non-interactively inside the task's workspace, with permissions mapped onto each tool's own
safety switches (never their "dangerously bypass" modes):

    claude_local   Claude Code   `claude -p --output-format json`      read_only: Read/Glob/Grep/Web*  · write: +Edit/Write, no Bash
    codex_local    Codex CLI     `codex exec --json -s <sandbox>`      read_only: -s read-only        · write: -s workspace-write
    hermes_local   Hermes Agent  `hermes chat --query-file - -Q`       dangerous commands stay behind Hermes' approval (never --yolo)
    gemini_local   Gemini CLI    `gemini -p`
    opencode_local OpenCode      `opencode run`
    process        any command: the prompt arrives on stdin, the answer is stdout
    http           any webhook: POST {"task": …} → {"text": …, "data": …}
    llm            PGA's own configured model (Settings → 模型与 API), at a tier

Where an agent offers something more direct, `links.py` uses it first and these commands are the fallback: Codex runs
in its app server, a conversation with Claude Code / CodeBuddy stays in one running session, Hermes is reached
through its local API server, and Claude through the Anthropic API when a working key is set.
"""

from __future__ import annotations

import json
import os
import queue
import shlex
import shutil
import subprocess
import tempfile
import threading
import time
from functools import lru_cache
from pathlib import Path
from typing import Any

from pga.agents.base import FULL, READ_ONLY, WORKSPACE_WRITE, Adapter, AgentError, AgentResult, AgentTask


@lru_cache(maxsize=32)
def _version(binary: str) -> str:
    try:
        out = subprocess.run([binary, "--version"], capture_output=True, text=True, timeout=8)
        return (out.stdout or out.stderr).strip().splitlines()[0][:80] if (out.stdout or out.stderr).strip() else ""
    except (OSError, subprocess.SubprocessError):
        return ""


def _prompt(task: AgentTask) -> str:
    parts = [task.system.strip()] if task.system.strip() else []
    parts.append(task.prompt.strip())
    if task.meta.get("images"):                       # a one-off CLI reads the pictures from disk itself
        parts.append("The user attached image(s); look at them before answering:\n" + "\n".join(f"- {p}" for p in task.meta["images"]))
    if task.want_json:
        parts.append("Reply with JSON only.")
    return "\n\n".join(parts)


class CLIAdapter(Adapter):
    """A local command-line agent."""
    binary = ""
    strip_env: tuple[str, ...] = ()
    secrets: tuple[str, ...] = ()           # read from pga/.env (Settings), passed to the CLI, never shown or logged

    def secret_map(self) -> dict[str, str]:
        """Env var the CLI reads → the key it is stored under in pga/.env. A second copy of an agent (claude-2) keeps its
        own token under its own key (`secret_keys`), and the CLI still gets it under the name it expects."""
        names = list(self.secrets) + [str(x) for x in (self.config.get("secret_env") or [])]
        alias = self.config.get("secret_keys") or {}
        return {n: str(alias.get(n) or n) for n in names}

    def secret_names(self) -> list[str]:
        """The keys you can set for this agent (Settings / its card): its CLI tokens, and its API key if it has one."""
        api = (self.config.get("api") or {}).get("key_env")
        return list(dict.fromkeys([*self.secret_map().values(), *([str(api)] if api else [])]))

    def secrets_set(self) -> dict[str, bool]:
        from pga.llm.catalog import get_key
        return {n: bool(get_key(n)) for n in self.secret_names()}

    def exe(self) -> str | None:
        b = self.config.get("command") or self.binary
        return shutil.which(b) or (b if os.path.isabs(b) and os.path.exists(b) else None)

    def available(self) -> tuple[bool, str]:
        exe = self.exe()
        if not exe:
            return False, f"{self.config.get('command') or self.binary} not found on PATH"
        return True, _version(exe) or exe

    def command(self, task: AgentTask, exe: str) -> list[str]:
        raise NotImplementedError

    def parse(self, stdout: str, stderr: str, task: AgentTask) -> AgentResult:
        return AgentResult(ok=True, text=stdout.strip())

    def progress(self, line: str, task: AgentTask) -> str | None:
        """What a line of output means to someone watching (shown live beside the planet). Plain text by default."""
        return line

    def env(self) -> dict[str, str]:
        env = {k: v for k, v in os.environ.items() if k not in self.strip_env}
        env.update({k: str(v) for k, v in (self.config.get("env") or {}).items()})
        from pga.llm.catalog import get_key
        for name, stored in self.secret_map().items():          # never the API key: the CLI would bill it instead
            if get_key(stored):
                env[name] = get_key(stored)
        return env

    def linked(self) -> bool:
        """Use the richer link (app server, session, API) unless the agent is set to `connect: cli`."""
        return str(self.config.get("connect", "auto")) != "cli"

    def _run(self, task: AgentTask) -> AgentResult:
        exe = self.exe()
        if not exe:
            raise AgentError(f"{self.binary} is not installed")
        env = self.env()
        cwd = task.workspace or tempfile.mkdtemp(prefix="pga-agent-")
        from pga.agents import live
        lid = task.meta.get("live_id")
        # stream: read stdout line by line so the constellation can show the agent's words as they come
        p = subprocess.Popen(self.command(task, exe), stdin=subprocess.PIPE, stdout=subprocess.PIPE, stderr=subprocess.PIPE,
                             text=True, env=env, cwd=cwd, bufsize=1)
        lines: queue.Queue = queue.Queue()
        err: list[str] = []

        def feed() -> None:
            try:
                p.stdin.write(self.stdin(task))
                p.stdin.close()
            except (BrokenPipeError, OSError):
                pass
        threading.Thread(target=feed, daemon=True).start()
        threading.Thread(target=lambda: err.append(p.stderr.read()), daemon=True).start()
        threading.Thread(target=lambda: ([lines.put(x) for x in p.stdout], lines.put(None)), daemon=True).start()
        out: list[str] = []
        deadline = time.monotonic() + task.timeout_s
        while True:
            left = deadline - time.monotonic()
            if left <= 0:
                p.kill()
                live.append(lid, f"\n（{task.timeout_s:.0f} 秒内没有完成）")
                return AgentResult(ok=False, status="TIMEOUT", error=f"no answer within {task.timeout_s:.0f}s")
            if live.stopped(lid):                              # you pressed stop: keep what it said so far
                p.kill()
                return AgentResult(ok=bool(live.text(lid).strip()), text=live.text(lid).strip(), status="STOPPED", error=None if live.text(lid).strip() else "你停止了生成", data={"stopped": True})
            try:
                line = lines.get(timeout=min(left, 0.5))
            except queue.Empty:
                continue
            if line is None:
                break
            out.append(line)
            try:
                shown = self.progress(line, task)
            except Exception:  # noqa: BLE001 - a display hiccup must not fail the run
                shown = None
            if shown:
                live.append(lid, shown[1:] if shown.startswith(RAW) else shown if shown.endswith("\n") else shown + "\n")
        try:
            p.wait(timeout=15)
        except subprocess.TimeoutExpired:
            p.kill()
        time.sleep(0.05)
        stdout, stderr = "".join(out), "".join(err)
        res = self.parse(stdout, stderr, task)
        if p.returncode != 0 and res.ok and not res.text:
            res.ok, res.status = False, "FAILED"
        if p.returncode != 0 and not res.ok and not res.error:
            res.error = (stderr + stdout)[-800:].strip() or f"exit code {p.returncode}"
        return res

    def stdin(self, task: AgentTask) -> str:
        return _prompt(task)


class ClaudeLocal(CLIAdapter):
    type, binary = "claude_local", "claude"
    strip_env = ("ANTHROPIC_API_KEY", "ANTHROPIC_AUTH_TOKEN")      # use the Claude subscription, not API billing
    # a background service cannot read the CLI's keychain login: `claude setup-token` makes a token for it
    secrets = ("CLAUDE_CODE_OAUTH_TOKEN",)

    def command(self, task: AgentTask, exe: str) -> list[str]:
        cmd = [exe, "-p", "--output-format", "stream-json", "--verbose", "--include-partial-messages", "--max-turns", str(task.max_turns),
               "--no-session-persistence"]
        if task.permissions == FULL:                  # a project you opened up: like Claude Code in your terminal, edits accepted
            return cmd + ["--permission-mode", "acceptEdits", "--allowedTools",
                          "Bash,Read,Edit,Write,MultiEdit,Glob,Grep,LS,WebSearch,WebFetch,NotebookEdit,Task,TodoWrite"] + self.choice_flags(task)
        cmd.append("--strict-mcp-config")
        if task.permissions == WORKSPACE_WRITE:
            cmd += ["--permission-mode", "acceptEdits", "--allowedTools", "Read,Edit,Write,Glob,Grep",
                    "--disallowedTools", "Bash,WebFetch,WebSearch,NotebookEdit"]
        else:
            cmd += ["--permission-mode", "default", "--allowedTools", "Read,Glob,Grep,WebSearch,WebFetch",
                    "--disallowedTools", "Bash,Edit,Write,NotebookEdit"]
        return cmd + self.choice_flags(task)

    def choice_flags(self, task: AgentTask) -> list[str]:
        """The model and effort chosen for this question (or the agent's own), as CLI flags."""
        model, effort = task.meta.get("model") or self.config.get("model"), task.meta.get("effort") or self.config.get("effort")
        return (["--model", str(model)] if model else []) + (["--effort", str(effort)] if effort else [])

    def stdin(self, task: AgentTask) -> str:
        return _prompt(task)

    def session_command(self, task: AgentTask, exe: str, resume: str | None) -> list[str]:
        """The same command kept running: one user message per stdin line, a `result` event after each."""
        cmd = [c for c in self.command(task, exe) if c != "--no-session-persistence"] + ["--input-format", "stream-json"]
        return cmd + (["--resume", resume] if resume else [])

    def _run(self, task: AgentTask) -> AgentResult:
        from pga.agents import links
        if self.linked() and task.permissions == READ_ONLY and not task.meta.get("project") and self.config.get("api") and links.api_ok(self.name):
            try:
                return links.api_chat(self, task)
            except links.LinkDown as exc:
                from pga.agents import live
                live.append(task.meta.get("live_id"), f"（API 不可用：{exc}，改用命令行）\n")
        if self.linked() and task.meta.get("conversation"):
            try:
                return links.StreamSession.ask(self, task)
            except links.LinkDown:
                pass
        return super()._run(task)

    def progress(self, line: str, task: AgentTask) -> str | None:
        return _stream_json_progress(line, task)

    def parse(self, stdout: str, stderr: str, task: AgentTask) -> AgentResult:
        d, said, model = None, [], None
        for line in stdout.splitlines():                       # stream-json: the last "result" event is the answer
            try:
                ev = json.loads(line)
            except json.JSONDecodeError:
                continue
            if isinstance(ev, dict) and ev.get("type") == "system" and ev.get("model"):
                model = str(ev["model"])                       # the model that actually answers
            if isinstance(ev, dict) and ev.get("type") == "result":
                d = ev
            elif isinstance(ev, dict) and ev.get("type") == "assistant":
                said += [b.get("text", "") for b in (ev.get("message") or {}).get("content") or [] if isinstance(b, dict) and b.get("type") == "text"]
        if d is None:
            try:
                d = json.loads(stdout or "{}")                   # a single JSON object (older CLIs)
            except json.JSONDecodeError:
                d = None
        if not isinstance(d, dict) or not d:
            text = "\n".join(x for x in said if x).strip() or stdout.strip()[-20000:]
            return AgentResult(ok=bool(text), text=text, error=None if text else stderr[-500:])
        text = str(d.get("result") or "")
        ok = not d.get("is_error") and d.get("subtype", "success") == "success"
        why = (text or "; ".join(str(e) for e in d.get("errors") or [] if e)          # the reason, not just "error_during_execution"
               or "\n".join(x for x in said if x).strip() or d.get("subtype") or "error")
        if not model and isinstance(d.get("modelUsage"), dict) and d["modelUsage"]:
            model = max(d["modelUsage"].items(), key=lambda kv: (kv[1] or {}).get("outputTokens", 0) if isinstance(kv[1], dict) else 0)[0]
        # the CLI reports an API-equivalent cost even on a subscription login (PGA strips API keys from its env), so it is
        # kept as information only: it is not money spent and must not count toward the daily cost cap
        return AgentResult(ok=ok, text=text, status="SUCCEEDED" if ok else "FAILED", cost_usd=None,
                           session_id=d.get("session_id"), error=None if ok else why[:500], model=model,
                           data={"turns": d.get("num_turns"), "notional_cost_usd": d.get("total_cost_usd"),
                                 **({"effort": task.meta.get("effort")} if task.meta.get("effort") else {})})


class CodebuddyLocal(ClaudeLocal):
    """WorkBuddy's bundled CodeBuddy CLI: same print-mode contract as Claude Code. Office work writes its files
    (documents, tables, slides as Markdown/CSV/HTML) into the task's own workspace; no shell."""
    type, binary = "codebuddy_local", "codebuddy"
    strip_env = ()
    secrets = ("CODEBUDDY_API_KEY",)

    def command(self, task: AgentTask, exe: str) -> list[str]:
        cmd = [exe, "-p", "--output-format", "stream-json", "--verbose", "--max-turns", str(task.max_turns),
               "--no-session-persistence"]
        if task.permissions == FULL:
            return cmd + ["--permission-mode", "acceptEdits", "--tools", "Read,Write,Edit,Bash,Glob,Grep,WebSearch,WebFetch"] + self.choice_flags(task)
        cmd.append("--strict-mcp-config")
        if task.permissions == WORKSPACE_WRITE:
            cmd += ["--permission-mode", "acceptEdits", "--tools", "Read,Write,Edit,Glob,Grep,WebSearch,WebFetch"]
        else:
            cmd += ["--permission-mode", "default", "--tools", "Read,Glob,Grep,WebSearch,WebFetch"]
        return cmd + self.choice_flags(task)

    LOGIN = "WorkBuddy CLI 未登录或登录已过期：在终端运行一次 codebuddy 并输入 /login，或在设置里填 CODEBUDDY_API_KEY"

    def parse(self, stdout: str, stderr: str, task: AgentTask) -> AgentResult:
        if not stdout.strip() and "Authentication required" in stderr:
            return AgentResult(ok=False, status="FAILED", error=self.LOGIN)
        r = super().parse(stdout, stderr, task)
        if not r.ok and "Authentication required" in (r.error or ""):   # newer CLIs report it inside the stream
            r.error = self.LOGIN
        return r


class CodexLocal(CLIAdapter):
    type, binary = "codex_local", "codex"

    def server_command(self, full: bool = False) -> list[str]:
        cmd = [self.exe() or self.binary, "app-server"]
        for feature in self.config.get("disable") or []:
            if full and feature == "shell_tool":
                continue
            cmd += ["--disable", str(feature)]
        return cmd

    def _run(self, task: AgentTask) -> AgentResult:
        from pga.agents import links
        if self.linked():
            try:
                srv = links.CodexServer.get(self, full=task.permissions == FULL)
            except links.LinkDown:
                srv = None                                     # cannot start the app server: one-off `codex exec`
            if srv is not None:
                try:
                    return srv.turn(self, task)
                except links.LinkDown as exc:                  # the thread or turn never started: same work, one-off
                    from pga.agents import live
                    live.append(task.meta.get("live_id"), f"（app-server：{exc}，改用 codex exec）\n")
        return super()._run(task)

    def command(self, task: AgentTask, exe: str) -> list[str]:
        task.meta["_codex_out"] = out = os.path.join(task.workspace or tempfile.gettempdir(), f".codex-last-{os.getpid()}-{id(task)}.txt")
        sandbox = "workspace-write" if task.permissions in (WORKSPACE_WRITE, FULL) else "read-only"
        cmd = [exe, "exec", "--json", "--skip-git-repo-check", "--ephemeral", "-s", sandbox, "-o", out]
        if task.workspace:
            cmd += ["-C", task.workspace]
        if self.config.get("model"):
            cmd += ["-m", str(self.config["model"])]
        if self.config.get("reasoning"):                       # model_reasoning_effort: minimal | low | medium | high
            cmd += ["-c", f'model_reasoning_effort="{self.config["reasoning"]}"']
        for feature in self.config.get("disable") or []:       # e.g. memories (no reading ~/.codex/memories), shell_tool
            if task.permissions == FULL and feature == "shell_tool":
                continue                                         # a project you opened up: it may run commands there
            cmd += ["--disable", str(feature)]
        return cmd + ["-"]

    def progress(self, line: str, task: AgentTask) -> str | None:
        try:
            ev = json.loads(line)
        except json.JSONDecodeError:
            return None
        item = ev.get("item") if isinstance(ev, dict) else None
        if ev.get("type") == "item.completed" and isinstance(item, dict):
            kind = item.get("type") or item.get("item_type")
            if kind in ("agent_message", "assistant_message"):
                return str(item.get("text") or "")
            if kind == "reasoning":
                return "（思考）" + str(item.get("text") or item.get("summary") or "")[:400]
            if kind in ("command_execution", "local_shell_call"):
                return "$ " + str(item.get("command") or "")[:200]
            if kind == "web_search":
                return "（搜索）" + str(item.get("query") or "")[:200]
        if ev.get("type") in ("error", "turn.failed"):
            return "错误：" + str(ev.get("message") or ev.get("error") or "")[:300]
        return None

    def parse(self, stdout: str, stderr: str, task: AgentTask) -> AgentResult:
        text = ""
        try:
            out = Path(task.meta.get("_codex_out", ""))
            text = out.read_text(encoding="utf-8").strip()
            out.unlink(missing_ok=True)
        except OSError:
            pass
        usage, err = None, None
        for line in stdout.splitlines():
            try:
                ev = json.loads(line)
            except json.JSONDecodeError:
                continue
            if isinstance(ev, dict):
                usage = ev.get("usage") or usage
                if ev.get("type") in ("error", "turn.failed"):
                    err = str(ev.get("message") or ev.get("error") or ev)[:500]
        return AgentResult(ok=bool(text) and not err, text=text, error=err, status="SUCCEEDED" if text and not err else "FAILED",
                           data={"usage": usage} if usage else {})


RAW = "\x00"                                  # a progress piece to append as it is (a token stream), not as a line


def _stream_json_progress(line: str, task: AgentTask | None = None) -> str | None:
    """Claude Code / CodeBuddy stream-json: the assistant's words (token by token with --include-partial-messages),
    and a short note for each tool it uses."""
    try:
        ev = json.loads(line)
    except json.JSONDecodeError:
        return None
    if isinstance(ev, dict) and ev.get("type") == "stream_event":
        e = ev.get("event") or {}
        d = e.get("delta") or {}
        if e.get("type") == "content_block_delta" and d.get("type") == "text_delta" and d.get("text"):
            if task is not None:
                task.meta["_streamed"] = True
            return RAW + d["text"]
        if e.get("type") == "message_stop" and task is not None and task.meta.get("_streamed"):
            return RAW + "\n"
        return None
    if not isinstance(ev, dict) or ev.get("type") != "assistant":
        return None
    out = []
    streamed = bool(task is not None and task.meta.get("_streamed"))   # the words already came token by token
    for b in (ev.get("message") or {}).get("content") or []:
        if not isinstance(b, dict):
            continue
        if b.get("type") == "text" and b.get("text") and not streamed:
            out.append(b["text"])
        elif b.get("type") == "tool_use":
            arg = b.get("input") or {}
            hint = arg.get("file_path") or arg.get("pattern") or arg.get("query") or arg.get("url") or ""
            out.append(f"→ {b.get('name')} {str(hint)[:120]}".rstrip())
    return "\n".join(out) or None


class HermesLocal(CLIAdapter):
    type, binary = "hermes_local", "hermes"
    secrets = ("HERMES_API_SERVER_KEY",)        # the key of Hermes' local API server (its API_SERVER_KEY)

    def _run(self, task: AgentTask) -> AgentResult:
        from pga.agents import links
        if self.linked() and task.permissions == READ_ONLY and not task.meta.get("project"):
            api = links.HermesApi.of(self.config)
            if api.usable():
                try:
                    return api.run(self, task)
                except links.LinkDown:
                    pass
        return super()._run(task)

    def command(self, task: AgentTask, exe: str) -> list[str]:
        cmd = [exe, "chat", "--query-file", "-", "-Q", "--max-turns", str(task.max_turns), "--run-budget", str(int(task.timeout_s))]
        if task.workspace:
            cmd += ["--in", task.workspace]
        if self.config.get("model"):
            cmd += ["-m", str(self.config["model"])]
        if self.config.get("provider"):
            cmd += ["--provider", str(self.config["provider"])]
        return cmd

    def progress(self, line: str, task: AgentTask) -> str | None:
        return None if line.lower().startswith(("session_id", "session:", "resume with")) else line

    def parse(self, stdout: str, stderr: str, task: AgentTask) -> AgentResult:
        lines = [l for l in stdout.splitlines() if not l.lower().startswith(("session_id", "session:", "resume with"))]
        text = "\n".join(lines).strip()
        return AgentResult(ok=bool(text), text=text, error=None if text else stderr[-500:])


class GeminiLocal(CLIAdapter):
    type, binary = "gemini_local", "gemini"

    def command(self, task: AgentTask, exe: str) -> list[str]:
        cmd = [exe, "-p", "Answer the request given on standard input."]
        if task.permissions != WORKSPACE_WRITE:
            cmd += ["--approval-mode", "default"]
        if self.config.get("model"):
            cmd += ["-m", str(self.config["model"])]
        return cmd


class OpencodeLocal(CLIAdapter):
    type, binary = "opencode_local", "opencode"

    def command(self, task: AgentTask, exe: str) -> list[str]:
        cmd = [exe, "run"]
        if self.config.get("model"):
            cmd += ["--model", str(self.config["model"])]
        return cmd + [_prompt(task)]

    def stdin(self, task: AgentTask) -> str:
        return ""


class Process(CLIAdapter):
    """Any program: the prompt arrives on stdin; stdout is the answer (JSON {"text", "data"} is understood too)."""
    type = "process"

    def exe(self) -> str | None:
        cmd = self.config.get("command")
        if not cmd:
            return None
        first = cmd[0] if isinstance(cmd, list) else shlex.split(str(cmd))[0]
        return shutil.which(first) or (first if os.path.exists(first) else None)

    def available(self) -> tuple[bool, str]:
        return (True, "command found") if self.exe() else (False, "command not set or not found")

    def command(self, task: AgentTask, exe: str) -> list[str]:
        cmd = self.config["command"]
        return list(cmd) if isinstance(cmd, list) else shlex.split(str(cmd))

    def parse(self, stdout: str, stderr: str, task: AgentTask) -> AgentResult:
        out = stdout.strip()
        try:
            d = json.loads(out)
            if isinstance(d, dict) and ("text" in d or "data" in d):
                return AgentResult(ok=bool(d.get("ok", True)), text=str(d.get("text") or ""), data=d.get("data") or {},
                                   error=d.get("error"))
        except json.JSONDecodeError:
            pass
        return AgentResult(ok=bool(out), text=out, error=None if out else (stderr[-500:] or "no output"))


class Http(Adapter):
    """A webhook agent: POST {"task": {...}} → {"text": "...", "data": {...}} (Paperclip's http adapter, other way round)."""
    type = "http"

    def available(self) -> tuple[bool, str]:
        url = str(self.config.get("url") or "")
        return (url.startswith(("http://", "https://")), url or "url not set")

    def _run(self, task: AgentTask) -> AgentResult:
        import httpx
        headers = {}
        if self.config.get("secret_env") and os.environ.get(self.config["secret_env"]):
            headers[self.config.get("header") or "Authorization"] = ("Bearer " if not self.config.get("header") else "") + os.environ[self.config["secret_env"]]
        body = {"task": {"prompt": task.prompt, "system": task.system, "kind": task.kind, "want_json": task.want_json,
                         "permissions": task.permissions, "meta": task.meta}}
        try:
            r = httpx.post(self.config["url"], json=body, headers=headers, timeout=task.timeout_s)
        except httpx.TimeoutException:
            return AgentResult(ok=False, status="TIMEOUT", error=f"no answer within {task.timeout_s:.0f}s")
        if r.status_code >= 400:
            raise AgentError(f"HTTP {r.status_code}: {r.text[:300]}")
        try:
            d = r.json()
        except ValueError:
            return AgentResult(ok=bool(r.text.strip()), text=r.text.strip())
        return AgentResult(ok=bool(d.get("ok", True)), text=str(d.get("text") or d.get("output") or d.get("result") or ""),
                           data=d.get("data") or {}, error=d.get("error"), cost_usd=d.get("cost_usd"))


class _Stopped(Exception):
    pass


class LLM(Adapter):
    """PGA's own model through the router. Usage is handed back to the caller to record (threads must not touch
    the database session)."""
    type = "llm"

    def __init__(self, name: str, config: dict[str, Any], rt=None):
        super().__init__(name, config)
        self.rt = rt

    def available(self) -> tuple[bool, str]:
        if self.rt is None:
            return False, "no runtime"
        return True, f"{self.rt.provider.name} · tier {int(self.config.get('tier', 2))} · {self.rt.router.model_for(int(self.config.get('tier', 2)))}"

    def _run(self, task: AgentTask) -> AgentResult:
        from pga.agents import live
        tier = int(self.config.get("tier", 2))
        chosen = str(task.meta.get("model") or "")
        model, prov = chosen or self.rt.router.model_for(tier), getattr(self.rt.router.provider, "name", "")
        who = (f"You are the model {model}" + (f" served by {prov}" if prov else "") + f", PGA's own model (agent \"{self.name}\"). "
               "If asked which model you are, say exactly that; you are not Claude, GPT or any other model.")
        system = (task.system or "You are one agent in a team working for the user. Be concrete.") + "\n\n" + who
        hist = [{"role": "user" if h.get("role") == "user" else "assistant", "content": str(h.get("text") or "")}
                for h in (task.meta.get("history") or []) if str(h.get("text") or "").strip()] if task.meta.get("new_text") else []
        while hist and hist[0]["role"] != "user":
            hist.pop(0)
        ask = task.meta.get("new_text") if hist else task.prompt
        messages = hist + [{"role": "user", "content": ask + ("\n\nReply with JSON only." if task.want_json else "")}]
        lid, provider = task.meta.get("live_id"), self.rt.router.provider
        if lid and hasattr(provider, "stream") and not task.want_json:   # the answer flows onto the live board as it is written
            def piece_in(piece: str) -> None:
                live.append(lid, piece)
                if live.stopped(lid):
                    raise _Stopped
            try:
                r = provider.stream(model=chosen or self.rt.router.model_for(tier), system=system, messages=messages,
                                    max_tokens=int(self.config.get("max_tokens", 2500)), temperature=None, on_delta=piece_in)
            except _Stopped:
                return AgentResult(ok=bool(live.text(lid).strip()), text=live.text(lid).strip(), status="STOPPED", error=None if live.text(lid).strip() else "你停止了生成", data={"stopped": True}, model=chosen or self.rt.router.model_for(tier))
            r.tier = tier
        elif chosen:
            r = provider.complete(model=chosen, system=system, messages=messages, max_tokens=int(self.config.get("max_tokens", 2500)), temperature=None)
            r.tier = tier
            live.append(lid, r.text)
        else:
            r = self.rt.router.complete(tier, system=system, messages=messages, max_tokens=int(self.config.get("max_tokens", 2500)),
                                        usage=None, delegate=False)
            live.append(lid, r.text)
        return AgentResult(ok=bool(r.text.strip()), text=r.text, model=r.model, usage=r)


ADAPTERS: dict[str, type[Adapter]] = {c.type: c for c in (ClaudeLocal, CodexLocal, HermesLocal, GeminiLocal, OpencodeLocal,
                                                           CodebuddyLocal, Process, Http, LLM)}
