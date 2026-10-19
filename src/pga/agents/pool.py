"""The agent pool: one framework that aggregates many agents.

`agents.yaml` (next to models.yaml) says which agents exist and how each kind of work is run — like Symphony's
WORKFLOW.md it is re-read when it changes, and like Paperclip's org chart each agent has a role, capabilities,
an adapter and limits:

    agents:
      claude: {adapter: claude_local, role: 工程师, capabilities: [code, review, research], timeout_s: 900}
      codex:  {adapter: codex_local,  role: 工程师, capabilities: [code, review]}
      hermes: {adapter: hermes_local, role: 研究助理, capabilities: [research, write]}
      model:  {adapter: llm, tier: 2,  role: PGA 自己的模型, capabilities: [research, review, write, plan]}
    workflows:
      implement: {pattern: single,  agents: [claude, codex], permissions: workspace_write}
      review:    {pattern: council, members: [claude, codex, model], chair: model, peer_review: true}
      deep_dive: {pattern: convoy,  planner: model, workers: [claude, hermes, model], merge: model, max_subtasks: 4}

Three patterns, each borrowed from one of the projects PGA learns from:

    single   the first available agent that can do it; on failure, a short backoff and the next one (Symphony's retries)
    council  members answer in parallel, rank each other's anonymised answers, a chair synthesises (Consilium / llm-council)
    convoy   a planner splits the work, workers take the pieces in parallel, a merger joins them (Gas Town's convoy → refinery)

Every step is recorded as an AgentRun (parent = the workflow run). Agents that are not installed are skipped;
a daily cost cap stops paid external agents; one run per agent at a time unless `max_concurrent` says otherwise
(Paperclip's V1 rule). Workspaces live under ~/Documents/PGA/workspaces/.
"""

from __future__ import annotations

import json
import logging
import os
import re
import threading
import time
import uuid
from concurrent.futures import ThreadPoolExecutor
from dataclasses import dataclass, field
from datetime import datetime, timedelta
from pathlib import Path
from typing import TYPE_CHECKING, Any

import yaml
from sqlalchemy import func, select

from pga.agents.adapters import ADAPTERS, LLM
from pga.agents.base import READ_ONLY, WORKSPACE_WRITE, Adapter, AgentResult, AgentTask
from pga.db.models import AgentRun
from pga.db.types import utcnow

if TYPE_CHECKING:
    from pga.db.models import User
    from pga.runtime import Runtime

log = logging.getLogger(__name__)

ROOT = Path(__file__).resolve().parents[3]                           # …/pga
CONFIG = Path(os.environ.get("PGA_AGENTS_FILE") or ROOT / "agents.yaml")
PATTERNS = ("single", "council", "convoy")
# routing modes (internal preference): weights for (preference order, quality, speed, cost, remaining usage)
MODES = {"performance": (3.0, 2.0, 0.5, 0.0, 1.0), "balanced": (3.0, 1.0, 1.0, 1.0, 1.5),
         "economy": (2.0, 0.5, 0.5, 2.5, 2.0), "speed": (2.0, 0.5, 2.5, 0.5, 1.0)}

CHATGPT_CODEX = "/Applications/ChatGPT.app/Contents/Resources/codex-cli/bin/codex"       # newer than ~/.local/bin/codex
WORKBUDDY_CLI = "/Applications/WorkBuddy.app/Contents/Resources/app.asar.unpacked/cli/bin/codebuddy"

