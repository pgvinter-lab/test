# AGY Package 08B — `bridge caps` CLI Namespace

> ## FLAGS — OWNER MUST SEE BEFORE DISPATCH
>
> - `FLAG-08B-PKGJSON`: the `package.json` grant is exactly one script property:
>   `"caps-refresh": "node dist/cli.js caps refresh --lane all"`. No dependency,
>   lockfile, or other script change is authorized.
> - `FLAG-08-CLI-PLACEMENT`: the literal `bridge caps` namespace belongs in the
>   existing binary. It must not replace or alter `bridge catalog`.
> - Authoring starts in Wave 1, but acceptance waits for the accepted 08A
>   contract/commit.

## 0. AGY execution identity and mode

- Surface: Antigravity (AGY), implementation owner.
- Model/thinking tier: Gemini implementation model, maximum available reasoning.
- Working directory: the isolated Package 08B worktree created by the single
  Caps 08–11 AGY factory orchestrator.
- Project: `C:\Users\pgvin\LLM Assisted Projects\Bridge`.
- Identity: `BRIDGE_AGENT=antigravity`,
  `BRIDGE_LANE=google_antigravity`, `BRIDGE_PROJECT=bridge`.
- This is an internal authoring lane, not a separate top-level dispatch. Do not
  merge or claim 08A's files.

Scripts may format, validate, or render content you yourself reasoned out; they
may never originate substantive content. Every section's substance must trace
to your own reasoning.

Before product edits, execute
`C:\Users\pgvin\.gemini\antigravity\brain\4acd2eff-97e3-48fb-aa8c-9accee9ccb77\skills\agy-prompt-qa\SKILL.md`,
write/QA `ROUND1_SELF_PROMPT.md`, and later attach the filled
`QA_CHECKLIST.<UTC>.md`.

## 1. Objective

Add model-free, machine-readable
`bridge caps status|search|get|refresh|backfill` commands to the existing CLI
while preserving every existing `bridge catalog` and `bridge openrouter`
behavior.

## 2. Exact paths and depth floors

| File | Purpose | Derived numeric floor |
|---|---|---|
| `src/caps/cli.ts` | closed parser/dispatcher and JSON output | 5 subcommands; 4 closed refresh lane values; at least 7 stable error/exit outcomes |
| `test/caps/cli.test.mjs` | spawned CLI boundary tests | at least 13 named tests covering all 5 subcommands, paid-last order, stdout purity, errors, resume, and held lock |
| `src/cli.ts` | existing-binary wiring | exactly 1 caps import, 1 help entry, and 1 `case "caps"`; no catalog/openrouter semantic change |
| `package.json` | scheduler-facing script | exactly 1 new `caps-refresh` script property and 0 other changes |

