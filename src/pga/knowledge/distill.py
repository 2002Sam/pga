"""Explicit, one-message knowledge capture: Markdown + YAML front matter, indexed as a Body.

The same answering agent supplies the content. A model cannot choose the output path or declare
success: PGA validates the returned block, writes the file, and records its provenance.
"""
from __future__ import annotations

import json
import math
import os
from pathlib import Path
import re
import threading
import time
from contextlib import contextmanager
import uuid

import yaml

from pga.db.models import AgentRun, Body, WorldNode
from pga.db.types import Origin, utcnow

ROOT = Path.home() / 'Documents/PGA/notes/knowledge'
_lock = threading.RLock()
_ID = re.compile(r'^[a-f0-9]{24}$')
MAX_TEXT = 200_000


def _index(user_id, kid):
    if not _ID.fullmatch(kid or ''):
        raise ValueError('知识记录编号无效')
    return ROOT / str(user_id) / '_index' / (kid + '.json')


def _write(path, text):
    path.parent.mkdir(parents=True, exist_ok=True)
    tmp = path.with_name(path.name + '.' + uuid.uuid4().hex + '.tmp')
    tmp.write_text(text, encoding='utf-8')
    tmp.replace(path)


def _save(user_id, item):
    item['updated_at'] = utcnow().isoformat()
    _write(_index(user_id, item['id']), json.dumps(item, ensure_ascii=False))


def read(user_id, kid):
    with _lock:
        item = json.loads(_index(user_id, kid).read_text())
        if item['status'] == 'generating' and item.get('pid') != os.getpid():
            item.update(status='failed', error='服务重启中断了本次整理；原会话内容仍保留，请重新发送整理请求。')
            _save(user_id, item)
        # Only the successful result is read as knowledge, never an agent's claimed file path.
        item['text'] = Path(item['path']).read_text() if item['status'] in ('generating', 'failed', 'ready', 'saved') and Path(item['path']).is_file() else ''
        return item


def listing(user_id, key=''):
    out = []
    for p in (ROOT / str(user_id) / '_index').glob('*.json'):
        try:
            item = read(user_id, p.stem)
            if not key or item['conversation'] == key:
                out.append({k: v for k, v in item.items() if k not in ('text', 'pid')})
        except (OSError, ValueError, KeyError):
            continue
    return sorted(out, key=lambda i: i['created_at'], reverse=True)[:200]


def _slug(text):
    return re.sub(r'[^\w\-一-鿿]+', '_', text).strip('._')[:70] or '未分类'


def create(rt, user, conversation, title, kid=None):
    from pga import projectsort
    from pga.worldtree import WorldTree, chat_node
    if not conversation or len(conversation) > 120:
        raise ValueError('需要来源会话')
    kid = kid or uuid.uuid4().hex[:24]
    with _lock:
        if _index(user.id, kid).exists():
            old = read(user.id, kid)
            if old['conversation'] != conversation:
                raise ValueError('这条知识记录属于另一段会话')
            return old
        wt = WorldTree(rt)
        nid = chat_node(user, conversation)
        node = wt.get(user, uuid.UUID(nid)) if nid else wt.leaf_of(user, conversation)
        if node and node.kind == 'leaf':
            node = rt.session.get(WorldNode, node.parent_id) if node.parent_id else None
        project = projectsort.project_of(projectsort.state(user), conversation, '')
        topic = ' / '.join(n.title for n in wt.path(node) if n.kind != 'root') if node else ''
        directory = ROOT / str(user.id) / _slug(project)
        if node:
            directory /= _slug(node.title) + '-' + str(node.id)[:8]
        item = {'id': kid, 'conversation': conversation, 'title': str(title).strip()[:120] or '对话知识汇总',
                'project': project, 'topic': topic, 'topic_id': str(node.id) if node else None,
                'path': str(directory / (kid + '.md')), 'status': 'queued', 'created_at': utcnow().isoformat()}
        _write(Path(item['path']), '')
        _save(user.id, item)
        return item


def claim(user_id, kid, conversation):
    with _lock:
        item = read(user_id, kid)
        if item['conversation'] != conversation:
            raise ValueError('知识记录与当前会话不一致')
        if item['status'] != 'queued':
            raise ValueError('这条知识整理已开始或已结束，请勿重复发送')
        item.pop('text', None)
        item.update(status='generating', pid=os.getpid())
        _save(user_id, item)
        return item


@contextmanager
def stream(user_id, item):
    """Persist a provisional Markdown draft while the answering agent streams it."""
    from pga.agents import live
    if not item:
        yield
        return
    buffers, last = {}, [0.0]
    marker = f'<PGA_KNOWLEDGE id="{item["id"]}">'
    def update(lid, delta):
        with _lock:
            raw = buffers.get(lid, '') + delta
            # Bound memory while retaining split opening tags and the complete draft.
            start = raw.find(marker)
            if start < 0:
                buffers[lid] = raw[-len(marker):]
                return
            raw = raw[start:][:MAX_TEXT + len(marker) + 100]
            buffers[lid] = raw
            content = raw[len(marker):].split('</PGA_KNOWLEDGE>', 1)[0]
            # A closing tag can arrive in several chunks.
            cut = content.rfind('<')
            if cut >= 0 and '</PGA_KNOWLEDGE>'.startswith(content[cut:]):
                content = content[:cut]
            if time.monotonic() - last[0] < .3 and '</PGA_KNOWLEDGE>' not in raw:
                return
            current = read(user_id, item['id'])
            if current['status'] != 'generating':
                return
            _write(Path(item['path']), content.strip()[:MAX_TEXT])
            last[0] = time.monotonic()
    with live.observe(f'{user_id}:{item["conversation"][:80]}', update):
        try:
            yield
        finally:
            for lid in list(buffers):
                last[0] = 0
                update(lid, '')


