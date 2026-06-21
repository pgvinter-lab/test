#!/usr/bin/env bash
# Launch both orchestrator watchers as DETACHED background processes that survive
# this shell (nohup + disown). Writes their PIDs to .shared/events/watchers.pid and
# prints a startup banner. Stop them with stop_watchers.sh.
#
# Honors $SHARED_DIR (default <repo>/.shared) and passes the watcher env through,
# so the watchers can be aimed at a test workspace without editing anything.
set -u

DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
REPO="$(dirname "$DIR")"
SHARED_DIR="${SHARED_DIR:-$REPO/.shared}"
EVENTS="$SHARED_DIR/events"
mkdir -p "$EVENTS"

# Resolve a python interpreter (Git Bash / Windows friendly).
if command -v python3 >/dev/null 2>&1; then PY="$(command -v python3)"; PYA=""
elif command -v python  >/dev/null 2>&1; then PY="$(command -v python)";  PYA=""
elif command -v py      >/dev/null 2>&1; then PY="$(command -v py)";      PYA="-3"
else echo "ERROR: no python interpreter (python3/python/py) found on PATH" >&2; exit 1
fi

export SHARED_DIR

# shellcheck disable=SC2086  # $PYA is intentionally word-split (empty or "-3")
nohup "$PY" $PYA "$DIR/watch_cowork.py" >>"$EVENTS/watch_cowork.out" 2>&1 &
COWORK_PID=$!
# shellcheck disable=SC2086
nohup "$PY" $PYA "$DIR/watch_codex.py"  >>"$EVENTS/watch_codex.out"  2>&1 &
CODEX_PID=$!
disown "$COWORK_PID" 2>/dev/null || true
disown "$CODEX_PID"  2>/dev/null || true

printf '%s\n%s\n' "$COWORK_PID" "$CODEX_PID" > "$EVENTS/watchers.pid"

cat <<BANNER
============================================================
  Orchestrator watchers started (detached)
------------------------------------------------------------
  watch_cowork.py   pid ${COWORK_PID}   git-fetch poll
  watch_codex.py    pid ${CODEX_PID}   mtime poll
  shared dir     -> ${SHARED_DIR}
  event stream   -> ${EVENTS}/orchestrator_inbox.jsonl
  logs           -> ${EVENTS}/watch_cowork.log
                    ${EVENTS}/watch_codex.log
  pid file       -> ${EVENTS}/watchers.pid
  stop with      -> bash ${DIR}/stop_watchers.sh
============================================================
BANNER
