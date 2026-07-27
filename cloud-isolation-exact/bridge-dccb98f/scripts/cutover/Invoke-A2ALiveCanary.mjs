// Dedicated, bounded A2A canary for a live Bridge 2 test cutover.
//
// This intentionally leaves the immutable canary job/audit history in place. A
// successful rollback means the synthetic task is cancelled and the exact child
// listener is gone; this script never replaces, copies over, or deletes live DB
// files and never terminates unrelated Node/Bridge processes.

import assert from "node:assert/strict";
import { spawn, spawnSync } from "node:child_process";
import { createHash, randomUUID } from "node:crypto";
import fs from "node:fs";
import path from "node:path";
import { setTimeout as delay } from "node:timers/promises";
import { DatabaseSync } from "node:sqlite";

const options = parseOptions(process.argv.slice(2));
const cutoverPlanPath = regularAbsoluteFile(options["cutover-plan"], "cutover-plan");
const transactionPath = regularAbsoluteFile(options.transaction, "transaction");
const cliPath = regularAbsoluteFile(options.cli, "cli");
const databasePath = regularAbsoluteFile(options.db, "db");
const auditPath = regularAbsoluteFile(options.audit, "audit");
const contextPath = regularAbsoluteFile(options.context, "context");
const doctorConfigPath = regularAbsoluteFile(options["doctor-config"], "doctor-config");
const reportPath = futureAbsoluteFile(options.report, "report");
const recoveryJournalPath = futureAbsoluteFile(`${reportPath}.recovery.jsonl`, "recovery-journal");
let cutoverPlan = readJson(cutoverPlanPath);
let transaction = readJson(transactionPath);
const candidateRoot = normalAbsoluteDirectory(cutoverPlan.candidateRoot, "candidate-root");
const runtimeRoot = normalAbsoluteDirectory(cutoverPlan.runtimeRoot, "runtime-root");
const nodePath = regularAbsoluteFile(cutoverPlan.nodePath, "node");
assert.ok(isWithin(nodePath, runtimeRoot), "canary_node_outside_runtime_root");
assert.equal(path.resolve(process.execPath), nodePath, "canary_must_run_with_planned_node");
assert.deepEqual(process.execArgv, [], "canary_node_exec_arguments_forbidden");
for (const [name, value] of Object.entries(process.env)) {
  if (["NODE_OPTIONS", "NODE_PATH"].includes(name.toUpperCase())) {
    assert.ok(!value, `canary_parent_node_environment_forbidden:${name}`);
  }
}
const nodeEnvironment = pinnedNodeEnvironment();
const transactionRoot = normalAbsoluteDirectory(cutoverPlan.transactionRoot, "transaction-root");
assert.ok(isWithin(transactionPath, transactionRoot), "canary_transaction_outside_plan_root");
const cutoverHarnessPath = regularAbsoluteFile(
  path.join(candidateRoot, "scripts", "cutover", "Invoke-BridgeTestCutover.ps1"),
  "cutover-harness",
);
const systemRoot = normalAbsoluteDirectory(process.env.SystemRoot ?? process.env.WINDIR, "system-root");
const powerShellPath = regularAbsoluteFile(
  path.join(systemRoot, "System32", "WindowsPowerShell", "v1.0", "powershell.exe"),
  "powershell",
);
const context = readJson(contextPath);
assert.equal(typeof context.projectId, "string", "canary_context_project_required");
assert.ok(context.actor && typeof context.actor === "object", "canary_context_actor_required");

const runId = `${new Date().toISOString().replace(/[:.]/g, "-")}-${randomUUID().slice(0, 8)}`;
const messageId = `msg-a2a-live-canary-${runId}`;
const messageParams = {
  message: {
    kind: "message",
    role: "user",
    messageId,
    parts: [{
      kind: "text",
      text: "Synthetic live A2A canary. DO NOT CLAIM OR EXECUTE. Create no external side effects.",
    }],
  },
};
const children = [];
const checks = [];
let activeServer;
let taskId;
let sendAttempted = false;
const recoveryStatus = { attempted: false, succeeded: false, error: null };
let receivedSignal = null;
let activeCutoverLock;
let cutoverLockReleased = false;
let terminalError;
let successReport;

for (const signal of ["SIGINT", "SIGTERM"]) {
  process.once(signal, () => {
    if (receivedSignal === null) receivedSignal = signal;
    process.exitCode = signal === "SIGINT" ? 130 : 143;
    try { appendRecoveryJournal({ phase: "signal_received", signal, taskId: taskId ?? null }); } catch { /* final report retains failure */ }
    for (const server of children) {
      if (server.child.exitCode === null && server.child.signalCode === null) server.child.kill("SIGTERM");
    }
  });
}

