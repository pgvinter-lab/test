# Bridge 2.0 Contract 0.1.0-draft.4

Status: REVISED DRAFT WITH CONDITIONAL PHASE 1 AUTHORIZATION GATE. This is not a frozen implementation contract.

The schemas are JSON Schema Draft 2020-12. They define envelopes and invariants
for identity, review jobs, artifacts/citations, adapters, scoped approval grants,
events, non-operational audit-mirror entries, RSA-OAEP recovery-key capsules,
backups, restores, and the Bridge A2A send/query/terminal-receipt compatibility
surface. Lifecycle and
authorization rules that cannot be expressed cleanly in JSON Schema are executable
in `test/contract/` against `mock-client/`.

Proposed compatibility rules:

- A producer writes exactly one declared `schemaVersion`.
- Each schema validates exactly `0.1.0-draft.4`. A dispatcher selects the schema
  identified by the incoming version and rejects unsupported versions.
- Event types and event `data` are a closed catalog. Unknown fields and event types
  are rejected rather than ignored.
- Draft versions have no stability guarantee. Owner approval is required before
  removing the `-draft.N` suffix. Implementation remains subject to the D-021 gate
  in `docs/DECISION_REGISTER.md`.
- Secrets, credentials, browser state, and source artifact bytes are never embedded
  in identity, adapter, backup, or restore manifests. Use opaque references.
- D-024 permits the RSA recovery private key only in configured local runtime and
  Drive recovery-key directories. Capsule and backup manifests carry fingerprints,
  hashes, and opaque references, never private or raw data-key bytes.
- Defaults M-3 and L-4 remain: instruction amendments revoke active approval
  grants, and additional or unapproved approval conditions force `ask`. The only
  exception is an owner-only, job-scoped, immutable, non-retroactive override
  declared up front at job creation and audited in the job and event records.
- L-2 is approved: complete verbatim instruction text may be retained in the
  encrypted audit mirror under the existing redaction, exclusion, access, and
  encryption controls.
- GitHub setup, authentication, remote creation, and push are deferred until after
  the first implementation phase.

Each file in `examples/` is synthetic and contains no user or case information.
Event canonicalization and hash chaining are specified in `EVENT-HASHING.md`.
Audit-mirror projection and archive rules are specified in `AUDIT-MIRROR.md`.
Cross-version negotiation and the supported-version window remain owner decisions.
