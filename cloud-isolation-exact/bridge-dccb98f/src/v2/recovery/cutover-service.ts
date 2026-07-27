import fs from "node:fs";
import path from "node:path";
import { canonicalize, hashCanonical } from "../core/canonical.js";
import { invariant } from "../core/errors.js";
import { requireIdentifier, requireNonEmptyString } from "../core/validation.js";

export type CutoverPhase = "shadow" | "test" | "final" | "rollback";

export interface CutoverBridgeEndpoint {
  bridgeId: string;
  version: "1.x" | "2.0";
  role: "primary" | "backup";
  writable: boolean;
  command?: string;
  statePath?: string;
  mcpConfigPath?: string;
  notes?: string;
}

export interface CutoverHistoryEntry {
  at: string;
  action: "init" | "switch";
  phase: CutoverPhase;
  primaryBridgeId: string;
  backupBridgeId: string;
  approvalRef: string;
  reason: string;
  previousHash?: string;
  entryHash: string;
}

export interface CutoverManifest {
  schemaVersion: "bridge2-cutover-v1";
  projectId: string;
  phase: CutoverPhase;
  primaryBridgeId: string;
  backupBridgeId: string;
  bridges: CutoverBridgeEndpoint[];
  updatedAt: string;
  history: CutoverHistoryEntry[];
}

export interface CutoverInitInput {
  statePath: string;
  projectId: string;
  primary: Omit<CutoverBridgeEndpoint, "role" | "writable">;
  backup: Omit<CutoverBridgeEndpoint, "role" | "writable">;
  approvalRef: string;
  reason: string;
  now?: () => string;
}

export interface CutoverSwitchInput {
  statePath: string;
  toBridgeId: string;
  phase: Exclude<CutoverPhase, "shadow">;
  approvalRef: string;
  reason: string;
  now?: () => string;
}

export function initializeCutover(input: CutoverInitInput): CutoverManifest {
  const statePath = writableManifestPath(input.statePath);
  invariant(!fs.existsSync(statePath), "cutover_state_exists");
  validateProjectId(input.projectId);
  validateEndpoint(input.primary, "primary");
  validateEndpoint(input.backup, "backup");
  invariant(input.primary.bridgeId !== input.backup.bridgeId, "cutover_bridge_ids_must_differ");
  validateApproval(input.approvalRef, input.reason);
  const at = (input.now ?? (() => new Date().toISOString()))();
  const primary = { ...input.primary, role: "primary" as const, writable: true };
  const backup = { ...input.backup, role: "backup" as const, writable: false };
  const entry = historyEntry({
    at,
    action: "init",
    phase: "shadow",
    primaryBridgeId: primary.bridgeId,
    backupBridgeId: backup.bridgeId,
    approvalRef: input.approvalRef,
    reason: input.reason,
  });
  const manifest: CutoverManifest = {
    schemaVersion: "bridge2-cutover-v1",
    projectId: input.projectId,
    phase: "shadow",
    primaryBridgeId: primary.bridgeId,
    backupBridgeId: backup.bridgeId,
    bridges: [primary, backup],
    updatedAt: at,
    history: [entry],
  };
  validateManifest(manifest);
  atomicWriteJson(statePath, manifest);
  return manifest;
}

export function readCutover(statePath: string): CutoverManifest {
  const manifest = JSON.parse(fs.readFileSync(readableManifestPath(statePath), "utf8")) as CutoverManifest;
  validateManifest(manifest);
  return manifest;
}

export function switchCutover(input: CutoverSwitchInput): CutoverManifest {
  const statePath = writableManifestPath(input.statePath);
  const current = readCutover(statePath);
  validateApproval(input.approvalRef, input.reason);
  invariant(input.phase === "test" || input.phase === "final" || input.phase === "rollback", "invalid_cutover_phase");
  const target = current.bridges.find((bridge) => bridge.bridgeId === input.toBridgeId);
  invariant(target, "cutover_target_bridge_unknown");
  const priorPrimary = current.bridges.find((bridge) => bridge.bridgeId === current.primaryBridgeId);
  invariant(priorPrimary, "cutover_primary_missing");
  invariant(input.phase !== "final" || current.phase === "test" || target.version === "1.x", "final_cutover_requires_test_phase");
  const at = (input.now ?? (() => new Date().toISOString()))();
  const backupBridgeId = priorPrimary.bridgeId === target.bridgeId ? current.backupBridgeId : priorPrimary.bridgeId;
  const previousHash = current.history.at(-1)?.entryHash;
  const history = [
    ...current.history,
    historyEntry({
      at,
      action: "switch",
      phase: input.phase,
      primaryBridgeId: target.bridgeId,
      backupBridgeId,
      approvalRef: input.approvalRef,
      reason: input.reason,
      previousHash,
    }),
  ];
  const manifest: CutoverManifest = {
    ...current,
    phase: input.phase,
    primaryBridgeId: target.bridgeId,
    backupBridgeId,
    bridges: current.bridges.map((bridge) => ({
      ...bridge,
      role: bridge.bridgeId === target.bridgeId ? "primary" : "backup",
      writable: bridge.bridgeId === target.bridgeId,
    })),
    updatedAt: at,
    history,
  };
  validateManifest(manifest);
  atomicWriteJson(statePath, manifest);
  return manifest;
}

