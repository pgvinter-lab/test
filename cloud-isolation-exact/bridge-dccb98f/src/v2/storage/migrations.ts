import fs from "node:fs";
import path from "node:path";
import type { DatabaseSync } from "node:sqlite";
import { sha256 } from "../core/canonical.js";
import { BridgeRuntimeError, invariant } from "../core/errors.js";

export interface MigrationFile {
  version: number;
  migrationId: string;
  path: string;
  sql: string;
  checksum: string;
}

export interface MigrationAuthorization {
  verifiedBackupManifest?: {
    backupId: string;
    projectId: string;
    backupType: "source_only" | "full";
    generation: number;
    destinations: Array<{ status: string }>;
    consistency: { eventSequence: number; databaseCheckpoint: string };
    contents: Array<{ kind: string }>;
  };
  /** The verified backup snapshot is captured one revision before its manifest commits. */
  restoredSnapshot?: boolean;
}

interface SqlToken {
  kind: "word" | "semicolon";
  value: string;
}

/**
 * Tokenize only the SQL surface needed to reject transaction-boundary and
 * database-attachment statements. Quoted strings/identifiers and comments are
 * deliberately discarded so words inside them cannot create false positives.
 */
function securityTokens(sql: string): SqlToken[] {
  const tokens: SqlToken[] = [];
  let index = 0;
  const skipQuoted = (terminator: string, doubled: boolean): void => {
    index += 1;
    while (index < sql.length) {
      if (sql[index] === terminator) {
        if (doubled && sql[index + 1] === terminator) {
          index += 2;
          continue;
        }
        index += 1;
        return;
      }
      index += 1;
    }
    invariant(false, "unterminated_migration_sql_quote");
  };
  while (index < sql.length) {
    const current = sql[index];
    const next = sql[index + 1];
    if (current === "-" && next === "-") {
      index += 2;
      while (index < sql.length && sql[index] !== "\n" && sql[index] !== "\r") index += 1;
      continue;
    }
    if (current === "/" && next === "*") {
      const end = sql.indexOf("*/", index + 2);
      invariant(end >= 0, "unterminated_migration_sql_comment");
      index = end + 2;
      continue;
    }
    if (current === "'") {
      skipQuoted("'", true);
      continue;
    }
    if (current === '"') {
      skipQuoted('"', true);
      continue;
    }
    if (current === "`") {
      skipQuoted("`", true);
      continue;
    }
    if (current === "[") {
      skipQuoted("]", false);
      continue;
    }
    if (current === ";") {
      tokens.push({ kind: "semicolon", value: ";" });
      index += 1;
      continue;
    }
    if (/[A-Za-z_]/u.test(current)) {
      const start = index;
      index += 1;
      while (index < sql.length && /[A-Za-z0-9_$]/u.test(sql[index])) index += 1;
      tokens.push({ kind: "word", value: sql.slice(start, index).toUpperCase() });
      continue;
    }
    index += 1;
  }
  return tokens;
}

function assertTransactionSafeSql(sql: string, migrationId: string): void {
  const forbidden = new Set(["COMMIT", "ROLLBACK", "SAVEPOINT", "RELEASE", "ATTACH", "DETACH"]);
  let statementWords: string[] = [];
  let triggerStepWords: string[] = [];
  let triggerBody = false;
  let triggerCaseDepth = 0;
  let triggerClosingEnd = false;
  for (const token of securityTokens(sql)) {
    if (token.kind === "semicolon") {
      // Semicolons within CREATE TRIGGER ... BEGIN ... END delimit trigger
      // steps. END; closes the outer trigger statement.
      if (!triggerBody || (triggerClosingEnd && triggerCaseDepth === 0)) {
        statementWords = [];
        triggerStepWords = [];
        triggerBody = false;
        triggerCaseDepth = 0;
      } else {
        triggerStepWords = [];
      }
      triggerClosingEnd = false;
      continue;
    }
    const word = token.value;
    const statementLeading = triggerBody ? triggerStepWords.length === 0 : statementWords.length === 0;
    invariant(
      !(forbidden.has(word) && statementLeading),
      "migration_transaction_control_forbidden",
      { migrationId, keyword: word },
    );
    // SQLite accepts a top-level bare END as an alias for COMMIT. END tokens
    // within expressions (for example CASE ... END) are not statement-leading,
    // and trigger-body END is tracked separately below.
    if (word === "END" && !triggerBody && statementWords.length === 0) {
      invariant(false, "migration_transaction_control_forbidden", { migrationId, keyword: word });
    }
    if (word === "BEGIN") {
      const createTrigger = statementWords[0] === "CREATE"
        && (statementWords[1] === "TRIGGER"
          || ((statementWords[1] === "TEMP" || statementWords[1] === "TEMPORARY") && statementWords[2] === "TRIGGER"));
      invariant(createTrigger && !triggerBody, "migration_transaction_control_forbidden", { migrationId, keyword: word });
      triggerBody = true;
      triggerStepWords = [];
      continue;
    }
    if (triggerBody && word === "CASE") triggerCaseDepth += 1;
    if (triggerBody && word === "END") {
      if (triggerCaseDepth > 0) triggerCaseDepth -= 1;
      else triggerClosingEnd = true;
    }
    if (triggerBody) triggerStepWords.push(word);
    else statementWords.push(word);
  }
}

