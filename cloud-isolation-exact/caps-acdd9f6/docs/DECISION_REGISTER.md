# Bridge 2.0 Decision Register

Status: REVISED DRAFT WITH CONDITIONAL PHASE 1 AUTHORIZATION GATE

Owner decisions recorded on 2026-07-12 through 2026-07-14 approve the recommendations
and additions identified below. The documents remain draft, and genuinely
deferred policy details are not approved requirements. Implementation is
authorized only through the conditional D-021 gate. Claude Code positions from the
first review are preserved; focused review records remain durable in
`docs/reviews/`.

## D-001: Draft contract version and approval gate

- Decision: How the shared contract becomes implementable.
- Available alternatives: Unversioned docs; immediate `1.0.0`; prerelease version
  with explicit approval.
- Recommendation: Use versioned prerelease drafts; this owner-directed revision is
  `0.1.0-draft.4`. Require explicit owner confirmation before freezing or
  removing the draft suffix. Implementation remains subject to D-021.
- Reasoning: Prevents recommendations and assumptions from becoming accidental
  requirements.
- Cost and maintenance impact: Requires version/disposition updates and a later
  approval commit/tag.
- Security and recovery impact: Prevents premature deployment of unresolved auth,
  encryption, and takeover policy.
- Assumptions: The owner is the final contract authority.
- Claude Code's position: Supports the gate and explicitly finds the draft not
  ready for approval until review defects and owner decisions are dispositioned.
- Owner decision: Approved as recommended.
- Approved addition: None.
- Genuinely deferred policy details: Final confirmation and freeze commit/tag.

## D-002: Bridge 1.x baseline and repository scope

- Decision: What historical code enters Bridge 2.0.
- Available alternatives: Copy everything; start empty; import a sanitized reusable
  source baseline.
- Recommendation: Keep commit `68ac195` and tag `bridge-1x-clean-baseline` as the
  sanitized historical baseline.
- Reasoning: Preserves behavior/tests without runtime state, one-off requests,
  generated files, or sensitive task prompts.
- Cost and maintenance impact: Future diffs can separate inherited behavior from
  2.0 changes.
- Security and recovery impact: Reduces accidental secret/case-data publication.
- Assumptions: Excluded local utilities are not required product source.
- Claude Code's position: No objection; reviewed only the sanitized repository and
  confirmed no case/credential/browser data was accessed.
- Owner decision: Approved as recommended.
- Approved addition: Preserve the baseline commit and tag without rewriting history.
- Genuinely deferred policy details: None for baseline scope.

## D-003: Authoritative local storage

- Decision: Storage engine for state, claims, idempotency, and events.
- Available alternatives: Locked JSON/JSONL; SQLite/WAL; PostgreSQL; custom log.
- Recommendation: SQLite/WAL for local-first operation; reconsider PostgreSQL only
  for an approved remote multi-user requirement.
- Reasoning: Atomic transactions and constraints address 1.x race/revision gaps
  without cloud infrastructure.
- Cost and maintenance impact: Adds migrations and checkpointing but no external
  database package, server, or installation.
- Security and recovery impact: Live DB remains local; consistent snapshots become
  testable.
- Assumptions: One authoritative writer service per project generation.
- Claude Code's position: Concurs with SQLite for local use but preserves D-A:
  generation allocation must remain storage-agnostic for any future remote store.
- Owner decision: Approved as recommended.
- Approved addition: Use Node's built-in `node:sqlite` API; no separate database
  dependency, server, or installation.
- Post-review draft clarification (requires owner confirmation): Accept the Node
  22.13 `node:sqlite` experimental-API stability risk; require full contract,
  migration, and backup verification before Node minor-version adoption.
- Genuinely deferred policy details: Compaction, supported migration window, and
  the storage engine for any separately approved remote multi-writer deployment.

## D-004: Event journal role

- Decision: Whether events are audit records or the sole source of truth.
- Available alternatives: Full event sourcing; mutable state only; transactional
  state plus append-only events.
- Recommendation: Transactional state plus an immutable ordered event journal.
- Reasoning: Preserves audit/replay value without making every query dependent on
  complete event-sourcing infrastructure.
- Cost and maintenance impact: Requires sequence/hash checks and snapshot/export
  tooling.
- Security and recovery impact: Improves tamper/corruption detection; event payloads
  must exclude source bytes and secrets.
- Assumptions: Materialized state and events commit in one transaction.
- Claude Code's position: Supports transactional state plus events, but F-1/F-2
  require a closed payload catalog and canonical hash-chain contract.
- Owner decision: Approved as recommended.
- Approved addition: Append a non-operational, append-only JSONL audit mirror with
  complete typed event, instruction, approval, action, outcome, citation, and hash
  envelopes. Exclude credentials, secrets, browser state, and raw artifact content;
  encrypt confidential audit archives.
- Post-review draft clarification (requires owner confirmation): Completion events
  immutably carry result artifacts, citations, and full disagreements. Event-family
  rules require associated instruction, approval, action, and outcome snapshots.
- Genuinely deferred policy details: Mirror write-failure behavior, redaction,
  retention/legal hold, access controls, archive cadence, and purge mechanics.
- Owner policy applied on 2026-07-13: L-2 is approved. Complete verbatim
  instruction text may be retained in the encrypted audit mirror under the
  existing redaction, exclusion, access, and encryption controls.

## D-005: Principal, session, and host identity

- Decision: How actors are durably identified.
- Available alternatives: Agent strings; OS user only; principal/session/host
  envelope; mandatory OIDC/mTLS.
- Recommendation: Three-part identity envelope with issuer+subject principal,
  revocable session, and registered host installation.
- Reasoning: Distinguishes durable actor, execution context, and machine while
  supporting local and remote modes.
- Cost and maintenance impact: Adds registration, revocation, and identity migration.
- Security and recovery impact: Better attribution and host retirement; auth provider
  remains unresolved.
- Assumptions: Display names are never authorization keys.
- Claude Code's position: Supports the envelope; flags hostname-digest privacy,
  mandatory expiry/transport binding, and identity namespaces (F-8/F-14/F-15).
