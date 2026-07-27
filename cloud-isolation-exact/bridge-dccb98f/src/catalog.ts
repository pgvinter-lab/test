import path from "node:path";
import crypto from "node:crypto";
import { getConfig } from "./config.js";
import { ensureDir, readJson, writeJsonAtomic, withLock, nowIso } from "./util.js";

/**
 * OpenRouter model-catalog cache.
 *
 * The router needs a current, machine-readable reference table of every model's
 * cost, context window, and modality. OpenRouter maintains exactly that at a
 * public, keyless endpoint, so we BORROW it rather than hand-maintain a price
 * list (which would rot within days). This module fetches, normalizes, and
 * caches it; the routing layer reads the cache, never the network.
 *
 * What this is NOT: a routing brain. It carries only the *reference* layer
 * (cost / capability / modality). The decision data — headroom, observed
 * latency, which surface won the vote — is generated privately elsewhere.
 *
 * Storage: global reference data, so it lives in BRIDGE_HOME alongside
 * registry.json and the ledger — one catalog shared by every project, not a
 * per-project `.connector/` file.
 */

// --- endpoint + cadence -----------------------------------------------------

const MODELS_URL = "https://openrouter.ai/api/v1/models";
const FETCH_TIMEOUT_MS = 30_000;

/** Freshness cadence for the lazy guard: the catalog is considered stale once it
 *  is this old. Set to match the 3×/day proactive schedule (06:00/14:00/22:00),
 *  so an on-demand read is never working from data more than ~8h behind even if a
 *  scheduled run was missed (machine asleep / logged off). */
export const MAX_AGE_HOURS = 8;

// --- paths (all under BRIDGE_HOME/catalog) ----------------------------------

export function catalogDir(): string { return path.join(getConfig().bridgeHome, "catalog"); }
/** Verbatim provider payload — kept for forensics and for fields we don't yet normalize. */
export function rawModelsPath(): string { return path.join(catalogDir(), "openrouter-models.raw.json"); }
/** The compact, router-facing table. */
export function modelsPath(): string { return path.join(catalogDir(), "models.json"); }
/** Freshness + provenance for the cache. */
export function metaPath(): string { return path.join(catalogDir(), "meta.json"); }
function catalogLockPath(): string { return path.join(catalogDir(), ".lock"); }

// --- types ------------------------------------------------------------------

/** Normalized per-model record. Prices are USD per token unless noted; null = absent. */
export interface CatalogModel {
  id: string;
  name: string;
  contextLength: number | null;
  maxCompletionTokens: number | null;
  pricing: {
    prompt: number | null;          // input token
    completion: number | null;      // output token
    image: number | null;           // per image
    request: number | null;         // per request
    webSearch: number | null;       // per web_search call
    inputCacheRead: number | null;
    inputCacheWrite: number | null;
  };
  modality: string | null;          // e.g. "text->text", "text+image->text"
  inputModalities: string[];
  outputModalities: string[];
  supportedParameters: string[];    // temperature, tools, structured_outputs, reasoning, ...
}

export interface CatalogMeta {
  source: string;
  fetchedAt: string;                // ISO timestamp of the last successful pull
  fetchedTs: number;                // ms epoch (for age math)
  count: number;
  hash: string;                     // content hash of the normalized table (change detection)
  ok: boolean;
  error?: string;
}

export interface Catalog {
  meta: CatalogMeta;
  models: CatalogModel[];
}

// --- normalization ----------------------------------------------------------

/** Coerce OpenRouter's string-typed numerics to numbers; "" / null / undefined -> null.
 *  A genuine "0" (a free price) is preserved as 0, not dropped to null. */
function num(v: unknown): number | null {
  if (v === null || v === undefined || v === "") return null;
  const n = typeof v === "number" ? v : parseFloat(String(v));
  return Number.isFinite(n) ? n : null;
}

function asStringArray(v: unknown): string[] {
  return Array.isArray(v) ? v.filter((x) => typeof x === "string") : [];
}

function normalize(m: any): CatalogModel {
  const arch = m?.architecture ?? {};
  const price = m?.pricing ?? {};
  const top = m?.top_provider ?? {};
  return {
    id: String(m?.id ?? ""),
    name: String(m?.name ?? m?.id ?? ""),
    contextLength: num(m?.context_length ?? top?.context_length),
    maxCompletionTokens: num(top?.max_completion_tokens),
    pricing: {
      prompt: num(price?.prompt),
      completion: num(price?.completion),
      image: num(price?.image),
      request: num(price?.request),
      webSearch: num(price?.web_search),
      inputCacheRead: num(price?.input_cache_read),
      inputCacheWrite: num(price?.input_cache_write),
    },
    modality: typeof arch?.modality === "string" ? arch.modality : null,
    inputModalities: asStringArray(arch?.input_modalities),
    outputModalities: asStringArray(arch?.output_modalities),
    supportedParameters: asStringArray(m?.supported_parameters),
  };
}

