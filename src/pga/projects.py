"""Projects: folders you let agents work in, separate from which agent you use.

A project is a name and a folder in your home directory. In any conversation you can pick a project, with any agent,
and switch agents whenever you like — the work stays in the project. By default an agent may only read a project;
`full_access` (you turn it on, and confirm it in the conversation) lets it work like in your terminal: run commands,
edit files, use your MCP tools (Claude Code / CodeBuddy accept edits and may run Bash; Codex runs in a workspace-write
sandbox with its shell; Hermes works in the folder with its approvals still refused). Who did what in a project is
read back from the ledger.
"""

from __future__ import annotations

import uuid
from pathlib import Path
from typing import TYPE_CHECKING

from sqlalchemy import select

from pga.db.models import AgentRun, Project, User
from pga.db.types import utcnow

if TYPE_CHECKING:
    from sqlalchemy.orm import Session

SKIP_DIRS = {".git", "node_modules", ".venv", "venv", "__pycache__", ".next", "dist", "build", ".cache", "target"}


class ProjectError(ValueError):
    pass


def check_path(raw: str, home: Path | None = None) -> Path:
    """A real folder inside your home directory — not home itself, not a hidden folder like ~/.ssh."""
    home = (home or Path.home()).resolve()
    p = Path(str(raw or "").strip()).expanduser()
    if not str(raw or "").strip():
        raise ProjectError("需要一个文件夹路径")
    try:
        p = p.resolve(strict=True)
    except (OSError, RuntimeError) as exc:
        raise ProjectError(f"找不到这个文件夹：{raw}") from exc
    if not p.is_dir():
        raise ProjectError("这不是一个文件夹")
    if p == home or home not in p.parents:
        raise ProjectError("只能选你主目录（~）下面的某个文件夹，不能是主目录本身")
    first = p.relative_to(home).parts[0]
    if first.startswith(".") or first == "Library":
        raise ProjectError("不能把隐藏文件夹或 ~/Library 当成项目")
    return p


class Projects:
    """A project is a folder on this Mac, so every (non-demo) account on it sees the same projects — the browser you
    happen to open PGA in decides which account you are, not which folders exist. A demo account sees only its own."""

    def __init__(self, session: "Session"):
        self.session = session

    def owners(self, user_id: uuid.UUID) -> list[uuid.UUID]:
        me = self.session.get(User, user_id)
        if me is None or (me.preferences or {}).get("demo"):
            return [user_id]
        return [u.id for u in self.session.scalars(select(User)) if not (u.preferences or {}).get("demo")]

    def list(self, user_id: uuid.UUID) -> list[Project]:
        out, seen = [], set()
        for p in self.session.scalars(select(Project).where(Project.user_id.in_(self.owners(user_id)))
                                      .order_by(Project.last_used_at.desc().nulls_last(), Project.created_at.desc())):
            if p.path not in seen:                             # the same folder added from two accounts: shown once
                seen.add(p.path)
                out.append(p)
        return out

    def get(self, user_id: uuid.UUID, pid: uuid.UUID) -> Project:
        p = self.session.get(Project, pid)
        if p is None or p.user_id not in self.owners(user_id):
            raise ProjectError("没有这个项目")
        return p

    def create(self, user_id: uuid.UUID, *, path: str, name: str = "", notes: str = "", full_access: bool = False) -> Project:
        folder = check_path(path)
        if self.session.scalar(select(Project).where(Project.user_id.in_(self.owners(user_id)), Project.path == str(folder))):
            raise ProjectError("这个文件夹已经是一个项目了")
        p = Project(user_id=user_id, name=(name or folder.name).strip()[:120], path=str(folder), notes=notes[:2000],
                    full_access=bool(full_access), created_at=utcnow())
        self.session.add(p)
        self.session.flush()
        return p

    def update(self, p: Project, *, name: str | None = None, notes: str | None = None, full_access: bool | None = None) -> Project:
        if name is not None and name.strip():
            p.name = name.strip()[:120]
        if notes is not None:
            p.notes = notes[:2000]
        if full_access is not None:
            p.full_access = bool(full_access)
        self.session.flush()
        return p

    def delete(self, p: Project) -> None:
        self.session.delete(p)            # the folder itself is never touched
        self.session.flush()

    def touch(self, p: Project) -> None:
        p.last_used_at = utcnow()

    def activity(self, p: Project, limit: int = 40) -> list[dict]:
        """Which agents worked in this project, newest first (from the ledger)."""
        rows = self.session.scalars(select(AgentRun).where(AgentRun.user_id.in_(self.owners(p.user_id)), AgentRun.parent_id.is_(None),
                                                           AgentRun.workflow == "ask")
                                    .order_by(AgentRun.started_at.desc()).limit(800))
        out = []
        for r in rows:
            d = r.data or {}
            if (d.get("project") or {}).get("id") != str(p.id):
                continue
            out.append({"at": r.started_at.isoformat(), "agent": d.get("agent"), "model": d.get("model"), "ok": r.status == "SUCCEEDED",
                        "full": bool((d.get("project") or {}).get("full")), "asked": " ".join((r.prompt or "").split())[:160],
                        "changed": (d.get("files") or [])[:12], "conversation": d.get("conversation")})
            if len(out) >= limit:
                break
        return out


def changed_files(folder: str, since: float, cap: int = 20000) -> list[str]:
    """Files in the project modified since `since` (skipping .git, node_modules, virtualenvs…), at most 20."""
    out, seen = [], 0
    root = Path(folder)
    stack = [root]
    while stack and seen < cap:
        d = stack.pop()
        try:
            entries = list(d.iterdir())
        except OSError:
            continue
        for e in entries:
            seen += 1
            if e.is_dir():
                if e.name not in SKIP_DIRS and not e.is_symlink():
                    stack.append(e)
            else:
                try:
                    if e.stat().st_mtime >= since:
                        out.append(str(e.relative_to(root)))
                except OSError:
                    pass
            if len(out) >= 20 or seen >= cap:
                break
    return sorted(out)[:20]