- Owner decision: Approved as recommended.
- Approved addition: Revocable, audited approval grants scoped to a job, actions,
  conditions, destinations/origins, side-effect class, duration, use count, and
  instruction version. No exact match defaults to `ask`; expansion requires renewal.
- Post-review draft clarification (requires owner confirmation): Bind consumption
  to the exact principal/session/host, required role, adapter, and current claim/
  generation/fencing token; reject another or stale claimant before scope matching.
- Genuinely deferred policy details: Remote authentication provider, session
  lifetime/revocation UX, and approval presentation/UI.

## D-006: Collaboration versus independent reviewer roles

- Decision: How independent review is enforced.
- Available alternatives: Same role for all agents; separate roles by label;
  provenance-based exclusion with owner waiver.
- Recommendation: Project-scoped collaborator/worker/reviewer roles and explicit
  excluded principal IDs derived from target authorship.
- Reasoning: A new session or model name is not independent when the durable
  principal authored the target.
- Cost and maintenance impact: Requires provenance lookup and waiver records.
- Security and recovery impact: Reduces self-approval; preserves reviewer findings
  through restore.
- Assumptions: Owner may waive independence only with a recorded reason.
- Claude Code's position: Supports separation but identifies F-3 as high severity:
  exclusions must derive from provenance, claims need role checks, and waivers need
  owner authority.
- Owner decision: Approved as recommended.
- Approved addition: Owner-supplied custom job instructions are versioned, hashed,
  and audited. Material amendments invalidate grants bound to superseded versions.
- Owner policy applied on 2026-07-13: Default M-3 remains. Because grants bind an
  exact instruction version, every instruction amendment, material or not,
  explicitly revokes active grants on the superseded version; materiality remains
  recorded separately.
- Genuinely deferred policy details: Project-specific materiality rules beyond the
  explicit owner/system material-amendment flag.

## D-007: Review-job lifecycle

- Decision: Durable states and retries for review work.
- Available alternatives: Fire-and-forget calls; generic task states; explicit
  review state machine.
- Recommendation: queued, claimable, claimed, running, awaiting_input, completed,
  failed, cancelled with constrained transitions.
- Reasoning: Makes recovery, retries, ownership, and terminal results deterministic.
- Cost and maintenance impact: Adds transition tests and migration burden.
- Security and recovery impact: Prevents silent reassignment and history rewriting.
- Assumptions: Retry creates a new attempt or job rather than mutating history.
- Claude Code's position: Supports the state model; requires failure/cancellation
  representation and transition coverage, and prefers at least one result artifact
  (F-7/F-13, D-C).
- Owner decision: Approved exactly as recommended.
- Approved addition: None.
- Genuinely deferred policy details: Retry scheduling and terminal-result retention.

## D-008: Claiming, idempotency, and fencing

- Decision: How duplicate commands and stale writers are blocked.
- Available alternatives: TTL only; optimistic revision; idempotency only;
  generation plus fencing token and idempotency.
- Recommendation: Atomic claim, scoped idempotency key/request hash, monotonic
  generation, and monotonic fencing token on every claimed mutation.
- Reasoning: Covers network retries and paused/expired writer races.
- Cost and maintenance impact: Every mutation and adapter must carry metadata;
  idempotency records need retention.
- Security and recovery impact: Critical split-brain defense; stale tokens survive
  clock errors.
- Assumptions: The authoritative store allocates tokens transactionally.
- Claude Code's position: Supports generation/fencing but requires scoped
  request-hash idempotency and executable restore monotonicity checks (F-5/F-6).
- Owner decision: Approved exactly as recommended.
- Approved addition: None.
- Genuinely deferred policy details: Idempotency and claim-history retention duration.

## D-009: Artifact and citation provenance

- Decision: What Bridge records about inputs and outputs.
- Available alternatives: Paths only; embed content; immutable metadata with hashes
  and first-class citations.
- Recommendation: Immutable artifact metadata, content hash, parent graph, precise
  citation locator/claim, and verification result.
- Reasoning: Supports traceability without centralizing sensitive bytes.
- Cost and maintenance impact: Requires hashing, metadata lifecycle, and graph
  validation.
- Security and recovery impact: Avoids evidence in Git/events; external artifact
  storage and access controls remain necessary.
- Assumptions: Clients can retain content outside Bridge.
- Claude Code's position: Supports immutable provenance; requires closed event data
  and sensitivity-aware storage constraints (F-1/F-10).
- Owner decision: Approved exactly as recommended.
- Approved addition: None.
- Genuinely deferred policy details: Artifact retention, legal hold, and external
  artifact-store access policy.

## D-010: Adapter interface and isolation

- Decision: How provider/browser/local integrations attach.
- Available alternatives: Hard-code integrations; in-process plugins; versioned
  manifest and out-of-process adapters.
- Recommendation: Closed manifest, schema-validated operations, side-effect classes,
  least privilege, and out-of-process isolation for credentialed adapters.
- Reasoning: Limits provider drift and credential exposure.
- Cost and maintenance impact: Adds process supervision, compatibility tests, and
  adapter versioning.
- Security and recovery impact: Adapter state and credentials stay outside core
  snapshots; manifests remain recoverable.
- Assumptions: Performance overhead is acceptable for orchestration work.
- Claude Code's position: Supports isolation intent; F-9 requires schemas to forbid
  in-process browser/credential adapters and enforce allowlists/approval declarations.
- Owner decision: Approved exactly as recommended.
- Approved addition: None.
- Post-review draft clarification (requires owner confirmation): Every grant names
  adapter IDs and restricts origins/destinations to the adapter allowlist; extra
  unlisted condition fields are scope expansion and default to `ask`.
- Owner policy applied on 2026-07-13: Default L-4 remains. Any additional or
  unapproved approval condition forces `ask` unless the owner declared the
  job-creation override in D-021.
- Genuinely deferred policy details: Adapter signing/trust distribution and the
  approved set of production adapters.

## D-011: MCP tool profiles

