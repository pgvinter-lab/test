import crypto from "node:crypto";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { invariant } from "../core/errors.js";
import {
  MAILBOX_CONFIG_VERSION,
  MAILBOX_LEGACY_CONFIG_VERSION,
  MAILBOX_PREVIOUS_CONFIG_VERSION,
  type MailboxConfig,
  type MailboxProviderConfig,
} from "./types.js";
import { defaultWebNodeProfiles, validateWebNodeProfile } from "./web-node-profile.js";

export interface InitializeMailboxConfigOptions {
  exchangeRoot: string;
  stateDirectory?: string;
  configPath?: string;
  host?: "127.0.0.1" | "::1";
  port?: number;
  overwrite?: boolean;
}

export function defaultMailboxStateDirectory(): string {
  const local = process.env.LOCALAPPDATA?.trim();
  return path.resolve(local || path.join(os.homedir(), ".bridge2"), "Bridge2", "mailbox");
}

export function defaultMailboxConfigPath(): string {
  return path.join(defaultMailboxStateDirectory(), "config.json");
}

export function initializeMailboxConfig(options: InitializeMailboxConfigOptions): MailboxConfig {
  const stateDirectory = path.resolve(options.stateDirectory ?? defaultMailboxStateDirectory());
  const configPath = path.resolve(options.configPath ?? path.join(stateDirectory, "config.json"));
  const exchangeRoot = path.resolve(options.exchangeRoot);
  invariant(path.isAbsolute(exchangeRoot), "mailbox_exchange_root_must_be_absolute");
  invariant(path.isAbsolute(stateDirectory), "mailbox_state_directory_must_be_absolute");
  invariant(!sameOrChild(exchangeRoot, stateDirectory) && !sameOrChild(stateDirectory, exchangeRoot), "mailbox_state_exchange_overlap_forbidden");
  fs.mkdirSync(stateDirectory, { recursive: true, mode: 0o700 });
  fs.mkdirSync(exchangeRoot, { recursive: true });
  assertDirectory(stateDirectory, "mailbox_state_directory_invalid");
  assertDirectory(exchangeRoot, "mailbox_exchange_root_invalid");

  if (fs.existsSync(configPath) && options.overwrite !== true) {
    return loadMailboxConfig(configPath);
  }
  const tokenFile = path.join(stateDirectory, "broker-token.txt");
  if (!fs.existsSync(tokenFile)) writeExclusive(tokenFile, `${crypto.randomBytes(32).toString("base64url")}\n`, 0o600);
  const provider = (consumerId: string): MailboxProviderConfig => ({ enabled: true, consumerId });
  const config: MailboxConfig = {
    schemaVersion: MAILBOX_CONFIG_VERSION,
    stateDirectory,
    databasePath: path.join(stateDirectory, "mailbox.sqlite"),
    auditMirrorPath: path.join(stateDirectory, "mailbox-audit.jsonl"),
    exchangeRoot,
    broker: {
      host: options.host ?? "127.0.0.1",
      port: options.port ?? 7319,
      tokenFile,
      allowedOrigins: [],
    },
    providers: {
      chatgpt: provider("provider.chatgpt.web"),
      antigravity: provider("provider.antigravity.mcp"),
      web: provider("provider.web.chrome"),
    },
    webNodes: defaultWebNodeProfiles(),
    delivery: {
      leaseMs: 15 * 60_000,
      heartbeatExtensionMs: 5 * 60_000,
      pollIntervalMs: 5_000,
      defaultExpiryMs: 24 * 60 * 60_000,
      maxPreDispatchAttempts: 3,
    },
    integrations: {
      chromeExtensionDirectory: path.join(stateDirectory, "chrome-extension"),
      antigravityPluginDirectory: path.join(stateDirectory, "antigravity-plugin"),
      webBrowserProfileDirectory: path.join(stateDirectory, "web-browser-profile"),
    },
  };
  writeJsonAtomic(configPath, config, options.overwrite === true);
  return config;
}

