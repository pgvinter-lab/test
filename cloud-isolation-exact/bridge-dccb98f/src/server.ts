#!/usr/bin/env node
import crypto from "node:crypto";
import os from "node:os";
import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import { z } from "zod";
import { getConfig } from "./config.js";
import { LegacyBridgeFacade } from "./v2/compat/legacy-core.js";
import { resolveLane } from "./v2/compat/lanes.js";
import { loadMailboxConfig } from "./v2/mailbox/config.js";
import { MailboxService } from "./v2/mailbox/service.js";
import { listWebNodeProfiles } from "./v2/mailbox/web-node-runtime.js";
import {
  CAPS_CENSUS_SCHEMA_VERSION,
  CapsMcpRuntime,
  capsCensusRosterInputSchema,
  deriveTrustedCapsContext,
  registerCapsTools,
  type CapsCensusStatus,
} from "./caps/mcp.js";

// This server lives as long as the chat window. Give it a unique per-process
// session id (unless one was injected) so each window tracks its own freshness
// baseline — even two windows of the same agent. Must run before getConfig().
if (!process.env.BRIDGE_SESSION) {
  const agent = (process.env.BRIDGE_AGENT || "unknown").toLowerCase();
  process.env.BRIDGE_SESSION = `${agent}:${os.hostname()}:${process.pid}:${Date.now()}`;
}

const cfg = getConfig();

const server = new McpServer({
  name: "codex-claude-bridge",
  version: "0.2.0",
});

const currentLane = () => resolveLane({
  configuredAgent: cfg.agent,
  configuredLane: process.env.BRIDGE_LANE,
  clientName: server.server.getClientVersion()?.name,
});

const core = new LegacyBridgeFacade({
  config: cfg,
  lane: currentLane,
});

process.once("exit", () => core.close());

let mailboxCore: MailboxService | undefined;
function mailbox(): MailboxService {
  mailboxCore ??= new MailboxService(loadMailboxConfig());
  return mailboxCore;
}
process.once("exit", () => mailboxCore?.close());

let capsCore: CapsMcpRuntime | undefined;
function caps(): CapsMcpRuntime {
  capsCore ??= new CapsMcpRuntime();
  return capsCore;
}
process.once("exit", () => capsCore?.close());

const getCapsCallerContext = () => {
  const lane = currentLane();
  return {
    principal: cfg.agent,
    session: cfg.sessionId,
    host: cfg.host,
    lane: lane.lane,
    lane_ambiguous: lane.ambiguous,
    lane_configured: Boolean(process.env.BRIDGE_LANE?.trim()),
    client_name: server.server.getClientVersion()?.name ?? "unknown",
  };
};

registerCapsTools(server, caps, getCapsCallerContext);

/** Wrap any JSON-able result as an MCP text content block. */
function ok(obj: unknown) {
  return { content: [{ type: "text" as const, text: JSON.stringify(obj, null, 2) }] };
}
function fail(message: string) {
  return { isError: true, content: [{ type: "text" as const, text: JSON.stringify({ ok: false, message }, null, 2) }] };
}
async function run(fn: () => Promise<unknown>) {
  try { return ok(await fn()); } catch (e) { return fail((e as Error).message); }
}

const projectArg = { project: z.string().optional().describe("Project name or absolute path; defaults to the current directory") };

server.registerTool(
  "bridge_sync",
  {
    title: "Sync with the bridge",
    description:
      "Call at the START of every turn before editing. Returns who holds control, the other agent's active file leases, open tasks, and the files that changed since you last synced (re-read those — your cached copy is stale).",
    inputSchema: {
      ...projectArg,
      capsRoster: capsCensusRosterInputSchema.optional().describe(
        "Optional closed bridge-caps-roster-v1 census payload to piggyback",
      ),
    },
  },
  async (a) => run(async () => {
    const res = await core.sync(a.project);
    let context;
    try {
      context = deriveTrustedCapsContext(getCapsCallerContext());
    } catch {
      if (a.capsRoster !== undefined) {
        throw new Error("caps_caller_context_unavailable");
      }
      return {
        ...(res as Record<string, unknown>),
        capsCensus: {
          schema_version: CAPS_CENSUS_SCHEMA_VERSION,
          due: true,
          last_report_at: null,
          status: "unavailable",
          reason: "caps_caller_context_unavailable",
        },
      };
    }

    if (a.capsRoster !== undefined) {
      const receipt = caps().reportWithReceipt(a.capsRoster, context);
      const capsCensus = {
        ...caps().censusStatus(context),
        receipt,
      };
      return { ...(res as Record<string, unknown>), capsCensus };
    }

    let capsCensus: CapsCensusStatus | (CapsCensusStatus & {
      status: "unavailable";
      reason: "caps_census_status_unavailable";
    });
    try {
      capsCensus = caps().censusStatus(context);
    } catch {
      capsCensus = {
        schema_version: CAPS_CENSUS_SCHEMA_VERSION,
        due: true,
        last_report_at: null,
        status: "unavailable",
        reason: "caps_census_status_unavailable",
      };
    }
    return { ...(res as Record<string, unknown>), capsCensus };
  })
);

