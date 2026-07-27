-- Package 02 contract correction.
--
-- A configuration declaration proves installation but not health. Such rows
-- live in installed_broken with failure_reason=verification_pending and have
-- never been verified, so last_verified must be SQL NULL. Rebuild the STRICT
-- table because SQLite cannot drop a NOT NULL constraint in place.

CREATE TABLE installed_broken_v2 (
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
  last_verified TEXT,
  stale_at TEXT NOT NULL,
  curated_notes TEXT,
  tools_json TEXT CHECK(tools_json IS NULL OR json_valid(tools_json)),
  detail_json TEXT CHECK(detail_json IS NULL OR json_valid(detail_json)),
  provenance_json TEXT NOT NULL CHECK(json_valid(provenance_json)),
  raw_json TEXT CHECK(raw_json IS NULL OR json_valid(raw_json)),
  failure_reason TEXT NOT NULL,
  failure_observed_at TEXT NOT NULL
) STRICT;

INSERT INTO installed_broken_v2 (
  id,
  kind,
  name,
  slug,
  source_url,
  surface_owner,
  transport,
  description,
  pricing,
  official,
  stars,
  install_command,
  source_lane,
  producer_surface,
  capture_class,
  observed_at,
  last_verified,
  stale_at,
  curated_notes,
  tools_json,
  detail_json,
  provenance_json,
  raw_json,
  failure_reason,
  failure_observed_at
)
SELECT
  id,
  kind,
  name,
  slug,
  source_url,
  surface_owner,
  transport,
  description,
  pricing,
  official,
  stars,
  install_command,
  source_lane,
  producer_surface,
  capture_class,
  observed_at,
  last_verified,
  stale_at,
  curated_notes,
  tools_json,
  detail_json,
  provenance_json,
  raw_json,
  failure_reason,
  failure_observed_at
FROM installed_broken;

DROP TABLE installed_broken;
ALTER TABLE installed_broken_v2 RENAME TO installed_broken;
