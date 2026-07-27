# Bridge 2.0 Shared Contract

Status: REVISED DRAFT WITH CONDITIONAL PHASE 1 AUTHORIZATION GATE

Draft version: `0.1.0-draft.4`

The owner-directed provider-mailbox extension is separately versioned as
`contracts/mailbox-v1-draft/` and recorded in D-025/ADR 0008. It does not remove
the draft status or freeze this core contract.

This document freezes nothing. It is a proposed contract for review by the owner,
Bridge implementation window, Procedural Guidance window, and an independent
Claude Code reviewer. The words MUST, SHOULD, and MAY describe proposed behavior
only until the owner explicitly approves a contract version.

## 1. Scope and boundaries

Bridge 2.0 is proposed as a local-first coordination and review control plane.
It manages identities, jobs, leases/claims, event metadata, artifact provenance,
adapter contracts, transport sessions, and recovery manifests. It does not own
client-domain reasoning or source evidence.

The Procedural Guidance System is a client. It may submit synthetic or authorized
artifact metadata and review jobs through the contract, but Bridge must not infer
jurisdictional rules or analyze case facts.

Complete sanitized source history belongs in a private GitHub repository and is
not pruned. Runtime state, case information, artifact bytes, credentials, browser
state, recovery snapshots, and recovery secrets do not belong in GitHub.

## 2. Proposed component boundaries

- Core service: validates commands, authorizes principals, advances aggregate
  state, appends events, and issues fencing tokens.
- Local state store: authoritative SQLite/WAL state through Node's built-in
  `node:sqlite`; no separate database package or server.
- Event journal: ordered immutable audit stream with closed event payload schemas
  and the canonical hash chain defined in
  `contracts/v0.1.0-draft.4/EVENT-HASHING.md`.
- Audit mirror: append-only JSONL projection of complete typed event envelopes and
  associated instruction, approval, action, outcome, citation, and hash records.
  It is never read for state transitions and excludes secrets, credentials,
  browser state, and raw artifact contents.
- Artifact index: metadata and hashes only; content remains in approved storage.
- Adapter host: invokes versioned adapters through explicit operation schemas.
- MCP facade: exposes role-filtered tools over stdio or Streamable HTTP.
- Recovery service: creates/verifies backup and restore manifests; it never stores
  encryption keys in a manifest.
- Mock client: in-memory test double only, not production code.

## 3. Principal, session, and host identity

Identity is a three-part envelope:

- Principal: durable human, agent, or service identity, keyed by issuer + subject.
- Session: a time-bounded authenticated execution context for one principal on one
  host. A session is never used as a durable principal identity.
- Host: a registered installation with a stable `hostId`, per-install
  `instanceId`, platform, and pseudonymous hostname digest. A bare hostname digest
  is not treated as non-reversible; HMAC/salt policy remains an owner decision.

Every mutation carries all three identifiers. Display names such as `codex` or
`claude` are labels, not authorization identities. Credentials are represented
only by opaque references. Remote authentication method and identity provider
remain owner decisions.

Approval grants are revocable audit records bound to the three-part identity and
one instruction version. Every grant is also bound to the consuming principal,
session, host, required project role, adapter, and current claim ID/generation/
fencing token. It is bounded by job, action, condition, destination/origin,
side-effect class, expiry, and use count. No exact active match defaults to `ask`;
a scope expansion or stale claimant cannot inherit an existing grant.

## 4. Collaboration and reviewer roles

Collaboration and review are separate authorization modes:

- Collaborators may create/update work artifacts and collaboration jobs.
- Workers may execute scoped jobs but do not approve their own output.
- Reviewers may read review targets, create findings, and complete review jobs.
- Independent reviewers are excluded when their principal created or materially
  authored any artifact in the target's transitive provenance closure, unless an
  owner-authored approval artifact records an explicit waiver.
- Owners/admins manage policy and may accept/reject findings, but review output
  preserves the reviewer's original position.

Role checks are project-scoped and enforced from the principal registry at claim
time. The service computes the effective exclusion set as declared exclusions plus
every creator in the target provenance closure. A principal may hold different
roles in different projects. Being the session boss or control-token holder does
not grant reviewer independence.

