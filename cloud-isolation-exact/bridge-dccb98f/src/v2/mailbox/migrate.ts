import crypto from "node:crypto";
import fs from "node:fs";
import path from "node:path";
import { backup, DatabaseSync } from "node:sqlite";
import { fileURLToPath } from "node:url";
import { canonicalize, hashCanonical, sha256 } from "../core/canonical.js";
import { invariant } from "../core/errors.js";
import { newId } from "../core/ids.js";
import { assertContainedPathWithoutReparse, writeJsonAtomic } from "./config.js";
import {
  MAILBOX_LEGACY_CONFIG_VERSION,
  MAILBOX_LEGACY_SCHEMA_VERSION,
  MAILBOX_PREVIOUS_CONFIG_VERSION,
  MAILBOX_PREVIOUS_SCHEMA_VERSION,
  type MailboxConfig,
  type MailboxProviderConfig,
} from "./types.js";

const MIGRATION_ID = "mailbox-002-antigravity-provider";

interface LegacyMailboxConfig {
  schemaVersion: typeof MAILBOX_LEGACY_CONFIG_VERSION;
  stateDirectory: string;
  databasePath: string;
  auditMirrorPath: string;
  exchangeRoot: string;
  broker: MailboxConfig["broker"];
  providers: {
    chatgpt: MailboxProviderConfig;
    gemini: MailboxProviderConfig;
  };
  delivery: MailboxConfig["delivery"];
  integrations: {
    chromeExtensionDirectory: string;
    geminiExtensionDirectory: string;
  };
}

interface MigratedMailboxV2Config {
  schemaVersion: typeof MAILBOX_PREVIOUS_CONFIG_VERSION;
  stateDirectory: string;
  databasePath: string;
  auditMirrorPath: string;
  exchangeRoot: string;
  broker: MailboxConfig["broker"];
  providers: {
    chatgpt: MailboxProviderConfig;
    antigravity: MailboxProviderConfig;
  };
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
  legacyGeminiMessages: number;
}

export interface MailboxMigrationResult {
  migrationId: typeof MIGRATION_ID;
  fromVersion: 1;
  toVersion: 2;
  legacyGeminiMessages: number;
  backupDirectory: string;
  rollback: "restore_before_v2_work_only";
}

export async function migrateMailboxV1ToV2(configPath: string): Promise<MailboxMigrationResult> {
  const resolvedConfigPath = path.resolve(configPath);
  const legacy = readLegacyConfig(resolvedConfigPath);
  const migrationSqlPath = fileURLToPath(new URL("../../../migrations/mailbox/002_antigravity_provider.sql", import.meta.url));
  const migrationSql = fs.readFileSync(migrationSqlPath, "utf8");
  const migrationSqlSha256 = sha256(Buffer.from(migrationSql, "utf8"));
  let database: DatabaseSync | undefined;
  let backupDirectory: string | undefined;
  let restoreBaseline: MigrationPreflight | undefined;
  let committed = false;

  try {
    database = new DatabaseSync(legacy.databasePath);
    database.exec("PRAGMA foreign_keys = ON");
    database.exec("PRAGMA busy_timeout = 10000");
    database.exec("PRAGMA trusted_schema = OFF");
    database.exec("PRAGMA locking_mode = EXCLUSIVE");
    database.exec("BEGIN EXCLUSIVE");
    let preflight: MigrationPreflight;
    try {
      preflight = verifyV1Preflight(database, legacy);
      restoreBaseline = preflight;
      database.exec("COMMIT");
    } catch (error) {
      try { database.exec("ROLLBACK"); } catch {}
      throw error;
    }

    backupDirectory = await createRestoreBackup(
      database,
      resolvedConfigPath,
      legacy,
      preflight,
      migrationSqlSha256,
    );

    database.exec("BEGIN IMMEDIATE");
    try {
      database.exec(migrationSql);
      assertPreservedCounts(database, preflight);
      appendMigrationEvent(database, preflight, migrationSqlSha256);
      database.exec("COMMIT");
      committed = true;
    } catch (error) {
      try { database.exec("ROLLBACK"); } catch {}
      throw error;
    }

    flushPendingAuditEvent(database, legacy.auditMirrorPath);
    verifyV2Result(database, legacy, preflight);
    writeJsonAtomic(resolvedConfigPath, activeConfig(legacy), true);
    validateMigratedV2Config(resolvedConfigPath);

    return {
      migrationId: MIGRATION_ID,
      fromVersion: 1,
      toVersion: 2,
      legacyGeminiMessages: preflight.legacyGeminiMessages,
      backupDirectory,
      rollback: "restore_before_v2_work_only",
    };
  } catch (error) {
    if (committed && backupDirectory) {
      try {
        invariant(database && restoreBaseline, "mailbox_migration_rollback_baseline_missing");
        assertAutomaticRestoreSafe(database, restoreBaseline);
        database?.close();
        database = undefined;
        await restoreBackup(backupDirectory, resolvedConfigPath, legacy);
      } catch (rollbackError) {
        throw new Error(
          `mailbox_migration_rollback_failed:${errorCode(error)}:${errorCode(rollbackError)}`,
        );
      }
    }
    throw error;
  } finally {
    database?.close();
  }
}

