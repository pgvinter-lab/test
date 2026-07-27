import { execFileSync } from "node:child_process";
import fs from "node:fs";
import path from "node:path";
import { canonicalEqual, canonicalize, hashAuditEntry, hashEvent } from "../core/canonical.js";
import { CONTRACT_VERSION } from "../core/constants.js";
import { newId } from "../core/ids.js";
import type { ContractSchemaRegistry } from "../core/schema-registry.js";
import type { AuditMirrorEntry, EventEnvelope, PrincipalRef } from "../core/types.js";
import type { IdentityService, TransportContext } from "../identity/identity-service.js";
import type { AdapterRegistry } from "../adapters/adapter-registry.js";
import type { BridgeStore } from "../storage/store.js";
import { verifyBackupManifest } from "./backup-service.js";

type DoctorCategory = "identity" | "permissions" | "storage" | "events" | "generation" | "adapter" | "github" | "drive" | "backup" | "secrets";
type CheckStatus = "pass" | "warn" | "fail" | "skipped";

export interface DoctorCheck {
  checkId: string;
  category: DoctorCategory;
  status: CheckStatus;
  detail: string;
  repairAction?: string;
}

export interface DoctorResult {
  schemaVersion: "0.1.0-draft.4";
  runId: string;
  projectId: string;
  hostId: string;
  generation: number;
  runAt: string;
  mode: "read_only";
  overall: "ready" | "degraded" | "blocked";
  checks: DoctorCheck[];
}

export interface DoctorOptions {
  projectId: string;
  hostId: string;
  actor?: PrincipalRef;
  transport?: TransportContext;
  sourceRoot?: string;
  recoveryRoot?: string;
  /** Exact owner-approved directories where recovery PEM files may exist. */
  recoveryKeyDirectories?: string[];
  /** Permits a deliberately non-activating recovered store to validate as ready. */
  isolatedRestore?: boolean;
}

export class DoctorService {
  constructor(
    private readonly store: BridgeStore,
    private readonly identity: IdentityService,
    private readonly adapters: AdapterRegistry,
    private readonly schemas: ContractSchemaRegistry,
    private readonly adapterExecutionMode?: (adapterId: string, adapterVersion: string) => "in_process" | "stdio" | "isolated" | undefined,
  ) {}

  run(options: DoctorOptions): DoctorResult {
    const project = this.store.get<{ active_generation: number }>(
      "SELECT active_generation FROM projects WHERE project_id = ?",
      options.projectId,
    );
    const generation = Number(project?.active_generation ?? 1);
    const checks: DoctorCheck[] = [];
    checks.push(this.projectCheck(options.projectId, options.isolatedRestore === true));
    checks.push(this.identityCheck(options));
    checks.push(this.permissionsCheck(options));
    checks.push(this.storageCheck());
    checks.push(this.contractCompatibilityCheck());
    checks.push(this.eventsCheck(options.projectId));
    checks.push(this.generationCheck(options.projectId, generation));
    checks.push(this.adapterCheck());
    checks.push(this.githubCheck(options.sourceRoot));
    checks.push(this.driveCheck(options.projectId, options.recoveryRoot));
    checks.push(this.backupCheck(options.projectId));
    checks.push(this.restoreDrillCheck(options.projectId));
    checks.push(this.secretsCheck(options));
    const overall = checks.some((check) => check.status === "fail")
      ? "blocked"
      : checks.some((check) => check.status === "warn")
        ? "degraded"
        : "ready";
    const result: DoctorResult = {
      schemaVersion: CONTRACT_VERSION,
      runId: newId("doctor.run"),
      projectId: options.projectId,
      hostId: options.hostId,
      generation,
      runAt: this.store.now(),
      mode: "read_only",
      overall,
      checks,
    };
    this.schemas.validateNamed("doctor.schema.json", result);
    return result;
  }

