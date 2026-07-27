// A2A (Agent2Agent) domain types for the Bridge command-center endpoint.
//
// Wire shapes for Messages, Parts, Artifacts, and Tasks, plus the parameter
// types for the JSON-RPC methods the Phase A server implements. Deliberately
// free of Bridge runtime types so the protocol layer stays testable in
// isolation; the binding to Bridge jobs lives behind the A2ATaskBackend port
// (see handler.ts).
//
// SPEC NOTE: field/enum names follow the A2A spec shape; verify against the
// version pinned in `A2A_PROTOCOL_VERSION` (agent-card.ts) before release.

export type A2ATaskState =
  | "submitted"
  | "working"
  | "input-required"
  | "completed"
  | "canceled"
  | "failed"
  | "rejected"
  | "auth-required"
  | "unknown";

/** A2A terminal task states — no further status updates once reached. */
export const A2A_TERMINAL_STATES: readonly A2ATaskState[] = [
  "completed",
  "canceled",
  "failed",
  "rejected",
];

export function isTerminalTaskState(state: A2ATaskState): boolean {
  return A2A_TERMINAL_STATES.includes(state);
}

export interface A2ATextPart {
  readonly kind: "text";
  readonly text: string;
  readonly metadata?: Record<string, unknown>;
}

export interface A2AFileWithBytes {
  readonly name?: string;
  readonly mimeType?: string;
  readonly bytes: string;
}

export interface A2AFileWithUri {
  readonly name?: string;
  readonly mimeType?: string;
  readonly uri: string;
}

export interface A2AFilePart {
  readonly kind: "file";
  readonly file: A2AFileWithBytes | A2AFileWithUri;
  readonly metadata?: Record<string, unknown>;
}

export interface A2ADataPart {
  readonly kind: "data";
  readonly data: Record<string, unknown>;
  readonly metadata?: Record<string, unknown>;
}

export type A2APart = A2ATextPart | A2AFilePart | A2ADataPart;

export interface A2AMessage {
  readonly kind: "message";
  readonly role: "user" | "agent";
  readonly messageId: string;
  readonly parts: readonly A2APart[];
  readonly taskId?: string;
  readonly contextId?: string;
  readonly metadata?: Record<string, unknown>;
}

export interface A2AArtifact {
  readonly artifactId: string;
  readonly name?: string;
  readonly description?: string;
  readonly parts: readonly A2APart[];
  readonly metadata?: Record<string, unknown>;
}

export interface A2ATaskStatus {
  readonly state: A2ATaskState;
  readonly message?: A2AMessage;
  /** ISO-8601 timestamp; supplied by the backend, which owns the clock. */
  readonly timestamp?: string;
}

export interface A2ATask {
  readonly kind: "task";
  readonly id: string;
  readonly contextId: string;
  readonly status: A2ATaskStatus;
  readonly history?: readonly A2AMessage[];
  readonly artifacts?: readonly A2AArtifact[];
  readonly metadata?: Record<string, unknown>;
}

// ---- Method parameter types ----

export interface MessageSendConfiguration {
  readonly acceptedOutputModes?: readonly string[];
  readonly historyLength?: number;
  readonly blocking?: boolean;
}

export interface MessageSendParams {
  readonly message: A2AMessage;
  readonly configuration?: MessageSendConfiguration;
  readonly metadata?: Record<string, unknown>;
}

export interface TaskQueryParams {
  readonly id: string;
  readonly historyLength?: number;
}

export interface TaskIdParams {
  readonly id: string;
}

/** Canonical JSON-RPC method names for the Phase A A2A surface. */
export const A2A_METHODS = {
  messageSend: "message/send",
  messageStream: "message/stream",
  tasksGet: "tasks/get",
  tasksCancel: "tasks/cancel",
} as const;

export type A2AMethod = (typeof A2A_METHODS)[keyof typeof A2A_METHODS];
