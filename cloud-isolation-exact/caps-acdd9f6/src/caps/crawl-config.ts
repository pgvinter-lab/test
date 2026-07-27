/**
 * src/caps/crawl-config.ts
 * Bounded, credential-blind configuration discovery lane for Claude, project MCP files,
 * Codex, and Gemini/Antigravity settings.
 *
 * Objective: Discover installed server declarations and emit normalized observations.
 * NEVER call tools, infer health, scan arbitrary drives, or retain secrets.
 */

import fs from "node:fs";
import path from "node:path";
import crypto from "node:crypto";
import os from "node:os";
import { CapsConfig } from "./config.js";
import { CapsStore } from "./store.js";
import { CrawlTargetsManager } from "./crawl-targets.js";
import { SurfaceOwner, TransportLayer } from "./types.js";

export interface CrawlGap {
  family: 'claude' | 'codex' | 'gemini' | 'project';
  config_path: string;
  kind: 'missing' | 'malformed' | 'unsupported';
  line?: number;
  message: string;
}

export interface CrawlReport {
  started_at: string;
  completed_at: string;
  observation_count: number;
  gaps: CrawlGap[];
}

const SECRET_KEY_REGEX = /(token|secret|password|api[_-]?key|apikey|authorization|bearer|cookie|credential|oauth|client[_-]?secret|access[_-]?token|refresh[_-]?token|profile[_-]?directory|user[_-]?data[_-]?dir)/i;
const FLAG_REGEX = /^--?([a-zA-Z0-9_-]+)(?:=(.*))?$/;

/**
 * Explicit stable ordinal/code-unit comparator for cross-host determinism.
 */
export function compareOrdinal(a: string, b: string): number {
  if (a === b) return 0;
  return a < b ? -1 : 1;
}

/**
 * Sanitizes a URL by removing userinfo (username/password), query string, and fragment.
 */
export function sanitizeUrl(urlStr: string): string | null {
  if (!urlStr) return null;
  try {
    const u = new URL(urlStr);
    u.username = '';
    u.password = '';
    u.search = '';
    u.hash = '';
    return u.toString();
  } catch (e) {
    return null;
  }
}

/**
 * Normalizes and redacts arguments to ensure no secrets are leaked.
 */
export function sanitizeArgs(args: string[]): string[] {
  if (!Array.isArray(args)) return [];
  const sanitized: string[] = [];

  let skipNext = false;
  for (let i = 0; i < args.length; i++) {
    const arg = String(args[i]);

    if (skipNext) {
      sanitized.push('[REDACTED]');
      skipNext = false;
      continue;
    }

    let processedArg = arg;
    if (/^[a-zA-Z][a-zA-Z0-9+.-]*:\/\//.test(processedArg)) {
      const cleanUrl = sanitizeUrl(processedArg);
      if (cleanUrl) processedArg = cleanUrl;
    }

    const flagMatch = processedArg.match(FLAG_REGEX);
    if (flagMatch) {
      const flagName = flagMatch[1];
      const hasEquals = processedArg.includes('=');

      if (SECRET_KEY_REGEX.test(flagName) || flagName === 'H' || flagName.toLowerCase() === 'header') {
        if (hasEquals) {
          const firstEq = processedArg.indexOf('=');
          const key = processedArg.substring(0, firstEq);
          sanitized.push(`${key}=[REDACTED]`);
        } else {
          sanitized.push(processedArg);
          skipNext = true;
        }
      } else {
         if (hasEquals) {
            const firstEq = processedArg.indexOf('=');
            const key = processedArg.substring(0, firstEq);
            const val = processedArg.substring(firstEq + 1);
            if (SECRET_KEY_REGEX.test(val)) {
               sanitized.push(`${key}=[REDACTED]`);
            } else {
               sanitized.push(processedArg);
            }
         } else {
            sanitized.push(processedArg);
         }
      }
    } else {
       if (processedArg.includes('=')) {
          const firstEq = processedArg.indexOf('=');
          const key = processedArg.substring(0, firstEq);
          const val = processedArg.substring(firstEq + 1);
          if (SECRET_KEY_REGEX.test(key) || key.toLowerCase() === 'header' || SECRET_KEY_REGEX.test(val)) {
             sanitized.push(`${key}=[REDACTED]`);
          } else {
             sanitized.push(processedArg);
          }
       } else if (processedArg.includes(':')) {
          const firstColon = processedArg.indexOf(':');
          const key = processedArg.substring(0, firstColon);
          const val = processedArg.substring(firstColon + 1);
          if (SECRET_KEY_REGEX.test(key) || SECRET_KEY_REGEX.test(val)) {
             sanitized.push(`${key}:[REDACTED]`);
          } else {
             sanitized.push(processedArg);
          }
       } else {
          if (SECRET_KEY_REGEX.test(processedArg)) {
             sanitized.push('[REDACTED]');
          } else {
             sanitized.push(processedArg);
          }
       }
    }
  }
  return sanitized;
}

