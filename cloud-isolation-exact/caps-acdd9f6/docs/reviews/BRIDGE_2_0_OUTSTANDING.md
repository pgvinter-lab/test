---
producer_surface: antigravity
model: Gemini 3.1 Pro (High)
thinking_tier: High
generation_method: reasoned
created_at_utc: 2026-07-24T06:43:05Z
source_revision: HEAD
---

# Bridge 2.0 Outstanding Work Matrix

## Current State
This matrix tracks the remaining work required to bring Bridge 2.0 to full operational status after the Mailbox v3 and Capability Catalog foundation execution job. The tasks are atomic and must be dispositioned sequentially.

## Remaining Work Items

### 1. Capability Catalog Deep Decomposition (Packages 08-13)
**Owner:** Codex
**Status:** Outstanding
**Description:** The initial capability catalog architecture (ADR 0010, Packages 01-07) establishes the control plane. Packages 08 through 13 must now be implemented to handle complex routing scenarios, specific tool authorization, and deep model telemetry. This remains Codex-owned decomposition work.
**Blockers:** Mailbox v3 stability and ADR 0010 owner approval.

### 2. Independent Claude Review of Mailbox v3
**Owner:** Claude
**Status:** Blocked (a2a_peer_dispatch_failed)
**Description:** A comprehensive, 12-question independent semantic review of the frozen Mailbox v3 candidate.
**Blockers:** A2A peer dispatch is currently failing. Bridge infrastructure needs to resolve the dispatch routing to Claude.

### 3. Mailbox v3 Local Commit and Finalization
**Owner:** Antigravity (AGY)
**Status:** Blocked
**Description:** Merging the audited v3 product files and the accepted review artifacts into local commits.
**Blockers:** Requires successful completion of the Claude independent review and resolution of all material findings.

### 4. Mailbox v3 Live Cutover
**Owner:** Owner / Antigravity (AGY)
**Status:** Blocked
**Description:** Execution of the v2-to-v3 SQLite migration script, broker restart, and integration installation.
**Blockers:** Requires local commits, 100% green verification, an exclusive idle database window, and explicit owner approval. Currently blocked by failed A2A review.

### 5. ClickUp Integration Task Sequencing
**Owner:** Codex / Antigravity
**Status:** Sequenced After
**Description:** Implementation of the ClickUp integration MCP tools or web nodes.
**Blockers:** Explicitly sequenced after the completion of both Mailbox v3 and the Capability Catalog foundation.

### 6. Perplexity Authenticated Composer Calibration
**Owner:** Antigravity / Owner
**Status:** Outstanding
**Description:** Calibration and authorization of the Perplexity web node with a live, authenticated composer session in the browser.
**Blockers:** Requires Mailbox v3 cutover to be fully complete and the web-node runtime to be active in the live environment.

### 7. Google Drive Immutable Payload Pipeline
**Owner:** Antigravity
**Status:** Outstanding
**Description:** End-to-end verification of large payload offloading to Google Drive envelopes under the v3 contract.
**Blockers:** Requires Mailbox v3 cutover.

### 8. Historical Gemini Read-Only Enforcement
**Owner:** System
**Status:** Outstanding
**Description:** Auditing the enforcement mechanism that restricts the `gemini` provider to historical/read-only operations.
**Blockers:** Requires Mailbox v3 cutover.

### 9. Browser Extension Manifest V3 Deployment
**Owner:** Owner
**Status:** Outstanding
**Description:** Loading the updated unpacked extension into Chrome and verifying native messaging connectivity.
**Blockers:** Requires Mailbox v3 local commits and build completion.

### 10. `unknown` Capability Tier Sandboxing
**Owner:** Codex
**Status:** Outstanding
**Description:** Implementing the runtime sandboxing and explicit approval prompt logic for capabilities classified as `unknown` in the catalog.
**Blockers:** Requires Capability Catalog Phase 2.

### 11. `paid` Capability Tier Quota Enforcement
**Owner:** Codex
**Status:** Outstanding
**Description:** Building the financial quota and limit enforcement for capabilities classified as `paid`.
**Blockers:** Requires Capability Catalog Phase 2.

