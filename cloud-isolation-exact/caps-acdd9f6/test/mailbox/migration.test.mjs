import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { DatabaseSync } from "node:sqlite";
import { canonicalize, hashCanonical, sha256 } from "../../dist/v2/core/canonical.js";
import { loadMailboxConfig } from "../../dist/v2/mailbox/config.js";
import { migrateMailboxV1ToV2 } from "../../dist/v2/mailbox/migrate.js";
import { migrateMailboxV2ToV3 } from "../../dist/v2/mailbox/migrate-web.js";
import { MailboxService } from "../../dist/v2/mailbox/service.js";

test("mailbox v1 migration preserves completed Gemini history and extends the hash chain", async () => {
  const fixture = legacyFixture("completed");
  const before = snapshot(fixture);
  try {
    assert.throws(() => loadMailboxConfig(fixture.configPath), /mailbox_config_migration_required/u);
    const migration = await migrateMailboxV1ToV2(fixture.configPath);
    assert.equal(migration.fromVersion, 1);
    assert.equal(migration.toVersion, 2);
    assert.equal(migration.rollback, "restore_before_v2_work_only");
    assert.equal(migration.legacyGeminiMessages, 1);
    assert.ok(fs.statSync(migration.backupDirectory).isDirectory());
    for (const name of ["config.json", "mailbox.sqlite", "mailbox-audit.jsonl", "manifest.json"]) {
      assert.ok(fs.statSync(path.join(migration.backupDirectory, name)).isFile(), `${name} backup missing`);
    }
    const manifest = JSON.parse(fs.readFileSync(path.join(migration.backupDirectory, "manifest.json"), "utf8"));
    assert.equal(manifest.migrationId, "mailbox-002-antigravity-provider");
    assert.equal(manifest.rollback, "restore_before_v2_work_only");
    assert.equal(manifest.rollbackWindow, "migration_command_only_before_any_v2_work");
    assert.equal(manifest.writerFence, "required_row_schema_version");
    for (const name of ["config.json", "mailbox.sqlite", "mailbox-audit.jsonl"]) {
      const bytes = fs.readFileSync(path.join(migration.backupDirectory, name));
      assert.equal(manifest.files[name].sha256, sha256(bytes), `${name} backup digest mismatch`);
      assert.equal(manifest.files[name].byteLength, bytes.length, `${name} backup size mismatch`);
    }
    const backupDatabase = new DatabaseSync(path.join(migration.backupDirectory, "mailbox.sqlite"), { readOnly: true });
    try {
      assert.deepEqual(backupDatabase.prepare("SELECT * FROM mailbox_messages ORDER BY message_id").all(), before.messages);
      assert.deepEqual(backupDatabase.prepare("SELECT * FROM mailbox_deliveries ORDER BY delivery_id").all(), before.deliveries);
      assert.deepEqual(backupDatabase.prepare("SELECT * FROM mailbox_idempotency ORDER BY principal_id, operation, idempotency_key").all(), before.idempotency);
      assert.deepEqual(backupDatabase.prepare("SELECT * FROM mailbox_events ORDER BY sequence").all(), before.events);
      assert.equal(backupDatabase.prepare("PRAGMA integrity_check").get().integrity_check, "ok");
    } finally {
      backupDatabase.close();
    }

    const database = new DatabaseSync(fixture.databasePath);
    const afterEvents = database.prepare("SELECT * FROM mailbox_events ORDER BY sequence").all();
    try {
      assert.equal(database.prepare("PRAGMA user_version").get().user_version, 2);
      assert.equal(database.prepare("SELECT value FROM mailbox_metadata WHERE key = 'schema_version'").get().value, "bridge-mailbox-v2");
      const migratedMessages = database.prepare("SELECT * FROM mailbox_messages ORDER BY message_id").all();
      const migratedDeliveries = database.prepare("SELECT * FROM mailbox_deliveries ORDER BY delivery_id").all();
      assert.deepEqual(migratedMessages.map(withoutSchemaVersion), before.messages);
      assert.deepEqual(migratedDeliveries.map(withoutSchemaVersion), before.deliveries);
      assert.deepEqual(migratedMessages.map((row) => row.schema_version), ["bridge-mailbox-v1"]);
      assert.deepEqual(migratedDeliveries.map((row) => row.schema_version), ["bridge-mailbox-v1"]);
      assert.deepEqual(database.prepare("SELECT * FROM mailbox_idempotency ORDER BY principal_id, operation, idempotency_key").all(), before.idempotency);
      assert.deepEqual(afterEvents.slice(0, before.events.length), before.events);
      assert.equal(afterEvents.length, before.events.length + 1);
      assert.equal(afterEvents.at(-1).event_type, "mailbox.schema_migrated");
      assert.equal(afterEvents.at(-1).previous_hash, before.events.at(-1).event_hash);
      assert.equal(afterEvents.at(-1).file_appended, 1);
      assert.equal(afterEvents.at(-1).event_hash, hashCanonical(eventForHash(afterEvents.at(-1))));
      assert.equal(database.prepare("PRAGMA integrity_check").get().integrity_check, "ok");
      assert.deepEqual(database.prepare("PRAGMA foreign_key_check").all(), []);

      assert.throws(() => database.prepare(`INSERT INTO mailbox_messages(
        message_id, project_id, sender_json, schema_version, provider, mode, priority, sensitivity,
        status, created_at, expires_at, prompt_sha256, approval_ref, attempt,
        max_attempts, updated_at
      ) SELECT ?, project_id, sender_json, 'bridge-mailbox-v2', 'gemini', mode, priority, sensitivity,
        'preparing', created_at, expires_at, prompt_sha256, approval_ref, 0,
        max_attempts, updated_at FROM mailbox_messages WHERE message_id = ?`)
        .run("mailbox.message.new-gemini", fixture.messageId), /retired_mailbox_provider/u);
      assert.throws(() => database.prepare(`INSERT INTO mailbox_deliveries(
        delivery_id, message_id, schema_version, provider, consumer_id, delivery_token_hash,
        status, claimed_at, lease_expires_at, updated_at
      ) VALUES (?, ?, 'bridge-mailbox-v2', 'gemini', ?, ?, 'claimed', ?, ?, ?)`)
        .run(
          "mailbox.delivery.new-gemini",
          fixture.messageId,
          "provider.gemini.test",
          "c".repeat(64),
          "2026-07-17T12:00:00.000Z",
          "2026-07-17T12:15:00.000Z",
          "2026-07-17T12:00:00.000Z",
        ), /retired_mailbox_provider/u);
      assert.throws(() => database.prepare("UPDATE mailbox_messages SET provider = 'antigravity' WHERE message_id = ?").run(fixture.messageId), /immutable_mailbox_(?:message_content|legacy_gemini_message)/u);
      assert.throws(() => database.prepare("UPDATE mailbox_messages SET status = 'failed' WHERE message_id = ?").run(fixture.messageId), /immutable_mailbox_legacy_gemini_message/u);
      assert.throws(() => database.prepare("UPDATE mailbox_messages SET response_relative_path = 'v1/tampered.json' WHERE message_id = ?").run(fixture.messageId), /immutable_mailbox_legacy_gemini_message/u);
      assert.throws(() => database.prepare("DELETE FROM mailbox_messages WHERE message_id = ?").run(fixture.messageId), /immutable_mailbox_message_history/u);
      assert.throws(() => database.prepare("UPDATE mailbox_deliveries SET provider = 'antigravity' WHERE message_id = ?").run(fixture.messageId), /immutable_mailbox_(?:delivery_binding|legacy_gemini_delivery)/u);
      assert.throws(() => database.prepare("UPDATE mailbox_deliveries SET status = 'failed' WHERE message_id = ?").run(fixture.messageId), /immutable_mailbox_legacy_gemini_delivery/u);
      assert.throws(() => database.prepare("UPDATE mailbox_deliveries SET response_relative_path = 'v1/tampered.json' WHERE message_id = ?").run(fixture.messageId), /immutable_mailbox_legacy_gemini_delivery/u);
      assert.throws(() => database.prepare("DELETE FROM mailbox_deliveries WHERE message_id = ?").run(fixture.messageId), /immutable_mailbox_delivery_history/u);
    } finally {
      database.close();
    }

    const auditAfterMigration = fs.readFileSync(fixture.auditMirrorPath, "utf8");
    assert.ok(auditAfterMigration.startsWith(before.auditText));
    assert.equal(auditAfterMigration.trimEnd().split("\n").length, before.events.length + 1);
    const appendedAudit = JSON.parse(auditAfterMigration.trimEnd().split("\n").at(-1));
    assert.deepEqual(appendedAudit, eventEnvelope(afterEvents.at(-1)));
    assert.deepEqual(exchangeSnapshot(fixture.exchangeRoot), before.exchangeFiles);

    const migratedConfig = JSON.parse(fs.readFileSync(fixture.configPath, "utf8"));
    assert.equal(migratedConfig.schemaVersion, "bridge-mailbox-config-v2");
    assert.deepEqual(Object.keys(migratedConfig.providers).sort(), ["antigravity", "chatgpt"]);
    assert.equal("gemini" in migratedConfig.providers, false);
    assert.equal(typeof migratedConfig.integrations.antigravityPluginDirectory, "string");
    assert.equal("geminiExtensionDirectory" in migratedConfig.integrations, false);

    const webMigration = await migrateMailboxV2ToV3(fixture.configPath);
    assert.equal(webMigration.fromVersion, 2);
    assert.equal(webMigration.toVersion, 3);
    assert.equal(webMigration.rollback, "restore_before_v3_work_only");
    assert.deepEqual(webMigration.webNodes, ["perplexity"]);
    assert.ok(fs.statSync(webMigration.backupDirectory).isDirectory());
    const currentConfig = JSON.parse(fs.readFileSync(fixture.configPath, "utf8"));
    assert.equal(currentConfig.schemaVersion, "bridge-mailbox-config-v3");
    assert.deepEqual(Object.keys(currentConfig.providers).sort(), ["antigravity", "chatgpt", "web"]);
    assert.deepEqual(Object.keys(currentConfig.webNodes), ["perplexity"]);
    assert.equal(currentConfig.webNodes.perplexity.origin, "https://www.perplexity.ai");
    assert.equal(typeof currentConfig.integrations.webBrowserProfileDirectory, "string");

    const mailbox = new MailboxService(loadMailboxConfig(fixture.configPath));
    try {
      const historical = mailbox.get(fixture.messageId);
      assert.equal(historical.provider, "gemini");
      assert.equal(historical.legacyProvider, true);
      assert.equal(mailbox.store.verifyEventChain().ok, true);
      assert.equal(mailbox.doctor().database.legacyGeminiMessages, 1);
      assert.throws(() => mailbox.send(sendInput("gemini", "migration-new-gemini")), /mailbox_provider_invalid/u);
      assert.throws(() => mailbox.take("gemini", "provider.gemini.test"), /mailbox_provider_invalid/u);

      const queued = mailbox.send(sendInput("antigravity", "migration-new-antigravity"));
      assert.match(queued.envelopeRelativePath, /^v3\/projects\/[^/]+\/antigravity\/inbox\//u);
      const claim = mailbox.take("antigravity", "provider.antigravity.test");
      assert.ok(claim);
      assert.equal(claim.message.recipient, "antigravity");
      assert.deepEqual(claim.message.dispatchAuthorization.destination, {
        kind: "local-mcp",
        surface: "antigravity",
      });
      mailbox.markDispatching(claim.deliveryId, claim.deliveryToken);
      mailbox.markSent(claim.deliveryId, claim.deliveryToken);
      assert.equal(mailbox.complete({
        deliveryId: claim.deliveryId,
        deliveryToken: claim.deliveryToken,
        response: "Synthetic Antigravity migration response.",
      }).status, "completed");
    } finally {
      mailbox.close();
    }
    const activeDatabase = new DatabaseSync(fixture.databasePath, { readOnly: true });
    try {
      assert.deepEqual(
        activeDatabase.prepare("SELECT DISTINCT schema_version FROM mailbox_messages WHERE provider = 'antigravity'").all().map((row) => row.schema_version),
        ["bridge-mailbox-v3"],
      );
      assert.deepEqual(
        activeDatabase.prepare("SELECT DISTINCT schema_version FROM mailbox_deliveries WHERE provider = 'antigravity'").all().map((row) => row.schema_version),
        ["bridge-mailbox-v3"],
      );
    } finally {
      activeDatabase.close();
    }
  } finally {
    fs.rmSync(fixture.root, { recursive: true, force: true });
  }
});

test("mailbox v2 schema fences off a surviving v1 writer", async () => {
  const fixture = legacyFixture("completed");
  const staleDatabase = new DatabaseSync(fixture.databasePath);
  const staleMessageInsert = staleDatabase.prepare(`INSERT INTO mailbox_messages(
    message_id, project_id, sender_json, provider, mode, priority, sensitivity, status,
    created_at, expires_at, prompt_sha256, approval_ref, attempt, max_attempts, updated_at
  ) VALUES (?, 'project.stale-v1', '{}', 'chatgpt', 'default', 'normal', 'internal',
    'preparing', ?, ?, ?, 'approval.stale-v1', 0, 3, ?)`);
  const staleDeliveryInsert = staleDatabase.prepare(`INSERT INTO mailbox_deliveries(
    delivery_id, message_id, provider, consumer_id, delivery_token_hash, status,
    claimed_at, lease_expires_at, updated_at
  ) VALUES (?, ?, 'chatgpt', 'provider.chatgpt.web', ?, 'claimed', ?, ?, ?)`);
  try {
    await migrateMailboxV1ToV2(fixture.configPath);
    assert.throws(() => staleMessageInsert.run(
      "mailbox.message.stale-v1",
      "2026-07-17T12:00:00.000Z",
      "2026-07-18T12:00:00.000Z",
      "e".repeat(64),
      "2026-07-17T12:00:00.000Z",
    ), /mailbox_messages\.schema_version/u);
    assert.throws(() => staleDeliveryInsert.run(
      "mailbox.delivery.stale-v1",
      fixture.messageId,
      "f".repeat(64),
      "2026-07-17T12:00:00.000Z",
      "2026-07-17T12:15:00.000Z",
      "2026-07-17T12:00:00.000Z",
    ), /mailbox_deliveries\.schema_version/u);
    assert.equal(staleDatabase.prepare("SELECT COUNT(*) AS count FROM mailbox_messages WHERE message_id = 'mailbox.message.stale-v1'").get().count, 0);
    assert.equal(staleDatabase.prepare("SELECT COUNT(*) AS count FROM mailbox_deliveries WHERE delivery_id = 'mailbox.delivery.stale-v1'").get().count, 0);
  } finally {
    staleDatabase.close();
    fs.rmSync(fixture.root, { recursive: true, force: true });
  }
});

for (const status of ["queued", "sent"]) {
  test(`mailbox v1 migration fails closed on ${status} Gemini history`, async () => {
    const fixture = legacyFixture(status);
    const before = snapshot(fixture);
    try {
      await assert.rejects(() => migrateMailboxV1ToV2(fixture.configPath), /mailbox_legacy_gemini_nonterminal/u);
      const after = snapshot(fixture);
      assert.deepEqual(after, before);
      assert.equal(fs.existsSync(path.join(fixture.stateDirectory, "migrations")), false);
    } finally {
      fs.rmSync(fixture.root, { recursive: true, force: true });
    }
  });
}

test("mailbox v1 migration fails closed when the audit mirror is not the database chain", async () => {
  const fixture = legacyFixture("completed");
  fs.appendFileSync(fixture.auditMirrorPath, `${canonicalize({ unexpected: true })}\n`, "utf8");
  const before = snapshot(fixture);
  try {
    await assert.rejects(() => migrateMailboxV1ToV2(fixture.configPath), /mailbox_audit_/u);
    assert.deepEqual(snapshot(fixture), before);
    assert.equal(fs.existsSync(path.join(fixture.stateDirectory, "migrations")), false);
  } finally {
    fs.rmSync(fixture.root, { recursive: true, force: true });
  }
});

test("mailbox v1 migration fails closed when the database event chain is corrupt", async () => {
  const fixture = legacyFixture("completed");
  const database = new DatabaseSync(fixture.databasePath);
  try {
    database.exec("DROP TRIGGER mailbox_events_no_update");
    database.prepare("UPDATE mailbox_events SET event_hash = ? WHERE sequence = 1").run("d".repeat(64));
  } finally {
    database.close();
  }
  const before = snapshot(fixture);
  try {
    await assert.rejects(() => migrateMailboxV1ToV2(fixture.configPath), /mailbox_event_/u);
    assert.deepEqual(snapshot(fixture), before);
    assert.equal(fs.existsSync(path.join(fixture.stateDirectory, "migrations")), false);
  } finally {
    fs.rmSync(fixture.root, { recursive: true, force: true });
  }
});

test("mailbox v1 migration restores config, database, and audit after a post-commit failure", async () => {
  const fixture = legacyFixture("completed");
  const config = JSON.parse(fs.readFileSync(fixture.configPath, "utf8"));
  config.broker.allowedOrigins = ["not-a-valid-origin"];
  fs.writeFileSync(fixture.configPath, `${JSON.stringify(config, null, 2)}\n`, "utf8");
  const before = snapshot(fixture);
  try {
    await assert.rejects(() => migrateMailboxV1ToV2(fixture.configPath), /mailbox_allowed_origin_invalid/u);
    assert.deepEqual(snapshot(fixture), before);
    const backups = fs.readdirSync(path.join(fixture.stateDirectory, "migrations"), { withFileTypes: true })
      .filter((entry) => entry.isDirectory() && !entry.name.startsWith("."));
    assert.equal(backups.length, 1);
    assert.ok(fs.statSync(path.join(fixture.stateDirectory, "migrations", backups[0].name, "manifest.json")).isFile());
  } finally {
    fs.rmSync(fixture.root, { recursive: true, force: true });
  }
});

test("mailbox v1 migration rejects a Windows junction at the backup directory before writing", {
  skip: process.platform !== "win32",
}, async () => {
  const fixture = legacyFixture("completed");
  const outside = path.join(fixture.root, "outside-migrations");
  const sentinel = path.join(outside, "sentinel.txt");
  const migrations = path.join(fixture.stateDirectory, "migrations");
  fs.mkdirSync(outside);
  fs.writeFileSync(sentinel, "outside sentinel", "utf8");
  fs.symlinkSync(outside, migrations, "junction");
  const before = snapshot(fixture);
  try {
    await assert.rejects(
      () => migrateMailboxV1ToV2(fixture.configPath),
      /mailbox_migration_backup_reparse_forbidden/u,
    );
    assert.deepEqual(snapshot(fixture), before);
    assert.equal(fs.readFileSync(sentinel, "utf8"), "outside sentinel");
    assert.deepEqual(fs.readdirSync(outside), ["sentinel.txt"]);
  } finally {
    fs.rmSync(fixture.root, { recursive: true, force: true });
  }
});

function legacyFixture(status) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "bridge-mailbox-v1-migration-"));
  const stateDirectory = path.join(root, "state");
  const exchangeRoot = path.join(root, "drive", "Bridge Exchange");
  const databasePath = path.join(stateDirectory, "mailbox.sqlite");
  const auditMirrorPath = path.join(stateDirectory, "mailbox-audit.jsonl");
  const configPath = path.join(stateDirectory, "config.json");
  const tokenFile = path.join(stateDirectory, "broker-token.txt");
  fs.mkdirSync(stateDirectory, { recursive: true });
  fs.mkdirSync(exchangeRoot, { recursive: true });
  fs.writeFileSync(tokenFile, `${"a".repeat(48)}\n`, "utf8");

  const projectId = "project.synthetic.migration";
  const messageId = "mailbox.message.legacy-gemini";
  const deliveryId = "mailbox.delivery.legacy-gemini";
  const responseId = "mailbox.response.legacy-gemini";
  const createdAt = "2026-07-14T12:00:00.000Z";
  const expiresAt = "2026-07-15T12:00:00.000Z";
  const prompt = "Synthetic historical Gemini prompt.";
  const response = "Synthetic historical Gemini response.";
  const promptSha256 = sha256(Buffer.from(prompt, "utf8"));
  const responseContentSha256 = sha256(Buffer.from(response, "utf8"));
  const projectDirectory = path.join(exchangeRoot, "v1", "projects", projectKey(projectId), "gemini");
  const messagePath = path.join(projectDirectory, "inbox", `${messageId}.json`);
  const messageReadyPath = path.join(projectDirectory, "inbox", `${messageId}.ready.json`);
  const responsePath = path.join(projectDirectory, "responses", messageId, `${responseId}.json`);
  const responseReadyPath = path.join(projectDirectory, "responses", messageId, `${responseId}.ready.json`);

  const message = {
    schemaVersion: "bridge-mailbox-v1",
    kind: "message",
    messageId,
    projectId,
    sender: { principalId: "principal.synthetic", sessionId: "session.synthetic", hostId: "host.synthetic" },
    recipient: "gemini",
    mode: "default",
    priority: "normal",
    sensitivity: "internal",
    createdAt,
    expiresAt,
    promptSha256,
    prompt,
    dispatchAuthorization: {
      approvalRef: "approval.synthetic.legacy-gemini",
      authorizedAt: createdAt,
      expiresAt,
      provider: "gemini",
      origin: "https://gemini.google.com",
      useCount: 1,
    },
  };
  const messageBytes = canonicalBytes(message);
  const messageEnvelopeSha256 = sha256(messageBytes);
  writeObject(messagePath, messageReadyPath, messageId, "message", messageBytes, createdAt);

  const responseEnvelope = {
    schemaVersion: "bridge-mailbox-v1",
    kind: "response",
    responseId,
    messageId,
    deliveryId,
    projectId,
    provider: "gemini",
    consumerId: "provider.gemini.web",
    createdAt: "2026-07-14T12:05:00.000Z",
    responseSha256: responseContentSha256,
    response,
    conversationUrl: "https://gemini.google.com/app/synthetic",
  };
  const responseBytes = canonicalBytes(responseEnvelope);
  const responseEnvelopeSha256 = sha256(responseBytes);
  if (status === "completed") {
    writeObject(responsePath, responseReadyPath, responseId, "response", responseBytes, responseEnvelope.createdAt);
  }

  const database = new DatabaseSync(databasePath);
  database.exec(legacySchema);
  const terminal = status === "completed";
  const active = status === "claimed" || status === "dispatching" || status === "sent";
  database.prepare(`INSERT INTO mailbox_messages(
    message_id, project_id, sender_json, provider, mode, priority, sensitivity, status,
    created_at, expires_at, prompt_sha256, approval_ref, envelope_sha256,
    envelope_relative_path, ready_relative_path, attempt, max_attempts,
    active_delivery_id, response_sha256, response_relative_path, updated_at
  ) VALUES (?, ?, ?, 'gemini', 'default', 'normal', 'internal', ?, ?, ?, ?, ?, ?, ?, ?, ?, 3, ?, ?, ?, ?)`)
    .run(
      messageId,
      projectId,
      canonicalize(message.sender),
      status,
      createdAt,
      expiresAt,
      promptSha256,
      message.dispatchAuthorization.approvalRef,
      messageEnvelopeSha256,
      relative(exchangeRoot, messagePath),
      relative(exchangeRoot, messageReadyPath),
      terminal || active ? 1 : 0,
      active ? deliveryId : null,
      terminal ? responseEnvelopeSha256 : null,
      terminal ? relative(exchangeRoot, responsePath) : null,
      "2026-07-14T12:06:00.000Z",
    );
  if (terminal || active) {
    database.prepare(`INSERT INTO mailbox_deliveries(
      delivery_id, message_id, provider, consumer_id, delivery_token_hash, status,
      claimed_at, lease_expires_at, response_id, response_created_at,
      response_content_sha256, response_sha256, response_relative_path,
      completed_at, updated_at
    ) VALUES (?, ?, 'gemini', 'provider.gemini.web', ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`)
      .run(
        deliveryId,
        messageId,
        sha256(Buffer.from("synthetic-delivery-token-that-is-never-exposed", "utf8")),
        status,
        "2026-07-14T12:01:00.000Z",
        "2026-07-14T12:16:00.000Z",
        terminal ? responseId : null,
        terminal ? responseEnvelope.createdAt : null,
        terminal ? responseContentSha256 : null,
        terminal ? responseEnvelopeSha256 : null,
        terminal ? relative(exchangeRoot, responsePath) : null,
        terminal ? "2026-07-14T12:06:00.000Z" : null,
        "2026-07-14T12:06:00.000Z",
      );
  }
  database.prepare(`INSERT INTO mailbox_idempotency(
    principal_id, operation, idempotency_key, request_hash, response_json, created_at
  ) VALUES ('principal.synthetic', 'mailbox.send', 'legacy-gemini-idempotency', ?, ?, ?)`)
    .run("b".repeat(64), canonicalize({ messageId }), createdAt);

  const eventTypes = terminal
    ? [
        "mailbox.message_reserved",
        "mailbox.message_queued",
        "mailbox.delivery_claimed",
        "mailbox.delivery_dispatching",
        "mailbox.delivery_sent",
        "mailbox.response_reserved",
        "mailbox.delivery_completed",
      ]
    : active
      ? [
          "mailbox.message_reserved",
          "mailbox.message_queued",
          "mailbox.delivery_claimed",
          ...(status === "claimed" ? [] : ["mailbox.delivery_dispatching"]),
          ...(status === "sent" ? ["mailbox.delivery_sent"] : []),
        ]
      : ["mailbox.message_reserved", "mailbox.message_queued"];
  const auditLines = [];
  let previousHash = null;
  for (let index = 0; index < eventTypes.length; index += 1) {
    const sequence = index + 1;
    const eventId = `mailbox.event.legacy-${sequence}`;
    const occurredAt = `2026-07-14T12:0${index}:00.000Z`;
    const payload = { fixture: true, provider: "gemini", step: sequence };
    const eventHash = hashCanonical({
      sequence,
      eventId,
      eventType: eventTypes[index],
      messageId,
      occurredAt,
      payload,
      previousHash,
    });
    database.prepare(`INSERT INTO mailbox_events(
      sequence, event_id, event_type, message_id, occurred_at, payload_json,
      previous_hash, event_hash, file_appended
    ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, 1)`)
      .run(sequence, eventId, eventTypes[index], messageId, occurredAt, canonicalize(payload), previousHash, eventHash);
    auditLines.push(canonicalize({ sequence, eventId, eventType: eventTypes[index], messageId, occurredAt, payload, previousHash, eventHash }));
    previousHash = eventHash;
  }
  database.exec("PRAGMA user_version = 1");
  database.close();
  fs.writeFileSync(auditMirrorPath, `${auditLines.join("\n")}\n`, "utf8");

  const config = {
    schemaVersion: "bridge-mailbox-config-v1",
    stateDirectory,
    databasePath,
    auditMirrorPath,
    exchangeRoot,
    broker: { host: "127.0.0.1", port: 7319, tokenFile, allowedOrigins: [] },
    providers: {
      chatgpt: { enabled: true, consumerId: "provider.chatgpt.web" },
      gemini: { enabled: true, consumerId: "provider.gemini.web" },
    },
    delivery: {
      leaseMs: 900000,
      heartbeatExtensionMs: 300000,
      pollIntervalMs: 5000,
      defaultExpiryMs: 86400000,
      maxPreDispatchAttempts: 3,
    },
    integrations: {
      chromeExtensionDirectory: path.join(stateDirectory, "chrome-extension"),
      geminiExtensionDirectory: path.join(stateDirectory, "bridge-mailbox"),
    },
  };
  fs.writeFileSync(configPath, `${JSON.stringify(config, null, 2)}\n`, "utf8");
  return {
    root,
    stateDirectory,
    exchangeRoot,
    databasePath,
    auditMirrorPath,
    configPath,
    messageId,
    messagePath,
    responsePath,
  };
}

