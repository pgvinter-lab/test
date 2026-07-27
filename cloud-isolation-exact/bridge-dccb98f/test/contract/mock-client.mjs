import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import Ajv2020 from "ajv/dist/2020.js";
import addFormats from "ajv-formats";
import { MockBridgeClient, hashAuditMirrorEntry, hashEvent } from "../../mock-client/index.mjs";

let tick = 0;
const owner = {
  principalId: "principal.owner",
  sessionId: "session.owner.001",
  hostId: "host.demo",
};
const reviewer = {
  principalId: "principal.reviewer",
  sessionId: "session.reviewer.001",
  hostId: "host.demo",
};
const reviewer2 = {
  principalId: "principal.reviewer2",
  sessionId: "session.reviewer.002",
  hostId: "host.demo",
};
const worker = {
  principalId: "principal.worker",
  sessionId: "session.worker.001",
  hostId: "host.demo",
};

const bridge = new MockBridgeClient({
  projectId: "project.procedural",
  roleAssignments: {
    [owner.principalId]: ["owner", "reviewer"],
    [reviewer.principalId]: ["reviewer"],
    [reviewer2.principalId]: ["reviewer"],
    [worker.principalId]: ["worker"],
  },
  artifacts: [
    {
      artifactId: "artifact.source.000",
      createdBy: worker,
      parentArtifactIds: [],
    },
    {
      artifactId: "artifact.synthetic.001",
      createdBy: owner,
      parentArtifactIds: ["artifact.source.000"],
    },
    {
      artifactId: "artifact.review.result.001",
      createdBy: reviewer,
      parentArtifactIds: ["artifact.synthetic.001"],
    },
  ],
  now: () => new Date(Date.UTC(2026, 6, 12, 12, 0, tick++)).toISOString(),
});

function createIndependentJob() {
  return bridge.createReviewJob({
    mode: "independent_review",
    requestedBy: owner,
    requiredRole: "reviewer",
    independence: {
      policy: "required",
      excludedPrincipalIds: [],
    },
    target: {
      artifactIds: ["artifact.synthetic.001"],
      instructions: "Review the synthetic artifact.",
      acceptanceCriteria: ["Preserve disagreements."],
    },
  });
}

const job = createIndependentJob();
assert.equal(job.status, "queued");
assert.equal(job.target.instructions.version, 1);
assert.equal(job.target.instructions.authoredBy.principalId, owner.principalId);
assert.deepEqual(job.independence.excludedPrincipalIds, [owner.principalId, worker.principalId]);
assert.deepEqual(job.independence.provenanceArtifactIds, ["artifact.source.000", "artifact.synthetic.001"]);
assert.throws(
  () => bridge.createReviewJob({
    mode: "independent_review",
    requestedBy: owner,
    requiredRole: "reviewer",
    independence: {
      policy: "waived_by_owner",
      excludedPrincipalIds: [],
      waiverApproval: {
        artifactId: "artifact.waiver.invalid",
        approvedBy: worker,
        reason: "Invalid synthetic waiver.",
      },
    },
    target: {
      artifactIds: ["artifact.synthetic.001"],
      instructions: "Invalid waiver test.",
      acceptanceCriteria: ["Reject non-owner waiver."],
    },
  }),
  /owner_waiver_required/
);
assert.throws(
  () => bridge.createReviewJob({
    mode: "collaboration",
    requestedBy: worker,
    requiredRole: "worker",
    independence: { policy: "not_required", excludedPrincipalIds: [] },
    approvalPolicyOverride: {
      reason: "Invalid non-owner override.",
    },
    target: {
      artifactIds: ["artifact.synthetic.001"],
      instructions: "Invalid override test.",
      acceptanceCriteria: ["Reject non-owner override."],
    },
  }),
  /owner_policy_override_required/
);

