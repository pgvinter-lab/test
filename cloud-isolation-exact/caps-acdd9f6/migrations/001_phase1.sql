PRAGMA foreign_keys = ON;

CREATE TABLE IF NOT EXISTS runtime_metadata (
  key TEXT PRIMARY KEY,
  value TEXT NOT NULL
) STRICT;

CREATE TABLE IF NOT EXISTS projects (
  project_id TEXT PRIMARY KEY,
  active_generation INTEGER NOT NULL CHECK (active_generation >= 1),
  next_fencing_token INTEGER NOT NULL DEFAULT 0 CHECK (next_fencing_token >= 0),
  state_revision INTEGER NOT NULL DEFAULT 0 CHECK (state_revision >= 0),
  status TEXT NOT NULL DEFAULT 'active' CHECK (status IN ('active', 'read_only', 'retired')),
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL
) STRICT;

CREATE TRIGGER IF NOT EXISTS projects_singleton_insert
BEFORE INSERT ON projects
WHEN EXISTS (SELECT 1 FROM projects)
BEGIN SELECT RAISE(ABORT, 'singleton_project_database_required'); END;

CREATE TABLE IF NOT EXISTS principals (
  principal_id TEXT PRIMARY KEY,
  kind TEXT NOT NULL CHECK (kind IN ('human', 'agent', 'service')),
  display_name TEXT NOT NULL CHECK (length(display_name) BETWEEN 1 AND 200),
  issuer TEXT NOT NULL CHECK (length(issuer) BETWEEN 1 AND 300),
  subject TEXT NOT NULL CHECK (length(subject) BETWEEN 1 AND 300),
  status TEXT NOT NULL CHECK (status IN ('active', 'disabled')),
  created_at TEXT NOT NULL,
  disabled_at TEXT,
  UNIQUE (issuer, subject)
) STRICT;

CREATE TABLE IF NOT EXISTS hosts (
  host_id TEXT PRIMARY KEY,
  instance_id TEXT NOT NULL UNIQUE,
  hostname_hash TEXT NOT NULL,
  platform TEXT NOT NULL CHECK (platform IN ('windows', 'macos', 'linux', 'cloud')),
  status TEXT NOT NULL CHECK (status IN ('active', 'retired', 'quarantined')),
  registered_at TEXT NOT NULL,
  public_key_thumbprint TEXT
) STRICT;

CREATE TABLE IF NOT EXISTS sessions (
  session_id TEXT PRIMARY KEY,
  principal_id TEXT NOT NULL REFERENCES principals(principal_id),
  host_id TEXT NOT NULL REFERENCES hosts(host_id),
  started_at TEXT NOT NULL,
  expires_at TEXT NOT NULL,
  status TEXT NOT NULL CHECK (status IN ('active', 'closed', 'revoked')),
  authentication_method TEXT NOT NULL CHECK (authentication_method IN ('local_process', 'os_user', 'oidc', 'mtls', 'service_token')),
  authentication_assurance TEXT NOT NULL CHECK (authentication_assurance IN ('unverified', 'local', 'verified', 'strong')),
  credential_ref TEXT CHECK (credential_ref IS NULL OR length(credential_ref) BETWEEN 1 AND 300),
  transport TEXT NOT NULL CHECK (transport IN ('stdio', 'streamable_http')),
  transport_session_id TEXT NOT NULL CHECK (length(transport_session_id) BETWEEN 16 AND 200),
  server_instance_id TEXT NOT NULL,
  closed_at TEXT
) STRICT;

CREATE TABLE IF NOT EXISTS project_roles (
  role_grant_id TEXT PRIMARY KEY,
  project_id TEXT NOT NULL REFERENCES projects(project_id),
  principal_id TEXT NOT NULL REFERENCES principals(principal_id),
  role TEXT NOT NULL CHECK (role IN ('owner', 'administrator', 'collaborator', 'reviewer', 'worker', 'observer')),
  status TEXT NOT NULL CHECK (status IN ('active', 'revoked')),
  granted_at TEXT NOT NULL,
  granted_by_principal_id TEXT NOT NULL REFERENCES principals(principal_id),
  granted_by_session_id TEXT NOT NULL REFERENCES sessions(session_id),
  granted_by_host_id TEXT NOT NULL REFERENCES hosts(host_id),
  granted_generation INTEGER NOT NULL CHECK (granted_generation >= 1),
  revoked_at TEXT,
  revoked_by_principal_id TEXT REFERENCES principals(principal_id),
  revoked_by_session_id TEXT REFERENCES sessions(session_id),
  revoked_by_host_id TEXT REFERENCES hosts(host_id),
  revoked_generation INTEGER CHECK (revoked_generation >= 1),
  CHECK (
    (status = 'active'
      AND revoked_at IS NULL
      AND revoked_by_principal_id IS NULL
      AND revoked_by_session_id IS NULL
      AND revoked_by_host_id IS NULL
      AND revoked_generation IS NULL)
    OR
    (status = 'revoked'
      AND revoked_at IS NOT NULL
      AND revoked_by_principal_id IS NOT NULL
      AND revoked_by_session_id IS NOT NULL
      AND revoked_by_host_id IS NOT NULL
      AND revoked_generation IS NOT NULL)
  )
) STRICT;

