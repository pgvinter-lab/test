import crypto from "node:crypto";
import fs from "node:fs";
import path from "node:path";
import { DatabaseSync } from "node:sqlite";
import { canonicalize, hashCanonical, sha256 } from "../core/canonical.js";
import { invariant } from "../core/errors.js";
import { newId } from "../core/ids.js";
import type {
  MailboxDeliveryStatus,
  MailboxIdentity,
  MailboxMessageRecord,
  MailboxMessageStatus,
  MailboxMode,
  MailboxPriority,
  MailboxProvider,
  MailboxSensitivity,
  MailboxStoredProvider,
} from "./types.js";

interface MessageRow {
  message_id: string;
  project_id: string;
  sender_json: string;
  schema_version: "bridge-mailbox-v1" | "bridge-mailbox-v2" | "bridge-mailbox-v3";
  provider: MailboxStoredProvider;
  mode: MailboxMode;
  priority: MailboxPriority;
  sensitivity: MailboxSensitivity;
  status: MailboxMessageStatus;
  created_at: string;
  expires_at: string;
  prompt_sha256: string;
  approval_ref: string;
  envelope_sha256: string | null;
  envelope_relative_path: string | null;
  ready_relative_path: string | null;
  attempt: number;
  max_attempts: number;
  active_delivery_id: string | null;
  response_sha256: string | null;
  response_relative_path: string | null;
  last_error: string | null;
  updated_at: string;
}

interface DeliveryRow {
  delivery_id: string;
  message_id: string;
  schema_version: "bridge-mailbox-v1" | "bridge-mailbox-v2" | "bridge-mailbox-v3";
  provider: MailboxStoredProvider;
  consumer_id: string;
  delivery_token_hash: string;
  status: MailboxDeliveryStatus;
  claimed_at: string;
  lease_expires_at: string;
  response_id: string | null;
  response_created_at: string | null;
  response_content_sha256: string | null;
  response_sha256: string | null;
  response_relative_path: string | null;
  updated_at: string;
}

export interface ReserveMessageInput {
  messageId: string;
  projectId: string;
  sender: MailboxIdentity;
  provider: MailboxProvider;
  mode: MailboxMode;
  priority: MailboxPriority;
  sensitivity: MailboxSensitivity;
  createdAt: string;
  expiresAt: string;
  promptSha256: string;
  approvalRef: string;
  maxAttempts: number;
  idempotencyKey: string;
  requestHash: string;
}

export interface ClaimedMessageMetadata {
  deliveryId: string;
  deliveryToken: string;
  consumerId: string;
  claimedAt: string;
  leaseExpiresAt: string;
  message: MailboxMessageRecord & { readyRelativePath: string };
}

export interface CompleteDeliveryInput {
  deliveryId: string;
  deliveryToken: string;
  responseSha256: string;
  responseRelativePath: string;
}

export interface PreparedResponse {
  responseId: string;
  createdAt: string;
  message: MailboxMessageRecord;
  provider: MailboxProvider;
  consumerId: string;
}

export class MailboxStore {
  readonly databasePath: string;
  readonly auditMirrorPath: string;
  readonly database: DatabaseSync;
  readonly now: () => string;
  private inWrite = false;

  constructor(databasePath: string, now: () => string = () => new Date().toISOString(), auditMirrorPath?: string) {
    this.databasePath = path.resolve(databasePath);
    this.auditMirrorPath = path.resolve(auditMirrorPath ?? path.join(path.dirname(this.databasePath), "mailbox-audit.jsonl"));
    invariant(this.auditMirrorPath !== this.databasePath, "mailbox_audit_database_collision");
    this.now = now;
    fs.mkdirSync(path.dirname(this.databasePath), { recursive: true, mode: 0o700 });
    this.database = new DatabaseSync(this.databasePath);
    this.database.exec("PRAGMA foreign_keys = ON");
    this.database.exec("PRAGMA busy_timeout = 10000");
    this.database.exec("PRAGMA journal_mode = WAL");
    this.database.exec("PRAGMA synchronous = FULL");
    this.database.exec("PRAGMA trusted_schema = OFF");
    this.bootstrap();
    this.flushAuditMirror();
  }

  close(): void {
    this.flushAuditMirror();
    this.database.close();
  }

