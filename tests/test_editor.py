import json
from urllib.parse import parse_qs, urlsplit
import zipfile
from fastapi import FastAPI
from fastapi.testclient import TestClient
from pga.filepreview import describe, router
from pga.localfiles import resolve_document
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
    assert info['text_only'] is True
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
    for ext in ['.pptx','.xlsx','.zip']:
        p=tmp_path/('file'+ext);p.write_bytes(b'placeholder')
        assert describe(p,'localhost:8010')['kind']=='external'
    p=tmp_path/'image.png';p.write_bytes(b'image')
    assert describe(p,'localhost:8010')['kind']=='image'
