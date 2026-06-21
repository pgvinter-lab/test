#!/usr/bin/env bash
# bridge_up.sh - the single command "The Bridge" runs at startup.
#
# 1. Launches the watcher daemons (agents/start_watchers.sh) unless already running.
# 2. Prints a status banner (pids, stream path, event count, playbook + gate reminder).
# 3. Shows the current tail of the merged stream so the session has context.
#
# Default: print banner + catch-up, then EXIT, leaving The Bridge (an agentic Claude
# Code session) to drive the loop by reading new lines per orchestrator_playbook.md.
# Use --follow for a human terminal that wants a live `tail -f`.
set -u

DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
REPO="$(dirname "$DIR")"
SHARED_DIR="${SHARED_DIR:-$REPO/.shared}"
EVENTS="$SHARED_DIR/events"
STREAM="$EVENTS/orchestrator_inbox.jsonl"
PIDFILE="$EVENTS/watchers.pid"

FOLLOW="0"
[ "${1:-}" = "--follow" ] && FOLLOW="1"

mkdir -p "$EVENTS"
export SHARED_DIR

# Idempotent start: only launch watchers if none from the pid file are alive.
already_running() {
  [ -f "$PIDFILE" ] || return 1
  while read -r pid; do
    [ -z "$pid" ] && continue
    kill -0 "$pid" 2>/dev/null && return 0
  done < "$PIDFILE"
  return 1
}

if already_running; then
  echo "watchers already running (pids: $(tr '\n' ' ' < "$PIDFILE")); not relaunching."
else
  bash "$DIR/start_watchers.sh"
fi

[ -f "$STREAM" ] || : > "$STREAM"   # ensure the stream exists so tail works
COUNT="$(grep -c '' "$STREAM" 2>/dev/null || echo 0)"

cat <<BANNER

############################################################
#  THE BRIDGE is up  (Code / orchestrator, agent 3)
#----------------------------------------------------------
#  merged event stream : $STREAM
#  events so far       : $COUNT
#  watchers pid file   : $PIDFILE
#  playbook            : $DIR/orchestrator_playbook.md
#  dispatch (cowork)   : bash $DIR/dispatch_to_cowork.sh --task <id> --instruction "..."
#  dispatch (codex)    : echo "<prompt>" | bash $DIR/dispatch_to_codex.sh --task <id>
#  stop watchers       : bash $DIR/stop_watchers.sh
#----------------------------------------------------------
#  GATE: v1 keeps the human in the loop. PAUSE for explicit
#  ok before any write/send/sign/submit/force-push. Bounded
#  rounds + "no new material issues" convergence stop apply.
############################################################

-- current tail of the stream --
BANNER

tail -n 10 "$STREAM" 2>/dev/null || true
echo "--------------------------------------------------------"

if [ "$FOLLOW" = "1" ]; then
  echo "Following $STREAM (Ctrl-C to stop watching; watchers keep running)..."
  exec tail -n 0 -f "$STREAM"
else
  echo "Ready. Read new lines from the stream and follow the playbook."
  echo "(Run with --follow for a live tail in a human terminal.)"
fi
