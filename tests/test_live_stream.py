from fastapi.testclient import TestClient
from pga.api.app import create_app
from pga.agents import live


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
