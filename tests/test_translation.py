"""Spec §26 — Translation acceptance tests (plus span edge cases)."""

from __future__ import annotations

import re
import uuid

import pytest

from pga.chat import chat_turn
from pga.db.types import TranslationStatus
from pga.translation import (
    DictionaryBackend, SpanIntegrityError, detect_language, find_spans, mark_up, requested_output_language,
    restore, translate_text,
)

from .conftest import has_cjk

MIXED = """我想看看 https://arxiv.org/abs/2401.01234v2，文件在 src/pga/config.py 和 /var/lib/pga/data.npz。
运行：
```bash
pip install -e ".[dev]"
echo "你好，世界"
```
然后调用 `get_policy()` 和 torch.nn.Module，公式 $E=mc^2$ 和 \\[ \\int_0^1 x\\,dx \\]。
ID 0b5e4a2c-1f3d-4e5a-9b8c-7d6e5f4a3b2c，见 [1] 与 (Smith et al., 2023)，配置 {"window": "5h", "ratio": 0.7}。"""

PROTECTED = [
    "https://arxiv.org/abs/2401.01234v2",
    "src/pga/config.py",
    "/var/lib/pga/data.npz",
    '```bash\npip install -e ".[dev]"\necho "你好，世界"\n```',
    "`get_policy()`",
    "torch.nn.Module",
    "$E=mc^2$",
    "\\[ \\int_0^1 x\\,dx \\]",
    "0b5e4a2c-1f3d-4e5a-9b8c-7d6e5f4a3b2c",
    "[1]",
    "(Smith et al., 2023)",
    '{"window": "5h", "ratio": 0.7}',
]


def scramble(text: str) -> str:
    """A hostile 'translator': rewrites every character it is allowed to touch."""
    return re.sub(r"[^\s]", lambda m: "x" if has_cjk(m.group()) else m.group().swapcase(), text)


# ---------------------------------------------------------------- §26: Chinese prose → English canonical


def test_chinese_prose_becomes_english_canonical(rt, user):
    msg = rt.gateway.inbound(user, uuid.uuid4(), "请帮我跟踪世界模型的最新研究")
    assert msg.raw_language == "zh"
    assert msg.raw_text == "请帮我跟踪世界模型的最新研究"
    assert msg.canonical_en == "Please help me track the latest research on world models"
    assert msg.display_text == msg.raw_text
    assert msg.translation_status == TranslationStatus.TRANSLATED


# ---------------------------------------------------------------- §26: protected spans byte-identical


def test_protected_spans_are_byte_identical_inbound():
    backend = DictionaryBackend(mangle=scramble)
    out = translate_text(backend, MIXED, "zh", "en", glossary=[], do_not_translate=[])
    assert out.ok, out.problems
    for span in PROTECTED:
        assert span in out.text, f"protected span changed: {span!r}"
    assert not has_cjk(out.text.replace('echo "你好，世界"', ""))  # everything else was 'translated'


def test_protected_spans_are_byte_identical_outbound(rt, user):
    text = ("Run `pytest -q` then open https://example.com/a_(b)?q=1. The formula $a^2+b^2=c^2$ is important. "
            "See ./scripts/eval_contact.py and call ResourceAllocator.allocate() with why_now set.")
    msg = rt.gateway.outbound(user, uuid.uuid4(), text)
    assert msg.translation_status == TranslationStatus.TRANSLATED
    for span in ["`pytest -q`", "https://example.com/a_(b)?q=1", "$a^2+b^2=c^2$", "./scripts/eval_contact.py",
                 "ResourceAllocator.allocate()", "why_now"]:
        assert span in msg.display_text, span
    assert msg.canonical_en == text  # canonical is never touched


def test_spans_survive_even_if_translator_edits_keep_content():
    def corrupt(s: str) -> str:  # a translator that "helpfully" edits verbatim content
        return s.replace("torch.nn.Module", "torch.nn.module").replace("get_policy()", "getPolicy()")
    out = translate_text(DictionaryBackend(mangle=scramble, corrupt=corrupt), MIXED, "zh", "en",
                         glossary=[], do_not_translate=[])
    assert out.ok
    assert "torch.nn.Module" in out.text and "`get_policy()`" in out.text


# ---------------------------------------------------------------- §26: English agent prose → Chinese display


