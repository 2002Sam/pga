"""网页阅读: a link opened inside PGA. The page is fetched here (with the proxy PGA uses), and its article is taken out of
the menus, ads and scripts around it (reader mode); the page's own title, site, description and picture make a card above it.
Whether the original page may be shown in a frame (X-Frame-Options / CSP frame-ancestors) is said too, so the reader can
offer it. A PDF or a picture behind the link is kept in the preview cache and shown as such.

Only public addresses are fetched: an address on this machine or the local network is refused (a link in an answer must
not reach your router or PGA itself)."""
from __future__ import annotations

import hashlib
import ipaddress
import re
import socket
from html import escape
from html.parser import HTMLParser
from urllib.parse import urljoin, urlsplit

import httpx

from pga import docview

MAX_BYTES = 8 * 1024 * 1024
UA = ("Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/130.0 Safari/537.36")
DROP = {"script", "style", "noscript", "template", "svg", "iframe", "form", "nav", "footer", "aside", "button", "input", "select",
        "textarea", "dialog", "canvas", "object", "embed", "head", "link", "meta"}
KEEP = {"p", "h1", "h2", "h3", "h4", "h5", "h6", "ul", "ol", "li", "blockquote", "pre", "code", "table", "thead", "tbody", "tr", "th",
        "td", "a", "img", "strong", "em", "b", "i", "br", "hr", "figure", "figcaption", "dl", "dt", "dd", "sup", "sub", "mark", "del"}
VOID = {"br", "hr", "img", "meta", "link", "input", "source", "area", "base", "col", "embed", "param", "track", "wbr"}
NOISE = re.compile(r"comment|sidebar|footer|\bfoot\b|\bnav|menu|\bshare\b|sharing|social|related|advert|\bads?\b|promo|cookie|subscribe|breadcrumb|"
                   r"newsletter|popup|modal|banner|recommend|toolbar|login|signup", re.I)


FAKE_IP = ipaddress.ip_network("198.18.0.0/15")


class ReadError(ValueError):
    pass


# ------------------------------------------------------------------------------------------------ fetching
def _public(host: str) -> None:
    try:
        infos = socket.getaddrinfo(host, None)
    except socket.gaierror as exc:
        raise ReadError(f"找不到这个网站：{host}") from exc
    for info in infos:
        ip = ipaddress.ip_address(info[4][0].split("%")[0])
        if ip in FAKE_IP:                                  # a proxy's fake-IP DNS (Clash, Surge): the proxy reaches the real host
            continue
        if ip.is_private or ip.is_loopback or ip.is_link_local or ip.is_reserved or ip.is_multicast or ip.is_unspecified:
            raise ReadError("这是本机或局域网里的地址，内置阅读器不打开它；可以在浏览器里打开")


def fetch(url: str, timeout: float = 15) -> tuple[str, dict, bytes]:
    """(final url, headers, body) of a public http(s) URL, following up to 5 redirects, each one checked."""
    with httpx.Client(timeout=timeout, follow_redirects=False, headers={"User-Agent": UA, "Accept-Language": "zh-CN,zh;q=0.9,en;q=0.8",
                                                                       "Accept": "text/html,application/xhtml+xml,*/*;q=0.8"}) as c:
        for _ in range(6):
            parts = urlsplit(url)
            if parts.scheme not in ("http", "https") or not parts.hostname:
                raise ReadError("只能打开 http 和 https 链接")
            _public(parts.hostname)
            with c.stream("GET", url) as r:
                if r.is_redirect and r.headers.get("location"):
                    url = urljoin(url, r.headers["location"])
                    continue
                if r.status_code >= 400:
                    raise ReadError(f"网站返回了 {r.status_code}，内容打不开；可以在浏览器里试试")
                body = b""
                for chunk in r.iter_bytes():
                    body += chunk
                    if len(body) > MAX_BYTES:
                        raise ReadError("页面太大（超过 8 MB），请在浏览器里打开")
                return str(r.url), {k.lower(): v for k, v in r.headers.items()}, body
        raise ReadError("跳转次数太多")


def frameable(headers: dict) -> bool:
    xfo = headers.get("x-frame-options", "").lower()
    if "deny" in xfo or "sameorigin" in xfo:
        return False
    m = re.search(r"frame-ancestors([^;]*)", headers.get("content-security-policy", ""), re.I)
    return not m or "*" in m.group(1).split()


