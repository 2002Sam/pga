"""内置文档阅读器的转换部分: Office files shown inside PGA instead of handed to another app.

- Word (docx, doc, rtf, odt): macOS `textutil` turns it into HTML in a fraction of a second (headings, bold, lists and
  tables kept), shown at reading size on a page; the layout view is a PDF made by LibreOffice (`soffice`), as the file
  would print, pictures included.
- Spreadsheets (xlsx, xlsm, csv, tsv; xls and ods through LibreOffice): every sheet as a table, a tab per sheet, links
  in cells kept. Read with the standard library: no extra package.
- Slides (pptx, ppt, odp): a PDF made by LibreOffice.

Conversions are kept in state/preview-cache/, keyed by the file's path, size and time, so a file opens at once the second
time and is converted again only when it changes. Nothing is written next to your files."""
from __future__ import annotations

import csv
import hashlib
import html
import io
import os
import re
import shutil
import subprocess
import tempfile
import threading
import zipfile
from pathlib import Path
from xml.etree import ElementTree as ET

CACHE = Path.home() / "Documents/PGA/state/preview-cache"
WORD = {".docx", ".doc", ".rtf", ".odt"}
SHEETS = {".xlsx", ".xlsm", ".xls", ".ods", ".csv", ".tsv"}
SLIDES = {".pptx", ".ppt", ".odp"}
MAX_ROWS, MAX_COLS = 3000, 80
_soffice_lock = threading.Lock()          # one LibreOffice at a time: two instances on one profile refuse to start


def soffice() -> str | None:
    for p in (shutil.which("soffice"), "/opt/homebrew/bin/soffice", "/Applications/LibreOffice.app/Contents/MacOS/soffice"):
        if p and os.access(p, os.X_OK):
            return p
    return None


def textutil() -> str | None:
    p = "/usr/bin/textutil"
    return p if os.access(p, os.X_OK) else None


# LibreOffice without a window draws text through the fontconfig it ships with, which knows only its own fonts: Chinese
# (and every other script those lack) came out blank in layout views and slides. This points it at the Mac's fonts too,
# and asks for Chinese faces first where a document names one this Mac does not have.
FONTS_CONF = """<?xml version="1.0"?>
<!DOCTYPE fontconfig SYSTEM "fonts.dtd">
<fontconfig>
  <dir>/System/Library/Fonts</dir><dir>/System/Library/Fonts/Supplemental</dir><dir>/Library/Fonts</dir><dir>~/Library/Fonts</dir>
  <dir>/Applications/LibreOffice.app/Contents/Resources/fonts/truetype</dir>
  <cachedir>{cache}</cachedir>
  <alias><family>PingFang SC</family><prefer><family>Hiragino Sans GB</family><family>STHeiti</family></prefer></alias>
  <alias><family>Microsoft YaHei</family><prefer><family>Hiragino Sans GB</family><family>STHeiti</family></prefer></alias>
  <alias><family>SimSun</family><prefer><family>Songti SC</family><family>STSong</family></prefer></alias>
  <alias><family>SimHei</family><prefer><family>STHeiti</family><family>Hiragino Sans GB</family></prefer></alias>
  <alias><family>sans-serif</family><prefer><family>Hiragino Sans GB</family><family>STHeiti</family><family>Arial Unicode MS</family></prefer></alias>
  <alias><family>serif</family><prefer><family>Songti SC</family><family>STSong</family><family>Arial Unicode MS</family></prefer></alias>
</fontconfig>
"""
RENDER = "fonts2"                         # in the cache key: previews made before the Mac's fonts were found are made again


def _fonts_env() -> dict:
    conf = CACHE / "fontconfig" / "fonts.conf"
    text = FONTS_CONF.format(cache=CACHE / "fontconfig" / "cache")
    if not conf.exists() or conf.read_text(encoding="utf-8") != text:
        conf.parent.mkdir(parents=True, exist_ok=True)
        conf.write_text(text, encoding="utf-8")
    return {**os.environ, "FONTCONFIG_FILE": str(conf)}


