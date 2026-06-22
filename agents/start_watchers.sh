#!/usr/bin/env bash
# Launch both orchestrator watchers as DETACHED background processes that survive
# this shell (nohup + disown). Writes namespace-tagged PIDs to
# .shared/events/watchers.pid and prints a startup banner. Stop with stop_watchers.sh.
#
# Honors $SHARED_DIR (default <repo>/.shared) and passes the watcher env through.
#
# Hardening (Forge review): F13 identity-validated liveness, F14 namespace-tagged
# pid lines ("sh:<pid>"), F15 already-running guard so a double-start can't spawn a
# duplicate pair or orphan the pid file.
set -u

DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
REPO="$(dirname "$DIR")"
SHARED_DIR="${SHARED_DIR:-$REPO/.shared}"
EVENTS="$SHARED_DIR/events"
PIDFILE="$EVENTS/watchers.pid"
mkdir -p "$EVENTS"

# F13: a PID is only "our live watcher" if it is alive AND its command line proves it.
# Degrades safely: if identity can't be determined (e.g. MSYS ps), falls back to bare
# liveness so behavior is never worse than the old `kill -0`.
pid_is_live_watcher() {  # $1 = bare pid
  local pid="$1" args=""
  [ -n "$pid" ] || return 1
  kill -0 "$pid" 2>/dev/null || return 1
  if [ -r "/proc/$pid/cmdline" ]; then
    args="$(tr '\0' ' ' < "/proc/$pid/cmdline" 2>/dev/null)"
  else
    args="$(ps -p "$pid" -o args= 2>/dev/null || ps -p "$pid" 2>/dev/null || true)"
  fi
  if [ -n "$args" ]; then
    case "$args" in *watch_cowork.py*|*watch_codex.py*) return 0 ;; *) return 1 ;; esac
  fi
  return 0   # identity unknown -> assume live (no worse than kill -0)
}

# F15: refuse to start if a bash-launched watcher is already alive.
if [ -f "$PIDFILE" ]; then
  while IFS= read -r line; do
    line="$(printf '%s' "$line" | tr -d '[:space:]')"; [ -z "$line" ] && continue
    case "$line" in
      sh:*) pid="${line#sh:}" ;;
      ps:*) continue ;;                 # PowerShell-launched; not ours to judge here
      *)    pid="$line" ;;              # legacy bare pid -> treat as sh
    esac
    if pid_is_live_watcher "$pid"; then
      echo "watchers already running (sh:$pid); refusing duplicate start." >&2
      echo "stop them first: bash $DIR/stop_watchers.sh" >&2
      exit 3
    fi
  done < "$PIDFILE"
fi

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

# F14: tag each line with the runtime so stop_watchers.{sh,ps1} can refuse a
# wrong-namespace pid (MSYS pids and Windows pids are different number spaces).
printf 'sh:%s\nsh:%s\n' "$COWORK_PID" "$CODEX_PID" > "$PIDFILE"

cat <<BANNER
============================================================
  Orchestrator watchers started (detached)
------------------------------------------------------------
  watch_cowork.py   pid sh:${COWORK_PID}   git-fetch poll
  watch_codex.py    pid sh:${CODEX_PID}   mtime poll
  shared dir     -> ${SHARED_DIR}
  event stream   -> ${EVENTS}/orchestrator_inbox.jsonl
  logs (cycles)  -> ${EVENTS}/watch_cowork.log ${EVENTS}/watch_codex.log
  crashes/stderr -> ${EVENTS}/watch_cowork.out ${EVENTS}/watch_codex.out
  pid file       -> ${EVENTS}/watchers.pid
  stop with      -> bash ${DIR}/stop_watchers.sh
============================================================
BANNER
