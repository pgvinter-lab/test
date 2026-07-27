export type CapabilityKind = 'server' | 'tool' | 'skill';
export type CapabilityPricing = 'free' | 'unknown' | 'paid';
export type SurfaceOwner = 'claude' | 'codex' | 'gemini' | 'agy' | 'clickup-hosted' | 'n/a';
export type TransportLayer = 'stdio' | 'http' | 'hosted';
export type SourceLane = 'config-crawl' | 'probe' | 'census' | 'mcpservers-sitemap' | 'mcpservers-search';
export type ProducerSurface = 'code' | 'cowork' | 'codex' | 'antigravity' | 'external-index';
export type CaptureClass = 'guaranteed' | 'best-effort' | 'reported' | 'observed';

export const PricingSortTier: Record<CapabilityPricing, number> = {
  free: 0,
  unknown: 1,
  paid: 2,
} as const;

export interface CaptureProvenance {
  producer_surface: ProducerSurface;
  capture_class: CaptureClass;
  observed_at: string; // ISO-8601 UTC
  last_verified: string | null; // ISO-8601 UTC, or null until probe/census verification
  stale_at: string; // ISO-8601 UTC
  provenance_json: string; // JSON string
}

export interface CapabilityBase extends CaptureProvenance {
  id: string;
  kind: CapabilityKind;
  name: string;
  slug: string;
  source_url: string | null;
  surface_owner: SurfaceOwner;
  transport: TransportLayer;
  description: string | null;
  pricing: CapabilityPricing;
  official: 0 | 1; // 0 or 1 for booleans
  stars: number | null;
  install_command: string | null;
  source_lane: SourceLane;
  curated_notes: string | null;
  tools_json: string | null; // JSON string
  detail_json: string | null; // JSON string
  raw_json: string | null; // JSON string, NEVER credential
}

export interface InstalledWorking extends CapabilityBase {
  last_verified: string;
}

export interface InstalledBroken extends CapabilityBase {
  failure_reason: string;
  failure_observed_at: string; // ISO-8601 UTC
}

export interface AvailableForInstall extends CapabilityBase {
  last_verified: string;
  category: string | null;
  detail_fetched_at: string | null; // ISO-8601 UTC
  judgment_model: string | null;
  judgment_at: string | null; // ISO-8601 UTC
  judgment_verdict: string | null;
  judgment_reason: string | null;
  judgment_surface: string | null;
}

export interface CensusCapability {
  kind: CapabilityKind;
  name: string;
  slug: string;
  transport: TransportLayer;
  description: string;
  pricing: CapabilityPricing;
  official: 0 | 1;
  tools_json: string;
  detail_json: string;
  command?: string;
  last_call_json?: string;
}

export interface CensusFailure {
  slug: string;
  command?: string;
  failure_reason: string;
  failure_class?: string;
}

export interface CensusRoster {
  schema: 'bridge-caps-roster-v1';
  report_id: string;
  observed_at: string;
  complete: boolean;
  capabilities: CensusCapability[];
  failures: CensusFailure[];
}

export interface CensusTrustedContext {
  principal: string;
  session: string;
  host: string;
  canonical_lane: string;
  client_name: string;
  source_surface?: SurfaceOwner | 'code' | 'cowork' | 'antigravity';
}

export interface CensusReceipt {
  report_id: string;
  canonical_hash: string;
  caller_provenance: string;
  observed_at: string;
  result_summary: string;
}

export interface CensusAttribution {
  surface_owner: SurfaceOwner;
  producer_surface: ProducerSurface;
  capture_class: CaptureClass;
  evidence_scope: string;
  principal: string;
  session: string;
  host: string;
  canonical_lane: string;
  client_name: string;
  source_surface: string | null;
}

export interface CensusResult {
  repaired: number;
  working: number;
  broken: number;
  missing: number;
  skipped: number;
  replayed: boolean;
}
