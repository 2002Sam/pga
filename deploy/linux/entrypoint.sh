#!/usr/bin/env bash
set -euo pipefail

cd /data/PGA/pga

# Wait for PostgreSQL to accept connections
python3 - <<'PY'
import os, time
from sqlalchemy import create_engine, text

url = os.environ.get("PGA_DATABASE_URL", "")
if not url:
    raise SystemExit("PGA_DATABASE_URL is not set")
if url.startswith("postgresql://"):
    url = "postgresql+psycopg://" + url[len("postgresql://"):]

engine = create_engine(url, connect_args={"connect_timeout": 5})
for i in range(60):
    try:
        with engine.connect() as conn:
            conn.execute(text("SELECT 1"))
        break
    except Exception:
        if i == 59:
            raise
        time.sleep(2)
engine.dispose()
PY

# Apply migrations
python3 -m alembic -c /data/PGA/pga/alembic.ini upgrade head

# Seed default agents.yaml if not present yet
if [[ ! -f /data/PGA/pga/agents.yaml ]]; then
    python3 - <<'PY'
import copy, shutil
from pathlib import Path
import yaml
from pga.agents.pool import DEFAULT, validate

cfg = copy.deepcopy(DEFAULT)
for name, cmd in {"codex": "codex", "chatgpt": "codex", "claude": "claude", "workbuddy": "codebuddy", "gemini": "gemini"}.items():
    cfg["agents"][name]["command"] = shutil.which(cmd) or cmd
cfg["run"]["workspace_root"] = "/data/PGA/workspaces"
Path("/data/PGA/pga/agents.yaml").write_text(
    yaml.safe_dump(validate(cfg), allow_unicode=True, sort_keys=False),
    encoding="utf-8",
)
PY
fi

exec python3 -m pga all --host "${PGA_HOST:-0.0.0.0}" --port "${PGA_PORT:-8000}"
