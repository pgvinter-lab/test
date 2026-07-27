// Regression tests for the SECOND and THIRD independent-review rounds.
// Each fails against the commit that preceded its fix:
//   N1 [major] provisioning conflated "principal exists" with "role granted"
//   N2 [major] existing deterministic artifact ids trusted without validation
//   N3 [minor] per-run session id came from millisecond time
//   N5 [major] dispatcher trusted a caller-supplied spec (allowlist bypassable,
//              and a prompt equal to a flag token skipped the scanner)
//   N6 [minor] the N3 test could pass for the wrong reason
//   F1/F6/F7 coverage earlier rounds asserted but did not actually test

import assert from "node:assert/strict";
import test from "node:test";
import { createFixture } from "./helpers.mjs";
import { runA2AServer } from "../../dist/v2/a2a/serve.js";
import { provisionPeers } from "../../dist/v2/a2a/peer-provisioning.js";
import { A2AHttpBoundary } from "../../dist/v2/a2a/http.js";
import { A2AClient } from "../../dist/v2/a2a/client.js";
import { buildPeerArgv, dispatchToPeer, peerCliSpec } from "../../dist/v2/a2a/peer-dispatch.js";
import { JobBackedA2ATaskBackend } from "../../dist/v2/a2a/job-backend.js";

const NOW = "2026-07-13T12:00:00.000Z";
const ACTOR = { principalId: "principal.pgvin.codex", sessionId: "session.codex.1", hostId: "host.desk" };
const CALLER = { peer: "codex", principalId: ACTOR.principalId };
const serveCtx = (fx) => ({ projectId: fx.projectId, actor: fx.owner });

async function rpc(url, peer, body) {
  const res = await fetch(url, {
    method: "POST",
    headers: { "content-type": "application/json", "x-bridge-peer": peer },
    body: JSON.stringify(body),
  });
  return { status: res.status, body: JSON.parse(await res.text()) };
}

function fakeArtifacts() {
  const byId = new Map();
  const calls = [];
  return {
    byId,
    calls,
    get: (id) => byId.get(id),
    register(args) {
      calls.push(args);
      byId.set(args.artifact.artifactId, args.artifact);
      return args.artifact;
    },
  };
}

function fakeJobs() {
  return {
    create: (input) => ({ jobId: input.jobId, projectId: input.projectId, status: "queued", updatedAt: NOW, target: input.target }),
    requireForProject: (projectId, jobId) => ({ jobId, projectId, status: "running", updatedAt: NOW }),
    cancel: (input) => ({ jobId: input.jobId, projectId: input.projectId, status: "cancelled", updatedAt: NOW }),
  };
}

function makeBackend(artifacts) {
  return new JobBackedA2ATaskBackend({
    jobs: fakeJobs(),
    artifacts,
    resolve: () => ({ projectId: "project.test", actor: ACTOR }),
    now: () => NOW,
  });
}

const message = (text, messageId, extra = {}) => ({
  message: { kind: "message", role: "user", messageId, parts: [{ kind: "text", text }], ...extra },
});

/** Register a prompt once, then corrupt the stored record with `mutate`. */
async function sendThenCorrupt(mutate) {
  const artifacts = fakeArtifacts();
  const backend = makeBackend(artifacts);
  const msg = message("hello", "msg-n2");
  await backend.send(msg, CALLER);
  const artifactId = artifacts.calls[0].artifact.artifactId;
  artifacts.byId.set(artifactId, mutate({ ...artifacts.byId.get(artifactId) }));
  return { backend, msg };
}

// ---- N2: the whole envelope must match, not a few fields ----

test("N2: a foreign creator principal at our artifact id is rejected", async () => {
  const { backend, msg } = await sendThenCorrupt((a) => ({
    ...a,
    createdBy: { principalId: "principal.someone.else", sessionId: "s", hostId: "h" },
  }));
  await assert.rejects(() => backend.send(msg, CALLER), /a2a_prompt_artifact_collision/);
});

