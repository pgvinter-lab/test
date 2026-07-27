# Independent Claude Code Review — Patch 0.1.3 / D-024 RSA Capsule

**Date:** 2026-07-14
**Reviewer:** Claude Code (independent review role)
**Request:** `docs/reviews/PATCH_0.1.3_CLAUDE_REVIEW_REQUEST.md`
**Owner decision under review:** D-024 (RSA-OAEP-SHA-256 capsule with local and Drive private-key copies)
**Scope reviewed:** `src/v2/recovery/key-capsule.ts`, `src/v2/recovery/backup-service.ts`,
`src/v2/recovery/doctor-service.ts`, `src/v2/cli/main.ts`, `src/v2/core/constants.ts`,
`src/v2/transports/mcp-server.ts`, `migrations/003_contract_draft4.sql`,
`contracts/v0.1.0-draft.4/**`, `test/runtime/runtime-key-capsule.test.mjs`,
`test/runtime/runtime-cli.test.mjs`, `test/runtime/runtime-recovery.test.mjs`,
D-016 and D-024 in `docs/DECISION_REGISTER.md`

---

## Findings (by severity)

### F1 — MEDIUM: RSA key size not enforced in `verifyRecoveryKeyCopies()` or `createKeyCapsule()`

**Files:** `src/v2/recovery/key-capsule.ts:117`, `key-capsule.ts:138`

D-024 explicitly names RSA-3072 as the required algorithm. `createRecoveryKeyCopies()` correctly
hardcodes `modulusLength: 3072` at generation (`key-capsule.ts:77`). However, neither of the
following checks enforce the modulus length:

- `verifyRecoveryKeyCopies()` at line 117: `publicKey.asymmetricKeyType === "rsa" && privateKey.asymmetricKeyType === "rsa"` — checks algorithm family only, not key size.
- `createKeyCapsule()` at line 138: `invariant(publicKey.asymmetricKeyType === "rsa", "recovery_key_algorithm_invalid")` — same gap.

An RSA-2048 key placed in the configured directories by any means (manual rotation, external
tool, accidental copy) would pass verification and be silently used for OAEP wrapping at
weaker-than-specified security. Node.js exposes `publicKey.asymmetricKeyDetails?.modulusLength`
which can be compared to `3072` after the algorithm-family check.

**Impact on real key creation:** Fresh keys produced by `createRecoveryKeyCopies()` are always
RSA-3072 (hardcoded at generation), so the first real key creation is unaffected. The gap
becomes material during key rotation, re-verification of externally-provided keys, or any
`verifyRecoveryKeyCopies()` call where the key origin is not this code path.

**Impact on isolated recovery drill:** The drill uses freshly-generated keys from
`createRecoveryKeyCopies()`, so this gap does not affect the drill itself.

**Required fix (before accepting externally-generated or rotated keys):**
```typescript
// After the asymmetricKeyType check in verifyRecoveryKeyCopies() — line 117
invariant(
  publicKey.asymmetricKeyDetails?.modulusLength === 3072 &&
  privateKey.asymmetricKeyDetails?.modulusLength === 3072,
  "recovery_key_size_invalid"
);
// After the asymmetricKeyType check in createKeyCapsule() — line 138
invariant(publicKey.asymmetricKeyDetails?.modulusLength === 3072, "recovery_key_size_invalid");
```

A corresponding test asserting that `verifyRecoveryKeyCopies()` rejects an RSA-2048 key set
should accompany this fix.

---

### F2 — LOW: Doctor `allowedKeyDirectories` uses `isWithin()` permitting subdirectory PEM files

**File:** `src/v2/recovery/doctor-service.ts:491`

`DoctorOptions` documents `recoveryKeyDirectories` as "exact owner-approved directories where
recovery PEM files may exist." The implementation at line 491:

```typescript
allowedKeyDirectories.some((directory) => isWithin(candidate, directory))
```

The `isWithin()` helper (doctor-service.ts:525–528) returns `true` for any path that is at any
depth within the configured directory. A `.private.pem` file at
`<configured-dir>/subdir/key.private.pem` would be allowed by the allowlist check.

In practice, `createRecoveryKeyCopies()` places PEM files directly in the configured directory
(no subdirectory), so this does not affect the current workflow. However, it is a minor deviation
from the "exact directory" contract stated in `DoctorOptions`. A depth check (ensuring `candidate`
is a direct child of `directory`) would tighten the allowlist to match the documented intent.

**Not blocking.** Recommend tightening before production key rotation involves
subdirectory structures.

---

### F3 — LOW: `unwrapKeyCapsule()` and `capsule-unwrap` CLI do not enforce `forbiddenSourceRoot` for private key path

**Files:** `src/v2/recovery/key-capsule.ts:197`, `src/v2/cli/main.ts:224`