bridge.makeReviewJobClaimable({
  jobId: job.jobId,
  actor: owner,
  idempotencyKey: "idempotency.make-claimable.001",
});
assert.throws(
  () => bridge.claimReviewJob({
    jobId: job.jobId,
    claimedBy: owner,
    idempotencyKey: "idempotency.owner.claim",
  }),
  /reviewer_not_independent/
);

const claimed = bridge.claimReviewJob({
  jobId: job.jobId,
  claimedBy: reviewer,
  idempotencyKey: "idempotency.reviewer.claim",
});
const eventCountAfterClaim = bridge.listEvents().length;
const replayedClaim = bridge.claimReviewJob({
  jobId: job.jobId,
  claimedBy: reviewer,
  idempotencyKey: "idempotency.reviewer.claim",
});
assert.deepEqual(replayedClaim, claimed);
assert.equal(bridge.listEvents().length, eventCountAfterClaim);
assert.throws(
  () => bridge.claimReviewJob({
    jobId: job.jobId,
    claimedBy: reviewer,
    idempotencyKey: "idempotency.reviewer.claim",
    leaseMs: 120000,
  }),
  /idempotency_key_reused/
);

bridge.startReviewJob({
  jobId: job.jobId,
  claim: claimed.claim,
  idempotencyKey: "idempotency.reviewer.start",
});
bridge.awaitReviewInput({
  jobId: job.jobId,
  claim: claimed.claim,
  reason: "Need one synthetic input.",
  idempotencyKey: "idempotency.reviewer.await",
});
const resumed = bridge.resumeReviewJob({
  jobId: job.jobId,
  claim: claimed.claim,
  idempotencyKey: "idempotency.reviewer.resume",
});
assert.equal(resumed.status, "running");

bridge.setGeneration({
  newGeneration: 2,
  actor: owner,
  reason: "synthetic takeover test",
});
assert.throws(
  () => bridge.completeReviewJob({
    jobId: job.jobId,
    claim: claimed.claim,
    idempotencyKey: "idempotency.reviewer.complete.stale",
    result: {
      outcome: "accepted",
      artifactIds: ["artifact.review.result.001"],
      disagreements: [],
      citations: [],
    },
  }),
  /stale_fencing_token/
);

const completedJob = createIndependentJob();
bridge.makeReviewJobClaimable({
  jobId: completedJob.jobId,
  actor: owner,
  idempotencyKey: "idempotency.make-claimable.002",
});
const completedClaim = bridge.claimReviewJob({
  jobId: completedJob.jobId,
  claimedBy: reviewer,
  idempotencyKey: "idempotency.reviewer.claim.002",
});
bridge.startReviewJob({
  jobId: completedJob.jobId,
  claim: completedClaim.claim,
  idempotencyKey: "idempotency.reviewer.start.002",
});
const completed = bridge.completeReviewJob({
  jobId: completedJob.jobId,
  claim: completedClaim.claim,
  idempotencyKey: "idempotency.reviewer.complete.002",
  result: {
    outcome: "changes_requested",
    artifactIds: ["artifact.review.result.001"],
    disagreements: [{
      disagreementId: "disagreement.synthetic.001",
      position: "The synthetic contract needs one revision.",
      disposition: "unresolved",
      reason: "Preserved for the owner.",
      raisedBy: reviewer,
      relatedArtifactIds: ["artifact.synthetic.001"],
    }],
    citations: [],
  },
});
assert.equal(completed.status, "completed");
assert.throws(
  () => bridge.resumeReviewJob({
    jobId: completedJob.jobId,
    claim: completedClaim.claim,
    idempotencyKey: "idempotency.invalid.resume",
  }),
  /invalid_transition/
);

const missingRoleJob = createIndependentJob();
bridge.makeReviewJobClaimable({
  jobId: missingRoleJob.jobId,
  actor: owner,
  idempotencyKey: "idempotency.make-claimable.003",
});
assert.throws(
  () => bridge.claimReviewJob({
    jobId: missingRoleJob.jobId,
    claimedBy: worker,
    idempotencyKey: "idempotency.worker.claim",
  }),
  /required_role_missing/
);

