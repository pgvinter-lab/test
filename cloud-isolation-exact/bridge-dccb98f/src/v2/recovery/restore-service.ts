import { execFileSync } from "node:child_process";
import fs from "node:fs";
import path from "node:path";
import { DatabaseSync } from "node:sqlite";
import { canonicalize, deepCopy, hashCanonical } from "../core/canonical.js";
import { CONTRACT_VERSION } from "../core/constants.js";
import { invariant } from "../core/errors.js";
import { requireIdentifier } from "../core/validation.js";
import type { ContractSchemaRegistry } from "../core/schema-registry.js";
import type { PrincipalRef } from "../core/types.js";
import { IdentityService } from "../identity/identity-service.js";
import { BridgeStore } from "../storage/store.js";
import { MigrationManager } from "../storage/migrations.js";
import { AdapterRegistry } from "../adapters/adapter-registry.js";
import { DoctorService } from "./doctor-service.js";
import type { BackupContent, BackupManifest } from "./backup-service.js";
import { verifyBackupManifest } from "./backup-service.js";
import { decryptFile } from "./encryption.js";

export interface RestoreManifest {
  schemaVersion: "0.1.0-draft.4";
  restoreId: string;
  backupId: string;
  projectId: string;
  mode: "new_host" | "replace_local" | "recovery_drill";
  requestedAt: string;
  requestedBy: PrincipalRef;
  targetHostId: string;
  expectedSourceGeneration: number;
  takeover: { mode: "no_takeover"; newGeneration: number };
  preconditions: Array<{ check: string; status: "pending" | "passed" | "failed" | "waived"; detail?: string }>;
  steps: Array<{
    order: number;
    operation: "verify_backup" | "restore_source" | "restore_state" | "migrate" | "doctor";
    status: "pending" | "running" | "passed" | "failed" | "skipped";
    expectedSha256?: string;
    detail?: string;
  }>;
  validation: { contractTests: "pending" | "passed" | "failed"; doctor: "pending" | "passed" | "failed"; eventSequence: number };
  status: "completed" | "failed";
}

export interface RestoreInput {
  restoreId: string;
  projectId: string;
  actor: PrincipalRef;
  idempotencyKey: string;
  manifestPath: string;
  destination: string;
  targetHostId: string;
  mode: "new_host" | "replace_local" | "recovery_drill";
  decryptionKey?: Buffer;
  runContractTests: (restoredSourceDirectory?: string) => boolean;
}

export interface OfflineRestoreOptions {
  schemas: ContractSchemaRegistry;
  migrationsDir: string;
  now?: () => string;
}

interface IsolatedRestoreOptions extends OfflineRestoreOptions {
  now: () => string;
}

/**
 * Restores a full package without opening or depending on a source Bridge
 * database. This path is deliberately non-activating and cannot replace a
 * live local store; takeover remains a separate, authenticated operation.
 */
export function executeOfflineRestore(
  input: RestoreInput,
  options: OfflineRestoreOptions,
): { manifest: RestoreManifest; destination: string } {
  invariant(input.mode === "new_host" || input.mode === "recovery_drill", "offline_restore_mode_must_be_non_activating");
  return executeIsolatedRestore(input, {
    ...options,
    migrationsDir: path.resolve(options.migrationsDir),
    now: options.now ?? (() => new Date().toISOString()),
  });
}

export class RestoreService {
  constructor(
    private readonly store: BridgeStore,
    private readonly identity: IdentityService,
    private readonly schemas: ContractSchemaRegistry,
  ) {}

  execute(input: RestoreInput): { manifest: RestoreManifest; destination: string } {
    this.identity.authorize(input.projectId, input.actor, ["owner"]);
    validateInput(input);
    const request = {
      restoreId: input.restoreId,
      projectId: input.projectId,
      manifestPath: path.resolve(input.manifestPath),
      destination: path.resolve(input.destination),
      targetHostId: input.targetHostId,
      mode: input.mode,
      decryptionKey: input.decryptionKey ? "[opaque]" : null,
      runContractTests: "[callback]",
    };
    return this.store.mutateIdempotent({
      projectId: input.projectId,
      actor: input.actor,
      operation: "restore.execute",
      idempotencyKey: input.idempotencyKey,
      request,
      run: () => {
        this.identity.authorize(input.projectId, input.actor, ["owner"]);
        invariant(!this.store.get("SELECT restore_id FROM restore_manifests WHERE restore_id = ?", input.restoreId), "restore_id_collision");
        const result = executeIsolatedRestore(input, {
          schemas: this.schemas,
          migrationsDir: this.store.migrationsDir,
          now: this.store.now,
        });
        this.store.run(
          "INSERT INTO restore_manifests(restore_id, backup_id, project_id, requested_at, status, manifest_json) VALUES (?, ?, ?, ?, ?, ?)",
          result.manifest.restoreId,
          result.manifest.backupId,
          result.manifest.projectId,
          result.manifest.requestedAt,
          result.manifest.status,
          JSON.stringify(result.manifest),
        );
        return result;
      },
    });
  }
}

