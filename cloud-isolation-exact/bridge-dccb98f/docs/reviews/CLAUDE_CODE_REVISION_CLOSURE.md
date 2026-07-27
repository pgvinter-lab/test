# Claude Code Revision Closure Review — Bridge 2.0 Contract `0.1.0-draft.2`

Status: INDEPENDENT CLOSURE RECORD (narrow verification of disposition)

Reviewer: Independent Claude Code closure reviewer
Closure date: 2026-07-12
Target commit: `e34b12f` ("address focused Claude contract review")
Working tree at closure: clean (files reviewed at the committed state of `e34b12f`)

## Scope and method

This is a **narrow closure review**, not a re-run of the broad architecture red team.
It verifies only whether the dispositions recorded in
`CLAUDE_CODE_REVISION_DISPOSITION.md` for **H-1, M-1…M-5, L-3, L-4, and the
canonicalization observation** were actually realized in the committed artifacts,
and whether **L-2** was faithfully preserved rather than silently reversed.

Inputs read at `e34b12f`:

- `docs/reviews/CLAUDE_CODE_REVISION_REVIEW.md`, `docs/reviews/CLAUDE_CODE_REVISION_DISPOSITION.md`
- `mock-client/index.mjs`
- `contracts/v0.1.0-draft.2/schemas/{approval-grant,event,artifact,backup-manifest,audit-mirror-entry}.schema.json`
- `contracts/v0.1.0-draft.2/{EVENT-HASHING,AUDIT-MIRROR}.md`
- `test/contract/{mock-client,schemas}.mjs`
- `docs/architecture/{DRAFT-CONTRACT,IDENTITY-ROLES-SECURITY}.md`, `docs/adr/0001-storage-and-event-journal.md`, `docs/DECISION_REGISTER.md`

Execution note: this session runs under safe-mode restrictions that deny command
execution, so `npm run contract-test` / `npm run test:all` were **not executed**.
The mock and the three contract test files were reviewed **statically** against the
schemas. No case/custody data, credentials, browser state, authenticated sessions,
or external repositories were accessed; MCP/CLI coordination was disabled. No
implementation is authorized and no other file was modified.

## Per-finding closure

### H-1 (High) — Grant consumption binds and checks the consuming identity, role, claim, and fencing token — **CLOSED**

- Schema now binds the subject and the claim/fencing token structurally:
  `approval-grant.schema.json:13-19` requires `grantedTo`, `requiredRole`,
  `claimBinding`, and `instructionBinding`; `claimBinding` requires
  `claimId`/`generation`/`fencingToken` (`:159-169`); `scope.adapterIds`
  (`:63-70`) is required with `minItems:1`.
- The authorize path now performs actor, fencing, and role checks **before** scope
  matching: `authorizeAction` calls `#assertFence(job, claim)`
  (`mock-client/index.mjs:350`), rejects a non-claimant actor
  (`:351` → `actor_not_claimant`), and requires the job's `requiredRole`
  (`:352` → `required_role_missing`). `#assertFence` (`:829-838`) rejects a claim
  whose `claimId`/`fencingToken`/`generation` does not match the active claim and
  current generation.
- `#grantMatches` (`:758-796`) additionally re-verifies `grantedTo === actor`
  (`:762`), `requiredRole` equality plus live role (`:763`), the full claim binding
  (`:764-768`), and the instruction binding (`:781-786`).
- Grant creation binds the subject to the claimant and requires the role:
  `createApprovalGrant` rejects a `grantedTo` that is not the claimant
  (`:229-231` → `approval_subject_not_claimant`) and a subject lacking
  `requiredRole` (`:232-234`).
- Prose is now consistent with the artifacts (the review's prose contradiction is
  resolved): `DRAFT-CONTRACT.md:63-66` and `IDENTITY-ROLES-SECURITY.md:33-34` now
  describe binding to the consuming principal/session/host, required role, adapter,
  and claim/generation/fencing token.
- Tests exercise the gap: non-claimant rejection (`mock-client.mjs:387-401`), stale
  post-takeover fencing rejection (`:551-566`), and the negative schema cases for a
  missing `grantedTo` / empty `adapterIds` (`schemas.mjs:77-78`).

Minor robustness observation (not a defect): if a caller omits `claim` entirely,
`#assertFence` dereferences `claim.claimId` and throws a `TypeError` rather than a
named contract error. The path still fails closed (no grant is consumed), so this is
a cleanliness nit, not an authorization gap.

