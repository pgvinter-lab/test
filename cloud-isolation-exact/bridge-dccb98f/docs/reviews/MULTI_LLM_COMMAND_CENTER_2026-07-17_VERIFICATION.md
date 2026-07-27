# Multi-LLM Command Center Verification - 2026-07-17

Date: 2026-07-17

Status: VERIFIED WITH EXPLICIT LIMITS - detector and registry corrected; mailbox v2 migration implemented; required final tests pass; project-local Codex default remains out of scope

## Scope and evidence standard

- The three failures below were established by live model round trips on
  2026-07-17. PATH, installation, process, configuration-file, and credential-
  artifact checks are probes only.
- This work leaves `agent-card.ts` and the A2A peer set unchanged. It updates the
  existing Antigravity dispatcher and D-026 record only to pin the live-verified
  model and promote the peer to fail-closed `verified` status.
- The installed production runtime pinned by the audited final cutover was not
  rebuilt or deployed. Repository `npm run build` runs were verification only.
- Nothing was published, pushed, or shared.

## Error 1 - Gemini CLI is dead

How found: live exact-response round trip, not a presence or credential probe.

### Reproduction command

```powershell
gemini -p "Reply with exactly: GEMINI_REACH_OK"
```

### Verbatim failure

```text
Error authenticating: IneligibleTierError: This client is no longer supported for Gemini Code
Assist for individuals. To continue using Gemini, please migrate to the Antigravity suite of
products: https://antigravity.google
```

### Fix applied

- The deep-research backend detector now uses the installed `agy` CLI as the
  Google lane and verifies it only through an exact live response.
- The global systems registry now identifies Antigravity desktop, IDE, and CLI
  surfaces and no longer contains a Gemini system section.
- Pre-verification wording is `subscription-backed`, not
  `subscription-authenticated`, and the legacy `~/.gemini` directory is not
  presented as Antigravity authentication evidence.
- The Bridge mailbox now admits new `chatgpt` and `antigravity` work only.
  Antigravity uses the local MCP plugin surface; Chrome remains ChatGPT-only.
  Historical Gemini storage remains read-only and is not relabeled.

### Verification evidence

`agy --help` exited 0 and reported the verified local flags, including `--model`,
`--project`, `--new-project`, `--print`, `--mode`, `--add-dir`, and
`--dangerously-skip-permissions`. `agy models` exited 0 with these exact model
strings:

```text
Gemini 3.5 Flash (Medium)
Gemini 3.5 Flash (High)
Gemini 3.5 Flash (Low)
Gemini 3.1 Pro (Low)
Gemini 3.1 Pro (High)
Claude Sonnet 4.6 (Thinking)
Claude Opus 4.6 (Thinking)
GPT-OSS 120B (Medium)
```

These commands prove installation and inventory only. They are not represented as
a verified model round trip by themselves.

The final detector command shape was then exercised directly:

```powershell
agy --mode plan --print "Reply with exactly: ANTIGRAVITY_REACH_OK"
```

It exited 0 after 40.7 seconds and returned exactly
`ANTIGRAVITY_REACH_OK`.

### Pinned-model A2A promotion

The installed `agy` 1.1.3 CLI also completed an exact-response call with
`--model "Gemini 3.1 Pro (High)"`. Bridge now freezes that model in the
Antigravity peer specification instead of inheriting the CLI default. The
compiled dispatcher was exercised through a shell-free Windows child process
and returned the exact sentinel. Antigravity is therefore promoted from
`unreliable` to `verified`; its non-zero exits and runner failures now fail
closed in the same way as the other verified peers.

## Error 2 - Codex default model rejected

How found: live `codex exec` round trip without `-m`, not configuration-file
inspection.

### Reproduction command

```powershell
codex exec "..."
```

The quoted ellipsis is retained from the owner-provided reproduction rather than
inventing a prompt that was not supplied in the incident report.

### Verbatim failure

```text
ERROR: {"type":"error","status":400,"error":{"type":"invalid_request_error","message":"The
'gpt-5.2-codex' model is not supported when using Codex with a ChatGPT account."}}
```

### Root cause

`C:\Users\pgvin\LLM Assisted Projects\Bridge\.codex\config.toml` is a symbolic
link to `.agents\settings\codex.toml`. The target declares
`model = "gpt-5.2-codex"`, so the project-local setting outranks
`C:\Users\pgvin\.codex\config.toml`, which declares `model = "gpt-5.6-sol"`.
The npm launchers pass arguments through unchanged, and no model environment
override was present.

### Fix applied

- Detector and registry dispatch advice now pins
  `codex exec -m gpt-5.6-sol -c model_reasoning_effort="ultra"`.
- The project-local override itself was not edited because
  `.agents/settings/codex.toml` is outside this task's exact four-part file scope.
  Therefore a no-`-m` invocation from this workspace remains unresolved and is
  not described as fixed.

## Error 3 - detector mislabeled probes as verified logins

How found: live round trips contradicted the detector's probe-derived login
claims.

### Reproduction command

```powershell
node "$env:USERPROFILE\.claude\skills\deep-research-fanout\scripts\detect-backends.mjs"
```

### Verbatim false claims

```text
gemini CLI logged in
codex logged in
```

### Fix applied

- Antigravity and Codex remain `PROBED` after binary and artifact checks.
- Only an exact sentinel response can set `verified`, `available`, `usable`, or
  default selection for either lane.
- Antigravity verification uses `agy`; Codex verification explicitly uses
  `gpt-5.6-sol`.
- Windows process enumeration is bounded to five seconds and falls back to an
  unknown/not-running probe result instead of hanging the detector.