  private projectCheck(projectId: string, isolatedRestore: boolean): DoctorCheck {
    const project = this.store.get<{ status: "active" | "read_only" | "retired" }>(
      "SELECT status FROM projects WHERE project_id = ?",
      projectId,
    );
    if (!project) return check("check.storage.project", "storage", "fail", "The requested project is absent from this runtime store.");
    if (project.status === "active") return check("check.storage.project", "storage", "pass", "The requested project exists and is active.");
    if (project.status === "read_only" && isolatedRestore) {
      return check("check.storage.project", "storage", "pass", "The recovered project is deliberately read-only and remains excluded from activation.");
    }
    if (project.status === "read_only") {
      return check("check.storage.project", "storage", "warn", "The project is read-only; this live runtime is not ready for claims or side effects.");
    }
    return check("check.storage.project", "storage", "fail", "The requested project is retired and cannot be used as a live runtime.");
  }

  private identityCheck(options: DoctorOptions): DoctorCheck {
    if (!options.actor) {
      return check("check.identity.binding", "identity", "skipped", "No identity was supplied; doctor remained in anonymous read-only bootstrap mode.");
    }
    try {
      this.identity.authorize(options.projectId, options.actor, [], options.transport);
      return check("check.identity.binding", "identity", "pass", "Principal, session, host, and optional transport binding are active and exact.");
    } catch (error) {
      return check("check.identity.binding", "identity", "fail", `Identity binding failed: ${message(error)}.`);
    }
  }

  private permissionsCheck(options: DoctorOptions): DoctorCheck {
    try {
      const roots = [options.sourceRoot, options.recoveryRoot].filter(Boolean).map((root) => path.resolve(root!));
      const liveStatePaths = [this.store.databasePath, this.store.auditMirrorPath].filter(Boolean).map((item) => path.resolve(item!));
      const stateAccessPaths = [
        ...liveStatePaths,
        `${this.store.databasePath}-wal`,
        `${this.store.databasePath}-shm`,
        `${this.store.databasePath}-journal`,
      ].filter((item, index, all) => fs.existsSync(item) && all.indexOf(item) === index);
      const failures: string[] = [];
      if (roots.some((root) => liveStatePaths.some((item) => isWithin(item, root)))) {
        failures.push("live state overlaps a source or recovery-replica root");
      }
      const project = this.store.get<{ status: string }>("SELECT status FROM projects WHERE project_id = ?", options.projectId);
      const liveWritable = project?.status === "active" && !options.isolatedRestore;
      for (const statePath of stateAccessPaths) {
        try {
          fs.accessSync(statePath, fs.constants.R_OK | (liveWritable ? fs.constants.W_OK : 0));
          fs.accessSync(path.dirname(statePath), fs.constants.R_OK | (liveWritable ? fs.constants.W_OK : 0));
          const stat = fs.lstatSync(statePath);
          if (!stat.isFile() || stat.isSymbolicLink()) failures.push(`${statePath} is not a regular no-follow file`);
          if (process.platform !== "win32" && (stat.mode & 0o077) !== 0) failures.push(`${statePath} allows group or other access`);
          if (process.platform !== "win32" && (fs.statSync(path.dirname(statePath)).mode & 0o022) !== 0) {
            failures.push(`${path.dirname(statePath)} allows group or other writes`);
          }
        } catch { failures.push(`${statePath} lacks required ${liveWritable ? "read/write" : "read"} access`); }
      }
      if (options.sourceRoot) {
        try { fs.accessSync(path.resolve(options.sourceRoot), fs.constants.R_OK); }
        catch { failures.push("source root is not readable"); }
      }
      if (options.recoveryRoot) {
        try { fs.accessSync(path.resolve(options.recoveryRoot), fs.constants.R_OK | fs.constants.W_OK); }
        catch { failures.push("recovery root is not readable and writable"); }
      }
      return failures.length > 0
        ? check("check.permissions.local", "permissions", "fail", `Filesystem permission/isolation checks failed: ${failures.join("; ")}.`)
        : check("check.permissions.local", "permissions", "pass", "Live state and supplied roots have the required no-follow read/write access and remain structurally isolated.");
    } catch (error) {
      return check("check.permissions.local", "permissions", "fail", `Filesystem permission inspection failed: ${message(error)}.`);
    }
  }

