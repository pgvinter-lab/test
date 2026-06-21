#!/usr/bin/env bash
# dispatch_to_codex.sh - Code -> Codex task dispatch (the LOCAL path).
#
# The orchestrator ("The Bridge") runs locally, so unlike the cloud topology in
# PROTOCOL.md it can drive Codex directly. Runs `codex exec` non-interactively with
# the prompt piped on stdin (the `-` sentinel) to avoid the interactive hang. The
# permission level is chosen PER RUN and confirmed with the human before anything
# executes - there is no silent full-access default. Captures the transcript to
# .shared/review/ and appends ONE normalized event to the merged stream.
#
# De-dupe with the watcher: watch_codex.py also watches .shared/review/*, so after
# emitting we PRE-SEED .shared/events/.codex_cursor with this file's signature.
#
# Usage:
#   dispatch_to_codex.sh --task <id> --sandbox <level> [--prompt "<text>"] [options]
#   echo "<prompt>" | dispatch_to_codex.sh --task <id> --sandbox read-only
#
# Options:
#   --task <id>        required; task id used in the event + filename
#   --sandbox <level>  REQUIRED (no default): read-only | workspace-write | danger-full-access
#   --prompt <text>    the instruction for Codex; if omitted, read from stdin
#   --next "<hint>"    next_hint to put on the emitted event
#   --yes              skip the interactive sandbox-confirm (for headless/automation)
#   --dry-run          print the exact codex command + planned event; exec NOTHING
#   -h | --help        this help
#
# Env:
#   CODEX_EXEC_FLAGS  advanced override of the codex flags (bypasses --sandbox mapping)
#   CODEX_MODEL       optional; adds  -m <model>
#   CODEX_TIMEOUT     seconds before the codex run is killed (default 900)
#   BRIDGE_AUTOCONFIRM=1  skip the sandbox-confirm (same as --yes)
#   SHARED_DIR        default: <repo>/.shared
#
# Gate: the sandbox level is confirmed with the human at the start of every run
# (unless --yes/BRIDGE_AUTOCONFIRM). Verify flag spellings with `codex exec --help`
# if your codex version differs.
set -u

usage() { sed -n '2,40p' "$0" | sed 's/^# \{0,1\}//'; }

DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
REPO="$(dirname "$DIR")"
SHARED_DIR="${SHARED_DIR:-$REPO/.shared}"
EVENTS_DIR="$SHARED_DIR/events"
REVIEW_DIR="$SHARED_DIR/review"
LOG="$SHARED_DIR/log.jsonl"
CODEX_TIMEOUT="${CODEX_TIMEOUT:-900}"

TASK=""; PROMPT=""; NEXT_HINT="Code: review Codex output and decide the next task per the playbook."
DRYRUN="0"; YES="0"; SANDBOX=""
while [ $# -gt 0 ]; do
  case "$1" in
    --task)    TASK="${2:-}"; shift 2;;
    --sandbox) SANDBOX="${2:-}"; shift 2;;
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

# Resolve the codex permission flags from --sandbox (no silent default), unless an
# advanced CODEX_EXEC_FLAGS override is supplied.
if [ -n "${CODEX_EXEC_FLAGS:-}" ]; then
  EXEC_FLAGS="$CODEX_EXEC_FLAGS"; SBX_DESC="custom(CODEX_EXEC_FLAGS)"
else
  case "$SANDBOX" in
    read-only)          EXEC_FLAGS="--sandbox read-only --ask-for-approval never";       SBX_DESC="read-only";;
    workspace-write)    EXEC_FLAGS="--sandbox workspace-write --ask-for-approval never"; SBX_DESC="workspace-write";;
    danger-full-access) EXEC_FLAGS="--dangerously-bypass-approvals-and-sandbox";         SBX_DESC="danger-full-access";;
    "") echo "ERROR: --sandbox {read-only|workspace-write|danger-full-access} is required (no default)." >&2; exit 2;;
    *)  echo "ERROR: invalid --sandbox '$SANDBOX' (expected read-only|workspace-write|danger-full-access)." >&2; exit 2;;
  esac
fi

mkdir -p "$REVIEW_DIR" "$EVENTS_DIR"
TS="$(date -u +%Y%m%dT%H%M%SZ)"
REL="review/codex_${TASK}_${TS}.md"
REVIEW_ABS="$SHARED_DIR/$REL"