### Verification evidence

`node --check` exited 0. A probe-only `--json` run exited 0 and reported both
Antigravity and Codex as `PROBED`, with `attempted: false`, `verified: false`,
`available: false`, `recommended: false`, `usable: false`, and no verified-login
claim. The only recommended default was the verified in-process Claude lane.

A live `--verify --json` run exited 0 after 192.5 seconds. Antigravity returned
the exact sentinel and was reported `VERIFIED`. The explicit
`codex exec -m gpt-5.6-sol -c model_reasoning_effort=\"ultra\"` verification
attempt reached its 180-second detector timeout, remained `FAILED`, and was not
reported as available, usable, or recommended. This is an honest failed live
check, not a probe promoted to a login claim.

## Mailbox migration evidence

Read-only inspection of the configured v1 mailbox found one Gemini message and
one delivery, both `completed`, one idempotency record, seven database events,
seven matching audit-mirror entries, and matching immutable v1 message/response
object hashes. No prompt, response, credential, token, or browser-state content
was printed or copied into this record. Because the only legacy row is terminal,
the migration does not require an owner disposition.

The explicit `bridge-mailbox migrate --config <path>` path now:

- obtains an exclusive database window and rejects any nonterminal legacy message
  or active delivery;
- verifies SQLite integrity, foreign keys, the complete event/audit chain, and
  every referenced immutable v1 exchange object before creating migration state;
- creates a digest-manifested restore backup of config, SQLite, and audit mirror;
- preserves complete message, delivery, idempotency, and historical event rows,
  leaves all v1 exchange bytes and paths unchanged, and appends exactly one
  canonical `mailbox.schema_migrated` event to the prior hash;
- marks every migrated row `bridge-mailbox-v1` and requires new writers to set
  `bridge-mailbox-v2`, so a surviving v1 writer fails rather than creating work
  after migration;
- stores historical `gemini` only as immutable/read-only data while SQL triggers
  reject every update or deletion and active APIs reject new Gemini messages,
  deliveries, sends, and claims;
- permits snapshot restore only inside a failing migration command before any v2
  work, with row-digest and event-tail checks that fail closed rather than erase
  accepted v2 work;
- rejects integration targets containing a junction or symbolic-link component,
  including existing and dangling symlinked output leaves, before the Chrome or
  Antigravity installer writes beneath them; and
- writes new messages under `v2/.../antigravity/...`, packages a local
  Antigravity MCP plugin, and keeps the Chrome extension ChatGPT-only.

Automated migration tests compare every historical row and exchange object byte,
recompute the appended database/audit hash, verify backup digests and the backup
database, exercise direct SQL immutability guards, and prove fail-closed behavior
for queued Gemini, sent Gemini, a corrupt database chain, and a mismatched audit
mirror. They also keep a prepared v1 writer open across migration to prove its
old inserts fail, exercise legacy status/path mutation guards, attempt a
junction escape from the integration directory, and protect an outside sentinel
behind a symlinked plugin output file without creating a dangling link target. A
forced post-commit
configuration-validation failure also proves the
restore path returns config, database, audit mirror, and exchange snapshot to the
exact v1 state while retaining the recovery backup. The configured production
mailbox was not migrated; deployment and live
state migration remain a separate cutover operation.

A final read-only production doctor check still reported schema v1, SQLite
integrity `ok`, one completed message, seven database-chain events, and seven
audit-mirror entries with the same last hash. A metadata-only provider listing
still showed the completed row at its original `v1/.../gemini/...` paths. This
confirms that verification builds and tests did not mutate live mailbox state.

## Test evidence

### `npm run build`

Exit 0:

```text
> codex-claude-bridge@0.2.0 build
> tsc
```

### `npm run test:mailbox`

Exit 0. Actual summary:

```text
tests 21
pass 21
fail 0
cancelled 0
skipped 0
todo 0
```

The command also completed the build and all Chrome `node --check` steps.

### Mailbox schema verification

The first standalone run correctly failed AJV strict validation because the new
Antigravity `conversationUrl` prohibition used an invalid strict-schema form.
That schema was corrected; the rerun exited 0:

```text
MAILBOX CONTRACT SCHEMAS PASSED: legacy v1 6 schemas/5 examples; active v2 6 schemas/5 examples; provider, destination, and hash semantic vectors
```

`npm run contract-test` then exited 0, including node:sqlite, 13 core schemas,
the mailbox schemas, and the mock client contract.

### Repository-wide regression verification

The final `npm run test:all` exited 0 after the migration containment,
custom-config plugin, pinned-model, and worker-permission hardening. Material
summaries were 118/118 runtime tests, 1/1 WAL-race stress test, 8/8
cutover-harness tests, and 21/21 mailbox tests, all with zero skipped tests. The
known competing-WAL-writer test passed in the full run; no isolation rerun was
needed.

## Production and publication state

- The installed production runtime was not rebuilt or deployed; repository builds
  were verification-only.
- The audited final cutover manifest was not modified.
- No commit, push, publication, remote creation, or external share was performed
  by this task.

## Anything not completed

- The project-local Codex default override was located but not changed because
  its target file is outside the exact authorized scope. A no-`-m` invocation in
  this workspace therefore still resolves the rejected model.
- The detector's explicit Codex `gpt-5.6-sol` live verification reached its
  180-second timeout. It was correctly reported unavailable, not promoted from a
  probe.
- The configured production mailbox was not migrated and integrations were not
  installed. This task implemented and verified the migration/cutover inputs but
  did not perform the separately controlled production deployment.
