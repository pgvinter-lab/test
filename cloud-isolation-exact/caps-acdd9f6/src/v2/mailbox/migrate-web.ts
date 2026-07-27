import crypto from "node:crypto";
import fs from "node:fs";
import path from "node:path";
import { backup, DatabaseSync } from "node:sqlite";
import { fileURLToPath } from "node:url";
import { canonicalize, hashCanonical, sha256 } from "../core/canonical.js";
import { invariant } from "../core/errors.js";
import { newId } from "../core/ids.js";
import {
  assertContainedPathWithoutReparse,
  loadMailboxConfig,
  writeJsonAtomic,
} from "./config.js";
import { migrateMailboxV1ToV2, type MailboxMigrationResult } from "./migrate.js";
import {
  MAILBOX_CONFIG_VERSION,
  MAILBOX_LEGACY_CONFIG_VERSION,
  MAILBOX_PREVIOUS_CONFIG_VERSION,
  MAILBOX_PREVIOUS_SCHEMA_VERSION,
  MAILBOX_SCHEMA_VERSION,
  type MailboxConfig,
} from "./types.js";
import { defaultWebNodeProfiles } from "./web-node-profile.js";

const MIGRATION_ID = "mailbox-003-generic-web-provider";

interface MailboxV2Config {
  schemaVersion: typeof MAILBOX_PREVIOUS_CONFIG_VERSION;
  stateDirectory: string;
  databasePath: string;
  auditMirrorPath: string;
  exchangeRoot: string;
  broker: MailboxConfig["broker"];
  providers: Pick<MailboxConfig["providers"], "chatgpt" | "antigravity">;
  delivery: MailboxConfig["delivery"];
  integrations: {
    chromeExtensionDirectory: string;
    antigravityPluginDirectory: string;
  };
}

interface EventRow {
  sequence: number;
  event_id: string;
  event_type: string;
  message_id: string | null;
  occurred_at: string;
  payload_json: string;
  previous_hash: string | null;
  event_hash: string;
  file_appended: number;
}

interface MigrationPreflight {
  messages: number;
  deliveries: number;
  idempotency: number;
  messagesSha256: string;
  deliveriesSha256: string;
  idempotencySha256: string;
  events: EventRow[];
}

export interface WebMailboxMigrationResult {
  migrationId: typeof MIGRATION_ID;
  fromVersion: 2;
  toVersion: 3;
  webNodes: string[];
  backupDirectory: string;
  rollback: "restore_before_v3_work_only";
}

export type MailboxCurrentMigrationResult =
  | { alreadyCurrent: true; schemaVersion: typeof MAILBOX_SCHEMA_VERSION }
  | { migrations: Array<MailboxMigrationResult | WebMailboxMigrationResult> };

export async function migrateMailboxToCurrent(configPath: string): Promise<MailboxCurrentMigrationResult> {
  const resolved = path.resolve(configPath);
  const parsed = JSON.parse(fs.readFileSync(resolved, "utf8")) as { schemaVersion?: unknown };
  if (parsed.schemaVersion === MAILBOX_CONFIG_VERSION) {
    loadMailboxConfig(resolved);
    return { alreadyCurrent: true, schemaVersion: MAILBOX_SCHEMA_VERSION };
  }
  const migrations: Array<MailboxMigrationResult | WebMailboxMigrationResult> = [];
  if (parsed.schemaVersion === MAILBOX_LEGACY_CONFIG_VERSION) {
    migrations.push(await migrateMailboxV1ToV2(resolved));
  } else {
    invariant(parsed.schemaVersion === MAILBOX_PREVIOUS_CONFIG_VERSION, "mailbox_migration_config_version_unsupported");
  }
  migrations.push(await migrateMailboxV2ToV3(resolved));
  return { migrations };
}