  reserveMessage(input: ReserveMessageInput): { record: MailboxMessageRecord; created: boolean } {
    validateIdentity(input.sender);
    validateProvider(input.provider);
    invariant(input.sensitivity === "public" || input.sensitivity === "internal", "mailbox_sensitivity_not_supported");
    validateId(input.messageId, "mailbox.message.");
    invariant(input.idempotencyKey.length >= 8 && input.idempotencyKey.length <= 300, "mailbox_idempotency_key_invalid");
    invariant(/^[a-f0-9]{64}$/u.test(input.promptSha256) && /^[a-f0-9]{64}$/u.test(input.requestHash), "mailbox_hash_invalid");
    invariant(Number.isSafeInteger(input.maxAttempts) && input.maxAttempts >= 1 && input.maxAttempts <= 20, "mailbox_max_attempts_invalid");
    return this.transaction(() => {
      const existing = this.get<{ request_hash: string; response_json: string }>(
        `SELECT request_hash, response_json FROM mailbox_idempotency
         WHERE principal_id = ? AND operation = 'mailbox.send' AND idempotency_key = ?`,
        input.sender.principalId,
        input.idempotencyKey,
      );
      if (existing) {
        invariant(existing.request_hash === input.requestHash, "mailbox_idempotency_key_reused");
        const response = JSON.parse(existing.response_json) as { messageId: string };
        return { record: this.requireMessageInTransaction(response.messageId), created: false };
      }
      const at = this.now();
      this.run(
        `INSERT INTO mailbox_messages(
          message_id, project_id, sender_json, schema_version, provider, mode, priority, sensitivity, status,
          created_at, expires_at, prompt_sha256, approval_ref, attempt, max_attempts, updated_at
        ) VALUES (?, ?, ?, 'bridge-mailbox-v3', ?, ?, ?, ?, 'preparing', ?, ?, ?, ?, 0, ?, ?)`,
        input.messageId,
        input.projectId,
        canonicalize(input.sender),
        input.provider,
        input.mode,
        input.priority,
        input.sensitivity,
        input.createdAt,
        input.expiresAt,
        input.promptSha256,
        input.approvalRef,
        input.maxAttempts,
        at,
      );
      this.run(
        `INSERT INTO mailbox_idempotency(principal_id, operation, idempotency_key, request_hash, response_json, created_at)
         VALUES (?, 'mailbox.send', ?, ?, ?, ?)`,
        input.sender.principalId,
        input.idempotencyKey,
        input.requestHash,
        canonicalize({ messageId: input.messageId }),
        at,
      );
      this.appendEvent("mailbox.message_reserved", input.messageId, {
        projectId: input.projectId,
        provider: input.provider,
        sender: input.sender,
        promptSha256: input.promptSha256,
        approvalRef: input.approvalRef,
        expiresAt: input.expiresAt,
      });
      return { record: this.requireMessageInTransaction(input.messageId), created: true };
    });
  }

  activateMessage(messageId: string, envelopeSha256: string, envelopeRelativePath: string, readyRelativePath: string): MailboxMessageRecord {
    return this.transaction(() => {
      const current = this.requireMessageRow(messageId);
      if (current.status !== "preparing") {
        invariant(
          current.envelope_sha256 === envelopeSha256 && current.envelope_relative_path === envelopeRelativePath,
          "mailbox_message_activation_conflict",
        );
        return rowToRecord(current);
      }
      const at = this.now();
      this.run(
        `UPDATE mailbox_messages SET status = 'queued', envelope_sha256 = ?, envelope_relative_path = ?,
          ready_relative_path = ?, updated_at = ? WHERE message_id = ? AND status = 'preparing'`,
        envelopeSha256,
        envelopeRelativePath,
        readyRelativePath,
        at,
        messageId,
      );
      this.appendEvent("mailbox.message_queued", messageId, { envelopeSha256, envelopeRelativePath });
      return this.requireMessageInTransaction(messageId);
    });
  }

  failPreparation(messageId: string, errorCode: string): MailboxMessageRecord {
    return this.transaction(() => {
      const current = this.requireMessageRow(messageId);
      if (current.status !== "preparing") return rowToRecord(current);
      this.run(
        "UPDATE mailbox_messages SET status = 'failed', last_error = ?, updated_at = ? WHERE message_id = ?",
        cleanError(errorCode), this.now(), messageId,
      );
      this.appendEvent("mailbox.message_failed", messageId, { phase: "preparing", errorCode: cleanError(errorCode) });
      return this.requireMessageInTransaction(messageId);
    });
  }

  claimNext(provider: MailboxProvider, consumerId: string, leaseMs: number): ClaimedMessageMetadata | undefined {
    validateProvider(provider);
    validateId(consumerId);
    invariant(Number.isSafeInteger(leaseMs) && leaseMs >= 30_000 && leaseMs <= 24 * 60 * 60_000, "mailbox_lease_invalid");
    return this.transaction(() => {
      this.sweepExpiredInTransaction();
      const now = this.now();
      const row = this.get<MessageRow>(
        `SELECT * FROM mailbox_messages
         WHERE provider = ? AND status = 'queued' AND expires_at > ? AND attempt < max_attempts
         ORDER BY CASE priority WHEN 'high' THEN 0 ELSE 1 END, created_at, message_id LIMIT 1`,
        provider,
        now,
      );
      if (!row) return undefined;
      invariant(row.envelope_sha256 && row.envelope_relative_path && row.ready_relative_path, "mailbox_envelope_not_ready");
      const deliveryId = newId("mailbox.delivery");
      const deliveryToken = crypto.randomBytes(32).toString("base64url");
      const leaseExpiresAt = new Date(Date.parse(now) + leaseMs).toISOString();
      this.run(
        `INSERT INTO mailbox_deliveries(
          delivery_id, message_id, schema_version, provider, consumer_id, delivery_token_hash, status,
          claimed_at, lease_expires_at, updated_at
        ) VALUES (?, ?, 'bridge-mailbox-v3', ?, ?, ?, 'claimed', ?, ?, ?)`,
        deliveryId,
        row.message_id,
        provider,
        consumerId,
        sha256(Buffer.from(deliveryToken, "utf8")),
        now,
        leaseExpiresAt,
        now,
      );
      this.run(
        `UPDATE mailbox_messages SET status = 'claimed', attempt = attempt + 1,
          active_delivery_id = ?, updated_at = ? WHERE message_id = ? AND status = 'queued'`,
        deliveryId,
        now,
        row.message_id,
      );
      this.appendEvent("mailbox.delivery_claimed", row.message_id, { deliveryId, consumerId, provider, leaseExpiresAt });
      const message = this.requireMessageRow(row.message_id);
      return {
        deliveryId,
        deliveryToken,
        consumerId,
        claimedAt: now,
        leaseExpiresAt,
        message: { ...rowToRecord(message), readyRelativePath: message.ready_relative_path! },
      };
    });
  }

