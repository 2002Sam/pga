"""内置文档 / 网页阅读器: Office files and web pages shown inside PGA (pga.docview, pga.webread, pga.filepreview)."""
import zipfile
from html import escape

import pytest
from fastapi import FastAPI
from fastapi.testclient import TestClient

from pga import docview, webread
from pga.filepreview import describe, router


def xlsx(path, sheets):
    """A small real xlsx: sheets = {name: [[cell, ...], ...]}; the first cell of each sheet is a link."""
    with zipfile.ZipFile(path, "w") as z:
        z.writestr("xl/workbook.xml", '<workbook xmlns="http://schemas.openxmlformats.org/spreadsheetml/2006/main" '
                   'xmlns:r="http://schemas.openxmlformats.org/officeDocument/2006/relationships"><sheets>'
                   + "".join(f'<sheet name="{n}" sheetId="{i + 1}" r:id="rId{i + 1}"/>' for i, n in enumerate(sheets)) + "</sheets></workbook>")
        z.writestr("xl/_rels/workbook.xml.rels", '<Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships">'
                   + "".join(f'<Relationship Id="rId{i + 1}" Target="worksheets/sheet{i + 1}.xml"/>' for i in range(len(sheets))) + "</Relationships>")
        z.writestr("xl/sharedStrings.xml", '<sst xmlns="http://schemas.openxmlformats.org/spreadsheetml/2006/main"><si><t>共享 &amp; 文字</t></si></sst>')
        for i, rows in enumerate(sheets.values()):
            data = "".join(f'<row r="{r + 1}">' + "".join(
                f'<c r="{chr(65 + c)}{r + 1}" t="inlineStr"><is><t>{escape(v)}</t></is></c>' if isinstance(v, str) else f'<c r="{chr(65 + c)}{r + 1}"><v>{v}</v></c>'
                for c, v in enumerate(row)) + "</row>" for r, row in enumerate(rows))
            data += '<row r="9"><c r="B9" t="s"><v>0</v></c></row>'
            z.writestr(f"xl/worksheets/sheet{i + 1}.xml", '<worksheet xmlns="http://schemas.openxmlformats.org/spreadsheetml/2006/main" '
                       'xmlns:r="http://schemas.openxmlformats.org/officeDocument/2006/relationships">'
                       f'<sheetData>{data}</sheetData><hyperlinks><hyperlink ref="A1" r:id="rL"/></hyperlinks></worksheet>')
            z.writestr(f"xl/worksheets/_rels/sheet{i + 1}.xml.rels", '<Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships">'
                       '<Relationship Id="rL" Target="https://example.com/job" TargetMode="External"/></Relationships>')


def test_spreadsheets_become_tables_with_their_links_and_every_sheet(tmp_path):
    p = tmp_path / "求职.xlsx"
    xlsx(p, {"公司": [["官网", "城市"], ["<script>x</script>", 42]], "备注": [["一"]]})
    sheets = docview.xlsx_sheets(p)
    assert [s["name"] for s in sheets] == ["公司", "备注"]
    assert sheets[0]["rows"][0][0] == ("官网", "https://example.com/job") and sheets[0]["rows"][1][1] == ("42", None)
    assert sheets[0]["rows"][8][1][0] == "共享 & 文字"                              # row 9, after empty rows
    page = docview.sheet_html(p)
    assert 'href="https://example.com/job"' in page and "&lt;script&gt;" in page and "<script>x" not in page
    assert '<a href="#s1">备注</a>' in page                                          # a tab per sheet
    c = tmp_path / "a.csv"
    c.write_text("名字,链接\n张三,https://a.example/x\n", encoding="utf-8")
    assert docview.sheet_html(c).count("<tr>") == 2 and 'href="https://a.example/x"' in docview.sheet_html(c)


