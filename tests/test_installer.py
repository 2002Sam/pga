"""Installation regressions without touching the user's services or database."""

import argparse
import importlib.util
import json
import os
from pathlib import Path
import plistlib
import socket
import subprocess
import sys

import pytest
import yaml


@pytest.fixture
def installer(tmp_path, monkeypatch):
    spec = importlib.util.spec_from_file_location("pga_installer", Path(__file__).parents[1] / "scripts/install.py")
    module = importlib.util.module_from_spec(spec)
    spec.loader.exec_module(module)
    root = tmp_path / "checkout % $word's space"
    root.mkdir()
    state = root / ".pga-install"
    state.mkdir()
    monkeypatch.setattr(module, "ROOT", root)
    monkeypatch.setattr(module, "STATE", state)
    monkeypatch.setattr(module, "PYTHON", root / ".venv/bin/python")
    monkeypatch.setattr(module, "check_docker", lambda: None)
    for name in ("PGA_DATABASE_URL", "PGA_HOST", "PGA_PORT", "PGA_LLM_PROVIDER"):
        monkeypatch.delenv(name, raising=False)
    return module


def options(**overrides):
    return argparse.Namespace(**{"database": "auto", "port": None, "db_port": None,
                                 "no_service": True, "check": False, **overrides})


def free_port():
    with socket.socket() as probe:
        probe.bind(("127.0.0.1", 0))
        return probe.getsockname()[1]


def test_managed_database_credentials_survive_retry(installer):
    args = options(db_port=free_port())
    first, additions, docker = installer.configuration(args)
    saved = (installer.STATE / "postgres.env").read_bytes()
    # An interrupted first run may have saved credentials but not yet written .env.
    retried, _, docker_again = installer.configuration(args)
    assert retried == first
    installer.append_settings(installer.ROOT / ".env", additions)
    again, extra, _ = installer.configuration(args)
    assert again == first
    assert extra == {}
    assert docker and docker_again
    assert saved == (installer.STATE / "postgres.env").read_bytes()
    assert (installer.STATE / "postgres.env").stat().st_mode & 0o777 == 0o600
    assert (installer.ROOT / ".env").stat().st_mode & 0o777 == 0o600


def test_existing_configuration_is_preserved_without_docker(installer, monkeypatch):
    path = installer.ROOT / ".env"
    original = ("# retain comments and keys\nPGA_DATABASE_URL='postgresql://user:p%25ss@localhost/pga'\n"
                "PGA_HOST=127.0.0.1\nPGA_PORT=8123\nANTHROPIC_API_KEY='keep me'\n")
    path.write_text(original)
    monkeypatch.setattr(installer, "check_docker", lambda: pytest.fail("existing DB must not need Docker"))
    settings, additions, docker = installer.configuration(options())
    installer.append_settings(path, additions)
    assert path.read_text() == original
    assert additions == {}
    assert not docker
    assert settings["PGA_DATABASE_URL"] == "postgresql+psycopg://user:p%25ss@localhost/pga"


def test_environment_database_is_saved_for_future_starts(installer, monkeypatch):
    url = "postgresql+psycopg://user:p%40ss@localhost/pga"
    monkeypatch.setenv("PGA_DATABASE_URL", url)
    settings, additions, docker = installer.configuration(options(database="existing"))
    installer.append_settings(installer.ROOT / ".env", additions)
    monkeypatch.delenv("PGA_DATABASE_URL")
    again, additions, _ = installer.configuration(options())
    assert again == settings
    assert additions == {}
    assert not docker


def test_dotenv_is_data_not_shell_code(installer):
    sentinel = installer.ROOT / "should-not-exist"
    value = f"literal'\\value $(touch '{sentinel}') `touch '{sentinel}'` # spaces"
    installer.append_settings(installer.ROOT / ".env", {"EXAMPLE_KEY": value})
    assert installer.read_settings(installer.ROOT / ".env")["EXAMPLE_KEY"] == value
    assert not sentinel.exists()


@pytest.mark.parametrize("url", ["invalid-secret", "sqlite:///pga", "postgresql://localhost", "postgresql://localhost:bad/pga"])
def test_invalid_url_has_no_secret_in_error(installer, url):
    with pytest.raises(installer.InstallError) as error:
        installer.normalized_url(url)
    assert url not in str(error.value)


def test_conflicting_environment_does_not_overwrite_file(installer, monkeypatch):
    path = installer.ROOT / ".env"
    path.write_text("PGA_DATABASE_URL=postgresql://first/db\n")
    before = path.read_bytes()
    monkeypatch.setenv("PGA_DATABASE_URL", "postgresql://second/db")
    with pytest.raises(installer.InstallError, match="differs from .env"):
        installer.configuration(options())
    assert path.read_bytes() == before


