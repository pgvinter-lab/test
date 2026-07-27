import { canonicalEqual, deepCopy, hashCanonical } from "../core/canonical.js";
import { CONTRACT_VERSION } from "../core/constants.js";
import { invariant } from "../core/errors.js";
import { newId } from "../core/ids.js";
import {
  rejectInlineCredentialField,
  rejectInlineCredentialMaterial,
  requireIdentifier,
  requireNonEmptyString,
  requireTimestamp,
  requireUriReference,
  requireUniqueStrings,
} from "../core/validation.js";
import type {
  ApprovalCondition,
  ApprovalGrant,
  Citation,
  JobClaim,
  PrincipalRef,
  ReviewJob,
} from "../core/types.js";
import type { AdapterRegistry } from "../adapters/adapter-registry.js";
import type { IdentityService } from "../identity/identity-service.js";
import type { EventJournal } from "../storage/journal.js";
import type { BridgeStore } from "../storage/store.js";
import type { ClaimToken, JobService } from "./job-service.js";
import type { ContractSchemaRegistry } from "../core/schema-registry.js";
import { assertRelationalCitations } from "../artifacts/artifact-service.js";
import type { DirtyBackupGrantConsumption } from "../recovery/backup-service.js";

export interface CreateGrantInput {
  projectId: string;
  jobId: string;
  actor: PrincipalRef;
  grantedTo: PrincipalRef;
  claim: JobClaim | ClaimToken;
  adapterIds: string[];
  actions: string[];
  conditions: ApprovalCondition[];
  destinations: string[];
  origins: string[];
  sideEffectClasses: Array<"read_only" | "local_write" | "external_reversible" | "external_irreversible">;
  approvalPromptClasses?: string[];
  expiresAt: string;
  maxUses: number;
  idempotencyKey: string;
}

export interface AuthorizationDecision {
  actionId: string;
  decision: "allow" | "ask" | "deny";
  reason: string;
  approvalGrantId?: string;
  approvalPolicyOverrideId?: string;
  overriddenRulesApplied?: Array<"M-3" | "L-4">;
}

export interface AuthorizeAdapterActionInput {
  projectId: string;
  jobId: string;
  actor: PrincipalRef;
  claim: JobClaim | ClaimToken;
  adapterId: string;
  operation: string;
  origin: string;
  destination: string;
  conditions: Record<string, string | number | boolean>;
  inputArtifactIds: string[];
  parameters: unknown;
  approvalPromptClass?: string;
  citations?: Citation[];
  idempotencyKey: string;
}

export class ApprovalService {
  constructor(
    private readonly store: BridgeStore,
    private readonly identity: IdentityService,
    private readonly jobs: JobService,
    private readonly adapters: AdapterRegistry,
    private readonly journal: EventJournal,
    private readonly schemas: ContractSchemaRegistry,
  ) {}