def _cached(path: Path, ext: str) -> Path:
    st = path.stat()
    key = hashlib.sha1(f"{path.resolve()}|{st.st_size}|{st.st_mtime_ns}|{RENDER}".encode()).hexdigest()[:20]
    CACHE.mkdir(parents=True, exist_ok=True)
    return CACHE / f"{key}{ext}"


def convert(path: Path, to: str = "pdf", timeout: int = 120) -> Path:
    """The file converted by LibreOffice (pdf, or xlsx for old spreadsheets); made once per version of the file."""
    out = _cached(path, "." + to)
    if out.exists() and out.stat().st_size:
        return out
    exe = soffice()
    if not exe:
        raise ValueError("没有找到 LibreOffice（soffice），无法生成版式预览；可以用系统应用打开")
    with _soffice_lock, tempfile.TemporaryDirectory(prefix="pga-lo-") as tmp:
        if out.exists() and out.stat().st_size:
            return out
        src = Path(tmp) / ("in" + path.suffix.lower())          # a plain name: odd characters in the original do not reach the command line
        shutil.copyfile(path, src)
        profile = CACHE / "lo-profile"
        try:
            subprocess.run([exe, f"-env:UserInstallation=file://{profile}", "--headless", "--norestore", "--convert-to", to,
                            "--outdir", tmp, str(src)], capture_output=True, timeout=timeout, check=False, env=_fonts_env())
        except subprocess.TimeoutExpired as exc:
            raise ValueError("转换超时，文件可能太大；可以用系统应用打开") from exc
        made = Path(tmp) / ("in." + to)
        if not made.exists() or not made.stat().st_size:
            raise ValueError("LibreOffice 没能转换这个文件；可以用系统应用打开")
        shutil.move(str(made), out)
    return out


# ------------------------------------------------------------------------------------------------ Word
PAGE_CSS = """body{margin:0;background:#e9e9ec;color:#1d1d1f}
.page{box-sizing:border-box;max-width:860px;margin:28px auto;padding:56px 64px;background:#fff;box-shadow:0 2px 14px #0002;
  border-radius:4px;font:16px/1.75 -apple-system,BlinkMacSystemFont,'PingFang SC','Hiragino Sans GB',system-ui,sans-serif;overflow-wrap:anywhere}
.page table{border-collapse:collapse;max-width:100%}.page td,.page th{border:1px solid #ccc;padding:4px 8px;vertical-align:top}
.page img{max-width:100%}.page a{color:#2563c9}
@media (max-width:640px){.page{margin:0;padding:24px 18px;border-radius:0}}"""


def _bigger(css: str) -> str:
    """textutil writes the sizes of the printed page (10-12 px for body text): scaled up to reading size, fonts left to ours."""
    css = re.sub(r"(\d+(?:\.\d+)?)px", lambda m: f"{float(m.group(1)) * 1.45:.1f}px" if float(m.group(1)) > 3 else m.group(0), css)
    return re.sub(r"(font:\s*(?:bold\s+|italic\s+)*[\d.]+px)\s+[^;}]+", r"\1 inherit", css)


def _rtl(path: Path) -> bool:
    """Whether a Word file really has right-to-left paragraphs (Arabic, Hebrew); only docx can be told, the rest is trusted."""
    if path.suffix.lower() != ".docx":
        return True
    try:
        with zipfile.ZipFile(path) as z:
            xml = z.read("word/document.xml").decode("utf-8", "replace")
    except (KeyError, zipfile.BadZipFile, OSError):
        return True
    return bool(re.search(r'<w:(bidi|rtl)(?:\s*/>|\s+w:val="(?:1|true|on)")', xml))


