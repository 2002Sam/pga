"""Local VS Code web service and same-origin HTTP/WebSocket bridge for the PGA desktop."""
from __future__ import annotations

import asyncio
import os
from pathlib import Path
import secrets
import re
import subprocess
import threading
import time
import json
from urllib.parse import parse_qsl, urlencode, urlsplit

import httpx
from fastapi import APIRouter, HTTPException, Request, WebSocket
from fastapi.responses import Response

ROOT = Path.home() / 'Documents/PGA/state/editor'
CLI = Path('/Applications/Visual Studio Code.app/Contents/Resources/app/bin/code-tunnel')
PORT = 8012
_lock = threading.Lock()
_process = None
_checked_at = 0.0


def token() -> str:
    ROOT.mkdir(parents=True, exist_ok=True)
    f = ROOT / 'connection-token'
    try:
        fd = os.open(f, os.O_WRONLY | os.O_CREAT | os.O_EXCL, 0o600)
    except FileExistsError:
        return f.read_text().strip()
    value = secrets.token_hex(32)
    with os.fdopen(fd, 'w') as out:
        out.write(value)
    return value


def upstream_url(path: str, query: str = '', *, websocket=False) -> str:
    params = [(k, v) for k, v in parse_qsl(query, keep_blank_values=True) if k != 'tkn']
    params.append(('tkn', token()))
    return f'{"ws" if websocket else "http"}://127.0.0.1:{PORT}/editor' + (f'/{path}' if path else '') + '?' + urlencode(params)


def ensure_started() -> None:
    global _process, _checked_at
    with _lock:
        if time.monotonic() - _checked_at < 5:
            return
        try:
            # /version doesn't fetch a new build; the first workbench request installs it if needed.
            r = httpx.get(upstream_url('version'), timeout=2, trust_env=False)
            if r.status_code == 200:
                _checked_at = time.monotonic()
                return
        except httpx.HTTPError:
            pass
        if not CLI.is_file():
            raise RuntimeError('未找到 VS Code，请先在 Applications 安装 Visual Studio Code')
        token()
        settings = ROOT / 'server/data/Machine/settings.json'
        if not settings.exists():
            settings.parent.mkdir(parents=True, exist_ok=True)
            settings.write_text(json.dumps({'workbench.colorTheme': 'Default Dark Modern',
                'workbench.startupEditor': 'none', 'chat.disableAIFeatures': True,
                'workbench.secondarySideBar.defaultVisibility': 'hidden',
                'editor.minimap.enabled': False, 'editor.fontSize': 13, 'telemetry.telemetryLevel': 'off'}))
        if _process is None or _process.poll() is not None:
            log = (ROOT / 'server.log').open('ab')
            os.chmod(ROOT / 'server.log', 0o600)
            try:
                _process = subprocess.Popen([
                    str(CLI), 'serve-web', '--host', '127.0.0.1', '--port', str(PORT),
                    '--server-base-path', '/editor', '--connection-token-file', str(ROOT / 'connection-token'),
                    '--server-data-dir', str(ROOT / 'server'), '--cli-data-dir', str(ROOT / 'cli'),
                    '--accept-server-license-terms', '--disable-telemetry',
                ], stdin=subprocess.DEVNULL, stdout=log, stderr=log, start_new_session=True)
            finally:
                log.close()
        for _ in range(120):
            if _process.poll() is not None:
                raise RuntimeError('VS Code 服务启动失败，请检查 state/editor/server.log')
            try:
                r = httpx.get(upstream_url('version'), timeout=1, trust_env=False)
                if r.status_code == 200:
                    _checked_at = time.monotonic()
                    return
            except httpx.HTTPError:
                pass
            time.sleep(.1)
        raise RuntimeError('VS Code 服务尚未就绪，请稍后重试')


def local_request(request) -> None:
    if not request.client or request.client.host not in ('127.0.0.1', '::1', 'testclient'):
        raise HTTPException(403, '编辑器只允许本机访问')
    origin = request.headers.get('origin')
    if origin and urlsplit(origin).netloc != request.url.netloc:
        raise HTTPException(403, '不允许跨站访问编辑器')


router = APIRouter()
HOP = {'connection', 'keep-alive', 'proxy-authenticate', 'proxy-authorization', 'te',
       'trailer', 'transfer-encoding', 'upgrade', 'content-length', 'content-encoding'}


@router.api_route('/editor', methods=['GET', 'POST', 'PUT', 'DELETE', 'PATCH', 'HEAD'], include_in_schema=False)
@router.api_route('/editor/{path:path}', methods=['GET', 'POST', 'PUT', 'DELETE', 'PATCH', 'HEAD'], include_in_schema=False)
async def proxy(request: Request, path: str = ''):
    local_request(request)
    try:
        await asyncio.to_thread(ensure_started)
        headers = {k: v for k, v in request.headers.items() if k.lower() not in HOP | {'authorization', 'cookie'}}
        # Use the build's bundled strings; downloaded language packs can lag the installed server build.
        headers['accept-language'] = 'en-US'
        cookies = {k: v for k, v in request.cookies.items() if k in ('vscode-tkn', 'vscode-secret-key-path', 'vscode-cli-secret-half')}
        async with httpx.AsyncClient(trust_env=False, timeout=180, follow_redirects=True) as client:
            result = await client.request(request.method, upstream_url(path, request.url.query),
                                          headers=headers, cookies=cookies, content=await request.body())
        headers = {k: v for k, v in result.headers.items() if k.lower() not in HOP | {'set-cookie'}}
        response = Response(result.content, status_code=result.status_code, headers=headers)
        for hop in [*result.history, result]:
            for cookie in hop.headers.get_list('set-cookie'):
                response.headers.append('set-cookie', re.sub(r'(?i)path=/([^;]*)', 'Path=/editor', cookie))
        return response
    except (httpx.HTTPError, RuntimeError) as exc:
        raise HTTPException(503, 'VS Code 正在准备或暂时不可用，请稍后重试') from exc


@router.websocket('/editor')
@router.websocket('/editor/{path:path}')
async def websocket_proxy(ws: WebSocket, path: str = ''):
    from websockets.asyncio.client import connect
    from websockets.exceptions import ConnectionClosed
    try:
        local_request(ws)
    except HTTPException:
        await ws.close(code=1008)
        return
    tasks = []
    try:
        await asyncio.to_thread(ensure_started)
        async with connect(upstream_url(path, ws.url.query, websocket=True),
                           origin=ws.headers.get('origin'), max_size=None, proxy=None) as upstream:
            await ws.accept()

            async def send():
                while True:
                    message = await ws.receive()
                    if message['type'] == 'websocket.disconnect':
                        return
                    await upstream.send(message.get('bytes') if message.get('bytes') is not None else message['text'])

            async def receive():
                async for message in upstream:
                    if isinstance(message, bytes):
                        await ws.send_bytes(message)
                    else:
                        await ws.send_text(message)

            tasks = [asyncio.create_task(send()), asyncio.create_task(receive())]
            done, _ = await asyncio.wait(tasks, return_when=asyncio.FIRST_COMPLETED)
            for task in done:
                task.result()
    except (ConnectionClosed, RuntimeError, OSError):
        pass
    finally:
        for task in tasks:
            task.cancel()
        await asyncio.gather(*tasks, return_exceptions=True)
        try:
            await ws.close()
        except RuntimeError:
            pass
