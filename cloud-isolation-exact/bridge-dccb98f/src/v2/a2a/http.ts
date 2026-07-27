// Loopback HTTP boundary for the inbound A2A endpoint (Phase A, D-026).
//
// A dedicated 127.0.0.1-only listener that serves the Agent Card and the A2A
// JSON-RPC endpoint. It deliberately does NOT modify the MCP streamable-http
// transport: an additive feature should not touch that security-critical path.
// Same security envelope (loopback only, origin allowlist, request-size cap);
// co-hosting on the MCP port is a later optimization, not required here.
//
// Routes:
//   GET  /.well-known/agent-card.json -> the v0.3 Agent Card (loopback-guarded)
//   POST /a2a                     -> JSON-RPC 2.0 (message/send, tasks/get, tasks/cancel)
//
// JSON-RPC replies are returned as HTTP 200 with the error, if any, in the body
// (JSON-RPC convention). Transport-level failures (bad origin, oversize, no
// auth) use non-200 HTTP status codes.

import type { IncomingMessage, ServerResponse } from "node:http";
import { invariant } from "../core/errors.js";
import type { A2AAgentCard } from "./agent-card.js";
import type { A2ACaller, A2ARequestHandler } from "./handler.js";
import { errorResponse, JSONRPC_PARSE_ERROR } from "./jsonrpc.js";

export const AGENT_CARD_PATH = "/.well-known/agent-card.json";
export const A2A_RPC_PATH = "/a2a";

/** A request authenticated to a peer identity plus the handler bound to it. */
export interface A2AResolved {
  readonly handler: A2ARequestHandler;
  readonly caller: A2ACaller;
}

export interface A2AHttpBoundaryOptions {
  /** Pre-built Agent Card (pure; see buildCommandCenterAgentCard). */
  readonly agentCard: A2AAgentCard;
  /** Allowed browser origins; a request whose Origin header is not listed is refused. */
  readonly allowedOrigins: readonly string[];
  /** Bind host; loopback is enforced by the socket guard when set to a loopback host. */
  readonly bindHost?: string;
  /** Maximum request body size in bytes (default 1 MiB). */
  readonly maxRequestBytes?: number;
  /** Authenticate a request to a peer identity + handler, or null to refuse (401). */
  readonly resolve: (request: IncomingMessage) => Promise<A2AResolved | null>;
}

export class A2AHttpBoundary {
  private readonly bindHost: string;
  private readonly maxRequestBytes: number;

  constructor(private readonly options: A2AHttpBoundaryOptions) {
    invariant(options.allowedOrigins.length > 0, "a2a_http_origin_allowlist_required");
    this.bindHost = options.bindHost ?? "127.0.0.1";
    // Loopback is an INVARIANT, not a default. Previously the socket guard below
    // was only applied when bindHost already looked like loopback, so passing
    // `0.0.0.0` both exposed the listener AND disabled the guard. Refuse to
    // construct a boundary that could serve a non-loopback interface.
    invariant(isLoopbackHost(this.bindHost), "a2a_http_requires_loopback_bind_host");
    this.maxRequestBytes = options.maxRequestBytes ?? 1_048_576;
  }

  /**
   * Handle a request. Returns true if this boundary owns the path (and has
   * written a response), false to let another handler try (non-A2A paths).
   */
  async handle(request: IncomingMessage, response: ServerResponse): Promise<boolean> {
    const path = (request.url ?? "").split("?", 1)[0];
    if (path !== AGENT_CARD_PATH && path !== A2A_RPC_PATH) return false;

    // Loopback bind guard: refuse a connection that did not arrive on a loopback
    // local address. Unconditional — the constructor guarantees bindHost is
    // loopback, so this can never be silently skipped.
    const local = request.socket.localAddress;
    if (!local || !isLoopbackAddress(local)) {
      httpError(response, 403, "a2a_bind_boundary_mismatch");
      return true;
    }

    // Origin allowlist: enforce only when an Origin header is present. Non-browser
    // A2A clients omit it; a browser page must match an allowed origin.
    const origin = singleHeader(request.headers.origin);
    if (origin !== undefined && !this.options.allowedOrigins.includes(origin)) {
      httpError(response, 403, "origin_not_allowed");
      return true;
    }

    if (path === AGENT_CARD_PATH) {
      if (request.method !== "GET") {
        httpError(response, 405, "method_not_allowed");
        return true;
      }
      writeJson(response, 200, this.options.agentCard);
      return true;
    }

    // A2A_RPC_PATH
    if (request.method !== "POST") {
      httpError(response, 405, "method_not_allowed");
      return true;
    }
    const declaredLength = Number(singleHeader(request.headers["content-length"]));
    if (Number.isFinite(declaredLength) && declaredLength > this.maxRequestBytes) {
      httpError(response, 413, "request_size_not_allowed");
      return true;
    }

    let resolved: A2AResolved | null;
    try {
      resolved = await this.options.resolve(request);
    } catch {
      httpError(response, 401, "authentication_required");
      return true;
    }
    if (!resolved) {
      httpError(response, 401, "authentication_required");
      return true;
    }

    let raw: string;
    try {
      raw = await readBody(request, this.maxRequestBytes);
    } catch {
      httpError(response, 413, "request_size_not_allowed");
      return true;
    }

    let parsed: unknown;
    try {
      parsed = JSON.parse(raw);
    } catch {
      // Malformed JSON: a JSON-RPC parse error with a null id, HTTP 200.
      writeJson(response, 200, errorResponse(null, JSONRPC_PARSE_ERROR, "parse_error"));
      return true;
    }

    const rpcResponse = await resolved.handler.handle(parsed, resolved.caller);
    writeJson(response, 200, rpcResponse);
    return true;
  }
}

// ---- HTTP helpers (kept local so the MCP transport file stays untouched) ----

/** True only for loopback bind hosts. Exported so the serve entrypoint enforces
 *  the same rule before it ever calls listen(). */
export function isLoopbackHost(host: string): boolean {
  return host === "127.0.0.1" || host === "::1" || host.toLowerCase() === "localhost";
}

function isLoopbackAddress(address: string): boolean {
  const normalized = address.toLowerCase();
  return normalized === "127.0.0.1" || normalized === "::1" || normalized === "::ffff:127.0.0.1";
}

function singleHeader(value: string | string[] | undefined): string | undefined {
  return Array.isArray(value) ? value[0] : value;
}

function writeJson(response: ServerResponse, status: number, body: unknown): void {
  const payload = JSON.stringify(body);
  response.writeHead(status, { "content-type": "application/json" });
  response.end(payload);
}

function httpError(response: ServerResponse, status: number, code: string): void {
  writeJson(response, status, { error: code });
}

async function readBody(request: IncomingMessage, maxBytes: number): Promise<string> {
  const chunks: Buffer[] = [];
  let size = 0;
  for await (const chunk of request) {
    const buffer = chunk as Buffer;
    size += buffer.length;
    if (size > maxBytes) throw new Error("request_too_large");
    chunks.push(buffer);
  }
  return Buffer.concat(chunks).toString("utf8");
}