### M-1 (Medium) — Review results and disagreements are journaled and mirrored — **CLOSED**

- The immutable event now carries results, disagreements, and citations:
  `event.schema.json:184-218` closes `review_job.completed.data` with required
  `outcome`, `artifactIds` (`minItems:1`), `disagreements`, and `citations`.
- `completeReviewJob` enforces the audit fields (`mock-client/index.mjs:537-540`)
  and emits them (`:561-566`), and writes a typed completion `outcome` carrying
  `artifactIds` into the mirror (`:555-560, :566`).
- Tests confirm the disagreement survives in the immutable stream and the mirror:
  `mock-client.mjs:590-593` asserts `completedEvent.data.disagreements.length === 1`
  and the matching mirror entry has `outcomes.length === 1`.

### M-2 (Medium) — Audit-mirror completeness is now per-event and enforced — **CLOSED**

- Completeness is now **structural**, not opportunistic:
  `audit-mirror-entry.schema.json:85-147` requires `instructionSets minItems:1` for
  any `review_job.*` event, `approvals minItems:1` for any `approval_grant.*` event,
  `actions`+`outcomes minItems:1` for `browser.authorization_decided`, and
  `outcomes minItems:1` for `review_job.completed`.
- The mock auto-populates the mandatory snapshots even when a method passes no
  explicit context: `#emit` injects the current instruction set for `review_job`
  aggregates (`mock-client/index.mjs:889-892`) and the grant for `approval_grant`
  aggregates (`:893-896`).
- `AUDIT-MIRROR.md:22-31` records the mandatory snapshot matrix, replacing the prior
  "opportunistic" language.
- Tests validate every mirror entry against the schema (`mock-client.mjs:633-636`)
  and assert the per-family minima directly (`:586-589`).

### M-3 (Medium) — Non-material amendments no longer silently invalidate grants — **CLOSED** (conservative rule; owner ratification noted)

- `amendReviewJobInstructions` now revokes **every** active grant on the job on
  **any** version bump, material or not, and emits `approval_grant.revoked` for each
  (`mock-client/index.mjs:148-159`, `#revokeGrant` `:744-756`), then records the
  invalidated IDs on the new instruction set and the amendment event
  (`:170, :175-181`). The silent-but-active state the review flagged is gone.
- Tests cover both branches: a material amendment revokes its grant
  (`mock-client.mjs:500-509`) and a **non-material** amendment likewise revokes its
  grant and lists it in `invalidatesApprovalGrantIds` (`:526-534`).

No disagreement. As the disposition itself flags (`DISPOSITION.md:17`), the choice to
revoke on non-material amendments is a **conservative draft policy** the owner must
ratify — it is safe (authority only narrows) and now fully audited, so it closes the
finding, but it remains an owner policy decision rather than a defect fix.

### M-4 (Medium) — Grant origins/destinations constrained to the adapter allowlist — **CLOSED** (at the executable-reference level)

- Grants now name adapters and are checked against their declared allowlist at
  creation: `createApprovalGrant` requires each `adapterId` to be registered and
  every origin/destination to be in `adapter.security.networkAccess`
  (`mock-client/index.mjs:243-250` → `approval_scope_outside_adapter_allowlist`).
- Consumption re-checks the same subset against the live adapter allowlist:
  `#grantMatches` (`:769-773`).
- Tests cover the rejection (`mock-client.mjs:353-370`, unlisted destination) and the
  positive path (`:371-386`).

The subset relation is inherently a cross-object rule that JSON Schema cannot express,
so it is enforced only in the executable reference. That is consistent with
`contracts/v0.1.0-draft.2/README.md`'s statement that the mock is the reference for
rules not expressible in schema; I record it as closed with that scope noted.

### M-5 (Medium) — `github_source` restricted to public/internal `source_code` — **CLOSED**

- `artifact.schema.json:183-203`: if any location has `storageClass:"github_source"`,
  then `kind` must be `const "source_code"` and `sensitivity` must be
  `public`/`internal`. Prompts, generic sources, attachments, backups, and generated
  outputs can no longer name a GitHub source, at any sensitivity.
- Tests: rejection of a `github_source` location on the default (non-source-code)
  artifact (`schemas.mjs:56-58`), rejection of `kind:"prompt"` + `github_source`
  (`:59-63`), and acceptance of `source_code`/`internal` + `github_source`
  (`:110-116`).

### L-3 (Low) — Dirty `source_only` backup requires an owner-exception attestation — **CLOSED**

