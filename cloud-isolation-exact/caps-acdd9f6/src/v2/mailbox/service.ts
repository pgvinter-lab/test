import fs from "node:fs";
import { hashCanonical, sha256 } from "../core/canonical.js";
import { asErrorCode, invariant } from "../core/errors.js";
import { newId } from "../core/ids.js";
import { DriveMailboxExchange } from "./exchange.js";
import { mailboxBrokerUrl } from "./config.js";
import { MailboxStore } from "./store.js";
import {
  MAILBOX_SCHEMA_VERSION,
  type MailboxConfig,
  type MailboxDeliveryClaim,
  type MailboxMessageEnvelope,
  type MailboxMessageRecord,
  type MailboxMessageStatus,
  type MailboxProvider,
  type MailboxResponseEnvelope,
  type MailboxSendInput,
  type WebNodeProfile,
} from "./types.js";

const MAX_MESSAGE_BYTES = 1024 * 1024;
const MAX_LIFETIME_MS = 30 * 24 * 60 * 60_000;

export interface CompleteMailboxDeliveryInput {
  deliveryId: string;
  deliveryToken: string;
  response: string;
  conversationUrl?: string;
}

export interface WebNodeResult {
  message: MailboxMessageRecord;
  webNodeId: string;
  displayName: string;
  response?: string;
  conversationUrl?: string;
  driveOutputRelativePath?: string;
  driveOutputPath?: string;
}

export class MailboxService {
  readonly config: MailboxConfig;
  readonly store: MailboxStore;
  readonly exchange: DriveMailboxExchange;
  private readonly now: () => string;

  constructor(config: MailboxConfig, now: () => string = () => new Date().toISOString()) {
    this.config = config;
    this.now = now;
    this.store = new MailboxStore(config.databasePath, now, config.auditMirrorPath);
    this.exchange = new DriveMailboxExchange(config.exchangeRoot);
  }

  close(): void {
    this.store.close();
  }

  send(input: MailboxSendInput): MailboxMessageRecord {
    validateSend(input, this.config);
    const now = this.now();
    const expiresAt = input.expiresAt ?? new Date(Date.parse(now) + this.config.delivery.defaultExpiryMs).toISOString();
    validateLifetime(now, expiresAt);
    const promptSha256 = sha256(Buffer.from(input.prompt, "utf8"));
    const requestHash = hashCanonical({
      projectId: input.projectId,
      sender: input.sender,
      provider: input.provider,
      webNodeId: input.webNodeId ?? null,
      promptSha256,
      approvalRef: input.approvalRef,
      mode: input.mode ?? "default",
      priority: input.priority ?? "normal",
      sensitivity: input.sensitivity ?? "internal",
      expiresAt: input.expiresAt ?? "default",
    });
    const reserved = this.store.reserveMessage({
      messageId: newId("mailbox.message"),
      projectId: input.projectId,
      sender: input.sender,
      provider: input.provider,
      mode: input.mode ?? "default",
      priority: input.priority ?? "normal",
      sensitivity: input.sensitivity ?? "internal",
      createdAt: now,
      expiresAt,
      promptSha256,
      approvalRef: input.approvalRef,
      maxAttempts: this.config.delivery.maxPreDispatchAttempts,
      idempotencyKey: input.idempotencyKey,
      requestHash,
    });
    if (reserved.record.status !== "preparing") return reserved.record;

    const record = reserved.record;
    const envelope: MailboxMessageEnvelope = {
      schemaVersion: MAILBOX_SCHEMA_VERSION,
      kind: "message",
      messageId: record.messageId,
      projectId: record.projectId,
      sender: record.sender,
      recipient: input.provider,
      ...(input.webNodeId ? { webNodeId: input.webNodeId } : {}),
      mode: record.mode,
      priority: record.priority,
      sensitivity: record.sensitivity,
      createdAt: record.createdAt,
      expiresAt: record.expiresAt,
      promptSha256: record.promptSha256,
      prompt: input.prompt,
      dispatchAuthorization: {
        approvalRef: record.approvalRef,
        authorizedAt: record.createdAt,
        expiresAt: record.expiresAt,
        provider: input.provider,
        destination: providerDestination(input.provider, input.webNodeId, this.config),
        useCount: 1,
      },
    };
    try {
      const written = this.exchange.writeMessage(envelope);
      return this.store.activateMessage(
        record.messageId,
        written.sha256,
        written.relativePath,
        written.readyRelativePath,
      );
    } catch (error) {
      this.store.failPreparation(record.messageId, asErrorCode(error));
      throw error;
    }
  }

