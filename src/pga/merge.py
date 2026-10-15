"""Merge one local account into another: `python -m pga.merge OLD_UID NEW_UID`.

PGA keeps an account per browser profile, so one person on one Mac can end up with several (the Claude app's pane,
Chrome / the Dock app, a fresh tab…) and their work split between them. Merging moves everything the old account
owns — aims and their boards, perpetual tasks, the evolution line, projects, talks, notifications, the ledger — to
the new one, and leaves the old account as a pointer (`preferences.merged_into`), so a browser still using it
switches over by itself the next time it opens PGA.

Where both accounts hold the same unique thing, the new account's copy wins, except the self-improvement state
(R0): the owner's is the one with the history, so it is kept. Imported conversations from local agents are not
moved: both accounts read the same stores, so the new one has them already (and re-reads them every 30 minutes).
"""

from __future__ import annotations

import sys
import uuid

from sqlalchemy import delete, select, text, update

from pga.db.models import Base, LinkedAgent, Project, R0State, User

# tables where the same row may exist on both sides: (columns that, with user_id, make it unique)
_UNIQUE = {"layers": ("ref", "level"), "bridges": ("a_ref", "b_ref"), "glossary_entries": ("source_lang", "target_lang", "source_term")}


def merge_accounts(session, old_id: uuid.UUID, new_id: uuid.UUID) -> dict:
    if old_id == new_id:
        raise ValueError("the two accounts are the same")
    old, new = session.get(User, old_id), session.get(User, new_id)
    if old is None or new is None:
        raise ValueError("unknown account")
    report: dict[str, int] = {}

    # the same local agents, linked from both: the old links (and their copies of the imports) go
    gone = session.execute(delete(LinkedAgent).where(LinkedAgent.user_id == old_id)).rowcount
    report["linked_agents (duplicate imports dropped)"] = gone or 0
    # self-improvement: one state per account; keep the one with the history
    o_r0, n_r0 = session.get(R0State, old_id), session.get(R0State, new_id)
    if o_r0 is not None and n_r0 is not None:
        keep_old = len(o_r0.ledger or []) >= len(n_r0.ledger or [])
        session.delete(n_r0 if keep_old else o_r0)
        session.flush()
    # projects: the same folder on both sides → keep the new account's
    for p in session.scalars(select(Project).where(Project.user_id == old_id)):
        if session.scalar(select(Project.id).where(Project.user_id == new_id, Project.path == p.path)):
            session.delete(p)
    session.flush()
    for table, cols in _UNIQUE.items():
        same = " and ".join(f"o.{c} = n.{c}" for c in cols)
        session.execute(text(f'delete from "{table}" o using "{table}" n where o.user_id = :old and n.user_id = :new and {same}'),
                        {"old": old_id, "new": new_id})
    # everything else that belongs to an account
    for t in Base.metadata.sorted_tables:
        if "user_id" not in t.c or t.name == "users":
            continue
        n = session.execute(update(t).where(t.c.user_id == old_id).values(user_id=new_id)).rowcount
        if n:
            report[t.name] = n
    # the old account points at the new one; ownership (self-improvement runs there) moves too
    prefs_old, prefs_new = dict(old.preferences or {}), dict(new.preferences or {})
    if prefs_old.pop("owner", None):
        prefs_new["owner"] = True
    prefs_old["merged_into"] = str(new_id)
    old.preferences, new.preferences = prefs_old, prefs_new
    session.flush()
    return report


def main() -> None:
    from pga.db.session import get_sessionmaker
    if len(sys.argv) != 3:
        sys.exit("usage: python -m pga.merge OLD_UID NEW_UID")
    s = get_sessionmaker()()
    try:
        rep = merge_accounts(s, uuid.UUID(sys.argv[1]), uuid.UUID(sys.argv[2]))
        s.commit()
    except Exception:
        s.rollback()
        raise
    for k, v in rep.items():
        print(f"{v:6d}  {k}")


if __name__ == "__main__":
    main()
