#!/usr/bin/env python3
"""watch_codex.py - Codex sensor for the Code<->Cowork<->Codex orchestrator.

Polls the local working tree by mtime (default every 5s). Codex runs locally and writes
to disk without going through git, so there is nothing to fetch - we watch files directly:

  * ``.shared/review/*``                         - Codex review/analysis artifacts
  * ``.shared/handoff/inbox.code.jsonl`` entries with ``actor == "codex"``

Each new/changed signal becomes one normalized event appended to the *same* merged
stream as the Cowork sensor: ``.shared/events/orchestrator_inbox.jsonl``.

Idempotent: a cursor (``.shared/events/.codex_cursor``) tracks an mtime_ns:size signature
per review file and a sha1 per emitted inbox line, so unchanged files and already-seen
entries never re-emit. On a *cold start* (cursor missing) or a *corrupt* cursor the review
scan is BASELINED (signatures recorded, nothing emitted) so stale fixtures never flood the
orchestrator. Resilient: per-file and per-line errors are logged and skipped; the loop
outlives any single bad cycle.

Standard library only. Python 3.8+. See agents/event_schema.md for the event shape.
"""

import hashlib
import json
import os
import re
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
LOG_PATH = EVENTS_DIR / "watch_codex.log"
CURSOR_PATH = EVENTS_DIR / ".codex_cursor"
LOCK_PATH = EVENTS_DIR / ".inbox.lock"
REVIEW_DIR = SHARED_DIR / "review"
CODEX_INBOX = SHARED_DIR / "handoff" / "inbox.code.jsonl"

INTERVAL = int(os.environ.get("POLL_INTERVAL", "5"))
VERBOSE = ("--verbose" in sys.argv) or ("--once" in sys.argv) or bool(os.environ.get("WATCH_VERBOSE"))

# F20: task ids use hyphens (t-YYYYMMDD-slug); excluding "_" stops the regex from
# swallowing the "_<TS>" suffix in review filenames like codex_<task>_<ts>.md.
TASK_RE = re.compile(r"t-\d{6,8}-[A-Za-z0-9-]+")
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


def iso_from_mtime(mtime):
    return datetime.fromtimestamp(mtime, timezone.utc).strftime("%Y-%m-%dT%H:%M:%S.%fZ")


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


def read_cursor():
    """Return (obj, state) where state is 'ok' | 'missing' | 'corrupt'."""
    if not CURSOR_PATH.exists():
        return {}, "missing"
    try:
        return json.loads(CURSOR_PATH.read_text(encoding="utf-8")), "ok"
    except Exception:  # noqa: BLE001
        return {}, "corrupt"


def write_cursor(obj):
    # F8 fix: unique tmp per writer so a concurrent dispatch+watcher write can't
    # clobber a shared ".codex_cursor.tmp" and corrupt the cursor.
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
            if time.time() - start > timeout:
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
    EVENTS_DIR.mkdir(parents=True, exist_ok=True)
    _lock()
    try:
        with open(ORCH_INBOX, "a", encoding="utf-8") as fh:
            fh.write(json.dumps(event, ensure_ascii=False) + "\n")
    finally:
        _unlock()


def artifact_kind(name):
    low = name.lower()
    if "needs_human_review" in low or "needs_input" in low or "question" in low:
        return "needs_input"
    if "error" in low or "fail" in low:
        return "error"
    if "progress" in low or "wip" in low:
        return "progress"
    return "result"


def normalize_artifact(name, rel, mtime):
    match = TASK_RE.search(name)
    # F10 fix: do not fabricate a task id from the filename stem; use "unknown"
    # (matches the inbox path) so phantom never-converging tasks aren't created.
    task = match.group(0) if match else "unknown"
    return {
        "ts": iso_from_mtime(mtime),
        "source": "codex",
        "task": task,
        "kind": artifact_kind(name),
        "summary": "Codex artifact updated: %s" % rel,
        "refs": [rel],
        "next_hint": "",
    }


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


def run_once():
    EVENTS_DIR.mkdir(parents=True, exist_ok=True)
    cursor, cstate = read_cursor()
    if cstate == "corrupt":
        log("WARN: .codex_cursor corrupt; renaming aside and re-baselining (no replay)")
        try:
            os.replace(str(CURSOR_PATH), str(CURSOR_PATH) + ".corrupt")
        except OSError:
            pass
    # F11/F12: on a cold start (missing) or corruption, BASELINE the review scan -
    # record signatures without emitting, so stale fixtures don't flood the stream.
    baseline = cstate in ("missing", "corrupt")
    files = dict(cursor.get("files", {}))
    entries_seen = set(cursor.get("entries", []))
    emitted = 0
    baselined = 0

    # 1) Codex review artifacts under .shared/review/ (top-level files).
    if REVIEW_DIR.is_dir():
        try:
            scan = sorted(os.scandir(REVIEW_DIR), key=lambda e: e.name)
        except OSError as exc:
            log("scandir review failed (continuing): %r" % exc)
            scan = []
        for ent in scan:
            try:
                if not ent.is_file():
                    continue
            except OSError:
                continue
            name = ent.name
            if name.startswith("_") or name.startswith("."):  # scratch / prompt inputs
                continue
            rel = "review/%s" % name
            try:
                st = ent.stat()
            except OSError:
                continue
            # F16 fix: sub-second precision so a same-second, same-size rewrite is seen.
            sig = "%d:%d" % (st.st_mtime_ns, st.st_size)
            if files.get(rel) == sig:
                continue
            files[rel] = sig
            if baseline:
                baselined += 1
                continue
            event = normalize_artifact(name, rel, st.st_mtime)
            append_event(event)
            emitted += 1
            log("emit codex artifact %s kind=%s" % (rel, event["kind"]))

    # 2) Codex-authored entries in the local inbox.code.jsonl. These are real results,
    #    not fixtures, so they are emitted (sha1-deduped) even on a cold start.
    if CODEX_INBOX.exists():
        try:
            lines = CODEX_INBOX.read_text(encoding="utf-8").splitlines()
        except OSError as exc:
            log("read inbox failed (continuing): %r" % exc)
            lines = []
        for raw in lines:
            raw = raw.strip()
            if not raw:
                continue
            try:
                entry = json.loads(raw)
            except json.JSONDecodeError:
                log("skip malformed line: %s" % raw[:80])
                continue
            actor = str(entry.get("actor", "")).strip().lower()
            # F1 fix: accept "codex"; "cowork"/"claude" are the cowork watcher's
            # job (skip quietly); anything else is a real drop - LOG it.
            if actor != "codex":
                if actor and actor not in ("cowork", "claude"):
                    log("DROP: unrecognized actor=%r in inbox.code.jsonl; line=%s" % (actor, raw[:80]))
                continue
            digest = hashlib.sha1(raw.encode("utf-8")).hexdigest()
            if digest in entries_seen:
                continue
            event = normalize_inbox_entry(entry, "codex")
            append_event(event)
            entries_seen.add(digest)
            emitted += 1
            log("emit codex task=%s kind=%s" % (event["task"], event["kind"]))

    write_cursor({"files": files, "entries": sorted(entries_seen)})
    log("cycle done: emitted=%d baselined=%d files_tracked=%d entries_tracked=%d"
        % (emitted, baselined, len(files), len(entries_seen)))
    return emitted


def main():
    once = "--once" in sys.argv
    log("watch_codex start once=%s shared_dir=%s interval=%ss" % (once, SHARED_DIR, INTERVAL))
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
