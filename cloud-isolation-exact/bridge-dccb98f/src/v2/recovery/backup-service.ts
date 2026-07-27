import { execFileSync } from "node:child_process";
import fs from "node:fs";
import path from "node:path";
import { pathToFileURL } from "node:url";
import { DatabaseSync } from "node:sqlite";
import { canonicalEqual, canonicalize, deepCopy, hashCanonical, sha256 } from "../core/canonical.js";
import { CONTRACT_VERSION } from "../core/constants.js";
import { invariant } from "../core/errors.js";
import { requireIdentifier, requireNonEmptyString, requireSha256, requireTimestamp, requireUriReference } from "../core/validation.js";
import type { ContractSchemaRegistry } from "../core/schema-registry.js";
import type { PrincipalRef } from "../core/types.js";
import type { IdentityService } from "../identity/identity-service.js";
import type { BridgeStore } from "../storage/store.js";
import { encryptBuffer, encryptFile } from "./encryption.js";

export interface BackupContent {
  name: string;
  kind: "git_bundle" | "state_snapshot" | "event_log" | "audit_mirror" | "artifact_index" | "configuration";
  sizeBytes: number;
  sha256: string;
  sensitivity: "public" | "internal" | "confidential" | "restricted";
}

export interface BackupManifest {
  schemaVersion: "0.1.0-draft.4";
  backupId: string;
  projectId: string;
  contractVersion: "0.1.0-draft.4";
  backupType: "source_only" | "full";
  generation: number;
  createdAt: string;
  createdBy: PrincipalRef;
  sourceHostId: string;
  sourceCommit: string;
  dirty: boolean;
  consistency: { quiesced: boolean; eventSequence: number; databaseCheckpoint: string };
  contents: BackupContent[];
  encryption: {
    mode: "none" | "aes-256-gcm";
    keyRef?: string;
    wrappedKeyCapsule?: {
      capsuleRef: string;
      storageAccountRef: "drive-account://recovery-key-account";
      wrappingAlgorithmId: string;
      recoveryProcedureRef: string;
      decryptionSecretCustody: "local_and_drive";
      recipientKeyFingerprint: string;
      capsuleSha256: string;
    };
  };
  destinations: Array<{ kind: "local" | "drive"; uri: string; status: "pending" | "verified" | "failed"; verifiedAt?: string }>;
  previousBackupId?: string;
  ownerException?: { approvalGrantId: string; reason: string; approvedBy: PrincipalRef };
}

export interface EncryptionMetadata {
  mode: "aes-256-gcm";
  keyRef: string;
  key: Buffer;
  wrappedKeyCapsule: NonNullable<BackupManifest["encryption"]["wrappedKeyCapsule"]>;
}

export interface CreateBackupInput {
  backupId: string;
  projectId: string;
  actor: PrincipalRef;
  idempotencyKey: string;
  backupType: "source_only" | "full";
  sourceRoot: string;
  destinationRoot: string;
  encryption?: EncryptionMetadata;
  ownerException?: BackupManifest["ownerException"];
  previousBackupId?: string;
}

export interface DirtyBackupGrantConsumption {
  projectId: string;
  backupId: string;
  actor: PrincipalRef;
  approvalGrantId: string;
  action: "backup.source_only.dirty";
  conditions: { backupId: string };
}

/** The approval service implements this boundary to consume and journal a use. */
export interface DirtyBackupGrantConsumer {
  consumeDirtyBackupGrant(input: DirtyBackupGrantConsumption): void;
}

export interface DirtyWorktreeArchive {
  schemaVersion: "bridge2-dirty-worktree-v1";
  baseCommit: string;
  entries: Array<
    | { path: string; state: "deleted" }
    | { path: string; state: "present"; kind: "file" | "symlink"; sizeBytes: number; sha256: string; executable: boolean; contentBase64: string }
  >;
}

interface SourceSnapshot {
  commit: string;
  status: string;
}

export class BackupService {
  constructor(
    private readonly store: BridgeStore,
    private readonly identity: IdentityService,
    private readonly schemas: ContractSchemaRegistry,
    private readonly dirtyGrantConsumer?: DirtyBackupGrantConsumer,
  ) {}

  create(input: CreateBackupInput): BackupManifest {
    this.identity.authorize(input.projectId, input.actor, ["owner"]);
    requireIdentifier(input.backupId, "backupId", "backup.");
    const sourceRoot = canonicalExistingDirectory(input.sourceRoot, "backup_source_reparse_forbidden");
    const destinationRoot = canonicalFutureDirectory(input.destinationRoot, "backup_destination_reparse_forbidden");
    invariant(
      !isWithin(destinationRoot, sourceRoot) && !isWithin(sourceRoot, destinationRoot),
      "backup_source_destination_overlap_forbidden",
    );
    const liveStatePaths = [this.store.databasePath, this.store.auditMirrorPath]
      .filter(Boolean)
      .map((item) => path.resolve(item!));
    invariant(
      !liveStatePaths.some((item) => isWithin(item, sourceRoot)),
      "backup_source_contains_live_state",
    );
    invariant(
      !liveStatePaths.some((item) => isWithin(item, destinationRoot)),
      "backup_destination_contains_live_state",
    );
    if (input.encryption) this.validateEncryption(input.encryption);
    if (input.backupType === "full") invariant(input.encryption, "full_backup_encryption_required");
    if (input.backupType === "full") {
      this.store.flushAuditMirror();
      this.store.exec("PRAGMA wal_checkpoint(FULL)");
    }
    const request = {
      backupId: input.backupId,
      projectId: input.projectId,
      backupType: input.backupType,
      sourceRoot,
      destinationRoot,
      ...(input.encryption ? {
        encryption: {
          mode: "aes-256-gcm",
          keyRef: input.encryption.keyRef,
          wrappedKeyCapsule: deepCopy(input.encryption.wrappedKeyCapsule),
        },
      } : {}),
      ...(input.previousBackupId ? { previousBackupId: input.previousBackupId } : {}),
      ...(input.ownerException ? { ownerException: deepCopy(input.ownerException) } : {}),
    };
    const recoveryHash = hashCanonical(request);
    return this.store.mutateIdempotent({
      projectId: input.projectId,
      actor: input.actor,
      operation: "backup.create",
      idempotencyKey: input.idempotencyKey,
      request,
      run: () => {
        // Authorization and filesystem side effects belong to the same writer
        // critical section as the durable command. This closes the gap between
        // the optimistic check above and role revocation by another process.
        this.identity.authorize(input.projectId, input.actor, ["owner"]);
        this.sweepSecurePlaintextStaging();
        invariant(!this.store.get("SELECT backup_id FROM backup_manifests WHERE backup_id = ?", input.backupId), "backup_id_collision");
        const project = this.store.get<{ state_revision: number }>(
          "SELECT state_revision FROM projects WHERE project_id = ?",
          input.projectId,
        );
        invariant(project, "project_not_found");
        const expectedCheckpoint = `sqlite-state-revision-${Number(project.state_revision) + 1}`;
        let manifest = this.recoverOrphanPackage(destinationRoot, input.backupId, recoveryHash);
        if (manifest) {
          invariant(manifest.projectId === input.projectId && manifest.backupType === input.backupType, "backup_orphan_request_mismatch");
          invariant(manifest.consistency.databaseCheckpoint === expectedCheckpoint, "backup_orphan_state_revision_mismatch");
          if (manifest.backupType === "source_only" && manifest.dirty) this.validateOwnerException(input);
        } else {
          const source = this.captureSourceSnapshot(sourceRoot);
          const dirty = source.status.length > 0;
          if (input.backupType === "full") invariant(!dirty, "full_backup_requires_clean_source");
          if (input.backupType === "source_only" && dirty) this.validateOwnerException(input);
          manifest = this.buildPackage(input, sourceRoot, destinationRoot, recoveryHash, source, expectedCheckpoint);
        }
        this.store.run(
          "INSERT INTO backup_manifests(backup_id, project_id, generation, event_sequence, created_at, manifest_json) VALUES (?, ?, ?, ?, ?, ?)",
          manifest.backupId,
          manifest.projectId,
          manifest.generation,
          manifest.consistency.eventSequence,
          manifest.createdAt,
          JSON.stringify(manifest),
        );
        return deepCopy(manifest);
      },
    });
  }