function executeIsolatedRestore(
  input: RestoreInput,
  options: IsolatedRestoreOptions,
): { manifest: RestoreManifest; destination: string } {
  validateInput(input);
  const backup = verifyBackupManifest(input.manifestPath, options.schemas);
  invariant(backup.projectId === input.projectId, "restore_project_mismatch");
  invariant(backup.backupType === "full", "full_backup_required_for_state_restore");
  invariant(backup.destinations.some((destination) => destination.status === "verified"), "verified_backup_destination_required");
  const packageDirectory = path.dirname(path.resolve(input.manifestPath));
  const destination = path.resolve(input.destination);
  const requestHash = restoreRequestHash(input);
  const partial = partialDestination(destination, input.restoreId);
  const failedReport = failureReportPath(destination, input.restoreId);
  assertRestorePathIsolation(packageDirectory, destination, partial, failedReport);
  const adopted = adoptCompletedRestore(input, backup, destination, requestHash, options);
  if (adopted) return adopted;

  const parent = path.dirname(destination);
  assertNormalDirectory(parent, "restore_parent_invalid");
  recoverMatchingPartial(partial, requestHash);
  invariant(!fs.existsSync(destination), "restore_destination_must_be_new");
  fs.mkdirSync(partial, { recursive: false, mode: 0o700 });
  fs.writeFileSync(path.join(partial, ".bridge2-restore-request-hash"), `${requestHash}\n`, { encoding: "utf8", flag: "wx", mode: 0o600 });

  const steps: RestoreManifest["steps"] = [
    { order: 1, operation: "verify_backup", status: "passed", detail: "Manifest schema, exact package inventory, and every declared hash verified before restore." },
  ];
  let phase: RestoreManifest["steps"][number]["operation"] = "restore_source";
  let doctorPassed = false;
  let contractPassed = false;
  let doctorRan = false;
  let contractRan = false;
  try {
    let restoredSource: string | undefined;
    const bundle = backup.contents.find((content) => content.kind === "git_bundle");
    if (bundle) {
      restoredSource = path.join(partial, "source");
      execFileSync("git", ["clone", path.join(packageDirectory, bundle.name), restoredSource], { stdio: "pipe", windowsHide: true });
      const commit = execFileSync("git", ["rev-parse", "HEAD"], { cwd: restoredSource, encoding: "utf8", windowsHide: true }).trim();
      invariant(commit === backup.sourceCommit, "restored_source_commit_mismatch");
      steps.push({ order: 2, operation: "restore_source", status: "passed", expectedSha256: bundle.sha256 });
    } else {
      steps.push({ order: 2, operation: "restore_source", status: "skipped", detail: "No source bundle in package." });
    }

    phase = "restore_state";
    const snapshot = backup.contents.find((content) => content.kind === "state_snapshot");
    invariant(snapshot, "state_snapshot_missing");
    const statePath = path.join(partial, "state.sqlite");
    restoreContent(backup, snapshot, packageDirectory, statePath, input.decryptionKey);
    const audit = backup.contents.find((content) => content.kind === "audit_mirror");
    invariant(audit, "audit_mirror_missing");
    const auditPath = path.join(partial, "audit.events.jsonl");
    restoreContent(backup, audit, packageDirectory, auditPath, input.decryptionKey);
    verifySnapshotBinding(statePath, backup);
    steps.push({ order: 3, operation: "restore_state", status: "passed", expectedSha256: snapshot.sha256, detail: "Snapshot project, generation, and event high-water match the verified manifest." });

    phase = "migrate";
    const database = new DatabaseSync(statePath);
    let appliedCount = 0;
    try {
      const manager = new MigrationManager(database, options.migrationsDir, options.now);
      manager.bootstrap();
      appliedCount = manager.apply({ verifiedBackupManifest: backup, restoredSnapshot: true }).length;
    } finally {
      database.close();
    }
    verifySnapshotBinding(statePath, backup);
    steps.push({
      order: 4,
      operation: "migrate",
      status: appliedCount > 0 ? "passed" : "skipped",
      detail: appliedCount > 0 ? `${appliedCount} forward migration(s) applied to the isolated state.` : "Snapshot already records the current packaged migration set.",
    });

    setRecoveredProjectReadOnly(statePath, backup, options.now());
    verifySnapshotBinding(statePath, backup, "read_only");
    phase = "doctor";
    doctorRan = true;
    doctorPassed = runRestoredDoctor(input, options, statePath, auditPath, restoredSource);
    invariant(doctorPassed, "restored_doctor_failed");
    steps.push({ order: 5, operation: "doctor", status: "passed", detail: "Full read-only doctor completed without failed checks; activation remains excluded." });
    contractRan = true;
    contractPassed = input.runContractTests(restoredSource);
    invariant(contractPassed, "restored_contract_tests_failed");
    const restore = completedManifest(input, backup, options.now(), steps);
    options.schemas.validateNamed("restore-manifest.schema.json", restore);
    persistRecoveredRestoreManifest(statePath, restore);
    verifyRecoveredRestoreBinding(statePath, backup, restore);
    fs.writeFileSync(path.join(partial, "restore-report.json"), `${canonicalize(restore)}\n`, { flag: "wx", mode: 0o600 });
    fsyncTree(partial);
    fs.renameSync(partial, destination);
    fsyncDirectory(path.dirname(destination));
    return { manifest: restore, destination };
  } catch (error) {
    removeOwnedPartial(partial, requestHash);
    writeFailureReport(input, backup, destination, phase, steps, doctorRan, doctorPassed, contractRan, contractPassed, error, options);
    throw error;
  }
}