def word_html(path: Path) -> str | None:
    """The document as HTML (textutil), on a page; None when textutil is not there or cannot read it."""
    exe = textutil()
    if not exe:
        return None
    with tempfile.TemporaryDirectory(prefix="pga-tu-") as tmp:
        src = Path(tmp) / ("in" + path.suffix.lower())
        shutil.copyfile(path, src)
        try:
            r = subprocess.run([exe, "-convert", "html", "-stdout", str(src)], capture_output=True, timeout=30, check=False)
        except subprocess.TimeoutExpired:
            return None
    if r.returncode or not r.stdout:
        return None
    doc = r.stdout.decode("utf-8", "replace")
    styles = "\n".join(_bigger(s) for s in re.findall(r"<style[^>]*>(.*?)</style>", doc, re.S | re.I))
    body = re.search(r"<body[^>]*>(.*)</body>", doc, re.S | re.I)
    body = body.group(1) if body else doc
    body = re.sub(r"<(script|iframe|object|embed)\b.*?(</\1>|$)", "", body, flags=re.S | re.I)
    if not _rtl(path):                                    # textutil reads Word's "not right-to-left" (w:bidi w:val="0") as right-to-left
        body = body.replace(' dir="rtl"', "")
    return (f'<!doctype html><meta charset="utf-8"><title>{html.escape(path.name)}</title>'
            f"<style>{styles}\n{PAGE_CSS}</style><div class=page>{body}</div>")


# ------------------------------------------------------------------------------------------------ spreadsheets
NS = {"m": "http://schemas.openxmlformats.org/spreadsheetml/2006/main",
      "r": "http://schemas.openxmlformats.org/officeDocument/2006/relationships",
      "rel": "http://schemas.openxmlformats.org/package/2006/relationships"}


def _col(ref: str) -> int:
    n = 0
    for ch in re.match(r"[A-Z]+", ref).group(0):
        n = n * 26 + ord(ch) - 64
    return n - 1


def _text(el) -> str:
    return "".join(t.text or "" for t in el.iter(f"{{{NS['m']}}}t"))


def xlsx_sheets(path: Path) -> list[dict]:
    """Every sheet of an xlsx: its name and its rows (strings), with the links in its cells."""
    with zipfile.ZipFile(path) as z:
        names = set(z.namelist())
        read = lambda n: ET.fromstring(z.read(n))                                            # noqa: E731
        shared = [_text(si) for si in read("xl/sharedStrings.xml").findall("m:si", NS)] if "xl/sharedStrings.xml" in names else []
        rels = {r.get("Id"): r.get("Target") for r in read("xl/_rels/workbook.xml.rels").findall("rel:Relationship", NS)}
        out = []
        sheets_el = read("xl/workbook.xml").find("m:sheets", NS)
        for sh in (list(sheets_el) if sheets_el is not None else []):
            target = rels.get(sh.get(f"{{{NS['r']}}}id"), "")
            part = target.lstrip("/") if target.startswith("/") else "xl/" + target
            if part not in names:
                continue
            info = z.getinfo(part)
            if info.file_size > 60 * 1024 * 1024:
                out.append({"name": sh.get("name"), "rows": [["（这个工作表太大，请用系统应用打开）"]], "links": {}})
                continue
            root = read(part)
            links = {}
            prels = part.rsplit("/", 1)[0] + "/_rels/" + part.rsplit("/", 1)[1] + ".rels"
            if prels in names:
                targets = {r.get("Id"): r.get("Target") for r in read(prels).findall("rel:Relationship", NS)}
                for hl in root.iter(f"{{{NS['m']}}}hyperlink"):
                    t = targets.get(hl.get(f"{{{NS['r']}}}id"))
                    if t and re.match(r"https?://", t):
                        links[hl.get("ref", "").split(":")[0]] = t
            rows = []
            for row in root.iter(f"{{{NS['m']}}}row"):
                if len(rows) >= MAX_ROWS:
                    break
                cells = {}
                for c in row.findall("m:c", NS):
                    ref, t = c.get("r") or "", c.get("t")
                    v = c.find("m:v", NS)
                    if t == "s" and v is not None:
                        val = shared[int(v.text)] if v.text and v.text.isdigit() and int(v.text) < len(shared) else ""
                    elif t == "inlineStr":
                        is_ = c.find("m:is", NS)
                        val = _text(is_) if is_ is not None else ""
                    elif t == "b" and v is not None:
                        val = "TRUE" if v.text == "1" else "FALSE"
                    else:
                        val = v.text if v is not None and v.text is not None else ""
                    if ref:
                        cells[_col(ref)] = (val, links.get(ref))
                if cells:
                    width = min(MAX_COLS, max(cells) + 1)
                    idx = int(row.get("r") or len(rows) + 1)
                    while len(rows) < idx - 1 and len(rows) < MAX_ROWS:   # empty rows in between stay empty
                        rows.append([])
                    rows.append([cells.get(i, ("", None)) for i in range(width)])
            out.append({"name": sh.get("name") or f"Sheet{len(out) + 1}", "rows": rows})
        return out