const cancelledJob = bridge.createReviewJob({
  mode: "collaboration",
  requestedBy: owner,
  requiredRole: "worker",
  independence: { policy: "not_required", excludedPrincipalIds: [] },
  target: {
    artifactIds: ["artifact.synthetic.001"],
    instructions: "Synthetic collaboration.",
    acceptanceCriteria: ["Return a local result."],
  },
});
const cancelled = bridge.cancelReviewJob({
  jobId: cancelledJob.jobId,
  actor: owner,
  reason: "Synthetic cancellation.",
  idempotencyKey: "idempotency.cancel.001",
});
assert.equal(cancelled.status, "cancelled");
assert.equal(cancelled.cancellation.reason, "Synthetic cancellation.");

const failedJob = createIndependentJob();
bridge.makeReviewJobClaimable({
  jobId: failedJob.jobId,
  actor: owner,
  idempotencyKey: "idempotency.make-claimable.004",
});
const failedClaim = bridge.claimReviewJob({
  jobId: failedJob.jobId,
  claimedBy: reviewer2,
  idempotencyKey: "shared-key",
});
bridge.startReviewJob({
  jobId: failedJob.jobId,
  claim: failedClaim.claim,
  idempotencyKey: "idempotency.reviewer2.start",
});
const failed = bridge.failReviewJob({
  jobId: failedJob.jobId,
  claim: failedClaim.claim,
  reason: "Synthetic adapter failure.",
  retryable: true,
  idempotencyKey: "idempotency.reviewer2.fail",
});
assert.equal(failed.status, "failed");
assert.equal(failed.failure.retryable, true);

const scopedKeyJob = createIndependentJob();
bridge.makeReviewJobClaimable({
  jobId: scopedKeyJob.jobId,
  actor: owner,
  idempotencyKey: "idempotency.make-claimable.005",
});
const scopedKeyClaim = bridge.claimReviewJob({
  jobId: scopedKeyJob.jobId,
  claimedBy: reviewer,
  idempotencyKey: "shared-key",
});
assert.equal(scopedKeyClaim.status, "claimed");

bridge.registerAdapterManifest({
  adapterId: "adapter.browser.synthetic",
  security: {
    networkAccess: [
      "https://example.invalid",
      "https://example.invalid/drafts",
    ],
  },
});

