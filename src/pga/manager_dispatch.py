"""A category manager's dispatcher: plan fast with a model, then schedule with your own ranking — no model.

Two stages, the split most open multi-agent orchestrators make (Magentic-One's task ledger vs. its orchestrator,
CrewAI's hierarchical manager vs. its workers, a LangGraph supervisor vs. the nodes it routes to):

- **plan** — DeepSeek's fast model reads the paragraph and returns at most four tasks: a title, the full words, the kind
  of work (code / serious / office / quick, the categories of agents.yaml → routing), which existing conversation's
  context it needs (if any), and a group: tasks that share one context and must happen in order. Budget ~2 s; on a
  timeout or a bad answer the whole paragraph becomes one task, its kind classified by rules.
- **schedule** — the Kubernetes scheduler's filter → score → bind, on PGA's own data:
    filter  usable agents for the task's kind (enabled, connected, quota above min_remaining); outside 日常对话 only
            agents that work in a folder (Claude Code, Codex, …), not plain chat models
    score   AgentRouter.rank — your preference order, quality, speed, cost, remaining usage, your marks, the arena —
            minus its load (runs in flight / its slots), minus a spread penalty for work this plan already gave it,
            plus affinity for the agent that last answered the conversation whose context the task needs
            (the sticky-session idea: its native session and cache are warm)
    bind    tasks of one group become one job — one conversation, one agent, the steps in order — so a shared
            context is built once instead of in parallel copies that disagree

The page runs each job in a new conversation: grown from the manager's note, or — when it needs an existing
conversation's context — branched from the end of that conversation, which is left as it was.
"""
from __future__ import annotations

import asyncio
import json
import os
import re
import time
from pathlib import Path

POLICY = Path(__file__).with_name('manager_policy.txt').read_text(encoding='utf-8')
BUDGET = 2.0             # the model's share of the 3 s: ranking runs alongside, the page needs the rest
KINDS = ('code', 'serious', 'office', 'quick')
HARD = {k: i for i, k in enumerate(KINDS)}   # the most demanding kind of a job's steps decides who can do it
W_LOAD, W_SPREAD, W_AFFINITY = 2.0, 0.5, 1.0
FREE_CATEGORIES = {'日常对话', ''}          # the one category whose tasks may go to plain chat models


def _kind(text: str) -> str:
    from pga.agents.routing import classify
    return classify(text)[0]


def fallback(text: str) -> list[dict]:
    return [{'title': text[:24], 'text': text, 'kind': _kind(text), 'context': '', 'group': ''}]


def segments(text: str) -> list[str]:
    """The request in numbered pieces — lines, then sentences — so the model answers with numbers, not rewritten text
    (its output is what takes the time)."""
    out = []
    for line in re.split(r'\n+', text or ''):
        out += [p.strip() for p in re.findall(r'[^。！？；!?;]+[。！？；!?;]*', line) if p.strip()]
    return out[:40] or [text]


async def _deepseek(text, context, candidates=()):
    import httpx
    from pga.llm import catalog
    cfg = catalog.load().get('providers', {}).get('deepseek', {})
    key = catalog.get_key(cfg.get('key_env') or 'DEEPSEEK_API_KEY')
    if not key:
        raise ValueError('DeepSeek key unavailable')
    ask = {'request': [f'[{i + 1}] {p}' for i, p in enumerate(segments(text))], 'context': context[:2000],
           'conversations': [f"{c['key']} | {c['title']}" for c in candidates]}
    async with httpx.AsyncClient(timeout=BUDGET) as client:
        response = await client.post((cfg.get('base_url') or 'https://api.deepseek.com').rstrip('/') + '/chat/completions',
            headers={'Authorization': 'Bearer ' + key}, json={'model': 'deepseek-chat', 'max_tokens': 400, 'temperature': 0,
            'messages': [{'role': 'system', 'content': POLICY}, {'role': 'user', 'content': json.dumps(ask, ensure_ascii=False)}]})
        response.raise_for_status()
        return response.json()['choices'][0]['message']['content']


