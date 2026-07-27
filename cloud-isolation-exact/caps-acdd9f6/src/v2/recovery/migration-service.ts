import type { ContractSchemaRegistry } from "../core/schema-registry.js";
import { invariant } from "../core/errors.js";
import type { PrincipalRef } from "../core/types.js";
import type { IdentityService } from "../identity/identity-service.js";
import type { BridgeStore } from "../storage/store.js";
import type { BackupService, BackupManifest } from "./backup-service.js";
import { hashCanonical } from "../core/canonical.js";

export interface MigrationContract {
  schemaVersion: "0.1.0-draft.4";
  migrationId: string;
  fromVersion: string;
  toVersion: string;
  checksum: string;
  backupRequired: true;
  estimatedDowntimeSeconds: number;
  rollbackClass: "restore_only";
  preconditions: string[];
  operations: { apply: string; verify: string };
}

export class MigrationService {
  constructor(
    private readonly store: BridgeStore,
    private readonly identity: IdentityService,
    private readonly backups: BackupService,
    private readonly schemas: ContractSchemaRegistry,
  ) {}

  plan(): { currentVersion: number; pending: MigrationContract[] } {
    const current = this.store.migrations.currentVersion();
    let fromVersion = current;
    const pending = this.store.migrations.pending().map((migration) => {
      const contract = this.contract(migration, fromVersion);
      fromVersion = migration.version;
      return contract;
    });
    return {
      currentVersion: current,
      pending,
    };
  }

  apply(args: {
    projectId: string;
    actor: PrincipalRef;
    backupManifestPath: string;
    idempotencyKey: string;
  }): MigrationContract[] {
    this.identity.authorize(args.projectId, args.actor, ["owner"]);
    const backup = this.backups.verify(args.backupManifestPath);
    invariant(backup.projectId === args.projectId, "pre_migration_backup_project_mismatch");
    invariant(backup.backupType === "full", "full_pre_migration_backup_required");
    return this.store.mutateIdempotent({
      projectId: args.projectId,
      actor: args.actor,
      operation: "migration.apply",
      idempotencyKey: args.idempotencyKey,
      request: { projectId: args.projectId, backupId: backup.backupId },
      run: () => {
        // Re-evaluate authorization under the same IMMEDIATE transaction that
        // applies schema changes so a concurrent role revocation cannot race
        // the preflight check above.
        this.identity.authorize(args.projectId, args.actor, ["owner"]);
        let before = this.store.migrations.currentVersion();
        const fromVersion = before;
        const applied = this.store.migrations.applyInTransaction({ verifiedBackupManifest: backup });
        const contracts = applied.map((migration) => {
          const contract = this.contract(migration, before);
          before = migration.version;
          this.schemas.validateNamed("migration.schema.json", contract);
          return contract;
        });
        const project = this.store.get<{ active_generation: number; state_revision: number }>(
          "SELECT active_generation, state_revision FROM projects WHERE project_id = ?",
          args.projectId,
        );
        invariant(project, "project_not_found");
        const occurredAt = this.store.now();
        const reportId = `runtime-report.migration.${hashCanonical({
          projectId: args.projectId,
          idempotencyKey: args.idempotencyKey,
          backupId: backup.backupId,
        }).slice(0, 32)}`;
        const report = {
          reportId,
          operation: "migration.apply",
          outcome: "accepted",
          projectId: args.projectId,
          actor: args.actor,
          generation: project.active_generation,
          acceptedAt: occurredAt,
          backup: {
            backupId: backup.backupId,
            databaseCheckpoint: backup.consistency.databaseCheckpoint,
          },
          priorSchemaVersion: String(fromVersion),
          newSchemaVersion: String(before),
          migrations: contracts,
          resultingStateRevision: project.state_revision + 1,
        };
        this.store.run(
          `INSERT INTO runtime_operation_reports(
            report_id, project_id, operation, principal_id, session_id, host_id,
            generation, occurred_at, report_json
          ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`,
          reportId,
          args.projectId,
          "migration.apply",
          args.actor.principalId,
          args.actor.sessionId,
          args.actor.hostId,
          project.active_generation,
          occurredAt,
          JSON.stringify(report),
        );
        return contracts;
      },
    });
  }

  rejectDowngrade(): never {
    throw new Error("downgrade_requires_verified_restore");
  }

  private contract(
    migration: { migrationId: string; version: number; checksum: string },
    fromVersion: number,
  ): MigrationContract {
    return {
      schemaVersion: "0.1.0-draft.4",
      migrationId: migration.migrationId,
      fromVersion: String(fromVersion),
      toVersion: String(migration.version),
      checksum: migration.checksum,
      backupRequired: true,
      estimatedDowntimeSeconds: 0,
      rollbackClass: "restore_only",
      preconditions: ["Verified pre-migration backup exists.", "Migration checksum matches the packaged forward migration."],
      operations: { apply: `${migration.migrationId}.apply`, verify: `${migration.migrationId}.verify` },
    };
  }
}