function snapshot(fixture) {
  const database = new DatabaseSync(fixture.databasePath, { readOnly: true });
  try {
    return {
      userVersion: database.prepare("PRAGMA user_version").get().user_version,
      metadata: database.prepare("SELECT * FROM mailbox_metadata ORDER BY key").all(),
      messages: database.prepare("SELECT * FROM mailbox_messages ORDER BY message_id").all(),
      deliveries: database.prepare("SELECT * FROM mailbox_deliveries ORDER BY delivery_id").all(),
      idempotency: database.prepare("SELECT * FROM mailbox_idempotency ORDER BY principal_id, operation, idempotency_key").all(),
      events: database.prepare("SELECT * FROM mailbox_events ORDER BY sequence").all(),
      schema: database.prepare("SELECT type, name, tbl_name, sql FROM sqlite_schema WHERE name NOT LIKE 'sqlite_%' ORDER BY type, name").all(),
      auditText: fs.readFileSync(fixture.auditMirrorPath, "utf8"),
      configText: fs.readFileSync(fixture.configPath, "utf8"),
      exchangeFiles: exchangeSnapshot(fixture.exchangeRoot),
    };
  } finally {
    database.close();
  }
}

function withoutSchemaVersion(row) {
  const normalized = Object.create(Object.getPrototypeOf(row));
  for (const [key, value] of Object.entries(row)) {
    if (key !== "schema_version") normalized[key] = value;
  }
  return normalized;
}