## 5. Review-job lifecycle

Proposed states and permitted transitions:

| From | To | Required condition |
|---|---|---|
| queued | claimable | dependencies and policy checks pass |
| queued | cancelled | authorized cancellation |
| claimable | claimed | atomic claim with role and independence checks |
| claimed | running | matching generation and fencing token |
| claimed | claimable | claim expires or is explicitly released |
| running | awaiting_input | reviewer records a blocking input request |
| awaiting_input | running | requested input is attached |
| running | completed | result artifacts and disagreements are recorded |
| running | failed | terminal error with reason |
| any nonterminal | cancelled | authorized cancellation |

Terminal states are `completed`, `failed`, and `cancelled`. Re-running terminal
work creates a new job or explicit retry attempt; history is not rewritten.

Owner-supplied custom instructions are accepted at job creation and persisted as
a versioned, hashed instruction set. Amendments retain prior versions. Because
grants bind an exact instruction version, every amendment explicitly revokes active
grants bound to the superseded version and emits both revocation and instruction-
amendment events. Materiality remains separately recorded for policy/audit use.

A full owner policy override exists only when explicitly invoked by the owner at
job creation. It is owner-only, job-scoped, immutable after creation,
non-retroactive, and fully audited in the creation event and job record. It
overrides only the default M-3 rule that every instruction amendment revokes active
approval grants and the default L-4 rule that additional unapproved condition keys
force `ask`. It does not bypass principal or role authorization, claim/generation/
fencing controls, adapter allowlists, credential isolation, or unrelated security
controls. When no override is declared, M-3 and L-4 remain the defaults.

## 6. Claiming, idempotency, and fencing

Claim acquisition is atomic and succeeds only from `claimable`. Each accepted
claim increments `attempt`, receives a unique `claimId`, active-instance
`generation`, monotonic `fencingToken`, and expiry time.

Every mutating retry carries an `idempotencyKey`. The service scopes it to
project + principal + operation, stores a canonical request hash, and returns the
original result without appending a duplicate event. Reusing the key with different
content is rejected. Retention duration for idempotency records is not approved.

Every mutation after claim must present the claim ID, generation, and fencing
token. A stale generation or token is rejected even if the old lease has not
noticed expiry. Claim expiry makes a job claimable again but never authorizes a
late writer.

## 7. Artifact and citation provenance

Artifact records are immutable metadata envelopes containing a content hash,
size, media type, creator identity, sensitivity, approved locations, parent
artifacts, and capture/transform method. Changed bytes create a new artifact ID.

Citations are first-class records tied to a source artifact, precise locator,
supported claim, optional quote hash, and verification status/method. A citation
being present is not proof of support. Review artifacts may mark citations
`contradicted` or `inconclusive`.

Source bytes are not embedded in events, review jobs, backup manifests, or GitHub.
Event `data` is a closed per-event-type schema; arbitrary extension objects are
not permitted.

The separate JSONL audit mirror contains the full event envelope and typed
snapshots associated with that event. Confidential/restricted mirror archives use
AES-256-GCM. Mirror retention, redaction, legal holds, access policy, and failure
behavior remain deferred; automatic deletion is not authorized.
Owner-approved L-2 permits complete verbatim instruction text in the encrypted
audit mirror under the existing redaction, exclusion, access, and encryption
controls.

Completion events include result artifact IDs, citations, and full preserved
disagreement envelopes. Mirror cardinality is mandatory by event family: review-job
events carry the current instruction snapshot, approval-grant events carry the
grant snapshot, browser authorization events carry action and outcome snapshots,
and completion events carry a result outcome snapshot.

## 8. Adapter interface

Each adapter publishes a closed manifest with:

- adapter and interface versions;
- operations with input/output schema references;
- idempotency and side-effect class;
- capabilities and supported transports;
- credential mode, network allowlist, sensitive-data policy, and approval gates;
- health-check operation and states.

The core validates requests before dispatch and outputs before acceptance.
Adapters receive the least authority needed for one operation. Browser or
credentialed adapters cannot use the in-process transport, browser/API adapters
declare a non-empty network allowlist, and every adapter declares human approval
for irreversible and sensitive-external operations. Browser adapters never export
authenticated profile state.