def instruction(item):
    return f'''[用户主动开启了“本次沉淀为知识”。这是本次输出要求。]
仍然正常回答用户的问题，并由你这个同一个 agent 根据当前会话可见的上下文及本次所得，额外整理一份可复用的知识汇总。
尽早输出知识草稿，随着梳理补全内容；用以下精确标签包住 Markdown 正文（不要把整个块包进代码围栏）：
<PGA_KNOWLEDGE id="{item['id']}">
# 简明具体的知识标题
## 核心结论
## 数据与证据
有数据时用表格，保留数值、单位、条件、时间和来源；没有数据时明确说明，不编造。
## 方法与适用范围
## 未确认事项与局限
## 来源
保留会话中实际出现的链接、文件引用或证据出处；区分已验证结果与推测。
</PGA_KNOWLEDGE>
只汇总实际可见的信息，缺失上下文要说明；不要宣称文件已经保存。PGA 会自动生成 YAML 元数据头，
将该块保存到项目/主题知识目录并索引，随后显示实际路径。你不需要另行创建文件，也不需要再调用另一个 agent。
除这份知识汇总外，照常完成用户本次请求，不要只返回标签块。'''


def fail(user_id, kid, error):
    with _lock:
        item = read(user_id, kid)
        if item['status'] in ('ready', 'saved'):
            return item
        item.pop('text', None)
        item.update(status='failed', error=str(error)[:1000])
        _save(user_id, item)
        return item


def finish(rt, user, kid, result):
    item = read(user.id, kid)
    raw = str(result.get('text') or '')
    if not result.get('ok') or result.get('stopped'):
        return fail(user.id, kid, result.get('error') or '本次回答被停止，尚未生成完整知识文件。')
    pattern = re.compile(r'<PGA_KNOWLEDGE\s+id=["\']' + re.escape(kid) + r'["\']>\s*(.*?)\s*</PGA_KNOWLEDGE>', re.S)
    matches = list(pattern.finditer(raw))
    if len(matches) != 1 or not matches[0][1].strip():
        return fail(user.id, kid, '回答已保留，但 agent 没有返回完整的知识汇总块；未生成知识文件。请开启“沉淀知识”再试。')
    content = matches[0][1].strip()
    if len(content) > MAX_TEXT or not re.search(r'^#\s+\S', content, re.M):
        return fail(user.id, kid, '汇总过大或缺少 Markdown 标题，未写入知识库。')
    # Metadata is generated by PGA, never trusted from model-supplied YAML.
    title = re.search(r'^#\s+(.+)', content, re.M)[1].strip()[:200]
    meta = {'id': kid, 'type': 'knowledge', 'title': title, 'created': item['created_at'],
            'source_chat': item['conversation'], 'source_run': result.get('run_id'),
            'agent': result.get('agent'), 'model': result.get('model'), 'project': item['project'],
            'topic': item['topic'], 'topic_id': item['topic_id'], 'tags': ['pga', 'conversation-knowledge']}
    text = '---\n' + yaml.safe_dump(meta, allow_unicode=True, sort_keys=False) + '---\n\n' + content + '\n'
    _write(Path(item['path']), text)
    body = Body(user_id=user.id, kind='database', title=title, title_en=title,
                description=content, description_en=content, origin=Origin.AGENT, compiled_at=utcnow(),
                data={'source': 'conversation-knowledge', 'file': item['path'], 'knowledge_id': kid,
                      'source_chat': item['conversation'], 'source_run': result.get('run_id'),
                      'project': item['project'], 'topic_id': item['topic_id'], 'chars': len(content),
                      'passages': math.ceil(len(content) / 1200)})
    rt.session.add(body)
    rt.session.flush()
    clean = (raw[:matches[0].start()] + raw[matches[0].end():]).strip()
    clean += f"\n\n知识已汇总：[ {title} ]({item['path'].replace(' ', '%20')})"
    run = rt.session.get(AgentRun, uuid.UUID(result['run_id'])) if result.get('run_id') else None
    if run and run.user_id == user.id:
        run.output = clean
        run.data = {**(run.data or {}), 'knowledge_id': kid, 'knowledge_file': item['path']}
    rt.session.commit()
    result['text'] = clean
    item.pop('text', None)
    item.update(status='ready', title=title, body_id=str(body.id), run_id=result.get('run_id'),
                agent=result.get('agent'), model=result.get('model'))
    _save(user.id, item)
    return {**item, 'text': text}