def test_forcing_docker_does_not_replace_existing_database(installer):
    path = installer.ROOT / ".env"
    path.write_text("PGA_DATABASE_URL=postgresql://existing/db\n")
    with pytest.raises(installer.InstallError, match="another database"):
        installer.configuration(options(database="docker"))
    assert not (installer.STATE / "postgres.env").exists()


def test_port_conflict_is_reported(installer):
    with socket.socket() as listener:
        listener.bind(("127.0.0.1", 0))
        listener.listen()
        with pytest.raises(installer.InstallError, match="unavailable"):
            installer.check_port("127.0.0.1", listener.getsockname()[1])


def test_concurrent_install_is_rejected(installer):
    with installer.install_lock():
        with pytest.raises(installer.InstallError, match="Another installer"):
            with installer.install_lock():
                pytest.fail("a second install acquired the lock")
    with installer.install_lock():
        pass  # the OS releases the lock after failure or process exit


def test_launcher_handles_shell_characters_in_checkout_path(installer, monkeypatch):
    monkeypatch.setattr(installer, "PYTHON", Path(sys.executable))
    scripts = installer.ROOT / "scripts"
    scripts.mkdir()
    (scripts / "run.py").write_text("import json, os; print(json.dumps(os.getcwd()))\n")
    installer.write_launcher()
    result = subprocess.run([str(installer.STATE / "run")], capture_output=True, text=True, check=True)
    assert json.loads(result.stdout) == str(installer.ROOT)


@pytest.mark.parametrize("kind", ["launchd", "systemd"])
def test_service_files_preserve_paths_and_set_restart(installer, monkeypatch, kind):
    path = installer.STATE / ("pga.plist" if kind == "launchd" else "pga.service")
    domain = "gui/123" if kind == "launchd" else ""
    control = ["launchctl"] if domain else ["systemctl", "--user"]
    monkeypatch.setattr(installer, "service_spec", lambda: (path, control, domain))
    calls = []
    monkeypatch.setattr(installer, "run", lambda args, **kwargs: calls.append(args))
    installer.install_service()
    if domain:
        data = plistlib.loads(path.read_bytes())
        assert data["ProgramArguments"] == [str(installer.STATE / "run")]
        assert data["KeepAlive"] is True
        assert data["PGAInstallerRoot"] == str(installer.ROOT)
        assert calls == [["launchctl", "bootstrap", domain, str(path)]]
    else:
        unit = path.read_text()
        assert "%% $$word's space/.pga-install/run\"" in unit
        assert "Restart=always" in unit
        assert calls[-1] == control + ["enable", "--now", "pga.service"]


def test_foreign_service_is_preserved(installer, monkeypatch):
    path = installer.STATE / "foreign.plist"
    original = plistlib.dumps({"Label": installer.LABEL, "WorkingDirectory": "/different"})
    path.write_bytes(original)
    monkeypatch.setattr(installer, "service_spec", lambda: (path, ["launchctl"], "gui/123"))
    monkeypatch.setattr(installer.shutil, "which", lambda command: command)
    monkeypatch.setattr(installer, "succeeds", lambda args: True)
    with pytest.raises(installer.InstallError, match="managed elsewhere"):
        installer.check_service()
    assert path.read_bytes() == original


def test_seeded_agents_are_valid_and_user_edits_survive(installer, monkeypatch):
    from pga.agents.pool import validate
    monkeypatch.setattr(installer.shutil, "which", lambda command: f"/tools/{command}")
    installer.initialize_agents()
    path = installer.ROOT / "agents.yaml"
    config = yaml.safe_load(path.read_text())
    validate(config)
    assert config["agents"]["codex"]["command"] == "/tools/codex"
    assert config["workflows"]["implement"]["agents"] == ["claude", "codex"]
    path.write_text("# user changed the file\n" + path.read_text())
    before = path.read_bytes()
    installer.initialize_agents()
    assert path.read_bytes() == before


def test_migration_failure_never_registers_service(installer, monkeypatch):
    settings = {"PGA_HOST": "127.0.0.1", "PGA_PORT": str(free_port()),
                "PGA_DATABASE_URL": "postgresql+psycopg://localhost/db"}
    monkeypatch.setattr(installer, "configuration", lambda options: (settings, {}, False))
    monkeypatch.setattr(installer, "wait_database", lambda url: None)
    def failed_migration(args, **kwargs):
        raise subprocess.CalledProcessError(1, args)
    monkeypatch.setattr(installer, "run", failed_migration)
    monkeypatch.setattr(installer, "install_service", lambda: pytest.fail("service started before migration succeeded"))
    with pytest.raises(subprocess.CalledProcessError):
        installer.install(options(no_service=False))
    assert not (installer.STATE / "run").exists()