  markDeliveryPhase(deliveryId: string, deliveryToken: string, phase: "dispatching" | "sent"): MailboxMessageRecord {
    return this.transaction(() => {
      const delivery = this.requireActiveDelivery(deliveryId, deliveryToken);
      const allowed = phase === "dispatching" ? ["claimed"] : ["dispatching"];
      invariant(allowed.includes(delivery.status), "mailbox_delivery_phase_invalid", { current: delivery.status, requested: phase });
      const at = this.now();
      this.run("UPDATE mailbox_deliveries SET status = ?, updated_at = ? WHERE delivery_id = ?", phase, at, deliveryId);
      this.run("UPDATE mailbox_messages SET status = ?, updated_at = ? WHERE message_id = ? AND active_delivery_id = ?", phase, at, delivery.message_id, deliveryId);
      this.appendEvent(`mailbox.delivery_${phase}`, delivery.message_id, { deliveryId, consumerId: delivery.consumer_id });
      return this.requireMessageInTransaction(delivery.message_id);
    });
  }

  heartbeat(deliveryId: string, deliveryToken: string, extensionMs: number): { leaseExpiresAt: string } {
    return this.transaction(() => {
      const delivery = this.requireActiveDelivery(deliveryId, deliveryToken);
      invariant(["claimed", "dispatching", "sent"].includes(delivery.status), "mailbox_delivery_not_heartbeatable");
      invariant(Number.isSafeInteger(extensionMs) && extensionMs >= 30_000 && extensionMs <= 60 * 60_000, "mailbox_heartbeat_extension_invalid");
      const currentExpiry = Date.parse(delivery.lease_expires_at);
      const candidateExpiry = Date.parse(this.now()) + extensionMs;
      const leaseExpiresAt = new Date(Math.max(currentExpiry, candidateExpiry)).toISOString();
      this.run("UPDATE mailbox_deliveries SET lease_expires_at = ?, updated_at = ? WHERE delivery_id = ?", leaseExpiresAt, this.now(), deliveryId);
      return { leaseExpiresAt };
    });
  }

  prepareResponse(deliveryId: string, deliveryToken: string, responseContentSha256: string): PreparedResponse {
    invariant(/^[a-f0-9]{64}$/u.test(responseContentSha256), "mailbox_response_content_hash_invalid");
    return this.transaction(() => {
      const delivery = this.requireDeliveryToken(deliveryId, deliveryToken);
      invariant(["dispatching", "sent", "completed"].includes(delivery.status), "mailbox_delivery_not_completable");
      if (delivery.status !== "completed") {
        invariant(Date.parse(delivery.lease_expires_at) > Date.parse(this.now()), "mailbox_delivery_lease_expired");
      }
      if (delivery.response_id) {
        invariant(
          delivery.response_content_sha256 === responseContentSha256 && delivery.response_created_at,
          "mailbox_response_retry_conflict",
        );
      } else {
        const responseId = newId("mailbox.response");
        const createdAt = this.now();
        this.run(
          `UPDATE mailbox_deliveries SET response_id = ?, response_created_at = ?,
            response_content_sha256 = ?, updated_at = ? WHERE delivery_id = ?`,
          responseId, createdAt, responseContentSha256, createdAt, deliveryId,
        );
        this.appendEvent("mailbox.response_reserved", delivery.message_id, {
          deliveryId,
          responseId,
          responseContentSha256,
        });
      }
      const prepared = this.requireDeliveryToken(deliveryId, deliveryToken);
      return {
        responseId: prepared.response_id!,
        createdAt: prepared.response_created_at!,
        message: this.requireMessageInTransaction(prepared.message_id),
        provider: activeProvider(prepared.provider),
        consumerId: prepared.consumer_id,
      };
    });
  }

  completeDelivery(input: CompleteDeliveryInput): MailboxMessageRecord {
    invariant(/^[a-f0-9]{64}$/u.test(input.responseSha256), "mailbox_response_hash_invalid");
    return this.transaction(() => {
      const delivery = this.requireDeliveryToken(input.deliveryId, input.deliveryToken);
      if (delivery.status === "completed") {
        invariant(
          delivery.response_sha256 === input.responseSha256 && delivery.response_relative_path === input.responseRelativePath,
          "mailbox_response_retry_conflict",
        );
        return this.requireMessageInTransaction(delivery.message_id);
      }
      invariant(["dispatching", "sent"].includes(delivery.status), "mailbox_delivery_not_completable");
      invariant(Date.parse(delivery.lease_expires_at) > Date.parse(this.now()), "mailbox_delivery_lease_expired");
      invariant(delivery.response_id && delivery.response_created_at && delivery.response_content_sha256, "mailbox_response_not_reserved");
      const at = this.now();
      this.run(
        `UPDATE mailbox_deliveries SET status = 'completed', response_sha256 = ?, response_relative_path = ?,
          completed_at = ?, updated_at = ? WHERE delivery_id = ?`,
        input.responseSha256,
        input.responseRelativePath,
        at,
        at,
        input.deliveryId,
      );
      this.run(
        `UPDATE mailbox_messages SET status = 'completed', response_sha256 = ?, response_relative_path = ?,
          active_delivery_id = NULL, updated_at = ? WHERE message_id = ? AND active_delivery_id = ?`,
        input.responseSha256,
        input.responseRelativePath,
        at,
        delivery.message_id,
        input.deliveryId,
      );
      this.appendEvent("mailbox.delivery_completed", delivery.message_id, {
        deliveryId: input.deliveryId,
        consumerId: delivery.consumer_id,
        responseSha256: input.responseSha256,
        responseRelativePath: input.responseRelativePath,
      });
      return this.requireMessageInTransaction(delivery.message_id);
    });
  }

