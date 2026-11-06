"""Source installer, bootstrapped by install.sh; no system Python packages are changed."""

from __future__ import annotations

import argparse
import contextlib
import copy
import fcntl
import hashlib
import ipaddress
import json
import os
from pathlib import Path
import platform
import plistlib
import secrets
import shlex
import shutil
import socket
import subprocess
import sys
import tempfile
import time
import urllib.request
import venv

ROOT = Path(__file__).resolve().parents[1]
STATE = ROOT / ".pga-install"
PYTHON = ROOT / ".venv" / "bin" / "python"
LABEL = "local.pga.agent"


class InstallError(Exception):
    pass


def run(args, **kwargs):
    return subprocess.run([str(arg) for arg in args], check=True, **kwargs)


def succeeds(args) -> bool:
    return subprocess.run(args, stdout=subprocess.DEVNULL, stderr=subprocess.DEVNULL).returncode == 0


def port_number(value: str) -> int:
    try:
        port = int(value)
        if 1 <= port <= 65535:
            return port
    except ValueError:
        pass
    raise argparse.ArgumentTypeError("port must be between 1 and 65535")


def arguments():
    parser = argparse.ArgumentParser(description="Install PGA from this checkout on macOS or Linux.")
    parser.add_argument("--database", choices=("auto", "docker", "existing"), default="auto",
                        help="auto reuses PGA_DATABASE_URL, otherwise creates a Docker database")
    parser.add_argument("--port", type=port_number, help="web port for a new configuration (default 8000)")
    parser.add_argument("--db-port", type=port_number, help="new Docker database port (default 55432)")
    parser.add_argument("--no-service", action="store_true", help="install and migrate, then print a foreground start command")
    parser.add_argument("--check", action="store_true", help="check prerequisites without installing or changing files")
    parser.add_argument("--prepared", action="store_true", help=argparse.SUPPRESS)
    return parser.parse_args()


def service_spec() -> tuple[Path, list[str], str]:
    if platform.system() == "Darwin":
        return Path.home() / "Library/LaunchAgents" / f"{LABEL}.plist", ["launchctl"], f"gui/{os.getuid()}"
    if os.getuid() == 0:
        return Path("/etc/systemd/system/pga.service"), ["systemctl"], ""
    config = Path(os.environ.get("XDG_CONFIG_HOME", str(Path.home() / ".config")))
    return config / "systemd/user/pga.service", ["systemctl", "--user"], ""


def check_service() -> bool:
    """Check ownership before touching a service; an active installation is a no-op."""
    path, control, domain = service_spec()
    if not shutil.which(control[0]):
        raise InstallError(f"{control[0]} is unavailable. Use --no-service for a foreground installation.")
    if domain:
        available = succeeds(control + ["print", domain])
    else:
        available = succeeds(control + ["show-environment"])
    if not available:
        raise InstallError("Service manager is unavailable in this session. Use --no-service, or log in with a user session.")
    if path.exists():
        if domain:
            with path.open("rb") as stream:
                owned = plistlib.load(stream).get("PGAInstallerRoot") == str(ROOT)
        else:
            owned = path.read_text().startswith(f"# PGA installer: {ROOT}\n")
        if not owned:
            raise InstallError(f"An existing service is managed elsewhere: {path}. Use --no-service or a separate account.")
    if domain:
        result = subprocess.run(control + ["print", f"{domain}/{LABEL}"], capture_output=True, text=True)
        loaded = result.returncode == 0
        if loaded and not path.exists():
            raise InstallError(f"An existing {LABEL} service is loaded from elsewhere.")
        # A loaded job can be waiting to restart or waiting for PostgreSQL.
        return loaded
    active = succeeds(control + ["is-active", "--quiet", "pga.service"])
    if active and not path.exists():
        raise InstallError("An existing pga.service is managed elsewhere.")
    return active


def stop_command() -> str:
    path, control, domain = service_spec()
    if domain:
        return shlex.join(control + ["bootout", f"{domain}/{LABEL}"])
    return shlex.join(control + ["stop", "pga.service"])


def check_docker():
    if not shutil.which("docker"):
        raise InstallError("Install and start Docker with Compose, or use --database existing with PGA_DATABASE_URL.")
    if not succeeds(["docker", "compose", "version"]) or not succeeds(["docker", "info"]):
        raise InstallError("Docker with Compose must be running and accessible to this user.")


