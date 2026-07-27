# AGY Package 03 — Local Stdio Live Probe

- Execution order: 03 of 13
- Implementation owner: AGY (Antigravity) only
- Package author/provenance: Codex (`producer_surface=codex`)
- Design authority: `docs/caps/DESIGN.md`

## 1. Objective

Implement the bounded local stdio evidence lane:

```text
spawn -> MCP initialize -> initialized notification -> tools/list -> kill
```

The probe verifies reachability and captures real tool names and input schemas.
It never invokes a discovered tool. Success can move a row to
`installed_working`; a bounded, classified failure can move it to
`installed_broken`.

## 2. Allowed paths

After `bridge_sync`, AGY must claim exactly:

```text
src/caps/stdio-probe.ts
src/caps/probe-policy.ts
test/caps/stdio-probe.test.mjs
test/fixtures/caps/stdio-probe-server.mjs
```

Read-only dependencies:

```text
src/caps/config.ts
src/caps/types.ts
src/caps/store.ts
src/caps/crawl-config.ts
```

No-touch zones:

- `.connector/**`
- `src/catalog.ts` and existing model-catalog CLI behavior
- `contracts/mailbox-v1-draft/v3/**`
- `src/v2/mailbox/**`
- `migrations/mailbox/**`
- `test/mailbox/**`
- `integrations/chrome-mailbox/**`
- `integrations/web-nodes/**`
- Bridge 1.x source

New npm dependencies: none. Use Node child processes and the already installed
MCP SDK only.

Runtime writes are limited to Package 01 store APIs and caps refresh reports.

## 3. Ordered implementation steps

1. Prove Packages 01–02 and the external gate.
2. Accept only normalized `stdio` declarations produced by Package 02 or an
   owner-approved census record. Never accept an arbitrary command string from
   an MCP caller.
3. Spawn with `shell:false`, an argv array, `windowsHide:true`, a fixed working
   directory, and an executable resolved from the declaration. Reject shell
   metacharacter interpretation and executable paths outside approved local
   targets.
4. Supply a minimal safe environment (`PATH`, `SystemRoot`, `TEMP`, `TMP`,
   `USERPROFILE`, and required Node variables). Do not read or forward
   API-key-, token-, password-, cookie-, authorization-, or secret-shaped
   variables.
5. Bound startup, initialize, and total runtime separately. Defaults:
   10 seconds to initialize, 10 seconds for `tools/list`, and 25 seconds total.
   Make bounds owner-configurable within hard minima/maxima, not caller
   overridable through `caps_refresh`.
6. Perform the MCP protocol sequence exactly. Capture protocol/version,
   server identity, tool names, descriptions, and input schemas. Do not call
   prompts, resources, or any discovered tool.
7. Limit stdout/stderr and schema bytes. A size overflow is a classified probe
   failure. Store sanitized error codes and bounded messages; never store raw
   stderr if it contains credential-shaped text.
8. Always terminate the process. On timeout, close stdin, send a normal
   termination, then use a bounded Windows process-tree kill if still alive.
   Do not leave detached children.
9. On success, transactionally move/upsert the server and its tool detail into
   `installed_working`, setting `last_verified` and probe provenance. On failure,
   move/upsert into `installed_broken` with a stable reason code and
   `failure_observed_at`.
10. A later successful probe may repair broken to working. A parse warning or
    catalog inference may not.
11. Add a synthetic MCP child fixture covering success, malformed protocol,
    oversized output, explicit error, hang/timeout, early exit, and secret-like
    stderr redaction.

## 4. Enforcement rules

- The probe has no credential store and never forwards secret-shaped env vars.
- The probe lists tools only; it never invokes them.
- Process execution is shell-free, bounded, non-detached, and always cleaned up.
- Results are evidence, not a general proxy. Caps never forwards later tool
  calls through the probed child.
- Store tool schemas as bounded JSON attached to installed rows.
- Preserve owner `curated_notes` on every state move.
- Pricing remains mandatory; unknown stays between free and paid.
- Paid is always the last hard ranking tier in every later consumer.
- No endpoint, tunnel, cloud worker, paid resource, or new dependency.
- Scheduled deterministic observations are tagged
  `producer_surface=code`, `capture_class=guaranteed`.
- AGY implementation evidence is tagged `producer_surface=antigravity`, then
  `bridge_log` and `bridge_release` are required.

## 5. Acceptance criteria and exact verification commands

Acceptance requires a real MCP initialize/list exchange against the synthetic
child, zero tool calls, deterministic status transitions, complete cleanup, and
credential redaction.

```powershell
npm run build
node --test test/caps/stdio-probe.test.mjs
node --test test/caps/store.test.mjs
Get-Process node -ErrorAction SilentlyContinue | Select-Object Id,ProcessName,Path
git diff --check -- src/caps/stdio-probe.ts src/caps/probe-policy.ts test/caps/stdio-probe.test.mjs test/fixtures/caps/stdio-probe-server.mjs
```

The process listing is an operator sanity check; the automated test must track
its own fixture PID and prove that PID exits.

## 6. Rollback note

Stop any active probe child before source rollback. Reverse only this package's
allowed paths. Restore the pre-package caps DB backup only if migration/store
damage occurred; ordinary probe observations can be superseded by a new
evidence run and must not be mass-deleted.

## 7. Dependencies

- Packages 01 and 02 accepted.
- Mailbox v3 and D-021 external gate proven.
- Global sequence remains mailbox v3, caps 01–13, then ClickUp.

## 8. FLAGS

- `FLAG-03-AUTH`: Credential-blind probing will classify some installed,
  authentication-dependent servers as broken/auth-pending. That is the intended
  no-credentials posture. Do not weaken it by reading config `env` blocks.
- `FLAG-03-NETWORK`: A stdio server may itself contact a remote service during
  initialization. Record that as the probed server's behavior; Caps still
  creates no public endpoint and holds no upstream credential.

