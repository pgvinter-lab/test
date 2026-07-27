// Process-isolated, localhost-only A2A canary.
//
// This boots the compiled `serve-a2a` CLI twice against a disposable database,
// drives real HTTP requests, and proves that stopping the child removes the
// listener. It never reads or writes a live Bridge project database, cutover
// manifest, MCP configuration, case artifact, credential, or provider API.

import assert from "node:assert/strict";
import { spawn, spawnSync } from "node:child_process";
import { createHash, randomUUID } from "node:crypto";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, isAbsolute, join, relative, resolve, sep } from "node:path";
import { fileURLToPath } from "node:url";
import { setTimeout as delay } from "node:timers/promises";
import { DatabaseSync } from "node:sqlite";

const REPOSITORY_ROOT = fileURLToPath(new URL("../../", import.meta.url));
const CLI = join(REPOSITORY_ROOT, "dist", "v2", "cli", "main.js");
const RUN_ID = `${new Date().toISOString().replace(/[:.]/g, "-")}-${randomUUID().slice(0, 8)}`;
const LOCAL_STATE_ROOT = process.env.LOCALAPPDATA ?? tmpdir();
const CANARY_PARENT = join(LOCAL_STATE_ROOT, "Bridge2", "canaries", "a2a-phase-a");
const LIVE_PROJECTS_ROOT = resolve(LOCAL_STATE_ROOT, "Bridge2", "projects");

mkdirSync(CANARY_PARENT, { recursive: true });
const testbedRoot = mkdtempSync(join(CANARY_PARENT, "run-"));
const databasePath = join(testbedRoot, "state", "bridge2.sqlite");
const auditMirrorPath = join(testbedRoot, "audit", "events.jsonl");
const bootstrapPath = join(testbedRoot, "bootstrap.json");
const contextPath = join(testbedRoot, "serve-context.json");
const reportPath = join(testbedRoot, "canary-report.json");
const candidateStatus = gitStatus();

for (const target of [databasePath, auditMirrorPath]) mkdirSync(dirname(target), { recursive: true });

// A canary must never be nested under the live per-project runtime root.
const relativeToLive = relative(LIVE_PROJECTS_ROOT, resolve(testbedRoot));
assert.ok(
  relativeToLive === ".." || relativeToLive.startsWith(`..${sep}`) || isAbsolute(relativeToLive),
  "canary_testbed_overlaps_live_projects",
);
assert.ok(existsSync(CLI), `compiled CLI missing: ${CLI}`);
const cliSha256 = createHash("sha256").update(readFileSync(CLI)).digest("hex");
if (process.env.BRIDGE_CANARY_REQUIRE_CLEAN === "1") {
  assert.equal(candidateStatus, "", "release_canary_requires_clean_candidate");
}

const projectId = "project.a2a.canary";
const now = new Date().toISOString();
const owner = {
  principalId: "principal.a2a.canary.owner",
  sessionId: "session.a2a.canary.owner.001",
  hostId: "host.a2a.canary",
};
const bootstrap = {
  projectId,
  principal: {
    principalId: owner.principalId,
    kind: "human",
    displayName: "A2A Canary Owner",
    issuer: "bridge.a2a.canary",
    subject: "synthetic-owner",
    status: "active",
    createdAt: now,
  },
  host: {
    hostId: owner.hostId,
    instanceId: "instance.a2a.canary.001",
    hostnameHash: "c".repeat(64),
    platform: process.platform === "win32" ? "windows" : process.platform === "darwin" ? "macos" : "linux",
    status: "active",
    registeredAt: now,
  },
  session: {
    sessionId: owner.sessionId,
    principalId: owner.principalId,
    hostId: owner.hostId,
    startedAt: now,
    expiresAt: new Date(Date.now() + 24 * 60 * 60 * 1000).toISOString(),
    status: "active",
    authentication: { method: "local_process", assurance: "local" },
    transportBinding: {
      transport: "stdio",
      transportSessionId: "stdio-a2a-canary-owner-0001",
      serverInstanceId: "instance.a2a.canary.server.001",
    },
  },
  idempotencyKey: `a2a-canary-bootstrap-${RUN_ID}`,
};