server.registerTool(
  "bridge_claim",
  {
    title: "Claim file leases",
    description:
      "Acquire short-lived leases on files/dirs you're about to edit (e.g. [\"src/api\"]). Denied if they overlap a lease held by the other agent. The anti-clobber primitive — claim before you edit.",
    inputSchema: {
      paths: z.array(z.string()).describe("Files or directories to lease (globs like 'src/**' are normalized to 'src')"),
      note: z.string().optional().describe("Why you're claiming these"),
      ttlMinutes: z.number().optional().describe("Lease lifetime in minutes (default 120)"),
      ...projectArg,
    },
  },
  async (a) => run(() => core.claim(a))
);

server.registerTool(
  "bridge_release",
  {
    title: "Release file leases",
    description: "Release leases you hold. Omit `paths` to release all of yours. Do this when you finish editing.",
    inputSchema: { paths: z.array(z.string()).optional().describe("Specific paths to release; omit for all"), ...projectArg },
  },
  async (a) => run(() => core.release(a))
);

server.registerTool(
  "bridge_handoff",
  {
    title: "Hand off control",
    description: "Change the shared control token and record a note. This is coordination metadata only: it does NOT launch a peer, deliver a message, or execute work. Use bridge_a2a_send or bridge_task_dispatch for execution.",
    inputSchema: {
      to: z.string().optional().describe("'codex' or 'claude' (defaults to the other agent)"),
      note: z.string().optional().describe("Context for whoever picks it up"),
      ...projectArg,
    },
  },
  async (a) => run(() => core.handoff(a))
);

server.registerTool(
  "bridge_log",
  {
    title: "Log work to the journal + ledger",
    description: "Record a one-line summary of what you just did and which files you changed. Feeds the cross-project ledger and the other agent's freshness signal.",
    inputSchema: {
      summary: z.string().describe("One-line summary of the work"),
      files: z.array(z.string()).optional().describe("Files you changed (project-relative)"),
      ...projectArg,
    },
  },
  async (a) => run(() => core.log(a))
);

server.registerTool(
  "bridge_set_boss",
  {
    title: "Set the session boss",
    description:
      "Set who is boss for this project's collaboration session (the other agent becomes the direct report). The boss otherwise defaults to whoever sent the first command; this overrides it and can be called anytime.",
    inputSchema: { to: z.string().describe("'codex' or 'claude'"), ...projectArg },
  },
  async (a) => run(() => core.setBoss({ to: a.to, project: a.project }))
);

server.registerTool(
  "bridge_reap",
  {
    title: "Close out idle sessions",
    description:
      "Close any collaboration session idle longer than the threshold (default 60 min) across all registered projects, releasing its leases. Intended for a scheduled wrap-up agent.",
    inputSchema: { idleMinutes: z.number().optional().describe("Idle threshold in minutes (default 60)") },
  },
  async (a) => run(() => core.reap(a))
);

server.registerTool(
  "bridge_register_project",
  {
    title: "Register a project",
    description: "Add a project to the cross-project registry (git-inits it if needed, adds .connector/ to .gitignore).",
    inputSchema: {
      name: z.string().describe("Short project name (the registry key)"),
      path: z.string().describe("Absolute path to the project working tree"),
      remote: z.string().optional().describe("Optional git remote URL for backup/restore"),
    },
  },
  async (a) => run(() => core.registerProject(a))
);

server.registerTool(
  "bridge_list_projects",
  { title: "List registered projects", description: "Show every registered project with control holder, active leases, open tasks, and last-active host/agent." },
  async () => run(() => core.listProjects())
);

server.registerTool(
  "bridge_task_add",
  {
    title: "Add a board-only task",
    description: "Write a TODO row to the shared board only. No worker is launched and nothing is dispatched. Use bridge_task_dispatch to execute an existing row through A2A.",
    inputSchema: { title: z.string(), owner: z.string().optional(), ...projectArg },
  },
  async (a) => run(() => core.taskAdd(a))
);

server.registerTool(
  "bridge_task_update",
  {
    title: "Update a shared task",
    description: "Change a task's status or owner.",
    inputSchema: { id: z.string(), status: z.enum(["todo", "doing", "done"]).optional(), owner: z.string().optional(), ...projectArg },
  },
  async (a) => run(() => core.taskUpdate({ id: a.id, status: a.status, owner: a.owner, project: a.project }))
);

