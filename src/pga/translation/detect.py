"""Cheap, deterministic language detection (Tier 0) and explicit output-language requests."""

from __future__ import annotations

import re

from .spans import find_spans, translatable_residue

_HAN = re.compile(r"[㐀-䶿一-鿿豈-﫿]")
_KANA = re.compile(r"[぀-ヿ]")
_HANGUL = re.compile(r"[가-힯ᄀ-ᇿ]")
_CYRILLIC_WORD = re.compile(r"[Ѐ-ӿ]+")
_ARABIC_WORD = re.compile(r"[؀-ۿ]+")
_LATIN_WORD = re.compile(r"[A-Za-zÀ-ɏ]+")

_STOPWORDS = {
    "en": {"the", "and", "is", "are", "of", "to", "in", "that", "it", "for", "you", "with", "this", "what", "how", "can", "i", "we", "be", "on"},
    "fr": {"le", "la", "les", "et", "est", "des", "une", "un", "du", "que", "pour", "dans", "pas", "vous", "je", "nous"},
    "de": {"der", "die", "das", "und", "ist", "nicht", "ein", "eine", "ich", "sie", "mit", "auf", "zu", "den", "wir"},
    "es": {"el", "la", "los", "las", "y", "es", "que", "de", "en", "un", "una", "por", "para", "con", "no", "yo"},
}

CJK_LANGS = {"zh", "ja", "ko"}


def is_english(lang: str | None) -> bool:
    return bool(lang) and lang.lower().split("-")[0] == "en"


def base_lang(lang: str | None) -> str:
    return (lang or "und").lower().split("-")[0]


def detect_language(text: str) -> str:
    """Return a BCP-47-ish base code: zh, ja, ko, ru, ar, en, fr, de, es, or 'und'.

    Protected spans (code, URLs, names) are ignored, so "用 PostgreSQL 做 source of truth"
    is Chinese and a message that is only a code block is 'und'.
    """
    residue = translatable_residue(text, find_spans(text))
    han = len(_HAN.findall(residue))
    kana = len(_KANA.findall(residue))
    hangul = len(_HANGUL.findall(residue))
    latin_words = [w.lower() for w in _LATIN_WORD.findall(residue)]
    cyr = len(_CYRILLIC_WORD.findall(residue))
    arab = len(_ARABIC_WORD.findall(residue))

    if kana and kana >= 0.1 * (kana + han):
        return "ja"
    if hangul and hangul >= 0.3 * (hangul + len(latin_words)):
        return "ko"
    # one Han character ~ one word; a few Chinese names in an English sentence stay English
    if han and han / (han + len(latin_words)) >= 0.4:
        return "zh"
    if cyr and cyr >= len(latin_words):
        return "ru"
    if arab and arab >= len(latin_words):
        return "ar"
    if latin_words:
        scores = {lang: sum(w in sw for w in latin_words) for lang, sw in _STOPWORDS.items()}
        best = max(scores, key=lambda k: scores[k])
        if scores[best] == 0 or scores["en"] >= scores[best]:
            return "en"
        return best
    if han:
        return "zh"
    return "und"


# "用英文怎么说 X" asks how to say X in English — the reply itself should stay Chinese.
_NOT_HOWTO = r"(?!\s*(怎么|如何|咋))"
_REPLY_VERB = r"\b(answer|reply|respond|write|output|explain|summari[sz]e|translate|draft|give|show)\b[^.?!\n]{0,40}"
_WANTS_EN = [
    re.compile(r"(用|以|使用|改用|换成|翻译成|译成)\s*英(文|语)" + _NOT_HOWTO),
    re.compile(r"英(文|语)\s*(回答|回复|作答|输出|生成|版|给我|说明|解释)"),
    re.compile(_REPLY_VERB + r"\b(in|into)\s+english\b", re.I),
    re.compile(r"^\s*in english\b", re.I),
    re.compile(r"\benglish\s+(version|please|only|output|reply|answer)\b", re.I),
]
_WANTS_ZH = [
    re.compile(r"(用|以|使用|改用|换成|翻译成|译成)\s*(中文|汉语|简体中文)" + _NOT_HOWTO),
    re.compile(r"(中文|汉语)\s*(回答|回复|作答|输出|生成|版|给我|说明|解释)"),
    re.compile(_REPLY_VERB + r"\b(in|into)\s+(chinese|mandarin)\b", re.I),
    re.compile(r"\bchinese\s+(version|please|only|output|reply|answer)\b", re.I),
]


def requested_output_language(text: str) -> str | None:
    """Explicit 'answer in English' style requests. Explicit language beats the UI default (§10.7)."""
    residue = translatable_residue(text, find_spans(text))
    if any(p.search(residue) for p in _WANTS_EN):
        return "en"
    if any(p.search(residue) for p in _WANTS_ZH):
        return "zh-CN"
    return None
