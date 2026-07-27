# Independent Claude Code Review — 0.1.0-draft.3 Owner-Policy Delta

Status: FOCUSED INDEPENDENT REVIEW (architecture/contract red team, not runtime)

Reviewer role: independent Claude Code reviewer for the owner-policy delta.

## Scope reviewed

- Reviewed base: `c62184f14617c4db6f8605738f998e05a169a494` (`record Claude closure
  review`), which carries contract `contracts/v0.1.0-draft.2/`.
- Working-tree target: the current uncommitted delta that introduces
  `contracts/v0.1.0-draft.3/` (untracked) plus modifications to `mock-client/`,
  `test/contract/`, decision register, architecture docs, and ADRs.
- Delta measured two ways: `git diff --stat` against the base for tracked files,
  and a direct `diff -ru contracts/v0.1.0-draft.2 contracts/v0.1.0-draft.3` for the
  new (untracked) contract tree.
- I did not access case data, credentials, browser state, authenticated sessions,
  or external repositories. I edited only this file.

## Test commands reviewed (statically) — not re-executed by me

- `npm run contract-test` and `npm run test:all` — the Codex preparation task
  reports both passed. I read the harnesses:
  - `test/contract/schemas.mjs` (AJV 2020, `strict: true`, valid + rejection cases,
    frozen hash vectors).
  - `test/contract/mock-client.mjs` (behavioral contract incl. override paths).
- Repository-local sensitive-marker scan: `docs/reviews/SECRET_SCAN_DRAFT3.md`
  records `NO_LOCAL_IDENTITY_OR_CASE_PATTERN_HITS` and
  `NO_SECRET_TOKEN_OR_PRIVATE_KEY_PATTERN_HITS_AFTER_SYNTHETIC_FIXTURE_FILTER`,
  with the single `data.secret` hit correctly dispositioned as the synthetic
  rejection fixture at `test/contract/schemas.mjs:86`. `gitleaks` was unavailable;
  the record discloses this and substitutes a pattern scan.

I reviewed these artifacts statically and did not re-run them, per instruction.

## Verification of every required boundary

### M-3 stays default (amendment revokes active grants)

VERIFIED. With no override:
- `contracts/v0.1.0-draft.3/schemas/event.schema.json:259-296`
  (`review_job.instructions_amended`) requires `invalidatedApprovalGrantIds`.
- Mock `mock-client/index.mjs:157-170` revokes every `active` grant scoped to the
  job on any amendment (material or not) when no override is present, and records
  each via `approval_grant.revoked`
  (`event.schema.json:328-345`, `invalidatedByInstructionAmendment`).
- `test/contract/mock-client.mjs:531-565` proves both a material and a
  non-material amendment revoke the bound grant by default.
- Prose is faithful: `docs/architecture/DRAFT-CONTRACT.md:109-113`,
  `docs/DECISION_REGISTER.md:149-152` (D-006 owner policy 2026-07-13).

### L-4 stays default (extra/unapproved conditions force ASK)

VERIFIED. With no override:
- Mock `mock-client/index.mjs:846-851` requires the condition-name set to match
  exactly; any extra key yields no match → `ask`.
- `test/contract/mock-client.mjs:474-486` proves an unapproved `unapproved_flag`
  condition returns `decision: "ask"`; origin expansion at 461-473 likewise.
- Prose faithful: `docs/architecture/DRAFT-CONTRACT.md:119-122,193-194`;
  `docs/DECISION_REGISTER.md:233-235` (D-010 owner policy 2026-07-13).

### Override is owner-only, job-scoped, immutable, non-retroactive, fully audited, limited to M-3 and L-4

VERIFIED at both schema and mock layers:
- Definition `contracts/v0.1.0-draft.3/schemas/common.schema.json:80-123`:
  `scope.overriddenRules` is `const ["M-3","L-4"]` (line 104-107);
  `immutableAfterCreation` is `const true` (110); `nonRetroactive` is `const true`
  (111); `preservedControls` is a fixed `const` list of the five protected control
  families (112-121); `additionalProperties:false` throughout.
- The override is attachable only on the review job
  (`review-job.schema.json:126-128`) and on the `review_job.created` event
  (`event.schema.json:133-135`) — i.e., at job creation. There is no schema path or
  mock method to attach or mutate it after creation.
