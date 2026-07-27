# AGY Package 07 — MCP Tools and Sync Census Piggyback

- Execution order: 07 of 13
- Implementation owner: AGY (Antigravity) only
- Package author/provenance: Codex (`producer_surface=codex`)
- Design authority: `docs/caps/DESIGN.md`

## 1. Objective

Register the four owner-approved caps MCP tools on the existing Bridge stdio
server:

- `caps_search`
- `caps_get`
- `caps_report`
- `caps_refresh`

Also add an optional roster payload to `bridge_sync` so hosted clients can
piggyback census evidence on their mandatory sync call. Tool identity and
mutation authority must come from the existing registered Bridge lane, not from
user-controlled arguments.

## 2. Allowed paths

After `bridge_sync`, AGY must re-read current shared integration files and claim
exactly:

```text
src/caps/mcp.ts
src/server.ts
test/caps/mcp-tools.test.mjs
```

Read-only dependencies: `src/caps/**` produced by Packages 01–06 and the
existing Bridge compatibility/session code.

No-touch zones:

- `.connector/**`
- `src/catalog.ts`
- the existing `bridge catalog` branches in `src/cli.ts`
- mailbox v3 files:
  `contracts/mailbox-v1-draft/v3/**`, `src/v2/mailbox/**`,
  `migrations/mailbox/**`, `test/mailbox/**`,
  `integrations/chrome-mailbox/**`, `integrations/web-nodes/**`
- Bridge 1.x source

`src/server.ts` is a shared file touched by the in-flight mailbox v3 stream. It
is explicitly granted to this package only after that stream is complete,
unleased, and re-read. No mailbox source file is granted.

New npm dependencies: none. Do not edit `package.json` or lockfiles.

## 3. Ordered implementation steps

1. Prove Packages 01–06 and the external sequencing gate.
2. Put caps-specific schemas and handler adapters in `src/caps/mcp.ts`; keep the
   `src/server.ts` edit limited to imports, lifecycle close, registrations, and
   the optional sync hook.
3. Create one lazy Caps service per server process and close it on process exit,
   mirroring mailbox/core lifecycle without sharing their SQLite database.
4. Derive a trusted caller context from the current Bridge lane, configured
   principal/session/host, and MCP client name. Normalize Code, Cowork, Codex,
   and Antigravity separately.
5. Register `caps_search(query, opts?)` with bounded query/limit/filter schemas.
   Do not expose identity or pricing-order overrides.
6. Register `caps_get(id)` with a bounded identifier and no path/SQL argument.
7. Register `caps_report(roster)` using Package 04's closed roster schema. The
   handler injects trusted caller context and rejects any roster surface claim.
8. Register `caps_refresh(lane?)`. Code is always the orchestrator: a mutation
   request from Code may run locally; another surface receives a non-mutating
   `requires_code_orchestrator` result plus an exact A2A request template for
   Code. Do not silently execute refresh under Cowork/Codex/Antigravity.
9. Extend `bridge_sync` input with optional `capsRoster`. When present, process
   it through the same census path and include a receipt in the sync response.
   When absent, return a compact `capsCensus` status (`due`, `last_report_at`,
   `schema_version`) without treating absence as an empty roster.
10. Preserve every existing Bridge tool name, description, input, and behavior
    except the backward-compatible optional sync field/result addition.
11. Add a spawned stdio MCP test that lists tools, calls search/get/report,
    proves caller spoof rejection, proves paid ordering through the public
    surface, exercises sync piggyback, and proves non-Code refresh does not
    mutate.

## 4. Enforcement rules

- Existing Bridge and mailbox tools are regression protected.
- MCP discovery is not authorization; each handler independently derives and
  checks caller context.
- Caps is metadata only. Search/get/report/refresh never proxies a discovered
  capability or performs an install.
- `caps_report` may record a caller contribution; `caps_refresh` orchestration
  remains Code-owned.
- Every census fact retains Code/Cowork/Codex/Antigravity surface provenance and
  capture class.
- Paid remains hard-last in every MCP result. No schema field can override it.
- No credentials, arbitrary paths, raw SQL, public endpoint, tunnel, cloud
  resource, paid service, or new dependency.
- All mutations use Package 01 idempotent/atomic APIs; owner notes survive.
- AGY labels receipts `producer_surface=antigravity`, calls `bridge_log`, and
  releases all three claimed files.

## 5. Acceptance criteria and exact verification commands

```powershell
npm run build
node --test test/caps/mcp-tools.test.mjs
node test/mcp-smoke.mjs
npm run contract-test
git diff --check -- src/caps/mcp.ts src/server.ts test/caps/mcp-tools.test.mjs
```

Acceptance requires exactly the four caps tool names, backward-compatible
Bridge tools, trusted caller routing, working sync census piggyback, and
Code-only refresh mutation.

## 6. Rollback note

Remove the four registrations, the lazy Caps service, and only the optional
sync field/result. Preserve all existing server behavior. The caps DB remains
intact. Never roll back by restoring a pre-v3 `src/server.ts`; reverse only this
package's hunks.

## 7. Dependencies

- Packages 01–06 accepted.
- Mailbox v3 is complete, tested, unleased, and re-read.
- D-021 gate proven.
- Do not overlap this shared `src/server.ts` window with ClickUp.
- Global order remains mailbox v3, caps 01–13, then ClickUp.

## 8. FLAGS

- `FLAG-07-PIGGYBACK`: An MCP server cannot discover a hosted client's private
  tool roster by introspection. Actual sync piggyback therefore requires the
  client to send optional `capsRoster`; otherwise sync only reports census due.
  Do not fabricate a roster from server-side tool discovery.
- `FLAG-07-SHARED-FILE`: `src/server.ts` is a mailbox-v3 integration collision
  until v3 closes. This package explicitly grants that one shared file only
  after the gate; it grants no `src/v2/mailbox/**` file.