function validateMigratedV2Config(configPath: string): void {
  const parsed = JSON.parse(fs.readFileSync(configPath, "utf8")) as MigratedMailboxV2Config;
  invariant(parsed.schemaVersion === MAILBOX_PREVIOUS_CONFIG_VERSION, "mailbox_migration_config_write_failed");
  invariant(
    Array.isArray(parsed.broker.allowedOrigins) &&
    parsed.broker.allowedOrigins.every((origin) => /^https:\/\/[A-Za-z0-9.-]+$/u.test(origin)),
    "mailbox_allowed_origin_invalid",
  );
  invariant(parsed.providers?.chatgpt && parsed.providers?.antigravity, "mailbox_migration_provider_config_invalid");
}

function readLegacyConfig(configPath: string): LegacyMailboxConfig {
  const stat = fs.lstatSync(configPath);
  invariant(stat.isFile() && !stat.isSymbolicLink(), "mailbox_migration_config_invalid");
  const parsed = JSON.parse(fs.readFileSync(configPath, "utf8")) as LegacyMailboxConfig;
  invariant(parsed?.schemaVersion === MAILBOX_LEGACY_CONFIG_VERSION, "mailbox_migration_v1_config_required");
  for (const [field, value] of Object.entries({
    stateDirectory: parsed.stateDirectory,
    databasePath: parsed.databasePath,
    auditMirrorPath: parsed.auditMirrorPath,
    exchangeRoot: parsed.exchangeRoot,
    tokenFile: parsed.broker?.tokenFile,
    chromeExtensionDirectory: parsed.integrations?.chromeExtensionDirectory,
    geminiExtensionDirectory: parsed.integrations?.geminiExtensionDirectory,
  })) invariant(typeof value === "string" && path.isAbsolute(value), "mailbox_migration_config_path_invalid", { field });
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
  invariant(parsed.providers?.chatgpt && parsed.providers?.gemini, "mailbox_migration_provider_config_invalid");
  return parsed;
}