- Owner-only + up-front construction is enforced by the mock, which ignores
  client-supplied scope/controls and rebuilds them server-side
  (`mock-client/index.mjs:774-806`): it rejects a non-owner-invoked override
  (`approval_policy_override_must_be_owner_invoked`, 777-779) and a non-owner
  principal (`owner_policy_override_required`, 780-782), and hardcodes
  `scope.jobId = jobId`, `overriddenRules = ["M-3","L-4"]`,
  `immutableAfterCreation/nonRetroactive = true`, and the preserved-controls list.
- Full audit trail: creation event carries the whole override
  (`event.schema.json:133-135`); amendment, consumption, browser-authorization, and
  audit-mirror action records carry `approvalPolicyOverrideId` +
  `overriddenRulesApplied` (`event.schema.json:286-291,362-367,430-435`;
  `audit-mirror-entry.schema.json:184-192`). `overriddenRulesApplied` is constrained
  to a non-empty unique subset of `{M-3,L-4}` (`event.schema.json:463-468`).
- Behavior proven: under override an amendment does NOT revoke grants
  (`mock-client/index.mjs:156-162`; `test/contract/mock-client.mjs:615-623`) and an
  extra condition key is tolerated while the decision is `allow` with
  `overriddenRulesApplied:["M-3","L-4"]` recorded
  (`test/contract/mock-client.mjs:639-654`); the amendment event records
  `overriddenRulesApplied:["M-3"]` (`test/contract/mock-client.mjs:752-756`).
- Rejection tests confirm the limits: deleting `immutableAfterCreation`, narrowing
  `overriddenRules` to `["M-3"]`, or shrinking `preservedControls` are all rejected
  (`test/contract/schemas.mjs:51-55`); a non-owner override is rejected
  (`test/contract/mock-client.mjs:104-120`).

### Override does not bypass identity/role, claim/generation/fencing, adapter allowlists, credential isolation, or unrelated controls

VERIFIED. Even inside an override job the mock still enforces:
- claimant/actor identity and required role: `actor_not_claimant`
  (`mock-client/index.mjs:368`) fires under override
  (`test/contract/mock-client.mjs:624-638`); role check at 369.
- fencing/generation: `#assertFence` (`mock-client/index.mjs:935-944`) still throws
  `stale_fencing_token` under override (`test/contract/mock-client.mjs:700-714`).
- adapter allowlist: origin outside the adapter allowlist still returns `ask` under
  override (`mock-client/index.mjs:833-841`;
  `test/contract/mock-client.mjs:655-667`).
- L-4 relaxation is narrow: the override skips only the condition-name-set equality
  (`mock-client/index.mjs:849`); every listed grant condition value must still match
  (`852-857`), and origin/destination/action/side-effect-class expansions still force
  `ask`. This matches "affects only M-3 and L-4."
- Prose faithful: `docs/architecture/DRAFT-CONTRACT.md:120-122,195-198`;
  `docs/architecture/IDENTITY-ROLES-SECURITY.md:39-43`;
  `docs/architecture/ADAPTERS-MCP-TRANSPORTS.md:54`;
  `docs/DECISION_REGISTER.md:466-469` (D-021).

### L-2 recorded faithfully (verbatim instruction text may remain in the encrypted mirror; no broader policy silently approved)

VERIFIED. Verbatim text is retained via `instructionSet.text`
(`common.schema.json:58`, max 16000) inside audit-mirror `instructionSets`
(`audit-mirror-entry.schema.json:30-35`). The mirror's
`excludedContentClasses` is `const ["browser_state","credentials",
"raw_artifact_contents","secrets"]` (`audit-mirror-entry.schema.json:56-59`) — it
does not exclude instruction text, and cannot be altered (rejection test
`test/contract/schemas.mjs:90-92`). The scope of L-2 is stated without expanding
redaction/access/retention: `contracts/v0.1.0-draft.3/AUDIT-MIRROR.md` L-2 note;
`docs/architecture/DRAFT-CONTRACT.md:159-161`; `docs/DECISION_REGISTER.md:101-103`
(D-004), which keep redaction/retention/legal-hold/access explicitly deferred.

### GitHub setup deferred

VERIFIED. `contracts/v0.1.0-draft.3/README.md` (deferral bullet);
`docs/DECISION_REGISTER.md:321-322` (D-014); `docs/adr/0005-...:19`;
`AGENTS.md:32-33`. The mock has no GitHub remote and the doctor `github` check is
`skipped` (`mock-client/index.mjs:709`). Source-only `github_source` remains
restricted to public/internal `source_code`
(`test/contract/schemas.mjs:61-68,115-121`).

