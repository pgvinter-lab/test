import { canonicalEqual, deepCopy, hashCanonical } from "../core/canonical.js";
import {
  CONTRACT_VERSION,
  OVERRIDDEN_RULES,
  PRESERVED_OVERRIDE_CONTROLS,
  TERMINAL_JOB_STATES,
  type JobStatus,
} from "../core/constants.js";
import { invariant } from "../core/errors.js";
import { newId } from "../core/ids.js";
import { requireIdentifier, requireNonEmptyString, requireUniqueStrings } from "../core/validation.js";
import type {
  ApprovalGrant,
  ApprovalPolicyOverride,
  Citation,
  Disagreement,
  HostRecord,
  InstructionSet,
  JobClaim,
  PrincipalRef,
  ReviewJob,
  SessionRecord,
} from "../core/types.js";
import type { ArtifactService } from "../artifacts/artifact-service.js";
import type { IdentityService } from "../identity/identity-service.js";
import type { EventJournal } from "../storage/journal.js";
import type { BridgeStore } from "../storage/store.js";
import type { ContractSchemaRegistry } from "../core/schema-registry.js";

export interface CreateJobInput {
  projectId: string;
  actor: PrincipalRef;
  idempotencyKey: string;
  jobId?: string;
  mode: "collaboration" | "independent_review";
  requiredRole: "collaborator" | "reviewer" | "worker";
  independence?: {
    policy?: "required" | "not_required" | "waived_by_owner";
    excludedPrincipalIds?: string[];
    waiverReason?: string;
    waiverApprovalArtifactId?: string;
  };
  target: {
    artifactIds: string[];
    instructions: string;
    acceptanceCriteria: string[];
  };
  approvalPolicyOverride?: { reason: string };
}

export interface ClaimToken {
  claimId: string;
  generation: number;
  fencingToken: number;
}

export class JobService {
  constructor(
    private readonly store: BridgeStore,
    private readonly identity: IdentityService,
    private readonly artifacts: ArtifactService,
    private readonly journal: EventJournal,
    private readonly schemas: ContractSchemaRegistry,
  ) {}

  create(input: CreateJobInput): ReviewJob {
    this.validateCreateAuthorization(input);
    if (input.jobId) requireIdentifier(input.jobId, "jobId", "job.");
    requireUniqueStrings(input.target.artifactIds, "target.artifactIds", 1);
    requireUniqueStrings(input.target.acceptanceCriteria, "target.acceptanceCriteria", 1);
    requireNonEmptyString(input.target.instructions, "target.instructions", 16_000);
    return this.store.mutateIdempotent({
      projectId: input.projectId,
      actor: input.actor,
      operation: "review_job.create",
      idempotencyKey: input.idempotencyKey,
      request: omitInvocationContext(input),
      run: () => {
        this.validateCreateAuthorization(input);
        for (const artifactId of input.target.artifactIds) {
          invariant(this.artifacts.require(artifactId).projectId === input.projectId, "target_artifact_project_mismatch");
        }
        const jobId = input.jobId ?? newId("job");
        invariant(!this.get(jobId), "job_exists");
        const at = this.store.now();
        const independence = this.evaluateIndependence(input, at);
        const instruction: InstructionSet = {
          instructionSetId: newId("instructions"),
          version: 1,
          text: input.target.instructions,
          contentHash: hashCanonical(input.target.instructions),
          authoredBy: deepCopy(input.actor),
          authoredAt: at,
          materialAmendment: false,
          invalidatesApprovalGrantIds: [],
        };
        const override = input.approvalPolicyOverride
          ? this.buildOverride(input.projectId, jobId, input.actor, at, input.approvalPolicyOverride.reason)
          : undefined;
        const job: ReviewJob = {
          schemaVersion: CONTRACT_VERSION,
          jobId,
          projectId: input.projectId,
          mode: input.mode,
          status: "queued",
          requestedBy: deepCopy(input.actor),
          requiredRole: input.requiredRole,
          independence,
          target: {
            contractVersion: CONTRACT_VERSION,
            artifactIds: [...input.target.artifactIds],
            instructions: instruction,
            acceptanceCriteria: [...input.target.acceptanceCriteria],
          },
          ...(override ? { approvalPolicyOverride: override } : {}),
          attempt: 0,
          createdAt: at,
          updatedAt: at,
        };
        this.insertJob(job);
        this.insertInstruction(jobId, instruction);
        if (override) {
          this.store.run(
            `INSERT INTO approval_policy_overrides(
              override_id, job_id, invoked_by_principal_id, invoked_by_session_id, invoked_by_host_id,
              invoked_at, document_json
            ) VALUES (?, ?, ?, ?, ?, ?, ?)`,
            override.overrideId,
            jobId,
            override.invokedBy.principalId,
            override.invokedBy.sessionId,
            override.invokedBy.hostId,
            override.invokedAt,
            JSON.stringify(override),
          );
        }
        this.journal.append({
          projectId: input.projectId,
          eventType: "review_job.created",
          aggregateId: jobId,
          actor: input.actor,
          idempotencyKey: input.idempotencyKey,
          data: {
            mode: input.mode,
            instructionSetId: instruction.instructionSetId,
            instructionVersion: 1,
            ...(override ? { approvalPolicyOverride: deepCopy(override) } : {}),
          },
          audit: { instructionSets: [instruction] },
        });
        return deepCopy(job);
      },
    });
  }

  makeClaimable(args: { projectId: string; jobId: string; actor: PrincipalRef; idempotencyKey: string }): ReviewJob {
    this.authorizeOrchestrator(args.projectId, args.jobId, args.actor);
    return this.store.mutateIdempotent({
      projectId: args.projectId,
      actor: args.actor,
      operation: "review_job.make_claimable",
      idempotencyKey: args.idempotencyKey,
      request: { jobId: args.jobId },
      run: () => {
        this.authorizeOrchestrator(args.projectId, args.jobId, args.actor);
        const job = this.requireForProject(args.projectId, args.jobId);
        invariant(job.status === "queued", "invalid_transition");
        job.independence = this.reevaluateIndependence(job, args.actor);
        job.status = "claimable";
        job.updatedAt = this.store.now();
        this.persistJob(job);
        this.journal.append({
          projectId: args.projectId,
          eventType: "review_job.claimable",
          aggregateId: job.jobId,
          actor: args.actor,
          idempotencyKey: args.idempotencyKey,
          data: {},
          audit: { instructionSets: [job.target.instructions] },
        });
        return deepCopy(job);
      },
    });
  }

