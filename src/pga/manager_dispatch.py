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

Workers reuse a related conversation, start an independent Q&A thread, or use the execution conversation. The manager document displays status and navigation only.
"""
from __future__ import annotations

import asyncio
import json
import os
import re
import time
import threading
import uuid
from concurrent.futures import ThreadPoolExecutor
from pathlib import Path

POLICY = Path(__file__).with_name('manager_policy.txt').read_text(encoding='utf-8')
BUDGET = 1.65             # the model's share of the 3 s: ranking runs alongside, the page needs the rest
# These reads may outlive a request. asyncio.run() joins its default executor on exit.
_rank_pool = ThreadPoolExecutor(max_workers=4, thread_name_prefix='manager-rank')
KINDS = ('code', 'serious', 'office', 'quick')
HARD = {k: i for i, k in enumerate(KINDS)}   # the most demanding kind of a job's steps decides who can do it
W_LOAD, W_SPREAD, W_AFFINITY = 2.0, 0.5, 1.0
FREE_CATEGORIES = {'日常对话', ''}          # the one category whose tasks may go to plain chat models


# Reserve a FIFO slot before launching each worker; one target never runs two manager tasks at once.
_pending_lock = threading.Lock()
_pending_tails = {}

def execution_slot(user_id, key):
    identity = (str(user_id), key)
    done = threading.Event()
    with _pending_lock:
        previous = _pending_tails.get(identity)
        _pending_tails[identity] = done
    def release():
        done.set()
        with _pending_lock:
            if _pending_tails.get(identity) is done:
                _pending_tails.pop(identity, None)
    return previous, release


def destination(text, kind=''):
    """Offline fallback: requests to change/create something go to execution."""
    question = re.match(r'\s*(?:请)?(?:解释|说明|为什么|如何|怎么|what\b|why\b|how\b)', text, re.I)
    if question and not re.search(r'并(?:实现|修复|修改|生成)|然后(?:实现|修复|修改|生成)', text):
        return 'qa'
    action = re.search(r'实现|修复|修改|改成|开发|部署|生成|制作|创建|删除|安装|重启|写入|导出|implement|fix|deploy|create|install', text, re.I)
    return 'execute' if action or kind in ('code', 'office') else 'qa'


def _kind(text: str) -> str:
    from pga.agents.routing import classify
    return classify(text)[0]


def needs_code(task: dict) -> bool:
    """Use the planner's per-step decision, or infer it when planning was offline."""
    text = task.get('text', '')
    if re.search(r'不(?:用|需要|必|要)(?:写|改|修改|编写|提供)(?:任何)?代码|without (?:writing )?code', text, re.I):
        return False
    # UI change requests often describe a gesture and its desired behavior without naming code.
    if (not re.search(r'为什么|为何|怎么|如何|请解释|是什么意思|[?？]', text)
            and re.search(r'右键|左键|双击|按钮|菜单|工具栏|标签栏|滚动条', text)
            and re.search(r'不要(?:再)?(?:显示|弹出)|不再(?:显示|弹出)|只(?:负责|允许|用于)|改为|改成', text)):
        return True
    if isinstance(task.get('needs_code'), bool):
        return task['needs_code']
    kind = task.get('kind', '')
    target = task.get('destination') or destination(text, kind)
    if target == 'qa' and re.search(r'请(?:给出|提供|写出).{0,8}(?:实现|代码|脚本)', text):
        return True
    if target == 'qa' and destination(text, 'code') == 'qa':
        return False
    if re.search(r'(?:写|编写|补全|修改|重构|实现|修复|开发|添加|新增).{0,12}(?:代码|脚本|函数|接口|功能|组件|单元测试|单测|程序|页面)|'
                 r'\b(?:write|implement|refactor|fix)\b.{0,30}\b(?:code|script|function|feature|test|bug)\b', text, re.I):
        return True
    return kind == 'code' and target == 'execute' and bool(re.search(
        r'实现|修复|修改|改成|开发|重构|编写|补全|添加|新增|写|\b(?:implement|fix|refactor|write|add|change|update)\b', text, re.I))


