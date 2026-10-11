"""Research tools: fetch pages, read feeds, search arXiv (spec §1.6, §24.9).

Everything fetched here is EXTERNAL data. It can become evidence and raise
tension; it can never change goals, permissions or policy (invariant 11).
The fetcher refuses non-HTTP schemes and private/loopback addresses so a
link inside fetched content cannot make the agent probe the user's network.
"""

from __future__ import annotations

import ipaddress
import logging
import re
import socket
import urllib.parse
import xml.etree.ElementTree as ET
from dataclasses import dataclass, field
from datetime import datetime, timezone
from email.utils import parsedate_to_datetime
from html.parser import HTMLParser
from typing import Protocol

log = logging.getLogger("pga.research")

USER_AGENT = "PGA/0.2 (+personal research agent)"
MAX_BYTES = 2_000_000


class FetchError(RuntimeError):
    pass


@dataclass
class FetchResult:
    url: str
    status: int
    text: str
    headers: dict[str, str] = field(default_factory=dict)

    @property
    def not_modified(self) -> bool:
        return self.status == 304


class Fetcher(Protocol):
    def get(self, url: str, headers: dict[str, str] | None = None) -> FetchResult: ...


def check_public_url(url: str) -> None:
    parts = urllib.parse.urlsplit(url)
    if parts.scheme not in {"http", "https"}:
        raise FetchError(f"refusing non-HTTP URL scheme {parts.scheme!r}")
    host = parts.hostname or ""
    if not host or host == "localhost" or host.endswith(".local") or host.endswith(".localhost"):
        raise FetchError(f"refusing local host {host!r}")
    try:
        infos = socket.getaddrinfo(host, parts.port or (443 if parts.scheme == "https" else 80))
    except socket.gaierror as exc:
        raise FetchError(f"cannot resolve {host}: {exc}") from exc
    for info in infos:
        ip = ipaddress.ip_address(info[4][0])
        if ip.is_private or ip.is_loopback or ip.is_link_local or ip.is_reserved or ip.is_multicast:
            raise FetchError(f"refusing private address {ip} for {host}")


class HttpFetcher:
    def __init__(self, timeout_s: float = 20.0, allow_private: bool = False):
        import httpx

        self._client = httpx.Client(timeout=timeout_s, follow_redirects=True, headers={"User-Agent": USER_AGENT})
        self.allow_private = allow_private

    def get(self, url: str, headers: dict[str, str] | None = None) -> FetchResult:
        if not self.allow_private:
            check_public_url(url)
        try:
            with self._client.stream("GET", url, headers=headers or {}) as resp:
                if not self.allow_private:
                    check_public_url(str(resp.url))  # redirects must stay public too
                chunks, size = [], 0
                for chunk in resp.iter_bytes():
                    size += len(chunk)
                    if size > MAX_BYTES:
                        break
                    chunks.append(chunk)
                body = b"".join(chunks)
                text = body.decode(resp.encoding or "utf-8", errors="replace")
                return FetchResult(str(resp.url), resp.status_code, text, dict(resp.headers))
        except FetchError:
            raise
        except Exception as exc:  # network errors become FetchError for the caller's retry logic
            raise FetchError(f"{type(exc).__name__}: {exc}") from exc


# ---------------------------------------------------------------- HTML → text


class _TextExtractor(HTMLParser):
    SKIP = {"script", "style", "noscript", "svg", "nav", "footer", "header", "form"}
    BLOCK = {"p", "div", "br", "li", "h1", "h2", "h3", "h4", "h5", "h6", "tr", "section", "article", "pre"}

    def __init__(self) -> None:
        super().__init__(convert_charrefs=True)
        self.parts: list[str] = []
        self.title = ""
        self._skip = 0
        self._in_title = False

    def handle_starttag(self, tag, attrs):
        if tag in self.SKIP:
            self._skip += 1
        elif tag == "title":
            self._in_title = True
        elif tag in self.BLOCK:
            self.parts.append("\n")

    def handle_endtag(self, tag):
        if tag in self.SKIP and self._skip:
            self._skip -= 1
        elif tag == "title":
            self._in_title = False
        elif tag in self.BLOCK:
            self.parts.append("\n")

    def handle_data(self, data):
        if self._in_title:
            self.title += data
        elif not self._skip:
            self.parts.append(data)


def html_to_text(html: str, max_chars: int = 20_000) -> tuple[str, str]:
    """(title, readable text)."""
    p = _TextExtractor()
    try:
        p.feed(html)
    except Exception:  # malformed markup: keep what was parsed
        pass
    text = re.sub(r"[ \t\r\f\v]+", " ", "".join(p.parts))
    text = re.sub(r"\n\s*\n+", "\n\n", text).strip()
    return p.title.strip(), text[:max_chars]


# ---------------------------------------------------------------- feeds


@dataclass
class FeedItem:
    key: str                 # guid / id / link — the dedupe key
    title: str
    summary: str
    link: str | None
    published_at: datetime | None
    authors: list[str] = field(default_factory=list)


_ATOM = "{http://www.w3.org/2005/Atom}"


def _strip(tag: str) -> str:
    return tag.rsplit("}", 1)[-1]