def test_english_prose_rendered_in_chinese(rt, user):
    msg = rt.gateway.outbound(user, uuid.uuid4(), "I found three new papers. Here is the summary.")
    assert msg.display_language == "zh-CN"
    assert msg.display_text == "我找到了三篇新论文。 以下是摘要。"
    assert msg.canonical_en == "I found three new papers. Here is the summary."
    assert msg.raw_language == "en"


# ---------------------------------------------------------------- §26: explicit English request bypasses Chinese


def test_explicit_english_request_bypasses_chinese_rendering(rt, user, backend):
    conv = uuid.uuid4()
    incoming = rt.gateway.inbound(user, conv, "请用英文回答：这个怎么样？")
    assert incoming.requested_output_language == "en"
    calls_before = len(backend.calls)
    reply = rt.gateway.outbound(user, conv, "I found three new papers.", reply_to=incoming)
    assert len(backend.calls) == calls_before  # no outbound translation at all
    assert reply.display_text == "I found three new papers."
    assert reply.display_language == "en"
    assert reply.translation_status == TranslationStatus.BYPASSED


def test_english_preference_and_mirror_mode(rt, user):
    conv = uuid.uuid4()
    user.preferences = {"output_language": "mirror_input"}
    incoming = rt.gateway.inbound(user, conv, "What do you think of this?")
    reply = rt.gateway.outbound(user, conv, "I found three new papers.", reply_to=incoming)
    assert reply.display_language == "en" and reply.display_text == "I found three new papers."


@pytest.mark.parametrize("text,expected", [
    ("请用英文回答这个问题", "en"),
    ("英文回复就好", "en"),
    ("Please answer in English.", "en"),
    ("用英文怎么说苹果？", None),          # asks for a word, not an English reply
    ("帮我写一篇英文论文的摘要", None),     # an English paper, not an English reply
    ("Reply in Chinese please", "zh-CN"),
    ("这个怎么样", None),
])
def test_requested_output_language(text, expected):
    assert requested_output_language(text) == expected


# ---------------------------------------------------------------- §26: no translation loop across turns


def test_no_translation_loop_across_repeated_turns(rt, user, backend, provider):
    conv = uuid.uuid4()
    for text in ["你好", "这个怎么样", "谢谢"]:
        chat_turn(rt, user, text, conv)
    # exactly one inbound and one outbound translation per turn
    assert len(backend.calls) == 6
    directions = [(src, tgt) for _, src, tgt in backend.calls]
    assert directions == [("zh", "en"), ("en", "zh-CN")] * 3
    # the model only ever saw English: system prompt and the whole history
    for call in provider.calls:
        assert not has_cjk(call.system)
        for m in call.messages:
            assert not has_cjk(m["content"]), m
    # assistant text sent to the model is the original canonical English, never a re-translation
    last = provider.calls[-1].messages
    assert [m["role"] for m in last] == ["user", "assistant", "user", "assistant", "user"]
    assert last[1]["content"].startswith("[claude-opus-5-5 offline] Hello")
    # nothing translated from Chinese back into English except user input
    zh_sources = [marked for marked, src, _ in backend.calls if src == "zh"]
    assert all("offline" not in s for s in zh_sources)


# ---------------------------------------------------------------- failure handling


def test_lost_placeholder_retries_then_fails_safe(rt, user):
    drop_all = DictionaryBackend(corrupt=lambda s: re.sub(r'<keep id="0">.*?</keep>', "", s))
    out = translate_text(drop_all, "运行 `make test` 然后看看结果", "zh", "en", glossary=[], do_not_translate=[],
                         max_retries=1)
    assert not out.ok and out.attempts == 2 and "missing span ids [0]" in out.problems[0]
    assert out.text == "运行 `make test` 然后看看结果"  # never a half-translation


def test_lost_placeholder_recovers_on_retry():
    state = {"n": 0}

    def flaky(s: str) -> str:
        state["n"] += 1
        return s.replace('<keep id="0">', "").replace("</keep>", "") if state["n"] == 1 else s
    out = translate_text(DictionaryBackend({"运行": "Run", "然后看看": "then take a look"}, corrupt=flaky),
                         "运行 `make test` 然后看看", "zh", "en", glossary=[], do_not_translate=[])
    assert out.ok and out.attempts == 2 and "`make test`" in out.text


