import crypto from "node:crypto";
import type { CapsStore } from "./store.js";
import type {
  CaptureClass,
  CensusAttribution,
  CensusCapability,
  CensusFailure,
  CensusResult,
  CensusRoster,
  CensusTrustedContext,
  ProducerSurface,
  SurfaceOwner,
} from "./types.js";

const LIMITS = {
  reportBytes: 1024 * 1024,
  rows: 500,
  text: 8 * 1024,
  command: 16 * 1024,
  json: 384 * 1024,
  tools: 1_000,
  schema: 64 * 1024,
  schemas: 256 * 1024,
  depth: 48,
} as const;

type InstalledTable = "installed_working" | "installed_broken";
type Row = Record<string, any>;

function fail(code: string): never {
  throw new Error(code);
}

function isPlainObject(value: unknown): value is Record<string, unknown> {
  if (!value || typeof value !== "object" || Array.isArray(value)) return false;
  const prototype = Object.getPrototypeOf(value);
  return prototype === Object.prototype || prototype === null;
}

function utf8(value: string): number {
  return Buffer.byteLength(value, "utf8");
}

function secretLike(value: string): boolean {
  return /\bBearer\s+[A-Za-z0-9._~+/-]{8,}/i.test(value)
    || /\bAKIA[0-9A-Z]{16}\b/.test(value)
    || /\beyJ[A-Za-z0-9_-]{10,}\.[A-Za-z0-9_-]{10,}(?:\.[A-Za-z0-9_-]{8,})?\b/.test(value)
    || /\b(?:sk|ghp|github_pat|xox[baprs])[-_][A-Za-z0-9_-]{12,}\b/i.test(value)
    || /\b(?:token|secret|password|api[_-]?key|authorization|cookie|credential)\s*[:=]\s*\S{6,}/i.test(value);
}

function boundedString(
  value: unknown,
  code: string,
  maximum = LIMITS.text,
  pattern?: RegExp,
): string {
  if (typeof value !== "string" || value.length === 0 || utf8(value) > maximum) {
    fail(code);
  }
  if (secretLike(value)) fail("credential_leak_rejected");
  if (pattern && !pattern.test(value)) fail(code);
  return value;
}

function sanitizeJson(
  value: unknown,
  depth = 0,
  key = "",
  secretAncestor = false,
): unknown {
  if (depth > LIMITS.depth) fail("json_too_deep");
  const directSecretKey =
    /(?:token|secret|password|api[_-]?key|authorization|cookie|credential)/i.test(key);
  const secretHere = secretAncestor || directSecretKey;
  if (value === null || typeof value === "boolean") return value;
  if (typeof value === "number") {
    if (!Number.isFinite(value)) fail("invalid_json_number");
    return value;
  }
  if (typeof value === "string") {
    if (utf8(value) > LIMITS.text) fail("json_string_too_large");
    if (directSecretKey && value.length > 0) return "[REDACTED]";
    if (secretLike(value)) {
      if (secretHere || /^(?:default|example|examples|const|enum|value)$/i.test(key)) {
        return "[REDACTED]";
      }
      fail("credential_leak_rejected");
    }
    if (
      secretAncestor
      && /^(?:default|example|examples|const|enum|value)$/i.test(key)
      && value.length > 0
    ) {
      return "[REDACTED]";
    }
    return value;
  }
  if (Array.isArray(value)) {
    return value.map((entry) => sanitizeJson(entry, depth + 1, key, secretHere));
  }
  if (!isPlainObject(value)) fail("invalid_json_object");
  const output: Record<string, unknown> = {};
  for (const childKey of Object.keys(value).sort()) {
    if (["__proto__", "prototype", "constructor"].includes(childKey)) {
      fail("prototype_key_rejected");
    }
    output[childKey] = sanitizeJson(
      value[childKey],
      depth + 1,
      childKey,
      secretHere,
    );
  }
  return output;
}

function parseSanitizedJson(value: unknown, code: string): unknown {
  if (typeof value !== "string" || utf8(value) > LIMITS.json) fail(code);
  try {
    return sanitizeJson(JSON.parse(value));
  } catch (error) {
    if (error instanceof SyntaxError) fail(code);
    throw error;
  }
}