export interface NormalizedDeclaration {
  id: string;
  name: string;
  slug: string;
  surface_owner: SurfaceOwner;
  transport: TransportLayer;
  source_url: string | null;
  install_command: string | null;
  raw_json: string;
  config_path: string;
  project_scope: string | null;
  source_format?: 'gemini';
}

interface ParsedCodex {
  mcp_servers: Record<string, { command?: string; args?: string[]; url?: string; enabled?: boolean }>;
}

export function parseCodexToml(content: string, filePath: string, onGap: (line: number, msg: string) => void): ParsedCodex {
  const result: ParsedCodex = { mcp_servers: {} };
  let currentServer: string | null = null;
  const invalidServers = new Set<string>();

  const lines = content.split('\n');
  for (let i = 0; i < lines.length; i++) {
    const line = lines[i].trim();
    if (!line || line.startsWith('#')) continue;

    const sectionMatch = line.match(/^\[([^\]]+)\]$/);
    if (sectionMatch) {
      const section = sectionMatch[1].trim();
      if (section.startsWith('mcp_servers.')) {
        currentServer = section.substring(12);
        if ((currentServer.startsWith('"') && currentServer.endsWith('"')) || (currentServer.startsWith("'") && currentServer.endsWith("'"))) {
          currentServer = currentServer.slice(1, -1);
        }
        if (!result.mcp_servers[currentServer]) {
           result.mcp_servers[currentServer] = {};
        }
      } else {
        currentServer = null; // Reset on unrelated/nested sections
      }
      continue;
    }

    if (currentServer && !invalidServers.has(currentServer)) {
      const kvMatch = line.match(/^([a-zA-Z0-9_-]+)\s*=\s*(.*)$/);
      if (kvMatch) {
        const key = kvMatch[1];
        let valStr = kvMatch[2].trim();

        if (!['command', 'args', 'url', 'enabled'].includes(key)) {
           invalidServers.add(currentServer);
           delete result.mcp_servers[currentServer];
           onGap(i + 1, "Unsupported TOML key");
           continue;
        }

        try {
          if (valStr === 'true') {
            (result.mcp_servers[currentServer] as any)[key] = true;
          } else if (valStr === 'false') {
            (result.mcp_servers[currentServer] as any)[key] = false;
          } else if (valStr.startsWith('"') && valStr.endsWith('"') && valStr.split('"').length === 3) {
            (result.mcp_servers[currentServer] as any)[key] = valStr.substring(1, valStr.length - 1);
          } else if (valStr.startsWith('[') && valStr.endsWith(']')) {
            const arrContent = valStr.substring(1, valStr.length - 1).trim();
            if (!arrContent) {
              (result.mcp_servers[currentServer] as any)[key] = [];
            } else {
              const elements = arrContent.split(',').map(s => s.trim());
              const parsedArray = [];
              for (const el of elements) {
                if (el.startsWith('"') && el.endsWith('"') && el.split('"').length === 3) {
                  parsedArray.push(el.substring(1, el.length - 1));
                } else if (el === '') {
                   // trailing comma
                } else {
                  throw new Error(`Unsupported array element`);
                }
              }
              (result.mcp_servers[currentServer] as any)[key] = parsedArray;
            }
          } else {
            invalidServers.add(currentServer);
            delete result.mcp_servers[currentServer];
            onGap(i + 1, "Unsupported TOML syntax");
          }
        } catch (e) {
          invalidServers.add(currentServer);
          delete result.mcp_servers[currentServer];
          onGap(i + 1, "Unsupported TOML syntax");
        }
      } else {
        invalidServers.add(currentServer);
        delete result.mcp_servers[currentServer];
        onGap(i + 1, "Unsupported TOML syntax");
      }
    }
  }

  return result;
}

