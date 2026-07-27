import { z } from "zod";
import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { mapTrustedContext, validateRoster } from "./census.js";
import { loadCapsConfig, type CapsConfig } from "./config.js";
import { CrawlConfigLane } from "./crawl-config.js";
import {
  McpserversIndexer,
  type McpserversRefreshReport,
} from "./mcpservers.js";
import { CapsService } from "./service.js";
import { probeLocalStdio, type ProbeOutcome } from "./stdio-probe.js";
import { CapsStore } from "./store.js";
import type {
  CensusAttribution,
  CensusTrustedContext,
} from "./types.js";

export const CAPS_CENSUS_SCHEMA_VERSION = "bridge-caps-roster-v1";

const MAX_QUERY_LENGTH = 512;
const MAX_IDENTIFIER_LENGTH = 160;
const MAX_PROBE_CANDIDATES = 100;
const CENSUS_FRESHNESS_MS = 24 * 60 * 60 * 1_000;

const refreshLaneSchema = z.enum([
  "all",
  "config-crawl",
  "stdio-probe",
  "mcpservers",
]);
type RefreshLane = z.infer<typeof refreshLaneSchema>;

export interface CapsCallerContextInput {
  principal: string;
  session: string;
  host: string;
  lane: string;
  lane_ambiguous: boolean;
  lane_configured: boolean;
  client_name: string;
}

export interface CapsCensusStatus {
  schema_version: typeof CAPS_CENSUS_SCHEMA_VERSION;
  due: boolean;
  last_report_at: string | null;
}

export interface CapsMcpRuntimeOptions {
  config?: CapsConfig;
  crawl_home?: string;
}

const jsonStringSchema = z.string().max(384 * 1_024);
const censusCapabilitySchema = z.object({
  kind: z.enum(["server", "tool", "skill"]),
  name: z.string().min(1).max(256),
  slug: z.string().min(1).max(128),
  transport: z.enum(["stdio", "http", "hosted"]),
  description: z.string().min(1).max(8 * 1_024),
  pricing: z.enum(["free", "unknown", "paid"]),
  official: z.union([z.literal(0), z.literal(1)]),
  tools_json: jsonStringSchema,
  detail_json: jsonStringSchema,
  command: z.string().min(1).max(16 * 1_024).optional(),
  last_call_json: jsonStringSchema.optional(),
}).strict();
const censusFailureSchema = z.object({
  slug: z.string().min(1).max(128),
  command: z.string().min(1).max(16 * 1_024).optional(),
  failure_reason: z.string().min(1).max(128),
  failure_class: z.string().min(1).max(128).optional(),
}).strict();
export const capsCensusRosterInputSchema = z.object({
  schema: z.literal(CAPS_CENSUS_SCHEMA_VERSION),
  report_id: z.string().min(1).max(128),
  observed_at: z.string().min(1).max(40),
  complete: z.boolean(),
  capabilities: z.array(censusCapabilitySchema).max(500),
  failures: z.array(censusFailureSchema).max(500),
}).strict();

export function normalizeLane(lane: string): string {
  const lower = lane.trim().toLowerCase();
  if (lower === "claude_desktop_code") return "code";
  if (lower === "claude_desktop_cowork") return "cowork";
  if (lower === "codex") return "codex";
  if (["antigravity", "google_antigravity", "agy"].includes(lower)) {
    return "antigravity";
  }
  return lower;
}

function normalizeClientName(
  lane: string,
  clientName: string,
  laneConfigured: boolean,
): string {
  const client = clientName.trim().toLowerCase().replace(/[\s_]+/gu, "-");
  const contradicts = (...markers: string[]) =>
    markers.some((marker) => client.includes(marker));

  if (lane === "code") {
    if (contradicts("cowork", "codex", "antigravity", "agy")) {
      throw new Error("caller_context_mismatch");
    }
    if (
      !laneConfigured
      && ![
        "code",
        "claude-code",
        "claude-code-cli",
        "claude-cli",
      ].includes(client)
    ) {
      throw new Error("caller_client_identity_unrecognized");
    }
    return "claude-code";
  }
  if (lane === "cowork") {
    if (contradicts("codex", "antigravity", "agy")
      || (client.includes("code") && !client.includes("cowork"))) {
      throw new Error("caller_context_mismatch");
    }
    if (!laneConfigured && !/(?:^|-)cowork(?:-|$)/u.test(client)) {
      throw new Error("caller_client_identity_unrecognized");
    }
    return "claude-cowork";
  }
  if (lane === "codex") {
    if (contradicts("cowork", "claude", "antigravity", "agy")) {
      throw new Error("caller_context_mismatch");
    }
    return "codex";
  }
  if (lane === "antigravity") {
    if (contradicts("cowork", "claude", "codex")) {
      throw new Error("caller_context_mismatch");
    }
    return "agy";
  }
  throw new Error("caller_lane_unsupported");
}

