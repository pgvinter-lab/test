// A2A (Agent2Agent) Agent Card for the Bridge command center.
//
// Bridge exposes itself as a single A2A agent whose skills
// are its peer agents (Antigravity, Claude, Codex) plus command-center
// operations. Served over a dedicated loopback JSON-RPC endpoint with the v0.3
// well-known Agent Card path.
//
// SPEC NOTE: field names follow the A2A Agent Card shape; verify against the
// published A2A spec version pinned in `A2A_PROTOCOL_VERSION` before release —
// the protocol is young and names may shift.

export const A2A_PROTOCOL_VERSION = "0.3.0" as const;

export interface A2AAgentSkill {
  readonly id: string;
  readonly name: string;
  readonly description: string;
  readonly tags: readonly string[];
  readonly examples?: readonly string[];
  readonly inputModes?: readonly string[];
  readonly outputModes?: readonly string[];
}

export interface A2AAgentCard {
  readonly protocolVersion: string;
  readonly name: string;
  readonly description: string;
  readonly url: string;
  readonly preferredTransport: "JSONRPC";
  readonly additionalInterfaces: readonly {
    readonly url: string;
    readonly transport: "JSONRPC";
  }[];
  readonly version: string;
  readonly provider: { readonly organization: string; readonly url?: string };
  readonly capabilities: {
    readonly streaming: boolean;
    readonly pushNotifications: boolean;
    readonly stateTransitionHistory: boolean;
  };
  readonly defaultInputModes: readonly string[];
  readonly defaultOutputModes: readonly string[];
  readonly skills: readonly A2AAgentSkill[];
  // The loopback peer selector is declared explicitly so a future networked
  // deployment cannot silently inherit this local trust boundary as real auth.
  readonly securitySchemes: Record<string, {
    readonly type: "apiKey";
    readonly in: "header";
    readonly name: string;
    readonly description: string;
  }>;
  readonly security: readonly Record<string, readonly string[]>[];
}

/**
 * Canonical command-center peers (symmetric A2A participants; D-026).
 *
 * Antigravity is the Google peer — NOT Gemini. The Gemini CLI is retired for
 * individual accounts (it errors with "migrate to the Antigravity suite"), so a
 * separate `gemini` peer would be both redundant and dead on arrival.
 */
export const COMMAND_CENTER_PEERS = ["antigravity", "claude", "codex"] as const;
export type CommandCenterPeer = (typeof COMMAND_CENTER_PEERS)[number];

export interface AgentCardOptions {
  /** Loopback A2A service URL, e.g. `http://127.0.0.1:4319/`. Must be a loopback host. */
  readonly url: string;
  /** Bridge version string. */
  readonly version: string;
  /** Peers to advertise as delegable skills; defaults to all command-center peers. */
  readonly peers?: readonly CommandCenterPeer[];
}

function peerSkill(peer: CommandCenterPeer): A2AAgentSkill {
  return {
    id: `delegate.${peer}`,
    name: `Delegate to ${peer}`,
    description: `Delegate a task to the ${peer} agent via the Bridge command center. The task is created as an audited Bridge job and routed to ${peer}; results are returned as A2A artifacts.`,
    tags: ["peer", "delegate", peer],
    inputModes: ["text/plain", "application/json"],
    outputModes: ["text/plain", "application/json"],
  };
}

/**
 * Build the command-center Agent Card. Pure and deterministic (no clock / no IO)
 * so it is safe to snapshot in tests and serve from the loopback transport.
 */
export function buildCommandCenterAgentCard(options: AgentCardOptions): A2AAgentCard {
  const host = new URL(options.url).hostname.toLowerCase();
  const loopback =
    host === "127.0.0.1" || host === "::1" || host === "localhost" || host === "[::1]";
  if (!loopback) {
    // Phase A is loopback-only per D-026; refuse to advertise a non-loopback URL.
    throw new Error("a2a_agent_card_requires_loopback_url");
  }
  const peers = options.peers ?? COMMAND_CENTER_PEERS;
  return {
    protocolVersion: A2A_PROTOCOL_VERSION,
    name: "Bridge Command Center",
    description:
      "Local-first multi-agent coordination control plane. Exposes its peer agents (Antigravity, Claude, Codex) as A2A-delegable skills. Loopback-only; every delegated task is an audited Bridge job.",
    url: new URL("a2a", options.url).href,
    preferredTransport: "JSONRPC",
    additionalInterfaces: [{ url: new URL("a2a", options.url).href, transport: "JSONRPC" }],
    version: options.version,
    provider: { organization: "Bridge (local)" },
    capabilities: {
      streaming: false,
      pushNotifications: false, // Phase A: no push config
      stateTransitionHistory: false,
    },
    defaultInputModes: ["text/plain", "application/json"],
    defaultOutputModes: ["text/plain", "application/json"],
    skills: peers.map(peerSkill),
    securitySchemes: {
      bridgePeer: {
        type: "apiKey",
        in: "header",
        name: "x-bridge-peer",
        description: "Loopback Bridge peer identity (antigravity, claude, or codex).",
      },
    },
    security: [{ bridgePeer: [] }],
  };
}