function exchangeSnapshot(root) {
  const entries = {};
  for (const filePath of walkFiles(root)) {
    entries[relative(root, filePath)] = fs.readFileSync(filePath).toString("base64");
  }
  return entries;
}

function walkFiles(directory) {
  if (!fs.existsSync(directory)) return [];
  return fs.readdirSync(directory, { withFileTypes: true })
    .sort((left, right) => left.name.localeCompare(right.name))
    .flatMap((entry) => {
      const candidate = path.join(directory, entry.name);
      return entry.isDirectory() ? walkFiles(candidate) : [candidate];
    });
}

function eventForHash(row) {
  return {
    sequence: Number(row.sequence),
    eventId: row.event_id,
    eventType: row.event_type,
    messageId: row.message_id,
    occurredAt: row.occurred_at,
    payload: JSON.parse(row.payload_json),
    previousHash: row.previous_hash,
  };
}

function eventEnvelope(row) {
  return { ...eventForHash(row), eventHash: row.event_hash };
}

function sendInput(provider, idempotencyKey) {
  return {
    projectId: "project.synthetic.migration.v2",
    sender: { principalId: "principal.codex", sessionId: "session.synthetic", hostId: "host.synthetic" },
    provider,
    prompt: "Synthetic post-migration prompt.",
    idempotencyKey,
    approvalRef: `approval.synthetic.${idempotencyKey}`,
  };
}

