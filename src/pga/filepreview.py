"""Short-lived preview URLs for files explicitly selected from a conversation (and pages fetched by the web reader).

What each kind shows (pga.docview converts): Word as a page of HTML with a PDF layout view, spreadsheets as tables, slides
as a PDF, PDFs and pictures as they are, text and Markdown inline."""
import html
from pathlib import Path
import secrets
import threading
import time
import zipfile
from xml.etree import ElementTree as ET

from fastapi import APIRouter, HTTPException, Request
from fastapi.responses import FileResponse, HTMLResponse
from pga.editor import local_request

router = APIRouter()
_grants = {}
_lock = threading.Lock()
IMAGES = {'.png', '.jpg', '.jpeg', '.gif', '.webp', '.svg'}
BINARY = {'.zip', '.7z', '.rar', '.dmg', '.key', '.numbers', '.pages'}


def grant(path: Path) -> str:
    """A preview URL for this file, good for four hours."""
    ticket = secrets.token_urlsafe(24)
    with _lock:
        now = time.time()
        for key, (_, expires) in list(_grants.items()):
            if expires < now:
                _grants.pop(key, None)
        while len(_grants) >= 256:
            _grants.pop(next(iter(_grants)))
        _grants[ticket] = (path, now + 4 * 3600)
    return '/v1/file-preview/' + ticket


def describe(path: Path, authority: str) -> dict:
    from pga import docview
    st = path.stat()
    result = {'name': path.name, 'path': str(path), 'size': st.st_size, 'mtime': str(st.st_mtime_ns)}
    ext = path.suffix.lower()
    if ext in BINARY:
        return {**result, 'kind': 'external', 'message': '此格式暂不支持内置预览，请用系统应用查看完整内容。'}
    if ext in IMAGES or ext == '.pdf':
        return {**result, 'kind': 'image' if ext in IMAGES else 'document', 'url': grant(path)}
    if ext in docview.WORD:
        url = grant(path)                       # the page of HTML; /pdf: as it would print (LibreOffice)
        return {**result, 'kind': 'document', 'url': url, 'pdf_url': url + '/pdf' if docview.soffice() else None,
                'text_only': not docview.textutil() and ext == '.docx'}
    if ext in docview.SHEETS:
        if ext in ('.xls', '.ods') and not docview.soffice():
            return {**result, 'kind': 'external', 'message': '旧版表格需要 LibreOffice 才能预览，请用系统应用查看。'}
        return {**result, 'kind': 'sheet', 'url': grant(path)}
    if ext in docview.SLIDES:
        if not docview.soffice():
            return {**result, 'kind': 'external', 'message': '幻灯片预览需要 LibreOffice，请用系统应用查看。'}
        return {**result, 'kind': 'slides', 'url': grant(path) + '/pdf'}
    st = path.stat()
    if st.st_size > 5 * 1024 * 1024:
        return {**result, 'kind': 'external', 'message': '文件超过 5 MB，请用系统应用查看。'}
    try:
        with path.open(encoding='utf-8-sig', newline='') as f:
            text = f.read()
        if '\x00' in text:
            raise ValueError('binary file')
    except (UnicodeError, ValueError):
        return {**result, 'kind': 'external', 'message': '此文件不是 UTF-8 文本，请用系统应用查看。'}
    from pga.localfiles import TEXT
    return {**result, 'kind': 'text', 'text': text, 'markdown': ext == '.md', 'ext': ext, 'size': st.st_size,
            'mtime': str(st.st_mtime_ns), 'editable': ext in TEXT, 'eol': 'CRLF' if '\r\n' in text[:20000] else 'LF'}


def word_preview(path: Path) -> str:
    with zipfile.ZipFile(path) as archive:
        info = archive.getinfo('word/document.xml')
        if info.file_size > 16 * 1024 * 1024:
            raise ValueError('文档过大，请用系统应用打开')
        root = ET.fromstring(archive.read(info))
    ns = {'w': 'http://schemas.openxmlformats.org/wordprocessingml/2006/main'}
    paragraphs = []
    for p in root.findall('.//w:p', ns):
        paragraphs.append(''.join(t.text or '' for t in p.findall('.//w:t', ns)))
    return '<!doctype html><meta charset="utf-8"><title>' + html.escape(path.name) + '</title><style>body{max-width:850px;margin:40px auto;padding:0 28px;font:16px/1.85 system-ui;color:#222;background:#fff}p{white-space:pre-wrap}small{color:#666}</style><small>Word 文字预览 · 图片、表格布局和批注请用系统应用查看</small>' + ''.join('<p>' + html.escape(p) + '</p>' for p in paragraphs)


HEADERS = {'Cache-Control': 'no-store', 'X-Content-Type-Options': 'nosniff',
           'Content-Security-Policy': "default-src 'none'; style-src 'unsafe-inline'; img-src data: https: http:; sandbox allow-popups allow-popups-to-escape-sandbox"}


PDF_HEADERS = {'Cache-Control': 'no-store', 'X-Content-Type-Options': 'nosniff'}   # a sandboxed page cannot show a PDF in Chrome's viewer


def _granted(ticket: str, request: Request) -> Path:
    local_request(request)
    with _lock:
        grant_ = _grants.get(ticket)
    if not grant_ or grant_[1] < time.time():
        raise HTTPException(404, '预览已过期，请重新点击文件链接')
    path = grant_[0]
    if not path.is_file():
        raise HTTPException(404, '文件已移动或删除')
    return path


@router.get('/v1/file-preview/{ticket}', include_in_schema=False)
def preview(ticket: str, request: Request):
    from pga import docview
    path = _granted(ticket, request)
    ext = path.suffix.lower()
    try:
        if ext in docview.WORD:
            page = docview.word_html(path)
            if page is None:
                if ext != '.docx':
                    raise ValueError('这台机器读不了这个格式的文字，请看版式视图或用系统应用打开')
                page = word_preview(path)
            return HTMLResponse(page, headers=HEADERS)
        if ext in docview.SHEETS:
            return HTMLResponse(docview.sheet_html(path), headers=HEADERS)
        if ext in docview.SLIDES:
            return FileResponse(docview.convert(path), media_type='application/pdf', content_disposition_type='inline', headers=PDF_HEADERS)
    except (ValueError, KeyError, zipfile.BadZipFile, ET.ParseError, OSError) as exc:
        raise HTTPException(422, str(exc) if isinstance(exc, ValueError) else '无法预览这个文件，请用系统应用打开') from exc
    return FileResponse(path, filename=path.name, content_disposition_type='inline', headers=PDF_HEADERS if ext == '.pdf' else HEADERS)


@router.get('/v1/file-preview/{ticket}/pdf', include_in_schema=False)
def preview_pdf(ticket: str, request: Request):
    """As it would print: Word, spreadsheets and slides through LibreOffice (made once per version of the file)."""
    from pga import docview
    path = _granted(ticket, request)
    if path.suffix.lower() == '.pdf':
        return FileResponse(path, media_type='application/pdf', content_disposition_type='inline', headers=PDF_HEADERS)
    try:
        return FileResponse(docview.convert(path), media_type='application/pdf', content_disposition_type='inline', headers=PDF_HEADERS)
    except (ValueError, OSError) as exc:
        raise HTTPException(422, str(exc) if isinstance(exc, ValueError) else '无法生成版式预览') from exc
