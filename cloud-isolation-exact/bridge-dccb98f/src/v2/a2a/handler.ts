// A2A JSON-RPC request handler for the Bridge command center (Phase A, D-026).
//
// Owns protocol concerns only: method routing, params validation, and mapping
// Bridge runtime error codes onto JSON-RPC error objects. All task IO happens
// behind the injected A2ATaskBackend port, so this class has no clock, storage,
// identity, or transport dependency and is unit-testable with a fake backend.
//
// Streaming (message/stream, SSE) is a known method but its transport framing is
// deferred to the streamable-http wiring slice; over this unary entrypoint it is
// answered with an "unsupported over this endpoint" error rather than silently.

import { asErrorCode } from "../core/errors.js";
import {
  A2A_TASK_NOT_CANCELABLE,
  A2A_TASK_NOT_FOUND,
  A2A_UNSUPPORTED_OPERATION,
  errorResponse,
  JSONRPC_INTERNAL_ERROR,
  JSONRPC_INVALID_PARAMS,
  JSONRPC_METHOD_NOT_FOUND,
  parseJsonRpcRequest,
  successResponse,
  type JsonRpcId,
  type JsonRpcResponse,
} from "./jsonrpc.js";
import {
  A2A_METHODS,
  type A2AFilePart,
  type A2AMessage,
  type A2APart,
  type A2ATask,
  type MessageSendParams,
  type TaskIdParams,
  type TaskQueryParams,
} from "./types.js";

/**
 * Opaque caller identity, resolved and authenticated by the transport before
 * the request reaches the handler. `peer` is the command-center peer name when
 * known (see COMMAND_CENTER_PEERS); `principalId` is the Bridge principal the
 * transport bound the session to. The backend uses these for authorization.
 */
export interface A2ACaller {
  readonly peer?: string;
  readonly principalId?: string;
}

/**
 * The Bridge binding for A2A tasks. Implemented by the runtime wiring (which
 * turns a message into a job/dispatch and reads task state back through the
 * job aggregate). Kept narrow so the protocol layer never touches storage.
 */
export interface A2ATaskBackend {
  send(params: MessageSendParams, caller: A2ACaller): Promise<A2ATask>;
  get(params: TaskQueryParams, caller: A2ACaller): Promise<A2ATask>;
  cancel(params: TaskIdParams, caller: A2ACaller): Promise<A2ATask>;
}

/**
 * Stable Bridge error codes → A2A/JSON-RPC error codes. Anything not listed
 * maps to a generic internal error so authorization and storage internals do
 * not leak their specific failure reason to a peer.
 */
const ERROR_CODE_MAP: Readonly<Record<string, number>> = {
  job_not_found: A2A_TASK_NOT_FOUND,
  job_project_mismatch: A2A_TASK_NOT_FOUND,
  invalid_transition: A2A_TASK_NOT_CANCELABLE,
};

export class A2ARequestHandler {
  constructor(private readonly backend: A2ATaskBackend) {}

  /** Handle one already-JSON-parsed request body; never throws. */
  async handle(raw: unknown, caller: A2ACaller): Promise<JsonRpcResponse> {
    const parsed = parseJsonRpcRequest(raw);
    if (!parsed.ok) return errorResponse(parsed.id, parsed.error.code, parsed.error.message, parsed.error.data);
    const { id, method, params } = parsed.request;
    try {
      switch (method) {
        case A2A_METHODS.messageSend:
          return successResponse(id, await this.backend.send(requireMessageSendParams(params), caller));
        case A2A_METHODS.tasksGet:
          return successResponse(id, await this.backend.get(requireTaskQueryParams(params), caller));
        case A2A_METHODS.tasksCancel:
          return successResponse(id, await this.backend.cancel(requireTaskIdParams(params), caller));
        case A2A_METHODS.messageStream:
          return errorResponse(id, A2A_UNSUPPORTED_OPERATION, "streaming_requires_sse_endpoint");
        default:
          return errorResponse(id, JSONRPC_METHOD_NOT_FOUND, "method_not_found", { method });
      }
    } catch (error) {
      return this.mapError(id, error);
    }
  }

  private mapError(id: JsonRpcId, error: unknown): JsonRpcResponse {
    if (error instanceof InvalidParamsError) {
      return errorResponse(id, JSONRPC_INVALID_PARAMS, error.reason);
    }
    const code = asErrorCode(error);
    const mapped = ERROR_CODE_MAP[code];
    if (mapped !== undefined) return errorResponse(id, mapped, code);
    // Unknown / authorization / internal: return a generic internal error, but
    // keep the stable Bridge code as data (loopback-only endpoint) for local
    // debugging without leaking a message to remote callers.
    return errorResponse(id, JSONRPC_INTERNAL_ERROR, "internal_error", { code });
  }
}

// ---- Params validation (produces -32602 on malformed input) ----

class InvalidParamsError extends Error {
  readonly reason: string;
  constructor(reason: string) {
    super(reason);
    this.name = "InvalidParamsError";
    this.reason = reason;
  }
}

