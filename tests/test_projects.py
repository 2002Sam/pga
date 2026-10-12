"""Projects: a folder any agent can work in, chosen per conversation; read-only unless you open it up."""

from __future__ import annotations

import sys
from pathlib import Path

import pytest

from pga.agents.adapters import ClaudeLocal, CodebuddyLocal, CodexLocal
from pga.agents.base import FULL, READ_ONLY, AgentTask
from pga.agents.pool import AgentPool
from pga.agents.routing import AgentRouter
from pga.projects import ProjectError, Projects, changed_files, check_path

WORKER = r'''
import os, sys, pathlib
sys.stdin.read()
pathlib.Path("NOTES.md").write_text("changed by " + sys.argv[1])
print(sys.argv[1] + " worked in " + os.getcwd())
'''


def test_only_real_folders_under_home_can_be_projects(tmp_path):
    home = tmp_path / "home"
    (home / "code" / "app").mkdir(parents=True)
    (home / ".ssh").mkdir()
    assert check_path(str(home / "code" / "app"), home) == (home / "code" / "app").resolve()
    for bad in (str(home), str(home / ".ssh"), str(home / "nope"), str(tmp_path), ""):
        with pytest.raises(ProjectError):
            check_path(bad, home)


def test_full_mode_is_each_clis_own_way_of_working_like_in_your_terminal():
    full, ro = AgentTask(prompt="x", permissions=FULL), AgentTask(prompt="x", permissions=READ_ONLY)
    c = ClaudeLocal("claude", {}).command(full, "claude")
    assert "Bash" in c[c.index("--allowedTools") + 1] and "--strict-mcp-config" not in c and "acceptEdits" in c   # your MCP tools too
    r = ClaudeLocal("claude", {}).command(ro, "claude")
    assert "--strict-mcp-config" in r and "Bash" in r[r.index("--disallowedTools") + 1]
    assert "Bash" in CodebuddyLocal("wb", {}).command(full, "codebuddy")[-1] or "Bash" in " ".join(CodebuddyLocal("wb", {}).command(full, "codebuddy"))
    cx = CodexLocal("chatgpt", {"disable": ["memories", "shell_tool"]})
    assert "shell_tool" not in cx.server_command(full=True) and "shell_tool" in cx.server_command()
    cmd = cx.command(AgentTask(prompt="x", permissions=FULL, workspace="/p"), "codex")
    assert cmd[cmd.index("-s") + 1] == "workspace-write" and "shell_tool" not in cmd


def test_any_agent_works_in_the_project_and_who_did_what_is_kept(rt, user, provider, tmp_path, monkeypatch):
    monkeypatch.setattr(Path, "home", staticmethod(lambda: tmp_path))
    folder = tmp_path / "work" / "site"
    folder.mkdir(parents=True)
    script = tmp_path / "worker.py"
    script.write_text(WORKER)
    proc = lambda name: {"adapter": "process", "command": [sys.executable, str(script), name], "capabilities": ["code"]}  # noqa: E731
    cfg = {"agents": {"alpha": proc("alpha"), "beta": proc("beta"),
                      "own": {"adapter": "llm", "tier": 1, "capabilities": ["code"]}},
           "workflows": {"general": {"pattern": "single", "agents": ["alpha"]}},
           "routing": {"enabled": True, "mode": "performance", "categories": {"code": {"label": "代码", "prefer": ["own", "alpha", "beta"]}}},
           "run": {"retries": 0, "workspace_root": str(tmp_path / "ws")}}
    ps = Projects(rt.session)
    p = ps.create(user.id, path=str(folder), full_access=True)
    r = AgentRouter(rt, AgentPool(rt, cfg))
    a = r.ask(user, "改一下 NOTES", agent="alpha", project=p)
    assert a["ok"] and a["text"] == f"alpha worked in {folder.resolve()}" and "NOTES.md" in a["files"]
    b = r.ask(user, "接着改", agent="beta", project=p)                     # another agent, the same project
    assert (folder / "NOTES.md").read_text() == "changed by beta" and b["agent"] == "beta"
    auto = r.ask(user, "修一下这个 bug", category="code", project=p)       # PGA's own model cannot open files: skipped
    assert auto["agent"] == "alpha"
    acts = ps.activity(p)
    assert [x["agent"] for x in acts] == ["alpha", "beta", "alpha"] and all(x["full"] for x in acts)
