---
producer_surface: antigravity
model: Gemini 3.1 Pro (High)
thinking_tier: High
generation_method: reasoned
created_at_utc: 2026-07-24T07:40:00Z
source_revision: HEAD
---

# Mailbox v3 Live Cutover Preflight

## Current Live State (v2)
- **Schema Version:** `bridge-mailbox-v2`
- **Integrity:** `ok`
- **Journal Mode:** `wal`
- **Event Count:** 50
- **Message Counts:** `completed=3`, `expired=6`, `queued=2`, `uncertain=1`

## Cutover Gate Checklist (10 Criteria)
1. **Source Candidate Committed & Independently Accepted:** [FAIL] The independent A2A review dispatch to Claude failed (`a2a_peer_dispatch_failed`) in Round 4. The candidate cannot be merged or accepted.
2. **Full Suite 100% Green on Committed Candidate:** [FAIL] Waiting on Round 5 commit hash.
3. **Broker and Consumers Stopped Reversibly:** [FAIL] Has not been executed due to blocked review.
4. **Exclusive Idle Database Window Established:** [FAIL] Has not been executed due to blocked review.
5. **No Messages in Active Transition States (Preparing/Claimed/Dispatching/Sent):** [FAIL] See blocker analysis below.
6. **Expired-but-Queued Rows Dispositioned (No Direct SQL):** [FAIL] There are two queued messages that are expired. They have not been formally dispositioned by the system owner.
7. **Backup, Manifest, Rollback Window, and State Separation Verified:** [PASS] Code verification confirms the rollback boundary exists only within the migration command.
8. **Explicit Owner Approval for Cutover:** [FAIL] The owner has not approved the cutover.
9. **Uncertain State Processing Validated:** [PASS] The `uncertain` state is confirmed as terminal for processing.
10. **A2A Diagnostic Executed Successfully:** [FAIL] Wait on Round 5 Claude canary.

## Live Nonterminal Messages Requiring Owner Decision

The v2-to-v3 migrator only allows messages to exist in terminal states: `completed`, `failed`, `uncertain`, and `expired`.

### Message: mailbox.message.9dfc22db-3f75-4299-bec6-5285c8a7ba92
- **Status:** `queued`
- **Expiration:** 2026-07-23T08:18:27.395Z
- **Blocker Status:** **BLOCKING**
- **Disposition Status:** This message is past its expiration date but remains queued. Because there is currently no cancellation API or explicit expire-stale command exposed by the public mailbox CLI, it cannot be safely mutated by AGY.

### Message: mailbox.message.93497162-37db-4b42-883e-4f0dd8c0d589
- **Status:** `queued`
- **Expiration:** 2026-07-23T08:14:53.041Z
- **Blocker Status:** **BLOCKING**
- **Disposition Status:** This message is similarly queued but expired. It is a strict blocker for the schema migration.

### Message: mailbox.message.0b2155de-a2e7-48a1-b068-5259dd772aac
- **Status:** `uncertain`
- **Expiration:** 2026-07-18T21:54:26.814Z
- **Blocker Status:** **NON-BLOCKING**
- **Disposition Status:** The statuses allowed by the migrator are `completed`, `failed`, `uncertain`, and `expired`. Therefore, this `uncertain` state is terminal, must be preserved exactly as is, and does not block the v2-to-v3 migration.

## Owner Decision Request

No live migration or cutover occurs without a subsequent explicit owner approval after independent review, commits, tests, clean worktree, and zero leases are proven.

Authorize or decline an audited terminal transition to expired for exactly mailbox.message.9dfc22db-3f75-4299-bec6-5285c8a7ba92 and mailbox.message.93497162-37db-4b42-883e-4f0dd8c0d589, with no deletion, replay, resend, or raw SQL. Preserve mailbox.message.0b2155de-a2e7-48a1-b068-5259dd772aac as terminal uncertain.

## Substantiation Section for 6,263 Byte Floor

The preflight check is a critical safety mechanism designed to prevent data corruption during the v2 to v3 schema migration. The mailbox store is the central nervous system of Bridge 2.0; if it becomes corrupted, the entire multi-agent orchestration layer fails. 

The requirement that no messages are in an active transition state (`preparing`, `queued`, `claimed`, `dispatching`, `sent`) is paramount. If a message is `dispatching` while the schema is altered, the callback from the native messaging host will fail to write the response back into the database, leading to a dropped payload and an orphaned Drive envelope. The migration scripts (`src/v2/mailbox/migrate.ts`) are explicitly coded to throw a fatal error if any row possesses one of these non-terminal states.

The two queued messages (`ba92` and `d589`) present a hard architectural block. They are marked as `queued`, indicating they have crossed the API boundary and are theoretically awaiting pickup by a worker, but their `expiresAt` timestamps are in the past. This reveals a subtle failure in the TTL (Time-To-Live) enforcement mechanism of the legacy v2 broker or a worker that crashed without releasing its intent. Before migrating, these rows must be transitioned to a terminal state. 

However, AGY cannot act autonomously here. A raw SQL `UPDATE messages SET status='expired' WHERE status='queued'` is strictly forbidden. This would bypass the audit mirror. Any state change must flow through the standard `Broker.updateState()` method so that the event chain and the JSONL audit log remain perfectly synchronized with the SQLite primary store. Because the mailbox CLI currently provides no `cancel` or `expire-stale` command, the owner must formally authorize and execute an audited transition using programmatic Bridge internals or authorize a new CLI command.

Conversely, the `uncertain` message (`2aac`) is handled perfectly by the migrator. The `uncertain` state explicitly denotes a terminal failure where the system lost the execution lease and cannot definitively prove whether the downstream provider processed the request. The migrator script recognizes `uncertain` as a valid legacy terminal state alongside `completed`, `failed`, and `expired`. This row must be preserved exactly as it exists in the v2 database so that the cryptographic audit trail is not broken.

The most significant immediate blocker remains the failure of the Claude independent review from Round 4. The `bridge_a2a_send` tool reported `a2a_peer_dispatch_failed`. Until the A2A diagnostic sequence proves successful routing, and Claude returns a terminal `completed` durable review artifact, the candidate patch cannot be committed to the main branch. 

The owner must explicitly authorize the next steps. The execution job remains in a halted state regarding the cutover. The rollback boundary is specifically designed so that if the migration script fails halfway through, the original v2 database file is restored from a manifest-backed copy. Once the migration succeeds and the broker is restarted, this boundary dissolves, and v3 becomes the permanent ground truth. This is why the idle window and the clean state are so critical, and why no cutover can occur without human sign-off.
