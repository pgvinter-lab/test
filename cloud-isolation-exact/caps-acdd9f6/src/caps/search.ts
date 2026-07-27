import { McpserversIndexer } from "./mcpservers.js";
import {
  computeRoutingRecipe,
  type CapsTableOrigin,
  type RoutingRecipe,
} from "./routing.js";
import type { CapsStore } from "./store.js";
import type {
  CapabilityKind,
  CapabilityPricing,
  CensusTrustedContext,
  SurfaceOwner,
} from "./types.js";
import { mapTrustedContext } from "./census.js";

const TABLES = [
  "installed_working",
  "installed_broken",
  "available_for_install",
] as const satisfies readonly CapsTableOrigin[];
const KINDS = ["server", "tool", "skill"] as const;
const SURFACES = [
  "claude",
  "codex",
  "gemini",
  "agy",
  "clickup-hosted",
  "n/a",
] as const;
const MAX_QUERY_BYTES = 512;
const MAX_HITS = 50;
const MAX_RESULT_BYTES = 64 * 1024;
const MAX_GET_BYTES = 1024 * 1024;
const MAX_JSON_BYTES = 384 * 1024;
const MAX_JSON_NODES = 10_000;
const MAX_JSON_DEPTH = 32;

type Row = Record<string, unknown>;

export interface CapsSearchOptions {
  kind?: CapabilityKind;
  table_origin?: CapsTableOrigin;
  surface_owner?: SurfaceOwner;
  limit?: number;
}

export interface CapsSearchProvenance {
  surface_owner: SurfaceOwner;
  source_lane: string;
  producer_surface: string;
  capture_class: string;
  observed_at: string;
  last_verified: string | null;
  stale_at: string;
  stale: boolean;
}

export interface CapsSearchHit {
  id: string;
  name: string;
  kind: CapabilityKind;
  pricing: CapabilityPricing;
  description: string;
  table_origin: CapsTableOrigin;
  provenance: CapsSearchProvenance;
  recipe: RoutingRecipe;
}

export interface DetailEnricher {
  enrichDetail(id: string, signal?: AbortSignal): Promise<Row>;
}

function isPlainObject(value: unknown): value is Record<string, unknown> {
  if (!value || typeof value !== "object" || Array.isArray(value)) return false;
  const prototype = Object.getPrototypeOf(value);
  return prototype === Object.prototype || prototype === null;
}

function utf8(value: string): number {
  return Buffer.byteLength(value, "utf8");
}

function fail(code: string): never {
  throw new Error(code);
}

function truncateUtf8(value: string, maximum: number): string {
  let output = "";
  let bytes = 0;
  for (const character of value) {
    const next = utf8(character);
    if (bytes + next > maximum) break;
    output += character;
    bytes += next;
  }
  return output;
}

function secretLike(value: string): boolean {
  return /\bBearer\s+[A-Za-z0-9._~+/-]{8,}/i.test(value)
    || /\bAKIA[0-9A-Z]{16}\b/.test(value)
    || /\beyJ[A-Za-z0-9_-]{10,}\.[A-Za-z0-9_-]{10,}(?:\.[A-Za-z0-9_-]{8,})?\b/.test(value)
    || /\b(?:sk|ghp|github_pat|xox[baprs])[-_][A-Za-z0-9_-]{12,}\b/i.test(value)
    || /\b(?:token|secret|password|api[_-]?key|authorization|cookie|credential)\s*[:=]\s*\S{6,}/i
      .test(value);
}

function safeText(
  value: unknown,
  maximum: number,
  oneLine = false,
): string | null {
  if (value === null || value === undefined) return null;
  if (typeof value !== "string") fail("caps_stored_text_invalid");
  let text = value.replace(/\u0000/g, "");
  if (oneLine) {
    text = text.replace(/[\u0001-\u001f\u007f]+/g, " ")
      .replace(/\s+/g, " ")
      .trim();
  }
  if (secretLike(text)) return "[REDACTED]";
  return truncateUtf8(text, maximum);
}

