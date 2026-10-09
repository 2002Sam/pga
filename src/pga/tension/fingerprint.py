"""Near-duplicate detection for event clustering (Tier 0, deterministic).

MinHash over word shingles of the canonical English text, plus exact matches
on canonical URL / content hash / upstream event key. Semantic (embedding)
clustering can replace `similarity` later without touching the tension math.
"""

from __future__ import annotations

import hashlib
import random
import re
import unicodedata
from urllib.parse import parse_qsl, urlencode, urlsplit, urlunsplit

_MERSENNE = (1 << 61) - 1
_WORD = re.compile(r"[^\W_]+", re.UNICODE)
_CJK = re.compile(r"[㐀-鿿぀-ヿ가-힯]")
_TRACKING = re.compile(r"^(utm_|fbclid$|gclid$|mc_|ref$|ref_src$|spm$|from$|share)", re.I)


def normalize(text: str) -> str:
    return unicodedata.normalize("NFKC", text).lower()


def content_hash(text: str) -> str:
    return hashlib.sha256(" ".join(_WORD.findall(normalize(text))).encode()).hexdigest()


def canonical_uri(uri: str | None) -> str | None:
    if not uri:
        return None
    try:
        parts = urlsplit(uri.strip())
    except ValueError:
        return uri.strip()
    if not parts.scheme:
        return uri.strip()
    query = urlencode(sorted((k, v) for k, v in parse_qsl(parts.query, keep_blank_values=True)
                             if not _TRACKING.match(k)))
    host = parts.netloc.lower().removeprefix("www.").removeprefix("m.")
    path = parts.path.rstrip("/") or "/"
    return urlunsplit(("https" if parts.scheme in {"http", "https"} else parts.scheme, host, path, query, ""))


def shingles(text: str, words: int = 3, chars: int = 3) -> set[str]:
    t = normalize(text)
    if len(_CJK.findall(t)) > len(t) * 0.3:
        compact = re.sub(r"\s+", "", t)
        return {compact[i:i + chars] for i in range(max(1, len(compact) - chars + 1))}
    toks = _WORD.findall(t)
    if len(toks) < words:
        return set(toks) or {t}
    return {" ".join(toks[i:i + words]) for i in range(len(toks) - words + 1)}


class MinHasher:
    def __init__(self, num_perm: int = 64, seed: int = 1729):
        rng = random.Random(seed)
        self.params = [(rng.randrange(1, _MERSENNE), rng.randrange(0, _MERSENNE)) for _ in range(num_perm)]

    def signature(self, items: set[str]) -> list[int]:
        hashes = [int.from_bytes(hashlib.blake2b(s.encode(), digest_size=8).digest(), "big") for s in items]
        if not hashes:
            return [_MERSENNE] * len(self.params)
        return [min((a * h + b) % _MERSENNE for h in hashes) for a, b in self.params]


def similarity(sig_a: list[int], sig_b: list[int]) -> float:
    """Estimated Jaccard similarity of the underlying shingle sets."""
    if not sig_a or len(sig_a) != len(sig_b):
        return 0.0
    return sum(1 for x, y in zip(sig_a, sig_b, strict=False) if x == y) / len(sig_a)
