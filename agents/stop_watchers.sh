#!/usr/bin/env bash
# Stop bash-launched watchers (sh:<pid> lines) from watchers.pid. Idempotent.
# F14: refuses PowerShell-launched (ps:) pids - they are a different PID namespace;
# stop those with stop_watchers.ps1. Any skipped ps: entries are kept in the pid file
# so they are not orphaned.
set -u

DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
REPO="$(dirname "$DIR")"
SHARED_DIR="${SHARED_DIR:-$REPO/.shared}"
EVENTS="$SHARED_DIR/events"
PIDFILE="$EVENTS/watchers.pid"

[ -f "$PIDFILE" ] || { echo "No pid file at $PIDFILE - nothing to stop."; exit 0; }

mine=(); skipped=()
while IFS= read -r line; do
  line="$(printf '%s' "$line" | tr -d '[:space:]')"; [ -z "$line" ] && continue
  case "$line" in
    sh:*) mine+=("${line#sh:}") ;;
    ps:*) skipped+=("$line") ;;
    *)    mine+=("$line") ;;        # legacy bare pid -> treat as bash-launched
  esac
done < "$PIDFILE"

if [ "${#mine[@]}" -gt 0 ]; then
  for pid in "${mine[@]}"; do
    if kill "$pid" 2>/dev/null; then echo "Sent TERM to $pid"; else echo "Process $pid not running"; fi
  done
  sleep 1
  for pid in "${mine[@]}"; do
    if kill -0 "$pid" 2>/dev/null; then kill -9 "$pid" 2>/dev/null && echo "Force-killed $pid"; fi
  done
fi

if [ "${#skipped[@]}" -gt 0 ]; then
  printf '%s\n' "${skipped[@]}" > "$PIDFILE"
  echo "Kept ${#skipped[@]} PowerShell-launched pid(s) in $PIDFILE; stop those with stop_watchers.ps1." >&2
else
  rm -f "$PIDFILE"
  echo "Stopped. Removed $PIDFILE"
fi
