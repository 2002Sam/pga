"""Resolve document links without treating them as web URLs or executable commands."""
from pathlib import Path
import os
import re
import stat
import subprocess
import tempfile
import threading
from urllib.parse import unquote, urlsplit


DOCUMENTS = {'.pdf', '.doc', '.docx', '.rtf', '.odt', '.xls', '.xlsx', '.xlsm', '.ods', '.ppt', '.pptx', '.odp', '.csv', '.tsv',
             '.txt', '.md', '.tex', '.png', '.jpg', '.jpeg', '.webp', '.gif', '.svg', '.zip'}
CODE = {'.py', '.js', '.ts', '.jsx', '.tsx', '.html', '.htm', '.css', '.json', '.yaml', '.yml', '.toml',
        '.xml', '.sql', '.swift', '.go', '.rs', '.c', '.h', '.cpp', '.java', '.sh', '.mjs', '.svelte', '.log',
        '.cjs', '.scss', '.less', '.vue', '.kt', '.rb', '.php', '.lua', '.r', '.scala', '.dart', '.cs', '.hpp', '.cc', '.m',
        '.zsh', '.bash', '.ini', '.cfg', '.conf', '.jsonl', '.ipynb', '.graphql', '.proto', '.bib', '.diff', '.patch', '.env.example'}
TEXT = CODE | {'.txt', '.md', '.tex', '.csv', '.tsv', '.svg'}     # what the viewer can edit and save as UTF-8 text


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


def open_document(path: Path, reveal: bool = False) -> None:
    """Open in its own app, or (reveal) show it selected in a Finder window."""
    subprocess.run(['/usr/bin/open', *(['-R'] if reveal else []), str(path)], check=True, capture_output=True, timeout=15)


def jump(raw: str) -> dict:
    """Where a link points inside the file: `app.py:42`, `app.py:42:7` or `app.py#L42C7`."""
    m = re.search(r'(?::(\d+)(?::(\d+))?|#L(\d+)(?:C(\d+))?)$', (raw or '').strip())
    if not m:
        return {}
    line, col = m.group(1) or m.group(3), m.group(2) or m.group(4)
    return {'line': int(line), **({'column': int(col)} if col else {})}


_save_lock = threading.Lock()


def save_text(path: Path, text: str, mtime_ns: str | int | None, force: bool = False) -> str:
    """Write what the viewer edited, unless the file changed on disk since it was read (then ValueError 'changed')."""
    if path.suffix.lower() not in TEXT:
        raise PermissionError('这种文件不能在查看器里保存')
    if len(text.encode('utf-8')) > 5 * 1024 * 1024:
        raise ValueError('内容超过 5 MB，不能在这里保存')
    if not force and (mtime_ns is None or not str(mtime_ns).isdigit()):
        raise ValueError('缺少有效的文件版本，请重新打开文件')
    # A nanosecond timestamp exceeds JavaScript's safe integer range. Transport it
    # as an opaque string, and serialize check + replace for simultaneous saves.
    with _save_lock:
        before = path.stat()
        if not force and before.st_mtime_ns != int(mtime_ns):
            raise ValueError('changed')
        original = path.read_bytes()
        if b'\x00' in original:
            raise ValueError('此文件不是可编辑的 UTF-8 文本')
        try:
            original.decode('utf-8-sig')
        except UnicodeError as exc:
            raise ValueError('此文件不是可编辑的 UTF-8 文本') from exc
        # Textareas normalize newlines. Preserve the file's original convention,
        # BOM and executable bit instead of changing them as a side effect.
        if b'\r\n' in original:
            text = text.replace('\r\n', '\n').replace('\n', '\r\n')
        data = text.encode('utf-8-sig' if original.startswith(b'\xef\xbb\xbf') else 'utf-8')
        fd, name = tempfile.mkstemp(prefix=f'.{path.name}.', suffix='.pga-save', dir=path.parent)
        tmp = Path(name)
        try:
            with os.fdopen(fd, 'wb') as f:
                f.write(data)
                f.flush()
                os.fsync(f.fileno())
                os.fchmod(f.fileno(), stat.S_IMODE(before.st_mode))
            if path.stat().st_mtime_ns != before.st_mtime_ns:
                raise ValueError('changed')
            tmp.replace(path)
            return str(path.stat().st_mtime_ns)
        finally:
            tmp.unlink(missing_ok=True)