function adoptCompletedRestore(
  input: RestoreInput,
  backup: BackupManifest,
  destination: string,
  requestHash: string,
  options: IsolatedRestoreOptions,
): { manifest: RestoreManifest; destination: string } | undefined {
  if (!fs.existsSync(destination)) return undefined;
  assertNormalDirectory(destination, "restore_destination_must_be_new");
  const marker = path.join(destination, ".bridge2-restore-request-hash");
  invariant(regularFileText(marker)?.trim() === requestHash, "restore_destination_must_be_new");
  const reportPath = path.join(destination, "restore-report.json");
  const report = JSON.parse(fs.readFileSync(reportPath, "utf8")) as RestoreManifest;
  options.schemas.validateNamed("restore-manifest.schema.json", report);
  invariant(
    report.status === "completed" && report.restoreId === input.restoreId && report.backupId === backup.backupId &&
      report.projectId === input.projectId && report.mode === input.mode && report.targetHostId === input.targetHostId &&
      report.expectedSourceGeneration === backup.generation && report.validation.eventSequence === backup.consistency.eventSequence,
    "restore_completed_report_mismatch",
  );
  const statePath = path.join(destination, "state.sqlite");
  const auditPath = path.join(destination, "audit.events.jsonl");
  verifyRecoveredRestoreBinding(statePath, backup, report);
  const restoredSource = fs.existsSync(path.join(destination, "source")) ? path.join(destination, "source") : undefined;
  if (restoredSource) {
    const commit = execFileSync("git", ["rev-parse", "HEAD"], { cwd: restoredSource, encoding: "utf8", windowsHide: true }).trim();
    invariant(commit === backup.sourceCommit, "restored_source_commit_mismatch");
  }
  invariant(runRestoredDoctor(input, options, statePath, auditPath, restoredSource), "restored_doctor_failed");
  invariant(input.runContractTests(restoredSource), "restored_contract_tests_failed");
  return { manifest: deepCopy(report), destination };
}

function validateInput(input: RestoreInput): void {
  requireIdentifier(input.restoreId, "restoreId", "restore.");
  requireIdentifier(input.targetHostId, "targetHostId", "host.");
}

function restoreRequestHash(input: RestoreInput): string {
  return hashCanonical({
    restoreId: input.restoreId,
    projectId: input.projectId,
    manifestPath: path.resolve(input.manifestPath),
    destination: path.resolve(input.destination),
    targetHostId: input.targetHostId,
    mode: input.mode,
    decryptionKey: input.decryptionKey ? "[opaque]" : null,
    runContractTests: "[callback]",
  });
}

function partialDestination(destination: string, restoreId: string): string {
  return path.join(path.dirname(destination), `.${path.basename(destination)}.${restoreId}.partial`);
}