try {
  assertCandidateIntegrity(false);
  activeCutoverLock = await acquireCutoverLock();
  const lockedPlan = readJson(cutoverPlanPath);
  const lockedTransaction = readJson(transactionPath);
  assert.deepEqual(lockedPlan, cutoverPlan, "canary_plan_changed_before_lock");
  assert.deepEqual(lockedTransaction, transaction, "canary_transaction_changed_before_lock");
  cutoverPlan = lockedPlan;
  transaction = lockedTransaction;
  appendRecoveryJournal({ phase: "cutover_lock_acquired", lockPath: activeCutoverLock.path });
  successReport = await executeCanary();
  assertCutoverLockHeld();
  assertNoSignal("before_pass_report");
} catch (error) {
  terminalError = error;
}

if (activeCutoverLock) {
  try {
    await releaseCutoverLock(activeCutoverLock);
    cutoverLockReleased = true;
  } catch (releaseError) {
    terminalError = terminalError
      ? new AggregateError([terminalError, releaseError], "a2a_live_canary_and_lock_release_failed")
      : releaseError;
  }
}

if (!terminalError) {
  try { assertNoSignal("after_lock_release"); }
  catch (signalError) { terminalError = signalError; }
}

if (terminalError) {
  const failure = {
    outcome: "fail",
    runId,
    projectId: context.projectId,
    taskId: taskId ?? null,
    messageId,
    cliPath,
    cliSha256: sha256(cliPath),
    nodePath,
    nodeSha256: sha256(nodePath),
    cutoverPlanPath,
    cutoverPlanSha256: sha256(cutoverPlanPath),
    transactionPath,
    transactionSha256: sha256(transactionPath),
    databasePath,
    auditPath,
    reportPath,
    sendAttempted,
    receivedSignal,
    recoveryStatus,
    recoveryJournalPath,
    cutoverLockPath: activeCutoverLock?.path ?? path.join(transactionRoot, ".bridge-test-cutover.lock"),
    cutoverLockReleased,
    listenerStopped: children.every((server) => server.child.exitCode !== null || server.child.signalCode !== null),
    checks,
    error: terminalError instanceof Error ? terminalError.message : String(terminalError),
  };
  try { writeReport(failure); }
  catch (reportError) {
    process.stderr.write(`a2a_live_canary_failure_report_error:${reportError instanceof Error ? reportError.message : String(reportError)}\n`);
  }
  throw terminalError;
}

successReport.cutoverLockReleased = true;
writeReport(successReport);
process.stdout.write(`${JSON.stringify(successReport, null, 2)}\n`);

