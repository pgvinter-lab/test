# AGY Package 12A — Per-Prompt Discovery, Judgment, and Proposal

> ## FLAGS — OWNER MUST SEE BEFORE DISPATCH
>
> - `FLAG-12-SKILL-EDIT`: this package may generate an inert patch artifact for
>   the owner, but it must not edit the live prompt-router or any skill outside
>   the repository. The owner applies/canaries that patch in Package 13B S7.
> - `FLAG-12-INSTALL-BOUNDARY`: proposals only. Caps never executes an install.
>   One-click or automatic installation requires a new owner decision.
> - Do not dispatch 12A until Package 08B is accepted and its `src/caps/cli.ts`
>   write lease is released.

## 0. AGY identity, mode, and QA

Surface Antigravity; Gemini implementation model at maximum available
reasoning; isolated 12A worktree created by the single factory orchestrator;
project `C:\Users\pgvin\LLM Assisted Projects\Bridge`; identity
`BRIDGE_AGENT=antigravity`, `BRIDGE_LANE=google_antigravity`,
`BRIDGE_PROJECT=bridge`.

Scripts may format, validate, or render content you yourself reasoned out; they
may never originate substantive content. Every section's substance must trace
to your own reasoning.

Before edits, run
`C:\Users\pgvin\.gemini\antigravity\brain\4acd2eff-97e3-48fb-aa8c-9accee9ccb77\skills\agy-prompt-qa\SKILL.md`,
write/QA `ROUND1_SELF_PROMPT.md`, preserve immutable revisions, and attach the
filled QA checklist.

## 1. Objective and exact deliverables

Document the per-prompt protocol and implement an inert owner-confirmation
proposal helper/CLI. The router consults `caps_search`; the current in-session
model judges against `NEEDS.json`; free/keyless proposals come first; paid/keyed
items are ask-first; caps executes nothing.

| Claimed file | Purpose | Derived floor |
|---|---|---|
| `docs/caps/PER-PROMPT.md` | exact router/search/judgment/proposal/owner-action protocol | 7 ordered phases; 4 paid/keyed/free decision branches; 5 explicit prohibitions |
| `src/caps/propose.ts` | closed proposal receipt and inert owner patch artifact | 1 closed proposal schema; 3 pricing tiers; 2 paid gates; 0 spawn/fetch/install calls |
| `test/caps/propose.test.mjs` | offline no-execution and receipt tests | at least 12 named tests covering atomicity, provenance, free-first, paid acknowledgement, no spawn/fetch/write outside root |
| `src/caps/cli.ts` | additive `caps propose --id` wiring | exactly 1 additive subcommand; 0 change to existing subcommand semantics |

Runtime writes are bounded to `<caps-state>\proposals\**`. Evidence goes under
`<factory-output>\12A\`: self-prompt, immutable
`iterations\<counter>-<UTC>.patch`, checklist, logs, acceptance receipt, review
pointer. Every artifact gets a truthful
`reasoned | script-rendered-from-reasoned-data | script-generated` receipt
stamp; false stamps, overwrites, or deletions reject the lane.

## 2. Ordered requirements

1. Specify seven exact phases: derive trusted prompt context; call two-phase
   `caps_search`; read/validate owner needs; have the in-session model judge;
   rank free/keyless before unknown before paid/keyed; write an inert proposal;
   wait for separate owner action.
2. A proposal includes capability ID/name/summary, pricing, key requirement,
   provenance/capture class, source URL, judgment reference, inert install
   command text, and explicit owner-confirmation state.
3. `bridge caps propose --id <id>` writes one atomic receipt under the proposal
   root and executes no command, fetch, model call, install, scheduler action,
   or external write.
4. Paid rows require `--acknowledge-paid` even to render an inert paid proposal,
   remain ask-first, and cannot be primary while an eligible free row exists.
5. Generate the proposed prompt-router integration as inert patch text inside
   the proposal artifact root. Do not apply it or write any live skill.
6. Reject unknown IDs, malformed owner needs, stale/missing provenance,
   unsupported pricing, path escape, duplicate idempotency conflict, and
   oversize fields with stable bounded errors.
7. Test no-execution by making spawn/fetch calls fatal and asserting zero
   invocation; verify no write escapes the temp proposal root.
8. Preserve all accepted 08B CLI behavior.

Every item and compound member is independently dispositioned; `etc.` is
forbidden.

## 3. No-touch, bus, gates, review

No-touch: live prompt-router/skills, files outside four claims, live owner
files/DB/mailbox/scheduler, `.connector/**`, mailbox contracts/source,
package/lockfiles, Bridge 1.x, dependencies, credentials, endpoints, network,
installs, paid actions.

1. `bridge_sync({"project":"C:\\Users\\pgvin\\LLM Assisted Projects\\Bridge"})`
2. `bridge_claim({"project":"C:\\Users\\pgvin\\LLM Assisted Projects\\Bridge","paths":["docs/caps/PER-PROMPT.md","src/caps/propose.ts","test/caps/propose.test.mjs","src/caps/cli.ts"],"note":"Caps 12A post-08B proposal-only lane"})`
3. `bridge_log({"project":"C:\\Users\\pgvin\\LLM Assisted Projects\\Bridge","summary":"CAPS-12A doing: inert per-prompt proposal lane; no install","files":[]})`
4. Log exact paths/SHA after gates.
5. After terminal same-SHA Claude PASS, log `CAPS-12A done` with tests/review
   IDs; release exactly all claims.

```powershell
npm run build
node --test test/caps/propose.test.mjs
node --test test/caps/cli.test.mjs
git diff --check -- docs/caps/PER-PROMPT.md src/caps/propose.ts src/caps/cli.ts test/caps/propose.test.mjs
```

Spawned/full regression queues on `windows-spawn-heavy-test`; no timeout
inflation. Self-audit: 8 requirements, 4 floors, 7 phases, 4 pricing branches,
zero forbidden invocations, command exits, changed paths, dependency SHA.
Freeze/commit, stop edits, and obtain independent terminal Claude review at the
same SHA. AGY never self-certifies.

Rollback reverses four paths; inert proposal receipts may remain. Round 1 uses
the hard cut established by AGY's 26/292, 16-stub, and shrinkage failures: one
executed action, missing branch/floor, receipt, review, or SHA match rejects it.