def prerequisites(options):
    if platform.system() not in ("Darwin", "Linux"):
        raise InstallError("This installer supports macOS and Linux.")
    if any(char in str(ROOT) for char in "\r\n\x00"):
        raise InstallError("The checkout path must fit on one line.")
    for name in ("pyproject.toml", "alembic.ini", "migrations", "src/pga", "scripts/run.py"):
        if not (ROOT / name).exists():
            raise InstallError(f"Incomplete checkout: missing {name}. Download the whole repository first.")
    if not options.no_service and check_service():
        print(f"PGA is already registered and running. To update it, stop it first with:\n  {stop_command()}")
        return False
    # Full configuration parsing happens inside the virtual environment.
    if options.database == "docker" or (options.database == "auto" and
            not (ROOT / ".env").exists() and not os.environ.get("PGA_DATABASE_URL")):
        check_docker()
    return True


@contextlib.contextmanager
def install_lock():
    STATE.mkdir(mode=0o700, exist_ok=True)
    with (STATE / "install.lock").open("a") as lock:
        try:
            fcntl.flock(lock, fcntl.LOCK_EX | fcntl.LOCK_NB)
        except BlockingIOError:
            raise InstallError("Another installer is running for this checkout.") from None
        yield


def write_atomic(path: Path, data: str | bytes, mode: int = 0o600):
    path.parent.mkdir(parents=True, exist_ok=True)
    fd, name = tempfile.mkstemp(prefix=f".{path.name}.", dir=path.parent)
    try:
        with os.fdopen(fd, "wb") as stream:
            stream.write(data.encode() if isinstance(data, str) else data)
            stream.flush()
            os.fsync(stream.fileno())
        os.chmod(name, mode)
        os.replace(name, path)
    finally:
        Path(name).unlink(missing_ok=True)


def dotenv_line(key: str, value: str) -> str:
    if any(char in value for char in "\r\n\x00"):
        raise InstallError(f"{key} must fit on one line.")
    escaped = value.replace("\\", "\\\\").replace("'", "\\'")
    return f"{key}='{escaped}'\n"


def append_settings(path: Path, values: dict[str, str]):
    if not values:
        return
    old = path.read_text() if path.exists() else ""
    separator = "\n" if old and not old.endswith("\n") else ""
    write_atomic(path, old + separator + "".join(dotenv_line(k, v) for k, v in values.items()))


def read_settings(path: Path) -> dict[str, str]:
    from dotenv import dotenv_values
    return {key: value for key, value in dotenv_values(path).items() if value is not None}


def normalized_url(value: str) -> str:
    from sqlalchemy.engine import make_url
    from sqlalchemy.exc import ArgumentError
    try:
        url = make_url(value)
        if url.drivername in ("postgres", "postgresql"):
            url = url.set(drivername="postgresql+psycopg")
        if url.drivername != "postgresql+psycopg" or not url.database or any(c in value for c in "\r\n\x00"):
            raise ValueError
        return url.render_as_string(hide_password=False)
    except (ArgumentError, ValueError, TypeError):
        raise InstallError("PGA_DATABASE_URL must be a PostgreSQL URL with a database name.") from None


def configuration(options) -> tuple[dict[str, str], dict[str, str], bool]:
    settings = read_settings(ROOT / ".env")
    additions = {}
    for key in ("PGA_DATABASE_URL", "PGA_HOST", "PGA_PORT", "PGA_LLM_PROVIDER"):
        provided = os.environ.get(key)
        if provided is not None and key in settings and provided != settings[key]:
            raise InstallError(f"Environment {key} differs from .env. Edit .env to choose a persistent value first.")
        if provided is not None and key not in settings:
            additions[key] = provided
    effective = {**settings, **additions}
    if options.port is not None and "PGA_PORT" in effective and str(options.port) != effective["PGA_PORT"]:
        raise InstallError("--port differs from the saved PGA_PORT. Edit .env before changing the port.")
    defaults = {"PGA_HOST": "127.0.0.1", "PGA_PORT": str(options.port or 8000)}
    if not (ROOT / ".env").exists():
        defaults["PGA_LLM_PROVIDER"] = "fake"
    for key, default in defaults.items():
        if key not in effective:
            additions[key] = default
            effective[key] = default
    try:
        port_number(effective["PGA_PORT"])
        ipaddress.ip_address(effective["PGA_HOST"])
    except (ValueError, argparse.ArgumentTypeError):
        raise InstallError("PGA_HOST must be an IP address and PGA_PORT must be between 1 and 65535.") from None

    managed_file = STATE / "postgres.env"
    managed = read_settings(managed_file) if managed_file.exists() else {}
    managed_url = ""
    if managed:
        managed_url = f"postgresql+psycopg://pga:{managed['POSTGRES_PASSWORD']}@127.0.0.1:{managed['POSTGRES_PORT']}/pga"
    configured_url = normalized_url(effective["PGA_DATABASE_URL"]) if effective.get("PGA_DATABASE_URL") else ""
    docker = options.database == "docker" or (options.database == "auto" and
             (not configured_url or configured_url == managed_url))
    if docker:
        check_docker()
        if configured_url and configured_url != managed_url:
            raise InstallError("PGA_DATABASE_URL already selects another database. Use --database existing.")
        if options.db_port and managed and str(options.db_port) != managed["POSTGRES_PORT"]:
            raise InstallError("--db-port differs from the saved database port in .pga-install/postgres.env.")
        if not managed:
            managed = {"POSTGRES_PASSWORD": secrets.token_hex(24), "POSTGRES_PORT": str(options.db_port or 55432)}
            check_port("127.0.0.1", int(managed["POSTGRES_PORT"]))
            write_atomic(managed_file, "".join(f"{k}={v}\n" for k, v in managed.items()))
            managed_url = f"postgresql+psycopg://pga:{managed['POSTGRES_PASSWORD']}@127.0.0.1:{managed['POSTGRES_PORT']}/pga"
        configured_url = managed_url
    elif not configured_url:
        raise InstallError("--database existing needs PGA_DATABASE_URL in .env or the environment.")
    elif options.db_port:
        raise InstallError("--db-port only applies to the installer-managed Docker database.")
    if not effective.get("PGA_DATABASE_URL"):
        additions["PGA_DATABASE_URL"] = configured_url
    elif "PGA_DATABASE_URL" in additions:
        additions["PGA_DATABASE_URL"] = configured_url
    effective["PGA_DATABASE_URL"] = configured_url
    return effective, additions, docker


