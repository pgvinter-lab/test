# Independent Claude Code Review Request: Patch 0.1.4

Status: FOCUSED REVIEW REQUEST

Independently review the uncommitted patch from immutable tag `v0.1.3`. This is a
narrow doctor and recovery-layout correction discovered during the live
pre-cutover check. Do not broaden into product implementation or custody-project
content. Do not inspect credentials, private keys, raw data keys, browser state,
recovery payload bytes, or case information.

Use the Bridge protocol. Claim and write only
`docs/reviews/PATCH_0.1.4_CLAUDE_REVIEW.md`, then log and release it. Review all
other files read-only.

## Scope

- `src/v2/recovery/doctor-service.ts`
- `test/runtime/runtime-recovery.test.mjs`
- `docs/recovery/DRAFT-DRIVE-LAYOUT.md`
- `README.md`
- `package.json`
- `package-lock.json`

## Questions

1. Does doctor correctly find the canonical
   `<recovery-root>/backups/<backup-id>/manifest.json` package while preserving
   the prior direct-root layout?
2. Does it fail closed when both layouts exist, or when the selected root/package
   is indirect, missing, malformed, or not bound to the latest recorded backup?
3. Can any path traversal, symlink, junction, or intermediate reparse point bypass
   the checks?
4. Do the tests prove canonical layout success, legacy compatibility, and
   ambiguity rejection without weakening existing recovery verification?
5. Does the Drive layout document now match the files the backup service actually
   writes?
6. Is this properly a patch release with no contract-schema change?

Write findings by severity with exact file/line evidence, distinguish defects from
preferences, preserve disagreements, and finish with one verdict: `APPROVE`,
`APPROVE WITH REQUIRED FIXES`, or `REJECT`.
