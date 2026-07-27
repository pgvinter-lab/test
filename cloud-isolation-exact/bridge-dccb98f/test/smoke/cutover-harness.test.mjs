import assert from "node:assert/strict";
import { execFileSync, spawn, spawnSync } from "node:child_process";
import crypto from "node:crypto";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import test from "node:test";

const harness = path.resolve("scripts/cutover/Invoke-BridgeTestCutover.ps1");

function sha256(filePath) {
  return crypto.createHash("sha256").update(fs.readFileSync(filePath)).digest("hex");
}

function distTreeSha256(candidateRoot) {
  const distRoot = path.join(candidateRoot, "dist");
  const inventory = [];
  const pending = [distRoot];
  while (pending.length > 0) {
    const directory = pending.pop();
    for (const name of fs.readdirSync(directory)) {
      const itemPath = path.join(directory, name);
      const stat = fs.lstatSync(itemPath);
      assert.equal(stat.isSymbolicLink(), false, `synthetic dist reparse forbidden: ${itemPath}`);
      if (stat.isDirectory()) pending.push(itemPath);
      else if (stat.isFile()) inventory.push(`${path.relative(distRoot, itemPath).split(path.sep).join("/")}\0${sha256(itemPath)}`);
    }
  }
  inventory.sort();
  return crypto.createHash("sha256").update(`${inventory.join("\n")}\n`, "utf8").digest("hex");
}

function writeJson(filePath, value) {
  fs.writeFileSync(filePath, `${JSON.stringify(value, null, 2)}\n`);
  return filePath;
}

function git(cwd, args) {
  return execFileSync("git", args, {
    cwd,
    encoding: "utf8",
    windowsHide: true,
    stdio: ["ignore", "pipe", "pipe"],
  }).trim();
}

function nodeCli(cliPath, args) {
  return JSON.parse(execFileSync(process.execPath, [cliPath, ...args], {
    encoding: "utf8",
    windowsHide: true,
    stdio: ["ignore", "pipe", "pipe"],
  }));
}

function invokeHarness(args, { expectFailure = false } = {}) {
  const result = spawnSync("powershell.exe", [
    "-NoLogo", "-NoProfile", "-NonInteractive", "-File", harness, ...args,
  ], {
    encoding: "utf8",
    windowsHide: true,
    stdio: ["ignore", "pipe", "pipe"],
  });
  if (expectFailure) {
    assert.notEqual(result.status, 0, `expected harness failure, stdout=${result.stdout}`);
    return result;
  }
  assert.equal(result.status, 0, `harness failed: ${result.stderr}`);
  return JSON.parse(result.stdout);
}

function startHoldLock(transactionRoot) {
  return new Promise((resolve, reject) => {
    const child = spawn("powershell.exe", [
      "-NoLogo", "-NoProfile", "-NonInteractive", "-File", harness,
      "-Action", "HoldLock", "-TransactionRoot", transactionRoot,
    ], { encoding: "utf8", windowsHide: true, stdio: ["pipe", "pipe", "pipe"] });
    let stdout = "";
    let stderr = "";
    const timer = setTimeout(() => {
      child.kill("SIGTERM");
      reject(new Error(`hold-lock timeout: ${stderr || stdout}`));
    }, 10_000);
    child.stdout.on("data", (chunk) => {
      stdout += chunk.toString();
      if (!stdout.includes("BRIDGE_TEST_CUTOVER_LOCK_READY")) return;
      clearTimeout(timer);
      resolve(child);
    });
    child.stderr.on("data", (chunk) => { stderr += chunk.toString(); });
    child.once("exit", (code, signal) => {
      clearTimeout(timer);
      if (!stdout.includes("BRIDGE_TEST_CUTOVER_LOCK_READY")) {
        reject(new Error(`hold-lock early exit: code=${code} signal=${signal} ${stderr || stdout}`));
      }
    });
  });
}

async function stopHoldLock(child) {
  if (!child || child.exitCode !== null || child.signalCode !== null) return;
  const exited = new Promise((resolve) => child.once("exit", resolve));
  child.stdin.end("release\n");
  await exited;
  assert.equal(child.exitCode, 0);
}

