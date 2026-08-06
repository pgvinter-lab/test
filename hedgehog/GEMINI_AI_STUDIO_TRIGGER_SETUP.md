# Gemini AI Studio / Antigravity Continuous Trigger Setup

## Goal

Create one hourly managed-agent trigger that reuses the same Antigravity environment so the Hedgehog engineering program runs continuously without relying on a browser tab or Google Drive access.

## AI Studio UI path

1. Open Google AI Studio.
2. Open Playground and switch to Agents.
3. Select the Antigravity managed agent.
4. Add the GitHub repository `pgvinter-lab/test` as an environment source.
5. Check out branch `hedgehog/agy-continuous`.
6. Allow only the network domains required for GitHub, package sources, official documentation, and approved research.
7. Start one interaction, then copy the resulting environment ID.
8. Create a scheduled trigger using that existing environment ID.
9. Set schedule to hourly: `0 * * * *`.
10. Set time zone to `America/New_York`.
11. Use the complete content of `hedgehog/AGY_TRIGGER_PROMPT.md` as the trigger prompt.
12. Set maximum consecutive failures to 3.
13. Set the largest practical execution timeout.
14. Confirm that the next scheduled execution is shown as active.

## Persistent-state requirement

The trigger must reuse one existing environment ID. Do not use a fresh `remote` environment on every execution. Reusing the environment preserves source trees, caches, experiments, logs, and unfinished work across runs.

## API configuration template

The Gemini Triggers API is Beta. Required values:

```json
{
  "display_name": "Hedgehog Continuous Engineer",
  "schedule": "0 * * * *",
  "time_zone": "America/New_York",
  "max_consecutive_failures": 3,
  "execution_timeout_seconds": 3600,
  "environment_id": "REPLACE_WITH_EXISTING_ENVIRONMENT_ID",
  "interaction": {
    "agent": "antigravity-preview-05-2026",
    "input": "REPLACE_WITH_CONTENTS_OF_AGY_TRIGGER_PROMPT.md",
    "environment": "REPLACE_WITH_EXISTING_ENVIRONMENT_ID"
  }
}
```

Use the exact current API schema shown by Google AI Studio or the Gemini Triggers API when creating the trigger; preview field names may change.

## Cost containment

- One scheduled run must select only one evidence-producing task.
- Stop after committing verified work and updating status.
- Do not recursively launch unlimited subagents.
- Record model and token use where available.
- Pause automatically after three consecutive failures.
- Review daily for loops, duplicate work, and unsupported claims.

## First-run acceptance test

The first scheduled run passes only if it:

1. Reads the doctrine, runbook, queue, and status.
2. Creates or updates one narrowly scoped engineering artifact.
3. Records evidence.
4. Updates `STATUS.md`.
5. Commits and pushes to `hedgehog/agy-continuous`.
6. Leaves a clear next task.

A prose-only progress report does not pass.