  private storageCheck(): DoctorCheck {
    try {
      const integrity = this.store.get<{ quick_check: string }>("PRAGMA quick_check");
      const migrations = this.store.migrations.verify();
      if (integrity?.quick_check !== "ok" || !migrations.checksumsValid) {
        return check("check.storage.integrity", "storage", "fail", "SQLite integrity or migration checksum verification failed.");
      }
      if (migrations.pending > 0) return check("check.storage.integrity", "storage", "warn", `${migrations.pending} forward migration(s) are pending; no migration was applied by doctor.`);
      return check("check.storage.integrity", "storage", "pass", `SQLite integrity passed at migration version ${migrations.currentVersion}.`);
    } catch (error) {
      return check("check.storage.integrity", "storage", "fail", `Storage verification failed: ${message(error)}.`);
    }
  }

  private contractCompatibilityCheck(): DoctorCheck {
    try {
      const contract = this.store.get<{ value: string }>(
        "SELECT value FROM runtime_metadata WHERE key = 'contract_version'",
      );
      const [major, minor, patch] = process.versions.node.split(".").map(Number);
      const supportedNode = major > 22 || (major === 22 && (minor > 13 || (minor === 13 && patch >= 0)));
      if (contract?.value !== CONTRACT_VERSION || !supportedNode) {
        return check(
          "check.storage.compatibility",
          "storage",
          "fail",
          `Runtime compatibility failed: contract=${contract?.value ?? "missing"}, node=${process.versions.node}.`,
        );
      }
      return check(
        "check.storage.compatibility",
        "storage",
        "pass",
        `Executable Node ${process.versions.node} and stored contract ${contract.value} are compatible.`,
      );
    } catch (error) {
      return check("check.storage.compatibility", "storage", "fail", `Runtime compatibility check failed: ${message(error)}.`);
    }
  }

  private eventsCheck(projectId: string): DoctorCheck {
    try {
      const eventRows = this.store.all<{
        project_id: string;
        sequence: number;
        event_id: string;
        generation: number;
        event_type: string;
        aggregate_type: string;
        aggregate_id: string;
        occurred_at: string;
        previous_hash: string | null;
        hash: string;
        envelope_json: string;
      }>(
        "SELECT * FROM events WHERE project_id = ? ORDER BY sequence",
        projectId,
      );
      const events = eventRows.map((row) => JSON.parse(row.envelope_json) as EventEnvelope);
      const eventOk = events.every((event, index) =>
        (() => {
          this.schemas.validateNamed("event.schema.json", event);
          const row = eventRows[index];
          return row.project_id === event.projectId && Number(row.sequence) === event.sequence &&
            row.event_id === event.eventId && Number(row.generation) === event.generation &&
            row.event_type === event.eventType && row.aggregate_type === event.aggregate.type &&
            row.aggregate_id === event.aggregate.id && row.occurred_at === event.occurredAt &&
            row.previous_hash === (event.previousHash ?? null) && row.hash === event.hash &&
            event.sequence === index + 1 &&
            hashEvent(event) === event.hash &&
            (index === 0 ? event.previousHash === undefined : event.previousHash === events[index - 1].hash);
        })(),
      );
      const mirrors = this.store.all<{
        project_id: string;
        mirror_sequence: number;
        event_id: string;
        mirrored_at: string;
        previous_mirror_hash: string | null;
        mirror_hash: string;
        entry_json: string;
        file_appended: number;
      }>(
        "SELECT * FROM audit_mirror_entries WHERE project_id = ? ORDER BY mirror_sequence",
        projectId,
      );
      const entries = mirrors.map((row) => JSON.parse(row.entry_json) as AuditMirrorEntry);
      const mirrorOk = entries.length === events.length && entries.every((entry, index) =>
        (() => {
          this.schemas.validateNamed("audit-mirror-entry.schema.json", entry);
          const row = mirrors[index];
          return row.project_id === projectId && Number(row.mirror_sequence) === entry.mirrorSequence &&
            row.event_id === entry.event.eventId && row.mirrored_at === entry.mirroredAt &&
            row.previous_mirror_hash === (entry.previousMirrorHash ?? null) && row.mirror_hash === entry.mirrorHash &&
            entry.mirrorSequence === index + 1 &&
            canonicalEqual(entry.event, events[index]) &&
            hashAuditEntry(entry) === entry.mirrorHash &&
            (index === 0 ? entry.previousMirrorHash === undefined : entry.previousMirrorHash === entries[index - 1].mirrorHash);
        })(),
      );
      const fileOk = this.verifyMirrorFile(entries);
      const pending = mirrors.filter((row) => Number(row.file_appended) !== 1).length;
      if (!eventOk || !mirrorOk || !fileOk || pending > 0) {
        return check("check.events.sequence", "events", "fail", `Event/audit continuity failed or ${pending} JSONL projection(s) remain pending.`);
      }
      return check("check.events.sequence", "events", "pass", `${events.length} immutable event(s) and one-to-one audit entries passed both canonical hash chains.`);
    } catch (error) {
      return check("check.events.sequence", "events", "fail", `Event verification failed: ${message(error)}.`);
    }
  }