def _date(s: str | None) -> datetime | None:
    if not s:
        return None
    s = s.strip()
    try:
        d = datetime.fromisoformat(s.replace("Z", "+00:00"))
    except ValueError:
        try:
            d = parsedate_to_datetime(s)
        except (TypeError, ValueError):
            return None
    return d if d.tzinfo else d.replace(tzinfo=timezone.utc)


def _clean(s: str | None) -> str:
    if not s:
        return ""
    if "<" in s:
        s = html_to_text(s)[1]
    return re.sub(r"\s+", " ", s).strip()


def parse_feed(xml: str) -> list[FeedItem]:
    """RSS 2.0, RSS 1.0/RDF and Atom (including arXiv's API responses)."""
    try:
        root = ET.fromstring(xml.encode("utf-8") if isinstance(xml, str) else xml)
    except ET.ParseError as exc:
        raise FetchError(f"not a feed: {exc}") from exc
    items: list[FeedItem] = []
    for el in root.iter():
        name = _strip(el.tag)
        if name == "entry":  # Atom
            get = lambda n: el.find(_ATOM + n)  # noqa: E731
            link = None
            for ln in el.findall(_ATOM + "link"):
                if ln.get("rel", "alternate") == "alternate":
                    link = ln.get("href")
                    break
            key = (get("id").text if get("id") is not None else None) or link
            title = _clean(get("title").text if get("title") is not None else "")
            summary = _clean((get("summary") if get("summary") is not None else get("content")).text
                             if (get("summary") is not None or get("content") is not None) else "")
            published = _date((get("published") if get("published") is not None else get("updated")).text
                              if (get("published") is not None or get("updated") is not None) else None)
            authors = [_clean(a.findtext(_ATOM + "name")) for a in el.findall(_ATOM + "author")]
            if key:
                items.append(FeedItem(key.strip(), title, summary, link, published, [a for a in authors if a]))
        elif name == "item":  # RSS
            fields = {_strip(c.tag): (c.text or "") for c in el}
            link = fields.get("link") or None
            key = fields.get("guid") or link or fields.get("title")
            if key:
                items.append(FeedItem(key.strip(), _clean(fields.get("title")),
                                      _clean(fields.get("description") or fields.get("encoded")), link,
                                      _date(fields.get("pubDate") or fields.get("date")),
                                      [a for a in [_clean(fields.get("creator") or fields.get("author"))] if a]))
    return items


# ---------------------------------------------------------------- search


ARXIV_API = "https://export.arxiv.org/api/query"


def arxiv_url(query: str, max_results: int = 10) -> str:
    q = urllib.parse.urlencode({"search_query": f"all:{query}" if ":" not in query else query, "start": 0,
                                "max_results": max_results, "sortBy": "submittedDate", "sortOrder": "descending"})
    return f"{ARXIV_API}?{q}"


@dataclass
class SearchHit:
    title: str
    snippet: str
    url: str | None
    key: str
    published_at: datetime | None = None
    source: str = "web"


class SearchProvider(Protocol):
    name: str

    def search(self, query: str, limit: int) -> list[SearchHit]: ...


class ArxivSearch:
    name = "arxiv"

    def __init__(self, fetcher: Fetcher):
        self.fetcher = fetcher

    def search(self, query: str, limit: int) -> list[SearchHit]:
        res = self.fetcher.get(arxiv_url(query, limit))
        if res.status >= 400:
            raise FetchError(f"arXiv returned HTTP {res.status}")
        return [SearchHit(i.title, i.summary[:1500], i.link or i.key, i.key, i.published_at, "arxiv")
                for i in parse_feed(res.text)[:limit]]


class BraveSearch:
    """Optional general web search (needs BRAVE_API_KEY)."""
    name = "brave"
    URL = "https://api.search.brave.com/res/v1/web/search"

    def __init__(self, api_key: str, client=None):
        import httpx

        self._client = client or httpx.Client(timeout=20, headers={"X-Subscription-Token": api_key,
                                                                   "Accept": "application/json"})

    def search(self, query: str, limit: int) -> list[SearchHit]:
        resp = self._client.get(self.URL, params={"q": query, "count": limit})
        if resp.status_code >= 400:
            raise FetchError(f"Brave search returned HTTP {resp.status_code}")
        out = []
        for r in (resp.json().get("web") or {}).get("results", [])[:limit]:
            out.append(SearchHit(_clean(r.get("title")), _clean(r.get("description")), r.get("url"),
                                 r.get("url") or r.get("title", ""), _date(r.get("page_age")), "brave"))
        return out


class MultiSearch:
    """Fan a query out to several providers; one failing provider doesn't sink the others."""
    name = "multi"

    def __init__(self, providers: list[SearchProvider]):
        self.providers = providers

    def search(self, query: str, limit: int) -> list[SearchHit]:
        hits: list[SearchHit] = []
        seen: set[str] = set()
        for p in self.providers:
            try:
                for h in p.search(query, limit):
                    if h.key not in seen:
                        seen.add(h.key)
                        hits.append(h)
            except FetchError as exc:
                log.warning("search provider %s failed: %s", p.name, exc)
        return hits[: limit * max(1, len(self.providers))]


def default_search(fetcher: Fetcher, brave_api_key: str | None = None) -> SearchProvider:
    providers: list[SearchProvider] = [ArxivSearch(fetcher)]
    if brave_api_key:
        providers.insert(0, BraveSearch(brave_api_key))
    return MultiSearch(providers)