function canonicalBytes(value) {
  return Buffer.from(`${canonicalize(value)}\n`, "utf8");
}

function writeObject(objectPath, readyPath, objectId, objectKind, bytes, createdAt) {
  fs.mkdirSync(path.dirname(objectPath), { recursive: true });
  fs.writeFileSync(objectPath, bytes);
  fs.writeFileSync(readyPath, canonicalBytes({
    schemaVersion: "bridge-mailbox-v1",
    kind: "ready",
    objectKind,
    objectId,
    sha256: sha256(bytes),
    byteLength: bytes.length,
    createdAt,
  }));
}

function projectKey(projectId) {
  const slug = projectId.toLowerCase().replace(/[^a-z0-9]+/gu, "-").replace(/^-|-$/gu, "").slice(0, 48) || "project";
  return `${slug}-${sha256(Buffer.from(projectId, "utf8")).slice(0, 16)}`;
}

function relative(root, filePath) {
  return path.relative(root, filePath).split(path.sep).join("/");
}

const legacySchema = `
  CREATE TABLE mailbox_metadata (
    key TEXT PRIMARY KEY,
    value TEXT NOT NULL
  ) STRICT;
  CREATE TABLE mailbox_messages (
    message_id TEXT PRIMARY KEY,
    project_id TEXT NOT NULL,
    sender_json TEXT NOT NULL CHECK (json_valid(sender_json)),
    provider TEXT NOT NULL CHECK (provider IN ('chatgpt','gemini')),
    mode TEXT NOT NULL CHECK (mode = 'default'),
    priority TEXT NOT NULL CHECK (priority IN ('normal','high')),
    sensitivity TEXT NOT NULL CHECK (sensitivity IN ('public','internal')),
    status TEXT NOT NULL CHECK (status IN ('preparing','queued','claimed','dispatching','sent','completed','failed','uncertain','expired')),
    created_at TEXT NOT NULL,
    expires_at TEXT NOT NULL,
    prompt_sha256 TEXT NOT NULL CHECK (length(prompt_sha256) = 64),
    approval_ref TEXT NOT NULL,
    envelope_sha256 TEXT CHECK (envelope_sha256 IS NULL OR length(envelope_sha256) = 64),
    envelope_relative_path TEXT,
    ready_relative_path TEXT,
    attempt INTEGER NOT NULL DEFAULT 0 CHECK (attempt >= 0),
    max_attempts INTEGER NOT NULL CHECK (max_attempts BETWEEN 1 AND 20),
    active_delivery_id TEXT,
    response_sha256 TEXT CHECK (response_sha256 IS NULL OR length(response_sha256) = 64),
    response_relative_path TEXT,
    last_error TEXT,
    updated_at TEXT NOT NULL
  ) STRICT;
  CREATE INDEX mailbox_messages_queue_idx ON mailbox_messages(provider, status, priority, created_at);
  CREATE TABLE mailbox_deliveries (
    delivery_id TEXT PRIMARY KEY,
    message_id TEXT NOT NULL REFERENCES mailbox_messages(message_id),
    provider TEXT NOT NULL CHECK (provider IN ('chatgpt','gemini')),
    consumer_id TEXT NOT NULL,
    delivery_token_hash TEXT NOT NULL CHECK (length(delivery_token_hash) = 64),
    status TEXT NOT NULL CHECK (status IN ('claimed','dispatching','sent','completed','failed','released','uncertain')),
    claimed_at TEXT NOT NULL,
    lease_expires_at TEXT NOT NULL,
    response_id TEXT,
    response_created_at TEXT,
    response_content_sha256 TEXT CHECK (response_content_sha256 IS NULL OR length(response_content_sha256) = 64),
    response_sha256 TEXT,
    response_relative_path TEXT,
    error_code TEXT,
    completed_at TEXT,
    updated_at TEXT NOT NULL
  ) STRICT;
  CREATE UNIQUE INDEX mailbox_one_active_delivery ON mailbox_deliveries(message_id)
    WHERE status IN ('claimed','dispatching','sent');
  CREATE TABLE mailbox_idempotency (
    principal_id TEXT NOT NULL,
    operation TEXT NOT NULL,
    idempotency_key TEXT NOT NULL,
    request_hash TEXT NOT NULL CHECK (length(request_hash) = 64),
    response_json TEXT NOT NULL CHECK (json_valid(response_json)),
    created_at TEXT NOT NULL,
    PRIMARY KEY (principal_id, operation, idempotency_key)
  ) STRICT;
  CREATE TABLE mailbox_events (
    sequence INTEGER PRIMARY KEY,
    event_id TEXT NOT NULL UNIQUE,
    event_type TEXT NOT NULL,
    message_id TEXT,
    occurred_at TEXT NOT NULL,
    payload_json TEXT NOT NULL CHECK (json_valid(payload_json)),
    previous_hash TEXT,
    event_hash TEXT NOT NULL UNIQUE CHECK (length(event_hash) = 64),
    file_appended INTEGER NOT NULL DEFAULT 0 CHECK (file_appended IN (0,1))
  ) STRICT;
  CREATE TRIGGER mailbox_events_no_update BEFORE UPDATE ON mailbox_events
  WHEN OLD.sequence IS NOT NEW.sequence
    OR OLD.event_id IS NOT NEW.event_id
    OR OLD.event_type IS NOT NEW.event_type
    OR OLD.message_id IS NOT NEW.message_id
    OR OLD.occurred_at IS NOT NEW.occurred_at
    OR OLD.payload_json IS NOT NEW.payload_json
    OR OLD.previous_hash IS NOT NEW.previous_hash
    OR OLD.event_hash IS NOT NEW.event_hash
    OR NOT (OLD.file_appended = 0 AND NEW.file_appended = 1)
  BEGIN SELECT RAISE(ABORT, 'immutable_mailbox_event'); END;
  CREATE TRIGGER mailbox_events_no_delete BEFORE DELETE ON mailbox_events
    BEGIN SELECT RAISE(ABORT, 'immutable_mailbox_event'); END;
  CREATE TRIGGER mailbox_message_content_immutable BEFORE UPDATE ON mailbox_messages
  WHEN OLD.provider IS NOT NEW.provider
  BEGIN SELECT RAISE(ABORT, 'immutable_mailbox_message_content'); END;
  CREATE TRIGGER mailbox_delivery_binding_immutable BEFORE UPDATE ON mailbox_deliveries
  WHEN OLD.provider IS NOT NEW.provider
  BEGIN SELECT RAISE(ABORT, 'immutable_mailbox_delivery_binding'); END;
  INSERT INTO mailbox_metadata(key, value) VALUES ('schema_version', 'bridge-mailbox-v1');
`;