function verifyV1Preflight(database: DatabaseSync, config: LegacyMailboxConfig): MigrationPreflight {
  const userVersion = Number((database.prepare("PRAGMA user_version").get() as { user_version: number }).user_version);
  invariant(userVersion === 1, "mailbox_migration_v1_database_required");
  const schema = database.prepare("SELECT value FROM mailbox_metadata WHERE key = 'schema_version'").get() as { value?: string } | undefined;
  invariant(schema?.value === MAILBOX_LEGACY_SCHEMA_VERSION, "mailbox_migration_v1_schema_required");
  invariant((database.prepare("PRAGMA integrity_check").get() as { integrity_check?: string }).integrity_check === "ok", "mailbox_migration_integrity_failed");
  invariant((database.prepare("PRAGMA foreign_key_check").all() as unknown[]).length === 0, "mailbox_migration_foreign_key_failed");

  const legacyGeminiNonterminal = count(database,
    `SELECT COUNT(*) AS count FROM mailbox_messages
     WHERE provider = 'gemini' AND status NOT IN ('completed','failed','uncertain','expired')`);
  const legacyGeminiActive = count(database,
    `SELECT COUNT(*) AS count FROM mailbox_deliveries
     WHERE provider = 'gemini' AND status IN ('claimed','dispatching','sent')`);
  invariant(legacyGeminiNonterminal === 0 && legacyGeminiActive === 0, "mailbox_legacy_gemini_nonterminal");
  const anyNonterminal = count(database,
    `SELECT COUNT(*) AS count FROM mailbox_messages
     WHERE status NOT IN ('completed','failed','uncertain','expired')`);
  const anyActive = count(database,
    `SELECT COUNT(*) AS count FROM mailbox_deliveries
     WHERE status IN ('claimed','dispatching','sent')`);
  invariant(anyNonterminal === 0 && anyActive === 0, "mailbox_legacy_nonterminal");

  const events = database.prepare("SELECT * FROM mailbox_events ORDER BY sequence").all() as unknown as EventRow[];
  verifyEventRows(events, true);
  verifyAuditMirror(config.auditMirrorPath, events);
  verifyLegacyExchange(database, config.exchangeRoot);
  return {
    messages: count(database, "SELECT COUNT(*) AS count FROM mailbox_messages"),
    deliveries: count(database, "SELECT COUNT(*) AS count FROM mailbox_deliveries"),
    idempotency: count(database, "SELECT COUNT(*) AS count FROM mailbox_idempotency"),
    messagesSha256: tableDigest(database, "SELECT * FROM mailbox_messages ORDER BY message_id"),
    deliveriesSha256: tableDigest(database, "SELECT * FROM mailbox_deliveries ORDER BY delivery_id"),
    idempotencySha256: tableDigest(database, "SELECT * FROM mailbox_idempotency ORDER BY principal_id, operation, idempotency_key"),
    events,
    legacyGeminiMessages: count(database, "SELECT COUNT(*) AS count FROM mailbox_messages WHERE provider = 'gemini'"),
  };
}

async function createRestoreBackup(
  database: DatabaseSync,
  configPath: string,
  config: LegacyMailboxConfig,
  preflight: MigrationPreflight,
  migrationSqlSha256: string,
): Promise<string> {
  const root = path.join(config.stateDirectory, "migrations");
  assertDirectory(config.stateDirectory, "mailbox_migration_state_directory_invalid");
  assertContainedPathWithoutReparse(root, config.stateDirectory, "mailbox_migration_backup_reparse_forbidden");
  fs.mkdirSync(root, { recursive: true, mode: 0o700 });
  assertDirectory(root, "mailbox_migration_backup_directory_invalid");
  assertContainedPathWithoutReparse(root, config.stateDirectory, "mailbox_migration_backup_reparse_forbidden");
  const stamp = new Date().toISOString().replace(/[:.]/gu, "-");
  const name = `${MIGRATION_ID}-${stamp}-${crypto.randomUUID()}`;
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
      invariant((snapshot.prepare("PRAGMA integrity_check").get() as { integrity_check?: string }).integrity_check === "ok", "mailbox_migration_backup_integrity_failed");
      invariant(count(snapshot, "SELECT COUNT(*) AS count FROM mailbox_events") === preflight.events.length, "mailbox_migration_backup_event_count_mismatch");
    } finally {
      snapshot.close();
    }
    const manifestFiles = Object.fromEntries(Object.entries(files).map(([fileName, filePath]) => {
      const bytes = fs.readFileSync(filePath);
      return [fileName, { sha256: sha256(bytes), byteLength: bytes.length }];
    }));
    const manifest = {
      schemaVersion: "bridge-mailbox-migration-backup-v1",
      migrationId: MIGRATION_ID,
      createdAt: new Date().toISOString(),
      fromSchemaVersion: MAILBOX_LEGACY_SCHEMA_VERSION,
      toSchemaVersion: MAILBOX_PREVIOUS_SCHEMA_VERSION,
      migrationSqlSha256,
      legacyGeminiMessages: preflight.legacyGeminiMessages,
      files: manifestFiles,
      rollback: "restore_before_v2_work_only",
      rollbackWindow: "migration_command_only_before_any_v2_work",
      restoreOrder: ["stop_mailbox", "restore_config", "restore_database", "restore_audit_mirror", "run_mailbox_doctor"],
      writerFence: "required_row_schema_version",
    };
    writeExclusive(path.join(partial, "manifest.json"), `${JSON.stringify(manifest, null, 2)}\n`);
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
    fromSchemaVersion: MAILBOX_LEGACY_SCHEMA_VERSION,
    toSchemaVersion: MAILBOX_PREVIOUS_SCHEMA_VERSION,
    retiredProvider: "gemini",
    activeProvider: "antigravity",
    legacyGeminiMessages: preflight.legacyGeminiMessages,
    migrationSqlSha256,
    rollback: "restore_before_v2_work_only",
    rollbackWindow: "migration_command_only_before_any_v2_work",
    writerFence: "required_row_schema_version",
  };
  const eventHash = hashCanonical({ sequence, eventId, eventType: "mailbox.schema_migrated", messageId: null, occurredAt, payload, previousHash });
  database.prepare(
    `INSERT INTO mailbox_events(sequence, event_id, event_type, message_id, occurred_at, payload_json, previous_hash, event_hash, file_appended)
     VALUES (?, ?, 'mailbox.schema_migrated', NULL, ?, ?, ?, ?, 0)`,
  ).run(sequence, eventId, occurredAt, canonicalize(payload), previousHash, eventHash);
}

