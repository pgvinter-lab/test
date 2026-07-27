# AGY Package 10A — Windows Daily Schedule (Offline Implementation)

> ## FLAGS — OWNER MUST SEE BEFORE DISPATCH
>
> - `FLAG-10-LIVE-VERIFICATION` is CLOSED, not open. Read-only evidence captured
>   on 2026-07-24 proves `\CodexConnector-CatalogSync` is enabled/Ready; triggers
>   06:00, 14:00, 22:00 local; action
>   `C:\Program Files\nodejs\node.exe dist\cli.js catalog refresh`; working
>   directory `C:\Users\pgvin\.claude\projects\Codex Connector`; last run
>   2026-07-24 06:00:01; last result 0; next run then 14:00.
> - `FLAG-10-TIME` remains open: 06:30 is the proposed non-colliding caps time.
>   The scripts may implement/dry-run it, but the owner may change it before
>   live apply.
> - This authorization is offline only. Creating/removing/running a real
>   scheduled task is owner-gated Package 13B S5 and is not authorized here.

## 0. AGY identity, mode, and QA

Surface Antigravity; Gemini implementation model at maximum reasoning; isolated
Wave-1 10A worktree; project
`C:\Users\pgvin\LLM Assisted Projects\Bridge`; identity
`BRIDGE_AGENT=antigravity`, `BRIDGE_LANE=google_antigravity`,
`BRIDGE_PROJECT=bridge`.

Scripts may format, validate, or render content you yourself reasoned out; they
may never originate substantive content. Every section's substance must trace
to your own reasoning.

Run the QA skill at
`C:\Users\pgvin\.gemini\antigravity\brain\4acd2eff-97e3-48fb-aa8c-9accee9ccb77\skills\agy-prompt-qa\SKILL.md`;
write/QA `ROUND1_SELF_PROMPT.md`, preserve revisions, and attach the filled QA
checklist.

## 1. Objective and exact deliverables

Build a reversible dry-run-first wrapper and installer for
`\Bridge Caps Daily Refresh` at proposed 06:30 local, preserving and auditing
the proven `\CodexConnector-CatalogSync` task without modifying it.

| Claimed file | Purpose | Derived numeric floor |
|---|---|---|
| `scripts/caps/Invoke-BridgeCapsRefresh.ps1` | absolute built-CLI invocation, sanitized environment, bounded local receipt/log | at least 8 explicit validation/log fields and 3 stable exit classes |
| `scripts/caps/Install-BridgeCapsSchedule.ps1` | dry-run, `-Apply`, `-Remove`, audit, backup/restore | exactly 3 modes; 1 task name; 1 trigger; 1 XML backup+hash rule; 0 password storage |
| `test/caps/scheduler.test.mjs` | offline fake-scheduler tests | at least 13 named tests covering dry-run, apply plan, remove scope, absolute action, 06:30, backup/refusal, audit-only catalog task, and no real scheduler mutation |

Read-only: `package.json`, built `dist/cli.js`, caps config/state interfaces.
External scheduler mutation is forbidden in this package. Evidence belongs in
`<factory-output>\10A\` with self-prompt, immutable revision patches, filled QA
checklist, command logs, receipt, and review pointer.

The receipt stamps each artifact
`reasoned | script-rendered-from-reasoned-data | script-generated`; false
declarations reject the package. Snapshot before every revision and never
overwrite/delete.

## 2. Ordered requirements

1. The wrapper resolves absolute Node executable, repo root, built
   `dist\cli.js`, and caps state paths; rejects a missing built entrypoint; never
   invokes TypeScript.
2. Invoke exactly:
   `node <absolute-dist-cli> caps refresh --lane all`.
3. Use a minimal sanitized environment and bounded local logs containing start,
   end, exit, refresh report ID, and bounded stderr. `already_running` is
   successful because 08A owns serialization.
4. Installer defaults to dry-run and supports explicit `-Apply` and `-Remove`.
   Configure `/RL LIMITED`; store no password.
5. Before replacing an existing same-name task, export its XML and SHA-256
   manifest under `<caps-state>\scheduler\backups`; refuse if backup/manifest
   cannot be proven.
6. Proposed trigger is one daily 06:30 local run, absolute action/working
   directory, and start-when-available when credential-free.
7. Audit `\CodexConnector-CatalogSync` and record the corrected live evidence
   above. It is audit-only: never replace, disable, re-time, or remove it.
8. `-Remove` deletes only `\Bridge Caps Daily Refresh`; restore a prior
   same-name task only from a matching backup manifest.
9. Offline tests use a fake scheduler command. Required CI never creates,
   changes, runs, or removes a real task.
10. Implement now against the frozen 08B invocation, but defer end-to-end built
    CLI acceptance until 08B is accepted.

Each item and compound member is binding and individually dispositioned.
`etc.` is forbidden.

## 3. No-touch and exact bus

No-touch: real Task Scheduler, the existing catalog task, live caps state,
files outside the three claims, `package.json`, caps/CLI source, `.connector/**`,
mailbox, owner files, Bridge 1.x, dependencies, credentials, endpoints, network,
installs, paid actions.

1. `bridge_sync({"project":"C:\\Users\\pgvin\\LLM Assisted Projects\\Bridge"})`
2. `bridge_claim({"project":"C:\\Users\\pgvin\\LLM Assisted Projects\\Bridge","paths":["scripts/caps/Invoke-BridgeCapsRefresh.ps1","scripts/caps/Install-BridgeCapsSchedule.ps1","test/caps/scheduler.test.mjs"],"note":"Caps 10A isolated offline scheduler lane"})`
3. `bridge_log({"project":"C:\\Users\\pgvin\\LLM Assisted Projects\\Bridge","summary":"CAPS-10A doing: offline dry-run schedule implementation; no live mutation","files":[]})`
4. Log exact files/candidate SHA after offline gates.
5. After 08B joins, rerun built-CLI acceptance; after terminal same-SHA Claude
   PASS, log `CAPS-10A done` with evidence/review IDs.
6. Release exactly the three claims.

## 4. Verification, review, receipt, rollback

```powershell
npm run build
node --test test/caps/scheduler.test.mjs
powershell -NoProfile -ExecutionPolicy Bypass -File .\scripts\caps\Install-BridgeCapsSchedule.ps1
git diff --check -- scripts/caps/Invoke-BridgeCapsRefresh.ps1 scripts/caps/Install-BridgeCapsSchedule.ps1 test/caps/scheduler.test.mjs
```

The fake/offline focused gate may run concurrently; spawned/full regression
gates require `windows-spawn-heavy-test` and queue behind Prospecting. Never
inflate timeouts.

Self-audit: 10 requirements, 3 floors, real-task mutation count 0, command exits,
changed paths, 08B join SHA. Freeze/commit locally and obtain a separate Claude
terminal review at that exact SHA; AGY cannot self-certify. Byte changes require
new iteration/tests/review.

Rollback source reverses these three files. Live `-Remove`/restore is not run
until 13B owner approval. Round 1 cut threshold follows the measured 26/292,
16-stub, and shrinkage failures: any live mutation, floor miss, missing safety
case, receipt, terminal review, or SHA match rejects the lane.