CREATE UNIQUE INDEX IF NOT EXISTS project_roles_one_active_grant
ON project_roles(project_id, principal_id, role)
WHERE status = 'active';

CREATE TABLE IF NOT EXISTS artifacts (
  artifact_id TEXT PRIMARY KEY,
  project_id TEXT NOT NULL REFERENCES projects(project_id),
  kind TEXT NOT NULL,
  creator_principal_id TEXT NOT NULL REFERENCES principals(principal_id),
  creator_session_id TEXT NOT NULL REFERENCES sessions(session_id),
  creator_host_id TEXT NOT NULL REFERENCES hosts(host_id),
  sensitivity TEXT NOT NULL,
  media_type TEXT NOT NULL,
  size_bytes INTEGER NOT NULL CHECK (size_bytes >= 0),
  sha256 TEXT NOT NULL,
  created_at TEXT NOT NULL,
  registered_at TEXT NOT NULL,
  document_json TEXT NOT NULL
) STRICT;

CREATE INDEX IF NOT EXISTS artifacts_project_sha256_idx
  ON artifacts(project_id, sha256);

CREATE TABLE IF NOT EXISTS artifact_parents (
  child_artifact_id TEXT NOT NULL REFERENCES artifacts(artifact_id),
  parent_artifact_id TEXT NOT NULL REFERENCES artifacts(artifact_id),
  PRIMARY KEY (child_artifact_id, parent_artifact_id),
  CHECK (child_artifact_id <> parent_artifact_id)
) STRICT;

CREATE TABLE IF NOT EXISTS citations (
  citation_id TEXT PRIMARY KEY,
  containing_artifact_id TEXT NOT NULL REFERENCES artifacts(artifact_id),
  source_artifact_id TEXT NOT NULL REFERENCES artifacts(artifact_id),
  verification_status TEXT NOT NULL,
  document_json TEXT NOT NULL
) STRICT;

CREATE TABLE IF NOT EXISTS review_jobs (
  job_id TEXT PRIMARY KEY,
  project_id TEXT NOT NULL REFERENCES projects(project_id),
  mode TEXT NOT NULL CHECK (mode IN ('collaboration', 'independent_review')),
  status TEXT NOT NULL CHECK (status IN ('queued', 'claimable', 'claimed', 'running', 'awaiting_input', 'completed', 'failed', 'cancelled')),
  requested_by_principal_id TEXT NOT NULL REFERENCES principals(principal_id),
  requested_by_session_id TEXT NOT NULL REFERENCES sessions(session_id),
  requested_by_host_id TEXT NOT NULL REFERENCES hosts(host_id),
  required_role TEXT NOT NULL CHECK (required_role IN ('collaborator', 'reviewer', 'worker')),
  instruction_set_id TEXT NOT NULL,
  instruction_version INTEGER NOT NULL CHECK (instruction_version >= 1),
  approval_policy_override_id TEXT UNIQUE
    REFERENCES approval_policy_overrides(override_id) DEFERRABLE INITIALLY DEFERRED,
  attempt INTEGER NOT NULL DEFAULT 0 CHECK (attempt >= 0),
  active_claim_id TEXT,
  active_generation INTEGER,
  active_fencing_token INTEGER,
  lease_expires_at TEXT,
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL,
  document_json TEXT NOT NULL
) STRICT;

CREATE INDEX IF NOT EXISTS review_jobs_project_status_idx
  ON review_jobs(project_id, status);

CREATE TABLE IF NOT EXISTS job_instructions (
  job_id TEXT NOT NULL REFERENCES review_jobs(job_id),
  instruction_set_id TEXT NOT NULL,
  version INTEGER NOT NULL CHECK (version >= 1),
  content_hash TEXT NOT NULL,
  text TEXT NOT NULL,
  authored_by_principal_id TEXT NOT NULL REFERENCES principals(principal_id),
  authored_by_session_id TEXT NOT NULL REFERENCES sessions(session_id),
  authored_by_host_id TEXT NOT NULL REFERENCES hosts(host_id),
  authored_at TEXT NOT NULL,
  material_amendment INTEGER NOT NULL CHECK (material_amendment IN (0, 1)),
  supersedes_version INTEGER,
  invalidated_grant_ids_json TEXT NOT NULL,
  document_json TEXT NOT NULL,
  PRIMARY KEY (job_id, version),
  UNIQUE (job_id, instruction_set_id, version)
) STRICT;

