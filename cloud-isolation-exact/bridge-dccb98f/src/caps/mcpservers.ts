import crypto from "node:crypto";
import fs from "node:fs";
import path from "node:path";
import type { CapsConfig } from "./config.js";
import { assertContainedPathWithoutReparse } from "./config.js";
import {
  fetchWithPolicy,
  RateLimitError,
  type FetchPolicyOptions,
  type FetchResult,
  type SleepImplementation,
} from "./fetch-policy.js";
import {
  parseDetail,
  parseListings,
  parseRootSitemaps,
  parseSearchTotal,
  parseSitemapEntries,
  type ParsedCapability,
  type SitemapEntry,
} from "./mcpservers-parser.js";
import type { CapsStore } from "./store.js";

const STATE_SCHEMA = "bridge-caps-mcpservers-state-v1";
const REPORT_SCHEMA = "bridge-caps-mcpservers-refresh-v1";
const PARSER_VERSION = "bridge-caps-mcpservers-parser-v1";
const DEFAULT_WATCH_TERMS = ["official", "curated"];
const DEFAULT_REQUEST_DELAY_MS = 750;
const DEFAULT_MAX_BULK_PAGES = 1_000;
const MAX_WATCH_TERMS = 32;
const MAX_REPORT_MESSAGES = 2_000;

type InstalledTable = "installed_working" | "installed_broken";
type Phase = "server" | "skill" | "done";
type Row = Record<string, unknown>;

interface StoredEntry {
  kind: "server" | "skill";
  url: string;
  lastmod: string | null;
}

interface BackfillState {
  schema: typeof STATE_SCHEMA;
  universe_hash: string | null;
  entries: Record<string, StoredEntry>;
  pending: string[];
  phase: Phase;
  server_page: number;
  skill_page: number;
  watch_totals: Record<string, number>;
  updated_at: string | null;
}

interface FetchLogEntry {
  url: string;
  outcome: "ok" | "error";
  status?: number;
  bytes?: number;
  sha256?: string;
  attempts?: number;
  parser?: string;
  error?: string;
}

interface ObservedTotal {
  value: number;
  previous: number | null;
  delta: number | null;
  observed_at: string;
  source_url: string;
  response_sha256: string;
}

export interface McpserversRefreshReport {
  schema: typeof REPORT_SCHEMA;
  started_at: string;
  finished_at: string | null;
  stated_totals: Record<string, ObservedTotal>;
  diff: {
    new_count: number;
    changed_count: number;
    removed_count: number;
    new: string[];
    changed: string[];
    removed: string[];
  };
  processed: number;
  skipped_installed: number;
  pending: number;
  gaps: string[];
  errors: string[];
  fetch_log: FetchLogEntry[];
}

export interface McpserversIndexerOptions {
  watchTerms?: string[];
  requestDelayMs?: number;
  maxBulkPages?: number;
  fetchPolicy?: FetchPolicyOptions;
  sleepImpl?: SleepImplementation;
  nowImpl?: () => number;
}

interface LoadedState {
  state: BackfillState;
  gaps: string[];
}

function emptyState(): BackfillState {
  return {
    schema: STATE_SCHEMA,
    universe_hash: null,
    entries: {},
    pending: [],
    phase: "server",
    server_page: 1,
    skill_page: 1,
    watch_totals: {},
    updated_at: null,
  };
}

function isPlainObject(value: unknown): value is Record<string, unknown> {
  return Boolean(value)
    && typeof value === "object"
    && !Array.isArray(value);
}

function boundedMessage(value: unknown): string {
  const text = value instanceof Error ? value.message : String(value);
  return text
    .replace(
      /\b(?:Bearer\s+|token\s*[:=]\s*|secret\s*[:=]\s*|password\s*[:=]\s*|api[_-]?key\s*[:=]\s*)\S+/gi,
      "[REDACTED]",
    )
    .replace(/[\r\n]+/g, " ")
    .slice(0, 512);
}

function validateWatchTerms(value: string[] | undefined): string[] {
  const source = value ?? DEFAULT_WATCH_TERMS;
  if (!Array.isArray(source) || source.length > MAX_WATCH_TERMS) {
    throw new Error("mcpservers_watch_terms_invalid");
  }
  const terms = new Set<string>();
  for (const raw of source) {
    const term = raw.trim().toLowerCase();
    if (
      !/^[a-z0-9][a-z0-9 ._+-]{0,63}$/.test(term)
      || /(?:token|secret|password|api[_-]?key|credential)/i.test(term)
    ) {
      throw new Error("mcpservers_watch_term_invalid");
    }
    terms.add(term);
  }
  return [...terms].sort();
}