  private generationCheck(projectId: string, generation: number): DoctorCheck {
    try {
      const project = this.store.get<{ active_generation: number; next_fencing_token: number }>(
        "SELECT active_generation, next_fencing_token FROM projects WHERE project_id = ?",
        projectId,
      );
      if (!project) return check("check.generation.active", "generation", "fail", "The requested project has no generation allocator row.");
      const claims = this.store.all<{ claim_id: string; generation: number; fencing_token: number; status: string; lease_expires_at: string }>(
        `SELECT c.claim_id, c.generation, c.fencing_token, c.status, c.lease_expires_at
         FROM job_claims c JOIN review_jobs j ON j.job_id = c.job_id
         WHERE j.project_id = ? ORDER BY c.fencing_token`,
        projectId,
      );
      const legacyCoordinationApplied = Boolean(this.store.get(
        "SELECT 1 AS applied FROM schema_migrations WHERE migration_id = 'migration.002.legacy_coordination'",
      ));
      const legacyLeases = legacyCoordinationApplied ? this.store.all<{
        claim_group_id: string;
        generation: number;
        fencing_token: number;
        status: string;
        expires_at: string;
      }>(
        `SELECT claim_group_id, generation, fencing_token, status, expires_at
         FROM legacy_file_leases WHERE project_id = ? ORDER BY fencing_token, claim_group_id, path_key`,
        projectId,
      ) : [];
      const legacyAllocations = new Map<string, { generations: Set<number>; tokens: Set<number> }>();
      for (const lease of legacyLeases) {
        const allocation = legacyAllocations.get(lease.claim_group_id) ?? { generations: new Set<number>(), tokens: new Set<number>() };
        allocation.generations.add(Number(lease.generation));
        allocation.tokens.add(Number(lease.fencing_token));
        legacyAllocations.set(lease.claim_group_id, allocation);
      }
      const jobTokens = claims.map((claim) => Number(claim.fencing_token));
      const legacyTokens = [...legacyAllocations.values()].flatMap((allocation) => [...allocation.tokens]);
      const allocationTokens = [...jobTokens, ...legacyTokens];
      const maximumToken = allocationTokens.length ? Math.max(...allocationTokens) : 0;
      const malformedLegacyAllocation = [...legacyAllocations.values()].some(
        (allocation) => allocation.generations.size !== 1 || allocation.tokens.size !== 1,
      );
      const invalidAllocator = malformedLegacyAllocation
        || Number(project.next_fencing_token) !== maximumToken
        || new Set(allocationTokens).size !== allocationTokens.length;
      const futureClaim = claims.some((claim) => Number(claim.generation) > generation)
        || legacyLeases.some((lease) => Number(lease.generation) > generation);
      const brokenJobBindings = Number(this.store.get<{ count: number }>(
        `SELECT COUNT(*) AS count FROM review_jobs j
         WHERE j.project_id = ? AND (
           (j.active_claim_id IS NULL AND EXISTS (SELECT 1 FROM job_claims c WHERE c.job_id = j.job_id AND c.status = 'active'))
           OR
           (j.active_claim_id IS NOT NULL AND NOT EXISTS (
             SELECT 1 FROM job_claims c WHERE c.claim_id = j.active_claim_id AND c.job_id = j.job_id
               AND c.status = 'active' AND c.generation = j.active_generation
               AND c.fencing_token = j.active_fencing_token AND c.lease_expires_at = j.lease_expires_at
           ))
         )`,
        projectId,
      )?.count ?? 0);
      const takeovers = this.store.all<{ from_generation: number; to_generation: number }>(
        "SELECT from_generation, to_generation FROM generation_takeovers WHERE project_id = ? ORDER BY to_generation",
        projectId,
      );
      let expectedGeneration = 1;
      const brokenTakeoverChain = takeovers.some((takeover) => {
        const valid = Number(takeover.from_generation) === expectedGeneration && Number(takeover.to_generation) > expectedGeneration;
        expectedGeneration = Number(takeover.to_generation);
        return !valid;
      }) || expectedGeneration !== generation;
      const eventGenerations = this.store.all<{ generation: number }>(
        "SELECT generation FROM events WHERE project_id = ? ORDER BY sequence",
        projectId,
      ).map((row) => Number(row.generation));
      const invalidEventGeneration = eventGenerations.some((value, index) =>
        value < 1 || value > generation || (index > 0 && value < eventGenerations[index - 1]),
      );
      if (invalidAllocator || futureClaim || brokenJobBindings > 0 || brokenTakeoverChain || invalidEventGeneration) {
        return check(
          "check.generation.active",
          "generation",
          "fail",
          `Generation/fencing integrity failed (allocator=${invalidAllocator}, futureClaim=${futureClaim}, jobBindings=${brokenJobBindings}, takeoverChain=${brokenTakeoverChain}, eventGeneration=${invalidEventGeneration}).`,
        );
      }
      const pendingReconciliations = Number(this.store.get<{ count: number }>(
        `SELECT COUNT(*) AS count FROM generation_takeovers t
         WHERE t.project_id = ? AND t.takeover_class = 'forced'
           AND NOT EXISTS (
             SELECT 1 FROM runtime_operation_reports r
             WHERE r.project_id = t.project_id AND r.operation = 'project.reconcile_takeover'
               AND json_extract(r.report_json, '$.takeoverId') = t.takeover_id
           )`,
        projectId,
      )?.count ?? 0);
      const stale = claims.filter((claim) => claim.status === "active" &&
        (Number(claim.generation) !== generation || Date.parse(claim.lease_expires_at) <= Date.parse(this.store.now())));
      const staleLegacyAllocations = new Set(legacyLeases.filter((lease) => lease.status === "active" &&
        (Number(lease.generation) !== generation || Date.parse(lease.expires_at) <= Date.parse(this.store.now())))
        .map((lease) => lease.claim_group_id));
      const staleCount = stale.length + staleLegacyAllocations.size;
      return staleCount > 0 || pendingReconciliations > 0
        ? check("check.generation.active", "generation", "warn", `${staleCount} active claim allocation(s) are stale/expired and ${pendingReconciliations} forced takeover(s) await a later reconciliation report; allocator and fencing relationships remain valid.`)
        : check("check.generation.active", "generation", "pass", `Generation ${generation}, takeover chain, ${claims.length} job claim(s), ${legacyAllocations.size} compatibility claim group(s), and the global fencing allocator are consistent.`);
    } catch (error) {
      return check("check.generation.active", "generation", "fail", `Generation/fencing verification failed: ${message(error)}.`);
    }
  }

