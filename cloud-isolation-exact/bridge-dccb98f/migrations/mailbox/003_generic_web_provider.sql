DROP TRIGGER IF EXISTS mailbox_message_content_immutable;
DROP TRIGGER IF EXISTS mailbox_messages_no_delete;
DROP TRIGGER IF EXISTS mailbox_delivery_binding_immutable;
DROP TRIGGER IF EXISTS mailbox_deliveries_no_delete;
DROP TRIGGER IF EXISTS mailbox_messages_current_schema_only;
DROP TRIGGER IF EXISTS mailbox_deliveries_current_schema_only;
DROP TRIGGER IF EXISTS mailbox_messages_no_new_legacy_provider;
DROP TRIGGER IF EXISTS mailbox_deliveries_no_new_legacy_provider;
DROP TRIGGER IF EXISTS mailbox_legacy_gemini_messages_read_only;
DROP TRIGGER IF EXISTS mailbox_legacy_gemini_deliveries_read_only;
DROP INDEX IF EXISTS mailbox_messages_queue_idx;
DROP INDEX IF EXISTS mailbox_one_active_delivery;

ALTER TABLE mailbox_deliveries RENAME TO mailbox_deliveries_v2;
ALTER TABLE mailbox_messages RENAME TO mailbox_messages_v2;

CREATE TABLE mailbox_messages (
  message_id TEXT PRIMARY KEY,
  project_id TEXT NOT NULL,
  sender_json TEXT NOT NULL CHECK (json_valid(sender_json)),
  schema_version TEXT NOT NULL CHECK (schema_version IN ('bridge-mailbox-v1','bridge-mailbox-v2','bridge-mailbox-v3')),
  provider TEXT NOT NULL CHECK (provider IN ('chatgpt','antigravity','web','gemini')),
  mode TEXT NOT NULL CHECK (mode = 'default'),
  priority TEXT NOT NULL CHECK (priority IN ('normal','high')),
  sensitivity TEXT NOT NULL CHECK (sensitivity IN ('public','internal')),
  status TEXT NOT NULL CHECK (status IN ('preparing','queued','claimed','dispatching','sent','completed','failed','uncertain','expired')),
  created_at TEXT NOT NULL,
  expires_at TEXT NOT NULL,
  prompt_sha256 TEXT NOT NULL CHECK (length(prompt_sha256) = 64),
  approval_ref TEXT NOT NULL,
  envelope_sha256 TEXT CHECK (envelope_sha256 IS NULL OR length(envelope_sha256) = 64),
  envelope_relative_path TEXT,
  ready_relative_path TEXT,
  attempt INTEGER NOT NULL DEFAULT 0 CHECK (attempt >= 0),
  max_attempts INTEGER NOT NULL CHECK (max_attempts BETWEEN 1 AND 20),
  active_delivery_id TEXT,
  response_sha256 TEXT CHECK (response_sha256 IS NULL OR length(response_sha256) = 64),
  response_relative_path TEXT,
  last_error TEXT,
  updated_at TEXT NOT NULL
) STRICT;

CREATE TABLE mailbox_deliveries (
  delivery_id TEXT PRIMARY KEY,
  message_id TEXT NOT NULL REFERENCES mailbox_messages(message_id),
  schema_version TEXT NOT NULL CHECK (schema_version IN ('bridge-mailbox-v1','bridge-mailbox-v2','bridge-mailbox-v3')),
  provider TEXT NOT NULL CHECK (provider IN ('chatgpt','antigravity','web','gemini')),
  consumer_id TEXT NOT NULL,
  delivery_token_hash TEXT NOT NULL CHECK (length(delivery_token_hash) = 64),
  status TEXT NOT NULL CHECK (status IN ('claimed','dispatching','sent','completed','failed','released','uncertain')),
  claimed_at TEXT NOT NULL,
  lease_expires_at TEXT NOT NULL,
  response_id TEXT,
  response_created_at TEXT,
  response_content_sha256 TEXT CHECK (response_content_sha256 IS NULL OR length(response_content_sha256) = 64),
  response_sha256 TEXT,
  response_relative_path TEXT,
  error_code TEXT,
  completed_at TEXT,
  updated_at TEXT NOT NULL
) STRICT;

INSERT INTO mailbox_messages(
  message_id, project_id, sender_json, schema_version, provider, mode, priority, sensitivity,
  status, created_at, expires_at, prompt_sha256, approval_ref,
  envelope_sha256, envelope_relative_path, ready_relative_path, attempt,
  max_attempts, active_delivery_id, response_sha256, response_relative_path,
  last_error, updated_at
)
SELECT
  message_id, project_id, sender_json, schema_version, provider, mode, priority, sensitivity,
  status, created_at, expires_at, prompt_sha256, approval_ref,
  envelope_sha256, envelope_relative_path, ready_relative_path, attempt,
  max_attempts, active_delivery_id, response_sha256, response_relative_path,
  last_error, updated_at
FROM mailbox_messages_v2;

