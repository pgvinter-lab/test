# Independent Claude Code Review Request: Patch 0.1.3

Date: 2026-07-14

## Owner decision under review

D-024 selects the software public/private-key option with deliberately less secure
storage. Bridge wraps fresh 256-bit backup data keys with RSA-3072-OAEP-SHA-256.
The RSA private key may have byte-identical copies in one configured local runtime
directory and one configured Drive recovery-key directory. The owner explicitly
accepts that Drive compromise can expose retained backups. Private keys and raw
data keys remain forbidden in Git, source, manifests, logs, prompts, audit records,
and fixtures.

This supersedes only D-016's former requirement that the capsule decryption secret
remain outside Drive. Do not reopen the owner's accepted storage tradeoff as if it
were an implementation defect; identify consequences and defects separately.

## Review scope

- `src/v2/recovery/key-capsule.ts`
- `src/v2/recovery/backup-service.ts`
- `src/v2/recovery/doctor-service.ts`
- `src/v2/cli/main.ts`
- `src/v2/core/constants.ts`
- `src/v2/transports/mcp-server.ts`
- `migrations/003_contract_draft4.sql`
- `contracts/v0.1.0-draft.4/**`
- `test/runtime/runtime-key-capsule.test.mjs`
- `test/runtime/runtime-cli.test.mjs`
- `test/runtime/runtime-recovery.test.mjs`
- D-016 and D-024 in `docs/DECISION_REGISTER.md`
- recovery architecture and Drive-layout revisions

## Required questions

1. Does capsule creation explicitly use RSA-OAEP-SHA-256, bind immutable capsule
   metadata through the OAEP label, and reject wrong recipients or tampering?
2. Can private or raw data-key material reach stdout, manifests, Git-tracked paths,
   audit records, or error details through any reviewed path?
3. Are local/Drive key-copy initialization and verification fail-closed for partial,
   mismatched, existing, indirect, or source-tree destinations?
4. Does the doctor exception allow only exact configured recovery-key directories
   without weakening source-tree secret detection?
5. Do backup and restore CLI paths bind capsule hash, backup ID, key reference,
   recipient fingerprint, and data-key hash before use?
6. Is contract `0.1.0-draft.4` versioned without mutating draft.3, and is migration
   003 forward-only and compatible with the pre-migration full-backup gate?
7. Are there missing adversarial or recovery tests that should block creation of
   the real key copies and restore drill?

## Review format

Lead with findings ordered by severity and include exact file/line references.
Then state PASS, CONDITIONAL PASS, or FAIL for real key creation and the isolated
recovery drill. Preserve any material disagreement with D-024 as a separate policy
objection rather than silently changing the approved decision. Do not inspect or
include custody-case content, credentials, live private keys, browser state, or
Drive file contents.
