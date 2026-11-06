#!/usr/bin/env bash
# Install from a source checkout. Compatible with the Bash 3.2 shipped by macOS.
set -euo pipefail

PGA_REPO_DIR="$(cd -- "$(dirname -- "${BASH_SOURCE[0]}")" && pwd)"

if [[ -n "${PGA_PYTHON:-}" ]]; then
    candidates=("$PGA_PYTHON")
else
    candidates=("$PGA_REPO_DIR/.venv/bin/python" python3 python3.14 python3.13 python3.12 python3.11)
fi

for candidate in "${candidates[@]}"; do
    if command -v "$candidate" >/dev/null 2>&1 &&
        "$candidate" -c 'import sys; sys.exit(sys.version_info < (3, 11))' 2>/dev/null; then
        exec "$candidate" "$PGA_REPO_DIR/scripts/install.py" "$@"
    fi
done

echo 'PGA needs Python 3.11+ with venv and pip. Install it, then run bash install.sh again.' >&2
echo 'You can select an interpreter with PGA_PYTHON=/path/to/python3 bash install.sh.' >&2
exit 1