const approvalJob = bridge.createReviewJob({
  mode: "collaboration",
  requestedBy: owner,
  requiredRole: "worker",
  independence: { policy: "not_required", excludedPrincipalIds: [] },
  target: {
    artifactIds: ["artifact.synthetic.001"],
    instructions: "Allow only a bounded synthetic browser draft action.",
    acceptanceCriteria: ["Scope expansion returns ask."],
  },
});
bridge.makeReviewJobClaimable({
  jobId: approvalJob.jobId,
  actor: owner,
  idempotencyKey: "idempotency.make-claimable.approval",
});
const approvalClaimedJob = bridge.claimReviewJob({
  jobId: approvalJob.jobId,
  claimedBy: worker,
  idempotencyKey: "idempotency.worker.claim.approval",
});
bridge.startReviewJob({
  jobId: approvalJob.jobId,
  claim: approvalClaimedJob.claim,
  idempotencyKey: "idempotency.worker.start.approval",
});
const approvalClaim = approvalClaimedJob.claim;
assert.throws(
  () => bridge.createApprovalGrant({
    jobId: approvalJob.jobId,
    grantedBy: worker,
    grantedTo: worker,
    claim: approvalClaim,
    adapterIds: ["adapter.browser.synthetic"],
    actions: ["browser.compose"],
    conditions: [{ name: "artifact_class", operator: "equals", value: "synthetic" }],
    destinations: ["https://example.invalid/drafts"],
    origins: ["https://example.invalid"],
    sideEffectClasses: ["external_reversible"],
    expiresAt: "2026-07-13T12:00:00Z",
    maxUses: 1,
    idempotencyKey: "idempotency.invalid.grant",
  }),
  /owner_approval_required/
);
assert.throws(
  () => bridge.createApprovalGrant({
    jobId: approvalJob.jobId,
    grantedBy: owner,
    grantedTo: worker,
    claim: approvalClaim,
    adapterIds: ["adapter.browser.synthetic"],
    actions: ["browser.compose"],
    conditions: [{ name: "artifact_class", operator: "equals", value: "synthetic" }],
    destinations: ["https://unlisted.invalid/drafts"],
    origins: ["https://example.invalid"],
    sideEffectClasses: ["external_reversible"],
    expiresAt: "2026-07-13T12:00:00Z",
    maxUses: 1,
    idempotencyKey: "idempotency.invalid.allowlist",
  }),
  /approval_scope_outside_adapter_allowlist/
);
const approval = bridge.createApprovalGrant({
  jobId: approvalJob.jobId,
  grantedBy: owner,
  grantedTo: worker,
  claim: approvalClaim,
  adapterIds: ["adapter.browser.synthetic"],
  actions: ["browser.compose", "approval_prompt.respond"],
  conditions: [{ name: "artifact_class", operator: "equals", value: "synthetic" }],
  destinations: ["https://example.invalid/drafts"],
  origins: ["https://example.invalid"],
  sideEffectClasses: ["external_reversible"],
  approvalPromptClasses: ["confirm_save_draft"],
  expiresAt: "2026-07-13T12:00:00Z",
  maxUses: 2,
  idempotencyKey: "idempotency.approval.create.001",
});
assert.throws(
  () => bridge.authorizeAction({
    jobId: approvalJob.jobId,
    actor: worker,
    adapterId: "adapter.browser.synthetic",
    operation: "browser.compose",
    origin: "https://example.invalid",
    destination: "https://example.invalid/drafts",
    sideEffectClass: "external_reversible",
    conditions: { artifact_class: "synthetic" },
    idempotencyKey: "idempotency.action.reject.missing-claim",
  }),
  /claim_required/
);
assert.throws(
  () => bridge.authorizeAction({
    jobId: approvalJob.jobId,
    actor: reviewer,
    claim: approvalClaim,
    adapterId: "adapter.browser.synthetic",
    operation: "browser.compose",
    origin: "https://example.invalid",
    destination: "https://example.invalid/drafts",
    sideEffectClass: "external_reversible",
    conditions: { artifact_class: "synthetic" },
    idempotencyKey: "idempotency.action.reject.actor",
  }),
  /actor_not_claimant/
);
const allowed = bridge.authorizeAction({
  jobId: approvalJob.jobId,
  actor: worker,
  claim: approvalClaim,
  adapterId: "adapter.browser.synthetic",
  operation: "browser.compose",
  origin: "https://example.invalid",
  destination: "https://example.invalid/drafts",
  sideEffectClass: "external_reversible",
  conditions: { artifact_class: "synthetic" },
  idempotencyKey: "idempotency.action.allow.001",
});
assert.equal(allowed.decision, "allow");
assert.equal(allowed.approvalGrantId, approval.grantId);
const eventCountAfterAuthorization = bridge.listEvents().length;
assert.deepEqual(bridge.authorizeAction({
  jobId: approvalJob.jobId,
  actor: worker,
  claim: approvalClaim,
  adapterId: "adapter.browser.synthetic",
  operation: "browser.compose",
  origin: "https://example.invalid",
  destination: "https://example.invalid/drafts",
  sideEffectClass: "external_reversible",
  conditions: { artifact_class: "synthetic" },
  idempotencyKey: "idempotency.action.allow.001",
}), allowed);
assert.equal(bridge.listEvents().length, eventCountAfterAuthorization);
const expandedOrigin = bridge.authorizeAction({
  jobId: approvalJob.jobId,
  actor: worker,
  claim: approvalClaim,
  adapterId: "adapter.browser.synthetic",
  operation: "browser.compose",
  origin: "https://new-origin.invalid",
  destination: "https://example.invalid/drafts",
  sideEffectClass: "external_reversible",
  conditions: { artifact_class: "synthetic" },
  idempotencyKey: "idempotency.action.ask.origin",
});
assert.equal(expandedOrigin.decision, "ask");
const expandedConditions = bridge.authorizeAction({
  jobId: approvalJob.jobId,
  actor: worker,
  claim: approvalClaim,
  adapterId: "adapter.browser.synthetic",
  operation: "browser.compose",
  origin: "https://example.invalid",
  destination: "https://example.invalid/drafts",
  sideEffectClass: "external_reversible",
  conditions: { artifact_class: "synthetic", unapproved_flag: true },
  idempotencyKey: "idempotency.action.ask.condition-expansion",
});
assert.equal(expandedConditions.decision, "ask");
const promptAllowed = bridge.authorizeAction({
  jobId: approvalJob.jobId,
  actor: worker,
  claim: approvalClaim,
  adapterId: "adapter.browser.synthetic",
  operation: "approval_prompt.respond",
  origin: "https://example.invalid",
  destination: "https://example.invalid/drafts",
  sideEffectClass: "external_reversible",
  conditions: { artifact_class: "synthetic" },
  approvalPromptClass: "confirm_save_draft",
  idempotencyKey: "idempotency.action.allow.prompt",
});
assert.equal(promptAllowed.decision, "allow");
assert.equal(bridge.getApprovalGrant(approval.grantId).status, "exhausted");
const exhausted = bridge.authorizeAction({
  jobId: approvalJob.jobId,
  actor: worker,
  claim: approvalClaim,
  adapterId: "adapter.browser.synthetic",
  operation: "browser.compose",
  origin: "https://example.invalid",
  destination: "https://example.invalid/drafts",
  sideEffectClass: "external_reversible",
  conditions: { artifact_class: "synthetic" },
  idempotencyKey: "idempotency.action.ask.exhausted",
});
assert.equal(exhausted.decision, "ask");