writeJson(bootstrapPath, bootstrap);
writeJson(contextPath, { projectId, actor: owner });

const checks = [];
let activeServer;
let firstTaskId;
let secondTaskId;

try {
  const initialized = runCli([
    "init",
    "--config", bootstrapPath,
    "--db", databasePath,
    "--audit", auditMirrorPath,
  ]);
  assert.equal(initialized.ok, true);
  assert.equal(initialized.projectId, projectId);
  checks.push("compiled CLI initialized an isolated SQLite/WAL runtime");

  activeServer = await startServer();
  const firstUrl = activeServer.url;

  const cardResponse = await fetchWithTimeout(`${firstUrl}.well-known/agent-card.json`);
  assert.equal(cardResponse.status, 200);
  const card = await cardResponse.json();
  assert.equal(card.url, `${firstUrl}a2a`);
  assert.equal(card.protocolVersion, "0.3.0");
  assert.equal(card.capabilities.streaming, false);
  const skills = new Set(card.skills.map((skill) => skill.id));
  for (const peer of ["antigravity", "claude", "codex"]) assert.ok(skills.has(`delegate.${peer}`));
  assert.ok(!skills.has("delegate.gemini"));
  checks.push("Agent Card advertised the three approved peers on the actual loopback port");

  const hostileOrigin = await fetchWithTimeout(`${firstUrl}.well-known/agent-card.json`, {
    headers: { origin: "https://hostile.invalid" },
  });
  assert.equal(hostileOrigin.status, 403);

  const noPeer = await post(firstUrl, undefined, rpcRequest(1, "tasks/get", { id: "job.synthetic.missing" }));
  assert.equal(noPeer.status, 401);
  const badPeer = await post(firstUrl, "stranger", rpcRequest(2, "tasks/get", { id: "job.synthetic.missing" }));
  assert.equal(badPeer.status, 401);
  checks.push("origin and peer-identity boundaries rejected hostile or unauthenticated callers");

  const malformed = await postRaw(firstUrl, "codex", "{");
  assert.equal(malformed.status, 200);
  assert.equal(malformed.body.error.code, -32700);

  const oversized = await fetchWithTimeout(`${firstUrl}a2a`, {
    method: "POST",
    headers: { "content-type": "application/octet-stream", "x-bridge-peer": "codex" },
    body: Buffer.alloc(1_048_577, 120),
    duplex: "half",
  });
  assert.equal(oversized.status, 413);
  checks.push("malformed and oversized requests failed closed");

  const message = {
    message: {
      kind: "message",
      role: "user",
      messageId: `msg-canary-${RUN_ID}`,
      parts: [{ kind: "text", text: "Synthetic A2A canary only. Create no external side effects." }],
    },
  };
  const firstSend = await post(firstUrl, "codex", rpcRequest(10, "message/send", message));
  assert.equal(firstSend.status, 200);
  assert.equal(firstSend.body.error, undefined, JSON.stringify(firstSend.body.error));
  assert.equal(firstSend.body.result.status.state, "submitted");
  firstTaskId = firstSend.body.result.id;

  const duplicate = await post(firstUrl, "codex", rpcRequest(11, "message/send", message));
  assert.equal(duplicate.body.result.id, firstTaskId);

  const otherPeer = await post(firstUrl, "claude", rpcRequest(12, "message/send", message));
  assert.equal(otherPeer.body.error, undefined, JSON.stringify(otherPeer.body.error));
  secondTaskId = otherPeer.body.result.id;
  assert.notEqual(secondTaskId, firstTaskId);

  const get = await post(firstUrl, "codex", rpcRequest(13, "tasks/get", { id: firstTaskId }));
  assert.equal(get.body.result.id, firstTaskId);
  assert.equal(get.body.result.status.state, "submitted");

  const cancel = await post(firstUrl, "codex", rpcRequest(14, "tasks/cancel", { id: firstTaskId }));
  assert.equal(cancel.body.result.status.state, "canceled");
  checks.push("real HTTP send/get/cancel worked; retries were idempotent and peer task IDs stayed isolated");

  await stopServer(activeServer);
  activeServer = undefined;
  checks.push("stopping the canary removed its listener before restart");

  activeServer = await startServer();
  const secondUrl = activeServer.url;
  const persisted = await post(secondUrl, "codex", rpcRequest(20, "tasks/get", { id: firstTaskId }));
  assert.equal(persisted.body.result.id, firstTaskId);
  assert.equal(persisted.body.result.status.state, "canceled");

  const replayAfterRestart = await post(secondUrl, "codex", rpcRequest(21, "message/send", message));
  assert.equal(replayAfterRestart.body.result.id, firstTaskId);
  // Bridge idempotency replays the original command response, so message/send
  // returns its original submitted receipt. tasks/get is the authoritative
  // current-state read and must prove that replay did not resurrect the task.
  assert.equal(replayAfterRestart.body.result.status.state, "submitted");
  const persistedAfterReplay = await post(secondUrl, "codex", rpcRequest(22, "tasks/get", { id: firstTaskId }));
  assert.equal(persistedAfterReplay.body.result.status.state, "canceled");

  const cancelSecond = await post(secondUrl, "claude", rpcRequest(23, "tasks/cancel", { id: secondTaskId }));
  assert.equal(cancelSecond.body.result.status.state, "canceled");
  checks.push("restart reused the disposable state safely and preserved task/idempotency history");

  await stopServer(activeServer);
  activeServer = undefined;
  checks.push("rollback check passed: the second canary listener was also fully removed");

  const migrationPlan = runCli(["migration-plan", "--db", databasePath]);
  assert.ok(Number.isInteger(migrationPlan.currentVersion) && migrationPlan.currentVersion > 0);
  assert.deepEqual(migrationPlan.pending, []);

  const database = new DatabaseSync(databasePath, { readOnly: true });
  try {
    const integrity = database.prepare("PRAGMA integrity_check").get();
    assert.equal(Object.values(integrity)[0], "ok");
  } finally {
    database.close();
  }

  const auditLines = readFileSync(auditMirrorPath, "utf8").split(/\r?\n/).filter(Boolean);
  assert.ok(auditLines.length > 0);
  for (const line of auditLines) JSON.parse(line);
  checks.push("migration plan, SQLite integrity, and JSONL audit mirror all verified");

  const report = {
    outcome: "pass",
    runId: RUN_ID,
    candidate: gitHead(),
    candidateDirty: candidateStatus.length > 0,
    candidateStatus,
    cliSha256,
    projectId,
    testbedRoot,
    databasePath,
    auditMirrorPath,
    reportPath,
    serverStarts: 2,
    taskIds: [firstTaskId, secondTaskId],
    auditEntries: auditLines.length,
    livePrimaryTouched: false,
    checks,
  };
  writeJson(reportPath, report);
  process.stdout.write(`A2A CANARY PASSED\n${JSON.stringify(report, null, 2)}\n`);
} catch (error) {
  if (activeServer) {
    try { await stopServer(activeServer); } catch { /* preserve the canary failure */ }
  }
  const report = {
    outcome: "fail",
    runId: RUN_ID,
    candidate: gitHead(),
    candidateDirty: candidateStatus.length > 0,
    candidateStatus,
    cliSha256,
    testbedRoot,
    databasePath,
    auditMirrorPath,
    reportPath,
    livePrimaryTouched: false,
    checks,
    error: error instanceof Error ? error.message : String(error),
  };
  writeJson(reportPath, report);
  throw error;
}

