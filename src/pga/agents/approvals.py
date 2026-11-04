"""Pending native tool approvals, scoped to an active conversation and live run."""
import threading
import time
import uuid
from pga.agents import live

_LOCK = threading.RLock()
_PENDING = {}
_FULL_RUNS = set()


def request(task, details):
    lid, conv = task.meta.get('live_id'), task.meta.get('conversation', '')
    if not lid or ':' not in conv:
        return False
    with _LOCK:
        if lid in _FULL_RUNS:
            return True
        aid = uuid.uuid4().hex
        row = {'id': aid, 'conversation': conv, 'live_id': lid, 'details': details,
               'event': threading.Event(), 'decision': None}
        _PENDING[aid] = row
    live.set_extra(lid, 'approval', {k: row[k] for k in ('id', 'conversation', 'details')})
    try:
        deadline = time.monotonic() + min(task.timeout_s, 600)
        while not row['event'].wait(.25):
            if live.stopped(lid) or time.monotonic() >= deadline:
                return False
        return row['decision'] in ('allow', 'full')
    finally:
        with _LOCK:
            _PENDING.pop(aid, None)
        live.set_extra(lid, 'approval', None)


def pending(aid, uid):
    with _LOCK:
        row = _PENDING.get(aid)
        if not row or row['decision'] is not None or not row['conversation'].startswith(str(uid) + ':'):
            raise KeyError(aid)
        return {k: row[k] for k in ('id', 'conversation', 'live_id', 'details')}


def answer(aid, uid, decision):
    if decision not in ('allow', 'deny', 'full'):
        raise ValueError('invalid approval decision')
    with _LOCK:
        pending(aid, uid)
        row = _PENDING[aid]
        if decision == 'full':
            _FULL_RUNS.add(row['live_id'])
        row['decision'] = decision
        row['event'].set()


def finish(lid):
    with _LOCK:
        _FULL_RUNS.discard(lid)
