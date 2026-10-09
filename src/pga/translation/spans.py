"""Protected spans (spec §10.3).

Code, URLs, paths, commands, JSON/YAML, math, IDs, citations, API names and
product names must come out of translation byte-identical. We find them,
hand the translator marked-up text, and afterwards restore every span from the
ORIGINAL bytes by id — so even a translator that "fixes" a span cannot change it.

Marked-up forms:
  short span → <keep id="3">torch.nn.Module</keep>   (visible, keeps sentence context)
  long span  → <ph id="4"/>                          (opaque, saves tokens)
"""

from __future__ import annotations

import json
import re
from collections.abc import Callable, Iterable
from dataclasses import asdict, dataclass

ASCII_W = r"A-Za-z0-9_"
CJK_RANGE = "\u3400-\u4dbf\u4e00-\u9fff\uf900-\ufaff\u3040-\u30ff\uac00-\ud7af"
CJK_PUNCT = "\u3000-\u303f\uff00-\uffef"


@dataclass(frozen=True)
class Span:
    id: int
    kind: str
    start: int
    end: int
    text: str

    def as_dict(self) -> dict:
        return asdict(self)


class SpanIntegrityError(ValueError):
    def __init__(self, problems: list[str]):
        super().__init__("; ".join(problems))
        self.problems = problems


# ------------------------------------------------------------------ detectors

Detector = Callable[[str], Iterable[tuple[int, int]]]


def _rx(pattern: str, flags: int = 0, group: int = 0, validate: Callable[[str], bool] | None = None,
        trim: Callable[[str], str] | None = None) -> Detector:
    compiled = re.compile(pattern, flags)

    def detect(text: str) -> Iterable[tuple[int, int]]:
        for m in compiled.finditer(text):
            start, end = m.span(group)
            s = text[start:end]
            if trim:
                t = trim(s)
                end = start + len(t)
                s = t
            if not s or (validate and not validate(s)):
                continue
            yield start, end

    return detect


def _trim_url(s: str) -> str:
    # Drop trailing sentence punctuation, but keep a ')' that closes a '(' inside the URL.
    while s and s[-1] in ".,;:!?'\"]}>":
        s = s[:-1]
    while s.endswith(")") and s.count(")") > s.count("("):
        s = s[:-1]
    return s


def _json_detector(text: str) -> Iterable[tuple[int, int]]:
    """Balanced-bracket scan for inline JSON objects/arrays; json.loads validates."""
    i, n = 0, len(text)
    while i < n:
        ch = text[i]
        if ch in "{[":
            j = i + 1
            while j < n and text[j] in " \t\r\n":
                j += 1
            looks_json = j < n and (text[j] == '"' or (ch == "[" and text[j] in "{[") or
                                    (ch == "{" and text[j] == "}"))
            if looks_json:
                end = _match_bracket(text, i)
                if end is not None:
                    try:
                        json.loads(text[i:end])
                    except ValueError:
                        pass
                    else:
                        yield i, end
                        i = end
                        continue
        i += 1


def _match_bracket(text: str, start: int) -> int | None:
    pairs = {"{": "}", "[": "]"}
    stack = [pairs[text[start]]]
    i, in_str, esc = start + 1, False, False
    while i < len(text):
        c = text[i]
        if in_str:
            if esc:
                esc = False
            elif c == "\\":
                esc = True
            elif c == '"':
                in_str = False
        elif c == '"':
            in_str = True
        elif c in pairs:
            stack.append(pairs[c])
        elif c in "}]":
            if not stack or c != stack.pop():
                return None
            if not stack:
                return i + 1
        i += 1
    return None


_YAML_LINE = re.compile(r"^[ \t]*(?:- )?([a-z_][a-z0-9_.\-]*):(?:[ \t]+(.*))?$")


