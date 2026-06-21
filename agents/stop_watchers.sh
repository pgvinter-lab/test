#!/usr/bin/env bash
# Stop the watchers launched by start_watchers.sh, by PID. Idempotent: missing
# processes or a missing pid file are not errors.
set -u

DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
REPO="$(dirname "$DIR")"
SHARED_DIR="${SHARED_DIR:-$REPO/.shared}"
EVENTS="$SHARED_DIR/events"
PIDFILE="$EVENTS/watchers.pid"

if [ ! -f "$PIDFILE" ]; then
  echo "No pid file at $PIDFILE - nothing to stop."
  exit 0
fi

# First pass: polite TERM.
while read -r pid; do
  [ -z "$pid" ] && continue
  if kill "$pid" 2>/dev/null; then
    echo "Sent TERM to $pid"
  else
    echo "Process $pid not running"
  fi
done < "$PIDFILE"

sleep 1

# Second pass: force any survivors.
while read -r pid; do
  [ -z "$pid" ] && continue
  if kill -0 "$pid" 2>/dev/null; then
    kill -9 "$pid" 2>/dev/null && echo "Force-killed $pid"
  fi
done < "$PIDFILE"

rm -f "$PIDFILE"
echo "Stopped. Removed $PIDFILE"
