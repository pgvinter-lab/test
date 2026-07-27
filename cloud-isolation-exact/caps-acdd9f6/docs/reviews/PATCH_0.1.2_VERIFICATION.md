# Bridge 2.0 Patch 0.1.2 Verification

Status: RELEASE CANDIDATE - LIVE CUTOVER BLOCKED BY KEY CAPSULE

Date: 2026-07-14

## Scope

Patch `0.1.2` makes Bridge 2.0's historical `dist/server.js` entrypoint a drop-in
legacy MCP surface backed by SQLite/WAL. It adds lane-specific principals for
Codex, Claude Desktop Code, and Claude Desktop Cowork; imports Bridge 1.x
coordination state only after all live leases are released; and records accepted
compatibility commands in the immutable event journal and JSONL audit mirror.

The versioned `bridge_v2_*` job tools and draft contract remain available. GitHub
publication, cloud deployment, product implementation, and permanent deletion of
Bridge 1.x remain outside this patch.

## Verification to date

- `npm run build`: passed.
- `npm test`: passed, 17 inherited end-to-end checks, 8 session checks, 14 fix
  regression checks, and the default MCP tool-list/identity smoke.
- `npm run connectors-test`: passed for ChatGPT, Gemini, and AI Studio manifests.
- `npm run contract-test`: passed, including 12 schemas, 12 valid examples, 33
  rejection cases, canonical hashing, and mock-client behavior.
- `npm run test:runtime`: passed after review hardening, 45 tests. The focused
  compatibility suite passes 7 tests. Coverage includes three distinct
  local lanes, persistent SQLite coordination, import idempotency, simultaneous
  competing process claims, immutable same-basename project bindings, complete
  audited command outcomes, and the exact `dist/server.js` stdio path.
- `npm run test:wal-race`: passed the permanent 20-round, four-process JSONL/WAL
  concurrency stress gate.
- `npm run test:all`: passed end to end after all accepted Claude findings were
  implemented.

## Pending gates

- Commit and `v0.1.2` tag.
- Verified encrypted full backup before applying migration 002 to the existing
  live Bridge 2.0 database.
- Legacy registry/state import with zero live leases.
- Direct pre-cutover and fresh-client post-cutover smoke tests.
- Reversible junction switch; Bridge 1.x remains intact as fallback.

## Independent review

- Original Claude Code review: conditional PASS, with H-1, H-2, M-1, and M-2
  accepted for immediate hardening.
- Follow-up Claude Code review: PASS for closure of every accepted finding;
  reversible cutover remains conditional PASS.
- Repository scan and package inventory: PASS; see
  `SECRET_SCAN_PATCH_0.1.2.md`.

## Current live-state blocker

The primary Drive recovery root is available, but the separately designated
recovery-key account is not mounted or authenticated in this environment and the
private recovery procedure records that no wrapped key capsule exists. D-016
therefore prevents creation of a recoverable encrypted full-state backup. Migration
002 and the junction switch must not run until the owner selects the still-deferred
capsule wrapping/external-secret procedure and the capsule is placed in the
designated account. This is an owner-policy prerequisite, not a test failure.
