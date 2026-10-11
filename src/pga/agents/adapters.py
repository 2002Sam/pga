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
"""

from __future__ import annotations

import json
import os
import shlex
import shutil
import subprocess
import tempfile
from functools import lru_cache
from pathlib import Path
from typing import Any

from pga.agents.base import READ_ONLY, WORKSPACE_WRITE, Adapter, AgentError, AgentResult, AgentTask


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
    if task.want_json:
        parts.append("Reply with JSON only.")
    return "\n\n".join(parts)


class CLIAdapter(Adapter):
    """A local command-line agent."""
    binary = ""
    strip_env: tuple[str, ...] = ()
    secrets: tuple[str, ...] = ()           # read from pga/.env (Settings), passed to the CLI, never shown or logged

    def secret_names(self) -> list[str]:
        return list(self.secrets) + [str(x) for x in (self.config.get("secret_env") or [])]

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

    def _run(self, task: AgentTask) -> AgentResult:
        exe = self.exe()
        if not exe:
            raise AgentError(f"{self.binary} is not installed")
        env = {k: v for k, v in os.environ.items() if k not in self.strip_env}
        env.update({k: str(v) for k, v in (self.config.get("env") or {}).items()})
        from pga.llm.catalog import get_key
        for name in self.secret_names():
            if get_key(name):
                env[name] = get_key(name)
        cwd = task.workspace or tempfile.mkdtemp(prefix="pga-agent-")
        try:
            p = subprocess.run(self.command(task, exe), input=self.stdin(task), capture_output=True, text=True,
                               timeout=task.timeout_s, env=env, cwd=cwd)
        except subprocess.TimeoutExpired:
            return AgentResult(ok=False, status="TIMEOUT", error=f"no answer within {task.timeout_s:.0f}s")
        res = self.parse(p.stdout or "", p.stderr or "", task)
        if p.returncode != 0 and res.ok and not res.text:
            res.ok, res.status = False, "FAILED"
        if p.returncode != 0 and not res.ok and not res.error:
            res.error = ((p.stderr or "") + (p.stdout or ""))[-800:].strip() or f"exit code {p.returncode}"
        return res

    def stdin(self, task: AgentTask) -> str:
        return _prompt(task)


class ClaudeLocal(CLIAdapter):
    type, binary = "claude_local", "claude"
    strip_env = ("ANTHROPIC_API_KEY", "ANTHROPIC_AUTH_TOKEN")      # use the Claude subscription, not API billing
    # a background service cannot read the CLI's keychain login: `claude setup-token` makes a token for it
    secrets = ("CLAUDE_CODE_OAUTH_TOKEN",)

    def command(self, task: AgentTask, exe: str) -> list[str]:
        cmd = [exe, "-p", "--output-format", "json", "--max-turns", str(task.max_turns), "--no-session-persistence",
               "--strict-mcp-config"]
        if task.permissions == WORKSPACE_WRITE:
            cmd += ["--permission-mode", "acceptEdits", "--allowedTools", "Read,Edit,Write,Glob,Grep",
                    "--disallowedTools", "Bash,WebFetch,WebSearch,NotebookEdit"]
        else:
            cmd += ["--permission-mode", "default", "--allowedTools", "Read,Glob,Grep,WebSearch,WebFetch",
                    "--disallowedTools", "Bash,Edit,Write,NotebookEdit"]
        if self.config.get("model"):
            cmd += ["--model", str(self.config["model"])]
        return cmd

    def stdin(self, task: AgentTask) -> str:
        return _prompt(task)

    def parse(self, stdout: str, stderr: str, task: AgentTask) -> AgentResult:
        try:
            d = json.loads(stdout or "{}")
        except json.JSONDecodeError:
            return AgentResult(ok=bool(stdout.strip()), text=stdout.strip()[-20000:], error=None if stdout.strip() else stderr[-500:])
        text = str(d.get("result") or "")
        ok = not d.get("is_error") and d.get("subtype", "success") == "success"
        return AgentResult(ok=ok, text=text, status="SUCCEEDED" if ok else "FAILED", cost_usd=d.get("total_cost_usd"),
                           session_id=d.get("session_id"), error=None if ok else (text or d.get("subtype") or "error")[:500],
                           data={"turns": d.get("num_turns")})


class CodexLocal(CLIAdapter):
    type, binary = "codex_local", "codex"

    def command(self, task: AgentTask, exe: str) -> list[str]:
        task.meta["_codex_out"] = out = os.path.join(task.workspace or tempfile.gettempdir(), f".codex-last-{os.getpid()}-{id(task)}.txt")
        sandbox = "workspace-write" if task.permissions == WORKSPACE_WRITE else "read-only"
        cmd = [exe, "exec", "--json", "--skip-git-repo-check", "--ephemeral", "-s", sandbox, "-o", out]
        if task.workspace:
            cmd += ["-C", task.workspace]
        if self.config.get("model"):
            cmd += ["-m", str(self.config["model"])]
        return cmd + ["-"]

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


class HermesLocal(CLIAdapter):
    type, binary = "hermes_local", "hermes"

    def command(self, task: AgentTask, exe: str) -> list[str]:
        cmd = [exe, "chat", "--query-file", "-", "-Q", "--max-turns", str(task.max_turns), "--run-budget", str(int(task.timeout_s))]
        if task.workspace:
            cmd += ["--in", task.workspace]
        if self.config.get("model"):
            cmd += ["-m", str(self.config["model"])]
        if self.config.get("provider"):
            cmd += ["--provider", str(self.config["provider"])]
        return cmd

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
        tier = int(self.config.get("tier", 2))
        r = self.rt.router.complete(tier, system=task.system or "You are one agent in a team working for the user. Be concrete.",
                                    messages=[{"role": "user", "content": task.prompt + ("\n\nReply with JSON only." if task.want_json else "")}],
                                    max_tokens=int(self.config.get("max_tokens", 2500)), usage=None)
        return AgentResult(ok=bool(r.text.strip()), text=r.text, model=r.model, usage=r)


ADAPTERS: dict[str, type[Adapter]] = {c.type: c for c in (ClaudeLocal, CodexLocal, HermesLocal, GeminiLocal, OpencodeLocal, Process, Http, LLM)}
