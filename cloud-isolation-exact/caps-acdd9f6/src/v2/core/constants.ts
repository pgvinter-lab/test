export const CONTRACT_VERSION = "0.1.0-draft.4" as const;
export const EVENT_HASH_ALGORITHM = "sha256-bridge-cjson-v1" as const;
export const AUDIT_HASH_ALGORITHM = "sha256-bridge-audit-cjson-v1" as const;
export const EXCLUDED_AUDIT_CONTENT = [
  "browser_state",
  "credentials",
  "raw_artifact_contents",
  "secrets",
] as const;
export const OVERRIDDEN_RULES = ["M-3", "L-4"] as const;
export const PRESERVED_OVERRIDE_CONTROLS = [
  "principal_role_authorization",
  "claim_generation_fencing",
  "adapter_allowlists",
  "credential_isolation",
  "unrelated_security_controls",
] as const;

export const TERMINAL_JOB_STATES = ["completed", "failed", "cancelled"] as const;

export type JobStatus =
  | "queued"
  | "claimable"
  | "claimed"
  | "running"
  | "awaiting_input"
  | "completed"
  | "failed"
  | "cancelled";

export type ProjectRole =
  | "owner"
  | "administrator"
  | "collaborator"
  | "reviewer"
  | "worker"
  | "observer";

export type RequiredJobRole = "collaborator" | "reviewer" | "worker";
export type SideEffectClass =
  | "read_only"
  | "local_write"
  | "external_reversible"
  | "external_irreversible";
