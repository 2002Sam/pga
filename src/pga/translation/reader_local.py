"""Run the Argos English/Chinese OPUS-MT packages inside the reader process."""
from __future__ import annotations

import fcntl
import hashlib
import re
import shutil
import threading
from functools import lru_cache
from pathlib import Path
from tempfile import TemporaryDirectory
from zipfile import BadZipFile, ZipFile

import httpx

from pga.config import get_settings
from .detect import base_lang, detect_language
from .reader_providers import ReaderTranslationError


# Argos package index, version 1.9. Verify the archive before publishing its inference files.
_PACKS = {
    "zh": ("translate-en_zh-1_9", "433e7c4f034d87fbe2353161e05f18646d7999452f801a4e1f0378522b9850ab"),
    "en": ("translate-zh_en-1_9", "62e7af5a3a48b530e47b7b3e5c78c2de79073ecd815750d2bf3ab35b4a67da2d"),
}
_FILES = ("README.md", "metadata.json", "sentencepiece.model", "model/model.bin",
          "model/config.json", "model/shared_vocabulary.json")
_READY = ".installed-sha256"
_LOAD_LOCK = threading.Lock()
_BOUNDARY = re.compile(r"(?<=[。！？!?])\s*|(?<=\.)\s+")
_MARKER = re.compile(r"\[901\d+\]")


def _install_model(root: Path, name: str, digest: str) -> Path:
    destination = root / name
    marker = destination / _READY
    if marker.is_file() and marker.read_text().strip() == digest:
        return destination
    root.mkdir(parents=True, exist_ok=True)
    # Multiple web workers / requests can encounter the same cold installation.
    with (root / (name + ".lock")).open("a") as lock:
        fcntl.flock(lock, fcntl.LOCK_EX)
        if marker.is_file() and marker.read_text().strip() == digest:
            return destination
        with TemporaryDirectory(dir=root, prefix="." + name + "-") as scratch:
            archive = Path(scratch) / "download"
            checksum = hashlib.sha256()
            with httpx.stream("GET", f"https://argos-net.com/v1/{name}.argosmodel",
                              follow_redirects=True, timeout=httpx.Timeout(60, connect=8)) as response:
                response.raise_for_status()
                with archive.open("wb") as out:
                    for chunk in response.iter_bytes(256 * 1024):
                        if out.tell() + len(chunk) > 85_000_000:
                            raise ReaderTranslationError("本地翻译模型下载大小异常，请重试。")
                        checksum.update(chunk)
                        out.write(chunk)
            if checksum.hexdigest() != digest:
                raise ReaderTranslationError("本地翻译模型下载校验失败，请重试。")
            staging = Path(scratch) / name
            with ZipFile(archive) as pack:
                for filename in _FILES:
                    path = staging / filename
                    path.parent.mkdir(parents=True, exist_ok=True)
                    with pack.open(f"{name}/{filename}") as src, path.open("wb") as out:
                        shutil.copyfileobj(src, out)
            (staging / _READY).write_text(digest)
            staging.rename(destination)
    return destination


@lru_cache(maxsize=2)
def _load_model(root: Path, target: str):
    name, digest = _PACKS[target]
    try:
        directory = _install_model(root, name, digest)
    except httpx.HTTPError:
        raise ReaderTranslationError("首次使用该方向需要联网下载本地翻译模型，请检查网络后重试。") from None
    except (OSError, BadZipFile, KeyError):
        raise ReaderTranslationError("本地翻译模型安装失败，请检查模型目录的空间和权限。") from None
    try:
        import ctranslate2
        import sentencepiece
        translator = ctranslate2.Translator(str(directory / "model"), device="cpu", compute_type="int8",
                                            inter_threads=1, intra_threads=2)
        tokenizer = sentencepiece.SentencePieceProcessor(model_file=str(directory / "sentencepiece.model"))
        return tokenizer, translator
    except (ImportError, OSError, RuntimeError, ValueError):
        raise ReaderTranslationError("无法加载本地翻译引擎或模型，请检查 PGA 的安装。") from None


def _units(sentence: str, tokenizer):
    """Split very long sentences at word boundaries without dropping tokens or splitting citations."""
    tokens = tokenizer.encode(sentence, out_type=str)
    if len(tokens) <= 180:
        yield sentence, tokens
        return
    middle = len(sentence) // 2
    boundaries = [m.end() for m in re.finditer(r"[\s,，、:：;；]", sentence)
                  if len(sentence) // 4 < m.end() < 3 * len(sentence) // 4]
    cut = min(boundaries, key=lambda n: abs(n - middle)) if boundaries else middle
    for marker in _MARKER.finditer(sentence):
        if marker.start() < cut < marker.end():
            cut = marker.end()
            break
    for part in (sentence[:cut].strip(), sentence[cut:].strip()):
        if part:
            yield from _units(part, tokenizer)


def translate_local(source: str, target: str) -> str:
    target = base_lang(target)
    language = detect_language(source)
    if language == target:
        return source
    if language not in ("en", "zh"):
        raise ValueError("本地翻译支持中文和英文。此段可选择已配置的云翻译服务。")
    root = get_settings().reader_models_dir.expanduser()
    with _LOAD_LOCK:
        tokenizer, engine = _load_model(root, target)
    lines = []
    for line in source.split("\n"):
        units = [unit for sentence in _BOUNDARY.split(line) if sentence.strip()
                 for unit in _units(sentence.strip(), tokenizer)]
        inputs = [tokens for text, tokens in units if any(c.isalpha() for c in text)]
        parts = []
        try:
            results = iter(engine.translate_batch(inputs, beam_size=4, max_input_length=0,
                                                   max_decoding_length=512, max_batch_size=8)) if inputs else iter(())
            for text, _ in units:
                if any(c.isalpha() for c in text):
                    hypothesis = next(results).hypotheses[0]
                    if not hypothesis or len(hypothesis) >= 512:
                        raise ValueError("本地模型未能译完整段文字，请重试或切换翻译服务。")
                    text = tokenizer.decode(hypothesis).replace("▁", " ").strip()
                    if not text:
                        raise ValueError("本地模型返回了空译文。")
                parts.append(text)
        except (RuntimeError, StopIteration, IndexError):
            raise ReaderTranslationError("本地翻译引擎未能完成本次翻译，请重试。") from None
        lines.append((" " if target == "en" else "").join(parts))
    return "\n".join(lines)
