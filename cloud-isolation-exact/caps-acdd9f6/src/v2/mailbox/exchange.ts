import crypto from "node:crypto";
import fs from "node:fs";
import path from "node:path";
import { canonicalize, sha256 } from "../core/canonical.js";
import { invariant } from "../core/errors.js";
import {
  MAILBOX_SCHEMA_VERSION,
  type MailboxMessageEnvelope,
  type MailboxProvider,
  type MailboxReadyMarker,
  type MailboxResponseEnvelope,
} from "./types.js";

export interface WrittenExchangeObject {
  relativePath: string;
  readyRelativePath: string;
  sha256: string;
  byteLength: number;
}

export interface WrittenWebNodeOutput {
  relativePath: string;
  absolutePath: string;
  sha256: string;
  byteLength: number;
}

export class DriveMailboxExchange {
  readonly root: string;

  constructor(exchangeRoot: string) {
    this.root = path.resolve(exchangeRoot);
    fs.mkdirSync(this.root, { recursive: true });
    const stat = fs.lstatSync(this.root);
    invariant(stat.isDirectory() && !stat.isSymbolicLink(), "mailbox_exchange_root_invalid");
    this.ensureReadme();
  }

  writeMessage(envelope: MailboxMessageEnvelope): WrittenExchangeObject {
    const base = this.providerDirectory(envelope.projectId, envelope.recipient, "inbox");
    return this.writeObject(base, envelope.messageId, envelope, "message");
  }

  readMessage(relativePath: string, readyRelativePath?: string): MailboxMessageEnvelope {
    const objectPath = this.resolveRelative(relativePath);
    const markerPath = this.resolveRelative(readyRelativePath ?? relativePath.replace(/\.json$/u, ".ready.json"));
    const bytes = fs.readFileSync(objectPath);
    const marker = JSON.parse(fs.readFileSync(markerPath, "utf8")) as MailboxReadyMarker;
    invariant(marker.schemaVersion === MAILBOX_SCHEMA_VERSION && marker.kind === "ready" && marker.objectKind === "message", "mailbox_ready_marker_invalid");
    invariant(marker.sha256 === sha256(bytes) && marker.byteLength === bytes.length, "mailbox_exchange_hash_mismatch");
    const envelope = JSON.parse(bytes.toString("utf8")) as MailboxMessageEnvelope;
    invariant(envelope.schemaVersion === MAILBOX_SCHEMA_VERSION && envelope.kind === "message", "mailbox_message_envelope_invalid");
    invariant(marker.objectId === envelope.messageId && envelope.promptSha256 === sha256(Buffer.from(envelope.prompt, "utf8")), "mailbox_message_binding_invalid");
    return envelope;
  }

  writeResponse(envelope: MailboxResponseEnvelope): WrittenExchangeObject {
    const base = path.join(
      this.providerDirectory(envelope.projectId, envelope.provider, "responses"),
      safeId(envelope.messageId),
    );
    return this.writeObject(base, envelope.responseId, envelope, "response");
  }

  readResponse(relativePath: string): MailboxResponseEnvelope {
    const objectPath = this.resolveRelative(relativePath);
    const markerPath = this.resolveRelative(relativePath.replace(/\.json$/u, ".ready.json"));
    const bytes = fs.readFileSync(objectPath);
    const marker = JSON.parse(fs.readFileSync(markerPath, "utf8")) as MailboxReadyMarker;
    invariant(marker.schemaVersion === MAILBOX_SCHEMA_VERSION && marker.kind === "ready" && marker.objectKind === "response", "mailbox_ready_marker_invalid");
    invariant(marker.sha256 === sha256(bytes) && marker.byteLength === bytes.length, "mailbox_exchange_hash_mismatch");
    const envelope = JSON.parse(bytes.toString("utf8")) as MailboxResponseEnvelope;
    invariant(envelope.schemaVersion === MAILBOX_SCHEMA_VERSION && envelope.kind === "response", "mailbox_response_envelope_invalid");
    invariant(
      marker.objectId === envelope.responseId &&
      envelope.responseSha256 === sha256(Buffer.from(envelope.response, "utf8")),
      "mailbox_response_binding_invalid",
    );
    return envelope;
  }

  writeWebNodeOutput(
    message: MailboxMessageEnvelope,
    response: MailboxResponseEnvelope,
    displayName: string,
  ): WrittenWebNodeOutput {
    invariant(message.recipient === "web" && typeof message.webNodeId === "string", "web_node_message_required");
    invariant(
      response.provider === "web" &&
      response.messageId === message.messageId &&
      response.projectId === message.projectId,
      "web_node_response_binding_invalid",
    );
    const directory = path.join(
      this.projectDirectory(message.projectId),
      "web",
      "outputs",
      safeId(message.webNodeId),
    );
    this.ensureOwnedDirectory(directory);
    const outputPath = path.join(directory, `${safeId(message.messageId)}.md`);
    const promptFence = markdownFence(message.prompt);
    const bytes = Buffer.from(
      `# ${displayName} response\n\n` +
      `- Bridge message: \`${message.messageId}\`\n` +
      `- WEB node: \`${message.webNodeId}\`\n` +
      `- Created: ${response.createdAt}\n` +
      `- Prompt SHA-256: \`${message.promptSha256}\`\n` +
      `- Response SHA-256: \`${response.responseSha256}\`\n` +
      (response.conversationUrl ? `- Conversation: [open in ${displayName}](${response.conversationUrl})\n` : "") +
      `\n## Prompt\n\n${promptFence}\n${message.prompt}\n${promptFence}\n\n` +
      `## Response\n\n${response.response}\n`,
      "utf8",
    );
    writeImmutable(outputPath, bytes);
    return {
      relativePath: toRelative(this.root, outputPath),
      absolutePath: outputPath,
      sha256: sha256(bytes),
      byteLength: bytes.length,
    };
  }

