# AGY Package 09A — Projections and Owner Needs Profile

> ## FLAGS — OWNER MUST SEE BEFORE DISPATCH
>
> - `FLAG-09-NEEDS-LOCATION`: the proposed owner-managed profile is
>   `NEEDS.json` beside `CATALOG.md` and `AVAILABLE.md`. That placement remains
>   owner-visible; implementation must not hide or relocate it.
> - `FLAG-09-SOURCE`: initial seed provenance records the live `CATALOG.md`
>   path/hash/time observed at creation. Never hard-code a source hash.
> - This package implements and tests projection logic only. Writing the real
>   owner files remains owner-gated Package 13B S4.

## 0. AGY identity, mode, and QA

- Surface/model: Antigravity, Gemini implementation model, maximum available
  reasoning.
- Worktree: isolated Wave-1 Package 09A lane created by the single Caps factory
  orchestrator.
- Project: `C:\Users\pgvin\LLM Assisted Projects\Bridge`.
- Identity: `BRIDGE_AGENT=antigravity`,
  `BRIDGE_LANE=google_antigravity`, `BRIDGE_PROJECT=bridge`.

Scripts may format, validate, or render content you yourself reasoned out; they
may never originate substantive content. Every section's substance must trace
to your own reasoning.

Run
`C:\Users\pgvin\.gemini\antigravity\brain\4acd2eff-97e3-48fb-aa8c-9accee9ccb77\skills\agy-prompt-qa\SKILL.md`
first. Write/QA `ROUND1_SELF_PROMPT.md`; attach the filled
`QA_CHECKLIST.<UTC>.md` before submission.

## 1. Objective

Implement a marker-spliced installed projection in `CATALOG.md`, a fully
generated `AVAILABLE.md`, and an exclusive-create owner `NEEDS.json` seeded from
Gaps G2–G5. The caps DB remains authoritative, and every owner byte outside the
marked generated block survives.

## 2. Exact claims and numeric depth floors

| File | Purpose | Derived floor |
|---|---|---|
| `src/caps/projections.ts` | validation, backup/manifest, marker splice, generated available view, atomic replace | 3 projection targets/states; 6 marker validity cases; 3 pricing tiers; 1 backup manifest; 1 atomic replacement path |
| `src/caps/needs-profile.ts` | closed `bridge-caps-needs-v1` schema and exclusive seed | exactly 4 seeded needs; at least 9 top-level/source/need fields validated; 1 no-overwrite path |
| `test/caps/projections.test.mjs` | byte-sensitive offline tests | at least 14 named tests, including 6 marker cases, owner bytes, line endings, backups, manifest hash, injected failure, needs no-overwrite, paid-last, and verdict rendering |
| `test/fixtures/caps/catalog-owner-content.md` | owner-byte preservation fixture | at least 2 owner sections outside markers and 1 marked region |
| `test/fixtures/caps/needs-g2-g5.json` | canonical seed fixture | exactly 4 needs and all required source/provenance fields |

Claim those five paths only. Read accepted Packages 01–06 through public store
APIs/SELECTs; do not edit `store.ts`. Runtime paths permitted only under
temp directories in tests. Live owner paths and
`<caps-state>\backups\projections\**` are exercised only in 13B.