export async function migrateMailboxV2ToV3(configPath: string): Promise<WebMailboxMigrationResult> {
  const resolvedConfigPath = path.resolve(configPath);
  const config = readV2Config(resolvedConfigPath);
  const migrationSqlPath = fileURLToPath(new URL("../../../migrations/mailbox/003_generic_web_provider.sql", import.meta.url));
  const migrationSql = fs.readFileSync(migrationSqlPath, "utf8");
  const migrationSqlSha256 = sha256(Buffer.from(migrationSql, "utf8"));
  let database: DatabaseSync | undefined;
  let backupDirectory: string | undefined;
  let preflight: MigrationPreflight | undefined;
  let committed = false;

  try {
    database = new DatabaseSync(config.databasePath);
    database.exec("PRAGMA foreign_keys = ON");
    database.exec("PRAGMA busy_timeout = 10000");
    database.exec("PRAGMA trusted_schema = OFF");
    database.exec("PRAGMA locking_mode = EXCLUSIVE");
    database.exec("BEGIN EXCLUSIVE");
    try {
      preflight = verifyPreflight(database, config);
      database.exec("COMMIT");
    } catch (error) {
      try { database.exec("ROLLBACK"); } catch {}
      throw error;
    }

    backupDirectory = await createRestoreBackup(
      database,
      resolvedConfigPath,
      config,
      preflight,
      migrationSqlSha256,
    );

    database.exec("BEGIN IMMEDIATE");
    try {
      database.exec(migrationSql);
      assertPreserved(database, preflight);
      appendMigrationEvent(database, preflight, migrationSqlSha256);
      database.exec("COMMIT");
      committed = true;
    } catch (error) {
      try { database.exec("ROLLBACK"); } catch {}
      throw error;
    }

    flushMigrationEvent(database, config.auditMirrorPath);
    verifyResult(database, config, preflight);
    const active = activeConfig(config);
    writeJsonAtomic(resolvedConfigPath, active, true);
    loadMailboxConfig(resolvedConfigPath);

    return {
      migrationId: MIGRATION_ID,
      fromVersion: 2,
      toVersion: 3,
      webNodes: Object.keys(active.webNodes).sort(),
      backupDirectory,
      rollback: "restore_before_v3_work_only",
    };
  } catch (error) {
    if (committed && backupDirectory && preflight) {
      try {
        invariant(database, "mailbox_migration_rollback_database_missing");
        assertAutomaticRestoreSafe(database, preflight);
        database.close();
        database = undefined;
        await restoreBackup(backupDirectory, resolvedConfigPath, config);
      } catch (rollbackError) {
        throw new Error(`mailbox_migration_rollback_failed:${errorCode(error)}:${errorCode(rollbackError)}`);
      }
    }
    throw error;
  } finally {
    database?.close();
  }
}

function readV2Config(configPath: string): MailboxV2Config {
  const stat = fs.lstatSync(configPath);
  invariant(stat.isFile() && !stat.isSymbolicLink(), "mailbox_migration_config_invalid");
  const parsed = JSON.parse(fs.readFileSync(configPath, "utf8")) as MailboxV2Config;
  invariant(parsed.schemaVersion === MAILBOX_PREVIOUS_CONFIG_VERSION, "mailbox_migration_v2_config_required");
  for (const [field, value] of Object.entries({
    stateDirectory: parsed.stateDirectory,
    databasePath: parsed.databasePath,
    auditMirrorPath: parsed.auditMirrorPath,
    exchangeRoot: parsed.exchangeRoot,
    tokenFile: parsed.broker?.tokenFile,
    chromeExtensionDirectory: parsed.integrations?.chromeExtensionDirectory,
    antigravityPluginDirectory: parsed.integrations?.antigravityPluginDirectory,
  })) {
    invariant(typeof value === "string" && path.isAbsolute(value), "mailbox_migration_config_path_invalid", { field });
  }
  invariant(sameOrChild(parsed.databasePath, parsed.stateDirectory), "mailbox_migration_state_path_invalid");
  invariant(sameOrChild(parsed.auditMirrorPath, parsed.stateDirectory), "mailbox_migration_state_path_invalid");
  invariant(sameOrChild(parsed.broker.tokenFile, parsed.stateDirectory), "mailbox_migration_state_path_invalid");
  invariant(!sameOrChild(parsed.exchangeRoot, parsed.stateDirectory) && !sameOrChild(parsed.stateDirectory, parsed.exchangeRoot), "mailbox_state_exchange_overlap_forbidden");
  assertDirectory(parsed.stateDirectory, "mailbox_migration_state_directory_invalid");
  assertDirectory(parsed.exchangeRoot, "mailbox_migration_exchange_root_invalid");
  for (const candidate of [parsed.databasePath, parsed.auditMirrorPath]) {
    const candidateStat = fs.lstatSync(candidate);
    invariant(candidateStat.isFile() && !candidateStat.isSymbolicLink(), "mailbox_migration_runtime_file_invalid");
  }
  invariant(parsed.providers?.chatgpt && parsed.providers?.antigravity, "mailbox_migration_provider_config_invalid");
  return parsed;
}

