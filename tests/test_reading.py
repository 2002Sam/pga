"""Source chats use isolated test users, fake models, and temporary documents."""
from uuid import uuid4

import pytest
from fastapi.testclient import TestClient
from sqlalchemy import select

from pga import docview, reading, webread
from pga.api.app import create_app
from pga.chats import branch_of, branch_context, runs_of
from pga.db.models import AgentRun
from pga.runtime import Runtime


@pytest.fixture
def client(session_factory, policy, provider, backend):
    app = create_app(session_factory=session_factory,
                     runtime_factory=lambda s: Runtime(s, policy=policy, provider=provider, translation_backend=backend))
    with TestClient(app) as client:
        yield client


def open_doc(client, user, **changes):
    return client.post(f"/v1/users/{user.id}/reading/open", json={
        "parent": "chat:parent", "source": "https://example.com/paper", "web": True, **changes})


def question(**changes):
    return {"request_id": str(uuid4()), "question": "这里的结论是什么？", "selection": "Small sample.",
            "context": "Only 12 participants were evaluated.", "anchor": "p2", "page": 3, **changes}


def test_source_identity_branch_and_category(rt, user, session):
    user.preferences = {"projects": {"of": {"chat:parent": "PGA"}}}
    session.flush()
    doc = reading.OpenReading(parent="chat:parent", source="https://example.com/paper#section")
    first = reading.open_reading(rt, user, doc)
    second = reading.open_reading(rt, user, doc)
    assert first == second
    assert first["source"] == "https://example.com/paper"
    assert branch_of(user, first["key"])["from"] == "chat:parent"
    assert branch_context(rt, user, branch_of(user, first["key"])) == []
    assert user.preferences["projects"]["of"][first["key"]] == "PGA"
    other = reading.open_reading(rt, user, doc.model_copy(update={"parent": "chat:another"}))
    assert other["key"] != first["key"]


def test_empty_source_chat_listed_and_restorable(client, user):
    response = open_doc(client, user)
    assert response.status_code == 200, response.text
    info = response.json()
    listed = client.get(f"/v1/users/{user.id}/chats").json()
    assert any(c["key"] == info["key"] and c["reading"] for c in listed)
    source = next(c["reading_info"] for c in listed if c["key"] == info["key"])
    assert source == {k: info[k] for k in ("key", "parent", "source", "title")}
    detail = client.get(f"/v1/users/{user.id}/chats/{info['key']}").json()
    assert detail["reading"] == info
    assert detail["branch"]["from"] == "chat:parent"
    assert detail["context"] == [] and detail["turns"] == []
    parent = client.get(f"/v1/users/{user.id}/chats/chat:parent").json()
    assert parent["children"][0]["key"] == info["key"]


def test_reading_state_survives_reopen_and_merges_partial_updates(client, user):
    key = open_doc(client, user).json()["key"]
    url = f"/v1/users/{user.id}/reading/{key}/state"
    assert client.patch(url, json={"page": 8, "ratio": .6, "draft": "Keep this question", "title": "Paper title"}).status_code == 200
    assert client.patch(url, json={"anchor": "p9"}).status_code == 200
    saved = open_doc(client, user).json()
    assert saved["title"] == "Paper title"
    assert saved["state"] == {"page": 8, "ratio": .6, "draft": "Keep this question", "anchor": "p9"}
    assert client.patch(url, json={"page": 0}).status_code == 422
    assert client.patch(url, json={"source": "file:///etc/passwd"}).status_code == 422


def test_questions_persist_with_reference_and_idempotent_retry(client, user, provider):
    provider.handler = lambda system, messages: "样本较少，结论需要进一步验证。"
    key = open_doc(client, user).json()["key"]
    url = f"/v1/users/{user.id}/reading/{key}/ask"
    body = question()
    first = client.post(url, json=body)
    assert first.status_code == 200, first.text
    assert client.post(url, json=body).json() == first.json()
    assert len(provider.calls) == 1
    saved = client.get(f"/v1/users/{user.id}/chats/{key}").json()
    assert len(saved["turns"]) == 2
    ref = saved["turns"][0]["reader_reference"]
    assert ref["selection"] == body["selection"] and ref["page"] == 3 and ref["anchor"] == "p2"
    assert saved["turns"][0]["reader_question"] == body["question"]
    assert "https://example.com/paper" in saved["turns"][0]["text"]  # exports retain provenance
    assert saved["turns"][1]["text"] == first.json()["answer"]
    assert client.post(url, json=question(question="再解释一下")).status_code == 200
    assert "样本较少" in str(provider.calls[-1])


def test_general_question_without_document_context_is_persisted(client, user, provider):
    key = open_doc(client, user).json()["key"]
    url = f"/v1/users/{user.id}/reading/{key}/ask"
    response=client.post(url, json=question(selection="", context=""))
    assert response.status_code == 200
    turns=client.get(f"/v1/users/{user.id}/chats/{key}").json()["turns"]
    assert len(turns)==2 and turns[0]["reader_question"]=="这里的结论是什么？"
    assert provider.calls and "general question unrelated to the document" in provider.calls[0].system
    assert client.post(url, json=question(request_id="bad")).status_code == 422
    assert client.post(url, json=question(question="x" * 2001)).status_code == 422
    assert len(client.get(f"/v1/users/{user.id}/chats/{key}").json()["turns"]) == 2


