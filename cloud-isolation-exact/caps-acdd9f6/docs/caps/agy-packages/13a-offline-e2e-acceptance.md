# AGY Package 13A — End-to-End Offline Acceptance Harness

> ## FLAGS — OWNER MUST SEE BEFORE DISPATCH
>
> - `FLAG-13A-SUITE`: whether this offline Caps E2E becomes part of
>   `npm run test:all` is an explicit acceptance-runtime decision. This package
>   may not edit `package.json` or add the suite automatically.
> - Do not dispatch until 07, 08A, 08B, 08C, 09B, and 11B are accepted.
> - Required execution is offline. Real network, mailbox, scheduler, projection
>   files, or caps DB are forbidden.

## 0. AGY identity, mode, and QA

Surface Antigravity; Gemini implementation model at maximum available
reasoning; isolated 13A worktree; project
`C:\Users\pgvin\LLM Assisted Projects\Bridge`; identity
`BRIDGE_AGENT=antigravity`, `BRIDGE_LANE=google_antigravity`,
`BRIDGE_PROJECT=bridge`.

Scripts may format, validate, or render content you yourself reasoned out; they
may never originate substantive content. Every section's substance must trace
to your own reasoning.

Run
`C:\Users\pgvin\.gemini\antigravity\brain\4acd2eff-97e3-48fb-aa8c-9accee9ccb77\skills\agy-prompt-qa\SKILL.md`,
write/QA `ROUND1_SELF_PROMPT.md`, preserve all revisions, and attach the filled
QA checklist.

## 1. Objective, scope, and numeric floors

Drive the assembled refresh pipeline offline from synthetic config and index
fixtures through refresh stages, projections, mock judgment completion,
verdict ingestion, CLI assertions, and MCP census piggyback.

| Claimed path | Purpose | Derived floor |
|---|---|---|
| `test/caps/e2e-refresh.test.mjs` | one hermetic integrated harness | at least 16 named assertions across 9 pipeline boundaries; 5 zero-live-resource guards |
| `test/fixtures/caps/e2e/**` | fixed config/index/mailbox/projection fixtures | at least 1 config server, 1 working probe, 1 broken probe, 3 pricing tiers, 1 diff, 1 canonical judgment request/response, 1 owner-marker file |

Evidence root `<factory-output>\13A\`: self-prompt, immutable revision patches,
checklist, logs, acceptance receipt, review pointer. Each artifact receives a
truthful `reasoned | script-rendered-from-reasoned-data | script-generated`
stamp. False stamps, overwrite, or deletion reject the package.

## 2. Ordered requirements

1. Use a unique temp state directory, temp projections, fixture fetcher,
   fixture process adapter, and mock MailboxService.
2. Drive synthetic config crawl, bounded probe, mcpservers diff,
   `runCapsRefresh("all")`, projection stage, judgment enqueue/completion,
   verdict ingestion, CLI status/search, and a spawned MCP census piggyback.
3. Assert rows from each data lane and paid-last order at DB, service search,
   CLI, `CATALOG.md`, and `AVAILABLE.md`.
4. Assert marker splice/owner-byte preservation, backups/manifests, and
   `NEEDS.json` exclusive-create behavior.
5. Assert report lifecycle/core-to-terminal chain and link the same
   `refresh_run_id` through projections, canonical judgment payload,
   message/prompt hashes, verdict ingestion, and terminal projection.
6. Assert the same validated verdict appears in its DB row and generated
   `AVAILABLE.md`.
7. Assert census piggyback using the real built MCP stdio boundary and bounded
   fixture data.
8. Make outbound network, real mailbox access, scheduler calls, owner-path
   writes, and real caps-state access fatal; assert all five invocation counts
   are zero.
9. Clean all children/temp handles deterministically even on failure.
10. Do not edit test scripts/package configuration; record an explicit
    recommendation on `FLAG-13A-SUITE` in the receipt.

Every item and every compound member is independently audited; `etc.` is
forbidden.

## 3. No-touch and exact bus

No-touch: every product source file, `package.json`, lockfiles, live caps state,
owner files, mailbox/scheduler/network, `.connector/**`, Bridge 1.x,
credentials, endpoints, installs, paid actions.

1. `bridge_sync({"project":"C:\\Users\\pgvin\\LLM Assisted Projects\\Bridge"})`
2. `bridge_claim({"project":"C:\\Users\\pgvin\\LLM Assisted Projects\\Bridge","paths":["test/caps/e2e-refresh.test.mjs","test/fixtures/caps/e2e"],"note":"Caps 13A integrated offline acceptance harness"})`
3. `bridge_log({"project":"C:\\Users\\pgvin\\LLM Assisted Projects\\Bridge","summary":"CAPS-13A doing: hermetic end-to-end acceptance harness","files":[]})`
4. Log exact files/SHA/gates after implementation.
5. After terminal same-SHA Claude PASS, log `CAPS-13A done` with artifact IDs;
   release both claims.

## 4. Gates, review, receipt, rollback

```powershell
npm run build
node --test test/caps/e2e-refresh.test.mjs
git diff --check -- test/caps/e2e-refresh.test.mjs test/fixtures/caps/e2e
```

Because the E2E spawns an MCP process, it must acquire
`windows-spawn-heavy-test`; queue it behind Prospecting and do not inflate
timeouts. Pure fixture/static checks may overlap.

Self-audit: 10 requirements, 2 floors, 9 boundaries, 5 zero-live guards, command
exits, accepted dependency SHAs, changed paths. Freeze a local candidate and
obtain independent terminal Claude review at the same SHA; AGY cannot
self-certify. Rollback deletes only the harness/fixtures.

This is Round 1. Against AGY's measured 26/292, 16-stub, and shrinkage failures,
one skipped boundary, live-resource touch, floor, receipt, terminal review, or
SHA match rejects the lane.
