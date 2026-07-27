# Bridge 2.0 Patch 0.1.2 Focused Review Request

Status: REQUESTED

Date: 2026-07-14

Reviewer lane: `claude_desktop_code`

## Scope

Independently review the uncommitted `0.1.2` delta from tag `v0.1.1`. This is a
cutover compatibility patch, not product feature work. Do not inspect custody
evidence, case facts, credentials, browser state, or runtime audit contents.

Review these files:

- `migrations/002_legacy_coordination.sql`
- `src/v2/compat/legacy-core.ts`
- `src/v2/compat/lanes.ts`
- `src/server.ts`
- `src/v2/cli/main.ts`
- `src/v2/storage/journal.ts`
- `contracts/v0.1.0-draft.3/schemas/event.schema.json`
- `test/runtime/legacy-compatibility.test.mjs`
- `test/runtime/legacy-claim-worker.mjs`
- migration-number updates in existing runtime tests
- D-022 and D-023 in `docs/DECISION_REGISTER.md`

## Required red-team questions

1. Can two SQLite processes both acquire overlapping file leases despite
   `BEGIN IMMEDIATE`, path normalization, generation, or fencing behavior?
2. Can Claude Desktop Code and Claude Desktop Cowork collapse to one principal or
   bypass each other's leases under any documented configuration?
3. Does any accepted compatibility mutation lack a complete immutable event and
   audit mirror projection, or leak excluded content classes?
4. Can legacy import overwrite newer state, import a live lease, mutate source
   workspaces, or place runtime/case data in Git?
5. Can project-path resolution bind a command to the wrong per-project database,
   especially under basename collisions, junctions, or omitted `project` args?
6. Does migration 002 preserve forward-only/backup requirements and immutable
   lease/import history?
7. Is the proposed directory-junction cutover and rollback actually reversible
   while both Codex and Claude use the historical `dist/server.js` path?
8. Do legacy backup/restore aliases violate the approved GitHub/Drive split or
   owner approval boundaries?
9. Are project-discovery/history reads and predictable backup/restore failures
   required in the audit mirror, and if so, where should projectless operations
   be journaled without creating a second authoritative database?
10. Is revising the still-unfrozen `v0.1.0-draft.3` event schema in place
    acceptable for this compatibility patch, or should the draft be advanced?

## Evidence already produced

- Build passed.
- Inherited CLI/MCP/session/fix suite passed: 39 checks.
- Connector suite passed.
- Contract suite passed: 12 schemas, 12 valid examples, 33 rejection cases.
- Runtime suite passed: 43 tests.
- Dedicated WAL stress passed: one 20-round, four-process run.
- New compatibility tests passed, including a simultaneous two-process
  overlapping-claim race, immutable same-basename project bindings, complete
  audited command outcomes, and real stdio calls through `dist/server.js`.

## Required output

Write `docs/reviews/PATCH_0.1.2_CLAUDE_REVIEW.md` with findings ordered by severity,
file/line references, disposition recommendation, residual risks, and an explicit
PASS or FAIL for reversible cutover. Preserve disagreements. Do not authorize
permanent deletion of Bridge 1.x, GitHub publication, cloud deployment, or product
implementation.
