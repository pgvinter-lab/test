# Patch 0.1.3 Claude Review Disposition

Date: 2026-07-14

Review: `PATCH_0.1.3_CLAUDE_REVIEW.md`

Claude Code independently reviewed the D-024 RSA capsule implementation through
Bridge and returned `APPROVE WITH REQUIRED FIXES`. All four findings are accepted.
The owner-approved risk that a compromise of the Drive recovery-key directory can
expose retained backups remains recorded as policy, not treated as a defect.

## Findings

| Finding | Disposition | Resolution |
| --- | --- | --- |
| F1, RSA modulus not verified | Accepted, fixed | Every wrap, unwrap, and copy-verification path now requires an RSA-3072 key. RSA-2048 regression coverage was added. |
| F2, doctor allowed nested PEM files | Accepted, fixed | Approved key directories must be canonical no-reparse paths, and only direct-child recovery PEM files are exempted. Nested PEM coverage was added. |
| F3, unwrap paths lacked source exclusion | Accepted, fixed | CLI restore and unwrap operations now reject private-key and raw data-key paths inside the package source root. |
| F4, one OAEP-label tamper field tested | Accepted, fixed | A second adversarial test mutates `createdAt` and verifies OAEP decryption fails. |

## Verification

- TypeScript build: pass.
- Focused runtime tests: 13 passed, 0 failed.
- Full inherited suite: pass (17 end-to-end, MCP smoke, 8 session, and 14
  regression checks).
- Connector manifests: pass.
- Contract suite: pass (13 schemas, 13 valid examples, 37 rejection cases, hash
  and restore vectors, and mock-client contract).
- Runtime suite: 48 passed, 0 failed.
- WAL-race stress: 1 passed, 0 failed.
- Real key creation and Drive-backed restore drill: pending the clean-commit and
  pre-migration backup gates.

No Claude disagreement with D-024 remains unresolved. Deferred rotation cadence,
multi-recipient recovery, private-key retirement, and recurring drill cadence remain
policy items rather than patch defects.