- Decision: How tools are exposed by role.
- Available alternatives: One universal tool set; per-client config; server-derived
  read/collaborate/review/operate/admin profiles.
- Recommendation: Server-derived least-privilege profiles with authorization at
  discovery and invocation.
- Reasoning: Client declarations are not trust boundaries.
- Cost and maintenance impact: More authorization tests and tool-profile docs.
- Security and recovery impact: Reduces accidental privilege; restored roles must be
  validated before tools become active.
- Assumptions: MCP clients tolerate role-filtered discovery.
- Claude Code's position: No material disagreement; emphasizes server-side role
  enforcement because discovery filtering is not an authorization boundary.
- Owner decision: Approved exactly as recommended.
- Approved addition: None.
- Genuinely deferred policy details: Final tool-to-profile matrix and administrator
  bootstrap/recovery UX.

## D-012: Stdio and remote HTTP transports

- Decision: Supported MCP transports.
- Available alternatives: Stdio only; Streamable HTTP only; both; custom REST.
- Recommendation: Stdio default plus optional MCP Streamable HTTP; no legacy
  HTTP+SSE unless a compatibility need is approved.
- Reasoning: Matches current MCP standard and local-first operation.
- Cost and maintenance impact: Two transport test matrices; remote operations add
  TLS/auth/monitoring.
- Security and recovery impact: Remote mode expands attack surface and cannot ship
  before auth/origin/session policy is approved.
- Assumptions: Remote access is optional.
- Claude Code's position: No transport disagreement; remote authentication,
  identity binding, and hosting remain owner-blocking decisions.
- Owner decision: Approved exactly as recommended for contract definition.
- Approved addition: None.
- Genuinely deferred policy details: Remote authentication, authorization, hosting,
  TLS termination, deployment, and operations. No remote deployment is approved.

## D-013: Browser dispatcher policy

- Decision: How authenticated browser surfaces are controlled.
- Available alternatives: Core-embedded automation; isolated dispatcher; APIs only;
  no browser support.
- Recommendation: Isolated allowlisted browser adapter; browser-owned profile;
  focus lease; human approval for irreversible actions.
- Reasoning: Browser state is high-trust and selectors are volatile.
- Cost and maintenance impact: Ongoing selector calibration and health checks.
- Security and recovery impact: Profiles are never backed up by Bridge; new hosts
  require manual re-authentication.
- Assumptions: Read/compose workflows can be separated from outbound approval.
- Claude Code's position: Supports isolated dispatchers; F-9 requires the manifest
  schema to enforce the stated process, origin, and approval boundaries.
- Owner decision: Approved as recommended.
- Approved addition: The owner may pre-approve a bounded job and its resulting
  approval prompts through scoped grants. New origins, destinations, side-effect
  classes, conditions, actions, instruction versions, duration, or use counts
  default to `ask` and require renewed approval.
- Genuinely deferred policy details: Browser provider selection, selector policy,
  approval UI, and production origin/side-effect allowlists.

## D-014: GitHub and Drive responsibility split

- Decision: Where source and recovery state live.
- Available alternatives: GitHub only; Drive only; live state in Drive; split
  source/recovery responsibilities.
- Recommendation: Private GitHub for source; Drive for immutable verified recovery
  packages; local/authoritative service for live state.
- Reasoning: Avoids Drive multi-writer corruption and GitHub runtime-data leakage.
- Cost and maintenance impact: Two backup paths and periodic restore drills.
- Security and recovery impact: Separates access domains; encryption and key custody
  are still open.
- Assumptions: The approved Drive path is available on primary and replacement hosts.
- Claude Code's position: Supports the split and preserves D-B: prefers removing
  GitHub from backup destinations entirely. The draft accepts that preference while
  retaining private GitHub for source only.
- Owner decision: Approved as recommended.
- Approved addition: Private GitHub keeps complete sanitized source history without
  pruning. Drive keeps immutable recovery packages and historical archives. Runtime
  state, case information, credentials, and recovery snapshots are forbidden in GitHub.
- Post-review draft clarification (requires owner confirmation): `github_source`
  artifact locations are permitted only for public/internal `source_code`; prompts,
  general sources, attachments, backups, and generated outputs are forbidden.
- Owner policy applied on 2026-07-13: GitHub setup, authentication, remote
  creation, and push are deferred until after the first implementation phase.
- Genuinely deferred policy details: Recovery/archive retention, legal hold, and
  restore-drill cadence.

## D-015: Active generation and split-brain policy

- Decision: How a restored/new host becomes writable.
- Available alternatives: Last-writer-wins; TTL; distributed lock service; monotonic
  owner-confirmed generation takeover.
- Recommendation: Exactly one active writable generation and owner-confirmed
  monotonic takeover.
- Reasoning: Drive cannot arbitrate and stale clients must be fenced.
- Cost and maintenance impact: Takeover UX, event/report, and reconciliation tooling.
- Security and recovery impact: Prevents dual writers; loss of owner approval channel
  can delay recovery.
- Assumptions: Single owner authority is reachable during activation.
- Claude Code's position: Supports the model; F-5 requires executable monotonic
  takeover and recovery-drill non-activation invariants.
- Owner decision: Approved as recommended.
- Approved addition: None.
- Genuinely deferred policy details: Takeover approval-channel recovery when the
  normal owner identity channel is unavailable.

## D-016: Backup encryption and key custody

- Decision: Which recovery data is encrypted and where keys live.
- Available alternatives: No encryption; password archive; OS keychain reference;
  hardware/managed key service.
- Recommendation: Encrypt confidential/restricted runtime snapshots with
  AES-256-GCM and store only an opaque key reference in manifests.
- Reasoning: Drive compromise must not expose runtime content.
- Cost and maintenance impact: Key rotation, escrow/recovery procedure, and lost-key
  drills.
- Security and recovery impact: Strong confidentiality but unrecoverable data if key
  custody is poorly designed.
- Assumptions: An approved key store is available on replacement hosts.
- Claude Code's position: Supports encryption references; key custody remains
  blocking and runtime-to-GitHub leakage must be structurally impossible (F-4).
