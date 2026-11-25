#!/usr/bin/env bash
set -euo pipefail

DIR="$(cd -- "$(dirname -- "${BASH_SOURCE[0]}")" && pwd)"
REPO_DIR="$(cd -- "$DIR/.." && pwd)"
PY="$REPO_DIR/.venv/bin/python"
if [[ ! -x "$PY" ]]; then
    PY="$(command -v python3)"
fi

exec "$PY" "$DIR/pga-desktop.py" --install-desktop
