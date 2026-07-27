export const MAILBOX_SCHEMA_VERSION = "bridge-mailbox-v3" as const;
export const MAILBOX_PREVIOUS_SCHEMA_VERSION = "bridge-mailbox-v2" as const;
export const MAILBOX_LEGACY_SCHEMA_VERSION = "bridge-mailbox-v1" as const;
export const MAILBOX_CONFIG_VERSION = "bridge-mailbox-config-v3" as const;
export const MAILBOX_PREVIOUS_CONFIG_VERSION = "bridge-mailbox-config-v2" as const;
export const MAILBOX_LEGACY_CONFIG_VERSION = "bridge-mailbox-config-v1" as const;
export const WEB_NODE_PROFILE_VERSION = "bridge-web-node-v1" as const;

export type MailboxProvider = "chatgpt" | "antigravity" | "web";
export type MailboxStoredProvider = MailboxProvider | "gemini";
export type MailboxMode = "default";
export type MailboxPriority = "normal" | "high";
export type MailboxSensitivity = "public" | "internal";
export type MailboxMessageStatus =
  | "preparing"
  | "queued"
  | "claimed"
  | "dispatching"
  | "sent"
  | "completed"
  | "failed"
  | "uncertain"
  | "expired";
export type MailboxDeliveryStatus =
  | "claimed"
  | "dispatching"
  | "sent"
  | "completed"
  | "failed"
  | "released"
  | "uncertain";

export interface MailboxIdentity {
  principalId: string;
  sessionId: string;
  hostId: string;
}

export interface MailboxDispatchAuthorization {
  approvalRef: string;
  authorizedAt: string;
  expiresAt: string;
  provider: MailboxProvider;
  destination:
    | { kind: "browser-origin"; origin: "https://chatgpt.com" }
    | { kind: "browser-origin"; origin: string; webNodeId: string }
    | { kind: "local-mcp"; surface: "antigravity" };
  useCount: 1;
}

export interface MailboxMessageEnvelope {
  schemaVersion: typeof MAILBOX_SCHEMA_VERSION;
  kind: "message";
  messageId: string;
  projectId: string;
  sender: MailboxIdentity;
  recipient: MailboxProvider;
  webNodeId?: string;
  mode: MailboxMode;
  priority: MailboxPriority;
  sensitivity: MailboxSensitivity;
  createdAt: string;
  expiresAt: string;
  promptSha256: string;
  prompt: string;
  dispatchAuthorization: MailboxDispatchAuthorization;
}

export interface MailboxReadyMarker {
  schemaVersion: typeof MAILBOX_SCHEMA_VERSION;
  kind: "ready";
  objectKind: "message" | "response";
  objectId: string;
  sha256: string;
  byteLength: number;
  createdAt: string;
}

export interface MailboxResponseEnvelope {
  schemaVersion: typeof MAILBOX_SCHEMA_VERSION;
  kind: "response";
  responseId: string;
  messageId: string;
  deliveryId: string;
  projectId: string;
  provider: MailboxProvider;
  consumerId: string;
  createdAt: string;
  responseSha256: string;
  response: string;
  conversationUrl?: string;
}

export interface MailboxMessageRecord {
  messageId: string;
  projectId: string;
  sender: MailboxIdentity;
  provider: MailboxStoredProvider;
  legacyProvider?: true;
  mode: MailboxMode;
  priority: MailboxPriority;
  sensitivity: MailboxSensitivity;
  status: MailboxMessageStatus;
  createdAt: string;
  expiresAt: string;
  promptSha256: string;
  approvalRef: string;
  envelopeSha256?: string;
  envelopeRelativePath?: string;
  attempt: number;
  activeDeliveryId?: string;
  responseSha256?: string;
  responseRelativePath?: string;
  lastError?: string;
}

export interface MailboxDeliveryClaim {
  deliveryId: string;
  deliveryToken: string;
  consumerId: string;
  claimedAt: string;
  leaseExpiresAt: string;
  message: MailboxMessageEnvelope;
}

export interface MailboxProviderConfig {
  enabled: boolean;
  consumerId: string;
}

export interface WebNodeProfile {
  schemaVersion: typeof WEB_NODE_PROFILE_VERSION;
  nodeId: string;
  displayName: string;
  enabled: boolean;
  origin: string;
  startUrl: string;
  auth: {
    mode: "browser-profile";
    signInHint?: string;
  };
  selectors: {
    composer: string[];
    submit: string[];
    response: string[];
    busy: string[];
  };
  behavior: {
    submitMode: "button-or-enter" | "button-only" | "enter-only";
    responseMode: "last-new-node";
    timeoutMs: number;
    settleMs: number;
    stablePolls: number;
    maxBytes: number;
  };
}

export interface MailboxConfig {
  schemaVersion: typeof MAILBOX_CONFIG_VERSION;
  stateDirectory: string;
  databasePath: string;
  auditMirrorPath: string;
  exchangeRoot: string;
  broker: {
    host: "127.0.0.1" | "::1";
    port: number;
    tokenFile: string;
    allowedOrigins: string[];
  };
  providers: {
    chatgpt: MailboxProviderConfig;
    antigravity: MailboxProviderConfig;
    web: MailboxProviderConfig;
  };
  webNodes: Record<string, WebNodeProfile>;
  delivery: {
    leaseMs: number;
    heartbeatExtensionMs: number;
    pollIntervalMs: number;
    defaultExpiryMs: number;
    maxPreDispatchAttempts: number;
  };
  integrations: {
    chromeExtensionDirectory: string;
    antigravityPluginDirectory: string;
    webBrowserProfileDirectory: string;
  };
}

export interface MailboxSendInput {
  projectId: string;
  sender: MailboxIdentity;
  provider: MailboxProvider;
  webNodeId?: string;
  prompt: string;
  idempotencyKey: string;
  approvalRef: string;
  mode?: MailboxMode;
  priority?: MailboxPriority;
  sensitivity?: MailboxSensitivity;
  expiresAt?: string;
}
