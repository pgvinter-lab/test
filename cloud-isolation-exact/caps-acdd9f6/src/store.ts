import fs from "node:fs";
import path from "node:path";
import { getConfig } from "./config.js";
import { ensureDir, readJson, writeJsonAtomic, appendLine, withLock, withLockSync, nowIso } from "./util.js";

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

export interface Lease {
  paths: string[];
  agent: string;
  session: string;
  ts: number;
  expires: number;
  note?: string;
}

export interface Task {
  id: string;
  title: string;
  status: "todo" | "doing" | "done";
  owner?: string;
  ts: number;
}

/** A collaboration session: the boss is whoever issued the first command; sticky until
 *  changed or until the session auto-closes after inactivity. */
export interface Session {
  boss: string | null;
  bossSetBy: "first-command" | "user" | null;
  startedAt: number;
  lastActivity: number;
  status: "active" | "closed";
  closedBy?: string;
}

export interface ProjectState {
  /** Agent currently holding the control token (handoff mode), or null. */
  control: string | null;
  leases: Lease[];
  tasks: Task[];
  /** sessionId -> last bridge_sync timestamp; powers per-window freshness. */
  lastSync: Record<string, number>;
  /** Active collaboration session (boss + inactivity lifecycle). */
  session?: Session;
}

export interface ProjectEntry {
  name: string;
  path: string;
  remote?: string;
  lastActive?: { host: string; agent: string; ts: number; action?: string };
}

export interface Registry {
  projects: Record<string, ProjectEntry>;
}

export interface LedgerEntry {
  ts: number;
  iso: string;
  host: string;
  agent: string;
  project: string;
  action: string;
  files?: string[];
  hashes?: Record<string, string>;
  note?: string;
}

const DEFAULT_STATE: ProjectState = { control: null, leases: [], tasks: [], lastSync: {} };

// ---------------------------------------------------------------------------
// Per-project state (.connector/ inside the project)
// ---------------------------------------------------------------------------

export function connectorDir(projectPath: string): string { return path.join(projectPath, ".connector"); }
export function statePath(projectPath: string): string { return path.join(connectorDir(projectPath), "state.json"); }
export function journalPath(projectPath: string): string { return path.join(connectorDir(projectPath), "journal.md"); }
export function stateLockPath(projectPath: string): string { return path.join(connectorDir(projectPath), ".lock"); }

export function loadState(projectPath: string): ProjectState {
  return { ...DEFAULT_STATE, ...readJson<ProjectState>(statePath(projectPath), DEFAULT_STATE) };
}

/** Locked read-modify-write of a project's state. `fn` mutates the state and returns a result. */
export async function withState<T>(projectPath: string, fn: (s: ProjectState) => T): Promise<T> {
  return withLock(stateLockPath(projectPath), () => {
    const s = loadState(projectPath);
    const result = fn(s);
    writeJsonAtomic(statePath(projectPath), s);
    return result;
  });
}

export function appendJournal(projectPath: string, line: string): void {
  appendLine(journalPath(projectPath), `- ${line}`);
}

// ---------------------------------------------------------------------------
// Cross-project registry (in BRIDGE_HOME)
// ---------------------------------------------------------------------------

export function registryPath(): string { return path.join(getConfig().bridgeHome, "registry.json"); }
function registryLockPath(): string { return path.join(getConfig().bridgeHome, ".registry.lock"); }

export function loadRegistry(): Registry {
  return readJson<Registry>(registryPath(), { projects: {} });
}

export async function withRegistry<T>(fn: (r: Registry) => T): Promise<T> {
  return withLock(registryLockPath(), () => {
    const r = loadRegistry();
    const result = fn(r);
    writeJsonAtomic(registryPath(), r);
    return result;
  });
}

export async function upsertRegistry(entry: ProjectEntry): Promise<ProjectEntry> {
  return withRegistry((r) => {
    r.projects[entry.name] = { ...r.projects[entry.name], ...entry };
    return r.projects[entry.name];
  });
}

export async function touchLastActive(name: string, projectPath: string, action: string): Promise<void> {
  const cfg = getConfig();
  await withRegistry((r) => {
    if (!r.projects[name]) r.projects[name] = { name, path: projectPath };
    r.projects[name].lastActive = { host: cfg.host, agent: cfg.agent, ts: Date.now(), action };
  });
}

// ---------------------------------------------------------------------------
// Cross-project ledger (append-only JSONL in BRIDGE_HOME)
// ---------------------------------------------------------------------------

/**
 * Ledger sharding (review H1/M10). A single `ledger.jsonl` on a Drive-synced
 * BRIDGE_HOME is fatal under concurrency: two machines appending the same file
 * produce a Drive "conflict copy" and one machine's entries silently vanish.
 * Each host therefore writes ONLY its own shard `ledger.<host>.jsonl`; no file is
 * ever written by two machines, so Drive never has to merge. Reads union every
 * shard (plus any legacy `ledger.jsonl`). Same-host concurrent appends are
 * serialized by a sync lock so lines can't tear.
 */
function sanitizeHost(h: string): string { return (h || "unknown").replace(/[^A-Za-z0-9._-]/g, "_"); }
function ledgerLockPath(): string { return path.join(getConfig().bridgeHome, ".ledger.lock"); }
/** Legacy single-file path; still READ for back-compat, never written anymore. */
export function ledgerPath(): string { return path.join(getConfig().bridgeHome, "ledger.jsonl"); }
/** This host's append-only shard. */
export function ledgerShardPath(): string {
  return path.join(getConfig().bridgeHome, `ledger.${sanitizeHost(getConfig().host)}.jsonl`);
}

export function ledgerAppend(e: Omit<LedgerEntry, "ts" | "iso" | "host" | "agent">): LedgerEntry {
  const cfg = getConfig();
  const full: LedgerEntry = { ts: Date.now(), iso: nowIso(), host: cfg.host, agent: cfg.agent, ...e };
  ensureDir(cfg.bridgeHome);
  withLockSync(ledgerLockPath(), () => appendLine(ledgerShardPath(), JSON.stringify(full)));
  return full;
}

export function ledgerReadAll(limit = 1000): LedgerEntry[] {
  const home = getConfig().bridgeHome;
  let files: string[];
  try {
    files = fs.readdirSync(home).filter((f) => /^ledger(\..+)?\.jsonl$/.test(f) || f === "ledger.jsonl");
  } catch {
    return [];
  }
  const all: LedgerEntry[] = [];
  for (const f of files) {
    let raw: string;
    try { raw = fs.readFileSync(path.join(home, f), "utf8").trim(); } catch { continue; }
    if (!raw) continue;
    for (const l of raw.split(/\r?\n/)) {
      try { all.push(JSON.parse(l) as LedgerEntry); } catch { /* skip torn/partial line */ }
    }
  }
  all.sort((a, b) => (a.ts ?? 0) - (b.ts ?? 0)); // merge shards into one time-ordered view
  return all.slice(-limit);
}

export function ledgerSince(project: string, since: number, excludeAgent?: string): LedgerEntry[] {
  return ledgerReadAll(2000).filter(
    (e) => e.project === project && e.ts > since && (!excludeAgent || e.agent !== excludeAgent)
  );
}
