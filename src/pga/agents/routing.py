"""Dispatch: which agent does a piece of work.

Every request — a question in the agent chat, or a model call inside long-term work — gets a category:

    code     → Claude first   (then Codex, ChatGPT, WorkBuddy, DeepSeek)
    serious  → ChatGPT gpt-astra first (then Claude, Hermes, DeepSeek)
    office   → WorkBuddy first (then ChatGPT, Claude, DeepSeek)
    quick    → DeepSeek first

(the orders live in agents.yaml → routing.categories). Candidates are then scored:

    score = w_pref·preference + w_q·quality + w_s·speed − w_c·cost + w_r·remaining usage

with weights from the mode (性能优先 / 均衡 / 省钱 / 速度优先). Agents that are not installed, disabled, over the
daily cost cap, out of usage (below `min_remaining`) or rate-limited are skipped. The first that answers wins;
on failure the next one is tried.

Long-term work: `delegate()` is plugged into the LLM router. Model calls made inside a run whose kind is listed
under routing.task_kinds go to the routed agent; quick kinds (translation, classification…) stay on PGA's own model.
If the agent fails, or a reply that must be JSON is not, the call falls back to PGA's model — work never stops
because an agent did.
"""

from __future__ import annotations

import logging
import re
import uuid
from datetime import datetime
from pathlib import Path
from typing import TYPE_CHECKING, Any

from pga.agents import quota as quotas
from pga.agents.base import READ_ONLY, WORKSPACE_WRITE
from pga.agents.pool import MODES, AgentPool, PoolResult, load
from pga.db.types import utcnow

if TYPE_CHECKING:
    from pga.db.models import User
    from pga.llm.router import LLMResult
    from pga.runtime import Runtime

log = logging.getLogger(__name__)

RULES = [
    ("code", re.compile(r"```|traceback|stack ?trace|exception|报错|bug|编译|compile|函数|代码|\bcode\b|python|javascript|typescript|\bjava\b|golang|rust\b|"
                        r"\bsql\b|regex|正则|\bgit\b|\bapi\b|接口|重构|refactor|单元测试|unit test|debug|调试|脚本|script|部署|deploy|docker|npm|\bpip\b", re.I)),
    ("office", re.compile(r"excel|表格|\bppt\b|幻灯片|演示文稿|\bword\b|排版|会议纪要|纪要|周报|日报|月报|邮件|e-?mail|简历|合同|报销|日程|排期|汇报|方案书|公文|"
                          r"通知稿|写一封|报表|slides?|spreadsheet|docx|xlsx|pptx|文案|海报", re.I)),
    ("serious", re.compile(r"分析|研究|论证|决策|战略|策略|风险|评估|比较|对比|利弊|取舍|法律|合规|医疗|健康|财务|投资|论文|证据|原理|为什么|深入|系统性|规划|"
                           r"长期|架构|伦理|trade-?off|analy[sz]|research|evaluat|strateg|decision|compare|\bwhy\b", re.I)),
]

ASK_SYSTEM = ("You are answering the user directly in a quick chat inside PGA, their personal multi-agent system. Answer in the "
              "user's language (Chinese if they write Chinese). Be direct and concise. If the request is office work that "
              "produces a document, write the file into the current directory and say its file name.")


def classify(text: str) -> tuple[str, str]:
    """(category, why) by rules; no model call, so it costs nothing and never waits."""
    hits = {cat: len(rx.findall(text or "")) for cat, rx in RULES}
    for cat in ("code", "office"):                       # specific kinds of work win over "serious"
        if hits[cat] and hits[cat] >= hits["serious"]:
            return cat, f"看起来是{'代码' if cat == 'code' else '办公'}问题"
    if hits["serious"]:
        return "serious", "需要分析或判断"
    if len((text or "").strip()) <= 80:
        return "quick", "简短的日常问题"
    return "serious", "较长、没有明显类型，按严肃问题处理"


