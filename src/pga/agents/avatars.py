"""Agents' avatars: a picture you chose for an agent (state/agent-avatars/<name>.<ext>), or a character and a colour of your
own (avatar_text / avatar_color in agents.yaml). The page draws them wherever that agent answers."""
from __future__ import annotations

import base64
import os
import re
from pathlib import Path

ROOT = Path(os.environ.get("PGA_AVATARS_DIR") or Path(__file__).resolve().parents[3].parent / "state" / "agent-avatars")
MAX_BYTES = 400_000                        # the page sends a 256 px square; this leaves room for a GIF
KINDS = {"png": b"\x89PNG", "jpeg": b"\xff\xd8\xff", "gif": b"GIF8", "webp": b"RIFF"}
COLOR = re.compile(r"^#[0-9a-fA-F]{6}$")


class AvatarError(ValueError):
    pass


def path(name: str) -> Path | None:
    for ext in KINDS:
        p = ROOT / f"{name}.{ext}"
        if p.is_file():
            return p
    return None


def version(name: str) -> int | None:
    p = path(name)
    return int(p.stat().st_mtime) if p else None


def save(name: str, data_url: str) -> int:
    """A picture as a data URL (data:image/png;base64,…): checked to really be that kind of image, then kept."""
    m = re.match(r"^data:image/(png|jpeg|gif|webp);base64,(.+)$", data_url or "", re.S)
    if not m:
        raise AvatarError("头像要是 PNG、JPEG、GIF 或 WebP 图片")
    try:
        raw = base64.b64decode(m.group(2), validate=True)
    except ValueError as exc:
        raise AvatarError("图片数据不完整") from exc
    kind = m.group(1)
    if len(raw) > MAX_BYTES:
        raise AvatarError("图片太大了（最多 400 KB）")
    if not raw.startswith(KINDS[kind]) or (kind == "webp" and raw[8:12] != b"WEBP"):
        raise AvatarError("文件内容不是它声称的图片格式")
    remove(name)
    ROOT.mkdir(parents=True, exist_ok=True)
    out = ROOT / f"{name}.{kind}"
    tmp = out.with_suffix(".part")
    tmp.write_bytes(raw)
    tmp.replace(out)
    return int(out.stat().st_mtime)


def remove(name: str) -> None:
    for ext in KINDS:
        (ROOT / f"{name}.{ext}").unlink(missing_ok=True)


def clean_text(text) -> str:
    """One or two characters — a letter, a Chinese character or an emoji (with its joiners)."""
    t = re.sub(r"\s+", "", str(text or ""))
    return t[:8] if len(t) <= 8 and len(re.sub(r"[‍️\U0001F3FB-\U0001F3FF]", "", t)) <= 2 else ""


def view(name: str, cfg: dict) -> dict:
    v = version(name)
    return {"image": f"/v1/agents/{name}/avatar?v={v}" if v else None,
            "text": cfg.get("avatar_text") or "", "color": cfg.get("avatar_color") or ""}
