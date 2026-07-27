# Claude Code Revision Review — Bridge 2.0 Contract `0.1.0-draft.2`

Status: INDEPENDENT REVIEW RECORD (focused revision red team)

Reviewer: Independent Claude Code architecture reviewer
Review date: 2026-07-12
Target commit: `e5d30a8` ("draft contract 0.1.0-draft.2 for focused review")
Working tree at review: clean (no local modifications)

This is an independent architecture/contract red team of the committed
`0.1.0-draft.2` owner-decision revision. It authorizes no implementation, freezes
no version, and does not declare the draft approved. Material disagreements are
preserved. Findings are separated from preferences, and defects are distinguished
from unresolved owner policy.

## Scope and method

Reviewed inputs (all at `e5d30a8`):

- `docs/DECISION_REGISTER.md` (D-001…D-020)
- `docs/architecture/DRAFT-CONTRACT.md`
- `docs/architecture/IDENTITY-ROLES-SECURITY.md`
- `docs/architecture/ADAPTERS-MCP-TRANSPORTS.md`
- `docs/architecture/RECOVERY-MIGRATION-DOCTOR.md`
- `docs/adr/0001…0002…0004…0005…0006`
- `contracts/v0.1.0-draft.2/**` (README, EVENT-HASHING, AUDIT-MIRROR, 11 schemas, 11 examples)
- `mock-client/index.mjs`
- `test/contract/{schemas,mock-client,node-sqlite}.mjs`

Test commands in scope (declared in `package.json`):

- `npm run contract-test` → `node test/contract/node-sqlite.mjs && node test/contract/schemas.mjs && node test/contract/mock-client.mjs`
- `npm run test:all` → `npm test && npm run connectors-test && npm run contract-test`

Execution note: this session runs under safe-mode restrictions that deny command
execution, so `npm run contract-test`/`npm run test:all` were **not executed**;
the three contract test files were reviewed **statically** against the schemas and
mock. No case data, credentials, browser state, authenticated sessions, or external
repositories were accessed. Bridge MCP/CLI coordination was disabled.

## Accepted architecture positions (concur; not defects)

These represent real improvements over `0.1.0-draft.1` and address prior review
findings; I concur with them as architecture, subject to the open policies below.

1. Transactional SQLite/WAL as the local authoritative store plus an immutable
   ordered event journal (D-003/D-004). `node:sqlite` `DatabaseSync` with WAL,
   atomic rollback, and `integrity_check` is exercised by `test/contract/node-sqlite.mjs`
   with no external DB package (`package.json` has no sqlite dependency) and no
   remote multi-writer claim (ADR 0001 keeps the allocator storage-agnostic). Focus 7: coherent.
2. GitHub is excluded from backup destinations **structurally**: `backup-manifest.schema.json:151`
   restricts destination `kind` to `["local","drive"]`; there is no GitHub sink. Focus 5.
3. Confidential/restricted content encryption is structural: `backup-manifest.schema.json:201-229`
   forces `mode:"aes-256-gcm"` plus `keyRef` and `wrappedKeyCapsule` whenever any
   content item is `confidential`/`restricted`; the capsule mandates
   `storageAccountRef` const `drive-account://recovery-key-account` and
   `decryptionSecretCustody` const `outside_drive_and_github` (`:116,:129`). Focus 6.
4. Recovery-drill non-activation is structural: `restore-manifest.schema.json:110-131`
   forces `no_takeover` and forbids an `activate` step for `recovery_drill`; monotonic
   takeover is exercised by the `restoreSemantics` vectors in `schemas.mjs:118-137`. Focus (D-015/D-017).
5. Provenance-derived independence is now implemented: `mock-client/index.mjs:639-661`
   computes the effective exclusion set as declared exclusions ∪ every creator in the
   transitive provenance closure (`#provenanceClosure` `:716-728`), and claim-time
   enforcement rejects a non-independent reviewer (`:414-419`; test `mock-client.mjs:110-117`).
   This addresses prior F-3.
6. Scoped request-hash idempotency: `#once` (`mock-client/index.mjs:751-763`) scopes to
   `project|principal|operation|key` and rejects key reuse with a different request hash
   (test `mock-client.mjs:132-140`). Addresses prior F-6.
7. Fencing on claimed transitions: `#assertFence` (`:740-749`) rejects a stale
   generation/token even after takeover (test `mock-client.mjs:160-177`). Addresses prior F-5 on the job path.
8. Doctor closed category set of ten with `minItems:10` + ten `contains` clauses
   (`doctor.schema.json:35-137`); `repair_plan` is a distinct mode. Addresses prior F-12.
