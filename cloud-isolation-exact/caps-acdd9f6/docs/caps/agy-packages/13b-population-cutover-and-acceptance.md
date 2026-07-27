# AGY Package 13B — Population, Cutover, and Acceptance Operations

> ## FLAGS — OWNER MUST SEE BEFORE DISPATCH
>
> - **DO NOT DISPATCH THIS PACKAGE NOW.** The current owner authorization covers
>   implementation/offline verification for Packages 08–11, not live 13B.
> - `FLAG-13-HOSTED`: if no hosted client sends `capsRoster`, the owner decides
>   whether that documented census gap blocks S9.
> - `FLAG-13-BACKFILL-WINDOW`: the owner must select the multi-hour live
>   backfill window.
> - `FLAG-10-TIME`: owner confirms/changes 06:30 before S5 `-Apply`.
> - `FLAG-12-SKILL-EDIT`: owner applies/canaries the inert router patch at S7.
> - Every S1–S8 live action requires a fresh explicit owner approval at its
>   boundary. This package file is readiness, not authorization.

## 0. AGY identity, mode, and QA

When separately authorized: Antigravity/Gemini at maximum available reasoning;
one strictly serial operations lane; project
`C:\Users\pgvin\LLM Assisted Projects\Bridge`; identity
`BRIDGE_AGENT=antigravity`, `BRIDGE_LANE=google_antigravity`,
`BRIDGE_PROJECT=bridge`. Codex joins evidence; the owner approves every live
gate.

Scripts may format, validate, or render content you yourself reasoned out; they
may never originate substantive content. Every section's substance must trace
to your own reasoning.

Before any future execution, run
`C:\Users\pgvin\.gemini\antigravity\brain\4acd2eff-97e3-48fb-aa8c-9accee9ccb77\skills\agy-prompt-qa\SKILL.md`,
write/QA `ROUND1_SELF_PROMPT.md`, preserve revisions, and attach the filled QA
checklist.

## 1. Objective and exact deliverable

Take the fully accepted Caps product live through nine serial, reversible
evidence joins. AGY may author only:

| Claimed repo file | Purpose | Derived floor |
|---|---|---|
| `docs/caps/CUTOVER.md` | exact S1–S9 runbook, owner gates, timeouts, receipts, rollback | 9 numbered stages; 8 explicit live approval checks; 9 forward evidence sets; 8 rollback/deferred behaviors; 1 terminal SHA/receipt matrix |