MODEL_ARGS=()
[ -n "${CODEX_MODEL:-}" ] && MODEL_ARGS=(-m "$CODEX_MODEL")

if [ "$DRYRUN" = "1" ]; then
  cat <<EOF
[DRY-RUN] dispatch_to_codex  task=$TASK  sandbox=$SBX_DESC  timeout=${CODEX_TIMEOUT}s
  would run (prompt piped on stdin, '-' sentinel avoids the hang):
      printf '%s' "<prompt>" | timeout -k 30 ${CODEX_TIMEOUT} codex exec $EXEC_FLAGS ${MODEL_ARGS[*]:-} \\
          -C "$REPO" -o "<final-msg-tmp>" -   > "$REVIEW_ABS" 2>&1
  prompt (first line): $(printf '%s' "$PROMPT" | head -n1)
  would capture transcript -> $REVIEW_ABS
  would emit ONE event -> $EVENTS_DIR/orchestrator_inbox.jsonl :
      {"ts":"<now>","source":"codex","task":"$TASK","kind":"result|needs_input|error",
       "summary":"<codex final message, trimmed>","refs":["$REL"],"next_hint":"$NEXT_HINT"}
  would pre-seed -> $EVENTS_DIR/.codex_cursor (so watch_codex won't double-emit $REL)
  No codex run, no file written, no event emitted.
EOF
  exit 0
fi

command -v codex >/dev/null 2>&1 || { echo "ERROR: codex not found on PATH" >&2; exit 127; }

# Per-run permission gate (operator decision): confirm the sandbox level before the
# run, in code - not just in the playbook. --yes / BRIDGE_AUTOCONFIRM bypass it.
if [ "$YES" != "1" ] && [ "${BRIDGE_AUTOCONFIRM:-0}" != "1" ]; then
  if [ -e /dev/tty ]; then
    printf 'Run Codex [sandbox=%s] on %s, task %s? [y/N] ' "$SBX_DESC" "$REPO" "$TASK" >/dev/tty
    read -r reply </dev/tty || reply=""
    case "$reply" in y|Y|yes|YES) ;; *) echo "aborted (no confirmation; use --yes to skip)." >&2; exit 4;; esac
  else
    echo "ERROR: Codex run needs confirmation of sandbox=$SBX_DESC; pass --yes or set BRIDGE_AUTOCONFIRM=1." >&2
    exit 4
  fi
fi

# --- real run (F7: timeout so a hung Codex never wedges the loop silently) ---
LASTMSG="$(mktemp)"
if command -v timeout >/dev/null 2>&1; then
  printf '%s' "$PROMPT" | timeout -k 30 "$CODEX_TIMEOUT" codex exec $EXEC_FLAGS "${MODEL_ARGS[@]}" -C "$REPO" -o "$LASTMSG" - > "$REVIEW_ABS" 2>&1
  CRC=$?
else
  echo "WARN: 'timeout' not found; running codex without a timeout guard." >&2
  printf '%s' "$PROMPT" | codex exec $EXEC_FLAGS "${MODEL_ARGS[@]}" -C "$REPO" -o "$LASTMSG" - > "$REVIEW_ABS" 2>&1
  CRC=$?
fi

FINAL="$(head -c 480 "$LASTMSG" 2>/dev/null | tr '\n' ' ' | sed 's/  */ /g')"
# B3 + F7: exit-0-with-empty-output is not a result; a timeout (124) is an error.
if [ "$CRC" -eq 124 ]; then
  KIND="error"; FINAL="codex timed out after ${CODEX_TIMEOUT}s (partial transcript in $REL)"
elif [ "$CRC" -ne 0 ]; then
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
    # F16: match watch_codex's sub-second signature so the pre-seed truly suppresses the dup.
    files[os.environ["REF"]] = "%d:%d" % (st.st_mtime_ns, st.st_size)
import tempfile as _tf  # F8: unique tmp so a concurrent watcher write can't clobber it
_fd, tmp = _tf.mkstemp(dir=os.path.dirname(cursor), prefix=os.path.basename(cursor) + ".", suffix=".tmp")
with os.fdopen(_fd, "w", encoding="utf-8") as fh:
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

echo "codex exit=$CRC  kind=$KIND  sandbox=$SBX_DESC  transcript=$REL"
[ "$CRC" -ne 0 ] && exit "$CRC"
exit 0
