import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import crypto from "node:crypto";
import fs from "node:fs";
import path from "node:path";
import { DatabaseSync } from "node:sqlite";
import test from "node:test";
import { createFixture } from "./helpers.mjs";

const cli = path.resolve("dist/v2/cli/main.js");

function run(args, env = {}) {
  const stdout = execFileSync(process.execPath, [cli, ...args], {
    cwd: process.cwd(),
    env: { ...process.env, ...env },
    encoding: "utf8",
    windowsHide: true,
    stdio: ["ignore", "pipe", "pipe"],
  });
  return JSON.parse(stdout);
}

function writeJson(filePath, value) {
  fs.writeFileSync(filePath, `${JSON.stringify(value)}\n`);
  return filePath;
}

function git(cwd, args) {
  return execFileSync("git", args, { cwd, encoding: "utf8", windowsHide: true, stdio: ["ignore", "pipe", "pipe"] }).trim();
}

test("recovery and administration CLI commands operate without network or live credentials", () => {
  const fx = createFixture("cli");
  try {
    const sourceRoot = path.join(fx.root, "cli-source");
    fs.mkdirSync(sourceRoot);
    fs.cpSync(path.resolve("contracts"), path.join(sourceRoot, "contracts"), { recursive: true });
    fs.writeFileSync(path.join(sourceRoot, "README.md"), "synthetic CLI recovery source\n");
    git(sourceRoot, ["init"]);
    git(sourceRoot, ["config", "user.email", "synthetic@example.invalid"]);
    git(sourceRoot, ["config", "user.name", "Synthetic Runtime CLI"]);
    git(sourceRoot, ["add", "."]);
    git(sourceRoot, ["commit", "-m", "synthetic CLI source"]);
    const localKeyDirectory = path.join(fx.root, "local-recovery-keys");
    const driveKeyDirectory = path.join(fx.root, "drive-recovery-keys");
    const initializedKeys = run([
      "recovery-key-init",
      "--local-dir", localKeyDirectory,
      "--drive-dir", driveKeyDirectory,
      "--key-name", "bridge2-test-recovery",
    ]);
    assert.equal(initializedKeys.created, true);
    const verifiedKeys = run([
      "recovery-key-verify",
      "--local-dir", localKeyDirectory,
      "--drive-dir", driveKeyDirectory,
      "--key-name", "bridge2-test-recovery",
    ]);
    assert.equal(verifiedKeys.fingerprintSha256, initializedKeys.fingerprintSha256);
    const capsulePath = path.join(driveKeyDirectory, "capsules", "backup.synthetic.cli.json");
    const dataKeyPath = path.join(fx.root, "backup.synthetic.cli.key.b64");
    const capsule = run([
      "capsule-create",
      "--backup-id", "backup.synthetic.cli",
      "--key-ref", "bridge-key://synthetic/cli",
      "--public-key", initializedKeys.localPublicKeyPath,
      "--capsule", capsulePath,
      "--data-key", dataKeyPath,
    ]);
    const keyEnvironment = { BRIDGE2_SYNTHETIC_KEY: fs.readFileSync(dataKeyPath, "ascii").trim() };
    const unwrappedKeyPath = path.join(fx.root, "backup.synthetic.cli.unwrapped.b64");
    const unwrapped = run([
      "capsule-unwrap",
      "--capsule", capsulePath,
      "--private-key", initializedKeys.drivePrivateKeyPath,
      "--data-key", unwrappedKeyPath,
    ]);
    assert.equal(unwrapped.capsuleSha256, capsule.capsuleSha256);
    assert.deepEqual(fs.readFileSync(unwrappedKeyPath), fs.readFileSync(dataKeyPath));
    const recoveryRoot = path.join(fx.root, "cli-recovery");
    const backupConfig = writeJson(path.join(fx.root, "backup.json"), {
      backupId: "backup.synthetic.cli",
      projectId: fx.projectId,
      actor: fx.owner,
      idempotencyKey: "idempotency.cli.backup",
      backupType: "full",
      sourceRoot,
      destinationRoot: recoveryRoot,
      encryption: {
        mode: "aes-256-gcm",
        keyRef: "bridge-key://synthetic/cli",
        wrappedKeyCapsule: {
          capsuleRef: "drive://recovery-key-account/bridge2/key-capsules/cli.wrap",
          storageAccountRef: "drive-account://recovery-key-account",
          wrappingAlgorithmId: capsule.wrappingAlgorithmId,
          recoveryProcedureRef: "drive://recovery-key-account/bridge2/KEY-RECOVERY.md",
          decryptionSecretCustody: "local_and_drive",
          recipientKeyFingerprint: capsule.recipientKeyFingerprint,
          capsuleSha256: capsule.capsuleSha256,
        },
      },
    });
    const doctorConfig = writeJson(path.join(fx.root, "doctor.json"), {
      projectId: fx.projectId,
      hostId: fx.owner.hostId,
      actor: fx.owner,
      transport: {
        transport: "stdio",
        transportSessionId: fx.ownerSession.transportBinding.transportSessionId,
        serverInstanceId: fx.ownerSession.transportBinding.serverInstanceId,
      },
      sourceRoot,
      recoveryRoot,
    });
    fx.runtime.close();

    const backup = run([
      "backup", "--db", fx.databasePath, "--audit", fx.auditMirrorPath,
      "--config", backupConfig, "--key-file", dataKeyPath, "--capsule", capsulePath,
    ]);
    assert.equal(backup.backupId, "backup.synthetic.cli");
    const manifestPath = path.join(recoveryRoot, backup.backupId, "manifest.json");
    assert.equal(run(["verify-backup", "--manifest", manifestPath]).backupId, backup.backupId);
    const doctor = run(["doctor", "--db", fx.databasePath, "--audit", fx.auditMirrorPath, "--config", doctorConfig]);
    assert.equal(doctor.mode, "read_only");
    assert.deepEqual(run(["migration-plan", "--db", fx.databasePath]).pending, []);

    const restoreDestination = path.join(fx.root, "cli-restore");
    const restoreConfig = writeJson(path.join(fx.root, "restore.json"), {
      restoreId: "restore.synthetic.cli",
      projectId: fx.projectId,
      actor: fx.owner,
      idempotencyKey: "idempotency.cli.restore",
      manifestPath,
      destination: restoreDestination,
      targetHostId: "host.synthetic.cli-restore",
      mode: "recovery_drill",
    });
    const restore = run([
      "restore", "--db", fx.databasePath, "--audit", fx.auditMirrorPath,
      "--config", restoreConfig, "--capsule", capsulePath,
      "--private-key", initializedKeys.localPrivateKeyPath,
    ]);
    assert.equal(restore.manifest.status, "completed");
    const restoredState = new DatabaseSync(path.join(restoreDestination, "state.sqlite"), { readOnly: true });
    try {
      assert.equal(restoredState.prepare("SELECT status FROM projects WHERE project_id = ?").get(fx.projectId).status, "read_only");
      const record = restoredState.prepare("SELECT manifest_json FROM restore_manifests WHERE restore_id = ?")
        .get(restore.manifest.restoreId);
      assert.equal(JSON.parse(record.manifest_json).targetHostId, restore.manifest.targetHostId);
    } finally {
      restoredState.close();
    }

    const offlineDestination = path.join(fx.root, "cli-offline-restore");
    const offlineConfig = writeJson(path.join(fx.root, "offline-restore.json"), {
      restoreId: "restore.synthetic.cli-offline",
      projectId: fx.projectId,
      actor: fx.owner,
      idempotencyKey: "idempotency.cli.restore-offline",
      manifestPath,
      destination: offlineDestination,
      targetHostId: "host.synthetic.cli-offline",
      mode: "new_host",
    });
    const unavailableDatabase = `${fx.databasePath}.offline-unavailable`;
    fs.renameSync(fx.databasePath, unavailableDatabase);
    try {
      const offline = run([
        "recover-offline", "--config", offlineConfig, "--capsule", capsulePath,
        "--private-key", initializedKeys.drivePrivateKeyPath,
      ]);
      assert.equal(offline.manifest.status, "completed");
      assert.equal(offline.manifest.takeover.mode, "no_takeover");
      assert.ok(fs.existsSync(path.join(offlineDestination, "state.sqlite")));
      assert.ok(fs.existsSync(path.join(offlineDestination, ".bridge2-restore-request-hash")));
      const offlineState = new DatabaseSync(path.join(offlineDestination, "state.sqlite"), { readOnly: true });
      try {
        assert.equal(offlineState.prepare("SELECT status FROM projects WHERE project_id = ?").get(fx.projectId).status, "read_only");
        assert.equal(offlineState.prepare("SELECT status FROM restore_manifests WHERE restore_id = ?")
          .get(offline.manifest.restoreId).status, "completed");
      } finally {
        offlineState.close();
      }
      assert.equal(fs.existsSync(path.join(
        path.dirname(offlineDestination),
        `.${path.basename(offlineDestination)}.restore.synthetic.cli-offline.partial`,
      )), false);
      assert.deepEqual(
        run([
          "recover-offline", "--config", offlineConfig, "--capsule", capsulePath,
          "--private-key", initializedKeys.drivePrivateKeyPath,
        ]),
        offline,
      );
    } finally {
      fs.renameSync(unavailableDatabase, fx.databasePath);
    }

    const takeoverConfig = writeJson(path.join(fx.root, "takeover.json"), {
      projectId: fx.projectId,
      actor: fx.owner,
      expectedGeneration: 1,
      newGeneration: 2,
      approvalRef: "approval.takeover.synthetic.cli",
      reason: "Synthetic CLI recovery takeover.",
      idempotencyKey: "idempotency.cli.takeover",
    });
    assert.equal(run(["takeover", "--db", fx.databasePath, "--audit", fx.auditMirrorPath, "--config", takeoverConfig]).generation, 2);
    assert.equal(run(["audit-project", "--db", fx.databasePath, "--audit", fx.auditMirrorPath]).ok, true);

    const plaintext = path.join(fx.root, "manual-plaintext.txt");
    const encrypted = path.join(fx.root, "manual-envelope.enc");
    const decrypted = path.join(fx.root, "manual-decrypted.txt");
    fs.writeFileSync(plaintext, "synthetic manual recovery encryption\n");
    run(["encrypt", "--input", plaintext, "--output", encrypted, "--key-env", "BRIDGE2_SYNTHETIC_KEY"], keyEnvironment);
    run(["decrypt", "--input", encrypted, "--output", decrypted, "--key-env", "BRIDGE2_SYNTHETIC_KEY"], keyEnvironment);
    assert.deepEqual(fs.readFileSync(decrypted), fs.readFileSync(plaintext));

    const dirtyDestination = path.join(fx.root, "manual-dirty-restore");
    fs.mkdirSync(dirtyDestination);
    git(dirtyDestination, ["init"]);
    git(dirtyDestination, ["config", "user.email", "synthetic@example.invalid"]);
    git(dirtyDestination, ["config", "user.name", "Synthetic Dirty Restore"]);
    fs.writeFileSync(path.join(dirtyDestination, "README.md"), "dirty restore baseline\n");
    git(dirtyDestination, ["add", "README.md"]);
    git(dirtyDestination, ["commit", "-m", "dirty restore baseline"]);
    const dirtyBaseCommit = git(dirtyDestination, ["rev-parse", "HEAD"]);
    const dirtyBytes = Buffer.from([0, 1, 2, 10, 13, 255]);
    const dirtyArchive = writeJson(path.join(fx.root, "manual-dirty.json"), {
      schemaVersion: "bridge2-dirty-worktree-v1",
      baseCommit: dirtyBaseCommit,
      entries: [{
        path: "nested/exact.bin",
        state: "present",
        kind: "file",
        sizeBytes: dirtyBytes.length,
        sha256: crypto.createHash("sha256").update(dirtyBytes).digest("hex"),
        executable: false,
        contentBase64: dirtyBytes.toString("base64"),
      }],
    });
    assert.deepEqual(run(["restore-dirty-worktree", "--archive", dirtyArchive, "--destination", dirtyDestination]), { restored: 1, deleted: 0 });
    assert.deepEqual(fs.readFileSync(path.join(dirtyDestination, "nested", "exact.bin")), dirtyBytes);

    const cutoverState = path.join(fx.root, "bridge-cutover.json");
    const cutoverInit = writeJson(path.join(fx.root, "cutover-init.json"), {
      statePath: cutoverState,
      projectId: fx.projectId,
      primary: {
        bridgeId: "bridge.1x",
        version: "1.x",
        command: "bridge serve",
        statePath: path.join(fx.root, "bridge1"),
      },
      backup: {
        bridgeId: "bridge.2x",
        version: "2.0",
        command: "bridge-v2 serve-stdio",
        statePath: fx.databasePath,
      },
      approvalRef: "approval.cutover.synthetic.init",
      reason: "Attach Bridge 2.0 as backup while Bridge 1.x remains primary.",
    });
    const shadow = run(["cutover-init", "--config", cutoverInit]);
    assert.equal(shadow.phase, "shadow");
    assert.equal(shadow.primaryBridgeId, "bridge.1x");
    assert.equal(shadow.bridges.find((bridge) => bridge.bridgeId === "bridge.1x").writable, true);
    assert.equal(shadow.bridges.find((bridge) => bridge.bridgeId === "bridge.2x").writable, false);
    assert.deepEqual(run(["cutover-status", "--state", cutoverState]), shadow);

    const testSwitch = writeJson(path.join(fx.root, "cutover-test.json"), {
      statePath: cutoverState,
      toBridgeId: "bridge.2x",
      phase: "test",
      approvalRef: "approval.cutover.synthetic.test",
      reason: "Promote Bridge 2.0 for test traffic with Bridge 1.x retained as rollback backup.",
    });
    const testPrimary = run(["cutover-switch", "--config", testSwitch]);
    assert.equal(testPrimary.phase, "test");
    assert.equal(testPrimary.primaryBridgeId, "bridge.2x");
    assert.equal(testPrimary.backupBridgeId, "bridge.1x");
    assert.equal(testPrimary.bridges.filter((bridge) => bridge.role === "primary" && bridge.writable).length, 1);

    const finalSwitch = writeJson(path.join(fx.root, "cutover-final.json"), {
      statePath: cutoverState,
      toBridgeId: "bridge.2x",
      phase: "final",
      approvalRef: "approval.cutover.synthetic.final",
      reason: "Finalize Bridge 2.0 as primary after test validation.",
    });
    const finalPrimary = run(["cutover-switch", "--config", finalSwitch]);
    assert.equal(finalPrimary.phase, "final");
    assert.equal(finalPrimary.primaryBridgeId, "bridge.2x");
    assert.equal(finalPrimary.history.length, 3);
    assert.equal(finalPrimary.history[2].previousHash, finalPrimary.history[1].entryHash);
  } finally {
    fx.cleanup();
  }
});
