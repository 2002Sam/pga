"""Documents you attach to a question: their text, read on this machine, so every agent can use them.

PDF through `pdftotext` (poppler), Word / RTF / ODT / HTML through macOS `textutil`, Excel and PowerPoint read
straight from their XML, plain text and code as they are. Nothing is sent anywhere to be read; an agent that can
open files (Claude Code, CodeBuddy) also gets the file's path.
"""

from __future__ import annotations

import re
import shutil
import subprocess
import zipfile
from pathlib import Path
from xml.etree import ElementTree

TEXT = {".txt", ".md", ".markdown", ".csv", ".tsv", ".json", ".yaml", ".yml", ".xml", ".html", ".htm", ".py", ".js", ".ts",
        ".tsx", ".jsx", ".java", ".c", ".h", ".cpp", ".go", ".rs", ".rb", ".sh", ".sql", ".log", ".ini", ".toml", ".css", ".tex", ".swift"}
TEXTUTIL = {".docx", ".doc", ".rtf", ".odt", ".webarchive"}
PER_FILE, TOTAL = 40_000, 120_000


def extract(path: str | Path) -> tuple[str, str]:
    """(text, how) — empty text when the kind is not readable here."""
    p = Path(path)
    ext = p.suffix.lower()
    try:
        if ext == ".pdf":
            exe = shutil.which("pdftotext") or "/opt/homebrew/bin/pdftotext"
            out = subprocess.run([exe, "-layout", str(p), "-"], capture_output=True, text=True, timeout=90)
            return out.stdout, "pdftotext"
        if ext in TEXTUTIL:
            out = subprocess.run(["/usr/bin/textutil", "-convert", "txt", "-stdout", str(p)], capture_output=True, text=True, timeout=90)
            return out.stdout, "textutil"
        if ext == ".xlsx":
            return _xlsx(p), "xlsx"
        if ext == ".pptx":
            return _pptx(p), "pptx"
        if ext in TEXT:
            return p.read_text(encoding="utf-8", errors="replace"), "text"
    except (OSError, subprocess.SubprocessError, zipfile.BadZipFile, ElementTree.ParseError) as exc:
        return "", f"unreadable: {type(exc).__name__}"
    return "", "unsupported"


def _xlsx(p: Path) -> str:
    ns = {"m": "http://schemas.openxmlformats.org/spreadsheetml/2006/main"}
    with zipfile.ZipFile(p) as z:
        shared = []
        if "xl/sharedStrings.xml" in z.namelist():
            for si in ElementTree.fromstring(z.read("xl/sharedStrings.xml")).findall("m:si", ns):
                shared.append("".join(t.text or "" for t in si.iter(f"{{{ns['m']}}}t")))
        out = []
        for name in sorted(n for n in z.namelist() if re.match(r"xl/worksheets/sheet\d+\.xml$", n)):
            out.append(f"## {name.rsplit('/', 1)[-1][:-4]}")
            for row in ElementTree.fromstring(z.read(name)).iter(f"{{{ns['m']}}}row"):
                cells = []
                for c in row.findall("m:c", ns):
                    v = c.find("m:v", ns)
                    val = v.text if v is not None else "".join(t.text or "" for t in c.iter(f"{{{ns['m']}}}t"))
                    if c.get("t") == "s" and val is not None and val.isdigit() and int(val) < len(shared):
                        val = shared[int(val)]
                    cells.append(val or "")
                if any(cells):
                    out.append("\t".join(cells))
        return "\n".join(out)


def _pptx(p: Path) -> str:
    a = "{http://schemas.openxmlformats.org/drawingml/2006/main}t"
    with zipfile.ZipFile(p) as z:
        slides = sorted((n for n in z.namelist() if re.match(r"ppt/slides/slide\d+\.xml$", n)), key=lambda n: int(re.findall(r"\d+", n)[-1]))
        return "\n\n".join(f"## Slide {i + 1}\n" + "\n".join(t.text or "" for t in ElementTree.fromstring(z.read(n)).iter(a))
                           for i, n in enumerate(slides))


def attachments_block(paths: list[str]) -> tuple[str, list[dict]]:
    """The documents as prompt text (each cut to fit), and what was read from each."""
    parts, info, used = [], [], 0
    for path in paths:
        name = Path(path).name.split("-", 2)[-1]
        txt, how = extract(path)
        txt = txt.strip()
        room = max(0, min(PER_FILE, TOTAL - used))
        cut = len(txt) > room
        body = txt[:room]
        used += len(body)
        info.append({"name": name, "chars": len(txt), "how": how, "cut": cut})
        if body:
            parts.append(f'<attachment name="{name}" read_by="{how}"{" truncated=\"true\"" if cut else ""}>\n{body}\n</attachment>')
        else:
            parts.append(f'<attachment name="{name}">(could not read this kind of file here: {how}; path: {path})</attachment>')
    return "\n\n".join(parts), info