function requireIdentifier(value: unknown, code: string): string {
  if (
    typeof value !== "string"
    || !/^[A-Za-z0-9._:-]{1,160}$/.test(value)
  ) {
    fail(code);
  }
  return value;
}

function validateQuery(value: unknown): string {
  if (typeof value !== "string" || utf8(value) > MAX_QUERY_BYTES) {
    fail("caps_search_query_invalid");
  }
  if (/[\u0000-\u0008\u000b\u000c\u000e-\u001f\u007f]/.test(value)) {
    fail("caps_search_query_invalid");
  }
  return value.replace(/\s+/g, " ").trim();
}

function validateOptions(raw: unknown): Required<Pick<CapsSearchOptions, "limit">>
  & Omit<CapsSearchOptions, "limit"> {
  if (raw === undefined) return { limit: 20 };
  if (!isPlainObject(raw)) fail("caps_search_options_invalid");
  const allowed = new Set([
    "kind",
    "table_origin",
    "surface_owner",
    "limit",
  ]);
  for (const key of Object.keys(raw)) {
    if (!allowed.has(key)) fail("caps_search_option_unknown");
  }
  if (
    raw.kind !== undefined
    && !KINDS.includes(raw.kind as typeof KINDS[number])
  ) {
    fail("caps_search_kind_invalid");
  }
  if (
    raw.table_origin !== undefined
    && !TABLES.includes(raw.table_origin as CapsTableOrigin)
  ) {
    fail("caps_search_table_invalid");
  }
  if (
    raw.surface_owner !== undefined
    && !SURFACES.includes(raw.surface_owner as SurfaceOwner)
  ) {
    fail("caps_search_surface_invalid");
  }
  const limit = raw.limit ?? 20;
  if (!Number.isInteger(limit) || Number(limit) < 1 || Number(limit) > MAX_HITS) {
    fail("caps_search_limit_invalid");
  }
  return {
    kind: raw.kind as CapabilityKind | undefined,
    table_origin: raw.table_origin as CapsTableOrigin | undefined,
    surface_owner: raw.surface_owner as SurfaceOwner | undefined,
    limit: Number(limit),
  };
}

function ftsQuery(query: string): string {
  const terms = query.match(/[\p{L}\p{N}]+/gu) ?? [];
  if (terms.length === 0 || terms.length > 16) {
    fail("caps_search_query_terms_invalid");
  }
  return terms.map((term) => `"${term}"*`).join(" AND ");
}

function likeEscape(value: string): string {
  return value.replace(/[\\%_]/g, "\\$&");
}

function tableUnion(tables: readonly CapsTableOrigin[]): string {
  return tables.map((table) => `
    SELECT
      id, name, slug, kind, pricing, description, surface_owner,
      official, stars, source_lane, producer_surface, capture_class,
      observed_at, last_verified, stale_at, install_command, curated_notes,
      tools_json,
      ${table === "installed_broken"
        ? "failure_reason"
        : "NULL"} AS failure_reason,
      '${table}' AS table_origin
    FROM ${table}
  `).join(" UNION ALL ");
}

function hasFts(store: CapsStore): boolean {
  return Boolean(store.db.prepare(`
    SELECT 1
    FROM sqlite_master
    WHERE type = 'table' AND name = 'caps_search_fts'
  `).get());
}