function parseProvenance(row: Row | undefined): Record<string, unknown> {
  try {
    const parsed = row?.provenance_json
      ? JSON.parse(String(row.provenance_json))
      : {};
    return isPlainObject(parsed) ? parsed : {};
  } catch {
    return {};
  }
}

function deterministicId(item: ParsedCapability): string {
  const digest = crypto.createHash("sha256")
    .update(`${item.kind}\0${item.source_url}`)
    .digest("hex")
    .slice(0, 32);
  return `caps.public.${digest}`;
}

function canonicalEntries(
  entries: Map<string, SitemapEntry>,
): Record<string, StoredEntry> {
  return Object.fromEntries(
    [...entries.entries()]
      .sort(([left], [right]) => left.localeCompare(right))
      .map(([identity, entry]) => [
        identity,
        { kind: entry.kind, url: entry.url, lastmod: entry.lastmod },
      ]),
  );
}

function universeHash(entries: Record<string, StoredEntry>): string {
  return crypto.createHash("sha256")
    .update(JSON.stringify(entries))
    .digest("hex");
}

function sameStoredEntry(
  left: StoredEntry,
  right: StoredEntry,
): boolean {
  return left.kind === right.kind
    && left.url === right.url
    && left.lastmod === right.lastmod;
}

function validateLoadedState(value: unknown): BackfillState | null {
  if (
    !isPlainObject(value)
    || value.schema !== STATE_SCHEMA
    || (value.universe_hash !== null
      && typeof value.universe_hash !== "string")
    || !isPlainObject(value.entries)
    || !Array.isArray(value.pending)
    || !["server", "skill", "done"].includes(String(value.phase))
    || !Number.isInteger(value.server_page)
    || Number(value.server_page) < 1
    || !Number.isInteger(value.skill_page)
    || Number(value.skill_page) < 1
    || !isPlainObject(value.watch_totals)
  ) {
    return null;
  }
  const entries: Record<string, StoredEntry> = {};
  for (const [identity, raw] of Object.entries(value.entries)) {
    if (
      !isPlainObject(raw)
      || !["server", "skill"].includes(String(raw.kind))
      || typeof raw.url !== "string"
      || (raw.lastmod !== null && typeof raw.lastmod !== "string")
    ) {
      return null;
    }
    entries[identity] = {
      kind: raw.kind as "server" | "skill",
      url: raw.url,
      lastmod: raw.lastmod as string | null,
    };
  }
  const pending = value.pending.filter(
    (entry): entry is string => typeof entry === "string",
  );
  if (pending.length !== value.pending.length) return null;
  const watchTotals: Record<string, number> = {};
  for (const [term, total] of Object.entries(value.watch_totals)) {
    if (!Number.isSafeInteger(total) || Number(total) < 0) return null;
    watchTotals[term] = Number(total);
  }
  return {
    schema: STATE_SCHEMA,
    universe_hash: value.universe_hash as string | null,
    entries,
    pending: [...new Set(pending)].sort(),
    phase: value.phase as Phase,
    server_page: Number(value.server_page),
    skill_page: Number(value.skill_page),
    watch_totals: watchTotals,
    updated_at: typeof value.updated_at === "string"
      ? value.updated_at
      : null,
  };
}

export class McpserversIndexer {
  private readonly watchTerms: string[];
  private readonly requestDelayMs: number;
  private readonly maxBulkPages: number;
  private readonly fetchPolicy: FetchPolicyOptions;
  private readonly sleepImpl: SleepImplementation;
  private readonly nowImpl: () => number;
  private lastRequestAt: number | null = null;
  private tempSequence = 0;

