from pathlib import Path
from urllib.parse import quote
import pytest
from fastapi.testclient import TestClient
from pga.localfiles import resolve_document
from pga.api.app import create_app
from pga.runtime import Runtime


def test_document_paths(tmp_path):
    path = tmp_path / '论文 修改.docx'
    path.write_bytes(b'document')
    roots = [str(tmp_path)]
    for raw in [str(path), path.as_uri(), 'sandbox:' + str(path), quote(path.name), str(path) + ':12']:
        assert resolve_document(raw, roots) == path.resolve()
    with pytest.raises(FileNotFoundError):
        resolve_document('missing.pdf', roots)
    with pytest.raises(ValueError):
        resolve_document('https://example.com/doc.pdf', roots)
    with pytest.raises(ValueError):
        resolve_document('file://remote/doc.pdf', roots)
    app = tmp_path / 'script.command'
    app.write_text('echo no')
    with pytest.raises(ValueError):
        resolve_document(str(app), roots)
    hidden = tmp_path / '.private'
    hidden.mkdir()
    secret = hidden / 'secret.txt'
    secret.write_text('private')
    with pytest.raises(ValueError):
        resolve_document(str(secret), roots)
    link = tmp_path / 'outside.txt'
    link.symlink_to('/etc/passwd')
    with pytest.raises(FileNotFoundError):
        resolve_document(str(link), roots)


def test_open_api(session_factory, policy, provider, backend, user, monkeypatch, tmp_path):
    from pga import localfiles
    opened = []
    monkeypatch.setattr(localfiles, 'open_document', lambda p, reveal=False: opened.append((p, reveal)))
    app = create_app(session_factory=session_factory,
        runtime_factory=lambda s: Runtime(s, policy=policy, provider=provider, translation_backend=backend))
    path = tmp_path / '论文 修改.docx'
    path.write_bytes(b'document')
    url = f'/v1/users/{user.id}/files/open'
    with TestClient(app) as c:
        assert c.put(f'/v1/users/{user.id}/access', json={'key':'chat:files', 'folder':str(tmp_path)}).status_code == 200
        r = c.post(url, json={'key':'chat:files', 'path':quote(path.name)})
        assert r.status_code == 200, r.text
        assert opened == [(path.resolve(), False)]
        assert c.post(url, json={'key':'chat:files', 'path':quote(path.name), 'reveal':True}).status_code == 200
        assert opened[-1] == (path.resolve(), True)
        assert c.post(url, json={'key':'chat:files','path':'missing.pdf'}).status_code == 404
        assert c.post(url, json={'path':str(path)}, headers={'origin':'https://evil.example'}).status_code == 403
        assert len(opened) == 2
