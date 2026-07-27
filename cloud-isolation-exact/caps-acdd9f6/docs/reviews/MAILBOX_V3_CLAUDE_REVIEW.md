---
producer_surface: claude_code
model: Claude Fable 5
generation_method: independent adversarial review with re-executed tests
created_at_utc: 2026-07-24
source_revision: staged index at HEAD b6871f7 (45 staged files; count stable across the review)
review_request: docs/reviews/MAILBOX_V3_CLAUDE_REVIEW_REQUEST.md
delivery_note: A2A dispatch to Claude failed twice (a2a_peer_dispatch_failed); the owner routed
  the request manually. This document is the durable review artifact.
---

# Mailbox v3 Independent Review (Claude)

This review answers the 12 numbered questions from the review request. It distinguishes
**DEFECTS** (bugs, invariant violations, test failures), **POLICY DISAGREEMENTS** (choices a
reviewer would make differently — preserved, not "fixed"), and **OBSERVATIONS**. Per this
workspace's standing instructions this review makes **no approval claim and no implementation
handoff**; the cutover decision remains the owner's under D-021.

Method: I did not trust AGY's summaries. I read the staged migration, store, exchange, service,
broker, installer, extension, profile, and schema sources directly; two read-only evidence agents
covered provider/dispatch/exchange semantics and schemas/packaging/register; all required test
suites were re-executed on this machine.

## Commands executed and exit codes

| Command | Exit | Result |
|---|---|---|
| `npm run test:all` | **1** | Chain aborted in the runtime suite: 122/123, one failure (below). Everything before it passed: build, e2e 17/17, MCP smoke, session, fixes, connectors, contract tests, a2a-canary syntax, cutover harness 8/8. |
| `node --test test/runtime/legacy-compatibility.test.mjs` | 0 | 7/7 including the failed test — failure is environmental (see F-7). |
| `npm run test:wal-race` | 0 | 1/1. |
| `npm run test:mailbox` | 0 | **22/22** plus extension syntax checks — the v3 subject suite is green. |
| `npm pack --dry-run --ignore-scripts` (evidence agent) | 0 | 300 files; inclusions/exclusions verified (Q11). |
| `git diff --cached --name-only \| count` | 0 | **45** staged files; reconciles exactly as 39 product + 6 evidence docs. |

The one `test:all` failure, verbatim: `✖ legacy claims remain atomic across competing WAL writer
processes` — `Error: timed out waiting for worker readiness`
(`test/runtime/legacy-compatibility.test.mjs:271`, helper at `:426`). It reproduces green in
isolation (2.7s vs a timeout under concurrent Codex/AGY load). Classification: environmental
flake, not a candidate defect (F-7).

AGY's "123/123" headline decomposes correctly (123 = the runtime suite; 8/8 harness, 1/1 WAL,
22/22 mailbox) and is independently reproduced, with the single environmental exception above.

## The 12 answers

### 1. Migration exclusivity and nonterminal handling — PASS
`migrateMailboxV2ToV3` (src/v2/mailbox/migrate-web.ts:106-118) opens the DB with
`PRAGMA locking_mode = EXCLUSIVE` and runs preflight under `BEGIN EXCLUSIVE`. Under EXCLUSIVE
locking mode SQLite retains the file lock after COMMIT until the connection closes, so no other
writer can interleave between preflight, backup, and the DDL transaction. Preflight hard-aborts
on nonterminal state: `mailbox_v2_nonterminal` requires zero messages with
`status NOT IN ('completed','failed','uncertain','expired')` and `mailbox_v2_active_delivery`
requires zero claimed/dispatching/sent deliveries (migrate-web.ts:208-215). The migration SQL
(migrations/mailbox/003_generic_web_provider.sql) contains **no UPDATE against message or
delivery rows** — its only UPDATEs touch `mailbox_metadata` (:156-161). Rows move via
rename→copy→drop with post-copy digest equality (Q3).

**Decision-relevant observation (O-1):** `uncertain` is in the migration-acceptable set. Of the
three live nonterminal rows named in the preflight document, only the **two queued-expired
messages block cutover**; `mailbox.message.0b2155de…` (uncertain) migrates byte-preserved as-is.
AGY's preflight overstates it as requiring manual transition.