async function executeCanary() {
validateFrozenCutoverBinding();
const baselineMigrationPlan = runCli(["migration-plan", "--db", databasePath, "--audit", auditPath]);
assert.deepEqual(baselineMigrationPlan.pending, [], "canary_preflight_pending_migrations");
assertNoSignal("after_preflight_migration_plan");
const baselineDoctor = runCli([
  "doctor", "--config", doctorConfigPath, "--db", databasePath, "--audit", auditPath,
]);
assertDoctorGates(baselineDoctor, "preflight");
await delay(0);
assertNoSignal("after_preflight_doctor");
checks.push("preflight migration plan was empty and Doctor had zero failures");
appendRecoveryJournal({
  phase: "prepared",
  runId,
  messageId,
  projectId: context.projectId,
  messageParams,
  transactionPath,
  candidateCommit: cutoverPlan.candidateCommit,
});
assert.equal(receivedSignal, null, `canary_signal_before_start:${receivedSignal}`);

try {
  activeServer = await startServer();
  assert.equal(receivedSignal, null, `canary_signal_after_listener_start:${receivedSignal}`);
  const cardResponse = await fetchWithTimeout(`${activeServer.url}.well-known/agent-card.json`);
  assert.equal(cardResponse.status, 200, "canary_agent_card_http_status");
  const card = await cardResponse.json();
  assert.equal(card.url, `${activeServer.url}a2a`, "canary_agent_card_url_mismatch");
  assert.equal(card.protocolVersion, "0.3.0", "canary_agent_card_protocol_version_mismatch");
  assert.equal(card.capabilities.streaming, false, "canary_agent_card_streaming_overclaim");
  checks.push("loopback Agent Card matched the spawned listener");

  validateFrozenCutoverBinding();
  assertNoSignal("before_send");
  sendAttempted = true;
  const sent = await rpc(activeServer.url, 1, "message/send", messageParams);
  assert.equal(sent.error, undefined, JSON.stringify(sent.error));
  assert.equal(sent.result?.status?.state, "submitted", "canary_task_not_submitted");
  taskId = sent.result.id;
  assert.match(taskId, /^job\.a2a-/u, "canary_task_id_invalid");
  appendRecoveryJournal({ phase: "sent", taskId });

  const fetched = await rpc(activeServer.url, 2, "tasks/get", { id: taskId });
  assert.equal(fetched.result?.id, taskId, "canary_get_task_mismatch");
  assert.equal(fetched.result?.status?.state, "submitted", "canary_get_not_submitted");

  const cancelled = await rpc(activeServer.url, 3, "tasks/cancel", { id: taskId });
  assert.equal(cancelled.result?.id, taskId, "canary_cancel_task_mismatch");
  assert.equal(cancelled.result?.status?.state, "canceled", "canary_task_not_canceled");

  const finalTask = await rpc(activeServer.url, 4, "tasks/get", { id: taskId });
  assert.equal(finalTask.result?.status?.state, "canceled", "canary_get_not_canceled");
  appendRecoveryJournal({ phase: "cancelled", taskId });
  checks.push("unique send/get/cancel/get-canceled lifecycle passed");
} catch (error) {
  if (sendAttempted) {
    recoveryStatus.attempted = true;
    try {
      taskId = await recoverAndCancel(taskId);
      recoveryStatus.succeeded = true;
      appendRecoveryJournal({ phase: "recovery_cancelled", taskId });
      checks.push("failure recovery recovered the idempotent task and cancelled it");
    } catch (recoveryError) {
      recoveryStatus.error = recoveryError instanceof Error ? recoveryError.message : String(recoveryError);
    }
  }
  throw error;
} finally {
  const teardownErrors = [];
  for (const server of children.reverse()) {
    try { await stopServer(server); }
    catch (teardownError) { teardownErrors.push(teardownError); }
  }
  activeServer = undefined;
  appendRecoveryJournal({ phase: "listeners_stopped", stopped: teardownErrors.length === 0 });
  if (teardownErrors.length > 0) throw new AggregateError(teardownErrors, "a2a_live_canary_teardown_failed");
}
assertNoSignal("after_listener_teardown");

const database = new DatabaseSync(databasePath, { readOnly: true });
try {
  const job = database.prepare(
    "SELECT project_id, status, active_claim_id FROM review_jobs WHERE job_id = ?",
  ).get(taskId);
  assert.equal(job?.project_id, context.projectId, "canary_job_project_mismatch");
  assert.equal(job?.status, "cancelled", "canary_job_not_cancelled");
  assert.equal(job?.active_claim_id, null, "canary_job_still_claimed");
  const activeClaims = Number(database.prepare(
    "SELECT COUNT(*) AS count FROM job_claims WHERE job_id = ? AND status = 'active'",
  ).get(taskId).count);
  assert.equal(activeClaims, 0, "canary_active_claim_remains");
  const canaryAdapterInvocations = Number(database.prepare(
    "SELECT COUNT(*) AS count FROM adapter_invocations WHERE job_id = ?",
  ).get(taskId).count);
  assert.equal(canaryAdapterInvocations, 0, "canary_dispatched_adapter_unexpectedly");
  const integrity = Object.values(database.prepare("PRAGMA integrity_check").get())[0];
  assert.equal(integrity, "ok", "canary_sqlite_integrity_failed");
  checks.push("durable job is cancelled, unclaimed, provider-free, and SQLite integrity is clean");
} finally {
  database.close();
}

const migrationPlan = runCli(["migration-plan", "--db", databasePath, "--audit", auditPath]);
assert.deepEqual(migrationPlan.pending, [], "canary_pending_migrations");
assertNoSignal("after_postflight_migration_plan");
const doctor = runCli([
  "doctor", "--config", doctorConfigPath, "--db", databasePath, "--audit", auditPath,
]);
const failures = assertDoctorGates(doctor, "postflight");
await delay(0);
assertNoSignal("after_postflight_doctor");
assertCutoverLockHeld();
checks.push("migration plan is empty and Doctor has zero failures with event/audit chains passing");

const report = {
  outcome: "pass",
  runId,
  projectId: context.projectId,
  taskId,
  messageId,
  cliPath,
  cliSha256: sha256(cliPath),
  nodePath,
  nodeSha256: sha256(nodePath),
  cutoverPlanPath,
  cutoverPlanSha256: sha256(cutoverPlanPath),
  transactionPath,
  transactionSha256: sha256(transactionPath),
  cutoverLockPath: activeCutoverLock.path,
  candidateCommit: cutoverPlan.candidateCommit,
  candidateDistSha256: cutoverPlan.candidateDistSha256,
  databasePath,
  auditPath,
  reportPath,
  recoveryJournalPath,
  listenerStopped: true,
  durableHistoryRetained: true,
  canaryAdapterInvocations: 0,
  migrationVersion: migrationPlan.currentVersion,
  doctorRunId: doctor.runId,
  doctorOverall: doctor.overall,
  doctorFailureCount: failures.length,
  checks,
};
return report;
}