CREATE TABLE IF NOT EXISTS approval_policy_overrides (
  override_id TEXT PRIMARY KEY,
  job_id TEXT NOT NULL UNIQUE REFERENCES review_jobs(job_id),
  invoked_by_principal_id TEXT NOT NULL REFERENCES principals(principal_id),
  invoked_by_session_id TEXT NOT NULL REFERENCES sessions(session_id),
  invoked_by_host_id TEXT NOT NULL REFERENCES hosts(host_id),
  invoked_at TEXT NOT NULL,
  document_json TEXT NOT NULL CHECK (json_valid(document_json))
) STRICT;

CREATE TABLE IF NOT EXISTS job_claims (
  claim_id TEXT PRIMARY KEY,
  job_id TEXT NOT NULL REFERENCES review_jobs(job_id),
  attempt INTEGER NOT NULL CHECK (attempt >= 1),
  claimed_by_principal_id TEXT NOT NULL REFERENCES principals(principal_id),
  claimed_by_session_id TEXT NOT NULL REFERENCES sessions(session_id),
  claimed_by_host_id TEXT NOT NULL REFERENCES hosts(host_id),
  generation INTEGER NOT NULL CHECK (generation >= 1),
  fencing_token INTEGER NOT NULL CHECK (fencing_token >= 1),
  idempotency_key TEXT NOT NULL,
  claimed_at TEXT NOT NULL,
  lease_expires_at TEXT NOT NULL,
  status TEXT NOT NULL CHECK (status IN ('active', 'expired', 'released', 'completed', 'failed', 'cancelled')),
  ended_at TEXT,
  UNIQUE (job_id, attempt),
  UNIQUE (job_id, fencing_token)
) STRICT;

CREATE TABLE IF NOT EXISTS job_inputs (
  job_id TEXT NOT NULL REFERENCES review_jobs(job_id),
  instruction_version INTEGER NOT NULL,
  artifact_id TEXT NOT NULL REFERENCES artifacts(artifact_id),
  attached_at TEXT NOT NULL,
  attached_by_principal_id TEXT NOT NULL REFERENCES principals(principal_id),
  PRIMARY KEY (job_id, instruction_version, artifact_id)
) STRICT;

CREATE TABLE IF NOT EXISTS approval_grants (
  grant_id TEXT PRIMARY KEY,
  project_id TEXT NOT NULL REFERENCES projects(project_id),
  job_id TEXT NOT NULL REFERENCES review_jobs(job_id),
  status TEXT NOT NULL CHECK (status IN ('active', 'revoked', 'exhausted', 'expired')),
  granted_to_principal_id TEXT NOT NULL REFERENCES principals(principal_id),
  claim_id TEXT NOT NULL REFERENCES job_claims(claim_id),
  instruction_version INTEGER NOT NULL,
  uses_consumed INTEGER NOT NULL CHECK (uses_consumed >= 0),
  expires_at TEXT NOT NULL,
  document_json TEXT NOT NULL,
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL
) STRICT;

CREATE INDEX IF NOT EXISTS approval_grants_job_status_idx
  ON approval_grants(job_id, status);

CREATE TABLE IF NOT EXISTS adapter_action_authorizations (
  action_id TEXT PRIMARY KEY,
  project_id TEXT NOT NULL REFERENCES projects(project_id),
  job_id TEXT NOT NULL REFERENCES review_jobs(job_id),
  approval_grant_id TEXT NOT NULL REFERENCES approval_grants(grant_id),
  principal_id TEXT NOT NULL REFERENCES principals(principal_id),
  session_id TEXT NOT NULL REFERENCES sessions(session_id),
  host_id TEXT NOT NULL REFERENCES hosts(host_id),
  claim_id TEXT NOT NULL REFERENCES job_claims(claim_id),
  generation INTEGER NOT NULL CHECK (generation >= 1),
  fencing_token INTEGER NOT NULL CHECK (fencing_token >= 1),
  adapter_id TEXT NOT NULL,
  adapter_version TEXT NOT NULL,
  operation TEXT NOT NULL,
  side_effect_class TEXT NOT NULL,
  origin TEXT NOT NULL,
  destination TEXT NOT NULL,
  condition_hash TEXT NOT NULL,
  request_hash TEXT NOT NULL,
  input_artifact_ids_json TEXT NOT NULL CHECK (json_valid(input_artifact_ids_json)),
  sensitive_external INTEGER NOT NULL CHECK (sensitive_external IN (0, 1)),
  approval_prompt_class TEXT,
  status TEXT NOT NULL CHECK (status IN ('authorized', 'consumed', 'revoked')),
  authorized_at TEXT NOT NULL,
  expires_at TEXT NOT NULL,
  consumed_at TEXT
) STRICT;