// --- v2->v3 migration fail-closed tests ---

for (const status of ["queued", "claimed", "dispatching", "sent"]) {
  test(`mailbox v2->v3 migration fails closed on ${status} nonterminal state`, async () => {
    const fixture = legacyFixture("completed");
    await migrateMailboxV1ToV2(fixture.configPath);
    
    const db = new DatabaseSync(fixture.databasePath);
    const active = status === "claimed" || status === "dispatching" || status === "sent";
    db.prepare(`INSERT INTO mailbox_messages(
      message_id, project_id, sender_json, schema_version, provider, mode, priority, sensitivity,
      status, created_at, expires_at, prompt_sha256, approval_ref, attempt,
      max_attempts, updated_at
    ) VALUES (?, 'proj', '{}', 'bridge-mailbox-v2', 'chatgpt', 'default', 'normal', 'internal',
      ?, '2026-07-17T12:00:00.000Z', '2026-07-18T12:00:00.000Z', ?, 'app', 0, 3, '2026-07-17T12:00:00.000Z')`)
      .run('mailbox.message.stale-v2', status, 'e'.repeat(64));
    
    if (active) {
       db.prepare(`INSERT INTO mailbox_deliveries(
        delivery_id, message_id, schema_version, provider, consumer_id, delivery_token_hash,
        status, claimed_at, lease_expires_at, updated_at
      ) VALUES (?, ?, 'bridge-mailbox-v2', 'chatgpt', 'provider.chatgpt.web', ?, ?, '2026-07-17T12:00:00.000Z', '2026-07-17T12:15:00.000Z', '2026-07-17T12:00:00.000Z')`)
        .run('mailbox.delivery.stale-v2', 'mailbox.message.stale-v2', 'f'.repeat(64), status);
       db.prepare(`UPDATE mailbox_messages SET active_delivery_id = ? WHERE message_id = ?`).run('mailbox.delivery.stale-v2', 'mailbox.message.stale-v2');
    }
    db.close();

    const before = snapshot(fixture);
    try {
      await assert.rejects(() => migrateMailboxV2ToV3(fixture.configPath), /mailbox_v2_(?:nonterminal|active_delivery)/u);
      const after = snapshot(fixture);
      assert.deepEqual(after, before);
    } finally {
      fs.rmSync(fixture.root, { recursive: true, force: true });
    }
  });
}