async function recoverAndCancel(knownTaskId) {
  let server = children.find((candidate) => candidate.child.exitCode === null && candidate.child.signalCode === null);
  if (!server) server = await startServer(true);
  let recoveredTaskId = knownTaskId;
  if (!recoveredTaskId) {
    const replay = await rpc(server.url, 90, "message/send", messageParams);
    assert.equal(replay.error, undefined, JSON.stringify(replay.error));
    recoveredTaskId = replay.result?.id;
  }
  const current = await rpc(server.url, 91, "tasks/get", { id: recoveredTaskId });
  if (current.result?.status?.state !== "canceled") {
    const cancelled = await rpc(server.url, 92, "tasks/cancel", { id: recoveredTaskId });
    assert.equal(cancelled.result?.status?.state, "canceled", "canary_recovery_cancel_failed");
  }
  const finalTask = await rpc(server.url, 93, "tasks/get", { id: recoveredTaskId });
  assert.equal(finalTask.result?.status?.state, "canceled", "canary_recovery_get_not_canceled");
  return recoveredTaskId;
}

function startServer(allowAfterSignal = false) {
  return new Promise((resolveStart, rejectStart) => {
    if (!allowAfterSignal) assert.equal(receivedSignal, null, `canary_signal_before_listener:${receivedSignal}`);
    assertCandidateIntegrity();
    const child = spawn(nodePath, [
      cliPath,
      "serve-a2a",
      "--context", contextPath,
      "--db", databasePath,
      "--audit", auditPath,
      "--port", "0",
    ], {
      cwd: candidateRoot,
      env: nodeEnvironment,
      stdio: ["ignore", "pipe", "pipe"],
      windowsHide: true,
    });
    const server = { child, url: undefined, stdout: "", stderr: "" };
    children.push(server);
    let settled = false;
    const timer = setTimeout(() => {
      if (settled) return;
      settled = true;
      rejectStart(new Error(`a2a_live_canary_start_timeout:${server.stderr || server.stdout}`));
    }, 20_000);
    const inspect = () => {
      if (settled) return;
      const match = server.stderr.match(/a2a ready on (http:\/\/127\.0\.0\.1:\d+\/) project=/u);
      if (!match) return;
      settled = true;
      clearTimeout(timer);
      server.url = match[1];
      resolveStart(server);
    };
    child.stdout.on("data", (chunk) => { server.stdout += chunk.toString(); inspect(); });
    child.stderr.on("data", (chunk) => { server.stderr += chunk.toString(); inspect(); });
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
      rejectStart(new Error(`a2a_live_canary_early_exit:code=${code}:signal=${signal}:${server.stderr || server.stdout}`));
    });
  });
}

async function stopServer(server) {
  if (server.child.exitCode === null && server.child.signalCode === null) {
    const exited = new Promise((resolveExit) => server.child.once("exit", resolveExit));
    server.child.kill("SIGTERM");
    await Promise.race([exited, delay(5_000)]);
    if (server.child.exitCode === null && server.child.signalCode === null) {
      server.child.kill("SIGKILL");
      await Promise.race([exited, delay(5_000)]);
    }
  }
  assert.ok(
    server.child.exitCode !== null || server.child.signalCode !== null,
    `a2a_live_canary_child_did_not_exit:pid=${server.child.pid}`,
  );
  if (server.url) await assertListenerClosed(server.url);
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
  throw new Error(`a2a_live_canary_listener_still_open:${url}`);
}

async function rpc(rootUrl, id, method, params) {
  assertCutoverLockHeld();
  const response = await fetchWithTimeout(`${rootUrl}a2a`, {
    method: "POST",
    headers: { "content-type": "application/json", "x-bridge-peer": "codex" },
    body: JSON.stringify({ jsonrpc: "2.0", id, method, params }),
  });
  assertCutoverLockHeld();
  assert.equal(response.status, 200, `canary_rpc_http_status:${method}:${response.status}`);
  return response.json();
}

