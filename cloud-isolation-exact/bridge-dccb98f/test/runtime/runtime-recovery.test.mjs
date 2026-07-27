import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import crypto from "node:crypto";
import fs from "node:fs";
import path from "node:path";
import { DatabaseSync } from "node:sqlite";
import test from "node:test";
import { BridgeRuntime, canonicalize, decryptBuffer, encryptBuffer, executeOfflineRestore, hashCanonical, restoreDirtyWorktree } from "../../dist/v2/index.js";
import { browserManifest, createFixture } from "./helpers.mjs";

function git(cwd, args) {
  return execFileSync("git", args, { cwd, encoding: "utf8", windowsHide: true, stdio: ["ignore", "pipe", "pipe"] }).trim();
}

test("AES-256-GCM recovery envelope rejects wrong keys, metadata, and tampering", () => {
  const key = crypto.randomBytes(32);
  const plaintext = Buffer.from("synthetic confidential runtime state");
  const aad = { backupId: "backup.synthetic.crypto", kind: "state_snapshot" };
  const encrypted = encryptBuffer(plaintext, key, aad);
  assert.deepEqual(decryptBuffer(encrypted, key, aad), plaintext);
  assert.throws(() => decryptBuffer(encrypted, crypto.randomBytes(32), aad), /encrypted_envelope_authentication_failed/);
  assert.throws(() => decryptBuffer(encrypted, key, { ...aad, kind: "audit_mirror" }), /encrypted_envelope_aad_mismatch/);
  const tampered = Buffer.from(encrypted);
  tampered[tampered.length - 1] ^= 1;
  assert.throws(() => decryptBuffer(tampered, key, aad), /encrypted_envelope_authentication_failed/);
});

test("backup paths reject reparses and overlap, and publication detects a moving source HEAD", () => {
  const fx = createFixture("backup-path-isolation");
  try {
    const sourceRoot = path.join(fx.root, "canonical-source");
    fs.mkdirSync(sourceRoot);
    git(sourceRoot, ["init"]);
    git(sourceRoot, ["config", "user.email", "synthetic@example.invalid"]);
    git(sourceRoot, ["config", "user.name", "Synthetic Runtime Test"]);
    fs.writeFileSync(path.join(sourceRoot, "README.md"), "canonical backup source\n");
    git(sourceRoot, ["add", "."]);
    git(sourceRoot, ["commit", "-m", "canonical baseline"]);
    const destinationRoot = path.join(fx.root, "canonical-destination");
    fs.mkdirSync(destinationRoot);

    const sourceAlias = path.join(fx.root, "source-reparse");
    fs.symlinkSync(sourceRoot, sourceAlias, process.platform === "win32" ? "junction" : "dir");
    assert.throws(() => fx.runtime.backups.create({
      backupId: "backup.synthetic.reparse-source",
      projectId: fx.projectId,
      actor: fx.owner,
      idempotencyKey: "idempotency.backup.reparse-source",
      backupType: "source_only",
      sourceRoot: sourceAlias,
      destinationRoot,
    }), /backup_source_reparse_forbidden/);

    const destinationAlias = path.join(fx.root, "destination-reparse");
    fs.symlinkSync(destinationRoot, destinationAlias, process.platform === "win32" ? "junction" : "dir");
    assert.throws(() => fx.runtime.backups.create({
      backupId: "backup.synthetic.reparse-destination",
      projectId: fx.projectId,
      actor: fx.owner,
      idempotencyKey: "idempotency.backup.reparse-destination",
      backupType: "source_only",
      sourceRoot,
      destinationRoot: destinationAlias,
    }), /backup_destination_reparse_forbidden/);
    assert.throws(() => fx.runtime.backups.create({
      backupId: "backup.synthetic.overlap",
      projectId: fx.projectId,
      actor: fx.owner,
      idempotencyKey: "idempotency.backup.overlap",
      backupType: "source_only",
      sourceRoot,
      destinationRoot: path.join(sourceRoot, "backups"),
    }), /backup_source_destination_overlap_forbidden/);
    assert.throws(() => fx.runtime.backups.create({
      backupId: "backup.synthetic.live-state-source",
      projectId: fx.projectId,
      actor: fx.owner,
      idempotencyKey: "idempotency.backup.live-state-source",
      backupType: "source_only",
      sourceRoot: path.dirname(fx.databasePath),
      destinationRoot,
    }), /backup_source_contains_live_state/);
    assert.throws(() => fx.runtime.backups.create({
      backupId: "backup.synthetic.live-state-destination",
      projectId: fx.projectId,
      actor: fx.owner,
      idempotencyKey: "idempotency.backup.live-state-destination",
      backupType: "source_only",
      sourceRoot,
      destinationRoot: path.dirname(fx.auditMirrorPath),
    }), /backup_destination_contains_live_state/);

    const service = fx.runtime.backups;
    const originalAssertion = service.assertSourceSnapshot;
    let assertions = 0;
    service.assertSourceSnapshot = function (...args) {
      assertions += 1;
      if (assertions === 2) {
        fs.writeFileSync(path.join(sourceRoot, "moved.txt"), "source moved during capture\n");
        git(sourceRoot, ["add", "moved.txt"]);
        git(sourceRoot, ["commit", "-m", "move during backup"]);
      }
      return originalAssertion.apply(this, args);
    };
    try {
      assert.throws(() => service.create({
        backupId: "backup.synthetic.moving-source",
        projectId: fx.projectId,
        actor: fx.owner,
        idempotencyKey: "idempotency.backup.moving-source",
        backupType: "source_only",
        sourceRoot,
        destinationRoot,
      }), /backup_source_changed_during_capture/);
    } finally {
      service.assertSourceSnapshot = originalAssertion;
    }
    assert.equal(assertions, 2);
    assert.equal(fs.existsSync(path.join(destinationRoot, "backup.synthetic.moving-source")), false);
  } finally {
    fx.cleanup();
  }
});

test("doctor skips compatibility leases only while their migration is genuinely pending", () => {
  const fx = createFixture("doctor-pending-legacy-migration");
  try {
    fx.runtime.store.exec("DROP TABLE legacy_file_leases");
    const corruptCheck = fx.runtime.doctor.run({ projectId: fx.projectId, hostId: fx.owner.hostId })
      .checks.find((check) => check.checkId === "check.generation.active");
    assert.equal(corruptCheck.status, "fail", "an applied migration with a missing lease table is schema corruption");
    assert.match(corruptCheck.detail, /no such table: legacy_file_leases/u);

    fx.runtime.store.run("DELETE FROM schema_migrations WHERE version >= 2");
    const pendingDoctor = fx.runtime.doctor.run({ projectId: fx.projectId, hostId: fx.owner.hostId });
    const pendingGeneration = pendingDoctor.checks.find((check) => check.checkId === "check.generation.active");
    assert.equal(pendingGeneration.status, "pass", pendingGeneration.detail);
    assert.match(pendingGeneration.detail, /0 compatibility claim group\(s\)/u);
    const storage = pendingDoctor.checks.find((check) => check.checkId === "check.storage.integrity");
    assert.equal(storage.status, "warn");
    assert.match(storage.detail, /2 forward migration\(s\) are pending/u);
  } finally {
    fx.cleanup();
  }
});

