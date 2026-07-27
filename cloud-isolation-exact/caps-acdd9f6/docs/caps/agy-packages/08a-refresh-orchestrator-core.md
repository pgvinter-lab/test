# AGY Package 08A — Refresh Orchestrator Core and Cross-Process Lock

> ## FLAGS — OWNER MUST SEE BEFORE DISPATCH
>
> - `FLAG-08A-DUAL-REFRESH` remains open until Package 08C is accepted. Until
>   then, do not run live MCP refresh concurrently with this orchestrator. 08C
>   is mandatory before scheduled or routine live use.
> - `FLAG-08A-LOCK-CORRECTION` is binding: Windows lock acquisition must use
>   exclusive create (`open(..., "wx")` or an equivalent atomic
>   create-if-absent primitive). Temp-file plus rename is forbidden for lock
>   acquisition.
> - `FLAG-08A-REPORT-LIFECYCLE` is binding: a crash-recovery core receipt and a
>   terminal report are distinguishable states. No incomplete or failed run may
>   look terminal-successful.

## 0. AGY execution identity and mode

- Surface: Antigravity (AGY), implementation owner.
- Model/thinking tier: Gemini implementation model, maximum available reasoning.
- Working directory: the isolated Package 08A worktree created by the single
  Caps 08–11 AGY factory orchestrator.
- Project: `C:\Users\pgvin\LLM Assisted Projects\Bridge`.
- Identity environment: `BRIDGE_AGENT=antigravity`,
  `BRIDGE_LANE=google_antigravity`, `BRIDGE_PROJECT=bridge`.
- This is one internal lane of one owner-authorized factory job. Do not create a
  competing top-level mailbox job, merge into the integration branch, or touch
  another lane's worktree.

Scripts may format, validate, or render content you yourself reasoned out; they
may never originate substantive content. Every section's substance must trace
to your own reasoning.

Before implementation, run the QA checklist at
`C:\Users\pgvin\.gemini\antigravity\brain\4acd2eff-97e3-48fb-aa8c-9accee9ccb77\skills\agy-prompt-qa\SKILL.md`.
Write and QA `ROUND1_SELF_PROMPT.md` before changing product bytes. Attach the
filled `QA_CHECKLIST.<UTC>.md` to the lane receipt before submission.

## 1. Objective

Implement a model-free refresh orchestrator that composes the already accepted
config-crawl, bounded stdio-probe, and mcpservers lanes; serializes all processes
with a safe file lock; and writes a durable, truthful refresh-report lifecycle.
Do not import or edit `src/caps/mcp.ts`.

## 2. Exact allowed paths and depth floors

Claim exactly these product paths:

| File | Purpose | Derived numeric floor |
|---|---|---|
| `src/caps/refresh.ts` | closed refresh contract, exclusive lock, lane composition, reports, stage hooks | 4 closed lane values; 2 closed stage names; 1 exclusive-create loop; 2 report lifecycle states; 3 composed lane adapters; 1 atomic terminal finalization |
| `test/caps/refresh.test.mjs` | offline public-contract and failure-path tests | at least 12 named tests, including 2 simultaneous contenders, stale takeover, stale-byte mismatch, owner-only release, atomic report finalization, crash/incomplete state, and stage failure |

Read-only dependencies are the accepted `src/caps/**` files at current HEAD and
Package 07's `src/caps/mcp.ts` for semantic parity only. Product writes outside
the two claimed files are automatic rejection.

