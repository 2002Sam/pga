"""The agent pool's contract: a task goes to an adapter, a result comes back.

Modelled on Paperclip's adapters (claude_local, codex_local, hermes_local, process, http…): every agent — a
coding CLI, another agent framework, a script, a webhook, or PGA's own model — is reached through one interface,
so workflows can mix them freely.
"""

from __future__ import annotations

import time
from dataclasses import asdict, dataclass, field
from typing import Any

READ_ONLY = "read_only"                 # may read the workspace and the web; writes nothing
WORKSPACE_WRITE = "workspace_write"     # may edit files inside its workspace; never runs shell commands outside it
FULL = "full"                           # a project you opened up: may run commands and edit files there, with your MCP tools


class AgentError(RuntimeError):
    pass


@dataclass
class AgentTask:
    prompt: str
    kind: str = "general"                       # the capability needed: code, research, review, write, plan, general
    system: str = ""                            # extra instructions (PGA's role framing)
    workspace: str | None = None                # the directory the agent works in (a git worktree for code)
    permissions: str = READ_ONLY
    timeout_s: float = 300
    max_turns: int = 30
    want_json: bool = False                     # the caller will parse JSON out of the reply
    meta: dict[str, Any] = field(default_factory=dict)


@dataclass
class AgentResult:
    ok: bool
    text: str = ""
    agent: str = ""
    adapter: str = ""
    model: str | None = None
    status: str = "SUCCEEDED"                   # SUCCEEDED | FAILED | TIMEOUT | SKIPPED
    error: str | None = None
    cost_usd: float | None = None
    duration_s: float = 0.0
    session_id: str | None = None
    data: dict[str, Any] = field(default_factory=dict)
    usage: Any = None                           # an LLMResult for PGA's own model, recorded by the caller

    def as_dict(self) -> dict:
        d = asdict(self)
        d.pop("usage", None)
        return d


class Adapter:
    """One way of running an agent. Subclasses set `type` and implement `available` and `_run`."""
    type = "base"
    binary: str | None = None

    def __init__(self, name: str, config: dict[str, Any]):
        self.name = name
        self.config = config

    def available(self) -> tuple[bool, str]:
        """Can this agent run here? (Paperclip's "Test environment".) Returns (ok, detail)."""
        return True, ""

    def run(self, task: AgentTask) -> AgentResult:
        t0 = time.monotonic()
        try:
            res = self._run(task)
        except AgentError as exc:
            res = AgentResult(ok=False, status="FAILED", error=str(exc)[:1000])
        except Exception as exc:  # noqa: BLE001 - an agent failing must never take PGA down
            res = AgentResult(ok=False, status="FAILED", error=f"{type(exc).__name__}: {exc}"[:1000])
        if not res.ok and res.status == "SUCCEEDED":
            res.status = "FAILED"
        res.agent, res.adapter = self.name, self.type
        res.duration_s = round(time.monotonic() - t0, 2)
        return res

    def _run(self, task: AgentTask) -> AgentResult:
        raise NotImplementedError