function searchRows(
  store: CapsStore,
  query: string,
  options: ReturnType<typeof validateOptions>,
): Row[] {
  const tables = options.table_origin
    ? [options.table_origin]
    : [...TABLES];
  const conditions: string[] = [];
  const filterParameters: Array<string | number> = [];
  if (options.kind) {
    conditions.push("data.kind = ?");
    filterParameters.push(options.kind);
  }
  if (options.surface_owner) {
    conditions.push("data.surface_owner = ?");
    filterParameters.push(options.surface_owner);
  }
  const filters = conditions.length > 0
    ? `AND ${conditions.join(" AND ")}`
    : "";
  const union = tableUnion(tables);
  const order = `
    ORDER BY
      CASE data.pricing
        WHEN 'free' THEN 0 WHEN 'unknown' THEN 1 WHEN 'paid' THEN 2 ELSE 3
      END,
      CASE data.table_origin
        WHEN 'installed_working' THEN 0
        WHEN 'installed_broken' THEN 1
        WHEN 'available_for_install' THEN 2
        ELSE 3
      END,
      relevance_rank,
      CASE data.capture_class
        WHEN 'guaranteed' THEN 0
        WHEN 'observed' THEN 1
        WHEN 'reported' THEN 1
        WHEN 'best-effort' THEN 2
        ELSE 3
      END,
      data.official DESC,
      COALESCE(data.stars, -1) DESC,
      lower(data.name),
      data.id
    LIMIT ?
  `;

  if (query && hasFts(store)) {
    return store.db.prepare(`
      WITH data AS (${union})
      SELECT data.*, caps_search_fts.rank AS relevance_rank
      FROM data
      JOIN caps_search_fts
        ON caps_search_fts.id = data.id
       AND caps_search_fts.table_name = data.table_origin
      WHERE caps_search_fts MATCH ?
      ${filters}
      ${order}
    `).all(
      ftsQuery(query),
      ...filterParameters,
      options.limit,
    ) as Row[];
  }

  if (query) {
    const needle = query.toLocaleLowerCase("en-US");
    const escaped = likeEscape(needle);
    return store.db.prepare(`
      WITH
        input AS (
          SELECT ? AS needle, ? AS contains_pattern, ? AS prefix_pattern
        ),
        data AS (${union})
      SELECT data.*,
        CASE
          WHEN lower(data.name) = input.needle THEN 0
          WHEN lower(data.slug) = input.needle THEN 1
          WHEN lower(data.name) LIKE input.prefix_pattern ESCAPE '\\'
            OR lower(data.slug) LIKE input.prefix_pattern ESCAPE '\\' THEN 2
          WHEN lower(data.name) LIKE input.contains_pattern ESCAPE '\\'
            OR lower(data.slug) LIKE input.contains_pattern ESCAPE '\\' THEN 3
          WHEN lower(COALESCE(data.description, ''))
            LIKE input.contains_pattern ESCAPE '\\' THEN 4
          ELSE 5
        END AS relevance_rank
      FROM data
      CROSS JOIN input
      WHERE (
        lower(data.name) LIKE input.contains_pattern ESCAPE '\\'
        OR lower(data.slug) LIKE input.contains_pattern ESCAPE '\\'
        OR lower(COALESCE(data.description, ''))
          LIKE input.contains_pattern ESCAPE '\\'
        OR lower(COALESCE(data.curated_notes, ''))
          LIKE input.contains_pattern ESCAPE '\\'
      )
      ${filters}
      ${order}
    `).all(
      needle,
      `%${escaped}%`,
      `${escaped}%`,
      ...filterParameters,
      options.limit,
    ) as Row[];
  }

  return store.db.prepare(`
    WITH data AS (${union})
    SELECT data.*, 0 AS relevance_rank
    FROM data
    WHERE 1 = 1
    ${filters}
    ${order}
  `).all(...filterParameters, options.limit) as Row[];
}

function validTimestamp(value: unknown): string | null {
  if (value === null) return null;
  if (
    typeof value !== "string"
    || !/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(?:\.\d{3})?Z$/.test(value)
    || !Number.isFinite(Date.parse(value))
  ) {
    return null;
  }
  return value;
}

