// Unit tests for the A2A protocol core (Phase A, D-026): JSON-RPC framing, the
// Bridge-job -> A2A-task state projection, and handler method routing + error
// mapping. Pure layer, exercised with a fake backend (no runtime fixture).

import assert from "node:assert/strict";
import test from "node:test";
import { BridgeRuntimeError } from "../../dist/v2/core/errors.js";
import {
  parseJsonRpcRequest,
  JSONRPC_INVALID_REQUEST,
} from "../../dist/v2/a2a/jsonrpc.js";
import { jobStatusToTaskState } from "../../dist/v2/a2a/job-mapping.js";
import { isTerminalTaskState } from "../../dist/v2/a2a/types.js";
import { A2ARequestHandler } from "../../dist/v2/a2a/handler.js";

// ---- helpers ----

function task(id, state) {
  return { kind: "task", id, contextId: `ctx.${id}`, status: { state } };
}

/** Records the last call and returns a canned task; can be told to throw. */
function fakeBackend(overrides = {}) {
  const calls = [];
  const record = (name) => async (params, caller) => {
    calls.push({ name, params, caller });
    if (overrides[name]) return overrides[name](params, caller);
    return task(params.id ?? "task.new", "working");
  };
  return {
    calls,
    send: record("send"),
    get: record("get"),
    cancel: record("cancel"),
  };
}

const CALLER = { peer: "codex", principalId: "principal.pgvin.codex" };

function req(method, params, id = 1) {
  return { jsonrpc: "2.0", id, method, params };
}

const sampleMessage = {
  kind: "message",
  role: "user",
  messageId: "msg.1",
  parts: [{ kind: "text", text: "do the thing" }],
};

// ---- JSON-RPC framing ----

test("parseJsonRpcRequest rejects non-objects, arrays, and null with id null", () => {
  for (const bad of [null, 42, "x", [], [{ jsonrpc: "2.0" }]]) {
    const r = parseJsonRpcRequest(bad);
    assert.equal(r.ok, false);
    assert.equal(r.id, null);
    assert.equal(r.error.code, JSONRPC_INVALID_REQUEST);
  }
});

test("parseJsonRpcRequest rejects a wrong jsonrpc version but keeps the id", () => {
  const r = parseJsonRpcRequest({ jsonrpc: "1.0", id: 7, method: "tasks/get" });
  assert.equal(r.ok, false);
  assert.equal(r.id, 7);
  assert.equal(r.error.message, "jsonrpc_version_required");
});

test("parseJsonRpcRequest rejects a missing/empty method", () => {
  const r = parseJsonRpcRequest({ jsonrpc: "2.0", id: 1 });
  assert.equal(r.ok, false);
  assert.equal(r.error.message, "method_required");
});

test("parseJsonRpcRequest rejects a structurally invalid id with id null", () => {
  const r = parseJsonRpcRequest({ jsonrpc: "2.0", id: { nope: true }, method: "tasks/get" });
  assert.equal(r.ok, false);
  assert.equal(r.id, null);
  assert.equal(r.error.message, "invalid_id");
});

test("parseJsonRpcRequest accepts a valid request and preserves string and number ids", () => {
  for (const id of ["abc", 0, 99]) {
    const r = parseJsonRpcRequest({ jsonrpc: "2.0", id, method: "message/send", params: {} });
    assert.equal(r.ok, true);
    assert.equal(r.request.id, id);
    assert.equal(r.request.method, "message/send");
  }
});

// ---- job -> task state projection ----

test("jobStatusToTaskState maps every Bridge job status to its A2A state", () => {
  assert.equal(jobStatusToTaskState("queued"), "submitted");
  assert.equal(jobStatusToTaskState("claimable"), "submitted");
  assert.equal(jobStatusToTaskState("claimed"), "working");
  assert.equal(jobStatusToTaskState("running"), "working");
  assert.equal(jobStatusToTaskState("awaiting_input"), "input-required");
  assert.equal(jobStatusToTaskState("completed"), "completed");
  assert.equal(jobStatusToTaskState("failed"), "failed");
  assert.equal(jobStatusToTaskState("cancelled"), "canceled"); // spelling shift is intentional
});

test("isTerminalTaskState matches the A2A terminal set", () => {
  for (const s of ["completed", "canceled", "failed", "rejected"]) assert.equal(isTerminalTaskState(s), true);
  for (const s of ["submitted", "working", "input-required", "auth-required", "unknown"]) {
    assert.equal(isTerminalTaskState(s), false);
  }
});

// ---- handler routing ----

test("handler routes message/send to the backend and echoes the id", async () => {
  const backend = fakeBackend();
  const handler = new A2ARequestHandler(backend);
  const res = await handler.handle(req("message/send", { message: sampleMessage }, 5), CALLER);
  assert.equal(res.id, 5);
  assert.equal(res.result.kind, "task");
  assert.equal(backend.calls.length, 1);
  assert.equal(backend.calls[0].name, "send");
  assert.deepEqual(backend.calls[0].caller, CALLER);
  assert.deepEqual(backend.calls[0].params.message, sampleMessage);
});