test("mailbox v2->v3 migration fails closed when the audit mirror is not the database chain", async () => {
  const fixture = legacyFixture("completed");
  await migrateMailboxV1ToV2(fixture.configPath);
  fs.appendFileSync(fixture.auditMirrorPath, `${canonicalize({ unexpected: true })}\n`, "utf8");
  const before = snapshot(fixture);
  try {
    await assert.rejects(() => migrateMailboxV2ToV3(fixture.configPath), /mailbox_audit_/u);
    assert.deepEqual(snapshot(fixture), before);
  } finally {
    fs.rmSync(fixture.root, { recursive: true, force: true });
  }
});

test("mailbox v2->v3 migration fails closed when the database event chain is corrupt", async () => {
  const fixture = legacyFixture("completed");
  await migrateMailboxV1ToV2(fixture.configPath);
  const database = new DatabaseSync(fixture.databasePath);
  try {
    database.exec("DROP TRIGGER mailbox_events_no_update");
    database.prepare("UPDATE mailbox_events SET event_hash = ? WHERE sequence = 1").run("d".repeat(64));
  } finally {
    database.close();
  }
  const before = snapshot(fixture);
  try {
    await assert.rejects(() => migrateMailboxV2ToV3(fixture.configPath), /mailbox_event_/u);
    assert.deepEqual(snapshot(fixture), before);
  } finally {
    fs.rmSync(fixture.root, { recursive: true, force: true });
  }
});

