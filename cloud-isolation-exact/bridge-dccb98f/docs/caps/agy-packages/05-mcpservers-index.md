# AGY Package 05 — mcpservers.org Server and Skill Index

- Execution order: 05 of 13
- Implementation owner: AGY (Antigravity) only
- Package author/provenance: Codex (`producer_surface=codex`)
- Design authority: `docs/caps/DESIGN.md`

## 1. Objective

Implement the public mcpservers.org ingestion lane for servers and agent skills:
sitemap universe, bulk listing metadata, watch-term totals, sequential resumable
backfill, daily slug diff, and lazy detail fetch. The lane is an indexer, not a
tool installer or proxy.

## 2. Allowed paths

After `bridge_sync`, claim exactly:

```text
src/caps/mcpservers.ts
src/caps/mcpservers-parser.ts
src/caps/fetch-policy.ts
test/caps/mcpservers.test.mjs
test/fixtures/caps/mcpservers-root-sitemap.xml
test/fixtures/caps/mcpservers-server-sitemap.xml
test/fixtures/caps/mcpservers-skills-sitemap.xml
test/fixtures/caps/mcpservers-listing.html
test/fixtures/caps/mcpservers-search.html
test/fixtures/caps/mcpservers-detail.html
```

Read-only dependencies: Package 01 store/config/types.

No-touch zones:

- `.connector/**`
- `src/catalog.ts` and existing OpenRouter model catalog
- all mailbox v3 paths
- `src/server.ts` and `src/cli.ts`
- Bridge 1.x source

New npm dependencies: none. Use built-in `fetch`, `AbortSignal`, and a bounded
purpose-built parser covered by frozen fixtures.

Runtime writes:

- `available_for_install` through Package 01 APIs
- atomic caps-owned backfill checkpoints and refresh reports under the caps
  state directory
- no other file or database

## 3. Ordered implementation steps

1. Prove Packages 01–04 and the external gate.
2. Implement a closed fetch policy: HTTPS only, exact host allowlist for
   mcpservers.org, no redirects to another origin, bounded response size,
   20-second timeout, at most three retries, `Retry-After` compliance, and an
   honest `BridgeCaps/<version> local-owner-operated-indexer` user agent.
3. Fetch the root sitemap, then the declared server sitemap pages and
   `skills.xml`. Treat sitemap content as the slug universe. Never fabricate a
   row from a failed or malformed response.
4. Parse bulk listing/category/search fixtures for name, blurb, category,
   official/curated badges, stars, pricing evidence, and install command when
   publicly present. Exclude pinned sponsor rows unless their slug appears as
   an ordinary sitemap entry.
5. Index agent skills with `kind=skill` in `available_for_install`, using the
   same pricing, provenance, and paid-tier fields as servers.
6. Implement the initial backfill as sequential and resumable. Default to at
   least 750 ms between requests, persist the last completed sitemap position
   atomically, and stop cleanly on interrupt/rate limit. Never run a parallel
   10k-page fetch.
7. Do not fetch 10k detail pages during backfill. Use bulk metadata. Fetch a
   detail page only for a judgment/search shortlist or an explicit `caps_get`
   enrichment request, then stamp `detail_fetched_at`.
8. Implement the daily incremental lane:
   diff the new sitemap slug set against stored public-index slugs, take
   advantage of newest-first ordering without relying on it for correctness,
   and fetch only new/changed bulk entries plus configured watch terms.
9. Persist watch-term stated totals and deltas in the refresh report. Treat
   `/search?page=1&query=...` as the supported search shape. Do not use the
   design-documented nonfunctional `/all?q=` or `?category=` parameters.
10. Upsert idempotently, preserve `curated_notes` and prior judgments, stamp
    `producer_surface=external-index`, `capture_class=observed`, source URL,
    fetch time, parser version, response hash, and staleness.
11. On a fetch/parse gap, keep the last good row, mark the gap in the refresh
    report, and never guess. Do not demote an installed status from public index
    evidence.
12. Add only offline fixture tests to required CI. An owner-invoked live canary
    may fetch one sitemap and one listing page, but it must not be part of
    `npm run test:all`.

## 4. Enforcement rules

- Catalog, not proxy: no tool invocation, install, credential, or provider API.
- No public endpoint, inbound listener, tunnel, cloud worker, or paid resource.
- Paid/unknown/free classification is explicit. Missing evidence is `unknown`.
- The hard `free`, `unknown`, `paid` tier is preserved on every index result;
  no relevance score may lift paid above free.
- Network writes are never authoritative. Only committed SQLite rows are.
- Backfill checkpoints and reports use temp-plus-rename. DB upserts are
  transactional and idempotent.
- Preserve `curated_notes` and existing AGY verdicts during refresh.
- Log fetch outcome, status, size, hash, and parser result without response
  bodies or credential-shaped values.
- No new dependency or headless browser.
- AGY labels receipts `producer_surface=antigravity`, then calls
  `bridge_log`/`bridge_release`.

## 5. Acceptance criteria and exact verification commands

```powershell
npm run build
node --test test/caps/mcpservers.test.mjs
node --test test/caps/store.test.mjs
git diff --check -- src/caps/mcpservers.ts src/caps/mcpservers-parser.ts src/caps/fetch-policy.ts test/caps/mcpservers.test.mjs test/fixtures/caps
```

Acceptance requires sitemap server and skill discovery, sponsor exclusion,
pricing classification, paced resumability, daily diff, watch deltas, lazy
detail, last-good preservation, and zero required live network traffic.

## 6. Rollback note

Reverse the package source/fixture diff. Preserve the last good index and
checkpoint. A parser rollback must not mass-delete rows; a later successful
refresh supersedes them. Restore the DB only from a verified backup if a bad
migration or transaction damaged authority state.

## 7. Dependencies

- Packages 01–04 accepted.
- Mailbox v3/D-021 external gate proven.
- Global order remains mailbox v3, caps 01–13, then ClickUp.

## 8. FLAGS

- `FLAG-05-SCAN-AGE`: The design's 10,139-server, 15-category, 562-official,
  and 256-curated figures are a 2026-07-23 observation, not constants. Store
  each new stated total with timestamp and provenance; do not assert the old
  figure as current.
- `FLAG-05-PARSER`: A dependency-free HTML parser is intentionally narrow.
  Site markup drift must produce a recorded gap and fixture update, not guessed
  content.