function asObject(value: unknown, reason: string): Record<string, unknown> {
  if (typeof value !== "object" || value === null || Array.isArray(value)) throw new InvalidParamsError(reason);
  return value as Record<string, unknown>;
}

function requireTaskIdParams(params: unknown): TaskIdParams {
  const obj = asObject(params, "params_required");
  if (typeof obj.id !== "string" || obj.id.length === 0) throw new InvalidParamsError("task_id_required");
  return { id: obj.id };
}

function requireTaskQueryParams(params: unknown): TaskQueryParams {
  const obj = asObject(params, "params_required");
  if (typeof obj.id !== "string" || obj.id.length === 0) throw new InvalidParamsError("task_id_required");
  if (obj.historyLength !== undefined) {
    if (typeof obj.historyLength !== "number" || !Number.isSafeInteger(obj.historyLength) || obj.historyLength < 0) {
      throw new InvalidParamsError("invalid_history_length");
    }
    return { id: obj.id, historyLength: obj.historyLength };
  }
  return { id: obj.id };
}

function requireMessageSendParams(params: unknown): MessageSendParams {
  const obj = asObject(params, "params_required");
  const message = requireMessage(obj.message);
  return {
    message,
    ...(obj.configuration !== undefined
      ? { configuration: requireMessageSendConfiguration(obj.configuration) }
      : {}),
    ...(obj.metadata !== undefined ? { metadata: requireMetadata(obj.metadata) } : {}),
  };
}

function requireMessageSendConfiguration(value: unknown): NonNullable<MessageSendParams["configuration"]> {
  const obj = asObject(value, "configuration_invalid");
  const configuration: {
    acceptedOutputModes?: readonly string[];
    historyLength?: number;
    blocking?: boolean;
  } = {};
  if (obj.acceptedOutputModes !== undefined) {
    if (!Array.isArray(obj.acceptedOutputModes) ||
      obj.acceptedOutputModes.some((mode) => typeof mode !== "string" || mode.length === 0)) {
      throw new InvalidParamsError("accepted_output_modes_invalid");
    }
    configuration.acceptedOutputModes = [...obj.acceptedOutputModes] as string[];
  }
  if (obj.historyLength !== undefined) {
    if (typeof obj.historyLength !== "number" || !Number.isSafeInteger(obj.historyLength) || obj.historyLength < 0) {
      throw new InvalidParamsError("invalid_history_length");
    }
    configuration.historyLength = obj.historyLength;
  }
  if (obj.blocking !== undefined) {
    if (typeof obj.blocking !== "boolean") throw new InvalidParamsError("blocking_invalid");
    configuration.blocking = obj.blocking;
  }
  return configuration;
}

function requireMetadata(value: unknown): Record<string, unknown> {
  return asObject(value, "metadata_invalid");
}

function requireMessage(value: unknown): A2AMessage {
  const obj = asObject(value, "message_required");
  if (obj.role !== "user" && obj.role !== "agent") throw new InvalidParamsError("message_role_invalid");
  if (typeof obj.messageId !== "string" || obj.messageId.length === 0) throw new InvalidParamsError("message_id_required");
  if (!Array.isArray(obj.parts) || obj.parts.length === 0) throw new InvalidParamsError("message_parts_required");
  const parts = obj.parts.map(requirePart);
  return {
    kind: "message",
    role: obj.role,
    messageId: obj.messageId,
    parts,
    ...(typeof obj.taskId === "string" ? { taskId: obj.taskId } : {}),
    ...(typeof obj.contextId === "string" ? { contextId: obj.contextId } : {}),
    ...(obj.metadata !== undefined ? { metadata: requireMetadata(obj.metadata) } : {}),
  };
}

function requirePart(value: unknown): A2APart {
  const obj = asObject(value, "part_invalid");
  switch (obj.kind) {
    case "text":
      if (typeof obj.text !== "string") throw new InvalidParamsError("text_part_requires_text");
      return {
        kind: "text",
        text: obj.text,
        ...(obj.metadata !== undefined ? { metadata: requireMetadata(obj.metadata) } : {}),
      };
    case "file":
      // Minimal shape check; the backend enforces content-type / size policy.
      if (typeof obj.file !== "object" || obj.file === null) throw new InvalidParamsError("file_part_requires_file");
      return {
        kind: "file",
        file: obj.file as A2AFilePart["file"],
        ...(obj.metadata !== undefined ? { metadata: requireMetadata(obj.metadata) } : {}),
      };
    case "data":
      if (typeof obj.data !== "object" || obj.data === null || Array.isArray(obj.data)) {
        throw new InvalidParamsError("data_part_requires_data");
      }
      return {
        kind: "data",
        data: obj.data as Record<string, unknown>,
        ...(obj.metadata !== undefined ? { metadata: requireMetadata(obj.metadata) } : {}),
      };
    default:
      throw new InvalidParamsError("part_kind_invalid");
  }
}