function failureReportPath(destination: string, restoreId: string): string {
  return path.join(path.dirname(destination), `${path.basename(destination)}.${restoreId}.failed.json`);
}

function assertRestorePathIsolation(packageDirectory: string, destination: string, partial: string, failedReport: string): void {
  assertNormalDirectory(packageDirectory, "restore_package_directory_invalid");
  for (const mutableDirectory of [destination, partial]) {
    invariant(!isWithin(packageDirectory, mutableDirectory) && !isWithin(mutableDirectory, packageDirectory), "restore_path_overlaps_backup_package");
  }
  invariant(!isWithin(failedReport, packageDirectory), "restore_failure_report_overlaps_backup_package");
  invariant(!samePath(failedReport, path.join(packageDirectory, "manifest.json")), "restore_failure_report_overlaps_backup_package");
}

function recoverMatchingPartial(partial: string, requestHash: string): void {
  if (!fs.existsSync(partial)) return;
  assertNormalDirectory(partial, "restore_partial_destination_collision");
  invariant(regularFileText(path.join(partial, ".bridge2-restore-request-hash"))?.trim() === requestHash, "restore_partial_destination_collision");
  fs.rmSync(partial, { recursive: true, force: true });
}

function removeOwnedPartial(partial: string, requestHash: string): void {
  if (!fs.existsSync(partial)) return;
  const stat = fs.lstatSync(partial);
  if (!stat.isDirectory() || stat.isSymbolicLink()) return;
  if (regularFileText(path.join(partial, ".bridge2-restore-request-hash"))?.trim() !== requestHash) return;
  fs.rmSync(partial, { recursive: true, force: true });
}

function verifySnapshotBinding(statePath: string, backup: BackupManifest, requiredStatus?: "read_only"): void {
  const database = new DatabaseSync(statePath, { readOnly: true });
  try {
    const integrity = database.prepare("PRAGMA quick_check").get() as { quick_check: string } | undefined;
    invariant(integrity?.quick_check === "ok", "restored_snapshot_integrity_failed");
    const project = database.prepare("SELECT active_generation, state_revision, status FROM projects WHERE project_id = ?")
      .get(backup.projectId) as { active_generation: number; state_revision: number; status: string } | undefined;
    invariant(project, "restored_snapshot_project_mismatch");
    invariant(Number(project.active_generation) === backup.generation, "restored_snapshot_generation_mismatch");
    const checkpoint = /^sqlite-state-revision-(\d+)$/u.exec(backup.consistency.databaseCheckpoint);
    invariant(checkpoint, "restored_snapshot_state_revision_checkpoint_invalid");
    // The snapshot is captured inside the backup transaction. Its manifest and
    // idempotency record commit immediately afterward as the transaction's one
    // central revision bump, so the published checkpoint is exactly N + 1.
    invariant(
      Number(checkpoint[1]) === Number(project.state_revision) + 1,
      "restored_snapshot_state_revision_mismatch",
    );
    if (requiredStatus) invariant(project.status === requiredStatus, "restored_project_not_read_only");
    const event = database.prepare("SELECT COALESCE(MAX(sequence), 0) AS sequence FROM events WHERE project_id = ?")
      .get(backup.projectId) as { sequence: number };
    invariant(Number(event.sequence) === backup.consistency.eventSequence, "restored_snapshot_event_sequence_mismatch");
  } finally {
    database.close();
  }
}

function setRecoveredProjectReadOnly(statePath: string, backup: BackupManifest, at: string): void {
  const database = new DatabaseSync(statePath);
  try {
    database.exec("BEGIN IMMEDIATE");
    try {
      const result = database.prepare(
        "UPDATE projects SET status = 'read_only', updated_at = ? WHERE project_id = ? AND active_generation = ?",
      ).run(at, backup.projectId, backup.generation);
      invariant(Number(result.changes) === 1, "restored_project_read_only_transition_failed");
      database.exec("COMMIT");
    } catch (error) {
      try { database.exec("ROLLBACK"); } catch { /* preserve original failure */ }
      throw error;
    }
  } finally {
    database.close();
  }
}

