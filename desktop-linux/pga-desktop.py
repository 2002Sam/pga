#!/usr/bin/env python3
"""PGA Linux Desktop Launcher.

Starts the local PGA service if needed and opens PGA in a dedicated Linux desktop window:
  1. Native GTK/Qt WebView via `pywebview` (if installed)
  2. Chromium-family `--app=` standalone window with dedicated WM class (`PGA`)
  3. System default browser via `xdg-open`

Also supports `--install-desktop` to register `~/.local/share/applications/pga.desktop`,
application icons, and `~/.local/bin/pga-desktop`.
"""

from __future__ import annotations

import argparse
import json
import os
from pathlib import Path
import shlex
import shutil
import subprocess
import sys
import time
import urllib.request

REPO_ROOT = Path(__file__).resolve().parents[1]
ICONS_DIR = REPO_ROOT / "src" / "pga" / "web" / "icons"
CHROMIUM_BINS = (
    "google-chrome",
    "google-chrome-stable",
    "chromium",
    "chromium-browser",
    "microsoft-edge",
    "microsoft-edge-stable",
    "brave-browser",
    "vivaldi",
)


def read_env_file(path: Path) -> dict[str, str]:
    out: dict[str, str] = {}
    if not path.is_file():
        return out
    for raw in path.read_text(encoding="utf-8", errors="replace").splitlines():
        line = raw.strip()
        if not line or line.startswith("#") or "=" not in line:
            continue
        k, _, v = line.partition("=")
        out[k.strip()] = v.strip().strip('"').strip("'")
    return out


def resolve_base_url(repo_root: Path = REPO_ROOT, *, url: str | None = None, port: int | None = None) -> str:
    if url:
        return url.rstrip("/")
    env_url = os.environ.get("PGA_URL", "").strip()
    if env_url:
        return env_url.rstrip("/")
    settings = read_env_file(repo_root / ".env")
    host = settings.get("PGA_HOST", "127.0.0.1")
    if host in ("0.0.0.0", "::", ""):
        host = "127.0.0.1"
    resolved_port = port or int(settings.get("PGA_PORT") or 8000)
    authority = f"[{host}]" if ":" in host else host
    return f"http://{authority}:{resolved_port}"


def is_healthy(base_url: str, timeout: float = 2.0) -> bool:
    opener = urllib.request.build_opener(urllib.request.ProxyHandler({}))
    try:
        with opener.open(f"{base_url}/healthz", timeout=timeout) as resp:
            if getattr(resp, "status", 200) != 200:
                return False
            data = json.load(resp)
            return bool(data.get("ok") is True)
    except Exception:  # noqa: BLE001
        return False


def start_local_service(repo_root: Path = REPO_ROOT) -> bool:
    """Try systemd user service first, then `.pga-install/run`, then `.venv/bin/python -m pga all`."""
    unit = Path(os.environ.get("XDG_CONFIG_HOME") or (Path.home() / ".config")) / "systemd/user/pga.service"
    if unit.is_file() and shutil.which("systemctl"):
        res = subprocess.run(["systemctl", "--user", "start", "pga.service"], capture_output=True)
        if res.returncode == 0:
            return True

    launcher = repo_root / ".pga-install" / "run"
    log_dir = repo_root.parent / "logs"
    log_dir.mkdir(parents=True, exist_ok=True)
    log_file = (log_dir / "pga-desktop-linux.log").open("ab")
    try:
        if launcher.is_file() and os.access(launcher, os.X_OK):
            subprocess.Popen([str(launcher)], cwd=repo_root, stdin=subprocess.DEVNULL,
                             stdout=log_file, stderr=log_file, start_new_session=True)
            return True
        venv_py = repo_root / ".venv" / "bin" / "python"
        if venv_py.is_file():
            subprocess.Popen([str(venv_py), "-m", "pga", "all"], cwd=repo_root, stdin=subprocess.DEVNULL,
                             stdout=log_file, stderr=log_file, start_new_session=True)
            return True
    finally:
        log_file.close()
    return False