  createGrant(input: CreateGrantInput): ApprovalGrant {
    return this.store.mutateIdempotent({
      projectId: input.projectId,
      actor: input.actor,
      operation: "approval_grant.create",
      idempotencyKey: input.idempotencyKey,
      request: omitInvocationContext(input),
      run: () => {
        this.identity.authorize(input.projectId, input.actor, ["owner"]);
        this.validateGrantInput(input);
        const job = this.jobs.assertActiveClaim(input.projectId, input.jobId, input.grantedTo, input.claim);
        invariant(canonicalEqual(job.claim!.claimedBy, input.grantedTo), "approval_subject_not_claimant");
        const at = this.store.now();
        const grant: ApprovalGrant = {
          schemaVersion: CONTRACT_VERSION,
          grantId: newId("approval"),
          projectId: input.projectId,
          status: "active",
          grantedBy: deepCopy(input.actor),
          grantedTo: deepCopy(input.grantedTo),
          requiredRole: job.requiredRole,
          grantedAt: at,
          expiresAt: input.expiresAt,
          scope: {
            jobId: input.jobId,
            adapterIds: [...input.adapterIds],
            actions: [...input.actions],
            conditions: deepCopy(input.conditions),
            destinations: [...input.destinations],
            origins: [...input.origins],
            sideEffectClasses: [...input.sideEffectClasses],
            approvalPromptClasses: [...(input.approvalPromptClasses ?? [])],
            maxUses: input.maxUses,
          },
          claimBinding: {
            claimId: input.claim.claimId,
            generation: input.claim.generation,
            fencingToken: input.claim.fencingToken,
          },
          instructionBinding: {
            instructionSetId: job.target.instructions.instructionSetId,
            version: job.target.instructions.version,
            contentHash: job.target.instructions.contentHash,
          },
          usesConsumed: 0,
          defaultOnNoMatch: "ask",
        };
        this.schemas.validateNamed("approval-grant.schema.json", grant);
        this.store.run(
          `INSERT INTO approval_grants(
            grant_id, project_id, job_id, status, granted_to_principal_id, claim_id,
            instruction_version, uses_consumed, expires_at, document_json, created_at, updated_at
          ) VALUES (?, ?, ?, 'active', ?, ?, ?, 0, ?, ?, ?, ?)`,
          grant.grantId,
          input.projectId,
          input.jobId,
          input.grantedTo.principalId,
          input.claim.claimId,
          grant.instructionBinding.version,
          input.expiresAt,
          JSON.stringify(grant),
          at,
          at,
        );
        this.journal.append({
          projectId: input.projectId,
          eventType: "approval_grant.created",
          aggregateId: grant.grantId,
          actor: input.actor,
          idempotencyKey: input.idempotencyKey,
          data: {
            grantId: grant.grantId,
            jobId: input.jobId,
            actions: [...input.actions],
            expiresAt: input.expiresAt,
            maxUses: input.maxUses,
          },
          audit: { approvals: [grant] },
        });
        return deepCopy(grant);
      },
    });
  }

  revoke(args: {
    projectId: string;
    grantId: string;
    actor: PrincipalRef;
    reason: string;
    idempotencyKey: string;
  }): ApprovalGrant {
    this.identity.authorize(args.projectId, args.actor, ["owner"]);
    requireNonEmptyString(args.reason, "reason", 2000);
    return this.store.mutateIdempotent({
      projectId: args.projectId,
      actor: args.actor,
      operation: "approval_grant.revoke",
      idempotencyKey: args.idempotencyKey,
      request: { grantId: args.grantId, reason: args.reason },
      run: () => {
        this.identity.authorize(args.projectId, args.actor, ["owner"]);
        const grant = this.require(args.grantId);
        invariant(grant.projectId === args.projectId && grant.status === "active", "approval_grant_not_active");
        grant.status = "revoked";
        grant.revocation = { revokedAt: this.store.now(), revokedBy: deepCopy(args.actor), reason: args.reason };
        this.persist(grant);
        this.store.run(
          "UPDATE adapter_action_authorizations SET status = 'revoked' WHERE approval_grant_id = ? AND status = 'authorized'",
          grant.grantId,
        );
        this.journal.append({
          projectId: args.projectId,
          eventType: "approval_grant.revoked",
          aggregateId: grant.grantId,
          actor: args.actor,
          idempotencyKey: args.idempotencyKey,
          data: { grantId: grant.grantId, reason: args.reason, invalidatedByInstructionAmendment: false },
          audit: { approvals: [grant] },
        });
        return deepCopy(grant);
      },
    });
  }

  authorizeBrowserAction(args: AuthorizeAdapterActionInput): AuthorizationDecision {
    return this.authorizeAdapterActionMutation(args, "browser.authorize_action", true);
  }

  authorizeAdapterAction(args: AuthorizeAdapterActionInput): AuthorizationDecision {
    return this.authorizeAdapterActionMutation(args, "adapter.authorize_action", false);
  }