function fetchWithTimeout(url, init = {}, timeoutMs = 5_000) {
  return fetch(url, { ...init, signal: AbortSignal.timeout(timeoutMs) });
}

function runCli(args) {
  assertCandidateIntegrity();
  const result = spawnSync(nodePath, [cliPath, ...args], {
    cwd: candidateRoot,
    env: nodeEnvironment,
    encoding: "utf8",
    timeout: 60_000,
    windowsHide: true,
    stdio: ["ignore", "pipe", "pipe"],
  });
  assertCutoverLockHeld();
  assert.equal(result.error, undefined, `canary_cli_spawn_failed:${result.error?.message}`);
  assert.equal(result.status, 0, `canary_cli_failed:${args[0]}:${result.stderr || result.stdout}`);
  return JSON.parse(result.stdout);
}

function pinnedNodeEnvironment() {
  const environment = {};
  for (const [name, value] of Object.entries(process.env)) {
    if (name.toUpperCase().startsWith("NODE_")) continue;
    environment[name] = value;
  }
  environment.NO_COLOR = "1";
  return Object.freeze(environment);
}

function acquireCutoverLock() {
  return new Promise((resolveLock, rejectLock) => {
    const lockPath = path.join(transactionRoot, ".bridge-test-cutover.lock");
    if (fs.existsSync(lockPath)) {
      const stat = fs.lstatSync(lockPath);
      assert.ok(stat.isFile() && !stat.isSymbolicLink(), "canary_cutover_lock_path_invalid");
    }
    const child = spawn(powerShellPath, [
      "-NoLogo", "-NoProfile", "-NonInteractive", "-ExecutionPolicy", "Bypass",
      "-File", cutoverHarnessPath,
      "-Action", "HoldLock",
      "-TransactionRoot", transactionRoot,
    ], {
      cwd: candidateRoot,
      env: { ...process.env },
      stdio: ["pipe", "pipe", "pipe"],
      windowsHide: true,
    });
    const lock = { child, path: lockPath, stdout: "", stderr: "", failure: null, releasing: false };
    let settled = false;
    const timer = setTimeout(() => {
      if (settled) return;
      settled = true;
      child.kill("SIGTERM");
      rejectLock(new Error(`canary_cutover_lock_timeout:${lock.stderr || lock.stdout}`));
    }, 10_000);
    child.stdout.on("data", (chunk) => {
      lock.stdout += chunk.toString();
      if (settled || !lock.stdout.includes("BRIDGE_TEST_CUTOVER_LOCK_READY")) return;
      settled = true;
      clearTimeout(timer);
      resolveLock(lock);
    });
    child.stderr.on("data", (chunk) => { lock.stderr += chunk.toString(); });
    child.once("error", (error) => {
      if (settled) {
        lock.failure = error.message;
        return;
      }
      settled = true;
      clearTimeout(timer);
      rejectLock(error);
    });
    child.once("exit", (code, signal) => {
      if (!settled) {
        settled = true;
        clearTimeout(timer);
        rejectLock(new Error(`canary_cutover_lock_early_exit:code=${code}:signal=${signal}:${lock.stderr || lock.stdout}`));
        return;
      }
      if (lock.releasing) return;
      lock.failure = `canary_cutover_lock_lost:code=${code}:signal=${signal}:${lock.stderr || lock.stdout}`;
      for (const server of children) {
        if (server.child.exitCode === null && server.child.signalCode === null) server.child.kill("SIGTERM");
      }
    });
  });
}

async function releaseCutoverLock(lock) {
  lock.releasing = true;
  if (lock.child.exitCode === null && lock.child.signalCode === null) {
    const exited = new Promise((resolveExit) => lock.child.once("exit", resolveExit));
    lock.child.stdin.end("release\n");
    const cleanExit = await Promise.race([exited.then(() => true), delay(5_000).then(() => false)]);
    if (!cleanExit && lock.child.exitCode === null && lock.child.signalCode === null) {
      lock.child.kill("SIGTERM");
      await Promise.race([exited, delay(5_000)]);
    }
  }
  assert.ok(
    lock.child.exitCode !== null || lock.child.signalCode !== null,
    `canary_cutover_lock_helper_did_not_exit:pid=${lock.child.pid}`,
  );
  assert.equal(lock.child.exitCode, 0, `canary_cutover_lock_release_failed:${lock.stderr || lock.stdout}`);
  assert.equal(lock.failure, null, lock.failure ?? "canary_cutover_lock_failure");
}

