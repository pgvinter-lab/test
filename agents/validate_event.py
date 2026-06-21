#!/usr/bin/env python3
"""validate_event.py - enforce the orchestrator event contract (fixes review B3).

The playbook says "PARSE + VALIDATE exactly 7 keys" but nothing enforced it, so a
malformed event could silently become a no-op (missing `status`/`kind` -> defaults
to progress -> "log only") or a false `result`. This validator makes the contract
real: run it over the stream (or a single line) before the orchestrator acts on it.

Usage:
  python agents/validate_event.py [path]          # default: .shared/events/orchestrator_inbox.jsonl
  python agents/validate_event.py --line '<json>' # validate one event
Exit code 0 = all valid; 1 = one or more violations (printed to stderr); 2 = usage.
"""
import json
import os
import sys

KEYS = {"ts", "source", "task", "kind", "summary", "refs", "next_hint"}
SOURCES = {"cowork", "codex"}
KINDS = {"result", "progress", "needs_input", "error"}


def check(obj):
    """Return a list of human-readable violation strings (empty == valid)."""
    errs = []
    if not isinstance(obj, dict):
        return ["not a JSON object"]
    got = set(obj.keys())
    missing, extra = KEYS - got, got - KEYS
    if missing:
        errs.append("missing keys: " + ", ".join(sorted(missing)))
    if extra:
        errs.append("unexpected keys: " + ", ".join(sorted(extra)))
    if obj.get("source") not in SOURCES:
        errs.append("source=%r not in %s" % (obj.get("source"), sorted(SOURCES)))
    if obj.get("kind") not in KINDS:
        errs.append("kind=%r not in %s" % (obj.get("kind"), sorted(KINDS)))
    if not isinstance(obj.get("refs"), list):
        errs.append("refs must be a list")
    for s in ("ts", "task", "summary"):
        if not isinstance(obj.get(s), str) or not obj.get(s):
            errs.append("%s must be a non-empty string" % s)
    return errs


def main(argv):
    if len(argv) >= 2 and argv[1] == "--line":
        if len(argv) < 3:
            print("usage: validate_event.py --line '<json>'", file=sys.stderr)
            return 2
        try:
            obj = json.loads(argv[2])
        except json.JSONDecodeError as e:
            print("INVALID: not JSON: %s" % e, file=sys.stderr)
            return 1
        errs = check(obj)
        if errs:
            print("INVALID: " + "; ".join(errs), file=sys.stderr)
            return 1
        print("valid")
        return 0

    path = argv[1] if len(argv) >= 2 else os.path.join(
        os.path.dirname(os.path.dirname(os.path.abspath(__file__))),
        ".shared", "events", "orchestrator_inbox.jsonl")
    if not os.path.exists(path):
        print("no stream at %s (0 events)" % path)
        return 0

    bad = 0
    total = 0
    with open(path, encoding="utf-8") as fh:
        for n, raw in enumerate(fh, 1):
            raw = raw.strip()
            if not raw:
                continue
            total += 1
            try:
                obj = json.loads(raw)
            except json.JSONDecodeError as e:
                bad += 1
                print("line %d INVALID: not JSON: %s" % (n, e), file=sys.stderr)
                continue
            errs = check(obj)
            if errs:
                bad += 1
                print("line %d INVALID: %s" % (n, "; ".join(errs)), file=sys.stderr)
    print("%d/%d events valid" % (total - bad, total))
    return 1 if bad else 0


if __name__ == "__main__":
    sys.exit(main(sys.argv))
