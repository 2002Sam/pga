"""The server log is compressed away past a size and starts again (pga.logrotate)."""
from __future__ import annotations

import gzip

from pga.logrotate import ours, rotate


def test_a_big_log_is_archived_and_truncated_in_place(tmp_path):
    p = tmp_path / "pga.log"
    p.write_text("line\n" * 1000)
    assert rotate(p, max_bytes=10_000, check_ours=False) is None                 # small: left alone
    p.write_text("line\n" * 5000)
    with p.open("a") as held:                                                   # the writer keeps its file open
        dest = rotate(p, max_bytes=10_000, check_ours=False)
        held.write("after\n")
    assert dest and gzip.open(dest, "rt").read().count("line") == 5000
    assert p.read_text() == "after\n"
    assert not ours(p) and rotate(p, max_bytes=0) is None                       # not this process's log: untouched