  private adapterCheck(): DoctorCheck {
    try {
      const rows = this.store.all<{ adapter_id: string; adapter_version: string; health_state: string; manifest_json: string; last_status: string | null }>(
        `SELECT m.adapter_id, m.adapter_version, m.health_state, m.manifest_json,
                (SELECT i.status FROM adapter_invocations i
                 WHERE i.adapter_id = m.adapter_id AND i.adapter_version = m.adapter_version
                   AND i.operation = json_extract(m.manifest_json, '$.health.checkOperation')
                 ORDER BY i.updated_at DESC, i.operation_id DESC LIMIT 1) AS last_status
         FROM adapter_registry r JOIN adapter_manifests m
           ON m.adapter_id = r.adapter_id AND m.adapter_version = r.active_version
         ORDER BY m.adapter_id`,
      );
      if (rows.length === 0) return check("check.adapter.manifests", "adapter", "skipped", "No adapters are registered.");
      let degraded = 0;
      let blocked = 0;
      let unavailable = 0;
      let unproven = 0;
      for (const row of rows) {
        const manifest = JSON.parse(row.manifest_json) as ReturnType<AdapterRegistry["require"]>;
        this.schemas.validateNamed("adapter.schema.json", manifest);
        if (!manifest.health.states.includes(row.health_state as never)) blocked += 1;
        else if (row.health_state === "blocked" || row.health_state === "offline") blocked += 1;
        else if (row.health_state === "degraded") degraded += 1;
        if (this.adapterExecutionMode && !this.adapterExecutionMode(row.adapter_id, row.adapter_version)) unavailable += 1;
        if (row.last_status === "failed") degraded += 1;
        if (row.last_status === null || row.last_status === "started") unproven += 1;
      }
      if (blocked > 0 || unavailable > 0) {
        return check("check.adapter.manifests", "adapter", "fail", `${rows.length} manifest(s) validate, but ${blocked} report blocked/offline health and ${unavailable} lack a configured isolated/stdio/in-process executor.`);
      }
      if (degraded > 0 || unproven > 0 || !this.adapterExecutionMode) {
        return check("check.adapter.manifests", "adapter", "warn", `${rows.length} manifest(s) validate; ${degraded} report degraded/failed health, ${unproven} lack a completed invocation result, and executor availability is ${this.adapterExecutionMode ? "confirmed" : "not observable in this isolated doctor context"}.`);
      }
      return check("check.adapter.manifests", "adapter", "pass", `${rows.length} active adapter manifest(s) validate, report ready health, have version-bound executors, and have completed version-bound health-check results.`);
    } catch (error) {
      return check("check.adapter.manifests", "adapter", "fail", `Adapter manifest validation failed: ${message(error)}.`);
    }
  }

