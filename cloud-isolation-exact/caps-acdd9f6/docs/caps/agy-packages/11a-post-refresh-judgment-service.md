# AGY Package 11A — Post-Refresh Judgment Service

> ## FLAGS — OWNER MUST SEE BEFORE DISPATCH
>
> - `FLAG-11-PAYLOAD` is corrected and binding. Mailbox provider enum is exactly
>   `"antigravity"`. `"provider.antigravity.mcp"` is the configured consumer ID,
>   not a provider enum; never write it into `provider` and never expand the
>   enum.
> - `bridge-caps-judgment-v1` travels as validated canonical JSON inside the
>   immutable mailbox prompt/content boundary. The normal v3 response content
>   carries the validated verdict JSON.
> - `FLAG-11-VERDICT-TRUST`: model verdicts are reported metadata only. They
>   cannot change status, pricing, installs, routing authority, or owner notes.
> - Live mailbox dispatch is not authorized here. Tests use a mock/fixture;
>   owner-gated Package 13B S6 performs the live round trip.

## 0. AGY identity, mode, and QA

- Surface/model: Antigravity, Gemini implementation model, maximum available
  reasoning.
- Worktree: isolated Wave-1 11A lane created by the single Caps factory
  orchestrator.
- Project: `C:\Users\pgvin\LLM Assisted Projects\Bridge`.
- Identity: `BRIDGE_AGENT=antigravity`,
  `BRIDGE_LANE=google_antigravity`, `BRIDGE_PROJECT=bridge`.

Scripts may format, validate, or render content you yourself reasoned out; they
may never originate substantive content. Every section's substance must trace
to your own reasoning.

Before editing, run
`C:\Users\pgvin\.gemini\antigravity\brain\4acd2eff-97e3-48fb-aa8c-9accee9ccb77\skills\agy-prompt-qa\SKILL.md`,
write/QA `ROUND1_SELF_PROMPT.md`, preserve every revision, and attach the filled
QA checklist.

## 1. Objective

Implement a closed judgment-document builder, canonical mailbox adapter, and
verdict ingester. It binds one refresh run and canonical payload hash to one v3
message/immutable prompt hash, accepts only the completed matching response,
validates it, and writes only judgment columns.

## 2. Exact paths and numeric depth floors

| File | Purpose | Derived floor |
|---|---|---|
| `src/caps/judgment.ts` | closed schemas, canonical JSON/hash, MailboxService adapter, completion binding, verdict ingestion | 1 request schema; 1 response schema; 1 canonical serializer; 2 SHA-256 bindings; 1 stable idempotency derivation; 1 completed-response gate; 5 explicit gap classes |
| `test/caps/judgment.test.mjs` | offline mock mailbox and store tests | at least 18 named tests covering schemas, canonicalization, provider/consumer distinction, send binding, idempotency, message/hash mismatch, nonterminal response, malformed content, ingestion, status/pricing/note immunity |
| `test/fixtures/caps/judgment-job.json` | canonical valid request | every request field below, at least 1 free and 1 paid candidate |
| `test/fixtures/caps/judgment-verdicts.json` | canonical valid response | at least 3 verdict enum values and all response fields |
| `src/caps/store.ts` | additive verdict method only | exactly 1 public `recordJudgmentVerdict` method; exactly 5 judgment columns mutable |
| `src/caps/types.ts` | additive judgment types only | 3 verdict values; request/response/provenance types required by the service |

