# Recovery, Migration, and Doctor

Status: REVISED DRAFT FOR OWNER CONFIRMATION

## Recovery layers

- GitHub private remote: complete sanitized source history and tags only after the
  first implementation phase; history is not pruned and GitHub is not a runtime
  backup-manifest destination. Setup, authentication, remote creation, and push are
  deferred until that phase closes.
- Google Drive recovery root: immutable packages, encrypted audit archives,
  manifests, restore reports, and historical archives.
- Local machine: active database, event journal, artifacts, credentials, browser
  state, and working trees.

Recovery packages are staged locally, hashed, optionally encrypted according to
sensitivity, copied to Drive, re-read, and marked verified. A manifest never claims
verification before the destination bytes are checked.
Any dirty `source_only` exception records an approval-grant reference, reason, and
owner identity in the manifest.

Confidential/restricted packages use AES-256-GCM and an opaque manifest key
reference. A fresh data key is wrapped with RSA-OAEP-SHA-256 in a canonical capsule
whose exact bytes and recipient public-key fingerprint are bound by the manifest.
The owner-approved private recovery key has one configured local-runtime copy and
one Drive recovery-key copy. Neither copy may enter GitHub, manifests, logs,
prompts, audit records, or source trees.

## New-laptop flow

1. Install Git, Node, Bridge dependencies, and approved credential tooling.
2. Clone the private source repository and verify the approved contract tag.
3. Locate the newest verified compatible backup manifest in Drive.
4. Restore into an isolated directory and verify hashes before decrypting.
5. Resolve and hash-verify the wrapped-key capsule, then unwrap it with either
   verified private-key copy.
6. Restore state, apply migrations, run doctor and contract tests.
7. Confirm the prior active instance is stopped or isolated.
8. Record owner-approved takeover and advance project generation.
9. Activate adapters one at a time; browser sessions are re-authenticated manually.
10. Write a restore report and perform a fresh backup.

## Migration contract

Each migration has an ID, from/to schema versions, checksum, preconditions,
estimated downtime, backup requirement, apply operation, verification operation,
and rollback classification. Migration execution records an event and report.

The draft recommends supporting restore from the two most recent approved minor
versions, but this window is an owner decision.

## Doctor contract

Doctor is deterministic and read-only by default. Its output contains:

- contract and executable version compatibility;
- identity/host binding and filesystem permissions;
- store integrity, schema version, migration status;
- event sequence and hash-chain continuity;
- active generation and stale claim/fencing detection;
- adapter manifest/schema and health results;
- private GitHub remote/privacy verification;
- Drive path availability and last verified backup age;
- forbidden file/secret placement checks;
- restore drill age.

Repair is a separate owner-approved operation that emits events and creates a
pre-repair backup.