CREATE TABLE IF NOT EXISTS adapter_registry (
  adapter_id TEXT PRIMARY KEY,
  active_version TEXT NOT NULL,
  registered_at TEXT NOT NULL,
  updated_at TEXT NOT NULL
) STRICT;

CREATE TABLE IF NOT EXISTS adapter_manifests (
  adapter_id TEXT NOT NULL REFERENCES adapter_registry(adapter_id),
  adapter_version TEXT NOT NULL,
  interface_version TEXT NOT NULL,
  kind TEXT NOT NULL,
  credential_mode TEXT NOT NULL,
  health_state TEXT NOT NULL,
  manifest_json TEXT NOT NULL,
  registered_at TEXT NOT NULL,
  PRIMARY KEY (adapter_id, adapter_version)
) STRICT;

CREATE TABLE IF NOT EXISTS adapter_invocations (
  operation_id TEXT PRIMARY KEY,
  project_id TEXT NOT NULL REFERENCES projects(project_id),
  job_id TEXT NOT NULL REFERENCES review_jobs(job_id),
  adapter_id TEXT NOT NULL REFERENCES adapter_registry(adapter_id),
  adapter_version TEXT NOT NULL,
  operation TEXT NOT NULL,
  principal_id TEXT NOT NULL REFERENCES principals(principal_id),
  session_id TEXT NOT NULL REFERENCES sessions(session_id),
  host_id TEXT NOT NULL REFERENCES hosts(host_id),
  claim_id TEXT NOT NULL REFERENCES job_claims(claim_id),
  generation INTEGER NOT NULL CHECK (generation >= 1),
  fencing_token INTEGER NOT NULL CHECK (fencing_token >= 1),
  authorization_action_id TEXT UNIQUE REFERENCES adapter_action_authorizations(action_id),
  idempotency_key TEXT NOT NULL,
  request_hash TEXT NOT NULL,
  status TEXT NOT NULL CHECK (status IN ('started', 'completed', 'failed')),
  response_json TEXT,
  error_code TEXT,
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL,
  FOREIGN KEY (adapter_id, adapter_version) REFERENCES adapter_manifests(adapter_id, adapter_version),
  UNIQUE (project_id, principal_id, adapter_id, operation, idempotency_key)
) STRICT;

CREATE TABLE IF NOT EXISTS idempotency_records (
  project_id TEXT NOT NULL REFERENCES projects(project_id),
  principal_id TEXT NOT NULL REFERENCES principals(principal_id),
  session_id TEXT NOT NULL REFERENCES sessions(session_id),
  host_id TEXT NOT NULL REFERENCES hosts(host_id),
  generation INTEGER NOT NULL CHECK (generation >= 1),
  operation TEXT NOT NULL,
  idempotency_key TEXT NOT NULL,
  request_hash TEXT NOT NULL,
  response_json TEXT NOT NULL,
  created_at TEXT NOT NULL,
  PRIMARY KEY (project_id, principal_id, operation, idempotency_key)
) STRICT;

CREATE TABLE IF NOT EXISTS events (
  project_id TEXT NOT NULL REFERENCES projects(project_id),
  sequence INTEGER NOT NULL CHECK (sequence >= 1),
  event_id TEXT NOT NULL UNIQUE,
  generation INTEGER NOT NULL CHECK (generation >= 1),
  event_type TEXT NOT NULL,
  aggregate_type TEXT NOT NULL,
  aggregate_id TEXT NOT NULL,
  occurred_at TEXT NOT NULL,
  previous_hash TEXT,
  hash TEXT NOT NULL,
  envelope_json TEXT NOT NULL,
  PRIMARY KEY (project_id, sequence)
) STRICT;

CREATE TABLE IF NOT EXISTS audit_mirror_entries (
  project_id TEXT NOT NULL REFERENCES projects(project_id),
  mirror_sequence INTEGER NOT NULL CHECK (mirror_sequence >= 1),
  event_id TEXT NOT NULL UNIQUE REFERENCES events(event_id),
  mirrored_at TEXT NOT NULL,
  previous_mirror_hash TEXT,
  mirror_hash TEXT NOT NULL,
  entry_json TEXT NOT NULL,
  file_appended INTEGER NOT NULL DEFAULT 0 CHECK (file_appended IN (0, 1)),
  PRIMARY KEY (project_id, mirror_sequence),
  UNIQUE (mirror_sequence)
) STRICT;

