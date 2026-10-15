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
import time
import uuid
from datetime import datetime
from pathlib import Path
from typing import TYPE_CHECKING, Any

from pga.agents import quota as quotas
from pga.agents.base import FULL, READ_ONLY, WORKSPACE_WRITE
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


def _save_images(images: list[dict] | None, ws: str) -> list[str]:
    """Pictures you attached (data URLs) → files in the conversation's folder, so every kind of agent can get them."""
    import base64
    import re as _re
    out = []
    for i, im in enumerate((images or [])[:6]):
        m = _re.match(r"data:(image/(png|jpeg|jpg|gif|webp));base64,(.+)", str(im.get("data") or ""), _re.S)
        if not m:
            continue
        raw = base64.b64decode(m.group(3), validate=False)
        if len(raw) > 8_000_000:
            continue
        d = Path(ws) / "uploads"
        d.mkdir(parents=True, exist_ok=True)
        stem = _re.sub(r"[^A-Za-z0-9_.-]", "_", str(im.get("name") or f"image-{i + 1}"))[:40].rsplit(".", 1)[0] or f"image-{i + 1}"
        p = d / f"{int(time.time())}-{i + 1}-{stem}.{'jpg' if m.group(2) in ('jpeg', 'jpg') else m.group(2)}"
        p.write_bytes(raw)
        out.append(str(p))
    return out


def _project_note(project, adapter_type: str) -> str:
    if adapter_type == "llm":
        return (f"\n\nThe user is asking about their project \"{project.name}\" ({project.path}). You cannot open its files; "
                "answer from what they tell you and say what you would need to see."
                + (f" The project serves their long-range aim: {project.aim.text_en}" if getattr(project, "aim", None) else ""))
    full = bool(project.full_access)
    return (f"\n\nYou are working in the user's project \"{project.name}\" at {project.path} (your working directory). "
            + ("You may run commands and edit files there. Work carefully, keep changes focused, and say exactly what you changed "
               "and how you checked it." if full else
               "You may read its files but not change them; if a change is needed, describe it precisely.")
            + (f"\nThe user's notes about this project: {project.notes}" if project.notes else "")
            + (f"\nThis folder serves the user's long-range aim: {project.aim.text_en}" if getattr(project, "aim", None) else ""))


def _reader_lang(user: "User | None") -> str:
    if user is None:
        return "zh-CN"
    pref = (user.preferences or {}).get("output_language")
    return pref if pref and pref != "mirror_input" else (user.locale or "zh-CN")


def _live_translator(rt: "Runtime", lang: str):
    """A plain, fast translation call for the live paragraphs (PGA's own model, tier 1; no database, safe in a thread)."""
    prov, model = rt.router.provider, rt.router.model_for(1)
    name = "Simplified Chinese" if lang.lower().startswith("zh") else lang
    system = (f"Translate the user's text into {name}. Keep Markdown structure, code blocks, inline code, URLs, file paths, "
              "commands and names unchanged. Output only the translation.")

    def tr(piece: str) -> str:
        return prov.complete(model=model, system=system, messages=[{"role": "user", "content": piece}],
                             max_tokens=min(4000, len(piece) * 2 + 200), temperature=None).text
    return tr


