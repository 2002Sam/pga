"""Write the vault to disk (or a zip) so it opens in Obsidian.

The export only ever touches files it wrote itself: it keeps a manifest
(`.pga-manifest.json`) of its files, removes the ones that no longer exist in
PGA, and never overwrites a file it did not create — so it is safe to point it
at a vault the user already keeps their own notes in.
"""

from __future__ import annotations

import io
import json
import zipfile
from datetime import datetime, timezone
from pathlib import Path

from .builder import Vault

MANIFEST = ".pga-manifest.json"

# Obsidian graph view colour groups (only written into a vault that has no .obsidian folder yet).
GRAPH_COLORS = [("path:Responsibilities", 0xC9432D), ("path:Beliefs", 0xF5C76B), ("path:Evidence", 0x8FB3A0),
                ("path:Agents", 0x7AA2F7), ("path:Projects", 0xC792EA), ("path:Sources", 0x9A8F83),
                ("path:Decisions", 0xE0AF68)]


class VaultExportError(RuntimeError):
    pass


def _graph_json() -> str:
    return json.dumps({"colorGroups": [{"query": q, "color": {"a": 1, "rgb": c}} for q, c in GRAPH_COLORS],
                       "showTags": False, "showArrow": True, "lineSizeMultiplier": 1, "nodeSizeMultiplier": 1.1,
                       "centerStrength": 0.5, "repelStrength": 12, "linkStrength": 1, "linkDistance": 220}, indent=2)


def export_vault(vault: Vault, target: str | Path) -> dict:
    root = Path(target).expanduser().resolve()
    if root == Path(root.anchor) or root == Path.home().resolve():
        raise VaultExportError(f"refusing to export into {root}; choose a dedicated folder")
    root.mkdir(parents=True, exist_ok=True)
    manifest_path = root / MANIFEST
    try:
        previous = set(json.loads(manifest_path.read_text("utf-8")).get("files", []))
    except (OSError, ValueError):
        previous = set()

    written: list[str] = []
    unchanged = 0
    conflicts: list[str] = []
    for n in vault.notes:
        if n.external:
            continue
        rel = n.path
        path = (root / rel).resolve()
        if root not in path.parents:
            conflicts.append(rel)
            continue
        text = n.markdown()
        if path.exists():
            if rel not in previous:
                conflicts.append(rel)  # the user's own file with the same name: leave it alone
                continue
            if path.read_text("utf-8", errors="replace") == text:
                written.append(rel)
                unchanged += 1
                continue
        path.parent.mkdir(parents=True, exist_ok=True)
        path.write_text(text, encoding="utf-8")
        written.append(rel)

    removed = 0
    for rel in previous - set(written):
        path = (root / rel).resolve()
        if root in path.parents and path.is_file():
            path.unlink()
            removed += 1
            parent = path.parent
            while parent != root and parent.is_dir() and not any(parent.iterdir()):
                parent.rmdir()
                parent = parent.parent

    obsidian = root / ".obsidian"
    if not obsidian.exists():
        obsidian.mkdir()
        (obsidian / "graph.json").write_text(_graph_json(), encoding="utf-8")

    manifest_path.write_text(json.dumps({"exported_at": datetime.now(timezone.utc).isoformat(),
                                         "files": sorted(written)}, ensure_ascii=False, indent=1), encoding="utf-8")
    return {"path": str(root), "notes": len(written), "changed": len(written) - unchanged, "removed": removed,
            "conflicts": conflicts}


def vault_zip(vault: Vault, folder: str = "PGA Vault") -> bytes:
    buf = io.BytesIO()
    with zipfile.ZipFile(buf, "w", zipfile.ZIP_DEFLATED) as z:
        for n in vault.notes:
            if not n.external:
                z.writestr(f"{folder}/{n.path}", n.markdown())
        z.writestr(f"{folder}/.obsidian/graph.json", _graph_json())
    return buf.getvalue()