type MigrationSqlLexicalState =
  | "code"
  | "single_quote"
  | "double_quote"
  | "backtick_quote"
  | "bracket_quote"
  | "line_comment"
  | "block_comment";

/**
 * Rewrites only checkout line endings that cannot change a SQLite token value.
 * Physical newlines inside literals and quoted identifiers are data, so they
 * remain byte-exact and a LF/CRLF change there continues to fail verification.
 * Bare CR is also preserved because Git's normal EOL conversion is LF <-> CRLF
 * and changing a bare CR could alter line-comment semantics.
 */
function migrationSqlWithLineEnding(sql: string, lineEnding: "\n" | "\r\n"): string {
  const output: string[] = [];
  let state: MigrationSqlLexicalState = "code";
  let index = 0;
  while (index < sql.length) {
    const current = sql[index];
    const next = sql[index + 1];

    if (state === "single_quote" || state === "double_quote" || state === "backtick_quote") {
      const terminator = state === "single_quote" ? "'" : state === "double_quote" ? '"' : "`";
      output.push(current);
      if (current === terminator) {
        if (next === terminator) {
          output.push(next);
          index += 2;
          continue;
        }
        state = "code";
      }
      index += 1;
      continue;
    }

    if (state === "bracket_quote") {
      output.push(current);
      if (current === "]") state = "code";
      index += 1;
      continue;
    }

    if (state === "block_comment") {
      if (current === "*" && next === "/") {
        output.push("*", "/");
        state = "code";
        index += 2;
        continue;
      }
      if (current === "\r" && next === "\n") {
        output.push(lineEnding);
        index += 2;
        continue;
      }
      if (current === "\n") {
        output.push(lineEnding);
        index += 1;
        continue;
      }
      output.push(current);
      index += 1;
      continue;
    }

    if (state === "line_comment") {
      if (current === "\r" && next === "\n") {
        output.push(lineEnding);
        state = "code";
        index += 2;
        continue;
      }
      if (current === "\n") {
        output.push(lineEnding);
        state = "code";
        index += 1;
        continue;
      }
      output.push(current);
      index += 1;
      continue;
    }

    if (current === "-" && next === "-") {
      output.push("-", "-");
      state = "line_comment";
      index += 2;
      continue;
    }
    if (current === "/" && next === "*") {
      output.push("/", "*");
      state = "block_comment";
      index += 2;
      continue;
    }
    if (current === "'") state = "single_quote";
    else if (current === '"') state = "double_quote";
    else if (current === "`") state = "backtick_quote";
    else if (current === "[") state = "bracket_quote";

    if (current === "\r" && next === "\n") {
      output.push(lineEnding);
      index += 2;
      continue;
    }
    if (current === "\n") {
      output.push(lineEnding);
      index += 1;
      continue;
    }
    output.push(current);
    index += 1;
  }
  return output.join("");
}

function canonicalMigrationChecksum(sql: string): string {
  return sha256(Buffer.from(migrationSqlWithLineEnding(sql, "\n"), "utf8"));
}

function migrationChecksumMatches(file: MigrationFile, appliedChecksum: string): boolean {
  const accepted = new Set([
    file.checksum,
    // Pre-canonical rows hashed exact checkout bytes, including mixed or bare-CR
    // files. Preserve that compatibility without treating quoted data as EOL-only.
    sha256(Buffer.from(file.sql, "utf8")),
    sha256(Buffer.from(migrationSqlWithLineEnding(file.sql, "\r\n"), "utf8")),
  ]);
  return accepted.has(appliedChecksum);
}

function migrationFiles(migrationsDir: string): MigrationFile[] {
  invariant(fs.existsSync(migrationsDir), "migrations_directory_not_found", { migrationsDir });
  return fs.readdirSync(migrationsDir, { withFileTypes: true })
    .filter((entry) => entry.isFile() && /^\d+_.+\.sql$/u.test(entry.name))
    .map((entry) => {
      const match = /^(\d+)_([^/]+)\.sql$/u.exec(entry.name)!;
      const filePath = path.join(migrationsDir, entry.name);
      const sql = fs.readFileSync(filePath, "utf8");
      return {
        version: Number(match[1]),
        migrationId: `migration.${match[1]}.${match[2]}`,
        path: filePath,
        sql,
        checksum: canonicalMigrationChecksum(sql),
      };
    })
    .sort((left, right) => left.version - right.version);
}

export class MigrationManager {
  constructor(
    private readonly database: DatabaseSync,
    private readonly migrationsDir: string,
    private readonly now: () => string,
  ) {}