function flushPendingAuditEvent(database: DatabaseSync, auditMirrorPath: string): void {
  database.exec("BEGIN IMMEDIATE");
  try {
    const rows = database.prepare("SELECT * FROM mailbox_events ORDER BY sequence").all() as unknown as EventRow[];
    verifyEventRows(rows, false);
    const pending = rows.filter((row) => Number(row.file_appended) === 0);
    invariant(pending.length === 1 && pending[0].event_type === "mailbox.schema_migrated", "mailbox_audit_pending_event_invalid");
    verifyAuditMirror(auditMirrorPath, rows.slice(0, -1));
    fs.appendFileSync(auditMirrorPath, `${canonicalize(eventEnvelope(pending[0]))}\n`, { encoding: "utf8", flag: "a", mode: 0o600 });
    database.prepare("UPDATE mailbox_events SET file_appended = 1 WHERE sequence = ?").run(pending[0].sequence);
    database.exec("COMMIT");
  } catch (error) {
    try { database.exec("ROLLBACK"); } catch {}
    throw error;
  }
}

function verifyV2Result(database: DatabaseSync, config: LegacyMailboxConfig, preflight: MigrationPreflight): void {
  invariant(Number((database.prepare("PRAGMA user_version").get() as { user_version: number }).user_version) === 2, "mailbox_migration_version_failed");
  const schema = database.prepare("SELECT value FROM mailbox_metadata WHERE key = 'schema_version'").get() as { value?: string } | undefined;
  invariant(schema?.value === MAILBOX_PREVIOUS_SCHEMA_VERSION, "mailbox_migration_schema_failed");
  assertPreservedCounts(database, preflight);
  const events = database.prepare("SELECT * FROM mailbox_events ORDER BY sequence").all() as unknown as EventRow[];
  invariant(events.length === preflight.events.length + 1, "mailbox_migration_event_count_mismatch");
  verifyEventRows(events, true);
  verifyAuditMirror(config.auditMirrorPath, events);
  verifyLegacyExchange(database, config.exchangeRoot);
  invariant((database.prepare("PRAGMA integrity_check").get() as { integrity_check?: string }).integrity_check === "ok", "mailbox_migration_integrity_failed");
  invariant((database.prepare("PRAGMA foreign_key_check").all() as unknown[]).length === 0, "mailbox_migration_foreign_key_failed");
}

