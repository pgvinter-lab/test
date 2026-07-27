# Bridge 1.x Clean Baseline Import

Status: historical baseline, not a Bridge 2.0 architecture decision.

Source was read from the local Bridge 1.x directory and copied without modifying
that directory. The import contains reusable TypeScript source, tests, connector
protocol documentation, browser connector playbooks/drivers/manifests, and package
metadata.

Excluded from the import:

- `.claude/`, `.gemini/`, `collab/`, and other local agent/runtime state
- `node_modules/`, `dist/`, logs, caches, and generated artifacts
- `connectors/state.json` and browser/session state
- all `_RUN_*` one-off request files
- local wiring scripts containing machine-specific paths
- transcription utilities containing task-specific prompt text
- the encoded review payload and unsanitized architecture-review bundle
- credentials, secrets, tokens, evidence, and case-specific material

Sanitation edits in this baseline are limited to generic machine/account examples,
deny-by-default sensitive routing, and repository ignore rules. No Bridge 2.0 runtime
or architecture implementation is included.