export function capsSearch(
  store: CapsStore,
  rawQuery: unknown,
  rawOptions: unknown,
  trustedContext: CensusTrustedContext,
): CapsSearchHit[] {
  mapTrustedContext(trustedContext);
  const query = validateQuery(rawQuery);
  const options = validateOptions(rawOptions);
  const rows = searchRows(store, query, options);
  const hits: CapsSearchHit[] = [];
  let bytes = 2;

  for (const row of rows) {
    const id = requireIdentifier(row.id, "caps_search_row_id_invalid");
    if (!KINDS.includes(row.kind as CapabilityKind)) {
      fail("caps_search_row_kind_invalid");
    }
    if (!["free", "unknown", "paid"].includes(String(row.pricing))) {
      fail("caps_search_row_pricing_invalid");
    }
    if (!TABLES.includes(row.table_origin as CapsTableOrigin)) {
      fail("caps_search_row_table_invalid");
    }
    if (!SURFACES.includes(row.surface_owner as SurfaceOwner)) {
      fail("caps_search_row_surface_invalid");
    }
    const staleAt = validTimestamp(row.stale_at);
    const name = safeText(row.name, 256, true);
    if (!name) fail("caps_search_row_name_invalid");
    const hit: CapsSearchHit = {
      id,
      name,
      kind: row.kind as CapabilityKind,
      pricing: row.pricing as CapabilityPricing,
      description: safeText(row.description, 512, true) ?? "",
      table_origin: row.table_origin as CapsTableOrigin,
      provenance: {
        surface_owner: row.surface_owner as SurfaceOwner,
        source_lane: safeText(row.source_lane, 128, true) ?? "unknown",
        producer_surface:
          safeText(row.producer_surface, 128, true) ?? "unknown",
        capture_class:
          safeText(row.capture_class, 128, true) ?? "unknown",
        observed_at: validTimestamp(row.observed_at) ?? "invalid",
        last_verified: validTimestamp(row.last_verified),
        stale_at: staleAt ?? "invalid",
        stale: staleAt === null || Date.parse(staleAt) <= Date.now(),
      },
      recipe: computeRoutingRecipe(
        row as unknown as Parameters<typeof computeRoutingRecipe>[0],
        row.table_origin as CapsTableOrigin,
        trustedContext,
      ),
    };
    const hitBytes = utf8(JSON.stringify(hit));
    const separator = hits.length === 0 ? 0 : 1;
    if (bytes + separator + hitBytes > MAX_RESULT_BYTES) break;
    bytes += separator + hitBytes;
    hits.push(hit);
  }
  return hits;
}

interface JsonBudget {
  nodes: number;
}

function sanitizeJson(
  value: unknown,
  budget: JsonBudget,
  depth = 0,
  key = "",
): unknown {
  budget.nodes += 1;
  if (budget.nodes > MAX_JSON_NODES || depth > MAX_JSON_DEPTH) {
    fail("caps_get_json_bounds_exceeded");
  }
  const secretKey =
    /(?:token|secret|password|api[_-]?key|authorization|cookie|credential)/i
      .test(key);
  if (value === null || typeof value === "boolean") return value;
  if (typeof value === "number") {
    if (!Number.isFinite(value)) fail("caps_get_json_number_invalid");
    return value;
  }
  if (typeof value === "string") {
    if (secretKey || secretLike(value)) return "[REDACTED]";
    return truncateUtf8(value.replace(/\u0000/g, ""), 8 * 1024);
  }
  if (Array.isArray(value)) {
    if (value.length > 1_000) fail("caps_get_json_array_too_large");
    return value.map((entry) =>
      sanitizeJson(entry, budget, depth + 1, key));
  }
  if (!isPlainObject(value)) fail("caps_get_json_object_invalid");
  const keys = Object.keys(value);
  if (keys.length > 1_000) fail("caps_get_json_object_too_large");
  const output: Record<string, unknown> = {};
  for (const childKey of keys.sort()) {
    if (["__proto__", "prototype", "constructor"].includes(childKey)) {
      fail("caps_get_json_key_invalid");
    }
    output[childKey] = sanitizeJson(
      value[childKey],
      budget,
      depth + 1,
      childKey,
    );
  }
  return output;
}