9. Adapter isolation invariants are structural: browser and any non-`none`
   credential adapter cannot use `in_process` (`adapter.schema.json:142-183`); browser/api
   require a non-empty `networkAccess`; `approvalPolicy.defaultDecision`/`scopeExpansionDecision`
   are const `ask`. Addresses prior F-9. Focus 4.

## Findings (ordered by severity)

### H-1 (High) — Action-authorization path binds and checks no consuming identity, role, or fencing token

The action/approval consumption path is the highest-risk surface (it authorizes
browser and external side effects), yet the executable authorization reference
performs no authorization of the *acting* principal.

- The approval-grant schema has no field binding a grant to the principal/session/host
  that may consume it. `approval-grant.schema.json:7-19` requires only `grantedBy`
  (the granter), `scope`, and `instructionBinding`; there is no subject/actor
  `principalRef`. The scope (`:38-141`) bounds job, actions, conditions,
  destinations, origins, side-effect classes, prompt classes, and `maxUses` — but
  not the consuming actor.
- `authorizeAction` (`mock-client/index.mjs:270-373`) and `#grantMatches`
  (`:692-714`) never reference `actor`: no role check, no claim/lease check, no
  generation/fencing check. Any caller — including a principal with no project
  role, an `observer`, or a reviewer excluded for independence — can invoke
  `authorizeAction` on a job, match an active grant, receive `decision:"allow"`,
  and consume a use (`:333-347`), emitting `approval_grant.consumed` and
  `browser.authorization_decided` events.
