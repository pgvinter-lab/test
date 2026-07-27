# Independent Claude Code Architecture Review — Bridge 2.0

Status: DRAFT REVIEW — NOT AN APPROVAL. This document is the independent reviewer's
durable artifact. It does **not** approve, freeze, or authorize implementation of any
contract version. It records defects, preference disagreements, and owner decisions.

- Review target: contract `0.1.0-draft.1` at commit `99761297c4759717184a36c70e336208f6246585`.
- Request followed: `docs/reviews/CLAUDE_CODE_REVIEW_REQUEST.md`.
- Reviewer role: independent Claude Code reviewer. No implementation was performed.
- Data boundary honored: no credentials, browser state, live authenticated sessions,
  or case data were accessed or included. Only synthetic fixtures in the repo were read.
- Method: read every listed source (contract, five architecture docs, ADRs 0001–0007,
  decision register, all schemas + examples, mock client, both contract test suites,
  recovery/drive layout, implementation board, secret-scan record). Contract tests were
  **statically** reviewed (their assertions are explicit); runtime execution and the
  Bridge sync/claim/log/handoff steps could not run because MCP and CLI calls were not
  granted permission in this session — see "Process notes" at the end.

Severity legend: **High** = would let incompatible/insecure implementations pass or
breaks a stated security/recovery invariant; **Medium** = real gap needing a contract or
test change; **Low/Info** = clarity/robustness; **Disagreement** = preference-dependent.

---

## Summary of findings

| ID | Sev | Area | One-line |
|---|---|---|---|
| F-1 | High | Provenance/leak | Event `data` is an open object; "no secrets/source bytes in events" is unenforced and untestable |
| F-2 | High | Interop/recovery | Event hash algorithm + canonicalization unspecified; hash-chain is not interoperable and doctor continuity is undefined |
| F-3 | High | Reviewer independence | Independence is a hand-supplied exclusion list, not provenance-derived; claimer role/waiver authority never checked |
| F-4 | High | Backup / Drive-GitHub split | Schema forbids the dirty/source-only exception the prose allows; and permits runtime snapshots to a GitHub destination |
| F-5 | High | Split-brain/fencing | Restore/takeover generation monotonicity is unenforced in the manifest; drill vs takeover not made exclusive |
| F-6 | Med | Idempotency | Scope is a raw string, not project+principal+operation; different-content replay returns stale result instead of erroring |
| F-7 | Med | Lifecycle | `awaiting_input`/`failed`/`cancelled`/`queued→claimable` unimplemented+untested; no failure-reason field |
| F-8 | Med | Identity privacy | `hostnameHash` called "non-reversible" but is an unsalted SHA-256 of a low-entropy hostname |
| F-9 | Med | Adapter isolation | Schema lets a browser/credentialed adapter run `in_process` and lets irreversible ops skip human approval |
| F-10 | Med | Artifact storage | Restricted artifacts may declare `github_source` or unencrypted `drive_replica` locations |
| F-11 | Med | Versioning | `const` schemaVersion gives no forward/version negotiation; contradicts the README compatibility rule |
| F-12 | Low | Doctor | Doctor conformance does not require the full mandatory checklist; mock doctor output does not match its own schema |
| F-13 | Low | Lifecycle | `result.artifactIds` may be empty on `completed` though prose says completion "requires result artifact IDs" |
| F-14 | Low | Session | Sessions may be non-expiring; transport-session↔identity binding is not schema-visible or tested |
| F-15 | Info | Identity | `identifier` pattern permits an authorization ID equal to a display label (e.g., `principalId: "codex"`) |

Preference disagreements: D-A (SQLite vs append-only / remote-store foreclosure),
D-B (GitHub as a backup destination at all), D-C (require ≥1 result artifact).

---

## High-severity findings

### F-1 (High) — Event `data` is unconstrained; the "no secrets / no source bytes in events" invariant is unenforced and untestable
- Where: `contracts/v0.1.0-draft.1/schemas/event.schema.json:61` (`"data": { "type": "object" }`, no `additionalProperties`, no per-`eventType` shape); asserted invariant in `docs/architecture/DRAFT-CONTRACT.md:116` ("Source bytes are not embedded in events…") and `contracts/v0.1.0-draft.1/README.md:14-19`; `mock-client/index.mjs:184-206` emits `data` with no redaction.
- Why it matters: A conformant producer can place case data, credentials, or source bytes into `data` and still pass every schema and contract test. Requirement #4 (sensitive-data leakage) and #10 (incompatible/unsafe implementations both pass) are directly triggered. The README even says consumers "may ignore unknown event `data` fields" — but no known fields are defined for any event type, so `data` is 100% unvalidated.
- Proposed contract/test change: Define a closed per-`eventType` `data` catalog (a `oneOf`/`if-then` keyed on `eventType`, each branch `additionalProperties:false`). At minimum, add (a) a max-size bound on `data`, (b) an explicit assertion/documented producer obligation that `data` contains no `content`/`bytes`/secret-shaped fields, and (c) a rejection test that an event carrying a base64 blob or a `sha256`-preimage in `data` is rejected. Owner decision: the canonical event/`data` catalog is a blocking design artifact.