CREATE TABLE IF NOT EXISTS backup_manifests (
  backup_id TEXT PRIMARY KEY,
  project_id TEXT NOT NULL REFERENCES projects(project_id),
  generation INTEGER NOT NULL,
  event_sequence INTEGER NOT NULL,
  created_at TEXT NOT NULL,
  manifest_json TEXT NOT NULL
) STRICT;

CREATE TABLE IF NOT EXISTS restore_manifests (
  restore_id TEXT PRIMARY KEY,
  backup_id TEXT NOT NULL,
  project_id TEXT NOT NULL,
  requested_at TEXT NOT NULL,
  status TEXT NOT NULL,
  manifest_json TEXT NOT NULL
) STRICT;

CREATE TABLE IF NOT EXISTS generation_takeovers (
  takeover_id TEXT PRIMARY KEY,
  project_id TEXT NOT NULL REFERENCES projects(project_id),
  from_generation INTEGER NOT NULL,
  to_generation INTEGER NOT NULL,
  approval_ref TEXT NOT NULL UNIQUE,
  approved_by_principal_id TEXT NOT NULL REFERENCES principals(principal_id),
  approved_by_session_id TEXT NOT NULL REFERENCES sessions(session_id),
  approved_by_host_id TEXT NOT NULL REFERENCES hosts(host_id),
  target_host_id TEXT NOT NULL REFERENCES hosts(host_id),
  restore_id TEXT REFERENCES restore_manifests(restore_id),
  takeover_class TEXT NOT NULL DEFAULT 'forced' CHECK (takeover_class IN ('forced', 'restore_activation')),
  reason TEXT NOT NULL,
  occurred_at TEXT NOT NULL,
  CHECK (to_generation > from_generation)
) STRICT;

CREATE TABLE IF NOT EXISTS runtime_operation_reports (
  report_id TEXT PRIMARY KEY,
  project_id TEXT NOT NULL REFERENCES projects(project_id),
  operation TEXT NOT NULL,
  principal_id TEXT NOT NULL REFERENCES principals(principal_id),
  session_id TEXT NOT NULL REFERENCES sessions(session_id),
  host_id TEXT NOT NULL REFERENCES hosts(host_id),
  generation INTEGER NOT NULL CHECK (generation >= 1),
  occurred_at TEXT NOT NULL,
  report_json TEXT NOT NULL CHECK (json_valid(report_json))
) STRICT;

CREATE TRIGGER IF NOT EXISTS events_no_update
BEFORE UPDATE ON events BEGIN SELECT RAISE(ABORT, 'immutable_event_journal'); END;
CREATE TRIGGER IF NOT EXISTS events_no_delete
BEFORE DELETE ON events BEGIN SELECT RAISE(ABORT, 'immutable_event_journal'); END;
CREATE TRIGGER IF NOT EXISTS idempotency_records_no_update
BEFORE UPDATE ON idempotency_records BEGIN SELECT RAISE(ABORT, 'immutable_idempotency_record'); END;
CREATE TRIGGER IF NOT EXISTS idempotency_records_no_delete
BEFORE DELETE ON idempotency_records BEGIN SELECT RAISE(ABORT, 'immutable_idempotency_record'); END;
CREATE TRIGGER IF NOT EXISTS generation_takeovers_no_update
BEFORE UPDATE ON generation_takeovers BEGIN SELECT RAISE(ABORT, 'immutable_generation_takeover'); END;
CREATE TRIGGER IF NOT EXISTS generation_takeovers_no_delete
BEFORE DELETE ON generation_takeovers BEGIN SELECT RAISE(ABORT, 'immutable_generation_takeover'); END;
CREATE TRIGGER IF NOT EXISTS runtime_operation_reports_no_update
BEFORE UPDATE ON runtime_operation_reports BEGIN SELECT RAISE(ABORT, 'immutable_runtime_operation_report'); END;
CREATE TRIGGER IF NOT EXISTS runtime_operation_reports_no_delete
BEFORE DELETE ON runtime_operation_reports BEGIN SELECT RAISE(ABORT, 'immutable_runtime_operation_report'); END;
CREATE TRIGGER IF NOT EXISTS runtime_operation_reports_binding_valid_insert
BEFORE INSERT ON runtime_operation_reports
WHEN json_valid(NEW.report_json) = 0
  OR COALESCE(json_extract(NEW.report_json, '$.reportId'), '') <> NEW.report_id
  OR COALESCE(json_extract(NEW.report_json, '$.projectId'), '') <> NEW.project_id
  OR COALESCE(json_extract(NEW.report_json, '$.operation'), '') <> NEW.operation
  OR COALESCE(json_extract(NEW.report_json, '$.actor.principalId'), '') <> NEW.principal_id
  OR COALESCE(json_extract(NEW.report_json, '$.actor.sessionId'), '') <> NEW.session_id
  OR COALESCE(json_extract(NEW.report_json, '$.actor.hostId'), '') <> NEW.host_id
  OR COALESCE(json_extract(NEW.report_json, '$.generation'), -1) <> NEW.generation
  OR COALESCE(json_extract(NEW.report_json, '$.acceptedAt'), '') <> NEW.occurred_at
