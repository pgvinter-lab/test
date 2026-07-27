# AGY Package 01 — Caps Store, Schema, and Search Index

- Execution order: 01 of 13
- Implementation owner: AGY (Antigravity) only
- Package author/provenance: Codex (`producer_surface=codex`)
- Design authority: `docs/caps/DESIGN.md`

## 1. Objective

Build the local `node:sqlite` foundation for Bridge caps without implementing
any crawler, network fetch, MCP tool, projection, or scheduler. The package must
create the exact owner-named capability tables:

1. `installed_working`
2. `installed_broken`
3. `available_for_install`

The database is metadata authority. It lives under the Bridge local runtime
state directory, never in the repository or the Drive exchange. Add a derived,
rebuildable FTS5 index when the runtime supports FTS5 and a deterministic
escaped-`LIKE` fallback when it does not.

## 2. Allowed paths

Before editing, AGY must call `bridge_sync`, re-read every path Bridge reports
as changed, then claim exactly:

```text
src/caps/config.ts
src/caps/types.ts
src/caps/store.ts
src/caps/search-index.ts
migrations/caps/001_caps_store.sql
test/caps/store.test.mjs
test/contract/node-sqlite.mjs
```

No other repository path is granted.

Global no-touch zones:

- `.connector/**`
- `src/catalog.ts` and the existing `bridge catalog` model-catalog behavior
- `contracts/mailbox-v1-draft/v3/**`
- `src/v2/mailbox/**`
- `migrations/mailbox/**`
- `test/mailbox/**`
- `integrations/chrome-mailbox/**`
- `integrations/web-nodes/**`
- the intact Bridge 1.x source directory

New npm dependencies: none. Do not edit `package.json` or `package-lock.json`.

Runtime write allowlist:

- `%LOCALAPPDATA%\Bridge2\caps\caps.sqlite` by default
- an absolute directory supplied through `BRIDGE_CAPS_STATE_DIR`
- caps-owned backup, lock, receipt, and refresh-report children under that same
  state directory

Reject a state directory inside the repository, the mailbox state directory,
the Drive exchange, or a reparse-point escape.

## 3. Ordered implementation steps

1. Prove the external gate in Section 7 before writing code.
2. Implement `defaultCapsStateDirectory()` as
   `%LOCALAPPDATA%\Bridge2\caps` on Windows, following the containment,
   canonical-path, mode, and state/Drive-separation reflexes in
   `src/v2/mailbox/config.ts`. Accept only the explicit
   `BRIDGE_CAPS_STATE_DIR` override; do not scan for another database.
3. Define closed TypeScript unions for:
   `kind=server|tool|skill`,
   `pricing=free|unknown|paid`,
   `surfaceOwner=claude|codex|gemini|agy|clickup-hosted|n/a`,
   `transport=stdio|http|hosted`, and the five design source lanes.
4. Add explicit capture provenance to every row:
   `producer_surface=code|cowork|codex|antigravity|external-index`,
   `capture_class=guaranteed|best-effort|reported|observed`,
   `observed_at`, `last_verified`, `stale_at`, and canonical
   `provenance_json`. This is required by the owner's surface bifurcation.
5. Create a checksummed, forward-only migration. All three owner tables are
   `STRICT` and share these columns:
   `id`, `kind`, `name`, `slug`, `source_url`, `surface_owner`, `transport`,
   `description`, `pricing`, `official`, `stars`, `install_command`,
   `source_lane`, `producer_surface`, `capture_class`, `observed_at`,
   `last_verified`, `stale_at`, `curated_notes`, `tools_json`, `detail_json`,
   `provenance_json`, and `raw_json`.
6. Add only the necessary table-specific columns:
   `installed_broken.failure_reason`,
   `installed_broken.failure_observed_at`, and, on
   `available_for_install`, `category`, `detail_fetched_at`,
   `judgment_model`, `judgment_at`, `judgment_verdict`,
   `judgment_reason`, and `judgment_surface`.
7. Require valid JSON for every non-null JSON column. Use integers constrained
   to `0|1` for booleans. Use ISO-8601 UTC text for timestamps. Never put a
   credential, header, cookie, token, browser state, prompt, or response in
   `raw_json`.
8. Implement idempotent upserts with a stable canonical observation hash.
   Reusing an observation ID with changed canonical content must update only
   machine-owned fields and must never overwrite `curated_notes`.
9. Implement working/broken moves as one `BEGIN IMMEDIATE` transaction that
   copies `curated_notes` and provenance, inserts the destination row, and
   deletes the source row. Only a typed probe or census evidence object may
   invoke the move API.
