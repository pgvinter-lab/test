# AGY Package 08C — MCP Refresh Unification

> ## FLAGS — OWNER MUST SEE BEFORE DISPATCH
>
> - This package closes `FLAG-08A-DUAL-REFRESH`.
> - It cannot start until Package 07 is accepted at
>   `6e7f3914166437cdcc67a0c72a4fda0f706ef9b4` and Package 08A is accepted.
> - Until 08C passes, live/scheduled MCP refresh remains on hold.

## 0. AGY identity, mode, and QA

Surface Antigravity; Gemini implementation model at maximum available
reasoning; isolated 08C worktree; project
`C:\Users\pgvin\LLM Assisted Projects\Bridge`; identity
`BRIDGE_AGENT=antigravity`, `BRIDGE_LANE=google_antigravity`,
`BRIDGE_PROJECT=bridge`. This is an internal lane of the single factory job.

Scripts may format, validate, or render content you yourself reasoned out; they
may never originate substantive content. Every section's substance must trace
to your own reasoning.

Before editing, run
`C:\Users\pgvin\.gemini\antigravity\brain\4acd2eff-97e3-48fb-aa8c-9accee9ccb77\skills\agy-prompt-qa\SKILL.md`,
write and QA `ROUND1_SELF_PROMPT.md`, preserve every revision, and attach a
filled `QA_CHECKLIST.<UTC>.md`.

## 1. Objective and exact scope

Rewire `CapsMcpRuntime.refresh()` to delegate to accepted 08A so MCP, CLI, and
scheduled refresh share one exclusive lock, lifecycle report, and stage
pipeline. Preserve non-Code `requires_code_orchestrator` bytes and all other
caps/Bridge behavior.

| Claimed file | Purpose | Derived numeric floor |
|---|---|---|
| `src/caps/mcp.ts` | replace only private refresh composition with 08A delegation | 1 08A delegation path; 1 fast in-process guard; 1 authoritative file-lock path; 0 search/get/report behavior changes |
| `test/caps/mcp-tools.test.mjs` | additive public-boundary regressions | at least 4 new named tests: held file lock, report parity, non-Code byte parity, and existing-tool preservation |

Evidence root: `<factory-output>\08C\` with self-prompt, immutable
`iterations\<counter>-<UTC>.patch`, QA checklist, command logs,
`acceptance-receipt.json`, and review pointer. The receipt stamps every artifact
as `reasoned`, `script-rendered-from-reasoned-data`, or `script-generated`;
false stamps reject it. Snapshot before each revision; delete/overwrite is
forbidden.

## 2. Ordered requirements

1. Verify current HEAD contains accepted P07 SHA and accepted 08A integration.
2. Replace only the private lane-composition path with 08A lock and
   `runCapsRefresh` delegation, using configured projection/judgment stages when
   present.
3. Keep `refreshRunning` only as an in-process fast path; 08A's exclusive file
   lock is cross-process authority.
4. Preserve tool schema and non-Code `requires_code_orchestrator` result
   byte-for-byte.
5. Preserve `caps_search`, `caps_get`, `caps_report`, sync census piggyback, and
   all existing Bridge tool behavior.
6. Prove a held 08A lock returns the correct non-mutating bounded result through
   the public MCP boundary.
7. Prove CLI/MCP report schema and lifecycle parity.

Every item is independently binding. Do not use `etc.` in implementation or
receipts.

No-touch: `src/server.ts`, all files outside the two claims, `.connector/**`,
`src/catalog.ts`, `src/cli.ts`, mailbox paths, migrations, scheduler/live caps
state, owner files, Bridge 1.x, dependencies, endpoints, credentials, or paid
resources.

## 3. Bus, gates, and review

Exact Bridge sequence:

1. `bridge_sync({"project":"C:\\Users\\pgvin\\LLM Assisted Projects\\Bridge"})`
2. `bridge_claim({"project":"C:\\Users\\pgvin\\LLM Assisted Projects\\Bridge","paths":["src/caps/mcp.ts","test/caps/mcp-tools.test.mjs"],"note":"Caps 08C isolated post-07/post-08A lane"})`
3. `bridge_log({"project":"C:\\Users\\pgvin\\LLM Assisted Projects\\Bridge","summary":"CAPS-08C doing: unify MCP refresh on 08A lock/report","files":[]})`
4. Log exact changed files and candidate SHA after gates.
5. Only after terminal SHA-bound Claude PASS, log `CAPS-08C done` with review
   IDs and gate exits.
6. `bridge_release({"project":"C:\\Users\\pgvin\\LLM Assisted Projects\\Bridge","paths":["src/caps/mcp.ts","test/caps/mcp-tools.test.mjs"]})`

Commands:

```powershell
npm run build
node --test test/caps/mcp-tools.test.mjs
node test/mcp-smoke.mjs
npm run contract-test
git diff --check -- src/caps/mcp.ts test/caps/mcp-tools.test.mjs
```

The spawned MCP test, smoke test, and full regression require
`windows-spawn-heavy-test`; queue them behind its current owner. Static and
focused pure checks may overlap. Preserve contention receipts and rerun alone;
never inflate timeouts.

Freeze a local candidate commit, stop edits, and obtain a separate terminal
Claude review at that exact SHA. AGY cannot self-certify. The self-audit counts
7 requirements, two file floors, tests/exits, diff scope, dependency SHAs, and
review IDs. Rollback reverses only this package's hunks and never restores a
pre-P07 `mcp.ts` or `server.ts`.

This is Round 1 for 08C. AGY previously produced 26/292 rows, 16 stubs, and
shrunk substantial artifacts. One changed protected behavior, missing test,
floor, receipt, review, or SHA match rejects the lane; the top-level factory
task cannot be marked done.
