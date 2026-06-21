# AGENTS.md

This is a shared workspace for the human, Codex, and Claude Code.

**Read `PROTOCOL.md` first** — it is the canonical entry/exit protocol for every
session. Current state and the event log live in `.shared/`.

Codex: on entry, read `PROTOCOL.md`, `.shared/state.md`, and
`.shared/handoff/inbox.codex.jsonl`. Use the task ID in all commits and
handoffs, and write commit trailers `Agent: codex` / `Task: <task-id>`.