function verifyPreflight(database: DatabaseSync, config: MailboxV2Config): MigrationPreflight {
  invariant(number(database, "PRAGMA user_version", "user_version") === 2, "mailbox_migration_v2_database_required");
  const schema = database.prepare("SELECT value FROM mailbox_metadata WHERE key = 'schema_version'").get() as { value?: string } | undefined;
  invariant(schema?.value === MAILBOX_PREVIOUS_SCHEMA_VERSION, "mailbox_migration_v2_schema_required");
  invariant(text(database, "PRAGMA integrity_check", "integrity_check") === "ok", "mailbox_migration_integrity_failed");
  invariant(database.prepare("PRAGMA foreign_key_check").all().length === 0, "mailbox_migration_foreign_key_failed");
  invariant(
    count(database, "SELECT COUNT(*) AS count FROM mailbox_messages WHERE status NOT IN ('completed','failed','uncertain','expired')") === 0,
    "mailbox_v2_nonterminal",
  );
  invariant(
    count(database, "SELECT COUNT(*) AS count FROM mailbox_deliveries WHERE status IN ('claimed','dispatching','sent')") === 0,
    "mailbox_v2_active_delivery",
  );
  const events = database.prepare("SELECT * FROM mailbox_events ORDER BY sequence").all() as unknown as EventRow[];
  verifyEvents(events, true);
  verifyAudit(config.auditMirrorPath, events);
  return {
    messages: count(database, "SELECT COUNT(*) AS count FROM mailbox_messages"),
    deliveries: count(database, "SELECT COUNT(*) AS count FROM mailbox_deliveries"),
    idempotency: count(database, "SELECT COUNT(*) AS count FROM mailbox_idempotency"),
    messagesSha256: tableDigest(database, "SELECT * FROM mailbox_messages ORDER BY message_id"),
    deliveriesSha256: tableDigest(database, "SELECT * FROM mailbox_deliveries ORDER BY delivery_id"),
    idempotencySha256: tableDigest(database, "SELECT * FROM mailbox_idempotency ORDER BY principal_id, operation, idempotency_key"),
    events,
  };
}

