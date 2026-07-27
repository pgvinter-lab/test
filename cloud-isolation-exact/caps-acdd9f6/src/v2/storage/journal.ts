import {
  AUDIT_HASH_ALGORITHM,
  CONTRACT_VERSION,
  EVENT_HASH_ALGORITHM,
  EXCLUDED_AUDIT_CONTENT,
} from "../core/constants.js";
import { canonicalEqual, deepCopy, hashAuditEntry, hashEvent } from "../core/canonical.js";
import { invariant } from "../core/errors.js";
import { newId } from "../core/ids.js";
import { requireExactKeys } from "../core/validation.js";
import type {
  ApprovalGrant,
  ApprovalPolicyOverride,
  AuditMirrorEntry,
  Citation,
  EventEnvelope,
  InstructionSet,
  PrincipalRef,
  ReviewJob,
} from "../core/types.js";
import type { BridgeStore } from "./store.js";
import type { ContractSchemaRegistry } from "../core/schema-registry.js";

export type EventType =
  | "review_job.created"
  | "review_job.claimable"
  | "review_job.claimed"
  | "review_job.started"
  | "review_job.input_requested"
  | "review_job.input_resumed"
  | "review_job.completed"
  | "review_job.failed"
  | "review_job.cancelled"
  | "review_job.claim_expired"
  | "review_job.instructions_amended"
  | "approval_grant.created"
  | "approval_grant.revoked"
  | "approval_grant.consumed"
  | "approval_grant.exhausted"
  | "browser.authorization_decided"
  | "collaboration.command_recorded"
  | "project.generation_advanced";

interface EventShape {
  required: readonly string[];
  allowed: readonly string[];
  aggregateType: EventEnvelope["aggregate"]["type"];
}

const SHAPES: Record<EventType, EventShape> = {
  "review_job.created": {
    required: ["mode", "instructionSetId", "instructionVersion"],
    allowed: ["mode", "instructionSetId", "instructionVersion", "approvalPolicyOverride"],
    aggregateType: "review_job",
  },
  "review_job.claimable": { required: [], allowed: [], aggregateType: "review_job" },
  "review_job.claimed": { required: ["claimId", "fencingToken"], allowed: ["claimId", "fencingToken"], aggregateType: "review_job" },
  "review_job.started": { required: [], allowed: [], aggregateType: "review_job" },
  "review_job.input_requested": { required: ["reason"], allowed: ["reason"], aggregateType: "review_job" },
  "review_job.input_resumed": { required: [], allowed: [], aggregateType: "review_job" },
  "review_job.completed": {
    required: ["outcome", "artifactIds", "disagreements", "citations"],
    allowed: ["outcome", "artifactIds", "disagreements", "citations"],
    aggregateType: "review_job",
  },
  "review_job.failed": { required: ["reason", "retryable"], allowed: ["reason", "retryable"], aggregateType: "review_job" },
  "review_job.cancelled": { required: ["reason"], allowed: ["reason"], aggregateType: "review_job" },
  "review_job.claim_expired": { required: [], allowed: [], aggregateType: "review_job" },
  "review_job.instructions_amended": {
    required: ["instructionSetId", "fromVersion", "toVersion", "materialAmendment", "invalidatedApprovalGrantIds"],
    allowed: [
      "instructionSetId", "fromVersion", "toVersion", "materialAmendment", "invalidatedApprovalGrantIds",
      "approvalPolicyOverrideId", "overriddenRulesApplied",
    ],
    aggregateType: "review_job",
  },
  "approval_grant.created": {
    required: ["grantId", "jobId", "actions", "expiresAt", "maxUses"],
    allowed: ["grantId", "jobId", "actions", "expiresAt", "maxUses"],
    aggregateType: "approval_grant",
  },
  "approval_grant.revoked": {
    required: ["grantId", "reason", "invalidatedByInstructionAmendment"],
    allowed: ["grantId", "reason", "invalidatedByInstructionAmendment"],
    aggregateType: "approval_grant",
  },
  "approval_grant.consumed": {
    required: ["grantId", "actionId", "useNumber"],
    allowed: ["grantId", "actionId", "useNumber", "approvalPolicyOverrideId", "overriddenRulesApplied"],
    aggregateType: "approval_grant",
  },
  "approval_grant.exhausted": {
    required: ["grantId", "usesConsumed"],
    allowed: ["grantId", "usesConsumed"],
    aggregateType: "approval_grant",
  },
  "browser.authorization_decided": {
    required: ["actionId", "jobId", "adapterId", "operation", "origin", "destination", "sideEffectClass", "decision", "reason"],
    allowed: [
      "actionId", "jobId", "adapterId", "operation", "origin", "destination", "sideEffectClass", "decision", "reason",
      "approvalGrantId", "approvalPolicyOverrideId", "overriddenRulesApplied",
    ],
    aggregateType: "adapter_action",
  },
  "collaboration.command_recorded": {
    required: ["operation", "agent", "request", "outcome"],
    allowed: ["operation", "agent", "request", "outcome"],
    aggregateType: "project",
  },
  "project.generation_advanced": { required: ["reason"], allowed: ["reason"], aggregateType: "project" },
};

