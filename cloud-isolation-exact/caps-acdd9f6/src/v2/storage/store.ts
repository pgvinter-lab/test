import fs from "node:fs";
import path from "node:path";
import { DatabaseSync, type SQLInputValue } from "node:sqlite";
import { canonicalEqual, canonicalize, deepCopy, hashAuditEntry, hashCanonical } from "../core/canonical.js";
import { BridgeRuntimeError, invariant } from "../core/errors.js";
import type { AuditMirrorEntry, PrincipalRef } from "../core/types.js";
import { MigrationManager, type MigrationAuthorization } from "./migrations.js";

export interface BridgeStoreOptions {
  databasePath: string;
  auditMirrorPath?: string;
  migrationsDir?: string;
  now?: () => string;
  initialize?: boolean;
  migrationAuthorization?: MigrationAuthorization;
  readOnly?: boolean;
}

export interface IdempotentMutation<T> {
  projectId: string;
  actor: PrincipalRef;
  operation: string;
  idempotencyKey: string;
  request: unknown;
  run: () => T;
}

interface PendingMirrorRow {
  project_id: string;
  mirror_sequence: number;
  entry_json: string;
  mirror_hash: string;
}

export class BridgeStore {
  readonly database: DatabaseSync;
  readonly migrations: MigrationManager;
  readonly databasePath: string;
  readonly auditMirrorPath?: string;
  readonly migrationsDir: string;
  readonly now: () => string;
  private inWrite = false;

  constructor(options: BridgeStoreOptions) {
    this.now = options.now ?? (() => new Date().toISOString());
    const requestedDatabasePath = path.resolve(options.databasePath);
    const databaseExisted = fs.existsSync(requestedDatabasePath);
    canonicalStateFilePath(requestedDatabasePath, options.readOnly === true, "database_path_reparse_forbidden");
    if (!options.readOnly) {
      fs.mkdirSync(path.dirname(requestedDatabasePath), { recursive: true, mode: 0o700 });
      canonicalStateFilePath(requestedDatabasePath, false, "database_path_reparse_forbidden");
    }
    const databasePath = requestedDatabasePath;
    this.databasePath = databasePath;
    this.auditMirrorPath = options.auditMirrorPath
      ? canonicalStateFilePath(path.resolve(options.auditMirrorPath), false, "audit_mirror_path_reparse_forbidden")
      : undefined;
    if (this.auditMirrorPath) {
      assertAuditMirrorDoesNotCollide(databasePath, this.auditMirrorPath);
      const auditStat = fs.lstatSync(this.auditMirrorPath, { throwIfNoEntry: false });
      invariant(!auditStat || (auditStat.isFile() && !auditStat.isSymbolicLink()), "audit_mirror_path_not_file");
    }
    if (!options.readOnly && !fs.existsSync(databasePath)) {
      const handle = fs.openSync(databasePath, "wx", 0o600);
      fs.closeSync(handle);
    }
    this.database = options.readOnly
      ? new DatabaseSync(databasePath, { readOnly: true })
      : new DatabaseSync(databasePath);
    this.database.exec("PRAGMA foreign_keys = ON");
    this.database.exec("PRAGMA busy_timeout = 5000");
    this.database.exec("PRAGMA recursive_triggers = ON");
    this.database.exec("PRAGMA trusted_schema = OFF");
    if (!options.readOnly) {
      this.database.exec("PRAGMA journal_mode = WAL");
      this.database.exec("PRAGMA synchronous = FULL");
      if (!databaseExisted && process.platform !== "win32") {
        for (const statePath of [databasePath, `${databasePath}-wal`, `${databasePath}-shm`]) {
          if (fs.existsSync(statePath)) fs.chmodSync(statePath, 0o600);
        }
      }
    }
    if (this.auditMirrorPath) {
      try {
        assertAuditMirrorDoesNotCollide(databasePath, this.auditMirrorPath);
      } catch (error) {
        this.database.close();
        throw error;
      }
    }
    this.migrationsDir = path.resolve(options.migrationsDir ?? path.resolve(process.cwd(), "migrations"));
    this.migrations = new MigrationManager(this.database, this.migrationsDir, this.now);
    if (options.initialize) this.migrations.apply(options.migrationAuthorization);
  }

  close(): void {
    this.database.close();
  }

  exec(sql: string): void {
    this.database.exec(sql);
  }