def delimited_sheets(path: Path) -> list[dict]:
    raw = path.read_bytes()[:30 * 1024 * 1024]
    for enc in ("utf-8-sig", "gb18030", "latin-1"):
        try:
            text = raw.decode(enc)
            break
        except UnicodeDecodeError:
            continue
    delim = "\t" if path.suffix.lower() == ".tsv" else (csv.Sniffer().sniff(text[:4096], ",;\t|").delimiter if text.strip() else ",")
    rows = []
    for r in csv.reader(io.StringIO(text), delimiter=delim):
        if len(rows) >= MAX_ROWS:
            break
        rows.append([(v, v if re.match(r"https?://\S+$", v) else None) for v in r[:MAX_COLS]])
    return [{"name": path.name, "rows": rows}]


SHEET_CSS = """body{margin:0;font:13px/1.45 -apple-system,BlinkMacSystemFont,'PingFang SC',system-ui,sans-serif;color:#1d1d1f;background:#fff}
nav{position:sticky;top:0;z-index:2;display:flex;gap:4px;padding:8px;background:#f3f3f5;border-bottom:1px solid #ddd;overflow-x:auto}
nav a{padding:3px 10px;border-radius:6px;color:#333;text-decoration:none;white-space:nowrap;background:#fff;border:1px solid #ddd}
.sheet{display:none}.sheet:target{display:block}.sheets:not(:has(.sheet:target)) .sheet:first-child{display:block}
table{border-collapse:collapse;margin:0}td,th{border:1px solid #e1e1e5;padding:3px 7px;vertical-align:top;max-width:420px;overflow-wrap:anywhere;white-space:pre-wrap}
th{position:sticky;left:0;background:#f7f7f9;color:#888;font-weight:400;text-align:right;min-width:28px}
tr:first-child td{background:#f9f9fb;font-weight:600}a{color:#2563c9}.note{padding:6px 10px;color:#888}"""


def sheet_html(path: Path) -> str:
    ext = path.suffix.lower()
    if ext in (".csv", ".tsv"):
        sheets = delimited_sheets(path)
    elif ext in (".xlsx", ".xlsm"):
        sheets = xlsx_sheets(path)
    else:                                                       # xls / ods: LibreOffice makes an xlsx of it first
        sheets = xlsx_sheets(convert(path, "xlsx"))
    nav = "".join(f'<a href="#s{i}">{html.escape(s["name"])}</a>' for i, s in enumerate(sheets)) if len(sheets) > 1 else ""
    parts = []
    for i, s in enumerate(sheets):
        body = []
        for n, row in enumerate(s["rows"], 1):
            cells = "".join(f'<td><a href="{html.escape(u)}" target="_blank" rel="noopener">{html.escape(v)}</a></td>' if u
                            else f"<td>{html.escape(v)}</td>" for v, u in row)
            body.append(f"<tr><th>{n}</th>{cells}</tr>")
        more = '<div class="note">只显示前 3000 行</div>' if len(s["rows"]) >= MAX_ROWS else ""
        parts.append(f'<section class="sheet" id="s{i}"><table>{"".join(body) or "<tr><td>（空表）</td></tr>"}</table>{more}</section>')
    return (f'<!doctype html><meta charset="utf-8"><title>{html.escape(path.name)}</title><style>{SHEET_CSS}</style>'
            f'{f"<nav>{nav}</nav>" if nav else ""}<div class="sheets">{"".join(parts)}</div>')