def check_port(host: str, port: int):
    family = socket.AF_INET6 if ":" in host else socket.AF_INET
    try:
        with socket.socket(family, socket.SOCK_STREAM) as probe:
            probe.setsockopt(socket.SOL_SOCKET, socket.SO_REUSEADDR, 1)
            probe.bind((host, port))
    except OSError:
        raise InstallError(f"Port {port} on {host} is unavailable. Stop its service or choose another port.") from None


def compose_command() -> list[str]:
    project = "pga-" + hashlib.sha256(str(ROOT).encode()).hexdigest()[:12]
    return ["docker", "compose", "--project-name", project, "--env-file", str(STATE / "postgres.env"),
            "--file", str(ROOT / "deploy/compose.postgres.yml")]


def wait_database(url: str, timeout: float = 120):
    from sqlalchemy import create_engine, text
    from sqlalchemy.exc import OperationalError
    engine = create_engine(normalized_url(url), connect_args={"connect_timeout": 5})
    deadline = time.monotonic() + timeout
    try:
        while True:
            try:
                with engine.connect() as connection:
                    connection.execute(text("SELECT 1"))
                return
            except OperationalError:
                if time.monotonic() >= deadline:
                    raise InstallError("PostgreSQL did not become ready. Check the database address, credentials and logs.") from None
                time.sleep(2)
    finally:
        engine.dispose()


def write_launcher():
    search_path = str(PYTHON.parent) + os.pathsep + os.environ.get("PATH", os.defpath)
    content = ("#!/bin/sh\nset -eu\n" + f"cd {shlex.quote(str(ROOT))}\n" +
               f"export PATH={shlex.quote(search_path)}\n" +
               f"exec {shlex.quote(str(PYTHON))} {shlex.quote(str(ROOT / 'scripts/run.py'))}\n")
    write_atomic(STATE / "run", content, 0o700)


def install_service():
    path, control, domain = service_spec()
    launcher = str(STATE / "run")
    if domain:
        # Match PGA's existing log rotation destination.
        log_path = ROOT.parent / "logs" / "pga.log"
        log_path.parent.mkdir(parents=True, exist_ok=True)
        data = {"Label": LABEL, "PGAInstallerRoot": str(ROOT), "ProgramArguments": [launcher],
                "WorkingDirectory": str(ROOT), "RunAtLoad": True, "KeepAlive": True,
                "ThrottleInterval": 10, "ExitTimeOut": 60,
                "StandardOutPath": str(log_path), "StandardErrorPath": str(log_path)}
        write_atomic(path, plistlib.dumps(data))
        run(control + ["bootstrap", domain, str(path)])
    else:
        # systemd expands % specifiers even inside quoted arguments.
        escaped = launcher.replace("\\", "\\\\").replace('"', '\\"').replace("%", "%%").replace("$", "$$")
        unit = (f"# PGA installer: {ROOT}\n[Unit]\nDescription=PGA agent\nAfter=network.target\n\n"
                f"[Service]\nType=simple\nExecStart=/bin/sh \"{escaped}\"\nRestart=always\nRestartSec=10\n"
                "TimeoutStopSec=60\nUMask=0077\n\n[Install]\nWantedBy=" +
                ("multi-user.target\n" if os.getuid() == 0 else "default.target\n"))
        write_atomic(path, unit)
        run(control + ["daemon-reload"])
        run(control + ["enable", "--now", "pga.service"])
        if os.getuid() != 0:
            print("For startup before login and continued service after logout, run: loginctl enable-linger")
    print(f"Service file: {path}")