DEFAULT: dict[str, Any] = {
    # traits: 1–5 (quality, speed, cost — cost 5 = most expensive); quota: where "remaining usage" comes from
    "agents": {
        "deepseek": {"adapter": "llm", "tier": 2, "role": "日常快速 · DeepSeek（PGA 自己的模型）", "max_concurrent": 3,
                     "capabilities": ["quick", "serious", "research", "review", "write", "plan", "general"],
                     "traits": {"quality": 3, "speed": 5, "cost": 1}, "quota": {"source": "deepseek_balance", "full": 50},
                     "link": "DeepSeek API（设置 → 模型与 API 里的通道和密钥），PGA 直接调用"},
        "chatgpt": {"adapter": "codex_local", "command": CHATGPT_CODEX, "role": "严肃问题 · ChatGPT（gpt-astra）",
                    "capabilities": ["serious", "research", "review", "write", "code", "general"], "reasoning": "medium",
                    "disable": ["memories", "shell_tool"],         # answers only: no local memory files, no shell commands
                    "timeout_s": 600, "max_turns": 20, "traits": {"quality": 5, "speed": 2, "cost": 3},
                    "quota": {"source": "codex_sessions"},
                    "link": "ChatGPT 应用自带的 Codex：常驻 app-server（JSON-RPC），每段对话一个可恢复的线程，额度实时读取；只读沙箱，用你登录的 ChatGPT 账号；默认模型 = ~/.codex/config.toml（gpt-astra）。app-server 起不来时退回 codex exec"},
        "claude": {"adapter": "claude_local", "role": "代码 · Claude Code（订阅）",
                   "capabilities": ["code", "serious", "review", "research", "write", "plan", "general"], "timeout_s": 900,
                   "max_turns": 40, "traits": {"quality": 5, "speed": 3, "cost": 3},
                   "quota": {"source": "observed", "window_hours": 5, "window_runs": 40},
                   # questions go straight to the Anthropic API when ANTHROPIC_API_KEY works (billed per token);
                   # writing code always uses Claude Code
                   "api": {"type": "anthropic", "key_env": "ANTHROPIC_API_KEY", "model": "claude-sonnet-5-5",
                           "usd_per_mtok_in": 3, "usd_per_mtok_out": 15},
                   "link": "提问：ANTHROPIC_API_KEY 有效时直接调 Anthropic API；否则 Claude Code 常驻会话（stream-json，每段对话一个，闲置 20 分钟后关闭、下次按会话 id 恢复）。写代码总是用 Claude Code（claude -p）。Claude Code 需要 `claude setup-token` 生成的令牌"},
        "workbuddy": {"adapter": "codebuddy_local", "command": WORKBUDDY_CLI, "role": "办公 · WorkBuddy",
                      "capabilities": ["office", "write", "general"], "timeout_s": 600, "max_turns": 30,
                      "traits": {"quality": 4, "speed": 3, "cost": 2}, "quota": {"source": "observed", "window_hours": 24, "window_runs": 60},
                      "link": "WorkBuddy 应用自带的 CodeBuddy CLI：常驻会话（stream-json，每段对话一个，可恢复），文件只写进这段对话自己的工作目录；需要 CODEBUDDY_API_KEY 或在终端运行一次 codebuddy 并 /login"},
        "hermes": {"adapter": "hermes_local", "role": "研究助理 · Hermes Agent", "capabilities": ["research", "serious", "write", "quick", "general"],
                   "timeout_s": 600, "max_turns": 30, "traits": {"quality": 4, "speed": 3, "cost": 3},
                   "quota": {"source": "codex_sessions"},
                   "api_url": "http://127.0.0.1:8642", "api_key_env": "HERMES_API_SERVER_KEY",
                   "link": "Hermes 本地 API（/v1/runs，带会话 id；需要在 ~/.hermes/.env 打开 API_SERVER_ENABLED，并把 API_SERVER_KEY 存进这里）；没开时用命令行 hermes chat -Q。模型用 ~/.hermes 里的（openai-codex · gpt-astra，与 ChatGPT 共用额度）"},
        "codex": {"adapter": "codex_local", "command": CHATGPT_CODEX, "role": "工程师 · Codex", "capabilities": ["code", "review", "general"],
                  "disable": ["memories"],
                  "timeout_s": 900, "max_turns": 40, "traits": {"quality": 4, "speed": 2, "cost": 3}, "quota": {"source": "codex_sessions"},
                  "link": "同 ChatGPT 的 Codex CLI，但用于写代码（工作目录可写）"},
        "gemini": {"adapter": "gemini_local", "role": "Gemini CLI", "capabilities": ["research", "review", "general"],
                   "traits": {"quality": 4, "speed": 3, "cost": 2}, "quota": {"source": "observed", "window_hours": 24, "window_runs": 100},
                   "link": "Gemini CLI（gemini -p）；本机未安装"},
    },
    "workflows": {
        "general": {"pattern": "single", "agents": ["deepseek", "chatgpt", "hermes"], "label": "一般问题 · 一个 agent 回答"},
        "implement": {"pattern": "single", "agents": ["claude", "codex"], "permissions": WORKSPACE_WRITE,
                      "label": "写代码 · 在工作目录里改文件（自我改进用它）"},
        "review": {"pattern": "council", "members": ["claude", "chatgpt", "deepseek"], "chair": "chatgpt", "peer_review": True,
                   "label": "评审 · 多个 agent 各自评审、互评、再综合"},
        "research": {"pattern": "council", "members": ["chatgpt", "hermes", "claude", "deepseek"], "chair": "chatgpt", "peer_review": True,
                     "label": "研究 · 议会：并行回答 → 匿名互评 → 主席综合"},
        "deep_dive": {"pattern": "convoy", "planner": "deepseek", "workers": ["chatgpt", "claude", "hermes"], "merge": "chatgpt",
                      "max_subtasks": 4, "label": "深挖 · 车队：拆成子任务并行做，再合并"},
    },
    # how work is dispatched: each category prefers agents in order; the mode weighs quality / speed / cost;
    # agents low on remaining usage drop down or out
    "routing": {
        "enabled": True,
        "mode": "performance",                      # performance 性能优先 | balanced 均衡 | economy 省钱 | speed 速度优先
        "long_tasks": True,                         # route the work of long-term responsibilities too (not only the chat box)
        "keep_for_me": ["claude_local"],            # agent kinds kept for your own chats: PGA's background work never uses them
        "min_remaining": 0.1,                       # skip an agent with less than 10% of its usage left
        "categories": {
            "code": {"label": "代码", "prefer": ["claude", "codex", "chatgpt", "workbuddy", "deepseek"]},
            "serious": {"label": "严肃问题", "prefer": ["chatgpt", "claude", "hermes", "deepseek"]},
            "office": {"label": "办公", "prefer": ["workbuddy", "chatgpt", "claude", "deepseek"]},
            "quick": {"label": "日常快速", "prefer": ["deepseek", "hermes", "chatgpt"]},
        },
        # which internal tasks belong to which category (others stay on PGA's own model)
        "task_kinds": {
            "serious": ["synthesis", "deep_research", "comparison", "exploration", "motivation_forward", "r0_forward",
                        "evolution_diagnose", "evolution_review", "evolution_propose", "evolution_propose_strong",
                        "critical_validation", "high_priority_artifact", "aim_expand"],
            "code": ["evolution_implement"],
            "quick": ["translation", "classification", "extraction", "event_scoring", "monitoring", "layers_build",
                      "hub_summary", "hub_background"],
        },
    },
    "run": {"max_parallel": 3, "retries": 1, "max_backoff_s": 20, "daily_usd_cap": 10.0, "default_timeout_s": 300,
            "heartbeat_minutes": 30,                # how often every link is checked (links.py)
            "workspace_root": str(ROOT.parent / "workspaces")},
}