const amendmentGrant = bridge.createApprovalGrant({
  jobId: approvalJob.jobId,
  grantedBy: owner,
  grantedTo: worker,
  claim: approvalClaim,
  adapterIds: ["adapter.browser.synthetic"],
  actions: ["browser.compose"],
  conditions: [{ name: "artifact_class", operator: "equals", value: "synthetic" }],
  destinations: ["https://example.invalid/drafts"],
  origins: ["https://example.invalid"],
  sideEffectClasses: ["external_reversible"],
  expiresAt: "2026-07-13T12:00:00Z",
  maxUses: 3,
  idempotencyKey: "idempotency.approval.create.amendment",
});
const amended = bridge.amendReviewJobInstructions({
  jobId: approvalJob.jobId,
  actor: owner,
  text: "Materially revised synthetic browser instruction.",
  materialAmendment: true,
  idempotencyKey: "idempotency.instructions.amend.001",
});
assert.equal(amended.target.instructions.version, 2);
assert.deepEqual(amended.target.instructions.invalidatesApprovalGrantIds, [amendmentGrant.grantId]);
assert.equal(bridge.getApprovalGrant(amendmentGrant.grantId).status, "revoked");

const nonMaterialGrant = bridge.createApprovalGrant({
  jobId: approvalJob.jobId,
  grantedBy: owner,
  grantedTo: worker,
  claim: approvalClaim,
  adapterIds: ["adapter.browser.synthetic"],
  actions: ["browser.compose"],
  conditions: [{ name: "artifact_class", operator: "equals", value: "synthetic" }],
  destinations: ["https://example.invalid/drafts"],
  origins: ["https://example.invalid"],
  sideEffectClasses: ["external_reversible"],
  expiresAt: "2026-07-13T12:00:00Z",
  maxUses: 3,
  idempotencyKey: "idempotency.approval.create.non-material",
});
const nonMaterialAmendment = bridge.amendReviewJobInstructions({
  jobId: approvalJob.jobId,
  actor: owner,
  text: "Editorially revised synthetic browser instruction.",
  materialAmendment: false,
  idempotencyKey: "idempotency.instructions.amend.non-material",
});
assert.deepEqual(nonMaterialAmendment.target.instructions.invalidatesApprovalGrantIds, [nonMaterialGrant.grantId]);
assert.equal(bridge.getApprovalGrant(nonMaterialGrant.grantId).status, "revoked");