def wait_http(settings: dict[str, str], timeout: float = 90):
    host = {"0.0.0.0": "127.0.0.1", "::": "::1"}.get(settings["PGA_HOST"], settings["PGA_HOST"])
    authority = f"[{host}]" if ":" in host else host
    address = f"http://{authority}:{settings['PGA_PORT']}"
    # A user's proxy must never intercept the loopback startup probe.
    client = urllib.request.build_opener(urllib.request.ProxyHandler({}))
    deadline = time.monotonic() + timeout
    while time.monotonic() < deadline:
        try:
            with client.open(address + "/healthz", timeout=3) as response:
                if json.load(response).get("ok") is True:
                    return address
        except (OSError, ValueError):
            pass
        time.sleep(1)
    raise InstallError("PGA startup check failed. Inspect the service logs, then stop the service before retrying.")


def install(options):
    settings, additions, docker = configuration(options)
    check_port(settings["PGA_HOST"], int(settings["PGA_PORT"]))
    append_settings(ROOT / ".env", additions)
    if docker:
        print("Starting PostgreSQL…", flush=True)
        # Explicit environment values take precedence over the caller's POSTGRES_* variables.
        run(compose_command() + ["up", "-d", "postgres"], env={**os.environ, **read_settings(STATE / "postgres.env")})
    print("Waiting for PostgreSQL…", flush=True)
    wait_database(settings["PGA_DATABASE_URL"])
    print("Applying database migrations…", flush=True)
    env = {**os.environ, **settings}
    run([PYTHON, "-m", "alembic", "-c", ROOT / "alembic.ini", "upgrade", "head"], cwd=ROOT, env=env)
    initialize_agents()
    write_launcher()
    if options.no_service:
        print(f"Installed and migrated. Start PGA with:\n  {shlex.quote(str(STATE / 'run'))}")
    else:
        install_service()
        address = wait_http(settings)
        print(f"PGA is ready: {address}\nStop: {stop_command()}")
    print("Configure a model API or log in to your agent CLI in PGA Settings. New installations use the offline fake provider.")


def initialize_agents():
    if (ROOT / "agents.yaml").exists():
        return
    import yaml
    from pga.agents.pool import DEFAULT, validate
    # Pool.load replaces the agent/workflow maps, so seed the complete default configuration.
    config = copy.deepcopy(DEFAULT)
    commands = {"codex": "codex", "chatgpt": "codex", "claude": "claude", "workbuddy": "codebuddy"}
    for name, command in commands.items():
        installed = shutil.which(command)
        bundled = config["agents"][name].get("command", "")
        config["agents"][name]["command"] = installed or (bundled if Path(bundled).is_file() else command)
    write_atomic(ROOT / "agents.yaml", yaml.safe_dump(validate(config), allow_unicode=True, sort_keys=False))


def main():
    options = arguments()
    if options.prepared:
        install(options)
        return
    if options.check:
        prerequisites(options)
        print(f"Python {platform.python_version()} available. Prerequisite check complete; database connectivity is checked during installation.")
        return
    with install_lock():
        if not prerequisites(options):
            return
        pending = STATE / "venv-pending"
        if not PYTHON.exists() or pending.exists():
            print("Creating .venv…", flush=True)
            pending.touch(mode=0o600)
            try:
                venv.EnvBuilder(with_pip=True, symlinks=True).create(ROOT / ".venv")
            except (OSError, subprocess.CalledProcessError):
                raise InstallError("Could not create .venv. Install your Python version's venv/pip package, then retry.") from None
            pending.unlink()
        if not succeeds([str(PYTHON), "-c", "import sys, pip; sys.exit(sys.version_info < (3, 11) or sys.prefix == sys.base_prefix)"]):
            raise InstallError("The existing .venv needs Python 3.11+ and pip. Move it aside and rerun with PGA_PYTHON set.")
        print("Installing PGA and Python dependencies…", flush=True)
        run([PYTHON, "-m", "pip", "install", "--disable-pip-version-check", "-e", ROOT])
        run([PYTHON, Path(__file__), *sys.argv[1:], "--prepared"])


if __name__ == "__main__":
    try:
        main()
    except InstallError as exc:
        print(f"PGA install: {exc}", file=sys.stderr)
        sys.exit(1)
    except (OSError, subprocess.CalledProcessError) as exc:
        print(f"PGA install: operation failed ({type(exc).__name__}). Fix the error above and rerun bash install.sh.", file=sys.stderr)
        sys.exit(1)