  constructor(
    private readonly store: CapsStore,
    private readonly config: CapsConfig,
    options: McpserversIndexerOptions = {},
  ) {
    this.watchTerms = validateWatchTerms(options.watchTerms);
    this.requestDelayMs =
      options.requestDelayMs ?? DEFAULT_REQUEST_DELAY_MS;
    if (
      !Number.isInteger(this.requestDelayMs)
      || this.requestDelayMs < DEFAULT_REQUEST_DELAY_MS
      || this.requestDelayMs > 60_000
    ) {
      throw new Error("mcpservers_request_delay_invalid");
    }
    this.maxBulkPages =
      options.maxBulkPages ?? DEFAULT_MAX_BULK_PAGES;
    if (
      !Number.isInteger(this.maxBulkPages)
      || this.maxBulkPages < 1
      || this.maxBulkPages > DEFAULT_MAX_BULK_PAGES
    ) {
      throw new Error("mcpservers_max_bulk_pages_invalid");
    }
    this.fetchPolicy = options.fetchPolicy ?? {};
    this.sleepImpl = options.sleepImpl
      ?? options.fetchPolicy?.sleepImpl
      ?? ((milliseconds, signal) =>
        new Promise<void>((resolve, reject) => {
          if (signal?.aborted) {
            reject(new Error("fetch_policy_aborted"));
            return;
          }
          const timer = setTimeout(resolve, milliseconds);
          signal?.addEventListener("abort", () => {
            clearTimeout(timer);
            reject(new Error("fetch_policy_aborted"));
          }, { once: true });
        }));
    this.nowImpl = options.nowImpl
      ?? options.fetchPolicy?.nowImpl
      ?? Date.now;
  }

  private nowIso(): string {
    return new Date(this.nowImpl()).toISOString();
  }

  private statePath(): string {
    const target = path.join(
      this.config.stateDirectory,
      "mcpservers-backfill-v1.json",
    );
    assertContainedPathWithoutReparse(
      target,
      this.config.stateDirectory,
      "caps_mcpservers_state_reparse_forbidden",
    );
    return target;
  }

  private reportPath(): string {
    const target = path.join(
      this.config.stateDirectory,
      "mcpservers-refresh-v1.json",
    );
    assertContainedPathWithoutReparse(
      target,
      this.config.stateDirectory,
      "caps_mcpservers_report_reparse_forbidden",
    );
    return target;
  }

  private atomicWriteJson(target: string, value: unknown): void {
    this.tempSequence += 1;
    const temporary =
      `${target}.tmp-${process.pid}-${this.tempSequence}`;
    assertContainedPathWithoutReparse(
      temporary,
      this.config.stateDirectory,
      "caps_mcpservers_temp_reparse_forbidden",
    );
    try {
      fs.writeFileSync(
        temporary,
        `${JSON.stringify(value, null, 2)}\n`,
        { encoding: "utf8", mode: 0o600, flag: "wx" },
      );
      fs.renameSync(temporary, target);
    } finally {
      if (fs.existsSync(temporary)) {
        fs.rmSync(temporary, { force: true });
      }
    }
  }

  private loadState(): LoadedState {
    const target = this.statePath();
    if (!fs.existsSync(target)) return { state: emptyState(), gaps: [] };
    try {
      const parsed = JSON.parse(fs.readFileSync(target, "utf8"));
      const state = validateLoadedState(parsed);
      return state
        ? { state, gaps: [] }
        : {
            state: emptyState(),
            gaps: ["checkpoint_shape_invalid"],
          };
    } catch {
      return {
        state: emptyState(),
        gaps: ["checkpoint_json_invalid"],
      };
    }
  }

  private addGap(
    report: McpserversRefreshReport,
    message: string,
  ): void {
    if (report.gaps.length < MAX_REPORT_MESSAGES) {
      report.gaps.push(boundedMessage(message));
    }
  }

  private addError(
    report: McpserversRefreshReport,
    error: unknown,
  ): void {
    if (report.errors.length < MAX_REPORT_MESSAGES) {
      report.errors.push(boundedMessage(error));
    }
  }