  private authorizeAdapterActionMutation(
    args: AuthorizeAdapterActionInput,
    mutationOperation: "browser.authorize_action" | "adapter.authorize_action",
    requireBrowser: boolean,
  ): AuthorizationDecision {
    rejectInlineCredentialMaterial(args.conditions, "conditions");
    requireUriReference(args.origin, "origin");
    requireUriReference(args.destination, "destination");
    return this.store.mutateIdempotent({
      projectId: args.projectId,
      actor: args.actor,
      operation: mutationOperation,
      idempotencyKey: args.idempotencyKey,
      request: {
        jobId: args.jobId,
        claim: claimToken(args.claim),
        adapterId: args.adapterId,
        operation: args.operation,
        origin: args.origin,
        destination: args.destination,
        conditions: args.conditions,
        inputArtifactIds: args.inputArtifactIds,
        parameters: args.parameters,
        ...(args.approvalPromptClass ? { approvalPromptClass: args.approvalPromptClass } : {}),
        citations: args.citations ?? [],
      },
      run: () => {
        const job = this.jobs.assertActiveClaim(args.projectId, args.jobId, args.actor, args.claim);
        assertRelationalCitations(this.store, this.identity, args.citations ?? [], args.projectId, true);
        const currentManifest = this.adapters.require(args.adapterId);
        const currentOperation = currentManifest.operations[args.operation];
        invariant(currentOperation, "adapter_operation_not_declared");
        invariant(currentManifest.security.approvalPolicy.preapproval === "bounded_grants", "adapter_bounded_grants_disabled");
        const requestBinding = this.validateAdapterRequest(job, currentManifest, args);
        if (requireBrowser) invariant(currentManifest.kind === "browser", "browser_authorization_requires_browser_adapter");
        invariant(
          currentManifest.kind === "browser" || currentOperation.sideEffectClass !== "read_only" || requestBinding.sensitiveExternal,
          "adapter_authorization_not_required",
        );
        const at = this.store.now();
        const candidates = this.store.all<{ document_json: string }>(
          "SELECT document_json FROM approval_grants WHERE job_id = ? AND status = 'active' ORDER BY grant_id",
          args.jobId,
        ).map((row) => JSON.parse(row.document_json) as ApprovalGrant);
        const grant = candidates.find((candidate) => this.matches(candidate, job, args, currentManifest.security.networkAccess, currentOperation.sideEffectClass, at));
        const actionId = newId("action");
        const rules = grant ? this.overriddenRulesApplied(grant, job, args.conditions) : [];
        const overrideAudit = rules.length > 0
          ? { approvalPolicyOverrideId: job.approvalPolicyOverride!.overrideId, overriddenRulesApplied: rules }
          : {};
        const decision = grant ? "allow" as const : "ask" as const;
        const reason = grant ? "bounded_approval_grant_matched" : "no_exact_active_grant";
        const action = {
          actionId,
          adapterId: args.adapterId,
          operation: args.operation,
          sideEffectClass: currentOperation.sideEffectClass,
          origin: args.origin,
          destination: args.destination,
          conditionHash: hashCanonical(args.conditions),
          ...(args.approvalPromptClass ? { approvalPromptClass: args.approvalPromptClass } : {}),
          authorizationDecision: decision,
          ...(grant ? { approvalGrantId: grant.grantId } : {}),
          ...overrideAudit,
        };
        const outcome = {
          outcomeId: newId("outcome"),
          status: grant ? "authorized" : "approval_required",
          detailHash: hashCanonical(reason),
          artifactIds: [],
        };
        if (grant) {
          grant.usesConsumed += 1;
          this.persist(grant);
          const expiresAt = new Date(Math.min(Date.parse(grant.expiresAt), Date.parse(job.claim!.leaseExpiresAt))).toISOString();
          this.store.run(
            `INSERT INTO adapter_action_authorizations(
              action_id, project_id, job_id, approval_grant_id, principal_id, session_id, host_id,
              claim_id, generation, fencing_token, adapter_id, adapter_version, operation,
              side_effect_class, origin, destination, condition_hash, request_hash,
              input_artifact_ids_json, sensitive_external, approval_prompt_class, status, authorized_at, expires_at
            ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 'authorized', ?, ?)`,
            actionId,
            args.projectId,
            args.jobId,
            grant.grantId,
            args.actor.principalId,
            args.actor.sessionId,
            args.actor.hostId,
            args.claim.claimId,
            args.claim.generation,
            args.claim.fencingToken,
            args.adapterId,
            currentManifest.adapterVersion,
            args.operation,
            currentOperation.sideEffectClass,
            args.origin,
            args.destination,
            hashCanonical(args.conditions),
            requestBinding.requestHash,
            JSON.stringify(args.inputArtifactIds),
            requestBinding.sensitiveExternal ? 1 : 0,
            args.approvalPromptClass ?? null,
            at,
            expiresAt,
          );
          this.journal.append({
            projectId: args.projectId,
            eventType: "approval_grant.consumed",
            aggregateId: grant.grantId,
            actor: args.actor,
            idempotencyKey: args.idempotencyKey,
            data: { grantId: grant.grantId, actionId, useNumber: grant.usesConsumed, ...overrideAudit },
            audit: { approvals: [grant], actions: [action], outcomes: [outcome], citations: args.citations ?? [] },
          });
          if (grant.usesConsumed >= grant.scope.maxUses) {
            grant.status = "exhausted";
            this.persist(grant);
            this.journal.append({
              projectId: args.projectId,
              eventType: "approval_grant.exhausted",
              aggregateId: grant.grantId,
              actor: args.actor,
              idempotencyKey: args.idempotencyKey,
              data: { grantId: grant.grantId, usesConsumed: grant.usesConsumed },
              audit: { approvals: [grant] },
            });
          }
        }
        if (currentManifest.kind === "browser") {
          this.journal.append({
            projectId: args.projectId,
            eventType: "browser.authorization_decided",
            aggregateId: actionId,
            actor: args.actor,
            idempotencyKey: args.idempotencyKey,
            data: {
              actionId,
              jobId: args.jobId,
              adapterId: args.adapterId,
              operation: args.operation,
              origin: args.origin,
              destination: args.destination,
              sideEffectClass: currentOperation.sideEffectClass,
              decision,
              reason,
              ...(grant ? { approvalGrantId: grant.grantId } : {}),
              ...overrideAudit,
            },
            audit: {
              approvals: grant ? [grant] : [],
              actions: [action],
              outcomes: [outcome],
              citations: args.citations ?? [],
            },
          });
        }
        return {
          actionId,
          decision,
          reason,
          ...(grant ? { approvalGrantId: grant.grantId } : {}),
          ...overrideAudit,
        };
      },
    });
  }