class AgentRouter:
    def __init__(self, rt: "Runtime", pool: AgentPool | None = None):
        self.rt = rt
        self.pool = pool or AgentPool(rt)
        self.cfg = self.pool.cfg["routing"]

    # -------------------------------------------------------------- choosing

    def quota(self, name: str) -> quotas.Quota:
        ad = self.pool.adapters.get(name)
        return quotas.for_agent(self.rt.session, name, self.pool.cfg["agents"].get(name, {}), ad.type if ad else "")

    def category_of_task(self, kind: str) -> str | None:
        for cat, kinds in (self.cfg.get("task_kinds") or {}).items():
            if kind in (kinds or []):
                return cat
        return None

    def rank(self, category: str, now: datetime | None = None) -> list[dict]:
        cats = self.cfg.get("categories") or {}
        prefer = list((cats.get(category) or {}).get("prefer") or [])
        extra = [n for n, a in self.pool.cfg["agents"].items() if category in (a.get("capabilities") or []) and n not in prefer]
        w_pref, w_q, w_s, w_c, w_r = MODES.get(self.cfg.get("mode", "performance"), MODES["performance"])
        spent = self.pool.spent_today(now)
        out = []
        for i, name in enumerate(prefer + extra):
            if name not in self.pool.adapters:
                continue
            a = self.pool.cfg["agents"][name]
            t = a.get("traits") or {}
            q = self.quota(name)
            pref = (len(prefer) - i) / len(prefer) if name in prefer else 0.0
            rem = q.remaining if q.remaining is not None else 0.7
            score = (w_pref * pref + w_q * (t.get("quality", 3) / 5) + w_s * (t.get("speed", 3) / 5)
                     - w_c * (t.get("cost", 3) / 5) + w_r * rem)
            ok, why_not = self.pool.usable(name, spent)
            if ok and (q.exhausted or (q.remaining is not None and q.remaining < float(self.cfg.get("min_remaining", 0.1)))):
                ok, why_not = False, f"剩余用量不足（{q.detail}）"
            out.append({"agent": name, "role": a.get("role", ""), "usable": ok, "why_not": why_not, "score": round(score, 3),
                        "preference": prefer.index(name) + 1 if name in prefer else None, "remaining": q.remaining,
                        "quota": q.as_dict(), "traits": t})
        out.sort(key=lambda x: (not x["usable"], -x["score"]))
        label = (cats.get(category) or {}).get("label", category)
        for x in out:
            x["why"] = (f"{label} → {x['agent']}" + (f"（偏好第 {x['preference']}" if x["preference"] else "（能力匹配")
                        + (f"，剩余 {x['remaining'] * 100:.0f}%" if x["remaining"] is not None else "") + "）")
        return out

    def route(self, category: str) -> list[str]:
        return [x["agent"] for x in self.rank(category) if x["usable"]]

    # -------------------------------------------------------------- the agent chat

    def ask(self, user: "User | None", text: str, agent: str = "auto", history: list[dict] | None = None,
            now: datetime | None = None) -> dict:
        cat, cwhy = classify(text)
        if agent and agent != "auto":
            if agent not in self.pool.adapters:
                raise ValueError(f"unknown agent {agent!r}")
            order, why = [agent], f"你指定了 {agent}"
        else:
            ranked = self.rank(cat, now)
            order = [x["agent"] for x in ranked if x["usable"]][:3]
            why = (ranked[0]["why"] if ranked and ranked[0]["usable"] else "没有可用的 agent") + f" · {cwhy}"
        convo = "".join(f"{'User' if h.get('role') == 'user' else 'Assistant'}: {str(h.get('text') or '')[:2000]}\n"
                        for h in (history or [])[-6:])
        prompt = (f"Earlier in this chat:\n{convo}\nNow the user says:\n{text}" if convo else text)
        run_id, t0, steps = uuid.uuid4(), utcnow(), []
        result_text, used, files = "", None, []
        for name in order:
            ad = self.pool.adapters[name]
            perms = WORKSPACE_WRITE if cat == "office" and ad.type == "codebuddy_local" else READ_ONLY
            ws = self.pool._workspace(run_id, "ask", name)
            step = self.pool._call(name, self.pool._task(name, prompt, system=ASK_SYSTEM, kind=cat, workspace=ws, permissions=perms,
                                                         timeout_s=None, want_json=False), "run")
            steps.append(step)
            if step.result.ok:
                result_text, used = step.result.text, name
                files = [str(p) for p in Path(ws).rglob("*") if p.is_file() and not p.name.startswith(".")][:20]
                break
        res = PoolResult(bool(used), result_text, "ask", "single",
                         {"agent": used, "category": cat, "why": why, "files": files, "tried": order}, steps,
                         error=None if used else "; ".join(f"{s.result.agent}: {s.result.error}" for s in steps)[:800] or "no agent available")
        res.run_id = run_id
        self.pool._record(res, text, user, None, None, t0)
        last = steps[-1].result if steps else None
        return {"ok": res.ok, "agent": used, "category": cat, "why": why, "text": result_text, "error": res.error,
                "files": files, "tried": [{"agent": s.result.agent, "status": s.result.status, "error": s.result.error} for s in steps],
                "duration_s": round((utcnow() - t0).total_seconds(), 1), "cost_usd": last.cost_usd if last else None,
                "run_id": str(run_id)}

    # -------------------------------------------------------------- long-term work

    def delegate(self, kind: str, tier: int, system: str, messages: list[dict[str, str]], max_tokens: int) -> "LLMResult | None":
        if not (self.cfg.get("enabled") and self.cfg.get("long_tasks")):
            return None
        cat = self.category_of_task(kind)
        if cat is None or cat == "quick":
            return None
        want_json = "json" in (system or "").lower() or "json" in (messages[-1].get("content", "") if messages else "").lower()[-400:]
        prompt = "\n\n".join(([f"<instructions>\n{system}\n</instructions>"] if system else [])
                             + [m["content"] if len(messages) == 1 else f"[{m['role']}]\n{m['content']}" for m in messages])
        from pga.agent.common import ModelOutputError, parse_json
        from pga.llm.router import LLMResult
        run_id, t0, steps, tried = uuid.uuid4(), utcnow(), [], 0
        for name in self.route(cat):
            ad = self.pool.adapters[name]
            if ad.type == "llm":                     # PGA's own model is next in line: let the router call it directly
                break
            if tried >= 2:
                break
            tried += 1
            step = self.pool._call(name, self.pool._task(name, prompt, system="", kind=cat, workspace=self.pool._workspace(run_id, f"task-{kind}", name),
                                                         permissions=READ_ONLY, timeout_s=None, want_json=want_json), "run")
            steps.append(step)
            ok = step.result.ok and step.result.text.strip()
            if ok and want_json:
                try:
                    parse_json(step.result.text)
                except ModelOutputError:
                    step.result.ok, step.result.status, step.result.error = False, "FAILED", "reply was not the JSON the task needs"
                    ok = False
            if ok:
                self._log(run_id, kind, cat, steps, True, step.result.text, t0)
                return LLMResult(text=step.result.text, input_tokens=0, output_tokens=0, model=f"{name}:{step.result.model or 'agent'}",
                                 provider=name, tier=tier)
        if steps:
            self._log(run_id, kind, cat, steps, False, "", t0)
        return None

    def _log(self, run_id: uuid.UUID, kind: str, cat: str, steps: list, ok: bool, text: str, t0: datetime) -> None:
        res = PoolResult(ok, text, f"task:{kind}"[:40], "single", {"category": cat, "agent": steps[-1].result.agent if ok else None}, steps,
                         error=None if ok else "; ".join(f"{s.result.agent}: {s.result.error}" for s in steps)[:800] + " → PGA 自己的模型接手")
        res.run_id = run_id
        self.pool._record(res, f"[{kind}] (long-term work)", None, None, None, t0)


def make_delegate(rt: "Runtime"):
    """The hook the Runtime installs on its LLM router. Cheap when routing is off or the kind stays on our model."""
    def delegate(kind: str, tier: int, system: str, messages: list[dict[str, str]], max_tokens: int) -> Any:
        cfg = load()["routing"]
        if not (cfg.get("enabled") and cfg.get("long_tasks")):
            return None
        if not any(kind in (v or []) for c, v in (cfg.get("task_kinds") or {}).items() if c != "quick"):
            return None
        return AgentRouter(rt).delegate(kind, tier, system, messages, max_tokens)
    return delegate
