import { fileURLToPath } from "node:url";
import { AdapterHost } from "./adapters/adapter-host.js";
import { AdapterRegistry } from "./adapters/adapter-registry.js";
import { ArtifactService } from "./artifacts/artifact-service.js";
import { ContractSchemaRegistry } from "./core/schema-registry.js";
import { IdentityService } from "./identity/identity-service.js";
import { ApprovalService } from "./jobs/approval-service.js";
import { JobService } from "./jobs/job-service.js";
import { BackupService } from "./recovery/backup-service.js";
import { DoctorService } from "./recovery/doctor-service.js";
import { MigrationService } from "./recovery/migration-service.js";
import { RestoreService } from "./recovery/restore-service.js";
import { EventJournal } from "./storage/journal.js";
import { BridgeStore, type BridgeStoreOptions } from "./storage/store.js";

export interface BridgeRuntimeOptions extends Omit<BridgeStoreOptions, "migrationsDir"> {
  migrationsDir?: string;
  schemaDirectory?: string;
}

export class BridgeRuntime {
  readonly store: BridgeStore;
  readonly schemas: ContractSchemaRegistry;
  readonly identity: IdentityService;
  readonly artifacts: ArtifactService;
  readonly journal: EventJournal;
  readonly adapters: AdapterRegistry;
  readonly jobs: JobService;
  readonly approvals: ApprovalService;
  readonly adapterHost: AdapterHost;
  readonly backups: BackupService;
  readonly restores: RestoreService;
  readonly migrations: MigrationService;
  readonly doctor: DoctorService;

  constructor(options: BridgeRuntimeOptions) {
    const migrationsDir = options.migrationsDir ?? fileURLToPath(new URL("../../migrations", import.meta.url));
    const schemaDirectory = options.schemaDirectory ?? fileURLToPath(new URL("../../contracts/v0.1.0-draft.4/schemas", import.meta.url));
    this.store = new BridgeStore({ ...options, migrationsDir });
    this.schemas = new ContractSchemaRegistry(schemaDirectory);
    this.identity = new IdentityService(this.store, this.schemas);
    this.artifacts = new ArtifactService(this.store, this.identity, this.schemas);
    this.journal = new EventJournal(this.store, this.schemas);
    this.adapters = new AdapterRegistry(this.store, this.identity, this.schemas);
    this.jobs = new JobService(this.store, this.identity, this.artifacts, this.journal, this.schemas);
    this.approvals = new ApprovalService(this.store, this.identity, this.jobs, this.adapters, this.journal, this.schemas);
    this.adapterHost = new AdapterHost(this.store, this.identity, this.adapters, this.jobs);
    this.backups = new BackupService(this.store, this.identity, this.schemas, this.approvals);
    this.restores = new RestoreService(this.store, this.identity, this.schemas);
    this.migrations = new MigrationService(this.store, this.identity, this.backups, this.schemas);
    this.doctor = new DoctorService(
      this.store,
      this.identity,
      this.adapters,
      this.schemas,
      (adapterId, adapterVersion) => this.adapterHost.executionMode(adapterId, adapterVersion),
    );
  }

  close(): void {
    this.store.close();
  }
}
