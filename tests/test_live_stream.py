import tracemalloc

from fastapi.testclient import TestClient
from pga.api.app import create_app
from pga.agents import live, links


def test_websocket_delivers_progress_and_finish_without_http_polling():
    client = TestClient(create_app())
    lid = live.start('stream-test')
    try:
        with client.websocket_connect('/v1/agents/live-stream') as ws:
            rows = ws.receive_json()
            assert any(r['id'] == lid for r in rows)
            live.step(lid, {'t':'tool','tool':'Bash','id':'command','title':'test'})
            live.step_output(lid, 'command', 'first line\n')
            rows = ws.receive_json()
            row = next(r for r in rows if r['id'] == lid)
            assert row['steps'][0]['output'] == 'first line\n'
            assert row['running']
            live.append(lid, 'answer')
            live.finish(lid, True)
            rows = ws.receive_json()
            row = next(r for r in rows if r['id'] == lid)
            assert row['text'] == 'answer'
            assert not row['running']
    finally:
        live.finish(lid, True)


def test_live_snapshot_and_encoding_are_shared_until_public_state_changes():
    lid = live.start('snapshot-cache-test')
    try:
        rows1, payload1 = live.snapshot_cached()
        rows2, payload2 = live.snapshot_cached()
        assert rows1 is not rows2  # each caller gets isolated nested rows
        assert rows1 == rows2
        assert payload1 is payload2
        revision = next(row['revision'] for row in rows1 if row['id'] == lid)
        live.step(lid, {'t':'tool','tool':'Bash','id':'command'})
        rows3, payload3 = live.snapshot_cached()
        assert rows3 is not rows1
        assert payload3 is not payload1
        assert next(row['revision'] for row in rows3 if row['id'] == lid) > revision
        assert 'elapsed_s' not in rows3[0]
        assert live.snapshot()[0]['elapsed_s'] >= 0
    finally:
        live.finish(lid, True)


def test_nested_snapshot_rows_are_isolated_from_run_updates_and_caller_mutation():
    lid = live.start('snapshot-isolation-test')
    try:
        env = {'tools':['Bash']}
        tool = {'t':'tool','tool':'Bash','id':'command','output':'before','meta':{'labels':['original']}}
        live.set_extra(lid, 'env', env)
        live.step(lid, tool)
        env['tools'].append('mutated before snapshot')
        tool['meta']['labels'].append('mutated before snapshot')
        before = next(row for row in live.snapshot() if row['id'] == lid)
        assert before['env']['tools'] == ['Bash']
        assert before['steps'][0]['meta']['labels'] == ['original']
        before_revision = before['revision']
        live.step_done(lid, 'command', error=True)
        after = next(row for row in live.snapshot() if row['id'] == lid)
        assert before['steps'][0]['output'] == 'before'
        assert 'secs' not in before['steps'][0]
        assert before['steps'][0].get('error') is None
        assert after['steps'][0]['error'] is True
        assert after['revision'] > before_revision
        before['env']['tools'].append('mutated by caller')
        before['steps'][0]['output'] = 'mutated by caller'
        fresh = next(row for row in live.snapshot() if row['id'] == lid)
        assert fresh['env']['tools'] == ['Bash']
        assert fresh['steps'][0]['output'] == 'before'
    finally:
        live.finish(lid, True)


def test_http_snapshot_does_not_encode_json(monkeypatch):
    import json
    lid = live.start('http-no-encode-test')
    try:
        def unexpected(*_args, **_kwargs):
            raise AssertionError('HTTP snapshot pre-encoded its response')
        monkeypatch.setattr(json, 'dumps', unexpected)
        assert any(row['id'] == lid for row in live.snapshot())
    finally:
        live.finish(lid, True)


def test_http_snapshot_then_full_websocket_uses_lazy_encoded_fragments():
    client = TestClient(create_app())
    lid = live.start('http-before-websocket-test')
    try:
        assert client.get('/v1/agents/live').status_code == 200
        with client.websocket_connect('/v1/agents/live-stream') as ws:
            rows = ws.receive_json()
            assert isinstance(rows, list)
            assert any(row['id'] == lid for row in rows)
    finally:
        live.finish(lid, True)


def test_delta_encodes_only_changed_run_fragments(monkeypatch):
    import json
    first, second = live.start('delta-cache-a'), live.start('delta-cache-b')
    try:
        live.step(first, {'id':'a','output':'a'*10000})
        live.step(second, {'id':'b','output':'b'*10000})
        live.snapshot_payload()
        previous = live.snapshot_revisions()
        live.step_done(first, 'a')
        original = json.dumps
        sizes = []
        def count_dumps(value, *args, **kwargs):
            sizes.append(len(value) if isinstance(value, list) else 1)
            return original(value, *args, **kwargs)
        monkeypatch.setattr(json, 'dumps', count_dumps)
        payload, current = live.snapshot_delta_payload(previous)
        delta = json.loads(payload)
        assert delta['type'] == 'live_delta'
        assert [row['id'] for row in delta['runs']] == [first]
        assert current[second] == previous[second]
        assert sizes == [1, 0]  # one changed row, empty removal list; unchanged row was reused
    finally:
        live.finish(first, True)
        live.finish(second, True)