export function loadMailboxConfig(configPath = process.env.BRIDGE_MAILBOX_CONFIG?.trim() || defaultMailboxConfigPath()): MailboxConfig {
  const resolved = path.resolve(configPath);
  const raw = JSON.parse(fs.readFileSync(resolved, "utf8")) as { schemaVersion?: unknown };
  invariant(
    raw?.schemaVersion !== MAILBOX_LEGACY_CONFIG_VERSION &&
    raw?.schemaVersion !== MAILBOX_PREVIOUS_CONFIG_VERSION,
    "mailbox_config_migration_required",
  );
  const parsed = raw as MailboxConfig;
  invariant(parsed?.schemaVersion === MAILBOX_CONFIG_VERSION, "mailbox_config_version_unsupported");
  for (const [field, value] of Object.entries({
    stateDirectory: parsed.stateDirectory,
    databasePath: parsed.databasePath,
    auditMirrorPath: parsed.auditMirrorPath,
    exchangeRoot: parsed.exchangeRoot,
    tokenFile: parsed.broker?.tokenFile,
    chromeExtensionDirectory: parsed.integrations?.chromeExtensionDirectory,
    antigravityPluginDirectory: parsed.integrations?.antigravityPluginDirectory,
    webBrowserProfileDirectory: parsed.integrations?.webBrowserProfileDirectory,
  })) invariant(typeof value === "string" && path.isAbsolute(value), "mailbox_config_path_invalid", { field });
  invariant(parsed.broker.host === "127.0.0.1" || parsed.broker.host === "::1", "mailbox_broker_loopback_required");
  invariant(Number.isSafeInteger(parsed.broker.port) && parsed.broker.port >= 1024 && parsed.broker.port <= 65535, "mailbox_broker_port_invalid");
  invariant(Array.isArray(parsed.broker.allowedOrigins) && parsed.broker.allowedOrigins.every((origin) => /^https:\/\/[A-Za-z0-9.-]+$/u.test(origin)), "mailbox_allowed_origin_invalid");
  for (const name of ["chatgpt", "antigravity", "web"] as const) {
    const provider = parsed.providers?.[name];
    invariant(provider && typeof provider.enabled === "boolean" && validIdentifier(provider.consumerId), "mailbox_provider_config_invalid", { provider: name });
  }
  invariant(parsed.webNodes !== null && typeof parsed.webNodes === "object" && !Array.isArray(parsed.webNodes), "web_node_profiles_invalid");
  for (const [nodeId, value] of Object.entries(parsed.webNodes)) {
    const profile = validateWebNodeProfile(value);
    invariant(profile.nodeId === nodeId, "web_node_profile_key_mismatch", { nodeId });
  }
  for (const [field, value] of Object.entries(parsed.delivery ?? {})) {
    invariant(Number.isSafeInteger(value) && value > 0, "mailbox_delivery_config_invalid", { field });
  }
  invariant(!sameOrChild(parsed.exchangeRoot, parsed.stateDirectory) && !sameOrChild(parsed.stateDirectory, parsed.exchangeRoot), "mailbox_state_exchange_overlap_forbidden");
  for (const [field, value] of Object.entries({
    databasePath: parsed.databasePath,
    auditMirrorPath: parsed.auditMirrorPath,
    tokenFile: parsed.broker.tokenFile,
    chromeExtensionDirectory: parsed.integrations.chromeExtensionDirectory,
    antigravityPluginDirectory: parsed.integrations.antigravityPluginDirectory,
    webBrowserProfileDirectory: parsed.integrations.webBrowserProfileDirectory,
  })) invariant(sameOrChild(value, parsed.stateDirectory), "mailbox_runtime_path_outside_state_forbidden", { field });
  invariant(
    !sameOrChild(parsed.integrations.chromeExtensionDirectory, parsed.integrations.webBrowserProfileDirectory) &&
    !sameOrChild(parsed.integrations.webBrowserProfileDirectory, parsed.integrations.chromeExtensionDirectory),
    "web_browser_extension_profile_overlap_forbidden",
  );
  invariant(sameOrChild(parsed.auditMirrorPath, parsed.stateDirectory), "mailbox_audit_mirror_outside_state_forbidden");
  invariant(path.resolve(parsed.auditMirrorPath).toLowerCase() !== path.resolve(parsed.databasePath).toLowerCase(), "mailbox_audit_database_collision");
  assertCanonicalDirectory(parsed.stateDirectory, "mailbox_state_directory_invalid");
  assertCanonicalDirectory(parsed.exchangeRoot, "mailbox_exchange_root_invalid");
  for (const candidate of [parsed.databasePath, parsed.auditMirrorPath, parsed.broker.tokenFile]) {
    assertContainedPathWithoutReparse(candidate, parsed.stateDirectory, "mailbox_runtime_reparse_forbidden");
  }
  for (const candidate of [
    parsed.integrations.chromeExtensionDirectory,
    parsed.integrations.antigravityPluginDirectory,
    parsed.integrations.webBrowserProfileDirectory,
  ]) {
    assertContainedPathWithoutReparse(candidate, parsed.stateDirectory, "mailbox_integration_reparse_forbidden");
  }
  return parsed;
}