test("handler routes tasks/get and tasks/cancel to the backend", async () => {
  const backend = fakeBackend();
  const handler = new A2ARequestHandler(backend);
  const got = await handler.handle(req("tasks/get", { id: "task.42" }), CALLER);
  assert.equal(got.result.id, "task.42");
  const cancelled = await handler.handle(req("tasks/cancel", { id: "task.42" }), CALLER);
  assert.equal(cancelled.result.id, "task.42");
  assert.deepEqual(backend.calls.map((c) => c.name), ["get", "cancel"]);
});

test("handler returns method_not_found for an unknown method", async () => {
  const handler = new A2ARequestHandler(fakeBackend());
  const res = await handler.handle(req("tasks/frobnicate", {}), CALLER);
  assert.equal(res.error.code, -32601);
});

test("handler reports message/stream as unsupported over the unary endpoint", async () => {
  const handler = new A2ARequestHandler(fakeBackend());
  const res = await handler.handle(req("message/stream", { message: sampleMessage }), CALLER);
  assert.equal(res.error.code, -32004);
  assert.equal(res.error.message, "streaming_requires_sse_endpoint");
});

// ---- handler params validation ----

test("handler rejects message/send without a message as invalid params", async () => {
  const handler = new A2ARequestHandler(fakeBackend());
  const res = await handler.handle(req("message/send", {}), CALLER);
  assert.equal(res.error.code, -32602);
  assert.equal(res.error.message, "message_required");
});

test("handler rejects a message with no parts", async () => {
  const handler = new A2ARequestHandler(fakeBackend());
  const bad = { ...sampleMessage, parts: [] };
  const res = await handler.handle(req("message/send", { message: bad }), CALLER);
  assert.equal(res.error.code, -32602);
  assert.equal(res.error.message, "message_parts_required");
});

test("handler rejects tasks/get without an id", async () => {
  const handler = new A2ARequestHandler(fakeBackend());
  const res = await handler.handle(req("tasks/get", {}), CALLER);
  assert.equal(res.error.code, -32602);
  assert.equal(res.error.message, "task_id_required");
});

test("handler rejects a negative historyLength", async () => {
  const handler = new A2ARequestHandler(fakeBackend());
  const res = await handler.handle(req("tasks/get", { id: "t", historyLength: -1 }), CALLER);
  assert.equal(res.error.code, -32602);
  assert.equal(res.error.message, "invalid_history_length");
});

test("handler validates message/send configuration and metadata before dispatch", async () => {
  const handler = new A2ARequestHandler(fakeBackend());
  const cases = [
    [{ message: sampleMessage, configuration: "blocking" }, "configuration_invalid"],
    [{ message: sampleMessage, configuration: { blocking: "yes" } }, "blocking_invalid"],
    [{ message: sampleMessage, configuration: { historyLength: -1 } }, "invalid_history_length"],
    [{ message: sampleMessage, configuration: { acceptedOutputModes: ["text/plain", 3] } }, "accepted_output_modes_invalid"],
    [{ message: sampleMessage, metadata: [] }, "metadata_invalid"],
    [{ message: { ...sampleMessage, metadata: "not-an-object" } }, "metadata_invalid"],
  ];
  for (const [params, message] of cases) {
    const res = await handler.handle(req("message/send", params), CALLER);
    assert.equal(res.error.code, -32602);
    assert.equal(res.error.message, message);
  }
});

// ---- handler error mapping ----

test("handler maps job_not_found to A2A TaskNotFound (-32001)", async () => {
  const backend = fakeBackend({
    get: () => {
      throw new BridgeRuntimeError("job_not_found");
    },
  });
  const handler = new A2ARequestHandler(backend);
  const res = await handler.handle(req("tasks/get", { id: "task.missing" }), CALLER);
  assert.equal(res.error.code, -32001);
  assert.equal(res.error.message, "job_not_found");
});

test("handler maps invalid_transition to A2A TaskNotCancelable (-32002)", async () => {
  const backend = fakeBackend({
    cancel: () => {
      throw new BridgeRuntimeError("invalid_transition");
    },
  });
  const handler = new A2ARequestHandler(backend);
  const res = await handler.handle(req("tasks/cancel", { id: "task.done" }), CALLER);
  assert.equal(res.error.code, -32002);
});

test("handler hides unknown backend errors behind a generic internal error", async () => {
  const backend = fakeBackend({
    send: () => {
      throw new BridgeRuntimeError("reviewer_not_independent");
    },
  });
  const handler = new A2ARequestHandler(backend);
  const res = await handler.handle(req("message/send", { message: sampleMessage }), CALLER);
  assert.equal(res.error.code, -32603);
  assert.equal(res.error.message, "internal_error");
  assert.equal(res.error.data.code, "reviewer_not_independent"); // kept as data, not message
});