Lane evidence lives outside product source under the orchestrator-provided
`<factory-output>\08A\` directory:

- `ROUND1_SELF_PROMPT.md`;
- `iterations\<counter>-<UTC>.patch` before every substantive revision;
- `QA_CHECKLIST.<UTC>.md`;
- `acceptance-receipt.json`;
- command logs and the independent-review artifact pointer.

Every artifact's receipt entry must declare exactly one truthful generation
method: `reasoned`, `script-rendered-from-reasoned-data`, or
`script-generated`. A false declaration is automatic rejection. No iteration
may be overwritten or deleted.

## 3. Frozen public contract

Export and test these closed concepts:

1. `CapsRefreshLane = "config" | "probe" | "mcpservers" | "all"`.
2. `CapsRefreshStage.name = "projections" | "judgment"`.
3. `CapsRefreshStage.run(ctx)` returns a bounded structured outcome.
4. `acquireCapsRefreshLock(stateDir)` returns an owned handle or
   `{ already_running: true, lock_provenance }`.
5. `runCapsRefresh({ lane, stages? })` returns
   `bridge-caps-refresh-report-v1`.
6. The report contains `refresh_run_id`, start/end timestamps, producer/capture
   provenance, lane outcomes, stage outcomes, `new_arrivals`, `status_flips`,
   `watch_deltas`, `gaps`, input hashes, output hashes, and an explicit terminal
   lifecycle/status field.

08B, 08C, 09B, 10A, and 11B build against these semantics. Do not silently
rename or widen them.

## 4. Ordered implementation requirements

1. Acquire `<caps-state>\refresh.lock` only by atomic exclusive creation
   (`open(path, "wx")` or proven equivalent). Write a canonical receipt with a
   random ownership nonce, local PID, hostname, and start time; flush/close it
   before returning the handle.
2. On `EEXIST`, read and validate the current receipt. A valid live local PID is
   `already_running`. For a dead local PID, or a foreign-host lock meeting an
   explicit tested age policy, read the file bytes again immediately before
   removal and prove they are byte-identical to the evaluated bytes. If bytes
   differ, remove nothing and retry from exclusive create.
3. After a justified stale removal, retry exclusive creation. Never assume
   removal granted ownership.
4. Release removes the lock only when the current bytes still match the
   handle's own canonical receipt and nonce. A replaced lock survives release.
5. `all` runs config crawl, then probes only the bounded discovered local stdio
   candidates using Package 07's selection semantics, then the mcpservers daily
   diff. Census remains event-driven and is never fabricated.
6. A lane-specific run executes only that named lane and still produces a
   complete receipt/report chain.
7. Atomically persist an explicit nonterminal `core` receipt before optional
   stages so a crash is diagnosable. It must say `incomplete` or `running`, not
   success.
8. Run configured stages only after committed DB facts and the core receipt.
   A stage failure records its outcome and a gap, preserves correct DB facts,
   and makes the terminal report non-successful.
9. After all lane and stage outcomes/hashes are known, atomically replace or
   finalize the report as terminal. A crash before this point leaves only a
   truthful non-success/incomplete receipt.
10. Store reports under `<caps-state>\reports\` by same-directory temp write,
    flush, and atomic replacement. Reports contain no credentials, prompts, raw
    remote bodies, or environment dumps.
11. Require no model, interactive session, API key, or MCP server. Plain Node
    execution from Task Scheduler must work.
12. Use only accepted Package 03/05 probing/fetch policies. Add no dependency.

Every numbered item and every member of every compound list is individually
binding. Do not replace any item with a summary. The token `etc.` is forbidden
in implementation receipts.

## 5. No-touch zones

Do not modify `.connector/**`, `src/caps/mcp.ts`, `src/server.ts`,
`src/cli.ts`, `package.json`, lockfiles, `src/catalog.ts`, mailbox contracts or
runtime, migrations outside caps, Chrome/web-node integrations, Bridge 1.x,
credentials, live caps state, real scheduler state, owner projection files, or
network state.

## 6. Bridge bus sequence — exact order

Use Bridge MCP calls with the project value exactly
`C:\Users\pgvin\LLM Assisted Projects\Bridge`:

1. `bridge_sync({"project":"C:\\Users\\pgvin\\LLM Assisted Projects\\Bridge"})`
2. `bridge_claim({"project":"C:\\Users\\pgvin\\LLM Assisted Projects\\Bridge","paths":["src/caps/refresh.ts","test/caps/refresh.test.mjs"],"note":"Caps 08A isolated factory lane"})`
3. `bridge_log({"project":"C:\\Users\\pgvin\\LLM Assisted Projects\\Bridge","summary":"CAPS-08A doing: exclusive refresh lock and truthful report lifecycle","files":[]})`
4. After implementation, log exact changed files and candidate SHA with
   `bridge_log`; do not use a vague milestone.
5. Only after all local gates and the separate Claude review pass at the same
   candidate SHA, call a final `bridge_log` containing `CAPS-08A done`, exact
   tests, review job/artifact IDs, and SHA.
6. `bridge_release({"project":"C:\\Users\\pgvin\\LLM Assisted Projects\\Bridge","paths":["src/caps/refresh.ts","test/caps/refresh.test.mjs"]})`

If a claim conflicts, stop this lane and report the exact lease. Do not edit
around it.

## 7. Verification and shared-resource rule

Focused pure tests may run concurrently:

```powershell
npm run build
node --test test/caps/refresh.test.mjs
npm run contract-test
git diff --check -- src/caps/refresh.ts test/caps/refresh.test.mjs
```

`npm run test:all`, stdio-probe, WAL stress, mailbox, cutover, and other
process-spawning suites require the factory resource
`windows-spawn-heavy-test`. Queue them while Prospecting remediation owns that
resource. Preserve a contention-failure receipt and rerun alone; never increase
timeouts to conceal contention.

The self-audit must list all 12 ordered requirements, all depth floors, actual
test counts, commands, exit codes, changed paths, and candidate tree/SHA.

## 8. Freeze, independent review, receipt, and rollback

Commit the isolated lane candidate locally and stop editing. The orchestrator
must dispatch a separate Claude review bound to that exact SHA/tree. AGY never
self-certifies. Any material finding returns to AGY, creates a new immutable
iteration and candidate commit, reruns affected gates, and requires a new
SHA-bound review.

Acceptance needs a terminal Claude artifact, current-byte equality to the
reviewed SHA, and `acceptance-receipt.json` containing identity, generation
methods, floors/actuals, commands/exits, review IDs, and changed paths. Reverse
only these two source files for rollback; leave reports/locks as audit evidence.

This is Round 1 for 08A. AGY's measured prior failures were 26 rows where 292
were required, 16 generated stubs, and regressions from 64.1 KB to 16.7 KB and
48.2 KB to 3.7 KB. The cut threshold is exact: one missing requirement, floor,
test, receipt, terminal review, or SHA match rejects the lane; no partial credit
and no factory `done`.