def test_late_save_cannot_overwrite_new_position_or_quote(client, user):
    key = open_doc(client, user).json()["key"]
    url = f"/v1/users/{user.id}/reading/{key}/state"
    quote = {"text": "Keep this reference", "id": "p8", "page": 2}
    client.patch(url, json={"revision": 200, "page": 2, "draft": "New draft", "selection": quote})
    client.patch(url, json={"revision": 100, "page": 1, "draft": "Old draft", "title": "Old title"})
    saved = open_doc(client, user).json()
    assert saved["title"] == "example.com"
    assert saved["state"]["page"] == 2 and saved["state"]["selection"] == quote
    assert saved["state"]["draft"] == "New draft"
    client.patch(url, json={"revision": 201, "selection": None})
    assert open_doc(client, user).json()["state"]["selection"] is None


def test_model_failure_keeps_retryable_request(client, user, provider):
    key = open_doc(client, user).json()["key"]
    url = f"/v1/users/{user.id}/reading/{key}/ask"
    body = question()
    provider.handler = lambda *args: ""
    assert client.post(url, json=body).status_code == 502
    provider.handler = lambda *args: "Recovered"
    assert client.post(url, json=body).json()["answer"] == "Recovered"


def test_local_pdf_uses_fresh_grant(client, user, tmp_path):
    pdf = tmp_path / "paper.pdf"
    pdf.write_bytes(b"%PDF-1.7\n")
    response = open_doc(client, user, source=str(pdf), web=False)
    assert response.status_code == 200, response.text
    key = response.json()["key"]
    content_url = f"/v1/users/{user.id}/reading/{key}/content"
    first, second = client.get(content_url), client.get(content_url)
    assert first.status_code == second.status_code == 200
    assert first.json()["kind"] == "document"
    assert first.json()["url"] != second.json()["url"]
    assert "url" not in open_doc(client, user, source=str(pdf), web=False).json()


def test_ownership_and_cross_origin(client, user):
    key = open_doc(client, user).json()["key"]
    assert client.get(f"/v1/users/{uuid4()}/reading/{key}/content").status_code == 404
    assert client.patch(f"/v1/users/{user.id}/reading/chat:{uuid4()}/state", json={"page": 2}).status_code == 404
    assert client.post(f"/v1/users/{user.id}/reading/open", json={"parent":"chat:p", "source":"https://example.com"}, headers={"origin":"https://evil.example"}).status_code == 403


def test_remote_reading_file_actions_download_original_and_check_reading_owner(client, user, tmp_path, monkeypatch):
    monkeypatch.setattr(docview, "CACHE", tmp_path / "cache")
    pdf_bytes = b"%PDF-1.7 original source, not a converted preview"
    monkeypatch.setattr(webread, "fetch", lambda url, **kwargs: ("https://cdn.example/paper.pdf", {"content-type": "application/pdf"}, pdf_bytes))
    key = open_doc(client, user, source="https://example.com/paper", web=True).json()["key"]
    route = f"/v1/users/{user.id}/reading/{key}/file-actions"
    info = client.get(route)
    assert info.status_code == 200, info.text
    payload = info.json()
    assert payload["kind"] == "document" and payload["name"] == "paper.pdf"
    assert payload["path"].endswith(".pdf") and payload["download_url"].endswith("/download")
    downloaded = client.get(payload["download_url"])
    assert downloaded.status_code == 200 and downloaded.content == pdf_bytes
    assert downloaded.headers["content-disposition"].startswith("attachment;")
    assert "paper.pdf" in downloaded.headers["content-disposition"]
    opened = []
    from pga import localfiles
    monkeypatch.setattr(localfiles, "open_document", lambda path, reveal=False: opened.append((path, reveal)))
    reveal = client.post(f"/v1/users/{user.id}/files/open", json={"path": payload["path"], "key": key, "reveal": True})
    assert reveal.status_code == 200 and opened and opened[-1][0].name.endswith(".pdf") and opened[-1][1]
    # Cached originals are under the app's allowed local cache root, so folder reveal still works without a conversation key.
    reveal_no_key = client.post(f"/v1/users/{user.id}/files/open", json={"path": payload["path"], "reveal": True})
    assert reveal_no_key.status_code == 200 and opened[-1][1]
    assert client.get(f"/v1/users/{uuid4()}/reading/{key}/file-actions").status_code == 404
    assert client.get(route, headers={"origin": "https://evil.example"}).status_code == 403
    assert client.get(f"/v1/users/{user.id}/reading/chat:{uuid4()}/file-actions").status_code == 404


def test_remote_office_actions_download_source_not_print_pdf(client, user, tmp_path, monkeypatch):
    monkeypatch.setattr(docview, "CACHE", tmp_path / "cache")
    monkeypatch.setattr(docview, "soffice", lambda: None)
    original = b"PK\x03\x04 original pptx bytes"
    monkeypatch.setattr(webread, "fetch", lambda url, **kwargs: (
        "https://cdn.example/deck.pptx",
        {"content-type": "application/vnd.openxmlformats-officedocument.presentationml.presentation"}, original))
    key = open_doc(client, user, source="https://example.com/deck", web=True).json()["key"]
    info = client.get(f"/v1/users/{user.id}/reading/{key}/file-actions").json()
    assert info["name"] == "deck.pptx" and info["kind"] == "external"
    response = client.get(info["download_url"])
    assert response.status_code == 200 and response.content == original
    assert 'filename="deck.pptx"' in response.headers["content-disposition"]


@pytest.mark.parametrize("source", ["javascript:alert(1)", "file:///etc/passwd", "https://token@example.com", "https://example.com:bad"])
def test_reject_bad_web_source(client, user, source):
    assert open_doc(client, user, source=source).status_code == 422


def test_vendored_pdf_assets_and_traversal(client):
    response = client.get("/ui/vendor/pdfjs/6.5.438/legacy/build/pdf.mjs")
    assert response.status_code == 200 and "javascript" in response.headers["content-type"]
    assert client.get("/ui/vendor/pdfjs/6.5.438/%2e%2e/%2e%2e/app-core.js").status_code == 404