Evidence goes to `<factory-output>\09A\`: self-prompt, immutable
`iterations\<counter>-<UTC>.patch`, QA checklist, command logs,
`acceptance-receipt.json`, and review pointer. Every receipt entry declares
`reasoned`, `script-rendered-from-reasoned-data`, or `script-generated`.
False declaration rejects the package. Snapshot before every revision; never
overwrite or delete an iteration.

## 3. Ordered requirements

1. Validate `bridge-caps-needs-v1` with `profile_id`, `owner_managed:true`,
   `updated_at`, source path/section/SHA-256/observed time/Code guaranteed
   provenance, and needs with id/title/purpose/match terms/priority/free-first
   policy.
2. Seed exactly four needs: G2 venue-profile fetcher; G3 per-venue deadline
   engine; G4 judge/opposing-counsel analytics from free sources; G5
   jurisdiction-correct forms/templates.
3. Create `NEEDS.json` exclusively. If it exists, validate/read it and never
   machine-overwrite owner bytes.
4. Before each existing projection-file write, copy prior bytes under
   `<caps-state>\backups\projections\` and write a SHA-256 manifest. A missing
   target requires an explicit `no_prior_file` receipt.
5. In `CATALOG.md`, replace only bytes between
   `<!-- bridge:caps:generated:begin -->` and
   `<!-- bridge:caps:generated:end -->`; append one block when both markers are
   absent.
6. Reject duplicate, reversed, begin-only, and end-only markers without
   touching the target. Preserve every byte and line ending outside a valid
   generated region.
7. Render installed working/broken rows with surface, capture class, pricing,
   last verification, staleness, and curated notes. Within every section,
   pricing order is free, unknown, paid before secondary ordering.
8. Fully generate `AVAILABLE.md` with new servers/skills since the prior day,
   watch totals/deltas, validated AGY verdict columns, broken summary, bounded
   fetch-gap log, generation/source hashes, and a hint-not-proof warning.
9. Write same-directory temp bytes, flush, and atomically replace. Any failure
   leaves prior target bytes intact.
10. Test all floors using temp roots and fixtures; no live owner-file write.

Every numbered item and every member of a compound list is binding and appears
individually in the self-audit. `etc.` is forbidden in receipts.

## 4. No-touch and bus protocol

No-touch: `.connector/**`, `src/caps/store.ts`, `src/caps/types.ts`,
`src/caps/refresh.ts`, `src/cli.ts`, `package.json`, mailbox files, scheduler,
live caps DB, real owner files, Bridge 1.x, dependencies, credentials, public
endpoints, network, installs, and paid actions.

Exact Bridge order:

1. `bridge_sync({"project":"C:\\Users\\pgvin\\LLM Assisted Projects\\Bridge"})`
2. `bridge_claim({"project":"C:\\Users\\pgvin\\LLM Assisted Projects\\Bridge","paths":["src/caps/projections.ts","src/caps/needs-profile.ts","test/caps/projections.test.mjs","test/fixtures/caps/catalog-owner-content.md","test/fixtures/caps/needs-g2-g5.json"],"note":"Caps 09A isolated Wave-1 projection lane"})`
3. `bridge_log({"project":"C:\\Users\\pgvin\\LLM Assisted Projects\\Bridge","summary":"CAPS-09A doing: offline projections and owner needs profile","files":[]})`
4. Log exact files and candidate SHA after local gates.
5. After terminal same-SHA Claude PASS, log `CAPS-09A done` with commands/exits
   and review IDs.
6. Release exactly the five claimed paths with `bridge_release`.

## 5. Gates, review, receipt, rollback

```powershell
npm run build
node --test test/caps/projections.test.mjs
node --test test/caps/search-routing.test.mjs
git diff --check -- src/caps/projections.ts src/caps/needs-profile.ts test/caps/projections.test.mjs test/fixtures/caps/catalog-owner-content.md test/fixtures/caps/needs-g2-g5.json
```

These focused offline gates may overlap. Any full/process-spawning suite queues
on `windows-spawn-heavy-test`; no timeout inflation.

Self-audit arithmetic: 10 requirements, 5 deliverables/floors, 4 exact needs,
all marker cases, commands/exits, changed paths, SHA. Freeze a local candidate,
stop edits, and obtain an independent Claude terminal artifact bound to it.
AGY does not self-certify. Byte changes require a new iteration, commit, tests,
and review.

Rollback source by reversing only the five paths. Restore a live owner file only
from its hash-verified backup and only in 13B; never delete owner `NEEDS.json`.

This is Round 1 for 09A. AGY's prior measured misses include 26/292 rows, 16
stubs, and major regression shrinkage. One owner-byte loss, floor miss,
unbacked write, missing case, review absence, or SHA mismatch rejects the lane.
