#!/usr/bin/env bash
# dispatch_to_codex.sh - Code -> Codex task dispatch (the LOCAL path).
#
# The orchestrator ("The Bridge") runs locally, so unlike the cloud topology in
# PROTOCOL.md it can drive Codex directly. This runs `codex exec` non-interactively
# in danger-full-access / approval-never mode, with the prompt piped on stdin (the
# `-` sentinel) to avoid the interactive hang. It captures the transcript to
# .shared/review/ and appends ONE normalized result event to the merged stream
# .shared/events/orchestrator_inbox.jsonl.
#
# De-dupe with the watcher: watch_codex.py also watches .shared/review/*, so after
# emitting directly we PRE-SEED .shared/events/.codex_cursor with this file's
# signature, so the watcher won't emit a second event for the same artifact. The
# orchestrator's idempotent dedup is the backstop for any race.
#
# Usage:
#   dispatch_to_codex.sh --task <id> --prompt "<text>" [options]
#   echo "<prompt>" | dispatch_to_codex.sh --task <id>
#
# Options:
#   --task <id>      required; task id used in the event + filename
#   --prompt <text>  the instruction for Codex; if omitted, read from stdin
#   --next "<hint>"  next_hint to put on the emitted event
#   --dry-run        print the exact codex command + planned event; exec NOTHING
#   -h | --help      this help
#
# Env:
#   CODEX_EXEC_FLAGS  default: --dangerously-bypass-approvals-and-sandbox
#   CODEX_MODEL       optional; adds  -m <model>
#   SHARED_DIR        default: <repo>/.shared
#
# Gate: full-access Codex can modify files. v1 uses it for verify/mine and captures
# output to review/. A human in The Bridge approves the prompt; the orchestrator
# does not auto-apply any Codex-proposed irreversible change.
set -u

usage() { sed -n '2,40p' "$0" | sed 's/^# \{0,1\}//'; }

DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
REPO="$(dirname "$DIR")"
SHARED_DIR="${SHARED_DIR:-$REPO/.shared}"
EVENTS_DIR="$SHARED_DIR/events"
REVIEW_DIR="$SHARED_DIR/review"
LOG="$SHARED_DIR/log.jsonl"
CODEX_EXEC_FLAGS="${CODEX_EXEC_FLAGS:---dangerously-bypass-approvals-and-sandbox}"

TASK=""; PROMPT=""; NEXT_HINT="Code: review Codex output and decide the next task per the playbook."; DRYRUN="0"; YES="0"
while [ $# -gt 0 ]; do
  case "$1" in
    --task)    TASK="${2:-}"; shift 2;;
    --prompt)  PROMPT="${2:-}"; shift 2;;
    --next)    NEXT_HINT="${2:-}"; shift 2;;
    --dry-run) DRYRUN="1"; shift;;
    --yes)     YES="1"; shift;;
    -h|--help) usage; exit 0;;
    *) echo "unknown arg: $1" >&2; usage; exit 2;;
  esac
done

if [ -z "$PROMPT" ] && [ ! -t 0 ]; then PROMPT="$(cat)"; fi
[ -z "$TASK" ]   && { echo "ERROR: --task is required" >&2; exit 2; }
[ -z "$PROMPT" ] && { echo "ERROR: --prompt (or piped stdin) is required" >&2; exit 2; }

mkdir -p "$REVIEW_DIR" "$EVENTS_DIR"
TS="$(date -u +%Y%m%dT%H%M%SZ)"
REL="review/codex_${TASK}_${TS}.md"
REVIEW_ABS="$SHARED_DIR/$REL"

MODEL_ARGS=()
[ -n "${CODEX_MODEL:-}" ] && MODEL_ARGS=(-m "$CODEX_MODEL")

if [ "$DRYRUN" = "1" ]; then
  cat <<EOF
[DRY-RUN] dispatch_to_codex  task=$TASK
  would run (prompt piped on stdin, '-' sentinel avoids the hang):
      printf '%s' "<prompt>" | codex exec $CODEX_EXEC_FLAGS ${MODEL_ARGS[*]:-} \\
          -C "$REPO" -o "<final-msg-tmp>" -   > "$REVIEW_ABS" 2>&1
  prompt (first line): $(printf '%s' "$PROMPT" | head -n1)
  would capture transcript -> $REVIEW_ABS
  would emit ONE event -> $EVENTS_DIR/orchestrator_inbox.jsonl :
      {"ts":"<now>","source":"codex","task":"$TASK","kind":"result|error",
       "summary":"<codex final message, trimmed>","refs":["$REL"],
       "next_hint":"$NEXT_HINT"}
  would pre-seed -> $EVENTS_DIR/.codex_cursor (so watch_codex won't double-emit $REL)
  No codex run, no file written, no event emitted.
EOF
  exit 0
fi

command -v codex >/dev/null 2>&1 || { echo "ERROR: codex not found on PATH" >&2; exit 127; }

# M5 fix: full-access Codex (no sandbox, no approvals) is an irreversible-capable
# action. Enforce the gate in code, not just in the playbook: require explicit
# confirmation unless --yes or BRIDGE_AUTOCONFIRM=1. Refuse to run unattended.
if [ "$YES" != "1" ] && [ "${BRIDGE_AUTOCONFIRM:-0}" != "1" ]; then
  if [ -e /dev/tty ]; then
    printf 'Run Codex FULL-ACCESS (no sandbox) on %s, task %s? [y/N] ' "$REPO" "$TASK" >/dev/tty
    read -r reply </dev/tty || reply=""
    case "$reply" in y|Y|yes|YES) ;; *) echo "aborted (no confirmation; use --yes to skip)." >&2; exit 4;; esac
  else
    echo "ERROR: full-access Codex needs confirmation; pass --yes or set BRIDGE_AUTOCONFIRM=1." >&2
    exit 4
  fi