async function createRestoreBackup(
  database: DatabaseSync,
  configPath: string,
  config: MailboxV2Config,
  preflight: MigrationPreflight,
  migrationSqlSha256: string,
): Promise<string> {
  const root = path.join(config.stateDirectory, "migrations");
  assertContainedPathWithoutReparse(root, config.stateDirectory, "mailbox_migration_backup_reparse_forbidden");
  fs.mkdirSync(root, { recursive: true, mode: 0o700 });
  const name = `${MIGRATION_ID}-${new Date().toISOString().replace(/[:.]/gu, "-")}-${crypto.randomUUID()}`;
  const partial = path.join(root, `.${name}.partial`);
  const target = path.join(root, name);
  fs.mkdirSync(partial, { mode: 0o700 });
  try {
    const files = {
      "config.json": path.join(partial, "config.json"),
      "mailbox.sqlite": path.join(partial, "mailbox.sqlite"),
      "mailbox-audit.jsonl": path.join(partial, "mailbox-audit.jsonl"),
    };
    fs.copyFileSync(configPath, files["config.json"], fs.constants.COPYFILE_EXCL);
    fs.copyFileSync(config.auditMirrorPath, files["mailbox-audit.jsonl"], fs.constants.COPYFILE_EXCL);
    await backup(database, files["mailbox.sqlite"]);
    const snapshot = new DatabaseSync(files["mailbox.sqlite"], { readOnly: true });
    try {
      invariant(text(snapshot, "PRAGMA integrity_check", "integrity_check") === "ok", "mailbox_migration_backup_integrity_failed");
      invariant(count(snapshot, "SELECT COUNT(*) AS count FROM mailbox_events") === preflight.events.length, "mailbox_migration_backup_event_count_mismatch");
    } finally {
      snapshot.close();
    }
    const manifestFiles = Object.fromEntries(Object.entries(files).map(([name, filePath]) => {
      const bytes = fs.readFileSync(filePath);
      return [name, { sha256: sha256(bytes), byteLength: bytes.length }];
    }));
    writeExclusive(path.join(partial, "manifest.json"), `${JSON.stringify({
      schemaVersion: "bridge-mailbox-migration-backup-v1",
      migrationId: MIGRATION_ID,
      createdAt: new Date().toISOString(),
      fromSchemaVersion: MAILBOX_PREVIOUS_SCHEMA_VERSION,
      toSchemaVersion: MAILBOX_SCHEMA_VERSION,
      migrationSqlSha256,
      files: manifestFiles,
      rollback: "restore_before_v3_work_only",
      rollbackWindow: "migration_command_only_before_any_v3_work",
      restoreOrder: ["stop_mailbox", "restore_config", "restore_database", "restore_audit_mirror", "run_mailbox_doctor"],
      writerFence: "required_row_schema_version",
    }, null, 2)}\n`);
    fs.renameSync(partial, target);
    return target;
  } catch (error) {
    fs.rmSync(partial, { recursive: true, force: true });
    throw error;
  }
}

function appendMigrationEvent(database: DatabaseSync, preflight: MigrationPreflight, migrationSqlSha256: string): void {
  const prior = preflight.events.at(-1);
  const sequence = Number(prior?.sequence ?? 0) + 1;
  const eventId = newId("mailbox.event");
  const occurredAt = new Date().toISOString();
  const previousHash = prior?.event_hash ?? null;
  const payload = {
    migrationId: MIGRATION_ID,
    fromSchemaVersion: MAILBOX_PREVIOUS_SCHEMA_VERSION,
    toSchemaVersion: MAILBOX_SCHEMA_VERSION,
    activeProvider: "web",
    webNodeProfileVersion: "bridge-web-node-v1",
    migrationSqlSha256,
    rollback: "restore_before_v3_work_only",
    rollbackWindow: "migration_command_only_before_any_v3_work",
    writerFence: "required_row_schema_version",
  };
  const eventHash = hashCanonical({ sequence, eventId, eventType: "mailbox.schema_migrated", messageId: null, occurredAt, payload, previousHash });
  database.prepare(
    `INSERT INTO mailbox_events(sequence, event_id, event_type, message_id, occurred_at, payload_json, previous_hash, event_hash, file_appended)
     VALUES (?, ?, 'mailbox.schema_migrated', NULL, ?, ?, ?, ?, 0)`,
  ).run(sequence, eventId, occurredAt, canonicalize(payload), previousHash, eventHash);
}

function flushMigrationEvent(database: DatabaseSync, auditMirrorPath: string): void {
  database.exec("BEGIN IMMEDIATE");
  try {
    const rows = database.prepare("SELECT * FROM mailbox_events ORDER BY sequence").all() as unknown as EventRow[];
    verifyEvents(rows, false);
    const pending = rows.filter((row) => Number(row.file_appended) === 0);
    invariant(pending.length === 1 && pending[0].event_type === "mailbox.schema_migrated", "mailbox_audit_pending_event_invalid");
    verifyAudit(auditMirrorPath, rows.slice(0, -1));
    fs.appendFileSync(auditMirrorPath, `${canonicalize(eventEnvelope(pending[0]))}\n`, { encoding: "utf8", flag: "a", mode: 0o600 });
    database.prepare("UPDATE mailbox_events SET file_appended = 1 WHERE sequence = ?").run(pending[0].sequence);
    database.exec("COMMIT");
  } catch (error) {
    try { database.exec("ROLLBACK"); } catch {}
    throw error;
  }
}

