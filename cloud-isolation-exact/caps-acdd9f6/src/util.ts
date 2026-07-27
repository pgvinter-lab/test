import fs from "node:fs";
import path from "node:path";
import crypto from "node:crypto";

/** Recursively create a directory (no-op if it exists). */
export function ensureDir(p: string): void {
  fs.mkdirSync(p, { recursive: true });
}

/**
 * Read+parse JSON. A MISSING file returns the fallback (normal). A file that is
 * PRESENT but unparseable is treated as corruption (data-loss risk, review H3):
 * the bad file is quarantined to `<file>.corrupt.<ts>` before the fallback is
 * returned, so the caller's subsequent write creates a fresh file instead of
 * silently overwriting (and destroying) the original.
 */
export function readJson<T>(file: string, fallback: T): T {
  let raw: string;
  try {
    raw = fs.readFileSync(file, "utf8");
  } catch {
    return fallback; // missing / unreadable -> fallback is correct
  }
  try {
    return JSON.parse(raw) as T;
  } catch {
    if (raw.trim()) {
      // Non-empty but corrupt: preserve it instead of letting it be overwritten.
      try { fs.renameSync(file, `${file}.corrupt.${Date.now()}`); } catch { /* best-effort */ }
    }
    return fallback;
  }
}

/** Write JSON via temp-file + atomic rename so readers never see a half-written file. */
export function writeJsonAtomic(file: string, data: unknown): void {
  ensureDir(path.dirname(file));
  const tmp = `${file}.tmp.${process.pid}.${Math.random().toString(36).slice(2)}`;
  fs.writeFileSync(tmp, JSON.stringify(data, null, 2), "utf8");
  fs.renameSync(tmp, file); // libuv uses MOVEFILE_REPLACE_EXISTING on Windows
}

/** Append a single line to a file (creating it + parents as needed). */
export function appendLine(file: string, line: string): void {
  ensureDir(path.dirname(file));
  fs.appendFileSync(file, line.endsWith("\n") ? line : line + "\n", "utf8");
}

export function nowIso(): string {
  return new Date().toISOString();
}

/** Short content hash of a file, or null if unreadable. */
export function hashFile(file: string): string | null {
  try {
    return crypto.createHash("sha256").update(fs.readFileSync(file)).digest("hex").slice(0, 16);
  } catch {
    return null;
  }
}

/**
 * Cross-process advisory lock via atomic mkdir. Breaks stale locks after `staleMs`.
 * Used to serialize read-modify-write on shared state files between agent processes.
 */
export async function withLock<T>(
  lockPath: string,
  fn: () => T | Promise<T>,
  opts?: { timeoutMs?: number; staleMs?: number }
): Promise<T> {
  const timeoutMs = opts?.timeoutMs ?? 5000;
  const staleMs = opts?.staleMs ?? 30000;
  ensureDir(path.dirname(lockPath));
  const start = Date.now();
  for (;;) {
    try {
      fs.mkdirSync(lockPath); // atomic: fails with EEXIST if held
      break;
    } catch (e: unknown) {
      const err = e as NodeJS.ErrnoException;
      if (err.code !== "EEXIST") throw e;
      try {
        const st = fs.statSync(lockPath);
        if (Date.now() - st.mtimeMs > staleMs) {
          try { fs.rmdirSync(lockPath); } catch { /* race: someone else broke it */ }
          continue;
        }
      } catch { /* lock vanished; retry */ }
      if (Date.now() - start > timeoutMs) throw new Error(`Timed out acquiring lock: ${lockPath}`);
      await new Promise((r) => setTimeout(r, 40));
    }
  }
  try {
    return await fn();
  } finally {
    try { fs.rmdirSync(lockPath); } catch { /* already gone */ }
  }
}

/**
 * Synchronous sibling of withLock: an atomic-mkdir advisory lock for short, sync
 * critical sections (e.g. the ledger append, which is a fire-and-forget sync call).
 * Same stale-break semantics; sleeps via Atomics so it doesn't busy-spin the CPU.
 */
export function withLockSync<T>(
  lockPath: string,
  fn: () => T,
  opts?: { timeoutMs?: number; staleMs?: number }
): T {
  const timeoutMs = opts?.timeoutMs ?? 5000;
  const staleMs = opts?.staleMs ?? 30000;
  ensureDir(path.dirname(lockPath));
  const sleep = (ms: number) => { try { Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, ms); } catch { /* no SAB */ } };
  const start = Date.now();
  for (;;) {
    try {
      fs.mkdirSync(lockPath); // atomic: EEXIST if held
      break;
    } catch (e: unknown) {
      const err = e as NodeJS.ErrnoException;
      if (err.code !== "EEXIST") throw e;
      try {
        const st = fs.statSync(lockPath);
        if (Date.now() - st.mtimeMs > staleMs) { try { fs.rmdirSync(lockPath); } catch { /* raced */ } continue; }
      } catch { /* lock vanished; retry */ }
      if (Date.now() - start > timeoutMs) throw new Error(`Timed out acquiring lock: ${lockPath}`);
      sleep(40);
    }
  }
  try {
    return fn();
  } finally {
    try { fs.rmdirSync(lockPath); } catch { /* already gone */ }
  }
}

/** Ensure a single entry exists in a project's .gitignore (idempotent). */
export function ensureGitignore(projectPath: string, entry: string): void {
  const gi = path.join(projectPath, ".gitignore");
  let content = "";
  try { content = fs.readFileSync(gi, "utf8"); } catch { /* none yet */ }
  const lines = content.split(/\r?\n/).map((l) => l.trim());
  if (lines.includes(entry.trim())) return;
  const sep = content && !content.endsWith("\n") ? "\n" : "";
  fs.writeFileSync(gi, content + sep + entry + "\n", "utf8");
}