def fallback(text: str) -> list[dict]:
    kind = _kind(text)
    if needs_code({'text': text, 'kind': kind}):
        kind = 'code'
    return [{'title': text[:24], 'text': text, 'kind': kind, 'context': '', 'group': '', 'destination': destination(text, kind)}]


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
           'conversations': [f"{c['key']} | {c['title']} | {str(c.get('detail') or '')[:220]} | {c.get('at', '')}" for c in candidates]}
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
                    **({'needs_code': t['needs_code']} if isinstance(t.get('needs_code'), bool) else {}),
                    'kind': kind if kind in KINDS else _kind(body),
                    'destination': t.get('destination') if t.get('destination') in ('qa', 'execute') else destination(body, kind),
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
        j['needs_code'] = any(needs_code(s) for s in st)
        j['kind'] = 'code' if j['needs_code'] else min((s['kind'] for s in st), key=lambda k: HARD.get(k, 9))
        j['context'] = next((s['context'] for s in st if s.get('context')), '')
        j['destination'] = 'execute' if any(s.get('destination', destination(s['text'], s['kind'])) == 'execute' for s in st) else 'qa'
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
    from pga.agents.routing import manager_order

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
            j.update(agent=None, tools=False, fallback=[], why='Codex 当前不可用，请检查连接和额度后重试')
            continue
        scored.sort(key=lambda x: -x[0])
        by_name = {item[1]['agent']: item for item in scored}
        coding = needs_code(j)
        order = manager_order(list(by_name), coding)
        s, r, running, slots, sticky = by_name[order[0]]
        j['fallback'] = order[1:4]   # if it fails: the next by the same score, in order
        planned[r['agent']] = planned.get(r['agent'], 0) + 1
        parts = [f"{(labels or {}).get(j['kind'], j['kind'])} · 综合分 {s:.2f}"]
        if r['agent'] == 'codex':
            parts.append('管理员默认使用 Codex')
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


def _ranks(bind, user_id, deadline, policy, provider) -> tuple[dict, dict, dict]:
    """Rank with an independent session on the same database as the submission."""
    from sqlalchemy.orm import Session
    from pga.runtime import Runtime
    with Session(bind) as session:
        return _ranks_on(Runtime(session, policy=policy, provider=provider), user_id, deadline)


def _ranks_on(rt, user_id, deadline) -> tuple[dict, dict, dict]:
    from pga.agents.pool import _SEMAPHORES, _SEM_LOCK
    from pga.agents.routing import AgentRouter
    router = AgentRouter(rt)
    router.quota_deadline = deadline
    ranks = {}
    for kind in KINDS:
        rows = router.rank(kind, user_id=user_id, manager_codex=True)
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
    return {'folder': ps[0].path, 'access': 'full', 'mcp': False}