@pytest.mark.skipif(not docview.textutil(), reason="textutil is macOS only")
def test_word_becomes_a_page_of_html_at_reading_size(tmp_path):
    p = tmp_path / "简历.rtf"
    p.write_text(r"{\rtf1\ansi{\fonttbl\f0 Times;}\f0\fs20 {\b Bold} line\par second <script>\par}", encoding="ascii")
    page = docview.word_html(p)
    assert "Bold" in page and "<b>" in page.lower() or "bold" in page.lower()
    assert "<script>" not in page and 'class=page' in page
    assert "14.5px" in page                                                           # 10 px of the printed page, shown at reading size


def test_preview_routes_serve_sheets_and_layout_pdfs(tmp_path, monkeypatch):
    p = tmp_path / "表.xlsx"
    xlsx(p, {"S": [["a"]]})
    info = describe(p, "testserver")
    assert info["kind"] == "sheet"
    w = tmp_path / "文.docx"
    w.write_bytes(b"not really")
    pdf = tmp_path / "made.pdf"
    pdf.write_bytes(b"%PDF-1.4 fake")
    monkeypatch.setattr(docview, "soffice", lambda: "/bin/true")
    monkeypatch.setattr(docview, "convert", lambda path, to="pdf", timeout=120: pdf)
    winfo = describe(w, "testserver")
    assert winfo["kind"] == "document" and winfo["pdf_url"].endswith("/pdf")
    app = FastAPI(); app.include_router(router)
    with TestClient(app) as c:
        r = c.get(info["url"])
        assert r.status_code == 200 and "<table>" in r.text and "sandbox" in r.headers["content-security-policy"]
        r = c.get(winfo["pdf_url"])
        assert r.status_code == 200 and r.content.startswith(b"%PDF") and "content-security-policy" not in r.headers   # Chrome shows no PDF in a sandbox
        assert c.get(winfo["pdf_url"], headers={"origin": "https://evil.example"}).status_code == 403


PAGE = """<html lang="zh"><head><title>站点标题</title><meta property="og:title" content="一篇文章">
<meta name="description" content="摘要"><link rel="icon" href="/i.png"></head><body>
<nav class="menu"><a href="/a">首页</a><a href="/b">关于</a></nav><div class="sidebar"><p>侧栏广告侧栏广告侧栏广告侧栏广告侧栏广告侧栏广告</p></div>
<div class="content"><h2>小标题</h2>""" + "".join(f"<p>第{i}段正文，这里有足够长的文字，说明这一段确实是正文的一部分，而不是菜单。<a href='/x{i}'>链接</a></p>" for i in range(6)) + """
<img data-src="/pic.png" src="data:image/gif;base64,AAA"><script>alert(1)</script><pre>  code
  kept</pre></div><footer><p>版权所有版权所有版权所有版权所有版权所有版权所有版权所有</p></footer></body></html>"""


def test_reader_mode_takes_the_article_out_of_the_page():
    a = webread.article(PAGE, "https://site.example/post/1")
    assert a["title"] == "一篇文章" and a["description"] == "摘要" and a["icon"] == "https://site.example/i.png"
    h = a["html"]
    assert "第5段正文" in h and "<h2>小标题</h2>" in h
    assert "首页" not in h and "侧栏广告" not in h and "版权所有" not in h and "alert" not in h
    assert 'href="https://site.example/x0"' in h and '<img src="https://site.example/pic.png"' in h
    assert "  code\n  kept" in h and not a["thin"]


def test_reader_refuses_local_addresses_and_reads_frame_rules(monkeypatch):
    for url in ["http://127.0.0.1:8010/v1/agents", "http://192.168.1.1/", "file:///etc/passwd", "http://localhost/"]:
        with pytest.raises(webread.ReadError):
            webread.fetch(url)
    assert webread.frameable({}) and not webread.frameable({"x-frame-options": "SAMEORIGIN"})
    assert not webread.frameable({"content-security-policy": "frame-ancestors 'self'"})
    assert webread.frameable({"content-security-policy": "default-src *; frame-ancestors *"})