RANK_SYSTEM = """You are reviewing anonymised answers to the same request. Judge them on correctness, usefulness and
honesty about uncertainty — not on length or style. Reply with JSON only:
{"ranking": ["<label best>", "...", "<label worst>"], "notes": "<one or two sentences>"}"""

CHAIR_SYSTEM = """You chair a council of agents. Several of them answered the same request and ranked each other's
answers. Write the single best final answer for the user: keep what the answers agree on, resolve or clearly flag
disagreements, and prefer the higher-ranked answers when they conflict. Do not mention the council unless the
disagreement matters to the user."""

PLAN_SYSTEM = """You plan a convoy: split the request into at most {n} independent subtasks that different agents can
do in parallel without talking to each other. Each subtask needs a short title and a self-contained prompt.
Reply with JSON only: {{"subtasks": [{{"title": "...", "prompt": "..."}}]}}"""

MERGE_SYSTEM = """You are the refinery of a convoy: several agents each did one part of the work. Merge their results
into one coherent, complete answer to the original request. Remove duplication, keep specifics, and say plainly which
parts failed or remain uncertain."""


class PoolError(ValueError):
    pass


# ---------------------------------------------------------------- configuration


def load() -> dict:
    if CONFIG.exists():
        data = yaml.safe_load(CONFIG.read_text(encoding="utf-8")) or {}
    else:
        data = {}
    import copy
    out = copy.deepcopy({k: DEFAULT[k] for k in ("agents", "workflows", "routing", "run")})
    if data:
        out["agents"] = data.get("agents") or {}
        out["workflows"] = data.get("workflows") or {}
        out["run"] = {**DEFAULT["run"], **(data.get("run") or {})}
        r = data.get("routing") or {}
        out["routing"] = {**out["routing"], **r, "categories": r.get("categories") or out["routing"]["categories"],
                          "task_kinds": r.get("task_kinds") or out["routing"]["task_kinds"]}
    return out