- Owner decision: Approved as recommended.
- Superseded approved addition: Store recoverable key material only as an encrypted/wrapped
  key capsule in the separately designated recovery-key Drive account. Manifests
  contain opaque references; the capsule decryption secret remains outside both
  Drive accounts and GitHub. The exact private account binding is kept in the Drive
  recovery procedure, not sanitized source history. The owner superseded the
  outside-Drive custody requirement in D-024 on 2026-07-14.
- Approved addition: D-024 selects RSA-OAEP-SHA-256 capsules and allows the private
  recovery key in exact local-runtime and Drive recovery-key directories.
- Genuinely deferred policy details: Rotation schedule, quorum/recovery actors,
  and lost-key drill cadence.

## D-017: Restore, migration, and doctor contracts

- Decision: How upgrades and recovery are verified.
- Available alternatives: Best-effort scripts; automatic in-place upgrade; manifest-
  driven isolated restore/migration/doctor.
- Recommendation: Pre-backup, checksummed forward migrations, isolated restore,
  read-only doctor, contract tests, then approved activation.
- Reasoning: Makes disaster recovery executable and auditable.
- Cost and maintenance impact: Migration matrix, fixtures, restore drills, and
  reports.
- Security and recovery impact: Detects corruption and forbidden files before
  activation; repair remains separate.
- Assumptions: Two recent approved minor versions are a possible support target.
- Claude Code's position: Supports staged restore; requires monotonic takeover,
  complete doctor categories, and schema-conformant doctor output (F-5/F-12).
- Owner decision: Approved exactly as recommended.
- Approved addition: None.
- Post-review draft clarification (requires owner confirmation): A dirty
  `source_only` exception must record approval-grant ID, reason, and owner identity.
- Genuinely deferred policy details: Supported migration window, RTO/RPO, backup
  cadence, and restore-drill frequency.

## D-018: Procedural Guidance client integration

- Decision: How the first client develops before Bridge exists.
- Available alternatives: Wait for Bridge runtime; couple to 1.x; use JSON schemas
  and the in-memory mock.
- Recommendation: Consume the current `0.1.0-draft.4` schemas and `mock-client/` behind a
  client-owned interface; no production dependency on mock internals.
- Reasoning: Enables concurrent contract testing without overlapping runtime files.
- Cost and maintenance impact: Client must swap the test double for a real transport
  adapter later.
- Security and recovery impact: Mock performs no external I/O and uses synthetic
  fixtures only.
- Assumptions: The client can use Node ESM or wrap the mock behavior.
- Claude Code's position: Supports a mock boundary but found the first mock omitted
  provenance roles, lifecycle edges, request-hash idempotency, and doctor conformance
  (F-3/F-6/F-7/F-12).
- Owner decision: Approved exactly as recommended as a draft integration boundary.
- Approved addition: None.
- Genuinely deferred policy details: Production dependency on a real Bridge
  transport remains outside the mock boundary until a later integration window.

## D-019: Cloud deployment and paid resources

- Decision: Whether Bridge 2.0 requires cloud infrastructure.
- Available alternatives: Local only; self-hosted remote; managed paid cloud.
- Recommendation: No cloud deployment in this draft; define remote contracts only.
- Reasoning: Requirements, auth, budget, and operational ownership are unresolved.
- Cost and maintenance impact: Defers deployment automation and recurring cost.
- Security and recovery impact: Avoids premature internet exposure.
- Assumptions: Local-first is sufficient for initial validation.
- Claude Code's position: Supports deferral; warns that local SQLite must not be
  mistaken for a future remote multi-writer topology (D-A).
- Owner decision: Approved exactly as recommended: no cloud deployment in this
  draft; remote contracts only.
- Approved addition: None.
- Genuinely deferred policy details: Every cloud, paid, hosted, or internet-exposed
  deployment decision requires separate owner approval.

## D-020: Retention and deletion policy

- Decision: Lifetimes for events, idempotency, artifacts, backups, and review
  disagreements.
- Available alternatives: Retain forever; fixed schedules; owner/project policy;
  legal-hold aware policy.
- Recommendation: Do not implement deletion until the owner selects per-class
  retention and hold semantics. Preserve disagreements in all retained reviews.
- Reasoning: Premature deletion can break audit and recovery; indefinite retention
  increases exposure.
- Cost and maintenance impact: Policy engine, purge jobs, backup tombstone handling,
  and tests.
- Security and recovery impact: Direct tradeoff between recoverability and data
  minimization.
- Assumptions: No current approved retention schedule exists.
- Claude Code's position: Supports explicit owner disposition; idempotency,
  audit-event, disagreement, artifact, and backup lifetimes remain unresolved.
- Owner decision: Approved exactly as recommended: implement no automatic deletion.
- Approved addition: Preserve disagreements in all retained reviews.
- Genuinely deferred policy details: Per-class retention, deletion, backup
  tombstones, legal holds, release authority, and purge verification.

## D-021: Owner override and conditional Phase 1 launch gate

- Decision: Whether to keep the conservative M-3/L-4 defaults while allowing a
  narrow job-scoped owner override, and when implementation windows may launch.
- Available alternatives: No override; global policy weakening; owner-only
  job-creation override with strict preserved controls.
- Recommendation: Keep M-3 and L-4 as defaults. Add a full override only when the
  owner explicitly invokes it up front at job creation. The override is owner-only,
  job-scoped, immutable after creation, non-retroactive, and fully audited. It
  overrides only M-3 and L-4 for that job.
- Reasoning: Preserves the safe default posture while allowing the owner to opt
  into a known relaxed approval model for a specific job before work begins.
- Cost and maintenance impact: Adds schema fields, event/audit fields, mock
  behavior, and contract tests. Implementations must keep the override immutable
  and auditable.
- Security and recovery impact: The override cannot bypass principal or role
  authorization, claim/generation/fencing controls, adapter allowlists, credential
  isolation, or unrelated security controls. GitHub setup remains deferred until
  after the first implementation phase.