test("N2: a content-hash mismatch at our artifact id is rejected", async () => {
  const { backend, msg } = await sendThenCorrupt((a) => ({
    ...a,
    content: { ...a.content, sha256: "b".repeat(64) },
  }));
  await assert.rejects(() => backend.send(msg, CALLER), /a2a_prompt_artifact_collision/);
});

test("N2: a foreign content LOCATION is rejected even when the hash matches", async () => {
  // Bridge stores metadata, not bytes: a right-hash/wrong-URI artifact must not bind.
  const { backend, msg } = await sendThenCorrupt((a) => ({
    ...a,
    locations: [{ storageClass: "local", uri: "bridge://a2a/prompt/somewhere-else" }],
  }));
  await assert.rejects(() => backend.send(msg, CALLER), /a2a_prompt_artifact_collision/);
});

test("N2: a foreign provenance captureMethod is rejected", async () => {
  const { backend, msg } = await sendThenCorrupt((a) => ({
    ...a,
    provenance: { ...a.provenance, captureMethod: "somebody_elses_capture" },
  }));
  await assert.rejects(() => backend.send(msg, CALLER), /a2a_prompt_artifact_collision/);
});

test("N2: a genuine retry (only createdAt/sessionId differ) is still accepted", async () => {
  const { backend, msg } = await sendThenCorrupt((a) => ({
    ...a,
    createdAt: "2027-01-01T00:00:00.000Z",
    createdBy: { ...a.createdBy, sessionId: "session.codex.LATER-RUN" },
  }));
  const task = await backend.send(msg, CALLER);
  assert.equal(task.kind, "task"); // reused, not a false collision
});

// ---- N1 ----

test("N1: a revoked peer role makes startup fail loud, not silently re-grant", async () => {
  const fx = createFixture("a2a-n1-revoked");
  try {
    const first = await runA2AServer(fx.runtime, serveCtx(fx), { port: 0 });
    await first.close();
    fx.runtime.identity.revokeRole({
      projectId: fx.projectId,
      actor: fx.owner,
      principalId: "principal.pgvin.codex",
      role: "collaborator",
      idempotencyKey: "revoke-codex-1",
    });
    await assert.rejects(
      () => runA2AServer(fx.runtime, serveCtx(fx), { port: 0 }),
      /a2a_peer_role_not_active/,
    );
  } finally {
    fx.cleanup();
  }
});

// ---- N3 / N6: prove distinct session ids, not just "a send worked" ----

test("N3/N6: two provisioning runs in the same millisecond mint distinct session ids", () => {
  const fx = createFixture("a2a-n3-ids");
  try {
    const input = {
      projectId: fx.projectId,
      owner: fx.owner,
      hostId: fx.host.hostId,
      serverInstanceId: "instance.bridge.a2a",
    };
    // The fixture clock is frozen: both runs observe the same millisecond.
    const first = provisionPeers(fx.runtime, input);
    const second = provisionPeers(fx.runtime, input);
    for (const peer of ["antigravity", "claude", "codex"]) {
      assert.notEqual(
        first.get(peer).sessionId,
        second.get(peer).sessionId,
        `${peer} reused a session id across runs in the same millisecond`,
      );
    }
  } finally {
    fx.cleanup();
  }
});

// ---- F1 ----

test("F1: A2AHttpBoundary refuses a non-loopback bindHost directly", () => {
  const options = (bindHost) => ({
    agentCard: { name: "test" },
    allowedOrigins: ["http://127.0.0.1:1"],
    bindHost,
    resolve: async () => null,
  });
  for (const bindHost of ["0.0.0.0", "::", "10.0.0.5", "example.com"]) {
    assert.throws(() => new A2AHttpBoundary(options(bindHost)), /a2a_http_requires_loopback_bind_host/, bindHost);
  }
  assert.ok(new A2AHttpBoundary(options("127.0.0.1")));
});

// ---- F6 / N5 ----