function assertPreservedCounts(database: DatabaseSync, preflight: MigrationPreflight): void {
  invariant(count(database, "SELECT COUNT(*) AS count FROM mailbox_messages") === preflight.messages, "mailbox_migration_message_count_mismatch");
  invariant(count(database, "SELECT COUNT(*) AS count FROM mailbox_deliveries") === preflight.deliveries, "mailbox_migration_delivery_count_mismatch");
  invariant(count(database, "SELECT COUNT(*) AS count FROM mailbox_idempotency") === preflight.idempotency, "mailbox_migration_idempotency_count_mismatch");
  invariant(count(database, "SELECT COUNT(*) AS count FROM mailbox_messages WHERE schema_version = 'bridge-mailbox-v1'") === preflight.messages, "mailbox_migration_message_schema_generation_mismatch");
  invariant(count(database, "SELECT COUNT(*) AS count FROM mailbox_deliveries WHERE schema_version = 'bridge-mailbox-v1'") === preflight.deliveries, "mailbox_migration_delivery_schema_generation_mismatch");
  invariant(tableDigest(database, "SELECT * FROM mailbox_messages ORDER BY message_id", true) === preflight.messagesSha256, "mailbox_migration_message_content_mismatch");
  invariant(tableDigest(database, "SELECT * FROM mailbox_deliveries ORDER BY delivery_id", true) === preflight.deliveriesSha256, "mailbox_migration_delivery_content_mismatch");
  invariant(tableDigest(database, "SELECT * FROM mailbox_idempotency ORDER BY principal_id, operation, idempotency_key") === preflight.idempotencySha256, "mailbox_migration_idempotency_content_mismatch");
  invariant(count(database, "SELECT COUNT(*) AS count FROM mailbox_messages WHERE provider = 'gemini'") === preflight.legacyGeminiMessages, "mailbox_migration_legacy_provider_count_mismatch");
}

function assertAutomaticRestoreSafe(database: DatabaseSync, preflight: MigrationPreflight): void {
  assertPreservedCounts(database, preflight);
  const events = database.prepare("SELECT * FROM mailbox_events ORDER BY sequence").all() as unknown as EventRow[];
  invariant(events.length === preflight.events.length + 1, "mailbox_migration_rollback_v2_work_detected");
  invariant(events.at(-1)?.event_type === "mailbox.schema_migrated", "mailbox_migration_rollback_v2_work_detected");
}

function verifyLegacyExchange(database: DatabaseSync, exchangeRoot: string): void {
  const messages = database.prepare(
    `SELECT message_id, provider, status, prompt_sha256, envelope_sha256,
            envelope_relative_path, ready_relative_path
     FROM mailbox_messages ORDER BY message_id`,
  ).all() as unknown as Array<Record<string, string | null>>;
  for (const message of messages) {
    if (!message.envelope_relative_path) {
      invariant(!message.envelope_sha256 && !message.ready_relative_path, "mailbox_legacy_message_artifact_incomplete");
      continue;
    }
    invariant(message.envelope_sha256 && message.ready_relative_path, "mailbox_legacy_message_artifact_incomplete");
    const value = verifyExchangeObject(
      exchangeRoot,
      message.envelope_relative_path,
      message.ready_relative_path,
      message.envelope_sha256,
      "message",
      message.message_id!,
    );
    invariant(value.schemaVersion === MAILBOX_LEGACY_SCHEMA_VERSION && value.recipient === message.provider, "mailbox_legacy_message_binding_invalid");
    invariant(value.promptSha256 === message.prompt_sha256 && value.promptSha256 === sha256(Buffer.from(String(value.prompt), "utf8")), "mailbox_legacy_message_hash_invalid");
  }

  const deliveries = database.prepare(
    `SELECT delivery_id, message_id, provider, response_id, response_content_sha256,
            response_sha256, response_relative_path
     FROM mailbox_deliveries ORDER BY delivery_id`,
  ).all() as unknown as Array<Record<string, string | null>>;
  for (const delivery of deliveries) {
    if (!delivery.response_relative_path) {
      invariant(!delivery.response_sha256 && !delivery.response_id, "mailbox_legacy_response_artifact_incomplete");
      continue;
    }
    invariant(delivery.response_sha256 && delivery.response_id && delivery.response_content_sha256, "mailbox_legacy_response_artifact_incomplete");
    const readyRelativePath = delivery.response_relative_path.replace(/\.json$/u, ".ready.json");
    const value = verifyExchangeObject(
      exchangeRoot,
      delivery.response_relative_path,
      readyRelativePath,
      delivery.response_sha256,
      "response",
      delivery.response_id,
    );
    invariant(
      value.schemaVersion === MAILBOX_LEGACY_SCHEMA_VERSION &&
      value.messageId === delivery.message_id &&
      value.deliveryId === delivery.delivery_id &&
      value.provider === delivery.provider,
      "mailbox_legacy_response_binding_invalid",
    );
    invariant(value.responseSha256 === delivery.response_content_sha256 && value.responseSha256 === sha256(Buffer.from(String(value.response), "utf8")), "mailbox_legacy_response_hash_invalid");
  }
}