  bootstrap(): void {
    this.database.exec(`
      CREATE TABLE IF NOT EXISTS schema_migrations (
        version INTEGER PRIMARY KEY,
        migration_id TEXT NOT NULL UNIQUE,
        checksum TEXT NOT NULL,
        applied_at TEXT NOT NULL
      ) STRICT;
    `);
  }

  currentVersion(): number {
    const row = this.database.prepare("SELECT COALESCE(MAX(version), 0) AS version FROM schema_migrations").get() as { version: number };
    return Number(row.version);
  }

  pending(): MigrationFile[] {
    const appliedRows = this.database.prepare(
      "SELECT version, migration_id, checksum FROM schema_migrations ORDER BY version",
    ).all() as Array<{ version: number; migration_id: string; checksum: string }>;
    const applied = new Map(appliedRows.map((row) => [Number(row.version), row]));
    const files = migrationFiles(this.migrationsDir);
    invariant(new Set(files.map((file) => file.version)).size === files.length, "duplicate_migration_version");
    const byVersion = new Map(files.map((file) => [file.version, file]));
    for (const row of appliedRows) {
      const file = byVersion.get(Number(row.version));
      invariant(file, "applied_migration_file_missing", { version: row.version });
      invariant(file.migrationId === row.migration_id, "migration_identity_mismatch", { version: row.version });
      if (!migrationChecksumMatches(file, row.checksum)) throw new BridgeRuntimeError("migration_checksum_mismatch", { version: row.version });
    }
    const current = appliedRows.length ? Number(appliedRows[appliedRows.length - 1].version) : 0;
    for (const file of files) {
      const row = applied.get(file.version);
      if (row && !migrationChecksumMatches(file, row.checksum)) throw new BridgeRuntimeError("migration_checksum_mismatch", { version: file.version });
      invariant(row || file.version > current, "non_forward_migration_detected", { version: file.version, current });
    }
    return files.filter((file) => !applied.has(file.version));
  }

  apply(options: MigrationAuthorization = {}): MigrationFile[] {
    this.bootstrap();
    if (this.pending().length === 0) return [];
    this.database.exec("BEGIN IMMEDIATE");
    try {
      const applied = this.applyInTransaction(options);
      this.database.exec("COMMIT");
      return applied;
    } catch (error) {
      try { this.database.exec("ROLLBACK"); } catch { /* preserve original error */ }
      throw error;
    }
  }

  /**
   * Apply pending migrations inside a caller-owned IMMEDIATE transaction. This
   * exists so the command service can atomically persist its idempotent response
   * with the schema change. Callers must already hold the write transaction.
   */
  applyInTransaction(options: MigrationAuthorization = {}): MigrationFile[] {
    this.bootstrap();
    const pending = this.pending();
    if (pending.length === 0) return [];
    const current = this.currentVersion();
    if (current > 0) {
      const manifest = options.verifiedBackupManifest;
      invariant(manifest, "pre_migration_backup_required");
      invariant(
        manifest.destinations.some((destination) => destination.status === "verified"),
        "verified_pre_migration_backup_required",
      );
      invariant(manifest.backupType === "full" && manifest.contents.some((content) => content.kind === "state_snapshot"), "full_pre_migration_backup_required");
      const projects = this.database.prepare("SELECT project_id, active_generation, state_revision FROM projects").all() as
        Array<{ project_id: string; active_generation: number; state_revision: number }>;
      invariant(projects.length === 1, "singleton_project_database_required");
      const project = projects[0];
      invariant(manifest.projectId === project.project_id, "pre_migration_backup_project_mismatch");
      invariant(manifest.generation === Number(project.active_generation), "pre_migration_backup_generation_mismatch");
      const event = this.database.prepare("SELECT COALESCE(MAX(sequence), 0) AS sequence FROM events WHERE project_id = ?").get(project.project_id) as { sequence: number };
      invariant(manifest.consistency.eventSequence === Number(event.sequence), "pre_migration_backup_event_sequence_mismatch");
      const checkpoint = /^sqlite-state-revision-(\d+)$/u.exec(manifest.consistency.databaseCheckpoint);
      invariant(checkpoint, "pre_migration_backup_checkpoint_invalid");
      const expectedRevision = Number(project.state_revision) + (options.restoredSnapshot ? 1 : 0);
      invariant(Number(checkpoint[1]) === expectedRevision, "pre_migration_backup_state_revision_mismatch");
    }
    for (const migration of pending) assertTransactionSafeSql(migration.sql, migration.migrationId);
    const applied: MigrationFile[] = [];
    for (const migration of pending) {
      this.database.exec(migration.sql);
      this.database.prepare(
        "INSERT INTO schema_migrations(version, migration_id, checksum, applied_at) VALUES (?, ?, ?, ?)",
      ).run(migration.version, migration.migrationId, migration.checksum, this.now());
      applied.push(migration);
    }
    return applied;
  }

  verify(): { currentVersion: number; pending: number; checksumsValid: boolean } {
    const pending = this.pending();
    return { currentVersion: this.currentVersion(), pending: pending.length, checksumsValid: true };
  }
}