- This contradicts the contract prose. `DRAFT-CONTRACT.md:63-66` states approval
  grants are "bound to the three-part identity," and `IDENTITY-ROLES-SECURITY.md:33-34`
  repeats it; the schema and mock do not realize that binding. It also bypasses
  `DRAFT-CONTRACT.md:123-127` ("Every mutation after claim must present the claim
  ID, generation, and fencing token"): the authorization path emits journal events
  with no fencing, so a stale writer surviving a takeover can still consume grants
  and authorize actions.

Impact: an approval grant is effectively a job-wide bearer authorization consumable
by any caller with no post-takeover fencing. Because the mock + contract tests are
the declared reference for "authorization rules that cannot be expressed cleanly in
JSON Schema" (`contracts/v0.1.0-draft.2/README.md:8-9`), this omission is a
specification gap, not merely a mock simplification.

Remedy options for owner decision: (a) add a consuming-actor `principalRef` binding
to the grant and check it in the authorize path; and/or (b) require the authorize
path to present a valid claim (claimId + generation + fencing token) and the job's
`requiredRole`. At minimum reconcile the prose so it does not claim identity binding
the artifacts do not provide. Focus 2, 6, 8.

### M-1 (Medium) — Review results and disagreements are not journaled or mirrored

The `review_job.completed` event carries only `outcome`
(`event.schema.json:184-199`); `completeReviewJob` emits it with no audit context
(`mock-client/index.mjs:482-504`). The result artifact IDs and the `disagreements`
array live only in mutable `job.result` (`review-job.schema.json:159-181`). No event
type records findings/disagreements (enum `event.schema.json:32-52`), and the audit
mirror entry for the completion event has empty `outcomes`/`citations`.

Impact: the append-only journal and the non-operational audit mirror — the tamper-
evident, restore-surviving records — do not contain the review's result artifacts or
disagreements. This weakens the system's central "preserve disagreements" guarantee
(AGENTS.md; D-020) and the audit/replay value asserted in D-004, since a state
snapshot or its loss, not the immutable stream, is the only carrier of disagreements. Focus 1.

### M-2 (Medium) — Audit-mirror completeness is opportunistic, not per-event

`#appendAuditMirror` (`mock-client/index.mjs:802-819`) only populates
`instructionSets`/`approvals`/`actions`/`outcomes`/`citations` when the emitting
method passes an `auditContext`. Approval/action emissions do so; `review_job.claimed`,
`started`, `input_*`, `completed`, `failed`, `cancelled`, `claim_expired`, and
`project.generation_advanced` pass nothing, so those entries carry empty typed
arrays. `AUDIT-MIRROR.md:5-9` and Focus 1 describe the mirror as preserving
"complete typed … envelopes … associated with that event"; the schema permits empty
arrays (`audit-mirror-entry.schema.json:30-55`), so the "complete" claim is only
partially realized and is not enforced. Recommend the owner define, per event type,
which typed snapshots are mandatory. Focus 1.

### M-3 (Medium) — Any instruction amendment silently invalidates grant matching, but only material amendments are audited

`#grantMatches` requires the grant's `instructionBinding.version` to equal the job's
**current** instruction version (`mock-client/index.mjs:702-707`). `amendReviewJobInstructions`
increments the version on every amendment, material or not (`:145-157`), but only
revokes grants when `materialAmendment` is true (`:131-136`). Consequently a
**non-material** amendment leaves every existing grant at `status:"active"` while
making it permanently non-matching (all subsequent authorizations return `ask`),
with no `approval_grant.revoked` or other invalidation event emitted.

Impact: authority narrows silently (a safe direction), but grant status shown to an
owner (`active`) no longer reflects effective authority, and there is no audit event
marking the change. This partially satisfies but partly contradicts Focus 3
("invalidate approvals deterministically without silently … rewriting authority"):
the invalidation is deterministic yet silent and unlogged for non-material
amendments. The owner should decide whether non-material amendments must (a) preserve
grant matching, or (b) emit an explicit invalidation/deactivation event. Focus 3.

### M-4 (Medium) — Grant origins/destinations are not constrained to the adapter's declared network allowlist

The adapter manifest declares `security.networkAccess` (`adapter.schema.json:82-86`),
and a grant independently declares `scope.origins`/`scope.destinations`
(`approval-grant.schema.json:115-126`). Nothing in the schemas, and nothing in
`#grantMatches`, cross-checks that a grant's destinations/origins are a subset of the
adapter's declared allowlist (the mock has no adapters at all). An owner grant can
therefore authorize a destination the browser/api adapter never declared, defeating
part of the allowlist intent behind D-010/D-013. Recommend a structural or executable
subset check (grant destinations/origins ⊆ adapter `networkAccess`). Focus 2, 4.

### M-5 (Medium) — Artifact schema permits `github_source` for prompt/source/attachment/backup kinds at internal sensitivity

The artifact schema blocks `github_source` only for kinds `response`/`review`/`decision`/`report`
(`artifact.schema.json:159-181`) and for `confidential`/`restricted` sensitivity
(`:117-158`). A `prompt` (or `source`/`attachment`/`backup`) artifact at `public`/`internal`
sensitivity may declare a `github_source` location. Prompts are exactly the
"sensitive task prompts" that D-002 excluded from the sanitized baseline. Because
artifact records carry hashes/metadata rather than bytes, this is a metadata/location
exposure rather than raw-byte leakage, but it means the "GitHub never receives case
information" guarantee (`DRAFT-CONTRACT.md:24-25`, `:213`) relies on correct
sensitivity/kind classification, not on a structural bar. Recommend the owner decide
whether `prompt`-kind artifacts may ever be `github_source`. Focus 5.

## Lower-severity findings and observations

- **L-1 (Low) — `node:sqlite` is experimental.** ADR 0001 and `node-sqlite.mjs` pin
  the authoritative store to Node's built-in `node:sqlite` (`DatabaseSync`), which is
  an unstable/experimental API subject to change across Node releases; neither ADR
  0001 nor the register records this stability risk as an accepted cost. Focus 7.
- **L-2 (Low) — Instruction text stored verbatim in the mirror.** Instruction
  `text` (up to 16000 chars, `common.schema.json:58`) is projected verbatim into the
  JSONL audit mirror via `instructionSets` and can carry sensitive prompt context.
  Only whole-archive AES-256-GCM mitigates it; there is no field-level redaction, and
  redaction is a deferred policy (`AUDIT-MIRROR.md:18-20`). Consistent with the draft,
  but the owner should confirm this is acceptable. Focus 1.
- **L-3 (Low) — `source_only` dirty backup has no owner-exception attestation.**
  `DRAFT-CONTRACT.md:230-231` (§13.1) permits a dirty `source_only` backup "only as an
  explicit owner exception," but `backup-manifest.schema.json:185-200` records no
  approval/exception reference; `schemas.mjs:108-116` accepts a dirty source-only
  backup unconditionally. The attestation is not captured.
- **L-4 (Low, preference/ambiguity — not a clear defect).** Condition matching in
  `#grantMatches` (`mock-client/index.mjs:708-713`) is subset-based: an action that
  carries additional, unlisted condition attributes still matches. Whether an unbounded
  extra condition should force `ask` (scope expansion) versus be treated as
  "don't-care" is a semantic policy the register does not settle. Owner clarification,
  not necessarily a code change. Focus 2.
- **Observation — canonicalization sort.** `canonicalize` uses JS `Array.prototype.sort`
  (UTF-16 code-unit order) while `EVENT-HASHING.md:16-18` specifies ascending
  code-point order. These agree only because contract keys are ASCII; the ASCII-only
  key restriction is the load-bearing invariant and should be stated as an enforced
  guard, not an incidental property. Non-defect at present.
- **Observation — mock doctor never reports `ready`.** `mock-client/index.mjs:605`
  returns at best `degraded`. Mock-only behavior; not a contract defect.

## Focus-question dispositions (summary)

1. Audit mirror non-operational / no secret leakage: mirror is non-operational and
   never read for transitions (`AUDIT-MIRROR.md:5-9`); `excludedContentClasses` is a
   const set (`audit-mirror-entry.schema.json:56-59`); events carry no bytes. **Gaps:**
   result/disagreement journaling (M-1), opportunistic completeness (M-2), verbatim
   instruction text (L-2). Archive encryption is structural (accepted #3).
2. Grants revocable/auditable/bounded and every expansion returns `ask`: bounds and
   `ask`-on-expansion are present and tested (`mock-client.mjs:354-391`). **Gap:** no
   consuming-identity binding or fencing on the consume path (H-1), and no
   grant⊆adapter allowlist check (M-4).
3. Versioned instructions/material amendments invalidate deterministically without
   widening: never widens; material amendments revoke + emit events. **Gap:**
   non-material amendments silently invalidate matching without an event (M-3).
4. Bounded browser pre-approval authorizes only typed decisions: browser adapters
   cannot be `in_process`, require allowlists, default `ask`; grants bound to typed
   origin/destination/action. **Gaps:** M-4, and H-1 identity/fencing.
5. GitHub/Drive split prevents leakage into GitHub: backup destinations exclude
   GitHub structurally (accepted #2). **Residual:** prompt/source/attachment metadata
   may name `github_source` at internal sensitivity (M-5).
6. AES-256-GCM + opaque manifest reference + separately stored wrapped capsule:
   structurally enforced (accepted #3); `decryptionSecretCustody` const attests
   out-of-Drive/GitHub custody. Note this is an attested constant, not a mechanism;
   wrapping algorithm/secret medium/rotation remain deferred. Combined with H-1 fencing.
7. `node:sqlite`/WAL coherent local store, no hidden server, no remote multi-writer
   claim: satisfied (accepted #1). **Residual:** experimental-API risk (L-1).
8. Schemas/examples/mock/tests vs register: broadly consistent and no approved
   addition omitted, **except** the "bound to the three-part identity" claim
   (D-005/§3) is not realized by the approval-grant schema or mock (H-1).

## Unresolved policies requiring owner confirmation

Deferred in the register and still open (not requirements): remote authentication/
authorization provider and host-key requirement (D-005/D-012); approval-grant
presentation/UI and material-amendment materiality rules (D-005/D-006/D-013);
capsule wrapping algorithm, external secret medium, rotation, quorum/recovery actors,
lost-key drill cadence (D-016); retention/legal-hold/redaction/mirror-failure/owner-
access policy (D-004/D-020); supported migration window, RTO/RPO, backup and restore-
drill cadence (D-017); `hostnameHash` HMAC/salt policy (D-005; `IDENTITY-ROLES-SECURITY.md:12-13`);
compaction and the remote-deployment store (D-003/D-019).

Additional policy questions raised by this review: whether approval grants must bind
a consuming principal and be fenced (H-1); whether the authorize path requires a valid
claim and `requiredRole` (H-1); which typed snapshots are mandatory per event and
whether results/disagreements must be journaled (M-1/M-2); whether non-material
amendments deactivate grants with an event (M-3); whether grant destinations/origins
must be a subset of adapter `networkAccess` (M-4); whether `prompt`-kind artifacts may
ever be `github_source` (M-5); and acceptance of the experimental `node:sqlite`
dependency (L-1).

## Final recommendation

**Confirm after changes.**

The revised `0.1.0-draft.2` architecture is sound and is a clear, material
improvement over the first draft: provenance-derived independence, scoped request-hash
idempotency, job-path fencing, structural GitHub/backup separation, structural
confidential-content encryption with an out-of-custody capsule, recovery-drill
non-activation, and a closed ten-category doctor are all implemented and (statically)
consistent with the decision register. No fatal architectural defect was found, and
no approved addition was omitted.

However, before the owner removes the `-draft.N` suffix or authorizes implementation,
the action-authorization path should be reconciled: **H-1** (no consuming-identity
binding, role check, or fencing on grant consumption, contradicting §3/§6) is a
genuine authorization gap on the highest-risk surface, and **M-1/M-2/M-3** materially
affect the audit and preserve-disagreements guarantees that are the system's purpose.
These are correctable within the draft and do not require re-architecting. I do not
confirm the draft as ready in its current form, and I make no implementation handoff.