function persistRecoveredRestoreManifest(statePath: string, restore: RestoreManifest): void {
  const database = new DatabaseSync(statePath);
  try {
    database.exec("BEGIN IMMEDIATE");
    try {
      invariant(
        !database.prepare("SELECT restore_id FROM restore_manifests WHERE restore_id = ?").get(restore.restoreId),
        "restored_restore_id_collision",
      );
      database.prepare(
        "INSERT INTO restore_manifests(restore_id, backup_id, project_id, requested_at, status, manifest_json) VALUES (?, ?, ?, ?, ?, ?)",
      ).run(
        restore.restoreId,
        restore.backupId,
        restore.projectId,
        restore.requestedAt,
        restore.status,
        JSON.stringify(restore),
      );
      database.exec("COMMIT");
    } catch (error) {
      try { database.exec("ROLLBACK"); } catch { /* preserve original failure */ }
      throw error;
    }
  } finally {
    database.close();
  }
}

function verifyRecoveredRestoreBinding(statePath: string, backup: BackupManifest, restore: RestoreManifest): void {
  verifySnapshotBinding(statePath, backup, "read_only");
  const database = new DatabaseSync(statePath, { readOnly: true });
  try {
    const row = database.prepare(
      "SELECT backup_id, project_id, requested_at, status, manifest_json FROM restore_manifests WHERE restore_id = ?",
    ).get(restore.restoreId) as {
      backup_id: string;
      project_id: string;
      requested_at: string;
      status: string;
      manifest_json: string;
    } | undefined;
    invariant(
      row && row.backup_id === restore.backupId && row.project_id === restore.projectId &&
        row.requested_at === restore.requestedAt && row.status === "completed" &&
        canonicalize(JSON.parse(row.manifest_json)) === canonicalize(restore) &&
        restore.targetHostId.length > 0 && restore.takeover.mode === "no_takeover",
      "restored_restore_manifest_binding_mismatch",
    );
  } finally {
    database.close();
  }
}

function runRestoredDoctor(
  input: RestoreInput,
  options: IsolatedRestoreOptions,
  statePath: string,
  auditPath: string,
  restoredSource?: string,
): boolean {
  const restoredStore = new BridgeStore({
    databasePath: statePath,
    auditMirrorPath: auditPath,
    migrationsDir: options.migrationsDir,
    readOnly: true,
    now: options.now,
  });
  try {
    const restoredIdentity = new IdentityService(restoredStore, options.schemas);
    const restoredAdapters = new AdapterRegistry(restoredStore, restoredIdentity, options.schemas);
    const doctor = new DoctorService(restoredStore, restoredIdentity, restoredAdapters, options.schemas).run({
      projectId: input.projectId,
      hostId: input.targetHostId,
      sourceRoot: restoredSource,
      isolatedRestore: true,
    });
    const failed = doctor.checks.filter((check) => check.status === "fail");
    invariant(failed.length === 0, "restored_doctor_failed", { failedChecks: failed });
    return true;
  } finally {
    restoredStore.close();
  }
}

function completedManifest(
  input: RestoreInput,
  backup: BackupManifest,
  at: string,
  steps: RestoreManifest["steps"],
): RestoreManifest {
  return {
    schemaVersion: CONTRACT_VERSION,
    restoreId: input.restoreId,
    backupId: backup.backupId,
    projectId: input.projectId,
    mode: input.mode,
    requestedAt: at,
    requestedBy: deepCopy(input.actor),
    targetHostId: input.targetHostId,
    expectedSourceGeneration: backup.generation,
    takeover: { mode: "no_takeover", newGeneration: backup.generation },
    preconditions: [
      { check: "Backup hashes, inventory, and schema verify", status: "passed" },
      { check: "Snapshot project, generation, and event sequence match manifest", status: "passed" },
      { check: "Restore destination is new and isolated", status: "passed" },
      { check: "Activation is excluded from restore execution", status: "passed" },
    ],
    steps,
    validation: { contractTests: "passed", doctor: "passed", eventSequence: backup.consistency.eventSequence },
    status: "completed",
  };
}