  get(grantId: string): ApprovalGrant | undefined {
    return this.store.readDocument<ApprovalGrant>("approval_grants", "grant_id", grantId);
  }

  require(grantId: string): ApprovalGrant {
    const grant = this.get(grantId);
    invariant(grant, "approval_grant_not_found", { grantId });
    return grant;
  }

  consumeDirtyBackupGrant(input: DirtyBackupGrantConsumption): void {
    this.store.assertWriteTransaction();
    this.identity.authorize(input.projectId, input.actor, ["owner"]);
    invariant(input.action === "backup.source_only.dirty", "dirty_backup_action_mismatch");
    invariant(
      Object.keys(input.conditions).length === 1 && input.conditions.backupId === input.backupId,
      "dirty_backup_condition_mismatch",
    );
    const row = this.store.get<{
      project_id: string;
      job_id: string;
      status: string;
      granted_to_principal_id: string;
      claim_id: string;
      instruction_version: number;
      uses_consumed: number;
      expires_at: string;
    }>(
      `SELECT project_id, job_id, status, granted_to_principal_id, claim_id,
              instruction_version, uses_consumed, expires_at
       FROM approval_grants WHERE grant_id = ?`,
      input.approvalGrantId,
    );
    invariant(row, "owner_exception_approval_grant_not_found");
    const grant = this.require(input.approvalGrantId);
    invariant(
      row.project_id === input.projectId && row.job_id === grant.scope.jobId && row.status === grant.status &&
      row.granted_to_principal_id === grant.grantedTo.principalId && row.claim_id === grant.claimBinding.claimId &&
      Number(row.instruction_version) === grant.instructionBinding.version &&
      Number(row.uses_consumed) === grant.usesConsumed && row.expires_at === grant.expiresAt,
      "approval_grant_relational_document_mismatch",
    );
    invariant(
      grant.projectId === input.projectId && grant.status === "active" &&
      Date.parse(grant.expiresAt) > Date.parse(this.store.now()) && grant.usesConsumed < grant.scope.maxUses &&
      canonicalEqual(grant.grantedBy, input.actor) && canonicalEqual(grant.grantedTo, input.actor),
      "dirty_source_owner_exception_not_active",
    );
    invariant(
      grant.scope.actions.length === 1 && grant.scope.actions[0] === input.action &&
      grant.scope.conditions.length === 1 && grant.scope.conditions[0]?.name === "backupId" &&
      grant.scope.conditions[0]?.operator === "equals" && grant.scope.conditions[0]?.value === input.backupId,
      "dirty_backup_grant_scope_mismatch",
    );
    const job = this.jobs.assertActiveClaim(input.projectId, grant.scope.jobId, input.actor, grant.claimBinding);
    invariant(this.instructionBindingMatches(grant, job), "dirty_backup_instruction_binding_stale");
    const overriddenRulesApplied = this.overriddenRulesApplied(grant, job, input.conditions);
    const overrideAudit = overriddenRulesApplied.length > 0
      ? {
          approvalPolicyOverrideId: job.approvalPolicyOverride!.overrideId,
          overriddenRulesApplied,
        }
      : {};

    const actionId = newId("action");
    grant.usesConsumed += 1;
    this.persist(grant);
    this.journal.append({
      projectId: input.projectId,
      eventType: "approval_grant.consumed",
      aggregateId: grant.grantId,
      actor: input.actor,
      data: { grantId: grant.grantId, actionId, useNumber: grant.usesConsumed, ...overrideAudit },
      audit: { approvals: [grant] },
    });
    if (grant.usesConsumed >= grant.scope.maxUses) {
      grant.status = "exhausted";
      this.persist(grant);
      this.journal.append({
        projectId: input.projectId,
        eventType: "approval_grant.exhausted",
        aggregateId: grant.grantId,
        actor: input.actor,
        data: { grantId: grant.grantId, usesConsumed: grant.usesConsumed },
        audit: { approvals: [grant] },
      });
    }
  }