export function readBrokerToken(config: MailboxConfig): string {
  const stat = fs.lstatSync(config.broker.tokenFile);
  invariant(stat.isFile() && !stat.isSymbolicLink(), "mailbox_broker_token_file_invalid");
  const token = fs.readFileSync(config.broker.tokenFile, "utf8").trim();
  invariant(/^[A-Za-z0-9_-]{40,100}$/u.test(token), "mailbox_broker_token_invalid");
  return token;
}

export function mailboxBrokerUrl(config: MailboxConfig): string {
  const host = config.broker.host === "::1" ? "[::1]" : config.broker.host;
  return `http://${host}:${config.broker.port}`;
}

export function writeJsonAtomic(filePath: string, value: unknown, overwrite: boolean): void {
  fs.mkdirSync(path.dirname(filePath), { recursive: true, mode: 0o700 });
  const temporary = `${filePath}.tmp-${process.pid}-${crypto.randomUUID()}`;
  writeExclusive(temporary, `${JSON.stringify(value, null, 2)}\n`, 0o600);
  try {
    if (!overwrite && fs.existsSync(filePath)) throw new Error("mailbox_config_exists");
    if (overwrite && fs.existsSync(filePath)) fs.rmSync(filePath);
    fs.renameSync(temporary, filePath);
  } catch (error) {
    try { fs.rmSync(temporary, { force: true }); } catch {}
    throw error;
  }
}

function writeExclusive(filePath: string, text: string, mode: number): void {
  const handle = fs.openSync(filePath, "wx", mode);
  try {
    fs.writeFileSync(handle, text, "utf8");
    fs.fsyncSync(handle);
  } finally { fs.closeSync(handle); }
}

function assertDirectory(directory: string, code: string): void {
  const stat = fs.lstatSync(directory);
  invariant(stat.isDirectory() && !stat.isSymbolicLink(), code);
}

function validIdentifier(value: string): boolean {
  return /^[A-Za-z0-9][A-Za-z0-9._:-]{2,127}$/u.test(value);
}

function sameOrChild(candidate: string, parent: string): boolean {
  const relative = path.relative(path.resolve(parent), path.resolve(candidate));
  return relative === "" || (!relative.startsWith("..") && !path.isAbsolute(relative));
}

function assertCanonicalDirectory(directory: string, code: string): void {
  const stat = fs.lstatSync(directory);
  invariant(stat.isDirectory() && !stat.isSymbolicLink(), code);
  invariant(sameFilesystemPath(fs.realpathSync.native(directory), directory), "mailbox_runtime_reparse_forbidden", { directory });
}

export function assertContainedPathWithoutReparse(candidate: string, allowedRoot: string, code: string): void {
  const root = path.resolve(allowedRoot);
  const resolved = path.resolve(candidate);
  invariant(sameOrChild(resolved, root), "mailbox_runtime_path_outside_state_forbidden", { candidate });
  const relative = path.relative(root, resolved);
  let current = root;
  for (const segment of relative.split(path.sep).filter(Boolean)) {
    current = path.join(current, segment);
    const stat = fs.lstatSync(current, { throwIfNoEntry: false });
    if (!stat) break;
    invariant(!stat.isSymbolicLink(), code, { candidate, current });
    invariant(sameFilesystemPath(fs.realpathSync.native(current), current), code, { candidate, current });
  }
}

function sameFilesystemPath(left: string, right: string): boolean {
  const a = path.resolve(left);
  const b = path.resolve(right);
  return process.platform === "win32" ? a.toLowerCase() === b.toLowerCase() : a === b;
}
