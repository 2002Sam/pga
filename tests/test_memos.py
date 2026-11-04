import base64
import uuid

import pytest

from pga import memos


@pytest.fixture(autouse=True)
def _dir(tmp_path, monkeypatch):
    monkeypatch.setattr(memos, "MEMO_DIR", tmp_path)


def test_memo_roundtrip_conflict_and_trash():
    u = uuid.uuid4()
    m = memos.create(u)
    assert m["rev"] == 1 and m["text"] == ""
    r = memos.write(u, m["id"], "第一段\n\n[[ref:conv:abc|聊天]]\n", 1)
    assert memos.listing(u)[0]["title"] == "第一段"
    with pytest.raises(memos.MemoConflict):
        memos.write(u, m["id"], "x", 1)
    assert r["rev"] == 2
    memos.delete(u, m["id"])
    assert memos.listing(u) == []
    assert list((memos.MEMO_DIR / str(u) / ".trash").iterdir())


def test_images_and_bad_ids():
    u = uuid.uuid4()
    png = "data:image/png;base64," + base64.b64encode(b"\x89PNG\r\n").decode()
    name = memos.save_image(u, png)
    assert memos.image_path(u, name).read_bytes().startswith(b"\x89PNG")
    with pytest.raises(ValueError):
        memos.save_image(u, "data:text/html;base64,AAAA")
    with pytest.raises(FileNotFoundError):
        memos.image_path(u, "../../etc/passwd")
    with pytest.raises(ValueError):
        memos.read(u, "../x")


def test_memo_http_routes(session_factory, policy, provider, backend):
    from fastapi.testclient import TestClient
    from pga.api.app import create_app
    from pga.runtime import Runtime
    app = create_app(session_factory=session_factory,
                     runtime_factory=lambda s: Runtime(s, policy=policy, provider=provider, translation_backend=backend))
    with TestClient(app) as c:
        uid = c.post("/v1/users", json={"locale": "zh-CN"}).json()["id"]
        r = c.post(f"/v1/users/{uid}/memos")
        assert r.status_code == 200, r.text
        mid = r.json()["id"]
        assert c.put(f"/v1/users/{uid}/memos/{mid}", json={"text": "hi", "rev": 1}).json()["rev"] == 2
        assert c.get(f"/v1/users/{uid}/memos").json()["memos"][0]["id"] == mid
        assert c.get(f"/v1/users/{uid}/memos/zzzzzz").status_code == 404