function stableStringify(value: unknown): string {
  return JSON.stringify(sanitizeJson(value));
}

function validateTools(value: unknown): string {
  const parsed = parseSanitizedJson(value, "invalid_tools_json");
  if (!Array.isArray(parsed) || parsed.length > LIMITS.tools) {
    fail("invalid_tools_json");
  }
  let totalSchemas = 0;
  for (const tool of parsed) {
    if (!isPlainObject(tool)) fail("invalid_tool");
    boundedString(tool.name, "invalid_tool_name", 256);
    if (tool.description !== undefined) {
      boundedString(tool.description, "invalid_tool_description");
    }
    if (!isPlainObject(tool.inputSchema)) fail("invalid_tool_schema");
    const schemaBytes = utf8(stableStringify(tool.inputSchema));
    if (schemaBytes > LIMITS.schema) fail("schema_too_large");
    totalSchemas += schemaBytes;
    if (totalSchemas > LIMITS.schemas) fail("schemas_too_large");
  }
  parsed.sort((left, right) => {
    const leftName = String((left as Record<string, unknown>).name);
    const rightName = String((right as Record<string, unknown>).name);
    return leftName.localeCompare(rightName);
  });
  return JSON.stringify(parsed);
}

function strictUtc(value: unknown): string {
  const text = boundedString(
    value,
    "invalid_observed_at",
    40,
    /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(?:\.\d{3})?Z$/,
  );
  const epoch = Date.parse(text);
  if (!Number.isFinite(epoch) || epoch > Date.now() + 5 * 60_000) {
    fail("invalid_observed_at");
  }
  return new Date(epoch).toISOString();
}

function normalizeSlug(value: unknown): string {
  return boundedString(
    value,
    "invalid_slug",
    128,
    /^[A-Za-z0-9][A-Za-z0-9._-]*$/,
  ).toLowerCase();
}

function validateCommand(value: unknown): string | undefined {
  if (value === undefined) return undefined;
  const command = boundedString(value, "invalid_command", LIMITS.command);
  if (/[\r\n\0]/.test(command) || /\[(?:redacted|secret|credential)[^\]]*\]/i.test(command)) {
    fail("invalid_command");
  }
  return command;
}

function validateCapability(value: unknown): CensusCapability {
  if (!isPlainObject(value)) fail("invalid_capability_object");
  const allowed = new Set([
    "kind", "name", "slug", "transport", "description", "pricing", "official",
    "tools_json", "detail_json", "command", "last_call_json",
  ]);
  for (const key of Object.keys(value)) {
    if (!allowed.has(key)) fail("unknown_field_in_capability");
  }
  if (!["server", "tool", "skill"].includes(String(value.kind))) fail("invalid_kind");
  if (!["stdio", "http", "hosted"].includes(String(value.transport))) fail("invalid_transport");
  if (!["free", "unknown", "paid"].includes(String(value.pricing))) fail("invalid_pricing");
  if (value.official !== 0 && value.official !== 1) fail("invalid_official");
  const result: CensusCapability = {
    kind: value.kind as CensusCapability["kind"],
    name: boundedString(value.name, "invalid_name", 256),
    slug: normalizeSlug(value.slug),
    transport: value.transport as CensusCapability["transport"],
    description: boundedString(value.description, "invalid_description"),
    pricing: value.pricing as CensusCapability["pricing"],
    official: value.official,
    tools_json: validateTools(value.tools_json),
    detail_json: JSON.stringify(parseSanitizedJson(value.detail_json, "invalid_detail_json")),
  };
  if (!isPlainObject(JSON.parse(result.detail_json))) fail("invalid_detail_json");
  const command = validateCommand(value.command);
  if (command !== undefined) result.command = command;
  if (value.last_call_json !== undefined) {
    const lastCall = parseSanitizedJson(
      value.last_call_json,
      "invalid_last_call_json",
    );
    if (!isPlainObject(lastCall)) fail("invalid_last_call_json");
    result.last_call_json = JSON.stringify(lastCall);
  }
  return result;
}