  private async pacedFetch(
    url: string,
    report: McpserversRefreshReport,
    signal?: AbortSignal,
  ): Promise<FetchResult> {
    if (this.lastRequestAt !== null) {
      const elapsed = Math.max(0, this.nowImpl() - this.lastRequestAt);
      const wait = Math.max(0, this.requestDelayMs - elapsed);
      if (wait > 0) await this.sleepImpl(wait, signal);
    }
    try {
      const result = await fetchWithPolicy(url, {
        ...this.fetchPolicy,
        signal,
      });
      this.lastRequestAt = this.nowImpl();
      if (report.fetch_log.length < MAX_REPORT_MESSAGES) {
        report.fetch_log.push({
          url: result.url,
          outcome: "ok",
          status: result.status,
          bytes: result.bytes,
          sha256: result.sha256,
          attempts: result.attempts,
        });
      }
      return result;
    } catch (error) {
      this.lastRequestAt = this.nowImpl();
      if (report.fetch_log.length < MAX_REPORT_MESSAGES) {
        report.fetch_log.push({
          url,
          outcome: "error",
          error: boundedMessage(error),
        });
      }
      throw error;
    }
  }

  private installedRow(sourceUrl: string): {
    table: InstalledTable;
    row: Row;
  } | null {
    for (const table of [
      "installed_working",
      "installed_broken",
    ] as const) {
      const row = this.store.db.prepare(
        `SELECT * FROM ${table} WHERE source_url = ? ORDER BY id LIMIT 1`,
      ).get(sourceUrl) as Row | undefined;
      if (row) return { table, row };
    }
    return null;
  }

  private availableRow(sourceUrl: string): Row | undefined {
    const rows = this.store.db.prepare(
      `SELECT * FROM available_for_install
       WHERE source_url = ?
       ORDER BY id`,
    ).all(sourceUrl) as Row[];
    if (rows.length > 1) {
      throw new Error("mcpservers_available_identity_ambiguous");
    }
    return rows[0];
  }

  private publicAvailableUrls(): Set<string> {
    return new Set(
      (this.store.db.prepare(`
        SELECT source_url
        FROM available_for_install
        WHERE producer_surface = 'external-index'
          AND source_url IS NOT NULL
      `).all() as { source_url: string }[])
        .map((row) => row.source_url),
    );
  }

  private markParser(
    report: McpserversRefreshReport,
    url: string,
    parser: string,
  ): void {
    for (let index = report.fetch_log.length - 1; index >= 0; index -= 1) {
      const entry = report.fetch_log[index];
      if (entry.url === url && entry.outcome === "ok") {
        entry.parser = parser;
        return;
      }
    }
  }

  private refreshSitemapPresence(
    entries: Map<string, SitemapEntry>,
    observedAt: string,
    sitemapSha256: string,
  ): void {
    const byUrl = new Map(
      [...entries.values()].map((entry) => [entry.url, entry]),
    );
    const rows = this.store.db.prepare(`
      SELECT *
      FROM available_for_install
      WHERE producer_surface = 'external-index'
        AND source_url IS NOT NULL
    `).all() as Row[];
    if (rows.length === 0) return;
    const staleAt = new Date(
      Date.parse(observedAt) + 86_400_000,
    ).toISOString();
    this.store.db.exec("BEGIN IMMEDIATE");
    try {
      for (const row of rows) {
        const entry = byUrl.get(String(row.source_url));
        if (!entry) continue;
        const previous = parseProvenance(row);
        const publicIndex = isPlainObject(previous.public_index)
          ? previous.public_index
          : {};
        this.store.db.prepare(`
          UPDATE available_for_install
          SET observed_at = ?, last_verified = ?, stale_at = ?,
              provenance_json = ?
          WHERE id = ?
        `).run(
          observedAt,
          observedAt,
          staleAt,
          JSON.stringify({
            ...previous,
            public_index: {
              ...publicIndex,
              sitemap_seen_at: observedAt,
              sitemap_sha256: sitemapSha256,
              sitemap_lastmod: entry.lastmod,
            },
          }),
          String(row.id),
        );
      }
      this.store.db.exec("COMMIT");
    } catch (error) {
      this.store.db.exec("ROLLBACK");
      throw error;
    }
  }

