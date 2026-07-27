// Peer reliability tiers (owner directive). Antigravity stays fail-closed after
// a real pinned-model end-to-end response promoted it to verified.
//
// Every verified peer propagates runner failures and throws on non-zero exits.

import assert from "node:assert/strict";
import test from "node:test";
import { dispatchToPeer, peerCliSpec, peerReliability } from "../../dist/v2/a2a/peer-dispatch.js";

const ok = async () => ({ stdout: "ANSWER", stderr: "", code: 0 });
const nonZero = async () => ({ stdout: "", stderr: "boom", code: 1 });
const throws = async () => {
  const error = new Error("spawn agy ENOENT");
  error.code = "ENOENT";
  throw error;
};

test("antigravity, claude, and codex are verified", () => {
  assert.equal(peerReliability("antigravity"), "verified");
  assert.equal(peerReliability("claude"), "verified");
  assert.equal(peerReliability("codex"), "verified");

  assert.equal(peerCliSpec("antigravity").reliabilityNote, undefined);
  assert.equal(peerCliSpec("codex").reliabilityNote, undefined);
});

test("antigravity dispatch pins the verified model and real CLI syntax", async () => {
  const runs = [];
  await dispatchToPeer("antigravity", "do the thing", async (cmd, args, input) => {
    runs.push({ cmd, args, input });
    return ok();
  });
  assert.equal(runs.length, 1);
  assert.equal(runs[0].cmd, "agy");
  assert.deepEqual(runs[0].args, [
    "--new-project",
    "--model",
    "Gemini 3.1 Pro (High)",
    "--mode",
    "accept-edits",
    "--dangerously-skip-permissions",
    "--print-timeout",
    "20m",
    "--print=do the thing",
  ]);
  assert.equal(runs[0].input, undefined);
});

test("verified antigravity throws on a non-zero exit", async () => {
  await assert.rejects(() => dispatchToPeer("antigravity", "x", nonZero), /a2a_peer_dispatch_failed/);
});

test("verified antigravity propagates a runner failure", async () => {
  await assert.rejects(() => dispatchToPeer("antigravity", "x", throws), /spawn agy ENOENT/);
});

test("verified antigravity returns a successful response", async () => {
  const result = await dispatchToPeer("antigravity", "x", ok);
  assert.equal(result.delivered, true);
  assert.equal(result.reliability, "verified");
  assert.equal(result.stdout, "ANSWER");
});

test("a verified peer keeps strict behaviour and still throws on failure", async () => {
  await assert.rejects(() => dispatchToPeer("codex", "x", nonZero), /a2a_peer_dispatch_failed/);
  await assert.rejects(() => dispatchToPeer("claude", "x", nonZero), /a2a_peer_dispatch_failed/);
});
