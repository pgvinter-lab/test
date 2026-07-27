# Bridge 2.0 Contract 0.1.0-draft.2

Status: REVISED DRAFT FOR OWNER CONFIRMATION. This is not a frozen implementation contract.

The schemas are JSON Schema Draft 2020-12. They define envelopes and invariants
for identity, review jobs, artifacts/citations, adapters, scoped approval grants,
events, non-operational audit-mirror entries, backups, and restores. Lifecycle and
authorization rules that cannot be expressed cleanly in JSON Schema are executable
in `test/contract/` against `mock-client/`.

Proposed compatibility rules:

- A producer writes exactly one declared `schemaVersion`.
- Each schema validates exactly `0.1.0-draft.2`. A dispatcher selects the schema
  identified by the incoming version and rejects unsupported versions.
- Event types and event `data` are a closed catalog. Unknown fields and event types
  are rejected rather than ignored.
- Draft versions have no stability guarantee. Owner approval is required before
  removing the `-draft.N` suffix or authorizing implementation.
- Secrets, credentials, browser state, and source artifact bytes are never embedded
  in identity, adapter, backup, or restore manifests. Use opaque references.

Each file in `examples/` is synthetic and contains no user or case information.
Event canonicalization and hash chaining are specified in `EVENT-HASHING.md`.
Audit-mirror projection and archive rules are specified in `AUDIT-MIRROR.md`.
Cross-version negotiation and the supported-version window remain owner decisions.
