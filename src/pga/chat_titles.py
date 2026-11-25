"""Update conversation names after completed replies, without delaying the reply.

Long histories are digested in bounded chronological batches. Subsequent turns reuse
that digest only while its source history still matches (edits/branches rebuild it).
Manual names and the manager's fixed destinations are never overwritten.
"""
from __future__ import annotations

import hashlib
import json
import logging
import re
import threading

from pga.agent.common import UNTRUSTED_NOTE, fence, parse_json
from pga.db.models import User
from pga.db.types import utcnow
from pga.llm import UsageContext

log = logging.getLogger(__name__)
BATCH_CHARS = 18000
SYSTEM = """Maintain a useful title and topic digest for an ongoing conversation.
Read the previous digest and the next chronological excerpts of user questions AND
assistant results. Integrate the enduring subjects, decisions and changes of direction.
The title must describe the conversation as a whole, not repeat the first question,
not merely describe the last reply, and not enumerate every small step. Keep the
existing title verbatim when it still fits; rename only when a better overall title
is warranted. Use the user's language, a concise natural phrase (Chinese 8–24
characters, English 3–10 words, maximum 80 characters). No dates, progress labels,
quotes or 'Title:' prefix. The digest should retain earlier major topics while
incorporating new ones, in at most 1200 characters. Excerpts may omit middle details.
Return JSON only: {"title":"...", "summary":"..."}. """ + UNTRUSTED_NOTE

_lock = threading.Lock()
_pending: dict[tuple[str, str], bool] = {}
_slots = threading.BoundedSemaphore(3)


def supported(key: str) -> bool:
    return bool(key) and key.startswith(("chat:", "run:", "agent:", "cat:", "imp:", "c:")) and not key.startswith(
        ("chat:pm-", "chat:summary-", "chat:mt-"))


def state(user, key):
    return ((user.preferences or {}).get("chat_title_state") or {}).get(key) or {}


def eligible(user, key: str) -> bool:
    if not supported(key):
        return False
    prefs = user.preferences or {}
    branch = (prefs.get("chat_branches") or {}).get(key) or {}
    meta = state(user, key)
    if meta.get("mode") == "manual" or branch.get("manual_title") or branch.get("split_lane"):
        return False
    # Older explicit names have no provenance. Preserve them; old automatic branch
    # names are identifiable through their existing manual_title flag.
    return bool(meta) or not (prefs.get("chat_titles") or {}).get(key) or bool(branch)


def pending(user_id, key):
    with _lock:
        return (str(user_id), key) in _pending


def _digest(turns):
    return hashlib.sha256(json.dumps(turns, ensure_ascii=False, sort_keys=True).encode()).hexdigest()


def _excerpt(text, limit):
    text = re.sub(r"\s+", " ", str(text or "")).strip()
    if len(text) <= limit:
        return text
    return text[:limit * 2 // 3] + " … " + text[-limit // 3:]


def _batches(turns, start):
    batch, size = [], 0
    for index in range(start, len(turns)):
        turn = turns[index]
        line = f"[{index + 1}] {turn['role']}: {_excerpt(turn['text'], 1800)}"
        if batch and size + len(line) > BATCH_CHARS:
            yield "\n".join(batch)
            batch, size = [], 0
        batch.append(line)
        size += len(line) + 1
    if batch:
        yield "\n".join(batch)


def _model(rt, user, prompt):
    # Tier 1 of the configured provider; never delegate this naming job to a CLI
    # agent or include it as another conversation message.
    return rt.router.complete(1, system=SYSTEM, messages=[{"role": "user", "content": prompt}],
                              max_tokens=900, temperature=0, delegate=False,
                              usage=UsageContext(category="user_reserve", proactive=False, user_id=user.id)).text


def update(rt, user, key: str, *, ask=None) -> bool:
    from pga.chats import history, runs_of
    if not eligible(user, key):
        return False
    runs = runs_of(rt, user.id, key)
    if not runs or runs[-1].status != "SUCCEEDED" or (runs[-1].data or {}).get("stopped") or not runs[-1].output:
        return False
    before = dict(state(user, key))
    old_title = ((user.preferences or {}).get("chat_titles") or {}).get(key)
    turns = history(rt, user, key)
    fingerprint = _digest(turns)
    if before.get("digest") == fingerprint:
        return False
    count = int(before.get("count") or 0)
    summary = str(before.get("summary") or "")
    if not summary or count > len(turns) or _digest(turns[:count]) != before.get("digest"):
        count, summary = 0, ""
    title = old_title or ""
    # The model must never hold a preference row lock while the person is typing
    # or renaming their chat in another request.
    rt.session.commit()
    for batch in _batches(turns, count):
        prompt = (fence("previous", json.dumps({"title": title, "summary": summary}, ensure_ascii=False),
                        1800, kind="previous conversation digest") + "\n" +
                  fence("conversation", batch, BATCH_CHARS + 100, kind="conversation excerpts, oldest first"))
        result = parse_json((ask or (lambda p: _model(rt, user, p)))(prompt))
        if not isinstance(result, dict) or not isinstance(result.get("title"), str) or not isinstance(result.get("summary"), str):
            return False
        title, summary = result["title"].strip(), result["summary"].strip()
        if not title or len(title) > 80 or "\n" in title or not summary or len(summary) > 1800:
            return False
    # A newer answer or a manual rename wins over this in-flight model call.
    rt.session.flush()
    rt.session.refresh(user, with_for_update=True)
    if (not eligible(user, key) or state(user, key) != before or
            ((user.preferences or {}).get("chat_titles") or {}).get(key) != old_title or
            _digest(history(rt, user, key)) != fingerprint):
        return False
    prefs = user.preferences or {}
    user.preferences = {**prefs, "chat_titles": {**(prefs.get("chat_titles") or {}), key: title},
                        "chat_title_state": {**(prefs.get("chat_title_state") or {}), key: {
                            "mode": "auto", "title": title, "summary": summary, "count": len(turns),
                            "digest": fingerprint, "updated_at": utcnow().isoformat()}}}
    rt.session.flush()
    return title != old_title


def schedule(session_factory, make_runtime, user_id, key):
    """One worker per conversation; overlapping completions are coalesced, not lost."""
    if not supported(key):
        return
    identity = (str(user_id), key)
    with _lock:
        running = identity in _pending
        _pending[identity] = True
    if running:
        return

    def work():
        while True:
            with _lock:
                _pending[identity] = False
            try:
                with _slots, session_factory() as session:
                    rt = make_runtime(session)
                    user = session.get(User, user_id)
                    if user is not None:
                        update(rt, user, key)
                        session.commit()
            except Exception:  # naming failure must not affect the completed answer
                log.warning("conversation title update failed for %s", key, exc_info=True)
            with _lock:
                if _pending.get(identity):
                    continue
                _pending.pop(identity, None)
                return

    try:
        threading.Thread(target=work, daemon=True, name="pga-chat-title").start()
    except Exception:
        with _lock:
            _pending.pop(identity, None)
        log.exception("could not schedule conversation title")