function parsedJson(value: unknown, code: string): unknown {
  if (value === null || value === undefined) return null;
  if (typeof value !== "string" || utf8(value) > MAX_JSON_BYTES) fail(code);
  try {
    return sanitizeJson(JSON.parse(value), { nodes: 0 });
  } catch (error) {
    if (error instanceof SyntaxError) fail(code);
    throw error;
  }
}

function sanitizedFullRow(row: Row, table: CapsTableOrigin): Row {
  const output: Row = {
    id: requireIdentifier(row.id, "caps_get_stored_id_invalid"),
    kind: safeText(row.kind, 32, true),
    name: safeText(row.name, 256, true),
    slug: safeText(row.slug, 128, true),
    source_url: safeText(row.source_url, 2_048, true),
    surface_owner: safeText(row.surface_owner, 64, true),
    transport: safeText(row.transport, 64, true),
    description: safeText(row.description, 8 * 1024),
    pricing: safeText(row.pricing, 32, true),
    official: row.official,
    stars: row.stars,
    install_command: safeText(row.install_command, 16 * 1024, true),
    source_lane: safeText(row.source_lane, 128, true),
    producer_surface: safeText(row.producer_surface, 128, true),
    capture_class: safeText(row.capture_class, 128, true),
    observed_at: validTimestamp(row.observed_at),
    last_verified: validTimestamp(row.last_verified),
    stale_at: validTimestamp(row.stale_at),
    curated_notes: safeText(row.curated_notes, 8 * 1024),
    tools_json: parsedJson(row.tools_json, "caps_get_tools_json_invalid"),
    detail_json: parsedJson(row.detail_json, "caps_get_detail_json_invalid"),
    provenance_json: parsedJson(
      row.provenance_json,
      "caps_get_provenance_json_invalid",
    ),
    raw_json: parsedJson(row.raw_json, "caps_get_raw_json_invalid"),
    failure_reason: safeText(row.failure_reason, 2_048),
    failure_observed_at: validTimestamp(row.failure_observed_at),
    category: safeText(row.category, 512, true),
    detail_fetched_at: validTimestamp(row.detail_fetched_at),
    judgment_model: safeText(row.judgment_model, 256, true),
    judgment_at: validTimestamp(row.judgment_at),
    judgment_verdict: safeText(row.judgment_verdict, 512, true),
    judgment_reason: safeText(row.judgment_reason, 8 * 1024),
    judgment_surface: safeText(row.judgment_surface, 256, true),
    table_origin: table,
  };
  if (utf8(JSON.stringify(output)) > MAX_GET_BYTES) {
    fail("caps_get_result_too_large");
  }
  return output;
}

export async function capsGet(
  store: CapsStore,
  rawId: unknown,
  trustedContext: CensusTrustedContext,
  injectedEnricher?: DetailEnricher,
): Promise<Row | null> {
  mapTrustedContext(trustedContext);
  const id = requireIdentifier(rawId, "caps_get_id_invalid");
  let foundRow: Row | undefined;
  let foundTable: CapsTableOrigin | undefined;
  for (const table of TABLES) {
    const row = store.db.prepare(
      `SELECT * FROM ${table} WHERE id = ?`,
    ).get(id) as Row | undefined;
    if (row) {
      foundRow = row;
      foundTable = table;
      break;
    }
  }
  if (!foundRow || !foundTable) return null;

  if (
    foundTable === "available_for_install"
    && !foundRow.detail_json
    && foundRow.producer_surface === "external-index"
    && foundRow.source_lane === "mcpservers-sitemap"
  ) {
    const enricher = injectedEnricher
      ?? new McpserversIndexer(store, store.getConfig());
    const controller = new AbortController();
    const timeout = setTimeout(() => controller.abort(), 20_000);
    try {
      foundRow = await enricher.enrichDetail(id, controller.signal);
    } catch {
      foundRow = store.db.prepare(
        "SELECT * FROM available_for_install WHERE id = ?",
      ).get(id) as Row;
    } finally {
      clearTimeout(timeout);
    }
  }

  return sanitizedFullRow(foundRow, foundTable);
}