server.registerTool(
  "bridge_a2a_send",
  {
    title: "Execute a task through A2A",
    description: "Send one task to an Antigravity, Claude, or Codex subscription peer over Bridge's loopback A2A JSON-RPC channel. The call blocks for a terminal receipt; ok=true means state=completed with a durable result artifact, never merely queued.",
    inputSchema: {
      target: z.enum(["antigravity", "claude", "codex"]),
      prompt: z.string().min(1).max(16_000),
      idempotencyKey: z.string().min(1).max(300).describe("Stable retry key; reuse it only for the identical target and prompt"),
      model: z.string().min(1).max(120).optional().describe("Optional subscription CLI model identifier; omitted preserves the peer's existing default"),
      effort: z.enum(["low", "medium", "high", "xhigh", "max", "ultra"]).optional().describe("Optional reasoning effort; validated against the selected peer"),
      ...projectArg,
    },
  },
  async (a) => run(() => core.a2aSend(a))
);

server.registerTool(
  "bridge_a2a_get",
  {
    title: "Read an A2A task receipt",
    description: "Read the authoritative Bridge job state and durable output for an A2A task id.",
    inputSchema: { id: z.string().min(1), ...projectArg },
  },
  async (a) => run(() => core.a2aGet(a))
);

server.registerTool(
  "bridge_task_dispatch",
  {
    title: "Dispatch a board task through A2A",
    description: "Execute an existing shared-board row through A2A. The board row becomes done only after Bridge receives a terminal completed task and durable result artifact; a queue or process failure cannot close it.",
    inputSchema: {
      id: z.string().min(1),
      target: z.enum(["antigravity", "claude", "codex"]).optional().describe("Defaults from the task owner"),
      prompt: z.string().min(1).max(16_000).optional().describe("Defaults to the task title"),
      idempotencyKey: z.string().min(1).max(300).describe("Stable retry key; reuse it only for the identical task dispatch"),
      ...projectArg,
    },
  },
  async (a) => run(() => core.taskDispatch(a))
);

server.registerTool(
  "bridge_backup",
  {
    title: "Back up a project",
    description: "Write a git bundle to BRIDGE_HOME (Drive) and push to the remote if one is configured. Refuses a dirty tree (the bundle only captures committed work) unless `force` is set.",
    inputSchema: { force: z.boolean().optional().describe("Bundle even with uncommitted/untracked changes (they will NOT be captured)"), ...projectArg },
  },
  async (a) => run(() => core.backup(a))
);

server.registerTool(
  "bridge_restore",
  {
    title: "Restore a project",
    description: "Clone a project from its bundle (or remote) on another machine. Use an empty --dest or rely on the registry path.",
    inputSchema: { project: z.string().describe("Registered project name"), dest: z.string().optional().describe("Destination dir (empty); defaults to the registry path") },
  },
  async (a) => run(() => core.restore({ project: a.project, dest: a.dest }))
);

server.registerTool(
  "bridge_recent",
  { title: "Recent activity", description: "Read recent entries from the cross-project ledger (the who-touched-what feed).", inputSchema: { limit: z.number().optional(), ...projectArg } },
  async (a) => run(() => core.recent(a))
);

server.registerTool(
  "bridge_mailbox_send",
  {
    title: "Send a message to a ChatGPT or Antigravity mailbox",
    description:
      "Queue one immutable message for exactly one provider. This tool call is the audited, one-use dispatch approval; it does not grant broader browser authority.",
    inputSchema: {
      provider: z.enum(["chatgpt", "antigravity"]),
      prompt: z.string().min(1).max(1_048_576),
      idempotencyKey: z.string().min(8).max(300).describe("Stable retry key; reuse it only when retrying the same message"),
      approvalRef: z.string().min(3).max(180).optional().describe("Existing approval reference; direct tool-call approval is recorded when omitted"),
      priority: z.enum(["normal", "high"]).optional(),
      sensitivity: z.enum(["public", "internal"]).optional(),
      expiresAt: z.string().optional(),
      ...projectArg,
    },
  },
  async (a) => run(async () => mailbox().send({
    projectId: a.project ?? cfg.project ?? process.cwd(),
    provider: a.provider,
    prompt: a.prompt,
    idempotencyKey: a.idempotencyKey,
    approvalRef: a.approvalRef ?? `approval.direct-mcp.${crypto.randomUUID()}`,
    priority: a.priority,
    sensitivity: a.sensitivity,
    expiresAt: a.expiresAt,
    sender: {
      principalId: `principal.${normalizeMailboxId(cfg.agent)}`,
      sessionId: `session.${normalizeMailboxId(cfg.sessionId)}`,
      hostId: `host.${normalizeMailboxId(cfg.host)}`,
    },
  }))
);