  private buildPackage(
    input: CreateBackupInput,
    sourceRoot: string,
    destinationRoot: string,
    recoveryHash: string,
    source: SourceSnapshot,
    expectedCheckpoint: string,
  ): BackupManifest {
    assertCanonicalDirectory(sourceRoot, "backup_source_reparse_forbidden");
    fs.mkdirSync(destinationRoot, { recursive: true });
    assertCanonicalDirectory(destinationRoot, "backup_destination_reparse_forbidden");
    invariant(
      !isWithin(destinationRoot, sourceRoot) && !isWithin(sourceRoot, destinationRoot),
      "backup_source_destination_overlap_forbidden",
    );
    const packageDirectory = path.join(destinationRoot, input.backupId);
    invariant(!fs.existsSync(packageDirectory), "backup_destination_exists");
    const temporaryDirectory = path.join(destinationRoot, `.${input.backupId}.partial`);
    this.prepareOwnedBackupPartial(destinationRoot, temporaryDirectory, input.backupId, recoveryHash);
    const plaintextDirectory = input.backupType === "full"
      ? this.prepareSecurePlaintextStaging(input.backupId, recoveryHash)
      : undefined;
    try {
      if (input.previousBackupId) {
        invariant(this.store.get(
          "SELECT backup_id FROM backup_manifests WHERE backup_id = ? AND project_id = ?",
          input.previousBackupId,
          input.projectId,
        ), "previous_backup_not_found");
      }
      let project = this.store.get<{ active_generation: number }>(
        "SELECT active_generation FROM projects WHERE project_id = ?",
        input.projectId,
      );
      invariant(project, "project_not_found");
      let eventSequence = Number(this.store.get<{ sequence: number }>(
        "SELECT COALESCE(MAX(sequence), 0) AS sequence FROM events WHERE project_id = ?",
        input.projectId,
      )?.sequence ?? 0);
      const contents: BackupContent[] = [];
      const bundleName = "source.bundle";
      const bundlePath = path.join(temporaryDirectory, bundleName);
      this.assertSourceSnapshot(sourceRoot, source);
      execFileSync("git", ["bundle", "create", bundlePath, "HEAD"], { cwd: sourceRoot, stdio: "pipe", windowsHide: true });
      execFileSync("git", ["bundle", "verify", bundlePath], { cwd: sourceRoot, stdio: "pipe", windowsHide: true });
      this.assertBundleCommit(sourceRoot, bundlePath, source.commit);
      contents.push(this.content(bundlePath, bundleName, "git_bundle", "internal"));

      let dirtyArchive: DirtyWorktreeArchive | undefined;
      if (input.backupType === "source_only" && source.status.length > 0) {
        const archiveName = "dirty-worktree.json";
        const archivePath = path.join(temporaryDirectory, archiveName);
        dirtyArchive = this.dirtyArchive(sourceRoot, source.commit);
        fs.writeFileSync(archivePath, `${canonicalize(dirtyArchive)}\n`, { encoding: "utf8", flag: "wx" });
        contents.push(this.content(archivePath, archiveName, "configuration", "internal"));
      }

      if (input.backupType === "full") {
        const encryption = input.encryption!;
        this.assertFullBackupMirrorBarrier(input.projectId);
        const snapshotPlain = path.join(plaintextDirectory!, "state.snapshot.sqlite");
        const snapshotWriter = new DatabaseSync(this.store.databasePath, { readOnly: true });
        try {
          snapshotWriter.exec(`VACUUM INTO '${snapshotPlain.replaceAll("'", "''")}'`);
        } finally {
          snapshotWriter.close();
        }
        const snapshot = new DatabaseSync(snapshotPlain, { readOnly: true });
        let entries: Array<{ entry_json: string; file_appended: number }>;
        try {
          const snapshotProject = snapshot.prepare("SELECT active_generation FROM projects WHERE project_id = ?")
            .get(input.projectId) as { active_generation: number } | undefined;
          invariant(snapshotProject, "backup_snapshot_project_missing");
          project = snapshotProject;
          eventSequence = Number((snapshot.prepare(
            "SELECT COALESCE(MAX(sequence), 0) AS sequence FROM events WHERE project_id = ?",
          ).get(input.projectId) as { sequence: number }).sequence);
          const eventCount = Number((snapshot.prepare(
            "SELECT COUNT(*) AS count FROM events WHERE project_id = ?",
          ).get(input.projectId) as { count: number }).count);
          entries = snapshot.prepare(
            "SELECT entry_json, file_appended FROM audit_mirror_entries WHERE project_id = ? ORDER BY mirror_sequence",
          ).all(input.projectId) as Array<{ entry_json: string; file_appended: number }>;
          invariant(eventCount === eventSequence, "backup_snapshot_event_sequence_not_contiguous");
          invariant(entries.length === eventCount, "backup_snapshot_audit_event_count_mismatch");
          invariant(entries.every((entry) => Number(entry.file_appended) === 1), "backup_snapshot_audit_projection_pending");
        } finally {
          snapshot.close();
        }
        const snapshotName = "state.snapshot.enc";
        const snapshotPath = path.join(temporaryDirectory, snapshotName);
        encryptFile(snapshotPlain, snapshotPath, encryption.key, this.encryptionAad(input.backupId, snapshotName, "state_snapshot"));
        contents.push(this.content(snapshotPath, snapshotName, "state_snapshot", "confidential"));
        const auditName = "audit.events.jsonl.enc";
        const auditPath = path.join(temporaryDirectory, auditName);
        const auditPlain = Buffer.from(
          entries.map((row) => canonicalize(JSON.parse(row.entry_json))).join("\n") + (entries.length ? "\n" : ""),
          "utf8",
        );
        fs.writeFileSync(
          auditPath,
          encryptBuffer(auditPlain, encryption.key, this.encryptionAad(input.backupId, auditName, "audit_mirror")),
          { flag: "wx" },
        );
        contents.push(this.content(auditPath, auditName, "audit_mirror", "confidential"));
      }

      const at = this.store.now();
      const manifest: BackupManifest = {
        schemaVersion: CONTRACT_VERSION,
        backupId: input.backupId,
        projectId: input.projectId,
        contractVersion: CONTRACT_VERSION,
        backupType: input.backupType,
        generation: Number(project.active_generation),
        createdAt: at,
        createdBy: deepCopy(input.actor),
        sourceHostId: input.actor.hostId,
        sourceCommit: source.commit,
        dirty: source.status.length > 0,
        consistency: {
          quiesced: input.backupType === "full",
          eventSequence,
          databaseCheckpoint: expectedCheckpoint,
        },
        contents,
        encryption: input.encryption
          ? { mode: "aes-256-gcm", keyRef: input.encryption.keyRef, wrappedKeyCapsule: deepCopy(input.encryption.wrappedKeyCapsule) }
          : { mode: "none" },
        destinations: [{ kind: "local", uri: pathToFileURL(packageDirectory).href, status: "verified", verifiedAt: at }],
        ...(input.previousBackupId ? { previousBackupId: input.previousBackupId } : {}),
        ...(input.ownerException ? { ownerException: deepCopy(input.ownerException) } : {}),
      };
      this.schemas.validateNamed("backup-manifest.schema.json", manifest);
      fs.writeFileSync(path.join(temporaryDirectory, "manifest.json"), `${canonicalize(manifest)}\n`, { encoding: "utf8", flag: "wx" });
      this.verifyPackage(temporaryDirectory, manifest);
      // The commit, clean/dirty state, archived dirty bytes, and bundle head
      // must all still describe the same source immediately before publish.
      this.assertSourceSnapshot(sourceRoot, source);
      if (dirtyArchive) this.assertDirtyArchiveSnapshot(sourceRoot, dirtyArchive);
      this.assertBundleCommit(sourceRoot, bundlePath, source.commit);
      assertCanonicalDirectory(destinationRoot, "backup_destination_reparse_forbidden");
      fsyncTree(temporaryDirectory);
      fs.renameSync(temporaryDirectory, packageDirectory);
      fsyncDirectory(destinationRoot);
      return manifest;
    } catch (error) {
      removeOwnedDirectory(temporaryDirectory, ".bridge2-request-hash", recoveryHash, false);
      throw error;
    } finally {
      if (plaintextDirectory) removeOwnedDirectory(plaintextDirectory, ".bridge2-staging-owner", recoveryHash, true);
    }
  }

