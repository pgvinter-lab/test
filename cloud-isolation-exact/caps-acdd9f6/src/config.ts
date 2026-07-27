import os from "node:os";
import fs from "node:fs";
import path from "node:path";

export interface BridgeConfig {
  /** Which system this server instance represents: "codex" | "claude" | "unknown". */
  agent: string;
  /** Machine hostname — used for the "last active on host X" cross-machine warning. */
  host: string;
  /** Stable id for this server process = one chat window. Used for per-session freshness. */
  sessionId: string;
  /** Where registry.json, ledger.jsonl and backups/ live (ideally a Drive-synced folder). */
  bridgeHome: string;
  /** Explicit default project (name or absolute path) from $BRIDGE_PROJECT, so a stdio
   *  server pinned by the wiring does not fall back to the host tool's cwd (review H4). */
  project?: string;
}

/**
 * Resolve BRIDGE_HOME:
 *   1. explicit env BRIDGE_HOME
 *   2. Google Drive folder, if "G:\My Drive" is mounted
 *   3. local fallback under the user profile (works fully offline / before Drive sign-in)
 */
function resolveBridgeHome(): string {
  const env = process.env.BRIDGE_HOME?.trim();
  if (env) return path.resolve(env);
  const driveRoot = "G:\\My Drive";
  try {
    if (fs.existsSync(driveRoot)) return path.join(driveRoot, "codex-claude-bridge");
  } catch { /* not mounted */ }
  return path.join(os.homedir(), ".codex-claude-bridge");
}

let cached: BridgeConfig | null = null;

export function getConfig(): BridgeConfig {
  if (cached) return cached;
  const agent = (process.env.BRIDGE_AGENT || "unknown").toLowerCase();
  const host = os.hostname();
  // A long-lived MCP server (one per chat window) sets BRIDGE_SESSION to a unique
  // per-process id for per-window freshness. The CLI leaves it unset and shares a
  // stable per-agent session so freshness persists across one-shot CLI invocations.
  const explicit = process.env.BRIDGE_SESSION?.trim();
  cached = {
    agent,
    host,
    sessionId: explicit && explicit.length > 0 ? explicit : `${agent}:${host}`,
    bridgeHome: resolveBridgeHome(),
    project: process.env.BRIDGE_PROJECT?.trim() || undefined,
  };
  return cached;
}

/** The agent that is NOT us — useful as the default handoff target. */
export function otherAgent(): string {
  const a = getConfig().agent;
  if (a === "codex") return "claude";
  if (a === "claude") return "codex";
  return "other";
}