- Assumptions: The owner identity is available at job creation and is the only
  actor allowed to invoke this override.
- Claude Code's position: PASS on the focused `0.1.0-draft.3` owner-policy delta
  with no unresolved material finding. One low pre-existing duplicate-key defect
  was fixed. Residual risks R1-R3 are preserved as implementation obligations:
  runtime enforcement of cross-field override invariants, consistency of override
  audit fields with grant invalidation, and deferred mirror redaction/retention/
  legal-hold/access/write-failure policy.
- Owner decision: Approved exactly as recommended for this draft revision.
- Approved addition: The Bridge runtime and Procedural Guidance Phase 1
  implementation windows are authorized to launch automatically only if this
  revision is committed, all existing tests and scans pass, a focused independent
  Claude review closes with no unresolved material finding, the worktree is clean,
  and no leases remain.
- Genuinely deferred policy details: Any post-Phase-1 GitHub setup/authentication
  details, remote deployment, production approval UI, and broader policy
  configuration.

## D-022: Legacy MCP compatibility and Claude lane identity

- Decision: How Bridge 2.0 can replace Bridge 1.x without forcing existing clients
  to rename tools, while preserving distinct Claude Code and Cowork ownership.
- Available alternatives: Keep one generic `claude` identity; require immediate
  client rewrites to `bridge_v2_*`; expose compatibility aliases backed by legacy
  JSON state; expose aliases backed by SQLite/WAL and lane-specific principals.
- Recommendation: Patch `0.1.2` keeps the historical `bridge_*` names at
  `dist/server.js`, but implements coordination in SQLite/WAL. Canonical principals
  are `codex`, `claude_desktop_code`, and `claude_desktop_cowork`. `BRIDGE_LANE`
  takes precedence, MCP client identity may infer a lane, `code`/`cowork` remain
  aliases, and ambiguous generic `claude` defaults to Code with a warning.
- Reasoning: Existing AGENTS/CLAUDE instructions continue to work while Code and
  Cowork cannot silently bypass each other's leases.
- Cost and maintenance impact: Adds one forward migration, a compatibility facade,
  legacy-state import, migration tests, and a temporary dual tool surface.
- Security and recovery impact: Accepted commands retain principal/session/host
  attribution, immutable event/audit envelopes, generation, fencing, and WAL
  serialization. Bridge 1.x runtime state is imported locally only and is never
  source-controlled or published.
- Assumptions: Local stdio clients either set `BRIDGE_LANE` or expose a client name
  that distinguishes Code from Cowork. Ambiguous clients may sync for diagnosis
  but cannot claim files.
- Claude Code's position: Conditional PASS. H-1 objected that a soft warning let
  ambiguous generic Claude clients collapse Code and Cowork into one lease owner;
  H-2 objected that junction aliases could fork one project into two lease spaces.
  Both findings were accepted and closed with fail-closed claims, startup warnings,
  canonical real-path identity, and Windows junction regression coverage.
- Owner decision: Approved by the owner's patch/cutover direction and explicit
  reminder that Claude has separate Code and Cowork pieces.
- Approved addition: Code and Cowork are separate principals and lease owners.
- Explicit owner approval required: No for this owner-directed patch; yes for
  removing compatibility aliases in a later release.
- Genuinely deferred policy details: Alias deprecation date, remote identity
  mapping, and production UI for lane ambiguity.

## D-023: Reversible local entrypoint cutover

- Decision: How the historical `Codex Connector` path changes from Bridge 1.x to
  Bridge 2.0 without editing every local client configuration.
- Available alternatives: Rewrite every MCP configuration; move the Bridge 2.0
  working tree into the old location; rename Bridge 1.x and place a directory
  junction at the old path pointing to the tested Bridge 2.0 checkout.
- Recommendation: After tests, review, source/state backups, and legacy-state
  import pass, rename the intact Bridge 1.x directory to `Decommissioned Bridge`
  and create a reversible junction named `Codex Connector` to Bridge 2.0. On any
  failed fresh-client smoke test, remove the junction and restore the old name.
- Reasoning: Codex and Claude currently launch the exact historical
  `dist/server.js` path. A junction preserves that entrypoint while keeping the
  Bridge 2.0 Git checkout and recovery paths stable.
- Cost and maintenance impact: Requires a tested rollback script/record and leaves
  the old source intact until post-cutover validation closes.
- Security and recovery impact: No source history is rewritten, no repository is
  published, and the old implementation remains an offline fallback. Runtime
  state stays outside both source trees.
- Assumptions: Windows directory junctions are supported and no Bridge process has
  the old source directory locked during the rename.
- Claude Code's position: Conditional PASS. The junction switch is reversible,
  but rollback does not copy Bridge 2.0 control, task, or lease changes back into
  Bridge 1.x JSON state. That limitation is accepted for the short validation
  window and must be stated in the cutover record.
- Owner decision: Approved by the owner's explicit rename/archive and rollback
  instruction.
- Approved addition: Test before cutover; restore Bridge 1.x immediately on failure.
- Explicit owner approval required: No for the reversible local cutover; permanent
  deletion of Bridge 1.x remains unapproved.
- Genuinely deferred policy details: Final archive medium, retention period, and
  permanent deletion authorization.

## D-024: RSA capsule with local and Drive private-key copies

- Decision: How to close D-016 without requiring an external password, hardware
  token, separate secret medium, or paid key service.
- Available alternatives: Passphrase-derived symmetric wrapping; random symmetric
  wrapping key; software public/private key with offline private-key custody;
  software public/private key with local and Drive private-key copies; hardware
  token; managed KMS.
- Recommendation: Use a dedicated RSA-3072 key pair and RSA-OAEP-SHA-256. Bridge
  uses the public key to wrap a fresh 256-bit backup data key. Keep byte-identical
  private-key copies in one configured local runtime directory and one configured
  Drive recovery-key directory.
- Reasoning: Preserves unattended public-key capsule creation and simple new-host
  recovery while matching the owner's stated low-security, low-maintenance
  preference.