def validate(data: dict) -> dict:
    agents, flows = data.get("agents") or {}, data.get("workflows") or {}
    if not agents:
        raise PoolError("at least one agent is needed")
    for name, a in agents.items():
        if not re.match(r"^[a-z0-9][a-z0-9_-]{0,39}$", name):
            raise PoolError(f"agent name {name!r}: use lowercase letters, digits, - or _")
        if a.get("adapter") not in ADAPTERS:
            raise PoolError(f"agent {name}: adapter must be one of {sorted(ADAPTERS)}")
    for name, w in flows.items():
        if w.get("pattern") not in PATTERNS:
            raise PoolError(f"workflow {name}: pattern must be one of {PATTERNS}")
        refs = list(w.get("agents") or []) + list(w.get("members") or []) + list(w.get("workers") or []) + \
            [w[k] for k in ("chair", "planner", "merge") if w.get(k)]
        for r in refs:
            if r not in agents:
                raise PoolError(f"workflow {name}: unknown agent {r!r}")
        if w.get("permissions", READ_ONLY) not in (READ_ONLY, WORKSPACE_WRITE):
            raise PoolError(f"workflow {name}: permissions must be {READ_ONLY} or {WORKSPACE_WRITE}")
    r = data.get("routing") or {}
    if r.get("mode", "performance") not in MODES:
        raise PoolError(f"routing mode must be one of {list(MODES)}")
    for cat, c in (r.get("categories") or {}).items():
        for n in c.get("prefer") or []:
            if n not in agents:
                raise PoolError(f"routing {cat}: unknown agent {n!r}")
    return data


def save(data: dict) -> dict:
    data = validate({"agents": data.get("agents") or {}, "workflows": data.get("workflows") or {},
                     "routing": data.get("routing") or {}, "run": data.get("run") or {}})
    header = ("# PGA agent pool — which agents exist and how each kind of work is run.\n"
              "# adapters: claude_local | codex_local | hermes_local | gemini_local | opencode_local | process | http | llm\n"
              "# patterns: single (first available) · council (answer → peer review → chair) · convoy (plan → parallel → merge)\n")
    CONFIG.write_text(header + yaml.safe_dump(data, allow_unicode=True, sort_keys=False), encoding="utf-8")
    return load()


# ---------------------------------------------------------------- the pool

_SEMAPHORES: dict[str, threading.BoundedSemaphore] = {}
_SEM_LOCK = threading.Lock()


def _slot(name: str, n: int) -> threading.BoundedSemaphore:
    with _SEM_LOCK:
        key = f"{name}:{n}"
        if key not in _SEMAPHORES:
            _SEMAPHORES[key] = threading.BoundedSemaphore(max(1, n))
        return _SEMAPHORES[key]


def busy(name: str, n: int) -> bool:
    """Every slot of this agent is taken right now (another thread is running it)."""
    with _SEM_LOCK:
        s = _SEMAPHORES.get(f"{name}:{n}")
    return s is not None and getattr(s, "_value", 1) <= 0


@dataclass
class Step:
    step: str
    task: AgentTask
    result: AgentResult
    attempt: int = 1
    started: datetime = field(default_factory=utcnow)
    finished: datetime = field(default_factory=utcnow)


@dataclass
class PoolResult:
    ok: bool
    text: str
    workflow: str
    pattern: str
    data: dict = field(default_factory=dict)
    steps: list[Step] = field(default_factory=list)
    run_id: uuid.UUID | None = None
    error: str | None = None

    def as_dict(self) -> dict:
        return {"ok": self.ok, "text": self.text, "workflow": self.workflow, "pattern": self.pattern, "data": self.data,
                "error": self.error, "run_id": str(self.run_id) if self.run_id else None,
                "steps": [{"step": s.step, "agent": s.result.agent, "adapter": s.result.adapter, "status": s.result.status,
                           "ok": s.result.ok, "duration_s": s.result.duration_s, "cost_usd": s.result.cost_usd,
                           "error": s.result.error, "text": s.result.text[:4000]} for s in self.steps]}