def test_outbound_failure_shows_english_not_garbage(rt, user, backend):
    backend.corrupt = lambda s: s.replace("<ph", "<p")
    msg = rt.gateway.outbound(user, uuid.uuid4(), "Here is the summary.\n```python\nprint('x')\n```")
    assert msg.translation_status == TranslationStatus.FAILED
    assert msg.display_text == msg.canonical_en and msg.display_language == "en"


def test_untranslated_output_is_rejected():
    out = translate_text(DictionaryBackend(), "请帮我总结一下这篇论文的主要贡献", "zh", "en", glossary=[], do_not_translate=[])
    assert not out.ok and "untranslated" in out.problems[-1]


def test_code_only_message_is_not_sent_to_translator(rt, user, backend):
    msg = rt.gateway.outbound(user, uuid.uuid4(), "```bash\nls -la\n```")
    assert backend.calls == [] and msg.display_text == "```bash\nls -la\n```"


# ---------------------------------------------------------------- glossary & cache


def test_translation_cache_avoids_repeat_calls(rt, user, backend):
    rt.gateway.outbound(user, uuid.uuid4(), "Here is the summary.")
    rt.gateway.outbound(user, uuid.uuid4(), "Here is the summary.")
    assert len(backend.calls) == 1


def test_user_correction_updates_glossary_and_busts_cache(rt, user, backend):
    text = "Responsibility Tension rose after new evidence."
    rt.gateway.outbound(user, uuid.uuid4(), text)
    first = backend.calls[-1]
    rt.gateway.glossary.correct(user.id, "en", "zh", "Responsibility Tension", "责任张力")
    msg = rt.gateway.outbound(user, uuid.uuid4(), text)
    assert len(backend.calls) == 2 and backend.calls[-1] == first  # re-translated (cache key changed)
    assert "责任张力" in msg.display_text
    global_targets = [t.target for t in rt.gateway.glossary.terms_for(None, "en", "zh", text)]
    assert "责任紧张度" in global_targets and "责任张力" not in global_targets  # correction stays user-scoped


def test_do_not_translate_terms_are_protected(rt, user):
    spans = find_spans("用 Temporal 和 Claude 做 workflow", do_not_translate=["Temporal", "Claude"], source_is_cjk=True)
    assert [(s.kind, s.text) for s in spans] == [("name", "Temporal"), ("name", "Claude")]


# ---------------------------------------------------------------- detection & span edge cases


@pytest.mark.parametrize("text,lang", [
    ("请帮我看看这个", "zh"),
    ("用 PostgreSQL 做 source of truth 可以吗", "zh"),
    ("Let us discuss 张三's paper today", "en"),
    ("これは日本語です", "ja"),
    ("```python\nprint(1)\n```", "und"),
    ("Le chat est sur la table et le chien est dans la maison", "fr"),
])
def test_detect_language(text, lang):
    assert detect_language(text) == lang


@pytest.mark.parametrize("text,unprotected", [
    ("It costs $5 and $10.", "$5"),
    ("Use and/or here.", "and/or"),
    ("Fruits, e.g. apples.", "e.g."),
    ("Ratio 1/2 is fine.", "1/2"),
    ("Summary: the model improved\nRisk: high", "Summary"),
])
def test_ordinary_prose_is_not_protected(text, unprotected):
    assert all(unprotected not in s.text for s in find_spans(text))


def test_url_trailing_punctuation_and_chinese_boundary():
    spans = find_spans("看看https://example.com/x?y=1。然后（见https://a.b/c）")
    assert [s.text for s in spans if s.kind == "url"] == ["https://example.com/x?y=1", "https://a.b/c"]


def test_literal_markup_in_user_text_is_preserved():
    text = 'The tag <keep id="0">x</keep> and <ph id="9"/> are literal here.'
    spans = find_spans(text)
    marked = mark_up(text, spans)
    assert restore(marked, spans) == text


def test_restore_rejects_duplicates_and_strays():
    spans = find_spans("call `f()` now")
    marked = mark_up("call `f()` now", spans)
    with pytest.raises(SpanIntegrityError):
        restore(marked + marked, spans)
    with pytest.raises(SpanIntegrityError):
        restore(marked + " <keep id=", spans)