function validateFailure(value: unknown): CensusFailure {
  if (!isPlainObject(value)) fail("invalid_failure_object");
  const allowed = new Set(["slug", "command", "failure_reason", "failure_class"]);
  for (const key of Object.keys(value)) {
    if (!allowed.has(key)) fail("unknown_field_in_failure");
  }
  const result: CensusFailure = {
    slug: normalizeSlug(value.slug),
    failure_reason: boundedString(
      value.failure_reason,
      "invalid_failure_reason",
      128,
      /^[a-z][a-z0-9_.:-]*$/,
    ),
  };
  const command = validateCommand(value.command);
  if (command !== undefined) result.command = command;
  if (value.failure_class !== undefined) {
    result.failure_class = boundedString(
      value.failure_class,
      "invalid_failure_class",
      128,
      /^[a-z][a-z0-9_.:-]*$/,
    );
  }
  return result;
}

export function validateRoster(raw: unknown): CensusRoster {
  if (!isPlainObject(raw)) fail("invalid_roster_object");
  let rawBytes: number;
  try {
    rawBytes = utf8(JSON.stringify(raw));
  } catch {
    fail("invalid_roster_object");
  }
  if (rawBytes > LIMITS.reportBytes) fail("report_too_large");
  const allowed = new Set([
    "schema", "report_id", "observed_at", "complete", "capabilities", "failures",
  ]);
  for (const key of Object.keys(raw)) {
    if (!allowed.has(key)) fail("unknown_field_in_roster");
  }
  if (raw.schema !== "bridge-caps-roster-v1") fail("invalid_schema");
  if (typeof raw.complete !== "boolean") fail("invalid_complete");
  if (!Array.isArray(raw.capabilities) || raw.capabilities.length > LIMITS.rows) {
    fail("invalid_capabilities");
  }
  if (!Array.isArray(raw.failures) || raw.failures.length > LIMITS.rows) {
    fail("invalid_failures");
  }
  const reportId = boundedString(
    raw.report_id,
    "invalid_report_id",
    128,
    /^[A-Za-z0-9][A-Za-z0-9._:-]*$/,
  );
  const capabilities = raw.capabilities.map(validateCapability)
    .sort((a, b) => `${a.slug}\0${a.name}`.localeCompare(`${b.slug}\0${b.name}`));
  const failures = raw.failures.map(validateFailure)
    .sort((a, b) => `${a.slug}\0${a.failure_reason}`.localeCompare(`${b.slug}\0${b.failure_reason}`));
  const duplicate = new Set<string>();
  for (const row of capabilities) {
    if (duplicate.has(row.slug)) fail("duplicate_capability");
    duplicate.add(row.slug);
  }
  const failureSlugs = new Set<string>();
  for (const row of failures) {
    if (failureSlugs.has(row.slug)) fail("duplicate_failure");
    if (duplicate.has(row.slug)) fail("conflicting_capability_status");
    failureSlugs.add(row.slug);
  }
  return {
    schema: "bridge-caps-roster-v1",
    report_id: reportId,
    observed_at: strictUtc(raw.observed_at),
    complete: raw.complete,
    capabilities,
    failures,
  };
}

function contextField(value: unknown, code: string): string {
  return boundedString(value, code, 256, /^[A-Za-z0-9][A-Za-z0-9._:@/-]*$/);
}

function ownerForSource(value: CensusTrustedContext["source_surface"]): SurfaceOwner {
  if (value === "code" || value === "cowork") return "claude";
  if (value === "antigravity") return "agy";
  if (["claude", "codex", "gemini", "agy", "clickup-hosted", "n/a"].includes(String(value))) {
    return value as SurfaceOwner;
  }
  fail("unknown_source_surface");
}

