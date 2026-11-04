"""Resolve document links without treating them as web URLs or executable commands."""
from pathlib import Path
import re
import subprocess
import tempfile
from urllib.parse import unquote, urlsplit


DOCUMENTS = {'.pdf', '.doc', '.docx', '.xls', '.xlsx', '.ppt', '.pptx', '.csv', '.tsv',
             '.txt', '.md', '.tex', '.png', '.jpg', '.jpeg', '.webp', '.gif', '.svg', '.zip'}
CODE = {'.py', '.js', '.ts', '.jsx', '.tsx', '.html', '.css', '.json', '.yaml', '.yml', '.toml',
        '.xml', '.sql', '.swift', '.go', '.rs', '.c', '.h', '.cpp', '.java', '.sh', '.mjs', '.svelte', '.log'}


def resolve_document(raw: str, folders: list[str], *, editor=False) -> Path:
    raw = raw.strip()
    if raw.startswith('file:'):
        url = urlsplit(raw)
        if url.netloc not in ('', 'localhost'):
            raise ValueError('不支持远程文件地址')
        raw = url.path
    elif raw.startswith('sandbox:'):
        raw = raw[len('sandbox:'):]
    elif re.match(r'^[a-zA-Z][a-zA-Z\d+.-]*:', raw):
        raise ValueError('不是本地文件路径')
    raw = re.sub(r'(?::\d+(?::\d+)?|#L\d+(?:C\d+)?)$', '', raw)
    raw = unquote(raw)
    if not raw or '\x00' in raw:
        raise ValueError('文件路径无效')
    p = Path(raw).expanduser()
    candidates = [p] if p.is_absolute() else [Path(f).expanduser() / p for f in folders if f]
    for candidate in candidates:
        resolved = candidate.resolve()
        # Never open executables, app bundles, private configuration, or arbitrary system files.
        roots = [Path.home().resolve(), Path('/tmp').resolve(), Path(tempfile.gettempdir()).resolve(),
                 *(Path(f).expanduser().resolve() for f in folders if f)]
        if not any(resolved.is_relative_to(root) for root in roots):
            continue
        if any(part.startswith('.') for part in resolved.parts) or resolved.suffix.lower() not in (DOCUMENTS | CODE if editor else DOCUMENTS):
            raise ValueError('此链接不是可打开的文档文件')
        if resolved.is_file():
            return resolved
    raise FileNotFoundError('找不到这个文件。它可能已移动，或只存在于原会话的云端环境中。')


def open_document(path: Path) -> None:
    subprocess.run(['/usr/bin/open', str(path)], check=True, capture_output=True, timeout=15)