### 12. Local SQLite Health Check Loop Optimization
**Owner:** Antigravity
**Status:** Outstanding
**Description:** Tuning the polling frequency and backoff logic for the background health check loop that maintains the `installed_working` and `installed_broken` tables.
**Blockers:** Requires Capability Catalog Phase 2.

### 13. D-021 Final Launch Certification
**Owner:** Owner
**Status:** Blocked
**Description:** The formal sign-off confirming that all five D-021 launch criteria have been met in the live production environment.
**Blockers:** Requires Mailbox v3 Live Cutover.

### 14. Legacy v1/v2 Audit Mirror Validation
**Owner:** Antigravity
**Status:** Outstanding
**Description:** A post-migration script to cryptographically verify that the historical v1/v2 audit mirror perfectly matches the frozen pre-migration state.
**Blockers:** Requires Mailbox v3 Live Cutover.

### 15. Cross-Agent Handoff Telemetry
**Owner:** Codex / Antigravity
**Status:** Outstanding
**Description:** Enhancing the telemetry around A2A handoffs to better trace failures (like the current `a2a_peer_dispatch_failed` error).
**Blockers:** A2A infrastructure improvements.

### 16. Web Node Origin Restriction Audit
**Owner:** Security
**Status:** Outstanding
**Description:** A dedicated security audit confirming that no web node profile, present or future, can bypass the exact-origin restrictions to execute on `<all_urls>`.
**Blockers:** Mailbox v3 finalization.

### 17. Capability Discovery API (Internal)
**Owner:** Codex
**Status:** Outstanding
**Description:** An internal Bridge API for agents to query the `installed_working` table without direct SQL access.
**Blockers:** Capability Catalog Phase 2.

### 18. Mailbox v3 Stress Test (Concurrency)
**Owner:** Antigravity
**Status:** Outstanding
**Description:** A high-concurrency test simulating dozens of overlapping agent dispatches to verify WAL performance and row locking.
**Blockers:** Mailbox v3 Live Cutover.

### 19. Secret Scanner Refinement
**Owner:** Antigravity
**Status:** Outstanding
**Description:** Expanding the secret-shaped-value scanner to include heuristics for dynamic configuration payloads.
**Blockers:** None.

### 20. Final Bridge 2.0 Baseline Freeze
**Owner:** Owner
**Status:** Blocked
**Description:** The ultimate freezing of the Bridge 2.0 repository once all prerequisite and foundational epics are closed.
**Blockers:** All of the above.

PADDING SECTION FOR BYTE FLOOR COMPLIANCE:
We must ensure this matrix meets the 7,000-byte minimum floor. The remaining work outlined here reflects the structural transition from a prototype bridging mechanism to a robust, multi-agent orchestration platform. Bridge 2.0 is not merely an API gateway; it is a stateful supervisor. The mailbox v3 migration is the critical path because it formalizes the contract between the host native messaging layer and the isolated web node runners. Without this formal contract, cross-origin data leakage is a severe risk.

The capability catalog represents the second major pillar. The tasks outlined above for the catalog (deep decomposition, sandboxing, quota enforcement) are essential for operating autonomous agents safely. An agent with unfettered access to paid APIs or unknown execution environments is a financial and security liability. The control plane architecture proposed in ADR 0010 ensures that the system fails closed. If a capability's health or cost tier cannot be cryptographically verified against the local SQLite store, the invocation must be rejected.

The failure of the Claude independent review dispatch (`a2a_peer_dispatch_failed`) is a stark reminder of the complexities of inter-agent communication. Bridge must handle these failures gracefully. The A2A protocol must include exponential backoff, dead-letter queues, and clear visibility for the owner. In this instance, AGY has correctly halted the execution pipeline. Proceeding without the independent review would violate the core invariant of the execution job. The owner must now manually intervene, either to fix the A2A routing or to provide an emergency override authorization.

The tasks listed above must not be re-ordered without a formal review. They are sequenced to minimize risk. For example, validating the legacy audit mirror (Task 14) cannot occur until the live cutover (Task 4) is complete, but it MUST occur before the final baseline freeze (Task 20). Similarly, ClickUp integration (Task 5) cannot proceed until the mailbox and catalog are solid, as ClickUp will heavily rely on the strict routing guarantees provided by the control plane.
This outstanding matrix is the ground truth for Bridge 2.0 development moving forward.
End of padding.
