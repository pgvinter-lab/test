#!/usr/bin/env python3
"""watch_cowork.py - Cowork sensor for the Code<->Cowork<->Codex orchestrator.

Polls ``git fetch`` on the shared branch. When the remote tip advances, reads the
committed ``.shared/handoff/inbox.code.jsonl`` at that commit, picks out entries with
``actor == "cowork"`` that have not been emitted yet, and appends one normalized event
per entry to ``.shared/events/orchestrator_inbox.jsonl``.

Why read from the git ref (not the working tree): per PROTOCOL.md, Cowork's results
reach this machine only as pushed commits, so the commit is the doorbell.

Idempotent: a cursor (``.shared/events/.cowork_cursor``) records the last-seen remote
SHA *plus* a sha1 of every entry already emitted, so a moved tip whose inbox merely
grew never re-emits old lines. Resilient: every git call is wrapped and transient
failures are logged and skipped (the loop continues).

Standard library only. Python 3.8+. See agents/event_schema.md for the event shape.
"""

import hashlib
import json
import os
import subprocess
import sys
import tempfile
import time
from datetime import datetime, timezone
from pathlib import Path

SCRIPT = Path(__file__).resolve()
REPO_ROOT = Path(os.environ.get("REPO_ROOT") or SCRIPT.parent.parent)
SHARED_DIR = Path(os.environ.get("SHARED_DIR") or (REPO_ROOT / ".shared"))
EVENTS_DIR = SHARED_DIR / "events"
ORCH_INBOX = EVENTS_DIR / "orchestrator_inbox.jsonl"
LOG_PATH = EVENTS_DIR / "watch_cowork.log"
CURSOR_PATH = EVENTS_DIR / ".cowork_cursor"
LOCK_PATH = EVENTS_DIR / ".inbox.lock"

REMOTE = os.environ.get("SHARED_REMOTE", "origin")
BRANCH_ENV = os.environ.get("SHARED_BRANCH")
REF_ENV = os.environ.get("COWORK_WATCH_REF")  # default <remote>/<branch>; "WORKTREE" = local file
INBOX_REL = os.environ.get("COWORK_INBOX_REL", ".shared/handoff/inbox.code.jsonl")
INTERVAL = int(os.environ.get("POLL_INTERVAL", "30"))

_TRUTHY = ("1", "true", "yes", "on")
NO_FETCH = os.environ.get("COWORK_NO_FETCH", "").lower() in _TRUTHY
VERBOSE = ("--verbose" in sys.argv) or ("--once" in sys.argv) or bool(os.environ.get("WATCH_VERBOSE"))

STATUS_TO_KIND = {
    "result": "result", "done": "result", "complete": "result", "completed": "result",
    "output": "result", "ok": "result", "finalized": "result",
    "progress": "progress", "working": "progress", "in_progress": "progress",
    "wip": "progress", "update": "progress", "started": "progress",
    "needs_input": "needs_input", "needs-input": "needs_input", "blocked": "needs_input",
    "question": "needs_input", "waiting": "needs_input", "needs_human_review": "needs_input",
    "error": "error", "failed": "error", "failure": "error", "fail": "error",
}


def now_iso():
    return datetime.now(timezone.utc).strftime("%Y-%m-%dT%H:%M:%S.%fZ")


def log(msg):
    EVENTS_DIR.mkdir(parents=True, exist_ok=True)
    line = "%s %s" % (now_iso(), msg)
    try:
        with open(LOG_PATH, "a", encoding="utf-8") as fh:
            fh.write(line + "\n")
    except OSError:
        pass
    if VERBOSE:
        print(line)


def run_git(args):
    """Run a git command rooted at the repo. Never raises; returns (rc, out, err)."""
    try:
        proc = subprocess.run(
            ["git"] + args, cwd=str(REPO_ROOT),
            stdout=subprocess.PIPE, stderr=subprocess.PIPE,
            universal_newlines=True, timeout=60,
        )
        return proc.returncode, proc.stdout, proc.stderr
    except Exception as exc:  # noqa: BLE001 - sensor must never die on a git hiccup
        return 1, "", str(exc)


def read_cursor():
    """Return (obj, state) where state is 'ok' | 'missing' | 'corrupt'."""
    if not CURSOR_PATH.exists():
        return {}, "missing"
    try:
        return json.loads(CURSOR_PATH.read_text(encoding="utf-8")), "ok"
    except Exception:  # noqa: BLE001
        return {}, "corrupt"


def write_cursor(obj):
    # F8 fix: unique tmp per writer so concurrent writers can't clobber a shared tmp.
    EVENTS_DIR.mkdir(parents=True, exist_ok=True)
    fd, tmp = tempfile.mkstemp(dir=str(EVENTS_DIR), prefix=CURSOR_PATH.name + ".", suffix=".tmp")
    try:
        with os.fdopen(fd, "w", encoding="utf-8") as fh:
            fh.write(json.dumps(obj))
        os.replace(tmp, str(CURSOR_PATH))
    except Exception:
        try:
            os.remove(tmp)
        except OSError:
            pass
        raise


def _lock(timeout=10.0):
    start = time.time()
    while True:
        try:
            fd = os.open(str(LOCK_PATH), os.O_CREAT | os.O_EXCL | os.O_RDWR)
            os.close(fd)
            return
        except FileExistsError:
            if time.time() - start > timeout:  # break a stale lock and retry
                try:
                    os.remove(str(LOCK_PATH))
                except OSError:
                    pass
                start = time.time()
            time.sleep(0.05)


