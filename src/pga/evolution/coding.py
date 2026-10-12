"""Isolated implementation and objective verification (spec §12–§14).

An accepted proposal is implemented by a coding agent (the Claude Code CLI) inside a git worktree that holds a
snapshot of the current working copy — never in the live tree. The agent gets the proposal, the files it may
touch, the acceptance criteria and the protected paths, and only file tools (no shell). Verification is ours:
the full test suite runs on the untouched snapshot and on the candidate, and the patch is checked against the
protected paths and a size limit. A candidate only reaches the live tree when the user approves it; rollback
reverses the stored patch. Every version stays inspectable (lineage, not replacement).
"""

from __future__ import annotations

import json
import os
import re
import shutil
import subprocess
import sys
import time
from collections.abc import Callable
from dataclasses import dataclass, field
from pathlib import Path

REPO = Path(__file__).resolve().parents[3]          # …/pga
SKIP = {".git", ".venv", ".evolution", "__pycache__", ".pytest_cache", "node_modules", ".mypy_cache", ".ruff_cache"}
GIT_ID = ["-c", "user.name=PGA evolution", "-c", "user.email=pga-evolution@localhost"]


class CodingError(RuntimeError):
    pass


BRIEF_SYSTEM = ("You are implementing one reviewed improvement inside an isolated copy of the PGA codebase. Stay strictly "
                "within the brief. Do not redefine the objective. Do not touch protected paths.")


@dataclass
class SuiteResult:
    passed: int = 0
    failed: int = 0
    errors: int = 0
    skipped: int = 0
    seconds: float = 0.0
    ok: bool = False
    tail: str = ""

    def as_dict(self) -> dict:
        return self.__dict__.copy()


@dataclass
class Candidate:
    worktree: str
    branch: str
    patch: str = ""
    files: list[str] = field(default_factory=list)
    added: int = 0
    removed: int = 0
    agent_summary: str = ""


def _git(cwd: Path, *args: str, check: bool = True, input: str | None = None) -> str:
    p = subprocess.run(["git", *GIT_ID, *args], cwd=cwd, capture_output=True, text=True, input=input)
    if check and p.returncode != 0:
        raise CodingError(f"git {' '.join(args[:3])} failed: {(p.stderr or p.stdout)[:400]}")
    return p.stdout


def _copy_tree(src: Path, dst: Path) -> None:
    """Mirror the working copy (tracked and untracked files) into the worktree, minus caches, secrets and venvs."""
    for root, dirs, files in os.walk(src):
        dirs[:] = [d for d in dirs if d not in SKIP and not d.endswith(".egg-info")]
        rel = Path(root).relative_to(src)
        (dst / rel).mkdir(parents=True, exist_ok=True)
        for f in files:
            if f == ".env" or f.endswith((".pyc", ".zip")):
                continue
            shutil.copy2(Path(root) / f, dst / rel / f)


def parse_pytest(out: str) -> SuiteResult:
    r = SuiteResult(tail=out[-1500:])
    for n, word in re.findall(r"(\d+) (passed|failed|error|errors|skipped)", out):
        n = int(n)
        if word == "passed": r.passed = n
        elif word == "failed": r.failed = n
        elif word.startswith("error"): r.errors = n
        elif word == "skipped": r.skipped = n
    return r