const overrideJob = bridge.createReviewJob({
  mode: "collaboration",
  requestedBy: owner,
  requiredRole: "worker",
  independence: { policy: "not_required", excludedPrincipalIds: [] },
  approvalPolicyOverride: {
    reason: "Owner declared the M-3/L-4 override up front for this synthetic job.",
  },
  target: {
    artifactIds: ["artifact.synthetic.001"],
    instructions: "Synthetic override job.",
    acceptanceCriteria: ["Only M-3 and L-4 are overridden."],
  },
});
assert.deepEqual(overrideJob.approvalPolicyOverride.scope.overriddenRules, ["M-3", "L-4"]);
assert.equal(overrideJob.approvalPolicyOverride.immutableAfterCreation, true);
assert.equal(overrideJob.approvalPolicyOverride.nonRetroactive, true);
bridge.makeReviewJobClaimable({
  jobId: overrideJob.jobId,
  actor: owner,
  idempotencyKey: "idempotency.make-claimable.override",
});
const overrideClaimedJob = bridge.claimReviewJob({
  jobId: overrideJob.jobId,
  claimedBy: worker,
  idempotencyKey: "idempotency.worker.claim.override",
});
bridge.startReviewJob({
  jobId: overrideJob.jobId,
  claim: overrideClaimedJob.claim,
  idempotencyKey: "idempotency.worker.start.override",
});
const overrideClaim = overrideClaimedJob.claim;
const overrideGrant = bridge.createApprovalGrant({
  jobId: overrideJob.jobId,
  grantedBy: owner,
  grantedTo: worker,
  claim: overrideClaim,
  adapterIds: ["adapter.browser.synthetic"],
  actions: ["browser.compose"],
  conditions: [{ name: "artifact_class", operator: "equals", value: "synthetic" }],
  destinations: ["https://example.invalid/drafts"],
  origins: ["https://example.invalid"],
  sideEffectClasses: ["external_reversible"],
  expiresAt: "2026-07-13T12:00:00Z",
  maxUses: 3,
  idempotencyKey: "idempotency.approval.create.override",
});
const overrideAmendment = bridge.amendReviewJobInstructions({
  jobId: overrideJob.jobId,
  actor: owner,
  text: "Synthetic override job after instruction amendment.",
  materialAmendment: true,
  idempotencyKey: "idempotency.instructions.amend.override",
});
assert.deepEqual(overrideAmendment.target.instructions.invalidatesApprovalGrantIds, []);
assert.equal(bridge.getApprovalGrant(overrideGrant.grantId).status, "active");
assert.throws(
  () => bridge.authorizeAction({
    jobId: overrideJob.jobId,
    actor: reviewer,
    claim: overrideClaim,
    adapterId: "adapter.browser.synthetic",
    operation: "browser.compose",
    origin: "https://example.invalid",
    destination: "https://example.invalid/drafts",
    sideEffectClass: "external_reversible",
    conditions: { artifact_class: "synthetic", unapproved_flag: true },
    idempotencyKey: "idempotency.override.reject.actor",
  }),
  /actor_not_claimant/
);
const overrideAllowed = bridge.authorizeAction({
  jobId: overrideJob.jobId,
  actor: worker,
  claim: overrideClaim,
  adapterId: "adapter.browser.synthetic",
  operation: "browser.compose",
  origin: "https://example.invalid",
  destination: "https://example.invalid/drafts",
  sideEffectClass: "external_reversible",
  conditions: { artifact_class: "synthetic", unapproved_flag: true },
  idempotencyKey: "idempotency.action.allow.override",
});
assert.equal(overrideAllowed.decision, "allow");
assert.equal(overrideAllowed.approvalGrantId, overrideGrant.grantId);
assert.equal(overrideAllowed.approvalPolicyOverrideId, overrideJob.approvalPolicyOverride.overrideId);
assert.deepEqual(overrideAllowed.overriddenRulesApplied, ["M-3", "L-4"]);
const overrideOutsideAllowlist = bridge.authorizeAction({
  jobId: overrideJob.jobId,
  actor: worker,
  claim: overrideClaim,
  adapterId: "adapter.browser.synthetic",
  operation: "browser.compose",
  origin: "https://new-origin.invalid",
  destination: "https://example.invalid/drafts",
  sideEffectClass: "external_reversible",
  conditions: { artifact_class: "synthetic", unapproved_flag: true },
  idempotencyKey: "idempotency.action.ask.override-origin",
});
assert.equal(overrideOutsideAllowlist.decision, "ask");

