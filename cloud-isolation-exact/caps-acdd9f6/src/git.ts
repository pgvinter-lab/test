import { execFileSync } from "node:child_process";
import path from "node:path";
import { ensureDir } from "./util.js";

function git(dir: string, args: string[], opts?: { allowFail?: boolean }): string {
  try {
    return execFileSync("git", args, {
      cwd: dir,
      encoding: "utf8",
      stdio: ["ignore", "pipe", "pipe"],
    }).trim();
  } catch (e: unknown) {
    if (opts?.allowFail) return "";
    const err = e as { stderr?: Buffer | string; message?: string };
    const msg = (err.stderr?.toString?.() || err.message || String(e)).trim();
    throw new Error(`git ${args.join(" ")} failed: ${msg}`);
  }
}

export function hasGit(): boolean {
  try { execFileSync("git", ["--version"], { stdio: "ignore" }); return true; } catch { return false; }
}

export function isGitRepo(dir: string): boolean {
  return git(dir, ["rev-parse", "--is-inside-work-tree"], { allowFail: true }) === "true";
}

export function initRepo(dir: string): void {
  git(dir, ["init"]);
  // Best-effort: name the default branch 'main' if the repo is fresh.
  git(dir, ["symbolic-ref", "HEAD", "refs/heads/main"], { allowFail: true });
}

export function headCommit(dir: string): string | null {
  return git(dir, ["rev-parse", "HEAD"], { allowFail: true }) || null;
}

export function currentBranch(dir: string): string {
  return git(dir, ["rev-parse", "--abbrev-ref", "HEAD"], { allowFail: true }) || "main";
}

export function isDirty(dir: string): boolean {
  return git(dir, ["status", "--porcelain"], { allowFail: true }).length > 0;
}

/** Bundle the entire history into a single portable file (Drive-safe). */
export function bundleCreate(dir: string, outFile: string): void {
  ensureDir(path.dirname(outFile));
  git(dir, ["bundle", "create", outFile, "--all"]);
}

export function ensureRemote(dir: string, name: string, url: string): void {
  const existing = git(dir, ["remote", "get-url", name], { allowFail: true });
  if (!existing) git(dir, ["remote", "add", name, url]);
  else if (existing !== url) git(dir, ["remote", "set-url", name, url]);
}

export function push(dir: string, remote: string, branch?: string): void {
  git(dir, ["push", remote, branch || currentBranch(dir)]);
}

export function cloneFrom(source: string, dest: string): void {
  execFileSync("git", ["clone", source, dest], { encoding: "utf8" });
}
