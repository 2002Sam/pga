"""`python -m pga` — run the API server (honours PGA_* environment variables)."""

import os

import uvicorn


def main() -> None:
    uvicorn.run("pga.api.app:app", host=os.environ.get("PGA_HOST", "127.0.0.1"),
                port=int(os.environ.get("PGA_PORT", "8000")), reload=bool(os.environ.get("PGA_RELOAD")))


if __name__ == "__main__":
    main()