function assertPrincipalMatchesLane(principal: string, lane: string): void {
  const normalized = principal.trim().toLowerCase();
  const allowed = lane === "code"
    ? ["claude", "code", "claude_desktop_code"]
    : lane === "cowork"
      ? ["claude", "cowork", "claude_desktop_cowork"]
      : lane === "codex"
        ? ["codex"]
        : lane === "antigravity"
          ? ["agy", "antigravity", "google_antigravity", "google-antigravity"]
          : [];
  if (!allowed.includes(normalized)) {
    throw new Error("caller_principal_lane_mismatch");
  }
}

export function deriveTrustedCapsContext(
  input: CapsCallerContextInput,
): CensusTrustedContext {
  if (input.lane_ambiguous) {
    throw new Error("caller_lane_ambiguous");
  }
  const canonicalLane = normalizeLane(input.lane);
  assertPrincipalMatchesLane(input.principal, canonicalLane);
  const context = {
    principal: input.principal,
    session: input.session,
    host: input.host,
    canonical_lane: canonicalLane,
    client_name: normalizeClientName(
      canonicalLane,
      input.client_name,
      input.lane_configured,
    ),
  };
  mapTrustedContext(context);
  return context;
}

function canonicalAttribution(attribution: CensusAttribution): string {
  return JSON.stringify(
    attribution,
    Object.keys(attribution).sort(),
  );
}

function compactMcpserversReport(report: McpserversRefreshReport) {
  const statedTotals = Object.fromEntries(
    Object.entries(report.stated_totals)
      .sort(([left], [right]) => left.localeCompare(right))
      .map(([name, value]) => [
        name,
        {
          value: value.value,
          previous: value.previous,
          delta: value.delta,
          observed_at: value.observed_at,
        },
      ]),
  );
  return {
    schema: report.schema,
    started_at: report.started_at,
    finished_at: report.finished_at,
    stated_totals: statedTotals,
    diff: {
      new_count: report.diff.new_count,
      changed_count: report.diff.changed_count,
      removed_count: report.diff.removed_count,
    },
    processed: report.processed,
    skipped_installed: report.skipped_installed,
    pending: report.pending,
    gap_count: report.gaps.length,
    error_count: report.errors.length,
    fetch_count: report.fetch_log.length,
  };
}

export class CapsMcpRuntime {
  private configValue: CapsConfig | undefined;
  private storeValue: CapsStore | undefined;
  private serviceValue: CapsService | undefined;
  private refreshRunning = false;
  private readonly crawlHome: string | undefined;

  public constructor(options: CapsMcpRuntimeOptions = {}) {
    this.configValue = options.config;
    this.crawlHome = options.crawl_home;
  }

  private config(): CapsConfig {
    this.configValue ??= loadCapsConfig();
    return this.configValue;
  }

  private store(): CapsStore {
    this.storeValue ??= new CapsStore(this.config());
    return this.storeValue;
  }

  private service(): CapsService {
    this.serviceValue ??= new CapsService(this.store());
    return this.serviceValue;
  }

  public close(): void {
    this.storeValue?.close();
    this.storeValue = undefined;
    this.serviceValue = undefined;
  }

  public search(
    query: string,
    options: unknown,
    context: CensusTrustedContext,
  ) {
    return this.service().search(query, options, context);
  }

  public get(id: string, context: CensusTrustedContext) {
    return this.service().get(id, context);
  }

  public report(roster: unknown, context: CensusTrustedContext) {
    return this.service().reportCensus(roster, context);
  }