const staleFenceGrant = bridge.createApprovalGrant({
  jobId: approvalJob.jobId,
  grantedBy: owner,
  grantedTo: worker,
  claim: approvalClaim,
  adapterIds: ["adapter.browser.synthetic"],
  actions: ["browser.compose"],
  conditions: [{ name: "artifact_class", operator: "equals", value: "synthetic" }],
  destinations: ["https://example.invalid/drafts"],
  origins: ["https://example.invalid"],
  sideEffectClasses: ["external_reversible"],
  expiresAt: "2026-07-13T12:00:00Z",
  maxUses: 3,
  idempotencyKey: "idempotency.approval.create.stale-fence",
});
bridge.setGeneration({ newGeneration: 3, actor: owner, reason: "authorization fencing test" });
assert.throws(
  () => bridge.authorizeAction({
    jobId: approvalJob.jobId,
    actor: worker,
    claim: approvalClaim,
    adapterId: "adapter.browser.synthetic",
    operation: "browser.compose",
    origin: "https://example.invalid",
    destination: "https://example.invalid/drafts",
    sideEffectClass: "external_reversible",
    conditions: { artifact_class: "synthetic" },
    idempotencyKey: "idempotency.action.reject.stale-fence",
  }),
  /stale_fencing_token/
);
assert.throws(
  () => bridge.authorizeAction({
    jobId: overrideJob.jobId,
    actor: worker,
    claim: overrideClaim,
    adapterId: "adapter.browser.synthetic",
    operation: "browser.compose",
    origin: "https://example.invalid",
    destination: "https://example.invalid/drafts",
    sideEffectClass: "external_reversible",
    conditions: { artifact_class: "synthetic", unapproved_flag: true },
    idempotencyKey: "idempotency.override.reject.stale-fence",
  }),
  /stale_fencing_token/
);

const events = bridge.listEvents();
assert.equal(events.every((event, index) => event.sequence === index + 1), true);
assert.equal(events.every((event, index) =>
  hashEvent(event) === event.hash &&
  (index === 0 || event.previousHash === events[index - 1].hash)
), true);
const auditMirror = bridge.listAuditMirror();
assert.equal(auditMirror.length, events.length);
assert.equal(auditMirror.every((entry, index) =>
  entry.mirrorSequence === index + 1 &&
  entry.event.eventId === events[index].eventId &&
  hashAuditMirrorEntry(entry) === entry.mirrorHash &&
  (index === 0 || entry.previousMirrorHash === auditMirror[index - 1].mirrorHash)
), true);
assert.equal(auditMirror.some((entry) => entry.instructionSets.length > 0), true);
assert.equal(auditMirror.some((entry) => entry.approvals.length > 0), true);
assert.equal(auditMirror.some((entry) => entry.actions.length > 0), true);
assert.equal(JSON.stringify(auditMirror).includes("rawArtifactContents"), false);
assert.equal(auditMirror.filter((entry) => entry.event.eventType.startsWith("review_job."))
  .every((entry) => entry.instructionSets.length === 1), true);