### D-021 conditional Phase 1 gate does not prematurely authorize implementation

VERIFIED. `docs/DECISION_REGISTER.md:451-481` conditions launch on ALL of:
revision committed, all tests/scans pass, a focused independent review closing with
no unresolved material finding, a clean worktree, and no remaining leases. At the
reviewed working tree the revision is uncommitted and the tree is dirty, so the gate
is not satisfied and implementation is not authorized by this state. This review
does not authorize implementation and makes no handoff.

## Findings, ordered by severity

### Defects

- D1 (Low, pre-existing, non-material). Duplicate object key `"minItems": 1`
  appears twice in `contracts/v0.1.0-draft.3/schemas/review-job.schema.json:109-110`
  (`target.artifactIds`). It is carried forward from
  `contracts/v0.1.0-draft.2/schemas/review-job.schema.json:109-110`, is not part of
  this owner-policy delta, and is functionally inert because `JSON.parse` collapses
  the duplicate before AJV sees it (so `strict: true` does not flag it). It is still
  malformed source and should be de-duplicated in a future cleanup. Non-blocking.

I found no defect in the owner-policy delta itself.

### Preference disagreements (non-defects)

- P1. The `preservedControls`/`overriddenRules` `const` arrays are position- and
  value-sensitive literal lists rather than enumerated required members. This is a
  legitimate design choice (it makes the audited value canonical and hash-stable);
  I merely note that any future addition to the protected-control taxonomy forces a
  coordinated schema + audit-vector change. Not a defect.

## Residual risks (runtime obligations JSON Schema cannot express)

- R1 (Medium). Cross-field invariants are not, and largely cannot be, enforced by
  JSON Schema and are therefore only guaranteed by the reference mock and prose:
  (a) `approvalPolicyOverride.scope.jobId` equals the enclosing job's `jobId`
  (`review-job.schema.json:126-128` vs `common.schema.json:98-108`);
  (b) `invokedBy` is the owner and equals `requestedBy`;
  (c) an event/audit record carrying `approvalPolicyOverrideId`/
  `overriddenRulesApplied` corresponds to a job that actually declared the override.
  The mock enforces (a)/(b) at `mock-client/index.mjs:774-806` and (c) by only
  emitting the fields when an override exists (`414-421,873-887`), and the prose
  states owner-only/job-scoped intent. Any independent implementer building solely
  from the schemas must re-implement these as runtime MUSTs. Recommend the contract
  add an explicit normative "runtime MUST" appendix enumerating these invariants so
  they are not lost outside the reference mock.
- R2 (Low). `event.schema.json` allows `overriddenRulesApplied` and
  `approvalPolicyOverrideId` on amendment/consumption/authorization events without a
  schema-level requirement that `invalidatedApprovalGrantIds` be empty when M-3 is
  overridden. The mock keeps these consistent (`mock-client/index.mjs:156-170,
  192-195`); consistency remains a runtime obligation. Non-blocking.
- R3 (Low, deferred by owner). Mirror redaction, retention, legal-hold, access, and
  write-failure policy remain deferred (D-004/D-020). L-2 does not resolve them, and
  this review does not treat them as approved.

## Explicit policies still requiring owner confirmation (unchanged by this delta)

The register's "Post-review draft clarification (requires owner confirmation)"
items (D-003, D-004, D-005, D-010, D-014, D-017) and all "Genuinely deferred policy
details" remain open. The M-3/L-4 defaults, the override, L-2, and GitHub deferral
reviewed here are owner-approved per D-004/D-006/D-010/D-014/D-021; nothing in this
delta silently upgrades a deferred item into a requirement.

## Final recommendation

PASS.

The 0.1.0-draft.3 owner-policy delta faithfully implements the required policy:
M-3 and L-4 remain the defaults; the override is owner-only, job-scoped, immutable,
non-retroactive, fully audited, and limited to M-3 and L-4 without bypassing
identity/role, claim/generation/fencing, adapter allowlists, credential isolation,
or unrelated controls; L-2 is recorded without expanding redaction/access/retention;
and GitHub setup remains deferred. The only defect (D1) is a pre-existing, inert
duplicate JSON key outside this delta, and the residual risks (R1–R3) are runtime
obligations already met by the reference mock and documented in prose — none is an
unresolved material finding. Recommended (non-blocking) follow-ups: fix D1 and add
a normative runtime-invariant appendix for R1.

This review authorizes no implementation and makes no handoff.
