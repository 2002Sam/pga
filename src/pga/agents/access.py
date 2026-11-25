"""Resolve conversation access before taking an independent branch snapshot."""
from copy import deepcopy

DEFAULT = {"access": "auto", "folder": "", "mcp": False}
OLD_LEVELS = {"write": "auto"}


def access_key(user, key: str) -> str:
    prefs = user.preferences or {}
    for parent, split in (prefs.get("chat_splits") or {}).items():
        if any(lane.get("key") == key for lane in split.get("lanes", [])):
            key = parent
            break
    # Imported chats are displayed/configured as c:<id>, but branched as imp:<id>.
    keys = (prefs.get("agent_access") or {}).get("keys") or {}
    if key.startswith("imp:") and key not in keys:
        key = "c:" + key[4:]
    return key[:120]


def effective_access(user, key: str) -> dict:
    prefs = (user.preferences or {}).get("agent_access") or {}
    got = deepcopy({**DEFAULT, **(prefs.get("default") or {}),
                    **((prefs.get("keys") or {}).get(access_key(user, key)) or {})})
    got["access"] = OLD_LEVELS.get(got["access"], got["access"])
    return got
