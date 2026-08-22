# Hedgehog Scheduled Engineering Rider

This file applies to the `hedgehog/` subtree and supplements the repository-root
workspace protocol.

## Scheduled runner delegation

When Codex is invoked by `hedgehog/scripts/run_agy_loop.ps1`, that invocation is
an explicit human-authorized handoff for the task ID supplied in the prompt.
For that scheduled task, Codex holds the Hedgehog engineering baton only for
the duration of the invocation and only inside `hedgehog/`.

Scheduled runs must:

- Read `HEDGEHOG_ENGINEERING_DOCTRINE.md`, `AGY_CONTINUOUS_RUNBOOK.md`,
  `QUEUE.md`, `STATUS.md`, recent evidence, and the latest daily report.
- Modify only files under `hedgehog/`.
- Produce substantive engineering work plus reproducible evidence. A
  `STATUS.md` or daily-report-only change is not progress.
- Run `python scripts/verify_evidence.py` and the Hedgehog unit tests before
  handing control back to the runner.
- Leave Git commit and push operations to `run_agy_loop.ps1`.
- Do not edit `.shared/`, do not invoke the repository-root finalization
  doorbell, and do not change the root shared-workspace baton.
- Do not send external communications.
- Do not publish secrets, credentials, customer data, private legal records,
  model weights, or private live-production payloads.

The scheduled runner is intentionally isolated from the repository-root
cross-surface orchestration so a Hedgehog hourly cycle cannot overwrite shared
state belonging to unrelated work.