server.registerTool(
  "bridge_mailbox_status",
  {
    title: "Read mailbox message status",
    description: "Returns authoritative delivery status and hashes without returning the prompt or response contents.",
    inputSchema: { messageId: z.string() },
  },
  async (a) => run(async () => mailbox().get(a.messageId) ?? { ok: false, error: "mailbox_message_not_found" })
);

server.registerTool(
  "bridge_web_node_send",
  {
    title: "Send a prompt through a browser WEB node",
    description:
      "Queue one immutable, one-use browser dispatch to a configured WEB node. The dedicated browser keeps its own OAuth/session state; Bridge saves the completed response as an immutable Drive exchange object and a readable Markdown file.",
    inputSchema: {
      nodeId: z.string().regex(/^[a-z0-9][a-z0-9-]{1,47}$/u),
      prompt: z.string().min(1).max(1_048_576),
      idempotencyKey: z.string().min(8).max(300).describe("Stable retry key; reuse it only when retrying the identical node and prompt"),
      approvalRef: z.string().min(3).max(180).optional().describe("Existing approval reference; direct tool-call approval is recorded when omitted"),
      priority: z.enum(["normal", "high"]).optional(),
      sensitivity: z.enum(["public", "internal"]).optional(),
      expiresAt: z.string().optional(),
      ...projectArg,
    },
  },
  async (a) => run(async () => mailbox().send({
    projectId: a.project ?? cfg.project ?? process.cwd(),
    provider: "web",
    webNodeId: a.nodeId,
    prompt: a.prompt,
    idempotencyKey: a.idempotencyKey,
    approvalRef: a.approvalRef ?? `approval.direct-mcp.${crypto.randomUUID()}`,
    priority: a.priority,
    sensitivity: a.sensitivity,
    expiresAt: a.expiresAt,
    sender: {
      principalId: `principal.${normalizeMailboxId(cfg.agent)}`,
      sessionId: `session.${normalizeMailboxId(cfg.sessionId)}`,
      hostId: `host.${normalizeMailboxId(cfg.host)}`,
    },
  })),
);

server.registerTool(
  "bridge_web_node_result",
  {
    title: "Read a WEB node result and Drive output path",
    description:
      "Returns the current delivery state. Once complete, it includes the captured response, source conversation URL, and readable Google Drive-synced Markdown path.",
    inputSchema: { messageId: z.string() },
  },
  async (a) => run(async () => mailbox().webNodeResult(a.messageId)),
);

server.registerTool(
  "bridge_web_node_list",
  {
    title: "List configured browser WEB nodes",
    description: "Lists reusable profile IDs, exact allowed origins, start URLs, and enabled state; it never exposes browser credentials or cookies.",
  },
  async () => run(async () => listWebNodeProfiles(mailbox().config)),
);

server.registerTool(
  "bridge_mailbox_list",
  {
    title: "List mailbox messages",
    description: "Lists provider delivery metadata without raw prompt or response contents.",
    inputSchema: {
      provider: z.enum(["chatgpt", "antigravity", "web"]).optional(),
      status: z.enum(["preparing", "queued", "claimed", "dispatching", "sent", "completed", "failed", "uncertain", "expired"]).optional(),
      limit: z.number().int().min(1).max(500).optional(),
    },
  },
  async (a) => run(async () => mailbox().list(a))
);

server.registerTool(
  "bridge_mailbox_doctor",
  {
    title: "Check mailbox health",
    description: "Verifies SQLite integrity, WAL mode, the event hash chain, provider configuration, and Drive exchange boundary.",
  },
  async () => run(async () => mailbox().doctor())
);

async function main() {
  const transport = new StdioServerTransport();
  await server.connect(transport);
  // stderr is safe for diagnostics; stdout is the MCP channel.
  const lane = currentLane();
  if (lane.warning) process.stderr.write(`[bridge] WARNING: ${lane.warning}\n`);
  process.stderr.write(`[bridge] connected as agent="${cfg.agent}" lane="${lane.lane}" host="${cfg.host}" home="${cfg.bridgeHome}"\n`);
}

main().catch((e) => {
  process.stderr.write(`[bridge] fatal: ${(e as Error).message}\n`);
  process.exit(1);
});

function normalizeMailboxId(value: string): string {
  const normalized = value.toLowerCase().replace(/[^a-z0-9._:-]+/gu, "-").replace(/^-|-$/gu, "");
  return normalized.length >= 3 ? normalized.slice(0, 160) : `id-${normalized || "unknown"}`;
}
