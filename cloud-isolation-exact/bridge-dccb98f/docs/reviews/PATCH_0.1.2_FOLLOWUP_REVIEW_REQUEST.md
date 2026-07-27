# Bridge 2.0 Patch 0.1.2 Follow-up Review Request

Status: REQUESTED

Date: 2026-07-14

Reviewer lane: `claude_desktop_code`

## Scope

Review only the disposition and implementation of H-1, H-2, M-1, M-2, Q7.2,
and Q9 from `PATCH_0.1.2_CLAUDE_REVIEW.md`. Do not repeat the broad architecture
review and do not inspect runtime contents, custody material, credentials, browser
state, or legal material.

Primary files:

- `src/v2/compat/lanes.ts`
- `src/v2/compat/legacy-core.ts`
- `src/server.ts`
- `test/runtime/legacy-compatibility.test.mjs`
- `docs/reviews/PATCH_0.1.2_CLAUDE_DISPOSITION.md`
- related D-022/D-023 and architecture text

## Required determinations

1. Does ambiguous generic Claude identity now fail closed for file claims while
   preserving diagnostic sync access and explicit Code/Cowork operation?
2. Do real paths and junction/symlink aliases now resolve to one project identity
   and one lease space without breaking same-basename isolation?
3. Is legacy control import now seed-only and unable to overwrite newer Bridge 2.0
   control on a changed-source re-import?
4. Are all predictable backup/restore outcomes audited when a project database is
   resolvable, without adding a second authoritative store?
5. Are rollback state-loss and intentionally unaudited projectless operations
   accurately documented and preserved as limitations?

## Evidence

- `npm run test:all`: PASS after the revisions.
- Runtime: 45/45 PASS.
- Focused compatibility: 7/7 PASS.
- Contract: 12 schemas, 12 valid examples, 33 rejection cases.
- Dedicated WAL race: PASS.

Write `PATCH_0.1.2_CLAUDE_FOLLOWUP.md` with PASS or FAIL, remaining findings,
and any preserved disagreement. Do not authorize permanent deletion, GitHub
publication, cloud deployment, product implementation, or contract freeze.
