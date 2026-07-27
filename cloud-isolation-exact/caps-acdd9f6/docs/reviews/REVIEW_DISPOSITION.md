# Claude Code Review Disposition

Status: DRAFT FOR OWNER APPROVAL

Review source: `docs/reviews/CLAUDE_CODE_REVIEW.md`

No disposition below approves the contract. Rejected, partial, deferred, and
preference-dependent findings remain visible.

| Finding | Claude position | Draft disposition | Reason / change | Owner approval |
|---|---|---|---|---|
| F-1 | High: event data permits leaks | Accepted | Event types and payloads are now a closed catalog with rejection tests for extra/secret fields | Yes, event catalog |
| F-2 | High: hash chain is non-interoperable | Accepted | Added `EVENT-HASHING.md`, algorithm ID, canonicalization, previous-hash rules, and frozen vector | Yes |
| F-3 | High: independence/role/waiver gaps | Accepted with owner-format dependency | Mock derives exclusions from transitive provenance, verifies role, and requires owner-role waiver approval metadata; exact production approval artifact remains open | Yes |
| F-4 | High: backup contradiction and GitHub leak | Accepted | Added `source_only` vs `full`; full is clean/quiesced; GitHub removed from backup destinations | Yes |
| F-5 | High: restore monotonicity/drill activation | Accepted | Recovery-drill schema forbids takeover/activate; executable semantic tests reject non-monotonic takeover | Yes |
| F-6 | Medium: idempotency scope/content | Accepted | Mock scopes by project+principal+operation+key, stores canonical request hash, rejects changed content | Yes, retention |
| F-7 | Medium: lifecycle incomplete | Accepted | Added queued gate, await/resume, failure, cancellation, terminal/illegal transition tests | Yes |
| F-8 | Medium: hostname hash privacy overclaim | Accepted as wording correction; HMAC deferred | Removed non-reversible claim and calls digest pseudonymous; owner decides whether hostname privacy/HMAC is required | Yes |
| F-9 | Medium: adapter isolation unenforced | Accepted | Schema forbids in-process browser/credential adapters and requires network/approval declarations | Yes |
| F-10 | Medium: artifact location/sensitivity | Accepted | Restricted/confidential locations cannot use GitHub and require encrypted Drive/remote storage; work-product kinds cannot use GitHub | Yes |
| F-11 | Medium: version compatibility contradiction | Partially accepted; proposed field split deferred | README now states exact draft-schema dispatch and rejection. `const` remains intentional for this draft; negotiation/window is owner-deferred | Yes |
| F-12 | Low: doctor incomplete/nonconformant | Accepted | Doctor requires all ten categories; mock emits the schema envelope and validates sequence/hash/generation | Yes |
| F-13 | Low/preference: empty result artifacts | Draft recommendation accepts Claude preference D-C | Completion requires at least one result artifact; disagreement preserved below | Yes |
| F-14 | Low: non-expiring/unbound sessions | Accepted | Session expiry and transport/server-instance binding are required; exact lifetime remains open | Yes |
| F-15 | Info: label-like identity IDs | Accepted | Principal/session/host references now require namespace prefixes | Yes |

## Preserved disagreements

### D-A: SQLite and future remote storage

Claude concurs with SQLite/WAL for local operation but warns that it must not
foreclose a server-authoritative remote store. Accepted as an ADR clarification:
generation allocation remains behind a storage-agnostic interface. The actual
remote store remains owner-deferred.

### D-B: GitHub as a backup destination

Claude prefers no GitHub backup destination. The draft adopts that preference:
GitHub is private source history only, while backup manifests target local/Drive.
The owner may reverse this only with content-level routing controls and a new review.

### D-C: At least one result artifact

Claude prefers requiring a durable result artifact; another reasonable design
could allow disagreement-only completion. The draft currently requires one result
artifact. This remains an explicit owner choice, not a silently settled fact.

## Unresolved owner choices

- Event catalog evolution and cross-version negotiation.
- Production reviewer waiver artifact/authority format.
- Authentication provider, session lifetime, and hostname privacy mechanism.
- Storage engine and remote authoritative-store topology.
- Idempotency, event, artifact, backup, and disagreement retention.
- Encryption-key custody, rotation, and recovery.
- RPO/RTO, supported migration window, and restore-drill cadence.
- Whether the at-least-one-result-artifact recommendation should remain.