  failDelivery(deliveryId: string, deliveryToken: string, errorCode: string, retryable: boolean): MailboxMessageRecord {
    return this.transaction(() => {
      const delivery = this.requireActiveDelivery(deliveryId, deliveryToken);
      const message = this.requireMessageRow(delivery.message_id);
      const at = this.now();
      const error = cleanError(errorCode);
      let deliveryStatus: MailboxDeliveryStatus;
      let messageStatus: MailboxMessageStatus;
      if (delivery.status === "claimed" && retryable && message.attempt < message.max_attempts && Date.parse(message.expires_at) > Date.parse(at)) {
        deliveryStatus = "released";
        messageStatus = "queued";
      } else if (delivery.status === "dispatching" || delivery.status === "sent") {
        deliveryStatus = "uncertain";
        messageStatus = "uncertain";
      } else {
        deliveryStatus = "failed";
        messageStatus = "failed";
      }
      this.run(
        "UPDATE mailbox_deliveries SET status = ?, error_code = ?, completed_at = ?, updated_at = ? WHERE delivery_id = ?",
        deliveryStatus, error, at, at, deliveryId,
      );
      this.run(
        "UPDATE mailbox_messages SET status = ?, active_delivery_id = NULL, last_error = ?, updated_at = ? WHERE message_id = ?",
        messageStatus, error, at, delivery.message_id,
      );
      this.appendEvent("mailbox.delivery_failed", delivery.message_id, {
        deliveryId,
        priorPhase: delivery.status,
        disposition: messageStatus,
        retryable,
        errorCode: error,
      });
      return this.requireMessageInTransaction(delivery.message_id);
    });
  }

  getMessage(messageId: string): MailboxMessageRecord | undefined {
    const row = this.get<MessageRow>("SELECT * FROM mailbox_messages WHERE message_id = ?", messageId);
    return row ? rowToRecord(row) : undefined;
  }

  getMessagePaths(messageId: string): { envelopeRelativePath: string; readyRelativePath: string } | undefined {
    const row = this.get<MessageRow>("SELECT * FROM mailbox_messages WHERE message_id = ?", messageId);
    if (!row?.envelope_relative_path || !row.ready_relative_path) return undefined;
    return { envelopeRelativePath: row.envelope_relative_path, readyRelativePath: row.ready_relative_path };
  }

  listMessages(filters: { provider?: MailboxProvider; status?: MailboxMessageStatus; limit?: number } = {}): MailboxMessageRecord[] {
    const limit = Math.min(Math.max(filters.limit ?? 100, 1), 500);
    if (filters.provider && filters.status) {
      validateProvider(filters.provider);
      return this.all<MessageRow>(
        "SELECT * FROM mailbox_messages WHERE provider = ? AND status = ? ORDER BY created_at DESC LIMIT ?",
        filters.provider, filters.status, limit,
      ).map(rowToRecord);
    }
    if (filters.provider) {
      validateProvider(filters.provider);
      return this.all<MessageRow>("SELECT * FROM mailbox_messages WHERE provider = ? ORDER BY created_at DESC LIMIT ?", filters.provider, limit).map(rowToRecord);
    }
    if (filters.status) return this.all<MessageRow>("SELECT * FROM mailbox_messages WHERE status = ? ORDER BY created_at DESC LIMIT ?", filters.status, limit).map(rowToRecord);
    return this.all<MessageRow>("SELECT * FROM mailbox_messages ORDER BY created_at DESC LIMIT ?", limit).map(rowToRecord);
  }

  health(): Record<string, unknown> {
    const integrity = this.get<{ integrity_check: string }>("PRAGMA integrity_check")?.integrity_check;
    const counts = this.all<{ status: string; count: number }>("SELECT status, COUNT(*) AS count FROM mailbox_messages GROUP BY status ORDER BY status");
    return {
      ok: integrity === "ok",
      databasePath: this.databasePath,
      journalMode: this.get<{ journal_mode: string }>("PRAGMA journal_mode")?.journal_mode,
      integrity,
      messages: Object.fromEntries(counts.map((row) => [row.status, Number(row.count)])),
      legacyGeminiMessages: Number(this.get<{ count: number }>("SELECT COUNT(*) AS count FROM mailbox_messages WHERE provider = 'gemini'")?.count ?? 0),
      events: Number(this.get<{ count: number }>("SELECT COUNT(*) AS count FROM mailbox_events")?.count ?? 0),
      auditMirrorPath: this.auditMirrorPath,
      auditMirror: this.verifyAuditMirror(),
    };
  }

