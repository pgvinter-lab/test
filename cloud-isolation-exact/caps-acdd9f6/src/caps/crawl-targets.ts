/**
 * src/caps/crawl-targets.ts
 * Manages the crawl targets configuration for the Caps subsystem.
 * This module is responsible for reading the owner-managed list of explicit
 * projects and rejecting paths that fall into one of the four rejection classes:
 * 1. Relative paths
 * 2. Repository-escaping paths
 * 3. Drive-exchange paths
 * 4. Reparse-points (symlinks/junctions)
 */

import fs from "node:fs";
import path from "node:path";
import type { CapsConfig } from "./config.js";

/**
 * Interface representing the structure of the crawl-targets.json file.
 * This is an owner-managed configuration file that lists absolute paths
 * to projects where `.mcp.json` files should be explicitly crawled.
 */
export interface CrawlTargets {
  /**
   * Array of absolute paths to project directories to crawl for `.mcp.json`.
   */
  projects: string[];
}

/**
 * Custom error class for reporting rejections during target validation.
 * While we primarily log warnings and skip invalid paths, this allows for
 * structured error representation if needed by callers.
 */
export class CrawlTargetRejectionError extends Error {
  constructor(public readonly path: string, public readonly rejectionClass: string, message: string) {
    super(`[${rejectionClass}] ${message}`);
    this.name = "CrawlTargetRejectionError";
  }
}

/**
 * Manages the discovery and validation of crawl targets.
 * Operates strictly on a credential-blind, bounded allowlist basis.
 */
export class CrawlTargetsManager {
  private targetsPath: string;
  public gaps: { family: string, config_path: string, kind: string, message: string }[] = [];

  /**
   * Constructs a new CrawlTargetsManager.
   * @param config The CapsConfig object providing environment details like stateDirectory.
   */
  constructor(private config: CapsConfig) {
    this.targetsPath = path.join(config.stateDirectory, "crawl-targets.json");
  }

  /**
   * Ensures that the crawl-targets.json file exists.
   * If it does not exist, it initializes a default empty configuration.
   * Note: This never replaces or modifies existing owner entries.
   */
  public ensureExists(): void {
    if (!fs.existsSync(this.targetsPath)) {
      const initial: CrawlTargets = { projects: [] };
      fs.mkdirSync(path.dirname(this.targetsPath), { recursive: true });
      fs.writeFileSync(this.targetsPath, JSON.stringify(initial, null, 2), "utf8");
    }
  }

  /**
   * Reads and validates the configured crawl targets.
   * Applies the four required rejection classes to ensure boundaries are respected.
   * Malformed files return an empty list of targets rather than throwing.
   *
   * @returns An array of validated absolute paths to crawl.
   */
  public readTargets(): string[] {
    this.ensureExists();
    this.gaps = [];

    let content: string;
    try {
      content = fs.readFileSync(this.targetsPath, "utf8");
    } catch (e) {
      this.gaps.push({ family: 'project', config_path: this.targetsPath, kind: 'missing', message: 'Failed to read crawl targets' });
      return [];
    }

    let parsed: any;
    try {
      parsed = JSON.parse(content);
    } catch (e) {
      this.gaps.push({ family: 'project', config_path: this.targetsPath, kind: 'malformed', message: 'Malformed crawl targets file' });
      return []; // Malformed files produce a structured gap (empty list)
    }

    if (!parsed || !Array.isArray(parsed.projects)) {
      this.gaps.push({ family: 'project', config_path: this.targetsPath, kind: 'malformed', message: 'projects must be an array' });
      return [];
    }

    const validTargets: string[] = [];

    for (const p of parsed.projects) {
      if (typeof p !== "string") {
        console.warn(`Rejected target: not a string (${typeof p}).`);
        continue;
      }

      const trimmedPath = p.trim();
      if (!trimmedPath) {
        continue;
      }

      // Rejection Class 1: Relative path
      if (!path.win32.isAbsolute(trimmedPath) && !path.posix.isAbsolute(trimmedPath)) {
        console.warn(`Rejected relative path: ${trimmedPath}`);
        continue;
      }

      // Rejection Class 2: Repository-escaping
      const splitSegments = trimmedPath.split(/[\\/]/);
      if (splitSegments.includes('..')) {
        console.warn(`Rejected repository-escaping path: ${trimmedPath}`);
        continue;
      }

      // Rejection Class 3: Drive-exchange
      const lowerPath = trimmedPath.toLowerCase();
      if (lowerPath.includes("google drive") || lowerPath.includes("my drive") || lowerPath.includes("bridge exchange")) {
        console.warn(`Rejected Drive-exchange path: ${trimmedPath}`);
        continue;
      }

      // Rejection Class 4: Reparse-point
      // Walk every existing path segment from the volume/root to the target
      let isSafe = true;
      try {
        let current = '';
        const parsed = path.parse(trimmedPath);
        current = parsed.root;
        const segments = trimmedPath.substring(parsed.root.length).split(/[\\/]/).filter(Boolean);

        for (const segment of segments) {
          current = path.join(current, segment);
          const stat = fs.lstatSync(current, { throwIfNoEntry: false });
          if (!stat) break; // Path doesn't exist yet, safe so far

          if (stat.isSymbolicLink()) {
            console.warn(`Rejected reparse-point target at segment ${current}: ${trimmedPath}`);
            isSafe = false;
            break;
          }

          const real = fs.realpathSync.native(current);
          if (process.platform === 'win32') {
             if (real.toLowerCase() !== path.resolve(current).toLowerCase()) {
               console.warn(`Rejected reparse-point mismatch at segment ${current}: ${trimmedPath}`);
               isSafe = false;
               break;
             }
          } else {
             if (real !== path.resolve(current)) {
               console.warn(`Rejected reparse-point mismatch at segment ${current}: ${trimmedPath}`);
               isSafe = false;
               break;
             }
          }
        }
      } catch (e: any) {
        console.warn(`Warning: Target path cannot be stat'd (reparse check failed).`);
        isSafe = false;
      }

      if (!isSafe) continue;

      validTargets.push(trimmedPath);
    }

    return validTargets;
  }

  /**
   * Helper utility to determine if a specific path is allowed based on the rules.
   * Exposed for testing specific rejection scenarios directly.
   */
  public isValidTarget(targetPath: string): boolean {
    if (typeof targetPath !== "string") return false;

    if (!path.win32.isAbsolute(targetPath) && !path.posix.isAbsolute(targetPath)) return false;

    if (targetPath.split(/[\\/]/).includes('..')) return false;

    const lower = targetPath.toLowerCase();
    if (lower.includes("google drive") || lower.includes("my drive") || lower.includes("bridge exchange")) return false;

    try {
        let current = '';
        const parsed = path.parse(targetPath);
        current = parsed.root;
        // On Windows, if we test a POSIX path like /opt/valid/project, path.parse might see root as '\'
        // Handle gracefully if parsed.root is empty
        if (!current) current = path.sep;

        const segments = targetPath.substring(parsed.root.length).split(/[\\/]/).filter(Boolean);
        for (const segment of segments) {
          current = path.join(current, segment);
          const stat = fs.lstatSync(current, { throwIfNoEntry: false });
          if (!stat) break;
          if (stat.isSymbolicLink()) return false;

          const real = fs.realpathSync.native(current);
          if (process.platform === 'win32') {
             if (real.toLowerCase() !== path.resolve(current).toLowerCase()) return false;
          } else {
             if (real !== path.resolve(current)) return false;
          }
        }
    } catch (e) {
      return false; // Fail closed on stat errors
    }

    return true;
  }
}