def _yaml_detector(text: str) -> Iterable[tuple[int, int]]:
    """Two or more consecutive `snake_key: scalar` lines (config), not 'Summary: prose'."""
    lines = text.splitlines(keepends=True)
    pos, block_start, block_lines, scalars = 0, None, 0, 0
    starts = []
    for line in lines:
        starts.append(pos)
        pos += len(line)

    def flush(end_idx: int):
        nonlocal block_start, block_lines, scalars
        if block_start is not None and block_lines >= 2 and scalars * 2 >= block_lines:
            s = starts[block_start]
            e = starts[end_idx - 1] + len(lines[end_idx - 1].rstrip("\r\n"))
            found.append((s, e))
        block_start, block_lines, scalars = None, 0, 0

    found: list[tuple[int, int]] = []
    for idx, line in enumerate(lines):
        m = _YAML_LINE.match(line.rstrip("\r\n"))
        indented_child = block_start is not None and line[:1] in " \t" and line.strip()
        if m:
            if block_start is None:
                block_start = idx
            block_lines += 1
            value = (m.group(2) or "").strip()
            if not value or " " not in value or value[:1] in "\"'[{" or re.fullmatch(r"[\d.eE+\-]+", value):
                scalars += 1
        elif indented_child:
            block_lines += 1
            scalars += 1
        else:
            flush(idx)
    flush(len(lines))
    return found


def _api_dotted_ok(s: str) -> bool:
    core = s[:-2] if s.endswith("()") else s
    parts = core.split(".")
    return any(len(p) > 1 for p in parts) and not core.lower() in {"e.g", "i.e", "etc", "vs"}


def _has_upper_or_digit(s: str) -> bool:
    return any(c.isupper() or c.isdigit() for c in s)