  flushAuditMirror(): void {
    invariant(!this.inWrite, "mailbox_audit_flush_during_transaction");
    fs.mkdirSync(path.dirname(this.auditMirrorPath), { recursive: true, mode: 0o700 });
    while (true) {
      this.database.exec("BEGIN IMMEDIATE");
      try {
        this.assertAuditMirrorPrefix();
        const row = this.get<{
          sequence: number;
          event_id: string;
          event_type: string;
          message_id: string | null;
          occurred_at: string;
          payload_json: string;
          previous_hash: string | null;
          event_hash: string;
        }>("SELECT * FROM mailbox_events WHERE file_appended = 0 ORDER BY sequence LIMIT 1");
        if (!row) {
          this.database.exec("COMMIT");
          return;
        }
        const entry = eventEnvelope(row);
        const last = lastJsonLine(this.auditMirrorPath) as ReturnType<typeof eventEnvelope> | undefined;
        if (last?.sequence === entry.sequence && last.eventHash === entry.eventHash) {
          this.run("UPDATE mailbox_events SET file_appended = 1 WHERE sequence = ?", entry.sequence);
          this.database.exec("COMMIT");
          continue;
        }
        invariant(
          last ? entry.sequence === last.sequence + 1 && entry.previousHash === last.eventHash : entry.sequence === 1 && entry.previousHash === null,
          "mailbox_audit_chain_mismatch",
        );
        fs.appendFileSync(this.auditMirrorPath, `${canonicalize(entry)}\n`, { encoding: "utf8", flag: "a", mode: 0o600 });
        this.run("UPDATE mailbox_events SET file_appended = 1 WHERE sequence = ?", entry.sequence);
        this.database.exec("COMMIT");
      } catch (error) {
        try { this.database.exec("ROLLBACK"); } catch {}
        throw error;
      }
    }
  }

  verifyAuditMirror(): { ok: true; count: number; lastHash?: string } {
    if (!fs.existsSync(this.auditMirrorPath)) return { ok: true, count: 0 };
    const text = fs.readFileSync(this.auditMirrorPath, "utf8");
    invariant(text === "" || text.endsWith("\n"), "mailbox_audit_chain_mismatch");
    const lines = text.trimEnd() ? text.trimEnd().split("\n") : [];
    let previous: string | null = null;
    for (let index = 0; index < lines.length; index += 1) {
      const entry = JSON.parse(lines[index]) as {
        sequence: number;
        eventId: string;
        eventType: string;
        messageId: string | null;
        occurredAt: string;
        payload: Record<string, unknown>;
        previousHash: string | null;
        eventHash: string;
      };
      invariant(entry.sequence === index + 1 && entry.previousHash === previous, "mailbox_audit_chain_mismatch");
      invariant(hashCanonical({
        sequence: entry.sequence,
        eventId: entry.eventId,
        eventType: entry.eventType,
        messageId: entry.messageId,
        occurredAt: entry.occurredAt,
        payload: entry.payload,
        previousHash: entry.previousHash,
      }) === entry.eventHash, "mailbox_audit_hash_mismatch");
      previous = entry.eventHash;
    }
    return { ok: true, count: lines.length, ...(previous ? { lastHash: previous } : {}) };
  }

  verifyEventChain(): { ok: true; count: number; lastHash?: string } {
    const rows = this.all<{
      sequence: number;
      event_id: string;
      event_type: string;
      message_id: string | null;
      occurred_at: string;
      payload_json: string;
      previous_hash: string | null;
      event_hash: string;
    }>("SELECT * FROM mailbox_events ORDER BY sequence");
    let previous: string | null = null;
    for (const row of rows) {
      invariant(row.previous_hash === previous, "mailbox_event_previous_hash_mismatch", { sequence: row.sequence });
      const expected = hashCanonical({
        sequence: Number(row.sequence),
        eventId: row.event_id,
        eventType: row.event_type,
        messageId: row.message_id,
        occurredAt: row.occurred_at,
        payload: JSON.parse(row.payload_json),
        previousHash: row.previous_hash,
      });
      invariant(expected === row.event_hash, "mailbox_event_hash_mismatch", { sequence: row.sequence });
      previous = row.event_hash;
    }
    return { ok: true, count: rows.length, ...(previous ? { lastHash: previous } : {}) };
  }

  private assertAuditMirrorPrefix(): void {
    const verified = this.verifyAuditMirror();
    if (verified.count === 0) return;
    const lines = fs.readFileSync(this.auditMirrorPath, "utf8").trimEnd().split("\n");
    const rows = this.all<{ sequence: number; event_hash: string }>(
      "SELECT sequence, event_hash FROM mailbox_events ORDER BY sequence LIMIT ?",
      lines.length,
    );
    invariant(rows.length === lines.length, "mailbox_audit_chain_mismatch");
    for (let index = 0; index < lines.length; index += 1) {
      const entry = JSON.parse(lines[index]) as { sequence: number; eventHash: string };
      invariant(Number(rows[index].sequence) === entry.sequence && rows[index].event_hash === entry.eventHash, "mailbox_audit_database_mismatch");
    }
  }

