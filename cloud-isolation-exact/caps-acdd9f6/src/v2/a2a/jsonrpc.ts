// Minimal JSON-RPC 2.0 framing for the A2A endpoint (Phase A, D-026).
//
// Transport-agnostic request/response shapes plus the error codes A2A uses.
// No IO and no clock: pure parse/validate/build helpers, so the request handler
// and its tests construct and inspect envelopes deterministically.
//
// SPEC NOTE: the A2A-specific error codes (-32001..-32006) follow the published
// A2A spec; verify against the version pinned in `A2A_PROTOCOL_VERSION`
// (see agent-card.ts) before release.

export type JsonRpcId = string | number | null;

export interface JsonRpcRequest {
  readonly jsonrpc: "2.0";
  readonly id: JsonRpcId;
  readonly method: string;
  readonly params?: unknown;
}

export interface JsonRpcError {
  readonly code: number;
  readonly message: string;
  readonly data?: unknown;
}

export interface JsonRpcSuccessResponse {
  readonly jsonrpc: "2.0";
  readonly id: JsonRpcId;
  readonly result: unknown;
}

export interface JsonRpcErrorResponse {
  readonly jsonrpc: "2.0";
  readonly id: JsonRpcId;
  readonly error: JsonRpcError;
}

export type JsonRpcResponse = JsonRpcSuccessResponse | JsonRpcErrorResponse;

// Standard JSON-RPC 2.0 codes.
export const JSONRPC_PARSE_ERROR = -32700;
export const JSONRPC_INVALID_REQUEST = -32600;
export const JSONRPC_METHOD_NOT_FOUND = -32601;
export const JSONRPC_INVALID_PARAMS = -32602;
export const JSONRPC_INTERNAL_ERROR = -32603;

// A2A-specific codes (verify against spec before release).
export const A2A_TASK_NOT_FOUND = -32001;
export const A2A_TASK_NOT_CANCELABLE = -32002;
export const A2A_PUSH_NOTIFICATION_NOT_SUPPORTED = -32003;
export const A2A_UNSUPPORTED_OPERATION = -32004;
export const A2A_CONTENT_TYPE_NOT_SUPPORTED = -32005;
export const A2A_INVALID_AGENT_RESPONSE = -32006;

export function successResponse(id: JsonRpcId, result: unknown): JsonRpcSuccessResponse {
  return { jsonrpc: "2.0", id, result };
}

export function errorResponse(id: JsonRpcId, code: number, message: string, data?: unknown): JsonRpcErrorResponse {
  return { jsonrpc: "2.0", id, error: data === undefined ? { code, message } : { code, message, data } };
}

export type ParseResult =
  | { readonly ok: true; readonly request: JsonRpcRequest }
  | { readonly ok: false; readonly id: JsonRpcId; readonly error: JsonRpcError };

/**
 * Validate the JSON-RPC 2.0 envelope framing of an already-parsed value.
 * Returns the typed request, or a JsonRpcError describing why it is invalid.
 * Method-specific params are validated by the handler, not here.
 *
 * Batch requests (arrays) are rejected: A2A's core methods are all unary, so we
 * do not support JSON-RPC batching in Phase A.
 */
export function parseJsonRpcRequest(value: unknown): ParseResult {
  if (typeof value !== "object" || value === null || Array.isArray(value)) {
    return { ok: false, id: null, error: { code: JSONRPC_INVALID_REQUEST, message: "invalid_request" } };
  }
  const obj = value as Record<string, unknown>;
  // A malformed id cannot be echoed, so responses to it carry id: null per spec.
  if ("id" in obj && !isValidId(obj.id)) {
    return { ok: false, id: null, error: { code: JSONRPC_INVALID_REQUEST, message: "invalid_id" } };
  }
  const id: JsonRpcId = isValidId(obj.id) ? (obj.id as JsonRpcId) : null;
  if (obj.jsonrpc !== "2.0") {
    return { ok: false, id, error: { code: JSONRPC_INVALID_REQUEST, message: "jsonrpc_version_required" } };
  }
  if (typeof obj.method !== "string" || obj.method.length === 0) {
    return { ok: false, id, error: { code: JSONRPC_INVALID_REQUEST, message: "method_required" } };
  }
  return { ok: true, request: { jsonrpc: "2.0", id, method: obj.method, params: obj.params } };
}

function isValidId(value: unknown): boolean {
  return typeof value === "string" || (typeof value === "number" && Number.isSafeInteger(value)) || value === null;
}