function validateManifest(manifest: CutoverManifest): void {
  invariant(manifest.schemaVersion === "bridge2-cutover-v1", "invalid_cutover_schema");
  validateProjectId(manifest.projectId);
  invariant(["shadow", "test", "final", "rollback"].includes(manifest.phase), "invalid_cutover_phase");
  invariant(Array.isArray(manifest.bridges) && manifest.bridges.length >= 2, "cutover_requires_two_bridges");
  const ids = new Set<string>();
  for (const bridge of manifest.bridges) {
    validateEndpoint(bridge, bridge.role);
    invariant(!ids.has(bridge.bridgeId), "duplicate_cutover_bridge_id");
    ids.add(bridge.bridgeId);
  }
  const primaries = manifest.bridges.filter((bridge) => bridge.role === "primary" && bridge.writable);
  const backups = manifest.bridges.filter((bridge) => bridge.role === "backup" && !bridge.writable);
  invariant(primaries.length === 1, "cutover_single_writable_primary_required");
  invariant(backups.length >= 1, "cutover_backup_required");
  invariant(primaries[0].bridgeId === manifest.primaryBridgeId, "cutover_primary_designation_mismatch");
  invariant(backups.some((bridge) => bridge.bridgeId === manifest.backupBridgeId), "cutover_backup_designation_mismatch");
  let previousHash: string | undefined;
  for (const entry of manifest.history) {
    invariant(entry.previousHash === previousHash, "cutover_history_chain_mismatch");
    const { entryHash, ...unsigned } = entry;
    invariant(entryHash === hashCanonical(unsigned), "cutover_history_hash_mismatch");
    previousHash = entryHash;
  }
}

function validateEndpoint(endpoint: Omit<CutoverBridgeEndpoint, "role" | "writable"> | CutoverBridgeEndpoint, label: string): void {
  requireIdentifier(endpoint.bridgeId, `${label}.bridgeId`, "bridge.");
  invariant(endpoint.version === "1.x" || endpoint.version === "2.0", "invalid_cutover_bridge_version");
  if ("role" in endpoint) invariant(endpoint.role === "primary" || endpoint.role === "backup", "invalid_cutover_bridge_role");
  if ("writable" in endpoint) invariant(typeof endpoint.writable === "boolean", "invalid_cutover_bridge_writable");
  for (const field of ["command", "statePath", "mcpConfigPath", "notes"] as const) {
    const value = endpoint[field];
    if (value !== undefined) requireNonEmptyString(value, `${label}.${field}`, 4000);
  }
}

function validateProjectId(projectId: string): void {
  requireIdentifier(projectId, "projectId", "project.");
}

function validateApproval(approvalRef: string, reason: string): void {
  requireIdentifier(approvalRef, "approvalRef", "approval.cutover.");
  requireNonEmptyString(reason, "reason", 2000);
}

function historyEntry(input: Omit<CutoverHistoryEntry, "entryHash">): CutoverHistoryEntry {
  return { ...input, entryHash: hashCanonical(input) };
}

function readableManifestPath(filePath: string): string {
  const resolved = path.resolve(filePath);
  invariant(fs.existsSync(resolved), "cutover_state_missing");
  const stat = fs.lstatSync(resolved);
  invariant(stat.isFile() && !stat.isSymbolicLink(), "cutover_state_path_invalid");
  return resolved;
}

function writableManifestPath(filePath: string): string {
  const resolved = path.resolve(filePath);
  const parent = path.dirname(resolved);
  invariant(fs.existsSync(parent), "cutover_state_parent_missing");
  const stat = fs.lstatSync(parent);
  invariant(stat.isDirectory() && !stat.isSymbolicLink(), "cutover_state_parent_invalid");
  return resolved;
}

function atomicWriteJson(filePath: string, manifest: CutoverManifest): void {
  const temporary = `${filePath}.${process.pid}.${Date.now()}.tmp`;
  fs.writeFileSync(temporary, `${canonicalize(manifest)}\n`, { encoding: "utf8", flag: "wx", mode: 0o600 });
  fs.renameSync(temporary, filePath);
}