function createSyntheticFixture() {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "bridge-cutover-harness-"));
  const configRoot = path.join(root, "workspace");
  const stateRoot = path.join(root, "state");
  const transactionRoot = path.join(root, "transactions");
  const candidateRoot = path.join(root, "candidate");
  const historicalRoot = path.join(root, "Bridge");
  const historicalJunction = path.join(root, "Codex Connector");
  for (const directory of [configRoot, stateRoot, transactionRoot, candidateRoot, historicalRoot]) fs.mkdirSync(directory);
  fs.mkdirSync(path.join(historicalRoot, "dist"));
  fs.writeFileSync(path.join(historicalRoot, "dist", "server.js"), "// retained synthetic Bridge 1.x\n");
  fs.symlinkSync(historicalRoot, historicalJunction, "junction");

  const recoveryDirectory = path.join(candidateRoot, "dist", "v2", "recovery");
  const coreDirectory = path.join(candidateRoot, "dist", "v2", "core");
  const cliDirectory = path.join(candidateRoot, "dist", "v2", "cli");
  fs.mkdirSync(recoveryDirectory, { recursive: true });
  fs.mkdirSync(coreDirectory, { recursive: true });
  fs.mkdirSync(cliDirectory, { recursive: true });
  fs.copyFileSync(path.resolve("dist/v2/recovery/cutover-service.js"), path.join(recoveryDirectory, "cutover-service.js"));
  for (const file of ["canonical.js", "errors.js", "validation.js"]) {
    fs.copyFileSync(path.resolve("dist/v2/core", file), path.join(coreDirectory, file));
  }
  writeJson(path.join(candidateRoot, "package.json"), { type: "module", private: true });
  const candidateCli = path.join(cliDirectory, "main.js");
  fs.writeFileSync(candidateCli, `
import fs from "node:fs";
import { initializeCutover, readCutover, switchCutover } from "../recovery/cutover-service.js";
const [command, ...tokens] = process.argv.slice(2);
const options = new Map();
for (let index = 0; index < tokens.length; index += 2) options.set(tokens[index], tokens[index + 1]);
let result;
if (command === "cutover-init") result = initializeCutover(JSON.parse(fs.readFileSync(options.get("--config"), "utf8")));
else if (command === "cutover-status") result = readCutover(options.get("--state"));
else if (command === "cutover-switch") result = switchCutover(JSON.parse(fs.readFileSync(options.get("--config"), "utf8")));
else throw new Error("synthetic_cli_command_invalid");
process.stdout.write(JSON.stringify(result));
`);
  const candidateMcpEntrypoint = path.join(candidateRoot, "dist", "server.js");
  fs.writeFileSync(candidateMcpEntrypoint, "// synthetic compatibility MCP entrypoint; never launched\n");
  fs.writeFileSync(path.join(candidateRoot, ".gitignore"), "dist/\n");
  git(candidateRoot, ["init"]);
  git(candidateRoot, ["config", "user.email", "cutover-harness@example.invalid"]);
  git(candidateRoot, ["config", "user.name", "Synthetic Cutover Harness"]);
  git(candidateRoot, ["config", "core.autocrlf", "false"]);
  git(candidateRoot, ["add", "-A"]);
  git(candidateRoot, ["commit", "-m", "synthetic immutable candidate"]);
  const candidateCommit = git(candidateRoot, ["rev-parse", "HEAD"]);

  const databasePath = path.join(stateRoot, "synthetic.sqlite");
  fs.writeFileSync(databasePath, "synthetic database placeholder\n");
  const candidateEntry = {
    type: "stdio",
    command: process.execPath,
    args: [candidateMcpEntrypoint],
    env: { BRIDGE_AGENT: "claude" },
  };
  const candidateCommand = JSON.stringify([candidateEntry.command, ...candidateEntry.args]);
  const originalConfig = Buffer.from(`${JSON.stringify({
    mcpServers: {
      bridge: {
        type: "stdio",
        command: "node",
        args: [path.join(historicalJunction, "dist", "server.js")],
        env: { BRIDGE_AGENT: "claude" },
      },
      untouched: { command: process.execPath, args: [path.join(root, "untouched.js")] },
    },
  }, null, 2)}\n`);
  const configPath = path.join(configRoot, ".mcp.json");
  fs.writeFileSync(configPath, originalConfig);

  const statePath = path.join(stateRoot, "cutover.json");
  const initPath = writeJson(path.join(stateRoot, "cutover-init.json"), {
    statePath,
    projectId: "project.synthetic.cutover-harness",
    primary: {
      bridgeId: "bridge.1x.current",
      version: "1.x",
      command: JSON.stringify([process.execPath, path.join(historicalJunction, "dist", "server.js")]),
      mcpConfigPath: configPath,
    },
    backup: {
      bridgeId: "bridge.2x.candidate",
      version: "2.0",
      command: candidateCommand,
      statePath: databasePath,
      mcpConfigPath: configPath,
    },
    approvalRef: "approval.cutover.synthetic.harness.init",
    reason: "Synthetic shadow attachment for the Windows cutover harness test.",
  });
  nodeCli(candidateCli, ["cutover-init", "--config", initPath]);

  const planPath = path.join(root, "plan.json");
  const plan = {
    schemaVersion: "bridge2-windows-test-cutover-v1",
    configRoot,
    mcpConfigPath: configPath,
    stateRoot,
    cutoverStatePath: statePath,
    candidateRoot,
    candidateCommit,
    runtimeRoot: path.dirname(process.execPath),
    nodePath: process.execPath,
    nodeSha256: sha256(process.execPath),
    cutoverCliPath: candidateCli,
    cutoverCliSha256: sha256(candidateCli),
    candidateMcpEntrypoint,
    candidateMcpEntrypointSha256: sha256(candidateMcpEntrypoint),
    candidateDistSha256: distTreeSha256(candidateRoot),
    serverName: "bridge",
    candidateBridgeId: "bridge.2x.candidate",
    candidateEntry,
    expectedConfigSha256: sha256(configPath),
    expectedStateSha256: sha256(statePath),
    transactionRoot,
    approvalRef: "approval.cutover.synthetic.harness.test",
    reason: "Synthetic monitored test cutover.",
    rollbackApprovalRef: "approval.cutover.synthetic.harness.rollback",
    rollbackReason: "Synthetic rollback to the retained prior configured entry.",
  };
  writeJson(planPath, plan);
  return {
    root, configPath, statePath, transactionRoot, candidateCli, candidateMcpEntrypoint, candidateEntry,
    originalConfig, plan, planPath, historicalRoot, historicalJunction,
    cleanup() { fs.rmSync(root, { recursive: true, force: true }); },
  };
}

