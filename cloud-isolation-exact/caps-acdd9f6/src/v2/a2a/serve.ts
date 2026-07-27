// A2A loopback server entrypoint (Phase A, D-026 — inbound goes live).
//
// Ties the pieces together: provision the peers (Task 2), publish the Agent
// Card, and route POST /a2a to a per-peer JobBackedA2ATaskBackend. A peer
// identifies itself with an `x-bridge-peer` header; the server maps that to the
// peer's provisioned principal and acts as it. Loopback only.

import { createServer, type Server } from "node:http";
import { invariant } from "../core/errors.js";
import type { PrincipalRef } from "../core/types.js";
import type { BridgeRuntime } from "../runtime.js";
import { buildCommandCenterAgentCard, COMMAND_CENTER_PEERS, type CommandCenterPeer } from "./agent-card.js";
import { A2AHttpBoundary, isLoopbackHost } from "./http.js";
import { provisionPeers } from "./peer-provisioning.js";
import { createSubscriptionProcessRunner } from "./process-runner.js";
import type { RunProcess } from "./peer-dispatch.js";
import { buildA2AHandler } from "./runtime-backend.js";

const DEFAULT_PORT = 4319;
const DEFAULT_HOST = "127.0.0.1";
const A2A_SERVER_INSTANCE_ID = "instance.bridge.a2a";
const PEER_HEADER = "x-bridge-peer";

export interface A2AServeContext {
  readonly projectId: string;
  /** Owner/administrator actor (from the serve context) that provisions peers. */
  readonly actor: PrincipalRef;
}

export interface A2AServeOptions {
  readonly port?: number;
  readonly host?: string;
  readonly version?: string;
  readonly allowedOrigins?: readonly string[];
  /** Working tree delegated subscription CLIs operate on. */
  readonly projectPath?: string;
  /** Test seam; production defaults to the shell-free subscription runner. */
  readonly runProcess?: RunProcess;
}

export interface RunningA2AServer {
  readonly port: number;
  readonly url: string;
  close(): Promise<void>;
}

/** Provision peers, publish the Agent Card, and start the loopback A2A server. */
export async function runA2AServer(
  runtime: BridgeRuntime,
  context: A2AServeContext,
  options: A2AServeOptions = {},
): Promise<RunningA2AServer> {
  const host = options.host ?? DEFAULT_HOST;
  // Refuse before listen(): this API is exported, so the loopback boundary must
  // live here and not only in the CLI's fixed host.
  invariant(isLoopbackHost(host), "a2a_serve_requires_loopback_host");
  const requestedPort = options.port ?? DEFAULT_PORT;
  const version = options.version ?? "0.1.0-draft.4";

  const peerActors = provisionPeers(runtime, {
    projectId: context.projectId,
    owner: context.actor,
    hostId: context.actor.hostId,
    serverInstanceId: A2A_SERVER_INSTANCE_ID,
  });
  const runProcess = options.runProcess ?? createSubscriptionProcessRunner({
    cwd: options.projectPath ?? process.cwd(),
  });

  // Assigned after bind so the Agent Card can advertise the actual port (an
  // ephemeral port 0 is resolved only once listening). Requests before the
  // boundary is ready get a 503.
  let boundary: A2AHttpBoundary | undefined;
  const server: Server = createServer((request, response) => {
    if (!boundary) {
      response.writeHead(503, { "content-type": "application/json" });
      response.end(JSON.stringify({ error: "starting" }));
      return;
    }
    boundary
      .handle(request, response)
      .then((handled) => {
        if (!handled && !response.headersSent) {
          response.writeHead(404, { "content-type": "application/json" });
          response.end(JSON.stringify({ error: "not_found" }));
        }
      })
      .catch(() => {
        if (!response.headersSent) {
          response.writeHead(500, { "content-type": "application/json" });
          response.end(JSON.stringify({ error: "internal_error" }));
        }
      });
  });

  await new Promise<void>((resolve) => server.listen(requestedPort, host, resolve));
  const port = addressPort(server, requestedPort);
  const url = `http://${host}:${port}/`;

  boundary = new A2AHttpBoundary({
    agentCard: buildCommandCenterAgentCard({ url, version, peers: COMMAND_CENTER_PEERS }),
    bindHost: host,
    allowedOrigins: options.allowedOrigins ?? [`http://${host}:${port}`, `http://localhost:${port}`],
    resolve: async (request) => {
      const raw = request.headers[PEER_HEADER];
      const peer = (Array.isArray(raw) ? raw[0] : raw)?.toLowerCase();
      if (!peer || !isCommandCenterPeer(peer)) return null;
      const actor = peerActors.get(peer);
      if (!actor) return null;
      return {
        handler: buildA2AHandler(
          runtime,
          { projectId: context.projectId, actor },
          { owner: context.actor, peerActors, runProcess },
        ),
        caller: { peer, principalId: actor.principalId },
      };
    },
  });

  return {
    port,
    url,
    close: () => new Promise<void>((resolve) => server.close(() => resolve())),
  };
}

function isCommandCenterPeer(value: string): value is CommandCenterPeer {
  return (COMMAND_CENTER_PEERS as readonly string[]).includes(value);
}

function addressPort(server: Server, fallback: number): number {
  const address = server.address();
  return address && typeof address === "object" ? address.port : fallback;
}
