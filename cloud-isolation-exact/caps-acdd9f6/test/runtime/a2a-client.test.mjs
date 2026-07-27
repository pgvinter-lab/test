// Tests for the A2A OUTBOUND lane (Phase B, D-026): the JSON-RPC client, the
// subscription-CLI dispatcher, and the outbound adapter manifest. All ports are
// faked (no network, no spawned process). Enforces the no-API-key invariant.

import assert from "node:assert/strict";
import test from "node:test";
import { A2AClient } from "../../dist/v2/a2a/client.js";
import { buildPeerArgv, dispatchToPeer, peerCliSpec } from "../../dist/v2/a2a/peer-dispatch.js";
import { buildA2AClientAdapterManifest } from "../../dist/v2/adapters/a2a-client-adapter.js";

const PEERS = ["antigravity", "claude", "codex"];

function message(text, messageId) {
  return { message: { kind: "message", role: "user", messageId, parts: [{ kind: "text", text }] } };
}

test("A2AClient.send returns the task on a JSON-RPC success", async () => {
  const calls = [];
  const client = new A2AClient({
    endpoint: "http://127.0.0.1:4319/a2a",
    fetchJson: async (url, body) => {
      calls.push({ url, body });
      return { jsonrpc: "2.0", id: body.id, result: { kind: "task", id: "job.x", contextId: "c", status: { state: "submitted" } } };
    },
  });
  const task = await client.send(message("hi", "m1"));
  assert.equal(task.id, "job.x");
  assert.equal(task.status.state, "submitted");
  assert.equal(calls[0].url, "http://127.0.0.1:4319/a2a");
  assert.equal(calls[0].body.method, "message/send");
});

test("A2AClient maps a JSON-RPC error reply to a BridgeRuntimeError", async () => {
  const client = new A2AClient({
    endpoint: "http://127.0.0.1:4319/a2a",
    fetchJson: async () => ({ jsonrpc: "2.0", id: 1, error: { code: -32001, message: "task_not_found" } }),
  });
  await assert.rejects(() => client.getTask({ id: "job.missing" }), /a2a_client_rpc_error/);
});

test("every peer's frozen spec is subscription-based and caller content cannot become an option", () => {
  const flagShapedPrompt = "--api-key sk-NOT-A-REAL-KEY";
  for (const peer of PEERS) {
    const spec = peerCliSpec(peer);
    const fixedOptions = spec.promptFlag ? [...spec.flags, spec.promptFlag] : spec.flags;
    for (const option of fixedOptions) {
      assert.ok(!/--?(api[-_]?key|key|token|bearer)\b/i.test(option), `${peer} has a key option: ${option}`);
    }

    const argv = buildPeerArgv(spec, flagShapedPrompt);
    assert.ok(!argv.includes(flagShapedPrompt), `${peer} exposed the prompt as a standalone argv token`);
    assert.ok(
      !argv.some((arg) => /^--?(api[-_]?key|key|token|bearer)(?:=|$)/i.test(arg)),
      `${peer} let caller content become an option`,
    );
  }

  assert.deepEqual(
    buildPeerArgv(peerCliSpec("antigravity"), flagShapedPrompt),
    [
      "--new-project",
      "--model",
      "Gemini 3.1 Pro (High)",
      "--mode",
      "accept-edits",
      "--dangerously-skip-permissions",
      "--print-timeout",
      "20m",
      `--print=${flagShapedPrompt}`,
    ],
  );
  assert.equal(peerCliSpec("antigravity").promptMode, "option-value");
  assert.equal(peerCliSpec("claude").promptMode, "stdin");
  assert.equal(peerCliSpec("codex").promptMode, "stdin");
});

test("Antigravity is the Google peer — the retired Gemini CLI is not a peer", () => {
  assert.equal(peerCliSpec("antigravity").command, "agy");
  assert.throws(() => peerCliSpec("gemini"), /a2a_peer_dispatch_unknown_peer/);
});

test("dispatchToPeer runs the peer's CLI and returns stdout", async () => {
  const runs = [];
  const out = await dispatchToPeer("codex", "summarize", async (cmd, args, input) => {
    runs.push({ cmd, args, input });
    return { stdout: "PEER_OUTPUT", stderr: "", code: 0 };
  });
  assert.equal(out.stdout, "PEER_OUTPUT");
  assert.equal(out.delivered, true);
  assert.equal(out.reliability, "verified");
  assert.equal(runs[0].cmd, "codex");
  assert.deepEqual(runs[0].args, ["exec", "--skip-git-repo-check"]);
  assert.equal(runs[0].input, "summarize");
});

test("dispatchToPeer fails on a non-zero exit", async () => {
  await assert.rejects(
    () => dispatchToPeer("codex", "x", async () => ({ stdout: "", stderr: "boom", code: 1 })),
    /a2a_peer_dispatch_failed/,
  );
});

test("adapter.a2a.client manifest uses no credentials and asks before sending", () => {
  const manifest = buildA2AClientAdapterManifest();
  assert.equal(manifest.adapterId, "adapter.a2a.client");
  assert.equal(manifest.security.credentialMode, "none");
  assert.equal(manifest.security.approvalPolicy.defaultDecision, "ask");
  assert.equal(manifest.operations.send.sideEffectClass, "external_reversible");
});