test("Windows cutover harness dry-runs, switches an exact MCP entry, and rolls back both files", {
  skip: process.platform !== "win32",
}, () => {
  const fixture = createSyntheticFixture();
  try {
    const originalState = fs.readFileSync(fixture.statePath);
    const dryRun = invokeHarness(["-Action", "Test", "-Plan", fixture.planPath]);
    assert.equal(dryRun.dryRun, true);
    assert.equal(dryRun.applied, false);
    assert.deepEqual(fs.readFileSync(fixture.configPath), fixture.originalConfig);
    assert.deepEqual(fs.readFileSync(fixture.statePath), originalState);
    assert.equal(fs.realpathSync(fixture.historicalJunction), fs.realpathSync(fixture.historicalRoot));
    assert.deepEqual(fs.readdirSync(fixture.transactionRoot), []);

    const applied = invokeHarness(["-Action", "Test", "-Plan", fixture.planPath, "-Apply"]);
    assert.equal(applied.phase, "test");
    assert.equal(applied.primaryBridgeId, "bridge.2x.candidate");
    assert.ok(fs.existsSync(applied.configBackup));
    const committedTransaction = JSON.parse(fs.readFileSync(applied.transactionPath, "utf8"));
    assert.equal(committedTransaction.planPath, path.resolve(fixture.planPath));
    assert.equal(committedTransaction.nodeSha256, sha256(process.execPath));
    assert.equal(committedTransaction.planSha256, sha256(fixture.planPath));
    assert.equal(committedTransaction.serverName, "bridge");
    assert.deepEqual(fs.readFileSync(applied.configBackup), fixture.originalConfig);
    const switchedConfig = JSON.parse(fs.readFileSync(fixture.configPath, "utf8"));
    assert.deepEqual(switchedConfig.mcpServers.bridge, fixture.candidateEntry);
    assert.deepEqual(switchedConfig.mcpServers.untouched, {
      command: process.execPath,
      args: [path.join(fixture.root, "untouched.js")],
    });
    const testStatus = nodeCli(fixture.candidateCli, ["cutover-status", "--state", fixture.statePath]);
    assert.equal(testStatus.phase, "test");
    assert.equal(testStatus.primaryBridgeId, "bridge.2x.candidate");
    assert.equal(testStatus.history.length, 2);
    assert.equal(fs.realpathSync(fixture.historicalJunction), fs.realpathSync(fixture.historicalRoot));

    const rollbackDryRun = invokeHarness(["-Action", "Rollback", "-Transaction", applied.transactionPath]);
    assert.equal(rollbackDryRun.dryRun, true);
    assert.equal(rollbackDryRun.applied, false);
    assert.equal(nodeCli(fixture.candidateCli, ["cutover-status", "--state", fixture.statePath]).phase, "test");

    const rolledBack = invokeHarness(["-Action", "Rollback", "-Transaction", applied.transactionPath, "-Apply"]);
    assert.equal(rolledBack.phase, "rollback");
    assert.equal(rolledBack.rollbackMode, "hash_chained");
    assert.equal(rolledBack.primaryBridgeId, "bridge.1x.current");
    assert.deepEqual(fs.readFileSync(fixture.configPath), fixture.originalConfig);
    const rollbackStatus = nodeCli(fixture.candidateCli, ["cutover-status", "--state", fixture.statePath]);
    assert.equal(rollbackStatus.phase, "rollback");
    assert.equal(rollbackStatus.primaryBridgeId, "bridge.1x.current");
    assert.equal(rollbackStatus.history.length, 3);
    assert.equal(rollbackStatus.history[2].previousHash, rollbackStatus.history[1].entryHash);
    assert.equal(fs.realpathSync(fixture.historicalJunction), fs.realpathSync(fixture.historicalRoot));
    assert.equal(fs.readFileSync(path.join(fixture.historicalRoot, "dist", "server.js"), "utf8"), "// retained synthetic Bridge 1.x\n");

    fixture.plan.expectedConfigSha256 = sha256(fixture.configPath);
    fixture.plan.expectedStateSha256 = sha256(fixture.statePath);
    writeJson(fixture.planPath, fixture.plan);
    const configBeforeFailedApply = fs.readFileSync(fixture.configPath);
    const stateBeforeFailedApply = fs.readFileSync(fixture.statePath);
    execFileSync("attrib", ["+R", fixture.statePath], { windowsHide: true });
    try {
      const failed = invokeHarness(["-Action", "Test", "-Plan", fixture.planPath, "-Apply"], { expectFailure: true });
      assert.match(`${failed.stdout}\n${failed.stderr}`, /test_cutover_failed_restored/);
    } finally {
      execFileSync("attrib", ["-R", fixture.statePath], { windowsHide: true });
    }
    assert.deepEqual(fs.readFileSync(fixture.configPath), configBeforeFailedApply);
    assert.deepEqual(fs.readFileSync(fixture.statePath), stateBeforeFailedApply);
    assert.equal(nodeCli(fixture.candidateCli, ["cutover-status", "--state", fixture.statePath]).phase, "rollback");
  } finally {
    fixture.cleanup();
  }
});