  private upsertAvailable(
    item: ParsedCapability,
    entry: SitemapEntry,
    listingFetch: FetchResult,
    observedAt: string,
  ): void {
    const existing = this.availableRow(item.source_url);
    const id = existing ? String(existing.id) : deterministicId(item);
    const collision = this.store.db.prepare(
      "SELECT source_url FROM available_for_install WHERE id = ?",
    ).get(id) as { source_url: string | null } | undefined;
    if (collision && collision.source_url !== item.source_url) {
      throw new Error("mcpservers_deterministic_id_collision");
    }

    const previousProvenance = parseProvenance(existing);
    const previousPublicIndex = isPlainObject(
      previousProvenance.public_index,
    )
      ? previousProvenance.public_index
      : null;
    const provenance = JSON.stringify({
      ...previousProvenance,
      public_index: {
        source: "mcpservers.org",
        parser_version: PARSER_VERSION,
        listing_url: listingFetch.url,
        listing_sha256: listingFetch.sha256,
        listing_status: listingFetch.status,
        listing_bytes: listingFetch.bytes,
        source_url: item.source_url,
        sitemap_lastmod: entry.lastmod,
        observed_at: observedAt,
        previous_observation: previousPublicIndex
          ? {
              listing_sha256: previousPublicIndex.listing_sha256 ?? null,
              observed_at: previousPublicIndex.observed_at ?? null,
            }
          : null,
      },
    });
    const rawJson = JSON.stringify({
      author: item.author,
      curated: item.curated,
      sponsor: item.sponsor,
    });
    const staleAt = new Date(
      Date.parse(observedAt) + 86_400_000,
    ).toISOString();
    const transport = existing?.transport
      ? String(existing.transport)
      : item.install_command
        ? "stdio"
        : "hosted";

    this.store.db.exec("BEGIN IMMEDIATE");
    try {
      if (existing) {
        this.store.db.prepare(`
          UPDATE available_for_install
          SET kind = ?, name = ?, slug = ?, source_url = ?,
              surface_owner = 'n/a', transport = ?, description = ?,
              pricing = ?, official = ?, stars = ?, install_command = ?,
              source_lane = 'mcpservers-sitemap',
              producer_surface = 'external-index',
              capture_class = 'observed', observed_at = ?,
              last_verified = ?, stale_at = ?, category = ?,
              provenance_json = ?, raw_json = ?
          WHERE id = ?
        `).run(
          item.kind,
          item.name,
          item.slug,
          item.source_url,
          transport,
          item.description,
          item.pricing,
          item.official,
          item.stars,
          item.install_command,
          observedAt,
          observedAt,
          staleAt,
          item.category,
          provenance,
          rawJson,
          id,
        );
      } else {
        this.store.db.prepare(`
          INSERT INTO available_for_install (
            id, kind, name, slug, source_url, surface_owner, transport,
            description, pricing, official, stars, install_command,
            source_lane, producer_surface, capture_class, observed_at,
            last_verified, stale_at, curated_notes, tools_json, detail_json,
            provenance_json, raw_json, category, detail_fetched_at,
            judgment_model, judgment_at, judgment_verdict, judgment_reason,
            judgment_surface
          ) VALUES (
            ?, ?, ?, ?, ?, 'n/a', ?, ?, ?, ?, ?, ?,
            'mcpservers-sitemap', 'external-index', 'observed', ?, ?, ?,
            NULL, NULL, NULL, ?, ?, ?, NULL,
            NULL, NULL, NULL, NULL, NULL
          )
        `).run(
          id,
          item.kind,
          item.name,
          item.slug,
          item.source_url,
          transport,
          item.description,
          item.pricing,
          item.official,
          item.stars,
          item.install_command,
          observedAt,
          observedAt,
          staleAt,
          provenance,
          rawJson,
          item.category,
        );
      }
      this.store.searchIndex.deleteRow(id);
      this.store.searchIndex.insertRow("available_for_install", {
        id,
        name: item.name,
        slug: item.slug,
        description: item.description,
        curated_notes: existing?.curated_notes
          ? String(existing.curated_notes)
          : null,
      });
      this.store.db.exec("COMMIT");
    } catch (error) {
      this.store.db.exec("ROLLBACK");
      throw error;
    }
  }