def _clean(data, keys: set[str], text: str = '') -> list[dict]:
    """The model's tasks, each made of the request's own pieces (`parts`, numbered from 1) plus an optional short
    `note`; pieces no task took go to the first, so nothing you wrote is dropped."""
    tasks = data.get('tasks') if isinstance(data, dict) else None
    if not isinstance(tasks, list) or not 1 <= len(tasks) <= 4:
        raise ValueError('invalid task list')
    seg, used, out = segments(text), set(), []
    for t in tasks:
        if not isinstance(t, dict):
            raise ValueError('invalid task')
        if str(t.get('agent') or '') == 'manager' or str(t.get('context') or '') == 'manager':
            raise ValueError('the manager does not take tasks itself')
        parts = [int(x) for x in (t.get('parts') or []) if str(x).isdigit() and 1 <= int(x) <= len(seg)]
        body = ''.join(seg[i - 1] for i in sorted(set(parts))) if parts else str(t.get('text') or '').strip()
        if not body:
            raise ValueError('invalid task')
        used.update(parts)
        note = str(t.get('note') or '').strip()[:120]
        kind, ctx = str(t.get('kind') or ''), str(t.get('context') or '')
        out.append({'title': str(t.get('title') or body)[:40], 'text': (body + ('\n要求：' + note if note else ''))[:8000],
                    'kind': kind if kind in KINDS else _kind(body),
                    'context': ctx if ctx in keys else '', 'group': str(t.get('group') or '')[:16]})
    rest = ''.join(p for i, p in enumerate(seg, 1) if i not in used)
    if rest and any(t.get('parts') for t in tasks):
        out[0]['text'] += '\n\n（原需求中的其余内容，一并处理：）' + rest
    return out


def jobs_of(tasks: list[dict]) -> list[dict]:
    """Tasks of one group → one job (affinity); the rest one job each, in the order given."""
    jobs, by = [], {}
    for t in tasks:
        g = t.get('group') or ''
        if g and g in by:
            by[g]['steps'].append(t)
            continue
        job = {'steps': [t]}
        jobs.append(job)
        if g:
            by[g] = job
    for j in jobs:
        st = j.pop('steps')
        j['kind'] = min((s['kind'] for s in st), key=lambda k: HARD.get(k, 9))
        j['context'] = next((s['context'] for s in st if s.get('context')), '')
        j['steps'] = len(st)
        if len(st) == 1:
            j['title'], j['text'] = st[0]['title'], st[0]['text']
        else:
            j['title'] = ' → '.join(s['title'] for s in st)[:40]
            j['text'] = ('按顺序完成下面几项。它们共用同一份上下文，后一项可能要用前一项的结果：\n\n'
                         + '\n\n'.join(f"{i + 1}. {s['title']}\n{s['text']}" for i, s in enumerate(st)))
    return jobs


def schedule(jobs: list[dict], ranks: dict, *, tools_only: bool, load: dict, affinity: dict, labels: dict | None = None) -> list[dict]:
    """Bind each job to an agent. `ranks`: kind → AgentRouter.rank rows (with a `tools` flag); `load`: agent →
    (running, slots); `affinity`: conversation key → the agent that last answered it. The most demanding jobs pick first."""
    planned: dict[str, int] = {}
    for i in sorted(range(len(jobs)), key=lambda i: HARD.get(jobs[i]['kind'], 9)):
        j = jobs[i]
        rows = [r for r in ranks.get(j['kind']) or [] if r.get('usable')]
        tooled = [r for r in rows if r.get('tools')]
        relaxed = tools_only and not tooled
        scored = []
        for r in (tooled if tools_only and tooled else rows):
            name = r['agent']
            running, slots = load.get(name, (0, 1))
            given = planned.get(name, 0)
            sticky = W_AFFINITY if j['context'] and affinity.get(j['context']) == name else 0.0
            s = r['score'] - W_LOAD * (running + given) / max(1, slots) - W_SPREAD * given + sticky
            scored.append((s, r, running, slots, sticky))
        if not scored:
            j.update(agent=None, tools=False, fallback=[], why='没有可用的 agent（都没连上、停用或用量不足）')
            continue
        scored.sort(key=lambda x: -x[0])
        s, r, running, slots, sticky = scored[0]
        j['fallback'] = [x[1]['agent'] for x in scored[1:4]]   # if it fails: the next by the same score, in order
        planned[r['agent']] = planned.get(r['agent'], 0) + 1
        parts = [f"{(labels or {}).get(j['kind'], j['kind'])} · 综合分 {s:.2f}"]
        if r.get('preference'):
            parts.append(f"你的排序第 {r['preference']}")
        if r.get('remaining') is not None:
            parts.append(f"剩余用量 {r['remaining'] * 100:.0f}%")
        parts.append(f"在跑 {running}/{slots}")
        if sticky:
            parts.append('上次处理过这段上下文')
        if relaxed:
            parts.append('没有可用的带权限 agent，改用对话模型')
        j.update(agent=r['agent'], tools=bool(r.get('tools')), why='，'.join(parts))
    return jobs


