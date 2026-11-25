"""Direct, explicitly selected translation services for the document reader."""
from __future__ import annotations

import hashlib
import html
import time
import uuid
from collections.abc import Callable, Iterator
from contextlib import contextmanager

import httpx

from pga.config import get_settings


class ReaderTranslationError(RuntimeError):
    """A service-wide failure safe to display, without source text or credentials."""


def _cloud_client() -> httpx.Client:
    return httpx.Client(timeout=httpx.Timeout(20, connect=5), follow_redirects=False)


def _response(response: httpx.Response, service: str):
    if response.status_code in (401, 403):
        raise ReaderTranslationError(f"{service} 拒绝了请求，请检查翻译密钥、服务权限和额度。")
    if response.status_code == 429:
        raise ReaderTranslationError(f"{service} 超出额度或请求过于频繁，请稍后重试。")
    if not response.is_success:
        raise ReaderTranslationError(f"{service} 翻译请求失败（HTTP {response.status_code}）。")
    try:
        return response.json()
    except ValueError:
        raise ValueError(f"{service} 未返回有效译文。") from None


def _secret(value, name: str) -> str:
    if not value or not value.get_secret_value().strip():
        raise ReaderTranslationError(f"请在 PGA 后端配置 {name}，或选择本地离线翻译。")
    return value.get_secret_value().strip()


@contextmanager
def cloud_translator(service: str, target: str) -> Iterator[Callable[[str], str]]:
    settings = get_settings()
    with _cloud_client() as client:
        if service == "Bing":
            headers = {"Ocp-Apim-Subscription-Key": _secret(settings.azure_translator_key, "PGA_AZURE_TRANSLATOR_KEY")}
            if settings.azure_translator_region:
                headers["Ocp-Apim-Subscription-Region"] = settings.azure_translator_region
            def send(source):
                response = client.post("https://api.cognitive.microsofttranslator.com/translate",
                                       params={"api-version": "3.0", "to": "zh-Hans" if target == "zh-CN" else "en"},
                                       headers=headers, json=[{"Text": source}])
                return _response(response, "微软 Azure")[0]["translations"][0]["text"]
        elif service == "Google":
            headers = {"X-Goog-Api-Key": _secret(settings.google_translation_key, "PGA_GOOGLE_TRANSLATION_KEY")}
            def send(source):
                response = client.post("https://translation.googleapis.com/language/translate/v2",
                                       headers=headers, json={"q": source, "target": target, "format": "text"})
                value = _response(response, "Google Cloud")["data"]["translations"][0]["translatedText"]
                return html.unescape(value) if isinstance(value, str) else value
        elif service == "Youdao":
            app_id = settings.youdao_app_id
            if not app_id:
                raise ReaderTranslationError("请在 PGA 后端配置 PGA_YOUDAO_APP_ID 和 PGA_YOUDAO_APP_SECRET，或选择本地离线翻译。")
            key = _secret(settings.youdao_app_secret, "PGA_YOUDAO_APP_SECRET")
            def send(source):
                salt, now = uuid.uuid4().hex, str(int(time.time()))
                query = source if len(source) <= 20 else source[:10] + str(len(source)) + source[-10:]
                signature = hashlib.sha256((app_id + query + salt + now + key).encode()).hexdigest()
                response = client.post("https://openapi.youdao.com/api", data={
                    "q": source, "from": "auto", "to": "zh-CHS" if target == "zh-CN" else "en",
                    "appKey": app_id, "salt": salt, "curtime": now, "signType": "v3", "sign": signature,
                })
                data = _response(response, "有道智云")
                code = str(data["errorCode"])
                if code != "0":
                    label = code if code.isascii() and code.isdigit() and len(code) <= 6 else "未知"
                    raise ReaderTranslationError(f"有道智云请求失败（{label}），请检查应用凭证、额度或稍后重试。")
                return "\n".join(data["translation"]) if isinstance(data["translation"], list) else None
        else:
            raise ReaderTranslationError("未知的阅读翻译服务。")

        def translate(source: str) -> str:
            try:
                value = send(source)
            except httpx.RequestError:
                raise ReaderTranslationError(f"{service} 连接中断或超时，请重试或切换翻译服务。") from None
            except (KeyError, IndexError, TypeError):
                raise ValueError(f"{service} 返回的译文格式异常。") from None
            if not isinstance(value, str) or not value.strip() or len(value) > 16000:
                raise ValueError(f"{service} 未能返回完整译文。")
            return value.strip()

        yield translate
