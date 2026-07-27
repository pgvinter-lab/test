import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { loadMailboxConfig } from "../v2/mailbox/config.js";

export interface CapsConfig {
  stateDirectory: string;
  databasePath: string;
}

export function defaultCapsStateDirectory(): string {
  const local = process.env.LOCALAPPDATA?.trim();
  return path.resolve(local || path.join(os.homedir(), ".bridge2"), "Bridge2", "caps");
}

export function loadCapsConfig(): CapsConfig {
  const stateDirectory = path.resolve(process.env.BRIDGE_CAPS_STATE_DIR?.trim() || defaultCapsStateDirectory());
  const databasePath = path.join(stateDirectory, "caps.sqlite");

  // Create if it doesn't exist
  fs.mkdirSync(stateDirectory, { recursive: true, mode: 0o700 });

  // Following mailbox reflexes for containment, canonical path, and no-reparse
  assertCanonicalDirectory(stateDirectory, "caps_state_directory_invalid");
  assertContainedPathWithoutReparse(databasePath, stateDirectory, "caps_runtime_reparse_forbidden");

  // Reject if inside repository, mailbox state dir, or Drive exchange
  const repoRoot = path.resolve(process.cwd());
  if (sameOrChild(stateDirectory, repoRoot)) {
    throw new Error("caps_state_inside_repository_forbidden");
  }

  // Reject if inside mailbox state directory (default)
  const defaultMailboxDir = path.resolve(process.env.LOCALAPPDATA?.trim() || path.join(os.homedir(), ".bridge2"), "Bridge2", "mailbox");
  if (sameOrChild(stateDirectory, defaultMailboxDir)) {
    throw new Error("caps_state_inside_mailbox_forbidden");
  }

  // Reject if inside mailbox exchange root
  try {
    const mailboxConfig = loadMailboxConfig();
    if (sameOrChild(stateDirectory, mailboxConfig.exchangeRoot)) {
      throw new Error("caps_state_inside_drive_exchange_forbidden");
    }
  } catch (e: any) {
    if (e.message === "caps_state_inside_drive_exchange_forbidden") throw e;
  }

  return {
    stateDirectory,
    databasePath,
  };
}

function sameOrChild(candidate: string, parent: string): boolean {
  const relative = path.relative(path.resolve(parent), path.resolve(candidate));
  return relative === "" || (!relative.startsWith("..") && !path.isAbsolute(relative));
}

function assertCanonicalDirectory(directory: string, code: string): void {
  const stat = fs.lstatSync(directory);
  if (!stat.isDirectory() || stat.isSymbolicLink()) {
    throw new Error(code);
  }
  if (!sameFilesystemPath(fs.realpathSync.native(directory), directory)) {
    throw new Error(code);
  }
}

export function assertContainedPathWithoutReparse(candidate: string, allowedRoot: string, code: string): void {
  const root = path.resolve(allowedRoot);
  const resolved = path.resolve(candidate);
  if (!sameOrChild(resolved, root)) {
    throw new Error("caps_runtime_path_outside_state_forbidden");
  }
  const relative = path.relative(root, resolved);
  let current = root;
  for (const segment of relative.split(path.sep).filter(Boolean)) {
    current = path.join(current, segment);
    const stat = fs.lstatSync(current, { throwIfNoEntry: false });
    if (!stat) break;
    if (stat.isSymbolicLink() || !sameFilesystemPath(fs.realpathSync.native(current), current)) {
      throw new Error(code);
    }
  }
}

function sameFilesystemPath(left: string, right: string): boolean {
  const a = path.resolve(left);
  const b = path.resolve(right);
  return process.platform === "win32" ? a.toLowerCase() === b.toLowerCase() : a === b;
}