  claim(args: {
    projectId: string;
    jobId: string;
    actor: PrincipalRef;
    leaseMs?: number;
    idempotencyKey: string;
  }): ReviewJob {
    const initial = this.requireForProject(args.projectId, args.jobId);
    this.identity.authorize(args.projectId, args.actor, [initial.requiredRole]);
    const leaseMs = args.leaseMs ?? 60_000;
    invariant(Number.isSafeInteger(leaseMs) && leaseMs >= 1_000 && leaseMs <= 86_400_000, "invalid_claim_lease");
    return this.store.mutateIdempotent({
      projectId: args.projectId,
      actor: args.actor,
      operation: "review_job.claim",
      idempotencyKey: args.idempotencyKey,
      request: { jobId: args.jobId, leaseMs },
      run: () => {
        const job = this.requireForProject(args.projectId, args.jobId);
        invariant(job.projectId === args.projectId && job.status === "claimable", "job_not_claimable");
        this.identity.authorize(args.projectId, args.actor, [job.requiredRole]);
        job.independence = this.reevaluateIndependence(job, args.actor);
        if (job.independence.policy === "required") {
          invariant(!job.independence.excludedPrincipalIds.includes(args.actor.principalId), "reviewer_not_independent");
        }
        this.store.run(
          "UPDATE projects SET next_fencing_token = next_fencing_token + 1, updated_at = ? WHERE project_id = ?",
          this.store.now(),
          args.projectId,
        );
        const project = this.store.get<{ active_generation: number; next_fencing_token: number }>(
          "SELECT active_generation, next_fencing_token FROM projects WHERE project_id = ?",
          args.projectId,
        )!;
        const claimedAt = this.store.now();
        const attempt = job.attempt + 1;
        const claim: JobClaim = {
          claimId: newId("claim"),
          claimedBy: deepCopy(args.actor),
          generation: Number(project.active_generation),
          fencingToken: Number(project.next_fencing_token),
          idempotencyKey: args.idempotencyKey,
          claimedAt,
          leaseExpiresAt: new Date(Date.parse(claimedAt) + leaseMs).toISOString(),
        };
        this.store.run(
          `INSERT INTO job_claims(
            claim_id, job_id, attempt, claimed_by_principal_id, claimed_by_session_id, claimed_by_host_id,
            generation, fencing_token, idempotency_key, claimed_at, lease_expires_at, status
          ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 'active')`,
          claim.claimId,
          job.jobId,
          attempt,
          args.actor.principalId,
          args.actor.sessionId,
          args.actor.hostId,
          claim.generation,
          claim.fencingToken,
          claim.idempotencyKey,
          claim.claimedAt,
          claim.leaseExpiresAt,
        );
        job.status = "claimed";
        job.attempt = attempt;
        job.claim = claim;
        job.updatedAt = claimedAt;
        this.persistJob(job);
        this.journal.append({
          projectId: args.projectId,
          eventType: "review_job.claimed",
          aggregateId: job.jobId,
          actor: args.actor,
          idempotencyKey: args.idempotencyKey,
          data: { claimId: claim.claimId, fencingToken: claim.fencingToken },
          audit: { instructionSets: [job.target.instructions] },
        });
        return deepCopy(job);
      },
    });
  }

  start(args: ClaimedMutation): ReviewJob {
    return this.claimedTransition(args, ["claimed"], "running", "review_job.started", {});
  }

  awaitInput(args: ClaimedMutation & { reason: string }): ReviewJob {
    requireNonEmptyString(args.reason, "reason", 2000);
    return this.claimedTransition(args, ["running"], "awaiting_input", "review_job.input_requested", { reason: args.reason });
  }

  resume(args: ClaimedMutation & { inputArtifactIds: string[] }): ReviewJob {
    requireUniqueStrings(args.inputArtifactIds, "inputArtifactIds", 1);
    for (const artifactId of args.inputArtifactIds) invariant(this.artifacts.require(artifactId).projectId === args.projectId, "input_artifact_project_mismatch");
    return this.claimedTransition(args, ["awaiting_input"], "running", "review_job.input_resumed", {}, () => {
      const job = this.requireForProject(args.projectId, args.jobId);
      for (const artifactId of args.inputArtifactIds) {
        this.store.run(
          `INSERT INTO job_inputs(job_id, instruction_version, artifact_id, attached_at, attached_by_principal_id)
           VALUES (?, ?, ?, ?, ?)
           ON CONFLICT(job_id, instruction_version, artifact_id) DO NOTHING`,
          args.jobId,
          job.target.instructions.version,
          artifactId,
          this.store.now(),
          args.actor.principalId,
        );
      }
    }, { inputArtifactIds: args.inputArtifactIds });
  }

