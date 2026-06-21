# AGENTS.md

This is a shared workspace for the human, Codex, and Claude Code.

**Read `PROTOCOL.md` first** — it is the canonical entry/exit protocol for every
session. Current state and the event log live in `.shared/`.

Codex: on entry, read `PROTOCOL.md` and `.shared/state.md`. Use the task ID in
all commits and handoffs, and write commit trailers `Agent: codex` /
`Task: <task-id>`.

Codex: on exit from every task, ring the finalization doorbell instead of a
manual commit:

```bash
python .claude/skills/work-with-codex-to/scripts/finalize_task.py \
  --actor codex --task <task-id> --status done \
  --did "<concise result>" --flags-count <n> \
  --next-recommended "<next action for Code>" --ref <changed-or-relevant-path>
```