  public reportWithReceipt(
    rawRoster: unknown,
    context: CensusTrustedContext,
  ) {
    const roster = validateRoster(rawRoster);
    const result = this.service().reportCensus(roster, context);
    const receipt = this.store().getCensusReceipt(roster.report_id);
    if (!receipt) throw new Error("census_receipt_missing");
    return {
      report_id: receipt.report_id,
      canonical_hash: receipt.canonical_hash,
      observed_at: receipt.observed_at,
      result,
    };
  }

  public censusStatus(context: CensusTrustedContext): CapsCensusStatus {
    const attribution = mapTrustedContext(context);
    const callerProvenance = canonicalAttribution(attribution);
    const row = this.store().db.prepare(`
      SELECT observed_at
      FROM _caps_census_receipts
      WHERE caller_provenance = ?
      ORDER BY observed_at DESC, report_id DESC
      LIMIT 1
    `).get(callerProvenance) as { observed_at: string } | undefined;
    const lastReportAt = row?.observed_at ?? null;
    const observedEpoch = lastReportAt === null
      ? Number.NaN
      : Date.parse(lastReportAt);
    return {
      schema_version: CAPS_CENSUS_SCHEMA_VERSION,
      due: !Number.isFinite(observedEpoch)
        || Date.now() - observedEpoch >= CENSUS_FRESHNESS_MS,
      last_report_at: lastReportAt,
    };
  }

  private async refreshConfig() {
    const report = new CrawlConfigLane(this.config(), this.store())
      .executeCrawl(this.crawlHome);
    return {
      started_at: report.started_at,
      completed_at: report.completed_at,
      observation_count: report.observation_count,
      gap_count: report.gaps.length,
      gaps: report.gaps.slice(0, 100),
      gaps_truncated: report.gaps.length > 100,
    };
  }

  private async refreshProbes() {
    const rows = this.store().db.prepare(`
      SELECT id
      FROM (
        SELECT id
        FROM installed_working
        WHERE transport = 'stdio'
          AND producer_surface = 'code'
          AND capture_class = 'guaranteed'
          AND source_lane IN ('config-crawl', 'probe')
          AND raw_json IS NOT NULL
        UNION
        SELECT id
        FROM installed_broken
        WHERE transport = 'stdio'
          AND producer_surface = 'code'
          AND capture_class = 'guaranteed'
          AND source_lane IN ('config-crawl', 'probe')
          AND raw_json IS NOT NULL
      )
      ORDER BY id
      LIMIT ?
    `).all(MAX_PROBE_CANDIDATES + 1) as { id: string }[];
    const selected = rows.slice(0, MAX_PROBE_CANDIDATES);
    const outcomes: ProbeOutcome[] = [];
    for (const row of selected) {
      outcomes.push(await probeLocalStdio(this.store(), row.id));
    }
    return {
      selected: selected.length,
      working: outcomes.filter((outcome) => outcome.status === "working").length,
      broken: outcomes.filter((outcome) => outcome.status === "broken").length,
      truncated: rows.length > MAX_PROBE_CANDIDATES,
      outcomes,
    };
  }

  private async refreshMcpservers() {
    const report = await new McpserversIndexer(this.store(), this.config())
      .runRefresh(AbortSignal.timeout(30 * 60 * 1_000));
    return compactMcpserversReport(report);
  }

  public async refresh(
    lane: RefreshLane,
    context: CensusTrustedContext,
  ) {
    const attribution = mapTrustedContext(context);
    if (
      context.canonical_lane !== "code"
      || attribution.producer_surface !== "code"
    ) {
      throw new Error("caps_refresh_requires_code");
    }
    if (this.refreshRunning) throw new Error("caps_refresh_in_progress");
    this.refreshRunning = true;
    const startedAt = new Date().toISOString();
    try {
      const reports: Record<string, unknown> = {};
      if (lane === "all" || lane === "config-crawl") {
        reports["config-crawl"] = await this.refreshConfig();
      }
      if (lane === "all" || lane === "stdio-probe") {
        reports["stdio-probe"] = await this.refreshProbes();
      }
      if (lane === "all" || lane === "mcpservers") {
        reports.mcpservers = await this.refreshMcpservers();
      }
      return {
        schema: "bridge-caps-refresh-v1",
        lane,
        mutated: true,
        started_at: startedAt,
        completed_at: new Date().toISOString(),
        reports,
      };
    } finally {
      this.refreshRunning = false;
    }
  }
}