  private sweepExpiredInTransaction(): void {
    const now = this.now();
    const expiredQueued = this.all<MessageRow>(
      "SELECT * FROM mailbox_messages WHERE status IN ('preparing','queued') AND expires_at <= ?",
      now,
    );
    for (const message of expiredQueued) {
      this.run("UPDATE mailbox_messages SET status = 'expired', updated_at = ? WHERE message_id = ?", now, message.message_id);
      this.appendEvent("mailbox.message_expired", message.message_id, { priorStatus: message.status });
    }
    const expiredDeliveries = this.all<DeliveryRow>(
      "SELECT * FROM mailbox_deliveries WHERE status IN ('claimed','dispatching','sent') AND lease_expires_at <= ?",
      now,
    );
    for (const delivery of expiredDeliveries) {
      const message = this.requireMessageRow(delivery.message_id);
      const beforeDispatch = delivery.status === "claimed";
      const retry = beforeDispatch && message.attempt < message.max_attempts && Date.parse(message.expires_at) > Date.parse(now);
      const deliveryStatus: MailboxDeliveryStatus = retry ? "released" : beforeDispatch ? "failed" : "uncertain";
      const messageStatus: MailboxMessageStatus = retry ? "queued" : beforeDispatch ? "failed" : "uncertain";
      this.run(
        "UPDATE mailbox_deliveries SET status = ?, error_code = 'lease_expired', completed_at = ?, updated_at = ? WHERE delivery_id = ?",
        deliveryStatus, now, now, delivery.delivery_id,
      );
      this.run(
        "UPDATE mailbox_messages SET status = ?, active_delivery_id = NULL, last_error = 'lease_expired', updated_at = ? WHERE message_id = ?",
        messageStatus, now, delivery.message_id,
      );
      this.appendEvent("mailbox.delivery_lease_expired", delivery.message_id, {
        deliveryId: delivery.delivery_id,
        priorPhase: delivery.status,
        disposition: messageStatus,
      });
    }
  }

  private requireActiveDelivery(deliveryId: string, deliveryToken: string): DeliveryRow {
    const delivery = this.requireDeliveryToken(deliveryId, deliveryToken);
    invariant(Date.parse(delivery.lease_expires_at) > Date.parse(this.now()), "mailbox_delivery_lease_expired");
    return delivery;
  }

  private requireDeliveryToken(deliveryId: string, deliveryToken: string): DeliveryRow {
    validateId(deliveryId, "mailbox.delivery.");
    invariant(typeof deliveryToken === "string" && deliveryToken.length >= 40, "mailbox_delivery_token_invalid");
    const delivery = this.get<DeliveryRow>("SELECT * FROM mailbox_deliveries WHERE delivery_id = ?", deliveryId);
    invariant(delivery, "mailbox_delivery_not_found");
    invariant(delivery.delivery_token_hash === sha256(Buffer.from(deliveryToken, "utf8")), "mailbox_delivery_token_mismatch");
    return delivery;
  }

  private appendEvent(eventType: string, messageId: string | null, payload: Record<string, unknown>): void {
    invariant(this.inWrite, "mailbox_write_transaction_required");
    const prior = this.get<{ sequence: number; event_hash: string }>("SELECT sequence, event_hash FROM mailbox_events ORDER BY sequence DESC LIMIT 1");
    const sequence = Number(prior?.sequence ?? 0) + 1;
    const eventId = newId("mailbox.event");
    const occurredAt = this.now();
    const previousHash = prior?.event_hash ?? null;
    const eventHash = hashCanonical({ sequence, eventId, eventType, messageId, occurredAt, payload, previousHash });
    this.run(
      `INSERT INTO mailbox_events(sequence, event_id, event_type, message_id, occurred_at, payload_json, previous_hash, event_hash)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?)`,
      sequence, eventId, eventType, messageId, occurredAt, canonicalize(payload), previousHash, eventHash,
    );
  }

  private transaction<T>(run: () => T): T {
    invariant(!this.inWrite, "mailbox_nested_transaction_forbidden");
    this.database.exec("BEGIN IMMEDIATE");
    this.inWrite = true;
    try {
      const value = run();
      this.database.exec("COMMIT");
      this.inWrite = false;
      this.flushAuditMirror();
      return value;
    } catch (error) {
      try { this.database.exec("ROLLBACK"); } catch {}
      this.inWrite = false;
      throw error;
    }
  }

  private requireMessageRow(messageId: string): MessageRow {
    const row = this.get<MessageRow>("SELECT * FROM mailbox_messages WHERE message_id = ?", messageId);
    invariant(row, "mailbox_message_not_found", { messageId });
    return row;
  }

  private requireMessageInTransaction(messageId: string): MailboxMessageRecord {
    return rowToRecord(this.requireMessageRow(messageId));
  }

  private get<T>(sql: string, ...params: any[]): T | undefined {
    return this.database.prepare(sql).get(...params) as T | undefined;
  }

  private all<T>(sql: string, ...params: any[]): T[] {
    return this.database.prepare(sql).all(...params) as T[];
  }

  private run(sql: string, ...params: any[]): void {
    this.database.prepare(sql).run(...params);
  }