# ------------------------------------------------------------------------------------------------ a small DOM
class Node:
    __slots__ = ("tag", "attrs", "kids", "parent")

    def __init__(self, tag, attrs=None, parent=None):
        self.tag, self.attrs, self.kids, self.parent = tag, dict(attrs or {}), [], parent

    def text(self) -> str:
        return "".join(k if isinstance(k, str) else k.text() for k in self.kids)

    def walk(self):
        yield self
        for k in self.kids:
            if isinstance(k, Node):
                yield from k.walk()


class _Builder(HTMLParser):
    def __init__(self):
        super().__init__(convert_charrefs=True)
        self.root = self.cur = Node("#root")

    def handle_starttag(self, tag, attrs):
        n = Node(tag, attrs, self.cur)
        self.cur.kids.append(n)
        if tag not in VOID:
            self.cur = n

    def handle_startendtag(self, tag, attrs):
        self.cur.kids.append(Node(tag, attrs, self.cur))

    def handle_endtag(self, tag):
        n = self.cur
        while n is not None and n.tag != tag:
            n = n.parent
        if n is not None and n.parent is not None:     # closes what was left open inside it too
            self.cur = n.parent

    def handle_data(self, data):
        self.cur.kids.append(data)


def parse(html_text: str) -> Node:
    b = _Builder()
    b.feed(html_text)
    b.close()
    return b.root


# ------------------------------------------------------------------------------------------------ reader mode
def _noisy(n: Node) -> bool:
    if n.tag in ("article", "main", "body", "html"):
        return False
    noisy = bool(NOISE.search(f'{n.attrs.get("class", "")} {n.attrs.get("id", "")} {n.attrs.get("role", "")}')) or n.attrs.get("aria-hidden") == "true" \
        or "display:none" in n.attrs.get("style", "").replace(" ", "")
    return noisy and not any(k.tag in ("article", "main") for k in n.walk())     # never throw away what holds the article


def _prune(n: Node) -> None:
    n.kids = [k for k in n.kids if isinstance(k, str) or not (k.tag in DROP or k.tag == "header" and n.tag != "article" or _noisy(k))]
    for k in n.kids:
        if isinstance(k, Node):
            _prune(k)


def _link_density(n: Node) -> float:
    total = len(n.text().strip()) or 1
    return sum(len(a.text()) for a in n.walk() if a.tag == "a") / total


def main_node(root: Node) -> Node:
    """The node that holds the article: scored by the text of the paragraphs right under it (Readability's way)."""
    score: dict[int, float] = {}
    nodes: dict[int, Node] = {}
    for p in root.walk():
        if p.tag not in ("p", "pre", "blockquote", "li", "h2", "h3") or p.parent is None:
            continue
        t = re.sub(r"\s+", " ", p.text()).strip()
        if len(t) < 25 and p.tag == "p":
            continue
        s = 1 + min(len(t) / 100, 3) + t.count("，") + t.count(",") * .5
        for up, w in ((p.parent, 1.0), (p.parent.parent if p.parent else None, .5)):
            if up is not None:
                score[id(up)] = score.get(id(up), 0) + s * w
                nodes[id(up)] = up
    best = None
    for k, n in nodes.items():
        v = score[k] * (1 - _link_density(n)) * (1.25 if n.tag in ("article", "main") else 1)
        if best is None or v > best[0]:
            best = (v, n)
    found = best[1] if best else None
    worth = lambda n: len(re.sub(r"\s+", "", n.text())) * (1 - _link_density(n))      # noqa: E731
    marked = [n for n in root.walk() if n.tag in ("article", "main") or n.attrs.get("itemprop") in ("articleBody", "text")
              or re.search(r"\b(markdown-body|article-content|post-content|entry-content|rich_media_content)\b", n.attrs.get("class", ""))]
    for n in sorted(marked, key=worth, reverse=True)[:1]:     # what the page itself marks as the article, when it holds as much
        if found is None or worth(n) >= .6 * worth(found):
            return n
    return found or next((n for n in root.walk() if n.tag == "body"), root)


def _serialize(n: Node, base: str, out: list, pre: bool = False) -> None:
    for k in n.kids:
        if isinstance(k, str):
            out.append(escape(k if pre else re.sub(r"\s+", " ", k)))
            continue
        tag = k.tag
        if tag not in KEEP:
            _serialize(k, base, out, pre)
            continue
        attrs = ""
        if tag == "a":
            href = k.attrs.get("href") or ""
            href = urljoin(base, href) if href and not href.startswith(("javascript:", "data:", "#")) else ""
            attrs = f' href="{escape(href)}"' if href.startswith(("http://", "https://")) else ""
        elif tag == "img":
            src = k.attrs.get("data-src") or k.attrs.get("data-original") or k.attrs.get("src") or ""
            if not src or src.startswith("data:"):
                continue
            out.append(f'<img src="{escape(urljoin(base, src))}" alt="{escape(k.attrs.get("alt") or "")}" loading="lazy">')
            continue
        elif tag in ("td", "th"):
            attrs = "".join(f' {a}="{escape(k.attrs[a])}"' for a in ("colspan", "rowspan") if (k.attrs.get(a) or "").isdigit())
        if tag in VOID:
            out.append(f"<{tag}>")
            continue
        out.append(f"<{tag}{attrs}>")
        _serialize(k, base, out, pre or tag == "pre")
        out.append(f"</{tag}>")