function codeRefreshRequest(lane: RefreshLane) {
  return {
    tool: "bridge_a2a_send",
    arguments: {
      target: "claude",
      prompt: [
        "CAPS REFRESH REQUEST - CODE ORCHESTRATOR REQUIRED",
        "Run the existing Bridge MCP tool caps_refresh locally from the registered Code lane.",
        `Use exactly these arguments: ${JSON.stringify({ lane })}`,
        "Return the bounded refresh report. Do not install or proxy any discovered capability.",
      ].join("\n"),
    },
  };
}

export function registerCapsTools(
  server: McpServer,
  getRuntime: () => CapsMcpRuntime,
  getContext: () => CapsCallerContextInput,
): void {
  const trustedContext = () => deriveTrustedCapsContext(getContext());

  function ok(obj: unknown) {
    return {
      content: [{
        type: "text" as const,
        text: JSON.stringify(obj, null, 2),
      }],
    };
  }
  function fail(message: string) {
    return {
      isError: true,
      content: [{
        type: "text" as const,
        text: JSON.stringify({ ok: false, message }, null, 2),
      }],
    };
  }
  async function run(fn: () => Promise<unknown> | unknown) {
    try {
      return ok(await fn());
    } catch (error) {
      return fail(error instanceof Error ? error.message : "caps_tool_failed");
    }
  }

  server.registerTool(
    "caps_search",
    {
      title: "Search capabilities",
      description: "Search for available capabilities (servers, tools, skills). Paid capabilities always sort after free ones.",
      inputSchema: {
        query: z.string().min(1).max(MAX_QUERY_LENGTH)
          .describe("FTS query or exact match string"),
        opts: z.object({
          kind: z.enum(["server", "tool", "skill"]).optional(),
          table_origin: z.enum([
            "installed_working",
            "installed_broken",
            "available_for_install",
          ]).optional(),
          surface_owner: z.enum([
            "claude",
            "codex",
            "gemini",
            "agy",
            "clickup-hosted",
            "n/a",
          ]).optional(),
          limit: z.number().int().min(1).max(50).optional(),
        }).strict().optional(),
      },
    },
    async (args) => run(() => getRuntime().search(
      args.query,
      args.opts,
      trustedContext(),
    )),
  );

  server.registerTool(
    "caps_get",
    {
      title: "Get capability detail",
      description: "Retrieve the sanitized stored row for a capability identifier.",
      inputSchema: {
        id: z.string()
          .min(1)
          .max(MAX_IDENTIFIER_LENGTH)
          .regex(/^[A-Za-z0-9._:-]+$/u)
          .describe("Capability identifier"),
      },
    },
    async (args) => run(() => getRuntime().get(
      args.id,
      trustedContext(),
    )),
  );

  server.registerTool(
    "caps_report",
    {
      title: "Report capabilities census",
      description: "Report the calling surface's current tools and failures to the catalog.",
      inputSchema: {
        roster: capsCensusRosterInputSchema.describe(
          "A closed bridge-caps-roster-v1 payload",
        ),
      },
    },
    async (args) => run(() => getRuntime().report(
      args.roster,
      trustedContext(),
    )),
  );

  server.registerTool(
    "caps_refresh",
    {
      title: "Refresh capabilities catalog",
      description: "Run a bounded catalog refresh. Local mutation is limited to the registered Code lane.",
      inputSchema: {
        lane: refreshLaneSchema.optional()
          .describe("Refresh lane; defaults to all"),
      },
    },
    async (args) => run(async () => {
      const lane = args.lane ?? "all";
      const context = trustedContext();
      if (context.canonical_lane !== "code") {
        return {
          code: "requires_code_orchestrator",
          requires_code_orchestrator: true,
          mutated: false,
          lane,
          a2a_request_template: codeRefreshRequest(lane),
        };
      }
      return getRuntime().refresh(lane, context);
    }),
  );
}
