// Outbound A2A JSON-RPC client (Phase B, D-026): delegate a task to a peer's
// loopback Agent Card endpoint and read task state back.
//
// The transport (`fetchJson`) is injected, so this is unit-testable with no
// network AND it honors the no-API-key invariant: the injected transport must
// reach a subscription-authenticated surface (a peer's local loopback A2A
// endpoint), never a keyed/metered API. This client never constructs auth
// headers or credentials of its own.

import { BridgeRuntimeError, invariant } from "../core/errors.js";
import type { JsonRpcResponse } from "./jsonrpc.js";
import { A2A_METHODS, type A2ATask, type MessageSendParams, type TaskQueryParams } from "./types.js";

export type A2AFetchJson = (url: string, body: unknown) => Promise<unknown>;

export interface A2AClientOptions {
  /** Peer JSON-RPC endpoint URL (loopback). */
  readonly endpoint: string;
  /** Injected transport; MUST reach a subscription-authenticated surface, never a keyed API. */
  readonly fetchJson: A2AFetchJson;
}

/** True only for a peer endpoint on the local machine. */
export function isLoopbackEndpoint(endpoint: string): boolean {
  let url: URL;
  try {
    url = new URL(endpoint);
  } catch {
    return false;
  }
  const host = url.hostname.toLowerCase();
  return host === "127.0.0.1" || host === "::1" || host === "[::1]" || host === "localhost";
}

export class A2AClient {
  private nextId = 0;

  constructor(private readonly options: A2AClientOptions) {
    // ENFORCED, not merely documented (independent review, F6): the D-026
    // invariant says outbound A2A speaks only to a peer's LOCAL,
    // subscription-bound endpoint. A non-loopback endpoint would be a network
    // egress path this client must never create, so refuse to construct one.
    invariant(isLoopbackEndpoint(options.endpoint), "a2a_client_requires_loopback_endpoint", {
      endpoint: options.endpoint,
    });
  }

  /** message/send — delegate a task to the peer. */
  async send(params: MessageSendParams): Promise<A2ATask> {
    return this.call(A2A_METHODS.messageSend, params);
  }

  /** tasks/get — read a delegated task's current state. */
  async getTask(params: TaskQueryParams): Promise<A2ATask> {
    return this.call(A2A_METHODS.tasksGet, params);
  }

  private async call(method: string, params: unknown): Promise<A2ATask> {
    this.nextId += 1;
    const request = { jsonrpc: "2.0", id: this.nextId, method, params };
    const raw = await this.options.fetchJson(this.options.endpoint, request);
    if (raw === null || typeof raw !== "object") {
      throw new BridgeRuntimeError("a2a_client_invalid_response");
    }
    const response = raw as JsonRpcResponse;
    if ("error" in response && response.error) {
      throw new BridgeRuntimeError("a2a_client_rpc_error", {
        code: response.error.code,
        message: response.error.message,
      });
    }
    if ("result" in response) {
      return response.result as A2ATask;
    }
    throw new BridgeRuntimeError("a2a_client_missing_result");
  }
}