function verifyExchangeObject(
  exchangeRoot: string,
  relativePath: string,
  readyRelativePath: string,
  expectedSha256: string,
  objectKind: "message" | "response",
  objectId: string,
): Record<string, unknown> {
  invariant(relativePath.startsWith("v1/") && readyRelativePath.startsWith("v1/"), "mailbox_legacy_exchange_version_invalid");
  const objectPath = resolveRelative(exchangeRoot, relativePath);
  const markerPath = resolveRelative(exchangeRoot, readyRelativePath);
  const bytes = fs.readFileSync(objectPath);
  invariant(sha256(bytes) === expectedSha256, "mailbox_legacy_exchange_hash_mismatch");
  const marker = JSON.parse(fs.readFileSync(markerPath, "utf8")) as Record<string, unknown>;
  invariant(
    marker.schemaVersion === MAILBOX_LEGACY_SCHEMA_VERSION &&
    marker.kind === "ready" && marker.objectKind === objectKind && marker.objectId === objectId &&
    marker.sha256 === expectedSha256 && Number(marker.byteLength) === bytes.length,
    "mailbox_legacy_ready_marker_invalid",
  );
  return JSON.parse(bytes.toString("utf8")) as Record<string, unknown>;
}

function verifyEventRows(rows: EventRow[], requireAppended: boolean): void {
  let previousHash: string | null = null;
  for (let index = 0; index < rows.length; index += 1) {
    const row = rows[index];
    invariant(Number(row.sequence) === index + 1 && row.previous_hash === previousHash, "mailbox_event_previous_hash_mismatch");
    invariant(row.event_hash === hashCanonical(eventForHash(row)), "mailbox_event_hash_mismatch");
    if (requireAppended) invariant(Number(row.file_appended) === 1, "mailbox_event_audit_projection_pending");
    previousHash = row.event_hash;
  }
}

function verifyAuditMirror(auditMirrorPath: string, rows: EventRow[]): void {
  const text = fs.readFileSync(auditMirrorPath, "utf8");
  invariant(text === "" || text.endsWith("\n"), "mailbox_audit_chain_mismatch");
  const lines = text.trimEnd() ? text.trimEnd().split("\n") : [];
  invariant(lines.length === rows.length, "mailbox_audit_database_mismatch");
  for (let index = 0; index < rows.length; index += 1) {
    let parsed: unknown;
    try { parsed = JSON.parse(lines[index]); }
    catch { throw new Error("mailbox_audit_json_invalid"); }
    invariant(canonicalize(parsed) === canonicalize(eventEnvelope(rows[index])), "mailbox_audit_database_mismatch");
  }
}

