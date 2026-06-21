# CLAUDE.md

This is a shared workspace for the human, Codex, and Claude Code.

**Read `PROTOCOL.md` first** — it is the canonical entry/exit protocol for every
session. Current state and the event log live in `.shared/`.

To run a collaborative Claude↔Codex(↔Gemini) loop on a goal, use the
`work-with-codex-to` skill (or say "work with codex to <goal>").

Cowork/Claude-run tasks must finish with the finalization doorbell (identity
`cowork`):

```bash
python .claude/skills/work-with-codex-to/scripts/finalize_task.py \
  --actor cowork --task <task-id> --status done \
  --did "<concise result>" --flags-count <n> \
  --next-recommended "<next action for Code>" --ref <changed-or-relevant-path>
```
