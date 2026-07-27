import crypto from "node:crypto";

export const CONTRACT_VERSION = "0.1.0-draft.4";
export const EVENT_HASH_ALGORITHM = "sha256-bridge-cjson-v1";
export const AUDIT_HASH_ALGORITHM = "sha256-bridge-audit-cjson-v1";

function copy(value) {
  return structuredClone(value);
}

export function canonicalize(value) {
  if (value === null || typeof value === "boolean" || typeof value === "number") {
    if (typeof value === "number" && !Number.isFinite(value)) {
      throw new Error("non_finite_number");
    }
    return JSON.stringify(value);
  }
  if (typeof value === "string") return JSON.stringify(value);
  if (Array.isArray(value)) return `[${value.map(canonicalize).join(",")}]`;
  if (typeof value === "object") {
    const keys = Object.keys(value).sort(compareUnicodeCodePoints);
    return `{${keys.map((key) => `${JSON.stringify(key)}:${canonicalize(value[key])}`).join(",")}}`;
  }
  throw new Error("unsupported_json_value");
}

function compareUnicodeCodePoints(left, right) {
  const a = Array.from(left, (character) => character.codePointAt(0));
  const b = Array.from(right, (character) => character.codePointAt(0));
  for (let index = 0; index < Math.min(a.length, b.length); index += 1) {
    if (a[index] !== b[index]) return a[index] - b[index];
  }
  return a.length - b.length;
}

export function hashEvent(event) {
  const { hash: _ignored, ...preimage } = event;
  return crypto.createHash("sha256").update(canonicalize(preimage), "utf8").digest("hex");
}

export function hashAuditMirrorEntry(entry) {
  const { mirrorHash: _ignored, ...preimage } = entry;
  return crypto.createHash("sha256").update(canonicalize(preimage), "utf8").digest("hex");
}

function hashValue(value) {
  return crypto.createHash("sha256").update(canonicalize(value), "utf8").digest("hex");
}

export class MockBridgeClient {
  constructor({
    projectId = "project.demo",
    hostId = "host.demo",
    policyIdentity,
    roleAssignments = {},
    artifacts = [],
    now,
  } = {}) {
    this.projectId = projectId;
    this.hostId = hostId;
    this.policyIdentity = policyIdentity ?? {
      principalId: "principal.policy",
      sessionId: "session.policy.001",
      hostId,
    };
    this.now = now ?? (() => new Date().toISOString());
    this.generation = 1;
    this.sequence = 0;
    this.fencingToken = 0;
    this.idCounter = 0;
    this.jobs = new Map();
    this.events = [];
    this.auditMirror = [];
    this.approvalGrants = new Map();
    this.adapters = new Map();
    this.idempotency = new Map();
    this.roleAssignments = new Map(
      Object.entries(roleAssignments).map(([principalId, roles]) => [principalId, new Set(roles)])
    );
    this.artifacts = new Map();
    for (const artifact of artifacts) this.registerArtifactMetadata(artifact);
  }

  registerArtifactMetadata(artifact) {
    if (!artifact?.artifactId || !artifact?.createdBy?.principalId) {
      throw new Error("invalid_artifact_metadata");
    }
    this.artifacts.set(artifact.artifactId, copy(artifact));
  }

  registerAdapterManifest(adapter) {
    if (!adapter?.adapterId || !Array.isArray(adapter?.security?.networkAccess)) {
      throw new Error("invalid_adapter_manifest");
    }
    this.adapters.set(adapter.adapterId, copy(adapter));
  }

  setRoles(principalId, roles) {
    this.roleAssignments.set(principalId, new Set(roles));
  }