  private async scanBulkKind(
    kind: "server" | "skill",
    entries: Map<string, SitemapEntry>,
    state: BackfillState,
    report: McpserversRefreshReport,
    signal?: AbortSignal,
  ): Promise<"complete" | "stopped"> {
    const pending = new Set(state.pending);
    const hasKind = () => [...pending].some(
      (identity) => entries.get(identity)?.kind === kind,
    );
    if (!hasKind()) return "complete";

    let page = kind === "server"
      ? state.server_page
      : state.skill_page;
    let scanned = 0;
    while (hasKind() && scanned < this.maxBulkPages) {
      if (signal?.aborted) return "stopped";
      const url = kind === "server"
        ? `https://mcpservers.org/all?page=${page}`
        : `https://mcpservers.org/agent-skills?page=${page}`;
      let fetched: FetchResult;
      try {
        fetched = await this.pacedFetch(url, report, signal);
      } catch (error) {
        if (!(error instanceof RateLimitError) && !signal?.aborted) {
          this.addError(report, error);
        }
        return "stopped";
      }

      const parsed = parseListings(fetched.text);
      this.markParser(
        report,
        fetched.url,
        `bulk-${kind}:items=${parsed.value.length}:gaps=${parsed.gaps.length}`,
      );
      const pageEnd = /data-page-end=(["'])true\1/i.test(fetched.text);
      for (const gap of parsed.gaps) {
        if (!(pageEnd && gap === "listing_cards_empty")) {
          this.addGap(report, `${url}:${gap}`);
        }
      }
      if (parsed.value.length === 0) {
        if (!pageEnd) this.addGap(report, `${url}:bulk_page_unusable`);
        break;
      }

      for (const item of parsed.value) {
        const entry = entries.get(item.identity);
        if (!entry || entry.kind !== kind || !pending.has(item.identity)) {
          continue;
        }
        if (this.installedRow(item.source_url)) {
          pending.delete(item.identity);
          report.skipped_installed += 1;
          continue;
        }
        try {
          this.upsertAvailable(item, entry, fetched, this.nowIso());
          pending.delete(item.identity);
          report.processed += 1;
        } catch (error) {
          this.addError(report, error);
        }
      }

      page += 1;
      scanned += 1;
      if (kind === "server") state.server_page = page;
      else state.skill_page = page;
      state.pending = [...pending].sort();
      state.phase = kind;
      state.updated_at = this.nowIso();
      this.atomicWriteJson(this.statePath(), state);
    }
    state.pending = [...pending].sort();
    if (scanned >= this.maxBulkPages && hasKind()) {
      this.addGap(report, `${kind}:bulk_page_limit_reached`);
    }
    return "complete";
  }

  public async runRefresh(
    signal?: AbortSignal,
  ): Promise<McpserversRefreshReport> {
    const startedAt = this.nowIso();
    const report: McpserversRefreshReport = {
      schema: REPORT_SCHEMA,
      started_at: startedAt,
      finished_at: null,
      stated_totals: {},
      diff: {
        new_count: 0,
        changed_count: 0,
        removed_count: 0,
        new: [],
        changed: [],
        removed: [],
      },
      processed: 0,
      skipped_installed: 0,
      pending: 0,
      gaps: [],
      errors: [],
      fetch_log: [],
    };
    const loaded = this.loadState();
    let state = loaded.state;
    for (const gap of loaded.gaps) this.addGap(report, gap);

    try {
      const root = await this.pacedFetch(
        "https://mcpservers.org/sitemap.xml",
        report,
        signal,
      );
      const rootParsed = parseRootSitemaps(root.text);
      this.markParser(
        report,
        root.url,
        `root:gaps=${rootParsed.gaps.length}`,
      );
      for (const gap of rootParsed.gaps) {
        this.addGap(report, `root:${gap}`);
      }
      if (rootParsed.value.length === 0) {
        throw new Error("mcpservers_root_sitemap_unusable");
      }

      const entries = new Map<string, SitemapEntry>();
      const sitemapHashes: string[] = [];
      for (const reference of rootParsed.value) {
        const fetched = await this.pacedFetch(
          reference.url,
          report,
          signal,
        );
        sitemapHashes.push(`${reference.url}:${fetched.sha256}`);
        const parsed = parseSitemapEntries(fetched.text, reference.kind);
        this.markParser(
          report,
          fetched.url,
          `sitemap-${reference.kind}:items=${parsed.value.length}:gaps=${parsed.gaps.length}`,
        );
        for (const gap of parsed.gaps) {
          this.addGap(report, `${reference.url}:${gap}`);
        }
        for (const entry of parsed.value) {
          const previous = entries.get(entry.identity);
          if (previous && previous.lastmod !== entry.lastmod) {
            this.addGap(report, `${entry.identity}:sitemap_conflict`);
            continue;
          }
          entries.set(entry.identity, entry);
        }
      }

      const currentEntries = canonicalEntries(entries);
      const currentHash = universeHash(currentEntries);
      const previousEntries = state.entries;
      const storedPublicUrls = this.publicAvailableUrls();
      const newIds = Object.keys(currentEntries).filter(
        (identity) => !(identity in previousEntries)
          && !storedPublicUrls.has(currentEntries[identity].url),
      );
      const changedIds = Object.keys(currentEntries).filter(
        (identity) => identity in previousEntries
          && !sameStoredEntry(currentEntries[identity], previousEntries[identity]),
      );
      const removedIds = Object.keys(previousEntries).filter(
        (identity) => !(identity in currentEntries),
      );
      report.diff = {
        new_count: newIds.length,
        changed_count: changedIds.length,
        removed_count: removedIds.length,
        new: newIds.slice(0, 1_000),
        changed: changedIds.slice(0, 1_000),
        removed: removedIds.slice(0, 1_000),
      };

      const previousServerTotal = Object.values(previousEntries).filter(
        (entry) => entry.kind === "server",
      ).length;
      const previousSkillTotal = Object.values(previousEntries).filter(
        (entry) => entry.kind === "skill",
      ).length;
      const serverTotal = [...entries.values()].filter(
        (entry) => entry.kind === "server",
      ).length;
      const skillTotal = entries.size - serverTotal;
      const observedAt = this.nowIso();
      const sitemapHash = crypto.createHash("sha256")
        .update(sitemapHashes.sort().join("\n"))
        .digest("hex");
      this.refreshSitemapPresence(entries, observedAt, sitemapHash);
      report.stated_totals.servers = {
        value: serverTotal,
        previous: state.universe_hash === null
          ? null
          : previousServerTotal,
        delta: state.universe_hash === null
          ? null
          : serverTotal - previousServerTotal,
        observed_at: observedAt,
        source_url: root.url,
        response_sha256: sitemapHash,
      };
      report.stated_totals.skills = {
        value: skillTotal,
        previous: state.universe_hash === null
          ? null
          : previousSkillTotal,
        delta: state.universe_hash === null
          ? null
          : skillTotal - previousSkillTotal,
        observed_at: observedAt,
        source_url: root.url,
        response_sha256: sitemapHash,
      };

      for (const term of this.watchTerms) {
        const url =
          `https://mcpservers.org/search?page=1&query=${encodeURIComponent(term)}`;
        try {
          const fetched = await this.pacedFetch(url, report, signal);
          const total = parseSearchTotal(fetched.text);
          this.markParser(
            report,
            fetched.url,
            total === null ? "watch-total:gap" : "watch-total:ok",
          );
          if (total === null) {
            this.addGap(report, `watch:${term}:total_missing`);
            continue;
          }
          const previous = state.watch_totals[term] ?? null;
          report.stated_totals[`watch:${term}`] = {
            value: total,
            previous,
            delta: previous === null ? null : total - previous,
            observed_at: this.nowIso(),
            source_url: url,
            response_sha256: fetched.sha256,
          };
          state.watch_totals[term] = total;
        } catch (error) {
          this.addError(report, error);
        }
      }

      const pending = new Set(
        state.pending.filter((identity) => entries.has(identity)),
      );
      for (const identity of [...newIds, ...changedIds]) {
        pending.add(identity);
      }
      const universeChanged = state.universe_hash !== currentHash;
      const retryPending = state.phase === "done" && pending.size > 0;
      state = {
        ...state,
        universe_hash: currentHash,
        entries: currentEntries,
        pending: [...pending].sort(),
        phase: universeChanged || state.phase === "done"
          ? "server"
          : state.phase,
        server_page: universeChanged || retryPending
          ? 1
          : state.server_page,
        skill_page: universeChanged || retryPending
          ? 1
          : state.skill_page,
        updated_at: this.nowIso(),
      };
      this.atomicWriteJson(this.statePath(), state);

      const serverScan = await this.scanBulkKind(
        "server",
        entries,
        state,
        report,
        signal,
      );
      if (serverScan === "complete") {
        state.phase = "skill";
        state.updated_at = this.nowIso();
        this.atomicWriteJson(this.statePath(), state);
        const skillScan = await this.scanBulkKind(
          "skill",
          entries,
          state,
          report,
          signal,
        );
        state.phase = skillScan === "complete" ? "done" : "skill";
      } else {
        state.phase = "server";
      }
      state.updated_at = this.nowIso();
      this.atomicWriteJson(this.statePath(), state);

      for (const identity of state.pending) {
        this.addGap(report, `${identity}:bulk_metadata_not_found`);
      }
      report.pending = state.pending.length;
    } catch (error) {
      this.addError(report, error);
      report.pending = state.pending.length;
    } finally {
      report.finished_at = this.nowIso();
      try {
        this.atomicWriteJson(this.reportPath(), report);
      } catch (error) {
        this.addError(report, error);
      }
    }
    return report;
  }

  public async enrichDetail(
    id: string,
    signal?: AbortSignal,
  ): Promise<Row> {
    if (!/^[A-Za-z0-9._:-]{1,160}$/.test(id)) {
      throw new Error("mcpservers_detail_id_invalid");
    }
    const existing = this.store.db.prepare(
      "SELECT * FROM available_for_install WHERE id = ?",
    ).get(id) as Row | undefined;
    if (!existing) throw new Error("mcpservers_detail_not_available");
    const sourceUrl = String(existing.source_url ?? "");
    let parsedSource: URL;
    try {
      parsedSource = new URL(sourceUrl);
    } catch {
      throw new Error("mcpservers_detail_source_invalid");
    }
    if (
      parsedSource.origin !== "https://mcpservers.org"
      || parsedSource.username !== ""
      || parsedSource.password !== ""
      || parsedSource.port !== ""
      || parsedSource.search !== ""
      || parsedSource.hash !== ""
    ) {
      throw new Error("mcpservers_detail_source_invalid");
    }

    const scratch: McpserversRefreshReport = {
      schema: REPORT_SCHEMA,
      started_at: this.nowIso(),
      finished_at: null,
      stated_totals: {},
      diff: {
        new_count: 0,
        changed_count: 0,
        removed_count: 0,
        new: [],
        changed: [],
        removed: [],
      },
      processed: 0,
      skipped_installed: 0,
      pending: 0,
      gaps: [],
      errors: [],
      fetch_log: [],
    };
    try {
      const fetched = await this.pacedFetch(
        sourceUrl,
        scratch,
        signal,
      );
      const parsed = parseDetail(fetched.text);
      this.markParser(
        scratch,
        fetched.url,
        `detail:gaps=${parsed.gaps.length}`,
      );
      if (!parsed.value) return existing;
      const observedAt = this.nowIso();
      const detailJson = JSON.stringify({
        ...parsed.value,
        parser_version: PARSER_VERSION,
        fetched_at: observedAt,
        response_sha256: fetched.sha256,
        gaps: parsed.gaps,
      });
      const provenance = JSON.stringify({
        ...parseProvenance(existing),
        public_detail: {
          source_url: sourceUrl,
          parser_version: PARSER_VERSION,
          fetched_at: observedAt,
          response_sha256: fetched.sha256,
          response_status: fetched.status,
          response_bytes: fetched.bytes,
        },
      });
      this.store.db.exec("BEGIN IMMEDIATE");
      try {
        this.store.db.prepare(`
          UPDATE available_for_install
          SET description = COALESCE(?, description),
              category = COALESCE(?, category),
              pricing = ?,
              install_command = COALESCE(?, install_command),
              detail_json = ?, detail_fetched_at = ?,
              provenance_json = ?
          WHERE id = ?
        `).run(
          parsed.value.description,
          parsed.value.category,
          parsed.value.pricing === "unknown"
            ? String(existing.pricing)
            : parsed.value.pricing,
          parsed.value.install_command,
          detailJson,
          observedAt,
          provenance,
          id,
        );
        const updated = this.store.db.prepare(
          "SELECT * FROM available_for_install WHERE id = ?",
        ).get(id) as Row;
        this.store.searchIndex.deleteRow(id);
        this.store.searchIndex.insertRow("available_for_install", {
          id,
          name: String(updated.name),
          slug: String(updated.slug),
          description: updated.description
            ? String(updated.description)
            : null,
          curated_notes: updated.curated_notes
            ? String(updated.curated_notes)
            : null,
        });
        this.store.db.exec("COMMIT");
        return updated;
      } catch (error) {
        this.store.db.exec("ROLLBACK");
        throw error;
      }
    } catch {
      return existing;
    }
  }
}