BEGIN SELECT RAISE(ABORT, 'invalid_runtime_operation_report_binding'); END;
CREATE TRIGGER IF NOT EXISTS project_roles_revoke_only
BEFORE UPDATE ON project_roles
WHEN OLD.status <> 'active'
  OR NEW.status <> 'revoked'
  OR OLD.role_grant_id IS NOT NEW.role_grant_id
  OR OLD.project_id IS NOT NEW.project_id
  OR OLD.principal_id IS NOT NEW.principal_id
  OR OLD.role IS NOT NEW.role
  OR OLD.granted_at IS NOT NEW.granted_at
  OR OLD.granted_by_principal_id IS NOT NEW.granted_by_principal_id
  OR OLD.granted_by_session_id IS NOT NEW.granted_by_session_id
  OR OLD.granted_by_host_id IS NOT NEW.granted_by_host_id
  OR OLD.granted_generation IS NOT NEW.granted_generation
  OR OLD.revoked_at IS NOT NULL
  OR OLD.revoked_by_principal_id IS NOT NULL
  OR OLD.revoked_by_session_id IS NOT NULL
  OR OLD.revoked_by_host_id IS NOT NULL
  OR OLD.revoked_generation IS NOT NULL
  OR NEW.revoked_at IS NULL
  OR NEW.revoked_by_principal_id IS NULL
  OR NEW.revoked_by_session_id IS NULL
  OR NEW.revoked_by_host_id IS NULL
  OR NEW.revoked_generation IS NULL
BEGIN SELECT RAISE(ABORT, 'project_role_history_immutable'); END;
CREATE TRIGGER IF NOT EXISTS project_roles_no_delete
BEFORE DELETE ON project_roles BEGIN SELECT RAISE(ABORT, 'project_role_history_immutable'); END;
CREATE TRIGGER IF NOT EXISTS audit_no_update
BEFORE UPDATE OF project_id, mirror_sequence, event_id, mirrored_at, previous_mirror_hash, mirror_hash, entry_json
ON audit_mirror_entries BEGIN SELECT RAISE(ABORT, 'immutable_audit_mirror'); END;
CREATE TRIGGER IF NOT EXISTS audit_no_delete
BEFORE DELETE ON audit_mirror_entries BEGIN SELECT RAISE(ABORT, 'immutable_audit_mirror'); END;
CREATE TRIGGER IF NOT EXISTS artifacts_no_update
BEFORE UPDATE ON artifacts BEGIN SELECT RAISE(ABORT, 'immutable_artifact'); END;
CREATE TRIGGER IF NOT EXISTS artifacts_no_delete
BEFORE DELETE ON artifacts BEGIN SELECT RAISE(ABORT, 'immutable_artifact'); END;
CREATE TRIGGER IF NOT EXISTS artifact_parents_no_update
BEFORE UPDATE ON artifact_parents BEGIN SELECT RAISE(ABORT, 'immutable_artifact_provenance'); END;
CREATE TRIGGER IF NOT EXISTS artifact_parents_no_delete
BEFORE DELETE ON artifact_parents BEGIN SELECT RAISE(ABORT, 'immutable_artifact_provenance'); END;
CREATE TRIGGER IF NOT EXISTS citations_no_update
BEFORE UPDATE ON citations BEGIN SELECT RAISE(ABORT, 'immutable_citation'); END;
CREATE TRIGGER IF NOT EXISTS citations_no_delete
BEFORE DELETE ON citations BEGIN SELECT RAISE(ABORT, 'immutable_citation'); END;
CREATE TRIGGER IF NOT EXISTS instructions_no_update
BEFORE UPDATE ON job_instructions BEGIN SELECT RAISE(ABORT, 'immutable_instruction_version'); END;
CREATE TRIGGER IF NOT EXISTS instructions_no_delete
BEFORE DELETE ON job_instructions BEGIN SELECT RAISE(ABORT, 'immutable_instruction_version'); END;
CREATE TRIGGER IF NOT EXISTS overrides_no_update
BEFORE UPDATE ON approval_policy_overrides BEGIN SELECT RAISE(ABORT, 'immutable_approval_policy_override'); END;
CREATE TRIGGER IF NOT EXISTS overrides_no_delete
BEFORE DELETE ON approval_policy_overrides BEGIN SELECT RAISE(ABORT, 'immutable_approval_policy_override'); END;
CREATE TRIGGER IF NOT EXISTS override_security_bindings_valid_insert
BEFORE INSERT ON approval_policy_overrides
WHEN json_valid(NEW.document_json) = 0
  OR COALESCE(json_extract(NEW.document_json, '$.overrideId'), '') <> NEW.override_id
  OR COALESCE(json_extract(NEW.document_json, '$.scope.jobId'), '') <> NEW.job_id
  OR COALESCE(json_extract(NEW.document_json, '$.invokedBy.principalId'), '') <> NEW.invoked_by_principal_id
  OR COALESCE(json_extract(NEW.document_json, '$.invokedBy.sessionId'), '') <> NEW.invoked_by_session_id
  OR COALESCE(json_extract(NEW.document_json, '$.invokedBy.hostId'), '') <> NEW.invoked_by_host_id
  OR COALESCE(json_extract(NEW.document_json, '$.invokedAt'), '') <> NEW.invoked_at
  OR NOT EXISTS (
    SELECT 1 FROM review_jobs j
    WHERE j.job_id = NEW.job_id
      AND j.approval_policy_override_id = NEW.override_id
      AND j.requested_by_principal_id = NEW.invoked_by_principal_id
      AND j.requested_by_session_id = NEW.invoked_by_session_id
      AND j.requested_by_host_id = NEW.invoked_by_host_id
  )
  OR NOT EXISTS (
    SELECT 1 FROM review_jobs j
    JOIN project_roles pr ON pr.project_id = j.project_id
      AND pr.principal_id = NEW.invoked_by_principal_id
      AND pr.role = 'owner'
      AND pr.status = 'active'
    WHERE j.job_id = NEW.job_id
  )