function writeFailureReport(
  input: RestoreInput,
  backup: BackupManifest,
  destination: string,
  phase: RestoreManifest["steps"][number]["operation"],
  steps: RestoreManifest["steps"],
  doctorRan: boolean,
  doctorPassed: boolean,
  contractRan: boolean,
  contractPassed: boolean,
  error: unknown,
  options: IsolatedRestoreOptions,
): void {
  const detail = error instanceof Error ? error.message.slice(0, 2000) : String(error).slice(0, 2000);
  const failure: RestoreManifest = {
    schemaVersion: CONTRACT_VERSION,
    restoreId: input.restoreId,
    backupId: backup.backupId,
    projectId: input.projectId,
    mode: input.mode,
    requestedAt: options.now(),
    requestedBy: deepCopy(input.actor),
    targetHostId: input.targetHostId,
    expectedSourceGeneration: backup.generation,
    takeover: { mode: "no_takeover", newGeneration: backup.generation },
    preconditions: [{ check: "Restore remained isolated and was not activated", status: "passed" }],
    steps: steps.some((step) => step.operation === phase)
      ? steps
      : [...steps, { order: steps.length + 1, operation: phase, status: "failed", detail }],
    validation: {
      contractTests: contractRan ? (contractPassed ? "passed" : "failed") : "pending",
      doctor: doctorRan ? (doctorPassed ? "passed" : "failed") : "pending",
      eventSequence: backup.consistency.eventSequence,
    },
    status: "failed",
  };
  try {
    options.schemas.validateNamed("restore-manifest.schema.json", failure);
    const reportPath = failureReportPath(destination, input.restoreId);
    if (!fs.existsSync(reportPath)) fs.writeFileSync(reportPath, `${canonicalize(failure)}\n`, { flag: "wx", mode: 0o600 });
  } catch { /* preserve the original restore failure */ }
}

function restoreContent(
  backup: BackupManifest,
  content: BackupContent,
  packageDirectory: string,
  destination: string,
  key?: Buffer,
): void {
  if (backup.encryption.mode === "aes-256-gcm") {
    invariant(key, "restore_decryption_key_required");
    decryptFile(path.join(packageDirectory, content.name), destination, key, encryptionAad(backup.backupId, content));
  } else {
    fs.copyFileSync(path.join(packageDirectory, content.name), destination, fs.constants.COPYFILE_EXCL);
    if (process.platform !== "win32") fs.chmodSync(destination, 0o600);
  }
}

function fsyncTree(directory: string): void {
  for (const entry of fs.readdirSync(directory, { withFileTypes: true })) {
    const candidate = path.join(directory, entry.name);
    if (entry.isSymbolicLink()) continue;
    if (entry.isDirectory()) fsyncTree(candidate);
    else if (entry.isFile()) fsyncRegularFile(candidate);
  }
  fsyncDirectory(directory);
}

function fsyncRegularFile(filePath: string): void {
  let handle: number | undefined;
  let restoreMode: number | undefined;
  try {
    try {
      handle = fs.openSync(filePath, process.platform === "win32" ? "r+" : "r");
    } catch (error) {
      const code = (error as NodeJS.ErrnoException).code;
      if (process.platform !== "win32" || (code !== "EACCES" && code !== "EPERM")) throw error;
      restoreMode = fs.statSync(filePath).mode;
      fs.chmodSync(filePath, restoreMode | 0o200);
      handle = fs.openSync(filePath, "r+");
    }
    fs.fsyncSync(handle);
  } finally {
    if (handle !== undefined) fs.closeSync(handle);
    if (restoreMode !== undefined) fs.chmodSync(filePath, restoreMode);
  }
}

function fsyncDirectory(directory: string): void {
  let handle: number | undefined;
  try {
    handle = fs.openSync(directory, "r");
    fs.fsyncSync(handle);
  } catch (error) {
    const code = (error as NodeJS.ErrnoException).code;
    if (process.platform !== "win32" || (code !== "EINVAL" && code !== "EPERM" && code !== "EISDIR")) throw error;
  } finally {
    if (handle !== undefined) fs.closeSync(handle);
  }
}

function encryptionAad(backupId: string, content: BackupContent): unknown {
  return { contractVersion: CONTRACT_VERSION, backupId, name: content.name, kind: content.kind };
}

function assertNormalDirectory(directory: string, code: string): void {
  const stat = fs.lstatSync(directory, { throwIfNoEntry: false });
  invariant(stat?.isDirectory() && !stat.isSymbolicLink(), code);
  const real = fs.realpathSync.native(directory);
  invariant(samePath(real, directory), code);
}

function regularFileText(filePath: string): string | undefined {
  const stat = fs.lstatSync(filePath, { throwIfNoEntry: false });
  if (!stat?.isFile() || stat.isSymbolicLink()) return undefined;
  return fs.readFileSync(filePath, "utf8");
}

function samePath(left: string, right: string): boolean {
  const normalize = (value: string): string => {
    const resolved = path.resolve(value);
    return process.platform === "win32" ? resolved.toLowerCase() : resolved;
  };
  return normalize(left) === normalize(right);
}

function isWithin(candidate: string, root: string): boolean {
  const relative = path.relative(path.resolve(root), path.resolve(candidate));
  return relative === "" || (!relative.startsWith("..") && !path.isAbsolute(relative));
}