export function mapTrustedContext(raw: CensusTrustedContext): CensusAttribution {
  if (!isPlainObject(raw)) fail("invalid_caller_context");
  const principal = contextField(raw.principal, "invalid_principal");
  const session = contextField(raw.session, "invalid_session");
  const host = contextField(raw.host, "invalid_host");
  const lane = contextField(raw.canonical_lane, "invalid_canonical_lane").toLowerCase();
  const client = contextField(raw.client_name, "invalid_client_name").toLowerCase();

  let owner: SurfaceOwner;
  let producer: ProducerSurface;
  let capture: CaptureClass;
  const pair = `${lane}\0${client}`;
  if (["code\0code", "code\0claude-code", "claude-code\0claude-code"].includes(pair)) {
    owner = "claude"; producer = "code"; capture = "guaranteed";
  } else if (["cowork\0cowork", "cowork\0claude-cowork", "claude-cowork\0claude-cowork"].includes(pair)) {
    owner = "claude"; producer = "cowork"; capture = "best-effort";
  } else if (pair === "codex\0codex") {
    owner = "codex"; producer = "codex"; capture = "reported";
  } else if (["antigravity\0antigravity", "antigravity\0agy", "agy\0agy"].includes(pair)) {
    owner = "agy"; producer = "antigravity"; capture = "reported";
  } else {
    fail("caller_context_mismatch");
  }

  let sourceSurface: string | null = null;
  if (raw.source_surface !== undefined) {
    if (producer !== "code") fail("unauthorized_source_surface");
    owner = ownerForSource(raw.source_surface);
    sourceSurface = raw.source_surface;
    if (raw.source_surface === "cowork" || raw.source_surface === "claude") {
      capture = "best-effort";
    }
  }
  const evidenceScope = `census:${producer}:${owner}:${sourceSurface ?? "direct"}`;
  return {
    surface_owner: owner,
    producer_surface: producer,
    capture_class: capture,
    evidence_scope: evidenceScope,
    principal,
    session,
    host,
    canonical_lane: lane,
    client_name: client,
    source_surface: sourceSurface,
  };
}

function canonicalHash(roster: CensusRoster): string {
  return crypto.createHash("sha256")
    .update(stableStringify(roster))
    .digest("hex");
}

function parseProvenance(row: Row | undefined): Record<string, unknown> {
  try {
    const value = row?.provenance_json ? JSON.parse(row.provenance_json) : {};
    return isPlainObject(value) ? value : {};
  } catch {
    return {};
  }
}

function censusProvenance(
  row: Row | undefined,
  roster: CensusRoster,
  hash: string,
  attribution: CensusAttribution,
  outcome: string,
  failureClass?: string,
): string {
  return JSON.stringify({
    ...parseProvenance(row),
    census: {
      schema: roster.schema,
      report_id: roster.report_id,
      canonical_hash: hash,
      observed_at: roster.observed_at,
      complete: roster.complete,
      outcome,
      failure_class: failureClass ?? null,
      ...attribution,
    },
  });
}

