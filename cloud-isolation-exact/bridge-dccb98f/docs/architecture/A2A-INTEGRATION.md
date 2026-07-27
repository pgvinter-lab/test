# A2A (Agent2Agent) Integration — Antigravity ⇄ Bridge

Status: **EXECUTABLE LOCAL PEER PATH; SEE D-026**. Antigravity, Claude, and
Codex can execute one another through Bridge's loopback A2A boundary and their
subscription-authenticated CLIs. Task-board writes and control handoffs remain
coordination metadata and are never treated as dispatch receipts.

## 1. Protocol surface

Bridge exposes an explicitly versioned A2A v0.3 compatibility surface:

- `GET /.well-known/agent-card.json`
- `POST /a2a` using JSON-RPC 2.0
- `message/send`, `tasks/get`, and `tasks/cancel`
- `streaming: false`; `message/stream` returns the documented unsupported error

The listener binds to loopback only. The Agent Card advertises only implemented
capabilities, the JSON-RPC endpoint, and the local `x-bridge-peer` identification
header. That header is a local peer selector, not a secret or remote-authentication
credential. Public exposure, tunneling, SSE, and push notifications are out of
scope and require a separate decision.

The published A2A specification has moved beyond this compatibility version.
Bridge intentionally declares v0.3 because that is the version implemented by
the stable JavaScript SDK used as the conformance reference. A future A2A 1.0
migration must be explicit; Bridge must never advertise a newer version or a
capability it has not implemented.

## 2. Execution path

`bridge_a2a_send` starts an ephemeral loopback boundary, sends a real
`message/send`, routes the task to the requested subscription CLI, drives its
Bridge review job through claim/start/complete or fail, persists the response as
a content-hashed artifact, and returns a terminal receipt. `bridge_a2a_get` reads
the authoritative job and artifact back through `tasks/get`.

`bridge_task_dispatch` performs the same A2A execution for an existing legacy
board row. It changes that row to `done` only when the receipt has all of:

- `channel: "a2a"`
- `terminal: true`
- `state: "completed"`
- at least one durable result artifact

A failed, submitted, or working task leaves the board row open. In contrast,
`bridge_task_add` returns `boardOnly: true` and an explicit `not_dispatched`
receipt. `bridge_handoff` returns the same explicit non-dispatch state because it
changes only the shared control token.

Each dispatch has a stable idempotency key. Replaying the identical request reads
the existing terminal task without invoking the peer twice; reusing the key with
a changed task, target, or prompt fails closed.

## 3. Subscription-only runner

**Invariant: subscriptions only, no API keys.** The executor resolves only the
three frozen peer commands (`agy`, `claude`, and `codex`) to installed absolute
paths, spawns without a shell, binds the child to the delegated project, strips
API-key/token/secret-shaped environment variables, and enforces time and output
limits. No Gemini API, Managed Agents API, or other metered provider credential is
accepted.

Antigravity's frozen command shape is `agy --model "Gemini 3.1 Pro (High)"
--print=<prompt>`. Codex uses `codex exec --skip-git-repo-check` because Bridge
projects may be non-Git Antigravity workspaces; Codex and Claude receive the
prompt on stdin. The Antigravity prompt necessarily appears in local process
command metadata because `agy` print
mode requires an option value; it remains one shell-free argv token and cannot
become another flag.

## 4. Antigravity configuration

Antigravity reaches Bridge through its supported global MCP configuration with:

- `BRIDGE_AGENT=antigravity`
- `BRIDGE_LANE=google_antigravity`
- explicit permission grants for `bridge_a2a_send`, `bridge_a2a_get`, and
  `bridge_task_dispatch`

The `bridge-mailbox` plugin also packages a `bridge-peer-protocol` rule and skill.
Both teach the board/A2A receipt distinction; the skill is a separately validated
component so a CLI version that fails to enumerate plugin rules cannot silently
drop all guidance. Tool descriptions repeat the invariant so correctness does
not depend on prompt guidance alone.

`scripts/cutover/Install-AntigravityBridgePeer.ps1` applies these settings from an
immutable release, backs up every changed config/plugin directory, validates the
plugin with `agy`, and emits a rollback command. Existing Antigravity sessions
must be restarted because MCP children and tool catalogs do not switch in place.

## 5. Bridge mapping and remaining gates

| A2A concept | Bridge concept |
|---|---|
| Caller | provisioned per-peer principal and loopback transport binding |
| Message | content-hashed prompt artifact |
| Task | review-job aggregate with claims, fencing, and terminal state |
| Result | content-hashed response artifact plus terminal receipt |
| Retry | deterministic task identity and request collision check |

The direct compatibility-tool execution path is production-capable. Registering
`adapter.a2a.client` for autonomous `AdapterHost` invocation remains a separate
approval-policy integration and is not required by the explicit MCP tools.
Remote/public A2A, SSE streaming, and A2A 1.0 are also separate gates.