  take(provider: MailboxProvider, consumerId?: string): MailboxDeliveryClaim | undefined {
    validateProvider(provider);
    const providerConfig = this.config.providers[provider];
    invariant(providerConfig?.enabled, "mailbox_provider_disabled", { provider });
    const claim = this.store.claimNext(provider, consumerId ?? providerConfig.consumerId, this.config.delivery.leaseMs);
    if (!claim) return undefined;
    try {
      const envelope = this.exchange.readMessage(
        claim.message.envelopeRelativePath!,
        claim.message.readyRelativePath,
      );
      invariant(
        envelope.messageId === claim.message.messageId &&
        envelope.projectId === claim.message.projectId &&
        envelope.recipient === provider &&
        envelope.promptSha256 === claim.message.promptSha256 &&
        envelope.dispatchAuthorization.provider === provider &&
        destinationMatches(envelope, provider, this.config) &&
        envelope.dispatchAuthorization.useCount === 1,
        "mailbox_claim_envelope_mismatch",
      );
      return {
        deliveryId: claim.deliveryId,
        deliveryToken: claim.deliveryToken,
        consumerId: claim.consumerId,
        claimedAt: claim.claimedAt,
        leaseExpiresAt: claim.leaseExpiresAt,
        message: envelope,
      };
    } catch (error) {
      this.store.failDelivery(claim.deliveryId, claim.deliveryToken, asErrorCode(error), true);
      throw error;
    }
  }

  markDispatching(deliveryId: string, deliveryToken: string): MailboxMessageRecord {
    return this.store.markDeliveryPhase(deliveryId, deliveryToken, "dispatching");
  }

  markSent(deliveryId: string, deliveryToken: string): MailboxMessageRecord {
    return this.store.markDeliveryPhase(deliveryId, deliveryToken, "sent");
  }

  heartbeat(deliveryId: string, deliveryToken: string): { leaseExpiresAt: string } {
    return this.store.heartbeat(deliveryId, deliveryToken, this.config.delivery.heartbeatExtensionMs);
  }

  complete(input: CompleteMailboxDeliveryInput): MailboxMessageRecord {
    validateBoundedText(input.response, "mailbox_response_invalid");
    const responseSha256 = sha256(Buffer.from(input.response, "utf8"));
    const prepared = this.store.prepareResponse(input.deliveryId, input.deliveryToken, responseSha256);
    invariant(prepared.message.envelopeRelativePath, "mailbox_message_envelope_missing");
    const message = this.exchange.readMessage(prepared.message.envelopeRelativePath);
    validateConversationUrl(input.conversationUrl, message.dispatchAuthorization.destination);
    const envelope: MailboxResponseEnvelope = {
      schemaVersion: MAILBOX_SCHEMA_VERSION,
      kind: "response",
      responseId: prepared.responseId,
      messageId: prepared.message.messageId,
      deliveryId: input.deliveryId,
      projectId: prepared.message.projectId,
      provider: prepared.provider,
      consumerId: prepared.consumerId,
      createdAt: prepared.createdAt,
      responseSha256,
      response: input.response,
      ...(input.conversationUrl ? { conversationUrl: input.conversationUrl } : {}),
    };
    const written = this.exchange.writeResponse(envelope);
    if (prepared.provider === "web") {
      invariant(message.webNodeId, "web_node_message_required");
      const profile = webNode(this.config, message.webNodeId);
      this.exchange.writeWebNodeOutput(message, envelope, profile.displayName);
    }
    return this.store.completeDelivery({
      deliveryId: input.deliveryId,
      deliveryToken: input.deliveryToken,
      responseSha256: written.sha256,
      responseRelativePath: written.relativePath,
    });
  }

  fail(deliveryId: string, deliveryToken: string, errorCode: string, retryable = false): MailboxMessageRecord {
    return this.store.failDelivery(deliveryId, deliveryToken, errorCode, retryable);
  }

  get(messageId: string): MailboxMessageRecord | undefined {
    return this.store.getMessage(messageId);
  }

  list(filters: { provider?: MailboxProvider; status?: MailboxMessageStatus; limit?: number } = {}): MailboxMessageRecord[] {
    return this.store.listMessages(filters);
  }

  webNodeResult(messageId: string): WebNodeResult {
    const message = this.store.getMessage(messageId);
    invariant(message, "mailbox_message_not_found");
    invariant(message.provider === "web" && message.envelopeRelativePath, "web_node_message_required");
    const envelope = this.exchange.readMessage(message.envelopeRelativePath);
    invariant(envelope.webNodeId, "web_node_message_required");
    const profile = webNode(this.config, envelope.webNodeId);
    const result: WebNodeResult = {
      message,
      webNodeId: envelope.webNodeId,
      displayName: profile.displayName,
    };
    if (message.status !== "completed") return result;
    invariant(message.responseRelativePath, "mailbox_response_missing");
    const response = this.exchange.readResponse(message.responseRelativePath);
    invariant(response.messageId === message.messageId && response.provider === "web", "web_node_response_binding_invalid");
    const output = this.exchange.webNodeOutputPath(message.projectId, envelope.webNodeId, message.messageId);
    invariant(fs.existsSync(output.absolutePath), "web_node_drive_output_missing");
    return {
      ...result,
      response: response.response,
      ...(response.conversationUrl ? { conversationUrl: response.conversationUrl } : {}),
      driveOutputRelativePath: output.relativePath,
      driveOutputPath: output.absolutePath,
    };
  }