def test_start_check_invalidates_run_snapshot_revision():
    lid = live.start('start-check-revision')
    try:
        before = next(row for row in live.snapshot() if row['id'] == lid)['revision']
        live.check_start(lid)
        after = next(row for row in live.snapshot() if row['id'] == lid)
        assert after['revision'] > before
        assert after['start_check']['state'] == 'unknown'
    finally:
        live.finish(lid, True)


def test_delta_websocket_sends_initial_snapshot_changes_and_removed_runs():
    client = TestClient(create_app())
    lid = live.start('delta-stream-test')
    try:
        with client.websocket_connect('/v1/agents/live-stream?delta=1') as ws:
            first = ws.receive_json()
            assert isinstance(first, list)
            assert any(row['id'] == lid for row in first)
            live.append(lid, 'hello')
            delta = ws.receive_json()
            assert delta['type'] == 'live_delta'
            assert next(row for row in delta['runs'] if row['id'] == lid)['text'] == 'hello'
            with live._LOCK:
                live._RUNS[lid]['finished'] = 1
            live.KEEP_S = 0
            # Trigger pruning and its cache invalidation without waiting for expiry.
            live.snapshot()
            removed = ws.receive_json()
            assert removed['type'] == 'live_delta'
            assert lid in removed['removed']
    finally:
        live.KEEP_S = 40
        live.finish(lid, True)


def test_tool_output_bounded_and_separate_between_calls():
    lid = live.start('tool-output-test')
    try:
        live.step(lid, {'id':'a'})
        live.step(lid, {'id':'b'})
        live.step_output(lid, 'a', 'x'*20000)
        live.step_output(lid, 'b', 'second')
        row = next(r for r in live.snapshot() if r['id'] == lid)
        assert len(row['steps'][0]['output']) == 12000
        assert row['steps'][1]['output'] == 'second'
        assert row['text'] == ''
    finally:
        live.finish(lid, True)


def test_running_images_are_bounded_without_reusing_cached_urls():
    lid = live.start('image-bound-test')
    try:
        for n in range(live.MAX_IMAGES + 7):
            call = f'call-{n}'
            live.step(lid, {'id': call})
            live.step_done(lid, call, images=[(str(n).encode(), 'image/png')])

        with live._LOCK:
            row = live._RUNS[lid]
            assert len(row['_images']) == live.MAX_IMAGES
            refs = [i for step in row['steps'] for i in step.get('images', [])]
            assert refs == list(range(live.MAX_IMAGES + 7))
        assert live.image(lid, 0) is None  # a cached old URL never resolves to a newer screenshot
        assert live.image(lid, 7) == (b'7', 'image/png')
        assert live.image(lid, live.MAX_IMAGES + 6) == (str(live.MAX_IMAGES + 6).encode(), 'image/png')
    finally:
        live.finish(lid, True)


def test_stream_reader_forwards_large_stream_without_retaining_events():
    count = 100_000
    seen = 0

    def source():
        for n in range(count):
            yield f'event-{n}\n'

    def consume(_line):
        nonlocal seen
        seen += 1

    tracemalloc.start()
    try:
        links.pump_lines(source(), consume)
        _, peak = tracemalloc.get_traced_memory()
    finally:
        tracemalloc.stop()

    assert seen == count
    assert peak < 1_000_000


def test_stop_endpoint_is_idempotent_after_finish_or_expiry():
    client = TestClient(create_app())
    lid = live.start('stop-test')
    try:
        for _ in range(2):
            response = client.post(f'/v1/agents/live/{lid}/stop')
            assert response.status_code == 200
            assert response.json()['stopping'] == lid
        assert live.stopped(lid)
        assert next(r for r in live.snapshot() if r['id'] == lid)['stopping']
        live.finish(lid, False)
        for run_id in (lid, 'expired-id'):
            response = client.post(f'/v1/agents/live/{run_id}/stop')
            assert response.status_code == 200
            assert response.json()['running'] is False
    finally:
        live.finish(lid, False)


def test_long_running_conversation_keeps_its_stop_handle(monkeypatch):
    lid = live.start('long-running')
    try:
        with live._LOCK:
            live._RUNS[lid]['started'] -= 4 * 3600
        assert any(r['id'] == lid and r['running'] for r in live.snapshot())
        assert live.stop(lid)
        assert live.stopped(lid)
    finally:
        live.finish(lid, False)


def test_broken_stdout_reader_still_wakes_the_waiting_session():
    import queue
    from types import SimpleNamespace
    import pytest
    def broken_stream():
        yield 'partial\n'
        raise OSError('pipe read failed')
    session = object.__new__(links.StreamSession)
    session.p = SimpleNamespace(stdout=broken_stream())
    session.lines = queue.Queue()
    with pytest.raises(OSError, match='pipe read failed'):
        session._read_stdout()
    assert session.lines.get_nowait() == 'partial\n'
    assert session.lines.get_nowait() is None