test("Windows cutover harness performs exact-state emergency rollback without invoking drifted candidate code", {
  skip: process.platform !== "win32",
}, () => {
  const fixture = createSyntheticFixture();
  try {
    const originalState = fs.readFileSync(fixture.statePath);
    const applied = invokeHarness(["-Action", "Test", "-Plan", fixture.planPath, "-Apply"]);
    const markerPath = path.join(fixture.root, "drifted-candidate-was-invoked.txt");
    const importedDistFile = path.join(fixture.plan.candidateRoot, "dist", "v2", "core", "canonical.js");
    fs.appendFileSync(importedDistFile, `\nimport syntheticFs from "node:fs";\nsyntheticFs.writeFileSync(${JSON.stringify(markerPath)}, "invoked");\n`);

    const rolledBack = invokeHarness(["-Action", "Rollback", "-Transaction", applied.transactionPath, "-Apply"]);
    assert.equal(rolledBack.rollbackMode, "emergency_exact_state");
    assert.equal(rolledBack.phase, "shadow");
    assert.equal(rolledBack.primaryBridgeId, "bridge.1x.current");
    assert.match(rolledBack.candidateIntegrityFailure, /rollback_candidate_dist_hash_mismatch/);
    assert.equal(fs.existsSync(markerPath), false, "drifted candidate code must never execute during emergency rollback");
    assert.deepEqual(fs.readFileSync(fixture.configPath), fixture.originalConfig);
    assert.deepEqual(fs.readFileSync(fixture.statePath), originalState);
    const restoredState = JSON.parse(fs.readFileSync(fixture.statePath, "utf8"));
    assert.equal(restoredState.phase, "shadow");
    assert.equal(restoredState.primaryBridgeId, "bridge.1x.current");
    const transaction = JSON.parse(fs.readFileSync(applied.transactionPath, "utf8"));
    assert.equal(transaction.status, "rolled_back_emergency_exact_state");
    assert.equal(transaction.rollbackMode, "emergency_exact_state");
  } finally {
    fixture.cleanup();
  }
});