  private validateGrantInput(input: CreateGrantInput): void {
    requireTimestamp(input.expiresAt, "expiresAt");
    invariant(Date.parse(input.expiresAt) > Date.parse(this.store.now()), "invalid_approval_duration");
    invariant(Number.isSafeInteger(input.maxUses) && input.maxUses >= 1 && input.maxUses <= 10_000, "invalid_use_limit");
    for (const [name, values] of Object.entries({
      adapterIds: input.adapterIds,
      actions: input.actions,
      destinations: input.destinations,
      origins: input.origins,
      sideEffectClasses: input.sideEffectClasses,
    })) requireUniqueStrings(values, name, 1);
    requireUniqueStrings(input.approvalPromptClasses ?? [], "approvalPromptClasses");
    invariant(Array.isArray(input.conditions) && input.conditions.length > 0, "approval_scope_unbounded");
    invariant(new Set(input.conditions.map((condition) => condition.name)).size === input.conditions.length, "duplicate_approval_condition");
    for (const condition of input.conditions) {
      requireNonEmptyString(condition.name, "condition.name", 100);
      rejectInlineCredentialField(condition.name, `conditions.${condition.name}`);
      if (condition.operator === "equals") invariant(!Array.isArray(condition.value), "invalid_equals_condition");
      else invariant(Array.isArray(condition.value) && condition.value.length > 0, "invalid_one_of_condition");
    }
    const manifests = input.adapterIds.map((adapterId) => this.adapters.require(adapterId));
    for (const endpoint of [...input.origins, ...input.destinations]) requireUriReference(endpoint, "approval.endpoint");
    for (const manifest of manifests) {
      invariant(manifest.security.approvalPolicy.preapproval === "bounded_grants", "adapter_bounded_grants_disabled");
      const endpoints = [...input.origins, ...input.destinations];
      invariant(
        manifest.security.networkAccess.length > 0
          ? endpoints.every((uri) => manifest.security.networkAccess.includes(uri))
          : endpoints.every((uri) => /^(?:bridge|file|local):/u.test(uri)),
        "approval_scope_outside_adapter_allowlist",
      );
    }
    for (const action of input.actions) {
      const definitions = manifests.map((manifest) => manifest.operations[action]).filter(Boolean);
      invariant(definitions.length > 0, "approval_action_not_declared");
      invariant(definitions.every((definition) => input.sideEffectClasses.includes(definition.sideEffectClass)), "approval_side_effect_class_mismatch");
    }
  }