function runCli(args) {
  const result = spawnSync(process.execPath, [CLI, ...args], {
    cwd: REPOSITORY_ROOT,
    encoding: "utf8",
    env: { ...process.env, NO_COLOR: "1" },
    timeout: 30_000,
    windowsHide: true,
  });
  assert.equal(result.error, undefined, `CLI failed to spawn: ${result.error?.message}`);
  assert.equal(result.status, 0, `CLI failed (${args[0]}): ${result.stderr || result.stdout}`);
  return JSON.parse(result.stdout);
}

function startServer() {
  return new Promise((resolveStart, rejectStart) => {
    const child = spawn(process.execPath, [
      CLI,
      "serve-a2a",
      "--context", contextPath,
      "--db", databasePath,
      "--audit", auditMirrorPath,
      "--port", "0",
    ], {
      cwd: REPOSITORY_ROOT,
      env: { ...process.env, NO_COLOR: "1" },
      stdio: ["ignore", "pipe", "pipe"],
      windowsHide: true,
    });

    let stdout = "";
    let stderr = "";
    let settled = false;
    const timer = setTimeout(() => {
      if (settled) return;
      settled = true;
      child.kill("SIGKILL");
      rejectStart(new Error(`a2a_canary_start_timeout: ${stderr || stdout}`));
    }, 20_000);

    const inspect = () => {
      if (settled) return;
      const match = stderr.match(/a2a ready on (http:\/\/127\.0\.0\.1:\d+\/) project=/);
      if (!match) return;
      settled = true;
      clearTimeout(timer);
      resolveStart({ child, url: match[1], logs: () => ({ stdout, stderr }) });
    };

    child.stdout.on("data", (chunk) => { stdout += chunk.toString(); inspect(); });
    child.stderr.on("data", (chunk) => { stderr += chunk.toString(); inspect(); });
    child.once("error", (error) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      rejectStart(error);
    });
    child.once("exit", (code, signal) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      rejectStart(new Error(`a2a_canary_server_exited: code=${code} signal=${signal} ${stderr || stdout}`));
    });
  });
}