### F-2 (High) — Event hash algorithm and canonicalization are unspecified → hash-chain is not interoperable; doctor "hash continuity" is undefined
- Where: `event.schema.json:62-67` constrains only the *shape* of `previousHash`/`hash` (64 hex chars); the *preimage* and algorithm are nowhere specified. `mock-client/index.mjs:204` computes `sha256(JSON.stringify(base))` — insertion-ordered, non-canonical JSON. `contracts/.../examples/event.valid.json:24` uses a placeholder hash (`2222…`), so no test ever verifies a real hash. Doctor requires "event sequence and hash-chain continuity" (`docs/architecture/RECOVERY-MIGRATION-DOCTOR.md:44`, DRAFT-CONTRACT §13).
- Why it matters: Two implementations that order keys differently, format numbers/unicode differently, or include a different field set will produce different hashes for identical events. Cross-implementation replay, restore verification, and tamper detection cannot agree — a silent interop break (requirement #10) and a recovery-integrity hole (#9).
- Proposed contract/test change: Specify exactly — algorithm (SHA-256), canonicalization (e.g., RFC 8785 JCS or an explicitly documented sorted-key, UTF-8, whitespace-free encoding), and the covered field set (the full envelope **minus** `hash`, including `previousHash`). Add a contract test with a frozen vector: fixed event object → fixed expected hash, plus a chain-continuity test that recomputes and links `previousHash`.

### F-3 (High) — Reviewer independence relies on a hand-supplied exclusion list and never verifies claimer role or waiver authority
- Where: DRAFT-CONTRACT §4:61-62 and `docs/architecture/IDENTITY-ROLES-SECURITY.md:25-27` ("Independence is evaluated per job using excluded principal IDs and target provenance"); `docs/architecture/REVIEW-JOBS-AND-PROVENANCE.md:11-14`; `review-job.schema.json` `independence` block (`excludedPrincipalIds` is free input); `mock-client/index.mjs:52-57`.
- Why it matters (three distinct gaps):
  1. **No provenance derivation.** `CreateReviewJob` accepts `excludedPrincipalIds` verbatim and never cross-references the target artifacts' `createdBy` (`artifact.schema.json:43`). An author can create an "independent_review" job that simply omits their own principal, then claim and complete it — self-review that passes every check. The prose promises "target provenance"; nothing computes it.
  2. **No role check.** The mock enforces independence only when `policy==="required"` and only tests `principalId` membership; it never verifies the claimer holds the `reviewer` role (`requiredRole`), and ignores session/host. Role enforcement — a core requirement (D-006, IDENTITY-ROLES table) — is unimplemented in the reference client and untested.
  3. **No waiver authority.** `policy: "waived_by_owner"` requires a `waiverReason` string but nothing verifies the waiver was recorded by an actual `owner` principal. Any job creator can set `waived_by_owner` and bypass independence.
- Proposed contract/test change: MUST require the service to compute the effective excluded set as `suppliedIds ∪ {createdBy.principalId for every artifact transitively reachable via target provenance}`; MUST verify `claimer.role == requiredRole` in the job's project scope; MUST verify a `waived_by_owner` waiver references an owner-authored approval record. Add tests: (i) author principal rejected even when absent from the supplied list, (ii) non-reviewer role rejected, (iii) non-owner waiver rejected. Owner decision: whether session/host also bind to independence, and the exact waiver-record format.

### F-4 (High) — Backup schema contradicts the contract's dirty/source-only exception, and permits runtime snapshots to a GitHub destination
- Where:
  - `backup-manifest.schema.json:46` (`"dirty": { "const": false }`) and `:51` (`"quiesced": { "const": true }`) vs DRAFT-CONTRACT §13:190-191 ("Refuse a dirty source tree **unless the owner explicitly chooses a source-only exception**"). The schema cannot represent the owner-approved exception the prose explicitly permits — a producer that implements §13 faithfully would emit a manifest the schema rejects.
  - `backup-manifest.schema.json:106` allows `destinations[].kind: "github"`; and `examples/backup-manifest.valid.json:29-52` pairs a `state_snapshot` (confidential) content with a `github` destination — directly contradicting §11:172-173 and ADR-0005 ("GitHub never receives runtime snapshots or source artifacts").
- Why it matters: Internal contradiction (#11 hidden assumptions) and a concrete confidential-runtime-to-GitHub leakage path (#4, #7) that the reference example actually demonstrates.
- Proposed contract/test change: (a) Reconcile §13 with the schema — either delete the source-only exception, or add `backupType: "source_only" | "full"` and make `dirty`/`quiesced` conditional on it (source-only MAY be dirty; full MUST be quiesced). (b) Constrain destinations: contents of kind `state_snapshot`/`event_log`/`artifact_index` MUST NOT be routed to a `github` destination; fix the example; add a rejection test.

### F-5 (High) — Restore/takeover generation monotonicity is unenforced in the manifest; recovery-drill and takeover are not mutually exclusive
- Where: `restore-manifest.schema.json:44` (`expectedSourceGeneration≥1`) and `:51` (`takeover.newGeneration≥1`) with no rule that `newGeneration > expectedSourceGeneration`. ADR-0007 and DRAFT-CONTRACT §12:177-184 require strictly monotonic, owner-confirmed takeover. The mock enforces monotonicity at runtime (`setGeneration`, `index.mjs:122-129`), but the manifest a fresh/replacement host validates does not — so a manifest reusing or lowering the generation (split-brain / fencing-token reuse) passes validation. Also `mode: "recovery_drill"` is not prevented from carrying `owner_confirmed_takeover` and an `activate` step.
- Why it matters: This is the central split-brain defense (#8, #9). A schema that admits a non-monotonic takeover manifest undercuts fencing on exactly the disaster-recovery path where two writers are most likely.
- Proposed contract/test change: Add a contract-test invariant (JSON Schema cannot compare two integer properties cleanly, so encode it executably) that `takeover.mode == owner_confirmed_takeover ⇒ newGeneration > expectedSourceGeneration`, and `mode == recovery_drill ⇒ takeover.mode == no_takeover AND steps contains no "activate"`. Add both a positive and a rejection fixture.

---

## Medium-severity findings

### F-6 (Med) — Idempotency scope and different-content reuse violate the stated contract
- Where: DRAFT-CONTRACT §6:96-98 and REVIEW-JOBS "Idempotency" ("scopes it to project + principal + operation"; "Reusing a key with different content is an error"). `mock-client/index.mjs:171-177` (`#once`) keys on a raw string only and returns the cached result **without** comparing a canonical request hash.
- Why it matters: (a) Two different principals reusing the same key string collide — one receives the other's cached result (cross-principal result bleed). (b) Reusing a key with *different* content silently returns the stale result instead of raising the specified error — a correctness hazard that masks bugs and could confirm the wrong job.
- Proposed contract/test change: Store idempotency under `(projectId, principalId, operation, canonicalRequestHash)`; on key match with a differing request hash, reject. Add tests for the collision and the different-content error. Owner decision: idempotency-record retention duration remains open (D-008).

### F-7 (Med) — Half the lifecycle is unimplemented/untested and failures cannot be represented
- Where: DRAFT-CONTRACT §5 table (states `queued`, `awaiting_input`, `failed`, `cancelled`). The mock implements only `claimable → claimed → running → completed` (`index.mjs`); there is no `makeClaimable` (the `queued→claimable` policy/dependency gate), `awaitInput`, `failJob`, or `cancelJob`, and no illegal-transition rejection tests. `review-job.schema.json` has no `failureReason`/`cancellation` fields, so "failed | terminal error with reason" (§5) is unrepresentable.
- Why it matters: An implementation could handle these transitions arbitrarily (or rewrite history on retry) and still pass the suite (#3, #10). `queued` and the dependency/policy gate — a stated safety step — are entirely unexercised.
- Proposed contract/test change: Add optional `failure {reason, retryable}` and `cancellation {reason, by}` objects with conditionals (`status==failed ⇒ failure required`; `status==cancelled ⇒ cancellation required`). Add mock methods + a transition matrix test covering every legal edge and representative illegal edges (e.g., `completed→running` rejected).

### F-8 (Med) — `hostnameHash` is claimed "non-reversible" but is an unsalted hash of a low-entropy value
- Where: DRAFT-CONTRACT §3:47 ("non-reversible hostname hash"); `principal.schema.json:144-146` (`hostnameHash` = bare `sha256`).
- Why it matters: Hostnames are low-entropy and enumerable; an unsalted SHA-256 is reversible by brute force / precomputation. The privacy claim is misleading and could give false assurance if a manifest or event leaks (#1, #4).
- Proposed contract/test change: Require an HMAC or salted hash using a per-install secret (persist only a salt/key reference, never the secret), or drop the "non-reversible" wording and treat `hostnameHash` as a pseudonymous label. Owner decision: is hostname privacy actually a requirement?

### F-9 (Med) — Adapter schema does not enforce the isolation/approval invariants the ADRs require
- Where: `adapter.schema.json`. (a) `kind: "browser"` (and any `credentialMode != none`) may still declare `transports: ["in_process"]`, violating ADR-0004 and §8 ("Browser adapters run out of process"); the example (`examples/adapter.valid.json:18`) itself lists `in_process`. (b) An operation with `sideEffectClass: "external_irreversible"` (`:49-51`) is not required to be covered by `security.humanApprovalFor` (`:89-100`), contradicting §8/ADR-0004. (c) `networkAccess` may be empty/absent even when `sensitiveData: "supported"`, leaving allowlist semantics undefined.
- Why it matters: These are the adapter/browser threat-boundary controls (#5). The schema currently lets a manifest declare a credentialed, in-process, irreversible-side-effect adapter with no approval and no network allowlist — all "valid."
- Proposed contract/test change: Add conditionals — `if kind==browser OR credentialMode!=none then transports MUST NOT contain in_process`; `if any operation.sideEffectClass==external_irreversible then humanApprovalFor MUST contain external_irreversible`; require `networkAccess` when `kind in {browser, api}`. Add rejection tests for each.

### F-10 (Med) — Artifact locations are not constrained by sensitivity/kind
- Where: `artifact.schema.json:61-76`. `storageClass: "github_source"` is allowed for any `kind`/`sensitivity`; `encrypted` is optional and never forced true for confidential/restricted. Contradicts §7:116 and §11:172-173.
- Why it matters: A `restricted` review/response artifact can legally declare a `github_source` location or an unencrypted `drive_replica`, contradicting the Drive/GitHub split and encryption-at-rest expectations (#4, #7).
- Proposed contract/test change: `if sensitivity in {confidential, restricted}`: forbid `github_source` locations and require `encrypted: true` on `drive_replica`/`remote_object`; `kind in {review, response, decision, report}` MUST NOT use `github_source`. Add tests.

### F-11 (Med) — `const` version pins preclude forward/version negotiation and contradict the README compatibility rule
- Where: every schema pins `"schemaVersion": { "const": "0.1.0-draft.1" }` (and `interfaceVersion`), vs README:10-13 ("Consumers reject unknown **major** versions and unknown required fields… may ignore unknown event data fields").
- Why it matters: With a `const`, any non-matching version fails validation wholesale — there is no major/minor split to "reject unknown major" against, and no negotiated overlap for migrating between `draft.N` and `draft.N+1`. The migration/compat story (§13, D-017) has no wire-level handshake (#9, #10, #11).
- Proposed contract/test change: Introduce `contractMajor`/`contractMinor` (or a documented `pattern` + an executable compatibility check), and specify the negotiation handshake. Owner decision: the supported-version window (D-017 is open).

---

## Low / informational

### F-12 (Low) — Doctor conformance is under-specified; mock doctor output does not match its own schema
- Where: `doctor.schema.json:35-65` — `checks` is a free array, so a `"ready"` result can omit the `secrets`, `github`, or `generation` category and still validate, even though §13 enumerates a mandatory checklist. Separately, the mock's `doctor()` (`index.mjs:139-152`) returns `{status, checks:{…}}`, which would **not** validate against `doctor.schema.json` — the doctor contract is never exercised against a conforming object.
- Proposed: Require ≥1 check per mandatory category (a `contains` per category, or an explicit `requiredCategories`). Add a doctor example + a test that validates a real doctor result.

### F-13 (Low) — `completed` allows an empty `result.artifactIds`
- Where: `review-job.schema.json:139-145` (no `minItems`); the mock test completes with `artifactIds: []` (`test/contract/mock-client.mjs:78`). §5 and REVIEW-JOBS say completion "requires result artifact IDs" — ambiguous whether ≥1 is meant. Preference-dependent; see D-C.

### F-14 (Low) — Non-expiring sessions and no visible transport-session binding
- Where: `principal.schema.json:103` (`expiresAt` optional → a session may never expire). §10/ADR-0003 require MCP-session↔Bridge-identity binding, but no schema field or test represents it. Owner decision: session lifetime/revocation (already listed open in IDENTITY-ROLES).

### F-15 (Info) — `identifier` pattern permits authorization IDs equal to display labels
- Where: `common.schema.json:6-11`. Nothing prevents `principalId: "codex"`. §3 says labels are not identities, but the schema cannot distinguish them. Consider mandating namespaced prefixes (`principal.`, `session.`, `host.`) as a MUST to match the examples' own convention and reduce confusion/spoofing.

---

## Preference-dependent disagreements (preserved per request)

- **D-A — Authoritative store (re: D-003 / ADR-0001).** I concur SQLite/WAL is a sound
  local-first choice and fixes the 1.x race/revision gaps. Disagreement to preserve:
  the fencing/generation allocator assumes a *single* authoritative writer. If remote
  HTTP mode (D-012) is ever approved, SQLite either becomes the bottleneck or reintroduces
  the multi-writer arbitration problem the design exists to kill. Recommendation: record
  now that "SQLite for local" must not foreclose a server-authoritative store for remote,
  and keep the generation-allocation interface storage-agnostic. This is advice, not a defect.

- **D-B — GitHub as a backup *destination* (re: F-4).** My preference is to remove `github`
  from backup `destinations` entirely and keep GitHub strictly for source history/tags,
  eliminating a whole class of runtime-to-GitHub leakage. A reasonable owner may prefer
  belt-and-suspenders redundancy. Preserve as a disagreement; either way, F-4's constraint
  (no runtime-snapshot content to GitHub) should hold.

- **D-C — Require ≥1 result artifact on completion (re: F-13).** I lean toward requiring at
  least one result artifact so a "completed" review always has a durable output; others may
  want to allow a purely-disagreement completion with no new artifact. Preference-dependent.

---

## Decisions the owner must resolve before implementation

1. Canonical event/`data` catalog and enforced exclusion of secrets/source bytes (F-1).
2. Event hash algorithm + canonicalization spec, with a frozen test vector (F-2).
3. Provenance-derived independence, claimer-role binding, and waiver-authority rules (F-3).
4. Reconcile backup dirty/source-only exception with the schema; GitHub-destination policy (F-4).
5. Restore/takeover generation-monotonicity invariant; drill-vs-takeover exclusivity (F-5).
6. Idempotency scope (project+principal+operation+request-hash) and retention duration (F-6, D-008).
7. Representation of `failed`/`cancelled` (reasons) and the `queued→claimable` policy gate (F-7).
8. Whether hostname privacy is a requirement; if so, salted/HMAC hashing (F-8).
9. Adapter isolation/approval conditionals: no in-process credentialed/browser adapters;
   irreversible ops require human approval; network allowlist required (F-9).
10. Artifact location/sensitivity constraints (no `github_source`/unencrypted restricted) (F-10).
11. Version-negotiation model to replace the `const` pins; supported-version window (F-11, D-017).
12. Still-open blocking items already in the register: encryption key custody (D-016),
    retention/deletion policy (D-020), remote authentication provider (ADR-0002/0003).

---

## What the draft gets right (context, not endorsement)

The three-part principal/session/host envelope, monotonic generation + fencing token on
every claimed mutation, append-only disagreements with owner disposition, out-of-process
adapter intent, the Drive-immutable / GitHub-source / local-live separation, and the
staged isolated-restore-before-activate flow are all coherent responses to the carried-forward
1.x findings (`BRIDGE-1X-REVIEW-INPUTS.md`). The mock correctly demonstrates the independence
exclusion, idempotent claim replay (no duplicate event), fencing rejection after a generation
advance, and event-sequence continuity. These strengths do not offset the High findings above,
which are mostly *gaps between the prose and what the schemas/tests actually enforce*.

---

## Process notes (transparency)

- Per the review request, "Done when the response is durable in `docs/reviews/`." This file is
  that durable artifact. Only this file was written; no other file was edited.
- The Bridge protocol steps (`bridge_sync`, `bridge_claim`, `bridge_log`, `bridge_release`,
  `bridge_handoff`) and the read-only test executions (`node test/contract/*.mjs`) could not be
  run: the Bridge MCP tools and the `bridge` CLI both returned ungranted-permission/approval
  errors in this session, and Bash execution of the test files was likewise not approved. The
  contract tests were therefore reviewed **statically**; their assertions are explicit and are
  cited directly above. If the architecture window can run `bridge_log`/`bridge_release`/
  `bridge_handoff` on this reviewer's behalf, please attach the review-file path and hand back
  to codex. No claim of test *execution* is made here — only static review.
- No credentials, browser state, live sessions, or case data were accessed. No implementation
  was performed. This draft is **not** approved or ready; it awaits owner disposition via
  `docs/reviews/REVIEW_DISPOSITION.md`.
