# Hedgehog Scheduled Engineering Rider

This file applies to the `hedgehog/` subtree and supplements the repository-root
workspace protocol.

## Scheduled runner delegation

When `hedgehog/scripts/run_agy_loop.ps1` starts a scheduled engineering cycle,
`agy.exe` / Google Antigravity is the execution engine for that cycle. The task
ID in the prompt is an explicit human-authorized handoff to Antigravity, and
Antigravity holds the Hedgehog engineering baton only for the duration of that
invocation and only inside `hedgehog/`.

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
- Do not invoke Codex or another coding agent to perform the scheduled cycle.

## Codex repair role

Codex is an out-of-band repair/debugging tool for the Antigravity system, not
the scheduled heavy-work engine. If Antigravity exposes a bad instruction,
harness bug, orchestration failure, or reproducibility defect, the operator may
use Codex to diagnose and repair those instructions or mechanisms. After that
repair, the work returns to Antigravity for the substantive engineering cycle.

A failed Antigravity cycle must therefore fail with useful evidence rather than
silently substituting Codex. The runner stops before a fourth consecutive
failure and requires a successful Antigravity smoke test before the failure
counter is cleared.

The scheduled runner is intentionally isolated from the repository-root
cross-surface orchestration so a Hedgehog hourly cycle cannot overwrite shared
state belonging to unrelated work.