  private bootstrap(): void {
    const currentVersion = Number(this.get<{ user_version: number }>("PRAGMA user_version")?.user_version ?? 0);
    invariant(currentVersion !== 1 && currentVersion !== 2, "mailbox_database_migration_required");
    invariant(currentVersion === 0 || currentVersion === 3, "mailbox_database_version_unsupported", { currentVersion });
    if (currentVersion === 0) this.database.exec(`
      CREATE TABLE IF NOT EXISTS mailbox_metadata (
        key TEXT PRIMARY KEY,
        value TEXT NOT NULL
      ) STRICT;
      CREATE TABLE IF NOT EXISTS mailbox_messages (
        message_id TEXT PRIMARY KEY,
        project_id TEXT NOT NULL,
        sender_json TEXT NOT NULL CHECK (json_valid(sender_json)),
        schema_version TEXT NOT NULL CHECK (schema_version IN ('bridge-mailbox-v1','bridge-mailbox-v2','bridge-mailbox-v3')),
        provider TEXT NOT NULL CHECK (provider IN ('chatgpt','antigravity','web','gemini')),
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
      CREATE INDEX IF NOT EXISTS mailbox_messages_queue_idx
        ON mailbox_messages(provider, status, priority, created_at);
      CREATE TABLE IF NOT EXISTS mailbox_deliveries (
        delivery_id TEXT PRIMARY KEY,
        message_id TEXT NOT NULL REFERENCES mailbox_messages(message_id),
        schema_version TEXT NOT NULL CHECK (schema_version IN ('bridge-mailbox-v1','bridge-mailbox-v2','bridge-mailbox-v3')),
        provider TEXT NOT NULL CHECK (provider IN ('chatgpt','antigravity','web','gemini')),
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
      CREATE UNIQUE INDEX IF NOT EXISTS mailbox_one_active_delivery
        ON mailbox_deliveries(message_id)
        WHERE status IN ('claimed','dispatching','sent');
      CREATE TRIGGER IF NOT EXISTS mailbox_messages_no_new_legacy_provider BEFORE INSERT ON mailbox_messages
      WHEN NEW.provider = 'gemini'
      BEGIN SELECT RAISE(ABORT, 'retired_mailbox_provider'); END;
      CREATE TRIGGER IF NOT EXISTS mailbox_deliveries_no_new_legacy_provider BEFORE INSERT ON mailbox_deliveries
      WHEN NEW.provider = 'gemini'
      BEGIN SELECT RAISE(ABORT, 'retired_mailbox_provider'); END;
      CREATE TRIGGER IF NOT EXISTS mailbox_messages_current_schema_only BEFORE INSERT ON mailbox_messages
      WHEN NEW.schema_version != 'bridge-mailbox-v3'
      BEGIN SELECT RAISE(ABORT, 'stale_mailbox_writer'); END;
      CREATE TRIGGER IF NOT EXISTS mailbox_deliveries_current_schema_only BEFORE INSERT ON mailbox_deliveries
      WHEN NEW.schema_version != 'bridge-mailbox-v3'
      BEGIN SELECT RAISE(ABORT, 'stale_mailbox_writer'); END;
      CREATE TRIGGER IF NOT EXISTS mailbox_legacy_gemini_messages_read_only BEFORE UPDATE ON mailbox_messages
      WHEN OLD.provider = 'gemini'
      BEGIN SELECT RAISE(ABORT, 'immutable_mailbox_legacy_gemini_message'); END;
      CREATE TRIGGER IF NOT EXISTS mailbox_legacy_gemini_deliveries_read_only BEFORE UPDATE ON mailbox_deliveries
      WHEN OLD.provider = 'gemini'
      BEGIN SELECT RAISE(ABORT, 'immutable_mailbox_legacy_gemini_delivery'); END;
      CREATE TABLE IF NOT EXISTS mailbox_idempotency (
        principal_id TEXT NOT NULL,
        operation TEXT NOT NULL,
        idempotency_key TEXT NOT NULL,
        request_hash TEXT NOT NULL CHECK (length(request_hash) = 64),
        response_json TEXT NOT NULL CHECK (json_valid(response_json)),
        created_at TEXT NOT NULL,
        PRIMARY KEY (principal_id, operation, idempotency_key)
      ) STRICT;
      CREATE TABLE IF NOT EXISTS mailbox_events (
        sequence INTEGER PRIMARY KEY,
        event_id TEXT NOT NULL UNIQUE,
        event_type TEXT NOT NULL,
        message_id TEXT,
        occurred_at TEXT NOT NULL,
        payload_json TEXT NOT NULL CHECK (json_valid(payload_json)),
        previous_hash TEXT,
        event_hash TEXT NOT NULL UNIQUE CHECK (length(event_hash) = 64)
        ,file_appended INTEGER NOT NULL DEFAULT 0 CHECK (file_appended IN (0,1))
      ) STRICT;
      CREATE TRIGGER IF NOT EXISTS mailbox_events_no_update BEFORE UPDATE ON mailbox_events
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
      CREATE TRIGGER IF NOT EXISTS mailbox_events_no_delete BEFORE DELETE ON mailbox_events
        BEGIN SELECT RAISE(ABORT, 'immutable_mailbox_event'); END;
      CREATE TRIGGER IF NOT EXISTS mailbox_idempotency_no_update BEFORE UPDATE ON mailbox_idempotency
        BEGIN SELECT RAISE(ABORT, 'immutable_mailbox_idempotency'); END;
      CREATE TRIGGER IF NOT EXISTS mailbox_idempotency_no_delete BEFORE DELETE ON mailbox_idempotency
        BEGIN SELECT RAISE(ABORT, 'immutable_mailbox_idempotency'); END;
      CREATE TRIGGER IF NOT EXISTS mailbox_message_content_immutable BEFORE UPDATE ON mailbox_messages
      WHEN OLD.message_id IS NOT NEW.message_id
        OR OLD.project_id IS NOT NEW.project_id
        OR OLD.sender_json IS NOT NEW.sender_json
        OR OLD.schema_version IS NOT NEW.schema_version
        OR OLD.provider IS NOT NEW.provider
        OR OLD.mode IS NOT NEW.mode
        OR OLD.priority IS NOT NEW.priority
        OR OLD.sensitivity IS NOT NEW.sensitivity
        OR OLD.created_at IS NOT NEW.created_at
        OR OLD.expires_at IS NOT NEW.expires_at
        OR OLD.prompt_sha256 IS NOT NEW.prompt_sha256
        OR OLD.approval_ref IS NOT NEW.approval_ref
        OR OLD.max_attempts IS NOT NEW.max_attempts
      BEGIN SELECT RAISE(ABORT, 'immutable_mailbox_message_content'); END;
      CREATE TRIGGER IF NOT EXISTS mailbox_messages_no_delete BEFORE DELETE ON mailbox_messages
        BEGIN SELECT RAISE(ABORT, 'immutable_mailbox_message_history'); END;
      CREATE TRIGGER IF NOT EXISTS mailbox_delivery_binding_immutable BEFORE UPDATE ON mailbox_deliveries
      WHEN OLD.delivery_id IS NOT NEW.delivery_id
        OR OLD.message_id IS NOT NEW.message_id
        OR OLD.schema_version IS NOT NEW.schema_version
        OR OLD.provider IS NOT NEW.provider
        OR OLD.consumer_id IS NOT NEW.consumer_id
        OR OLD.delivery_token_hash IS NOT NEW.delivery_token_hash
        OR OLD.claimed_at IS NOT NEW.claimed_at
      BEGIN SELECT RAISE(ABORT, 'immutable_mailbox_delivery_binding'); END;
      CREATE TRIGGER IF NOT EXISTS mailbox_deliveries_no_delete BEFORE DELETE ON mailbox_deliveries
        BEGIN SELECT RAISE(ABORT, 'immutable_mailbox_delivery_history'); END;
      INSERT OR IGNORE INTO mailbox_metadata(key, value) VALUES ('schema_version', 'bridge-mailbox-v3');
      PRAGMA user_version = 3;
    `);
    const schemaVersion = this.get<{ value: string }>("SELECT value FROM mailbox_metadata WHERE key = 'schema_version'")?.value;
    invariant(schemaVersion === "bridge-mailbox-v3", "mailbox_database_schema_mismatch");
  }
}