function verifyResult(database: DatabaseSync, config: MailboxV2Config, preflight: MigrationPreflight): void {
  invariant(number(database, "PRAGMA user_version", "user_version") === 3, "mailbox_migration_version_failed");
  const schema = database.prepare("SELECT value FROM mailbox_metadata WHERE key = 'schema_version'").get() as { value?: string } | undefined;
  invariant(schema?.value === MAILBOX_SCHEMA_VERSION, "mailbox_migration_schema_failed");
  assertPreserved(database, preflight);
  const events = database.prepare("SELECT * FROM mailbox_events ORDER BY sequence").all() as unknown as EventRow[];
  invariant(events.length === preflight.events.length + 1, "mailbox_migration_event_count_mismatch");
  verifyEvents(events, true);
  verifyAudit(config.auditMirrorPath, events);
  invariant(text(database, "PRAGMA integrity_check", "integrity_check") === "ok", "mailbox_migration_integrity_failed");
  invariant(database.prepare("PRAGMA foreign_key_check").all().length === 0, "mailbox_migration_foreign_key_failed");
  const messagesSql = text(database, "SELECT sql FROM sqlite_master WHERE type = 'table' AND name = 'mailbox_messages'", "sql");
  invariant(messagesSql.includes("'web'") && messagesSql.includes("'bridge-mailbox-v3'"), "mailbox_migration_web_provider_missing");
}

function assertPreserved(database: DatabaseSync, preflight: MigrationPreflight): void {
  invariant(count(database, "SELECT COUNT(*) AS count FROM mailbox_messages") === preflight.messages, "mailbox_migration_message_count_mismatch");
  invariant(count(database, "SELECT COUNT(*) AS count FROM mailbox_deliveries") === preflight.deliveries, "mailbox_migration_delivery_count_mismatch");
  invariant(count(database, "SELECT COUNT(*) AS count FROM mailbox_idempotency") === preflight.idempotency, "mailbox_migration_idempotency_count_mismatch");
  invariant(tableDigest(database, "SELECT * FROM mailbox_messages ORDER BY message_id") === preflight.messagesSha256, "mailbox_migration_message_content_mismatch");
  invariant(tableDigest(database, "SELECT * FROM mailbox_deliveries ORDER BY delivery_id") === preflight.deliveriesSha256, "mailbox_migration_delivery_content_mismatch");
  invariant(tableDigest(database, "SELECT * FROM mailbox_idempotency ORDER BY principal_id, operation, idempotency_key") === preflight.idempotencySha256, "mailbox_migration_idempotency_content_mismatch");
}

function assertAutomaticRestoreSafe(database: DatabaseSync, preflight: MigrationPreflight): void {
  assertPreserved(database, preflight);
  const events = database.prepare("SELECT * FROM mailbox_events ORDER BY sequence").all() as unknown as EventRow[];
  invariant(events.length === preflight.events.length + 1, "mailbox_migration_rollback_v3_work_detected");
  invariant(events.at(-1)?.event_type === "mailbox.schema_migrated", "mailbox_migration_rollback_v3_work_detected");
}

function activeConfig(config: MailboxV2Config): MailboxConfig {
  return {
    ...config,
    schemaVersion: MAILBOX_CONFIG_VERSION,
    providers: {
      ...config.providers,
      web: { enabled: true, consumerId: "provider.web.chrome" },
    },
    webNodes: defaultWebNodeProfiles(),
    integrations: {
      ...config.integrations,
      webBrowserProfileDirectory: path.join(config.stateDirectory, "web-browser-profile"),
    },
  };
}

