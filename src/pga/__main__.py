"""`python -m pga [api|worker|all]` — run the API server, the background worker, or both.

    api     HTTP API + web app (default)
    worker  the perpetual loop: heartbeats, source polls, research, exploration, notifications — and the perpetual
            tasks' own thread (pga/perpetual.py)
    all     both in one process (handy on a laptop)
"""

import logging
import os
import signal
import sys
import threading

import uvicorn


def _raise_nofile_soft_limit(resource_module=None) -> bool:
    """Raise this process's descriptor soft limit, without changing its hard limit."""
    try:
        if resource_module is None:
            import resource as resource_module
        resource_id = resource_module.RLIMIT_NOFILE
        soft, hard = resource_module.getrlimit(resource_id)
        infinity = getattr(resource_module, "RLIM_INFINITY", -1)
        if soft == infinity:
            return False  # already unlimited
        target = 4096 if hard == infinity else min(int(hard), 4096)
        if target <= soft:
            return False
        resource_module.setrlimit(resource_id, (target, hard))
        return True
    except (ImportError, AttributeError, OSError, ValueError, TypeError):
        # Unsupported platforms and restricted launch environments keep their inherited limit.
        return False


def _make_worker():
    import pga.hub.jobs  # noqa: F401  (registers the hub.sync planner and handler)
    import pga.teams  # noqa: F401  (registers the planner for teams that meet on their own)
    from pga.db.session import get_sessionmaker
    from pga.runtime import Runtime
    from pga.workflow.worker import Worker

    return Worker(get_sessionmaker(), lambda s: Runtime(s))


def _perpetual(stop: threading.Event) -> threading.Thread:
    """Perpetual tasks run in their own thread, so a long cycle never holds up the worker's jobs (see pga/perpetual.py)."""
    from pga.db.session import get_sessionmaker
    from pga.perpetual import PerpetualRunner
    from pga.runtime import Runtime

    t = threading.Thread(target=PerpetualRunner(get_sessionmaker(), lambda s: Runtime(s)).run_forever, args=(stop,),
                         daemon=True, name="pga-perpetual")
    t.start()
    return t


def _stop_on_signals(stop: threading.Event) -> None:
    def handle(signum, _frame):
        logging.getLogger("pga").info("signal %s: stopping", signum)
        stop.set()
    for sig in (signal.SIGTERM, signal.SIGINT, signal.SIGHUP):
        signal.signal(sig, handle)


def _links():
    """Keep every agent link checked (heartbeat) and its long-lived processes tidy — see pga/agents/links.py."""
    from pga.agents import links
    from pga.db.session import get_sessionmaker
    from pga.runtime import Runtime

    return links.start_keeper(get_sessionmaker(), lambda s: Runtime(s))


def _api() -> None:
    uvicorn.run("pga.api.app:app", host=os.environ.get("PGA_HOST", "127.0.0.1"),
                port=int(os.environ.get("PGA_PORT", "8000")), reload=bool(os.environ.get("PGA_RELOAD")))


def main() -> None:
    _raise_nofile_soft_limit()   # do this before starting API, worker, keeper, or their child processes
    logging.basicConfig(level=os.environ.get("PGA_LOG_LEVEL", "INFO"),
                        format="%(asctime)s %(levelname)s %(name)s: %(message)s")
    from pga.netenv import adopt_system_proxy
    adopt_system_proxy()                # same network as the terminal, also when started by launchd
    mode = sys.argv[1] if len(sys.argv) > 1 else "api"
    if mode == "worker":
        stop = threading.Event()
        _stop_on_signals(stop)
        _perpetual(stop)
        _make_worker().run_forever(stop)
    elif mode == "all":
        stop = threading.Event()
        # uvicorn re-raises SIGTERM/SIGINT after its own graceful shutdown; with our handler installed first, that
        # re-raise only sets `stop` instead of killing the process before the shutdown snapshot is written
        _stop_on_signals(stop)
        worker = _make_worker()
        t = threading.Thread(target=worker.run_forever, args=(stop,), daemon=True, name="pga-worker")
        t.start()
        _perpetual(stop)
        keeper = _links()
        try:
            _api()                      # returns when uvicorn is stopped (SIGTERM / SIGINT)
        finally:
            stop.set()
            t.join(timeout=20)          # let the job in hand finish if it can…
            worker.shutdown("the server was stopped" + ("" if not t.is_alive() else " during a long job"))   # …then snapshot
            keeper.stop()               # close the app servers and sessions PGA started
    elif mode == "api":
        keeper = _links()
        try:
            _api()
        finally:
            keeper.stop()
    else:
        sys.exit(f"unknown mode {mode!r}; use api, worker or all")


if __name__ == "__main__":
    main()