function activeConfig(legacy: LegacyMailboxConfig): MigratedMailboxV2Config {
  return {
    schemaVersion: MAILBOX_PREVIOUS_CONFIG_VERSION,
    stateDirectory: legacy.stateDirectory,
    databasePath: legacy.databasePath,
    auditMirrorPath: legacy.auditMirrorPath,
    exchangeRoot: legacy.exchangeRoot,
    broker: {
      ...legacy.broker,
      allowedOrigins: legacy.broker.allowedOrigins.filter((origin) => origin !== "https://gemini.google.com"),
    },
    providers: {
      chatgpt: legacy.providers.chatgpt,
      antigravity: { enabled: legacy.providers.gemini.enabled, consumerId: "provider.antigravity.mcp" },
    },
    delivery: legacy.delivery,
    integrations: {
      chromeExtensionDirectory: legacy.integrations.chromeExtensionDirectory,
      antigravityPluginDirectory: path.join(legacy.stateDirectory, "antigravity-plugin"),
    },
  };
}

async function restoreBackup(backupDirectory: string, configPath: string, config: LegacyMailboxConfig): Promise<void> {
  fs.copyFileSync(path.join(backupDirectory, "config.json"), configPath);
  const source = new DatabaseSync(path.join(backupDirectory, "mailbox.sqlite"), { readOnly: true });
  try { await backup(source, config.databasePath); }
  finally { source.close(); }
  const restored = new DatabaseSync(config.databasePath);
  try { restored.exec("PRAGMA wal_checkpoint(TRUNCATE)"); }
  finally { restored.close(); }
  fs.copyFileSync(path.join(backupDirectory, "mailbox-audit.jsonl"), config.auditMirrorPath);
}

function eventForHash(row: EventRow): Record<string, unknown> {
  return {
    sequence: Number(row.sequence),
    eventId: row.event_id,
    eventType: row.event_type,
    messageId: row.message_id,
    occurredAt: row.occurred_at,
    payload: JSON.parse(row.payload_json) as Record<string, unknown>,
    previousHash: row.previous_hash,
  };
}

function eventEnvelope(row: EventRow): Record<string, unknown> {
  return { ...eventForHash(row), eventHash: row.event_hash };
}

function count(database: DatabaseSync, sql: string): number {
  return Number((database.prepare(sql).get() as { count?: number }).count ?? 0);
}

function tableDigest(database: DatabaseSync, sql: string, stripSchemaVersion = false): string {
  const rows = database.prepare(sql).all() as unknown as Array<Record<string, unknown>>;
  const normalized = stripSchemaVersion
    ? rows.map(({ schema_version: _schemaVersion, ...row }) => row)
    : rows;
  return sha256(Buffer.from(canonicalize(normalized), "utf8"));
}

function resolveRelative(root: string, relativePath: string): string {
  invariant(typeof relativePath === "string" && relativePath.length > 0 && !path.isAbsolute(relativePath), "mailbox_relative_path_invalid");
  const resolved = path.resolve(root, relativePath);
  invariant(sameOrChild(resolved, root) && path.resolve(resolved) !== path.resolve(root), "mailbox_exchange_path_escape");
  const stat = fs.lstatSync(resolved);
  invariant(stat.isFile() && !stat.isSymbolicLink(), "mailbox_legacy_exchange_file_invalid");
  return resolved;
}

function assertDirectory(directory: string, code: string): void {
  const stat = fs.lstatSync(directory);
  invariant(stat.isDirectory() && !stat.isSymbolicLink(), code);
  invariant(sameFilesystemPath(fs.realpathSync.native(directory), directory), code, { directory });
}

function sameOrChild(candidate: string, parent: string): boolean {
  const relative = path.relative(path.resolve(parent), path.resolve(candidate));
  return relative === "" || (!relative.startsWith("..") && !path.isAbsolute(relative));
}

function sameFilesystemPath(left: string, right: string): boolean {
  const a = path.resolve(left);
  const b = path.resolve(right);
  return process.platform === "win32" ? a.toLowerCase() === b.toLowerCase() : a === b;
}

function writeExclusive(filePath: string, text: string): void {
  const handle = fs.openSync(filePath, "wx", 0o600);
  try {
    fs.writeFileSync(handle, text, "utf8");
    fs.fsyncSync(handle);
  } finally {
    fs.closeSync(handle);
  }
}

function errorCode(error: unknown): string {
  return (error instanceof Error ? error.message : String(error)).replace(/[^A-Za-z0-9._:-]/gu, "_").slice(0, 180);
}
