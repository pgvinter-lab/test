-- Checksum: 001_caps_store
-- Forward-only migration

PRAGMA foreign_keys=ON;

CREATE TABLE _caps_idempotency (
  idempotency_key TEXT PRIMARY KEY,
  canonical_hash TEXT NOT NULL
) STRICT;


-- installed_working
CREATE TABLE installed_working (
  id TEXT PRIMARY KEY,
  kind TEXT NOT NULL CHECK(kind IN ('server', 'tool', 'skill')),
  name TEXT NOT NULL,
  slug TEXT NOT NULL,
  source_url TEXT,
  surface_owner TEXT NOT NULL CHECK(surface_owner IN ('claude', 'codex', 'gemini', 'agy', 'clickup-hosted', 'n/a')),
  transport TEXT NOT NULL CHECK(transport IN ('stdio', 'http', 'hosted')),
  description TEXT,
  pricing TEXT NOT NULL CHECK(pricing IN ('free', 'unknown', 'paid')),
  official INTEGER NOT NULL CHECK(official IN (0, 1)),
  stars INTEGER,
  install_command TEXT,
  source_lane TEXT NOT NULL CHECK(source_lane IN ('config-crawl', 'probe', 'census', 'mcpservers-sitemap', 'mcpservers-search')),
  producer_surface TEXT NOT NULL CHECK(producer_surface IN ('code', 'cowork', 'codex', 'antigravity', 'external-index')),
  capture_class TEXT NOT NULL CHECK(capture_class IN ('guaranteed', 'best-effort', 'reported', 'observed')),
  observed_at TEXT NOT NULL,
  last_verified TEXT NOT NULL,
  stale_at TEXT NOT NULL,
  curated_notes TEXT,
  tools_json TEXT CHECK(tools_json IS NULL OR json_valid(tools_json)),
  detail_json TEXT CHECK(detail_json IS NULL OR json_valid(detail_json)),
  provenance_json TEXT NOT NULL CHECK(json_valid(provenance_json)),
  raw_json TEXT CHECK(raw_json IS NULL OR json_valid(raw_json))
) STRICT;

-- installed_broken
CREATE TABLE installed_broken (
  id TEXT PRIMARY KEY,
  kind TEXT NOT NULL CHECK(kind IN ('server', 'tool', 'skill')),
  name TEXT NOT NULL,
  slug TEXT NOT NULL,
  source_url TEXT,
  surface_owner TEXT NOT NULL CHECK(surface_owner IN ('claude', 'codex', 'gemini', 'agy', 'clickup-hosted', 'n/a')),
  transport TEXT NOT NULL CHECK(transport IN ('stdio', 'http', 'hosted')),
  description TEXT,
  pricing TEXT NOT NULL CHECK(pricing IN ('free', 'unknown', 'paid')),
  official INTEGER NOT NULL CHECK(official IN (0, 1)),
  stars INTEGER,
  install_command TEXT,
  source_lane TEXT NOT NULL CHECK(source_lane IN ('config-crawl', 'probe', 'census', 'mcpservers-sitemap', 'mcpservers-search')),
  producer_surface TEXT NOT NULL CHECK(producer_surface IN ('code', 'cowork', 'codex', 'antigravity', 'external-index')),
  capture_class TEXT NOT NULL CHECK(capture_class IN ('guaranteed', 'best-effort', 'reported', 'observed')),
  observed_at TEXT NOT NULL,
  last_verified TEXT NOT NULL,
  stale_at TEXT NOT NULL,
  curated_notes TEXT,
  tools_json TEXT CHECK(tools_json IS NULL OR json_valid(tools_json)),
  detail_json TEXT CHECK(detail_json IS NULL OR json_valid(detail_json)),
  provenance_json TEXT NOT NULL CHECK(json_valid(provenance_json)),
  raw_json TEXT CHECK(raw_json IS NULL OR json_valid(raw_json)),
  failure_reason TEXT NOT NULL,
  failure_observed_at TEXT NOT NULL
) STRICT;

-- available_for_install
CREATE TABLE available_for_install (
  id TEXT PRIMARY KEY,
  kind TEXT NOT NULL CHECK(kind IN ('server', 'tool', 'skill')),
  name TEXT NOT NULL,
  slug TEXT NOT NULL,
  source_url TEXT,
  surface_owner TEXT NOT NULL CHECK(surface_owner IN ('claude', 'codex', 'gemini', 'agy', 'clickup-hosted', 'n/a')),
  transport TEXT NOT NULL CHECK(transport IN ('stdio', 'http', 'hosted')),
  description TEXT,
  pricing TEXT NOT NULL CHECK(pricing IN ('free', 'unknown', 'paid')),
  official INTEGER NOT NULL CHECK(official IN (0, 1)),
  stars INTEGER,
  install_command TEXT,
  source_lane TEXT NOT NULL CHECK(source_lane IN ('config-crawl', 'probe', 'census', 'mcpservers-sitemap', 'mcpservers-search')),
  producer_surface TEXT NOT NULL CHECK(producer_surface IN ('code', 'cowork', 'codex', 'antigravity', 'external-index')),
  capture_class TEXT NOT NULL CHECK(capture_class IN ('guaranteed', 'best-effort', 'reported', 'observed')),
  observed_at TEXT NOT NULL,
  last_verified TEXT NOT NULL,
  stale_at TEXT NOT NULL,
  curated_notes TEXT,
  tools_json TEXT CHECK(tools_json IS NULL OR json_valid(tools_json)),
  detail_json TEXT CHECK(detail_json IS NULL OR json_valid(detail_json)),
  provenance_json TEXT NOT NULL CHECK(json_valid(provenance_json)),
  raw_json TEXT CHECK(raw_json IS NULL OR json_valid(raw_json)),
  category TEXT,
  detail_fetched_at TEXT,
  judgment_model TEXT,
  judgment_at TEXT,
  judgment_verdict TEXT,
  judgment_reason TEXT,
  judgment_surface TEXT
) STRICT;
