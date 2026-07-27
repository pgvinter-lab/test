# AGY Package 06 — Search, Get, Ranking, and Caller Routing

- Execution order: 06 of 13
- Implementation owner: AGY (Antigravity) only
- Package author/provenance: Codex (`producer_surface=codex`)
- Design authority: `docs/caps/DESIGN.md`

## 1. Objective

Implement the service behavior for `caps_search(query, opts?)` and
`caps_get(id)`: compact two-phase discovery, full detail retrieval, immutable
paid-downvote ordering, and a truthful routing recipe computed from the trusted
calling surface.

## 2. Allowed paths

After `bridge_sync`, claim exactly:

```text
src/caps/search.ts
src/caps/routing.ts
src/caps/service.ts
src/caps/types.ts
src/caps/store.ts
test/caps/search-routing.test.mjs
```

No-touch zones:

- `.connector/**`
- `src/catalog.ts` and the `bridge catalog` namespace
- all mailbox v3 files
- `src/server.ts`; tool registration is Package 07
- `src/cli.ts`; CLI integration is Package 08
- Bridge 1.x source

New npm dependencies: none.

This package writes only lazy public detail/provenance through the caps store.
Search and get are otherwise read-only.

## 3. Ordered implementation steps

1. Prove Packages 01–05 and the external gate.
2. Define bounded search options: kind, table origin, surface owner, and limit.
   Do not expose a pricing-order override, `includePaidFirst`, raw SQL, or
   caller-supplied identity.
3. Query FTS when available and the escaped `LIKE` fallback otherwise. Search
   compact text only; do not search arbitrary raw JSON or credential-shaped
   content.
4. Apply the non-overridable outer ordering before any relevance ordering:
   `free`, then `unknown`, then `paid`.
5. Within one pricing tier, order:
   `installed_working`, `installed_broken`, `available_for_install`;
   relevance; capture confidence (`guaranteed` before `observed/reported` before
   `best-effort`); official; stars; stable normalized name; ID.
6. Return compact hits containing only ID, name, kind, pricing, one-line
   description, table of origin, staleness/provenance summary, and routing
   recipe. Bound count and byte size.
7. Derive caller surface from a trusted Bridge context. Never accept it in
   `opts`.
8. Compute recipes truthfully:
   - caller owns a verified tool: `native` with exact tool name;
   - capability on `agy`: existing v3
     `bridge_mailbox_send(provider=antigravity)` template;
   - capability on Claude or Codex: approved D-026
     `bridge_a2a_send(target=claude|codex)` template, clearly labeled A2A rather
     than mailbox;
   - `clickup-hosted`: native only when the caller owns that surface; otherwise
     return unavailable until its approved integration supplies a route;
   - historical `gemini`: return unavailable/retired, never route to Gemini;
   - available: install command only as inert text plus pricing and
     owner-confirmation flags.
9. Never claim a broken or stale capability is callable. Its recipe is
   diagnostic, with last evidence and repair path.
10. `caps_get(id)` returns the full sanitized row, tool/detail JSON, owner notes,
    judgment fields, and provenance. If public detail is missing, it may request
    Package 05 lazy enrichment under the same fetch policy; return the stored row
    if enrichment fails.
11. Add adversarial ranking tests proving:
    a weak free match outranks a perfect paid match; unknown is between; no
    caller option changes it; stale/broken recipes do not claim success; and a
    caller cannot spoof native ownership.

## 4. Enforcement rules

- Paid is always below every free row, regardless of relevance, status, stars,
  official badge, model request, or caller.
- Unknown is always between free and paid.
- Catalog output is a hint with provenance, not proof of tool success.
- Routing is a recipe, never a proxied tool call.
- No automatic install, process spawn, credential use, or external mutation.
- Every hit includes surface and capture provenance. Code vs Cowork weighting is
  visible and deterministic.
- Do not fabricate mailbox providers. The active v3 providers remain exactly
  ChatGPT, Antigravity, and web.
- Owner notes are returned but never machine-overwritten.
- All detail enrichment is idempotent and atomic.
- No public endpoint, tunnel, cloud, paid resource, or new dependency.
- AGY logs/releases and labels evidence `producer_surface=antigravity`.

## 5. Acceptance criteria and exact verification commands

```powershell
npm run build
node --test test/caps/search-routing.test.mjs
node --test test/caps/store.test.mjs
git diff --check -- src/caps/search.ts src/caps/routing.ts src/caps/service.ts src/caps/types.ts src/caps/store.ts test/caps/search-routing.test.mjs
```

Acceptance requires two-phase compact/full behavior, immutable paid sorting,
truthful caller-derived routes, retired Gemini handling, and bounded results.

## 6. Rollback note

Search/routing source rollback has no authority-data rollback. Revert only the
allowed source/tests. Do not delete stored observations or judgments because a
ranking implementation is rolled back.

## 7. Dependencies

- Packages 01–05 accepted.
- Mailbox v3/D-021 gate proven.
- Mailbox v3 is read-only to this package.
- Global sequence remains mailbox v3, caps 01–13, then ClickUp.

## 8. FLAGS

- `FLAG-06-DATA-PLANE`: DESIGN says every non-native hit receives a mailbox
  dispatch template, but mailbox v3 has no Claude, Codex, ClickUp, or Gemini
  provider. This package uses approved D-026 A2A recipes for Claude/Codex,
  Antigravity mailbox for `agy`, and fails closed for ClickUp/Gemini. Do not
  change the v3 provider enum to make the wording fit.
- `FLAG-06-CLICKUP`: `clickup-hosted` remains a required surface value, but its
  live route is unavailable until the later ClickUp task completes. Refresh and
  census it after that task; do not run the tasks concurrently.