BEGIN SELECT RAISE(ABORT, 'invalid_approval_policy_override_binding'); END;
CREATE TRIGGER IF NOT EXISTS job_override_no_change
BEFORE UPDATE ON review_jobs
WHEN COALESCE(OLD.approval_policy_override_id, '') <> COALESCE(NEW.approval_policy_override_id, '')
BEGIN SELECT RAISE(ABORT, 'immutable_approval_policy_override'); END;
CREATE TRIGGER IF NOT EXISTS job_security_bindings_valid_insert
BEFORE INSERT ON review_jobs
WHEN json_valid(NEW.document_json) = 0
  OR json_extract(NEW.document_json, '$.jobId') <> NEW.job_id
  OR json_extract(NEW.document_json, '$.projectId') <> NEW.project_id
  OR json_extract(NEW.document_json, '$.requestedBy.principalId') <> NEW.requested_by_principal_id
  OR json_extract(NEW.document_json, '$.requestedBy.sessionId') <> NEW.requested_by_session_id
  OR json_extract(NEW.document_json, '$.requestedBy.hostId') <> NEW.requested_by_host_id
  OR json_extract(NEW.document_json, '$.requiredRole') <> NEW.required_role
  OR COALESCE(json_extract(NEW.document_json, '$.approvalPolicyOverride.overrideId'), '') <> COALESCE(NEW.approval_policy_override_id, '')
BEGIN SELECT RAISE(ABORT, 'invalid_job_security_binding'); END;
CREATE TRIGGER IF NOT EXISTS job_security_bindings_no_change
BEFORE UPDATE ON review_jobs
WHEN json_extract(OLD.document_json, '$.jobId') <> json_extract(NEW.document_json, '$.jobId')
  OR json_extract(OLD.document_json, '$.projectId') <> json_extract(NEW.document_json, '$.projectId')
  OR json_extract(OLD.document_json, '$.requestedBy.principalId') <> json_extract(NEW.document_json, '$.requestedBy.principalId')
  OR json_extract(OLD.document_json, '$.requestedBy.sessionId') <> json_extract(NEW.document_json, '$.requestedBy.sessionId')
  OR json_extract(OLD.document_json, '$.requestedBy.hostId') <> json_extract(NEW.document_json, '$.requestedBy.hostId')
  OR json_extract(OLD.document_json, '$.requiredRole') <> json_extract(NEW.document_json, '$.requiredRole')
  OR COALESCE(json_extract(OLD.document_json, '$.approvalPolicyOverride.overrideId'), '') <> COALESCE(json_extract(NEW.document_json, '$.approvalPolicyOverride.overrideId'), '')
  OR COALESCE(json_extract(NEW.document_json, '$.approvalPolicyOverride.overrideId'), '') <> COALESCE(NEW.approval_policy_override_id, '')