# Ordered by priority: earlier detectors claim text first; later ones cannot overlap it.
BASE_DETECTORS: list[tuple[str, Detector]] = [
    # literal markup that would collide with our own placeholders
    ("markup", _rx(r"</?keep\b[^>]*>|<ph\b[^>]*/?>")),
    ("code_block", _rx(r"(?ms)^[ \t]*(`{3,}|~{3,})[^\n]*\n.*?^[ \t]*\1[ \t]*$")),
    ("code_block", _rx(r"(?ms)^[ \t]*(`{3,}|~{3,}).*\Z")),  # unterminated fence: protect to end
    ("math", _rx(r"(?s)\$\$.+?\$\$")),
    ("math", _rx(r"(?s)\\\[.+?\\\]")),
    ("math", _rx(r"(?s)\\begin\{([A-Za-z]+\*?)\}.*?\\end\{\1\}")),
    ("inline_code", _rx(r"``[^`\n]+``|`[^`\n]+`")),
    ("math", _rx(r"(?<![\\$A-Za-z0-9])\$(?![\s$])[^$\n]+?(?<![\s\\])\$(?![A-Za-z0-9$])")),
    ("math", _rx(r"\\\(.+?\\\)")),
    ("command", _rx(r"(?m)^[ \t]*\$ [^\n]+$")),
    ("command", _rx(
        r"(?m)^[ \t]*(?:sudo\s+)?(?:pip3?|python3?|npm|npx|pnpm|yarn|git|docker(?:-compose)?|kubectl|"
        r"curl|wget|cd|ls|cat|mkdir|rm|cp|mv|chmod|ssh|scp|brew|apt(?:-get)?|conda|uv|poetry|make|"
        r"cargo|go|node|bash|sh|export|alembic|uvicorn|pytest|psql|redis-cli|temporal|nvidia-smi|"
        r"torchrun|accelerate)\s+[^\n" + CJK_RANGE + r"]*$")),
    ("json", _json_detector),
    ("yaml", _yaml_detector),
    ("url", _rx(r"(?<![A-Za-z0-9])(?:https?|ftp)://[^\s<>\"'`" + CJK_RANGE + CJK_PUNCT + r"]+", trim=_trim_url)),
    ("url", _rx(r"(?<![A-Za-z0-9_./])www\.[^\s<>\"'`" + CJK_RANGE + CJK_PUNCT + r"]+", trim=_trim_url)),
    ("email", _rx(r"(?<![A-Za-z0-9_.+\-])[A-Za-z0-9_.+\-]+@[A-Za-z0-9\-]+(?:\.[A-Za-z0-9\-]+)+")),
    ("id", _rx(r"(?<![A-Za-z0-9.])10\.\d{4,9}/[^\s\"<>" + CJK_RANGE + CJK_PUNCT + r"]+", trim=_trim_url)),  # DOI
    ("id", _rx(r"(?<![A-Za-z0-9.])(?:arXiv:)?\d{4}\.\d{4,5}(?:v\d+)?(?![A-Za-z0-9])")),
    ("id", _rx(r"(?<![A-Za-z0-9\-])[0-9a-fA-F]{8}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{12}(?![A-Za-z0-9\-])")),
    ("id", _rx(r"(?<![A-Za-z0-9])(?=[0-9a-f]*\d)(?=[0-9a-f]*[a-f])[0-9a-f]{7,64}(?![A-Za-z0-9])")),
    ("path", _rx(r"(?<![A-Za-z0-9])[A-Za-z]:\\(?:[^\\\s]+\\)*[^\\\s" + CJK_PUNCT + r"]*")),
    ("path", _rx(r"(?<![A-Za-z0-9_/:.\-])(?:~|\.{1,2})?/(?:[A-Za-z0-9_.\-]+/)*[A-Za-z0-9_.\-]+/?",
                 validate=lambda s: s.strip("/~.") != "")),
    ("path", _rx(r"(?<![A-Za-z0-9_/.\-])(?:[A-Za-z0-9_.\-]+/)+[A-Za-z0-9_\-]+\.[A-Za-z0-9]{1,8}(?![A-Za-z0-9_])")),
    ("path", _rx(r"(?<![A-Za-z0-9_.\-])[A-Za-z0-9_\-]+\.(?:py|ts|tsx|js|jsx|mjs|json|ya?ml|toml|md|txt|csv|"
                 r"tsv|sql|sh|ipynb|pt|pth|ckpt|safetensors|onnx|cfg|ini|env|lock|html|css|go|rs|java|"
                 r"cpp|cc|h|hpp|c|pdf|pptx|docx|xlsx|mp4|png|jpg|npz|npy|obj|ply|pkl)(?![A-Za-z0-9_])")),
    ("citation", _rx(r"\[\d+(?:\s*[-–,]\s*\d+)*\]")),
    ("citation", _rx(r"\[@[\w:.\-]+(?:;\s*@[\w:.\-]+)*\]")),
    ("citation", _rx(r"\\cite[pt]?\{[^}]+\}")),
    ("citation", _rx(r"\([A-Z][A-Za-z\-]+(?: et al\.?| (?:and|&) [A-Z][A-Za-z\-]+)?,? \d{4}[a-z]?\)")),
    ("api", _rx(r"(?<![A-Za-z0-9_.])[A-Za-z_][A-Za-z0-9_]*(?:\.[A-Za-z_][A-Za-z0-9_]*)+(?:\(\))?(?![A-Za-z0-9_])",
                validate=_api_dotted_ok)),
    ("api", _rx(r"(?<![A-Za-z0-9_])[A-Za-z_][A-Za-z0-9_]*\([^()\n" + CJK_RANGE + r"]{0,60}\)")),
    ("api", _rx(r"(?<![A-Za-z0-9_])[A-Za-z][A-Za-z0-9]*(?:_[A-Za-z0-9]+)+(?![A-Za-z0-9_])")),
    ("api", _rx(r"(?<![A-Za-z0-9_])(?=[A-Za-z0-9]*[a-z])[A-Za-z][A-Za-z0-9]*[A-Z][A-Za-z0-9]*(?![A-Za-z0-9_])")),
]

# Only when the source text is CJK: embedded Latin names/terms ("用 Gemini Notebook 做…").
LATIN_TERM_IN_CJK: Detector = _rx(
    r"(?<![A-Za-z0-9_])[A-Za-z][A-Za-z0-9+#\-]*(?:[ .][A-Za-z0-9][A-Za-z0-9+#\-]*)*(?![A-Za-z0-9_])",
    validate=_has_upper_or_digit)


def _term_detector(terms: Iterable[str]) -> Detector | None:
    terms = sorted({t for t in terms if t}, key=len, reverse=True)
    if not terms:
        return None
    alts = "|".join(re.escape(t) for t in terms)
    return _rx(rf"(?<![A-Za-z0-9_])(?:{alts})(?![A-Za-z0-9_])")


