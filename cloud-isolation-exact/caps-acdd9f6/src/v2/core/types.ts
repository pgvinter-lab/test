import type { JobStatus, ProjectRole, RequiredJobRole, SideEffectClass } from "./constants.js";

export interface PrincipalRef {
  principalId: string;
  sessionId: string;
  hostId: string;
}

export interface PrincipalRecord {
  principalId: string;
  kind: "human" | "agent" | "service";
  displayName: string;
  issuer: string;
  subject: string;
  status: "active" | "disabled";
  createdAt: string;
  disabledAt?: string;
}

export interface HostRecord {
  hostId: string;
  instanceId: string;
  hostnameHash: string;
  platform: "windows" | "macos" | "linux" | "cloud";
  status: "active" | "retired" | "quarantined";
  registeredAt: string;
  publicKeyThumbprint?: string;
}

export interface SessionRecord {
  sessionId: string;
  principalId: string;
  hostId: string;
  startedAt: string;
  expiresAt: string;
  status: "active" | "closed" | "revoked";
  authentication: {
    method: "local_process" | "os_user" | "oidc" | "mtls" | "service_token";
    assurance: "unverified" | "local" | "verified" | "strong";
    credentialRef?: string;
  };
  transportBinding: {
    transport: "stdio" | "streamable_http";
    transportSessionId: string;
    serverInstanceId: string;
  };
}

export interface InstructionSet {
  instructionSetId: string;
  version: number;
  text: string;
  contentHash: string;
  authoredBy: PrincipalRef;
  authoredAt: string;
  materialAmendment: boolean;
  supersedesVersion?: number;
  invalidatesApprovalGrantIds: string[];
}

export interface ApprovalPolicyOverride {
  overrideId: string;
  invokedBy: PrincipalRef;
  invokedAt: string;
  reason: string;
  scope: { jobId: string; overriddenRules: ["M-3", "L-4"] };
  immutableAfterCreation: true;
  nonRetroactive: true;
  preservedControls: [
    "principal_role_authorization",
    "claim_generation_fencing",
    "adapter_allowlists",
    "credential_isolation",
    "unrelated_security_controls",
  ];
}

export interface JobClaim {
  claimId: string;
  claimedBy: PrincipalRef;
  generation: number;
  fencingToken: number;
  idempotencyKey: string;
  claimedAt: string;
  leaseExpiresAt: string;
}

export interface Citation {
  citationId: string;
  sourceArtifactId: string;
  locator: { type: "line" | "page" | "section" | "timestamp" | "uri" | "record"; value: string };
  claim: string;
  quoteHash?: string;
  verification: {
    status: "unverified" | "verified" | "contradicted" | "inconclusive";
    method: string;
    verifiedBy?: PrincipalRef;
    verifiedAt?: string;
  };
}

export interface Disagreement {
  disagreementId: string;
  position: string;
  disposition: "accepted" | "rejected" | "unresolved" | "owner_decision_required";
  reason: string;
  raisedBy?: PrincipalRef;
  relatedArtifactIds?: string[];
}

export interface ArtifactRecord {
  schemaVersion: "0.1.0-draft.4";
  artifactId: string;
  projectId: string;
  kind: "source" | "source_code" | "prompt" | "response" | "review" | "decision" | "report" | "attachment" | "backup";
  createdAt: string;
  createdBy: PrincipalRef;
  sensitivity: "public" | "internal" | "confidential" | "restricted";
  content: { mediaType: string; sizeBytes: number; sha256: string };
  locations: Array<{
    storageClass: "local" | "drive_replica" | "github_source" | "remote_object";
    uri: string;
    encrypted?: boolean;
  }>;
  provenance: {
    origin: "human" | "agent" | "adapter" | "import" | "derived" | "system";
    parentArtifactIds: string[];
    captureMethod: string;
    adapterId?: string;
    tool?: string;
    model?: string;
    transform?: string;
  };
  citations: Citation[];
  retention?: { policy: "project" | "temporary" | "legal_hold" | "owner_defined"; expiresAt?: string };
}

