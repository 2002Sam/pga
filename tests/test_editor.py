import json
import os
from urllib.parse import parse_qs, urlsplit
import zipfile
from fastapi import FastAPI
from fastapi.testclient import TestClient
from pga.filepreview import describe, router
from pga.localfiles import resolve_document, save_text
import pytest


def test_editor_url_and_code_are_not_executed(tmp_path):
    path = tmp_path / '代码 与空格.py'
    path.write_text('print("hello")')
    assert resolve_document(str(path), [str(tmp_path)], editor=True) == path
    with pytest.raises(ValueError):
        resolve_document(str(path), [str(tmp_path)])
    info = describe(path, 'localhost:8010')
    assert info['kind'] == 'text'
    assert info['text'] == 'print("hello")'
    assert 'url' not in info


def test_word_preview_escapes_document_and_denies_cross_site(tmp_path):
    path = tmp_path / '论文.docx'
    with zipfile.ZipFile(path,'w') as z:
        z.writestr('word/document.xml','<w:document xmlns:w="http://schemas.openxmlformats.org/wordprocessingml/2006/main"><w:body><w:p><w:r><w:t>&lt;script&gt;alert(1)&lt;/script&gt;</w:t></w:r></w:p></w:body></w:document>')
    info = describe(path,'testserver')
    assert info['kind'] == 'document'          # text_only only when this machine has no textutil
    app=FastAPI(); app.include_router(router)
    with TestClient(app) as c:
        r=c.get(info['url']); assert r.status_code==200
        assert '&lt;script&gt;' in r.text and '<script>' not in r.text
        assert 'sandbox' in r.headers['content-security-policy']
        assert c.get(info['url'],headers={'origin':'https://evil.example'}).status_code==403
        assert c.get('/v1/file-preview/unknown').status_code==404
        path.unlink()
        assert c.get(info['url']).status_code==404


def test_binary_formats_do_not_open_as_garbled_text(tmp_path):
    for ext in ['.zip','.dmg']:
        p=tmp_path/('file'+ext);p.write_bytes(b'placeholder')
        assert describe(p,'localhost:8010')['kind']=='external'
    p=tmp_path/'file.xlsx';p.write_bytes(b'placeholder')
    assert describe(p,'localhost:8010')['kind']=='sheet'                    # spreadsheets are read in PGA now (pga.docview)
    p=tmp_path/'image.png';p.write_bytes(b'image')
    assert describe(p,'localhost:8010')['kind']=='image'


def test_save_preserves_version_precision_bom_newlines_and_permissions(tmp_path):
    path = tmp_path / 'hello.py'
    path.write_bytes(b'\xef\xbb\xbfprint("old")\r\n')
    path.chmod(0o755)
    # This exact ns value cannot survive a JavaScript JSON number round trip.
    stamp = 1793974721123456789
    os.utime(path, ns=(stamp, stamp))
    info = json.loads(json.dumps(describe(path, 'localhost')))
    assert info['mtime'] == str(stamp) and int(float(stamp)) != stamp
    assert info['eol'] == 'CRLF' and info['editable']
    saved = save_text(path, 'print("新内容")\n', info['mtime'])
    assert saved == str(path.stat().st_mtime_ns)
    assert path.read_bytes() == b'\xef\xbb\xbf' + 'print("新内容")\r\n'.encode()
    assert path.stat().st_mode & 0o777 == 0o755
    assert not list(tmp_path.glob('*.pga-save'))
    with pytest.raises(ValueError, match='changed'):
        save_text(path, 'stale', info['mtime'])
    assert '新内容' in path.read_text(encoding='utf-8-sig')


def test_save_requires_version_and_rejects_non_text(tmp_path):
    path = tmp_path / 'notes.md'
    path.write_text('original')
    with pytest.raises(ValueError, match='版本'):
        save_text(path, 'lost update', None)
    path.write_text('external change')
    save_text(path, 'explicit overwrite', None, force=True)
    assert path.read_text() == 'explicit overwrite'
    for ext, content, error in [('.pdf', b'%PDF', PermissionError), ('.py', b'\x00binary', ValueError), ('.txt', b'\xff\xfe', ValueError)]:
        binary = tmp_path / ('binary' + ext); binary.write_bytes(content)
        with pytest.raises(error):
            save_text(binary, 'replacement', str(binary.stat().st_mtime_ns))
        assert binary.read_bytes() == content


def test_file_edit_api_round_trip_and_conflict(session_factory, user, policy, provider, backend, tmp_path):
    from pga.api.app import create_app
    from pga.runtime import Runtime
    c = TestClient(create_app(session_factory, lambda s: Runtime(s, policy=policy, provider=provider, translation_backend=backend)))
    base = f'/v1/users/{user.id}/files'
    for name in ['代码.py', '说明.md', '网页.htm', '图.svg', '数据.csv']:
        path = tmp_path / name; path.write_text('initial')
        opened = c.post(base + '/view', json={'path': str(path)})
        assert opened.status_code == 200, opened.text
        info = opened.json()
        assert info['editable'] and isinstance(info['mtime'], str)
        payload = {'path': str(path), 'text': 'changed 中文\n', 'mtime': info['mtime']}
        r = c.post(base + '/save', json=payload)
        assert r.status_code == 200, r.text
        assert path.read_text() == payload['text']
        assert r.json()['mtime'] == c.post(base + '/stat', json={'path': str(path)}).json()['mtime']
        assert c.post(base + '/view', json={'path': str(path)}).json()['text'] == payload['text']
        assert c.post(base + '/save', json=payload).status_code == 409
        assert c.post(base + '/save', json={**payload, 'mtime': r.json()['mtime']}, headers={'origin': 'https://other.example'}).status_code == 403
    asset = c.get('/ui/vendor/monaco/0.52.2/min/vs/loader.js')
    assert asset.status_code == 200 and 'immutable' in asset.headers['cache-control']
    assert c.get('/ui/vendor/monaco/0.52.2/min/%2e%2e/%2e%2e/%2e%2e/app-editor.js').status_code == 404