function assertCutoverLockHeld() {
  assert.ok(activeCutoverLock, "canary_cutover_lock_not_acquired");
  assert.equal(activeCutoverLock.failure, null, activeCutoverLock.failure ?? "canary_cutover_lock_failure");
  assert.ok(
    activeCutoverLock.child.exitCode === null && activeCutoverLock.child.signalCode === null,
    "canary_cutover_lock_not_held",
  );
}

function assertNoSignal(label) {
  assert.equal(receivedSignal, null, `canary_signal_${label}:${receivedSignal}`);
}

function parseOptions(tokens) {
  const parsed = {};
  for (let index = 0; index < tokens.length; index += 2) {
    const flag = tokens[index];
    const value = tokens[index + 1];
    assert.match(flag ?? "", /^--[a-z-]+$/u, "canary_option_invalid");
    assert.ok(value && !value.startsWith("--"), `canary_option_value_missing:${flag}`);
    const name = flag.slice(2);
    assert.equal(parsed[name], undefined, `canary_option_duplicate:${name}`);
    parsed[name] = value;
  }
  for (const name of ["cutover-plan", "transaction", "cli", "db", "audit", "context", "doctor-config", "report"]) {
    assert.equal(typeof parsed[name], "string", `canary_option_required:${name}`);
  }
  assert.deepEqual(Object.keys(parsed).sort(), ["audit", "cli", "context", "cutover-plan", "db", "doctor-config", "report", "transaction"]);
  return parsed;
}

function validateFrozenCutoverBinding() {
  assertCutoverLockHeld();
  assert.equal(cutoverPlan.schemaVersion, "bridge2-windows-test-cutover-v1", "canary_cutover_plan_schema_invalid");
  const stateRoot = normalAbsoluteDirectory(cutoverPlan.stateRoot, "state-root");
  assert.equal(cliPath, path.resolve(cutoverPlan.cutoverCliPath), "canary_cli_not_cutover_candidate");
  assert.match(cutoverPlan.candidateCommit ?? "", /^[0-9a-f]{40}$/u, "canary_candidate_commit_invalid");
  assertCandidateIntegrity();

  assert.equal(transaction.schemaVersion, "bridge2-windows-cutover-transaction-v1", "canary_transaction_schema_invalid");
  assert.equal(transaction.status, "committed", "canary_transaction_not_committed");
  assert.equal(path.resolve(transaction.planPath), cutoverPlanPath, "canary_transaction_plan_path_mismatch");
  assert.equal(transaction.planSha256, sha256(cutoverPlanPath), "canary_transaction_plan_hash_mismatch");
  assert.equal(transaction.serverName, cutoverPlan.serverName, "canary_transaction_server_name_mismatch");
  for (const [field, expected] of Object.entries({
    stateRoot,
    candidateRoot,
    runtimeRoot,
    transactionRoot,
    candidateCommit: cutoverPlan.candidateCommit,
    candidateDistSha256: cutoverPlan.candidateDistSha256,
    cliPath,
    cliSha256: cutoverPlan.cutoverCliSha256,
    nodePath,
    nodeSha256: cutoverPlan.nodeSha256,
    candidateBridgeId: cutoverPlan.candidateBridgeId,
  })) {
    assert.equal(pathField(field) ? path.resolve(transaction[field]) : transaction[field], pathField(field) ? path.resolve(expected) : expected, `canary_transaction_${field}_mismatch`);
  }
  assert.equal(databasePath, path.join(stateRoot, "state", "bridge2.sqlite"), "canary_live_database_path_mismatch");
  assert.equal(auditPath, path.join(stateRoot, "audit", "events.jsonl"), "canary_live_audit_path_mismatch");
  assert.equal(contextPath, path.join(stateRoot, "config", "context.json"), "canary_live_context_path_mismatch");
  assert.equal(path.dirname(doctorConfigPath), path.join(stateRoot, "config"), "canary_doctor_config_root_mismatch");

  const mcpConfigPath = regularAbsoluteFile(cutoverPlan.mcpConfigPath, "mcp-config");
  const cutoverStatePath = regularAbsoluteFile(cutoverPlan.cutoverStatePath, "cutover-state");
  assert.equal(path.resolve(transaction.configPath), mcpConfigPath, "canary_transaction_config_path_mismatch");
  assert.equal(path.resolve(transaction.statePath), cutoverStatePath, "canary_transaction_state_path_mismatch");
  assert.equal(sha256(mcpConfigPath), transaction.testConfigSha256, "canary_live_config_hash_mismatch");
  assert.equal(sha256(cutoverStatePath), transaction.testStateSha256, "canary_live_cutover_state_hash_mismatch");

  const expectedEntrypoint = path.join(candidateRoot, "dist", "server.js");
  assert.equal(path.resolve(cutoverPlan.candidateMcpEntrypoint), expectedEntrypoint, "canary_candidate_entrypoint_path_mismatch");
  assert.equal(sha256(regularAbsoluteFile(expectedEntrypoint, "candidate-entrypoint")), cutoverPlan.candidateMcpEntrypointSha256, "canary_candidate_entrypoint_hash_mismatch");
  const candidateEntry = cutoverPlan.candidateEntry;
  assert.deepEqual(Object.keys(candidateEntry).sort(), ["args", "command", "env", "type"], "canary_candidate_entry_fields_invalid");
  assert.equal(candidateEntry.type, "stdio", "canary_candidate_entry_type_invalid");
  assert.equal(path.resolve(candidateEntry.command), path.resolve(cutoverPlan.nodePath), "canary_candidate_node_path_mismatch");
  assert.deepEqual(candidateEntry.args, [expectedEntrypoint], "canary_candidate_entry_args_invalid");
  const liveConfig = readJson(mcpConfigPath);
  assert.deepEqual(liveConfig.mcpServers?.[cutoverPlan.serverName], candidateEntry, "canary_live_mcp_entry_mismatch");

  const state = readJson(cutoverStatePath);
  assert.equal(state.phase, "test", "canary_requires_test_cutover_phase");
  assert.equal(state.primaryBridgeId, cutoverPlan.candidateBridgeId, "canary_candidate_not_primary");
  const endpoint = state.bridges?.find((bridge) => bridge.bridgeId === cutoverPlan.candidateBridgeId);
  assert.ok(endpoint, "canary_candidate_endpoint_missing");
  assert.equal(endpoint.command, JSON.stringify([candidateEntry.command, ...candidateEntry.args]), "canary_manifest_candidate_command_mismatch");
  assert.equal(path.resolve(endpoint.statePath), databasePath, "canary_manifest_database_path_mismatch");
  assert.equal(path.resolve(endpoint.mcpConfigPath), mcpConfigPath, "canary_manifest_config_path_mismatch");
}

