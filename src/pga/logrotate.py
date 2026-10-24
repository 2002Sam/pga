"""The server's log stays small: past a size it is compressed into a dated archive beside it and starts again empty.

launchd writes PGA's output straight into ~/Documents/PGA/logs/pga.log and never rotates it (it had reached 169 MB).
Here the file is copied into pga.log.<time>.gz and then truncated in place ("copytruncate"): launchd keeps writing to
the same open file, from its new start. Archives are kept; nothing is deleted. Only the file this process is actually
writing to is touched.
"""
from __future__ import annotations

import gzip
import logging
import os
import shutil
import time
from pathlib import Path

log = logging.getLogger(__name__)

MAX_BYTES = 50 * 1024 * 1024


def default_path() -> Path:
    from pga.agents.pool import ROOT
    return ROOT.parent / "logs" / "pga.log"


def ours(path: Path) -> bool:
    """Is this the file our stdout goes to? (A test or another process's log is left alone.)"""
    try:
        a, b = os.fstat(1), os.stat(path)
    except OSError:
        return False
    return (a.st_dev, a.st_ino) == (b.st_dev, b.st_ino)


def rotate(path: Path | None = None, max_bytes: int = MAX_BYTES, check_ours: bool = True) -> Path | None:
    path = path or default_path()
    try:
        if path.stat().st_size <= max_bytes or (check_ours and not ours(path)):
            return None
    except OSError:
        return None
    dest = path.with_name(f"{path.name}.{time.strftime('%Y%m%d-%H%M%S')}.gz")
    with path.open("rb") as src, gzip.open(dest, "wb", compresslevel=6) as out:
        shutil.copyfileobj(src, out, 1024 * 1024)
    os.truncate(path, 0)
    log.info("log rotated into %s", dest.name)
    return dest