  webNodeOutputPath(projectId: string, nodeId: string, messageId: string): {
    relativePath: string;
    absolutePath: string;
  } {
    const absolutePath = path.join(
      this.projectDirectory(projectId),
      "web",
      "outputs",
      safeId(nodeId),
      `${safeId(messageId)}.md`,
    );
    return { relativePath: toRelative(this.root, absolutePath), absolutePath };
  }

  projectDirectory(projectId: string): string {
    return path.join(this.root, "v3", "projects", projectKey(projectId));
  }

  private providerDirectory(projectId: string, provider: MailboxProvider, leaf: "inbox" | "responses"): string {
    invariant(provider === "chatgpt" || provider === "antigravity" || provider === "web", "mailbox_provider_invalid");
    const directory = path.join(this.projectDirectory(projectId), provider, leaf);
    this.ensureOwnedDirectory(directory);
    return directory;
  }

  private writeObject(
    directory: string,
    objectId: string,
    value: MailboxMessageEnvelope | MailboxResponseEnvelope,
    objectKind: "message" | "response",
  ): WrittenExchangeObject {
    this.ensureOwnedDirectory(directory);
    const objectPath = path.join(directory, `${safeId(objectId)}.json`);
    const readyPath = path.join(directory, `${safeId(objectId)}.ready.json`);
    const bytes = Buffer.from(`${canonicalize(value)}\n`, "utf8");
    const objectHash = sha256(bytes);
    writeImmutable(objectPath, bytes);
    const marker: MailboxReadyMarker = {
      schemaVersion: MAILBOX_SCHEMA_VERSION,
      kind: "ready",
      objectKind,
      objectId,
      sha256: objectHash,
      byteLength: bytes.length,
      createdAt: value.createdAt,
    };
    writeImmutable(readyPath, Buffer.from(`${canonicalize(marker)}\n`, "utf8"));
    return {
      relativePath: toRelative(this.root, objectPath),
      readyRelativePath: toRelative(this.root, readyPath),
      sha256: objectHash,
      byteLength: bytes.length,
    };
  }

  private resolveRelative(relativePath: string): string {
    invariant(typeof relativePath === "string" && relativePath.length > 0 && !path.isAbsolute(relativePath), "mailbox_relative_path_invalid");
    const resolved = path.resolve(this.root, relativePath);
    const relative = path.relative(this.root, resolved);
    invariant(relative !== "" && !relative.startsWith("..") && !path.isAbsolute(relative), "mailbox_exchange_path_escape");
    return resolved;
  }

  private ensureOwnedDirectory(directory: string): void {
    const relative = path.relative(this.root, directory);
    invariant(relative !== "" && !relative.startsWith("..") && !path.isAbsolute(relative), "mailbox_exchange_path_escape");
    let current = this.root;
    for (const segment of relative.split(path.sep)) {
      current = path.join(current, segment);
      if (!fs.existsSync(current)) fs.mkdirSync(current);
      const stat = fs.lstatSync(current);
      invariant(stat.isDirectory() && !stat.isSymbolicLink(), "mailbox_exchange_reparse_forbidden");
    }
  }

  private ensureReadme(): void {
    const readme = path.join(this.root, "README.md");
    if (fs.existsSync(readme)) return;
    writeImmutable(readme, Buffer.from(
      "# Bridge Exchange\n\n" +
      "This folder contains immutable, provider-addressed Bridge mailbox messages and responses.\n" +
      "Active v3 traffic is addressed to ChatGPT, Antigravity, or a profile-driven WEB node; v1/v2 objects remain immutable history.\n" +
      "It is not authoritative state and must not contain the Bridge database, WAL, leases, browser profiles, credentials, or recovery keys.\n" +
      "A message is consumable only when its adjacent `.ready.json` marker verifies the complete file hash.\n",
      "utf8",
    ));
  }
}

function projectKey(projectId: string): string {
  const slug = projectId.toLowerCase().replace(/[^a-z0-9]+/gu, "-").replace(/^-|-$/gu, "").slice(0, 48) || "project";
  return `${slug}-${sha256(Buffer.from(projectId, "utf8")).slice(0, 16)}`;
}

function safeId(value: string): string {
  invariant(/^[A-Za-z0-9][A-Za-z0-9._:-]{2,179}$/u.test(value), "mailbox_object_id_invalid");
  return value;
}

function markdownFence(value: string): string {
  let longest = 0;
  for (const match of value.matchAll(/`+/gu)) longest = Math.max(longest, match[0].length);
  return "`".repeat(Math.max(3, longest + 1));
}

function writeImmutable(filePath: string, bytes: Buffer): void {
  if (fs.existsSync(filePath)) {
    invariant(fs.readFileSync(filePath).equals(bytes), "mailbox_immutable_object_collision", { filePath });
    return;
  }
  const temporary = path.join(path.dirname(filePath), `.bridge-mailbox-tmp-${crypto.randomUUID()}`);
  const handle = fs.openSync(temporary, "wx", 0o600);
  try {
    fs.writeFileSync(handle, bytes);
    fs.fsyncSync(handle);
  } finally { fs.closeSync(handle); }
  try {
    fs.linkSync(temporary, filePath);
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "EEXIST") {
      invariant(fs.readFileSync(filePath).equals(bytes), "mailbox_immutable_object_collision", { filePath });
    } else {
      invariant(false, "mailbox_exchange_atomic_publish_unsupported", {
        filePath,
        cause: error instanceof Error ? error.message : String(error),
      });
    }
  } finally {
    fs.rmSync(temporary, { force: true });
  }
}

function toRelative(root: string, filePath: string): string {
  return path.relative(root, filePath).split(path.sep).join("/");
}
