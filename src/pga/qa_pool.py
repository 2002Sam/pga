"""Worker identities for a category's Q&A and execution feeds. Only presentation queries span workers."""
import re
import uuid

from sqlalchemy import and_, or_

from pga.db.models import AgentRun

_SUMMARY = re.compile(r'chat:summary-([0-9a-f]{20})-(qa|execute)')
_WORKER = re.compile(r'chat:mt-([0-9a-f]{20})-(qa|execute)-([0-9a-f]{32})')


def worker_prefix(summary):
    match = _SUMMARY.fullmatch(summary or '')
    return f'chat:mt-{match[1]}-{match[2]}-' if match else None


def summary_of(worker):
    match = _WORKER.fullmatch(worker or '')
    return f'chat:summary-{match[1]}-{match[2]}' if match else None


def public_key(key):
    return summary_of(key) or key


def feed_filter(key):
    conversation = AgentRun.data['conversation'].as_string()
    prefix = worker_prefix(key)
    return or_(conversation == key, conversation.startswith(prefix)) if prefix else thread_filter(key)


def turn_thread(conversation, run_id):
    """Each old feed-only task already has a stable worker identity, based on its run."""
    prefix = worker_prefix(conversation)
    return prefix + run_id.hex if prefix else conversation


def thread_filter(key):
    conversation = AgentRun.data['conversation'].as_string()
    match = _WORKER.fullmatch(key or '')
    if not match:
        return conversation == key
    original = uuid.UUID(hex=match[3])
    legacy = and_(conversation == summary_of(key), or_(
        AgentRun.id == original, AgentRun.data['regen_of'].as_string() == str(original)))
    return or_(conversation == key, legacy)