Claim exactly those six paths. `src/v2/mailbox/**`, v3 schemas, migrations, and
mailbox tests are read-only. Evidence goes under
`<factory-output>\11A\`: self-prompt, immutable
`iterations\<counter>-<UTC>.patch`, QA checklist, command logs,
`acceptance-receipt.json`, and review pointer.

Every receipt entry declares one truthful method:
`reasoned`, `script-rendered-from-reasoned-data`, or `script-generated`.
False declarations, missing stamps, overwritten iterations, or deletions reject
the lane.

## 3. Frozen `bridge-caps-judgment-v1` document

The canonical request contains:

1. `schema_version`;
2. `refresh_run_id`;
3. `generated_at`;
4. `needs_profile { path, sha256 }`;
5. `diff.new_available[] { id, name, kind, pricing, category, one_liner,
   source_url, ask_first }`;
6. `diff.status_flips[]`;
7. `diff.watch_deltas[]`;
8. `rules { free_first:true, paid_ask_first:true }`;
9. `response_contract.verdicts[] { id, verdict:
   "immediate-need"|"watch"|"no", reason, pricing_ack }`;
10. response `model` and `judged_at`.

Shortlists sort free, unknown, paid. Paid entries have `ask_first:true` and
cannot be primary while a free candidate exists.

## 4. Ordered implementation requirements

1. Define closed runtime validators for request and response, canonical JSON
   serialization, and SHA-256 hashing. Reject unknown fields, duplicate IDs,
   invalid timestamps/enums, oversize text/arrays, and noncanonical reparse.
2. Place the canonical request JSON inside the immutable mailbox prompt/content
   boundary. Do not rely on an unvalidated side channel or add a mailbox field.
3. Call the existing public `MailboxService.send()` API only. Set provider enum
   to `"antigravity"`; use configured consumer ID
   `"provider.antigravity.mcp"` only where the existing API expects consumer
   identity.
4. Derive a stable idempotency key from `refresh_run_id` and canonical payload
   SHA-256. Same run+bytes returns the original receipt; same run with different
   bytes is a conflict/gap, not a new silent dispatch.
5. Persist/return the mailbox message ID, canonical payload hash, immutable
   prompt hash, idempotency key, and dispatch timestamp.
6. Accept a verdict only from a terminal completed mailbox response for that
   exact message ID and prompt/payload binding. Queued, working, uncertain,
   canceled, failed, expired, mismatched, or missing responses are not verdicts.
7. Hash response content, parse JSON, validate the closed response contract,
   and bind it to `refresh_run_id` before any DB mutation.
8. Apply known verdict IDs atomically through
   `recordJudgmentVerdict()`. Unknown IDs and malformed verdicts become bounded
   gaps and do not create rows.
9. That method may touch only `judgment_model`, `judgment_at`,
   `judgment_verdict`, `judgment_reason`, and `judgment_surface`; preserve
   `curated_notes`, status, pricing, install command, and every other field.
10. Stamp verdict provenance `producer_surface=antigravity`,
    `capture_class=reported`.
11. Tests use a mock MailboxService and fixtures only; no live send, provider
    enum change, install, network call, or model claim.

Every item and compound member is separately binding and listed in the
self-audit. `etc.` is forbidden.

## 5. No-touch zones and bus sequence

No-touch: `.connector/**`, `src/v2/mailbox/**`,
`contracts/mailbox-v1-draft/v3/**`, `migrations/mailbox/**`,
`test/mailbox/**`, Chrome/web-node integrations, `src/caps/refresh.ts`,
projection/CLI/MCP files, package/lockfiles, live DB/mailbox, Bridge 1.x,
credentials, endpoints, network, installs, and paid actions.

1. `bridge_sync({"project":"C:\\Users\\pgvin\\LLM Assisted Projects\\Bridge"})`
2. `bridge_claim({"project":"C:\\Users\\pgvin\\LLM Assisted Projects\\Bridge","paths":["src/caps/judgment.ts","test/caps/judgment.test.mjs","test/fixtures/caps/judgment-job.json","test/fixtures/caps/judgment-verdicts.json","src/caps/store.ts","src/caps/types.ts"],"note":"Caps 11A isolated Wave-1 judgment lane"})`
3. `bridge_log({"project":"C:\\Users\\pgvin\\LLM Assisted Projects\\Bridge","summary":"CAPS-11A doing: canonical v3 judgment adapter and bounded verdict ingestion","files":[]})`
4. Log exact changed paths and candidate SHA after offline gates.
5. After terminal same-SHA Claude PASS, log `CAPS-11A done` with command exits,
   review IDs, message-binding test count, and SHA.
6. Release exactly the six claims.

## 6. Verification, review, receipt, rollback

```powershell
npm run build
node --test test/caps/judgment.test.mjs
node --test test/caps/store.test.mjs
npm run contract-test
git diff --check -- src/caps/judgment.ts src/caps/store.ts src/caps/types.ts test/caps/judgment.test.mjs test/fixtures/caps/judgment-job.json test/fixtures/caps/judgment-verdicts.json
```

Focused mock/unit tests may overlap. Full mailbox/process-spawning regression
queues on `windows-spawn-heavy-test` behind Prospecting; do not inflate
timeouts.

Self-audit arithmetic: 11 requirements, 6 file floors, 10 request components, 3
verdict values, 5 mutable judgment columns, commands/exits, paths, SHA. Freeze
a local candidate commit and obtain a different Claude identity's terminal
review bound to it. AGY never self-certifies; remediation creates a new
iteration/commit/tests/review.

Rollback reverses only these hunks. Existing ingested verdict metadata may
remain and be superseded; do not alter mailbox state. This is Round 1. The
measured 26/292, 16-stub, and shrinkage failures set a hard cut: one wrong
provider, missing hash/message binding, unsafe column, floor, receipt, review,
or SHA match rejects the lane.