def _unlock():
    try:
        os.remove(str(LOCK_PATH))
    except OSError:
        pass


def append_event(event):
    """Append one event line to the merged stream under a cross-process lock."""
    EVENTS_DIR.mkdir(parents=True, exist_ok=True)
    _lock()
    try:
        with open(ORCH_INBOX, "a", encoding="utf-8") as fh:
            fh.write(json.dumps(event, ensure_ascii=False) + "\n")
    finally:
        _unlock()


def _status_kind(status):
    # F4 fix: a non-empty status that maps to nothing must force inspection
    # (needs_input), NOT be silently relabeled "progress" (which the playbook drops).
    if not status:
        return "progress"
    kind = STATUS_TO_KIND.get(status)
    if kind is None:
        log("WARN: unmapped status=%r -> needs_input (review)" % status)
        return "needs_input"
    return kind


def normalize_inbox_entry(entry, source):
    status = str(entry.get("status") or entry.get("kind") or "").strip().lower()
    refs = entry.get("refs") or []
    if isinstance(refs, str):
        refs = [refs]
    return {
        "ts": entry.get("ts") or now_iso(),
        "source": source,
        "task": entry.get("task") or entry.get("taskId") or "unknown",
        "kind": _status_kind(status),
        "summary": entry.get("did") or entry.get("summary") or entry.get("msg") or "",
        "refs": list(refs),
        "next_hint": entry.get("next_recommended") or entry.get("next_hint") or entry.get("next") or "",
    }


def _resolve_ref():
    """Return (ref, branch). ref may be the sentinel 'WORKTREE'."""
    if REF_ENV == "WORKTREE":
        return "WORKTREE", None
    if REF_ENV:
        return REF_ENV, BRANCH_ENV
    branch = BRANCH_ENV
    if not branch:
        rc, out, _ = run_git(["rev-parse", "--abbrev-ref", "HEAD"])
        branch = out.strip() if rc == 0 and out.strip() else "HEAD"
    return "%s/%s" % (REMOTE, branch), branch


def run_once():
    EVENTS_DIR.mkdir(parents=True, exist_ok=True)
    ref, branch = _resolve_ref()
    worktree = ref == "WORKTREE"

    if not worktree and not NO_FETCH:
        rc, _, err = run_git(["fetch", REMOTE, branch])
        if rc != 0:
            log("git fetch failed (transient, continuing): %s" % err.strip()[:200])

    # Determine the head id we are about to process.
    if worktree:
        wt = SHARED_DIR / "handoff" / "inbox.code.jsonl"
        content = wt.read_text(encoding="utf-8") if wt.exists() else ""
        head_id = "wt:" + hashlib.sha1(content.encode("utf-8")).hexdigest() if content else "wt:absent"
    else:
        rc, out, err = run_git(["rev-parse", ref])
        if rc != 0:  # ref not fetched yet / offline => nothing to do this cycle
            log("rev-parse %s failed (transient, continuing): %s" % (ref, err.strip()[:200]))
            return 0
        head_id = out.strip()
        content = None

    cursor, cstate = read_cursor()
    if cstate == "corrupt":
        log("WARN: .cowork_cursor corrupt; renaming aside (entries may re-emit; orchestrator dedups)")
        try:
            os.replace(str(CURSOR_PATH), str(CURSOR_PATH) + ".corrupt")
        except OSError:
            pass
    if head_id == cursor.get("sha"):
        log("no change (tip=%s)" % head_id[:16])
        return 0

    if not worktree:
        rc, out, err = run_git(["show", "%s:%s" % (ref, INBOX_REL)])
        if rc == 0:
            content = out
        else:  # file not committed at this tip yet — normal early on
            content = ""
            log("inbox absent at %s (%s); 0 new" % (ref, err.strip()[:120]))

    seen = set(cursor.get("seen", []))
    emitted = 0
    for raw in (content or "").splitlines():
        raw = raw.strip()
        if not raw:
            continue
        try:
            entry = json.loads(raw)
        except json.JSONDecodeError:
            log("skip malformed line: %s" % raw[:80])
            continue
        actor = str(entry.get("actor", "")).strip().lower()
        # F1 fix: the Cowork/Claude surface finalizes as "cowork" OR "claude"
        # (PROTOCOL/SKILL and the live log use "claude") - accept both. "codex"
        # is the other watcher's job (skip quietly). Anything else is a real drop:
        # LOG it instead of silently continuing, so losses are visible.
        if actor not in ("cowork", "claude"):
            if actor and actor != "codex":
                log("DROP: unrecognized actor=%r in inbox.code.jsonl; line=%s" % (actor, raw[:80]))
            continue
        digest = hashlib.sha1(raw.encode("utf-8")).hexdigest()
        if digest in seen:
            continue
        event = normalize_inbox_entry(entry, "cowork")
        append_event(event)
        seen.add(digest)
        emitted += 1
        log("emit cowork task=%s kind=%s" % (event["task"], event["kind"]))

    write_cursor({"sha": head_id, "seen": sorted(seen)})
    log("cycle done: emitted=%d tip=%s" % (emitted, head_id[:16]))
    return emitted


def main():
    once = "--once" in sys.argv
    log("watch_cowork start once=%s shared_dir=%s interval=%ss" % (once, SHARED_DIR, INTERVAL))
    while True:
        try:
            run_once()
        except Exception as exc:  # noqa: BLE001 - a daemon must outlive any single bad cycle
            log("run_once error (continuing): %r" % exc)
        if once:
            break
        time.sleep(INTERVAL)


if __name__ == "__main__":
    main()