Browser dispatch remains per-action `ask` by default. An owner may issue a bounded
approval grant for a job, including named approval-prompt classes. A new origin,
destination, operation, condition, side-effect class, instruction version, expiry,
or exhausted use count produces `ask` and requires a new grant. A manifest can
declare support for bounded grants but cannot grant authority itself.
Grant adapter IDs and every approved origin/destination must be a subset of each
adapter's declared network allowlist. Additional unlisted condition keys count as
scope expansion and produce `ask` unless the owner declared the job-creation
override described in Section 5. Under that override, unlisted condition keys do
not alone force `ask`, but every listed grant condition still has to match and all
identity, role, claim, fencing, allowlist, credential, and side-effect controls
remain enforced.

## 9. Proposed MCP tool profiles

- `bridge.read`: identity, project status, job reads, artifact metadata, events.
- `bridge.collaborate`: create collaboration jobs, claim/release work, log, and
  register artifact metadata.
- `bridge.review`: claim independent reviews, submit findings/disagreements, and
  complete review jobs; cannot mutate target artifacts.
- `bridge.operate`: backup, restore planning, migration, doctor, and generation
  takeover; sensitive actions require owner approval.
- `bridge.admin`: principal/role/policy administration; disabled by default.

Tool discovery may hide unauthorized tools, but every invocation is independently
authorized server-side.

Patch `0.1.2` adds a transitional, audited compatibility profile at the historical
`dist/server.js` entrypoint. It preserves the `bridge_sync`, `bridge_claim`,
`bridge_release`, `bridge_log`, `bridge_handoff`, task, recent, backup, and restore
tool names while storing coordination state in SQLite/WAL. Compatibility file
leases record generation and fencing tokens. Codex, Claude Desktop Code, and
Claude Desktop Cowork are separate principals and lease owners. The compatibility
surface fails closed on file claims when a generic Claude client cannot identify
Code versus Cowork. Project identity keys resolve junctions and symlinks so aliases
of one working tree cannot create independent lease spaces. Legacy import seeds
control only when Bridge 2.0 has no control row; later imports cannot overwrite
newer Bridge 2.0 control. Resolvable backup/restore failures are journaled in the
project database. Projectless discovery reads and unregistered-restore failures
remain intentionally unaudited because this design has no host-level authoritative
database. `BRIDGE2_RECOVERY_ROOT` is authoritative; without it, compatibility mode
uses a uniquely discoverable existing `Bridge 2.0 Recovery` folder or falls back
to local state rather than embedding an account identifier in source. The
compatibility surface does not rename or weaken the versioned `bridge_v2_*` job
tools.

## 10. Transports

The local default is MCP stdio: one child server process per client session, JSON-
RPC on stdin/stdout, diagnostics on stderr only.

Remote mode uses MCP Streamable HTTP at one authenticated endpoint. The proposed
server validates `Origin`, binds localhost when used locally, uses TLS remotely,
and binds MCP session IDs to Bridge session/principal/host identity. Legacy
HTTP+SSE is excluded unless an owner-approved compatibility need appears.

References:

- https://modelcontextprotocol.io/specification/2025-11-25/basic/transports
- https://json-schema.org/draft/2020-12

## 11. Drive replication and GitHub source backup

Proposed responsibility split:

- GitHub: private complete sanitized source history, tags, schemas, docs, synthetic
  fixtures, and migrations. Commit history is not pruned.
- Drive recovery root: immutable verified recovery packages, encrypted runtime
  snapshots, audit archives, manifests, historical archives, and restore reports.
- Local working directory: live Git working tree, database, event journal, runtime
  cache, leases, browser state, and credentials.

Drive never hosts a live Git repository, SQLite database, active lease file, or
shared mutable state. GitHub never receives runtime snapshots or source artifacts.
Artifact metadata may identify `github_source` only for `source_code` artifacts at
public/internal sensitivity; prompts, evidence-like sources, attachments, backups,
and generated work products are structurally excluded.