  private assertFullBackupMirrorBarrier(projectId: string): void {
    const eventCount = Number(this.store.get<{ count: number }>(
      "SELECT COUNT(*) AS count FROM events WHERE project_id = ?",
      projectId,
    )?.count ?? 0);
    if (eventCount === 0) return;
    invariant(this.store.auditMirrorPath && fs.existsSync(this.store.auditMirrorPath), "full_backup_audit_mirror_required");
    const mirror = this.store.get<{ count: number; pending: number }>(
      `SELECT COUNT(*) AS count,
              COALESCE(SUM(CASE WHEN file_appended = 1 THEN 0 ELSE 1 END), 0) AS pending
       FROM audit_mirror_entries WHERE project_id = ?`,
      projectId,
    );
    invariant(Number(mirror?.count ?? 0) === eventCount, "full_backup_audit_event_count_mismatch");
    invariant(Number(mirror?.pending ?? 0) === 0, "full_backup_audit_projection_pending");
  }

  private prepareOwnedBackupPartial(destinationRoot: string, temporaryDirectory: string, backupId: string, recoveryHash: string): void {
    for (const entry of fs.readdirSync(destinationRoot, { withFileTypes: true })) {
      if (!entry.name.startsWith(`.${backupId}.partial-`) || !entry.isDirectory() || entry.isSymbolicLink()) continue;
      const candidate = path.join(destinationRoot, entry.name);
      if (regularFileText(path.join(candidate, ".bridge2-request-hash"))?.trim() === recoveryHash) {
        removeOwnedDirectory(candidate, ".bridge2-request-hash", recoveryHash, false);
      }
    }
    if (fs.existsSync(temporaryDirectory)) {
      invariant(
        regularFileText(path.join(temporaryDirectory, ".bridge2-request-hash"))?.trim() === recoveryHash,
        "backup_partial_destination_collision",
      );
      removeOwnedDirectory(temporaryDirectory, ".bridge2-request-hash", recoveryHash, false);
    }
    fs.mkdirSync(temporaryDirectory, { mode: 0o700 });
    fs.writeFileSync(path.join(temporaryDirectory, ".bridge2-request-hash"), `${recoveryHash}\n`, { encoding: "utf8", flag: "wx", mode: 0o600 });
  }

  private prepareSecurePlaintextStaging(backupId: string, recoveryHash: string): string {
    const root = path.join(path.dirname(this.store.databasePath), ".bridge2-secure-staging");
    if (!fs.existsSync(root)) fs.mkdirSync(root, { mode: 0o700 });
    assertNormalDirectory(root, "backup_secure_staging_root_invalid");
    const staging = path.join(root, backupId);
    if (fs.existsSync(staging)) {
      invariant(
        regularFileText(path.join(staging, ".bridge2-staging-owner"))?.trim() === recoveryHash,
        "backup_secure_staging_collision",
      );
      removeOwnedDirectory(staging, ".bridge2-staging-owner", recoveryHash, true);
    }
    fs.mkdirSync(staging, { mode: 0o700 });
    fs.writeFileSync(path.join(staging, ".bridge2-staging-owner"), `${recoveryHash}\n`, { encoding: "utf8", flag: "wx", mode: 0o600 });
    return staging;
  }

  private sweepSecurePlaintextStaging(): void {
    this.store.assertWriteTransaction();
    const root = path.join(path.dirname(this.store.databasePath), ".bridge2-secure-staging");
    if (!fs.existsSync(root)) return;
    assertCanonicalDirectory(root, "backup_secure_staging_root_invalid");
    for (const entry of fs.readdirSync(root, { withFileTypes: true })) {
      const candidate = path.join(root, entry.name);
      const stat = tryLstat(candidate);
      // Never inspect through a link or junction. A stale area is ours only
      // when it is a normal child directory with a regular exact marker.
      if (!stat?.isDirectory() || stat.isSymbolicLink()) continue;
      invariant(samePath(fs.realpathSync.native(candidate), candidate), "owned_recovery_staging_invalid");
      const marker = regularFileText(path.join(candidate, ".bridge2-staging-owner"))?.trim();
      if (!marker || !/^[a-f0-9]{64}$/u.test(marker)) continue;
      removeOwnedDirectory(candidate, ".bridge2-staging-owner", marker, true);
    }
  }

  private recoverOrphanPackage(destinationRoot: string, backupId: string, recoveryHash: string): BackupManifest | undefined {
    const packageDirectory = path.join(destinationRoot, backupId);
    if (!fs.existsSync(packageDirectory)) return undefined;
    const hashPath = path.join(packageDirectory, ".bridge2-request-hash");
    invariant(fs.existsSync(hashPath) && fs.readFileSync(hashPath, "utf8").trim() === recoveryHash, "backup_destination_exists");
    const manifest = this.verify(path.join(packageDirectory, "manifest.json"));
    invariant(manifest.backupId === backupId, "backup_id_collision");
    return manifest;
  }