Claim exactly those four paths. Evidence belongs under
`<factory-output>\08B\`: self-prompt, immutable
`iterations\<counter>-<UTC>.patch`, filled QA checklist, command logs,
`acceptance-receipt.json`, and review pointer.

The receipt is the identity stamp for every changed/generated artifact and
declares `reasoned`, `script-rendered-from-reasoned-data`, or
`script-generated`. False declarations reject the package. Snapshot before
every revision; overwrite/delete is forbidden.

## 3. Ordered implementation requirements

1. Implement `runCapsCommand()` with JSON-only stdout, bounded diagnostics on
   stderr, and stable nonzero error exits.
2. Add one surgical import, help entry, and `case "caps"` to `src/cli.ts`.
3. `status` reports DB path, migration/integrity state, per-table row counts,
   pricing-tier counts, FTS/fallback mode, last refresh lifecycle/result, census
   due state, projection/needs state, and pending judgment state. It degrades to
   explicit `not_installed` until 09A/11A exist and never emits credentials or a
   raw environment/DB dump.
4. `search` and `get` use Package 06's service with local Code orchestration
   context; paid remains hard-last and cannot be reordered by CLI arguments.
5. `refresh [--lane config|probe|mcpservers|all]` invokes accepted 08A lock and
   orchestrator semantics. `already_running` returns exit 0 plus bounded lock
   provenance.
6. `backfill [--resume]` uses Package 05's paced, resumable, host-allowlisted
   path. No option can disable pacing, bounds, paid flags, or host policy.
7. Add exactly the authorized `caps-refresh` script property.
8. Spawn the built CLI in tests and cover help, status, search, get, every
   allowed refresh lane, rejected lane, held lock, JSON stdout purity,
   nonzero-error stability, paid-last search, fixture-backed backfill, and
   `--resume`.
9. No TypeScript source is executed directly by scheduled/runtime commands; the
   built `dist/cli.js` entrypoint is authoritative.

Each numbered requirement and each member of its compound lists is separately
binding. Do not compress it, and do not use `etc.` in receipts.

## 4. No-touch zones

Do not alter the implementation or semantics of `case "catalog"` or
`case "openrouter"`, any lockfile, any other `package.json` property,
`.connector/**`, `src/catalog.ts`, mailbox files, `src/caps/refresh.ts`,
`src/caps/mcp.ts`, scheduler state, live caps data, owner files, Bridge 1.x,
credentials, endpoints, paid resources, or dependencies.

## 5. Bridge bus sequence

With the exact project and identity above:

1. `bridge_sync({"project":"C:\\Users\\pgvin\\LLM Assisted Projects\\Bridge"})`
2. `bridge_claim({"project":"C:\\Users\\pgvin\\LLM Assisted Projects\\Bridge","paths":["src/caps/cli.ts","test/caps/cli.test.mjs","src/cli.ts","package.json"],"note":"Caps 08B isolated Wave-1 authoring lane"})`
3. `bridge_log({"project":"C:\\Users\\pgvin\\LLM Assisted Projects\\Bridge","summary":"CAPS-08B doing: bridge caps CLI authoring; acceptance awaits 08A","files":[]})`
4. Log exact changed files and the authoring candidate SHA. Do not claim
   acceptance until 08A is accepted and rebased/merged into this lane.
5. After 08A join, rerun all gates; after terminal SHA-bound Claude PASS, log
   `CAPS-08B done` with exact command exits, review job/artifact IDs, and SHA.
6. `bridge_release({"project":"C:\\Users\\pgvin\\LLM Assisted Projects\\Bridge","paths":["src/caps/cli.ts","test/caps/cli.test.mjs","src/cli.ts","package.json"]})`

## 6. Verification and resource queue

After the 08A acceptance join:

```powershell
npm run build
node --test test/caps/cli.test.mjs
node dist/cli.js caps status
node dist/cli.js caps search "synthetic"
npm run contract-test
git diff --check -- src/caps/cli.ts src/cli.ts package.json test/caps/cli.test.mjs
```

Spawned CLI tests and any full regression gate must acquire
`windows-spawn-heavy-test`; queue them behind Prospecting remediation. Pure
parser/unit checks and static inspection may overlap. Do not inflate timeouts.
The self-audit records all 9 requirements, four file floors, actual test count,
diff scope, commands/exits, and join SHA.

## 7. Freeze, review, receipt, rollback

Freeze a local candidate commit only after 08A is joined and gates pass.
Dispatch a different Claude identity through a separate A2A review bound to the
candidate SHA. AGY never self-certifies. Remediation creates an immutable new
iteration, commit, tests, and review.

Acceptance requires the terminal review artifact, byte/SHA match, filled QA
checklist, and receipt with generation-method stamps and floor arithmetic.
Rollback reverses only the caps import/help/case, one package script line, and
package-created CLI/test files.

This is Round 1 for 08B. Prior measured AGY failures were 26/292 rows, 16
one-second stubs, and severe artifact shrinkage. Any missing subcommand,
required field, floor, protected-branch proof, gate, receipt, review, or SHA
match is below the cut threshold and rejects the lane.
