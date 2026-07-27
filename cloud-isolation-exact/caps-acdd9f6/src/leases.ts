import fs from "node:fs";
import path from "node:path";

/** Directories never considered for freshness scanning. */
const IGNORE = new Set([
  "node_modules", ".git", ".connector", "dist", ".bridge-home",
  ".vscode", ".idea", "out", "build", ".next", ".cache", ".turbo",
]);

/**
 * Normalize a claim/lease path to a comparable form:
 *  - backslashes -> forward slashes
 *  - strip trailing slashes and glob suffixes (`/**`, `/*`)
 *  - strip leading `./` and `/`
 * A bare "." means "the whole project".
 */
export function normalizeClaim(p: string): string {
  let s = p.replace(/\\/g, "/").trim();
  s = s.replace(/\/+$/, "");
  s = s.replace(/\/\*\*?$/, "");
  s = s.replace(/^\.\//, "");
  s = s.replace(/^\/+/, "");
  return s === "" ? "." : s;
}

/** True if two claim paths cover any common file (equal, or one is an ancestor dir of the other). */
export function pathsOverlap(a: string, b: string): boolean {
  const na = normalizeClaim(a);
  const nb = normalizeClaim(b);
  if (na === nb) return true;
  if (na === "." || nb === ".") return true; // whole-project claim overlaps everything
  return na.startsWith(nb + "/") || nb.startsWith(na + "/");
}

/**
 * Files under `projectPath` modified after `since` (epoch ms). This is the freshness signal:
 * "what changed since you last synced", by filesystem mtime — no read-tracking hooks needed.
 * Returns project-relative POSIX paths, capped at `limit`.
 */
export function changedSince(projectPath: string, since: number, limit = 300): string[] {
  const out: string[] = [];
  const walk = (dir: string): void => {
    if (out.length >= limit) return;
    let entries: fs.Dirent[];
    try { entries = fs.readdirSync(dir, { withFileTypes: true }); } catch { return; }
    for (const e of entries) {
      if (out.length >= limit) return;
      if (IGNORE.has(e.name)) continue;
      const full = path.join(dir, e.name);
      if (e.isDirectory()) {
        walk(full);
      } else {
        try {
          if (fs.statSync(full).mtimeMs > since) {
            out.push(path.relative(projectPath, full).replace(/\\/g, "/"));
          }
        } catch { /* unreadable; skip */ }
      }
    }
  };
  walk(projectPath);
  return out;
}