export interface ReviewJob {
  schemaVersion: "0.1.0-draft.4";
  jobId: string;
  projectId: string;
  mode: "collaboration" | "independent_review";
  status: JobStatus;
  requestedBy: PrincipalRef;
  requiredRole: RequiredJobRole;
  independence: {
    policy: "required" | "not_required" | "waived_by_owner";
    excludedPrincipalIds: string[];
    provenanceArtifactIds: string[];
    evaluatedBy: PrincipalRef;
    evaluatedAt: string;
    waiverReason?: string;
    waiverApprovalArtifactId?: string;
  };
  target: {
    contractVersion: "0.1.0-draft.4";
    artifactIds: string[];
    instructions: InstructionSet;
    acceptanceCriteria: string[];
  };
  approvalPolicyOverride?: ApprovalPolicyOverride;
  attempt: number;
  claim?: JobClaim;
  result?: {
    outcome: "accepted" | "changes_requested" | "rejected" | "inconclusive";
    artifactIds: string[];
    disagreements: Disagreement[];
    citations: Citation[];
  };
  failure?: { reason: string; retryable: boolean };
  cancellation?: { reason: string; by: PrincipalRef };
  createdAt: string;
  updatedAt: string;
}

export interface ApprovalCondition {
  name: string;
  operator: "equals" | "one_of";
  value: string | number | boolean | Array<string | number | boolean>;
}

export interface ApprovalGrant {
  schemaVersion: "0.1.0-draft.4";
  grantId: string;
  projectId: string;
  status: "active" | "revoked" | "exhausted" | "expired";
  grantedBy: PrincipalRef;
  grantedTo: PrincipalRef;
  requiredRole: RequiredJobRole;
  grantedAt: string;
  expiresAt: string;
  scope: {
    jobId: string;
    adapterIds: string[];
    actions: string[];
    conditions: ApprovalCondition[];
    destinations: string[];
    origins: string[];
    sideEffectClasses: SideEffectClass[];
    approvalPromptClasses: string[];
    maxUses: number;
  };
  claimBinding: { claimId: string; generation: number; fencingToken: number };
  instructionBinding: { instructionSetId: string; version: number; contentHash: string };
  usesConsumed: number;
  defaultOnNoMatch: "ask";
  revocation?: { revokedAt: string; revokedBy: PrincipalRef; reason: string };
}

export interface AdapterManifest {
  schemaVersion: "0.1.0-draft.4";
  adapterId: string;
  adapterVersion: string;
  interfaceVersion: "0.1.0-draft.4";
  displayName: string;
  kind: "browser" | "api" | "cli" | "local_process" | "storage";
  operations: Record<string, {
    inputSchema: string;
    outputSchema: string;
    idempotent: boolean;
    sideEffectClass: SideEffectClass;
    timeoutMs: number;
  }>;
  capabilities: string[];
  transports: Array<"in_process" | "stdio" | "remote_http">;
  security: {
    credentialMode: "none" | "environment_reference" | "os_keychain_reference" | "brokered";
    networkAccess: string[];
    sensitiveData: "forbidden" | "local_only" | "approved_external_only" | "supported";
    humanApprovalFor: Array<"external_reversible" | "external_irreversible" | "sensitive_external" | "credential_change">;
    approvalPolicy: {
      defaultDecision: "ask";
      preapproval: "disabled" | "bounded_grants";
      scopeExpansionDecision: "ask";
      grantSchema: string;
    };
  };
  health: { checkOperation: string; states: Array<"ready" | "degraded" | "blocked" | "offline"> };
}

export interface IdentityAuthorization {
  actor: PrincipalRef;
  roles: ProjectRole[];
}

export interface EventEnvelope extends Record<string, unknown> {
  schemaVersion: "0.1.0-draft.4";
  eventId: string;
  projectId: string;
  sequence: number;
  generation: number;
  eventType: string;
  aggregate: { type: string; id: string };
  actor: PrincipalRef;
  occurredAt: string;
  correlationId: string;
  causationId?: string;
  idempotencyKey?: string;
  data: Record<string, unknown>;
  previousHash?: string;
  hashAlgorithm: "sha256-bridge-cjson-v1";
  hash: string;
}

export interface AuditMirrorEntry extends Record<string, unknown> {
  schemaVersion: "0.1.0-draft.4";
  mirrorSequence: number;
  mirroredAt: string;
  event: EventEnvelope;
  instructionSets: InstructionSet[];
  approvals: ApprovalGrant[];
  actions: Array<Record<string, unknown>>;
  outcomes: Array<Record<string, unknown>>;
  citations: Citation[];
  excludedContentClasses: ["browser_state", "credentials", "raw_artifact_contents", "secrets"];
  previousMirrorHash?: string;
  hashAlgorithm: "sha256-bridge-audit-cjson-v1";
  mirrorHash: string;
}
