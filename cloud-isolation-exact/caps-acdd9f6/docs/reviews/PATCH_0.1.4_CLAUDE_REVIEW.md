# Independent Claude Code Review: Patch 0.1.4

**Reviewer:** Claude Code (independent, read-only)
**Reviewed at:** 2026-07-14
**Tag base:** v0.1.3 (immutable)
**Scope:** Narrow doctor + recovery-layout correction. No custody-project content, credentials, key material, browser state, or recovery payload bytes inspected.

---

## Files Reviewed (read-only)

| File | Role |
|---|---|
| `src/v2/recovery/doctor-service.ts` | Implementation under review |
| `test/runtime/runtime-recovery.test.mjs` | Test coverage |
| `docs/recovery/DRAFT-DRIVE-LAYOUT.md` | Layout specification |
| `README.md` | Version header |
| `package.json` | Version + exports |
| `package-lock.json` | Dependency lock (no substantive changes noted) |

---

## Question-by-Question Findings

### Q1 — Canonical layout resolution with legacy compatibility

**Finding: PASS**

`resolveRecoveryManifest` (lines 546–561, doctor-service.ts) builds two candidate paths:

```
<root>/backups/<backup-id>/   ← canonical layout
<root>/<backup-id>/           ← legacy direct-root layout
```

It filters both with `fs.lstatSync(dir, { throwIfNoEntry: false }) !== undefined`, then enforces that exactly one is present before returning `path.join(packageDirectory, "manifest.json")`. Both layouts are reachable; neither takes priority over the other—the count alone governs.

---

### Q2 — Fail-closed on ambiguity, missing package, malformed manifest, and unbound backup

**Finding: PASS**

| Failure mode | Code path | Outcome |
|---|---|---|
| Both layouts present | `present.length > 1` → throws `backup_package_layout_ambiguous` | `driveCheck` catch → `fail` |
| Neither layout present | `present.length === 0` → throws `backup_package_not_found` | `driveCheck` catch → `fail` |
| Package directory is a symlink/junction | `packageStat.isSymbolicLink()` → throws `backup_package_directory_invalid` | `driveCheck` catch → `fail` |
| Intermediate reparse point in path | `!samePath(fs.realpathSync.native(packageDirectory), packageDirectory)` → throws | `driveCheck` catch → `fail` |
| Not a directory | `!packageStat?.isDirectory()` → throws | `driveCheck` catch → `fail` |
| Malformed manifest | `verifyBackupManifest` throws | `driveCheck` catch → `fail` |
| Project ID mismatch | `manifest.projectId !== projectId` → explicit `fail` | `driveCheck` → `fail` |
| Backup ID mismatch | `manifest.backupId !== latest.backup_id` → explicit `fail` | `driveCheck` → `fail` |
| No verified destination | `!manifest.destinations.some(d => d.status === "verified")` → explicit `fail` | `driveCheck` → `fail` |

All nine paths fail closed. No silent pass.

---

### Q3 — Path traversal, symlink, junction, and intermediate reparse point bypass

**Finding: PASS with one observation (not a defect)**

**Package directory**: The double check `packageStat.isSymbolicLink() || !samePath(fs.realpathSync.native(packageDirectory), packageDirectory)` is defense-in-depth:

- `isSymbolicLink()` catches a symlink or Windows directory-symlink at the terminal path component.
- `realpathSync.native` comparison catches Windows junctions and intermediate reparsals that `lstatSync` would not surface at the leaf node. Any intermediate junction in the path resolves to a different real path, causing the `samePath` check to fail.

The recovery root itself is validated identically in `driveCheck` before `resolveRecoveryManifest` is entered (line 420).

**Observation (preference, not defect):** `manifest.json` inside the package directory is read with `fs.readFileSync`, which follows symlinks by design in Node.js. If `manifest.json` itself were a symlink pointing to a manifest controlled by an attacker, the content would be read from that external location. However, `verifyBackupManifest` schema-validates the result and the explicit projectId/backupId/destination checks in `driveCheck` must pass, so no cryptographically meaningful bypass is achievable this way. Adding `lstatSync` on the manifest file itself (`!manifestFileStat.isSymbolicLink()`) would be a minor hardening improvement but is not required.

**TOCTOU note:** There are two `lstatSync` calls in `resolveRecoveryManifest`—one in the filter and one for `packageStat`. On a local trusted filesystem in a diagnostic, read-only doctor context this is not an exploitable race; no finding.

---

### Q4 — Test coverage: canonical success, legacy compatibility, ambiguity rejection, and non-regression

**Finding: PASS with one test gap (preference)**

| Case | Test location | Evidence |
|---|---|---|
| **Legacy direct layout pass** | Lines 562–581, doctor `check.drive.root === "pass"` | Main recovery test creates backup at `destinationRoot = recoveryRoot`; doctor is run with same path. Package is at `<recoveryRoot>/<backupId>/` (direct). Passes. |
| **Canonical nested layout pass** | Lines 584–597, `nestedLayoutDoctor` | `driveLayoutRoot/backups/<latestBackupId>/` is created via `fs.cpSync`; doctor run with `recoveryRoot: driveLayoutRoot` passes `check.drive.root`. |
| **Ambiguity rejection** | Lines 599–607, `ambiguousLayoutDoctor` | Both `driveLayoutRoot/backups/<id>/` and `driveLayoutRoot/<id>/` exist; doctor reports `status === "fail"` and detail matches `/backup_package_layout_ambiguous/`. |
| Non-regression: read-only doctor | Lines 580–582 | Event count, idempotency count, and raw database bytes are all unchanged after doctor run. |
| Non-regression: JSONL tamper detection | Lines 616–640 | Tampered audit mirror entry causes `check.events.sequence === "fail"` and `overall === "blocked"`. |