def _ranks(rt, user_id) -> tuple[dict, dict, dict]:
    """Every kind's ranking by your formula, each agent's load right now, and the categories' labels. Runs in a thread
    beside the model call, on a session of its own (the request's may be closed if the deadline passes first)."""
    from pga.db import get_sessionmaker
    from pga.runtime import Runtime
    session = get_sessionmaker()()
    try:
        return _ranks_on(Runtime(session), user_id)
    finally:
        session.close()


def _ranks_on(rt, user_id) -> tuple[dict, dict, dict]:
    from pga.agents.pool import _SEMAPHORES, _SEM_LOCK
    from pga.agents.routing import AgentRouter
    router = AgentRouter(rt)
    ranks = {}
    for kind in KINDS:
        rows = router.rank(kind, user_id=user_id)
        for r in rows:
            ad = router.pool.adapters.get(r['agent'])
            r['tools'] = bool(ad and ad.type != 'llm')
        ranks[kind] = rows
    load = {}
    with _SEM_LOCK:
        sems = dict(_SEMAPHORES)
    for name, a in router.pool.cfg['agents'].items():
        slots = int(a.get('max_concurrent') or 1)
        sem = sems.get(f'{name}:{slots}')
        load[name] = (max(0, slots - getattr(sem, '_value', slots)) if sem else 0, slots)
    labels = {k: (v or {}).get('label', k) for k, v in (router.cfg.get('categories') or {}).items()}
    return ranks, load, labels


def workspace(rt, user, project: str) -> dict:
    """The folder of the registered project named like the category (only when exactly one matches), so tasks given
    to agents with tools work in it."""
    from pga.projects import Projects
    if not project or project in FREE_CATEGORIES:
        return {}
    ps = [p for p in Projects(rt.session).list(user.id) if p.name.casefold() == project.casefold() and os.path.isdir(p.path)]
    if len(ps) != 1:
        return {}
    return {'folder': ps[0].path, 'access': 'write', 'mcp': False}


async def plan(text, context='', *, rt=None, user=None, project='', candidates=None):
    t0 = time.monotonic()
    if rt is not None and user is not None and project:
        from pga import project_context
        scope = project_context.overview(rt, user, project)
        candidates = [{'key': c['key'], 'title': c['title']} for c in scope['conversations']]
        context = project_context.brief(rt, user, project)
    cands = [{'key': str(c.get('key'))[:120], 'title': re.sub(r'\s+', ' ', str(c.get('title') or ''))[:60]}
             for c in (candidates or []) if isinstance(c, dict) and c.get('key')][:20]
    ranking = asyncio.create_task(asyncio.to_thread(_ranks, rt, user.id)) if rt is not None and user is not None else None
    try:
        from pga.agent.common import parse_json
        tasks, planner = _clean(parse_json(await asyncio.wait_for(_deepseek(text, context, cands), BUDGET)),
                                {c['key'] for c in cands}, text), 'deepseek'
    except Exception:  # noqa: BLE001 - any failure: the whole paragraph as one task, on time
        tasks, planner = fallback(text), 'rules'
    jobs = jobs_of(tasks)
    tools_only = project not in FREE_CATEGORIES
    out = {'planner': planner, 'fallback': planner != 'deepseek', 'tools_only': tools_only}
    if ranking is None:
        out['tasks'] = [{**j, 'agent': None, 'why': ''} for j in jobs]
        return out
    try:
        ranks, load, labels = await asyncio.wait_for(ranking, max(.3, 2.6 - (time.monotonic() - t0)))
    except Exception:  # noqa: BLE001 - no ranking in time: the page asks with agent "auto" (the same formula, at send time)
        out['tasks'] = [{**j, 'agent': None, 'why': '排序超时，发送时按你的排序自动选择'} for j in jobs]
        return out
    from pga.agents.routing import AgentRouter
    router, affinity = AgentRouter(rt), {}
    for j in jobs:
        if j['context'] and j['context'] not in affinity:
            last = router.last_turn(user, j['context'])
            affinity[j['context']] = (last or {}).get('agent')
    out['tasks'] = schedule(jobs, ranks, tools_only=tools_only, load=load, affinity=affinity, labels=labels)
    out['workspace'] = workspace(rt, user, project)
    out['ms'] = round((time.monotonic() - t0) * 1000)
    return out