def routing_candidates(rt, user, project, text):
    """Rank actual conversations, including assignments whose workers haven't answered yet."""
    from sqlalchemy import func, or_, select
    from pga import project_context as pc, projectsort, qa_pool
    from pga.db.models import AgentConversation, AgentRun, LinkedAgent, ThoughtNode, WorldNode
    from pga.project_context import tokens
    from pga.timeline import NOT_YOU

    manager = pc.manager_key(user, project)
    feeds = {item['key'] for item in pc.manager_feeds(manager).values()}
    keys = {k for k in pc.members(user, project) - feeds if not pc.is_manager(k) and not k.startswith('chat:mt-')}
    titles = (user.preferences or {}).get('chat_titles') or {}
    rows = {}
    def add(key, title, detail, at):
        if not key or key in feeds:
            return
        row = rows.setdefault(key, {'key': key, 'title': title, 'detail': '', 'at': ''})
        row['at'] = max(row['at'], at or '')
        if title and row['title'] in ('', '新对话'):
            row['title'] = title
        if detail and detail not in row['detail']:
            row['detail'] = (row['detail'] + ' ' + detail).strip()[:450]

    # The map includes edges, topics and complete histories. Routing only needs names,
    # the most recent questions in each member chat, and their timestamps.
    leaf_titles = dict(rt.session.execute(select(WorldNode.ref, WorldNode.title).where(
        WorldNode.user_id == user.id, WorldNode.ref.in_(keys))).all())
    names = {**leaf_titles, **titles}
    for key, draft in (projectsort.state(user).get('drafts') or {}).items():
        if key in keys:
            add(key, names.get(key) or '新对话', '', draft.get('at'))
    base = select(AgentRun).where(AgentRun.user_id == user.id, AgentRun.workflow == 'ask',
                                 AgentRun.parent_id.is_(None)).order_by(AgentRun.started_at.desc())
    conv = AgentRun.data['conversation'].as_string()
    order = (AgentRun.started_at, AgentRun.id)
    recent = (
        base.order_by(None)
        .where(conv.in_(keys), AgentRun.data['regen_of'].as_string().is_(None))
        .with_only_columns(
            conv.label('key'), func.substr(AgentRun.prompt, 1, 160).label('question'),
            func.first_value(func.substr(AgentRun.prompt, 1, 60)).over(partition_by=conv, order_by=order).label('title'),
            AgentRun.started_at,
            func.row_number().over(partition_by=conv, order_by=[c.desc() for c in order]).label('n'))
        .subquery()
    )
    query = select(recent.c.key, recent.c.title, recent.c.question, recent.c.started_at).where(
        recent.c.n <= 3).order_by(recent.c.started_at.desc())
    for key, title, question, at in rt.session.execute(query):
        add(key, names.get(key) or title, question, at.isoformat())

    def ids(prefix):
        result = []
        for key in keys:
            if key.startswith(prefix):
                try:
                    result.append(uuid.UUID(key[len(prefix):]))
                except ValueError:
                    continue
        return result

    imports = select(AgentConversation).join(LinkedAgent).where(
        LinkedAgent.user_id == user.id, AgentConversation.id.in_(ids('c:')))
    for c in rt.session.scalars(imports):
        questions = pc._said(c.excerpt)
        first = re.search(r'^User:\s?(.+)$', c.excerpt or '', re.M)
        title = '' if (c.title or '').startswith('ant: ') else c.title or ''
        if NOT_YOU.match(re.sub(r'^\[[^\]]*\]\s*', '', title)) or first and NOT_YOU.match(first[1]):
            continue
        key = 'c:' + str(c.id)
        add(key, names.get(key) or title or (first[1] if first else ''), ' '.join(questions),
            (c.updated_at or c.started_at or c.created_at).isoformat())
    for node in rt.session.scalars(select(ThoughtNode).where(ThoughtNode.user_id == user.id, ThoughtNode.id.in_(ids('n:')))):
        key = 'n:' + str(node.id)
        add(key, names.get(key) or node.title, '', node.created_at.isoformat())

    # The run id gives each pre-pool Q&A a stable isolated thread for future replies.
    query = base.where(or_(*(qa_pool.feed_filter(feed) for feed in feeds))).with_only_columns(
        AgentRun.id, AgentRun.data, func.substr(AgentRun.prompt, 1, 200),
        func.substr(AgentRun.output, 1, 200), AgentRun.started_at).limit(160)
    for run, data, question, answer, at in rt.session.execute(query):
        if data.get('regen_of') or data.get('note'):
            continue
        key = data['conversation']
        if key in feeds:
            key = qa_pool.turn_thread(key, run)
        add(key, question[:60], question + ' ' + (answer or ''), at.isoformat())
    query = base.where(AgentRun.data['conversation'].as_string() == manager).with_only_columns(
        AgentRun.data, AgentRun.started_at).limit(160)
    for data, at in rt.session.execute(query):
        for t in (data.get('dispatch') or {}).get('tasks', []):
            key = t.get('worker') or t.get('key')
            if qa_pool.summary_of(key) in feeds or key in rows:
                add(key, t.get('title') or '', (t.get('text') or '')[:200], at.isoformat())
    terms = tokens(text)
    for c in rows.values():
        c['overlap'] = len(terms & tokens(c['title'] + ' ' + c['detail']))
    return sorted(rows.values(), key=lambda c: (c['overlap'], c['at']), reverse=True)[:20]