function normalizeCommand(value: string): string {
  return value.toLowerCase().replace(/["']/g, "").replace(/\s+/g, " ").trim();
}

function findAvailable(store: CapsStore, slug: string, command?: string): Row | undefined {
  const bySlug = store.db.prepare(
    "SELECT * FROM available_for_install WHERE lower(slug) = ?",
  ).get(slug) as Row | undefined;
  if (bySlug || !command) return bySlug;
  const wanted = normalizeCommand(command);
  return (store.db.prepare(
    "SELECT * FROM available_for_install WHERE install_command IS NOT NULL",
  ).all() as Row[]).find((row) => normalizeCommand(row.install_command) === wanted);
}

function rowEvidenceScope(row: Row): string | undefined {
  const provenance = parseProvenance(row);
  const census = isPlainObject(provenance.census) ? provenance.census : {};
  return typeof census.evidence_scope === "string"
    ? census.evidence_scope
    : undefined;
}

function findInstalledPair(
  store: CapsStore,
  slug: string,
  attribution: CensusAttribution,
): { working?: Row; broken?: Row } {
  const select = (table: InstalledTable): Row[] => store.db.prepare(
    `SELECT * FROM ${table}
     WHERE lower(slug) = ? AND surface_owner = ?
     ORDER BY id`,
  ).all(slug, attribution.surface_owner) as Row[];
  const workingRows = select("installed_working");
  const brokenRows = select("installed_broken");
  const exactWorking = workingRows.filter(
    (row) => rowEvidenceScope(row) === attribution.evidence_scope,
  );
  const exactBroken = brokenRows.filter(
    (row) => rowEvidenceScope(row) === attribution.evidence_scope,
  );
  if (exactWorking.length + exactBroken.length > 1) {
    fail("ambiguous_census_state");
  }
  if (exactWorking.length === 1 || exactBroken.length === 1) {
    return { working: exactWorking[0], broken: exactBroken[0] };
  }
  return {
    working: workingRows.find((row) => row.source_lane !== "census"),
    broken: brokenRows.find((row) => row.source_lane !== "census"),
  };
}

function deterministicId(attribution: CensusAttribution, slug: string): string {
  return `caps.census.${crypto.createHash("sha256")
    .update(`${attribution.surface_owner}\0${attribution.evidence_scope}\0${slug}`)
    .digest("hex")
    .slice(0, 32)}`;
}

function staleAt(observedAt: string): string {
  return new Date(Date.parse(observedAt) + 86_400_000).toISOString();
}

function effectivePricing(existing: Row | undefined, reported: CensusCapability["pricing"]): string {
  if (existing?.pricing === "paid") return "paid";
  return existing?.pricing ?? reported;
}

function mergedDetail(cap: CensusCapability): string {
  const details = JSON.parse(cap.detail_json) as Record<string, unknown>;
  return JSON.stringify({
    ...details,
    ...(cap.last_call_json ? { last_call: JSON.parse(cap.last_call_json) } : {}),
  });
}

function updateSuccess(
  store: CapsStore,
  id: string,
  cap: CensusCapability,
  roster: CensusRoster,
  attribution: CensusAttribution,
  provenance: string,
  existing?: Row,
): void {
  store.updateCensusInstalledRow("installed_working", id, {
    kind: cap.kind,
    name: cap.name,
    slug: cap.slug,
    surface_owner: attribution.surface_owner,
    transport: cap.transport,
    description: cap.description,
    pricing: effectivePricing(existing, cap.pricing),
    official: cap.official,
    source_lane: "census",
    producer_surface: attribution.producer_surface,
    capture_class: attribution.capture_class,
    observed_at: roster.observed_at,
    last_verified: roster.observed_at,
    stale_at: staleAt(roster.observed_at),
    tools_json: cap.tools_json,
    detail_json: mergedDetail(cap),
    provenance_json: provenance,
  });
}

export function processCensusReport(
  store: CapsStore,
  rawRoster: unknown,
  rawContext: CensusTrustedContext,
): CensusResult {
  const roster = validateRoster(rawRoster);
  const attribution = mapTrustedContext(rawContext);
  const hash = canonicalHash(roster);
  const callerProvenance = stableStringify(attribution);

  const applied = store.applyCensusReportAtomic(
    {
      report_id: roster.report_id,
      canonical_hash: hash,
      caller_provenance: callerProvenance,
      observed_at: roster.observed_at,
    },
    () => {
      const result = { repaired: 0, working: 0, broken: 0, missing: 0, skipped: 0 };

      for (const cap of roster.capabilities) {
        const { working, broken } = findInstalledPair(
          store, cap.slug, attribution,
        );
        const source = working ?? broken;
        const provenance = censusProvenance(
          source, roster, hash, attribution, "working",
        );
        if (working) {
          updateSuccess(store, working.id, cap, roster, attribution, provenance, working);
          result.working += 1;
          continue;
        }
        if (broken) {
          store.moveBrokenToWorking(broken.id, {
            source_lane: "census",
            failure_observed_at: roster.observed_at,
            provenance_json: provenance,
          });
          updateSuccess(store, broken.id, cap, roster, attribution, provenance, broken);
          result.repaired += 1;
          continue;
        }

        const available = findAvailable(store, cap.slug, cap.command);
        if (available) {
          const availableProvenance = censusProvenance(
            available, roster, hash, attribution, "working",
          );
          store.moveAvailableToInstalled(
            available.slug,
            cap.command ?? null,
            "installed_working",
            {
              surface_owner: attribution.surface_owner,
              source_lane: "census",
              last_verified: roster.observed_at,
              provenance_json: availableProvenance,
            },
          );
          updateSuccess(
            store,
            available.id,
            cap,
            roster,
            attribution,
            availableProvenance,
            available,
          );
          result.working += 1;
          continue;
        }

        const id = deterministicId(attribution, cap.slug);
        store.upsertCapability("installed_working", {
          id,
          kind: cap.kind,
          name: cap.name,
          slug: cap.slug,
          source_url: null,
          surface_owner: attribution.surface_owner,
          transport: cap.transport,
          description: cap.description,
          pricing: cap.pricing,
          official: cap.official,
          stars: null,
          install_command: cap.command ?? null,
          source_lane: "census",
          producer_surface: attribution.producer_surface,
          capture_class: attribution.capture_class,
          observed_at: roster.observed_at,
          last_verified: roster.observed_at,
          stale_at: staleAt(roster.observed_at),
          curated_notes: null,
          tools_json: cap.tools_json,
          detail_json: mergedDetail(cap),
          provenance_json: provenance,
          raw_json: null,
        });
        result.working += 1;
      }

      for (const failure of roster.failures) {
        const { working, broken } = findInstalledPair(
          store, failure.slug, attribution,
        );
        const available = !working && !broken
          ? findAvailable(store, failure.slug, failure.command)
          : undefined;
        const source = working ?? broken ?? available;
        if (!source) {
          result.skipped += 1;
          continue;
        }
        const provenance = censusProvenance(
          source,
          roster,
          hash,
          attribution,
          "broken",
          failure.failure_class,
        );
        let id = source.id;
        if (working) {
          store.moveWorkingToBroken(working.id, {
            source_lane: "census",
            failure_reason: failure.failure_reason,
            failure_observed_at: roster.observed_at,
            provenance_json: provenance,
          });
        } else if (available) {
          store.moveAvailableToInstalled(
            available.slug,
            failure.command ?? null,
            "installed_broken",
            {
              surface_owner: attribution.surface_owner,
              source_lane: "census",
              last_verified: roster.observed_at,
              provenance_json: provenance,
              failure_reason: failure.failure_reason,
              failure_observed_at: roster.observed_at,
            },
          );
          id = available.id;
        }
        store.updateCensusInstalledRow("installed_broken", id, {
          source_lane: "census",
          producer_surface: attribution.producer_surface,
          capture_class: attribution.capture_class,
          observed_at: roster.observed_at,
          last_verified: roster.observed_at,
          stale_at: staleAt(roster.observed_at),
          failure_reason: failure.failure_reason,
          failure_observed_at: roster.observed_at,
          provenance_json: provenance,
        });
        result.broken += 1;
      }

      if (roster.complete) {
        const reported = new Set(roster.capabilities.map((cap) => cap.slug));
        const candidates = store.db.prepare(
          "SELECT * FROM installed_working WHERE source_lane = 'census' AND surface_owner = ?",
        ).all(attribution.surface_owner) as Row[];
        for (const row of candidates) {
          const previous = parseProvenance(row);
          const census = isPlainObject(previous.census) ? previous.census : {};
          if (
            census.evidence_scope !== attribution.evidence_scope
            || reported.has(String(row.slug).toLowerCase())
          ) {
            continue;
          }
          const provenance = censusProvenance(
            row, roster, hash, attribution, "missing",
          );
          store.moveWorkingToBroken(row.id, {
            source_lane: "census",
            failure_reason: "census_missing_from_complete_roster",
            failure_observed_at: roster.observed_at,
            provenance_json: provenance,
          });
          store.updateCensusInstalledRow("installed_broken", row.id, {
            producer_surface: attribution.producer_surface,
            capture_class: attribution.capture_class,
            failure_reason: "census_missing_from_complete_roster",
            failure_observed_at: roster.observed_at,
            provenance_json: provenance,
          });
          result.missing += 1;
        }
      }
      return result;
    },
  );

  return { ...applied.result, replayed: applied.replayed };
}