  private githubCheck(sourceRoot?: string): DoctorCheck {
    if (!sourceRoot) return check("check.github.private", "github", "skipped", "No source root was supplied; GitHub remains operationally deferred.");
    try {
      const remotes = execFileSync("git", ["remote", "-v"], {
        cwd: sourceRoot,
        encoding: "utf8",
        windowsHide: true,
        stdio: ["ignore", "pipe", "pipe"],
      }).trim();
      return remotes
        ? check("check.github.private", "github", "warn", "A Git remote exists, but privacy cannot be verified offline and no authenticated network check was performed.")
        : check("check.github.private", "github", "skipped", "No Git remote is configured; GitHub setup remains deferred until Phase 1 closes.");
    } catch {
      return check("check.github.private", "github", "skipped", "Source root is not a Git worktree or remote inspection was unavailable.");
    }
  }

  private driveCheck(projectId: string, recoveryRoot?: string): DoctorCheck {
    if (!recoveryRoot) return check("check.drive.root", "drive", "skipped", "No Drive recovery root was supplied; no external access was attempted.");
    const root = path.resolve(recoveryRoot);
    if (isWithin(this.store.databasePath, root)) return check("check.drive.root", "drive", "fail", "The live database is inside the recovery-replica root.");
    try {
      const rootStat = fs.lstatSync(root, { throwIfNoEntry: false });
      if (!rootStat) return check("check.drive.root", "drive", "warn", "Configured recovery root is unavailable; doctor did not create it.");
      if (!rootStat.isDirectory() || rootStat.isSymbolicLink() || !samePath(fs.realpathSync.native(root), root)) {
        throw new Error("recovery_root_directory_invalid");
      }
      const latest = this.store.get<{ backup_id: string }>(
        "SELECT backup_id FROM backup_manifests WHERE project_id = ? ORDER BY created_at DESC LIMIT 1",
        projectId,
      );
      if (!latest) return check("check.drive.root", "drive", "pass", "Recovery root is reachable; no backup record exists to verify against it.");
      const manifestPath = resolveRecoveryManifest(root, latest.backup_id);
      const manifest = verifyBackupManifest(manifestPath, this.schemas);
      return manifest.projectId === projectId && manifest.backupId === latest.backup_id &&
        manifest.destinations.some((destination) => destination.status === "verified")
        ? check("check.drive.root", "drive", "pass", `Recovery package ${latest.backup_id} is reachable and every declared content hash verifies.`)
        : check("check.drive.root", "drive", "fail", `Recovery package ${latest.backup_id} is not bound to this project or has no verified destination.`);
    } catch (error) {
      return check("check.drive.root", "drive", "fail", `Latest recovery package verification failed: ${message(error)}.`);
    }
  }