export interface AuditContext {
  instructionSets?: InstructionSet[];
  approvals?: ApprovalGrant[];
  actions?: Array<Record<string, unknown>>;
  outcomes?: Array<Record<string, unknown>>;
  citations?: Citation[];
}

export interface AppendEventInput {
  projectId: string;
  eventType: EventType;
  aggregateId: string;
  actor: PrincipalRef;
  data: Record<string, unknown>;
  idempotencyKey?: string;
  correlationId?: string;
  causationId?: string;
  audit?: AuditContext;
}

export class EventJournal {
  constructor(private readonly store: BridgeStore, private readonly schemas: ContractSchemaRegistry) {}

  append(input: AppendEventInput): EventEnvelope {
    this.store.assertWriteTransaction();
    // Phase 1 requires every authoritative event to have a durable JSONL
    // projection. Refuse the state change atomically when no mirror endpoint
    // was configured instead of silently accumulating an unmirrored outbox.
    invariant(Boolean(this.store.auditMirrorPath), "audit_mirror_path_required");
    const shape = SHAPES[input.eventType];
    requireExactKeys(input.data, shape.allowed, shape.required, `${input.eventType}.data`);
    const project = this.store.get<{ active_generation: number }>(
      "SELECT active_generation FROM projects WHERE project_id = ?",
      input.projectId,
    );
    invariant(project, "project_not_found");
    const previous = this.store.get<{ sequence: number; hash: string }>(
      "SELECT sequence, hash FROM events WHERE project_id = ? ORDER BY sequence DESC LIMIT 1",
      input.projectId,
    );
    const sequence = previous ? Number(previous.sequence) + 1 : 1;
    const base = {
      schemaVersion: CONTRACT_VERSION,
      eventId: newId("event"),
      projectId: input.projectId,
      sequence,
      generation: Number(project.active_generation),
      eventType: input.eventType,
      aggregate: { type: shape.aggregateType, id: input.aggregateId },
      actor: deepCopy(input.actor),
      occurredAt: this.store.now(),
      correlationId: input.correlationId ?? `correlation.${input.aggregateId}`,
      ...(input.causationId ? { causationId: input.causationId } : {}),
      ...(input.idempotencyKey ? { idempotencyKey: input.idempotencyKey } : {}),
      data: deepCopy(input.data),
      ...(previous ? { previousHash: previous.hash } : {}),
      hashAlgorithm: EVENT_HASH_ALGORITHM,
    };
    const event = { ...base, hash: hashEvent(base) } as EventEnvelope;
    this.assertOverrideConsistency(event);
    this.schemas.validateNamed("event.schema.json", event);
    this.store.run(
      `INSERT INTO events(
        project_id, sequence, event_id, generation, event_type, aggregate_type, aggregate_id,
        occurred_at, previous_hash, hash, envelope_json
      ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      event.projectId,
      event.sequence,
      event.eventId,
      event.generation,
      event.eventType,
      event.aggregate.type,
      event.aggregate.id,
      event.occurredAt,
      event.previousHash ?? null,
      event.hash,
      JSON.stringify(event),
    );
    this.appendAudit(event, input.audit ?? {});
    return deepCopy(event);
  }

  list(projectId: string): EventEnvelope[] {
    return this.store.all<{ envelope_json: string }>(
      "SELECT envelope_json FROM events WHERE project_id = ? ORDER BY sequence",
      projectId,
    ).map((row) => JSON.parse(row.envelope_json) as EventEnvelope);
  }

  private appendAudit(event: EventEnvelope, context: AuditContext): void {
    const instructionSets = deepCopy(context.instructionSets ?? []);
    const approvals = deepCopy(context.approvals ?? []);
    const actions = deepCopy(context.actions ?? []);
    const outcomes = deepCopy(context.outcomes ?? []);
    const citations = deepCopy(context.citations ?? []);
    if (event.eventType.startsWith("review_job.")) invariant(instructionSets.length > 0, "audit_instruction_snapshot_required");
    if (event.eventType.startsWith("approval_grant.")) invariant(approvals.length > 0, "audit_approval_snapshot_required");
    if (event.eventType === "browser.authorization_decided") {
      invariant(actions.length > 0, "audit_action_snapshot_required");
      invariant(outcomes.length > 0, "audit_outcome_snapshot_required");
    }
    if (event.eventType === "review_job.completed") invariant(outcomes.length > 0, "audit_outcome_snapshot_required");
    this.assertAuditOverrideConsistency(event, actions);
    const previous = this.store.get<{ mirror_sequence: number; mirror_hash: string }>(
      "SELECT mirror_sequence, mirror_hash FROM audit_mirror_entries ORDER BY mirror_sequence DESC LIMIT 1",
    );
    const base = {
      schemaVersion: CONTRACT_VERSION,
      mirrorSequence: previous ? Number(previous.mirror_sequence) + 1 : 1,
      mirroredAt: this.store.now(),
      event: deepCopy(event),
      instructionSets,
      approvals,
      actions,
      outcomes,
      citations,
      excludedContentClasses: [...EXCLUDED_AUDIT_CONTENT] as AuditMirrorEntry["excludedContentClasses"],
      ...(previous ? { previousMirrorHash: previous.mirror_hash } : {}),
      hashAlgorithm: AUDIT_HASH_ALGORITHM,
    };
    const entry = { ...base, mirrorHash: hashAuditEntry(base) } as AuditMirrorEntry;
    this.schemas.validateNamed("audit-mirror-entry.schema.json", entry);
    this.store.run(
      `INSERT INTO audit_mirror_entries(
        project_id, mirror_sequence, event_id, mirrored_at, previous_mirror_hash, mirror_hash, entry_json, file_appended
      ) VALUES (?, ?, ?, ?, ?, ?, ?, 0)`,
      event.projectId,
      entry.mirrorSequence,
      event.eventId,
      entry.mirroredAt,
      entry.previousMirrorHash ?? null,
      entry.mirrorHash,
      JSON.stringify(entry),
    );
  }

  private assertOverrideConsistency(event: EventEnvelope): void {
    const data = event.data;
    if (event.eventType === "review_job.created") {
      const override = data.approvalPolicyOverride as ReviewJob["approvalPolicyOverride"];
      const relational = this.relationalOverride(event.aggregate.id);
      invariant(Boolean(override) === Boolean(relational), "override_creation_audit_mismatch");
      if (override) {
        invariant(override.scope.jobId === event.aggregate.id && canonicalEqual(override, relational), "override_job_scope_mismatch");
      }
    }
    const overrideId = data.approvalPolicyOverrideId;
    const rules = data.overriddenRulesApplied;
    invariant((overrideId === undefined) === (rules === undefined), "override_audit_fields_incomplete");
    if (overrideId === undefined) return;
    const jobId = this.eventJobId(event);
    const override = this.relationalOverride(jobId);
    invariant(override, "override_audit_without_job_override");
    invariant(override.overrideId === overrideId, "override_audit_id_mismatch");
    invariant(Array.isArray(rules) && rules.length > 0 && rules.every((rule) => rule === "M-3" || rule === "L-4"), "invalid_overridden_rules_audit");
    if (event.eventType === "review_job.instructions_amended") {
      invariant(rules.length === 1 && rules[0] === "M-3", "invalid_m3_override_audit");
      invariant(Array.isArray(data.invalidatedApprovalGrantIds) && data.invalidatedApprovalGrantIds.length === 0, "m3_override_invalidation_inconsistent");
    }
  }

  private relationalOverride(jobId: string): ApprovalPolicyOverride | undefined {
    const row = this.store.get<{
      document_json: string;
      override_id: string;
      override_job_id: string;
      invoked_by_principal_id: string;
      invoked_by_session_id: string;
      invoked_by_host_id: string;
      invoked_at: string;
      project_id: string;
      approval_policy_override_id: string | null;
      requested_by_principal_id: string;
      requested_by_session_id: string;
      requested_by_host_id: string;
      owner_present: number;
    }>(
      `SELECT o.document_json, o.override_id, o.job_id AS override_job_id,
              o.invoked_by_principal_id, o.invoked_by_session_id, o.invoked_by_host_id, o.invoked_at,
              j.project_id, j.approval_policy_override_id, j.requested_by_principal_id,
              j.requested_by_session_id, j.requested_by_host_id,
              EXISTS(
                SELECT 1 FROM project_roles r
                WHERE r.project_id = j.project_id
                  AND r.principal_id = o.invoked_by_principal_id
                  AND r.role = 'owner'
                  AND julianday(r.granted_at) <= julianday(o.invoked_at)
                  AND (r.revoked_at IS NULL OR julianday(r.revoked_at) >= julianday(o.invoked_at))
              ) AS owner_present
       FROM approval_policy_overrides o
       JOIN review_jobs j ON j.job_id = o.job_id
       WHERE o.job_id = ?`,
      jobId,
    );
    if (!row) return undefined;
    const override = JSON.parse(row.document_json) as ApprovalPolicyOverride;
    invariant(
      row.override_job_id === jobId && row.approval_policy_override_id === row.override_id &&
      override.overrideId === row.override_id && override.scope.jobId === row.override_job_id &&
      override.invokedAt === row.invoked_at &&
      override.invokedBy.principalId === row.invoked_by_principal_id &&
      override.invokedBy.sessionId === row.invoked_by_session_id &&
      override.invokedBy.hostId === row.invoked_by_host_id,
      "approval_policy_override_relational_binding_mismatch",
    );
    invariant(
      row.invoked_by_principal_id === row.requested_by_principal_id &&
      row.invoked_by_session_id === row.requested_by_session_id &&
      row.invoked_by_host_id === row.requested_by_host_id && Number(row.owner_present) === 1,
      "approval_policy_override_must_be_owner_invoked",
    );
    return override;
  }

  private assertAuditOverrideConsistency(event: EventEnvelope, actions: Array<Record<string, unknown>>): void {
    const expectedId = event.data.approvalPolicyOverrideId;
    const expectedRules = event.data.overriddenRulesApplied;
    for (const action of actions) {
      const actionId = action.approvalPolicyOverrideId;
      const actionRules = action.overriddenRulesApplied;
      invariant((actionId === undefined) === (actionRules === undefined), "override_action_audit_fields_incomplete");
      if (actionId !== undefined) {
        invariant(actionId === expectedId, "override_action_audit_id_mismatch");
        invariant(JSON.stringify(actionRules) === JSON.stringify(expectedRules), "override_action_audit_rules_mismatch");
      }
    }
  }

  private eventJobId(event: EventEnvelope): string {
    if (event.aggregate.type === "review_job") return event.aggregate.id;
    if (event.eventType === "browser.authorization_decided") return String(event.data.jobId);
    if (event.aggregate.type === "approval_grant") {
      const row = this.store.get<{ job_id: string }>("SELECT job_id FROM approval_grants WHERE grant_id = ?", event.aggregate.id);
      invariant(row, "approval_grant_not_found");
      return row.job_id;
    }
    throw new Error("event_has_no_job_scope");
  }
}
