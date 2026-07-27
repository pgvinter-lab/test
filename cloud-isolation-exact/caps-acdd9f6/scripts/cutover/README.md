# Windows test-cutover harness

`Invoke-BridgeTestCutover.ps1` performs a reversible **test** switch by replacing
one selected entry in `.mcp.json`. It does not rename, remove, or retarget the
historical `Codex Connector` junction. That keeps the currently configured bridge
and its junction target intact as the fallback while the selected MCP entry points
at one exact candidate build.

The script is dry-run by default. `-Apply` is required for either the test switch
or rollback. It refuses to proceed unless:

- every config, state, runtime, candidate, and transaction path is absolute and
  contained by its declared root, with no reparse point in the path;
- the candidate Git checkout is clean and exactly at the full commit in the plan;
- the exact Node executable is bound by absolute path and SHA-256;
- the source checkout is clean at the exact commit, and the candidate MCP
  entrypoint/cutover CLI are either tracked or intentionally Git-ignored build
  artifacts bound to exact SHA-256 hashes (so normal ignored `dist/` output is
  supported without weakening source-commit validation);
- every regular non-reparse file under candidate `dist/` matches one deterministic
  inventory hash, preventing an unchanged entrypoint from importing a modified
  ignored module;
- `.mcp.json` and the cutover manifest still have the hashes recorded in the plan;
- the selected primary MCP entry preserves `type: "stdio"`, points at the exact
  absolute Node executable with exactly one argument—the frozen candidate's
  `dist/server.js` compatibility facade—and preserves the current entry's
  environment exactly;
- preserved environment keys are limited to safe Bridge identity fields
  (`BRIDGE_AGENT` and `BRIDGE_LANE`), preventing `NODE_OPTIONS`, `PATH`, or
  another environment override from subverting the pinned command;
- the manifest's Bridge 2.0 endpoint command is exactly the compact JSON array of
  the candidate entry's `command` followed by its `args`;
- the current phase is `shadow` or `rollback`, with the candidate not yet primary.

The test operation creates an exact `.mcp.json` backup and cutover-state backup in
the transaction directory before any mutation. It stages the phase change on a
copy through the existing `cutover-switch` CLI, verifies the hash chain, then
replaces both live files. Any failure restores their original bytes. Rollback
stages a hash-chained `rollback` transition through the same CLI and restores the
exact config backup. Drift after either plan creation or test activation fails
closed for activation. Rollback is never blocked by candidate drift: when the
complete candidate `dist/` still matches, it stages the normal hash-chained
`rollback`. If the candidate is missing or changed, it executes no candidate code
and restores the exact pre-test config and cutover state backups. If a matching,
verified candidate CLI is attempted but fails, it uses the same fallback. The
transaction records either fallback as `emergency_exact_state`. Applied
test and rollback operations also hold one exclusive transaction lock under the
transaction root, preventing two harness processes from passing preflight and
replacing the files concurrently. Once prior config/state restoration is verified,
a later transaction-record write failure is reported as
`rollback_applied_record_update_failed` and never compensates back to the test
candidate.

## Plan shape

All paths must be absolute. The transaction root must be under Windows Local App
Data and outside the candidate source checkout. The config and cutover state are
also forbidden inside the candidate checkout. `candidateEntry` must have the same
`type`, `command`, `args`, and optional `env` fields as the current selected
entry; only `command` and `args` change. The v2 CLI remains a separate pinned
artifact used solely for cutover-state validation and hash-chain transitions.

```json
{
  "schemaVersion": "bridge2-windows-test-cutover-v1",
  "configRoot": "C:\\path\\to\\workspace",
  "mcpConfigPath": "C:\\path\\to\\workspace\\.mcp.json",
  "stateRoot": "C:\\Users\\owner\\AppData\\Local\\Bridge2\\projects\\project-id",
  "cutoverStatePath": "C:\\Users\\owner\\AppData\\Local\\Bridge2\\projects\\project-id\\cutover.json",
  "candidateRoot": "C:\\path\\to\\frozen-bridge-candidate",
  "candidateCommit": "full-40-character-git-commit",
  "runtimeRoot": "C:\\Program Files\\nodejs",
  "nodePath": "C:\\Program Files\\nodejs\\node.exe",
  "nodeSha256": "64-hex-sha256",
  "cutoverCliPath": "C:\\path\\to\\frozen-bridge-candidate\\dist\\v2\\cli\\main.js",
  "cutoverCliSha256": "64-hex-sha256",
  "candidateMcpEntrypoint": "C:\\path\\to\\frozen-bridge-candidate\\dist\\server.js",
  "candidateMcpEntrypointSha256": "64-hex-sha256",
  "candidateDistSha256": "64-hex-sha256-of-the-complete-dist-inventory",
  "serverName": "bridge",
  "candidateBridgeId": "bridge.2x.backup",
  "candidateEntry": {
    "type": "stdio",
    "command": "C:\\Program Files\\nodejs\\node.exe",
    "args": ["C:\\path\\to\\frozen-bridge-candidate\\dist\\server.js"],
    "env": { "BRIDGE_AGENT": "claude" }
  },
  "expectedConfigSha256": "64-hex-sha256",
  "expectedStateSha256": "64-hex-sha256",
  "transactionRoot": "C:\\Users\\owner\\AppData\\Local\\Bridge2\\cutover-transactions",
  "approvalRef": "approval.cutover.owner.test",
  "reason": "Timeboxed monitored Bridge 2.0 test cutover.",
  "rollbackApprovalRef": "approval.cutover.owner.rollback",
  "rollbackReason": "Restore the prior configured bridge after the test window or any failed smoke check."
}
```