  private validateAdapterRequest(
    job: ReviewJob,
    manifest: ReturnType<AdapterRegistry["require"]>,
    input: Pick<AuthorizeAdapterActionInput, "actor" | "operation" | "inputArtifactIds" | "parameters">,
  ): { requestHash: string; sensitiveExternal: boolean } {
    requireUniqueStrings(input.inputArtifactIds, "inputArtifactIds");
    this.adapters.validateOperationInput(manifest, input.operation, input.parameters);
    const attached = this.store.all<{ artifact_id: string }>(
      "SELECT artifact_id FROM job_inputs WHERE job_id = ?",
      job.jobId,
    ).map((row) => row.artifact_id);
    const permitted = new Set([...job.target.artifactIds, ...attached]);
    let containsSensitive = false;
    for (const artifactId of input.inputArtifactIds) {
      const artifact = this.store.get<{ project_id: string; sensitivity: string }>(
        "SELECT project_id, sensitivity FROM artifacts WHERE artifact_id = ?",
        artifactId,
      );
      invariant(artifact?.project_id === job.projectId, "adapter_input_artifact_not_found");
      invariant(permitted.has(artifactId), "adapter_input_artifact_not_job_scoped");
      if (artifact.sensitivity === "confidential" || artifact.sensitivity === "restricted") containsSensitive = true;
    }
    if (containsSensitive) {
      invariant(manifest.security.sensitiveData !== "forbidden", "adapter_sensitive_data_forbidden");
      if (manifest.security.networkAccess.length > 0) {
        invariant(manifest.security.sensitiveData !== "local_only", "adapter_sensitive_data_local_only");
      }
    }
    return {
      requestHash: hashCanonical({ inputArtifactIds: input.inputArtifactIds, parameters: input.parameters }),
      sensitiveExternal: containsSensitive && manifest.security.networkAccess.length > 0,
    };
  }

  private matches(
    grant: ApprovalGrant,
    job: ReviewJob,
    action: {
      actor: PrincipalRef;
      claim: JobClaim | ClaimToken;
      adapterId: string;
      operation: string;
      origin: string;
      destination: string;
      conditions: Record<string, string | number | boolean>;
      approvalPromptClass?: string;
    },
    allowlist: string[],
    sideEffectClass: string,
    at: string,
  ): boolean {
    if (grant.status !== "active" || grant.usesConsumed >= grant.scope.maxUses || Date.parse(grant.expiresAt) <= Date.parse(at)) return false;
    if (grant.scope.jobId !== job.jobId || !grant.scope.adapterIds.includes(action.adapterId)) return false;
    if (!canonicalEqual(grant.grantedTo, action.actor)) return false;
    if (grant.requiredRole !== job.requiredRole || !this.identity.hasRole(job.projectId, action.actor.principalId, grant.requiredRole)) return false;
    if (
      grant.claimBinding.claimId !== action.claim.claimId ||
      grant.claimBinding.generation !== action.claim.generation ||
      grant.claimBinding.fencingToken !== action.claim.fencingToken
    ) return false;
    if (allowlist.length > 0) {
      if (!allowlist.includes(action.origin) || !allowlist.includes(action.destination)) return false;
    } else if (!/^(?:bridge|file|local):/u.test(action.origin) || !/^(?:bridge|file|local):/u.test(action.destination)) return false;
    if (!grant.scope.actions.includes(action.operation)) return false;
    if (!grant.scope.origins.includes(action.origin) || !grant.scope.destinations.includes(action.destination)) return false;
    if (!grant.scope.sideEffectClasses.includes(sideEffectClass as never)) return false;
    if (grant.scope.approvalPromptClasses.length > 0) {
      if (!action.approvalPromptClass || !grant.scope.approvalPromptClasses.includes(action.approvalPromptClass)) return false;
    } else if (action.approvalPromptClass) return false;
    if (!this.instructionBindingMatches(grant, job)) return false;
    const expectedNames = grant.scope.conditions.map((condition) => condition.name).sort();
    const actualNames = Object.keys(action.conditions).sort();
    const l4 = job.approvalPolicyOverride?.scope.overriddenRules.includes("L-4") ?? false;
    if (!l4 && !canonicalEqual(expectedNames, actualNames)) return false;
    if (l4 && !expectedNames.every((name) => actualNames.includes(name))) return false;
    return grant.scope.conditions.every((condition) => {
      const actual = action.conditions[condition.name];
      return condition.operator === "equals"
        ? actual === condition.value
        : Array.isArray(condition.value) && condition.value.includes(actual);
    });
  }