GitHub setup, authentication, remote creation, and push are deferred until after
the first implementation phase. This draft records the private-source-history
responsibility but does not authorize GitHub operational setup in the revision
window or initial implementation launch.

## 12. Active generation and split-brain prevention

Each project has exactly one writable active generation. Every event, claim, and
backup records it. Normal restart retains the generation. Owner-confirmed takeover
or restore advances it monotonically and invalidates old fencing tokens.

Remote HTTP uses a single authoritative service/store for generation allocation.
Drive is replication only and cannot arbitrate writers. Offline peers may read
snapshots but may not both become writers. Forced takeover requires an approval
record and a later reconciliation report.

## 13. Backup, restore, migration, and doctor

Backup:

1. A `source_only` backup may capture a dirty tree only as an explicit owner
   exception recorded with an approval-grant reference, reason, and owner identity,
   and contains only source/configuration material. A `full` backup
   requires a clean tree, quiescence/checkpoint, and a state snapshot.
2. Capture source commit, generation, event high-water mark, content hashes,
   sensitivity, encryption mode, opaque key reference, wrapped-key capsule
   reference, recovery-procedure reference, and destinations.
3. Verify each replica after write and retain the manifest locally and in Drive.
   GitHub is not a backup-manifest destination; source reaches it through normal Git
   history only.

Restore:

1. Verify manifest, hashes, encryption access, source commit, and event sequence.
2. Restore into a new isolated destination.
3. Run schema migrations and doctor without activating.
4. Run contract tests.
5. For takeover, record owner approval and advance generation.
6. Activate only after all checks pass; preserve a restore report.

Confidential/restricted packages use AES-256-GCM with a fresh 256-bit data key.
That key is wrapped in a canonical RSA-OAEP-SHA-256 capsule. The manifest binds the
capsule hash and recipient SPKI fingerprint while retaining only opaque key and
Drive account references. D-024 permits byte-identical private recovery-key copies
in exact configured local-runtime and Drive recovery-key directories. Private or
raw data-key bytes remain forbidden in GitHub, manifests, logs, prompts, audit
records, and source trees. Rotation and lost-key drill cadence remain deferred.

Migration:

- Migrations are ordered, checksummed, forward-only in normal operation, and tested
  from the latest supported backup.
- A pre-migration backup is mandatory.
- Downgrade is restore-based unless a specific reversible migration exists.

Doctor reports machine-readable checks for identity binding, permissions, schema
version, migration status, event sequence/hash continuity, generation/fencing,
stale claims, adapter health, Git remote privacy, Drive path/replica verification,
backup age, and secret-file placement. Doctor is read-only unless an explicit
`--repair` operation is separately approved.

## 14. Deferred or excluded functionality

- No production storage engine, HTTP server, auth provider, browser automation,
  cloud deployment, synchronization service, or paid resource.
- No legal/procedural reasoning engine.
- No automatic outbound browser action.
- No multi-primary or Drive-based live coordination.
- No approval UI; scoped approval-grant policy is contract-only.
- No automatic retention deletion or purge job.
- No promise of backward compatibility before owner approval.
- No GitHub setup, authentication, remote creation, or push before the first
  implementation phase closes.

## 15. Assumptions requiring confirmation

- A single owner controls active-generation takeover.
- Local-first operation is the default; remote HTTP is optional.
- The Procedural Guidance System can consume JSON Schema and an in-memory mock.
- Artifact bytes can remain outside Bridge while metadata is sufficient for jobs.
- A private GitHub repository and local Drive mirror are acceptable recovery legs.
- The owner will select remote authentication, deferred key-rotation policy details,
  retention/legal-hold rules, and supported migration window before those features
  are implemented.

## 16. Conditional Phase 1 authorization

The owner conditionally authorizes the Bridge runtime and Procedural Guidance
Phase 1 implementation windows to launch automatically only after all gates are
proven: this revision is committed, the full existing test and scan suite passes,
a focused independent Claude review of this exact delta closes with no unresolved
material finding, the worktree is clean, and no Bridge leases remain. If any gate
is not proven, implementation remains unauthorized and the exact blocker controls.
