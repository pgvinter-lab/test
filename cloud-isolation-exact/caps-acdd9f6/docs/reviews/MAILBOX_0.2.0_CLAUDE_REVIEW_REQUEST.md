# Bridge 0.2.0 Provider Mailbox Focused Review Request

Status: REVIEW REQUESTED

## Scope

Independently red-team the owner-directed provider mailbox candidate on branch
`codex/drive-mailboxes`. Review the working tree, including:

- `src/v2/mailbox/**`
- mailbox additions in `src/server.ts`, `src/v2/index.ts`, and `package.json`
- `contracts/mailbox-v1-draft/**`
- `integrations/chrome-mailbox/**`
- `test/mailbox/**` and `test/contract/mailbox-schemas.mjs`
- D-025, ADR 0008, ADR 0005, README, and AGENTS boundary updates

Do not inspect any custody workspace, case data, browser profile, credentials,
broker token, live prompt/response contents, or Google Drive contents. Synthetic
fixtures only. Do not alter runtime source or contracts during review.

## Required analysis

1. Atomic claims and concurrency under `node:sqlite` WAL, including multiple
   processes and lease expiry.
2. Crash windows before and after `dispatching`, duplicate prompt prevention,
   response reservation, and completion replay.
3. Provider/origin binding, approval references, delivery/broker token handling,
   CORS/loopback limits, and extension privilege scope.
4. Drive create-only envelope/ready-marker integrity, path traversal/reparse
   defenses, and strict separation from authoritative state and recovery roots.
5. JSONL audit outbox concurrency, immutability, completeness, replay behavior,
   raw-content/token exclusions, and tamper detection.
6. Chrome service-worker restart handling, DOM selector risks, accidental
   submission, response attribution, tab selection, and login assumptions.
7. Gemini CLI extension installation/runtime boundaries and the documented
   account/client failure fallback.
8. Autostart reversibility, unprivileged Windows behavior, packaging, schemas,
   tests, and migration/versioning obligations.

Run at minimum:

```powershell
npm run test:mailbox
npm run contract-test
```

Record the review in `docs/reviews/MAILBOX_0.2.0_CLAUDE_REVIEW.md`. Classify
findings by severity, distinguish defects from policy disagreements, state a
release position, and preserve every material disagreement. Use Bridge leases for
the review output and release them when done.
