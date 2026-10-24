"""Secrets out of text before it leaves this machine: API keys, tokens, private keys, passwords and database URLs are
replaced by a marker. Used on imported conversations (pga.hub.connectors) and on every call PGA's own model work makes
(pga.llm.router.LLMRouter), so a key you once pasted into a chat never reaches a model in the background."""
from __future__ import annotations

import re

_SECRETS: list[tuple[re.Pattern[str], str]] = [
    (re.compile(r"-----BEGIN [A-Z ]*PRIVATE KEY-----[\s\S]*?-----END [A-Z ]*PRIVATE KEY-----"), "[REDACTED_PRIVATE_KEY]"),
    (re.compile(r"\bsk-(?:ant-|proj-)?[A-Za-z0-9_\-]{16,}"), "[REDACTED_KEY]"),
    (re.compile(r"\b(?:AKIA|ASIA)[0-9A-Z]{16}\b"), "[REDACTED_KEY]"),
    (re.compile(r"\bgh[pousr]_[A-Za-z0-9]{30,}\b"), "[REDACTED_TOKEN]"),
    (re.compile(r"\bgithub_pat_[A-Za-z0-9_]{40,}\b"), "[REDACTED_TOKEN]"),
    (re.compile(r"\bglpat-[A-Za-z0-9_\-]{20,}\b"), "[REDACTED_TOKEN]"),
    (re.compile(r"(?i)\b(bearer\s+)[A-Za-z0-9._\-]{20,}"), r"\1[REDACTED]"),
    (re.compile(r"\bxox[abprs]-[A-Za-z0-9-]{10,}\b"), "[REDACTED_TOKEN]"),
    (re.compile(r"\bAIza[0-9A-Za-z_\-]{30,}\b"), "[REDACTED_KEY]"),
    (re.compile(r"\beyJ[A-Za-z0-9_\-]{10,}\.[A-Za-z0-9_\-]{10,}\.[A-Za-z0-9_\-]{10,}"), "[REDACTED_JWT]"),
    (re.compile(r"(?i)\b(password|passwd|pwd|secret|token|api[_-]?key|access[_-]?key)(\s*[:=]\s*)\S+"), r"\1\2[REDACTED]"),
    (re.compile(r"(?i)(postgres(?:ql)?(?:\+\w+)?|mysql|mongodb(?:\+srv)?|redis)://[^\s:@/]+:[^\s@/]+@"), r"\1://[REDACTED]@"),
]


def redact(text: str) -> str:
    for pat, repl in _SECRETS:
        text = pat.sub(repl, text)
    return text


def redact_messages(messages: list[dict]) -> list[dict]:
    return [{**m, "content": redact(m["content"])} if isinstance(m.get("content"), str) else m for m in messages]