test("Windows cutover harness never re-enables candidate when rollback record persistence fails", {
  skip: process.platform !== "win32",
}, () => {
  const fixture = createSyntheticFixture();
  try {
    const applied = invokeHarness(["-Action", "Test", "-Plan", fixture.planPath, "-Apply"]);
    execFileSync("attrib", ["+R", applied.transactionPath], { windowsHide: true });
    try {
      const failed = invokeHarness(["-Action", "Rollback", "-Transaction", applied.transactionPath, "-Apply"], { expectFailure: true });
      assert.match(`${failed.stdout}\n${failed.stderr}`, /rollback_applied_record_update_failed/);
    } finally {
      execFileSync("attrib", ["-R", applied.transactionPath], { windowsHide: true });
    }
    assert.deepEqual(fs.readFileSync(fixture.configPath), fixture.originalConfig);
    const restoredState = JSON.parse(fs.readFileSync(fixture.statePath, "utf8"));
    assert.equal(restoredState.phase, "rollback");
    assert.equal(restoredState.primaryBridgeId, "bridge.1x.current");
    const staleTransaction = JSON.parse(fs.readFileSync(applied.transactionPath, "utf8"));
    assert.equal(staleTransaction.status, "committed", "record failure must not reverse the already-applied rollback");
  } finally {
    fixture.cleanup();
  }
});

test("Windows cutover harness binds the Node runtime hash before creating a transaction", {
  skip: process.platform !== "win32",
}, () => {
  const fixture = createSyntheticFixture();
  try {
    fixture.plan.nodeSha256 = "0".repeat(64);
    writeJson(fixture.planPath, fixture.plan);
    const failed = invokeHarness(["-Action", "Test", "-Plan", fixture.planPath, "-Apply"], { expectFailure: true });
    assert.match(`${failed.stdout}\n${failed.stderr}`, /node_runtime_hash_mismatch/);
    assert.deepEqual(fs.readFileSync(fixture.configPath), fixture.originalConfig);
    assert.deepEqual(fs.readdirSync(fixture.transactionRoot), []);
  } finally {
    fixture.cleanup();
  }
});

test("Windows cutover lock excludes activation, rollback, and a second canary holder", {
  skip: process.platform !== "win32",
}, async () => {
  const fixture = createSyntheticFixture();
  let holder;
  try {
    const originalState = fs.readFileSync(fixture.statePath);
    holder = await startHoldLock(fixture.transactionRoot);
    const blockedApply = invokeHarness(["-Action", "Test", "-Plan", fixture.planPath, "-Apply"], { expectFailure: true });
    assert.match(`${blockedApply.stdout}\n${blockedApply.stderr}`, /cutover_transaction_lock_held/);
    const blockedHolder = invokeHarness(["-Action", "HoldLock", "-TransactionRoot", fixture.transactionRoot], { expectFailure: true });
    assert.match(`${blockedHolder.stdout}\n${blockedHolder.stderr}`, /cutover_transaction_lock_held/);
    assert.deepEqual(fs.readFileSync(fixture.configPath), fixture.originalConfig);
    assert.deepEqual(fs.readFileSync(fixture.statePath), originalState);
    await stopHoldLock(holder);
    holder = undefined;

    const applied = invokeHarness(["-Action", "Test", "-Plan", fixture.planPath, "-Apply"]);
    const testConfig = fs.readFileSync(fixture.configPath);
    const testState = fs.readFileSync(fixture.statePath);
    holder = await startHoldLock(fixture.transactionRoot);
    const blockedRollback = invokeHarness(["-Action", "Rollback", "-Transaction", applied.transactionPath, "-Apply"], { expectFailure: true });
    assert.match(`${blockedRollback.stdout}\n${blockedRollback.stderr}`, /cutover_transaction_lock_held/);
    assert.deepEqual(fs.readFileSync(fixture.configPath), testConfig);
    assert.deepEqual(fs.readFileSync(fixture.statePath), testState);
    await stopHoldLock(holder);
    holder = undefined;

    const rolledBack = invokeHarness(["-Action", "Rollback", "-Transaction", applied.transactionPath, "-Apply"]);
    assert.equal(rolledBack.primaryBridgeId, "bridge.1x.current");
  } finally {
    await stopHoldLock(holder);
    fixture.cleanup();
  }
});