async function stopServer(server) {
  const { child, url } = server;
  if (child.exitCode === null && child.signalCode === null) {
    const exited = new Promise((resolveExit) => child.once("exit", resolveExit));
    child.kill("SIGTERM");
    await Promise.race([exited, delay(5_000)]);
    if (child.exitCode === null && child.signalCode === null) {
      child.kill("SIGKILL");
      await Promise.race([exited, delay(5_000)]);
    }
  }
  assert.ok(child.exitCode !== null || child.signalCode !== null, `canary child did not exit: ${JSON.stringify(server.logs())}`);
  await assertListenerClosed(url);
}

async function assertListenerClosed(url) {
  const deadline = Date.now() + 5_000;
  while (Date.now() < deadline) {
    try {
      await fetchWithTimeout(`${url}.well-known/agent-card.json`, {}, 300);
      await delay(100);
    } catch {
      return;
    }
  }
  throw new Error(`a2a_canary_listener_still_open:${url}`);
}

function rpcRequest(id, method, params) {
  return { jsonrpc: "2.0", id, method, params };
}

async function post(rootUrl, peer, body) {
  return postRaw(rootUrl, peer, JSON.stringify(body));
}

async function postRaw(rootUrl, peer, body) {
  const headers = { "content-type": "application/json" };
  if (peer) headers["x-bridge-peer"] = peer;
  const response = await fetchWithTimeout(`${rootUrl}a2a`, { method: "POST", headers, body });
  const text = await response.text();
  return { status: response.status, body: text ? JSON.parse(text) : undefined };
}

function fetchWithTimeout(url, init = {}, timeoutMs = 5_000) {
  return fetch(url, { ...init, signal: AbortSignal.timeout(timeoutMs) });
}

function writeJson(filePath, value) {
  writeFileSync(filePath, `${JSON.stringify(value, null, 2)}\n`, "utf8");
}

function gitHead() {
  const result = spawnSync("git", ["rev-parse", "HEAD"], {
    cwd: REPOSITORY_ROOT,
    encoding: "utf8",
    timeout: 10_000,
    windowsHide: true,
  });
  return result.status === 0 ? result.stdout.trim() : "unknown";
}

function gitStatus() {
  const result = spawnSync("git", ["status", "--porcelain", "--untracked-files=normal"], {
    cwd: REPOSITORY_ROOT,
    encoding: "utf8",
    timeout: 10_000,
    windowsHide: true,
  });
  return result.status === 0 ? result.stdout.trim() : "git-status-unavailable";
}