**Test gap (preference):** The case where the DB records a backup ID but neither layout directory exists on disk—`backup_package_not_found`—is not directly tested via the doctor code path. The throw is present and correct in `resolveRecoveryManifest` (line 552) and is caught by the outer try/catch in `driveCheck`, but a dedicated test assertion would close this gap. This is a recommendation, not a blocking defect.

No existing recovery verification assertions were weakened. All prior assertions remain and the new assertions are additive.

---

### Q5 — Drive layout document accuracy

**Finding: PASS with one aspirational gap (documentation note)**

The `DRAFT-DRIVE-LAYOUT.md` now shows:

```text
backups/
  <backup-id>/
    manifest.json
    source.bundle
    state.snapshot.enc
    audit.events.jsonl.enc
```

This matches the backup service output confirmed by the test:

- `manifest.json` — created and verified at `path.join(recoveryRoot, manifest.backupId, "manifest.json")` (test line 194–195).
- `state.snapshot.enc` / `audit.events.jsonl.enc` — test asserts that plain `.sqlite` and `.jsonl` are absent (lines 192–193), confirming encrypted forms are written instead.
- `source.bundle` — confirmed by `sourceOnly.contents.map(c => c.kind)` === `["git_bundle"]` (line 338).

The document correctly describes both the canonical `backups/<id>/` layout and the legacy `<recovery-root>/<backup-id>/` compatibility, and explicitly states ambiguity causes a failure.

**Documentation gap (not a defect):** The layout shows `key-capsules/<backup-id>.json` as a separate file. In the current implementation, the wrapped key capsule is embedded in `manifest.json` itself via `wrappedKeyCapsule`. The document is labeled "DRAFT SCAFFOLDING" and the aspirational `key-capsules/` directory is consistent with a planned future layout. No code change required; this should be acknowledged when the draft is finalized.

---

### Q6 — Patch release correctness (no contract-schema change)

**Finding: PASS**

- `package.json` version: `0.1.4` (bumped from 0.1.3).
- `DoctorResult.schemaVersion` remains typed as literal `"0.1.0-draft.4"` (doctor-service.ts line 27).
- No new JSON schema types, no existing schema shape changes, no protocol message changes, no exports added or removed.
- `contracts/v0.1.0-draft.4/` is unchanged (still in `package.json` `files` array, unchanged path).
- Node.js engine requirement unchanged (`>=22.13.0`).
- `@modelcontextprotocol/sdk`, `ajv`, `ajv-formats`, `zod` — dependency versions unchanged.

The only runtime behavior changes are:
1. `resolveRecoveryManifest` introduced: doctor now probes `backups/<id>/` before `<id>/`, and rejects ambiguity.
2. Tests extended: three new doctor assertions for canonical layout, legacy layout, and ambiguity.
3. `DRAFT-DRIVE-LAYOUT.md` updated to show canonical layout.
4. `README.md` version header bumped.

All changes are additive or corrective. No consumer-visible API was changed. This is properly a patch release.

---

## Severity Summary

### Defects (blocking)

None found.

### Warnings (non-blocking, should be addressed before the next minor release)

**W1 — Test gap: `backup_package_not_found` via doctor is untested** *(test/runtime/runtime-recovery.test.mjs)*

The path in which the DB records a backup ID but neither candidate layout directory exists on disk is not exercised through the doctor code path. A short test case covering this (e.g., create a backup record, wipe the package directory, run doctor, assert `check.drive.root === "fail"`) would close the coverage gap.

### Preferences (informational, not required)

**P1 — lstat the manifest file itself** *(src/v2/recovery/doctor-service.ts, `resolveRecoveryManifest`)*

Before passing `manifestPath` to `verifyBackupManifest`, an additional `fs.lstatSync(manifestPath)?.isSymbolicLink()` check would prevent silently following a symlink planted inside the package directory. The content checks downstream already prevent a meaningful bypass; this is defense-in-depth only.

**P2 — Document `key-capsules/` as aspirational** *(docs/recovery/DRAFT-DRIVE-LAYOUT.md)*

Add an inline note clarifying that `key-capsules/<backup-id>.json` reflects a planned future layout; the current implementation embeds the capsule in `manifest.json`. Prevents confusion when the draft is consulted during implementation.

---

## Disagreements Preserved

None. The following were considered and closed:

- Whether `lstatSync` with `throwIfNoEntry: false` correctly handles EPERM vs ENOENT: confirmed EPERM still throws and is caught by the outer try/catch, preserving fail-closed behavior.
- Whether Windows junctions bypass the `isSymbolicLink` check: the `realpathSync.native` comparison is a valid backstop regardless of how libuv surfaces junction stat bits.

---

## Verdict

**APPROVE**

The patch correctly implements canonical `<recovery-root>/backups/<backup-id>/manifest.json` layout discovery with backward-compatible direct-root fallback, fails closed across all nine identified failure modes, provides defense-in-depth symlink/junction rejection at both root and package-directory level, proves canonical success/legacy compat/ambiguity rejection in tests without weakening any existing verification, and introduces no contract-schema change. The test gap (W1) and documentation gap (P2) are recommended follow-ups, not blocking issues.