- Cost and maintenance impact: No new service, password, hardware, or dependency.
  Key-copy verification, capsule hashes, rotation bookkeeping, and restore drills
  remain required.
- Security and recovery impact: Compromise of the Drive recovery-key directory can
  expose every retained backup encrypted to that key. The owner explicitly accepts
  this tradeoff. The private key remains forbidden in GitHub, source trees, logs,
  prompts, manifests, audit records, and synthetic fixtures.
- Assumptions: The local runtime and Drive copies are readable on a replacement
  host and Drive account access is sufficient owner authentication for this risk
  posture.
- Claude Code's position: The focused independent review returned `APPROVE WITH
  REQUIRED FIXES`. Claude accepted D-024's Drive-custody exposure as an explicit
  owner policy tradeoff, not an implementation defect. Its F1-F4 findings were all
  accepted and resolved in patch 0.1.3; disposition is recorded in
  `docs/reviews/PATCH_0.1.3_CLAUDE_DISPOSITION.md`.
- Owner decision: Approved on 2026-07-14 as "option 3 with the less secure storage."
- Approved addition: Manifests bind the capsule hash, recipient public-key
  fingerprint, RSA-OAEP-SHA-256 algorithm, backup ID, and opaque key reference.
- Explicit owner approval required: No for implementation and the recovery drill;
  yes for placing any key in GitHub or broadening storage beyond the two configured
  directories.
- Genuinely deferred policy details: Rotation schedule, multi-recipient/quorum
  recovery, private-key retirement, and recurring restore-drill cadence.

## D-025: Provider-addressed Drive mailboxes for ChatGPT and Gemini

- Current implementation note (2026-07-18): this decision remains the
  historical mailbox-v1 authorization and threat model. Mailbox v3 accepts new
  work for ChatGPT, Antigravity, and the generic profile-driven `web` provider;
  Gemini history remains immutable and read-only. D-027 governs WEB node
  onboarding and the dedicated browser.
- Decision: How Bridge may deliver owner-authorized messages to ChatGPT and
  Gemini without treating Drive synchronization as an authoritative queue.
- Available alternatives: Human-copied Drive files; provider APIs; Drive-only
  mutable mailboxes; public/remote MCP apps; a local broker with isolated browser
  and CLI consumers; no chatbot delivery.
- Recommendation: Use a separate local SQLite/WAL mailbox as authority, immutable
  provider-addressed message/response envelopes in a separate `Bridge Exchange`
  Drive folder, a bearer-authenticated loopback broker, and an unpacked Chrome
  extension for automatic ChatGPT/Gemini web delivery. Package an optional Gemini
  CLI extension. Do not create a public endpoint, paid cloud resource, or ChatGPT
  custom app in this release.
- Reasoning: ChatGPT custom apps require reachable remote MCP and do not
  autonomously poll; the installed Gemini CLI is currently unavailable for model
  execution on this account. Browser delivery reuses owner-authenticated tabs
  without exporting credentials, while SQLite provides atomic claims and WAL
  serialization.
- Cost and maintenance impact: Adds a local broker process, Chrome selector
  maintenance, a provider extension, schema/tests, and an explicit uncertain-job
  reconciliation path. The Gemini CLI extension remains optional.
- Security and recovery impact: Each enqueue grants exactly one immutable prompt
  to one provider/origin for one use and one expiry. Delivery tokens and the
  broker token remain local. Drive contains raw mailbox prompt/response contents
  but never the database/WAL, locks, leases, tokens, credentials, cookies, browser
  profiles, or recovery keys. Once dispatch starts, Bridge never auto-resends.
- Assumptions: The owner remains signed into the provider websites in Chrome and
  accepts that the dedicated Drive exchange may contain message/response text.
  DOM selectors may change and require maintenance.
- Claude Code's position: No critical/high defect; draft not approved. Claude
  reported M-1 through M-6, low/informational findings, and preserved three
  disagreements. Accepted fixes and residual positions are recorded in
  `docs/reviews/MAILBOX_0.2.0_CLAUDE_DISPOSITION.md`; the original review is
  unchanged.
- Owner decision: Approved by the owner's 2026-07-14 direction to automate the
  Gemini and GPT mailboxes and create/install the required local integrations.
- Approved addition: The existing D-013 bounded browser pre-approval applies only
  to the exact provider-addressed message. The enqueue call is the audited
  one-message approval unless it names an existing approval grant.
- Explicit owner approval required: No for the local broker, separate Drive
  exchange, Chrome extension, and optional Gemini CLI extension. Yes for any new
  origin/provider, provider API credential, remote MCP tunnel, public endpoint,
  paid service, or cloud deployment.
- Genuinely deferred policy details: Per-class mailbox retention/legal hold,
  manual adjudication UI for `uncertain`, provider API adapters, remote ChatGPT
  app publication, encrypted support for confidential/restricted mailbox
  contents, and unattended operation when Chrome is closed.

## D-026: A2A (Agent2Agent) peer fabric â€” inbound live + outbound client

- Decision: Integrate Google's A2A protocol as the command center's universal
  peer-delegation fabric, treating Antigravity, Claude, and Codex as
  symmetric A2A peers; built to production on branch `a2a-phase-a` (off `main`).
- INVARIANT (owner directive): subscriptions only, NEVER API keys. A2A is the
  interface; execution stays on each peer's subscription-authenticated surface
  (the `agy`/Codex/Claude CLIs, owner-authenticated tabs, or a peer's
  local loopback A2A endpoint). The metered provider-API / Managed-Agents path is
  barred as a default.
- Peer set (owner direction, 2026-07-15): **Antigravity is the Google peer â€” NOT
  Gemini.** The Gemini CLI is retired for individual accounts (it errors with
  "migrate to the Antigravity suite"), so a separate `gemini` peer would be both
  redundant and dead on arrival. `COMMAND_CENTER_PEERS` = antigravity, claude,
  codex; a regression test asserts `delegate.gemini` is never advertised and that
  the CLI spec table has no `gemini` entry.
- As built (inbound, live): a dedicated loopback listener (`A2AHttpBoundary`,
  `serve-a2a` entrypoint) serves the v0.3 Agent Card at
  `/.well-known/agent-card.json` plus JSON-RPC (`message/send`, `tasks/get`,
  `tasks/cancel`); each inbound task becomes a review job via
  `JobBackedA2ATaskBackend` (message â†’ `prompt` artifact + a default acceptance
  criterion; deterministic ids â‡’ idempotent `send`). Peers are provisioned with
  `collaborator` and `worker` roles so routed tasks can use the real claim/start/
  terminal lifecycle. A peer self-identifies with `x-bridge-peer` and an
  unprovisioned caller gets 401. The header is a loopback peer selector, not a
  remote authentication credential. The MCP `streamable-http` transport is left
  untouched â€” a second loopback port carries the same security envelope (no new
  external exposure).
- As built (outbound): `A2AClient` plus a shell-free subscription-process runner
  resolves only the frozen Antigravity/Claude/Codex binaries, strips inherited
  API-key/token/secret-shaped environment variables, and bounds runtime/output.
  A routed blocking `message/send` now drives the Bridge job through a real peer
  invocation and persists a content-hashed response artifact before returning a
  terminal receipt. The `adapter.a2a.client` manifest has
  `credentialMode: "none"`, `remote_http`, dedicated send/query/receipt schemas,
  and `approvalPolicy.defaultDecision: "ask"`.
- Compatibility contract (2026-07-22 Antigravity repair): `bridge_task_add` is
  board-only and `bridge_handoff` is control metadata only; each returns an
  explicit `not_dispatched` receipt. `bridge_a2a_send` performs direct peer work,
  and `bridge_task_dispatch` closes a board row only after `channel=a2a`, a
  terminal `completed` state, and a durable result artifact. Reusing an
  idempotency key for changed work fails closed. Antigravity's plugin carries the
  same invariant as both a rule and a separately validated skill, and its global
  permission config explicitly allows the three execution/status tools.
- Protocol compatibility: Bridge declares A2A v0.3 and `streaming: false` because
  that is its implemented stable-JavaScript-SDK compatibility target. It does not
  claim A2A 1.0 or streaming conformance. A version migration is a separate gate.
- Peer reliability tiers (owner direction, updated 2026-07-17): every outbound
  peer carries `reliability: "verified" | "unreliable"`. A verified peer has a
  live end-to-end response on its exact production command shape and remains
  fail-closed: runner failures propagate and a non-zero exit throws. Antigravity,
  Claude, and Codex are currently verified. Antigravity was promoted only after
  the installed Google `agy` 1.1.3 CLI returned the exact sentinel through both
  a direct pinned-model call and Bridge's compiled subscription dispatcher. Its
  frozen command shape is `agy --model "Gemini 3.1 Pro (High)"
  --print=<prompt>`; the model is never left to a mutable CLI default. The real
  CLI does not accept the prompt on stdin, so Bridge keeps the option and its
  untrusted value in one spawned argv token and requires a shell-free runner.
  That prevents flag-shaped prompt content from becoming another option, but it
  necessarily exposes the prompt to local process-command inspection; runners
  must treat command-line metadata as sensitive. The `unreliable` tier remains
  available for a future peer that has not passed the same live evidence gate.
- Codex non-Git execution correction (2026-07-22): the frozen Codex shape is
  `codex exec --skip-git-repo-check`, with the prompt on stdin. This is required
  because Antigravity brain/project directories are valid Bridge projects but
  are not necessarily Git worktrees; without the fixed flag, the real CLI exits
  before execution with its trusted-directory check.
- Reasoning: A2A is the agent-to-agent layer (vs. MCP's agent-to-tool). Binding
  inbound tasks to the review-job aggregate (not an outbound prompt courier)
  matches A2A's task lifecycle 1:1 and inherits fencing, audit, and identity.
- Security and recovery impact: loopback only, no credentials inbound; outbound
  uses no provider key. No public endpoint; a remote/tunnel target would be a
  separate owner decision.
- Owner decision: Owner approved a full production build and directed max-agent
  parallelism. During the build Gemini (ineligible tier) and Codex (CLI model
  config) were unavailable; the outbound lane was built by Claude and the loop
  ran degraded (recorded in `.shared/log.jsonl`).
- Verification: `tsc` build and strict contract schemas are clean. Runtime tests
  cover real HTTP + real Bridge storage, terminal response artifacts, exact-once
  replay, key-reuse rejection, truthful board acknowledgements, successful board
  closure, and failure-preserves-open behavior. Live subscription canaries remain
  release-specific evidence and must be recorded with the cutover.
- Genuinely deferred: SSE `message/stream` (job-status streaming); co-hosting the
  A2A endpoint on the MCP port; A2A 1.0 migration; public/remote exposure; and
  registering `adapter.a2a.client` for autonomous `AdapterHost` invocation. The
  explicit MCP tools use the executable A2A path without that autonomous gate.

## D-027: Generic browser-backed WEB nodes

- Decision: Make a profile-driven browser node the default Bridge integration
  for subscription-only WEB LLMs and other authenticated web services.
- Owner direction: On 2026-07-18 the owner rejected a bespoke Perplexity
  adapter and directed Bridge to become the reusable custom integration layer:
  trigger a dedicated browser, open the requested service, insert the generated
  prompt, wait for the answer, save it to Google Drive, and return the result or
  link to the originating workflow. Store the repeatable onboarding process as
  the `Learn new Bridge WEB node` skill.
- Decision: Mailbox v3 adds exactly one provider, `web`. Each message also binds
  a node ID and exact HTTPS origin. Perplexity is the first profile. A future
  service adds a closed JSON profile and regenerates the exact-origin extension
  manifest; it does not add a provider, database table, or schema migration.
- Profile boundary: Profiles contain identifiers, start URL, CSS selectors,
  submit mode, and bounded response settle/timeout limits. They cannot contain
  arbitrary JavaScript. The generated extension never requests `<all_urls>`.
- Authentication: A dedicated Chrome user-data directory under local Bridge
  runtime state owns Google OAuth, cookies, and provider login state. The owner
  signs in interactively once. Bridge does not read, export, synchronize, back
  up, or place that browser profile in Git or Drive.
- Dispatch and output: `bridge_web_node_send` is the one-message audited
  approval. The browser worker inherits the mailbox no-auto-resend boundary.
  Completion publishes the immutable v3 response envelope plus a readable
  Markdown file under the synced `Bridge Exchange`; `bridge_web_node_result`
  returns the captured response, conversation URL, and Drive path. Any optional
  paste-back to Gmail, a case workspace, or another destination remains an
  action by the originating orchestrator and uses that destination's own
  authorization.
- Migration and recovery: The explicit v2-to-v3 migration requires an exclusive
  idle mailbox, creates a digest-manifested local restore snapshot, extends the
  audit hash chain, and installs v3-only insert triggers to fence surviving v2
  writers. It never migrates browser credentials or rewrites v1/v2 Drive
  objects.
- Cost and maintenance: No provider API key, metered API, public endpoint, or
  cloud worker is introduced. Expected per-service maintenance is selector
  calibration when a site changes its DOM. The reusable skill records the
  observe, profile, validate, install, and canary sequence.
- Approval rule: The generic mechanism and Perplexity origin are owner-approved
  by this direction. Adding a later profile is an explicit owner-invoked
  onboarding action, and every real dispatch still requires its own one-use
  message approval.
- Scope boundary: v3 supports only `public` and `internal` messages. Encrypted
  confidential/restricted browser delivery, automatic Drive share-link
  creation, and executable site plug-ins remain deferred.



---
producer_surface: antigravity
model: Gemini 3.1 Pro (High)
thinking_tier: High
generation_method: reasoned
created_at_utc: 2026-07-24T07:30:00Z
source_revision: HEAD
---

## D-028: Capability Catalog Phase 1 — Control Plane Foundation
APPROVED BY OWNER — 2026-07-24

**1. Decision Name:** Capability Catalog Phase 1 - Control Plane Foundation
**2. Context:** Bridge 2.0 is transitioning from a prototyping environment where agents use hardcoded or organically discovered tools into a stateful, resilient multi-agent orchestration framework. As the system scales to incorporate native Bridge capabilities, MCP servers (Model Context Protocol), and web nodes (browser-based execution profiles like Perplexity), it requires a unified registry. Historically, capabilities were inferred, leading to ambiguous boundaries, especially when choosing between local execution, unknown API usage, or costly external models.
**3. Problem Statement:** Without a deterministic control plane, the Bridge router cannot reliably know which endpoints are healthy, authenticated, and permitted for a given task. This creates the risk of "black-hole dispatches"—tasks routed to endpoints that are misconfigured, offline, or lacking credentials. Furthermore, lacking a strict capability categorization creates severe financial and security risks, as an autonomous agent might mistakenly route high-volume background tasks to a paid inference endpoint instead of a free local one.
**4. Architectural Posture:** The Capability Catalog is strictly a control plane. It is not a data proxy. It does not sit in the execution path intercepting payloads. Its sole responsibility is to act as the central authority for capability definition, routing authorization, and access control. Before `bridge_a2a_send` or `bridge_task_dispatch` assigns work, the routing engine must query the catalog to confirm that the requested target is fully authorized and healthy. If the catalog says no, the dispatch is rejected immediately.
**5. Data Authority (The 3 Tables):** The catalog's state is authoritative and modeled using exactly three distinct tables in the local SQLite store: `installed_working`, `installed_broken`, and `available_for_install`.
  - `installed_working` holds capabilities that have been proven functional through an active probe.
  - `installed_broken` holds capabilities that are configured but are currently failing their health checks or lack proper authentication.
  - `available_for_install` acts as a census of capabilities that exist in the system (e.g., manifest files on disk) but have not been formally instantiated or configured.
  The routing engine only ever reads from `installed_working`.
**6. Credential Non-Exposure Boundary:** The capability catalog strictly segregates credential configuration from capability execution. The catalog tracks the *status* of a credential—it knows that a capability has been authenticated—but it does not hold, expose, verify, or provision the raw credentials (such as API keys or OAuth tokens) to the execution layer. The actual execution payload flows directly from the Bridge broker to the target provider. This invariant ensures that a compromised component querying the catalog cannot extract sensitive keys.
**7. Cost-Tier Constraints:** The pricing tier is implemented as an unbendable code reflex for routing priority: `free=0`, `unknown=1`, `paid=2`. The router will always prefer `free` capabilities over `unknown`, and `unknown` over `paid`. The `paid` tier is systematically down-voted and never auto-invoked while a free capability can satisfy the intent, and this is OWNER-OVERRIDABLE PER REQUEST. The `unknown` category acts as a vital buffer for endpoints where the financial cost is unquantified, preventing accidental budget exhaustion.
**8. Configuration vs. Proven Execution:** The presence of a configuration file (e.g., in `integrations/web-nodes/profiles/`) or a recorded API key never proves that a capability is working. Bridge relies entirely on empiricism. Only typed probe or census evidence—an active health check that returns a success response from the underlying provider—may promote a capability from `installed_broken` or `available_for_install` into the `installed_working` table. If a probe times out, the capability is immediately demoted.
**9. Sequencing and Exclusions:** The capability catalog represents a fundamental shift in Bridge's architecture. Therefore, it is being rolled out in phases. Packages 08 through 13 of the catalog design remain completely absent from this Phase 1 deployment and are explicitly reserved as Codex-owned decomposition work. No schemas or implementations for Packages 08 through 13 exist, nor are they claimed to exist. This phase (Packages 01 through 07) must be thoroughly proven before the system expands to handle complex routing scenarios or specific tool authorization.
**10. Owner-Confirmation Status:** APPROVED. The owner explicitly approved D-028 and ADR 0010 in the Codex GUI conversation on 2026-07-24. Capability Catalog Packages 01 through 07 may proceed in order after each package proves its own dependencies and the repository's D-021 gates at dispatch time.