  private dirtyArchive(sourceRoot: string, baseCommit: string): DirtyWorktreeArchive {
    const changed = this.gitNul(sourceRoot, ["diff", "--name-only", "--no-renames", "-z", "HEAD", "--"]);
    const untracked = this.gitNul(sourceRoot, ["ls-files", "--others", "--exclude-standard", "-z"]);
    const names = [...new Set([...changed, ...untracked])].sort();
    invariant(names.length > 0, "dirty_archive_empty");
    const entries: DirtyWorktreeArchive["entries"] = names.map((name) => {
      assertSafeRelativePath(name);
      const filePath = path.join(sourceRoot, ...name.split("/"));
      const stat = tryLstat(filePath);
      if (!stat) return { path: name, state: "deleted" as const };
      invariant(stat.isFile() || stat.isSymbolicLink(), "dirty_entry_type_unsupported", { name });
      const bytes = stat.isSymbolicLink() ? Buffer.from(fs.readlinkSync(filePath), "utf8") : fs.readFileSync(filePath);
      return {
        path: name,
        state: "present" as const,
        kind: stat.isSymbolicLink() ? "symlink" as const : "file" as const,
        sizeBytes: bytes.length,
        sha256: sha256(bytes),
        executable: (stat.mode & 0o111) !== 0,
        contentBase64: bytes.toString("base64"),
      };
    });
    return { schemaVersion: "bridge2-dirty-worktree-v1", baseCommit, entries };
  }

  private captureSourceSnapshot(sourceRoot: string): SourceSnapshot {
    assertCanonicalDirectory(sourceRoot, "backup_source_reparse_forbidden");
    const commit = this.git(sourceRoot, ["rev-parse", "HEAD"]);
    invariant(/^[a-f0-9]{40,64}$/u.test(commit), "backup_source_commit_invalid");
    const status = this.gitRaw(sourceRoot, [
      "status",
      "--porcelain=v1",
      "-z",
      "--untracked-files=all",
      "--no-renames",
    ]);
    return { commit, status };
  }

  private assertSourceSnapshot(sourceRoot: string, expected: SourceSnapshot): void {
    const current = this.captureSourceSnapshot(sourceRoot);
    invariant(
      current.commit === expected.commit && current.status === expected.status,
      "backup_source_changed_during_capture",
    );
  }

  private assertBundleCommit(sourceRoot: string, bundlePath: string, expectedCommit: string): void {
    const heads = this.gitRaw(sourceRoot, ["bundle", "list-heads", bundlePath]);
    invariant(
      heads.split(/\r?\n/u).some((line) => line.startsWith(`${expectedCommit} `)),
      "backup_bundle_source_commit_mismatch",
    );
  }

  private assertDirtyArchiveSnapshot(sourceRoot: string, expected: DirtyWorktreeArchive): void {
    invariant(
      canonicalEqual(this.dirtyArchive(sourceRoot, expected.baseCommit), expected),
      "backup_source_changed_during_capture",
    );
  }

  verify(manifestPath: string): BackupManifest {
    return verifyBackupManifest(manifestPath, this.schemas);
  }

  verifyPackage(packageDirectory: string, manifest: BackupManifest): void {
    verifyBackupContents(packageDirectory, manifest);
  }

  private content(filePath: string, name: string, kind: BackupContent["kind"], sensitivity: BackupContent["sensitivity"]): BackupContent {
    const bytes = fs.readFileSync(filePath);
    return { name, kind, sizeBytes: bytes.length, sha256: sha256(bytes), sensitivity };
  }

  private validateOwnerException(input: CreateBackupInput): void {
    const exception = input.ownerException;
    invariant(exception && canonicalEqual(exception.approvedBy, input.actor), "dirty_source_owner_exception_required");
    requireNonEmptyString(exception.reason, "ownerException.reason", 2000);
    invariant(this.dirtyGrantConsumer, "dirty_backup_grant_consumer_required");
    this.dirtyGrantConsumer.consumeDirtyBackupGrant({
      projectId: input.projectId,
      backupId: input.backupId,
      actor: deepCopy(input.actor),
      approvalGrantId: exception.approvalGrantId,
      action: "backup.source_only.dirty",
      conditions: { backupId: input.backupId },
    });
  }

  private validateEncryption(encryption: EncryptionMetadata): void {
    invariant(encryption.key.length === 32, "aes_256_key_required");
    validateBackupManifestReferences({
      encryption: {
        mode: encryption.mode,
        keyRef: encryption.keyRef,
        wrappedKeyCapsule: encryption.wrappedKeyCapsule,
      },
      destinations: [],
    });
  }

  private encryptionAad(backupId: string, name: string, kind: BackupContent["kind"]): unknown {
    return { contractVersion: CONTRACT_VERSION, backupId, name, kind };
  }

  private git(cwd: string, args: string[]): string {
    return execFileSync("git", args, { cwd, encoding: "utf8", stdio: ["ignore", "pipe", "pipe"], windowsHide: true }).trim();
  }

  private gitNul(cwd: string, args: string[]): string[] {
    return this.gitRaw(cwd, args).split("\0").filter(Boolean);
  }

  private gitRaw(cwd: string, args: string[]): string {
    return execFileSync("git", args, {
      cwd,
      encoding: "utf8",
      stdio: ["ignore", "pipe", "pipe"],
      windowsHide: true,
    });
  }
}

export function verifyBackupManifest(manifestPath: string, schemas: ContractSchemaRegistry): BackupManifest {
  const resolved = path.resolve(manifestPath);
  invariant(path.basename(resolved) === "manifest.json", "backup_manifest_filename_invalid");
  const manifestStat = tryLstat(resolved);
  invariant(manifestStat?.isFile() && !manifestStat.isSymbolicLink(), "backup_manifest_not_regular_file");
  const manifest = JSON.parse(fs.readFileSync(resolved, "utf8")) as BackupManifest;
  schemas.validateNamed("backup-manifest.schema.json", manifest);
  validateBackupManifestReferences(manifest);
  verifyBackupContents(path.dirname(resolved), manifest);
  return manifest;
}

function validateBackupManifestReferences(manifest: Pick<BackupManifest, "encryption" | "destinations">): void {
  if (manifest.encryption.mode === "none") {
    invariant(
      manifest.encryption.keyRef === undefined && manifest.encryption.wrappedKeyCapsule === undefined,
      "unencrypted_backup_key_metadata_forbidden",
    );
  }
  if (manifest.encryption.mode === "aes-256-gcm") {
    requireUriReference(manifest.encryption.keyRef, "encryption.keyRef");
    const keyReference = new URL(manifest.encryption.keyRef);
    invariant(
      keyReference.protocol === "bridge-key:" && (keyReference.hostname.length > 0 || keyReference.pathname.length > 1),
      "invalid_backup_key_reference",
    );
    const capsule = manifest.encryption.wrappedKeyCapsule;
    invariant(capsule, "wrapped_key_capsule_required");
    invariant(capsule.storageAccountRef === "drive-account://recovery-key-account", "recovery_key_account_alias_required");
    requireUriReference(capsule.capsuleRef, "encryption.wrappedKeyCapsule.capsuleRef");
    requireUriReference(capsule.recoveryProcedureRef, "encryption.wrappedKeyCapsule.recoveryProcedureRef");
    for (const reference of [capsule.capsuleRef, capsule.recoveryProcedureRef]) {
      const uri = new URL(reference);
      invariant(uri.protocol === "drive:" && uri.hostname === "recovery-key-account", "recovery_key_reference_scope_invalid");
    }
    requireNonEmptyString(capsule.wrappingAlgorithmId, "encryption.wrappedKeyCapsule.wrappingAlgorithmId", 100);
    invariant(capsule.wrappingAlgorithmId === "rsa-oaep-sha256", "capsule_wrapping_algorithm_invalid");
    invariant(capsule.decryptionSecretCustody === "local_and_drive", "decryption_secret_custody_invalid");
    requireSha256(capsule.recipientKeyFingerprint, "encryption.wrappedKeyCapsule.recipientKeyFingerprint");
    requireSha256(capsule.capsuleSha256, "encryption.wrappedKeyCapsule.capsuleSha256");
  }
  for (const destination of manifest.destinations) {
    requireUriReference(destination.uri, "backup.destination.uri");
    const protocol = new URL(destination.uri).protocol;
    invariant(
      (destination.kind === "local" && protocol === "file:") ||
        (destination.kind === "drive" && (protocol === "drive:" || protocol === "file:")),
      "backup_destination_uri_scope_invalid",
    );
    if (destination.status === "verified") requireTimestamp(destination.verifiedAt, "backup.destination.verifiedAt");
    else invariant(destination.verifiedAt === undefined, "unverified_backup_destination_timestamp_forbidden");
  }
}