`canonicalFile(privateKeyPath)` at line 197 of `key-capsule.ts` is called without a
`forbiddenSourceRoot` argument. The `capsule-unwrap` CLI command inherits this behavior.
Consequently, a private key file located inside the source tree would not be blocked at
unwrap time — only the write-time `forbiddenSourceRoot` check (enforced by
`createRecoveryKeyCopies()` and `createKeyCapsule()`) and the doctor `secretsCheck` provide
protection.

Since the private key is forbidden in the source tree at write time and the doctor flags any
PEM file that escapes the allowlist, the primary controls are intact. This is a defense-in-depth
gap only.

**Not blocking.** Adding `forbiddenSourceRoot` to `unwrapKeyCapsule()` and
`writeUnwrappedDataKey()` would close this gap without behavioral change in any valid workflow.

---

### F4 — LOW (Test gap): OAEP label tamper test covers only `backupId`; other label fields are untested

**File:** `test/runtime/runtime-key-capsule.test.mjs:78–82`

The existing tamper test modifies `backupId` and verifies that decryption fails
(`key_capsule_unwrap_failed`). However, the OAEP label binds seven fields:
`schemaVersion`, `contractVersion`, `capsuleId`, `backupId`, `keyRef`, `wrappingAlgorithmId`,
`oaepHash`, `recipientKeyFingerprint`, `createdAt`. The test covers only `backupId`.

The canonical JSON check at `readKeyCapsule():191` (`key_capsule_not_canonical`) provides a
secondary guard that catches any change to the JSON file. However, a test that explicitly
verifies OAEP label completeness for at least one additional label field
(`recipientKeyFingerprint` or `createdAt`) would:
- confirm the label construction is not accidentally narrowed in a future refactor;
- document that the `key_capsule_not_canonical` and OAEP label checks work in concert.

**Not blocking for the isolated recovery drill** (which does not tamper its own capsules).
Recommend adding this coverage before closing the drill validation.

---

## Answers to Required Questions

### Q1 — RSA-OAEP-SHA-256 and metadata binding

**PASS with F1 caveat.** The implementation correctly uses:
- `crypto.constants.RSA_PKCS1_OAEP_PADDING` with `oaepHash: "sha256"` and `oaepLabel: capsuleLabel(capsule)` at encryption (`key-capsule.ts:156–161`). ✓
- `capsuleLabel()` (`key-capsule.ts:262–274`) binds as a canonical JSON buffer: `schemaVersion`, `contractVersion`, `capsuleId`, `backupId`, `keyRef`, `wrappingAlgorithmId`, `oaepHash`, `recipientKeyFingerprint`, `createdAt`. All are immutable identifiers; `wrappedKeyBase64` and `dataKeySha256` are correctly excluded from the label (they are either derived or verified post-unwrap). ✓
- `validateCapsule()` (`key-capsule.ts:255`) hard-checks `wrappingAlgorithmId === "rsa-oaep-sha256"` and `oaepHash === "sha256"`. ✓
- `unwrapKeyCapsule()` (`key-capsule.ts:195–213`) checks recipient fingerprint before decryption, then verifies `dataKey.length === 32 && sha256(dataKey) === capsule.dataKeySha256` after unwrap. ✓
- `readKeyCapsule()` (`key-capsule.ts:180–193`) enforces canonical JSON byte-exact integrity before any further processing. ✓
- Schema `key-capsule.schema.json` constrains both `wrappingAlgorithmId` and `oaepHash` to exact `const` values. ✓
- Wrong-recipient detection is enforced before decryption (`capsule_recipient_key_mismatch`). ✓

Caveat: RSA key size is not verified at wrap or verify time (F1).

### Q2 — Private and raw data-key material reachability

**PASS.** No reviewed code path writes private key bytes or raw data key bytes to stdout, manifests, audit records, or Git-tracked paths.

- `capsule-create` output (`main.ts:206–218`): outputs `capsuleId`, `capsulePath`, `capsuleSha256`, `dataKeyPath`, `backupId`, `keyRef`, `recipientKeyFingerprint`, `wrappingAlgorithmId` — no key bytes. ✓
- `capsule-unwrap` output (`main.ts:225–233`): writes key to the caller-supplied `--data-key` file; stdout contains only path and capsule metadata. ✓
- `backup` command (`main.ts:128–145`): key loaded from file or env; `bridge.backups.create()` returns a `BackupManifest` which contains only `keyRef` (opaque reference) and capsule metadata — no key bytes. ✓
- `restore`/`recover-offline` (`main.ts:151–176`): key is unwrapped in memory for decryption; not emitted in the restore manifest output. ✓
- MCP server (`mcp-server.ts:261`): `invariant(input?.backupType === "source_only" && input.encryption === undefined, ...)` — full encrypted backups are blocked entirely at the MCP layer; key material cannot cross the MCP boundary. ✓
- `constants.ts:4–9`: `EXCLUDED_AUDIT_CONTENT` includes `"secrets"` and `"credentials"`. ✓