All runtime mutations are separately owner-approved allowlists, not standing
repo claims. Evidence root `<factory-output>\13B\` contains the self-prompt,
immutable revision patches, checklist, stage receipts, hashes, logs, acceptance
join, and review pointer. Every artifact gets a truthful
`reasoned | script-rendered-from-reasoned-data | script-generated` stamp.
False stamps, overwrite, deletion, or retroactive/fabricated completion reject
the cutover.

## 2. Hard dependencies and resource rules

All Packages 01–12 and 13A must have accepted commits, terminal SHA-bound
independent reviews, current-byte joins, and a clean integration tree. Acquire
exclusive runtime ownership of the real caps DB, mcpservers network lane,
projection owner files, Task Scheduler caps namespace, and mailbox judgment
lane as each stage requires. Process-spawning verification acquires
`windows-spawn-heavy-test`. No overlapping Prospecting run, no timeout inflation.

## 3. Nine strictly serial stages

1. **S1 live backfill — owner approval required.** Run paced resumable
   `bridge caps backfill` with Package 05 host/pacing/bounds unchanged. Record
   start/checkpoints/end/counts/hash/gaps. Timeout means persist checkpoint and
   report deferred/incomplete; never fabricate completion. Rollback is later
   superseding evidence, not mass deletion.
2. **S2 live local lanes — owner approval required.** Run
   `bridge caps refresh --lane config`, then `--lane probe`; record reports and
   counts. Credential-dependent auth-pending/broken evidence is expected, not
   silently repaired.
3. **S3 live census — owner approval required.** Capture Code, Codex, and AGY
   roster receipts and any hosted client that actually sends `capsRoster`.
   Absence is a named gap under `FLAG-13-HOSTED`, never an invented roster.
4. **S4 owner projections — owner approval required.** Verify pre-write backups
   and manifests, render real `CATALOG.md` marker block, exclusive-create/read
   `NEEDS.json`, fully generate `AVAILABLE.md`, and perform byte-level owner
   review. Rollback uses only verified pre-write backups.
5. **S5 scheduler — owner approval required.** Re-audit and preserve the proven
   `\CodexConnector-CatalogSync` task (06:00/14:00/22:00, exact action/working
   directory, enabled/Ready, prior result 0); confirm `FLAG-10-TIME`; then apply
   only `\Bridge Caps Daily Refresh`, query it, manually run once, and verify
   caps status plus terminal report. Rollback removes/restores only the caps task
   via verified manifest.
6. **S6 live judgment round trip — owner approval required.** This stage is not
   complete at dispatch. It must:
   1. dispatch one canonical `bridge-caps-judgment-v1` document through
      `MailboxService.send()` with provider `"antigravity"` and record message,
      idempotency, payload, and immutable prompt hashes;
   2. wait for terminal mailbox completion within the named timeout;
   3. hash/parse/schema-validate the completed response and prove
      message/prompt/payload binding;
   4. ingest validated verdicts into only the judgment columns;
   5. run a subsequent projection regeneration or equivalent accepted
      projection stage;
   6. verify the same verdict value/reason/model/time appears in the DB row and
      `AVAILABLE.md`.

   If the timeout expires or state is queued, working, uncertain, canceled,
   failed, expired, mismatched, or malformed, record `deferred`/non-success with
   the exact state and resume token; do not claim completion or write verdicts.
7. **S7 per-prompt canary — owner approval required.** Owner applies the
   reviewed 12A patch; run one router-to-search-to-inert-proposal prompt; verify
   receipt and execute no install. Owner reverts the patch on failure.
8. **S8 rollback drill — owner approval required.** Remove/reapply only the caps
   schedule, restore a projection from a verified backup, and prove DB snapshot
   restore on a copy of caps.sqlite, never the live DB.
9. **S9 terminal acceptance join — owner decision required.** Assemble every
   package SHA/review/artifact, S1–S8 receipts/hashes, current clean tree, all
   open FLAGS and owner dispositions. Only the owner declares production
   cutover. ClickUp begins strictly after S9 and first censuses itself into Caps.

Every substep and compound member is individually binding. `etc.` is forbidden.

## 4. No-touch and future bus sequence

Until separately authorized, do not claim, edit, dispatch, write live state,
query network, change scheduler, alter owner files, send mailbox work, or apply
a skill patch.

On future authorization:

1. `bridge_sync({"project":"C:\\Users\\pgvin\\LLM Assisted Projects\\Bridge"})`
2. `bridge_claim({"project":"C:\\Users\\pgvin\\LLM Assisted Projects\\Bridge","paths":["docs/caps/CUTOVER.md"],"note":"Caps 13B owner-gated serial cutover runbook"})`
3. `bridge_log({"project":"C:\\Users\\pgvin\\LLM Assisted Projects\\Bridge","summary":"CAPS-13B doing: runbook only; live stages require individual owner gates","files":[]})`
4. Log each owner authorization and exact stage receipt separately.
5. After S9 owner declaration and independent same-SHA review, log
   `CAPS-13B done` with all artifact IDs and release the doc claim.

No-touch outside each explicitly approved stage allowlist: `.connector/**`,
Bridge 1.x, mailbox source/contracts, credentials, public endpoints, cloud,
automatic installs, paid actions, ClickUp implementation, unrelated scheduled
tasks, and unbacked owner bytes.

## 5. Verification, review, receipt, rollback

Offline runbook gate:

```powershell
git diff --check -- docs/caps/CUTOVER.md
```

Each future stage names exact commands, timeout/deferred behavior, forward
receipt, rollback/inverse, and hashes. Process-spawning stages queue on
`windows-spawn-heavy-test`. The final self-audit counts 9 stages, 8 live owner
gates, 9 evidence sets, 8 rollback/deferred paths, every package/review SHA, and
all flag dispositions.

Freeze the runbook/candidate, stop edits, and obtain an independent Claude
terminal review at the same SHA. AGY never self-certifies. Any byte change
invalidates affected receipts and review joins.

This is future Round 1 only after authorization. AGY's measured 26/292,
16-stub, and shrinkage failures make the cut exact: one skipped approval,
fabricated terminal state, incomplete judgment round trip, missing rollback,
floor, receipt, review, or SHA match blocks S9 and production cutover.