  complete(args: ClaimedMutation & {
    result: {
      outcome: "accepted" | "changes_requested" | "rejected" | "inconclusive";
      artifactIds: string[];
      disagreements: Disagreement[];
      citations: Citation[];
    };
  }): ReviewJob {
    requireUniqueStrings(args.result.artifactIds, "result.artifactIds", 1);
    invariant(Array.isArray(args.result.disagreements) && Array.isArray(args.result.citations), "result_audit_fields_required");
    for (const artifactId of args.result.artifactIds) invariant(this.artifacts.require(artifactId).projectId === args.projectId, "result_artifact_project_mismatch");
    this.validateDisagreements(args.result.disagreements, args.projectId, args.actor);
    this.artifacts.assertCitations(args.result.citations, args.projectId, true);
    this.identity.authorize(args.projectId, args.actor, [this.requireForProject(args.projectId, args.jobId).requiredRole]);
    return this.store.mutateIdempotent({
      projectId: args.projectId,
      actor: args.actor,
      operation: "review_job.complete",
      idempotencyKey: args.idempotencyKey,
      request: { jobId: args.jobId, claim: token(args.claim), result: args.result },
      run: () => {
        const job = this.assertActiveClaim(args.projectId, args.jobId, args.actor, args.claim);
        invariant(job.status === "running", "invalid_transition");
        this.validateDisagreements(args.result.disagreements, args.projectId, args.actor);
        job.status = "completed";
        job.result = deepCopy(args.result);
        job.updatedAt = this.store.now();
        this.store.run("UPDATE job_claims SET status = 'completed', ended_at = ? WHERE claim_id = ?", job.updatedAt, job.claim!.claimId);
        this.persistJob(job);
        const outcome = {
          outcomeId: newId("outcome"),
          status: `review_${args.result.outcome}`,
          detailHash: hashCanonical(args.result),
          artifactIds: [...args.result.artifactIds],
        };
        this.journal.append({
          projectId: args.projectId,
          eventType: "review_job.completed",
          aggregateId: job.jobId,
          actor: args.actor,
          idempotencyKey: args.idempotencyKey,
          data: deepCopy(args.result),
          audit: { instructionSets: [job.target.instructions], outcomes: [outcome], citations: args.result.citations },
        });
        return deepCopy(job);
      },
    });
  }

  private validateDisagreements(disagreements: Disagreement[], projectId: string, actor: PrincipalRef): void {
    const ids = disagreements.map((disagreement) => disagreement.disagreementId);
    invariant(new Set(ids).size === ids.length, "duplicate_disagreement_id");
    for (const disagreement of disagreements) {
      requireIdentifier(disagreement.disagreementId, "disagreementId", "disagreement.");
      requireNonEmptyString(disagreement.position, "disagreement.position", 4000);
      requireNonEmptyString(disagreement.reason, "disagreement.reason", 4000);
      if (disagreement.raisedBy) invariant(canonicalEqual(disagreement.raisedBy, actor), "disagreement_actor_mismatch");
      for (const artifactId of disagreement.relatedArtifactIds ?? []) {
        invariant(this.artifacts.require(artifactId).projectId === projectId, "disagreement_artifact_project_mismatch");
      }
    }
  }

  fail(args: ClaimedMutation & { reason: string; retryable: boolean }): ReviewJob {
    requireNonEmptyString(args.reason, "reason", 2000);
    this.identity.authorize(args.projectId, args.actor, [this.requireForProject(args.projectId, args.jobId).requiredRole]);
    return this.store.mutateIdempotent({
      projectId: args.projectId,
      actor: args.actor,
      operation: "review_job.fail",
      idempotencyKey: args.idempotencyKey,
      request: { jobId: args.jobId, claim: token(args.claim), reason: args.reason, retryable: args.retryable },
      run: () => {
        const job = this.assertActiveClaim(args.projectId, args.jobId, args.actor, args.claim);
        invariant(job.status === "running", "invalid_transition");
        job.status = "failed";
        job.failure = { reason: args.reason, retryable: args.retryable };
        job.updatedAt = this.store.now();
        this.store.run("UPDATE job_claims SET status = 'failed', ended_at = ? WHERE claim_id = ?", job.updatedAt, job.claim!.claimId);
        this.persistJob(job);
        this.journal.append({
          projectId: args.projectId,
          eventType: "review_job.failed",
          aggregateId: job.jobId,
          actor: args.actor,
          idempotencyKey: args.idempotencyKey,
          data: { reason: args.reason, retryable: args.retryable },
          audit: { instructionSets: [job.target.instructions] },
        });
        return deepCopy(job);
      },
    });
  }

  cancel(args: { projectId: string; jobId: string; actor: PrincipalRef; reason: string; idempotencyKey: string }): ReviewJob {
    requireNonEmptyString(args.reason, "reason", 2000);
    this.authorizeCancellation(args.projectId, args.jobId, args.actor);
    return this.store.mutateIdempotent({
      projectId: args.projectId,
      actor: args.actor,
      operation: "review_job.cancel",
      idempotencyKey: args.idempotencyKey,
      request: { jobId: args.jobId, reason: args.reason },
      run: () => {
        this.authorizeCancellation(args.projectId, args.jobId, args.actor);
        const job = this.requireForProject(args.projectId, args.jobId);
        invariant(!TERMINAL_JOB_STATES.includes(job.status as never), "invalid_transition");
        job.status = "cancelled";
        job.cancellation = { reason: args.reason, by: deepCopy(args.actor) };
        job.updatedAt = this.store.now();
        if (job.claim) this.store.run("UPDATE job_claims SET status = 'cancelled', ended_at = ? WHERE claim_id = ?", job.updatedAt, job.claim.claimId);
        this.persistJob(job);
        this.journal.append({
          projectId: args.projectId,
          eventType: "review_job.cancelled",
          aggregateId: job.jobId,
          actor: args.actor,
          idempotencyKey: args.idempotencyKey,
          data: { reason: args.reason },
          audit: { instructionSets: [job.target.instructions] },
        });
        return deepCopy(job);
      },
    });
  }

  expireClaim(args: { projectId: string; jobId: string; actor: PrincipalRef; at?: string; idempotencyKey: string }): ReviewJob {
    this.identity.authorize(args.projectId, args.actor, ["owner", "administrator"]);
    return this.store.mutateIdempotent({
      projectId: args.projectId,
      actor: args.actor,
      operation: "review_job.expire_claim",
      idempotencyKey: args.idempotencyKey,
      request: { jobId: args.jobId },
      run: () => {
        this.identity.authorize(args.projectId, args.actor, ["owner", "administrator"]);
        const job = this.requireForProject(args.projectId, args.jobId);
        const at = this.store.now();
        invariant(["claimed", "running", "awaiting_input"].includes(job.status) && job.claim, "claim_not_expirable_from_state");
        invariant(Date.parse(job.claim.leaseExpiresAt) <= Date.parse(at), "claim_not_expired");
        this.store.run("UPDATE job_claims SET status = 'expired', ended_at = ? WHERE claim_id = ?", at, job.claim.claimId);
        job.status = "claimable";
        delete job.claim;
        job.updatedAt = at;
        this.persistJob(job);
        this.journal.append({
          projectId: args.projectId,
          eventType: "review_job.claim_expired",
          aggregateId: job.jobId,
          actor: args.actor,
          idempotencyKey: args.idempotencyKey,
          data: {},
          audit: { instructionSets: [job.target.instructions] },
        });
        return deepCopy(job);
      },
    });
  }