function verifyBackupContents(packageDirectory: string, manifest: BackupManifest): void {
  const declared = manifest.contents.map((content) => content.name);
  invariant(new Set(declared).size === declared.length, "backup_content_name_duplicate");
  invariant(declared.every((name) => name !== "manifest.json" && name !== ".bridge2-request-hash"), "backup_content_name_reserved");
  const expected = new Set([...declared, "manifest.json", ".bridge2-request-hash"]);
  const actualEntries = fs.readdirSync(packageDirectory, { withFileTypes: true });
  invariant(
    actualEntries.length === expected.size &&
      actualEntries.every((entry) => expected.has(entry.name) && entry.isFile() && !entry.isSymbolicLink()),
    "backup_package_inventory_mismatch",
    { expected: [...expected].sort(), actual: actualEntries.map((entry) => entry.name).sort() },
  );
  invariant(
    /^[a-f0-9]{64}$/u.test(fs.readFileSync(path.join(packageDirectory, ".bridge2-request-hash"), "utf8").trim()),
    "backup_request_hash_invalid",
  );
  for (const content of manifest.contents) {
    invariant(path.basename(content.name) === content.name, "backup_content_path_invalid");
    const filePath = path.join(packageDirectory, content.name);
    const stat = tryLstat(filePath);
    invariant(stat?.isFile() && !stat.isSymbolicLink(), "backup_content_missing", { name: content.name });
    const bytes = fs.readFileSync(filePath);
    invariant(bytes.length === content.sizeBytes && sha256(bytes) === content.sha256, "backup_content_hash_mismatch", { name: content.name });
  }
}

function isWithin(candidate: string, root: string): boolean {
  const relative = path.relative(path.resolve(root), path.resolve(candidate));
  return relative === "" || (!relative.startsWith("..") && !path.isAbsolute(relative));
}

function canonicalExistingDirectory(directory: string, code: string): string {
  const resolved = path.resolve(directory);
  assertCanonicalDirectory(resolved, code);
  return fs.realpathSync.native(resolved);
}

/**
 * Canonicalizes an existing directory or a not-yet-created directory beneath
 * a normal existing ancestor. A junction/symlink anywhere in the resolved
 * prefix is rejected rather than silently changing the isolation boundary.
 */
function canonicalFutureDirectory(directory: string, code: string): string {
  const resolved = path.resolve(directory);
  let existing = resolved;
  const suffix: string[] = [];
  while (!tryLstat(existing)) {
    const parent = path.dirname(existing);
    invariant(parent !== existing, code);
    suffix.unshift(path.basename(existing));
    existing = parent;
  }
  assertCanonicalDirectory(existing, code);
  const canonical = path.join(fs.realpathSync.native(existing), ...suffix);
  invariant(samePath(canonical, resolved), code);
  return canonical;
}

function assertSafeRelativePath(value: string): void {
  const normalized = value.replaceAll("\\", "/");
  invariant(normalized === value && !path.posix.isAbsolute(normalized), "dirty_archive_path_invalid", { value });
  const segments = normalized.split("/");
  invariant(segments.length > 0 && segments.every((segment) => segment.length > 0 && segment !== "." && segment !== ".."), "dirty_archive_path_invalid", { value });
  invariant(segments[0].toLowerCase() !== ".git", "dirty_archive_path_invalid", { value });
}

export function restoreDirtyWorktree(archivePath: string, destinationRoot: string): { restored: number; deleted: number } {
  const resolvedArchive = path.resolve(archivePath);
  const archiveStat = tryLstat(resolvedArchive);
  invariant(archiveStat?.isFile() && !archiveStat.isSymbolicLink(), "dirty_archive_not_regular_file");
  const archiveBytes = fs.readFileSync(resolvedArchive);
  const archive = JSON.parse(archiveBytes.toString("utf8")) as DirtyWorktreeArchive;
  invariant(
    archive && typeof archive === "object" &&
      canonicalKeySet(archive, ["baseCommit", "entries", "schemaVersion"]) &&
      archive.schemaVersion === "bridge2-dirty-worktree-v1" && Array.isArray(archive.entries),
    "dirty_archive_invalid",
  );
  invariant(/^[a-f0-9]{40,64}$/u.test(archive.baseCommit), "dirty_archive_base_commit_invalid");
  const root = canonicalExistingDirectory(destinationRoot, "dirty_restore_destination_reparse_forbidden");
  const realRoot = root;
  const gitDirectory = path.join(root, ".git");
  assertCanonicalDirectory(gitDirectory, "dirty_restore_git_directory_invalid");
  invariant(isWithin(gitDirectory, realRoot), "dirty_restore_git_directory_invalid");
  const targetCommit = execFileSync("git", ["rev-parse", "HEAD"], {
    cwd: root,
    encoding: "utf8",
    stdio: ["ignore", "pipe", "pipe"],
    windowsHide: true,
  }).trim();
  invariant(targetCommit === archive.baseCommit, "dirty_restore_base_commit_mismatch");
  const validated = validateDirtyEntries(archive.entries, root, realRoot);
  const archiveHash = sha256(archiveBytes);
  const intentPath = path.join(gitDirectory, "bridge2-dirty-restore.intent.json");
  let intent = readDirtyRestoreIntent(intentPath, archiveHash, archive.baseCommit, root, validated);
  const statusPaths = dirtyStatusPaths(root);
  assertDirtyStatusLimited(statusPaths, validated);
  if (!intent && statusPaths.length > 0) {
    invariant(validated.every(entryMatchesDesired), "dirty_restore_destination_not_clean");
    return dirtyRestoreCounts(validated);
  }
  if (!intent) {
    const prepared = validated.map((item) => ({ ...item, original: captureOriginalDirtyTarget(item.target) }));
    intent = {
      schemaVersion: "bridge2-dirty-restore-intent-v1",
      archiveSha256: archiveHash,
      baseCommit: archive.baseCommit,
      destinationRoot: root,
      entries: prepared.map((item) => ({ path: item.entry.path, original: serializeOriginalDirtyTarget(item.original) })),
    };
    writeDirtyRestoreIntent(intentPath, intent);
  }
  const prepared = validated.map((item, index) => ({
    ...item,
    original: deserializeOriginalDirtyTarget(intent!.entries[index].original, item.entry.path),
  }));
  invariant(
    prepared.every((item) => entryMatchesOriginal(item) || entryMatchesDesired(item)),
    "dirty_restore_target_diverged",
  );

  const stageDirectory = path.join(gitDirectory, `bridge2-dirty-restore.stage-${archiveHash}`);
  const createdDirectories: string[] = [];
  try {
    prepareDirtyRestoreStage(stageDirectory, archiveHash, prepared, "desired");
    for (let index = 0; index < prepared.length; index += 1) {
      const item = prepared[index];
      if (item.entry.state === "present") ensureDirtyParents(root, realRoot, item.entry.path, createdDirectories);
      invariant(samePath(preflightDirtyTarget(root, realRoot, item.entry.path), item.target), "dirty_restore_target_changed");
      if (entryMatchesDesired(item)) continue;
      invariant(entryMatchesOriginal(item), "dirty_restore_target_diverged", { path: item.entry.path });
      if (item.entry.state === "deleted") {
        fs.unlinkSync(item.target);
      } else {
        fs.renameSync(path.join(stageDirectory, `${index}.desired`), item.target);
      }
      fsyncDirectory(path.dirname(item.target));
      invariant(entryMatchesDesired(item), "dirty_restore_hash_verification_failed", { path: item.entry.path });
    }
    verifyAppliedDirtyEntries(prepared);
    assertDirtyStatusLimited(dirtyStatusPaths(root), validated);
    removeOwnedDirectory(stageDirectory, ".bridge2-dirty-restore-stage-owner", archiveHash, true);
    removeDirtyRestoreIntent(intentPath, intent);
  } catch (error) {
    try {
      rollbackDirtyEntries(prepared, createdDirectories, stageDirectory, archiveHash);
      removeDirtyRestoreIntent(intentPath, intent);
    } catch (rollbackError) {
      throw new Error(`dirty_restore_rollback_failed:${String(rollbackError)}`, { cause: error });
    }
    throw error;
  }
  return dirtyRestoreCounts(prepared);
}

