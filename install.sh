#!/usr/bin/env bash
# One-shot installer for the work-with-codex-to skill.
# Run this ONCE on the machine/surface where you want the skill available
# (e.g. in Cowork on your laptop). It copies the skill into your personal
# skills dir so it is invocable as /work-with-codex-to across all projects,
# then runs the preflight so you immediately see whether this surface can
# actually reach Codex.
#
# Usage:  bash install.sh
set -euo pipefail

SRC_DIR="$(cd "$(dirname "$0")" && pwd)/.claude/skills/work-with-codex-to"
DEST_DIR="${HOME}/.claude/skills/work-with-codex-to"

echo "Installing skill:"
echo "  from: ${SRC_DIR}"
echo "  to  : ${DEST_DIR}"

if [ ! -f "${SRC_DIR}/SKILL.md" ]; then
  echo "ERROR: ${SRC_DIR}/SKILL.md not found. Run this from the repo root." >&2
  exit 1
fi

mkdir -p "${DEST_DIR}"
cp -R "${SRC_DIR}/." "${DEST_DIR}/"
chmod +x "${DEST_DIR}/scripts/preflight.sh" 2>/dev/null || true

echo "Installed. Invoke it with:  /work-with-codex-to <goal>"
echo "(In the desktop app: click the + next to the prompt -> Slash commands -> work-with-codex-to)"
echo
echo "Running preflight so you can see what this surface can reach:"
echo
bash "${DEST_DIR}/scripts/preflight.sh"