  releaseClaim(args: ClaimedMutation): ReviewJob {
    this.identity.authorize(args.projectId, args.actor, [this.requireForProject(args.projectId, args.jobId).requiredRole]);
    return this.store.mutateIdempotent({
      projectId: args.projectId,
      actor: args.actor,
      operation: "review_job.release_claim",
      idempotencyKey: args.idempotencyKey,
      request: { jobId: args.jobId, claim: token(args.claim) },
      run: () => {
        const job = this.assertActiveClaim(args.projectId, args.jobId, args.actor, args.claim);
        invariant(job.status === "claimed", "claim_not_releasable_from_state");
        const at = this.store.now();
        const releasedClaimId = job.claim!.claimId;
        const released = this.store.run(
          "UPDATE job_claims SET status = 'released', ended_at = ? WHERE claim_id = ? AND status = 'active'",
          at,
          releasedClaimId,
        );
        invariant(Number(released.changes) === 1, "claim_not_active");
        job.status = "claimable";
        delete job.claim;
        job.updatedAt = at;
        this.persistJob(job);
        this.journal.append({
          projectId: args.projectId,
          eventType: "review_job.claimable",
          aggregateId: job.jobId,
          actor: args.actor,
          idempotencyKey: args.idempotencyKey,
          data: {},
          audit: {
            instructionSets: [job.target.instructions],
            actions: [{
              actionId: releasedClaimId,
              adapterId: "adapter.bridge.runtime",
              operation: "claim.release",
              sideEffectClass: "local_write",
              origin: `bridge://runtime/jobs/${job.jobId}`,
              destination: `bridge://runtime/claims/${releasedClaimId}`,
              conditionHash: hashCanonical({
                claimId: releasedClaimId,
                generation: args.claim.generation,
                fencingToken: args.claim.fencingToken,
              }),
              authorizationDecision: "allow",
            }],
            outcomes: [{
              outcomeId: newId("outcome"),
              status: "succeeded",
              detailHash: hashCanonical({ operation: "claim.release", claimId: releasedClaimId }),
              artifactIds: [],
            }],
          },
        });
        return deepCopy(job);
      },
    });
  }

  amendInstructions(args: {
    projectId: string;
    jobId: string;
    actor: PrincipalRef;
    text: string;
    materialAmendment: boolean;
    idempotencyKey: string;
  }): ReviewJob {
    requireNonEmptyString(args.text, "instructions", 16_000);
    this.identity.authorize(args.projectId, args.actor, ["owner"]);
    return this.store.mutateIdempotent({
      projectId: args.projectId,
      actor: args.actor,
      operation: "review_job.amend_instructions",
      idempotencyKey: args.idempotencyKey,
      request: { jobId: args.jobId, text: args.text, materialAmendment: args.materialAmendment },
      run: () => {
        this.identity.authorize(args.projectId, args.actor, ["owner"]);
        const job = this.requireForProject(args.projectId, args.jobId);
        invariant(!TERMINAL_JOB_STATES.includes(job.status as never), "terminal_job_instructions_immutable");
        const previous = job.target.instructions;
        const override = job.approvalPolicyOverride;
        const grantRows = override ? [] : this.store.all<{ document_json: string }>(
          `SELECT document_json FROM approval_grants
           WHERE job_id = ? AND status = 'active' AND instruction_version = ? ORDER BY grant_id`,
          job.jobId,
          previous.version,
        );
        const invalidated = grantRows.map((row) => (JSON.parse(row.document_json) as ApprovalGrant).grantId).sort();
        const revokedGrants: ApprovalGrant[] = [];
        for (const row of grantRows) {
          const grant = JSON.parse(row.document_json) as ApprovalGrant;
          grant.status = "revoked";
          grant.revocation = {
            revokedAt: this.store.now(),
            revokedBy: deepCopy(args.actor),
            reason: `${args.materialAmendment ? "Material" : "Non-material"} instruction amendment superseded version ${previous.version}.`,
          };
          this.store.run(
            "UPDATE approval_grants SET status = 'revoked', document_json = ?, updated_at = ? WHERE grant_id = ? AND status = 'active'",
            JSON.stringify(grant),
            this.store.now(),
            grant.grantId,
          );
          this.store.run(
            "UPDATE adapter_action_authorizations SET status = 'revoked' WHERE approval_grant_id = ? AND status = 'authorized'",
            grant.grantId,
          );
          revokedGrants.push(deepCopy(grant));
          this.journal.append({
            projectId: args.projectId,
            eventType: "approval_grant.revoked",
            aggregateId: grant.grantId,
            actor: args.actor,
            idempotencyKey: args.idempotencyKey,
            data: {
              grantId: grant.grantId,
              reason: grant.revocation.reason,
              invalidatedByInstructionAmendment: true,
            },
            audit: { approvals: [grant] },
          });
        }
        const instruction: InstructionSet = {
          instructionSetId: previous.instructionSetId,
          version: previous.version + 1,
          text: args.text,
          contentHash: hashCanonical(args.text),
          authoredBy: deepCopy(args.actor),
          authoredAt: this.store.now(),
          materialAmendment: Boolean(args.materialAmendment),
          supersedesVersion: previous.version,
          invalidatesApprovalGrantIds: invalidated,
        };
        this.insertInstruction(job.jobId, instruction);
        job.target.instructions = instruction;
        job.updatedAt = instruction.authoredAt;
        this.persistJob(job);
        this.journal.append({
          projectId: args.projectId,
          eventType: "review_job.instructions_amended",
          aggregateId: job.jobId,
          actor: args.actor,
          idempotencyKey: args.idempotencyKey,
          data: {
            instructionSetId: instruction.instructionSetId,
            fromVersion: previous.version,
            toVersion: instruction.version,
            materialAmendment: instruction.materialAmendment,
            invalidatedApprovalGrantIds: invalidated,
            ...(override ? {
              approvalPolicyOverrideId: override.overrideId,
              overriddenRulesApplied: ["M-3"],
            } : {}),
          },
          audit: { instructionSets: [instruction], approvals: revokedGrants },
        });
        return deepCopy(job);
      },
    });
  }