def _save_files(files: list[dict] | None, ws: str) -> list[str]:
    """Documents you attached (data URLs, ≤20 MB each) → files in the conversation's folder."""
    import base64
    import re as _re
    out = []
    for i, f in enumerate((files or [])[:6]):
        m = _re.match(r"data:[^;,]*(;[^,]*)?;base64,(.+)", str(f.get("data") or ""), _re.S)
        if not m:
            continue
        raw = base64.b64decode(m.group(2), validate=False)
        if len(raw) > 20_000_000:
            continue
        d = Path(ws) / "uploads"
        d.mkdir(parents=True, exist_ok=True)
        name = _re.sub(r"[^\w.\-]", "_", str(f.get("name") or f"file-{i + 1}"))[:80] or f"file-{i + 1}"
        p = d / f"{int(time.time())}-{i + 1}-{name}"
        p.write_bytes(raw)
        out.append(str(p))
    return out


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
        """Each agent's quota is looked up once per router (one request): ranking asks for it again per category."""
        memo = self.__dict__.setdefault("_quota_memo", {})
        if name not in memo:
            ad = self.pool.adapters.get(name)
            memo[name] = quotas.for_agent(self.rt.session, name, self.pool.cfg["agents"].get(name, {}), ad.type if ad else "")
        return memo[name]

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
            now: datetime | None = None, category: str | None = None, conversation: str | None = None,
            context: str | None = None, model: str | None = None, effort: str | None = None,
            images: list[dict] | None = None, files: list[dict] | None = None, translate: bool = False,
            project=None) -> dict:
        """`conversation` (a card's id) keeps one thread / session per agent: an agent that still has it hears only
        the new message; one that does not gets the recent history written into the prompt.

        `model` / `effort` are what you picked for a named agent (its own default otherwise); `images` are pictures
        you attached ({name, data: data URL}) — only agents that take images are asked. `files` are documents (PDF, Word,
        Excel, PowerPoint, text, code): read here and given to the agent as text (an agent that opens files gets the path too)."""
        from pga.agents.options import options as agent_options
        if category and category not in (self.cfg.get("categories") or {}):
            raise ValueError(f"unknown category {category!r}")
        cat, cwhy = (category, "你在这一类里提问") if category else classify(text)
        if agent and agent != "auto":
            if agent not in self.pool.adapters:
                raise ValueError(f"unknown agent {agent!r}")
            order, why = [agent], f"你指定了 {agent}"
            if images and not agent_options(agent, self.pool.adapters[agent], self.pool.cfg["agents"][agent], self.rt)["images"]:
                raise ValueError(f"{agent} 不能看图片：换一个能看图的 agent（ChatGPT、Claude、WorkBuddy），或去掉图片")
        else:
            ranked = self.rank(cat, now)
            order = [x["agent"] for x in ranked if x["usable"]]
            if project is not None:                       # a project: only agents that can open its files
                order = [n for n in order if self.pool.adapters[n].type != "llm"]
            if images:                                    # pictures: only agents that can see them
                order = [n for n in order if agent_options(n, self.pool.adapters[n], self.pool.cfg["agents"][n], self.rt)["images"]]
            order = order[:3]
            why = (ranked[0]["why"] if ranked and ranked[0]["usable"] else "没有可用的 agent") + f" · {cwhy}" + (" · 带图片" if images else "")
            model = effort = None                        # a model you picked belongs to one agent, not to a whole category
        lang = _reader_lang(user)
        asked = text                                       # what you typed (kept for the record and the screen)
        if translate and user is not None:                 # 翻译: the agent hears English, you read your own language
            try:
                text = self.rt.gateway.to_canonical(text, user.id)[0] or text
            except Exception:  # noqa: BLE001 - untranslated is better than nothing
                pass
        hist = [h for h in (history or [])[-6:] if isinstance(h, dict)]
        convo = "".join(f"{'User' if h.get('role') == 'user' else 'Assistant'}: {str(h.get('text') or '')[:2000]}\n" for h in hist)
        conv = f"{user.id if user else 'anon'}:{str(conversation)[:80]}" if conversation else None
        prompt = (f"Earlier in this chat:\n{convo}\nNow the user says:\n{text}" if convo else text)
        run_id, t0, steps = uuid.uuid4(), utcnow(), []
        result_text, used, docs, attached = "", None, files, []
        files = []
        for name in order:
            ad = self.pool.adapters[name]
            perms = WORKSPACE_WRITE if cat == "office" and ad.type == "codebuddy_local" else READ_ONLY
            ws = self.pool.conversation_workspace(name, conv) if conv else self.pool._workspace(run_id, "ask", name)
            if project is not None:                       # the work happens in your project, whichever agent does it
                ws, perms = project.path, (FULL if project.full_access else READ_ONLY)
            before = time.time()
            pics = _save_images(images, ws)
            said, prompt_now = text, prompt
            if docs:                                      # documents: their text goes with the question
                from pga.agents.files import attachments_block
                paths = _save_files(docs, ws)
                block, attached = attachments_block(paths)
                said = f"{text}\n\n{block}"
                prompt_now = prompt.replace(text, said) if text in prompt else f"{prompt}\n\n{block}"
            meta = {"category": cat, "workflow": "chat", "history": [{"role": h.get("role"), "text": str(h.get("text") or "")[:4000]} for h in hist],
                    "new_text": said, **({"conversation": conv} if conv else {}), **({"model": model} if model else {}),
                    **({"translate": _live_translator(self.rt, lang)} if translate else {}),
                    **({"project": {"id": str(project.id), "name": project.name, "path": project.path}} if project is not None else {}),
                    **({"effort": effort} if effort else {}), **({"images": pics} if pics else {})}
            system = ASK_SYSTEM + (f"\n\n{context}" if context else "") + (_project_note(project, ad.type) if project is not None else "") + (
                "\n\nThe user's message was translated into English for you. Reply in English; it is translated back." if translate else "")
            step = self.pool._call(name, self.pool._task(name, prompt_now, system=system, kind=cat, workspace=ws, permissions=perms,
                                                         timeout_s=None, want_json=False, meta=meta), "run")
            steps.append(step)
            if step.result.status == "STOPPED":            # you stopped it: no other agent takes over
                result_text, used = step.result.text, name if step.result.ok else None
                break
            if step.result.ok:
                result_text, used = step.result.text, name
                if project is not None:
                    from pga.projects import changed_files
                    files = changed_files(project.path, before - 1)
                else:
                    files = [str(p) for p in Path(ws).rglob("*") if p.is_file() and not p.name.startswith(".") and "uploads" not in p.parts
                             and p.stat().st_mtime >= before - 1][:20]              # what this answer wrote
                break
        original = None
        if translate and result_text and user is not None:  # the settled answer, translated whole (the live one was by paragraph)
            try:
                original, result_text = result_text, self.rt.gateway.render(result_text, lang, user.id).text or result_text
            except Exception:  # noqa: BLE001
                original = None
        res = PoolResult(bool(used), result_text, "ask", "single",
                         {"agent": used, "category": cat, "why": why, "files": files, "tried": order,
                          "model": steps[-1].result.model if used else None, "effort": (steps[-1].result.data or {}).get("effort") or effort if used else None,
                          "images": len(images or []), "attachments": attached,
                          **({"project": {"id": str(project.id), "name": project.name, "full": bool(project.full_access)}} if project is not None else {}),
                          **({"translated": True, "original": original[:50000], "sent": text[:20000]} if original else {}),
                          "stopped": bool(steps and steps[-1].result.status == "STOPPED"),
                          **({"conversation": str(conversation)[:80]} if conversation else {})}, steps,
                         error=None if used else "; ".join(f"{s.result.agent}: {s.result.error}" for s in steps)[:800] or "no agent available")
        res.run_id = run_id
        self.pool._record(res, asked, user, None, None, t0)
        last = steps[-1].result if steps else None
        return {"ok": res.ok, "agent": used, "category": cat, "why": why, "text": result_text, "error": res.error,
                "files": files, "tried": [{"agent": s.result.agent, "status": s.result.status, "error": s.result.error} for s in steps],
                "duration_s": round((utcnow() - t0).total_seconds(), 1), "cost_usd": last.cost_usd if last else None,
                "run_id": str(run_id), "model": res.data.get("model"), "effort": res.data.get("effort"),
                "stopped": res.data.get("stopped"), "attachments": attached,
                "original": original, "sent": text if translate and text != asked else None, "project": res.data.get("project")}

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
        order = self.route(cat)
        member = self._team_member(kind)
        if member and member in self.pool.adapters and self.pool.usable(member, self.pool.spent_today())[0]:
            order = [member] + [n for n in order if n != member]       # the aim's own teammate for this kind of work
        for name in order:
            ad = self.pool.adapters[name]
            if ad.type == "llm":                     # PGA's own model is next in line: let the router call it directly
                break
            if tried >= 2:
                break
            tried += 1
            step = self.pool._call(name, self.pool._task(name, prompt, system="", kind=cat, workspace=self.pool._workspace(run_id, f"task-{kind}", name),
                                                         permissions=READ_ONLY, timeout_s=None, want_json=want_json,
                                                         meta={"category": cat, "task_kind": kind, "workflow": "long-term"}), "run")
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

    def _team_member(self, kind: str) -> str | None:
        from pga.llm.router import CURRENT_RESP
        from pga.teams import TASK_ROLE, TeamService
        rid, role = CURRENT_RESP.get(), TASK_ROLE.get(kind)
        if not rid or not role:
            return None
        from pga.db.models import Aim, Responsibility
        r = self.rt.session.get(Responsibility, rid)
        aim = self.rt.session.get(Aim, r.aim_id) if r is not None and r.aim_id else None
        if aim is None:
            return None
        try:
            return TeamService(self.rt).member(aim, role)
        except Exception:  # noqa: BLE001 - the team is a preference, routing still works without it
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