def find_spans(text: str, *, do_not_translate: Iterable[str] = (), source_is_cjk: bool = False) -> list[Span]:
    detectors = list(BASE_DETECTORS)
    term_det = _term_detector(do_not_translate)
    if term_det:
        # product/proper names claim text before generic api-name heuristics
        idx = next(i for i, (k, _) in enumerate(detectors) if k == "citation")
        detectors.insert(idx, ("name", term_det))
    if source_is_cjk:
        detectors.append(("name", LATIN_TERM_IN_CJK))

    taken = bytearray(len(text))
    found: list[tuple[int, int, str]] = []
    masked = text
    for kind, detect in detectors:
        claimed = False
        for start, end in detect(masked):
            if start >= end or any(taken[start:end]):
                continue
            taken[start:end] = b"\x01" * (end - start)
            found.append((start, end, kind))
            claimed = True
        if claimed:
            # later detectors see claimed regions as NULs, so they can neither match inside
            # them nor anchor on them (e.g. a second, unterminated code fence)
            masked = "".join("\x00" if taken[i] else c for i, c in enumerate(text))
    found.sort()
    return [Span(i, kind, s, e, text[s:e]) for i, (s, e, kind) in enumerate(found)]


# ------------------------------------------------------------------ mark-up / restore

_COLLIDES = re.compile(r"</?keep\b|<ph\b")


def mark_up(text: str, spans: list[Span], visible_max_chars: int = 80) -> str:
    out, pos = [], 0
    for sp in spans:
        out.append(text[pos:sp.start])
        visible = (len(sp.text) <= visible_max_chars and "\n" not in sp.text
                   and not _COLLIDES.search(sp.text) and sp.kind not in {"code_block", "json", "yaml"})
        out.append(f'<keep id="{sp.id}">{sp.text}</keep>' if visible else f'<ph id="{sp.id}"/>')
        pos = sp.end
    out.append(text[pos:])
    return "".join(out)


_KEEP = re.compile(r'<keep\s+id\s*=\s*["\']?(\d+)["\']?\s*>(.*?)</keep\s*>', re.S)
_PH = re.compile(r'<ph\s+id\s*=\s*["\']?(\d+)["\']?\s*/?>')
_STRAY = re.compile(r"</?keep\b|<ph\b")


def restore(translated: str, spans: list[Span]) -> str:
    """Put original span bytes back. Raises SpanIntegrityError if markup was lost or duplicated."""
    by_id = {sp.id: sp for sp in spans}
    seen: dict[int, int] = {}
    problems: list[str] = []

    def sub(m: re.Match[str]) -> str:
        sid = int(m.group(1))
        seen[sid] = seen.get(sid, 0) + 1
        if sid not in by_id:
            problems.append(f"unknown span id {sid}")
            return ""
        return by_id[sid].text

    # Swap restored spans for sentinels first so span content that happens to look like
    # markup can't be re-parsed, then expand the sentinels.
    sentinel: dict[str, str] = {}

    def sub_sentinel(m: re.Match[str]) -> str:
        restored = sub(m)
        key = f"\x00{len(sentinel)}\x00"
        sentinel[key] = restored
        return key

    out = _KEEP.sub(sub_sentinel, translated)
    out = _PH.sub(sub_sentinel, out)
    if _STRAY.search(out):
        problems.append("stray or malformed markup left in output")
    missing = sorted(set(by_id) - set(seen))
    dupes = sorted(k for k, v in seen.items() if v > 1)
    if missing:
        problems.append(f"missing span ids {missing}")
    if dupes:
        problems.append(f"duplicated span ids {dupes}")
    if problems:
        raise SpanIntegrityError(problems)
    for key, val in sentinel.items():
        out = out.replace(key, val)
    return out


def translatable_residue(text: str, spans: list[Span]) -> str:
    """Text outside protected spans — if it has no letters, there is nothing to translate."""
    out, pos = [], 0
    for sp in spans:
        out.append(text[pos:sp.start])
        pos = sp.end
    out.append(text[pos:])
    return "".join(out)