test("Windows cutover harness rejects candidate drift before creating a transaction", {
  skip: process.platform !== "win32",
}, () => {
  const fixture = createSyntheticFixture();
  try {
    fs.writeFileSync(path.join(fixture.plan.candidateRoot, "untracked-drift.txt"), "drift\n");
    const failed = invokeHarness(["-Action", "Test", "-Plan", fixture.planPath, "-Apply"], { expectFailure: true });
    assert.match(`${failed.stdout}\n${failed.stderr}`, /candidate_worktree_not_clean/);
    assert.deepEqual(fs.readFileSync(fixture.configPath), fixture.originalConfig);
    assert.deepEqual(fs.readdirSync(fixture.transactionRoot), []);
  } finally {
    fixture.cleanup();
  }
});

test("Windows cutover harness rejects drift in ignored imported dist modules", {
  skip: process.platform !== "win32",
}, () => {
  const fixture = createSyntheticFixture();
  try {
    fs.appendFileSync(path.join(fixture.plan.candidateRoot, "dist", "v2", "core", "canonical.js"), "\n// ignored drift\n");
    const failed = invokeHarness(["-Action", "Test", "-Plan", fixture.planPath, "-Apply"], { expectFailure: true });
    assert.match(`${failed.stdout}\n${failed.stderr}`, /candidate_dist_hash_mismatch/);
    assert.deepEqual(fs.readFileSync(fixture.configPath), fixture.originalConfig);
    assert.deepEqual(fs.readdirSync(fixture.transactionRoot), []);
  } finally {
    fixture.cleanup();
  }
});

test("Windows cutover harness rejects unsafe compatibility arguments and environment overrides", {
  skip: process.platform !== "win32",
}, () => {
    const fixture = createSyntheticFixture();
  try {
    const baseEntry = structuredClone(fixture.plan.candidateEntry);
    const cases = [
      {
        name: "extra compatibility argument",
        mutate(entry) { entry.args.push("serve-stdio"); },
        expected: /candidate_args_invalid/,
      },
      {
        name: "wrong MCP entrypoint",
        mutate(entry) { entry.args[0] = path.join(fixture.historicalRoot, "dist", "server.js"); },
        expected: /candidate_entrypoint_not_exact/,
      },
      {
        name: "dropped stdio type",
        mutate(entry) { delete entry.type; },
        expected: /candidate_entry_fields_not_preserved/,
      },
      {
        name: "NODE_OPTIONS override",
        mutate(entry) { entry.env.NODE_OPTIONS = "--require=C:\\untrusted.cjs"; },
        expected: /candidate_env_name_forbidden:NODE_OPTIONS/,
      },
      {
        name: "changed bridge identity",
        mutate(entry) { entry.env.BRIDGE_AGENT = "codex"; },
        expected: /candidate_env_not_preserved/,
      },
    ];
    for (const scenario of cases) {
      const entry = structuredClone(baseEntry);
      scenario.mutate(entry);
      fixture.plan.candidateEntry = entry;
      writeJson(fixture.planPath, fixture.plan);
      const failed = invokeHarness(["-Action", "Test", "-Plan", fixture.planPath], { expectFailure: true });
      assert.match(`${failed.stdout}\n${failed.stderr}`, scenario.expected, scenario.name);
      assert.deepEqual(fs.readFileSync(fixture.configPath), fixture.originalConfig, scenario.name);
      assert.deepEqual(fs.readdirSync(fixture.transactionRoot), [], scenario.name);
    }
  } finally {
    fixture.cleanup();
  }
});