function pathField(field) {
  return ["stateRoot", "candidateRoot", "runtimeRoot", "transactionRoot", "cliPath", "nodePath"].includes(field);
}

function isWithin(candidate, root) {
  const relative = path.relative(path.resolve(root), path.resolve(candidate));
  return relative === "" || (!relative.startsWith("..") && !path.isAbsolute(relative));
}

function assertCandidateIntegrity(requireLock = true) {
  if (requireLock) assertCutoverLockHeld();
  assert.deepEqual(readJson(cutoverPlanPath), cutoverPlan, "canary_cutover_plan_drifted");
  assert.deepEqual(readJson(transactionPath), transaction, "canary_transaction_drifted");
  assert.equal(sha256(cutoverPlanPath), transaction.planSha256, "canary_cutover_plan_hash_drifted");
  const candidateRoot = normalAbsoluteDirectory(cutoverPlan.candidateRoot, "candidate-root");
  assert.match(cutoverPlan.nodeSha256 ?? "", /^[0-9a-f]{64}$/u, "canary_node_hash_invalid");
  assert.equal(sha256(nodePath), cutoverPlan.nodeSha256, "canary_node_runtime_hash_mismatch");
  assert.equal(sha256(cliPath), cutoverPlan.cutoverCliSha256, "canary_cli_hash_mismatch");
  assert.equal(distTreeSha256(candidateRoot), cutoverPlan.candidateDistSha256, "canary_candidate_dist_hash_mismatch");
  assert.equal(runGit(candidateRoot, ["rev-parse", "HEAD"]), cutoverPlan.candidateCommit, "canary_candidate_commit_mismatch");
  assert.equal(runGit(candidateRoot, ["status", "--porcelain", "--untracked-files=normal"]), "", "canary_candidate_not_clean");
}

function assertDoctorGates(doctor, label) {
  const failures = doctor.checks.filter((check) => check.status === "fail");
  assert.deepEqual(failures, [], `canary_${label}_doctor_failures:${JSON.stringify(failures)}`);
  for (const required of ["check.storage.integrity", "check.events.sequence", "check.generation.active"]) {
    assert.equal(
      doctor.checks.find((check) => check.checkId === required)?.status,
      "pass",
      `canary_${label}_doctor_gate_failed:${required}`,
    );
  }
  return failures;
}

