// End-to-end tests for the inbound A2A server (Phase A, D-026 tasks 1+2):
// a real BridgeRuntime + real HTTP round-trips prove inbound A2A is operational.
// Bootstraps a runtime, provisions peers, starts the loopback server, and drives
// the Agent Card + message/send -> job -> tasks/get -> tasks/cancel flow.

import assert from "node:assert/strict";
import test from "node:test";
import { createFixture } from "./helpers.mjs";
import { runA2AServer } from "../../dist/v2/a2a/serve.js";

async function rpc(url, peer, body) {
  const headers = { "content-type": "application/json" };
  if (peer) headers["x-bridge-peer"] = peer;
  const res = await fetch(url, { method: "POST", headers, body: JSON.stringify(body) });
  const text = await res.text();
  return { status: res.status, body: text ? JSON.parse(text) : undefined };
}

function sendParams(text, messageId) {
  return { message: { kind: "message", role: "user", messageId, parts: [{ kind: "text", text }] } };
}

test("A2A server publishes the Agent Card on loopback with the actual bound port", async () => {
  const fx = createFixture("a2a-card");
  const server = await runA2AServer(fx.runtime, { projectId: fx.projectId, actor: fx.owner }, { port: 0 });
  try {
    const res = await fetch(`${server.url}.well-known/agent-card.json`);
    assert.equal(res.status, 200);
    const card = await res.json();
    assert.equal(card.name, "Bridge Command Center");
    assert.equal(card.protocolVersion, "0.3.0");
    assert.equal(card.url, `${server.url}a2a`); // advertises the real JSON-RPC endpoint
    assert.equal(card.preferredTransport, "JSONRPC");
    assert.equal(card.capabilities.streaming, false, "must not advertise unimplemented SSE");
    assert.equal(card.capabilities.stateTransitionHistory, false, "must not advertise unimplemented wire history");
    assert.equal(card.securitySchemes.bridgePeer.name, "x-bridge-peer");
    const skillIds = card.skills.map((s) => s.id);
    for (const peer of ["antigravity", "claude", "codex"]) {
      assert.ok(skillIds.includes(`delegate.${peer}`), `missing delegate.${peer}`);
    }
    assert.deepEqual(skillIds.sort(), ["delegate.antigravity", "delegate.claude", "delegate.codex"]);
    // Antigravity is the Google peer; the retired Gemini CLI is not a peer.
    assert.ok(!skillIds.includes("delegate.gemini"), "gemini must not be advertised as a peer");
  } finally {
    await server.close();
    fx.cleanup();
  }
});

test("inbound message/send creates a Bridge job; tasks/get and tasks/cancel project its state", async () => {
  const fx = createFixture("a2a-flow");
  const server = await runA2AServer(fx.runtime, { projectId: fx.projectId, actor: fx.owner }, { port: 0 });
  const rpcUrl = `${server.url}a2a`;
  try {
    const send = await rpc(rpcUrl, "codex", {
      jsonrpc: "2.0", id: 1, method: "message/send", params: sendParams("summarize the filing", "msg-e2e-1"),
    });
    assert.equal(send.status, 200);
    assert.equal(send.body.error, undefined, JSON.stringify(send.body.error));
    const task = send.body.result;
    assert.equal(task.kind, "task");
    assert.equal(task.status.state, "submitted");

    // A real, audited Bridge job was created for the delegated task.
    const jobs = fx.runtime.jobs.list(fx.projectId);
    assert.equal(jobs.length, 1);
    assert.equal(jobs[0].jobId, task.id);
    assert.equal(jobs[0].requestedBy.principalId, "principal.pgvin.codex");
    assert.equal(jobs[0].requiredRole, "worker");
    assert.equal(jobs[0].target.instructions.text, "summarize the filing");

    // tasks/get round-trips the same task.
    const get = await rpc(rpcUrl, "codex", { jsonrpc: "2.0", id: 2, method: "tasks/get", params: { id: task.id } });
    assert.equal(get.body.result.id, task.id);
    assert.equal(get.body.result.status.state, "submitted");

    // tasks/cancel moves it to canceled.
    const cancel = await rpc(rpcUrl, "codex", { jsonrpc: "2.0", id: 3, method: "tasks/cancel", params: { id: task.id } });
    assert.equal(cancel.body.result.status.state, "canceled");
  } finally {
    await server.close();
    fx.cleanup();
  }
});

test("send is idempotent across repeated identical messages (one job)", async () => {
  const fx = createFixture("a2a-idem");
  const server = await runA2AServer(fx.runtime, { projectId: fx.projectId, actor: fx.owner }, { port: 0 });
  const rpcUrl = `${server.url}a2a`;
  try {
    const first = await rpc(rpcUrl, "claude", { jsonrpc: "2.0", id: 1, method: "message/send", params: sendParams("same task", "msg-idem") });
    const second = await rpc(rpcUrl, "claude", { jsonrpc: "2.0", id: 2, method: "message/send", params: sendParams("same task", "msg-idem") });
    assert.equal(first.body.result.id, second.body.result.id);
    assert.equal(fx.runtime.jobs.list(fx.projectId).length, 1);
  } finally {
    await server.close();
    fx.cleanup();
  }
});

test("a request without a provisioned peer header is refused (401)", async () => {
  const fx = createFixture("a2a-auth");
  const server = await runA2AServer(fx.runtime, { projectId: fx.projectId, actor: fx.owner }, { port: 0 });
  const rpcUrl = `${server.url}a2a`;
  try {
    const noPeer = await rpc(rpcUrl, undefined, { jsonrpc: "2.0", id: 1, method: "tasks/get", params: { id: "job.x" } });
    assert.equal(noPeer.status, 401);
    const badPeer = await fetch(rpcUrl, {
      method: "POST",
      headers: { "content-type": "application/json", "x-bridge-peer": "stranger" },
      body: "{}",
    });
    assert.equal(badPeer.status, 401);
  } finally {
    await server.close();
    fx.cleanup();
  }
});