test("mailbox v2->v3 migration restores config, database, and audit after a post-commit failure", async () => {
  const fixture = legacyFixture("completed");
  await migrateMailboxV1ToV2(fixture.configPath);
  
  const config = JSON.parse(fs.readFileSync(fixture.configPath, "utf8"));
  config.broker.allowedOrigins = ["not-a-valid-origin"];
  fs.writeFileSync(fixture.configPath, `${JSON.stringify(config, null, 2)}\n`, "utf8");
  const before = snapshot(fixture);
  try {
    await assert.rejects(() => migrateMailboxV2ToV3(fixture.configPath), /mailbox_allowed_origin_invalid/u);
    assert.deepEqual(snapshot(fixture), before);
    const backups = fs.readdirSync(path.join(fixture.stateDirectory, "migrations"), { withFileTypes: true })
      .filter((entry) => entry.isDirectory() && !entry.name.startsWith("."));
    assert.equal(backups.length, 2);
    // Find the latest backup
    backups.sort((a,b) => b.name.localeCompare(a.name));
    assert.ok(fs.statSync(path.join(fixture.stateDirectory, "migrations", backups[0].name, "manifest.json")).isFile());
  } finally {
    fs.rmSync(fixture.root, { recursive: true, force: true });
  }
});

test("mailbox v3 schema fences off a surviving v2 writer", async () => {
  const fixture = legacyFixture("completed");
  await migrateMailboxV1ToV2(fixture.configPath);
  await migrateMailboxV2ToV3(fixture.configPath);

  const staleDatabase = new DatabaseSync(fixture.databasePath);
  const staleMessageInsert = staleDatabase.prepare(`INSERT INTO mailbox_messages(
    message_id, project_id, sender_json, schema_version, provider, mode, priority, sensitivity, status,
    created_at, expires_at, prompt_sha256, approval_ref, attempt, max_attempts, updated_at
  ) VALUES (?, 'project.stale-v2', '{}', 'bridge-mailbox-v2', 'chatgpt', 'default', 'normal', 'internal',
    'preparing', ?, ?, ?, 'approval.stale-v2', 0, 3, ?)`);
  const staleDeliveryInsert = staleDatabase.prepare(`INSERT INTO mailbox_deliveries(
    delivery_id, message_id, schema_version, provider, consumer_id, delivery_token_hash, status,
    claimed_at, lease_expires_at, updated_at
  ) VALUES (?, ?, 'bridge-mailbox-v2', 'chatgpt', 'provider.chatgpt.web', ?, 'claimed', ?, ?, ?)`);
  try {
    assert.throws(() => staleMessageInsert.run(
      "mailbox.message.stale-v2",
      "2026-07-17T12:00:00.000Z",
      "2026-07-18T12:00:00.000Z",
      "e".repeat(64),
      "2026-07-17T12:00:00.000Z",
    ), /stale_mailbox_writer/u);
    assert.throws(() => staleDeliveryInsert.run(
      "mailbox.delivery.stale-v2",
      "mailbox.message.legacy-gemini",
      "f".repeat(64),
      "2026-07-17T12:00:00.000Z",
      "2026-07-17T12:15:00.000Z",
      "2026-07-17T12:00:00.000Z",
    ), /stale_mailbox_writer/u);
    assert.equal(staleDatabase.prepare("SELECT COUNT(*) AS count FROM mailbox_messages WHERE message_id = 'mailbox.message.stale-v2'").get().count, 0);
    assert.equal(staleDatabase.prepare("SELECT COUNT(*) AS count FROM mailbox_deliveries WHERE delivery_id = 'mailbox.delivery.stale-v2'").get().count, 0);
  } finally {
    staleDatabase.close();
    fs.rmSync(fixture.root, { recursive: true, force: true });
  }
});