test("F6: A2AClient refuses a non-loopback endpoint", () => {
  const fetchJson = async () => ({});
  for (const endpoint of ["https://api.example.com/v1", "http://192.168.1.5:4319/a2a", "not-a-url"]) {
    assert.throws(() => new A2AClient({ endpoint, fetchJson }), /a2a_client_requires_loopback_endpoint/, endpoint);
  }
  assert.ok(new A2AClient({ endpoint: "http://127.0.0.1:4319/a2a", fetchJson }));
});

test("N5: the dispatcher takes a peer name — a forged spec cannot supply argv", async () => {
  // There is no longer any way to hand in a command or buildArgs: an unknown peer
  // is the only thing a caller can get wrong, and it is refused.
  await assert.rejects(
    () => dispatchToPeer("curl", "x", async () => ({ stdout: "", stderr: "", code: 0 })),
    /a2a_peer_dispatch_unknown_peer/,
  );
});

test("N5: a flag-shaped prompt cannot become a separate CLI option", async () => {
  const runs = [];
  const out = await dispatchToPeer("codex", "--api-key sk-REAL-SECRET", async (cmd, args, input) => {
    runs.push({ cmd, args, input });
    return { stdout: "ok", stderr: "", code: 0 };
  });
  assert.equal(out.stdout, "ok");
  // The prompt is data on stdin; argv is exactly the frozen flags.
  assert.deepEqual(runs[0].args, ["exec", "--skip-git-repo-check"]);
  assert.equal(runs[0].input, "--api-key sk-REAL-SECRET");
  assert.ok(!runs[0].args.some((a) => a.includes("--api-key")));

  const antigravityArgs = buildPeerArgv(peerCliSpec("antigravity"), "--api-key sk-REAL-SECRET");
  assert.deepEqual(antigravityArgs, [
    "--new-project",
    "--model",
    "Gemini 3.1 Pro (High)",
    "--mode",
    "accept-edits",
    "--dangerously-skip-permissions",
    "--print-timeout",
    "20m",
    "--print=--api-key sk-REAL-SECRET",
  ]);
  assert.ok(!antigravityArgs.includes("--api-key sk-REAL-SECRET"));
  assert.ok(!antigravityArgs.some((a) => /^--api-key(?:=|$)/.test(a)));
});

test("F6: a legitimate prompt containing --token is dispatched, not rejected", async () => {
  const out = await dispatchToPeer("claude", "explain the --token flag", async () => ({
    stdout: "explained",
    stderr: "",
    code: 0,
  }));
  assert.equal(out.stdout, "explained");
});

test("N5: buildPeerArgv uses stdin or binds the prompt to one fixed option value", () => {
  for (const peer of ["claude", "codex"]) {
    const argv = buildPeerArgv(peerCliSpec(peer), "--api-key sk-LEAK");
    assert.ok(!argv.join(" ").includes("sk-LEAK"), `${peer} leaked the prompt into argv`);
  }
  assert.deepEqual(
    buildPeerArgv(peerCliSpec("antigravity"), "--api-key sk-LEAK"),
    [
      "--new-project",
      "--model",
      "Gemini 3.1 Pro (High)",
      "--mode",
      "accept-edits",
      "--dangerously-skip-permissions",
      "--print-timeout",
      "20m",
      "--print=--api-key sk-LEAK",
    ],
  );
});

// ---- F7 ----

test("F7: messages differing only by taskId do not collapse onto one task", async () => {
  const fx = createFixture("a2a-f7-taskid");
  const server = await runA2AServer(fx.runtime, serveCtx(fx), { port: 0 });
  const url = `${server.url}a2a`;
  try {
    const a = await rpc(url, "codex", { jsonrpc: "2.0", id: 1, method: "message/send", params: message("hi", "msg-t", { taskId: "task-a" }) });
    const b = await rpc(url, "codex", { jsonrpc: "2.0", id: 2, method: "message/send", params: message("hi", "msg-t", { taskId: "task-b" }) });
    assert.equal(a.body.error, undefined, JSON.stringify(a.body.error));
    assert.equal(b.body.error, undefined, JSON.stringify(b.body.error));
    assert.notEqual(a.body.result.id, b.body.result.id);
  } finally {
    await server.close();
    fx.cleanup();
  }
});