10. Implement available-to-installed moves in one transaction, matching by
    normalized source slug first and a redacted normalized command second.
11. Feature-detect FTS5 at database initialization. When present, create a
    derived `caps_search_fts` virtual index over non-secret searchable text.
    It is not a fourth state table and must be fully rebuildable from the three
    owner tables. When unavailable, use parameterized, escaped `LIKE` over
    `name`, `slug`, `description`, and `curated_notes`, with a hard result cap.
12. Extend `test/contract/node-sqlite.mjs` to report FTS5 availability while
    retaining its WAL, rollback, and integrity assertions. The installed
    runtime was empirically checked on 2026-07-24: Node `v24.16.0` successfully
    created and queried an FTS5 table through `node:sqlite`.
13. Add offline store tests for schema names, constraints, WAL, idempotency,
    curated-note preservation, atomic state moves, provenance requirements,
    FTS rebuild, and forced `LIKE` fallback.

## 4. Enforcement rules

- The three owner table names and their installed-working, installed-broken,
  and available meanings are requirements.
- The FTS structure is derived only. A failed FTS rebuild must not corrupt or
  block reads from the three authority tables.
- `pricing` is mandatory. Unknown does not mean free.
- Define one non-overridable sort-tier helper:
  `free=0`, `unknown=1`, `paid=2`. Later packages must reuse it; callers and
  models may not supply a different tier or weight.
- Only probe/census evidence can assert working or broken. Configuration
  presence alone never asserts working.
- All database writes are idempotent and transactional. Run
  `PRAGMA foreign_keys=ON`, use WAL, and verify `PRAGMA integrity_check`.
- Back up an existing DB before applying a migration. Never downgrade in place.
- Do not store credentials or credential-shaped values, create a public
  endpoint, tunnel, cloud worker, or paid resource.
- AGY must label implementation receipts and generated evidence
  `producer_surface=antigravity`.
- After the unit is complete, call `bridge_log` with the exact changed-file
  list and then `bridge_release` those paths.

## 5. Acceptance criteria and exact verification commands

Acceptance requires:

- the exact three owner tables exist;
- all rows require pricing and provenance/staleness stamps;
- `curated_notes` survives every upsert and move;
- a changed idempotency-key request fails closed where applicable;
- FTS5 is used on the current runtime and the forced fallback test also passes;
- the DB is outside the repository and Drive exchange; and
- strict TypeScript compilation succeeds.

Run from the repository root:

```powershell
npm run build
node test/contract/node-sqlite.mjs
node --test test/caps/store.test.mjs
npm run contract-test
git diff --check -- src/caps/config.ts src/caps/types.ts src/caps/store.ts src/caps/search-index.ts migrations/caps/001_caps_store.sql test/caps/store.test.mjs test/contract/node-sqlite.mjs
```

## 6. Rollback note

Before a migration, copy the DB, WAL, and SHM consistently under the caps state
backup directory and write a hash manifest. Source rollback removes only this
package's files or reverses this package's diff; never use `git reset --hard`.
Runtime rollback stops caps writers and restores the verified pre-migration
snapshot. Do not write a down migration.

## 7. Dependencies

External gate: do not execute this or any later caps package until the mailbox
v2-to-v3 migration and its tests are complete, its integration paths are no
longer leased, and the repository's D-021 authorization gates are proven.

Codex sequencing decision:

```text
mailbox v3 completion -> caps packages 01 through 13 -> ClickUp board task
```

Do not run the ClickUp implementation concurrently with caps. After ClickUp is
implemented, it must report/crawl into the already working caps catalog.

Package dependencies: none beyond the external gate.

## 8. FLAGS

- `FLAG-01-FTS`: FTS5 is confirmed available on the current Node `v24.16.0`
  runtime. The fallback remains mandatory because the repository engine floor
  is Node `>=22.13.0` and future builds may differ.
- `FLAG-01-TABLES`: `caps_search_fts` and SQLite shadow tables are derived
  indexes, not additional catalog authority. If the owner interprets "three
  tables" as forbidding even derived virtual indexes, disable FTS and use the
  required `LIKE` fallback; do not rename or add another authority table.
- `FLAG-01-GATE`: RESOLVED on 2026-07-24. Mailbox v3 is live and healthy,
  the independent Claude closure is recorded, `npm run test:all` passes on the
  current revision, the worktree is clean, and the authoritative Bridge 2.0
  coordination surface has zero leases. AGY must re-run `bridge_sync` and
  re-prove those conditions immediately before editing; any regression remains
  a hard stop.