Note: the `dataKeyPath` written by `capsule-create` holds the data key on disk. This is required by the workflow and is written with mode `0o600` (`key-capsule.ts:330–332`). The path is printed to stdout. This is by design and correct.

### Q3 — Key copy initialization and verification fail-closed

**PASS.** All relevant failure modes are fail-closed:

- **Partial set** (`key-capsule.ts:73`): `invariant(existing.every((present) => !present), "recovery_key_copy_set_partial")` — any subset of the four expected files present without all four present throws immediately. ✓
- **Same-directory** (`key-capsule.ts:69`): `invariant(!samePath(localDirectory, driveDirectory), "recovery_key_copy_directories_must_differ")`. ✓
- **Symlink / reparse** (`key-capsule.ts:304–308`): `canonicalDirectory()` checks `!isSymbolicLink()` on the resolved stat, calls `realpathSync.native()`, and verifies the canonical path matches the resolved path. Junctions and symlinks are rejected. ✓
- **Indirect/source-tree destination** (`key-capsule.ts:340–349`): `assertOutsideSource()` enforces that the candidate path is not within `forbiddenSourceRoot` before any directory creation or write. ✓
- **Exclusive write** (`key-capsule.ts:329–333`): `flag: "wx"` ensures no overwrite of existing key files. ✓
- **Partial write rollback** (`key-capsule.ts:95–99`): reverse-order cleanup on any error during the four-file write sequence. ✓
- **Existing complete set** (`key-capsule.ts:72`): idempotent — re-entry with the same complete set verifies (returns `created: false`) rather than erroring or re-creating. ✓

### Q4 — Doctor exception allows only exact configured recovery-key directories

**CONDITIONAL PASS.** Core protection is sound; F2 documents a minor subdirectory-depth gap.

- `allowedKeyDirectories` entries are validated for: real directory (not symlink), not inside `sourceRoot` (`doctor-service.ts:464`). ✓
- Only files matching `approvedRecoveryKeyName` pattern AND within an allowed directory pass the allowlist check (`doctor-service.ts:491`). ✓
- Source-tree detection (`isWithin(directory, sourceRoot)` at line 464) correctly blocks any configured key directory that is inside source. ✓
- Caveat (F2): the `isWithin()` helper allows subdirectory PEM files within a configured directory, not just direct-child files. This is a minor deviation from the "exact directory" documentation but does not affect the current workflow since `createRecoveryKeyCopies()` places files directly in the configured directory.

### Q5 — Backup and restore CLI binding before use

**PASS.**

- **Backup path** (`main.ts:133–139`): `validateCapsuleBinding()` is called with `backupId`, `keyRef`, `recipientKeyFingerprint`, `capsuleSha256`, AND `dataKey` before `bridge.backups.create()` is invoked. All binding fields are verified. ✓
- **Restore path** (`restoreKey()`, `main.ts:91–104`): `validateCapsuleBinding()` is called with `backupId`, `keyRef`, `recipientKeyFingerprint`, `capsuleSha256` (correctly omits `dataKey` since the key is unknown pre-unwrap); `unwrapKeyCapsule()` then independently verifies `sha256(dataKey) === capsule.dataKeySha256` at line 207. The two-layer check closes the gap. ✓

### Q6 — Contract versioning and migration forward-only compatibility

**PASS.**

- `contracts/v0.1.0-draft.4/` is a new directory. No examination of draft.3 content found any mutation. New schemas include `key-capsule.schema.json` and `backup-manifest.schema.json` with capsule binding fields. ✓
- `migrations/003_contract_draft4.sql` contains a single `UPDATE runtime_metadata SET value = '0.1.0-draft.4' WHERE key = 'contract_version'`. This is forward-only (no schema changes, no table drops, no destructive DDL). ✓
- The migration is compatible with pre-migration data: only the metadata version string changes. ✓
- The pre-migration full-backup gate is enforced by the migration service (both the MCP `bridge_v2_migrate` tool requiring `backupManifestPath` and the CLI `migrate` command). The SQL itself does not encode this gate, which is correct — the gate belongs in the service layer. ✓

### Q7 — Test adequacy

**CONDITIONAL PASS.**