class AgentPool:
    def __init__(self, rt: "Runtime", config: dict | None = None):
        self.rt = rt
        self.cfg = config or load()
        self.runcfg = self.cfg["run"]
        if "routing" not in self.cfg:
            import copy
            self.cfg["routing"] = copy.deepcopy(DEFAULT["routing"])
        self.adapters: dict[str, Adapter] = {}
        for name, a in self.cfg["agents"].items():
            cls = ADAPTERS.get(a.get("adapter"))
            if cls is None:
                continue
            self.adapters[name] = cls(name, a, rt) if cls is LLM else cls(name, a)
        self._lock = threading.Lock()

    # -------------------------------------------------------------- who can run

    def status(self) -> dict[str, dict]:
        out = {}
        for name, ad in self.adapters.items():
            a = self.cfg["agents"][name]
            ok, detail = ad.available()
            out[name] = {"adapter": ad.type, "role": a.get("role", ""), "capabilities": a.get("capabilities") or [],
                         "enabled": a.get("enabled", True) is not False, "available": ok, "detail": detail,
                         "external": ad.type != "llm",
                         "secrets": ad.secrets_set() if hasattr(ad, "secrets_set") else {}}
        return out

    def spent_today(self, now: datetime | None = None) -> float:
        now = now or utcnow()
        start = now.replace(hour=0, minute=0, second=0, microsecond=0)
        return float(self.rt.session.scalar(select(func.coalesce(func.sum(AgentRun.cost_usd), 0.0)).where(
            AgentRun.started_at >= start)) or 0.0)

    def usable(self, name: str, spent: float) -> tuple[bool, str]:
        a, ad = self.cfg["agents"].get(name), self.adapters.get(name)
        if not a or not ad:
            return False, "unknown agent"
        if a.get("enabled", True) is False:
            return False, "disabled"
        ok, detail = ad.available()
        if not ok:
            return False, detail
        from pga.agents import links
        st = links.state(name)
        if st and st.get("state") in links.DOWN:
            return False, f"{links.LABEL[st['state']]}：{st.get('detail') or ''}".rstrip("：")
        if ad.type != "llm" and spent >= float(self.runcfg.get("daily_usd_cap") or 1e9):
            return False, f"daily cost cap reached (${spent:.2f})"
        return True, ""

    # -------------------------------------------------------------- running

    def _task(self, name: str, prompt: str, *, system: str, kind: str, workspace: str | None, permissions: str,
              timeout_s: float | None, want_json: bool, meta: dict | None = None) -> AgentTask:
        a = self.cfg["agents"][name]
        return AgentTask(prompt=prompt, system=system, kind=kind, workspace=workspace, permissions=permissions,
                         timeout_s=float(timeout_s or a.get("timeout_s") or self.runcfg.get("default_timeout_s", 300)),
                         max_turns=int(a.get("max_turns", 30)), want_json=want_json, meta=dict(meta or {}))

    def _call(self, name: str, task: AgentTask, step: str, attempt: int = 1) -> Step:
        from pga.agents import live
        a = self.cfg["agents"][name]
        started = utcnow()
        proj = task.meta.get("project") if isinstance(task.meta.get("project"), dict) else {}
        tags = {k: str(task.meta[k]) for k in ("aim", "perpetual", "role", "conversation", "question") if task.meta.get(k)}
        if proj.get("id"):
            tags["project"] = str(proj["id"])
        lid = live.start(name, category=task.meta.get("category") or task.kind, workflow=task.meta.get("workflow", ""), step=step,
                         prompt=task.prompt, task_kind=task.meta.get("task_kind", ""), tags=tags)
        task.meta["live_id"] = lid
        from pga.agents.base import PGA_MARK
        if self.adapters[name].type not in ("llm", "http") and not task.prompt.startswith(PGA_MARK):   # only agents that keep transcripts
            task.prompt = f"{PGA_MARK}\n{task.prompt}"
        if callable(task.meta.get("translate")):            # the reader's language, paragraph by paragraph, while it writes
            live.translate_along(lid, task.meta["translate"])
        try:
            with _slot(name, int(a.get("max_concurrent", 1))):
                res = self.adapters[name].run(task)
        finally:
            r = locals().get("res")
            trace = live.text(lid)
            if r is not None and trace.strip() and trace.strip() != (r.text or "").strip():
                r.data = {**(r.data or {}), "trace": trace[-20000:]}     # how it got there: files read, commands, thinking
            if r is not None:
                r.data = {**(r.data or {}), "live_id": lid}
            live.finish(lid, bool(r and r.ok), text=r.text if r else None, error=r.error if r else "interrupted")
        return Step(step=step, task=task, result=res, attempt=attempt, started=started, finished=utcnow())

    def conversation_workspace(self, agent: str, conversation: str) -> str:
        """A conversation keeps one folder, so a running session and the files it writes stay together."""
        import hashlib
        root = Path(os.path.expanduser(str(self.runcfg.get("workspace_root"))))
        d = root / "conversations" / f"{agent}-{hashlib.sha256(conversation.encode()).hexdigest()[:12]}"
        d.mkdir(parents=True, exist_ok=True)
        return str(d)

    def _workspace(self, run_id: uuid.UUID, workflow: str, sub: str | None = None) -> str:
        root = Path(os.path.expanduser(str(self.runcfg.get("workspace_root"))))
        d = root / utcnow().strftime("%Y%m%d") / f"{str(run_id)[:8]}-{workflow}" / (sub or "")
        d.mkdir(parents=True, exist_ok=True)
        return str(d)

    def run(self, workflow: str, prompt: str, *, user: "User | None" = None, system: str = "", workspace: str | None = None,
            permissions: str | None = None, timeout_s: float | None = None, want_json: bool = False,
            job_id: uuid.UUID | None = None, now: datetime | None = None) -> PoolResult:
        w = self.cfg["workflows"].get(workflow)
        if not w:
            raise PoolError(f"unknown workflow {workflow!r}")
        run_id = uuid.uuid4()
        perms = permissions or w.get("permissions") or READ_ONLY
        spent = self.spent_today(now)
        ctx = dict(system=system, workspace=workspace, permissions=perms, timeout_s=timeout_s, want_json=want_json, run_id=run_id,
                   workflow=workflow, spent=spent)
        pattern = w["pattern"]
        t0 = utcnow()
        if pattern == "single":
            res = self._single(w, prompt, **ctx)
        elif pattern == "council":
            res = self._council(w, prompt, **ctx)
        else:
            res = self._convoy(w, prompt, **ctx)
        res.workflow, res.pattern, res.run_id = workflow, pattern, run_id
        self._record(res, prompt, user, job_id, workspace, t0)
        return res

    def _candidates(self, names: list[str], spent: float, skipped: list[Step]) -> list[str]:
        out = []
        for n in names:
            ok, why = self.usable(n, spent)
            if ok:
                out.append(n)
            elif n in self.adapters:
                skipped.append(Step("skip", AgentTask(prompt=""), AgentResult(ok=False, agent=n, adapter=self.adapters[n].type,
                                                                           status="SKIPPED", error=why)))
        return out

    def _single(self, w: dict, prompt: str, *, system, workspace, permissions, timeout_s, want_json, run_id, workflow, spent) -> PoolResult:
        steps: list[Step] = []
        names = self._candidates(list(w.get("agents") or []), spent, steps)
        retries, cap = int(self.runcfg.get("retries", 1)), float(self.runcfg.get("max_backoff_s", 20))
        for name in names:
            ws = workspace or self._workspace(run_id, workflow, name)
            for attempt in range(1, retries + 2):
                st = self._call(name, self._task(name, prompt, system=system, kind=workflow, workspace=ws, permissions=permissions,
                                                 timeout_s=timeout_s, want_json=want_json), "run", attempt)
                steps.append(st)
                if st.result.ok:
                    return PoolResult(True, st.result.text, workflow, "single", {"agent": name, "workspace": ws}, steps)
                if st.result.status == "TIMEOUT" or attempt > retries:
                    break
                time.sleep(min(cap, 2 * 2 ** (attempt - 1)))               # Symphony-style exponential backoff, kept short
        why = "; ".join(f"{s.result.agent}: {s.result.error}" for s in steps if s.result.error) or "no agent could run"
        return PoolResult(False, "", workflow, "single", {}, steps, error=why[:1000])

    def _parallel(self, jobs: list[tuple[str, AgentTask, str]]) -> list[Step]:
        if not jobs:
            return []
        with ThreadPoolExecutor(max_workers=max(1, min(len(jobs), int(self.runcfg.get("max_parallel", 3))))) as ex:
            return list(ex.map(lambda j: self._call(*j), jobs))

    def _council(self, w: dict, prompt: str, *, system, workspace, permissions, timeout_s, want_json, run_id, workflow, spent) -> PoolResult:
        steps: list[Step] = []
        members = self._candidates(list(w.get("members") or []), spent, steps)
        mk = lambda n, p, sysp, step, wj=False: (n, self._task(n, p, system=sysp, kind=workflow, workspace=workspace or self._workspace(run_id, workflow, f"{n}-{step}"),  # noqa: E731
                                                            permissions=READ_ONLY, timeout_s=timeout_s, want_json=wj), step)
        answers = self._parallel([mk(n, prompt, system, "answer") for n in members])
        steps += answers
        good = [s for s in answers if s.result.ok and s.result.text.strip()]
        if not good:
            return PoolResult(False, "", workflow, "council", {}, steps, error="no member answered")
        labels = {s.result.agent: chr(65 + i) for i, s in enumerate(good)}
        listing = "\n\n".join(f"<answer label=\"{labels[s.result.agent]}\">\n{s.result.text[:6000]}\n</answer>" for s in good)
        scores = {s.result.agent: 0.0 for s in good}
        if w.get("peer_review", True) and len(good) > 1:
            reviews = self._parallel([mk(s.result.agent, f"Request:\n{prompt}\n\n{listing}", RANK_SYSTEM, "review", True) for s in good])
            steps += reviews
            back = {v: k for k, v in labels.items()}
            for r in reviews:
                ranking = _json(r.result.text).get("ranking") or []
                # agents recognise their own writing even anonymised: a reviewer's vote for itself does not count
                others = [back.get(str(lab).strip().strip('"')) for lab in (ranking if isinstance(ranking, list) else [])]
                others = [w for w in others if w and w != r.result.agent]
                for pos, who in enumerate(others):
                    scores[who] += len(others) - 1 - pos                   # Borda count over the others
        order = sorted(good, key=lambda s: -scores[s.result.agent])
        data = {"answers": [{"label": labels[s.result.agent], "agent": s.result.agent, "score": scores[s.result.agent],
                             "text": s.result.text[:8000]} for s in order],
                "agreement": _agreement(scores)}
        chair = w.get("chair")
        if chair and self.usable(chair, spent)[0]:
            board = "\n".join(f"{labels[s.result.agent]}: peer score {scores[s.result.agent]:g}" for s in order)
            st = self._call(chair, self._task(chair, f"Request:\n{prompt}\n\n{listing}\n\nPeer ranking (higher is better):\n{board}",
                                              system=CHAIR_SYSTEM + (f"\n\n{system}" if system else ""), kind=workflow,
                                              workspace=workspace or self._workspace(run_id, workflow, "chair"), permissions=READ_ONLY,
                                              timeout_s=timeout_s, want_json=want_json), "synthesis")
            steps.append(st)
            if st.result.ok:
                return PoolResult(True, st.result.text, workflow, "council", {**data, "chair": chair}, steps)
        return PoolResult(True, order[0].result.text, workflow, "council", {**data, "chair": None}, steps)

    def _convoy(self, w: dict, prompt: str, *, system, workspace, permissions, timeout_s, want_json, run_id, workflow, spent) -> PoolResult:
        steps: list[Step] = []
        n = int(w.get("max_subtasks", 4))
        plan = [{"title": "whole request", "prompt": prompt}]
        planner = w.get("planner")
        if planner and self.usable(planner, spent)[0]:
            st = self._call(planner, self._task(planner, prompt, system=PLAN_SYSTEM.format(n=n), kind=workflow,
                                                workspace=self._workspace(run_id, workflow, "plan"), permissions=READ_ONLY,
                                                timeout_s=timeout_s, want_json=True), "plan")
            steps.append(st)
            subs = _json(st.result.text).get("subtasks") if st.result.ok else None
            if isinstance(subs, list) and subs:
                plan = [{"title": str(x.get("title") or f"part {i + 1}")[:120], "prompt": str(x.get("prompt") or "")}
                        for i, x in enumerate(subs[:n]) if isinstance(x, dict) and x.get("prompt")] or plan
        workers = self._candidates(list(w.get("workers") or []), spent, steps)
        if not workers:
            return PoolResult(False, "", workflow, "convoy", {"plan": plan}, steps, error="no worker available")
        jobs = []
        for i, sub in enumerate(plan):
            name = workers[i % len(workers)]
            body = f"Overall request (context only):\n{prompt}\n\nYour part — {sub['title']}:\n{sub['prompt']}"
            jobs.append((name, self._task(name, body, system=system, kind=workflow, workspace=self._workspace(run_id, workflow, f"{i + 1}-{name}"),
                                          permissions=permissions, timeout_s=timeout_s, want_json=False, meta={"subtask": i}), "work"))
        work = self._parallel(jobs)
        steps += work
        parts = [{"title": plan[i]["title"], "agent": s.result.agent, "ok": s.result.ok, "text": s.result.text[:8000],
                  "error": s.result.error} for i, s in enumerate(work)]
        if not any(p["ok"] for p in parts):
            return PoolResult(False, "", workflow, "convoy", {"plan": plan, "parts": parts}, steps, error="every subtask failed")
        merge = w.get("merge")
        listing = "\n\n".join(f"<part title=\"{p['title']}\" agent=\"{p['agent']}\" ok=\"{p['ok']}\">\n{p['text'] or p['error']}\n</part>"
                              for p in parts)
        if merge and self.usable(merge, spent)[0]:
            st = self._call(merge, self._task(merge, f"Original request:\n{prompt}\n\n{listing}", system=MERGE_SYSTEM, kind=workflow,
                                              workspace=self._workspace(run_id, workflow, "merge"), permissions=READ_ONLY,
                                              timeout_s=timeout_s, want_json=want_json), "merge")
            steps.append(st)
            if st.result.ok:
                return PoolResult(True, st.result.text, workflow, "convoy", {"plan": plan, "parts": parts, "merge": merge}, steps)
        return PoolResult(True, "\n\n".join(f"## {p['title']}\n{p['text']}" for p in parts if p["ok"]), workflow, "convoy",
                          {"plan": plan, "parts": parts, "merge": None}, steps)

    # -------------------------------------------------------------- the ledger

    def _record(self, res: PoolResult, prompt: str, user: "User | None", job_id: uuid.UUID | None, workspace: str | None,
                started: datetime) -> None:
        s = self.rt.session
        cost = sum(st.result.cost_usd or 0 for st in res.steps) or None
        parent = AgentRun(id=res.run_id, user_id=user.id if user else None, job_id=job_id, workflow=res.workflow,
                          pattern=res.pattern, step="workflow", agent=(res.data or {}).get("agent") or (res.data or {}).get("chair")
                          or (res.data or {}).get("merge") or "-", adapter="pool",
                          status="SUCCEEDED" if res.ok else "FAILED", prompt=prompt[:20000], output=res.text[:50000],
                          data=_jsonable({k: v for k, v in (res.data or {}).items()}), error=res.error, workspace=workspace,
                          cost_usd=cost, duration_s=round((utcnow() - started).total_seconds(), 2), started_at=started,
                          finished_at=utcnow())
        s.add(parent)
        s.flush()
        for st in res.steps:
            r = st.result
            s.add(AgentRun(user_id=user.id if user else None, parent_id=parent.id, job_id=job_id, workflow=res.workflow,
                           pattern=res.pattern, step=st.step, agent=r.agent or "-", adapter=r.adapter or "-", status=r.status,
                           prompt=st.task.prompt[:20000], output=r.text[:50000], data=_jsonable(r.data), error=r.error,
                           workspace=st.task.workspace, cost_usd=r.cost_usd, duration_s=r.duration_s, attempt=st.attempt,
                           started_at=st.started, finished_at=st.finished))
            if r.usage is not None and user is not None:              # PGA's own model: count it against the budget
                from pga.llm import UsageContext
                r.usage.tier = int(self.cfg["agents"].get(r.agent, {}).get("tier", 2))
                self.rt.ledger.record_llm(r.usage, UsageContext(category="user_reserve", proactive=job_id is not None, user_id=user.id))
        s.flush()

    def history(self, user_id: uuid.UUID | None, limit: int = 20) -> list[dict]:
        q = select(AgentRun).where(AgentRun.parent_id.is_(None)).order_by(AgentRun.started_at.desc()).limit(limit)
        if user_id:
            q = q.where(AgentRun.user_id == user_id)
        out = []
        for p in self.rt.session.scalars(q):
            kids = list(self.rt.session.scalars(select(AgentRun).where(AgentRun.parent_id == p.id).order_by(AgentRun.started_at)))
            out.append({"id": str(p.id), "workflow": p.workflow, "pattern": p.pattern, "status": p.status, "prompt": p.prompt[:400],
                        "output": p.output[:6000], "error": p.error, "cost_usd": p.cost_usd, "duration_s": p.duration_s,
                        "started_at": p.started_at.isoformat(), "data": p.data,
                        "steps": [{"step": k.step, "agent": k.agent, "adapter": k.adapter, "status": k.status, "duration_s": k.duration_s,
                                   "cost_usd": k.cost_usd, "error": k.error, "output": k.output[:1500]} for k in kids]})
        return out


def _json(text: str) -> dict:
    try:
        from pga.agent.common import parse_json
        d = parse_json(text or "")
        return d if isinstance(d, dict) else {}
    except Exception:  # noqa: BLE001
        return {}


def _agreement(scores: dict[str, float]) -> float | None:
    """1.0 when one answer is clearly preferred by everyone, lower when the council is split."""
    if len(scores) < 2:
        return None
    vals = sorted(scores.values(), reverse=True)
    top = vals[0] or 1.0
    return round((vals[0] - vals[1]) / top, 3) if top else 0.0


def _jsonable(v: Any) -> Any:
    try:
        return json.loads(json.dumps(v, default=str))
    except (TypeError, ValueError):
        return {}