def _meta(root: Node) -> dict:
    m = {}
    for n in root.walk():
        if n.tag == "meta":
            key = (n.attrs.get("property") or n.attrs.get("name") or "").lower()
            if key and n.attrs.get("content"):
                m.setdefault(key, n.attrs["content"].strip())
        elif n.tag == "title" and "title" not in m:
            m["title"] = re.sub(r"\s+", " ", n.text()).strip()
        elif n.tag == "link" and "icon" in (n.attrs.get("rel") or "").lower() and n.attrs.get("href"):
            m.setdefault("icon", n.attrs["href"])
        elif n.tag == "html" and n.attrs.get("lang"):
            m.setdefault("lang", n.attrs["lang"])
    return m


def _decode(body: bytes, headers: dict) -> str:
    cs = re.search(r"charset=([\w-]+)", headers.get("content-type", ""), re.I) or re.search(rb'<meta[^>]+charset=["\']?([\w-]+)', body[:4096], re.I)
    enc = cs.group(1) if cs else "utf-8"
    enc = enc.decode() if isinstance(enc, bytes) else enc
    try:
        return body.decode(enc, "replace")
    except LookupError:
        return body.decode("utf-8", "replace")


def article(html_text: str, base: str) -> dict:
    root = parse(html_text)
    meta = _meta(root)
    _prune(root)
    main = main_node(root)
    out: list[str] = []
    _serialize(main, base, out)
    body = re.sub(r"(<(p|li|h\d|blockquote|figure)>\s*</\2>)+", "", "".join(out)).strip()
    text = re.sub(r"\s+", " ", main.text()).strip()
    words = len(re.findall(r"[一-鿿]", text)) + len(re.findall(r"[A-Za-z0-9]+", text))
    host = urlsplit(base).hostname or ""
    return {"title": meta.get("og:title") or meta.get("twitter:title") or meta.get("title") or host,
            "site": meta.get("og:site_name") or host, "description": meta.get("og:description") or meta.get("description") or "",
            "image": urljoin(base, meta["og:image"]) if meta.get("og:image") else "",
            "icon": urljoin(base, meta.get("icon") or "/favicon.ico"), "byline": meta.get("author") or meta.get("article:author") or "",
            "published": meta.get("article:published_time") or "", "html": body[:600_000], "chars": len(text),
            "minutes": max(1, round(words / 400)), "thin": len(text) < 200}


def read(url: str) -> dict:
    """What the reader shows for a link: an article, a PDF or a picture (as preview URLs), or plain text."""
    from pga.filepreview import grant
    final, headers, body = fetch(url)
    ctype = headers.get("content-type", "").split(";")[0].strip().lower()
    out = {"url": url, "final": final, "frameable": frameable(headers), "host": urlsplit(final).hostname or ""}
    if ctype == "application/pdf" or body[:5] == b"%PDF-" or ctype.startswith("image/"):
        ext = ".pdf" if ctype == "application/pdf" or body[:5] == b"%PDF-" else "." + (ctype.split("/")[1].split("+")[0] or "png")
        docview.CACHE.mkdir(parents=True, exist_ok=True)
        f = docview.CACHE / ("web-" + hashlib.sha1(final.encode()).hexdigest()[:20] + ext)
        f.write_bytes(body)
        name = urlsplit(final).path.rsplit("/", 1)[-1] or out["host"]
        return {**out, "kind": "document" if ext == ".pdf" else "image", "url_view": grant(f), "title": name}
    if ctype in ("text/plain", "text/markdown", "application/json"):
        return {**out, "kind": "text", "title": urlsplit(final).path.rsplit("/", 1)[-1] or out["host"],
                "text": _decode(body, headers)[:400_000], "markdown": ctype == "text/markdown" or final.endswith(".md")}
    if "html" not in ctype and ctype:
        raise ReadError(f"这个链接是 {ctype} 文件，内置阅读器不支持；可以在浏览器里打开")
    return {**out, "kind": "web", **article(_decode(body, headers), final)}