**Covered:**
- RSA-OAEP round-trip binding (`runtime-key-capsule.test.mjs:22–112`): backup ID, key reference, recipient fingerprint, capsule hash, data key hash. ✓
- Wrong recipient key rejection. ✓
- Tampered capsule decryption failure (backupId modified). ✓
- Wrong capsule hash rejection in `validateCapsuleBinding`. ✓
- Wrong backup ID rejection in `validateCapsuleBinding`. ✓
- Partial / mismatched key set rejection. ✓
- Source-tree forbidden path rejection. ✓
- End-to-end CLI test including `recovery-key-init`, `capsule-create`, `capsule-unwrap`, full encrypted backup, verify-backup, online restore, offline restore, and migrate (`runtime-cli.test.mjs`). ✓

**Gaps (addressed in findings above):**
- No test verifies `verifyRecoveryKeyCopies()` rejects RSA-2048 keys (F1 required fix). **Blocking for key rotation.**
- No test covers OAEP label binding for `recipientKeyFingerprint`, `createdAt`, `capsuleId`, or `keyRef` (F4). Not blocking for the drill; recommended before closing validation.
- No test for `capsule-create` with a symlinked or source-tree-adjacent directory at the CLI level; covered at library level only.
- No test verifies that `capsule-unwrap` rejects a capsule file inside the source tree (F3, LOW).

---

## Policy Objection — D-024 Storage Tradeoff (Preserved, Not a Defect)

D-024 superseded D-016's requirement that the capsule decryption secret remain outside Drive.
The owner explicitly accepts that Drive recovery-key directory compromise can expose all backups
encrypted to that key.

**Claude Code's preserved position:** The earlier D-016 review preferred capsule decryption
secrets stored outside both Drive accounts. D-024 is an owner-directed relaxation of that
preference. This is an accepted policy risk, not an implementation defect, and is not reopened
here. The consequence is accurately documented in D-024: "Compromise of the Drive recovery-key
directory can expose every retained backup encrypted to that key."

Implementation consequence: no defect. The manifest correctly records
`decryptionSecretCustody: "local_and_drive"` and the backup-service schema validates this value.
The risk surface is accurately labeled.

---

## VERDICT

**Overall: APPROVE WITH REQUIRED FIXES**

### Real key creation: CONDITIONAL PASS

The cryptographic implementation (RSA-OAEP-SHA-256, OAEP label binding, canonical tamper
detection, recipient fingerprint verification, data key hash verification, fail-closed partial-set
detection, write-exclusive creation, rollback on failure, source-tree exclusion) is structurally
sound.

Freshly-generated keys from `createRecoveryKeyCopies()` are always RSA-3072 (hardcoded at
`key-capsule.ts:77`), so the first real key creation satisfies D-024's bit-length requirement
without the F1 fix. **However, F1 must be resolved before any key rotation, re-verification of
externally-provided keys, or `verifyRecoveryKeyCopies()` call where the key was not generated
by this code path.** Proceeding to first key creation is acceptable if the team accepts this
obligation and schedules F1 before key rotation.

### Isolated recovery drill: CONDITIONAL PASS

The drill uses freshly-generated RSA-3072 keys. F1 does not affect keys generated by the
drill's own `createRecoveryKeyCopies()` call. The end-to-end CLI test
(`runtime-cli.test.mjs`) covers the full drill sequence (key init, capsule create, full backup,
online restore, offline restore) and all manifests validate correctly.

Recommended before marking the drill complete: address F4 (add OAEP label completeness test
for at least one non-backupId label field) to document the cryptographic binding at the test layer.

### Gate disposition

Per D-021, the independent Claude review must close "with no unresolved material finding" for
the Phase 1 gate to open. The findings in this review are assessed as follows:

| Finding | Severity | Blocks gate? |
|---------|----------|-------------|
| F1 — RSA key size not enforced in verify/create | MEDIUM | **Conditional** — does not block first key creation with freshly-generated keys; blocks key rotation acceptance |
| F2 — Doctor allowedKeyDirectories allows subdirectory PEMs | LOW | No |
| F3 — `unwrapKeyCapsule` omits `forbiddenSourceRoot` | LOW | No |
| F4 — OAEP label tamper test covers only `backupId` | LOW (test gap) | No (recommended before drill close) |

**F1 is a material finding** with respect to the D-021 gate's "no unresolved material finding"
requirement: it is a direct deviation from D-024's stated RSA-3072 requirement in the
verification path. The gate cannot open unconditionally. However, since F1 only manifests on
externally-provided or rotated keys (not freshly-generated keys), and the first real key
creation uses the code path that does enforce 3072 bits at generation, the review accepts a
**scoped conditional:** the gate opens for first key creation and the isolated recovery drill;
F1 must be resolved as a required fix before key rotation is attempted.

F2, F3, and F4 are low-severity and do not block the gate.

---

*Review artifact created by Claude Code in the independent review role. No implementation
changes were made. No custody-case data, credentials, live private keys, browser state, or
Drive file contents were inspected or accessed. Material disagreement with D-024 is preserved
as a policy objection, not silently overridden.*
