"""Large tool payloads remain on disk; step summaries have a bounded cache."""
import json
import tracemalloc
from datetime import datetime, timezone, timedelta

from pga.hub import steps


def transcript(tmp_path, monkeypatch):
    path = tmp_path / 'session.jsonl'
    monkeypatch.setattr(steps, 'transcript', lambda *args: path)
    steps._WINDOWS.clear()
    return path


def test_large_transcript_is_streamed_and_detail_remains_available(tmp_path, monkeypatch):
    path = transcript(tmp_path, monkeypatch)
    timestamp = '2026-11-12T00:00:00+00:00'
    call = {'type':'assistant','timestamp':timestamp,'message':{'content':[{'type':'tool_use','name':'Read','id':'call','input':{'file_path':'large.txt'}}]}}
    result = {'type':'user','timestamp':timestamp,'message':{'content':[{'type':'tool_result','tool_use_id':'call','content':'x'*500_000}]}}
    with path.open('w') as f:
        f.write(json.dumps(call)+'\n')
        for _ in range(64):
            f.write(json.dumps(result)+'\n')
    tracemalloc.start()
    try:
        how = steps.window('session-test', None, None)
        _, peak = tracemalloc.get_traced_memory()
    finally:
        tracemalloc.stop()
    assert peak < 8 * 1024 * 1024, peak
    assert how['steps'][0]['title'] == 'large.txt'
    assert how['steps'][0]['out'] == '1.0'
    assert sum(map(len, steps._WINDOWS.values())) < 2048
    # Original tool output is still available on demand.
    assert steps._block(path, '1.0')['content'] == 'x'*500_000


def test_window_cache_is_lru_bounded_and_returns_independent_objects(tmp_path, monkeypatch):
    path = transcript(tmp_path, monkeypatch)
    path.write_text(json.dumps({'type':'assistant','timestamp':'2026-11-12T00:00:01Z','message':{'content':[{'type':'thinking','thinking':'think'}]}})+'\n')
    monkeypatch.setattr(steps, 'WINDOW_CACHE_ITEMS', 2)
    start = datetime(2026,11,12,tzinfo=timezone.utc)
    one = steps.window('session-test', start, start+timedelta(seconds=3))
    one['steps'][0]['text'] = 'changed by caller'
    two = steps.window('session-test', start, start+timedelta(seconds=3))
    assert two['steps'][0]['text'] == 'think'
    for n in range(4,9):
        steps.window('session-test', start, start+timedelta(seconds=n))
    assert len(steps._WINDOWS) == 2
    monkeypatch.setattr(steps, 'WINDOW_CACHE_BYTES', 400)
    steps.window('session-test', start, start+timedelta(seconds=10))
    assert sum(map(len, steps._WINDOWS.values())) <= 400


def test_cached_window_invalidates_when_transcript_grows(tmp_path, monkeypatch):
    path = transcript(tmp_path, monkeypatch)
    path.write_text('invalid json\n')
    assert steps.window('session-test', None, None) is None
    with path.open('a') as f:
        f.write(json.dumps({'type':'assistant','timestamp':'2026-11-12T00:00:01Z','message':{'content':[{'type':'thinking','thinking':'new'}]}})+'\n')
    assert steps.window('session-test', None, None)['steps'][0]['text'] == 'new'