  private instructionBindingMatches(grant: ApprovalGrant, job: ReviewJob): boolean {
    const current = job.target.instructions;
    const exact = grant.instructionBinding.instructionSetId === current.instructionSetId &&
      grant.instructionBinding.version === current.version &&
      grant.instructionBinding.contentHash === current.contentHash;
    if (exact) return true;
    return Boolean(
      job.approvalPolicyOverride?.scope.overriddenRules.includes("M-3") &&
      grant.instructionBinding.instructionSetId === current.instructionSetId &&
      grant.instructionBinding.version >= 1 &&
      grant.instructionBinding.version < current.version,
    );
  }

  private overriddenRulesApplied(
    grant: ApprovalGrant,
    job: ReviewJob,
    conditions: Record<string, string | number | boolean>,
  ): Array<"M-3" | "L-4"> {
    const rules: Array<"M-3" | "L-4"> = [];
    if (job.approvalPolicyOverride?.scope.overriddenRules.includes("M-3") && !this.currentInstructionBindingMatches(grant, job)) rules.push("M-3");
    const expectedNames = grant.scope.conditions.map((condition) => condition.name).sort();
    const actualNames = Object.keys(conditions).sort();
    if (job.approvalPolicyOverride?.scope.overriddenRules.includes("L-4") && !canonicalEqual(expectedNames, actualNames)) rules.push("L-4");
    return rules;
  }

  private currentInstructionBindingMatches(grant: ApprovalGrant, job: ReviewJob): boolean {
    const current = job.target.instructions;
    return grant.instructionBinding.instructionSetId === current.instructionSetId &&
      grant.instructionBinding.version === current.version &&
      grant.instructionBinding.contentHash === current.contentHash;
  }

  private persist(grant: ApprovalGrant): void {
    this.schemas.validateNamed("approval-grant.schema.json", grant);
    this.store.run(
      `UPDATE approval_grants SET status = ?, uses_consumed = ?, document_json = ?, updated_at = ? WHERE grant_id = ?`,
      grant.status,
      grant.usesConsumed,
      JSON.stringify(grant),
      this.store.now(),
      grant.grantId,
    );
  }
}

function claimToken(claim: JobClaim | ClaimToken): ClaimToken {
  return { claimId: claim.claimId, generation: claim.generation, fencingToken: claim.fencingToken };
}

function omitInvocationContext<T extends { actor: PrincipalRef; idempotencyKey: string }>(
  input: T,
): Omit<T, "actor" | "idempotencyKey"> {
  return Object.fromEntries(
    Object.entries(input).filter(([key]) => key !== "actor" && key !== "idempotencyKey"),
  ) as Omit<T, "actor" | "idempotencyKey">;
}