  doctor(): Record<string, unknown> {
    const state = fs.lstatSync(this.config.stateDirectory);
    const exchange = fs.lstatSync(this.config.exchangeRoot);
    const database = this.store.health();
    const eventChain = this.store.verifyEventChain();
    return {
      ok: database.ok === true && state.isDirectory() && !state.isSymbolicLink() && exchange.isDirectory() && !exchange.isSymbolicLink(),
      schemaVersion: MAILBOX_SCHEMA_VERSION,
      stateDirectory: this.config.stateDirectory,
      exchangeRoot: this.config.exchangeRoot,
      broker: mailboxBrokerUrl(this.config),
      database,
      eventChain,
      providers: this.config.providers,
      webNodes: Object.fromEntries(Object.entries(this.config.webNodes).map(([nodeId, profile]) => [
        nodeId,
        { enabled: profile.enabled, displayName: profile.displayName, origin: profile.origin },
      ])),
    };
  }
}

function validateSend(input: MailboxSendInput, config: MailboxConfig): void {
  validateProvider(input.provider);
  if (input.provider === "web") {
    invariant(typeof input.webNodeId === "string", "web_node_id_required");
    webNode(config, input.webNodeId);
  } else {
    invariant(input.webNodeId === undefined, "web_node_id_not_supported");
  }
  invariant(input.sensitivity === undefined || input.sensitivity === "public" || input.sensitivity === "internal", "mailbox_sensitivity_not_supported");
  invariant(typeof input.projectId === "string" && input.projectId.trim().length >= 3 && input.projectId.length <= 300, "mailbox_project_id_invalid");
  for (const value of [input.sender?.principalId, input.sender?.sessionId, input.sender?.hostId]) {
    invariant(typeof value === "string" && /^[A-Za-z0-9][A-Za-z0-9._:-]{2,179}$/u.test(value), "mailbox_identity_invalid");
  }
  validateBoundedText(input.prompt, "mailbox_prompt_invalid");
  invariant(typeof input.idempotencyKey === "string" && input.idempotencyKey.length >= 8 && input.idempotencyKey.length <= 300, "mailbox_idempotency_key_invalid");
  invariant(typeof input.approvalRef === "string" && /^[A-Za-z0-9][A-Za-z0-9._:-]{2,180}$/u.test(input.approvalRef), "mailbox_approval_ref_invalid");
}

function validateBoundedText(value: string, code: string): void {
  invariant(typeof value === "string" && value.trim().length > 0 && Buffer.byteLength(value, "utf8") <= MAX_MESSAGE_BYTES, code);
}

function validateLifetime(now: string, expiresAt: string): void {
  const start = Date.parse(now);
  const end = Date.parse(expiresAt);
  invariant(Number.isFinite(end) && end > start && end - start <= MAX_LIFETIME_MS, "mailbox_expiry_invalid");
}

function validateProvider(provider: MailboxProvider): void {
  invariant(provider === "chatgpt" || provider === "antigravity" || provider === "web", "mailbox_provider_invalid");
}

function providerDestination(
  provider: MailboxProvider,
  webNodeId: string | undefined,
  config: MailboxConfig,
): MailboxMessageEnvelope["dispatchAuthorization"]["destination"] {
  if (provider === "chatgpt") return { kind: "browser-origin", origin: "https://chatgpt.com" };
  if (provider === "antigravity") return { kind: "local-mcp", surface: "antigravity" };
  invariant(webNodeId, "web_node_id_required");
  const profile = webNode(config, webNodeId);
  return { kind: "browser-origin", origin: profile.origin, webNodeId };
}

function destinationMatches(
  envelope: MailboxMessageEnvelope,
  provider: MailboxProvider,
  config: MailboxConfig,
): boolean {
  const destination = envelope.dispatchAuthorization.destination;
  if (provider === "chatgpt") {
    return envelope.webNodeId === undefined &&
      destination.kind === "browser-origin" &&
      destination.origin === "https://chatgpt.com" &&
      !("webNodeId" in destination);
  }
  if (provider === "antigravity") {
    return envelope.webNodeId === undefined &&
      destination.kind === "local-mcp" &&
      destination.surface === "antigravity";
  }
  if (!envelope.webNodeId || destination.kind !== "browser-origin" || !("webNodeId" in destination)) return false;
  const profile = config.webNodes[envelope.webNodeId];
  return Boolean(profile?.enabled && destination.webNodeId === envelope.webNodeId && destination.origin === profile.origin);
}

function validateConversationUrl(
  value: string | undefined,
  destination: MailboxMessageEnvelope["dispatchAuthorization"]["destination"],
): void {
  if (!value) return;
  invariant(destination.kind === "browser-origin", "mailbox_conversation_url_not_supported");
  let parsed: URL;
  try { parsed = new URL(value); }
  catch { throw new Error("mailbox_conversation_url_invalid"); }
  invariant(parsed.origin === destination.origin, "mailbox_conversation_origin_mismatch");
  invariant(parsed.username === "" && parsed.password === "", "mailbox_conversation_credentials_forbidden");
}

function webNode(config: MailboxConfig, nodeId: string): WebNodeProfile {
  const profile = config.webNodes[nodeId];
  invariant(profile && profile.enabled, "web_node_not_found_or_disabled", { nodeId });
  invariant(config.providers.web.enabled, "mailbox_provider_disabled", { provider: "web" });
  return profile;
}
