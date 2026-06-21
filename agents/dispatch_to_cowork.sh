#!/usr/bin/env bash
# dispatch_to_cowork.sh - Code -> Cowork task dispatch (the git path).
#
# Appends one task entry to .shared/handoff/inbox.cowork.jsonl, records a handoff
# in .shared/log.jsonl, commits (trailers Agent: code / Task: <id>), and pushes so
# Cowork picks it up on its next sync. Cowork's result returns via inbox.code.jsonl
# and is surfaced to the orchestrator by watch_cowork.py.
#
# JSON is built/appended by an embedded Python (stdlib) so quoting/newlines in the
# instruction can never corrupt the line. Git work stays in bash.
#
# Usage:
#   dispatch_to_cowork.sh --task <id> --instruction "<text>" [options]
#   echo "<instruction>" | dispatch_to_cowork.sh --task <id>
#
# Options:
#   --task <id>           required; task id (e.g. t-20260621-motion10)
#   --instruction <text>  the task spec for Cowork; if omitted, read from stdin
#   --kind <k>            assign|revise|question|verify  (default: assign)
#   --refs a,b,c         comma-separated repo-relative paths Cowork should look at
#   --done "<criteria>"  acceptance / done-when criteria
#   --round <n>          bounded-loop round number (default: 1)
#   --no-push            commit locally but do not push
#   --dry-run            print exactly what would happen; write/commit/push NOTHING
#   -h | --help          this help
#
# Irreversible-action gate: a normal commit+push of a NEW task entry is the
# sanctioned dispatch mechanism. This script never force-pushes, resets, or
# rewrites history. Use --dry-run to preview.
set -u

usage() { sed -n '2,40p' "$0" | sed 's/^# \{0,1\}//'; }

DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
REPO="$(dirname "$DIR")"
SHARED_DIR="${SHARED_DIR:-$REPO/.shared}"

TASK=""; KIND="assign"; INSTRUCTION=""; REFS=""; DONE=""; ROUND="1"; DRYRUN="0"; PUSH="1"
while [ $# -gt 0 ]; do
  case "$1" in
    --task)        TASK="${2:-}"; shift 2;;
    --instruction) INSTRUCTION="${2:-}"; shift 2;;
    --kind)        KIND="${2:-}"; shift 2;;
    --refs)        REFS="${2:-}"; shift 2;;
    --done)        DONE="${2:-}"; shift 2;;
    --round)       ROUND="${2:-}"; shift 2;;
    --no-push)     PUSH="0"; shift;;
    --dry-run)     DRYRUN="1"; shift;;
    -h|--help)     usage; exit 0;;
    *) echo "unknown arg: $1" >&2; usage; exit 2;;
  esac
done

if [ -z "$INSTRUCTION" ] && [ ! -t 0 ]; then INSTRUCTION="$(cat)"; fi
[ -z "$TASK" ]        && { echo "ERROR: --task is required" >&2; exit 2; }
[ -z "$INSTRUCTION" ] && { echo "ERROR: --instruction (or piped stdin) is required" >&2; exit 2; }

INBOX="$SHARED_DIR/handoff/inbox.cowork.jsonl"
LOG="$SHARED_DIR/log.jsonl"
mkdir -p "$SHARED_DIR/handoff"

# Build the entry (and append it unless dry-run); echo the JSON line for visibility.
ENTRY_JSON="$(
  TASK="$TASK" KIND="$KIND" INSTRUCTION="$INSTRUCTION" REFS="$REFS" DONE="$DONE" \
  ROUND="$ROUND" INBOX="$INBOX" LOG="$LOG" DRYRUN="$DRYRUN" \
  python - <<'PY'
import os, json
from datetime import datetime, timezone

def now():
    return datetime.now(timezone.utc).strftime("%Y-%m-%dT%H:%M:%S.%fZ")

refs = [r.strip() for r in os.environ.get("REFS", "").split(",") if r.strip()]
try:
    rnd = int(os.environ.get("ROUND", "1") or 1)
except ValueError:
    rnd = 1