async function restoreBackup(backupDirectory: string, configPath: string, config: MailboxV2Config): Promise<void> {
  fs.copyFileSync(path.join(backupDirectory, "config.json"), configPath);
  const source = new DatabaseSync(path.join(backupDirectory, "mailbox.sqlite"), { readOnly: true });
  try {
    await backup(source, config.databasePath);
  } finally {
    source.close();
  }
  const restored = new DatabaseSync(config.databasePath);
  try {
    restored.exec("PRAGMA wal_checkpoint(TRUNCATE)");
  } finally {
    restored.close();
  }
  fs.copyFileSync(path.join(backupDirectory, "mailbox-audit.jsonl"), config.auditMirrorPath);
}

function verifyEvents(rows: EventRow[], requireAppended: boolean): void {
  let previousHash: string | null = null;
  for (let index = 0; index < rows.length; index += 1) {
    const row = rows[index];
    invariant(Number(row.sequence) === index + 1 && row.previous_hash === previousHash, "mailbox_event_previous_hash_mismatch");
    invariant(row.event_hash === hashCanonical({
      sequence: Number(row.sequence),
      eventId: row.event_id,
      eventType: row.event_type,
      messageId: row.message_id,
      occurredAt: row.occurred_at,
      payload: JSON.parse(row.payload_json) as Record<string, unknown>,
      previousHash: row.previous_hash,
    }), "mailbox_event_hash_mismatch");
    if (requireAppended) invariant(Number(row.file_appended) === 1, "mailbox_event_audit_projection_pending");
    previousHash = row.event_hash;
  }
}

function verifyAudit(filePath: string, rows: EventRow[]): void {
  const textValue = fs.readFileSync(filePath, "utf8");
  invariant(textValue === "" || textValue.endsWith("\n"), "mailbox_audit_chain_mismatch");
  const lines = textValue.trimEnd() ? textValue.trimEnd().split("\n") : [];
  invariant(lines.length === rows.length, "mailbox_audit_database_mismatch");
  for (let index = 0; index < rows.length; index += 1) {
    invariant(canonicalize(JSON.parse(lines[index])) === canonicalize(eventEnvelope(rows[index])), "mailbox_audit_database_mismatch");
  }
}

function eventEnvelope(row: EventRow): Record<string, unknown> {
  return {
    sequence: Number(row.sequence),
    eventId: row.event_id,
    eventType: row.event_type,
    messageId: row.message_id,
    occurredAt: row.occurred_at,
    payload: JSON.parse(row.payload_json) as Record<string, unknown>,
    previousHash: row.previous_hash,
    eventHash: row.event_hash,
  };
}

function tableDigest(database: DatabaseSync, sql: string): string {
  return hashCanonical(database.prepare(sql).all());
}

function count(database: DatabaseSync, sql: string): number {
  return Number((database.prepare(sql).get() as { count: number }).count);
}

function number(database: DatabaseSync, sql: string, field: string): number {
  return Number((database.prepare(sql).get() as Record<string, unknown>)[field]);
}

function text(database: DatabaseSync, sql: string, field: string): string {
  return String((database.prepare(sql).get() as Record<string, unknown>)[field]);
}

function sameOrChild(candidate: string, parent: string): boolean {
  const relative = path.relative(path.resolve(parent), path.resolve(candidate));
  return relative === "" || (!relative.startsWith("..") && !path.isAbsolute(relative));
}

function assertDirectory(directory: string, code: string): void {
  const stat = fs.lstatSync(directory);
  invariant(stat.isDirectory() && !stat.isSymbolicLink(), code);
}

function writeExclusive(filePath: string, textValue: string): void {
  const handle = fs.openSync(filePath, "wx", 0o600);
  try {
    fs.writeFileSync(handle, textValue, "utf8");
    fs.fsyncSync(handle);
  } finally {
    fs.closeSync(handle);
  }
}

function errorCode(error: unknown): string {
  return error instanceof Error ? error.message.replace(/[^A-Za-z0-9._:-]/gu, "_").slice(0, 200) : "unknown_error";
}