- `backup-manifest.schema.json:215-227`: a `source_only` backup with `dirty:true`
  requires `ownerException`, whose object requires `approvalGrantId`, `reason`, and
  `approvedBy` (`:163-176`).
- Tests: acceptance of an attested dirty source-only backup (`schemas.mjs:128-145`)
  and rejection when `ownerException` is deleted (`:146-149`).

### L-4 (Low) — Extra condition keys force `ask` — **CLOSED** (conservative rule; owner ratification noted)

- `#grantMatches` now requires exact condition-name set equality: it compares the
  canonicalized sorted expected vs. actual condition names and returns `false`
  (→ `ask`) on any difference (`mock-client/index.mjs:787-789`) before evaluating
  operators (`:790-795`).
- Test: an action carrying an extra `unapproved_flag` condition returns
  `decision:"ask"` (`mock-client.mjs:443-455`).

The review classified L-4 as a preference/ambiguity rather than a clear defect; the
disposition resolves it toward the safe (exact-match) reading. No disagreement; this
is an owner-ratifiable semantic choice, now settled and tested.

### Observation — canonicalization sort — **CLOSED**

- `canonicalize` no longer relies on JS default `sort`; it sorts keys with
  `compareUnicodeCodePoints`, which iterates by code point via
  `Array.from(...codePointAt(0))` and compares scalar values
  (`mock-client/index.mjs:21, :27-34`).
- `EVENT-HASHING.md:16-18` now specifies comparing Unicode scalar values, not UTF-16
  code units, and references a supplementary-plane vector.
- Test: `schemas.mjs:122-126` asserts a BMP key (`U+E000`) sorts before a
  supplementary-plane key (`U+10000`) — the exact case JS default UTF-16 ordering
  would get wrong (the `U+10000` surrogate lead `0xD800` sorts below `0xE000`).

The review's underlying caution — that ASCII-only keys were the load-bearing
invariant — is now moot because ordering is correct across the whole code-point
range; the frozen hash vectors are still pinned (`schemas.mjs:118-121`).

## Preserved position

### L-2 (Low) — Verbatim instruction text in the mirror — **FAITHFULLY PRESERVED**

- The disposition (`DISPOSITION.md:21, :30-33`) states L-2 is preserved with no
  contract reversal because owner decision D-004 requires complete instruction
  envelopes; redaction remains deferred.
- The artifacts match that statement: the mirror still snapshots the full instruction
  set including its `text` (`mock-client/index.mjs:889-892, :907`), and
  `AUDIT-MIRROR.md:16-20` still keeps redaction/retention/owner-access **deferred**
  while requiring AES-256-GCM only for confidential/restricted archives. No
  field-level redaction was silently introduced, and the historical instruction
  record is not rewritten.

This is a faithful preservation, not a quiet reversal. The residual sensitivity risk
the review named is unchanged and remains an explicit owner acceptance item, exactly
as recorded.

## Disagreements with the disposition

None material. Two scope clarifications, already noted inline, are worth surfacing so
the owner is not misled:

1. **M-4** is enforced only in the executable reference (the subset rule is not
   expressible in JSON Schema and there are no adapters in the schema layer). The
   disposition's "creation checks … authorization rechecks" is accurate for the mock;
   an eventual implementation must carry the same check — it is not guaranteed by the
   schemas alone.
2. **M-3** and **L-4** close the findings by adopting conservative rules that the
   disposition itself marks "requires owner confirmation." They are correctly
   implemented and tested, but they encode owner policy choices, not merely defect
   repairs.

## Final recommendation

**Owner may confirm the revised draft.**

Every finding in scope for this closure — H-1, M-1, M-2, M-3, M-4, M-5, L-3, L-4, and
the canonicalization observation — is **closed** with structural and/or executable
evidence in the committed `e34b12f` artifacts, and **L-2** is **faithfully
preserved**. The conditions on which the prior independent review's "confirm after
changes" recommendation depended (H-1 identity/fencing binding; M-1/M-2/M-3 audit and
preserve-disagreements guarantees) have been satisfied.

This confirmation is subject to the owner **ratifying the policy choices** the
disposition already flagged as owner decisions — the all-amendment revocation rule
(M-3), the exact-condition-match rule (L-4), and continued acceptance of verbatim
instruction text in the mirror pending a redaction policy (L-2) — and to the broader
unresolved policies the prior review listed, which this narrow closure did not
reopen. This record authorizes no implementation and makes no implementation handoff.
