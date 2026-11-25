#!/usr/bin/env python3
"""Resolve the merge conflicts that every upstream sync of the duhell fork runs into.

Called by sync-upstream.yml (and the temporary local release script) while
`git merge` of main into duhell has stopped with conflicts. Only data files
that both sides append to are resolved; any other conflicted file exits 1 and
the caller aborts the merge as before.

- apps/*/src/i18n/translations/*.json: three-way merge per key. Upstream order
  and upstream values win; keys only the fork changed keep the fork value;
  keys only the fork added are appended at the end. Upstream keys stay even
  when the fork dropped them: an unused entry is harmless, a missing one is not. Each entry keeps the exact
  text of the file it came from, so the formatter's output stays untouched.
- apps/server/src/provider/agentContextBudget.json: measured byte counts.
  Each value becomes fork + (upstream - base), i.e. both growths add up.
  Only a test reads this file; the next measurement corrects it.

Standard library only. It reads git index stages and writes the resolved
files; it never runs code from the repository.
"""

import fnmatch
import json
import re
import subprocess
import sys

TRANSLATIONS = "apps/*/src/i18n/translations/*.json"
BUDGET = "apps/server/src/provider/agentContextBudget.json"
MISSING = object()


def git(*args: str) -> str:
    return subprocess.run(["git", *args], capture_output=True, text=True, check=True).stdout


def stage(n: int, path: str) -> str | None:
    r = subprocess.run(["git", "show", f":{n}:{path}"], capture_output=True, text=True)
    return r.stdout if r.returncode == 0 else None


def raw_entries(text: str) -> dict[str, str]:
    """Top-level entries of a formatted JSON object with their original text."""
    lines = text.split("\n")
    if lines[0] != "{":
        raise ValueError("not a top-level object")
    out: dict[str, list[str]] = {}
    current = None
    for line in lines[1:]:
        m = re.match(r'^  "((?:[^"\\]|\\.)*)": ', line)
        if m:
            current = json.loads(f'"{m.group(1)}"')
            out[current] = [line]
        elif line == "}":
            break
        elif current is None:
            raise ValueError("unexpected line before the first key")
        else:
            out[current].append(line)
    result = {}
    for key, parts in out.items():
        entry = "\n".join(parts)
        result[key] = entry[:-1] if entry.endswith(",") else entry
    if set(result) != set(json.loads(text)):
        raise ValueError("keys do not match the parsed JSON")
    return result


def merge_translations(base: str, ours: str, theirs: str) -> str:
    b, o, t = json.loads(base), json.loads(ours), json.loads(theirs)
    ro, rt = raw_entries(ours), raw_entries(theirs)
    parts = []
    for key in t:
        fork_changed = key in o and o[key] != b.get(key, MISSING)
        upstream_changed = t[key] != b.get(key, MISSING)
        parts.append(ro[key] if fork_changed and not upstream_changed else rt[key])
    for key in o:
        if key not in t and key not in b:
            parts.append(ro[key])  # fork-only key
    text = "{\n" + ",\n".join(parts) + "\n}\n"
    json.loads(text)
    return text


def merge_budget(base: str, ours: str, theirs: str) -> str:
    b, o, t = json.loads(base), json.loads(ours), json.loads(theirs)
    out = {}
    for key in list(t) + [k for k in o if k not in t]:
        if key in o and key in t and key in b:
            out[key] = o[key] + (t[key] - b[key])
        else:
            out[key] = max(v for v in (o.get(key), t.get(key)) if v is not None)
    return json.dumps(out, indent=2) + "\n"


def main() -> int:
    conflicted = [p for p in git("diff", "--name-only", "--diff-filter=U").splitlines() if p]
    if not conflicted:
        print("no conflicts")
        return 0
    other = [p for p in conflicted if p != BUDGET and not fnmatch.fnmatch(p, TRANSLATIONS)]
    if other:
        print("cannot resolve automatically: " + " ".join(other))
        return 1
    for path in conflicted:
        base, ours, theirs = stage(1, path), stage(2, path), stage(3, path)
        if base is None or ours is None or theirs is None:
            print(f"{path}: added or deleted on one side, not resolved")
            return 1
        try:
            merged = (merge_budget if path == BUDGET else merge_translations)(base, ours, theirs)
        except (ValueError, json.JSONDecodeError) as error:
            print(f"{path}: {error}")
            return 1
        with open(path, "w", encoding="utf-8") as f:
            f.write(merged)
        git("add", "--", path)
        print(f"resolved {path}")
    left = [p for p in git("diff", "--name-only", "--diff-filter=U").splitlines() if p]
    if left:
        print("still conflicted: " + " ".join(left))
        return 1
    return 0


if __name__ == "__main__":
    sys.exit(main())