The manifest endpoint `command` must equal the compact JSON encoding of the
candidate command tokens, for example:

```text
["C:\\Program Files\\nodejs\\node.exe","C:\\frozen\\dist\\server.js"]
```

`candidateDistSha256` is SHA-256 over UTF-8 lines sorted by ordinal relative path.
Each line is `forward/slash/relative/path`, one NUL byte, the lowercase per-file
SHA-256, and LF; the complete inventory also ends with LF. Reparse points anywhere
under `dist/` are rejected.

Dry-run and apply:

```powershell
powershell.exe -NoProfile -File .\scripts\cutover\Invoke-BridgeTestCutover.ps1 -Action Test -Plan C:\absolute\cutover-plan.json
powershell.exe -NoProfile -File .\scripts\cutover\Invoke-BridgeTestCutover.ps1 -Action Test -Plan C:\absolute\cutover-plan.json -Apply
```

The apply result prints `transactionPath`. Keep it for dry-run and applied
rollback:

```powershell
powershell.exe -NoProfile -File .\scripts\cutover\Invoke-BridgeTestCutover.ps1 -Action Rollback -Transaction C:\absolute\transaction.json
powershell.exe -NoProfile -File .\scripts\cutover\Invoke-BridgeTestCutover.ps1 -Action Rollback -Transaction C:\absolute\transaction.json -Apply
```

Run the synthetic Windows coverage through the package command (or invoke the
same test file directly with Node):

```powershell
npm run test:cutover-harness
```

Before live use, freeze and commit the candidate, reconcile the cutover manifest
to the exact command above, record fresh config/state hashes, complete the backup
and restore drill, and obtain a zero-failure doctor result. Keep the candidate and
transaction directory unchanged until rollback has closed. This harness enters
only the reversible `test` phase; it never promotes `final`.

The `.mcp.json` change affects only newly spawned MCP clients. Drain or close the
old `dist/server.js` / `serve-stdio` child processes, then restart the intended
clients before the fresh-client smoke check. Existing children do not switch in
place. The selected primary entry deliberately uses `dist/server.js` so the
historical `bridge_sync`, `bridge_claim`, `bridge_log`, and related aliases remain
available. The raw `serve-stdio` v2 surface is not a primary compatibility
cutover. The harness also does not start `serve-a2a` and does not register the
outbound A2A adapter; those are separate runtime gates.

## Antigravity Bridge peer cutover

`Install-AntigravityBridgePeer.ps1` is the reversible Antigravity-specific
configuration step. It points the global `bridge` MCP entry at one immutable
release, fixes the `antigravity` / `google_antigravity` identity binding, grants
only the explicit A2A send/get and board-dispatch tools, regenerates the local
Bridge plugin, and validates that `agy` processes both its MCP server and its
`bridge-peer-protocol` skill. It is a dry run unless `-Apply` is supplied.

```powershell
.\scripts\cutover\Install-AntigravityBridgePeer.ps1 -ReleaseRoot C:\absolute\immutable-release
.\scripts\cutover\Install-AntigravityBridgePeer.ps1 -ReleaseRoot C:\absolute\immutable-release -Apply
```

The applied result includes `backupRoot` and an exact `rollbackCommand`. The
backup covers both Antigravity JSON configs, the generated and installed plugin,
and the Chrome integration regenerated by the mailbox installer. Restart active
Antigravity sessions after apply; an existing MCP child cannot acquire the new
tool catalog in place.

## Live inbound-A2A canary

After the frozen build is backed up and restored, Doctor has zero failures, and
the MCP transaction is in `test`, run the separately supervised inbound canary:

```powershell
& 'C:\Program Files\nodejs\node.exe' .\scripts\cutover\Invoke-A2ALiveCanary.mjs `
  --cutover-plan C:\absolute\cutover-plan.json `
  --transaction C:\absolute\cutover-transaction.json `
  --cli C:\frozen\dist\v2\cli\main.js `
  --db C:\runtime\state\bridge2.sqlite `
  --audit C:\runtime\audit\events.jsonl `
  --context C:\runtime\config\context.json `
  --doctor-config C:\runtime\config\doctor-a2a-test.json `
  --report C:\runtime\reports\a2a-live-canary.json
```

The canary holds the same exclusive transaction lock as activation and rollback,
binds the exact plan (path and hash) and server name to the applied transaction
record and live `.mcp.json`, then refuses a dirty or wrong commit, mismatched
Node runtime/CLI/entrypoint/complete `dist/` hash, reparse-point path,
non-live state/audit/context path, or a cutover manifest
that does not show the exact candidate primary in `test`. It requires an empty migration
plan and zero-failure Doctor both before and after the request. It starts one
ephemeral loopback listener, sends one unique synthetic task, immediately reads,
cancels, and re-reads it, then stops only the exact child it spawned. The cancelled
task, prompt artifact, peer provisioning, and audit events are intentionally
immutable history; rollback never deletes them. A fsynced recovery journal is
created before the listener starts and records the stable message ID, task ID,
cancellation, signals, and teardown so an interrupted run remains recoverable. A
failure report records whether idempotent cancellation recovery succeeded and
whether every spawned listener stopped. This command does not enable outbound
provider dispatch. Launch the runner with the exact Node executable from the
plan and no Node command-line injection. Candidate child processes receive a
sanitized environment with every inherited `NODE_*` variable removed.