INSERT INTO mailbox_deliveries(
  delivery_id, message_id, schema_version, provider, consumer_id, delivery_token_hash, status,
  claimed_at, lease_expires_at, response_id, response_created_at,
  response_content_sha256, response_sha256, response_relative_path, error_code,
  completed_at, updated_at
)
SELECT
  delivery_id, message_id, schema_version, provider, consumer_id, delivery_token_hash, status,
  claimed_at, lease_expires_at, response_id, response_created_at,
  response_content_sha256, response_sha256, response_relative_path, error_code,
  completed_at, updated_at
FROM mailbox_deliveries_v2;

DROP TABLE mailbox_deliveries_v2;
DROP TABLE mailbox_messages_v2;

CREATE INDEX mailbox_messages_queue_idx
  ON mailbox_messages(provider, status, priority, created_at);
CREATE UNIQUE INDEX mailbox_one_active_delivery
  ON mailbox_deliveries(message_id)
  WHERE status IN ('claimed','dispatching','sent');

CREATE TRIGGER mailbox_messages_no_new_legacy_provider BEFORE INSERT ON mailbox_messages
WHEN NEW.provider = 'gemini'
BEGIN SELECT RAISE(ABORT, 'retired_mailbox_provider'); END;

CREATE TRIGGER mailbox_deliveries_no_new_legacy_provider BEFORE INSERT ON mailbox_deliveries
WHEN NEW.provider = 'gemini'
BEGIN SELECT RAISE(ABORT, 'retired_mailbox_provider'); END;

CREATE TRIGGER mailbox_messages_current_schema_only BEFORE INSERT ON mailbox_messages
WHEN NEW.schema_version != 'bridge-mailbox-v3'
BEGIN SELECT RAISE(ABORT, 'stale_mailbox_writer'); END;

CREATE TRIGGER mailbox_deliveries_current_schema_only BEFORE INSERT ON mailbox_deliveries
WHEN NEW.schema_version != 'bridge-mailbox-v3'
BEGIN SELECT RAISE(ABORT, 'stale_mailbox_writer'); END;

CREATE TRIGGER mailbox_legacy_gemini_messages_read_only BEFORE UPDATE ON mailbox_messages
WHEN OLD.provider = 'gemini'
BEGIN SELECT RAISE(ABORT, 'immutable_mailbox_legacy_gemini_message'); END;

CREATE TRIGGER mailbox_legacy_gemini_deliveries_read_only BEFORE UPDATE ON mailbox_deliveries
WHEN OLD.provider = 'gemini'
BEGIN SELECT RAISE(ABORT, 'immutable_mailbox_legacy_gemini_delivery'); END;

CREATE TRIGGER mailbox_message_content_immutable BEFORE UPDATE ON mailbox_messages
WHEN OLD.message_id IS NOT NEW.message_id
  OR OLD.project_id IS NOT NEW.project_id
  OR OLD.sender_json IS NOT NEW.sender_json
  OR OLD.schema_version IS NOT NEW.schema_version
  OR OLD.provider IS NOT NEW.provider
  OR OLD.mode IS NOT NEW.mode
  OR OLD.priority IS NOT NEW.priority
  OR OLD.sensitivity IS NOT NEW.sensitivity
  OR OLD.created_at IS NOT NEW.created_at
  OR OLD.expires_at IS NOT NEW.expires_at
  OR OLD.prompt_sha256 IS NOT NEW.prompt_sha256
  OR OLD.approval_ref IS NOT NEW.approval_ref
  OR OLD.max_attempts IS NOT NEW.max_attempts
BEGIN SELECT RAISE(ABORT, 'immutable_mailbox_message_content'); END;

CREATE TRIGGER mailbox_messages_no_delete BEFORE DELETE ON mailbox_messages
BEGIN SELECT RAISE(ABORT, 'immutable_mailbox_message_history'); END;

CREATE TRIGGER mailbox_delivery_binding_immutable BEFORE UPDATE ON mailbox_deliveries
WHEN OLD.delivery_id IS NOT NEW.delivery_id
  OR OLD.message_id IS NOT NEW.message_id
  OR OLD.schema_version IS NOT NEW.schema_version
  OR OLD.provider IS NOT NEW.provider
  OR OLD.consumer_id IS NOT NEW.consumer_id
  OR OLD.delivery_token_hash IS NOT NEW.delivery_token_hash
  OR OLD.claimed_at IS NOT NEW.claimed_at
BEGIN SELECT RAISE(ABORT, 'immutable_mailbox_delivery_binding'); END;

CREATE TRIGGER mailbox_deliveries_no_delete BEFORE DELETE ON mailbox_deliveries
BEGIN SELECT RAISE(ABORT, 'immutable_mailbox_delivery_history'); END;

UPDATE mailbox_metadata
SET value = 'bridge-mailbox-v3'
WHERE key = 'schema_version' AND value = 'bridge-mailbox-v2';

INSERT OR REPLACE INTO mailbox_metadata(key, value)
VALUES ('web_provider', 'profile-driven-browser');

PRAGMA user_version = 3;
