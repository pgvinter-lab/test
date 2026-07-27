import type { IncomingMessage, ServerResponse } from "node:http";
import { StreamableHTTPServerTransport } from "@modelcontextprotocol/sdk/server/streamableHttp.js";
import { canonicalEqual } from "../core/canonical.js";
import { invariant } from "../core/errors.js";
import type { PrincipalRef } from "../core/types.js";
import type { BridgeRuntime } from "../runtime.js";
import { createRuntimeMcpServer } from "./mcp-server.js";

export interface HttpAuthentication {
  projectId: string;
  actor: PrincipalRef;
  transportSessionId: string;
  serverInstanceId: string;
}

export interface StreamableHttpBoundaryOptions {
  enabled?: boolean;
  bindHost?: string;
  tls?: boolean;
  remoteAuthenticationApproved?: boolean;
  allowedOrigins: string[];
  maxRequestBytes?: number;
  authenticate: (request: IncomingMessage) => Promise<HttpAuthentication>;
  adminEnabled?: boolean;
}

interface ActiveHttpSession {
  authentication: HttpAuthentication;
  transport: StreamableHTTPServerTransport;
  server: ReturnType<typeof createRuntimeMcpServer>;
}

export class StreamableHttpBoundary {
  private readonly enabled: boolean;
  private readonly bindHost: string;
  private readonly maxRequestBytes: number;
  private readonly sessions = new Map<string, ActiveHttpSession>();

  constructor(
    private readonly runtime: BridgeRuntime,
    private readonly options: StreamableHttpBoundaryOptions,
  ) {
    this.enabled = options.enabled ?? false;
    this.bindHost = options.bindHost ?? "127.0.0.1";
    this.maxRequestBytes = options.maxRequestBytes ?? 1_048_576;
    invariant(options.allowedOrigins.length > 0, "http_origin_allowlist_required");
    if (!isLoopback(this.bindHost)) {
      invariant(options.tls === true && options.remoteAuthenticationApproved === true, "remote_http_policy_not_approved");
    }
  }

  get listenHost(): string {
    return this.bindHost;
  }

  async handle(request: IncomingMessage, response: ServerResponse): Promise<void> {
    if (!this.enabled) return jsonError(response, 404, "streamable_http_disabled");
    const localAddress = request.socket.localAddress;
    if (isLoopback(this.bindHost)) {
      if (!localAddress || !isLoopbackAddress(localAddress)) return jsonError(response, 403, "http_bind_boundary_mismatch");
    } else {
      const encrypted = "encrypted" in request.socket && request.socket.encrypted === true;
      if (!encrypted) return jsonError(response, 426, "tls_required");
    }
    const origin = singleHeader(request.headers.origin);
    if (!origin || !this.options.allowedOrigins.includes(origin)) return jsonError(response, 403, "origin_not_allowed");
    if (!["POST", "GET", "DELETE"].includes(request.method ?? "")) return jsonError(response, 405, "method_not_allowed");
    if (request.method === "POST") {
      const contentLength = Number(singleHeader(request.headers["content-length"]));
      if (!Number.isSafeInteger(contentLength) || contentLength < 0 || contentLength > this.maxRequestBytes) {
        return jsonError(response, 413, "request_size_not_allowed");
      }
    }
    let authentication: HttpAuthentication;
    try {
      authentication = await this.options.authenticate(request);
    } catch {
      return jsonError(response, 401, "authentication_required");
    }
    const suppliedSessionId = singleHeader(request.headers["mcp-session-id"]);
    let active = suppliedSessionId ? this.sessions.get(suppliedSessionId) : undefined;
    if (suppliedSessionId && !active) return jsonError(response, 404, "mcp_session_not_found");
    if (active) {
      if (!sameAuthentication(active.authentication, authentication)) return jsonError(response, 403, "mcp_session_identity_mismatch");
    } else {
      if (request.method !== "POST") return jsonError(response, 400, "mcp_initialization_requires_post");
      let server: ReturnType<typeof createRuntimeMcpServer>;
      try {
        server = createRuntimeMcpServer(this.runtime, {
        projectId: authentication.projectId,
        actor: authentication.actor,
        transport: {
          transport: "streamable_http",
          transportSessionId: authentication.transportSessionId,
          serverInstanceId: authentication.serverInstanceId,
        },
        adminEnabled: this.options.adminEnabled,
        });
      } catch {
        return jsonError(response, 403, "identity_or_profile_not_authorized");
      }
      let transport!: StreamableHTTPServerTransport;
      transport = new StreamableHTTPServerTransport({
        sessionIdGenerator: () => authentication.transportSessionId,
        onsessioninitialized: (sessionId): void => {
          this.sessions.set(sessionId, { authentication, transport, server });
        },
      });
      transport.onclose = () => {
        if (transport.sessionId) this.sessions.delete(transport.sessionId);
      };
      await server.connect(transport);
      active = { authentication, transport, server };
    }
    await active.transport.handleRequest(request, response);
    if (request.method === "DELETE" && active.transport.sessionId) {
      this.sessions.delete(active.transport.sessionId);
      await active.transport.close();
      await active.server.close();
    }
  }

  async close(): Promise<void> {
    const active = [...this.sessions.values()];
    this.sessions.clear();
    await Promise.all(active.flatMap((session) => [session.transport.close(), session.server.close()]));
  }
}

function sameAuthentication(left: HttpAuthentication, right: HttpAuthentication): boolean {
  return left.projectId === right.projectId &&
    left.transportSessionId === right.transportSessionId &&
    left.serverInstanceId === right.serverInstanceId &&
    canonicalEqual(left.actor, right.actor);
}

function isLoopback(host: string): boolean {
  return host === "127.0.0.1" || host === "::1" || host.toLowerCase() === "localhost";
}

function isLoopbackAddress(address: string): boolean {
  const normalized = address.toLowerCase();
  return normalized === "127.0.0.1" || normalized === "::1" || normalized === "::ffff:127.0.0.1";
}

function singleHeader(value: string | string[] | undefined): string | undefined {
  return Array.isArray(value) ? value[0] : value;
}

function jsonError(response: ServerResponse, status: number, code: string): void {
  response.writeHead(status, { "content-type": "application/json" });
  response.end(JSON.stringify({ jsonrpc: "2.0", error: { code: -32000, message: code }, id: null }));
}
