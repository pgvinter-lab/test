# Round 6 CAPS-08B Evidence

## 1. Aborted Prohibited Suite Truth
The previous `npm run test:all` attempt was an aborted prohibited suite truth and is not acceptance evidence. 
The correct gates are `npm run build`, `node --test test/caps/cli.test.mjs`, `npm run contract-test`, and `git diff --check`.

## 2. Quarantine Manifest and Hash Proof
- `src/caps/fetch-policy.ts` exact HEAD blob: `253d4d3aa8e162df37f68ec8e50ec355334e1a48`
- `factory-output/08B/quarantine` contains:
  - `debug.cjs`
  - `manifest.json`
  - `refresh.lock`
  - `run_gates.ps1`
  - `unauthorized-fetch-policy-debug.patch`
  - `stdio-probe-telemetry-*.json`
- These files are preserved exactly as left by Codex.

## 3. Exact URL Set and Request Log
The only URLs allowed in `test/caps/cli.test.mjs` are exactly the following Set:
- `https://mcpservers.org/sitemap.xml`
- `https://mcpservers.org/servers/1.xml`
- `https://mcpservers.org/skills.xml`
- `https://mcpservers.org/all`
- `https://mcpservers.org/all?page=1`
- `https://mcpservers.org/all?page=2`
- `https://mcpservers.org/agent-skills`
- `https://mcpservers.org/agent-skills?page=1`
- `https://mcpservers.org/search?page=1&query=official`
- `https://mcpservers.org/search?page=1&query=curated`
- `https://mcpservers.org/servers/test-server`
- `https://mcpservers.org/servers/paid-server`
- `https://mcpservers.org/servers/shared-slug`

All requests exactly match this set. Fixture `mcpservers` errors are exactly zero.

## 4. Status, Census, Checkpoint, and Terminal Facts
- **Status/Census**: Proved `searchMode` (fts/fallback) and `needsState` (installed/not_installed). Tested `lastRefresh` timestamp tie-breaking rules and missing `end_at` fallback. Proved census freshness logic checking `observed_at` (ignores malformed and future dates, triggering `censusDue=true`).
- **Checkpoint**: Asserted exactly bounded plain-object map (<25000), array of `pending`, exact `server|skill|done` phase, canonical ISO `updated_at`, positive integers for pages, and `schema` / `universe_hash`. Proven SHA-256 change across resumes while retaining the same `universe_hash` and phase logic.
- **Terminal Report**: Proved raw mcpservers report retains an exact `pending` number >= 0, proper canonical `finished_at`, empty `errors` array, and correct counts (processed, skipped_installed) without falsely asserting `lifecycle_status` on the nested lane report.

## 5. Direct Gate Exits and Counts
- `npm run build`: Exit 0
- `node --test test/caps/cli.test.mjs`: Exit 0 (17 tests, 17 pass, 0 fail)
- `npm run contract-test`: Exit 0 (NODE:SQLITE, CONTRACT SCHEMAS, MAILBOX CONTRACT SCHEMAS, MOCK CLIENT CONTRACT)
- `git diff --check`: Exit 0 (no trailing whitespace or marker errors)