ts = now()
entry = {
    "ts": ts, "actor": "code", "to": "cowork",
    "task": os.environ["TASK"], "kind": os.environ.get("KIND", "assign"),
    "instruction": os.environ["INSTRUCTION"], "refs": refs,
    "done_when": os.environ.get("DONE", ""), "round": rnd,
}
line = json.dumps(entry, ensure_ascii=False)
log_line = json.dumps({
    "ts": ts, "type": "handoff", "task": entry["task"], "from": "code", "to": "cowork",
    "round": rnd, "msg": entry["instruction"][:280], "refs": refs, "confidence": 0.8,
}, ensure_ascii=False)

if os.environ.get("DRYRUN") != "1":
    with open(os.environ["INBOX"], "a", encoding="utf-8") as fh:
        fh.write(line + "\n")
    try:
        with open(os.environ["LOG"], "a", encoding="utf-8") as fh:
            fh.write(log_line + "\n")
    except OSError:
        pass
print(line)
PY
)" || { echo "ERROR: failed to build entry" >&2; exit 1; }

if [ "$DRYRUN" = "1" ]; then
  push_line="             git push origin HEAD"
  [ "$PUSH" = "0" ] && push_line="             (push skipped: --no-push)"
  cat <<EOF
[DRY-RUN] dispatch_to_cowork  task=$TASK kind=$KIND round=$ROUND
  would append -> $INBOX
  entry: $ENTRY_JSON
  would log    -> $LOG  (type=handoff)
  would run:
             git add "$INBOX" "$LOG"
             git commit -F <msg>   # trailers: Agent: code / Task: $TASK
$push_line
  Nothing written, committed, or pushed.
EOF
  exit 0
fi

# --- real dispatch: commit + push ---
[ -z "$(git -C "$REPO" config user.name)"  ] && git -C "$REPO" config user.name  "code"
[ -z "$(git -C "$REPO" config user.email)" ] && git -C "$REPO" config user.email "pgvinter@gmail.com"

git -C "$REPO" add "$INBOX" "$LOG" 2>/dev/null

MSGFILE="$(mktemp)"
printf 'Dispatch %s to cowork: %s\n\n%s\n\nAgent: code\nTask: %s\nCo-Authored-By: Claude Opus 4.8 <noreply@anthropic.com>\n' \
  "$KIND" "$TASK" "$INSTRUCTION" "$TASK" > "$MSGFILE"
git -C "$REPO" commit -q -F "$MSGFILE" || { echo "ERROR: commit failed (nothing to commit?)" >&2; rm -f "$MSGFILE"; exit 1; }
rm -f "$MSGFILE"
echo "committed: $(git -C "$REPO" rev-parse --short HEAD)  ($KIND -> cowork, task=$TASK)"

if [ "$PUSH" = "1" ]; then
  # M2 fix: handle non-fast-forward by rebasing onto the remote and retrying,
  # instead of warning and stranding the task locally.
  BRANCH="$(git -C "$REPO" rev-parse --abbrev-ref HEAD)"
  pushed=0
  for attempt in 1 2 3; do
    if git -C "$REPO" push origin HEAD 2>/dev/null; then pushed=1; break; fi
    echo "push rejected (attempt $attempt) - rebasing onto origin/$BRANCH and retrying..." >&2
    if ! git -C "$REPO" pull --rebase origin "$BRANCH" >/dev/null 2>&1; then
      echo "ERROR: rebase failed (conflict?). Resolve, then: git -C \"$REPO\" push origin HEAD" >&2
      exit 3
    fi
  done
  if [ "$pushed" = "1" ]; then
    echo "pushed (task=$TASK -> cowork)."
    # B1 (half): nothing auto-wakes the cloud Cowork session - make the gap loud.
    {
      echo "============================================================"
      echo "  MANUAL RELAY REQUIRED - nothing auto-wakes Cowork."
      echo "  Tell the Cowork session to pull and read inbox.cowork.jsonl,"
      echo "  or it will never see task $TASK."
      echo "============================================================"
    } >&2
  else
    echo "ERROR: push still failing after retries; commit is local." >&2
    echo "Manual recovery: git -C \"$REPO\" pull --rebase origin $BRANCH && git -C \"$REPO\" push origin HEAD" >&2
    exit 3
  fi
else
  echo "(committed locally; --no-push given. Push when ready.)"
fi
