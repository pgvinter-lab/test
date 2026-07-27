# Bridge

Status: `0.2.0` LOCAL PROVIDER-MAILBOX CANDIDATE. Core contract
`0.1.0-draft.4` and mailbox contract `mailbox-v1-draft` remain versioned drafts.
No public or cloud deployment is authorized.

The sanitized Bridge 1.x baseline is commit `68ac195`, tagged
`bridge-1x-clean-baseline`. The proposed Bridge 2.0 contract begins at
`docs/architecture/DRAFT-CONTRACT.md` and
`contracts/v0.1.0-draft.4/README.md`.

## Provider mailboxes and WEB nodes

Bridge can queue one-use, provider-addressed messages for ChatGPT or
Antigravity, plus profile-addressed browser work through the generic `web`
provider. The queue is authoritative SQLite/WAL under `%LOCALAPPDATA%`;
immutable prompt and response envelopes are replicated to a separate Google
Drive `Bridge Exchange`. WEB node responses also get a readable Markdown
projection in that Drive tree. Historical Gemini and v2 rows remain immutable.

```powershell
bridge-mailbox init --exchange "C:\Users\you\My Drive\Bridge Exchange"
bridge-mailbox install-integrations
bridge-mailbox web-browser-start --node perplexity
bridge-mailbox broker
bridge-mailbox send --provider antigravity --project project.example --prompt "Review this synthetic input."
bridge-mailbox web-send --node perplexity --project project.example --prompt "Research this synthetic question."
```

Codex and Claude normally enqueue through `bridge_mailbox_send`, then inspect
`bridge_mailbox_status`. Browser services use `bridge_web_node_send`,
`bridge_web_node_result`, and `bridge_web_node_list`. The generated Chrome
extension is profile-driven and receives only exact enabled origins. The
dedicated browser profile owns Google OAuth, cookies, and provider sessions;
Bridge never exports them to source, SQLite, or Drive. Antigravity uses the
packaged local MCP plugin, installed with `agy plugin install <directory>`.
Neither integration creates a public endpoint.

Add another browser service with a closed JSON profile:

```powershell
bridge-mailbox web-node-validate --profile .\my-node.json
bridge-mailbox web-node-add --profile .\my-node.json
```

The profile may declare selectors and bounded settle/timeout behavior, but no
executable code. Adding it regenerates the exact-origin extension manifest;
reload the unpacked extension afterward. Existing mailbox-v1/v2 installations
must run `bridge-mailbox migrate --config <path>` before the v3 runtime opens
them. See `contracts/mailbox-v1-draft/README.md`.

Mailboxes support `public` and `internal` messages. Confidential/restricted
messages are rejected until encrypted exchange handling exists. Every MCP send
must include a stable `idempotencyKey` so transport retries cannot duplicate a
provider prompt.

The remainder of this file is the imported Bridge 1.x README and is retained as
historical baseline documentation.

---

# Codex ↔ Claude Bridge 1.x

Lets **OpenAI Codex CLI** and **Claude Code** work on the same projects without clobbering each
other — with a record of *which system touched which project*, and git+Drive backup so you can
resume on another machine.

Same machine, shared files. The bridge doesn't sync bytes (the filesystem already does that) — it
adds the two things that actually matter when two AI agents share a repo:

1. **Coordination** — atomic file *leases* and a *control handoff* token so only one agent edits a
   given path at a time.
2. **Visibility** — a turn-start `sync` that tells each agent *what changed since it last looked*
   (AI chats are snapshots, not live views), plus a cross-project *ledger* of all activity.

It runs as **one stdio MCP server** that each tool launches with its own identity (`BRIDGE_AGENT`),
coordinating through plain files on disk. Everything is also available as a `bridge` CLI.

## How it works

```
C:\dev\<project>\                     working trees: LOCAL git repos (never inside Drive)
  └─ .connector\
       ├─ state.json                  control holder, leases, tasks, per-session last-sync
       └─ journal.md                  human-readable "who did what"

<BRIDGE_HOME>\                        registry + ledger + backups (point at a Drive folder)
  ├─ registry.json                    every project: path, remote, last-active host/agent
  ├─ ledger.jsonl                     cross-project activity feed
  └─ backups\<project>.bundle         git bundle snapshots (atomic single file = Drive-safe)
```

`BRIDGE_HOME` resolves to `$BRIDGE_HOME` → else `G:\My Drive\codex-claude-bridge` (if Drive is
mounted) → else `~/.codex-claude-bridge`. Working trees stay **out** of Drive on purpose: Drive
syncing a live `.git/` corrupts repos. Drive only ever holds inert single files (bundles + JSON).

## Install

```sh
npm install
npm run build      # -> dist/
npm test           # e2e + MCP transport smoke
```

## Wire it into both tools

Register a project (git-inits it, writes the protocol into CLAUDE.md/AGENTS.md, prints snippets):

```sh
node dist/cli.js init my-project C:\dev\my-project --remote git@github.com:you/my-project.git
```

**Claude Code** — `C:\dev\my-project\.mcp.json`:

```json
{
  "mcpServers": {
    "bridge": {
      "type": "stdio",
      "command": "node",
      "args": ["C:\\dev\\codex-claude-bridge\\dist\\server.js"],
      "env": { "BRIDGE_AGENT": "claude" }
    }
  }
}
```

**Codex CLI** — `~/.codex/config.toml` (or a project `.codex/config.toml`):

```toml
[mcp_servers.bridge]
command = "node"
args = ["C:\\dev\\codex-claude-bridge\\dist\\server.js"]
env = { BRIDGE_AGENT = "codex" }
```

`node dist/cli.js snippets` reprints these any time.

## The protocol (what each agent does)

Embedded into every managed project's `CLAUDE.md` and `AGENTS.md`:

1. **Start of turn** → `bridge_sync`: see control holder, the other agent's leases, open tasks, and
   files changed since you last synced (re-read those).
2. **Before editing** → `bridge_claim ["src/api"]`: denied if it overlaps the other agent's lease.
3. **After working** → `bridge_log "summary" --files ...`, then `bridge_release`.
4. **To hand over** → `bridge_handoff codex|claude --note "..."`.

## CLI

```
bridge init <name> [path] [--remote url]   register + write protocol docs + print snippets
bridge sync [project]                      control, leases, tasks, freshness delta
bridge claim <paths...> [--note] [--ttl m] lease files/dirs before editing
bridge release [paths...]                  release your leases
bridge handoff [to] [--note]               pass the control token
bridge log "<summary>" [--files a,b]       record work to journal + ledger
bridge task-add "<title>" / task-update <id> <status>
bridge backup [project]                    git bundle -> BRIDGE_HOME (+ push if remote set)
bridge restore <project> [dest]            clone from bundle/remote on another machine
bridge list / recent [--project] [--limit] dashboard views
bridge home / snippets                     show BRIDGE_HOME / wiring snippets
```

Identity comes from `$BRIDGE_AGENT` (`codex`|`claude`); unset = `unknown` (fine for human CLI use).

## Backup & resume on another machine

```sh
node dist/cli.js backup my-project          # bundle -> Drive, and push to remote
# on machine B (Drive synced, this tool installed):
node dist/cli.js restore my-project C:\dev\my-project
```

## Status

v1 covers coordination, visibility, wiring, and backup/restore. Deferred: parallel `git worktree`
mode, a rendered ledger dashboard, and enforcement hooks (auto-inject freshness / block un-leased
edits). See `../plans/structured-greeting-neumann.md`.