  createReviewJob(input) {
    const jobId = input.jobId ?? this.#id("job");
    if (this.jobs.has(jobId)) throw new Error("job_exists");
    const at = this.now();
    const independence = this.#evaluateIndependence(input, at);
    const instructions = this.#normalizeInitialInstructions(input.target.instructions, input.requestedBy, at);
    const approvalPolicyOverride = this.#normalizeApprovalPolicyOverride(
      input.approvalPolicyOverride,
      input.requestedBy,
      jobId,
      at
    );
    const job = {
      schemaVersion: CONTRACT_VERSION,
      jobId,
      projectId: input.projectId ?? this.projectId,
      mode: input.mode,
      status: "queued",
      requestedBy: copy(input.requestedBy),
      requiredRole: input.requiredRole,
      independence,
      target: {
        contractVersion: CONTRACT_VERSION,
        ...copy(input.target),
        instructions,
      },
      ...(approvalPolicyOverride ? { approvalPolicyOverride } : {}),
      attempt: 0,
      createdAt: at,
      updatedAt: at,
    };
    this.jobs.set(jobId, job);
    this.#emit("review_job.created", jobId, input.requestedBy, {
      mode: job.mode,
      instructionSetId: instructions.instructionSetId,
      instructionVersion: instructions.version,
      ...(approvalPolicyOverride ? { approvalPolicyOverride } : {}),
    }, undefined, { instructionSets: [instructions] });
    return copy(job);
  }

  amendReviewJobInstructions({ jobId, actor, text, materialAmendment, idempotencyKey }) {
    return this.#once({
      key: idempotencyKey,
      actor,
      operation: "amend_instructions",
      request: { jobId, text, materialAmendment },
      run: () => {
        if (!this.#hasRole(actor.principalId, "owner")) throw new Error("owner_approval_required");
        const job = this.#job(jobId);
        if (["completed", "failed", "cancelled"].includes(job.status)) {
          throw new Error("terminal_job_instructions_immutable");
        }
        const previous = job.target.instructions;
        const override = this.#approvalPolicyOverride(job);
        const invalidated = override
          ? []
          : [...this.approvalGrants.values()]
            .filter((grant) => grant.status === "active" && grant.scope.jobId === jobId)
            .map((grant) => grant.grantId)
            .sort();
        for (const grantId of invalidated) {
          this.#revokeGrant({
            grant: this.approvalGrants.get(grantId),
            actor,
            reason: `${materialAmendment ? "Material" : "Non-material"} amendment to ${previous.instructionSetId} version ${previous.version}; exact instruction binding changed.`,
            invalidatedByInstructionAmendment: true,
          });
        }
        const at = this.now();
        const instructions = {
          instructionSetId: previous.instructionSetId,
          version: previous.version + 1,
          text,
          contentHash: hashValue(text),
          authoredBy: copy(actor),
          authoredAt: at,
          materialAmendment: Boolean(materialAmendment),
          supersedesVersion: previous.version,
          invalidatesApprovalGrantIds: invalidated,
        };
        job.target.instructions = instructions;
        job.updatedAt = at;
        const approvals = invalidated.map((grantId) => copy(this.approvalGrants.get(grantId)));
        this.#emit("review_job.instructions_amended", jobId, actor, {
          instructionSetId: instructions.instructionSetId,
          fromVersion: previous.version,
          toVersion: instructions.version,
          materialAmendment: instructions.materialAmendment,
          invalidatedApprovalGrantIds: invalidated,
          ...(override ? {
            approvalPolicyOverrideId: override.overrideId,
            overriddenRulesApplied: ["M-3"],
          } : {}),
        }, idempotencyKey, { instructionSets: [instructions], approvals });
        return copy(job);
      },
    });
  }

  createApprovalGrant({
    jobId,
    grantedBy,
    grantedTo,
    claim,
    adapterIds,
    actions,
    conditions,
    destinations,
    origins,
    sideEffectClasses,
    approvalPromptClasses = [],
    expiresAt,
    maxUses,
    idempotencyKey,
  }) {
    if (!claim) throw new Error("claim_required");
    return this.#once({
      key: idempotencyKey,
      actor: grantedBy,
      operation: "create_approval_grant",
      request: {
        jobId,
        grantedTo,
        claimId: claim?.claimId,
        generation: claim?.generation,
        fencingToken: claim?.fencingToken,
        adapterIds,
        actions,
        conditions,
        destinations,
        origins,
        sideEffectClasses,
        approvalPromptClasses,
        expiresAt,
        maxUses,
      },
      run: () => {
        if (!this.#hasRole(grantedBy.principalId, "owner")) {
          throw new Error("owner_approval_required");
        }
        const job = this.#job(jobId);
        this.#assertFence(job, claim);
        if (!this.#samePrincipalRef(claim.claimedBy, grantedTo)) {
          throw new Error("approval_subject_not_claimant");
        }
        if (!this.#hasRole(grantedTo.principalId, job.requiredRole)) {
          throw new Error("required_role_missing");
        }
        const grantedAt = this.now();
        if (!Number.isInteger(maxUses) || maxUses < 1) throw new Error("invalid_use_limit");
        if (!Number.isFinite(Date.parse(expiresAt)) || Date.parse(expiresAt) <= Date.parse(grantedAt)) {
          throw new Error("invalid_approval_duration");
        }
        for (const list of [adapterIds, actions, conditions, destinations, origins, sideEffectClasses]) {
          if (!Array.isArray(list) || list.length === 0) throw new Error("approval_scope_unbounded");
        }
        for (const adapterId of adapterIds) {
          const adapter = this.adapters.get(adapterId);
          if (!adapter) throw new Error("adapter_not_registered");
          const allowlist = adapter.security.networkAccess;
          if (![...origins, ...destinations].every((uri) => allowlist.includes(uri))) {
            throw new Error("approval_scope_outside_adapter_allowlist");
          }
        }
        const instruction = job.target.instructions;
        const grant = {
          schemaVersion: CONTRACT_VERSION,
          grantId: this.#id("approval"),
          projectId: this.projectId,
          status: "active",
          grantedBy: copy(grantedBy),
          grantedTo: copy(grantedTo),
          requiredRole: job.requiredRole,
          grantedAt,
          expiresAt,
          scope: {
            jobId,
            adapterIds: copy(adapterIds),
            actions: copy(actions),
            conditions: copy(conditions),
            destinations: copy(destinations),
            origins: copy(origins),
            sideEffectClasses: copy(sideEffectClasses),
            approvalPromptClasses: copy(approvalPromptClasses),
            maxUses,
          },
          claimBinding: {
            claimId: claim.claimId,
            generation: claim.generation,
            fencingToken: claim.fencingToken,
          },
          instructionBinding: {
            instructionSetId: instruction.instructionSetId,
            version: instruction.version,
            contentHash: instruction.contentHash,
          },
          usesConsumed: 0,
          defaultOnNoMatch: "ask",
        };
        this.approvalGrants.set(grant.grantId, grant);
        this.#emit("approval_grant.created", grant.grantId, grantedBy, {
          grantId: grant.grantId,
          jobId,
          actions: grant.scope.actions,
          expiresAt,
          maxUses,
        }, idempotencyKey, { approvals: [grant] });
        return copy(grant);
      },
    });
  }

  revokeApprovalGrant({ grantId, actor, reason, idempotencyKey }) {
    return this.#once({
      key: idempotencyKey,
      actor,
      operation: "revoke_approval_grant",
      request: { grantId, reason },
      run: () => {
        if (!this.#hasRole(actor.principalId, "owner")) throw new Error("owner_approval_required");
        const grant = this.approvalGrants.get(grantId);
        if (!grant) throw new Error("approval_grant_not_found");
        if (grant.status !== "active") throw new Error("approval_grant_not_active");
        this.#revokeGrant({ grant, actor, reason, invalidatedByInstructionAmendment: false, idempotencyKey });
        return copy(grant);
      },
    });
  }

  authorizeAction({
    jobId,
    actor,
    claim,
    adapterId,
    operation,
    origin,
    destination,
    sideEffectClass,
    conditions,
    approvalPromptClass,
    citations = [],
    idempotencyKey,
  }) {
    if (!claim) throw new Error("claim_required");
    return this.#once({
      key: idempotencyKey,
      actor,
      operation: "authorize_action",
      request: {
        jobId,
        claimId: claim?.claimId,
        generation: claim?.generation,
        fencingToken: claim?.fencingToken,
        adapterId,
        operation,
        origin,
        destination,
        sideEffectClass,
        conditions,
        ...(approvalPromptClass ? { approvalPromptClass } : {}),
        citations,
      },
      run: () => {
        const job = this.#job(jobId);
        this.#assertFence(job, claim);
        if (!this.#samePrincipalRef(actor, claim.claimedBy)) throw new Error("actor_not_claimant");
        if (!this.#hasRole(actor.principalId, job.requiredRole)) throw new Error("required_role_missing");
        const at = this.now();
        const actionId = this.#id("action");
        const grant = [...this.approvalGrants.values()].find((candidate) =>
          this.#grantMatches(candidate, job, actor, claim, {
            adapterId,
            at,
            operation,
            origin,
            destination,
            sideEffectClass,
            conditions,
            approvalPromptClass,
          })
        );
        const decision = grant ? "allow" : "ask";
        const reason = grant ? "bounded_approval_grant_matched" : "no_exact_active_grant";
        const overriddenRulesApplied = grant
          ? this.#overriddenRulesApplied(grant, job, conditions)
          : [];
        const overrideAudit = overriddenRulesApplied.length
          ? {
            approvalPolicyOverrideId: job.approvalPolicyOverride.overrideId,
            overriddenRulesApplied,
          }
          : {};
        const action = {
          actionId,
          adapterId,
          operation,
          sideEffectClass,
          origin,
          destination,
          conditionHash: hashValue(conditions),
          ...(approvalPromptClass ? { approvalPromptClass } : {}),
          authorizationDecision: decision,
          ...(grant ? { approvalGrantId: grant.grantId } : {}),
          ...overrideAudit,
        };
        const outcome = {
          outcomeId: this.#id("outcome"),
          status: grant ? "authorized" : "approval_required",
          detailHash: hashValue(reason),
          artifactIds: [],
        };
        if (grant) {
          grant.usesConsumed += 1;
          this.#emit("approval_grant.consumed", grant.grantId, actor, {
            grantId: grant.grantId,
            actionId,
            useNumber: grant.usesConsumed,
            ...overrideAudit,
          }, idempotencyKey, { approvals: [grant], actions: [action], outcomes: [outcome], citations });
          if (grant.usesConsumed >= grant.scope.maxUses) {
            grant.status = "exhausted";
            this.#emit("approval_grant.exhausted", grant.grantId, actor, {
              grantId: grant.grantId,
              usesConsumed: grant.usesConsumed,
            }, idempotencyKey, { approvals: [grant], actions: [action], outcomes: [outcome], citations });
          }
        }
        this.#emit("browser.authorization_decided", actionId, actor, {
          actionId,
          jobId,
          adapterId,
          operation,
          origin,
          destination,
          sideEffectClass,
          decision,
          reason,
          ...(grant ? { approvalGrantId: grant.grantId } : {}),
          ...overrideAudit,
        }, idempotencyKey, {
          approvals: grant ? [grant] : [],
          actions: [action],
          outcomes: [outcome],
          citations,
        });
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

  getApprovalGrant(grantId) {
    const grant = this.approvalGrants.get(grantId);
    if (!grant) throw new Error("approval_grant_not_found");
    return copy(grant);
  }

  listAuditMirror() {
    return copy(this.auditMirror);
  }

  makeReviewJobClaimable({ jobId, actor, idempotencyKey }) {
    return this.#once({
      key: idempotencyKey,
      actor,
      operation: "make_claimable",
      request: { jobId },
      run: () => {
        const job = this.#job(jobId);
        if (job.status !== "queued") throw new Error("invalid_transition");
        job.status = "claimable";
        job.updatedAt = this.now();
        this.#emit("review_job.claimable", jobId, actor, {}, idempotencyKey);
        return copy(job);
      },
    });
  }

  claimReviewJob({ jobId, claimedBy, idempotencyKey, leaseMs = 60000 }) {
    return this.#once({
      key: idempotencyKey,
      actor: claimedBy,
      operation: "claim",
      request: { jobId, claimedBy, leaseMs },
      run: () => {
        const job = this.#job(jobId);
        if (job.status !== "claimable") throw new Error("job_not_claimable");
        if (!this.#hasRole(claimedBy.principalId, job.requiredRole)) {
          throw new Error("required_role_missing");
        }
        if (
          job.independence.policy === "required" &&
          job.independence.excludedPrincipalIds.includes(claimedBy.principalId)
        ) {
          throw new Error("reviewer_not_independent");
        }
        const claimedAt = this.now();
        const claim = {
          claimId: this.#id("claim"),
          claimedBy: copy(claimedBy),
          generation: this.generation,
          fencingToken: ++this.fencingToken,
          idempotencyKey,
          claimedAt,
          leaseExpiresAt: new Date(Date.parse(claimedAt) + leaseMs).toISOString(),
        };
        job.status = "claimed";
        job.attempt += 1;
        job.claim = claim;
        job.updatedAt = claimedAt;
        this.#emit("review_job.claimed", jobId, claimedBy, {
          claimId: claim.claimId,
          fencingToken: claim.fencingToken,
        }, idempotencyKey);
        return copy(job);
      },
    });
  }

  startReviewJob({ jobId, claim, idempotencyKey }) {
    return this.#claimedTransition({
      jobId,
      claim,
      idempotencyKey,
      operation: "start",
      from: ["claimed"],
      to: "running",
      eventType: "review_job.started",
      data: {},
    });
  }

  awaitReviewInput({ jobId, claim, reason, idempotencyKey }) {
    return this.#claimedTransition({
      jobId,
      claim,
      idempotencyKey,
      operation: "await_input",
      from: ["running"],
      to: "awaiting_input",
      eventType: "review_job.input_requested",
      data: { reason },
    });
  }

  resumeReviewJob({ jobId, claim, idempotencyKey }) {
    return this.#claimedTransition({
      jobId,
      claim,
      idempotencyKey,
      operation: "resume",
      from: ["awaiting_input"],
      to: "running",
      eventType: "review_job.input_resumed",
      data: {},
    });
  }

  completeReviewJob({ jobId, claim, result, idempotencyKey }) {
    if (!result?.artifactIds?.length) throw new Error("result_artifact_required");
    if (!Array.isArray(result.disagreements) || !Array.isArray(result.citations)) {
      throw new Error("result_audit_fields_required");
    }
    return this.#once({
      key: idempotencyKey,
      actor: claim.claimedBy,
      operation: "complete",
      request: { jobId, claimId: claim.claimId, result },
      run: () => {
        const job = this.#job(jobId);
        this.#assertFence(job, claim);
        if (!["running", "awaiting_input"].includes(job.status)) {
          throw new Error("invalid_transition");
        }
        job.status = "completed";
        job.result = copy(result);
        job.updatedAt = this.now();
        const outcome = {
          outcomeId: this.#id("outcome"),
          status: `review_${result.outcome}`,
          detailHash: hashValue(result),
          artifactIds: copy(result.artifactIds),
        };
        this.#emit("review_job.completed", jobId, claim.claimedBy, {
          outcome: result.outcome,
          artifactIds: copy(result.artifactIds),
          disagreements: copy(result.disagreements),
          citations: copy(result.citations),
        }, idempotencyKey, { outcomes: [outcome], citations: result.citations });
        return copy(job);
      },
    });
  }

  failReviewJob({ jobId, claim, reason, retryable, idempotencyKey }) {
    return this.#once({
      key: idempotencyKey,
      actor: claim.claimedBy,
      operation: "fail",
      request: { jobId, claimId: claim.claimId, reason, retryable },
      run: () => {
        const job = this.#job(jobId);
        this.#assertFence(job, claim);
        if (!["running", "awaiting_input"].includes(job.status)) {
          throw new Error("invalid_transition");
        }
        job.status = "failed";
        job.failure = { reason, retryable };
        job.updatedAt = this.now();
        this.#emit("review_job.failed", jobId, claim.claimedBy, {
          reason,
          retryable,
        }, idempotencyKey);
        return copy(job);
      },
    });
  }

  cancelReviewJob({ jobId, actor, reason, idempotencyKey }) {
    return this.#once({
      key: idempotencyKey,
      actor,
      operation: "cancel",
      request: { jobId, reason },
      run: () => {
        const job = this.#job(jobId);
        if (["completed", "failed", "cancelled"].includes(job.status)) {
          throw new Error("invalid_transition");
        }
        job.status = "cancelled";
        job.cancellation = { reason, by: copy(actor) };
        delete job.claim;
        job.updatedAt = this.now();
        this.#emit("review_job.cancelled", jobId, actor, { reason }, idempotencyKey);
        return copy(job);
      },
    });
  }

  releaseExpiredClaim({ jobId, at = this.now() }) {
    const job = this.#job(jobId);
    if (!job.claim || Date.parse(job.claim.leaseExpiresAt) > Date.parse(at)) {
      throw new Error("claim_not_expired");
    }
    const actor = job.claim.claimedBy;
    delete job.claim;
    job.status = "claimable";
    job.updatedAt = at;
    this.#emit("review_job.claim_expired", jobId, actor, {});
    return copy(job);
  }

  setGeneration({ newGeneration, actor, reason }) {
    if (!Number.isInteger(newGeneration) || newGeneration <= this.generation) {
      throw new Error("generation_not_monotonic");
    }
    this.generation = newGeneration;
    this.#emit("project.generation_advanced", this.projectId, actor, { reason });
    return this.generation;
  }

  getReviewJob(jobId) {
    return copy(this.#job(jobId));
  }

  listEvents() {
    return copy(this.events);
  }

  doctor() {
    const sequenceOk = this.events.every((event, index) => event.sequence === index + 1);
    const hashesOk = this.events.every((event, index) =>
      hashEvent(event) === event.hash &&
      (index === 0 || event.previousHash === this.events[index - 1].hash)
    );
    const auditOk = this.auditMirror.length === this.events.length && this.auditMirror.every((entry, index) =>
      entry.mirrorSequence === index + 1 &&
      entry.event.eventId === this.events[index].eventId &&
      hashAuditMirrorEntry(entry) === entry.mirrorHash &&
      (index === 0 || entry.previousMirrorHash === this.auditMirror[index - 1].mirrorHash)
    );
    const staleClaims = [...this.jobs.values()].filter(
      (job) => job.claim && job.claim.generation !== this.generation
    ).map((job) => job.jobId);
    const generationStatus = staleClaims.length ? "warn" : "pass";
    return {
      schemaVersion: CONTRACT_VERSION,
      runId: this.#id("doctor"),
      projectId: this.projectId,
      hostId: this.hostId,
      generation: this.generation,
      runAt: this.now(),
      mode: "read_only",
      overall: sequenceOk && hashesOk && auditOk && staleClaims.length === 0 ? "degraded" : "blocked",
      checks: [
        { checkId: "check.identity.binding", category: "identity", status: "pass", detail: "Mock identity binding is configured." },
        { checkId: "check.permissions.local", category: "permissions", status: "pass", detail: "Mock performs no external I/O." },
        { checkId: "check.storage.integrity", category: "storage", status: "pass", detail: "In-memory maps are readable." },
        { checkId: "check.events.sequence", category: "events", status: sequenceOk && hashesOk && auditOk ? "pass" : "fail", detail: "Event and non-operational audit-mirror sequences and canonical hash chains checked." },
        { checkId: "check.generation.active", category: "generation", status: generationStatus, detail: staleClaims.length ? `Stale claims: ${staleClaims.join(", ")}` : "No stale claims." },
        { checkId: "check.adapter.manifests", category: "adapter", status: "skipped", detail: "Mock has no adapters." },
        { checkId: "check.github.private", category: "github", status: "skipped", detail: "Mock has no GitHub remote." },
        { checkId: "check.drive.root", category: "drive", status: "skipped", detail: "Mock has no Drive access." },
        { checkId: "check.backup.age", category: "backup", status: "warn", detail: "Mock has no backup schedule." },
        { checkId: "check.secrets.placement", category: "secrets", status: "pass", detail: "Mock stores no credentials." },
      ],
    };
  }

  #claimedTransition({ jobId, claim, idempotencyKey, operation, from, to, eventType, data }) {
    return this.#once({
      key: idempotencyKey,
      actor: claim.claimedBy,
      operation,
      request: { jobId, claimId: claim.claimId, data },
      run: () => {
        const job = this.#job(jobId);
        this.#assertFence(job, claim);
        if (!from.includes(job.status)) throw new Error("invalid_transition");
        job.status = to;
        job.updatedAt = this.now();
        this.#emit(eventType, jobId, claim.claimedBy, data, idempotencyKey);
        return copy(job);
      },
    });
  }

  #evaluateIndependence(input, at) {
    const declared = input.independence?.excludedPrincipalIds ?? [];
    const closure = this.#provenanceClosure(input.target.artifactIds);
    const authors = closure.map((artifactId) => this.artifacts.get(artifactId).createdBy.principalId);
    const effective = [...new Set([...declared, ...authors])].sort();
    const policy = input.independence?.policy ?? "not_required";
    const result = {
      policy,
      excludedPrincipalIds: effective,
      provenanceArtifactIds: closure,
      evaluatedBy: copy(this.policyIdentity),
      evaluatedAt: at,
    };
    if (policy === "waived_by_owner") {
      const waiver = input.independence?.waiverApproval;
      if (!waiver || !this.#hasRole(waiver.approvedBy.principalId, "owner")) {
        throw new Error("owner_waiver_required");
      }
      result.waiverReason = waiver.reason;
      result.waiverApprovalArtifactId = waiver.artifactId;
    }
    return result;
  }

  #normalizeInitialInstructions(instructions, authoredBy, authoredAt) {
    const text = typeof instructions === "string" ? instructions : instructions?.text;
    if (typeof text !== "string" || text.length === 0) throw new Error("instructions_required");
    return {
      instructionSetId: this.#id("instructions"),
      version: 1,
      text,
      contentHash: hashValue(text),
      authoredBy: copy(authoredBy),
      authoredAt,
      materialAmendment: false,
      invalidatesApprovalGrantIds: [],
    };
  }

  #normalizeApprovalPolicyOverride(input, requestedBy, jobId, invokedAt) {
    if (!input) return undefined;
    const invokedBy = input.invokedBy ?? requestedBy;
    if (!this.#samePrincipalRef(invokedBy, requestedBy)) {
      throw new Error("approval_policy_override_must_be_owner_invoked");
    }
    if (!this.#hasRole(invokedBy.principalId, "owner")) {
      throw new Error("owner_policy_override_required");
    }
    const reason = input.reason;
    if (typeof reason !== "string" || reason.length === 0) {
      throw new Error("approval_policy_override_reason_required");
    }
    return {
      overrideId: input.overrideId ?? this.#id("policy_override"),
      invokedBy: copy(invokedBy),
      invokedAt,
      reason,
      scope: {
        jobId,
        overriddenRules: ["M-3", "L-4"],
      },
      immutableAfterCreation: true,
      nonRetroactive: true,
      preservedControls: [
        "principal_role_authorization",
        "claim_generation_fencing",
        "adapter_allowlists",
        "credential_isolation",
        "unrelated_security_controls",
      ],
    };
  }

  #revokeGrant({ grant, actor, reason, invalidatedByInstructionAmendment, idempotencyKey }) {
    grant.status = "revoked";
    grant.revocation = {
      revokedAt: this.now(),
      revokedBy: copy(actor),
      reason,
    };
    this.#emit("approval_grant.revoked", grant.grantId, actor, {
      grantId: grant.grantId,
      reason,
      invalidatedByInstructionAmendment,
    }, idempotencyKey, { approvals: [grant] });
  }

  #grantMatches(grant, job, actor, claim, action) {
    if (grant.status !== "active" || Date.parse(grant.expiresAt) <= Date.parse(action.at)) return false;
    if (grant.scope.jobId !== job.jobId) return false;
    if (!grant.scope.adapterIds.includes(action.adapterId)) return false;
    if (!this.#samePrincipalRef(grant.grantedTo, actor)) return false;
    if (grant.requiredRole !== job.requiredRole || !this.#hasRole(actor.principalId, grant.requiredRole)) return false;
    if (
      grant.claimBinding.claimId !== claim.claimId ||
      grant.claimBinding.generation !== claim.generation ||
      grant.claimBinding.fencingToken !== claim.fencingToken
    ) return false;
    const adapter = this.adapters.get(action.adapterId);
    if (!adapter) return false;
    if (![action.origin, action.destination].every((uri) => adapter.security.networkAccess.includes(uri))) {
      return false;
    }
    if (!grant.scope.actions.includes(action.operation)) return false;
    if (!grant.scope.destinations.includes(action.destination)) return false;
    if (!grant.scope.origins.includes(action.origin)) return false;
    if (!grant.scope.sideEffectClasses.includes(action.sideEffectClass)) return false;
    if (action.approvalPromptClass && !grant.scope.approvalPromptClasses.includes(action.approvalPromptClass)) {
      return false;
    }
    if (!this.#instructionBindingMatches(grant, job)) return false;
    const expectedConditionNames = grant.scope.conditions.map((condition) => condition.name).sort();
    const actualConditionNames = Object.keys(action.conditions ?? {}).sort();
    if (
      !this.#overridesRule(job, "L-4") &&
      canonicalize(expectedConditionNames) !== canonicalize(actualConditionNames)
    ) return false;
    return grant.scope.conditions.every((condition) => {
      const actual = action.conditions?.[condition.name];
      return condition.operator === "equals"
        ? actual === condition.value
        : Array.isArray(condition.value) && condition.value.includes(actual);
    });
  }

  #instructionBindingMatches(grant, job) {
    const instruction = job.target.instructions;
    const currentMatch =
      grant.instructionBinding.instructionSetId === instruction.instructionSetId &&
      grant.instructionBinding.version === instruction.version &&
      grant.instructionBinding.contentHash === instruction.contentHash;
    if (currentMatch) return true;
    return this.#overridesRule(job, "M-3") &&
      grant.instructionBinding.instructionSetId === instruction.instructionSetId &&
      grant.instructionBinding.version >= 1 &&
      grant.instructionBinding.version < instruction.version;
  }

  #overriddenRulesApplied(grant, job, conditions) {
    const applied = [];
    if (this.#overridesRule(job, "M-3") && !this.#currentInstructionBindingMatches(grant, job)) {
      applied.push("M-3");
    }
    const expectedConditionNames = grant.scope.conditions.map((condition) => condition.name).sort();
    const actualConditionNames = Object.keys(conditions ?? {}).sort();
    if (
      this.#overridesRule(job, "L-4") &&
      canonicalize(expectedConditionNames) !== canonicalize(actualConditionNames)
    ) {
      applied.push("L-4");
    }
    return applied;
  }

  #currentInstructionBindingMatches(grant, job) {
    const instruction = job.target.instructions;
    return grant.instructionBinding.instructionSetId === instruction.instructionSetId &&
      grant.instructionBinding.version === instruction.version &&
      grant.instructionBinding.contentHash === instruction.contentHash;
  }

  #overridesRule(job, rule) {
    return job.approvalPolicyOverride?.scope?.overriddenRules?.includes(rule) ?? false;
  }

  #approvalPolicyOverride(job) {
    return job.approvalPolicyOverride;
  }

  #provenanceClosure(rootIds) {
    const visited = new Set();
    const visit = (artifactId) => {
      if (visited.has(artifactId)) return;
      const artifact = this.artifacts.get(artifactId);
      if (!artifact) throw new Error(`target_artifact_not_registered:${artifactId}`);
      visited.add(artifactId);
      const parents = artifact.parentArtifactIds ?? artifact.provenance?.parentArtifactIds ?? [];
      for (const parentId of parents) visit(parentId);
    };
    for (const artifactId of rootIds) visit(artifactId);
    return [...visited].sort();
  }

  #hasRole(principalId, role) {
    return this.roleAssignments.get(principalId)?.has(role) ?? false;
  }

  #samePrincipalRef(left, right) {
    return Boolean(left && right) &&
      left.principalId === right.principalId &&
      left.sessionId === right.sessionId &&
      left.hostId === right.hostId;
  }

  #job(jobId) {
    const job = this.jobs.get(jobId);
    if (!job) throw new Error("job_not_found");
    return job;
  }

  #assertFence(job, claim) {
    if (
      !job.claim ||
      claim.claimId !== job.claim.claimId ||
      claim.fencingToken !== job.claim.fencingToken ||
      claim.generation !== this.generation
    ) {
      throw new Error("stale_fencing_token");
    }
  }

  #once({ key, actor, operation, request, run }) {
    if (!key) throw new Error("idempotency_key_required");
    const scope = `${this.projectId}|${actor.principalId}|${operation}|${key}`;
    const requestHash = crypto.createHash("sha256").update(canonicalize(request), "utf8").digest("hex");
    const existing = this.idempotency.get(scope);
    if (existing) {
      if (existing.requestHash !== requestHash) throw new Error("idempotency_key_reused");
      return copy(existing.result);
    }
    const result = run();
    this.idempotency.set(scope, { requestHash, result: copy(result) });
    return result;
  }

  #id(prefix) {
    this.idCounter += 1;
    return `${prefix}.mock.${String(this.idCounter).padStart(4, "0")}`;
  }

  #emit(eventType, aggregateId, actor, data, idempotencyKey, auditContext = {}) {
    const previousHash = this.events.at(-1)?.hash;
    const base = {
      schemaVersion: CONTRACT_VERSION,
      eventId: this.#id("event"),
      projectId: this.projectId,
      sequence: ++this.sequence,
      generation: this.generation,
      eventType,
      aggregate: {
        type: eventType.startsWith("project.")
          ? "project"
          : eventType.startsWith("approval_grant.")
            ? "approval_grant"
            : eventType.startsWith("browser.")
              ? "adapter_action"
              : "review_job",
        id: aggregateId,
      },
      actor: copy(actor),
      occurredAt: this.now(),
      correlationId: `correlation.${aggregateId}`,
      ...(idempotencyKey ? { idempotencyKey } : {}),
      data: copy(data),
      ...(previousHash ? { previousHash } : {}),
      hashAlgorithm: EVENT_HASH_ALGORITHM,
    };
    const event = { ...base, hash: hashEvent(base) };
    this.events.push(event);
    const completeAuditContext = { ...auditContext };
    if (event.aggregate.type === "review_job" && !completeAuditContext.instructionSets) {
      const instruction = this.jobs.get(aggregateId)?.target?.instructions;
      completeAuditContext.instructionSets = instruction ? [instruction] : [];
    }
    if (event.aggregate.type === "approval_grant" && !completeAuditContext.approvals) {
      const grant = this.approvalGrants.get(aggregateId);
      completeAuditContext.approvals = grant ? [grant] : [];
    }
    this.#appendAuditMirror(event, completeAuditContext);
  }

  #appendAuditMirror(event, context) {
    const previousMirrorHash = this.auditMirror.at(-1)?.mirrorHash;
    const base = {
      schemaVersion: CONTRACT_VERSION,
      mirrorSequence: this.auditMirror.length + 1,
      mirroredAt: this.now(),
      event: copy(event),
      instructionSets: copy(context.instructionSets ?? []),
      approvals: copy(context.approvals ?? []),
      actions: copy(context.actions ?? []),
      outcomes: copy(context.outcomes ?? []),
      citations: copy(context.citations ?? []),
      excludedContentClasses: ["browser_state", "credentials", "raw_artifact_contents", "secrets"],
      ...(previousMirrorHash ? { previousMirrorHash } : {}),
      hashAlgorithm: AUDIT_HASH_ALGORITHM,
    };
    this.auditMirror.push({ ...base, mirrorHash: hashAuditMirrorEntry(base) });
  }
}
