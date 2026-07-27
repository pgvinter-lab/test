# AGY Package 11B — Refresh-to-Judgment Stage Wiring

> ## FLAGS — OWNER MUST SEE BEFORE DISPATCH
>
> - No new package flag.
> - `FLAG-11-VERDICT-TRUST` remains binding: this stage records reported
>   judgment metadata only.
> - 11B and 09B serialize on `src/caps/refresh.ts`. The one AGY orchestrator must
>   grant the single-writer slot to only one at a time.
> - Live mailbox dispatch remains owner-gated Package 13B S6.

## 0. Identity and QA

Antigravity/Gemini at maximum available reasoning; isolated 11B worktree;
project `C:\Users\pgvin\LLM Assisted Projects\Bridge`; identity
`BRIDGE_AGENT=antigravity`, `BRIDGE_LANE=google_antigravity`,
`BRIDGE_PROJECT=bridge`. Start only after accepted 08A and 11A and after the
orchestrator grants the refresh single-writer slot.

Scripts may format, validate, or render content you yourself reasoned out; they
may never originate substantive content. Every section's substance must trace
to your own reasoning.

Run
`C:\Users\pgvin\.gemini\antigravity\brain\4acd2eff-97e3-48fb-aa8c-9accee9ccb77\skills\agy-prompt-qa\SKILL.md`,
write/QA `ROUND1_SELF_PROMPT.md`, preserve iterations, and attach the filled
checklist.

## 1. Objective, claims, and floors

Register accepted 11A enqueue/pending-completion collection as 08A's
`"judgment"` stage, produce a truthful bounded stage outcome, and never
fabricate a receipt or verdict.

| Claimed file | Derived floor |
|---|---|
| `src/caps/refresh.ts` | 1 judgment-stage registration; 1 canonical enqueue receipt; 1 bounded pending/completed collection result; at least 4 explicit non-success gap classes |
| `test/caps/refresh.test.mjs` | at least 7 additive named tests: after-projection order, no-projection gap, enqueue receipt, idempotent repeat, pending response, valid completion collection, mailbox unavailable |

Evidence root `<factory-output>\11B\`: self-prompt, immutable revision patches,
QA checklist, logs, acceptance receipt, review pointer. Every artifact receipt
declares `reasoned | script-rendered-from-reasoned-data | script-generated`;
false stamps, overwrite, or deletion reject the lane.

## 2. Ordered requirements

1. Prove accepted 08A and 11A SHAs are present and 09B is not simultaneously
   claiming `refresh.ts`.
2. Run judgment after projections when the projection stage exists.
3. If 09B is not integrated, record an explicit bounded missing-projection gap;
   do not invent projection success.
4. Enqueue through 11A and include message ID, payload hash, prompt hash,
   idempotency key, and terminal state in the stage outcome.
5. Collect only completed, exactly bound, schema-valid verdicts through 11A.
   Pending/nonterminal responses remain pending and cannot be ingested.
6. Mailbox unavailability, mismatch, invalid content, and stage error each
   produce a truthful gap and terminal non-success report, not a crash or
   fabricated receipt.
7. Use a mock mailbox and temp caps state in all package tests.
8. Preserve the 08A public contract and all accepted 09B behavior.

Each item and compound member is separately binding; `etc.` is forbidden.
No-touch: files outside the two claims, live mailbox/DB/owner files, mailbox
source/contracts, `.connector/**`, CLI/MCP/scheduler, Bridge 1.x, dependencies,
credentials, network, installs, paid actions.

## 3. Bus, gates, and acceptance

1. `bridge_sync({"project":"C:\\Users\\pgvin\\LLM Assisted Projects\\Bridge"})`
2. `bridge_claim({"project":"C:\\Users\\pgvin\\LLM Assisted Projects\\Bridge","paths":["src/caps/refresh.ts","test/caps/refresh.test.mjs"],"note":"Caps 11B serialized judgment-stage wiring"})`
3. `bridge_log({"project":"C:\\Users\\pgvin\\LLM Assisted Projects\\Bridge","summary":"CAPS-11B doing: canonical judgment stage; refresh.ts single-writer slot held","files":[]})`
4. Log exact paths/candidate SHA after gates.
5. After terminal same-SHA Claude PASS, log `CAPS-11B done` with gates/review
   IDs, then release exactly both paths.

```powershell
npm run build
node --test test/caps/refresh.test.mjs
git diff --check -- src/caps/refresh.ts test/caps/refresh.test.mjs
```

Full/process-spawning regression queues on `windows-spawn-heavy-test`; no timeout
inflation. Self-audit: 8 requirements, 2 floors, actual tests, dependency SHAs,
commands/exits, changed paths, review IDs. Freeze a local candidate and obtain
an independent Claude terminal review at that exact SHA. AGY cannot
self-certify.

Rollback only 11B wiring hunks. This is Round 1. Prior measured 26/292, 16-stub,
and shrinkage failures make one fabricated state, missing binding, floor,
receipt, review, or SHA equality sufficient to reject the lane.
