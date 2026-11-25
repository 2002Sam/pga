"""Small code-change measurements from tool events, without reading the workspace."""
from __future__ import annotations

import os
import re
import shlex


def _path(value):
    return os.path.normpath(value) if isinstance(value, str) and value and value != '/dev/null' else ''


def diff_stats(text: str) -> dict | None:
    """Count unified/apply_patch hunks, excluding headers and context lines."""
    if not isinstance(text, str):
        return None
    paths, added, removed, recognized, hunk, partial = set(), 0, 0, not text.strip(), False, False
    old_path = ''
    for line in text.splitlines():
        if line.startswith('diff --git '):
            recognized, hunk = True, False
            try:
                parts = shlex.split(line)
                if len(parts) >= 4:
                    paths.add(_path(parts[3][2:] if parts[3].startswith('b/') else parts[3]))
            except ValueError:
                partial = True
        elif match := re.match(r'\*\*\* (Update|Add|Delete) File: (.+)', line):
            recognized, hunk = True, True
            paths.add(_path(match[2]))
            partial |= match[1] == 'Delete'  # apply_patch deletion has no old content
        elif line.startswith(('*** End Patch', '*** Move to:', '*** End of File')):
            hunk = False
        elif line.startswith('@@'):
            recognized, hunk = True, True
        elif not hunk and line.startswith(('--- ', '+++ ')):
            path = line[4:].split('\t', 1)[0].strip('"')
            if path.startswith(('a/', 'b/')):
                path = path[2:]
            if line.startswith('--- '):
                old_path = path
            else:
                paths.add(_path(old_path if path == '/dev/null' else path))
        elif line.startswith(('Binary files ', 'GIT binary patch')):
            partial = True
        elif hunk:
            added += line.startswith('+')
            removed += line.startswith('-')
    if not recognized:
        return None
    return {'paths': sorted(paths - {''}), 'added': added, 'removed': removed, 'partial': partial}


def tool_stats(name: str, args) -> dict | None:
    """Measure supported edit inputs; commands and prose never become code counts."""
    name = re.split(r'__|\.', name)[-1]
    if name in {'apply_patch', 'patch'}:
        patch = args if isinstance(args, str) else args.get('patch') if isinstance(args, dict) else None
        return diff_stats(patch)
    if not isinstance(args, dict):
        return None
    path = _path(args.get('file_path') or args.get('path') or args.get('notebook_path'))
    if not path:
        return None
    count = lambda value: len(value.splitlines()) if isinstance(value, str) else 0
    if name in {'Edit', 'edit_file'} and 'new_string' in args:
        return {'paths': [path], 'added': count(args['new_string']), 'removed': count(args.get('old_string')),
                'partial': bool(args.get('replace_all'))}
    if name == 'MultiEdit' and isinstance(args.get('edits'), list):
        edits = [x for x in args['edits'] if isinstance(x, dict)]
        return {'paths': [path], 'added': sum(count(x.get('new_string')) for x in edits),
                'removed': sum(count(x.get('old_string')) for x in edits), 'partial': any(x.get('replace_all') for x in edits)}
    if name in {'Write', 'write_file', 'NotebookEdit'}:
        content = args.get('new_source') if name == 'NotebookEdit' else args.get('content')
        if isinstance(content, str):
            # The input tells us how many lines were written, not what was overwritten.
            return {'paths': [path], 'added': count(content), 'removed': 0, 'partial': True}
    return None


def file_change_stats(changes) -> dict:
    result = {'paths': [], 'added': 0, 'removed': 0, 'partial': False}
    paths = set()
    for change in changes or []:
        if not isinstance(change, dict):
            continue
        if path := _path(change.get('path')):
            paths.add(path)
        measured = diff_stats(change.get('diff'))
        if measured is None:
            result['partial'] = True
        else:
            result['added'] += measured['added']
            result['removed'] += measured['removed']
            result['partial'] |= measured['partial']
    result['paths'] = sorted(paths)
    return result