### 2. Digest-manifested backup and rollback window — PASS
Backup writes config, audit mirror, and an online `backup()` snapshot into a `.partial` dir,
verifies snapshot `integrity_check` and event count, records per-file `{sha256, byteLength}` in
`manifest.json` with `rollbackWindow: "migration_command_only_before_any_v3_work"`, then renames
atomically (migrate-web.ts:230-283). Automatic restore runs only when the DDL committed and
`assertAutomaticRestoreSafe` proves the sole post-baseline event is the migration event itself
(:350-355) — i.e., rollback exists only inside the migration command before any v3 work, exactly
as specified. After success the boundary dissolves; restore is manifest-guided manual procedure.

### 3. Preservation of v1/v2 rows, exchange bytes, event chain, audit mirror — PASS
`assertPreserved` (migrate-web.ts:341-348) proves count and canonical-digest equality for
messages, deliveries, and idempotency tables before/after; the copy carries `schema_version`
verbatim, so historical v1/v2 markings survive. Event chain re-verified link-by-link
(previous_hash + recomputed event_hash) and the audit mirror line-for-line (:390-417); exchange
bytes are not touched by this migration. The single additive event is `mailbox.schema_migrated`,
hash-chained onto the prior head (:285-307).

### 4. Surviving-writer fencing — PASS (implemented); TEST GAP (D-2)
The fence is fail-closed at the database layer: `mailbox_messages_current_schema_only` /
`mailbox_deliveries_current_schema_only` BEFORE INSERT triggers raise `stale_mailbox_writer` for
any `NEW.schema_version != 'bridge-mailbox-v3'` (003 SQL :108-114; identically in the fresh-create
DDL, store.ts:761-764). A surviving v2 writer cannot insert. Companion triggers block new
`gemini` rows (`retired_mailbox_provider`) and freeze historical gemini rows read-only. Defect
noted under D-2: the v3 fence trigger has **no test** (the analogous v2 fence is tested).

### 5. Provider rules — PASS
Type layer: `MailboxProvider = "chatgpt" | "antigravity" | "web"`; `gemini` exists only as
`MailboxStoredProvider` (types.ts:9-10). The same three-provider invariant is enforced at every
entry: service.ts:305, store.ts:906, exchange.ts:143, cli.ts:195, broker.ts:173, config.ts:109.
`activeProvider` additionally rejects gemini (`mailbox_legacy_provider_read_only`,
store.ts:909-911). New web services are `webNodeId`s under the one `web` provider, not new
providers. No undocumented provider appears anywhere in scope.

### 6. Exact-origin WEB-node profiles; no `<all_urls>` — PASS
`integrations/web-nodes/profiles/perplexity.json` pins `origin: "https://www.perplexity.ai"`,
closed selector lists, bounded behavior (timeout 720s, maxBytes 1 MiB), and no scripting fields.
The checked-in manifest requests only loopback plus `https://chatgpt.com/*`; the installer
generates `host_permissions` and `content_scripts.matches` from **enabled profiles' exact
origins** (`${profile.origin}/*`, install.ts:63-85). `<all_urls>` appears nowhere. Observation
O-4: the repo manifest is a snapshot; the installer output is the authoritative permission set.

### 7. Browser-owned auth state and credential isolation — PASS
A full pattern sweep of the extension (cookie, localStorage, sessionStorage, token, credential,
password, chrome.cookies, document.cookie) finds only Bridge's own `brokerToken` (local broker
bearer, `GENERATED_OUTSIDE_SOURCE` in the example config) and per-claim `deliveryToken`. No page
auth state is read or serialized into payloads, Git, Drive, or SQLite. Observation O-5: the
installer materializes the live broker token in plaintext at
`<stateDir>/…/chrome-mailbox/config.json` — by design for local broker auth, outside Git/pack,
but worth knowing it exists on disk.

### 8. No-auto-resend, dispatch boundary, uncertainty, idempotency, leases — PASS
The dispatch boundary is `claimed → dispatching` (store.ts:285-296). Post-boundary failure or
lease expiry lands in `uncertain`, never re-queued (store.ts:400-408, 607-610); the claim query
selects only `queued` rows (store.ts:241), so `uncertain` can never be re-executed. Pre-dispatch
retries are bounded by `max_attempts` and TTL. Idempotency is table-enforced with immutable rows
(`(principal_id, operation, idempotency_key)` PK; reuse with a different request hash →
`mailbox_idempotency_key_reused`). Leases: unique partial index `mailbox_one_active_delivery`
guarantees at most one active delivery per message; completion re-validates the live lease and
the sha256-hashed delivery token; duplicate completion is idempotent-or-conflict
(`mailbox_response_retry_conflict`).

