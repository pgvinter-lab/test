# AGY Package 02 — Configuration Crawl

- Execution order: 02 of 13
- Implementation owner: AGY (Antigravity) only
- Package author/provenance: Codex (`producer_surface=codex`)
- Design authority: `docs/caps/DESIGN.md`

## 1. Objective

Implement the bounded, credential-blind configuration discovery lane for
Claude, project MCP files, Codex, and Gemini/Antigravity settings. The lane
discovers installed server declarations and emits normalized observations for
the caps store. It does not call tools, infer that a server works, scan arbitrary
drives, or retain secrets.

## 2. Allowed paths

AGY must `bridge_sync`, re-read changed files, and claim exactly:

```text
src/caps/crawl-config.ts
src/caps/crawl-targets.ts
test/caps/config-crawl.test.mjs
test/fixtures/caps/config-crawl/claude.json
test/fixtures/caps/config-crawl/project-mcp.json
test/fixtures/caps/config-crawl/codex.toml
test/fixtures/caps/config-crawl/gemini-settings.json
test/fixtures/caps/config-crawl/malformed.json
```

Read-only dependency paths: `src/caps/config.ts`, `src/caps/types.ts`, and
`src/caps/store.ts`.

No-touch zones:

- `.connector/**`
- `src/catalog.ts` and the `bridge catalog` model catalog
- all mailbox v3 paths:
  `contracts/mailbox-v1-draft/v3/**`, `src/v2/mailbox/**`,
  `migrations/mailbox/**`, `test/mailbox/**`,
  `integrations/chrome-mailbox/**`, and `integrations/web-nodes/**`
- the intact Bridge 1.x source directory

New npm dependencies: none. Use a documented targeted TOML subset parser; do
not add a TOML package.

Runtime read allowlist:

- `~/.claude.json`
- `.mcp.json` only at explicit project roots in the caps crawl-targets file
- `~/.codex/config.toml`
- `~/.gemini/settings.json`
- additional absolute project `.mcp.json` paths explicitly named in the
  owner-managed caps crawl-targets file

The lane may write only caps state and reports through Package 01 APIs.

## 3. Ordered implementation steps

1. Prove Package 01 and the external gate in Section 7.
2. Implement an owner-managed crawl-targets schema under the caps state
   directory. Create it only if missing; never replace owner entries. Reject
   relative, repository-escaping, Drive-exchange, and reparse-point targets.
3. Parse `~/.claude.json` top-level and per-project `mcpServers`.
4. Parse only explicit project `.mcp.json` files. Do not recursively search a
   home directory or drive.
5. Parse the `[mcp_servers.<name>]` subset of `~/.codex/config.toml`. Support
   string keys, quoted strings, string arrays, command, args, URL, and enabled
   state. Record a warning with file and line when unsupported TOML syntax
   affects a server; never guess.
6. Parse `~/.gemini/settings.json` MCP server declarations. Map actual
   Antigravity-owned declarations to `surface_owner=agy` while retaining the
   source path in provenance. Do not advertise a retired Gemini peer route.
7. Normalize only allowlisted metadata: stable server name, executable basename,
   redacted argument shape, sanitized URL without userinfo/query/fragment,
   transport, project scope, config path, and observed timestamp.
8. Never ingest `env`, environment values, headers, auth blocks, cookies,
   tokens, API keys, OAuth data, browser profile paths, or full raw config.
   Redact secret-shaped inline args. Store a canonical sanitized observation as
   `raw_json`; it must be safe to log.
9. A valid config declaration is evidence of installation, not evidence of
   health. Insert a newly discovered declaration into `installed_broken` with
   `failure_reason=verification_pending`, `last_verified=NULL`, and
   `source_lane=config-crawl`. A later probe or census is the only way to move
   it to `installed_working`.
10. For repeated crawls, upsert idempotently, preserve `curated_notes`, retain
    the oldest first-seen provenance in `provenance_json`, and advance only
    machine timestamps and sanitized fields.
11. Missing files are warnings, not failures. Malformed files produce a
    structured gap in the refresh report and no fabricated capability.
12. Add fixtures containing synthetic credential-shaped fields and assert that
    none reach observations, database rows, errors, or logs.

## 4. Enforcement rules

- Config crawling is bounded to the exact read allowlist.
- No credential value may be parsed into an intermediate object retained past
  the current file operation. Do not echo parse input on error.
- No shell execution, process spawn, network request, or tool invocation occurs
  in this lane.
- A declaration cannot create an `installed_working` row.
- Use `producer_surface=code` and `capture_class=guaranteed` for deterministic
  scheduled crawls. The capability owner remains `claude`, `codex`, `agy`, or
  another design value.
- Facts later recovered from Cowork transcripts must be census observations
  tagged `producer_surface=cowork`, `capture_class=best-effort`; they do not
  enter through this deterministic file lane.
- Pricing is always `free|unknown|paid`; absent pricing becomes `unknown`, never
  `free`.
- Paid-downvote is not exercised by this lane but its pricing value must be
  preserved for the shared hard-tier sorter.
- All writes use Package 01 transactions and preserve `curated_notes`.
- No public endpoint, tunnel, cloud, paid resource, or new dependency.
- AGY calls `bridge_log` and `bridge_release` after verification and labels its
  receipt `producer_surface=antigravity`.

## 5. Acceptance criteria and exact verification commands

Acceptance requires all four config families, bounded target handling, targeted
TOML limit warnings, deterministic provenance, credential non-retention, and
config-only rows that remain non-working.

```powershell
npm run build
node --test test/caps/config-crawl.test.mjs
node --test test/caps/store.test.mjs
rg -n "token|secret|password|api[_-]?key|authorization|cookie" test/fixtures/caps/config-crawl
git diff --check -- src/caps/crawl-config.ts src/caps/crawl-targets.ts test/caps/config-crawl.test.mjs test/fixtures/caps/config-crawl
```

The fixture `rg` command is expected to find synthetic secret-shaped inputs;
the test must prove those fixture values never occur in emitted observations or
stored rows.

## 6. Rollback note

Source rollback reverses only the allowed paths. Catalog rollback deletes only
rows whose provenance identifies the rolled-back synthetic or crawl run, in one
transaction, after a caps DB backup. Never delete owner notes. The owner-managed
crawl-targets file is not removed or overwritten.

## 7. Dependencies

- Package 01 accepted.
- External sequence remains:
  mailbox v3 completion, caps 01–13, then ClickUp.
- Do not execute while ClickUp or mailbox v3 owns a shared integration path.

## 8. FLAGS

- `FLAG-02-PENDING`: The exact three-table design has no installed-unverified
  table. This package uses `installed_broken` with
  `failure_reason=verification_pending` for config-only discoveries. It does
  not claim a failure was observed and cannot become working without
  probe/census evidence. If the owner rejects this interpretation, pause; do
  not add a fourth authority table silently.
- `FLAG-02-GEMINI`: DESIGN requires crawling `~/.gemini/settings.json` and also
  names both `gemini` and `agy`, while D-026 says Antigravity is the live Google
  peer and Gemini is retired. Preserve `gemini` only as historical/source
  provenance. Route live Antigravity-owned declarations as `agy`; never create
  a live `gemini` dispatch recipe without owner direction.

