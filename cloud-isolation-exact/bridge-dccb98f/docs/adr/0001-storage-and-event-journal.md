# ADR 0001: Storage and Event Journal

Status: REVISED DRAFT - OWNER DECISION RECORDED; FINAL CONFIRMATION REQUIRED

## Context

Bridge 1.x uses mutable JSON files plus host-sharded JSONL. The prior review found
missing monotonic revision/fencing and Drive dual-writer risk.

## Recommendation

Use one local transactional SQLite database in WAL mode through Node's built-in
`node:sqlite` API for authoritative project state, claims, idempotency records, and
ordered events. No separate database package, server, or installation is required.
Export immutable event and snapshot packages for recovery. Do not place the live
database or WAL in Drive.
Keep the generation/fencing allocator behind a storage-agnostic interface so an
owner-approved remote deployment can use a server-authoritative store without
pretending multiple SQLite writers are safe.

## Alternatives

- Continue locked JSON/JSONL files.
- Use PostgreSQL from the start.
- Use an embedded append-only log plus materialized JSON snapshots.

## Consequences

SQLite adds migrations, backup/checkpoint discipline, and one native storage
dependency, but gives atomic claims and constrained writes without cloud cost.
`node:sqlite` is still experimental in the approved Node 22.13 runtime floor, so
Node minor upgrades require the contract suite and migration/backup verification;
this API-stability risk is an accepted draft cost, not a claim of stable API status.
PostgreSQL remains an option if owner-approved remote multi-user operation becomes
a requirement. SQLite is a local recommendation, not a remote-topology commitment.
Event replay is audit/recovery support, not the only read model.

Also append a non-operational JSONL audit mirror containing each complete event
envelope plus associated instruction, approval, action, outcome, citation, and hash
records. Operational reads and transitions never consume the mirror. Confidential
mirror archives use AES-256-GCM and exclude credentials, secrets, browser state,
and raw artifact contents.

## Unresolved

Retention, legal holds, mirror failure behavior, redaction, compaction, supported
migration window, and the store for any approved remote deployment remain deferred.
