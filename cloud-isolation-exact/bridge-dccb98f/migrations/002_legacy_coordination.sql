CREATE TABLE IF NOT EXISTS legacy_project_bindings (
  project_id TEXT PRIMARY KEY REFERENCES projects(project_id),
  project_name TEXT NOT NULL CHECK (length(project_name) BETWEEN 1 AND 300),
  project_path TEXT NOT NULL CHECK (length(project_path) BETWEEN 1 AND 2000),
  project_path_key TEXT NOT NULL UNIQUE CHECK (length(project_path_key) BETWEEN 1 AND 2000),
  remote TEXT,
  registered_at TEXT NOT NULL,
  updated_at TEXT NOT NULL
) STRICT;

CREATE TABLE IF NOT EXISTS legacy_collaboration_sessions (
  collaboration_session_id TEXT PRIMARY KEY,
  project_id TEXT NOT NULL REFERENCES projects(project_id),
  boss_agent TEXT NOT NULL CHECK (length(boss_agent) BETWEEN 1 AND 100),
  boss_set_by TEXT NOT NULL CHECK (boss_set_by IN ('first-command', 'user')),
  status TEXT NOT NULL CHECK (status IN ('active', 'closed')),
  started_at TEXT NOT NULL,
  last_activity_at TEXT NOT NULL,
  closed_at TEXT,
  closed_by_agent TEXT,
  CHECK (
    (status = 'active' AND closed_at IS NULL AND closed_by_agent IS NULL)
    OR
    (status = 'closed' AND closed_at IS NOT NULL AND closed_by_agent IS NOT NULL)
  )
) STRICT;

CREATE UNIQUE INDEX IF NOT EXISTS legacy_one_active_collaboration_session
ON legacy_collaboration_sessions(project_id)
WHERE status = 'active';

CREATE TABLE IF NOT EXISTS legacy_control (
  project_id TEXT PRIMARY KEY REFERENCES projects(project_id),
  control_agent TEXT,
  updated_at TEXT NOT NULL,
  updated_by_principal_id TEXT NOT NULL REFERENCES principals(principal_id),
  updated_by_session_id TEXT NOT NULL REFERENCES sessions(session_id),
  updated_by_host_id TEXT NOT NULL REFERENCES hosts(host_id)
) STRICT;

CREATE TABLE IF NOT EXISTS legacy_file_leases (
  lease_id TEXT PRIMARY KEY,
  claim_group_id TEXT NOT NULL,
  project_id TEXT NOT NULL REFERENCES projects(project_id),
  path TEXT NOT NULL CHECK (length(path) BETWEEN 1 AND 2000),
  path_key TEXT NOT NULL CHECK (length(path_key) BETWEEN 1 AND 2000),
  agent TEXT NOT NULL CHECK (length(agent) BETWEEN 1 AND 100),
  principal_id TEXT NOT NULL REFERENCES principals(principal_id),
  session_id TEXT NOT NULL REFERENCES sessions(session_id),
  host_id TEXT NOT NULL REFERENCES hosts(host_id),
  generation INTEGER NOT NULL CHECK (generation >= 1),
  fencing_token INTEGER NOT NULL CHECK (fencing_token >= 1),
  claimed_at TEXT NOT NULL,
  expires_at TEXT NOT NULL,
  status TEXT NOT NULL CHECK (status IN ('active', 'released', 'expired')),
  note TEXT,
  ended_at TEXT
) STRICT;

CREATE INDEX IF NOT EXISTS legacy_file_leases_active_project_idx
ON legacy_file_leases(project_id, status, expires_at);

CREATE UNIQUE INDEX IF NOT EXISTS legacy_file_lease_active_session_path
ON legacy_file_leases(project_id, session_id, path_key)
WHERE status = 'active';

CREATE TABLE IF NOT EXISTS legacy_sync_cursors (
  project_id TEXT NOT NULL REFERENCES projects(project_id),
  principal_id TEXT NOT NULL REFERENCES principals(principal_id),
  session_id TEXT NOT NULL REFERENCES sessions(session_id),
  host_id TEXT NOT NULL REFERENCES hosts(host_id),
  event_sequence INTEGER NOT NULL CHECK (event_sequence >= 0),
  filesystem_observed_at_ms INTEGER NOT NULL CHECK (filesystem_observed_at_ms >= 0),
  updated_at TEXT NOT NULL,
  PRIMARY KEY (project_id, session_id)
) STRICT;

CREATE TABLE IF NOT EXISTS legacy_tasks (
  task_id TEXT PRIMARY KEY,
  project_id TEXT NOT NULL REFERENCES projects(project_id),
  title TEXT NOT NULL CHECK (length(title) BETWEEN 1 AND 16000),
  status TEXT NOT NULL CHECK (status IN ('todo', 'doing', 'done')),
  owner_agent TEXT,
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL
) STRICT;

CREATE INDEX IF NOT EXISTS legacy_tasks_project_status_idx
ON legacy_tasks(project_id, status, created_at, task_id);

CREATE TABLE IF NOT EXISTS legacy_imports (
  import_id TEXT PRIMARY KEY,
  project_id TEXT NOT NULL REFERENCES projects(project_id),
  source_kind TEXT NOT NULL,
  source_hash TEXT NOT NULL,
  imported_at TEXT NOT NULL,
  imported_by_principal_id TEXT NOT NULL REFERENCES principals(principal_id),
  imported_by_session_id TEXT NOT NULL REFERENCES sessions(session_id),
  imported_by_host_id TEXT NOT NULL REFERENCES hosts(host_id),
  details_json TEXT NOT NULL CHECK (json_valid(details_json)),
  UNIQUE (project_id, source_kind, source_hash)
) STRICT;

CREATE TRIGGER IF NOT EXISTS legacy_file_lease_terminal_only
BEFORE UPDATE ON legacy_file_leases
WHEN OLD.status <> 'active'
  OR NEW.status NOT IN ('released', 'expired')
  OR OLD.lease_id IS NOT NEW.lease_id
  OR OLD.claim_group_id IS NOT NEW.claim_group_id
  OR OLD.project_id IS NOT NEW.project_id
  OR OLD.path IS NOT NEW.path
  OR OLD.path_key IS NOT NEW.path_key
  OR OLD.agent IS NOT NEW.agent
  OR OLD.principal_id IS NOT NEW.principal_id
  OR OLD.session_id IS NOT NEW.session_id
  OR OLD.host_id IS NOT NEW.host_id
  OR OLD.generation IS NOT NEW.generation
  OR OLD.fencing_token IS NOT NEW.fencing_token
  OR OLD.claimed_at IS NOT NEW.claimed_at
  OR OLD.expires_at IS NOT NEW.expires_at
  OR OLD.note IS NOT NEW.note
  OR OLD.ended_at IS NOT NULL
  OR NEW.ended_at IS NULL
BEGIN SELECT RAISE(ABORT, 'legacy_file_lease_history_immutable'); END;

CREATE TRIGGER IF NOT EXISTS legacy_file_leases_no_delete
BEFORE DELETE ON legacy_file_leases
BEGIN SELECT RAISE(ABORT, 'legacy_file_lease_history_immutable'); END;

CREATE TRIGGER IF NOT EXISTS legacy_imports_no_update
BEFORE UPDATE ON legacy_imports
BEGIN SELECT RAISE(ABORT, 'legacy_import_history_immutable'); END;

CREATE TRIGGER IF NOT EXISTS legacy_imports_no_delete
BEFORE DELETE ON legacy_imports
BEGIN SELECT RAISE(ABORT, 'legacy_import_history_immutable'); END;
