import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const MARKER_START = "<!-- BRIDGE-PROTOCOL:START -->";
const MARKER_END = "<!-- BRIDGE-PROTOCOL:END -->";

/** The shared etiquette both agents follow. Embedded in CLAUDE.md and AGENTS.md. */
export function protocolSection(): string {
  return `${MARKER_START}
## Codex ↔ Claude Bridge protocol

This project is shared between **Codex** and **Claude** through the \`bridge\` MCP server. Follow this
etiquette so you never clobber the other agent's work or lose track of who changed what:

1. **Start of every turn** — call \`bridge_sync\`. It tells you who holds control, which files the
   other agent has leased, the open task list, and **which files changed since you last synced**.
   Re-read any listed files before you reason about or edit them (your cached copy is stale).
2. **Before editing** — call \`bridge_claim\` with the files or directories you're about to touch
   (e.g. \`["src/api"]\`). If it's denied, the other agent holds an overlapping lease — pick other
   files or hand off.
3. **After a unit of work** — call \`bridge_log\` with a one-line summary and the files you changed,
   then \`bridge_release\` the paths you claimed.
4. **To pass work over** — call \`bridge_handoff\` with \`to\` = \`codex\` or \`claude\` and a short note.
5. \`.connector/\` holds bridge-managed state — never edit it by hand.

If the \`bridge\` MCP tools aren't available, the same operations exist as the \`bridge\` CLI
(\`bridge sync\`, \`bridge claim <paths...>\`, \`bridge log\`, etc.).
${MARKER_END}`;
}

/** Insert or replace the protocol section in a doc file (CLAUDE.md / AGENTS.md). Idempotent. */
export function writeProtocolDoc(filePath: string): "created" | "updated" {
  const section = protocolSection();
  let content = "";
  try { content = fs.readFileSync(filePath, "utf8"); } catch { /* none yet */ }
  if (content.includes(MARKER_START) && content.includes(MARKER_END)) {
    const re = new RegExp(`${MARKER_START}[\\s\\S]*?${MARKER_END}`);
    fs.writeFileSync(filePath, content.replace(re, section), "utf8");
    return "updated";
  }
  const sep = content && !content.endsWith("\n") ? "\n\n" : content ? "\n" : "";
  fs.writeFileSync(filePath, content + sep + section + "\n", "utf8");
  return content ? "updated" : "created";
}

/** `.mcp.json` snippet wiring the bridge into Claude Code for a project.
 *  Pins BRIDGE_PROJECT (review H4) so the server coordinates on THIS project rather
 *  than whatever cwd the host tool happens to launch it from. */
export function claudeMcpSnippet(serverJsPath: string, projectName?: string): string {
  const args = JSON.stringify([serverJsPath]);
  const env = projectName
    ? `{ "BRIDGE_AGENT": "claude", "BRIDGE_PROJECT": ${JSON.stringify(projectName)} }`
    : `{ "BRIDGE_AGENT": "claude" }`;
  return `{
  "mcpServers": {
    "bridge": {
      "type": "stdio",
      "command": "node",
      "args": ${args},
      "env": ${env}
    }
  }
}`;
}

/** `config.toml` snippet wiring the bridge into Codex CLI. Pins BRIDGE_PROJECT (H4). */
export function codexTomlSnippet(serverJsPath: string, projectName?: string): string {
  const argsToml = `["${serverJsPath.replace(/\\/g, "\\\\")}"]`;
  const env = projectName
    ? `{ BRIDGE_AGENT = "codex", BRIDGE_PROJECT = ${JSON.stringify(projectName)} }`
    : `{ BRIDGE_AGENT = "codex" }`;
  return `[mcp_servers.bridge]
command = "node"
args = ${argsToml}
env = ${env}`;
}

/** Absolute path to the compiled server entrypoint (dist/server.js, next to this module). */
export function serverEntrypoint(): string {
  return path.join(path.dirname(fileURLToPath(import.meta.url)), "server.js");
}