interface OriginalDirtyTarget {
  kind: "absent" | "file" | "symlink";
  bytes?: Buffer;
  mode?: number;
}

interface SerializedOriginalDirtyTarget {
  kind: "absent" | "file" | "symlink";
  contentBase64?: string;
  mode?: number;
  sha256?: string;
  sizeBytes?: number;
}

interface DirtyRestoreIntent {
  schemaVersion: "bridge2-dirty-restore-intent-v1";
  archiveSha256: string;
  baseCommit: string;
  destinationRoot: string;
  entries: Array<{ path: string; original: SerializedOriginalDirtyTarget }>;
}

interface ValidatedDirtyEntry {
  entry: DirtyWorktreeArchive["entries"][number];
  target: string;
  bytes?: Buffer;
}

interface PreparedDirtyEntry extends ValidatedDirtyEntry {
  original: OriginalDirtyTarget;
}

function validateDirtyEntries(
  entries: DirtyWorktreeArchive["entries"],
  root: string,
  realRoot: string,
): ValidatedDirtyEntry[] {
  const paths = entries.map((entry) => {
    invariant(entry && typeof entry === "object" && typeof entry.path === "string", "dirty_archive_entry_invalid");
    assertSafeRelativePath(entry.path);
    return entry.path;
  }).sort();
  const pathSet = new Set(paths);
  invariant(pathSet.size === paths.length, "dirty_archive_path_duplicate");
  for (const candidate of paths) {
    const segments = candidate.split("/");
    for (let index = 1; index < segments.length; index += 1) {
      invariant(!pathSet.has(segments.slice(0, index).join("/")), "dirty_archive_path_overlap", { path: candidate });
    }
  }

  return entries.map((entry) => {
    const target = preflightDirtyTarget(root, realRoot, entry.path);
    invariant(isWithin(target, root) && target !== root, "dirty_archive_path_invalid", { path: entry.path });
    const stat = tryLstat(target);
    invariant(!stat || stat.isFile() || stat.isSymbolicLink(), "dirty_restore_target_type_unsupported", { path: entry.path });
    if (entry.state === "deleted") {
      invariant(canonicalKeySet(entry, ["path", "state"]), "dirty_archive_entry_invalid", { path: entry.path });
      return { entry, target };
    }
    invariant(entry.state === "present", "dirty_archive_entry_invalid", { path: entry.path });
    invariant(
      canonicalKeySet(entry, ["contentBase64", "executable", "kind", "path", "sha256", "sizeBytes", "state"]) &&
        (entry.kind === "file" || entry.kind === "symlink") && Number.isSafeInteger(entry.sizeBytes) && entry.sizeBytes >= 0 &&
        typeof entry.executable === "boolean" && typeof entry.contentBase64 === "string" && /^[a-f0-9]{64}$/u.test(entry.sha256),
      "dirty_archive_entry_invalid",
      { path: entry.path },
    );
    const bytes = Buffer.from(entry.contentBase64, "base64");
    invariant(bytes.toString("base64") === entry.contentBase64, "dirty_archive_content_encoding_invalid", { path: entry.path });
    invariant(bytes.length === entry.sizeBytes && sha256(bytes) === entry.sha256, "dirty_archive_content_hash_mismatch", { path: entry.path });
    if (entry.kind === "symlink") {
      const targetText = bytes.toString("utf8");
      invariant(targetText.length > 0 && !targetText.includes("\0"), "dirty_archive_symlink_target_invalid", { path: entry.path });
    }
    return { entry, target, bytes };
  });
}

function preflightDirtyTarget(root: string, realRoot: string, relativePath: string): string {
  const segments = relativePath.split("/");
  let current = root;
  const parents = segments.slice(0, -1);
  let missing = false;
  for (const segment of parents) {
    current = path.join(current, segment);
    if (missing) continue;
    const stat = tryLstat(current);
    if (!stat) {
      missing = true;
      continue;
    }
    invariant(stat.isDirectory() && !stat.isSymbolicLink(), "dirty_restore_parent_reparse_forbidden", { path: relativePath });
    const resolved = fs.realpathSync.native(current);
    invariant(isWithin(resolved, realRoot) && samePath(resolved, current), "dirty_restore_parent_reparse_forbidden", { path: relativePath });
  }
  return path.join(current, segments.at(-1)!);
}

function ensureDirtyParents(root: string, realRoot: string, relativePath: string, created: string[]): void {
  let current = root;
  for (const segment of relativePath.split("/").slice(0, -1)) {
    current = path.join(current, segment);
    let stat = tryLstat(current);
    if (!stat) {
      fs.mkdirSync(current);
      created.push(current);
      stat = fs.lstatSync(current);
    }
    invariant(stat.isDirectory() && !stat.isSymbolicLink(), "dirty_restore_parent_reparse_forbidden", { path: relativePath });
    invariant(samePath(fs.realpathSync.native(current), current) && isWithin(current, realRoot), "dirty_restore_parent_reparse_forbidden", { path: relativePath });
  }
}

