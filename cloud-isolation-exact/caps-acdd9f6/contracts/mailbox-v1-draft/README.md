# Bridge Mailbox Contract v1/v2/v3 (Draft)

Status: DRAFT. Implemented experimentally in Bridge `0.2.0`; not part of the
owner-frozen core contract.

## Purpose

The active v3 contract carries explicitly addressed messages from Bridge to
ChatGPT, Antigravity, or the generic browser-backed `web` provider and returns
the answer. A `web` message names a validated WEB node profile such as
`perplexity`; onboarding another site does not add another mailbox provider.
SQLite/WAL is the only
authoritative queue. Google Drive is an immutable exchange and human-accessible
replica, never a lock, lease, database, or browser-state store.

## Authorization

Creating a message records one authorization for one immutable prompt, one
provider, one approved destination, one use, and one expiry. The Bridge MCP tool or
CLI invocation is the approval act unless it names an existing `approvalRef`.
The consumer cannot widen the destination. A new provider, origin, prompt, or
reuse requires a new message and approval reference.

## State machine

```text
preparing -> queued -> claimed -> dispatching -> sent -> completed
     |          |         |            |          |
     +-> failed +-> expired+-> queued    +----------+-> uncertain
                              (only before dispatch)
```

- A claim is exclusive and lease-bound.
- Failures while `claimed` may retry up to the configured limit.
- Once `dispatching` is committed, expiration or failure becomes `uncertain`.
  Bridge never automatically resends an uncertain message.
- Response reservation and immutable publication make completion idempotent.

## Drive exchange

```text
Bridge Exchange/
  v3/projects/<project-slug-hash>/<provider>/
    inbox/<message-id>.json
    inbox/<message-id>.ready.json
    responses/<message-id>/<response-id>.json
    responses/<message-id>/<response-id>.ready.json
  v3/projects/<project-slug-hash>/web/outputs/<node-id>/<message-id>.md
```

An object is readable only after its adjacent ready marker exists and verifies
the exact byte length and SHA-256 hash. Files are create-only. Rewriting the same
path is accepted only when all bytes are identical.

The exchange may contain prompt and response text. It must not contain the
SQLite database or WAL, leases, delivery tokens, broker token, credentials,
cookies, browser profiles, or recovery keys. It is separate from the approved
`Bridge 2.0 Recovery` root.

Mailbox v1, v2, and v3 accept only `public` and `internal` sensitivity. Confidential and
restricted delivery fails closed until an encrypted exchange contract exists.

The original root `schemas/` and `examples/` remain the frozen v1 validation
set. `v2/` remains the historical ChatGPT/Antigravity contract. Active schemas,
examples, and the closed `bridge-web-node-v1` profile schema live under `v3/`.
Existing v1/v2 exchange objects are never renamed or rewritten.

## Local broker

The broker binds only to `127.0.0.1` or `::1` and requires a random bearer token
stored outside source control. Its routes are:

| Method | Route | Purpose |
|---|---|---|
| `GET` | `/health` | Integrity, WAL, event-chain, and provider checks |
| `POST` | `/v1/messages` | Enqueue one approved message |
| `GET` | `/v1/messages` | List metadata, never raw contents |
| `GET` | `/v1/messages/{id}` | Read status metadata |
| `POST` | `/v1/take` | Claim one provider-bound message |
| `POST` | `/v1/deliveries/{id}/dispatching` | Irreversible no-auto-retry boundary |
| `POST` | `/v1/deliveries/{id}/sent` | Record successful prompt submission |
| `POST` | `/v1/deliveries/{id}/heartbeat` | Extend an active lease |
| `POST` | `/v1/deliveries/{id}/complete` | Publish and bind one response |
| `POST` | `/v1/deliveries/{id}/fail` | Fail, retry, or mark uncertain by phase |

Delivery tokens are returned only by `/v1/take`, stored only as hashes in
SQLite, and never written to Drive or logs.

## Consumers

- The Chrome extension is the automatic consumer for ChatGPT and generic WEB
  nodes. The installer generates exact host permissions from enabled profiles;
  `<all_urls>` is never requested. It creates a dedicated background tab,
  drives only the origin bound into the message authorization, and stores no
  credentials. Its response hash proves the bytes
  captured from that tab; DOM capture does not cryptographically prove model
  causality or prompt-response binding.
- OAuth, cookies, and login state remain inside a dedicated browser profile
  under local Bridge runtime state. That profile is never copied into Git or
  Drive. Profiles contain selectors and bounded timing behavior only; arbitrary
  JavaScript is not a valid profile field.
- The local Antigravity plugin exposes the same claim lifecycle through MCP and
  is installed with `agy plugin install <plugin-directory>`. Antigravity has no
  fabricated browser origin or conversation URL in this contract.
- A ChatGPT custom app profile is deferred because ChatGPT requires a reachable
  remote MCP endpoint and does not provide autonomous background polling. No
  tunnel or public endpoint is created by this release.

## Explicit migrations

SQLite `user_version=3` is the active baseline. Opening a v1 or v2 config or
database through the v3 runtime fails with a migration-required error. The only upgrade
path is `bridge-mailbox migrate --config <path>`.

The migration first takes an exclusive database window and verifies integrity,
foreign keys, the full event/audit chain, and every referenced immutable v1
exchange object. It refuses any nonterminal legacy message or active delivery.
It then creates a digest-manifested restore backup, preserves historical rows and
v1 object bytes unchanged, extends the event chain with one
`mailbox.schema_migrated` event, and enables only `chatgpt` and `antigravity` for
new work. Historical `gemini` rows remain readable metadata and are guarded
against updates, deletion, new sends, or new claims.

Every message and delivery insert must declare `schema_version`; migrated
rows are marked `bridge-mailbox-v1` and new rows are marked
with the current version. This required column is the stale-writer fence: a surviving
v1 broker's old insert statements fail instead of creating v1 work after the
schema changes.

Snapshot rollback is allowed only inside the still-running migration command,
before any new-version message or delivery exists. The command verifies the preserved row
digests and confirms that no event follows `mailbox.schema_migrated` before it
performs an automatic restore. Once the command succeeds or any v2 work exists,
restoring the v1 snapshot is forbidden because it would discard accepted work;
recovery must move forward. The operator must stop every mailbox process
before invoking migration and keep that maintenance window closed until the
command returns. An allowed automatic restore replaces the backed-up v1 config,
SQLite snapshot, and audit mirror inside that same command. The operator then
runs the mailbox doctor before restarting the broker. The migration command does
not stop external processes or restart them. It never deletes an old integration
directory or any historical exchange object.

The v2-to-v3 phase uses the same exclusive-window, digest backup, audit-chain,
and restore-window rules. It refuses nonterminal v2 work, adds the single
`web` provider, seeds the Perplexity profile, and adds v3-only insert triggers so
a surviving v2 writer fails closed. Future WEB node onboarding changes only
validated local configuration and the generated exact-origin extension
manifest; it does not require another SQLite migration.