  advanceGeneration(args: {
    projectId: string;
    actor: PrincipalRef;
    expectedGeneration: number;
    newGeneration: number;
    approvalRef: string;
    targetHostId?: string;
    restoreId?: string;
    recoveryHost?: HostRecord;
    recoverySession?: SessionRecord;
    reason: string;
    idempotencyKey: string;
  }): number {
    this.identity.authorize(args.projectId, args.actor, ["owner"]);
    invariant(Boolean(args.recoveryHost) === Boolean(args.recoverySession), "recovery_binding_incomplete");
    requireNonEmptyString(args.approvalRef, "approvalRef", 300);
    requireNonEmptyString(args.reason, "reason", 2000);
    const targetHostId = args.targetHostId ?? args.recoveryHost?.hostId ?? args.actor.hostId;
    requireIdentifier(targetHostId, "targetHostId", "host.");
    return this.store.mutateIdempotent({
      projectId: args.projectId,
      actor: args.actor,
      operation: "project.advance_generation",
      idempotencyKey: args.idempotencyKey,
      request: {
        expectedGeneration: args.expectedGeneration,
        newGeneration: args.newGeneration,
        approvalRef: args.approvalRef,
        targetHostId,
        ...(args.restoreId ? { restoreId: args.restoreId } : {}),
        ...(args.recoveryHost && args.recoverySession ? {
          recoveryHost: args.recoveryHost,
          recoverySession: args.recoverySession,
        } : {}),
        reason: args.reason,
      },
      run: () => {
        this.identity.authorize(args.projectId, args.actor, ["owner"]);
        const project = this.store.get<{ active_generation: number; status: string }>(
          "SELECT active_generation, status FROM projects WHERE project_id = ?",
          args.projectId,
        );
        invariant(project && Number(project.active_generation) === args.expectedGeneration, "generation_precondition_failed");
        invariant(Number.isSafeInteger(args.newGeneration) && args.newGeneration > args.expectedGeneration, "generation_not_monotonic");
        requireIdentifier(args.approvalRef, "approvalRef", "approval.takeover.");
        if (project.status === "read_only") {
          requireIdentifier(args.restoreId, "restoreId", "restore.");
          const restoreRow = this.store.get<{ status: string; manifest_json: string }>(
            "SELECT status, manifest_json FROM restore_manifests WHERE restore_id = ? AND project_id = ?",
            args.restoreId,
            args.projectId,
          );
          invariant(restoreRow?.status === "completed", "completed_restore_required_for_recovery_takeover");
          const restore = JSON.parse(restoreRow.manifest_json) as {
            restoreId: string;
            projectId: string;
            status: string;
            mode?: string;
            targetHostId: string;
            expectedSourceGeneration: number;
            requestedBy?: PrincipalRef;
            takeover?: { mode?: string };
          };
          invariant(
            restore.restoreId === args.restoreId && restore.projectId === args.projectId && restore.status === "completed" &&
            restore.targetHostId === targetHostId && restore.expectedSourceGeneration === args.expectedGeneration,
            "restore_takeover_binding_mismatch",
          );
          invariant(
            (restore.mode === "new_host" || restore.mode === "replace_local") && restore.takeover?.mode === "no_takeover",
            "restore_mode_not_activatable",
          );
          if (args.recoveryHost && args.recoverySession) {
            invariant(restore.mode === "new_host", "recovery_binding_requires_new_host_restore");
            invariant(restore.requestedBy?.principalId === args.actor.principalId, "restore_requesting_owner_mismatch");
            invariant(targetHostId === args.recoveryHost.hostId, "recovery_target_host_mismatch");
            this.identity.insertRecoveryBindingWithinTakeover({
              projectId: args.projectId,
              authorizedOwner: args.actor,
              host: args.recoveryHost,
              session: args.recoverySession,
            });
          } else {
            invariant(targetHostId === args.actor.hostId, "takeover_target_host_actor_mismatch");
          }
          invariant(
            this.store.get("SELECT 1 AS present FROM hosts WHERE host_id = ? AND status = 'active'", targetHostId),
            "takeover_target_host_not_active",
          );
        } else {
          invariant(project.status === "active", "project_not_takeover_eligible");
          invariant(args.restoreId === undefined, "active_project_restore_binding_forbidden");
          invariant(!args.recoveryHost && !args.recoverySession, "active_project_recovery_binding_forbidden");
          invariant(targetHostId === args.actor.hostId, "takeover_target_host_actor_mismatch");
          invariant(
            this.store.get("SELECT 1 AS present FROM hosts WHERE host_id = ? AND status = 'active'", targetHostId),
            "takeover_target_host_not_active",
          );
        }
        const takeoverClass = project.status === "read_only" ? "restore_activation" : "forced";
        const at = this.store.now();
        const advanced = this.store.run(
          "UPDATE projects SET active_generation = ?, status = 'active', updated_at = ? WHERE project_id = ? AND active_generation = ?",
          args.newGeneration,
          at,
          args.projectId,
          args.expectedGeneration,
        );
        invariant(Number(advanced.changes) === 1, "generation_precondition_failed");
        this.store.run(
          `INSERT INTO generation_takeovers(
            takeover_id, project_id, from_generation, to_generation, approval_ref,
            approved_by_principal_id, approved_by_session_id, approved_by_host_id,
            target_host_id, restore_id, takeover_class, reason, occurred_at
          ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
          newId("takeover"),
          args.projectId,
          args.expectedGeneration,
          args.newGeneration,
          args.approvalRef,
          args.actor.principalId,
          args.actor.sessionId,
          args.actor.hostId,
          targetHostId,
          args.restoreId ?? null,
          takeoverClass,
          args.reason,
          at,
        );
        this.journal.append({
          projectId: args.projectId,
          eventType: "project.generation_advanced",
          aggregateId: args.projectId,
          actor: args.actor,
          idempotencyKey: args.idempotencyKey,
          data: { reason: args.reason },
          audit: {
            outcomes: [{
              outcomeId: args.approvalRef,
              status: "succeeded",
              detailHash: hashCanonical({
                operation: "project.advance_generation",
                projectId: args.projectId,
                fromGeneration: args.expectedGeneration,
                toGeneration: args.newGeneration,
                approvalRef: args.approvalRef,
                targetHostId,
                restoreId: args.restoreId ?? null,
                recoveryBinding: args.recoveryHost && args.recoverySession ? {
                  hostId: args.recoveryHost.hostId,
                  instanceId: args.recoveryHost.instanceId,
                  sessionId: args.recoverySession.sessionId,
                  principalId: args.recoverySession.principalId,
                } : null,
                actor: args.actor,
              }),
              artifactIds: [],
            }],
          },
        });
        return args.newGeneration;
      },
    });
  }

  reconcileTakeover(args: {
    projectId: string;
    actor: PrincipalRef;
    approvalRef: string;
    reportArtifactId: string;
    summary: string;
    idempotencyKey: string;
  }): Record<string, unknown> {
    this.identity.authorize(args.projectId, args.actor, ["owner"]);
    requireIdentifier(args.approvalRef, "approvalRef", "approval.takeover.");
    requireIdentifier(args.reportArtifactId, "reportArtifactId", "artifact.");
    requireNonEmptyString(args.summary, "summary", 4000);
    return this.store.mutateIdempotent({
      projectId: args.projectId,
      actor: args.actor,
      operation: "project.reconcile_takeover",
      idempotencyKey: args.idempotencyKey,
      request: {
        approvalRef: args.approvalRef,
        reportArtifactId: args.reportArtifactId,
        summary: args.summary,
      },
      run: () => {
        this.identity.authorize(args.projectId, args.actor, ["owner"]);
        const takeover = this.store.get<{
          takeover_id: string;
          to_generation: number;
          takeover_class: string;
          occurred_at: string;
        }>(
          `SELECT takeover_id, to_generation, takeover_class, occurred_at
           FROM generation_takeovers WHERE project_id = ? AND approval_ref = ?`,
          args.projectId,
          args.approvalRef,
        );
        invariant(takeover?.takeover_class === "forced", "forced_takeover_not_found");
        invariant(!this.store.get(
          `SELECT 1 AS present FROM runtime_operation_reports
           WHERE project_id = ? AND operation = 'project.reconcile_takeover'
             AND json_extract(report_json, '$.takeoverId') = ?`,
          args.projectId,
          takeover.takeover_id,
        ), "takeover_already_reconciled");
        const artifact = this.artifacts.require(args.reportArtifactId);
        const registeredAt = this.artifacts.registeredAt(args.reportArtifactId);
        invariant(
          artifact.projectId === args.projectId && (artifact.kind === "report" || artifact.kind === "decision"),
          "takeover_reconciliation_report_artifact_required",
        );
        invariant(
          Date.parse(artifact.createdAt) >= Date.parse(takeover.occurred_at) &&
            Date.parse(registeredAt) >= Date.parse(takeover.occurred_at),
          "takeover_reconciliation_report_must_be_later",
        );
        const project = this.store.get<{ active_generation: number }>(
          "SELECT active_generation FROM projects WHERE project_id = ?",
          args.projectId,
        );
        invariant(project && Number(project.active_generation) >= Number(takeover.to_generation), "takeover_reconciliation_generation_mismatch");
        const acceptedAt = this.store.now();
        const report = {
          reportId: newId("runtime.report"),
          operation: "project.reconcile_takeover",
          outcome: "accepted",
          projectId: args.projectId,
          actor: deepCopy(args.actor),
          generation: Number(project.active_generation),
          acceptedAt,
          takeoverId: takeover.takeover_id,
          approvalRef: args.approvalRef,
          takeoverGeneration: Number(takeover.to_generation),
          reportArtifactId: args.reportArtifactId,
          summary: args.summary,
        };
        this.store.run(
          `INSERT INTO runtime_operation_reports(
            report_id, project_id, operation, principal_id, session_id, host_id,
            generation, occurred_at, report_json
          ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`,
          report.reportId,
          args.projectId,
          report.operation,
          args.actor.principalId,
          args.actor.sessionId,
          args.actor.hostId,
          report.generation,
          acceptedAt,
          JSON.stringify(report),
        );
        return deepCopy(report);
      },
    });
  }

  assertActiveClaim(projectId: string, jobId: string, actor: PrincipalRef, claim: JobClaim | ClaimToken): ReviewJob {
    const job = this.requireForProject(projectId, jobId);
    invariant(job.claim, "active_claim_required");
    this.identity.authorize(projectId, actor, [job.requiredRole]);
    const project = this.store.get<{ active_generation: number }>("SELECT active_generation FROM projects WHERE project_id = ?", projectId);
    invariant(project, "project_not_found");
    invariant(job.claim.claimId === claim.claimId, "stale_fencing_token");
    invariant(job.claim.generation === claim.generation && job.claim.generation === Number(project.active_generation), "stale_fencing_token");
    invariant(job.claim.fencingToken === claim.fencingToken, "stale_fencing_token");
    invariant(canonicalEqual(job.claim.claimedBy, actor), "actor_not_claimant");
    invariant(Date.parse(job.claim.leaseExpiresAt) > Date.parse(this.store.now()), "claim_expired");
    const row = this.store.get<{ status: string }>("SELECT status FROM job_claims WHERE claim_id = ?", job.claim.claimId);
    invariant(row?.status === "active", "claim_not_active");
    return job;
  }

  get(jobId: string): ReviewJob | undefined {
    const row = this.store.get<{
      job_id: string;
      project_id: string;
      status: string;
      requested_by_principal_id: string;
      requested_by_session_id: string;
      requested_by_host_id: string;
      required_role: string;
      instruction_set_id: string;
      instruction_version: number;
      approval_policy_override_id: string | null;
      document_json: string;
    }>(
      `SELECT job_id, project_id, status, requested_by_principal_id, requested_by_session_id,
              requested_by_host_id, required_role, instruction_set_id, instruction_version,
              approval_policy_override_id, document_json
       FROM review_jobs WHERE job_id = ?`,
      jobId,
    );
    if (!row) return undefined;
    const job = JSON.parse(row.document_json) as ReviewJob;
    this.schemas.validateNamed("review-job.schema.json", job);
    invariant(
      job.jobId === row.job_id && job.projectId === row.project_id && job.status === row.status &&
      job.requestedBy.principalId === row.requested_by_principal_id &&
      job.requestedBy.sessionId === row.requested_by_session_id &&
      job.requestedBy.hostId === row.requested_by_host_id && job.requiredRole === row.required_role &&
      job.target.instructions.instructionSetId === row.instruction_set_id &&
      job.target.instructions.version === Number(row.instruction_version),
      "job_relational_document_mismatch",
    );
    const override = job.approvalPolicyOverride;
    invariant((override?.overrideId ?? null) === row.approval_policy_override_id, "job_override_relational_mismatch");
    if (override) {
      const persisted = this.store.get<{ document_json: string }>(
        "SELECT document_json FROM approval_policy_overrides WHERE override_id = ? AND job_id = ?",
        override.overrideId,
        job.jobId,
      );
      invariant(persisted && canonicalEqual(JSON.parse(persisted.document_json), override), "job_override_relational_mismatch");
      invariant(override.scope.jobId === job.jobId && canonicalEqual(override.invokedBy, job.requestedBy), "job_override_cross_field_mismatch");
      invariant(
        this.identity.hadRoleAt(job.projectId, override.invokedBy.principalId, "owner", override.invokedAt),
        "owner_policy_override_required",
      );
    }
    return job;
  }

  require(jobId: string): ReviewJob {
    const job = this.get(jobId);
    invariant(job, "job_not_found", { jobId });
    return job;
  }

  requireForProject(projectId: string, jobId: string): ReviewJob {
    const job = this.require(jobId);
    invariant(job.projectId === projectId, "job_project_mismatch");
    return job;
  }

  list(projectId: string): ReviewJob[] {
    return this.store.all<{ document_json: string }>(
      "SELECT document_json FROM review_jobs WHERE project_id = ? ORDER BY created_at, job_id",
      projectId,
    ).map((row) => JSON.parse(row.document_json) as ReviewJob);
  }

  private claimedTransition(
    args: ClaimedMutation,
    from: JobStatus[],
    to: JobStatus,
    eventType: "review_job.started" | "review_job.input_requested" | "review_job.input_resumed",
    data: Record<string, unknown>,
    beforePersist?: () => void,
    extraRequest: Record<string, unknown> = {},
  ): ReviewJob {
    this.identity.authorize(args.projectId, args.actor, [this.requireForProject(args.projectId, args.jobId).requiredRole]);
    return this.store.mutateIdempotent({
      projectId: args.projectId,
      actor: args.actor,
      operation: eventType,
      idempotencyKey: args.idempotencyKey,
      request: { jobId: args.jobId, claim: token(args.claim), ...data, ...extraRequest },
      run: () => {
        const job = this.assertActiveClaim(args.projectId, args.jobId, args.actor, args.claim);
        invariant(from.includes(job.status), "invalid_transition");
        beforePersist?.();
        job.status = to;
        job.updatedAt = this.store.now();
        this.persistJob(job);
        this.journal.append({
          projectId: args.projectId,
          eventType,
          aggregateId: job.jobId,
          actor: args.actor,
          idempotencyKey: args.idempotencyKey,
          data,
          audit: { instructionSets: [job.target.instructions] },
        });
        return deepCopy(job);
      },
    });
  }

  private evaluateIndependence(input: CreateJobInput, at: string): ReviewJob["independence"] {
    const closure = this.artifacts.creatorClosure(input.target.artifactIds);
    const declared = input.independence?.excludedPrincipalIds ?? [];
    requireUniqueStrings(declared, "independence.excludedPrincipalIds");
    let policy = input.independence?.policy ?? (input.mode === "independent_review" ? "required" : "not_required");
    if (input.mode === "independent_review") invariant(input.requiredRole === "reviewer" && policy !== "not_required", "independent_review_policy_required");
    if (input.mode === "collaboration") invariant(policy === "not_required", "collaboration_independence_policy_invalid");
    const independence: ReviewJob["independence"] = {
      policy,
      excludedPrincipalIds: [...new Set([...declared, ...closure.principalIds])].sort(),
      provenanceArtifactIds: closure.artifactIds,
      evaluatedBy: deepCopy(input.actor),
      evaluatedAt: at,
    };
    if (policy === "waived_by_owner") {
      const reason = input.independence?.waiverReason;
      const artifactId = input.independence?.waiverApprovalArtifactId;
      requireNonEmptyString(reason, "waiverReason", 1000);
      requireIdentifier(artifactId, "waiverApprovalArtifactId", "artifact.");
      const artifact = this.artifacts.require(artifactId);
      const registeredAt = this.artifacts.registeredAt(artifactId);
      invariant(
        artifact.projectId === input.projectId && artifact.kind === "decision" &&
        this.identity.hadRoleAt(input.projectId, artifact.createdBy.principalId, "owner", registeredAt),
        "owner_waiver_artifact_required",
      );
      independence.waiverReason = reason;
      independence.waiverApprovalArtifactId = artifactId;
    }
    return independence;
  }

  private reevaluateIndependence(job: ReviewJob, evaluator: PrincipalRef): ReviewJob["independence"] {
    const closure = this.artifacts.creatorClosure(job.target.artifactIds);
    const priorDerived = new Set(job.independence.provenanceArtifactIds.flatMap((artifactId) => {
      const artifact = this.artifacts.get(artifactId);
      return artifact ? [artifact.createdBy.principalId] : [];
    }));
    const declared = job.independence.excludedPrincipalIds.filter((principalId) => !priorDerived.has(principalId));
    const result = {
      ...deepCopy(job.independence),
      excludedPrincipalIds: [...new Set([...declared, ...closure.principalIds])].sort(),
      provenanceArtifactIds: closure.artifactIds,
      evaluatedBy: deepCopy(evaluator),
      evaluatedAt: this.store.now(),
    };
    if (result.policy === "waived_by_owner") {
      const waiver = this.artifacts.require(result.waiverApprovalArtifactId!);
      const registeredAt = this.artifacts.registeredAt(waiver.artifactId);
      invariant(
        waiver.projectId === job.projectId && waiver.kind === "decision" &&
        this.identity.hadRoleAt(job.projectId, waiver.createdBy.principalId, "owner", registeredAt),
        "owner_waiver_artifact_required",
      );
    }
    return result;
  }

  private buildOverride(projectId: string, jobId: string, actor: PrincipalRef, at: string, reason: string): ApprovalPolicyOverride {
    this.identity.authorize(projectId, actor, ["owner"]);
    requireNonEmptyString(reason, "approvalPolicyOverride.reason", 2000);
    return {
      overrideId: newId("policy_override"),
      invokedBy: deepCopy(actor),
      invokedAt: at,
      reason,
      scope: { jobId, overriddenRules: [...OVERRIDDEN_RULES] },
      immutableAfterCreation: true,
      nonRetroactive: true,
      preservedControls: [...PRESERVED_OVERRIDE_CONTROLS],
    };
  }

  private validateCreateAuthorization(input: CreateJobInput): void {
    if (input.mode === "independent_review" || input.approvalPolicyOverride) {
      this.identity.authorize(input.projectId, input.actor, ["owner"]);
    } else {
      this.identity.authorize(input.projectId, input.actor, ["owner", "collaborator"]);
    }
    if (input.approvalPolicyOverride) invariant(this.identity.hasRole(input.projectId, input.actor.principalId, "owner"), "owner_policy_override_required");
  }

  private authorizeOrchestrator(projectId: string, jobId: string, actor: PrincipalRef): void {
    const job = this.requireForProject(projectId, jobId);
    if (job.mode === "independent_review") this.identity.authorize(projectId, actor, ["owner"]);
    else this.identity.authorize(projectId, actor, ["owner", "collaborator"]);
  }

  private authorizeCancellation(projectId: string, jobId: string, actor: PrincipalRef): void {
    const job = this.requireForProject(projectId, jobId);
    const auth = this.identity.authorize(projectId, actor);
    invariant(job.requestedBy.principalId === actor.principalId || auth.roles.includes("owner"), "cancellation_not_authorized");
  }

  private insertJob(job: ReviewJob): void {
    this.schemas.validateNamed("review-job.schema.json", job);
    this.store.run(
      `INSERT INTO review_jobs(
        job_id, project_id, mode, status, requested_by_principal_id, requested_by_session_id, requested_by_host_id,
        required_role, instruction_set_id, instruction_version, approval_policy_override_id, attempt,
        created_at, updated_at, document_json
      ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      job.jobId,
      job.projectId,
      job.mode,
      job.status,
      job.requestedBy.principalId,
      job.requestedBy.sessionId,
      job.requestedBy.hostId,
      job.requiredRole,
      job.target.instructions.instructionSetId,
      job.target.instructions.version,
      job.approvalPolicyOverride?.overrideId ?? null,
      job.attempt,
      job.createdAt,
      job.updatedAt,
      JSON.stringify(job),
    );
  }

  private persistJob(job: ReviewJob): void {
    this.schemas.validateNamed("review-job.schema.json", job);
    this.store.run(
      `UPDATE review_jobs SET
        status = ?, instruction_version = ?, attempt = ?, active_claim_id = ?, active_generation = ?,
        active_fencing_token = ?, lease_expires_at = ?, updated_at = ?, document_json = ?
       WHERE job_id = ?`,
      job.status,
      job.target.instructions.version,
      job.attempt,
      job.claim?.claimId ?? null,
      job.claim?.generation ?? null,
      job.claim?.fencingToken ?? null,
      job.claim?.leaseExpiresAt ?? null,
      job.updatedAt,
      JSON.stringify(job),
      job.jobId,
    );
  }

  private insertInstruction(jobId: string, instruction: InstructionSet): void {
    this.store.run(
      `INSERT INTO job_instructions(
        job_id, instruction_set_id, version, content_hash, text,
        authored_by_principal_id, authored_by_session_id, authored_by_host_id, authored_at,
        material_amendment, supersedes_version, invalidated_grant_ids_json, document_json
      ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      jobId,
      instruction.instructionSetId,
      instruction.version,
      instruction.contentHash,
      instruction.text,
      instruction.authoredBy.principalId,
      instruction.authoredBy.sessionId,
      instruction.authoredBy.hostId,
      instruction.authoredAt,
      instruction.materialAmendment ? 1 : 0,
      instruction.supersedesVersion ?? null,
      JSON.stringify(instruction.invalidatesApprovalGrantIds),
      JSON.stringify(instruction),
    );
  }

}

interface ClaimedMutation {
  projectId: string;
  jobId: string;
  actor: PrincipalRef;
  claim: JobClaim | ClaimToken;
  idempotencyKey: string;
}

function token(claim: JobClaim | ClaimToken): ClaimToken {
  return { claimId: claim.claimId, generation: claim.generation, fencingToken: claim.fencingToken };
}

function omitInvocationContext<T extends { actor: PrincipalRef; idempotencyKey: string }>(
  input: T,
): Omit<T, "actor" | "idempotencyKey"> {
  return Object.fromEntries(
    Object.entries(input).filter(([key]) => key !== "actor" && key !== "idempotencyKey"),
  ) as Omit<T, "actor" | "idempotencyKey">;
}