assert.equal(auditMirror.filter((entry) => entry.event.eventType.startsWith("approval_grant."))
  .every((entry) => entry.approvals.length === 1), true);
const completedEvent = events.find((event) => event.eventType === "review_job.completed");
assert.equal(completedEvent.data.disagreements.length, 1);
const completedAudit = auditMirror.find((entry) => entry.event.eventId === completedEvent.eventId);
assert.equal(completedAudit.outcomes.length, 1);
const overrideCreationEvent = events.find((event) =>
  event.eventType === "review_job.created" &&
  event.data.approvalPolicyOverride?.overrideId === overrideJob.approvalPolicyOverride.overrideId
);
assert.equal(overrideCreationEvent.data.approvalPolicyOverride.scope.jobId, overrideJob.jobId);
const overrideAuthorizationEvent = events.find((event) =>
  event.eventType === "browser.authorization_decided" &&
  event.data.approvalPolicyOverrideId === overrideJob.approvalPolicyOverride.overrideId
);
assert.deepEqual(overrideAuthorizationEvent.data.overriddenRulesApplied, ["M-3", "L-4"]);
const overrideAmendmentEvent = events.find((event) =>
  event.eventType === "review_job.instructions_amended" &&
  event.data.approvalPolicyOverrideId === overrideJob.approvalPolicyOverride.overrideId
);
assert.deepEqual(overrideAmendmentEvent.data.overriddenRulesApplied, ["M-3"]);

const doctor = bridge.doctor();
assert.equal(doctor.overall, "blocked");
assert.equal(new Set(doctor.checks.map((check) => check.category)).size, 10);

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "../..");
const schemaDir = path.join(root, "contracts", "v0.1.0-draft.4", "schemas");
const schemas = fs.readdirSync(schemaDir)
  .filter((name) => name.endsWith(".schema.json"))
  .map((name) => JSON.parse(fs.readFileSync(path.join(schemaDir, name), "utf8")));
const ajv = new Ajv2020({ allErrors: true, strict: true });
addFormats(ajv);
for (const schema of schemas) ajv.addSchema(schema);
const schemaByName = (name) => schemas.find((schema) => schema.$id.endsWith(`/${name}`));
const validateJob = ajv.getSchema(schemaByName("review-job.schema.json").$id);
for (const candidate of [
  bridge.getReviewJob(job.jobId),
  completed,
  bridge.getReviewJob(missingRoleJob.jobId),
  cancelled,
  failed,
  scopedKeyClaim,
]) {
  assert.equal(validateJob(candidate), true, JSON.stringify(validateJob.errors));
}
const validateEvent = ajv.getSchema(schemaByName("event.schema.json").$id);
for (const event of events) {
  assert.equal(validateEvent(event), true, JSON.stringify(validateEvent.errors));
}
const validateApproval = ajv.getSchema(schemaByName("approval-grant.schema.json").$id);
for (const grantId of [
  approval.grantId,
  amendmentGrant.grantId,
  nonMaterialGrant.grantId,
  staleFenceGrant.grantId,
]) {
  const grant = bridge.getApprovalGrant(grantId);
  assert.equal(validateApproval(grant), true, JSON.stringify(validateApproval.errors));
}
const validateAudit = ajv.getSchema(schemaByName("audit-mirror-entry.schema.json").$id);
for (const entry of auditMirror) {
  assert.equal(validateAudit(entry), true, JSON.stringify(validateAudit.errors));
}
const validateDoctor = ajv.getSchema(schemaByName("doctor.schema.json").$id);
assert.equal(validateDoctor(doctor), true, JSON.stringify(validateDoctor.errors));

console.log("MOCK CLIENT CONTRACT PASSED: provenance, roles, lifecycle, scoped idempotency, fencing, versioned instructions, bounded approvals, canonical event/audit chains, schema-shaped doctor");