  private backupCheck(projectId: string): DoctorCheck {
    const latest = this.store.get<{ backup_id: string; created_at: string }>(
      "SELECT backup_id, created_at FROM backup_manifests WHERE project_id = ? ORDER BY created_at DESC LIMIT 1",
      projectId,
    );
    return latest
      ? check("check.backup.age", "backup", "warn", `Latest verified backup record is ${latest.backup_id} at ${latest.created_at}; no owner-approved age threshold exists.`)
      : check("check.backup.age", "backup", "warn", "No backup record exists and no owner-approved backup-age threshold is configured.");
  }

  private restoreDrillCheck(projectId: string): DoctorCheck {
    const latest = this.store.get<{ restore_id: string; requested_at: string }>(
      `SELECT restore_id, requested_at FROM restore_manifests
       WHERE project_id = ? AND status = 'completed' AND json_extract(manifest_json, '$.mode') = 'recovery_drill'
       ORDER BY requested_at DESC LIMIT 1`,
      projectId,
    );
    return latest
      ? check("check.backup.restore_drill", "backup", "warn", `Latest completed restore drill is ${latest.restore_id} at ${latest.requested_at}; no owner-approved drill-age threshold exists.`)
      : check("check.backup.restore_drill", "backup", "warn", "No completed restore drill is recorded and no owner-approved drill-age threshold exists.");
  }