function normalAbsoluteDirectory(directoryPath, label) {
  assert.ok(path.isAbsolute(directoryPath), `canary_${label}_path_must_be_absolute`);
  const resolved = path.resolve(directoryPath);
  const stat = fs.lstatSync(resolved);
  assert.ok(stat.isDirectory() && !stat.isSymbolicLink(), `canary_${label}_path_invalid`);
  assertNoReparseAncestors(resolved);
  return resolved;
}

function runGit(cwd, args) {
  const result = spawnSync("git", args, {
    cwd,
    encoding: "utf8",
    timeout: 20_000,
    windowsHide: true,
    stdio: ["ignore", "pipe", "pipe"],
  });
  assert.equal(result.error, undefined, `canary_git_spawn_failed:${result.error?.message}`);
  assert.equal(result.status, 0, `canary_git_failed:${result.stderr || result.stdout}`);
  return result.stdout.trim();
}

function distTreeSha256(candidateRoot) {
  const distRoot = path.join(candidateRoot, "dist");
  const pending = [distRoot];
  const inventory = [];
  while (pending.length) {
    const directory = pending.pop();
    for (const name of fs.readdirSync(directory)) {
      const itemPath = path.join(directory, name);
      const stat = fs.lstatSync(itemPath);
      assert.equal(stat.isSymbolicLink(), false, `canary_candidate_dist_reparse_forbidden:${itemPath}`);
      if (stat.isDirectory()) pending.push(itemPath);
      else if (stat.isFile()) inventory.push(`${path.relative(distRoot, itemPath).split(path.sep).join("/")}\0${sha256(itemPath)}`);
      else assert.fail(`canary_candidate_dist_item_invalid:${itemPath}`);
    }
  }
  inventory.sort();
  return createHash("sha256").update(`${inventory.join("\n")}\n`, "utf8").digest("hex");
}

function regularAbsoluteFile(filePath, label) {
  assert.ok(path.isAbsolute(filePath), `canary_${label}_path_must_be_absolute`);
  const resolved = path.resolve(filePath);
  const stat = fs.lstatSync(resolved);
  assert.ok(stat.isFile() && !stat.isSymbolicLink(), `canary_${label}_path_invalid`);
  assertNoReparseAncestors(resolved);
  return resolved;
}

function futureAbsoluteFile(filePath, label) {
  assert.ok(path.isAbsolute(filePath), `canary_${label}_path_must_be_absolute`);
  const resolved = path.resolve(filePath);
  assert.equal(fs.existsSync(resolved), false, `canary_${label}_already_exists`);
  const parent = fs.lstatSync(path.dirname(resolved));
  assert.ok(parent.isDirectory() && !parent.isSymbolicLink(), `canary_${label}_parent_invalid`);
  assertNoReparseAncestors(path.dirname(resolved));
  return resolved;
}

function assertNoReparseAncestors(targetPath) {
  const resolved = path.resolve(targetPath);
  const root = path.parse(resolved).root;
  let current = root;
  for (const segment of path.relative(root, resolved).split(path.sep).filter(Boolean)) {
    current = path.join(current, segment);
    if (!fs.existsSync(current)) break;
    const stat = fs.lstatSync(current);
    assert.equal(stat.isSymbolicLink(), false, `canary_reparse_path_forbidden:${current}`);
  }
}

function readJson(filePath) {
  return JSON.parse(fs.readFileSync(filePath, "utf8"));
}

function sha256(filePath) {
  return createHash("sha256").update(fs.readFileSync(filePath)).digest("hex");
}

function appendRecoveryJournal(value) {
  const first = !fs.existsSync(recoveryJournalPath);
  const descriptor = fs.openSync(recoveryJournalPath, first ? "ax" : "a", 0o600);
  try {
    fs.writeSync(descriptor, `${JSON.stringify({ at: new Date().toISOString(), ...value })}\n`, null, "utf8");
    fs.fsyncSync(descriptor);
  } finally {
    fs.closeSync(descriptor);
  }
}

function writeReport(value) {
  const descriptor = fs.openSync(reportPath, "wx", 0o600);
  try {
    fs.writeSync(descriptor, `${JSON.stringify(value, null, 2)}\n`, null, "utf8");
    fs.fsyncSync(descriptor);
  } finally {
    fs.closeSync(descriptor);
  }
}
