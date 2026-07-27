# Bridge 0.2.0 Provider Mailbox Verification

Date: 2026-07-14

Status: LOCAL RELEASE CANDIDATE VERIFIED; MAILBOX CONTRACT REMAINS DRAFT

This record covers the sanitized source candidate and the local runtime. It does
not freeze either contract, authorize a public/cloud deployment, or publish a
GitHub repository.

## Independent review

- Claude Code completed the focused review in
  `MAILBOX_0.2.0_CLAUDE_REVIEW.md`.
- Claude reported no critical or high finding. M-1 through M-5 were accepted and
  fixed. M-6 remains an explicitly documented browser-capture provenance limit.
- Accepted, deferred, rejected, and disputed positions are preserved in
  `MAILBOX_0.2.0_CLAUDE_DISPOSITION.md`; the original review is unchanged.
- Claude's subprocess approval gate prevented it from running commands. Codex
  independently executed every verification below after the accepted fixes.

## Test evidence

`npm run test:all` completed successfully:

- Legacy end-to-end checks: 17 passed.
- MCP smoke: passed with the four mailbox tools advertised.
- Session checks: 8 passed.
- Legacy fix-regression checks: 14 passed.
- Connector structure checks: ChatGPT, Gemini, and AI Studio passed.
- Core contract schemas/examples/semantic vectors: passed.
- Mailbox schemas/examples/provider/hash vectors: passed.
- Mock client contract: passed.
- Bridge 2.0 runtime tests: 48 passed.
- WAL multi-process stress: 1 passed.
- Mailbox runtime/integration tests: 8 passed.
- Chrome service-worker, content-script, and popup syntax checks: passed.

`npm pack --dry-run --json` also completed successfully. The package contains
the sanitized `config.example.json`; it excludes the live mailbox config, broker
token, SQLite/WAL state, audit mirror, browser state, and Drive exchange.

## Live local checks

- Authenticated broker health returned `ok: true` on `127.0.0.1:7319`.
- SQLite integrity returned `ok`; journal mode is `wal`.
- The immutable event journal and JSONL audit mirror both verified 7 linked rows.
- A synthetic message completed in one attempt through the configured Drive
  exchange using atomic create-only publication.
- User-logon autostart is installed in the Windows Startup folder. Scheduled-task
  creation was unavailable without elevation, so the installer used its
  documented non-elevated fallback.
- Gemini CLI extension `bridge-mailbox` version `0.2.0` is installed and enabled.
- The Chrome extension was regenerated under the local mailbox state directory.
  Loading it into Chrome remains an action-time-confirmed browser operation and
  is not represented here as completed.

## Sanitization checks

Working-tree scans found no high-confidence private-key/API-token signatures,
browser databases, runtime databases, audit JSONL, archives, evidence/document
media, one-off run files, case-data indicators, or source files over 1 MiB.
`git diff --check` reported no whitespace errors. Dedicated scanners were not
installed, so the credential check used explicit high-confidence signatures and
artifact/filename allow-deny inspection.

## Residual limits

- Browser DOM capture cannot cryptographically prove model causality or bind the
  response to the prompt. Dedicated tabs and immutable hashes narrow but do not
  eliminate this limit.
- Provider DOM changes can require selector maintenance.
- Automatic web delivery requires Chrome to be running and authenticated.
- The installed Gemini CLI currently reaches the extension but the account/client
  is rejected before model execution; the browser consumer is the primary Gemini
  route until Google resolves that eligibility condition.
- GitHub publication remains owner-deferred and was neither attempted nor failed.
