// Regression tests for the defects found by the independent (Codex) review of
// branch a2a-phase-a. Each test fails against the pre-fix code:
//   F1 [blocker] loopback was a default, not an invariant
//   F2 [major]   provisioning was not restart-idempotent (stable key + fresh createdAt)
//   F3 [major]   message/send was not durably idempotent across a clock tick
//   F4 [major]   artifact/job ids were not namespaced by project + peer

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

function send(text, messageId) {
  return { message: { kind: "message", role: "user", messageId, parts: [{ kind: "text", text }] } };
}

const serveCtx = (fx) => ({ projectId: fx.projectId, actor: fx.owner });

test("F1: runA2AServer refuses every non-loopback host (loopback is an invariant)", async () => {
  const fx = createFixture("a2a-fix-loopback");
  try {
    for (const host of ["0.0.0.0", "::", "192.168.1.10", "example.com"]) {
      await assert.rejects(
        () => runA2AServer(fx.runtime, serveCtx(fx), { port: 0, host }),
        /a2a_serve_requires_loopback_host/,
        `host ${host} must be refused`,
      );
    }
    // The loopback default still works.
    const ok = await runA2AServer(fx.runtime, serveCtx(fx), { port: 0 });
    await ok.close();
  } finally {
    fx.cleanup();
  }
});

test("F2: provisioning survives a restart after the clock moves", async () => {
  const fx = createFixture("a2a-fix-restart");
  try {
    const first = await runA2AServer(fx.runtime, serveCtx(fx), { port: 0 });
    await first.close();

    // Move the clock. Previously the stable provisioning key + a fresh createdAt
    // changed the request hash and threw idempotency_key_reused on restart.
    fx.clock.value = "2026-07-13T18:30:00.000Z";
    const second = await runA2AServer(fx.runtime, serveCtx(fx), { port: 0 });
    try {
      const res = await rpc(`${second.url}a2a`, "codex", {
        jsonrpc: "2.0", id: 1, method: "message/send", params: send("after restart", "msg-restart"),
      });
      assert.equal(res.body.error, undefined, JSON.stringify(res.body.error));
      assert.equal(res.body.result.status.state, "submitted");
    } finally {
      await second.close();
    }
  } finally {
    fx.cleanup();
  }
});

test("F3: send retried after the clock moves returns the same task, not an error", async () => {
  const fx = createFixture("a2a-fix-retry");
  const server = await runA2AServer(fx.runtime, serveCtx(fx), { port: 0 });
  const url = `${server.url}a2a`;
  try {
    const first = await rpc(url, "codex", { jsonrpc: "2.0", id: 1, method: "message/send", params: send("retry me", "msg-retry") });
    assert.equal(first.body.error, undefined, JSON.stringify(first.body.error));

    // A delayed retry: the artifact request carries createdAt, so replaying
    // registration on a new tick used to throw idempotency_key_reused.
    fx.clock.value = "2026-07-13T14:00:00.000Z";
    const second = await rpc(url, "codex", { jsonrpc: "2.0", id: 2, method: "message/send", params: send("retry me", "msg-retry") });
    assert.equal(second.body.error, undefined, JSON.stringify(second.body.error));
    assert.equal(second.body.result.id, first.body.result.id);
    assert.equal(fx.runtime.jobs.list(fx.projectId).length, 1);
  } finally {
    await server.close();
    fx.cleanup();
  }
});

test("F4: two peers sending an identical message get distinct tasks (no id collision)", async () => {
  const fx = createFixture("a2a-fix-peers");
  const server = await runA2AServer(fx.runtime, serveCtx(fx), { port: 0 });
  const url = `${server.url}a2a`;
  try {
    const a = await rpc(url, "codex", { jsonrpc: "2.0", id: 1, method: "message/send", params: send("same text", "msg-shared") });
    const b = await rpc(url, "claude", { jsonrpc: "2.0", id: 2, method: "message/send", params: send("same text", "msg-shared") });
    assert.equal(a.body.error, undefined, JSON.stringify(a.body.error));
    assert.equal(b.body.error, undefined, JSON.stringify(b.body.error));
    assert.notEqual(a.body.result.id, b.body.result.id);
    assert.equal(fx.runtime.jobs.list(fx.projectId).length, 2);
  } finally {
    await server.close();
    fx.cleanup();
  }
});

test("F7: messages differing only by contextId do not collapse onto one task", async () => {
  const fx = createFixture("a2a-fix-context");
  const server = await runA2AServer(fx.runtime, serveCtx(fx), { port: 0 });
  const url = `${server.url}a2a`;
  try {
    const one = { message: { kind: "message", role: "user", messageId: "msg-ctx", contextId: "ctx-a", parts: [{ kind: "text", text: "hello" }] } };
    const two = { message: { kind: "message", role: "user", messageId: "msg-ctx", contextId: "ctx-b", parts: [{ kind: "text", text: "hello" }] } };
    const a = await rpc(url, "codex", { jsonrpc: "2.0", id: 1, method: "message/send", params: one });
    const b = await rpc(url, "codex", { jsonrpc: "2.0", id: 2, method: "message/send", params: two });
    assert.equal(a.body.error, undefined, JSON.stringify(a.body.error));
    assert.equal(b.body.error, undefined, JSON.stringify(b.body.error));
    assert.notEqual(a.body.result.id, b.body.result.id);
  } finally {
    await server.close();
    fx.cleanup();
  }
});