export class CrawlConfigLane {
  private targetsManager: CrawlTargetsManager;
  private gaps: CrawlGap[] = [];
  private obsCount = 0;

  constructor(private config: CapsConfig, private store: CapsStore) {
    this.targetsManager = new CrawlTargetsManager(this.config);
  }

  private addGap(family: CrawlGap['family'], config_path: string, kind: CrawlGap['kind'], message: string, line?: number) {
    this.gaps.push({ family, config_path, kind, message, line });
  }

  private readJsonSafe(filePath: string, family: CrawlGap['family']): any | null {
    try {
      if (!fs.existsSync(filePath)) {
        console.warn(`[CrawlConfig] Warning: File not found: ${filePath}`);
        this.addGap(family, filePath, 'missing', 'File not found');
        return null;
      }
      const content = fs.readFileSync(filePath, "utf8");
      return JSON.parse(content);
    } catch (e) {
      console.error(`[CrawlConfig] Malformed JSON in ${filePath}. Ignoring file.`);
      this.addGap(family, filePath, 'malformed', 'JSON parse failed');
      return null;
    }
  }

  private generateId(surface: SurfaceOwner, name: string, projectScope: string | null): string {
    const payload = `${surface}:${name}:${projectScope || 'global'}`;
    return crypto.createHash("sha256").update(payload).digest("hex");
  }

  private normalizeDeclaration(
    name: string,
    raw: any,
    surface: SurfaceOwner,
    configPath: string,
    projectScope: string | null,
    sourceFormat?: 'gemini'
  ): NormalizedDeclaration | null {
    if (!raw || typeof raw !== 'object') return null;

    let command = typeof raw.command === 'string' ? raw.command : null;
    let url = typeof raw.url === 'string' ? sanitizeUrl(raw.url) : null;

    if (!command && !url) return null;

    let args: string[] = [];
    if (Array.isArray(raw.args)) {
      args = raw.args.map((a: any) => String(a));
    }

    const sanitizedArgs = sanitizeArgs(args);

    const transport: TransportLayer = url ? 'http' : 'stdio';
    let executableBasename = null;
    if (command) {
       const parts = command.split(/[\\/]/);
       executableBasename = parts[parts.length - 1];
    }

    const safeObj = {
      command: executableBasename,
      args: sanitizedArgs,
      url: url,
      enabled: typeof raw.enabled === 'boolean' ? raw.enabled : undefined,
      config_path: configPath,
      project_scope: projectScope
    };

    return {
      id: this.generateId(surface, name, projectScope),
      name: name,
      slug: `${surface}-${name}`,
      surface_owner: surface,
      transport: transport,
      source_url: url,
      install_command: executableBasename ? `${executableBasename} ${sanitizedArgs.join(" ")}` : null,
      raw_json: JSON.stringify(safeObj),
      config_path: configPath,
      project_scope: projectScope,
      source_format: sourceFormat
    };
  }