  get<T>(sql: string, ...params: SQLInputValue[]): T | undefined {
    return this.database.prepare(sql).get(...params) as T | undefined;
  }

  all<T>(sql: string, ...params: SQLInputValue[]): T[] {
    return this.database.prepare(sql).all(...params) as T[];
  }

  run(sql: string, ...params: SQLInputValue[]): { changes: number | bigint; lastInsertRowid: number | bigint } {
    return this.database.prepare(sql).run(...params);
  }

  transaction<T>(run: () => T): T {
    invariant(!this.inWrite, "nested_write_transaction_forbidden");
    this.database.exec("BEGIN IMMEDIATE");
    this.inWrite = true;
    try {
      const changesBefore = Number(this.get<{ changes: number }>("SELECT total_changes() AS changes")?.changes ?? 0);
      const result = run();
      const changesAfter = Number(this.get<{ changes: number }>("SELECT total_changes() AS changes")?.changes ?? 0);
      if (changesAfter > changesBefore) {
        const projects = this.all<{ project_id: string }>("SELECT project_id FROM projects ORDER BY project_id");
        invariant(projects.length <= 1, "singleton_project_database_required");
        if (projects.length === 1) {
          const bumped = this.run(
            "UPDATE projects SET state_revision = state_revision + 1 WHERE project_id = ?",
            projects[0].project_id,
          );
          invariant(Number(bumped.changes) === 1, "state_revision_bump_failed");
        }
      }
      this.database.exec("COMMIT");
      this.inWrite = false;
      this.flushAuditMirror();
      return result;
    } catch (error) {
      if (this.inWrite) {
        try { this.database.exec("ROLLBACK"); } catch { /* preserve original error */ }
      }
      this.inWrite = false;
      throw error;
    }
  }

  assertWriteTransaction(): void {
    invariant(this.inWrite, "write_transaction_required");
  }