def ensure_service(base_url: str, *, repo_root: Path = REPO_ROOT, autostart: bool = True, timeout: float = 45.0) -> bool:
    if is_healthy(base_url):
        return True
    if not autostart:
        return False
    if not start_local_service(repo_root):
        return False
    deadline = time.monotonic() + timeout
    while time.monotonic() < deadline:
        if is_healthy(base_url):
            return True
        time.sleep(0.8)
    return False


def find_chromium() -> str | None:
    for name in CHROMIUM_BINS:
        hit = shutil.which(name)
        if hit:
            return hit
    return None


def chromium_command(browser: str, target_url: str, *, profile_dir: Path | None = None,
                     width: int = 1440, height: int = 900) -> list[str]:
    profile = profile_dir or (Path(os.environ.get("XDG_DATA_HOME") or (Path.home() / ".local/share")) / "pga-desktop" / "profile")
    profile.mkdir(parents=True, exist_ok=True)
    return [
        browser,
        f"--app={target_url}",
        f"--user-data-dir={profile}",
        f"--window-size={width},{height}",
        "--class=PGA",
        "--name=PGA",
        "--no-first-run",
        "--no-default-browser-check",
    ]


def open_window(target_url: str, *, backend: str = "auto", width: int = 1440, height: int = 900) -> str:
    if backend in ("auto", "webview"):
        try:
            import webview  # type: ignore[import-not-found]

            webview.create_window("PGA · 个人多智能体工作台", target_url, width=width, height=height, min_size=(900, 600))
            webview.start()
            return "webview"
        except Exception:  # noqa: BLE001
            if backend == "webview":
                raise

    if backend in ("auto", "chromium"):
        browser = find_chromium()
        if browser:
            subprocess.Popen(chromium_command(browser, target_url, width=width, height=height),
                             stdin=subprocess.DEVNULL, stdout=subprocess.DEVNULL, stderr=subprocess.DEVNULL,
                             start_new_session=True)
            return f"chromium:{Path(browser).name}"
        if backend == "chromium":
            raise RuntimeError("未找到 Chrome/Chromium/Edge/Brave 浏览器，请安装其中之一或使用 --backend browser")

    opener = shutil.which("xdg-open")
    if opener:
        subprocess.Popen([opener, target_url], stdin=subprocess.DEVNULL, stdout=subprocess.DEVNULL,
                         stderr=subprocess.DEVNULL, start_new_session=True)
        return "xdg-open"
    raise RuntimeError(f"无法自动打开窗口，请在浏览器访问：{target_url}")


def desktop_entry_text(exec_cmd: str, icon_name: str = "pga") -> str:
    return (
        "[Desktop Entry]\n"
        "Type=Application\n"
        "Version=1.0\n"
        "Name=PGA\n"
        "GenericName=Personal Multi-Agent Workspace\n"
        "Comment=个人多智能体工作台 · Personal Multi-Agent Workspace\n"
        f"Exec={exec_cmd}\n"
        f"Icon={icon_name}\n"
        "Terminal=false\n"
        "Categories=Development;Utility;Office;\n"
        "StartupWMClass=PGA\n"
        "StartupNotify=true\n"
        "Actions=Models;\n"
        "\n"
        "[Desktop Action Models]\n"
        "Name=模型与 API 设置\n"
        f"Exec={exec_cmd} --models\n"
    )