  private upsertDeclaration(decl: NormalizedDeclaration) {
    const now = new Date().toISOString();
    let first_observed_at = now;
    let targetTable: 'installed_broken' | 'installed_working' = 'installed_broken';
    let curated_notes = null;
    let tools_json = null;
    let detail_json = null;
    let last_verified = null;
    let source_lane: 'config-crawl' | 'probe' | 'census' = 'config-crawl';
    let failure_reason: string | null = 'verification_pending';
    let failure_observed_at: string | null = now;

    try {
      let existingRow = this.store.db.prepare("SELECT observed_at, provenance_json, curated_notes, tools_json, detail_json, last_verified, source_lane, failure_reason, failure_observed_at FROM installed_broken WHERE id = ?").get(decl.id) as any;
      if (!existingRow) {
         existingRow = this.store.db.prepare("SELECT observed_at, provenance_json, curated_notes, tools_json, detail_json, last_verified, source_lane FROM installed_working WHERE id = ?").get(decl.id) as any;
         if (existingRow) {
            targetTable = 'installed_working';
         }
      }

      if (existingRow) {
         first_observed_at = existingRow.observed_at;
         curated_notes = existingRow.curated_notes;
         tools_json = existingRow.tools_json;
         detail_json = existingRow.detail_json;
         last_verified = existingRow.last_verified;
         source_lane = existingRow.source_lane;

         if (targetTable === 'installed_broken' && (source_lane === 'probe' || source_lane === 'census')) {
            failure_reason = existingRow.failure_reason;
            failure_observed_at = existingRow.failure_observed_at;
         }

         if (existingRow.provenance_json) {
            try {
               const prov = JSON.parse(existingRow.provenance_json);
               if (prov.first_observed_at) first_observed_at = prov.first_observed_at;
            } catch(e) {}
         }
      }
    } catch(e) {}

    const stale_at = new Date(new Date(now).getTime() + 24 * 60 * 60 * 1000).toISOString();

    const provObj: any = {
      config_path: decl.config_path,
      first_observed_at: first_observed_at
    };
    if (decl.project_scope) provObj.project_scope = decl.project_scope;
    if (decl.source_format) provObj.source_format = decl.source_format;

    const payload = {
      id: decl.id,
      kind: 'server' as const,
      name: decl.name,
      slug: decl.slug,
      source_url: decl.source_url,
      surface_owner: decl.surface_owner,
      transport: decl.transport,
      description: `Discovered from ${decl.config_path}`,
      pricing: 'unknown' as const,
      official: 0 as const,
      stars: null,
      install_command: decl.install_command,
      source_lane: source_lane,
      producer_surface: 'code' as const,
      capture_class: 'guaranteed' as const,
      observed_at: now,
      last_verified: last_verified,
      stale_at: stale_at,
      provenance_json: JSON.stringify(provObj),
      raw_json: decl.raw_json,
      failure_reason: failure_reason,
      failure_observed_at: failure_observed_at,
      curated_notes: curated_notes,
      tools_json: tools_json,
      detail_json: detail_json
    };

    this.store.upsertCapability(targetTable, payload);
    this.obsCount++;
  }

  private crawlClaude(homeDir: string) {
    const claudePath = path.join(homeDir, ".claude.json");
    const parsed = this.readJsonSafe(claudePath, 'claude');
    if (!parsed) return;

    if (parsed.mcpServers && typeof parsed.mcpServers === 'object') {
      const keys = Object.keys(parsed.mcpServers).sort(compareOrdinal);
      for (const name of keys) {
        const decl = this.normalizeDeclaration(name, parsed.mcpServers[name], 'claude', claudePath, null);
        if (decl) this.upsertDeclaration(decl);
      }
    }

    if (parsed.projects && typeof parsed.projects === 'object') {
      const pKeys = Object.keys(parsed.projects).sort(compareOrdinal);
      for (const projPath of pKeys) {
        const projConf = parsed.projects[projPath];
        if (projConf.mcpServers && typeof projConf.mcpServers === 'object') {
          const sKeys = Object.keys(projConf.mcpServers).sort(compareOrdinal);
          for (const name of sKeys) {
             const decl = this.normalizeDeclaration(name, projConf.mcpServers[name], 'claude', claudePath, projPath);
             if (decl) this.upsertDeclaration(decl);
          }
        }
      }
    }
  }