test("full backup, verified isolated recovery drill, and read-only doctor", () => {
  const fx = createFixture("recovery");
  try {
    const sourceRoot = path.join(fx.root, "source-repo");
    fs.mkdirSync(sourceRoot);
    git(sourceRoot, ["init"]);
    git(sourceRoot, ["config", "user.email", "synthetic@example.invalid"]);
    git(sourceRoot, ["config", "user.name", "Synthetic Runtime Test"]);
    fs.writeFileSync(path.join(sourceRoot, "README.md"), "synthetic source\n");
    git(sourceRoot, ["add", "README.md"]);
    git(sourceRoot, ["commit", "-m", "synthetic baseline"]);
    const leaseExpiry = new Date(Date.parse(fx.clock.value) + 10 * 60_000).toISOString();
    fx.runtime.store.transaction(() => {
      fx.runtime.store.run(
        "UPDATE projects SET next_fencing_token = 1, updated_at = ? WHERE project_id = ?",
        fx.clock.value,
        fx.projectId,
      );
      for (const [leaseId, leasePath] of [["lease.legacy.synthetic.001", "src"], ["lease.legacy.synthetic.002", "docs"]]) {
        fx.runtime.store.run(
          `INSERT INTO legacy_file_leases(
            lease_id, claim_group_id, project_id, path, path_key, agent,
            principal_id, session_id, host_id, generation, fencing_token,
            claimed_at, expires_at, status, note, ended_at
          ) VALUES (?, 'claim.legacy.synthetic.001', ?, ?, ?, 'codex', ?, ?, ?, 1, 1, ?, ?, 'active', 'synthetic recovery coverage', NULL)`,
          leaseId,
          fx.projectId,
          leasePath,
          leasePath,
          fx.owner.principalId,
          fx.owner.sessionId,
          fx.owner.hostId,
          fx.clock.value,
          leaseExpiry,
        );
      }
    });
    const preBackupGenerationCheck = fx.runtime.doctor.run({ projectId: fx.projectId, hostId: fx.owner.hostId })
      .checks.find((check) => check.checkId === "check.generation.active");
    assert.equal(preBackupGenerationCheck.status, "pass", preBackupGenerationCheck.detail);
    assert.match(preBackupGenerationCheck.detail, /1 compatibility claim group\(s\)/u);
    const barrierSource = fx.registerArtifact({ text: "backup event source" });
    const key = crypto.randomBytes(32);
    const recoveryRoot = path.join(fx.root, "recovery-packages");
    const wrappedKeyCapsule = {
      capsuleRef: "drive://recovery-key-account/bridge2/key-capsules/synthetic.wrap",
      storageAccountRef: "drive-account://recovery-key-account",
      wrappingAlgorithmId: "rsa-oaep-sha256",
      recoveryProcedureRef: "drive://recovery-key-account/bridge2/KEY-RECOVERY.md",
      decryptionSecretCustody: "local_and_drive",
      recipientKeyFingerprint: "6".repeat(64),
      capsuleSha256: "8".repeat(64),
    };
    assert.throws(() => fx.runtime.backups.create({
      backupId: "backup.synthetic.raw-key-reference",
      projectId: fx.projectId,
      actor: fx.owner,
      idempotencyKey: "idempotency.backup.raw-key-reference",
      backupType: "full",
      sourceRoot,
      destinationRoot: recoveryRoot,
      encryption: { mode: "aes-256-gcm", keyRef: key.toString("base64"), key, wrappedKeyCapsule },
    }), /invalid_uri_reference|invalid_backup_key_reference/);
    assert.throws(() => fx.runtime.backups.create({
      backupId: "backup.synthetic.inline-capsule-reference",
      projectId: fx.projectId,
      actor: fx.owner,
      idempotencyKey: "idempotency.backup.inline-capsule-reference",
      backupType: "full",
      sourceRoot,
      destinationRoot: recoveryRoot,
      encryption: {
        mode: "aes-256-gcm",
        keyRef: "bridge-key://synthetic/inline-capsule",
        key,
        wrappedKeyCapsule: { ...wrappedKeyCapsule, capsuleRef: "data:text/plain;base64,cmF3LWtleQ==" },
      },
    }), /inline_or_executable_uri_forbidden/);
    const manifest = fx.runtime.backups.create({
      backupId: "backup.synthetic.full",
      projectId: fx.projectId,
      actor: fx.owner,
      idempotencyKey: "idempotency.backup.full",
      backupType: "full",
      sourceRoot,
      destinationRoot: recoveryRoot,
      encryption: {
        mode: "aes-256-gcm",
        keyRef: "bridge-key://synthetic/full",
        key,
        wrappedKeyCapsule,
      },
    });
    fx.runtime.schemas.validateNamed("backup-manifest.schema.json", manifest);
    assert.equal(manifest.backupType, "full");
    assert.equal(manifest.dirty, false);
    assert.ok(manifest.contents.some((content) => content.kind === "state_snapshot" && content.sensitivity === "confidential"));
    assert.equal(fs.existsSync(path.join(recoveryRoot, manifest.backupId, "state.snapshot.sqlite")), false);
    assert.equal(fs.existsSync(path.join(recoveryRoot, manifest.backupId, "audit.events.jsonl")), false);
    const manifestPath = path.join(recoveryRoot, manifest.backupId, "manifest.json");
    assert.deepEqual(fx.runtime.backups.verify(manifestPath), manifest);
    const unsafeReferencePackage = path.join(recoveryRoot, "backup.synthetic.unsafe-reference");
    fs.cpSync(path.join(recoveryRoot, manifest.backupId), unsafeReferencePackage, { recursive: true });
    const unsafeReferenceManifestPath = path.join(unsafeReferencePackage, "manifest.json");
    const unsafeReferenceManifest = JSON.parse(fs.readFileSync(unsafeReferenceManifestPath, "utf8"));
    unsafeReferenceManifest.encryption.keyRef = key.toString("base64");
    fs.writeFileSync(unsafeReferenceManifestPath, `${JSON.stringify(unsafeReferenceManifest)}\n`);
    assert.throws(() => fx.runtime.backups.verify(unsafeReferenceManifestPath), /invalid_uri_reference|invalid_backup_key_reference/);
    unsafeReferenceManifest.encryption.keyRef = manifest.encryption.keyRef;
    unsafeReferenceManifest.destinations[0].kind = "drive";
    fs.writeFileSync(unsafeReferenceManifestPath, `${JSON.stringify(unsafeReferenceManifest)}\n`);
    assert.equal(
      fx.runtime.backups.verify(unsafeReferenceManifestPath).destinations[0].uri.startsWith("file:"),
      true,
      "a contract-valid Drive-synced local file URI remains compatible",
    );
    const pendingPackage = path.join(recoveryRoot, "backup.synthetic.pending-destination");
    fs.cpSync(path.join(recoveryRoot, manifest.backupId), pendingPackage, { recursive: true });
    const pendingManifestPath = path.join(pendingPackage, "manifest.json");
    const pendingManifest = JSON.parse(fs.readFileSync(pendingManifestPath, "utf8"));
    pendingManifest.destinations[0].status = "pending";
    delete pendingManifest.destinations[0].verifiedAt;
    fs.writeFileSync(pendingManifestPath, `${JSON.stringify(pendingManifest)}\n`);
    assert.throws(() => executeOfflineRestore({
      restoreId: "restore.synthetic.pending-destination",
      projectId: fx.projectId,
      actor: fx.owner,
      idempotencyKey: "idempotency.restore.pending-destination",
      manifestPath: pendingManifestPath,
      destination: path.join(fx.root, "pending-destination-restore"),
      targetHostId: "host.synthetic.pending-destination",
      mode: "recovery_drill",
      decryptionKey: key,
      runContractTests: () => true,
    }, {
      schemas: fx.runtime.schemas,
      migrationsDir: path.resolve("migrations"),
      now: () => fx.clock.value,
    }), /verified_backup_destination_required/);

    fx.runtime.jobs.create({
      projectId: fx.projectId,
      actor: fx.owner,
      idempotencyKey: "idempotency.backup.audit-barrier-event",
      jobId: "job.synthetic.backup-audit-barrier",
      mode: "collaboration",
      requiredRole: "collaborator",
      independence: { policy: "not_required", excludedPrincipalIds: [] },
      target: {
        artifactIds: [barrierSource.artifactId],
        instructions: "Create an event that must have a durable JSONL projection before a full backup.",
        acceptanceCriteria: ["The full backup snapshot has one-to-one event and audit high-water marks."],
      },
    });

    const mirrorlessRuntime = new BridgeRuntime({ databasePath: fx.databasePath, now: () => fx.clock.value });
    try {
      assert.throws(() => mirrorlessRuntime.backups.create({
        backupId: "backup.synthetic.no-audit-mirror",
        projectId: fx.projectId,
        actor: fx.owner,
        idempotencyKey: "idempotency.backup.no-audit-mirror",
        backupType: "full",
        sourceRoot,
        destinationRoot: recoveryRoot,
        encryption: {
          mode: "aes-256-gcm",
          keyRef: "bridge-key://synthetic/no-mirror",
          key,
          wrappedKeyCapsule: manifest.encryption.wrappedKeyCapsule,
        },
      }), /full_backup_audit_mirror_required/);
    } finally {
      mirrorlessRuntime.close();
    }

    const staleInput = {
      backupId: "backup.synthetic.stale-secure-staging",
      projectId: fx.projectId,
      actor: fx.owner,
      idempotencyKey: "idempotency.backup.stale-secure-staging",
      backupType: "full",
      sourceRoot,
      destinationRoot: recoveryRoot,
      encryption: {
        mode: "aes-256-gcm",
        keyRef: "bridge-key://synthetic/stale-staging",
        key,
        wrappedKeyCapsule: manifest.encryption.wrappedKeyCapsule,
      },
    };
    const staleRequestHash = hashCanonical({
      backupId: staleInput.backupId,
      projectId: staleInput.projectId,
      backupType: staleInput.backupType,
      sourceRoot: path.resolve(sourceRoot),
      destinationRoot: path.resolve(recoveryRoot),
      encryption: {
        mode: "aes-256-gcm",
        keyRef: staleInput.encryption.keyRef,
        wrappedKeyCapsule: staleInput.encryption.wrappedKeyCapsule,
      },
    });
    const secureStaging = path.join(path.dirname(fx.databasePath), ".bridge2-secure-staging", staleInput.backupId);
    fs.mkdirSync(secureStaging, { recursive: true });
    fs.writeFileSync(path.join(secureStaging, ".bridge2-staging-owner"), `${staleRequestHash}\n`);
    fs.writeFileSync(path.join(secureStaging, "crash-left-plaintext.sqlite"), "synthetic plaintext must be erased\n");
    const otherStaleStaging = path.join(path.dirname(fx.databasePath), ".bridge2-secure-staging", "backup.synthetic.other-crashed-operation");
    fs.mkdirSync(otherStaleStaging);
    fs.writeFileSync(path.join(otherStaleStaging, ".bridge2-staging-owner"), `${"a".repeat(64)}\n`);
    fs.writeFileSync(path.join(otherStaleStaging, "other-crash-plaintext.sqlite"), "all owned stale plaintext must be erased\n");
    const foreignStaging = path.join(path.dirname(fx.databasePath), ".bridge2-secure-staging", "foreign-unmarked");
    fs.mkdirSync(foreignStaging);
    fs.writeFileSync(path.join(foreignStaging, "preserve.txt"), "not bridge-owned\n");
    const outsideStaging = path.join(fx.root, "outside-secure-staging");
    fs.mkdirSync(outsideStaging);
    fs.writeFileSync(path.join(outsideStaging, ".bridge2-staging-owner"), `${"b".repeat(64)}\n`);
    fs.writeFileSync(path.join(outsideStaging, "must-survive.txt"), "junction targets are never followed\n");
    const stagingReparse = path.join(path.dirname(fx.databasePath), ".bridge2-secure-staging", "linked-outside");
    fs.symlinkSync(outsideStaging, stagingReparse, process.platform === "win32" ? "junction" : "dir");
    const legacyPartial = path.join(recoveryRoot, `.${staleInput.backupId}.partial-crash`);
    fs.mkdirSync(legacyPartial);
    fs.writeFileSync(path.join(legacyPartial, ".bridge2-request-hash"), `${staleRequestHash}\n`);
    fs.writeFileSync(path.join(legacyPartial, "orphan.bin"), "owned orphan\n");
    const recoveredStale = fx.runtime.backups.create(staleInput);
    assert.equal(recoveredStale.backupId, staleInput.backupId);
    assert.equal(fs.existsSync(secureStaging), false);
    assert.equal(fs.existsSync(otherStaleStaging), false);
    assert.equal(fs.existsSync(foreignStaging), true);
    assert.equal(fs.existsSync(stagingReparse), true);
    assert.equal(fs.existsSync(path.join(outsideStaging, "must-survive.txt")), true);
    assert.equal(fs.existsSync(legacyPartial), false);

    const sourceOnly = fx.runtime.backups.create({
      backupId: "backup.synthetic.source-only",
      projectId: fx.projectId,
      actor: fx.owner,
      idempotencyKey: "idempotency.backup.source-only",
      backupType: "source_only",
      sourceRoot,
      destinationRoot: recoveryRoot,
    });
    assert.equal(sourceOnly.encryption.mode, "none");
    assert.deepEqual(sourceOnly.contents.map((content) => content.kind), ["git_bundle"]);
    assert.deepEqual(fx.runtime.backups.create({
      backupId: "backup.synthetic.source-only",
      projectId: fx.projectId,
      actor: fx.owner,
      idempotencyKey: "idempotency.backup.source-only",
      backupType: "source_only",
      sourceRoot,
      destinationRoot: recoveryRoot,
    }), sourceOnly);
    const unsafeNonePackage = path.join(recoveryRoot, "backup.synthetic.source-only-unsafe-key");
    fs.cpSync(path.join(recoveryRoot, sourceOnly.backupId), unsafeNonePackage, { recursive: true });
    const unsafeNoneManifestPath = path.join(unsafeNonePackage, "manifest.json");
    const unsafeNoneManifest = JSON.parse(fs.readFileSync(unsafeNoneManifestPath, "utf8"));
    unsafeNoneManifest.encryption.keyRef = "RAW_SECRET_MATERIAL";
    fs.writeFileSync(unsafeNoneManifestPath, `${JSON.stringify(unsafeNoneManifest)}\n`);
    assert.throws(() => fx.runtime.backups.verify(unsafeNoneManifestPath), /unencrypted_backup_key_metadata_forbidden/);

    const restoreDestination = path.join(fx.root, "isolated-restore");
    const restored = fx.runtime.restores.execute({
      restoreId: "restore.synthetic.drill",
      projectId: fx.projectId,
      actor: fx.owner,
      idempotencyKey: "idempotency.restore.drill",
      manifestPath,
      destination: restoreDestination,
      targetHostId: "host.synthetic.restore",
      mode: "recovery_drill",
      decryptionKey: key,
      runContractTests: () => true,
    });
    fx.runtime.schemas.validateNamed("restore-manifest.schema.json", restored.manifest);
    assert.equal(restored.manifest.status, "completed");
    assert.equal(restored.manifest.takeover.mode, "no_takeover");
    assert.ok(restored.manifest.steps.every((step) => step.operation !== "activate"));
    assert.ok(fs.existsSync(path.join(restoreDestination, "state.sqlite")));
    assert.ok(fs.existsSync(path.join(restoreDestination, "restore-report.json")));
    assert.ok(fs.existsSync(path.join(restoreDestination, ".bridge2-restore-request-hash")));
    const recoveredDatabase = new DatabaseSync(path.join(restoreDestination, "state.sqlite"), { readOnly: true });
    try {
      assert.equal(recoveredDatabase.prepare("SELECT status FROM projects WHERE project_id = ?").get(fx.projectId).status, "read_only");
      const recoveredRecord = recoveredDatabase.prepare(
        "SELECT status, manifest_json FROM restore_manifests WHERE restore_id = ?",
      ).get(restored.manifest.restoreId);
      assert.equal(recoveredRecord.status, "completed");
      assert.equal(JSON.parse(recoveredRecord.manifest_json).targetHostId, "host.synthetic.restore");
    } finally {
      recoveredDatabase.close();
    }
    const recoveredRuntime = new BridgeRuntime({
      databasePath: path.join(restoreDestination, "state.sqlite"),
      auditMirrorPath: path.join(restoreDestination, "audit.events.jsonl"),
      readOnly: true,
    });
    try {
      const liveCheck = recoveredRuntime.doctor.run({ projectId: fx.projectId, hostId: "host.synthetic.restore" });
      assert.equal(liveCheck.checks.find((check) => check.checkId === "check.storage.project").status, "warn");
      const isolatedCheck = recoveredRuntime.doctor.run({
        projectId: fx.projectId,
        hostId: "host.synthetic.restore",
        isolatedRestore: true,
      });
      assert.equal(isolatedCheck.checks.find((check) => check.checkId === "check.storage.project").status, "pass");
    } finally {
      recoveredRuntime.close();
    }
    const drillActivationProbe = new BridgeRuntime({
      databasePath: path.join(restoreDestination, "state.sqlite"),
      auditMirrorPath: path.join(restoreDestination, "audit.events.jsonl"),
    });
    try {
      assert.throws(() => drillActivationProbe.jobs.advanceGeneration({
        projectId: fx.projectId,
        actor: fx.owner,
        expectedGeneration: 1,
        newGeneration: 2,
        approvalRef: "approval.takeover.synthetic.drill-forbidden",
        targetHostId: restored.manifest.targetHostId,
        restoreId: restored.manifest.restoreId,
        reason: "A recovery drill must remain structurally non-activating.",
        idempotencyKey: "idempotency.takeover.synthetic.drill-forbidden",
      }), /restore_mode_not_activatable/);
    } finally {
      drillActivationProbe.close();
    }

    const newHostDestination = path.join(fx.root, "new-host-restore");
    const newHost = {
      hostId: "host.synthetic.replacement",
      instanceId: "instance.synthetic.replacement.001",
      hostnameHash: "9".repeat(64),
      platform: "windows",
      status: "active",
      registeredAt: fx.clock.value,
    };
    const newSession = {
      sessionId: "session.synthetic.replacement-owner",
      principalId: fx.owner.principalId,
      hostId: newHost.hostId,
      startedAt: fx.clock.value,
      expiresAt: "2026-07-13T13:00:00.000Z",
      status: "active",
      authentication: { method: "local_process", assurance: "local" },
      transportBinding: {
        transport: "stdio",
        transportSessionId: "stdio-replacement-owner-0001",
        serverInstanceId: "server.synthetic.replacement",
      },
    };
    const newHostRestore = fx.runtime.restores.execute({
      restoreId: "restore.synthetic.new-host",
      projectId: fx.projectId,
      actor: fx.owner,
      idempotencyKey: "idempotency.restore.new-host",
      manifestPath,
      destination: newHostDestination,
      targetHostId: newHost.hostId,
      mode: "new_host",
      decryptionKey: key,
      runContractTests: () => true,
    });
    assert.equal(newHostRestore.manifest.mode, "new_host");
    const replacementRuntime = new BridgeRuntime({
      databasePath: path.join(newHostDestination, "state.sqlite"),
      auditMirrorPath: path.join(newHostDestination, "audit.events.jsonl"),
      now: () => fx.clock.value,
    });
    try {
      assert.equal(replacementRuntime.jobs.advanceGeneration({
        projectId: fx.projectId,
        actor: fx.owner,
        expectedGeneration: 1,
        newGeneration: 2,
        approvalRef: "approval.takeover.synthetic.new-host",
        targetHostId: newHost.hostId,
        restoreId: newHostRestore.manifest.restoreId,
        recoveryHost: newHost,
        recoverySession: newSession,
        reason: "Owner-confirmed activation on a newly registered replacement host.",
        idempotencyKey: "idempotency.takeover.synthetic.new-host",
      }), 2);
      const replacementOwner = {
        principalId: fx.owner.principalId,
        sessionId: newSession.sessionId,
        hostId: newHost.hostId,
      };
      assert.ok(replacementRuntime.identity.authorize(fx.projectId, replacementOwner, ["owner"]));
      const activated = replacementRuntime.store.get(
        "SELECT active_generation, status FROM projects WHERE project_id = ?",
        fx.projectId,
      );
      assert.equal(activated.active_generation, 2);
      assert.equal(activated.status, "active");
      const takeover = replacementRuntime.store.get(
        "SELECT target_host_id, restore_id, takeover_class FROM generation_takeovers WHERE approval_ref = ?",
        "approval.takeover.synthetic.new-host",
      );
      assert.equal(takeover.target_host_id, newHost.hostId);
      assert.equal(takeover.restore_id, newHostRestore.manifest.restoreId);
      assert.equal(takeover.takeover_class, "restore_activation");
    } finally {
      replacementRuntime.close();
    }

    assert.throws(() => fx.runtime.restores.execute({
      restoreId: "restore.synthetic.overlap",
      projectId: fx.projectId,
      actor: fx.owner,
      idempotencyKey: "idempotency.restore.overlap",
      manifestPath,
      destination: path.join(recoveryRoot, manifest.backupId, "nested-restore"),
      targetHostId: "host.synthetic.overlap",
      mode: "recovery_drill",
      decryptionKey: key,
      runContractTests: () => true,
    }), /restore_path_overlaps_backup_package/);

    const tamperedPackage = path.join(recoveryRoot, "backup.synthetic.full-tampered-manifest");
    fs.cpSync(path.join(recoveryRoot, manifest.backupId), tamperedPackage, { recursive: true });
    const tamperedManifestPath = path.join(tamperedPackage, "manifest.json");
    const tamperedManifest = JSON.parse(fs.readFileSync(tamperedManifestPath, "utf8"));
    tamperedManifest.consistency.eventSequence += 1;
    fs.writeFileSync(tamperedManifestPath, `${JSON.stringify(tamperedManifest)}\n`);
    assert.throws(() => fx.runtime.restores.execute({
      restoreId: "restore.synthetic.sequence-mismatch",
      projectId: fx.projectId,
      actor: fx.owner,
      idempotencyKey: "idempotency.restore.sequence-mismatch",
      manifestPath: tamperedManifestPath,
      destination: path.join(fx.root, "sequence-mismatch-restore"),
      targetHostId: "host.synthetic.sequence-mismatch",
      mode: "recovery_drill",
      decryptionKey: key,
      runContractTests: () => true,
    }), /restored_snapshot_event_sequence_mismatch/);

    fs.writeFileSync(path.join(tamperedPackage, "undeclared-plaintext.sqlite"), "must be rejected\n");
    assert.throws(() => fx.runtime.backups.verify(tamperedManifestPath), /backup_package_inventory_mismatch/);

    const failedDestination = path.join(fx.root, "failed-isolated-restore");
    assert.throws(() => fx.runtime.restores.execute({
      restoreId: "restore.synthetic.failed-drill",
      projectId: fx.projectId,
      actor: fx.owner,
      idempotencyKey: "idempotency.restore.failed-drill",
      manifestPath,
      destination: failedDestination,
      targetHostId: "host.synthetic.restore-failed",
      mode: "recovery_drill",
      decryptionKey: crypto.randomBytes(32),
      runContractTests: () => true,
    }), /encrypted_envelope_authentication_failed/);
    assert.equal(fs.existsSync(failedDestination), false);
    const failureReport = JSON.parse(fs.readFileSync(
      `${failedDestination}.restore.synthetic.failed-drill.failed.json`,
      "utf8",
    ));
    fx.runtime.schemas.validateNamed("restore-manifest.schema.json", failureReport);
    assert.equal(failureReport.status, "failed");

    const before = {
      events: fx.runtime.store.get("SELECT COUNT(*) AS count FROM events").count,
      idempotency: fx.runtime.store.get("SELECT COUNT(*) AS count FROM idempotency_records").count,
    };
    const databaseBytesBeforeDoctor = fs.readFileSync(fx.databasePath);
    const doctor = fx.runtime.doctor.run({
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
    fx.runtime.schemas.validateNamed("doctor.schema.json", doctor);
    assert.equal(doctor.checks.length, 13);
    assert.equal(doctor.checks.find((check) => check.checkId === "check.storage.compatibility").status, "pass");
    assert.equal(doctor.checks.find((check) => check.checkId === "check.drive.root").status, "pass");
    assert.equal(doctor.checks.find((check) => check.checkId === "check.backup.restore_drill").category, "backup");
    assert.equal(fx.runtime.store.get("SELECT COUNT(*) AS count FROM events").count, before.events);
    assert.equal(fx.runtime.store.get("SELECT COUNT(*) AS count FROM idempotency_records").count, before.idempotency);
    assert.deepEqual(fs.readFileSync(fx.databasePath), databaseBytesBeforeDoctor);

    const latestBackupId = fx.runtime.store.get(
      "SELECT backup_id FROM backup_manifests WHERE project_id = ? ORDER BY created_at DESC LIMIT 1",
      fx.projectId,
    ).backup_id;
    const driveLayoutRoot = path.join(fx.root, "drive-layout-root");
    const nestedPackage = path.join(driveLayoutRoot, "backups", latestBackupId);
    fs.mkdirSync(path.dirname(nestedPackage), { recursive: true });
    fs.cpSync(path.join(recoveryRoot, latestBackupId), nestedPackage, { recursive: true });
    const nestedLayoutDoctor = fx.runtime.doctor.run({
      projectId: fx.projectId,
      hostId: fx.owner.hostId,
      recoveryRoot: driveLayoutRoot,
    });
    assert.equal(nestedLayoutDoctor.checks.find((check) => check.checkId === "check.drive.root").status, "pass");

    const missingLayoutRoot = path.join(fx.root, "missing-drive-layout-root");
    fs.mkdirSync(missingLayoutRoot);
    const missingLayoutDoctor = fx.runtime.doctor.run({
      projectId: fx.projectId,
      hostId: fx.owner.hostId,
      recoveryRoot: missingLayoutRoot,
    });
    const missingDriveCheck = missingLayoutDoctor.checks.find((check) => check.checkId === "check.drive.root");
    assert.equal(missingDriveCheck.status, "fail");
    assert.match(missingDriveCheck.detail, /backup_package_not_found/);

    fs.cpSync(path.join(recoveryRoot, latestBackupId), path.join(driveLayoutRoot, latestBackupId), { recursive: true });
    const ambiguousLayoutDoctor = fx.runtime.doctor.run({
      projectId: fx.projectId,
      hostId: fx.owner.hostId,
      recoveryRoot: driveLayoutRoot,
    });
    const ambiguousDriveCheck = ambiguousLayoutDoctor.checks.find((check) => check.checkId === "check.drive.root");
    assert.equal(ambiguousDriveCheck.status, "fail");
    assert.match(ambiguousDriveCheck.detail, /backup_package_layout_ambiguous/);

    const missingProjectDoctor = fx.runtime.doctor.run({
      projectId: "project.synthetic.missing",
      hostId: fx.owner.hostId,
    });
    assert.equal(missingProjectDoctor.overall, "blocked");
    assert.equal(missingProjectDoctor.checks.find((check) => check.checkId === "check.storage.project").status, "fail");

    const mirrorSource = fx.registerArtifact({ text: "doctor mirror tamper source" });
    fx.runtime.jobs.create({
      projectId: fx.projectId,
      actor: fx.owner,
      idempotencyKey: "idempotency.doctor.mirror-event",
      jobId: "job.synthetic.doctor-mirror-event",
      mode: "collaboration",
      requiredRole: "collaborator",
      independence: { policy: "not_required", excludedPrincipalIds: [] },
      target: {
        artifactIds: [mirrorSource.artifactId],
        instructions: "Create one synthetic immutable event for JSONL tamper verification.",
        acceptanceCriteria: ["Doctor rejects a changed body with retained hashes."],
      },
    });
    const originalMirror = fs.readFileSync(fx.auditMirrorPath, "utf8");
    const tamperedLines = originalMirror.trimEnd().split("\n");
    const tampered = JSON.parse(tamperedLines[0]);
    tampered.event.aggregate.id = "job.tampered-with-retained-hash";
    tamperedLines[0] = JSON.stringify(tampered);
    fs.writeFileSync(fx.auditMirrorPath, `${tamperedLines.join("\n")}\n`);
    const tamperedDoctor = fx.runtime.doctor.run({ projectId: fx.projectId, hostId: fx.owner.hostId });
    assert.equal(tamperedDoctor.overall, "blocked");
    assert.equal(tamperedDoctor.checks.find((check) => check.category === "events").status, "fail");
    fs.writeFileSync(fx.auditMirrorPath, originalMirror);

    fs.writeFileSync(path.join(sourceRoot, "dirty.txt"), "dirty\n");
    assert.throws(
      () => fx.runtime.backups.create({
        backupId: "backup.synthetic.dirty-full",
        projectId: fx.projectId,
        actor: fx.owner,
        idempotencyKey: "idempotency.backup.dirty-full",
        backupType: "full",
        sourceRoot,
        destinationRoot: recoveryRoot,
        encryption: {
          mode: "aes-256-gcm",
          keyRef: "bridge-key://synthetic/dirty",
          key,
          wrappedKeyCapsule: manifest.encryption.wrappedKeyCapsule,
        },
      }),
      /full_backup_requires_clean_source/,
    );
    assert.throws(
      () => fx.runtime.backups.create({
        backupId: "backup.synthetic.dirty-source",
        projectId: fx.projectId,
        actor: fx.owner,
        idempotencyKey: "idempotency.backup.dirty-source",
        backupType: "source_only",
        sourceRoot,
        destinationRoot: recoveryRoot,
      }),
      /dirty_source_owner_exception_required/,
    );

    fx.runtime.identity.assignRole({
      projectId: fx.projectId,
      actor: fx.owner,
      principalId: fx.owner.principalId,
      role: "collaborator",
      idempotencyKey: "idempotency.owner.collaborator-for-backup",
    });
    const attestationAdapter = browserManifest();
    attestationAdapter.adapterId = "adapter.backup.attestation";
    attestationAdapter.displayName = "Synthetic Backup Attestation";
    attestationAdapter.operations = {
      "backup.source_only.dirty": {
        ...attestationAdapter.operations.compose,
        sideEffectClass: "external_reversible",
      },
    };
    fx.runtime.adapters.register({
      projectId: fx.projectId,
      actor: fx.owner,
      manifest: attestationAdapter,
      idempotencyKey: "idempotency.backup.attestation-adapter",
    });
    const approvalSource = fx.registerArtifact({ text: "dirty source backup attestation" });
    const approvalJob = fx.runtime.jobs.create({
      projectId: fx.projectId,
      actor: fx.owner,
      idempotencyKey: "idempotency.backup.attestation-job",
      jobId: "job.synthetic.backup-attestation",
      mode: "collaboration",
      requiredRole: "collaborator",
      independence: { policy: "not_required", excludedPrincipalIds: [] },
      target: {
        artifactIds: [approvalSource.artifactId],
        instructions: "Authorize one explicit synthetic dirty source-only recovery capture.",
        acceptanceCriteria: ["Capture the exact dirty worktree patch."],
      },
    });
    fx.runtime.jobs.makeClaimable({
      projectId: fx.projectId,
      jobId: approvalJob.jobId,
      actor: fx.owner,
      idempotencyKey: "idempotency.backup.attestation-claimable",
    });
    const approvalClaim = fx.runtime.jobs.claim({
      projectId: fx.projectId,
      jobId: approvalJob.jobId,
      actor: fx.owner,
      idempotencyKey: "idempotency.backup.attestation-claim",
    });
    const grant = fx.runtime.approvals.createGrant({
      projectId: fx.projectId,
      jobId: approvalJob.jobId,
      actor: fx.owner,
      grantedTo: fx.owner,
      claim: approvalClaim.claim,
      adapterIds: [attestationAdapter.adapterId],
      actions: ["backup.source_only.dirty"],
      conditions: [{ name: "backupId", operator: "equals", value: "backup.synthetic.dirty-approved" }],
      destinations: ["https://example.invalid/drafts"],
      origins: ["https://example.invalid"],
      sideEffectClasses: ["external_reversible"],
      expiresAt: "2026-07-13T12:10:00.000Z",
      maxUses: 1,
      idempotencyKey: "idempotency.backup.attestation-grant",
    });
    const approvedDirtyInput = {
      backupId: "backup.synthetic.dirty-approved",
      projectId: fx.projectId,
      actor: fx.owner,
      idempotencyKey: "idempotency.backup.dirty-approved",
      backupType: "source_only",
      sourceRoot,
      destinationRoot: recoveryRoot,
      ownerException: {
        approvalGrantId: grant.grantId,
        reason: "Synthetic owner-approved dirty source recovery capture.",
        approvedBy: fx.owner,
      },
    };
    const originalStoreRun = fx.runtime.store.run.bind(fx.runtime.store);
    fx.runtime.store.run = (sql, ...parameters) => {
      if (sql.includes("INSERT INTO backup_manifests")) throw new Error("synthetic_backup_manifest_insert_crash");
      return originalStoreRun(sql, ...parameters);
    };
    try {
      assert.throws(() => fx.runtime.backups.create(approvedDirtyInput), /synthetic_backup_manifest_insert_crash/);
    } finally {
      fx.runtime.store.run = originalStoreRun;
    }
    assert.ok(fs.existsSync(path.join(recoveryRoot, approvedDirtyInput.backupId, "manifest.json")));
    const rolledBackGrant = fx.runtime.store.get(
      "SELECT status, uses_consumed FROM approval_grants WHERE grant_id = ?",
      grant.grantId,
    );
    assert.equal(rolledBackGrant.status, "active");
    assert.equal(rolledBackGrant.uses_consumed, 0);
    const approvedDirty = fx.runtime.backups.create(approvedDirtyInput);
    assert.equal(approvedDirty.dirty, true);
    const consumedGrant = fx.runtime.store.get(
      "SELECT status, uses_consumed FROM approval_grants WHERE grant_id = ?",
      grant.grantId,
    );
    assert.equal(consumedGrant.status, "exhausted");
    assert.equal(consumedGrant.uses_consumed, 1);
    assert.deepEqual(fx.runtime.backups.create(approvedDirtyInput), approvedDirty);
    assert.equal(fx.runtime.store.get(
      "SELECT uses_consumed FROM approval_grants WHERE grant_id = ?",
      grant.grantId,
    ).uses_consumed, 1);
    assert.throws(() => fx.runtime.backups.create({
      backupId: "backup.synthetic.dirty-reuse-forbidden",
      projectId: fx.projectId,
      actor: fx.owner,
      idempotencyKey: "idempotency.backup.dirty-reuse-forbidden",
      backupType: "source_only",
      sourceRoot,
      destinationRoot: recoveryRoot,
      ownerException: {
        approvalGrantId: grant.grantId,
        reason: "A consumed one-use grant cannot authorize another backup.",
        approvedBy: fx.owner,
      },
    }));
    const dirtyArchive = path.join(recoveryRoot, approvedDirty.backupId, "dirty-worktree.json");
    assert.ok(fs.readFileSync(dirtyArchive, "utf8").includes("dirty.txt"));
    const dirtyRestore = path.join(fx.root, "dirty-source-restore");
    git(fx.root, ["clone", path.join(recoveryRoot, approvedDirty.backupId, "source.bundle"), dirtyRestore]);
    restoreDirtyWorktree(dirtyArchive, dirtyRestore);
    assert.deepEqual(fs.readFileSync(path.join(dirtyRestore, "dirty.txt")), Buffer.from("dirty\n"));
    assert.deepEqual(restoreDirtyWorktree(dirtyArchive, dirtyRestore), { restored: 1, deleted: 0 });

    const atomicRestore = path.join(fx.root, "dirty-atomic-restore");
    git(fx.root, ["clone", path.join(recoveryRoot, approvedDirty.backupId, "source.bundle"), atomicRestore]);
    const originalReadme = fs.readFileSync(path.join(atomicRestore, "README.md"));
    const changedReadme = Buffer.from("would be applied only after full preflight\n");
    const invalidArchive = path.join(fx.root, "dirty-preflight-invalid.json");
    fs.writeFileSync(invalidArchive, `${JSON.stringify({
      schemaVersion: "bridge2-dirty-worktree-v1",
      baseCommit: git(atomicRestore, ["rev-parse", "HEAD"]),
      entries: [{
        path: "README.md",
        state: "present",
        kind: "file",
        sizeBytes: changedReadme.length,
        sha256: crypto.createHash("sha256").update(changedReadme).digest("hex"),
        executable: false,
        contentBase64: changedReadme.toString("base64"),
      }, {
        path: "invalid.bin",
        state: "present",
        kind: "file",
        sizeBytes: 1,
        sha256: "0".repeat(64),
        executable: false,
        contentBase64: Buffer.from("x").toString("base64"),
      }],
    })}\n`);
    assert.throws(() => restoreDirtyWorktree(invalidArchive, atomicRestore), /dirty_archive_content_hash_mismatch/);
    assert.deepEqual(fs.readFileSync(path.join(atomicRestore, "README.md")), originalReadme);
    assert.equal(git(atomicRestore, ["status", "--porcelain"]), "");

    const tooLongLink = Buffer.from("x".repeat(40_000));
    const rollbackArchive = path.join(fx.root, "dirty-rollback.json");
    fs.writeFileSync(rollbackArchive, `${JSON.stringify({
      schemaVersion: "bridge2-dirty-worktree-v1",
      baseCommit: git(atomicRestore, ["rev-parse", "HEAD"]),
      entries: [{
        path: "README.md",
        state: "present",
        kind: "file",
        sizeBytes: changedReadme.length,
        sha256: crypto.createHash("sha256").update(changedReadme).digest("hex"),
        executable: false,
        contentBase64: changedReadme.toString("base64"),
      }, {
        path: "will-fail-link",
        state: "present",
        kind: "symlink",
        sizeBytes: tooLongLink.length,
        sha256: crypto.createHash("sha256").update(tooLongLink).digest("hex"),
        executable: false,
        contentBase64: tooLongLink.toString("base64"),
      }],
    })}\n`);
    assert.throws(() => restoreDirtyWorktree(rollbackArchive, atomicRestore));
    assert.deepEqual(fs.readFileSync(path.join(atomicRestore, "README.md")), originalReadme);
    assert.equal(fs.existsSync(path.join(atomicRestore, "will-fail-link")), false);
    assert.equal(git(atomicRestore, ["status", "--porcelain"]), "");

    const outside = path.join(fx.root, "dirty-escape-target");
    fs.mkdirSync(outside);
    git(dirtyRestore, ["reset", "--hard", "HEAD"]);
    git(dirtyRestore, ["clean", "-fd"]);
    fs.appendFileSync(path.join(dirtyRestore, ".git", "info", "exclude"), "\nlinked-parent\n");
    fs.symlinkSync(outside, path.join(dirtyRestore, "linked-parent"), process.platform === "win32" ? "junction" : "dir");
    assert.equal(git(dirtyRestore, ["status", "--porcelain"]), "");
    const escapeBytes = Buffer.from("must not escape\n");
    const craftedArchive = path.join(fx.root, "crafted-dirty-archive.json");
    fs.writeFileSync(craftedArchive, `${JSON.stringify({
      schemaVersion: "bridge2-dirty-worktree-v1",
      baseCommit: git(dirtyRestore, ["rev-parse", "HEAD"]),
      entries: [{
        path: "linked-parent/escape.txt",
        state: "present",
        kind: "file",
        sizeBytes: escapeBytes.length,
        sha256: crypto.createHash("sha256").update(escapeBytes).digest("hex"),
        executable: false,
        contentBase64: escapeBytes.toString("base64"),
      }],
    })}\n`);
    assert.throws(() => restoreDirtyWorktree(craftedArchive, dirtyRestore), /dirty_restore_parent_reparse_forbidden/);
    assert.equal(fs.existsSync(path.join(outside, "escape.txt")), false);
  } finally {
    fx.cleanup();
  }
});

test("dirty worktree restore resumes a durable intent and rejects divergent targets", () => {
  const fx = createFixture("dirty-restore-resume");
  try {
    const sourceRoot = path.join(fx.root, "resume-source");
    fs.mkdirSync(sourceRoot);
    git(sourceRoot, ["init"]);
    git(sourceRoot, ["config", "user.email", "synthetic@example.invalid"]);
    git(sourceRoot, ["config", "user.name", "Synthetic Runtime Test"]);
    const originalBytes = Buffer.from("original tracked content\n");
    fs.writeFileSync(path.join(sourceRoot, "README.md"), originalBytes);
    git(sourceRoot, ["add", "."]);
    git(sourceRoot, ["commit", "-m", "dirty restore resume baseline"]);
    const baseCommit = git(sourceRoot, ["rev-parse", "HEAD"]);
    const desiredTracked = Buffer.from("desired tracked content\n");
    const desiredNew = Buffer.from("desired new content\n");
    const archive = {
      schemaVersion: "bridge2-dirty-worktree-v1",
      baseCommit,
      entries: [{
        path: "README.md",
        state: "present",
        kind: "file",
        sizeBytes: desiredTracked.length,
        sha256: crypto.createHash("sha256").update(desiredTracked).digest("hex"),
        executable: false,
        contentBase64: desiredTracked.toString("base64"),
      }, {
        path: "nested/resumed.txt",
        state: "present",
        kind: "file",
        sizeBytes: desiredNew.length,
        sha256: crypto.createHash("sha256").update(desiredNew).digest("hex"),
        executable: false,
        contentBase64: desiredNew.toString("base64"),
      }],
    };
    const archivePath = path.join(fx.root, "resume-dirty.json");
    const archiveText = `${JSON.stringify(archive)}\n`;
    fs.writeFileSync(archivePath, archiveText);
    const archiveSha256 = crypto.createHash("sha256").update(archiveText).digest("hex");

    const makeIntent = (destination) => {
      const readme = path.join(destination, "README.md");
      const stat = fs.statSync(readme);
      const checkedOutOriginal = fs.readFileSync(readme);
      return {
        schemaVersion: "bridge2-dirty-restore-intent-v1",
        archiveSha256,
        baseCommit,
        destinationRoot: fs.realpathSync.native(destination),
        entries: [{
          path: "README.md",
          original: {
            kind: "file",
            contentBase64: checkedOutOriginal.toString("base64"),
            mode: stat.mode & 0o777,
            sha256: crypto.createHash("sha256").update(checkedOutOriginal).digest("hex"),
            sizeBytes: checkedOutOriginal.length,
          },
        }, {
          path: "nested/resumed.txt",
          original: { kind: "absent" },
        }],
      };
    };

    const resumed = path.join(fx.root, "resume-destination");
    git(fx.root, ["clone", sourceRoot, resumed]);
    const resumedIntent = makeIntent(resumed);
    const resumedIntentPath = path.join(resumed, ".git", "bridge2-dirty-restore.intent.json");
    fs.writeFileSync(resumedIntentPath, `${canonicalize(resumedIntent)}\n`, { mode: 0o600 });
    fs.writeFileSync(path.join(resumed, "README.md"), desiredTracked);
    assert.deepEqual(restoreDirtyWorktree(archivePath, resumed), { restored: 2, deleted: 0 });
    assert.deepEqual(fs.readFileSync(path.join(resumed, "README.md")), desiredTracked);
    assert.deepEqual(fs.readFileSync(path.join(resumed, "nested", "resumed.txt")), desiredNew);
    assert.equal(fs.existsSync(resumedIntentPath), false);
    assert.equal(fs.readdirSync(path.join(resumed, ".git")).some((name) => name.startsWith("bridge2-dirty-restore.stage-")), false);
    assert.deepEqual(restoreDirtyWorktree(archivePath, resumed), { restored: 2, deleted: 0 });

    const temporaryIntentDestination = path.join(fx.root, "temporary-intent-destination");
    git(fx.root, ["clone", sourceRoot, temporaryIntentDestination]);
    const temporaryIntent = makeIntent(temporaryIntentDestination);
    const temporaryIntentPath = path.join(temporaryIntentDestination, ".git", "bridge2-dirty-restore.intent.json");
    fs.writeFileSync(`${temporaryIntentPath}.tmp`, `${canonicalize(temporaryIntent)}\n`, { mode: 0o600 });
    assert.deepEqual(restoreDirtyWorktree(archivePath, temporaryIntentDestination), { restored: 2, deleted: 0 });
    assert.equal(fs.existsSync(temporaryIntentPath), false);
    assert.equal(fs.existsSync(`${temporaryIntentPath}.tmp`), false);

    const divergent = path.join(fx.root, "divergent-intent-destination");
    git(fx.root, ["clone", sourceRoot, divergent]);
    const divergentIntent = makeIntent(divergent);
    const divergentIntentPath = path.join(divergent, ".git", "bridge2-dirty-restore.intent.json");
    fs.writeFileSync(divergentIntentPath, `${canonicalize(divergentIntent)}\n`, { mode: 0o600 });
    fs.writeFileSync(path.join(divergent, "README.md"), "neither original nor desired\n");
    assert.throws(() => restoreDirtyWorktree(archivePath, divergent), /dirty_restore_target_diverged/);
    assert.equal(fs.existsSync(divergentIntentPath), true);
  } finally {
    fx.cleanup();
  }
});

test("forward migration enforcement requires a verified pre-migration backup and detects checksum drift", () => {
  const fx = createFixture("migrations");
  let runtime;
  try {
    const sourceRoot = path.join(fx.root, "migration-source");
    fs.mkdirSync(sourceRoot);
    git(sourceRoot, ["init"]);
    git(sourceRoot, ["config", "user.email", "synthetic@example.invalid"]);
    git(sourceRoot, ["config", "user.name", "Synthetic Runtime Test"]);
    fs.writeFileSync(path.join(sourceRoot, "README.md"), "migration recovery source\n");
    git(sourceRoot, ["add", "README.md"]);
    git(sourceRoot, ["commit", "-m", "migration backup baseline"]);
    const recoveryRoot = path.join(fx.root, "migration-backups");
    const sourceOnly = fx.runtime.backups.create({
      backupId: "backup.synthetic.migration-source-only",
      projectId: fx.projectId,
      actor: fx.owner,
      idempotencyKey: "idempotency.migration.source-only",
      backupType: "source_only",
      sourceRoot,
      destinationRoot: recoveryRoot,
    });
    const key = crypto.randomBytes(32);
    const full = fx.runtime.backups.create({
      backupId: "backup.synthetic.migration-full-stale",
      projectId: fx.projectId,
      actor: fx.owner,
      idempotencyKey: "idempotency.migration.full-stale",
      backupType: "full",
      sourceRoot,
      destinationRoot: recoveryRoot,
      encryption: {
        mode: "aes-256-gcm",
        keyRef: "bridge-key://synthetic/migration",
        key,
        wrappedKeyCapsule: {
          capsuleRef: "drive://recovery-key-account/bridge2/key-capsules/migration.wrap",
          storageAccountRef: "drive-account://recovery-key-account",
          wrappingAlgorithmId: "rsa-oaep-sha256",
          recoveryProcedureRef: "drive://recovery-key-account/bridge2/KEY-RECOVERY.md",
          decryptionSecretCustody: "local_and_drive",
          recipientKeyFingerprint: "6".repeat(64),
          capsuleSha256: "8".repeat(64),
        },
      },
    });
    const source = fx.registerArtifact({ text: "post-backup migration high-water" });
    fx.runtime.jobs.create({
      projectId: fx.projectId,
      actor: fx.owner,
      idempotencyKey: "idempotency.migration.post-backup-event",
      jobId: "job.synthetic.post-backup-event",
      mode: "collaboration",
      requiredRole: "collaborator",
      independence: { policy: "not_required", excludedPrincipalIds: [] },
      target: {
        artifactIds: [source.artifactId],
        instructions: "Create one event after the migration backup high-water mark.",
        acceptanceCriteria: ["The stale backup cannot authorize migration."],
      },
    });
    const revisionStale = fx.runtime.backups.create({
      backupId: "backup.synthetic.migration-full-revision-stale",
      projectId: fx.projectId,
      actor: fx.owner,
      idempotencyKey: "idempotency.migration.full-revision-stale",
      backupType: "full",
      sourceRoot,
      destinationRoot: recoveryRoot,
      encryption: {
        mode: "aes-256-gcm",
        keyRef: "bridge-key://synthetic/migration-revision-stale",
        key,
        wrappedKeyCapsule: full.encryption.wrappedKeyCapsule,
      },
    });
    const sequenceBeforeIdentityMutation = fx.runtime.store.get(
      "SELECT COALESCE(MAX(sequence), 0) AS sequence FROM events WHERE project_id = ?",
      fx.projectId,
    ).sequence;
    fx.runtime.identity.registerHost({
      projectId: fx.projectId,
      actor: fx.owner,
      host: {
        ...fx.host,
        hostId: "host.synthetic.migration-revision",
        instanceId: "instance.synthetic.migration-revision.001",
        hostnameHash: "3".repeat(64),
      },
      idempotencyKey: "idempotency.migration.revision-host",
    });
    assert.equal(
      fx.runtime.store.get("SELECT COALESCE(MAX(sequence), 0) AS sequence FROM events WHERE project_id = ?", fx.projectId).sequence,
      sequenceBeforeIdentityMutation,
      "the identity command used to stale the backup must not rely on an event high-water change",
    );
    const fresh = fx.runtime.backups.create({
      backupId: "backup.synthetic.migration-full-current",
      projectId: fx.projectId,
      actor: fx.owner,
      idempotencyKey: "idempotency.migration.full-current",
      backupType: "full",
      sourceRoot,
      destinationRoot: recoveryRoot,
      encryption: {
        mode: "aes-256-gcm",
        keyRef: "bridge-key://synthetic/migration-current",
        key,
        wrappedKeyCapsule: full.encryption.wrappedKeyCapsule,
      },
    });
    const freshRevision = Number(/^sqlite-state-revision-(\d+)$/.exec(fresh.consistency.databaseCheckpoint)?.[1]);
    assert.equal(
      fx.runtime.store.get("SELECT state_revision FROM projects WHERE project_id = ?", fx.projectId).state_revision,
      freshRevision,
    );
    const migrationCopy = path.join(fx.root, "migrations-copy");
    fs.cpSync(path.resolve("migrations"), migrationCopy, { recursive: true });
    const forwardMigrationPath = path.join(migrationCopy, "004_synthetic_forward.sql");
    fs.writeFileSync(
      forwardMigrationPath,
      "CREATE TABLE synthetic_escape_must_rollback(id TEXT PRIMARY KEY) STRICT; COMMIT; CREATE TABLE unreachable(id TEXT);\n",
    );
    fx.runtime.close();
    runtime = new BridgeRuntime({
      databasePath: fx.databasePath,
      auditMirrorPath: fx.auditMirrorPath,
      migrationsDir: migrationCopy,
      now: () => fx.clock.value,
    });
    assert.equal(runtime.migrations.plan().pending.length, 1);
    assert.throws(() => runtime.store.migrations.apply(), /pre_migration_backup_required/);
    assert.throws(() => runtime.migrations.apply({
      projectId: fx.projectId,
      actor: fx.owner,
      idempotencyKey: "idempotency.migration.reject-source-only",
      backupManifestPath: path.join(recoveryRoot, sourceOnly.backupId, "manifest.json"),
    }), /full_pre_migration_backup_required/);
    assert.throws(() => runtime.migrations.apply({
      projectId: fx.projectId,
      actor: fx.owner,
      idempotencyKey: "idempotency.migration.reject-stale-full",
      backupManifestPath: path.join(recoveryRoot, full.backupId, "manifest.json"),
    }), /pre_migration_backup_event_sequence_mismatch/);
    assert.throws(() => runtime.migrations.apply({
      projectId: fx.projectId,
      actor: fx.owner,
      idempotencyKey: "idempotency.migration.reject-state-revision-stale",
      backupManifestPath: path.join(recoveryRoot, revisionStale.backupId, "manifest.json"),
    }), /pre_migration_backup_state_revision_mismatch/);
    const migrationRequest = {
      projectId: fx.projectId,
      actor: fx.owner,
      idempotencyKey: "idempotency.migration.apply-current",
      backupManifestPath: path.join(recoveryRoot, fresh.backupId, "manifest.json"),
    };
    const revisionBeforeRejectedMigration = runtime.store.get(
      "SELECT state_revision FROM projects WHERE project_id = ?",
      fx.projectId,
    ).state_revision;
    assert.throws(() => runtime.migrations.apply(migrationRequest), /migration_transaction_control_forbidden/);
    assert.equal(runtime.store.get(
      "SELECT COUNT(*) AS count FROM sqlite_schema WHERE type = 'table' AND name = 'synthetic_escape_must_rollback'",
    ).count, 0, "transaction-escape SQL must be rejected before any migration statement executes");
    assert.equal(runtime.store.get(
      "SELECT COUNT(*) AS count FROM idempotency_records WHERE idempotency_key = ?",
      migrationRequest.idempotencyKey,
    ).count, 0);
    assert.equal(runtime.store.get(
      "SELECT COUNT(*) AS count FROM runtime_operation_reports WHERE operation = 'migration.apply'",
    ).count, 0);
    assert.equal(
      runtime.store.get("SELECT state_revision FROM projects WHERE project_id = ?", fx.projectId).state_revision,
      revisionBeforeRejectedMigration,
    );

    fs.writeFileSync(
      forwardMigrationPath,
      "CREATE TABLE synthetic_end_escape_must_rollback(id TEXT PRIMARY KEY) STRICT; END; CREATE TABLE unreachable_end(id TEXT);\n",
    );
    assert.throws(() => runtime.migrations.apply(migrationRequest), /migration_transaction_control_forbidden/);
    assert.equal(runtime.store.get(
      "SELECT COUNT(*) AS count FROM sqlite_schema WHERE type = 'table' AND name = 'synthetic_end_escape_must_rollback'",
    ).count, 0, "SQLite's END transaction alias must be rejected before any migration statement executes");
    assert.equal(
      runtime.store.get("SELECT state_revision FROM projects WHERE project_id = ?", fx.projectId).state_revision,
      revisionBeforeRejectedMigration,
    );

    fs.writeFileSync(forwardMigrationPath, [
      "-- COMMIT and BEGIN TRANSACTION inside comments are inert.",
      "CREATE TABLE synthetic_forward(id TEXT PRIMARY KEY, note TEXT DEFAULT 'ROLLBACK; ATTACH');",
      "CREATE TRIGGER synthetic_forward_insert AFTER INSERT ON synthetic_forward BEGIN",
      "  UPDATE synthetic_forward",
      "  SET note = CASE WHEN NEW.note IS NULL THEN 'BEGIN is valid in a trigger body' ELSE NEW.note END",
      "  WHERE id = NEW.id;",
      "END;",
      "",
    ].join("\n"));
    const pendingMigrationRestoreDestination = path.join(fx.root, "pending-migration-restore");
    executeOfflineRestore({
      restoreId: "restore.synthetic.pending-forward-migration",
      projectId: fx.projectId,
      actor: fx.owner,
      idempotencyKey: "idempotency.restore.pending-forward-migration",
      manifestPath: path.join(recoveryRoot, fresh.backupId, "manifest.json"),
      destination: pendingMigrationRestoreDestination,
      targetHostId: "host.synthetic.pending-migration-restore",
      mode: "recovery_drill",
      decryptionKey: key,
      runContractTests: () => true,
    }, {
      schemas: runtime.schemas,
      migrationsDir: migrationCopy,
      now: () => fx.clock.value,
    });
    const migratedRestore = new DatabaseSync(path.join(pendingMigrationRestoreDestination, "state.sqlite"), { readOnly: true });
    try {
      assert.equal(migratedRestore.prepare(
        "SELECT COUNT(*) AS count FROM sqlite_schema WHERE type = 'table' AND name = 'synthetic_forward'",
      ).get().count, 1, "an older verified backup must restore and apply the packaged N+1 migration");
      assert.equal(migratedRestore.prepare("SELECT MAX(version) AS version FROM schema_migrations").get().version, 4);
    } finally {
      migratedRestore.close();
    }
    const applied = runtime.migrations.apply(migrationRequest);
    assert.equal(applied.length, 1);
    assert.equal(
      runtime.store.get("SELECT state_revision FROM projects WHERE project_id = ?", fx.projectId).state_revision,
      freshRevision + 1,
    );
    const reportRow = runtime.store.get(
      `SELECT report_id, project_id, operation, principal_id, session_id, host_id,
              generation, occurred_at, report_json
       FROM runtime_operation_reports WHERE operation = 'migration.apply'`,
    );
    assert.ok(reportRow);
    assert.equal(reportRow.project_id, fx.projectId);
    assert.equal(reportRow.principal_id, fx.owner.principalId);
    assert.equal(reportRow.session_id, fx.owner.sessionId);
    assert.equal(reportRow.host_id, fx.owner.hostId);
    const report = JSON.parse(reportRow.report_json);
    assert.equal(report.outcome, "accepted");
    assert.equal(report.acceptedAt, reportRow.occurred_at);
    assert.equal(report.priorSchemaVersion, "3");
    assert.equal(report.newSchemaVersion, "4");
    assert.equal(report.backup.backupId, fresh.backupId);
    assert.equal(report.backup.databaseCheckpoint, fresh.consistency.databaseCheckpoint);
    assert.equal(report.migrations[0].checksum, applied[0].checksum);
    assert.throws(
      () => runtime.store.run("UPDATE runtime_operation_reports SET occurred_at = occurred_at WHERE report_id = ?", reportRow.report_id),
      /immutable_runtime_operation_report/,
    );
    const revisionAfterMigration = runtime.store.get(
      "SELECT state_revision FROM projects WHERE project_id = ?",
      fx.projectId,
    ).state_revision;
    assert.deepEqual(runtime.migrations.apply(migrationRequest), applied);
    assert.equal(
      runtime.store.get("SELECT state_revision FROM projects WHERE project_id = ?", fx.projectId).state_revision,
      revisionAfterMigration,
      "migration idempotency replay must not advance state revision or create a second report",
    );
    assert.equal(runtime.store.get(
      "SELECT COUNT(*) AS count FROM runtime_operation_reports WHERE operation = 'migration.apply'",
    ).count, 1);
    runtime.close();
    runtime = undefined;
    fs.appendFileSync(path.join(migrationCopy, "001_phase1.sql"), "\n-- checksum drift\n");
    runtime = new BridgeRuntime({
      databasePath: fx.databasePath,
      auditMirrorPath: fx.auditMirrorPath,
      migrationsDir: migrationCopy,
      now: () => fx.clock.value,
    });
    assert.throws(() => runtime.migrations.plan(), /migration_checksum_mismatch/);
  } finally {
    try { runtime?.close(); } catch {}
    fx.cleanup();
  }
});
