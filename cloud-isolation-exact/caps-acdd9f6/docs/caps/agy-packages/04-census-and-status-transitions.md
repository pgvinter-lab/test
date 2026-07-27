# AGY Package 04 — Census and Evidence-Only Status Transitions

- Execution order: 04 of 13
- Implementation owner: AGY (Antigravity) only
- Package author/provenance: Codex (`producer_surface=codex`)
- Design authority: `docs/caps/DESIGN.md`

## 1. Objective

Implement the census service behind `caps_report(roster)`. Census is the only
lane that can report hosted rosters and live call failures that config files and
stdio probes cannot see. Reports are idempotent, surface-attributed, and cannot
spoof another caller.

## 2. Allowed paths

After `bridge_sync`, claim exactly:

```text
src/caps/census.ts
src/caps/service.ts
src/caps/types.ts
src/caps/store.ts
test/caps/census.test.mjs
test/fixtures/caps/census-roster.json
```

No-touch zones:

- `.connector/**`
- `src/catalog.ts` and `bridge catalog`
- every mailbox v3 stream file:
  `contracts/mailbox-v1-draft/v3/**`, `src/v2/mailbox/**`,
  `migrations/mailbox/**`, `test/mailbox/**`,
  `integrations/chrome-mailbox/**`, `integrations/web-nodes/**`
- `src/server.ts` in this package; MCP registration belongs to Package 07
- Bridge 1.x source

New npm dependencies: none.

Runtime writes are limited to the caps DB and caps-owned atomic census receipts
under the Package 01 state directory.

## 3. Ordered implementation steps

1. Prove Packages 01–03 and the external gate.
2. Define the closed `bridge-caps-roster-v1` input:
   `report_id`, `observed_at`, `complete`, `capabilities[]`, and `failures[]`.
   A capability contains kind, name, slug, transport, description, pricing,
   official, sanitized tool detail, and optional last-call evidence. It does
   not contain a caller-selected surface.
3. Require a trusted caller context supplied by the Bridge server:
   principal, session, host, canonical lane, and client name. Map that context
   to `producer_surface` and `surface_owner`; ignore/reject any surface field in
   the roster.
4. Map capture posture exactly:
   Code -> `producer_surface=code`, `capture_class=guaranteed`;
   Cowork -> `cowork`, `best-effort`;
   Codex -> `codex`, `reported`;
   Antigravity -> `antigravity`, `reported`.
5. Hash the canonical report. Persist a caps-owned receipt by `report_id`.
   Same ID/same hash returns the original result; same ID/different hash fails
   closed. Do not auto-delete receipts because retention is not approved.
6. Upsert successful live capabilities into `installed_working`. A success
   repairs a matching broken row in one transaction.
7. A failure report moves the exact matching working capability to
   `installed_broken`, preserving notes and recording a bounded reason,
   observation time, caller provenance, and optional sanitized failure class.
8. A `complete=true` roster may mark a previously census-owned capability from
   the same surface broken with `census_missing_from_complete_roster`. An
   incremental report may not infer removal from absence.
9. Match an `available_for_install` row by normalized slug or redacted command,
   then transactionally move it to the appropriate installed table. Preserve
   its curated notes and public index provenance.
10. Prevent one caller from changing another surface's status unless the report
    is from Code orchestration and explicitly cites the source surface being
    ingested. Cowork transcript ingestion remains best-effort and must be
    labeled as such.
11. Bound report size, row count, descriptions, schemas, and error strings.
    Reject credential-shaped fields and values before hashing or logging.
12. Add tests for idempotent replay, changed-key rejection, caller spoofing,
    Code/Cowork capture weighting, hosted roster creation, failure transitions,
    repair, complete vs incremental absence, and note preservation.

## 4. Enforcement rules

- Census is evidence; it never proxies or invokes a tool.
- Caller surface comes from the registered Bridge session, never tool input.
- Every fact has producer surface, capture class, observed time, verification
  time where applicable, and provenance.
- Code is the deterministic orchestrator. Cowork facts are explicitly
  best-effort even when Code later ingests the transcript.
- `free|unknown|paid` is mandatory. Paid remains the hard last tier and cannot
  be promoted by a report.
- Reports and transitions are idempotent and transactional.
- Never overwrite `curated_notes`.
- No credential, public endpoint, tunnel, cloud resource, or paid dependency.
- AGY calls `bridge_log` and `bridge_release` and labels its receipt
  `producer_surface=antigravity`.

## 5. Acceptance criteria and exact verification commands

```powershell
npm run build
node --test test/caps/census.test.mjs
node --test test/caps/store.test.mjs
git diff --check -- src/caps/census.ts src/caps/service.ts src/caps/types.ts src/caps/store.ts test/caps/census.test.mjs test/fixtures/caps/census-roster.json
```

Acceptance requires all capture mappings, spoof rejection, receipt
idempotency, evidence-only transitions, and no credential leakage.

## 6. Rollback note

Reverse only the package diff. Do not delete census receipts or rows merely to
hide a bad report. Correct bad evidence with a new, attributable report; restore
a verified pre-package DB snapshot only for structural corruption.

## 7. Dependencies

- Packages 01–03 accepted.
- Mailbox v3/D-021 external gate proven.
- Sequence remains mailbox v3, caps 01–13, then ClickUp.

## 8. FLAGS

- `FLAG-04-SURFACE`: The owner table value `surface_owner=claude` is not enough
  to distinguish Code from Cowork. This package preserves the required owner
  value and adds separate `producer_surface`/`capture_class` provenance rather
  than changing the owner enum.
- `FLAG-04-REMOVAL`: Missing capability means broken only when the same caller
  marks the roster complete. Incremental absence is never removal evidence.

