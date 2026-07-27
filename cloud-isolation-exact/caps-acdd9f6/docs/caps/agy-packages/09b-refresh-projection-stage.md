# AGY Package 09B — Refresh-to-Projection Stage Wiring

> ## FLAGS — OWNER MUST SEE BEFORE DISPATCH
>
> - No new package flag.
> - `FLAG-09-NEEDS-LOCATION` and `FLAG-09-SOURCE` from 09A remain binding.
> - 09B and 11B both write `src/caps/refresh.ts`; the single AGY orchestrator
>   must serialize them. They may never hold overlapping claims/worktrees
>   against the same integration base.

## 0. Identity and QA

Antigravity/Gemini at maximum available reasoning; isolated 09B worktree;
project `C:\Users\pgvin\LLM Assisted Projects\Bridge`; identity
`BRIDGE_AGENT=antigravity`, `BRIDGE_LANE=google_antigravity`,
`BRIDGE_PROJECT=bridge`. This is an internal factory lane and starts only after
accepted 08A and 09A.

Scripts may format, validate, or render content you yourself reasoned out; they
may never originate substantive content. Every section's substance must trace
to your own reasoning.

Run the AGY prompt QA skill at
`C:\Users\pgvin\.gemini\antigravity\brain\4acd2eff-97e3-48fb-aa8c-9accee9ccb77\skills\agy-prompt-qa\SKILL.md`;
write/QA `ROUND1_SELF_PROMPT.md`, preserve immutable iterations, and attach the
filled checklist.

## 1. Objective, claims, and floors

Register the accepted 09A renderer as the 08A `"projections"` stage in the
default `all` pipeline, after committed DB facts/core receipt, and expose its
truthful outcome in the terminal report.

| Claimed file | Derived floor |
|---|---|
| `src/caps/refresh.ts` | 1 projection-stage registration; 1 ordered-after-core invariant; 1 bounded success outcome; 1 non-success gap path |
| `test/caps/refresh.test.mjs` | at least 5 additive named tests: order, success receipt/hash, target temp root, failure isolation, terminal non-success |

Evidence root `<factory-output>\09B\`: self-prompt, immutable revision patches,
QA checklist, logs, receipt, review pointer. Each artifact gets a truthful
`reasoned | script-rendered-from-reasoned-data | script-generated` receipt
stamp. False stamps, overwrites, and deletions reject the lane.

## 2. Ordered requirements

1. Prove accepted 08A and 09A SHAs are present.
2. Acquire the `src/caps/refresh.ts` single-writer slot; verify 11B is not
   claiming it.
3. Compose the 09A renderer after DB commit and durable core receipt in `all`.
4. Put bounded projection state, hashes, and backup receipt in the stage result.
5. On projection failure, preserve DB facts, record a gap and stage failure,
   atomically finalize a terminal non-success report, and return non-success.
6. Test ordering and failure isolation against temp projection roots only.
7. Change no 08A public contract and no 09A projection semantics.

No-touch: every file outside the two claims, live owner files, live DB,
mailbox/scheduler, `.connector/**`, Bridge 1.x, dependencies, credentials,
network, installs, and paid actions. Every requirement is independently audited;
`etc.` is forbidden.

## 3. Bus, gates, and acceptance

1. `bridge_sync({"project":"C:\\Users\\pgvin\\LLM Assisted Projects\\Bridge"})`
2. `bridge_claim({"project":"C:\\Users\\pgvin\\LLM Assisted Projects\\Bridge","paths":["src/caps/refresh.ts","test/caps/refresh.test.mjs"],"note":"Caps 09B serialized projection-stage wiring"})`
3. `bridge_log({"project":"C:\\Users\\pgvin\\LLM Assisted Projects\\Bridge","summary":"CAPS-09B doing: projection stage wiring; refresh.ts single-writer slot held","files":[]})`
4. Log exact paths and SHA after gates.
5. After terminal same-SHA Claude PASS, log `CAPS-09B done` and release exactly
   both paths.

```powershell
npm run build
node --test test/caps/refresh.test.mjs
git diff --check -- src/caps/refresh.ts test/caps/refresh.test.mjs
```

Any full/process-spawning gate queues on `windows-spawn-heavy-test`. Freeze a
local candidate and dispatch an independent Claude review at that SHA. AGY
cannot self-certify. The self-audit counts 7 requirements, 2 floors, actual
tests, dependency SHAs, command exits, diff paths, and review IDs.

Rollback reverses only 09B wiring hunks. This is Round 1. The prior AGY record
of 26/292 rows, 16 stubs, and major shrinkage makes the cut threshold exact:
one missing invariant/test/floor/review/SHA match rejects the lane.
