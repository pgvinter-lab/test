# Changelog

## Unreleased

### Changed

- Replaced new Gemini mailbox work with the local Antigravity MCP plugin while
  preserving historical Gemini rows and v1 Drive objects as immutable,
  read-only evidence.
- Added a restore-safe v1-to-v2 migration with schema fencing, event-chain
  extension, verified backups, and reparse-point containment.
- Pinned outbound Antigravity dispatch to `Gemini 3.1 Pro (High)` after a live
  subscription response and promoted the peer to fail-closed `verified` status.
- Restricted the `google_antigravity` worker to forward-only updates of its own
  assigned tasks without ownership reassignment.

### Safety

- Chrome mailbox automation is now ChatGPT-only; no Gemini or Antigravity web
  origin remains in the extension.
- The generated Antigravity plugin embeds the exact selected mailbox config
  path and creates no API key, remote MCP tunnel, or public endpoint.

## 0.2.0 - 2026-07-14

### Added

- Added a provider-bound ChatGPT/Gemini mailbox with SQLite/WAL authority,
  immutable Drive envelopes, atomic claims, idempotent response publication, and
  a bearer-authenticated loopback broker.
- Added Bridge MCP and CLI enqueue/status tools, an automatic Chrome consumer,
  an optional Gemini CLI MCP extension, draft JSON Schemas, and contract/runtime
  tests.

### Safety

- Each enqueue authorizes one exact provider/origin/use. Failures after the
  `dispatching` transition become `uncertain` and are never auto-resubmitted.
- Mailbox state, tokens, credentials, and browser state remain outside Drive and
  Git; no public endpoint or paid cloud resource is created.

## 0.1.1 - 2026-07-13

### Fixed

- Removed a check-then-stat race when transient SQLite WAL or shared-memory
  sidecars disappear during concurrent runtime startup.
- Revalidated audit-mirror and SQLite path separation after WAL initialization.
- Added deterministic sidecar-removal coverage and a permanent 20-round,
  four-process concurrency stress command.