function eventEnvelope(row: {
  sequence: number;
  event_id: string;
  event_type: string;
  message_id: string | null;
  occurred_at: string;
  payload_json: string;
  previous_hash: string | null;
  event_hash: string;
}) {
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

function lastJsonLine(filePath: string): unknown | undefined {
  if (!fs.existsSync(filePath)) return undefined;
  const text = fs.readFileSync(filePath, "utf8").trimEnd();
  if (!text) return undefined;
  return JSON.parse(text.slice(text.lastIndexOf("\n") + 1)) as unknown;
}

function rowToRecord(row: MessageRow): MailboxMessageRecord {
  return {
    messageId: row.message_id,
    projectId: row.project_id,
    sender: JSON.parse(row.sender_json) as MailboxIdentity,
    provider: row.provider,
    ...(row.provider === "gemini" ? { legacyProvider: true as const } : {}),
    mode: row.mode,
    priority: row.priority,
    sensitivity: row.sensitivity,
    status: row.status,
    createdAt: row.created_at,
    expiresAt: row.expires_at,
    promptSha256: row.prompt_sha256,
    approvalRef: row.approval_ref,
    ...(row.envelope_sha256 ? { envelopeSha256: row.envelope_sha256 } : {}),
    ...(row.envelope_relative_path ? { envelopeRelativePath: row.envelope_relative_path } : {}),
    attempt: Number(row.attempt),
    ...(row.active_delivery_id ? { activeDeliveryId: row.active_delivery_id } : {}),
    ...(row.response_sha256 ? { responseSha256: row.response_sha256 } : {}),
    ...(row.response_relative_path ? { responseRelativePath: row.response_relative_path } : {}),
    ...(row.last_error ? { lastError: row.last_error } : {}),
  };
}

function validateIdentity(identity: MailboxIdentity): void {
  validateId(identity.principalId);
  validateId(identity.sessionId);
  validateId(identity.hostId);
}

function validateProvider(provider: MailboxProvider): void {
  invariant(provider === "chatgpt" || provider === "antigravity" || provider === "web", "mailbox_provider_invalid");
}

function activeProvider(provider: MailboxStoredProvider): MailboxProvider {
  invariant(provider !== "gemini", "mailbox_legacy_provider_read_only");
  return provider;
}

function validateId(value: string, prefix?: string): void {
  invariant(typeof value === "string" && /^[A-Za-z0-9][A-Za-z0-9._:-]{2,179}$/u.test(value), "mailbox_identifier_invalid");
  if (prefix) invariant(value.startsWith(prefix), "mailbox_identifier_prefix_invalid", { prefix });
}

function cleanError(value: string): string {
  invariant(typeof value === "string" && value.length > 0, "mailbox_error_code_required");
  return value.replace(/[^A-Za-z0-9._:-]/gu, "_").slice(0, 200);
}