fi

# --- real run ---
LASTMSG="$(mktemp)"
printf '%s' "$PROMPT" | codex exec $CODEX_EXEC_FLAGS "${MODEL_ARGS[@]}" -C "$REPO" -o "$LASTMSG" - > "$REVIEW_ABS" 2>&1
CRC=$?
# B3 fix: do NOT equate exit-0 with a substantive result. An empty final message
# on exit 0 must not signal a "result" (the playbook would read it as convergence).
FINAL="$(head -c 480 "$LASTMSG" 2>/dev/null | tr '\n' ' ' | sed 's/  */ /g')"
if [ "$CRC" -ne 0 ]; then
  KIND="error"
elif [ -n "$FINAL" ]; then
  KIND="result"
else
  KIND="needs_input"   # exit 0 but no final message: disposition unclear, not a result
fi

SUMMARY="$FINAL"
[ -z "$SUMMARY" ] && SUMMARY="$(tail -c 480 "$REVIEW_ABS" 2>/dev/null | tr '\n' ' ' | sed 's/  */ /g')"
[ -z "$SUMMARY" ] && SUMMARY="Codex exec exit $CRC, no final message for $TASK; see $REL (review before treating as done)."
rm -f "$LASTMSG"

# Emit the event, pre-seed the codex cursor, and log - all JSON via Python (stdlib).
TASK="$TASK" KIND="$KIND" SUMMARY="$SUMMARY" REF="$REL" REVIEW_ABS="$REVIEW_ABS" \
NEXT_HINT="$NEXT_HINT" EVENTS_DIR="$EVENTS_DIR" LOG="$LOG" \
python - <<'PY'
import os, json, time
from datetime import datetime, timezone

def now():
    return datetime.now(timezone.utc).strftime("%Y-%m-%dT%H:%M:%S.%fZ")

events = os.environ["EVENTS_DIR"]; os.makedirs(events, exist_ok=True)
orch = os.path.join(events, "orchestrator_inbox.jsonl")
lock = os.path.join(events, ".inbox.lock")
cursor = os.path.join(events, ".codex_cursor")
ts = now()

event = {
    "ts": ts, "source": "codex", "task": os.environ["TASK"], "kind": os.environ["KIND"],
    "summary": os.environ.get("SUMMARY", "")[:500], "refs": [os.environ["REF"]],
    "next_hint": os.environ.get("NEXT_HINT", ""),
}
line = json.dumps(event, ensure_ascii=False)

def acquire(timeout=10.0):
    start = time.time()
    while True:
        try:
            fd = os.open(lock, os.O_CREAT | os.O_EXCL | os.O_RDWR); os.close(fd); return
        except FileExistsError:
            if time.time() - start > timeout:
                try: os.remove(lock)
                except OSError: pass
                start = time.time()
            time.sleep(0.05)

acquire()
try:
    with open(orch, "a", encoding="utf-8") as fh:
        fh.write(line + "\n")
finally:
    try: os.remove(lock)
    except OSError: pass

# Pre-seed the codex cursor so watch_codex.py treats this review file as already seen.
try:
    cur = json.loads(open(cursor, encoding="utf-8").read())
except Exception:
    cur = {"files": {}, "entries": []}
files = cur.get("files", {}); entries = cur.get("entries", [])
abs_path = os.environ.get("REVIEW_ABS", "")
if abs_path and os.path.exists(abs_path):
    st = os.stat(abs_path)
    files[os.environ["REF"]] = "%d:%d" % (int(st.st_mtime), st.st_size)
tmp = cursor + ".tmp"
with open(tmp, "w", encoding="utf-8") as fh:
    json.dump({"files": files, "entries": entries}, fh)
os.replace(tmp, cursor)

log = os.environ.get("LOG", "")
if log:
    try:
        with open(log, "a", encoding="utf-8") as fh:
            fh.write(json.dumps({
                "ts": ts, "type": "output", "task": event["task"], "agent": "codex",
                "from": "codex", "to": "code", "msg": event["summary"][:280],
                "refs": event["refs"], "confidence": 0.7,
            }, ensure_ascii=False) + "\n")
    except OSError:
        pass

print("emitted: " + line)
PY

echo "codex exit=$CRC  kind=$KIND  transcript=$REL"
[ "$CRC" -ne 0 ] && exit "$CRC"
exit 0