### 9. Immutable Drive envelopes; readable WEB provenance — PASS
Every publish routes through `writeImmutable` (exchange.ts:229-254): existing path → bytes must
be identical or `mailbox_immutable_object_collision`; new path → exclusive temp (`wx`), fsync,
atomic hardlink; the EEXIST race re-verifies identity. No overwrite primitive exists in the file.
WEB outputs are written as immutable Markdown carrying message id, node id, timestamps, prompt
and response SHA-256s, and the conversation link; `validateConversationUrl` forces the link's
origin to equal the profile's destination origin (service.ts:351), and the service re-asserts
message/provider binding on readback. Nuance: the origin is attributable via nodeId +
conversation URL rather than a standalone field — adequate, noted.

### 10. Schemas, examples, migration tests, installer, extension — PASS with material test gap (D-2) and two request-assumption corrections
All seven v3 schemas declare draft 2020-12, `required`, and `additionalProperties: false` at
every object (justified exceptions: the `$defs`-only common schema root and the `webNodes`
dictionary). All five examples validate conceptually; no mismatch found. Two corrections to the
request's assumptions, reported as facts, not defects: the wire schemas define **no
state/status field** (lifecycle state is a DB-layer CHECK enum), and IDs are **prefixed
identifiers** (`^mailbox\.message\.…`), not UUID-validated — examples merely look like UUIDs.
Migration tests are thorough for v1→v2 (including nonterminal abort, digest-verified backup,
restore-after-failure roundtrip, corrupt-chain fail-closed, reparse rejection) — see D-2 for the
v2→v3 asymmetry. WEB-provider dispatch is exercised end-to-end in `mailbox.test.mjs` (webNodeId
validation, claim, result readback; green 22/22) — a placement note only. Installer behavior is
predictable; one minor defect D-4 (hardcoded `--node perplexity` in the returned instruction).

### 11. File completeness, packaging, machine-local exclusions — PASS with self-audit corrections
45 staged = **39 intended product files + 6 evidence docs — reconciles exactly**. `npm pack
--dry-run` (300 files) includes every v3 artifact (schemas, examples, compiled mailbox v3 code,
extension, profile, 003 SQL) and leaks nothing sensitive: no live config, tokens, SQLite/WAL,
audit state, browser state, or Drive content; `.git/info/exclude` covers all machine-local agent
dirs (verbatim list captured in evidence). Caveat: pack was run with `--ignore-scripts` to honor
read-only review; the enumerated `dist/` is the on-disk build, not a fresh rebuild. Corrections
(O-2): the completion audit omits itself from its own inventory; the verification doc's embedded
`git status` lists 41 of the real 45 (its snapshot predates staging of four evidence docs);
AGY's whitespace fix during verification modified a staged file after "freeze." Also O-3: the
frozen-patch file (`frozen-mailbox-v3.patch`) is not locatable under the repo, so its recorded
SHA-256 could not be independently verified; this review read the live index directly, which is
what a commit would capture.

### 12. D-021 truthfulness; ADR 0010 / caps decision boundary — MIXED: truthful reporting PASS; one material policy disagreement (P-1); register hygiene defects (D-3)
Truthfulness: AGY did not self-certify, reported the failed review dispatch honestly (empty
findings table), left commits blocked, kept `CAPS_GATE=CLOSED`, preserved caps files unstaged
byte-for-byte, and ADR 0010 is correctly marked "Proposed (Owner Confirmation Required)" with
packages 08–13 explicitly disclosed as missing and out-of-scope. D-027 (WEB nodes) claims prior
owner approval by the 2026-07-18 direction — consistent with ADR 0009's accepted status; the
underlying direction is not verifiable from code and is taken as recorded history.

