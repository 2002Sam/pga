"""Short-lived preview URLs for files explicitly selected from a conversation."""
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
BINARY = {'.doc', '.xls', '.xlsx', '.ppt', '.pptx', '.zip'}


def describe(path: Path, authority: str) -> dict:
    result = {'name': path.name, 'path': str(path)}
    ext = path.suffix.lower()
    if ext in BINARY:
        return {**result, 'kind': 'external', 'message': '此格式暂不支持内置预览，请用系统应用查看完整内容。'}
    if ext == '.pdf' or ext in IMAGES or ext == '.docx':
        ticket = secrets.token_urlsafe(24)
        with _lock:
            now = time.time()
            for key, (_, expires) in list(_grants.items()):
                if expires < now:
                    _grants.pop(key, None)
            while len(_grants) >= 256:
                _grants.pop(next(iter(_grants)))
            _grants[ticket] = (path, now + 4 * 3600)
        return {**result, 'kind': 'image' if ext in IMAGES else 'document',
                'url': '/v1/file-preview/' + ticket, 'text_only': ext == '.docx'}
    if path.stat().st_size > 2 * 1024 * 1024:
        return {**result, 'kind': 'external', 'message': '文件超过 2 MB，请用系统应用查看。'}
    try:
        text = path.read_text(encoding='utf-8-sig')
        if '\x00' in text:
            raise ValueError('binary file')
    except (UnicodeError, ValueError):
        return {**result, 'kind': 'external', 'message': '此文件不是 UTF-8 文本，请用系统应用查看。'}
    return {**result, 'kind': 'text', 'text': text, 'markdown': ext == '.md'}


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


@router.get('/v1/file-preview/{ticket}', include_in_schema=False)
def preview(ticket: str, request: Request):
    local_request(request)
    with _lock:
        grant = _grants.get(ticket)
    if not grant or grant[1] < time.time():
        raise HTTPException(404, '预览已过期，请重新点击文件链接')
    path = grant[0]
    if not path.is_file():
        raise HTTPException(404, '文件已移动或删除')
    headers = {'Cache-Control': 'no-store', 'X-Content-Type-Options': 'nosniff',
               'Content-Security-Policy': "default-src 'none'; style-src 'unsafe-inline'; sandbox"}
    if path.suffix.lower() == '.docx':
        try:
            return HTMLResponse(word_preview(path), headers=headers)
        except (ValueError, KeyError, zipfile.BadZipFile, ET.ParseError) as exc:
            raise HTTPException(422, '无法预览此 Word 文件，请用系统应用打开') from exc
    return FileResponse(path, filename=path.name, content_disposition_type='inline', headers=headers)
