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


def test_video_link_seeks_and_downloads_original(session_factory, policy, provider, backend, user, tmp_path):
    path = tmp_path / '演示 片.MP4'
    with path.open('wb') as f:
        f.seek(6 * 1024 * 1024)
        f.write(b'last-frame')
    app = create_app(session_factory=session_factory,
        runtime_factory=lambda s: Runtime(s, policy=policy, provider=provider, translation_backend=backend))
    user_url = f'/v1/users/{user.id}'
    with TestClient(app) as client:
        key = 'chat:video'
        assert client.put(user_url + '/access', json={'key': key, 'folder': str(tmp_path)}).is_success
        response = client.post(user_url + '/files/view', json={'key': key, 'path': quote(path.name)})
        assert response.is_success, response.text
        info = response.json()
        assert info['kind'] == 'video' and 'text' not in info
        headers = client.head(info['url']).headers
        assert headers['content-type'] == 'video/mp4'
        assert headers['content-disposition'].startswith('inline')
        assert headers['accept-ranges'] == 'bytes'
        assert int(headers['content-length']) == path.stat().st_size
        tail = client.get(info['url'], headers={'range': 'bytes=-10'})
        assert tail.status_code == 206 and tail.content == b'last-frame'
        size = path.stat().st_size
        assert tail.headers['content-range'] == f'bytes {size - 10}-{size - 1}/{size}'
        assert client.get(info['url'], headers={'range': f'bytes={size}-'}).status_code == 416
        original = client.get(info['download_url'])
        assert original.headers['content-disposition'].startswith('attachment')
        assert original.content == path.read_bytes()


@pytest.mark.parametrize(('ext', 'mime'), [
    ('mov', 'video/quicktime'), ('m4v', 'video/mp4'), ('webm', 'video/webm'),
    ('ogv', 'video/ogg'), ('mkv', 'video/x-matroska'), ('avi', 'video/x-msvideo'),
])
def test_video_containers_open_as_media(tmp_path, ext, mime):
    from pga.filepreview import describe
    from pga.localfiles import save_text

    path = tmp_path / ('file.' + ext)
    path.write_bytes(b'video fixture')
    assert resolve_document(path.as_uri(), []) == path
    info = describe(path, 'testserver')
    assert info['kind'] == 'video'
    assert TestClient(create_app()).get(info['url']).headers['content-type'] == mime
    with pytest.raises(PermissionError):
        save_text(path, 'text', info['mtime'])
