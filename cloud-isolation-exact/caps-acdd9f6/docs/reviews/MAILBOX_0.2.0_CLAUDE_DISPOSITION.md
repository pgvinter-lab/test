# Bridge 0.2.0 Provider Mailbox Claude Review Disposition

Status: ACCEPTED FIXES IMPLEMENTED; DRAFT REMAINS UNFROZEN

Review: `docs/reviews/MAILBOX_0.2.0_CLAUDE_REVIEW.md`

This disposition does not approve or freeze either draft contract. It records
which independent-review findings were accepted, deferred, or rejected and why.
The original Claude review is preserved unchanged.

## Medium findings

| Finding | Disposition | Result |
|---|---|---|
| M-1 delivery token reached the content script | Accepted | The service worker now sends only `messageId`, provider, prompt, and expiry to the isolated page script. Delivery and broker tokens remain in extension-worker state. A static regression test forbids `deliveryToken` in `content.js`. |
| M-2 advertised `::1` was malformed | Accepted | One canonical URL builder brackets IPv6 loopback; broker, doctor, installer, and extension use it. A regression vector verifies `http://[::1]:port`. |
| M-3 exchange writes could tear | Accepted | Objects and ready markers are fully written and fsynced to same-directory temporary files, then atomically published by a create-only hard link. Unsupported filesystems fail closed. The actual configured Drive exchange completed a synthetic message/response smoke through this path. |
| M-4 sensitivity was decorative | Accepted | Mailbox v1 now supports only `public` and `internal`. `confidential` and `restricted` are removed from the schema/types/MCP surface and rejected at runtime until encrypted exchange handling exists. |
| M-5 arbitrary `tabs[0]` reuse | Accepted | Each new claim receives a new extension-created, background provider tab. Existing user conversations are never selected. Pending state binds the exact tab ID; a missing post-send tab becomes uncertain. |
| M-6 scraped response lacks cryptographic prompt binding | Accepted as inherent residual risk | Dedicated per-message tabs, a longer stability window, provider origin checks, conversation URL, response hash, and Chrome consumer ID improve provenance but cannot prove model causality. The immutable response means "bytes captured," not "verified truth." D/A-2 remains preserved; no claim of cryptographic binding is made. |

## Low and informational findings

- L-1 accepted: broker CORS origins now default to empty. Extension host
  permissions do not require page-origin CORS.
- L-2 accepted: the global Chrome `tabs` permission was removed; provider host
  permissions and basic tab APIs are sufficient.
- L-3 deferred: full audit-prefix verification on append is intentionally retained
  for fail-closed tamper detection at the expected local mailbox volume. A future
  checkpoint design may optimize it without weakening verification.
- L-4 rejected as factually inapplicable: `ensureReadme()` already returns when the
  README exists. The accepted M-3 atomic publisher also removes the torn initial
  write case.
- L-5 accepted for the v1 baseline: SQLite `user_version=1` and the metadata
  version are asserted; unknown versions fail closed. No v2 schema change may ship
  without a numbered mailbox migration and upgrade/rollback tests.
- L-6 accepted: the Gemini manifest now resolves `node` from PATH instead of
  baking one installation path.
- I-1 accepted: identifier bounds are consistently capped at 180 characters.
- I-2 accepted: provider CLI consumers use `provider.<provider>.cli`.
- I-3 accepted: broker delivery routing is an explicit switch with one response.

## Additional integration fixes

- Heartbeats can no longer shorten an existing lease.
- Generated integration targets, database, audit, and token paths must remain
  inside the local mailbox state root and reject symlink/reparse redirection.
- Gemini MCP `take` crosses `dispatching` and `sent` before returning the prompt to
  model context, so a crash cannot expose then auto-retry it.
- Bridge MCP enqueue now requires a caller-supplied idempotency key.
- Conversation URLs reject embedded credentials.

## Preserved policy positions

- P-1 remains owner-approved: `public`/`internal` prompt and response bytes may be
  replicated to the dedicated Drive exchange. Database/WAL, tokens, credentials,
  browser state, and recovery keys remain excluded.
- P-2 remains owner-approved under D-025: the local MCP/CLI enqueue call is the
  audited one-message authorization when no prior approval reference is supplied.
  There is no second-factor prompt. Provider/origin/use/expiry cannot widen.
- D/A-1 and D/A-2 remain preserved in the original review. D/A-3 is resolved by
  implementing IPv6 loopback support rather than dropping it.

## Verification

Claude Code could not execute commands because its subprocess approval gate did
not clear; that limitation remains accurately recorded in the review. Codex then
ran the revised candidate:

- `npm run test:mailbox`: 8/8 passed, including real stdio provider MCP.
- `npm run contract-test`: all core and mailbox schemas/examples/semantic vectors
  passed.
- Live synthetic broker/Drive smoke: completed in one attempt; SQLite integrity
  `ok`, journal `wal`, 7 event rows, 7 audit mirror rows, 7 verified chain rows.

The full inherited suite must be rerun after these accepted edits before commit.