function hashOf(s: string): string {
  return crypto.createHash("sha256").update(s).digest("hex").slice(0, 16);
}

// --- fetch ------------------------------------------------------------------

/** Pull the model list. Throws on network / HTTP / shape error so the caller can
 *  keep the existing cache rather than clobber it with garbage. */
async function fetchModels(): Promise<any[]> {
  const ctrl = new AbortController();
  const timer = setTimeout(() => ctrl.abort(), FETCH_TIMEOUT_MS);
  try {
    const res = await fetch(MODELS_URL, { signal: ctrl.signal, headers: { accept: "application/json" } });
    if (!res.ok) throw new Error(`HTTP ${res.status} ${res.statusText} from ${MODELS_URL}`);
    const body = (await res.json()) as { data?: unknown };
    if (!Array.isArray(body?.data)) throw new Error("unexpected response shape: no `data` array");
    return body.data as any[];
  } finally {
    clearTimeout(timer);
  }
}

// --- public API -------------------------------------------------------------

/** Fetch + normalize + cache. The network call happens OUTSIDE the lock (it can
 *  take seconds); only the three-file write is serialized, so a concurrent
 *  refresh can never interleave a half-updated cache. On any fetch failure this
 *  throws and writes nothing — the previous good cache is left intact. */
export async function refreshCatalog(): Promise<CatalogMeta> {
  const raw = await fetchModels();
  const models = raw.map(normalize).sort((a, b) => a.id.localeCompare(b.id));
  const meta: CatalogMeta = {
    source: MODELS_URL,
    fetchedAt: nowIso(),
    fetchedTs: Date.now(),
    count: models.length,
    hash: hashOf(JSON.stringify(models)),
    ok: true,
  };
  await withLock(catalogLockPath(), () => {
    ensureDir(catalogDir());
    writeJsonAtomic(rawModelsPath(), raw);
    writeJsonAtomic(modelsPath(), models);
    writeJsonAtomic(metaPath(), meta);
  });
  return meta;
}

/** Read the cached catalog (no network). Missing cache -> empty models + an
 *  `ok:false` meta explaining how to populate it. */
export function loadCatalog(): Catalog {
  const meta = readJson<CatalogMeta | null>(metaPath(), null);
  const models = readJson<CatalogModel[]>(modelsPath(), []);
  if (!meta) {
    return {
      meta: { source: MODELS_URL, fetchedAt: "", fetchedTs: 0, count: models.length, hash: "", ok: false, error: "no catalog yet — run `bridge catalog refresh`" },
      models,
    };
  }
  return { meta, models };
}

/** Age of the cache in hours, or null if there is no cache yet. */
export function catalogAgeHours(): number | null {
  const meta = readJson<CatalogMeta | null>(metaPath(), null);
  if (!meta || !meta.fetchedTs) return null;
  return (Date.now() - meta.fetchedTs) / 3_600_000;
}

/** True when the cache is missing or older than the daily cadence. */
export function isStale(maxAgeHours = MAX_AGE_HOURS): boolean {
  const age = catalogAgeHours();
  return age === null || age >= maxAgeHours;
}

/** The lazy daily guard the router calls: refresh if stale, then return the cache.
 *  If the refresh fails (offline, rate-limited) it warns and falls back to the
 *  stale cache rather than blocking the caller — reference data degrades
 *  gracefully, it doesn't take the router down. */
export async function ensureFresh(maxAgeHours = MAX_AGE_HOURS): Promise<Catalog> {
  if (isStale(maxAgeHours)) {
    try {
      await refreshCatalog();
    } catch (e) {
      const age = catalogAgeHours();
      console.error(
        `[catalog] refresh failed (${(e as Error).message}); ` +
        (age === null ? "no cached catalog available." : `falling back to cache ${Math.round(age)}h old.`)
      );
    }
  }
  return loadCatalog();
}

/** Convenience lookup by exact model id (e.g. "anthropic/claude-opus-4.8"). */
export function getModel(id: string): CatalogModel | undefined {
  return loadCatalog().models.find((m) => m.id === id);
}