  private crawlProjectMcp() {
    const targets = this.targetsManager.readTargets().sort(compareOrdinal);

    for (const gap of this.targetsManager.gaps) {
       this.addGap(gap.family as any, gap.config_path, gap.kind as any, gap.message);
    }

    for (const target of targets) {
      const mcpPath = path.join(target, ".mcp.json");
      const parsed = this.readJsonSafe(mcpPath, 'project');
      if (!parsed) continue;

      if (parsed.mcpServers && typeof parsed.mcpServers === 'object') {
        const keys = Object.keys(parsed.mcpServers).sort(compareOrdinal);
        for (const name of keys) {
          const decl = this.normalizeDeclaration(name, parsed.mcpServers[name], 'n/a', mcpPath, target);
          if (decl) this.upsertDeclaration(decl);
        }
      }
    }
  }


  private crawlCodex(homeDir: string) {
    const codexPath = path.join(homeDir, ".codex", "config.toml");
    if (!fs.existsSync(codexPath)) {
      console.warn(`[CrawlConfig] Warning: File not found: ${codexPath}`);
      this.addGap('codex', codexPath, 'missing', 'File not found');
      return;
    }

    let content: string;
    try {
      content = fs.readFileSync(codexPath, "utf8");
    } catch (e) {
      console.warn(`[CrawlConfig] Failed to read ${codexPath}`);
      this.addGap('codex', codexPath, 'missing', 'Failed to read file');
      return;
    }

    const parsed = parseCodexToml(content, codexPath, (line, msg) => {
       console.warn(`[CrawlConfig] ${msg} in ${codexPath}:${line}`);
       this.addGap('codex', codexPath, 'unsupported', msg, line);
    });

    const keys = Object.keys(parsed.mcp_servers).sort(compareOrdinal);
    for (const name of keys) {
      const config = parsed.mcp_servers[name];
      if (config.enabled === false) continue;
      const decl = this.normalizeDeclaration(name, config, 'codex', codexPath, null);
      if (decl) this.upsertDeclaration(decl);
    }
  }

  private crawlGemini(homeDir: string) {
    const geminiPath = path.join(homeDir, ".gemini", "settings.json");
    const parsed = this.readJsonSafe(geminiPath, 'gemini');
    if (!parsed) return;

    const seenServers = new Set<string>();

    // Process canonical mcpServers first, it wins
    if (parsed.mcpServers && typeof parsed.mcpServers === 'object') {
      const keys = Object.keys(parsed.mcpServers).sort(compareOrdinal);
      for (const name of keys) {
        seenServers.add(name);
        const decl = this.normalizeDeclaration(name, parsed.mcpServers[name], 'agy', geminiPath, null, 'gemini');
        if (decl) this.upsertDeclaration(decl);
      }
    }

    // Process legacy mcp.servers only for keys not in mcpServers
    if (parsed.mcp && parsed.mcp.servers && typeof parsed.mcp.servers === 'object') {
      const keys = Object.keys(parsed.mcp.servers).sort(compareOrdinal);
      for (const name of keys) {
        if (!seenServers.has(name)) {
          const decl = this.normalizeDeclaration(name, parsed.mcp.servers[name], 'agy', geminiPath, null, 'gemini');
          if (decl) this.upsertDeclaration(decl);
        }
      }
    }
  }

  public executeCrawl(overrideHomeDir?: string): CrawlReport {
    const started_at = new Date().toISOString();
    const homeDir = overrideHomeDir || os.homedir();

    this.gaps = [];
    this.obsCount = 0;

    this.crawlClaude(homeDir);

    this.crawlCodex(homeDir);
    this.crawlGemini(homeDir);
    this.crawlProjectMcp();

    this.gaps.sort((a, b) => {
       if (a.config_path !== b.config_path) return compareOrdinal(a.config_path, b.config_path);
       if (a.line !== b.line) return (a.line || 0) - (b.line || 0);
       return compareOrdinal(a.message, b.message);
    });

    return {
       started_at,
       completed_at: new Date().toISOString(),
       observation_count: this.obsCount,
       gaps: this.gaps
    };
  }
}