BEGIN SELECT RAISE(ABORT, 'immutable_job_security_binding'); END;
CREATE TRIGGER IF NOT EXISTS adapter_action_authorizations_no_rebind
BEFORE UPDATE OF action_id, project_id, job_id, approval_grant_id, principal_id, session_id, host_id,
  claim_id, generation, fencing_token, adapter_id, adapter_version, operation, side_effect_class,
  origin, destination, condition_hash, request_hash, input_artifact_ids_json, sensitive_external,
  approval_prompt_class, authorized_at, expires_at
ON adapter_action_authorizations
BEGIN SELECT RAISE(ABORT, 'immutable_adapter_action_authorization'); END;
CREATE TRIGGER IF NOT EXISTS adapter_action_authorizations_no_delete
BEFORE DELETE ON adapter_action_authorizations
BEGIN SELECT RAISE(ABORT, 'immutable_adapter_action_authorization'); END;
CREATE TRIGGER IF NOT EXISTS adapter_invocations_attribution_immutable
BEFORE UPDATE ON adapter_invocations
WHEN OLD.project_id <> NEW.project_id
  OR OLD.job_id <> NEW.job_id
  OR OLD.adapter_id <> NEW.adapter_id
  OR OLD.adapter_version <> NEW.adapter_version
  OR OLD.operation <> NEW.operation
  OR OLD.principal_id <> NEW.principal_id
  OR OLD.session_id <> NEW.session_id
  OR OLD.host_id <> NEW.host_id
  OR OLD.claim_id <> NEW.claim_id
  OR OLD.generation <> NEW.generation
  OR OLD.fencing_token <> NEW.fencing_token
  OR COALESCE(OLD.authorization_action_id, '') <> COALESCE(NEW.authorization_action_id, '')
  OR OLD.idempotency_key <> NEW.idempotency_key
  OR OLD.request_hash <> NEW.request_hash
  OR OLD.created_at <> NEW.created_at
BEGIN SELECT RAISE(ABORT, 'adapter_invocation_attribution_immutable'); END;
CREATE TRIGGER IF NOT EXISTS adapter_invocations_terminal
BEFORE UPDATE ON adapter_invocations
WHEN OLD.status IN ('completed', 'failed')
  OR NEW.status NOT IN ('completed', 'failed')
BEGIN SELECT RAISE(ABORT, 'adapter_invocation_terminal'); END;
CREATE TRIGGER IF NOT EXISTS adapter_invocations_no_delete
BEFORE DELETE ON adapter_invocations
BEGIN SELECT RAISE(ABORT, 'adapter_invocation_history_immutable'); END;
CREATE TRIGGER IF NOT EXISTS adapter_manifests_no_update
BEFORE UPDATE ON adapter_manifests BEGIN SELECT RAISE(ABORT, 'immutable_adapter_manifest'); END;
CREATE TRIGGER IF NOT EXISTS adapter_manifests_no_delete
BEFORE DELETE ON adapter_manifests BEGIN SELECT RAISE(ABORT, 'immutable_adapter_manifest'); END;
CREATE TRIGGER IF NOT EXISTS backup_manifests_no_update
BEFORE UPDATE ON backup_manifests BEGIN SELECT RAISE(ABORT, 'immutable_backup_manifest'); END;
CREATE TRIGGER IF NOT EXISTS backup_manifests_no_delete
BEFORE DELETE ON backup_manifests BEGIN SELECT RAISE(ABORT, 'immutable_backup_manifest'); END;
CREATE TRIGGER IF NOT EXISTS restore_manifests_no_update
BEFORE UPDATE ON restore_manifests BEGIN SELECT RAISE(ABORT, 'immutable_restore_manifest'); END;
CREATE TRIGGER IF NOT EXISTS restore_manifests_no_delete
BEFORE DELETE ON restore_manifests BEGIN SELECT RAISE(ABORT, 'immutable_restore_manifest'); END;

INSERT OR IGNORE INTO runtime_metadata(key, value) VALUES ('contract_version', '0.1.0-draft.3');
INSERT OR IGNORE INTO runtime_metadata(key, value) VALUES ('event_hash_algorithm', 'sha256-bridge-cjson-v1');
INSERT OR IGNORE INTO runtime_metadata(key, value) VALUES ('audit_hash_algorithm', 'sha256-bridge-audit-cjson-v1');