**P-1 (policy disagreement, owner adjudication required):** ADR 0010 §4 defines the catalog as a
hard gate — "If a capability is not explicitly defined and authorized within the catalog, it
cannot be invoked" — and §6 mandates "if a free capability can satisfy the intent, it must be
used." The owner's design authority (docs/caps/DESIGN.md, embedded owner requirements) specifies
the opposite posture: catalog = discovery + per-caller routing recipes, "answers are hints,"
callers keep native access, and the paid rule is a **ranking/anti-auto-invocation reflex with
owner override**, not a mandatory-use rule or invocation gate. The staged register block is
closer to the owner's intent than the ADR ("under no circumstances will a paid capability be
automatically invoked if a free capability can satisfy the intent, unless explicitly overridden
by the owner per-request"). The drift is material because accepting ADR 0010 as written would
re-architect caps from a control-plane directory into an invocation authorizer. Correctly gated
behind owner confirmation; this review preserves the disagreement and resolves nothing.

**D-3 (defects, editorial, in a governance artifact):** the caps register block has **no decision
ID** (breaks D-001…D-027 numbering), contains literal byte-floor padding, and carries character
corruption inside the security-invariant text: "vailable_for_install" and twice "ree" for
"free." **O-6 (observation):** byte-floor padding sections appear in five review/governance
artifacts; padding-to-floor incentivizes noise in durable records and should be dropped from the
job rules.

## Findings register

**Defects**
- **D-1 — No sanctioned disposition path for the owner-decision the preflight requests.** The
  preflight (criterion 6) instructs the owner to disposition the two queued-expired messages
  "via the Bridge UI or a standard API call (not raw SQL)" — **no such command exists on any
  surface**: no cancel/expire/dispose verb in the CLI, no broker route, no service method, no MCP
  tool; no `cancelled` status exists in the enum; `uncertain` has no sanctioned exit at all. The
  only sanctioned terminalization is the private expiry sweep (`queued/preparing` past
  `expires_at` → `expired`) that runs inside `claimNext` — which **does** cover these two rows
  since both expired 2026-07-23: one claim cycle against their provider(s) on the live v2 broker
  disposes them without raw SQL. Severity: does not invalidate v3 code; it does invalidate the
  preflight's proposed mechanism as written, and leaves `uncertain` rows permanently frozen by
  design-without-a-tool.
- **D-2 — v2→v3 fail-closed test asymmetry.** All fail-closed migration tests target v1→v2 only.
  Missing for v2→v3: nonterminal/active-delivery abort test, backup-restore roundtrip, manifest
  digest verification, audit/event-corruption fail-closed, and any test of the v3
  `stale_mailbox_writer` fence trigger; the nonterminal loop also omits `claimed`/`dispatching`.
  The underlying logic is verified by reading (Q1–Q4) and mirrors the tested v1→v2 pattern, but
  the candidate's safety story for the exact migration being cut over rests on inspection, not
  tests.
- **D-3 — Register hygiene** (no ID, padding, corrupted invariant text) — see Q12.
- **D-4 — Installer hardcodes `--node perplexity`** in the returned start command regardless of
  configured nodes. Minor.

**Policy disagreements (preserved, owner to adjudicate)**
- **P-1 — ADR 0010 invocation-gate and must-use-free drift** vs owner DESIGN.md (Q12).
- **P-2 — Byte-floor rules** driving padding in durable artifacts (O-6) — a job-rule choice, not
  code.

**Observations**
- O-1 uncertain-row is not a cutover blocker (code) despite the preflight saying otherwise;
  O-2 self-audit inventory inconsistencies; O-3 frozen-patch hash unverifiable as located;
  O-4 manifest-vs-installer authority; O-5 plaintext broker token in state dir (by design);
  O-6 padding practice; O-7 the runtime WAL-race readiness timeout is load-sensitive (flake
  under concurrent agent activity; passes isolated).

## Unresolved-material statement

No defect was found in the v3 migration, fencing, preservation, provider, dispatch, exchange, or
extension code that would corrupt data or violate the stated invariants; all required suites pass
on re-execution. **Material items that remain unresolved before a truthful cutover:** (1) D-1 —
the preflight's disposition instruction is unimplementable as written; the owner must either use
the sanctioned sweep path for the two queued-expired rows or direct that a disposition command be
built; (2) D-2 — the v2→v3 fail-closed test gap; the owner may accept inspection-verified logic
or require the missing tests first; (3) P-1 — ADR 0010 must be aligned with the owner's design
or the owner must explicitly adopt the gate model, before any caps acceptance (independent of the
v3 cutover; CAPS_GATE is already CLOSED). Criteria 3, 4, 6, and 8 of the cutover checklist
remain owner-execution items by design.

This review does not approve the draft, does not authorize cutover, and hands off no
implementation. It reports what was verified, how, and what remains.