function rollbackDirtyEntries(
  entries: PreparedDirtyEntry[],
  createdDirectories: string[],
  stageDirectory: string,
  archiveHash: string,
): void {
  invariant(
    entries.every((item) => entryMatchesOriginal(item) || entryMatchesDesired(item)),
    "dirty_restore_rollback_target_diverged",
  );
  prepareDirtyRollbackStage(stageDirectory, archiveHash, entries);
  for (let index = entries.length - 1; index >= 0; index -= 1) {
    const item = entries[index];
    if (entryMatchesOriginal(item)) continue;
    invariant(entryMatchesDesired(item), "dirty_restore_rollback_target_diverged", { path: item.entry.path });
    if (item.original.kind === "absent") {
      fs.unlinkSync(item.target);
    } else {
      fs.renameSync(path.join(stageDirectory, `${index}.original`), item.target);
    }
    fsyncDirectory(path.dirname(item.target));
    invariant(entryMatchesOriginal(item), "dirty_restore_rollback_verification_failed", { path: item.entry.path });
  }
  removeOwnedDirectory(stageDirectory, ".bridge2-dirty-restore-stage-owner", archiveHash, true);
  for (const directory of [...createdDirectories].reverse()) {
    if (tryLstat(directory)?.isDirectory() && fs.readdirSync(directory).length === 0) fs.rmdirSync(directory);
  }
}

function verifyAppliedDirtyEntries(entries: PreparedDirtyEntry[]): void {
  for (const item of entries) {
    invariant(entryMatchesDesired(item), "dirty_restore_hash_verification_failed", { path: item.entry.path });
  }
}

function captureOriginalDirtyTarget(target: string): OriginalDirtyTarget {
  const stat = tryLstat(target);
  if (!stat) return { kind: "absent" };
  invariant(stat.isFile() || stat.isSymbolicLink(), "dirty_restore_target_type_unsupported");
  if (stat.isSymbolicLink()) return { kind: "symlink", bytes: Buffer.from(fs.readlinkSync(target), "utf8") };
  return { kind: "file", bytes: fs.readFileSync(target), mode: stat.mode & 0o777 };
}

function serializeOriginalDirtyTarget(original: OriginalDirtyTarget): SerializedOriginalDirtyTarget {
  if (original.kind === "absent") return { kind: "absent" };
  const bytes = original.bytes!;
  return {
    kind: original.kind,
    contentBase64: bytes.toString("base64"),
    ...(original.kind === "file" ? { mode: original.mode! } : {}),
    sha256: sha256(bytes),
    sizeBytes: bytes.length,
  };
}

function deserializeOriginalDirtyTarget(value: SerializedOriginalDirtyTarget, entryPath: string): OriginalDirtyTarget {
  invariant(value && typeof value === "object", "dirty_restore_intent_invalid", { path: entryPath });
  if (value.kind === "absent") {
    invariant(canonicalKeySet(value, ["kind"]), "dirty_restore_intent_invalid", { path: entryPath });
    return { kind: "absent" };
  }
  const expectedKeys = value.kind === "file"
    ? ["contentBase64", "kind", "mode", "sha256", "sizeBytes"]
    : ["contentBase64", "kind", "sha256", "sizeBytes"];
  invariant(
    (value.kind === "file" || value.kind === "symlink") && canonicalKeySet(value, expectedKeys) &&
      typeof value.contentBase64 === "string" && /^[a-f0-9]{64}$/u.test(value.sha256 ?? "") &&
      Number.isSafeInteger(value.sizeBytes) && Number(value.sizeBytes) >= 0 &&
      (value.kind !== "file" || (Number.isSafeInteger(value.mode) && Number(value.mode) >= 0 && Number(value.mode) <= 0o777)),
    "dirty_restore_intent_invalid",
    { path: entryPath },
  );
  const bytes = Buffer.from(value.contentBase64, "base64");
  invariant(
    bytes.toString("base64") === value.contentBase64 && bytes.length === value.sizeBytes && sha256(bytes) === value.sha256,
    "dirty_restore_intent_invalid",
    { path: entryPath },
  );
  return { kind: value.kind, bytes, ...(value.kind === "file" ? { mode: value.mode } : {}) };
}

function entryMatchesDesired(item: ValidatedDirtyEntry): boolean {
  const stat = tryLstat(item.target);
  if (item.entry.state === "deleted") return !stat;
  if (!stat || (item.entry.kind === "file" ? !stat.isFile() : !stat.isSymbolicLink())) return false;
  const bytes = stat.isSymbolicLink() ? Buffer.from(fs.readlinkSync(item.target), "utf8") : fs.readFileSync(item.target);
  if (bytes.length !== item.entry.sizeBytes || sha256(bytes) !== item.entry.sha256) return false;
  return process.platform === "win32" || item.entry.kind === "symlink" || ((stat.mode & 0o111) !== 0) === item.entry.executable;
}

function entryMatchesOriginal(item: PreparedDirtyEntry): boolean {
  const stat = tryLstat(item.target);
  if (item.original.kind === "absent") return !stat;
  if (!stat || (item.original.kind === "file" ? !stat.isFile() : !stat.isSymbolicLink())) return false;
  const bytes = stat.isSymbolicLink() ? Buffer.from(fs.readlinkSync(item.target), "utf8") : fs.readFileSync(item.target);
  if (!item.original.bytes?.equals(bytes)) return false;
  return process.platform === "win32" || item.original.kind === "symlink" || (stat.mode & 0o777) === item.original.mode;
}

function dirtyStatusPaths(root: string): string[] {
  const output = execFileSync("git", [
    "status",
    "--porcelain=v1",
    "-z",
    "--untracked-files=all",
    "--no-renames",
  ], {
    cwd: root,
    encoding: "utf8",
    stdio: ["ignore", "pipe", "pipe"],
    windowsHide: true,
  });
  return output.split("\0").filter(Boolean).map((record) => {
    invariant(record.length >= 4 && record[2] === " ", "dirty_restore_status_parse_failed");
    const relativePath = record.slice(3);
    assertSafeRelativePath(relativePath);
    return relativePath;
  });
}

function assertDirtyStatusLimited(statusPaths: string[], entries: ValidatedDirtyEntry[]): void {
  const allowed = new Set(entries.map((item) => item.entry.path));
  invariant(statusPaths.every((candidate) => allowed.has(candidate)), "dirty_restore_unrelated_worktree_change", { statusPaths });
}

function dirtyRestoreCounts(entries: ValidatedDirtyEntry[]): { restored: number; deleted: number } {
  return {
    restored: entries.filter((item) => item.entry.state === "present").length,
    deleted: entries.filter((item) => item.entry.state === "deleted").length,
  };
}

function readDirtyRestoreIntent(
  intentPath: string,
  archiveHash: string,
  baseCommit: string,
  root: string,
  entries: ValidatedDirtyEntry[],
): DirtyRestoreIntent | undefined {
  const temporaryPath = `${intentPath}.tmp`;
  const existingIntent = tryLstat(intentPath);
  const existingTemporary = tryLstat(temporaryPath);
  invariant(!existingIntent || (existingIntent.isFile() && !existingIntent.isSymbolicLink()), "dirty_restore_intent_invalid");
  invariant(!existingTemporary || (existingTemporary.isFile() && !existingTemporary.isSymbolicLink()), "dirty_restore_intent_invalid");
  invariant(!(existingIntent && existingTemporary), "dirty_restore_intent_collision");
  const candidatePath = existingIntent ? intentPath : existingTemporary ? temporaryPath : undefined;
  if (!candidatePath) return undefined;
  const text = fs.readFileSync(candidatePath, "utf8");
  const intent = JSON.parse(text) as DirtyRestoreIntent;
  validateDirtyRestoreIntent(intent, archiveHash, baseCommit, root, entries);
  invariant(text === `${canonicalize(intent)}\n`, "dirty_restore_intent_not_canonical");
  if (candidatePath === temporaryPath) {
    fs.renameSync(temporaryPath, intentPath);
    fsyncDirectory(path.dirname(intentPath));
  }
  return intent;
}

