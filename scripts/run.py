"""Load checkout configuration, wait for the database, then start API + worker."""

import os
from pathlib import Path
import sys

from dotenv import load_dotenv

from install import InstallError, normalized_url, wait_database


def main():
    root = Path(__file__).resolve().parents[1]
    os.chdir(root)
    load_dotenv(root / ".env", override=True)
    url = os.environ.get("PGA_DATABASE_URL", "")
    os.environ["PGA_DATABASE_URL"] = normalized_url(url)
    # Auto-reload creates a separate process and cannot run the combined worker.
    os.environ.pop("PGA_RELOAD", None)
    wait_database(url)
    os.execv(sys.executable, [sys.executable, "-m", "pga", "all"])


if __name__ == "__main__":
    try:
        main()
    except InstallError as exc:
        sys.exit(f"PGA startup: {exc}")
