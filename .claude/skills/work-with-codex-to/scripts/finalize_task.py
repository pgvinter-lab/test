#!/usr/bin/env python3
"""Finalization doorbell for the shared AI workspace (the canonical producer).

Every Cowork/Codex task ends by calling this. It:
  1. appends a result entry to .shared/handoff/inbox.code.jsonl (what the watchers read),
  2. appends a finalization event to .shared/log.jsonl,
  3. refreshes .shared/state.md,
  4. `git add -A`, commits with trailers `Agent: <actor>` / `Task: <id>`, and pushes
     (rebase-and-retry on a non-fast-forward, so a busy shared branch never strands work).

Identity (canonical): producers are {cowork, codex}; the orchestrator is `code`.
The commit trailer mirrors --actor so `git log --grep "Agent: codex"` works.

Usage:
  finalize_task.py --actor {cowork|codex} --task <id> [--status done] [--did "..."]
                   [--flags-count N] [--next-recommended "..."] [--ref PATH ...] [--no-push]
"""
import argparse
import json
import os
import subprocess
import sys
from datetime import datetime, timezone

def _repo_root():
    """Repo root, not .claude/.

    The script sits at <repo>/.claude/skills/work-with-codex-to/scripts/, so
    walking up four levels lands on .claude and writes the bus to
    .claude/.shared/ — where no watcher looks. Ask git, and fall back to the
    correct five-level walk if this is ever run outside a work tree.
    """
    r = subprocess.run(["git", "-C", os.path.dirname(os.path.abspath(__file__)),
                        "rev-parse", "--show-toplevel"],
                       capture_output=True, text=True)
    if r.returncode == 0 and r.stdout.strip():
        return r.stdout.strip()
    p = os.path.abspath(__file__)
    for _ in range(5):
        p = os.path.dirname(p)
    return p


REPO = _repo_root()
SHARED = os.environ.get("SHARED_DIR", os.path.join(REPO, ".shared"))
INBOX = os.path.join(SHARED, "handoff", "inbox.code.jsonl")
LOG = os.path.join(SHARED, "log.jsonl")
STATE = os.path.join(SHARED, "state.md")


def now_iso():
    return datetime.now(timezone.utc).strftime("%Y-%m-%dT%H:%M:%S.%fZ")


def git(args, check=False):
    r = subprocess.run(["git", "-C", REPO] + args, capture_output=True, text=True)
    if check and r.returncode != 0:
        sys.stderr.write(r.stderr)
    return r.returncode, r.stdout.strip(), r.stderr.strip()


def append_jsonl(path, obj):
    os.makedirs(os.path.dirname(path), exist_ok=True)
    with open(path, "a", encoding="utf-8") as fh:
        fh.write(json.dumps(obj, ensure_ascii=False) + "\n")


def main(argv):
    ap = argparse.ArgumentParser(description="Finalization doorbell")
    # actor is constrained to the canonical producer set (no "claude" — F1/identity decision).
    ap.add_argument("--actor", required=True, choices=["cowork", "codex"])
    ap.add_argument("--task", required=True)
    ap.add_argument("--status", default="done")
    ap.add_argument("--did", default="")
    ap.add_argument("--flags-count", type=int, default=0)
    ap.add_argument("--next-recommended", default="")
    ap.add_argument("--ref", action="append", default=[],
                    help="repo-relative path the result points at; repeatable")
    ap.add_argument("--no-push", action="store_true")
    a = ap.parse_args(argv[1:])

    ts = now_iso()
    refs = list(a.ref)

    # 1) the doorbell entry the watchers consume
    entry = {
        "ts": ts, "actor": a.actor, "task": a.task, "status": a.status,
        "did": a.did, "flags_count": a.flags_count,
        "next_recommended": a.next_recommended, "refs": refs,
    }
    append_jsonl(INBOX, entry)

    # 2) audit log
    append_jsonl(LOG, {
        "ts": ts, "type": "summary", "task": a.task, "agent": a.actor,
        "from": a.actor, "to": "code", "msg": (a.did or a.status)[:280],
        "refs": refs, "confidence": 0.8,
    })

    # 3) state snapshot (rebuildable; just a convenience cache)
    os.makedirs(SHARED, exist_ok=True)
    with open(STATE, "w", encoding="utf-8") as fh:
        fh.write("# Current State\n\n"
                 "holder: code\n"
                 "last_task: %s\n"
                 "last_actor: %s\n"
                 "last_status: %s\n"
                 "updated: %s\n\n"
                 "%s\n" % (a.task, a.actor, a.status, ts,
                          ("next: " + a.next_recommended) if a.next_recommended else ""))

    # 4) commit + push (rebase-retry on non-ff)
    git(["add", "-A"])
    msg = ("Finalize %s (%s): %s\n\nAgent: %s\nTask: %s\n"
           % (a.task, a.actor, (a.did or a.status)[:120], a.actor, a.task))
    rc, _, err = git(["commit", "-q", "-m", msg])
    if rc != 0:
        sys.stderr.write("nothing to commit or commit failed: %s\n" % err)
        # still emit a clear signal; the inbox entry is written regardless
        print("finalize: no commit (clean tree?) task=%s" % a.task)
        return 0

    if a.no_push:
        print("finalize: committed locally (--no-push) task=%s" % a.task)
        return 0

    rc, _, branch = git(["rev-parse", "--abbrev-ref", "HEAD"])
    branch = branch or "HEAD"
    for attempt in range(1, 4):
        rc, _, _ = git(["push", "origin", "HEAD"])
        if rc == 0:
            print("finalize: pushed task=%s actor=%s" % (a.task, a.actor))
            return 0
        sys.stderr.write("push rejected (attempt %d); rebasing onto origin/%s...\n" % (attempt, branch))
        rc, _, err = git(["pull", "--rebase", "origin", branch])
        if rc != 0:
            sys.stderr.write("rebase failed (conflict?): %s\n"
                             "resolve, then: git -C %s push origin HEAD\n" % (err, REPO))
            return 3
    sys.stderr.write("push still failing after retries; commit is local.\n")
    return 3


if __name__ == "__main__":
    sys.exit(main(sys.argv))
