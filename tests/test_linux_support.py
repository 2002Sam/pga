"""Unit tests for Linux compatibility (notifications, editor, docview, desktop launcher)."""

from __future__ import annotations

import importlib.util
from pathlib import Path
from types import SimpleNamespace

import pytest

from pga import docview, editor
from pga.notify.service import default_channels, linux_channel


def _load_desktop_module():
    path = Path(__file__).resolve().parents[1] / "desktop-linux" / "pga-desktop.py"
    spec = importlib.util.spec_from_file_location("pga_desktop_linux", path)
    assert spec and spec.loader
    mod = importlib.util.module_from_spec(spec)
    spec.loader.exec_module(mod)
    return mod


def test_linux_notification_channel_invokes_notify_send():
    calls = []

    def fake_run(cmd, **kw):
        calls.append((cmd, kw))

    assert "linux" in default_channels()
    ch = linux_channel(run=fake_run)
    note = SimpleNamespace(display_title="任务完成", title_en="Done", display_body="已生成结果", body_en="Ready")
    ch(SimpleNamespace(), note)
    assert len(calls) == 1
    cmd, kw = calls[0]
    assert cmd[0].endswith("notify-send") and "--app-name=PGA" in cmd
    assert "任务完成" in cmd[2] and cmd[3] == "已生成结果" and kw["check"] is True


def test_editor_resolves_linux_code_binary(tmp_path, monkeypatch):
    fake_code = tmp_path / "code-tunnel"
    fake_code.write_text("#!/bin/sh\n", encoding="utf-8")
    fake_code.chmod(0o755)

    monkeypatch.setattr(editor, "CLI", tmp_path / "missing-mac-code")
    monkeypatch.delenv("PGA_CODE_CLI", raising=False)
    monkeypatch.setenv("PATH", str(tmp_path))
    assert editor.resolve_cli() == fake_code

    custom = tmp_path / "custom-code"
    custom.write_text("#!/bin/sh\n", encoding="utf-8")
    monkeypatch.setenv("PGA_CODE_CLI", str(custom))
    assert editor.resolve_cli() == custom


def test_docview_uses_system_fontconfig_on_linux(tmp_path, monkeypatch):
    fake_lo = tmp_path / "libreoffice"
    fake_lo.write_text("#!/bin/sh\n", encoding="utf-8")
    fake_lo.chmod(0o755)
    monkeypatch.setenv("PATH", str(tmp_path))
    monkeypatch.setattr("sys.platform", "linux")
    monkeypatch.delenv("FONTCONFIG_FILE", raising=False)

    env = docview._fonts_env()
    assert "FONTCONFIG_FILE" not in env
    assert docview.soffice() == str(fake_lo)


def test_linux_desktop_launcher_and_desktop_entry(tmp_path, monkeypatch):
    mod = _load_desktop_module()
    fake_repo = tmp_path / "repo"
    (fake_repo / "desktop-linux").mkdir(parents=True)
    (fake_repo / "desktop-linux" / "pga-desktop.py").write_text("#!/usr/bin/env python3\n", encoding="utf-8")
    (fake_repo / "src" / "pga" / "web" / "icons").mkdir(parents=True)
    (fake_repo / "src" / "pga" / "web" / "icons" / "logo-128.png").write_bytes(b"PNG")
    (fake_repo / ".env").write_text("PGA_HOST=0.0.0.0\nPGA_PORT=8015\n", encoding="utf-8")

    monkeypatch.delenv("PGA_URL", raising=False)
    assert mod.resolve_base_url(fake_repo) == "http://127.0.0.1:8015"
    assert mod.resolve_base_url(fake_repo, port=9001) == "http://127.0.0.1:9001"

    cmd = mod.chromium_command("/usr/bin/chromium", "http://127.0.0.1:8015", profile_dir=tmp_path / "prof")
    assert cmd[0] == "/usr/bin/chromium" and "--app=http://127.0.0.1:8015" in cmd and "--class=PGA" in cmd

    fake_home = tmp_path / "home"
    out = mod.install_desktop(repo_root=fake_repo, home=fake_home)
    assert out["wrapper"].is_file() and out["desktop"].is_file()
    desktop_txt = out["desktop"].read_text(encoding="utf-8")
    assert "StartupWMClass=PGA" in desktop_txt and "--models" in desktop_txt
    assert (fake_home / ".local/share/icons/hicolor/128x128/apps/pga.png").is_file()

    mod.uninstall_desktop(home=fake_home)
    assert not out["wrapper"].exists() and not out["desktop"].exists()
