#!/usr/bin/env bash
# Preflight / environment report for the work-with-codex-to skill.
# Its whole job is to tell you, unambiguously, WHERE this is running and WHICH
# collaboration backends are actually reachable. Firing it is the experiment
# that settles "is Cowork local or a cloud VM?".
set -u

echo "==================== ENVIRONMENT REPORT ===================="
echo "host : $(hostname 2>/dev/null || echo '?')"
echo "os   : $(uname -srm 2>/dev/null || echo '?')"
echo "user : $(whoami 2>/dev/null || echo '?')"
echo "cwd  : $(pwd)"
echo "home : ${HOME:-?}"
echo "-------------------- backends ------------------------------"
for c in codex gemini claude gh node python3 jq git; do
  loc="$(command -v "$c" 2>/dev/null)"
  printf "%-8s %s\n" "$c" "${loc:-(missing)}"
done

echo "-------------------- locality hint -------------------------"
# Heuristic: a real laptop usually has a recognizable hostname and a populated
# home with personal dirs; a fresh cloud VM typically does not.
if [ -d "$HOME/Desktop" ] || [ -d "$HOME/Documents" ]; then
  echo "looks LOCAL-ish (found personal home dirs)"
else
  echo "looks CLOUD-ish (no personal home dirs found) — verify with the backends above"
fi

echo "-------------------- verdict -------------------------------"
if command -v codex >/dev/null 2>&1; then
  echo "CODEX: reachable -> the Claude<->Codex loop CAN run here."
else
  echo "CODEX: NOT reachable -> the loop cannot call Codex from here."
  echo "       Options: (1) run from a local surface, (2) install codex via a"
  echo "       setup script, or (3) proceed Claude-only (degraded)."
fi
echo "==========================================================="