function validateDirtyRestoreIntent(
  intent: DirtyRestoreIntent,
  archiveHash: string,
  baseCommit: string,
  root: string,
  entries: ValidatedDirtyEntry[],
): void {
  invariant(
    intent && typeof intent === "object" &&
      canonicalKeySet(intent, ["archiveSha256", "baseCommit", "destinationRoot", "entries", "schemaVersion"]) &&
      intent.schemaVersion === "bridge2-dirty-restore-intent-v1" && intent.archiveSha256 === archiveHash &&
      intent.baseCommit === baseCommit && samePath(intent.destinationRoot, root) && Array.isArray(intent.entries) &&
      intent.entries.length === entries.length,
    "dirty_restore_intent_mismatch",
  );
  for (let index = 0; index < entries.length; index += 1) {
    const persisted = intent.entries[index];
    invariant(
      persisted && typeof persisted === "object" && canonicalKeySet(persisted, ["original", "path"]) &&
        persisted.path === entries[index].entry.path,
      "dirty_restore_intent_mismatch",
    );
    deserializeOriginalDirtyTarget(persisted.original, persisted.path);
  }
}

function writeDirtyRestoreIntent(intentPath: string, intent: DirtyRestoreIntent): void {
  const temporaryPath = `${intentPath}.tmp`;
  invariant(!tryLstat(intentPath) && !tryLstat(temporaryPath), "dirty_restore_intent_collision");
  const handle = fs.openSync(temporaryPath, "wx", 0o600);
  try {
    fs.writeFileSync(handle, `${canonicalize(intent)}\n`, "utf8");
    fs.fsyncSync(handle);
  } finally {
    fs.closeSync(handle);
  }
  fs.renameSync(temporaryPath, intentPath);
  fsyncDirectory(path.dirname(intentPath));
}

function removeDirtyRestoreIntent(intentPath: string, intent: DirtyRestoreIntent): void {
  invariant(
    regularFileText(intentPath) === `${canonicalize(intent)}\n`,
    "dirty_restore_intent_changed",
  );
  fs.unlinkSync(intentPath);
  fsyncDirectory(path.dirname(intentPath));
}

function prepareDirtyRestoreStage(
  stageDirectory: string,
  archiveHash: string,
  entries: PreparedDirtyEntry[],
  mode: "desired",
): void {
  if (fs.existsSync(stageDirectory)) {
    removeOwnedDirectory(stageDirectory, ".bridge2-dirty-restore-stage-owner", archiveHash, true);
  }
  fs.mkdirSync(stageDirectory, { mode: 0o700 });
  fs.writeFileSync(path.join(stageDirectory, ".bridge2-dirty-restore-stage-owner"), `${archiveHash}\n`, { flag: "wx", mode: 0o600 });
  for (let index = 0; index < entries.length; index += 1) {
    const item = entries[index];
    if (item.entry.state === "deleted") continue;
    writeDirtyStageTarget(
      path.join(stageDirectory, `${index}.${mode}`),
      item.entry.kind,
      item.bytes!,
      item.entry.executable ? 0o755 : 0o644,
    );
  }
  fsyncDirectory(stageDirectory);
}

function prepareDirtyRollbackStage(stageDirectory: string, archiveHash: string, entries: PreparedDirtyEntry[]): void {
  if (fs.existsSync(stageDirectory)) {
    removeOwnedDirectory(stageDirectory, ".bridge2-dirty-restore-stage-owner", archiveHash, true);
  }
  fs.mkdirSync(stageDirectory, { mode: 0o700 });
  fs.writeFileSync(path.join(stageDirectory, ".bridge2-dirty-restore-stage-owner"), `${archiveHash}\n`, { flag: "wx", mode: 0o600 });
  for (let index = 0; index < entries.length; index += 1) {
    const original = entries[index].original;
    if (original.kind === "absent") continue;
    writeDirtyStageTarget(
      path.join(stageDirectory, `${index}.original`),
      original.kind,
      original.bytes!,
      original.mode ?? 0o644,
    );
  }
  fsyncDirectory(stageDirectory);
}

function writeDirtyStageTarget(target: string, kind: "file" | "symlink", bytes: Buffer, mode: number): void {
  if (kind === "symlink") {
    fs.symlinkSync(bytes.toString("utf8"), target);
    return;
  }
  const handle = fs.openSync(target, "wx", mode);
  try {
    fs.writeFileSync(handle, bytes);
    if (process.platform !== "win32") fs.fchmodSync(handle, mode);
    fs.fsyncSync(handle);
  } finally {
    fs.closeSync(handle);
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

function canonicalKeySet(value: object, expected: string[]): boolean {
  return JSON.stringify(Object.keys(value).sort()) === JSON.stringify([...expected].sort());
}

function samePath(left: string, right: string): boolean {
  const normalize = (value: string): string => {
    const resolved = path.resolve(value);
    return process.platform === "win32" ? resolved.toLowerCase() : resolved;
  };
  return normalize(left) === normalize(right);
}

function assertNormalDirectory(directory: string, code: string): void {
  const stat = tryLstat(directory);
  invariant(stat?.isDirectory() && !stat.isSymbolicLink(), code);
  invariant(samePath(fs.realpathSync.native(directory), directory), code);
}

function assertCanonicalDirectory(directory: string, code: string): void {
  assertNormalDirectory(directory, code);
}

function regularFileText(filePath: string): string | undefined {
  const stat = tryLstat(filePath);
  if (!stat?.isFile() || stat.isSymbolicLink()) return undefined;
  return fs.readFileSync(filePath, "utf8");
}

/** Removes only a directory carrying the exact operation marker; links are never followed. */
function removeOwnedDirectory(directory: string, markerName: string, markerValue: string, eraseRegularFiles: boolean): void {
  if (!fs.existsSync(directory)) return;
  assertNormalDirectory(directory, "owned_recovery_staging_invalid");
  invariant(regularFileText(path.join(directory, markerName))?.trim() === markerValue, "owned_recovery_staging_marker_mismatch");
  removeTreeNoFollow(directory, eraseRegularFiles);
}

function removeTreeNoFollow(entryPath: string, eraseRegularFiles: boolean): void {
  const stat = fs.lstatSync(entryPath);
  if (stat.isDirectory() && !stat.isSymbolicLink()) {
    for (const entry of fs.readdirSync(entryPath)) removeTreeNoFollow(path.join(entryPath, entry), eraseRegularFiles);
    fs.rmdirSync(entryPath);
    return;
  }
  if (eraseRegularFiles && stat.isFile() && stat.size > 0) {
    const handle = fs.openSync(entryPath, "r+");
    try {
      const zeros = Buffer.alloc(Math.min(64 * 1024, stat.size));
      for (let offset = 0; offset < stat.size; offset += zeros.length) {
        fs.writeSync(handle, zeros, 0, Math.min(zeros.length, stat.size - offset), offset);
      }
      fs.fsyncSync(handle);
    } finally {
      fs.closeSync(handle);
    }
  }
  fs.unlinkSync(entryPath);
}

function tryLstat(filePath: string): fs.Stats | undefined {
  try { return fs.lstatSync(filePath); }
  catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return undefined;
    throw error;
  }
}