class CodingAgent:
    def __init__(self, repo: Path = REPO, root: Path | None = None, python: str | None = None,
                 claude: str | None = None, run_cli: Callable[..., subprocess.CompletedProcess] | None = None,
                 run_tests: Callable[[Path], SuiteResult] | None = None):
        self.repo = repo
        self.root = root or repo.parent / "evolution"
        self.python = python or (str(repo / ".venv/bin/python") if (repo / ".venv/bin/python").exists() else sys.executable)
        self.claude = claude or shutil.which("claude") or "claude"
        self._run_cli = run_cli or subprocess.run
        self._run_tests = run_tests
        self.injected = run_cli is not None          # a test double: never hand the work to the agent pool

    # -------------------------------------------------------------- worktree

    def prepare(self, label: str, stack: list[tuple[str, str]] | None = None) -> Candidate:
        """A worktree with the running working copy — plus, on the evolution line, the verified candidates you have
        not promoted yet (`stack`: [(label, patch)…], oldest first), so the next change builds on them."""
        if not (self.repo / ".git").exists():
            raise CodingError(f"{self.repo} is not a git repository")
        self.root.mkdir(parents=True, exist_ok=True)
        wt, branch = self.root / label, f"evolution/{label}"
        if wt.exists():
            _git(self.repo, "worktree", "remove", "--force", str(wt), check=False)
            shutil.rmtree(wt, ignore_errors=True)
        _git(self.repo, "branch", "-D", branch, check=False)
        _git(self.repo, "worktree", "add", "-b", branch, str(wt), "HEAD")
        _copy_tree(self.repo, wt)                                  # the snapshot is what is running now
        _git(wt, "add", "-A")
        _git(wt, "commit", "-q", "--allow-empty", "-m", f"evolution {label}: snapshot of the working copy")
        for below, patch in stack or []:
            if not patch.strip():
                continue
            try:
                _git(wt, "apply", "--whitespace=nowarn", "-", input=patch)
            except CodingError as exc:
                raise CodingError(f"the line no longer applies on the working copy at {below}: {exc}") from exc
            _git(wt, "add", "-A")
            _git(wt, "commit", "-q", "--allow-empty", "-m", f"evolution line: {below}")
        _git(wt, "tag", "-f", f"evo-base-{label}")
        return Candidate(worktree=str(wt), branch=branch)

    # -------------------------------------------------------------- the coding agent

    def implement(self, cand: Candidate, brief: str, *, timeout_s: float, max_turns: int) -> Candidate:
        cmd = [self.claude, "-p", "--output-format", "json", "--permission-mode", "acceptEdits",
               "--allowedTools", "Read,Edit,Write,Glob,Grep", "--disallowedTools", "Bash,WebFetch,WebSearch",
               "--max-turns", str(max_turns), "--no-session-persistence", "--strict-mcp-config",
               "--append-system-prompt", "You are implementing one reviewed improvement inside an isolated copy of the "
               "PGA codebase. Stay strictly within the brief. Do not redefine the objective. Do not touch protected paths."]
        env = {k: v for k, v in os.environ.items() if k not in {"ANTHROPIC_API_KEY", "ANTHROPIC_AUTH_TOKEN"}}
        try:
            p = self._run_cli(cmd, input=brief, capture_output=True, text=True, timeout=timeout_s, env=env, cwd=cand.worktree)
        except FileNotFoundError as exc:
            raise CodingError("the `claude` CLI is not installed; install Claude Code and log in once") from exc
        except subprocess.TimeoutExpired as exc:
            raise CodingError(f"coding agent timed out after {timeout_s:.0f}s") from exc
        try:
            data = json.loads(p.stdout or "{}")
            cand.agent_summary = str(data.get("result") or "")[:2000]
        except json.JSONDecodeError:
            cand.agent_summary = (p.stdout or p.stderr or "")[-1500:]
        return self.collect(cand)

    def collect(self, cand: Candidate) -> Candidate:
        wt = Path(cand.worktree)
        _git(wt, "add", "-A")
        label = Path(cand.worktree).name
        cand.patch = _git(wt, "diff", "--cached", f"evo-base-{label}")
        stat = _git(wt, "diff", "--cached", "--numstat", f"evo-base-{label}")
        cand.files, cand.added, cand.removed = [], 0, 0
        for line in stat.splitlines():
            a, r, f = (line.split("\t") + ["", "", ""])[:3]
            cand.files.append(f)
            cand.added += int(a) if a.isdigit() else 0
            cand.removed += int(r) if r.isdigit() else 0
        if cand.patch:
            _git(wt, "commit", "-q", "-m", f"evolution {label}: candidate")
        return cand

    # -------------------------------------------------------------- verification

    def tests(self, where: Path, timeout_s: float = 1200) -> SuiteResult:
        if self._run_tests:
            return self._run_tests(where)
        env = {**os.environ, "PYTHONPATH": str(where / "src")}
        t0 = time.monotonic()
        try:
            p = subprocess.run([self.python, "-m", "pytest", "-q", "-p", "no:cacheprovider", "-o", "addopts="],
                               cwd=where, capture_output=True, text=True, timeout=timeout_s, env=env)
            out = (p.stdout or "") + (p.stderr or "")
        except subprocess.TimeoutExpired:
            return SuiteResult(seconds=timeout_s, ok=False, tail="test suite timed out")
        r = parse_pytest(out)
        r.seconds = round(time.monotonic() - t0, 1)
        r.ok = p.returncode == 0 and r.failed == 0 and r.errors == 0
        return r

    def verify(self, cand: Candidate, baseline: SuiteResult, *, protected: list[str], max_lines: int) -> dict:
        checks, failures = [], []
        touched = [f for f in cand.files if any(f == p or f.startswith(p) for p in protected)]
        checks.append({"check": "protected paths untouched", "ok": not touched, "detail": ", ".join(touched) or "—"})
        size = cand.added + cand.removed
        checks.append({"check": f"patch ≤ {max_lines} lines", "ok": size <= max_lines and size > 0, "detail": f"+{cand.added} −{cand.removed}"})
        result = self.tests(Path(cand.worktree)) if not touched and 0 < size <= max_lines else SuiteResult(tail="skipped: patch rejected before tests")
        checks.append({"check": "full test suite passes", "ok": result.ok, "detail": f"{result.passed} passed, {result.failed} failed, {result.errors} errors"})
        checks.append({"check": "no tests lost", "ok": result.passed >= baseline.passed, "detail": f"{baseline.passed} → {result.passed}"})
        failures = [c["check"] for c in checks if not c["ok"]]
        return {"ok": not failures, "failures": failures, "checks": checks,
                "table": [{"metric": "tests passed", "current": baseline.passed, "candidate": result.passed},
                          {"metric": "tests failed", "current": baseline.failed + baseline.errors, "candidate": result.failed + result.errors},
                          {"metric": "suite seconds", "current": baseline.seconds, "candidate": result.seconds},
                          {"metric": "files changed", "current": 0, "candidate": len(cand.files)},
                          {"metric": "lines changed", "current": 0, "candidate": cand.added + cand.removed}],
                "candidate_tests": result.as_dict()}

    # -------------------------------------------------------------- promotion and rollback (live tree)

    def apply(self, patch: str, reverse: bool = False) -> None:
        if not patch.strip():
            raise CodingError("empty patch")
        args = ["apply", "--whitespace=nowarn"] + (["-R"] if reverse else [])
        _git(self.repo, *args, "--check", "-", input=patch)
        _git(self.repo, *args, "-", input=patch)

    def discard(self, worktree: str | None) -> None:
        if worktree and Path(worktree).exists():
            _git(self.repo, "worktree", "remove", "--force", worktree, check=False)