def fallback_context(text, candidates):
    """When the planner is offline, only bind explicit references and clear follow-ups."""
    named = [c for c in candidates if c['key'] in text or
             (len(c['title']) >= 3 and any(q + c['title'] + end in text for q, end in [('「','」'), ('《','》'), ('“','”')]))]
    if len(named) == 1:
        return named[0]['key']
    if not re.search(r'继续|接着|上(?:一|次|面)|刚才|之前|刚刚|前面|再(?:解释|展开|说|详细)|follow.up|continue|previous', text, re.I):
        return ''
    ranked = [c for c in candidates if c.get('overlap', 0) >= 2]
    if ranked and (len(ranked) == 1 or ranked[0]['overlap'] > ranked[1]['overlap']):
        return ranked[0]['key']
    recent = sorted((c for c in candidates if c.get('at') and c.get('detail')),
                    key=lambda c: c['at'], reverse=True)
    if not ranked and recent and (len(recent) == 1 or recent[0]['at'] != recent[1]['at']) and re.search(
            r'刚才|刚刚|上一(?:条|个|问)|^(?:请)?(?:继续|接着)(?:说|解释|展开)?[。！!？?]?$', text):
        return recent[0]['key']
    return ''


async def plan(text, context='', *, rt=None, user=None, project='', candidates=None, reply_target=None):
    t0 = time.monotonic()
    if rt is not None and user is not None and project:
        from pga import project_context
        project = project_context.project_name(user, project)
        candidates = routing_candidates(rt, user, project, text)
        context = project
    cands = [{**c, 'key': str(c.get('key'))[:120], 'title': re.sub(r'\s+', ' ', str(c.get('title') or ''))[:60]}
             for c in (candidates or []) if isinstance(c, dict) and c.get('key')][:20]
    if reply_target:
        target = reply_target['key']
        cands = [reply_target] + [c for c in cands if c['key'] != target][:19]
        context = (f"用户点了 {target} 的「追问这条回答」。只把依赖所选回答的任务分配给它。"
                   "独立任务的 context 留空，依赖其他会话的任务使用对应的 key。\n" + context)
    ranking = None
    if rt is not None and user is not None:
        bind = rt.session.get_bind().engine
        ranking = asyncio.get_running_loop().run_in_executor(
            _rank_pool, _ranks, bind, user.id, t0 + 1.4, rt.policy, rt.provider)
    try:
        from pga.agent.common import parse_json
        remaining = max(0, t0 + BUDGET - time.monotonic())
        answer = await asyncio.wait_for(_deepseek(text, context, cands), remaining)
        tasks, planner = _clean(parse_json(answer), {c['key'] for c in cands}, text), 'deepseek'
    except Exception:  # noqa: BLE001 - any failure: the whole paragraph as one task, on time
        tasks, planner = fallback(text), 'rules'
        tasks[0]['context'] = fallback_context(text, cands)
    jobs = jobs_of(tasks)
    if reply_target and len(jobs) == 1 and (planner == 'rules' or not jobs[0]['context']):
        jobs[0]['context'] = reply_target['key']
    tools_only = project not in FREE_CATEGORIES
    out = {'planner': planner, 'fallback': planner != 'deepseek', 'tools_only': tools_only}
    if ranking is None:
        out['tasks'] = [{**j, 'agent': None, 'why': ''} for j in jobs]
        return out
    try:
        ranks, load, labels = await asyncio.wait_for(ranking, max(0, t0 + 2.45 - time.monotonic()))
    except TimeoutError:
        out['tasks'] = [{**j, 'agent': None, 'why': '分配超时，请重试'} for j in jobs]
        return out
    from pga.agents.routing import AgentRouter
    affinity = {}
    router = AgentRouter(rt) if any(j['context'] for j in jobs) else None
    for j in jobs:
        if j['context'] and j['context'] not in affinity:
            last = router.last_turn(user, j['context'])
            affinity[j['context']] = (last or {}).get('agent')
    out['tasks'] = schedule(jobs, ranks, tools_only=tools_only, load=load, affinity=affinity, labels=labels)
    out['workspace'] = workspace(rt, user, project)
    out['ms'] = round((time.monotonic() - t0) * 1000)
    return out