  mutateIdempotent<T>(mutation: IdempotentMutation<T>): T {
    invariant(mutation.idempotencyKey.length > 0, "idempotency_key_required");
    // The durable idempotency scope already includes the principal. Sessions and
    // hosts are deliberately not part of the request hash: a principal must be
    // able to replay an interrupted command from a refreshed authenticated
    // session without turning the same key into a collision.
    const requestHash = hashCanonical(mutation.request);
    return this.transaction(() => {
      const existing = this.get<{ request_hash: string; response_json: string }>(
        `SELECT request_hash, response_json FROM idempotency_records
         WHERE project_id = ? AND principal_id = ? AND operation = ? AND idempotency_key = ?`,
        mutation.projectId,
        mutation.actor.principalId,
        mutation.operation,
        mutation.idempotencyKey,
      );
      if (existing) {
        invariant(existing.request_hash === requestHash, "idempotency_key_reused");
        // Idempotency changes command evaluation order, not authentication.
        // A principal may replay from a refreshed *authenticated* session, but
        // knowledge of another principal's key and request must never be enough
        // to retrieve the durable response through the library API.
        this.assertActiveActorBinding(mutation.actor);
        return deepCopy(JSON.parse(existing.response_json) as T);
      }

      // Replays remain available while a recovered/retired project is frozen,
      // but no new state-changing command may enter it. Bootstrap has no
      // project row yet, and generation takeover is the narrowly scoped path
      // used by recovery activation.
      if (mutation.operation !== "identity.bootstrap_owner" && mutation.operation !== "project.advance_generation") {
        const project = this.get<{ status: string }>(
          "SELECT status FROM projects WHERE project_id = ?",
          mutation.projectId,
        );
        invariant(project, "project_not_found");
        invariant(project.status === "active", "project_not_active");
      }

      const result = mutation.run();
      // Persist attribution only after the mutation so bootstrap can create
      // its project/principal/session/host in this same atomic transaction.
      // The principal remains part of the idempotency scope; session and host
      // are attribution, not scope, so a refreshed session can replay safely.
      const project = this.get<{ active_generation: number }>(
        "SELECT active_generation FROM projects WHERE project_id = ?",
        mutation.projectId,
      );
      invariant(project, "project_not_found");
      const session = this.get<{ principal_id: string; host_id: string }>(
        "SELECT principal_id, host_id FROM sessions WHERE session_id = ?",
        mutation.actor.sessionId,
      );
      invariant(
        session
          && session.principal_id === mutation.actor.principalId
          && session.host_id === mutation.actor.hostId,
        "command_attribution_identity_mismatch",
      );
      this.run(
        `INSERT INTO idempotency_records(
          project_id, principal_id, session_id, host_id, generation,
          operation, idempotency_key, request_hash, response_json, created_at
        ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
        mutation.projectId,
        mutation.actor.principalId,
        mutation.actor.sessionId,
        mutation.actor.hostId,
        project.active_generation,
        mutation.operation,
        mutation.idempotencyKey,
        requestHash,
        JSON.stringify(result),
        this.now(),
      );
      return deepCopy(result);
    });
  }

  private assertActiveActorBinding(actor: PrincipalRef): void {
    const binding = this.get<{
      principal_id: string;
      principal_status: string;
      host_id: string;
      host_status: string;
      session_status: string;
      started_at: string;
      expires_at: string;
    }>(
      `SELECT s.principal_id, p.status AS principal_status,
              s.host_id, h.status AS host_status,
              s.status AS session_status, s.started_at, s.expires_at
       FROM sessions s
       JOIN principals p ON p.principal_id = s.principal_id
       JOIN hosts h ON h.host_id = s.host_id
       WHERE s.session_id = ?`,
      actor.sessionId,
    );
    invariant(binding, "identity_binding_not_found");
    invariant(
      binding.principal_id === actor.principalId && binding.host_id === actor.hostId,
      "identity_binding_mismatch",
    );
    invariant(binding.principal_status === "active", "principal_not_active");
    invariant(binding.session_status === "active", "session_not_active");
    invariant(binding.host_status === "active", "host_not_active");
    invariant(Date.parse(binding.started_at) <= Date.parse(this.now()), "session_not_started");
    invariant(Date.parse(binding.expires_at) > Date.parse(this.now()), "session_expired");
  }

  flushAuditMirror(): void {
    if (!this.auditMirrorPath) return;
    fs.mkdirSync(path.dirname(this.auditMirrorPath), { recursive: true, mode: 0o700 });
    invariant(!this.inWrite, "audit_mirror_flush_during_write_transaction");
    while (true) {
      // SQLite is the cross-process mutex for the JSONL outbox. Holding an
      // IMMEDIATE transaction across append + acknowledgement prevents two
      // runtime/CLI processes from appending the same pending row. If a process
      // crashes after append but before the flag update, the exact-last-line
      // branch below safely acknowledges the replay.
      this.database.exec("BEGIN IMMEDIATE");
      try {
        this.assertMirrorFilePrefix();
        const row = this.get<PendingMirrorRow>(
          `SELECT project_id, mirror_sequence, entry_json, mirror_hash
           FROM audit_mirror_entries WHERE file_appended = 0
           ORDER BY mirror_sequence LIMIT 1`,
        );
        if (!row) {
          this.database.exec("COMMIT");
          return;
        }
        const entry = JSON.parse(row.entry_json) as AuditMirrorEntry;
        const last = this.lastMirrorFileEntry();
        if (last) {
          if (last.mirrorSequence === entry.mirrorSequence && last.mirrorHash === entry.mirrorHash) {
            this.markMirrorAppended(row.project_id, row.mirror_sequence);
            this.database.exec("COMMIT");
            continue;
          }
          invariant(
            entry.mirrorSequence === last.mirrorSequence + 1 && entry.previousMirrorHash === last.mirrorHash,
            "audit_mirror_file_chain_mismatch",
          );
        } else {
          invariant(entry.mirrorSequence === 1 && entry.previousMirrorHash === undefined, "audit_mirror_file_chain_mismatch");
        }
        fs.appendFileSync(this.auditMirrorPath, `${canonicalize(entry)}\n`, { encoding: "utf8", flag: "a", mode: 0o600 });
        this.markMirrorAppended(row.project_id, row.mirror_sequence);
        this.database.exec("COMMIT");
      } catch (error) {
        try { this.database.exec("ROLLBACK"); } catch { /* preserve original error */ }
        throw new BridgeRuntimeError("audit_mirror_append_failed", {
          cause: error instanceof Error ? error.message : String(error),
        });
      }
    }
  }

  private markMirrorAppended(projectId: string, mirrorSequence: number): void {
    this.run(
      "UPDATE audit_mirror_entries SET file_appended = 1 WHERE project_id = ? AND mirror_sequence = ?",
      projectId,
      mirrorSequence,
    );
  }

  private lastMirrorFileEntry(): AuditMirrorEntry | undefined {
    if (!this.auditMirrorPath || !fs.existsSync(this.auditMirrorPath)) return undefined;
    const content = fs.readFileSync(this.auditMirrorPath, "utf8").trimEnd();
    if (!content) return undefined;
    const lastLine = content.slice(content.lastIndexOf("\n") + 1);
    return JSON.parse(lastLine) as AuditMirrorEntry;
  }

  private assertMirrorFilePrefix(): void {
    if (!this.auditMirrorPath || !fs.existsSync(this.auditMirrorPath)) return;
    const content = fs.readFileSync(this.auditMirrorPath, "utf8");
    if (!content) return;
    invariant(content.endsWith("\n"), "audit_mirror_file_chain_mismatch");
    const lines = content.trimEnd().split("\n");
    const rows = this.all<{ entry_json: string }>(
      "SELECT entry_json FROM audit_mirror_entries ORDER BY mirror_sequence LIMIT ?",
      lines.length,
    );
    invariant(rows.length === lines.length, "audit_mirror_file_chain_mismatch");
    let previousHash: string | undefined;
    for (let index = 0; index < lines.length; index += 1) {
      const parsed = JSON.parse(lines[index]) as AuditMirrorEntry;
      const persisted = JSON.parse(rows[index].entry_json) as AuditMirrorEntry;
      invariant(canonicalize(parsed) === lines[index], "audit_mirror_file_not_canonical");
      invariant(canonicalEqual(parsed, persisted) && hashAuditEntry(parsed) === parsed.mirrorHash, "audit_mirror_file_hash_mismatch");
      invariant(
        parsed.mirrorSequence === index + 1 && (index === 0 ? parsed.previousMirrorHash === undefined : parsed.previousMirrorHash === previousHash),
        "audit_mirror_file_chain_mismatch",
      );
      previousHash = parsed.mirrorHash;
    }
  }

  readDocument<T>(table: "artifacts" | "review_jobs" | "approval_grants", idColumn: string, id: string): T | undefined {
    invariant(/^[a-z_]+$/u.test(idColumn), "invalid_identifier_column");
    const row = this.get<{ document_json: string }>(`SELECT document_json FROM ${table} WHERE ${idColumn} = ?`, id);
    return row ? JSON.parse(row.document_json) as T : undefined;
  }

  assertImmutableCollision(existing: unknown, candidate: unknown, code: string): void {
    invariant(canonicalEqual(existing, candidate), code);
  }
}

function canonicalStateFilePath(filePath: string, mustExist: boolean, code: string): string {
  const absolute = path.resolve(filePath);
  if (mustExist) invariant(fs.existsSync(absolute), "database_path_missing");
  if (fs.existsSync(absolute)) {
    const stat = fs.lstatSync(absolute);
    invariant(stat.isFile() && !stat.isSymbolicLink(), code);
  }
  let ancestor = path.dirname(absolute);
  while (!fs.existsSync(ancestor)) {
    const parent = path.dirname(ancestor);
    invariant(parent !== ancestor, code);
    ancestor = parent;
  }
  const stat = fs.lstatSync(ancestor);
  invariant(stat.isDirectory() && !stat.isSymbolicLink(), code);
  invariant(sameFilesystemPath(fs.realpathSync.native(ancestor), ancestor), code);
  return absolute;
}

function sameFilesystemPath(left: string, right: string): boolean {
  const normalize = (value: string): string => process.platform === "win32"
    ? path.normalize(path.resolve(value)).toLocaleLowerCase("en-US")
    : path.normalize(path.resolve(value));
  return normalize(left) === normalize(right);
}

function assertAuditMirrorDoesNotCollide(databasePath: string, auditMirrorPath: string): void {
  const sqliteStatePaths = [databasePath, `${databasePath}-wal`, `${databasePath}-shm`, `${databasePath}-journal`];
  invariant(
    !sqliteStatePaths.some((statePath) => (
      sameFilesystemPath(statePath, auditMirrorPath) || sameExistingFile(statePath, auditMirrorPath)
    )),
    "audit_mirror_sqlite_path_collision",
  );
}

function sameExistingFile(left: string, right: string): boolean {
  const leftStat = fs.statSync(left, { bigint: true, throwIfNoEntry: false });
  if (!leftStat) return false;
  const rightStat = fs.statSync(right, { bigint: true, throwIfNoEntry: false });
  return Boolean(rightStat && leftStat.dev === rightStat.dev && leftStat.ino === rightStat.ino);
}