  private secretsCheck(options: DoctorOptions): DoctorCheck {
    try {
      const forbidden = /(^\.env$|\.pem$|\.pfx$|\.key$|^id_rsa$)/iu;
      const approvedRecoveryKeyName = /^[A-Za-z0-9][A-Za-z0-9._-]{0,99}\.(?:private|public)\.pem$/u;
      const sourceRoot = options.sourceRoot ? path.resolve(options.sourceRoot) : undefined;
      const allowedKeyDirectories = (options.recoveryKeyDirectories ?? []).map((directory) => path.resolve(directory));
      for (const directory of allowedKeyDirectories) {
        const stat = fs.lstatSync(directory, { throwIfNoEntry: false });
        const canonical = stat?.isDirectory() && !stat.isSymbolicLink()
          ? fs.realpathSync.native(directory)
          : undefined;
        if (!canonical || !samePath(canonical, directory) || (sourceRoot && isWithin(directory, sourceRoot))) {
          return check("check.secrets.placement", "secrets", "fail", `Approved recovery-key directory is unavailable, indirect, or inside source: ${directory}.`);
        }
      }
      const roots = [...new Set([
        path.dirname(this.store.databasePath),
        sourceRoot,
        options.recoveryRoot ? path.resolve(options.recoveryRoot) : undefined,
      ].filter((value): value is string => Boolean(value)))];
      const hits: string[] = [];
      const stack = roots.filter((root) => fs.existsSync(root));
      let inspected = 0;
      const maximumEntries = 50_000;
      while (stack.length > 0 && inspected < maximumEntries) {
        const directory = stack.pop()!;
        const entries = fs.readdirSync(directory, { withFileTypes: true });
        for (const entry of entries) {
          inspected += 1;
          if (inspected > maximumEntries) break;
          const candidate = path.join(directory, entry.name);
          if (entry.isSymbolicLink()) {
            if (forbidden.test(entry.name)) hits.push(candidate);
            continue;
          }
          if (entry.isDirectory()) stack.push(candidate);
          else if (entry.isFile() && forbidden.test(entry.name)) {
            const approved = approvedRecoveryKeyName.test(entry.name)
              && allowedKeyDirectories.some((directory) => samePath(path.dirname(candidate), directory));
            if (!approved) hits.push(candidate);
          }
        }
      }
      return hits.length
        ? check("check.secrets.placement", "secrets", "fail", `Potential secret file(s) were found in live/source/recovery roots: ${hits.slice(0, 20).join(", ")}.`)
        : inspected >= maximumEntries
          ? check("check.secrets.placement", "secrets", "warn", `Secret-placement scan reached its ${maximumEntries}-entry safety bound without finding a forbidden name.`)
          : check("check.secrets.placement", "secrets", "pass", `No unapproved secret-file names were found across ${roots.length} supplied live/source/recovery root(s); ${allowedKeyDirectories.length} recovery-key director${allowedKeyDirectories.length === 1 ? "y is" : "ies are"} explicitly allowed.`);
    } catch (error) {
      return check("check.secrets.placement", "secrets", "warn", `Secret-placement inspection was incomplete: ${message(error)}.`);
    }
  }

  private verifyMirrorFile(entries: AuditMirrorEntry[]): boolean {
    if (entries.length === 0) return true;
    if (!this.store.auditMirrorPath || !fs.existsSync(this.store.auditMirrorPath)) return false;
    const text = fs.readFileSync(this.store.auditMirrorPath, "utf8");
    if (!text.endsWith("\n")) return false;
    const lines = text.trimEnd().split("\n");
    if (lines.length !== entries.length) return false;
    return lines.every((line, index) => {
      const parsed = JSON.parse(line) as AuditMirrorEntry;
      this.schemas.validateNamed("audit-mirror-entry.schema.json", parsed);
      return canonicalize(parsed) === line && canonicalEqual(parsed, entries[index]) && hashAuditEntry(parsed) === parsed.mirrorHash;
    });
  }
}

function check(checkId: string, category: DoctorCategory, status: CheckStatus, detail: string): DoctorCheck {
  return { checkId, category, status, detail };
}

function isWithin(candidate: string, root: string): boolean {
  const relative = path.relative(path.resolve(root), path.resolve(candidate));
  return relative === "" || (!relative.startsWith("..") && !path.isAbsolute(relative));
}

function samePath(left: string, right: string): boolean {
  const normalize = (value: string): string => {
    const resolved = path.resolve(value);
    return process.platform === "win32" ? resolved.toLowerCase() : resolved;
  };
  return normalize(left) === normalize(right);
}

function resolveRecoveryManifest(root: string, backupId: string): string {
  const packageDirectories = [
    path.join(root, "backups", backupId),
    path.join(root, backupId),
  ];
  const present = packageDirectories.filter((directory) => fs.lstatSync(directory, { throwIfNoEntry: false }) !== undefined);
  if (present.length === 0) throw new Error("backup_package_not_found");
  if (present.length > 1) throw new Error("backup_package_layout_ambiguous");

  const packageDirectory = present[0];
  const packageStat = fs.lstatSync(packageDirectory, { throwIfNoEntry: false });
  if (!packageStat?.isDirectory() || packageStat.isSymbolicLink() || !samePath(fs.realpathSync.native(packageDirectory), packageDirectory)) {
    throw new Error("backup_package_directory_invalid");
  }
  return path.join(packageDirectory, "manifest.json");
}

function message(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}