def install_desktop(*, repo_root: Path = REPO_ROOT, home: Path | None = None) -> dict[str, Path]:
    base_home = home or Path.home()
    bin_dir = base_home / ".local" / "bin"
    apps_dir = base_home / ".local" / "share" / "applications"
    icons_base = base_home / ".local" / "share" / "icons" / "hicolor"
    bin_dir.mkdir(parents=True, exist_ok=True)
    apps_dir.mkdir(parents=True, exist_ok=True)

    script_path = repo_root / "desktop-linux" / "pga-desktop.py"
    venv_py = repo_root / ".venv" / "bin" / "python"
    py_exe = str(venv_py) if venv_py.is_file() else (shutil.which("python3") or sys.executable)

    wrapper = bin_dir / "pga-desktop"
    wrapper.write_text(
        f"#!/bin/sh\nexec {shlex.quote(py_exe)} {shlex.quote(str(script_path))} \"$@\"\n",
        encoding="utf-8",
    )
    wrapper.chmod(0o755)

    icons_src = repo_root / "src" / "pga" / "web" / "icons"
    installed_icon = "pga"
    for size, filename in (("128x128", "logo-128.png"), ("512x512", "icon-512.png")):
        src = icons_src / filename
        if src.is_file():
            dst = icons_base / size / "apps" / "pga.png"
            dst.parent.mkdir(parents=True, exist_ok=True)
            shutil.copy2(src, dst)
            installed_icon = "pga"

    desktop_file = apps_dir / "pga.desktop"
    desktop_file.write_text(desktop_entry_text(str(wrapper), icon_name=installed_icon), encoding="utf-8")
    desktop_file.chmod(0o644)

    if shutil.which("update-desktop-database"):
        subprocess.run(["update-desktop-database", str(apps_dir)], capture_output=True)
    return {"wrapper": wrapper, "desktop": desktop_file}


def uninstall_desktop(*, home: Path | None = None) -> None:
    base_home = home or Path.home()
    for p in (
        base_home / ".local" / "bin" / "pga-desktop",
        base_home / ".local" / "share" / "applications" / "pga.desktop",
        base_home / ".local" / "share" / "icons" / "hicolor" / "128x128" / "apps" / "pga.png",
        base_home / ".local" / "share" / "icons" / "hicolor" / "512x512" / "apps" / "pga.png",
    ):
        if p.exists() or p.is_symlink():
            p.unlink()


def parse_args(argv: list[str] | None = None) -> argparse.Namespace:
    p = argparse.ArgumentParser(description="PGA Linux Desktop Launcher")
    p.add_argument("--url", help="PGA server URL (defaults to .env PGA_HOST/PGA_PORT)")
    p.add_argument("--port", type=int, help="Override PGA port")
    p.add_argument("--models", action="store_true", help="Open directly to Settings → 模型与 API")
    p.add_argument("--backend", choices=("auto", "webview", "chromium", "browser"), default="auto")
    p.add_argument("--no-autostart", action="store_true", help="Do not attempt to start the local PGA service")
    p.add_argument("--install-desktop", action="store_true", help="Install ~/.local/bin/pga-desktop and .desktop entry")
    p.add_argument("--uninstall-desktop", action="store_true", help="Remove Linux desktop shortcut and launcher")
    p.add_argument("--check", action="store_true", help="Print resolved URL, health status, and detected window backend")
    return p.parse_args(argv)


def main(argv: list[str] | None = None) -> int:
    args = parse_args(argv)
    if args.install_desktop:
        res = install_desktop()
        print(f"Installed launcher: {res['wrapper']}")
        print(f"Installed desktop entry: {res['desktop']}")
        return 0
    if args.uninstall_desktop:
        uninstall_desktop()
        print("Removed PGA Linux desktop entry and launcher.")
        return 0

    base_url = resolve_base_url(url=args.url, port=args.port)
    target_url = f"{base_url}/#model-settings" if args.models else base_url
    if args.check:
        healthy = is_healthy(base_url)
        browser = find_chromium()
        print(json.dumps({"url": target_url, "healthy": healthy, "chromium": browser or ""}, ensure_ascii=False, indent=2))
        return 0 if healthy else 1

    if not ensure_service(base_url, autostart=not args.no_autostart):
        print(f"PGA 服务未在 {base_url} 运行。请先运行 `bash deploy/linux/install-linux.sh` 或 `systemctl --user start pga`。",
              file=sys.stderr)
        return 1

    mode = open_window(target_url, backend=args.backend)
    print(f"Opened PGA ({mode}): {target_url}")
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
