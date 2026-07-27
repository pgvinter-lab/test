import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import test from "node:test";
import { browserManifest, createFixture, localReadAdapterManifest } from "./helpers.mjs";

function createClaimed(fx, reviewer, source, jobId, suffix, override = false) {
  const job = fx.runtime.jobs.create({
    projectId: fx.projectId,
    actor: fx.owner,
    idempotencyKey: `idempotency.create.${suffix}`,
    jobId,
    mode: "independent_review",
    requiredRole: "reviewer",
    independence: { policy: "required", excludedPrincipalIds: [] },
    target: {
      artifactIds: [source.artifactId],
      instructions: "Review synthetic approval behavior.",
      acceptanceCriteria: ["Preserve the approval audit trail."],
    },
    ...(override ? { approvalPolicyOverride: { reason: "Synthetic M-3/L-4 override declared before creation." } } : {}),
  });
  fx.runtime.jobs.makeClaimable({ projectId: fx.projectId, jobId, actor: fx.owner, idempotencyKey: `idempotency.claimable.${suffix}` });
  return fx.runtime.jobs.claim({ projectId: fx.projectId, jobId, actor: reviewer.ref, idempotencyKey: `idempotency.claim.${suffix}` });
}

function createGrant(fx, reviewer, claimed, suffix, maxUses = 3) {
  return fx.runtime.approvals.createGrant({
    projectId: fx.projectId,
    jobId: claimed.jobId,
    actor: fx.owner,
    grantedTo: reviewer.ref,
    claim: claimed.claim,
    adapterIds: ["adapter.browser.synthetic"],
    actions: ["compose"],
    conditions: [{ name: "artifact_class", operator: "equals", value: "synthetic" }],
    destinations: ["https://example.invalid/drafts"],
    origins: ["https://example.invalid"],
    sideEffectClasses: ["external_reversible"],
    approvalPromptClasses: ["confirm_save_draft"],
    expiresAt: "2026-07-13T13:00:00.000Z",
    maxUses,
    idempotencyKey: `idempotency.grant.${suffix}`,
  });
}

function apiWriteManifest() {
  const reviewSchema = "https://bridge2.local/contracts/v0.1.0-draft.4/schemas/review-job.schema.json";
  return {
    schemaVersion: "0.1.0-draft.4",
    adapterId: "adapter.api.synthetic",
    adapterVersion: "0.1.0-draft.4",
    interfaceVersion: "0.1.0-draft.4",
    displayName: "Synthetic API Writer",
    kind: "api",
    operations: {
      push: { inputSchema: reviewSchema, outputSchema: reviewSchema, idempotent: true, sideEffectClass: "external_reversible", timeoutMs: 5000 },
    },
    capabilities: ["synthetic_api_write"],
    transports: ["stdio"],
    security: {
      credentialMode: "none",
      networkAccess: ["https://api.example.invalid", "https://api.example.invalid/records"],
      sensitiveData: "local_only",
      humanApprovalFor: ["external_irreversible", "sensitive_external"],
      approvalPolicy: {
        defaultDecision: "ask",
        preapproval: "bounded_grants",
        scopeExpansionDecision: "ask",
        grantSchema: "https://bridge2.local/contracts/v0.1.0-draft.4/schemas/approval-grant.schema.json",
      },
    },
    health: { checkOperation: "doctor", states: ["ready", "degraded", "blocked", "offline"] },
  };
}

test("R1-R3 override enforcement is owner-only, immutable, narrow, and audit-consistent", () => {
  const fx = createFixture("override");
  try {
    const reviewer = fx.addIdentity("reviewer_override", ["reviewer"]);
    const collaborator = fx.addIdentity("collaborator_override", ["collaborator"]);
    const source = fx.registerArtifact({ text: "approval policy source" });
    fx.runtime.adapters.register({
      projectId: fx.projectId,
      actor: fx.owner,
      manifest: browserManifest(),
      idempotencyKey: "idempotency.adapter.browser",
    });
    assert.throws(
      () => fx.runtime.jobs.create({
        projectId: fx.projectId,
        actor: collaborator.ref,
        idempotencyKey: "idempotency.nonowner.override",
        jobId: "job.synthetic.nonowner.override",
        mode: "collaboration",
        requiredRole: "collaborator",
        independence: { policy: "not_required" },
        target: { artifactIds: [source.artifactId], instructions: "Attempt forbidden override.", acceptanceCriteria: ["Must fail."] },
        approvalPolicyOverride: { reason: "Not an owner." },
      }),
      /required_role_missing/,
    );

    const defaults = createClaimed(fx, reviewer, source, "job.synthetic.default-policy", "default-policy");
    const defaultGrant = createGrant(fx, reviewer, defaults, "default-policy");
    const amendedDefault = fx.runtime.jobs.amendInstructions({
      projectId: fx.projectId,
      jobId: defaults.jobId,
      actor: fx.owner,
      text: "A non-material amendment still revokes by default.",
      materialAmendment: false,
      idempotencyKey: "idempotency.amend.default-policy",
    });
    assert.equal(fx.runtime.approvals.get(defaultGrant.grantId).status, "revoked");
    assert.deepEqual(amendedDefault.target.instructions.invalidatesApprovalGrantIds, [defaultGrant.grantId]);
    const defaultAmendEvent = fx.runtime.journal.list(fx.projectId).find((event) =>
      event.eventType === "review_job.instructions_amended" && event.aggregate.id === defaults.jobId,
    );
    assert.deepEqual(defaultAmendEvent.data.invalidatedApprovalGrantIds, [defaultGrant.grantId]);
    assert.equal(defaultAmendEvent.data.approvalPolicyOverrideId, undefined);

    const overridden = createClaimed(fx, reviewer, source, "job.synthetic.override-policy", "override-policy", true);
    assert.equal(overridden.approvalPolicyOverride.scope.jobId, overridden.jobId);
    assert.deepEqual(overridden.approvalPolicyOverride.invokedBy, overridden.requestedBy);
    assert.deepEqual(overridden.approvalPolicyOverride.scope.overriddenRules, ["M-3", "L-4"]);
    assert.throws(
      () => fx.runtime.store.run("UPDATE approval_policy_overrides SET document_json = document_json WHERE override_id = ?", overridden.approvalPolicyOverride.overrideId),
      /immutable_approval_policy_override/,
    );
    const overrideGrant = createGrant(fx, reviewer, overridden, "override-policy", 2);
    assert.throws(() => fx.runtime.approvals.createGrant({
      projectId: fx.projectId,
      jobId: overridden.jobId,
      actor: fx.owner,
      grantedTo: reviewer.ref,
      claim: overridden.claim,
      adapterIds: ["adapter.browser.synthetic"],
      actions: ["compose"],
      conditions: [{ name: "api_key", operator: "equals", value: "raw-secret" }],
      destinations: ["https://example.invalid/drafts"],
      origins: ["https://example.invalid"],
      sideEffectClasses: ["external_reversible"],
      expiresAt: "2026-07-13T13:00:00.000Z",
      maxUses: 1,
      idempotencyKey: "idempotency.grant.inline-credential-forbidden",
    }), /credential_material_forbidden_in_broker_envelope/);
    const amendedOverride = fx.runtime.jobs.amendInstructions({
      projectId: fx.projectId,
      jobId: overridden.jobId,
      actor: fx.owner,
      text: "Override amendment retains the bounded grant but no other authority.",
      materialAmendment: true,
      idempotencyKey: "idempotency.amend.override-policy",
    });
    assert.equal(fx.runtime.approvals.get(overrideGrant.grantId).status, "active");
    assert.deepEqual(amendedOverride.target.instructions.invalidatesApprovalGrantIds, []);

    assert.throws(() => fx.runtime.approvals.authorizeBrowserAction({
      projectId: fx.projectId,
      jobId: overridden.jobId,
      actor: reviewer.ref,
      claim: overridden.claim,
      adapterId: "adapter.browser.synthetic",
      operation: "compose",
      origin: "https://example.invalid",
      destination: "https://example.invalid/drafts",
      conditions: { artifact_class: "synthetic", api_key: "raw-secret" },
      inputArtifactIds: [source.artifactId],
      parameters: overridden,
      approvalPromptClass: "confirm_save_draft",
      idempotencyKey: "idempotency.authorize.override.inline-credential-forbidden",
    }), /credential_material_forbidden_in_broker_envelope/);

    const allowed = fx.runtime.approvals.authorizeBrowserAction({
      projectId: fx.projectId,
      jobId: overridden.jobId,
      actor: reviewer.ref,
      claim: overridden.claim,
      adapterId: "adapter.browser.synthetic",
      operation: "compose",
      origin: "https://example.invalid",
      destination: "https://example.invalid/drafts",
      conditions: { artifact_class: "synthetic", extra_condition: true },
      inputArtifactIds: [source.artifactId],
      parameters: overridden,
      approvalPromptClass: "confirm_save_draft",
      idempotencyKey: "idempotency.authorize.override.allow",
    });
    assert.equal(allowed.decision, "allow");
    assert.deepEqual(allowed.overriddenRulesApplied, ["M-3", "L-4"]);
    assert.equal(allowed.approvalPolicyOverrideId, overridden.approvalPolicyOverride.overrideId);

    const mismatch = fx.runtime.approvals.authorizeBrowserAction({
      projectId: fx.projectId,
      jobId: overridden.jobId,
      actor: reviewer.ref,
      claim: overridden.claim,
      adapterId: "adapter.browser.synthetic",
      operation: "compose",
      origin: "https://example.invalid",
      destination: "https://example.invalid/drafts",
      conditions: { artifact_class: "wrong", extra_condition: true },
      inputArtifactIds: [source.artifactId],
      parameters: overridden,
      approvalPromptClass: "confirm_save_draft",
      idempotencyKey: "idempotency.authorize.override.mismatch",
    });
    assert.equal(mismatch.decision, "ask", "L-4 cannot relax an approved condition value");

    const originExpansion = fx.runtime.approvals.authorizeBrowserAction({
      projectId: fx.projectId,
      jobId: overridden.jobId,
      actor: reviewer.ref,
      claim: overridden.claim,
      adapterId: "adapter.browser.synthetic",
      operation: "compose",
      origin: "https://outside.invalid",
      destination: "https://example.invalid/drafts",
      conditions: { artifact_class: "synthetic", extra_condition: true },
      inputArtifactIds: [source.artifactId],
      parameters: overridden,
      approvalPromptClass: "confirm_save_draft",
      idempotencyKey: "idempotency.authorize.override.origin",
    });
    assert.equal(originExpansion.decision, "ask", "override cannot expand the adapter allowlist");

    const events = fx.runtime.journal.list(fx.projectId);
    const consumed = events.find((event) => event.eventType === "approval_grant.consumed" && event.data.actionId === allowed.actionId);
    const decided = events.find((event) => event.eventType === "browser.authorization_decided" && event.data.actionId === allowed.actionId);
    assert.deepEqual(consumed.data.overriddenRulesApplied, ["M-3", "L-4"]);
    assert.deepEqual(decided.data.overriddenRulesApplied, ["M-3", "L-4"]);
    const actionMirror = fx.runtime.store.all("SELECT entry_json FROM audit_mirror_entries ORDER BY mirror_sequence")
      .map((row) => JSON.parse(row.entry_json))
      .find((entry) => entry.event.eventId === decided.eventId);
    assert.equal(actionMirror.actions[0].approvalPolicyOverrideId, overridden.approvalPolicyOverride.overrideId);
    assert.deepEqual(actionMirror.actions[0].overriddenRulesApplied, ["M-3", "L-4"]);
  } finally {
    fx.cleanup();
  }
});

test("M-3 override applies consistently to the dirty source-backup grant consumer", () => {
  const fx = createFixture("override-dirty-backup-grant");
  try {
    fx.runtime.identity.assignRole({
      projectId: fx.projectId,
      actor: fx.owner,
      principalId: fx.owner.principalId,
      role: "collaborator",
      idempotencyKey: "idempotency.override-dirty.owner-collaborator",
    });
    const manifest = localReadAdapterManifest();
    manifest.adapterId = "adapter.backup.override-dirty";
    manifest.operations = {
      "backup.source_only.dirty": {
        ...manifest.operations.inspect,
        sideEffectClass: "local_write",
      },
    };
    fx.runtime.adapters.register({
      projectId: fx.projectId,
      actor: fx.owner,
      manifest,
      idempotencyKey: "idempotency.override-dirty.adapter",
    });
    const source = fx.registerArtifact({ text: "dirty backup override source" });
    const claimed = fx.runtime.jobs.create({
      projectId: fx.projectId,
      actor: fx.owner,
      idempotencyKey: "idempotency.override-dirty.create",
      jobId: "job.synthetic.override-dirty-backup",
      mode: "collaboration",
      requiredRole: "collaborator",
      independence: { policy: "not_required" },
      target: {
        artifactIds: [source.artifactId],
        instructions: "Authorize one bounded synthetic dirty source backup.",
        acceptanceCriteria: ["Preserve M-3 override audit consistency."],
      },
      approvalPolicyOverride: { reason: "Exercise the owner-declared M-3/L-4 policy." },
    });
    fx.runtime.jobs.makeClaimable({
      projectId: fx.projectId,
      jobId: claimed.jobId,
      actor: fx.owner,
      idempotencyKey: "idempotency.override-dirty.claimable",
    });
    const owned = fx.runtime.jobs.claim({
      projectId: fx.projectId,
      jobId: claimed.jobId,
      actor: fx.owner,
      idempotencyKey: "idempotency.override-dirty.claim",
    });
    const backupId = "backup.synthetic.override-dirty";
    const grant = fx.runtime.approvals.createGrant({
      projectId: fx.projectId,
      jobId: owned.jobId,
      actor: fx.owner,
      grantedTo: fx.owner,
      claim: owned.claim,
      adapterIds: [manifest.adapterId],
      actions: ["backup.source_only.dirty"],
      conditions: [{ name: "backupId", operator: "equals", value: backupId }],
      destinations: ["local:backup-destination"],
      origins: ["local:backup-source"],
      sideEffectClasses: ["local_write"],
      expiresAt: "2026-07-13T13:00:00.000Z",
      maxUses: 1,
      idempotencyKey: "idempotency.override-dirty.grant",
    });
    fx.runtime.jobs.amendInstructions({
      projectId: fx.projectId,
      jobId: owned.jobId,
      actor: fx.owner,
      text: "Amended instructions retain this bounded grant under the declared override.",
      materialAmendment: true,
      idempotencyKey: "idempotency.override-dirty.amend",
    });
    assert.equal(fx.runtime.approvals.require(grant.grantId).status, "active");

    fx.runtime.store.transaction(() => fx.runtime.approvals.consumeDirtyBackupGrant({
      projectId: fx.projectId,
      backupId,
      actor: fx.owner,
      approvalGrantId: grant.grantId,
      action: "backup.source_only.dirty",
      conditions: { backupId },
    }));
    const consumed = fx.runtime.journal.list(fx.projectId).find((event) =>
      event.eventType === "approval_grant.consumed" && event.aggregate.id === grant.grantId,
    );
    assert.equal(consumed.data.approvalPolicyOverrideId, owned.approvalPolicyOverride.overrideId);
    assert.deepEqual(consumed.data.overriddenRulesApplied, ["M-3"]);
  } finally {
    fx.cleanup();
  }
});

test("artifact immutability, provenance constraints, adapter schemas, and isolated invocation", async () => {
  const fx = createFixture("artifacts-adapters");
  try {
    const reviewer = fx.addIdentity("reviewer_adapter", ["reviewer"]);
    const source = fx.registerArtifact({ text: "immutable bytes" });
    assert.throws(() => fx.runtime.artifacts.assertCitations([{
      citationId: "citation.synthetic.inline-uri",
      sourceArtifactId: source.artifactId,
      locator: { type: "uri", value: "data:text/plain,raw-secret" },
      claim: "A URI citation must remain metadata-only.",
      verification: { status: "unverified", method: "synthetic" },
    }], fx.projectId), /inline_or_executable_uri_forbidden/);
    assert.throws(
      () => fx.runtime.artifacts.register({
        actor: fx.owner,
        idempotencyKey: "idempotency.artifact.collision",
        artifact: {
          ...source,
          content: { ...source.content, sha256: "f".repeat(64) },
        },
      }),
      /artifact_id_content_collision/,
    );
    assert.throws(
      () => fx.runtime.artifacts.register({
        actor: fx.owner,
        idempotencyKey: "idempotency.artifact.self-cycle",
        artifact: {
          ...source,
          artifactId: "artifact.synthetic.self-cycle",
          provenance: { ...source.provenance, parentArtifactIds: ["artifact.synthetic.self-cycle"] },
        },
      }),
      /artifact_provenance_cycle/,
    );
    assert.throws(
      () => fx.runtime.artifacts.register({
        actor: fx.owner,
        idempotencyKey: "idempotency.artifact.github-forbidden",
        artifact: {
          ...source,
          artifactId: "artifact.synthetic.github-forbidden",
          locations: [{ storageClass: "github_source", uri: "https://example.invalid/private/repo" }],
        },
      }),
      /contract_schema_validation_failed|github_source_kind_forbidden/,
    );
    assert.throws(
      () => fx.runtime.artifacts.register({
        actor: fx.owner,
        idempotencyKey: "idempotency.artifact.credential-uri",
        artifact: {
          ...source,
          artifactId: "artifact.synthetic.credential-uri",
          locations: [{ storageClass: "local", uri: "https://user:password@example.invalid/source" }],
        },
      }),
      /credential_material_forbidden_in_uri/,
    );
    assert.throws(
      () => fx.runtime.artifacts.register({
        actor: fx.owner,
        idempotencyKey: "idempotency.artifact.inline-data-uri",
        artifact: {
          ...source,
          artifactId: "artifact.synthetic.inline-data-uri",
          locations: [{ storageClass: "local", uri: "data:text/plain;base64,c2VjcmV0" }],
        },
      }),
      /inline_or_executable_uri_forbidden/,
    );
    assert.throws(
      () => fx.runtime.artifacts.register({
        actor: fx.owner,
        idempotencyKey: "idempotency.artifact.signed-uri",
        artifact: {
          ...source,
          artifactId: "artifact.synthetic.signed-uri",
          locations: [{ storageClass: "local", uri: "https://example.invalid/source?X-Amz-Signature=raw-secret" }],
        },
      }),
      /credential_material_forbidden_in_uri/,
    );

    const credentialUriManifest = apiWriteManifest();
    credentialUriManifest.adapterId = "adapter.api.credential-uri";
    credentialUriManifest.security = {
      ...credentialUriManifest.security,
      networkAccess: ["https://api.example.invalid/?access_token=raw-secret"],
    };
    assert.throws(
      () => fx.runtime.adapters.register({
        projectId: fx.projectId,
        actor: fx.owner,
        manifest: credentialUriManifest,
        idempotencyKey: "idempotency.adapter.credential-uri",
      }),
      /credential_material_forbidden_in_uri/,
    );
    const executableUriManifest = apiWriteManifest();
    executableUriManifest.adapterId = "adapter.api.executable-uri";
    executableUriManifest.security = { ...executableUriManifest.security, networkAccess: ["javascript:alert(1)"] };
    assert.throws(() => fx.runtime.adapters.register({
      projectId: fx.projectId,
      actor: fx.owner,
      manifest: executableUriManifest,
      idempotencyKey: "idempotency.adapter.executable-uri",
    }), /inline_or_executable_uri_forbidden|network_adapter_uri_scheme_forbidden/);

    const invalidCredentialed = { ...localReadAdapterManifest(), adapterId: "adapter.invalid.credentialed" };
    invalidCredentialed.security = { ...invalidCredentialed.security, credentialMode: "environment_reference" };
    assert.throws(
      () => fx.runtime.adapters.register({
        projectId: fx.projectId,
        actor: fx.owner,
        manifest: invalidCredentialed,
        idempotencyKey: "idempotency.adapter.invalid-credentialed",
      }),
      /contract_schema_validation_failed|credentialed_adapter_in_process_forbidden/,
    );

    const manifest = localReadAdapterManifest();
    fx.runtime.adapters.register({
      projectId: fx.projectId,
      actor: fx.owner,
      manifest,
      idempotencyKey: "idempotency.adapter.local-read",
    });
    const seenVersions = [];
    fx.runtime.adapterHost.registerInProcessHandler(manifest.adapterId, (envelope) => {
      seenVersions.push(envelope.adapterVersion);
      return envelope.parameters;
    });
    const claimed = createClaimed(fx, reviewer, source, "job.synthetic.adapter", "adapter");
    const result = await fx.runtime.adapterHost.invoke({
      projectId: fx.projectId,
      jobId: claimed.jobId,
      actor: reviewer.ref,
      claim: claimed.claim,
      adapterId: manifest.adapterId,
      operation: "inspect",
      deadline: "2026-07-13T12:05:00.000Z",
      inputArtifactIds: [source.artifactId],
      parameters: claimed,
      idempotencyKey: "idempotency.adapter.invoke",
    });
    assert.deepEqual(result, claimed);
    const replay = await fx.runtime.adapterHost.invoke({
      projectId: fx.projectId,
      jobId: claimed.jobId,
      actor: reviewer.ref,
      claim: claimed.claim,
      adapterId: manifest.adapterId,
      operation: "inspect",
      deadline: "2026-07-13T12:05:00.000Z",
      inputArtifactIds: [source.artifactId],
      parameters: claimed,
      idempotencyKey: "idempotency.adapter.invoke",
    });
    assert.deepEqual(replay, claimed);
    assert.equal(fx.runtime.store.get("SELECT COUNT(*) AS count FROM adapter_invocations").count, 1);
    assert.deepEqual(seenVersions, [manifest.adapterVersion]);

    const secretOutputManifest = { ...localReadAdapterManifest(), adapterId: "adapter.local.secret-output" };
    fx.runtime.adapters.register({
      projectId: fx.projectId,
      actor: fx.owner,
      manifest: secretOutputManifest,
      idempotencyKey: "idempotency.adapter.secret-output",
    });
    fx.runtime.adapterHost.registerInProcessHandler(secretOutputManifest.adapterId, () => ({ ...claimed, token: "raw-secret" }));
    await assert.rejects(() => fx.runtime.adapterHost.invoke({
      projectId: fx.projectId,
      jobId: claimed.jobId,
      actor: reviewer.ref,
      claim: claimed.claim,
      adapterId: secretOutputManifest.adapterId,
      operation: "inspect",
      deadline: "2026-07-13T12:05:00.000Z",
      inputArtifactIds: [source.artifactId],
      parameters: claimed,
      idempotencyKey: "idempotency.adapter.secret-output.invoke",
    }), /credential_material_forbidden_in_broker_envelope/);
    const secretOutputRow = fx.runtime.store.get(
      "SELECT status, response_json FROM adapter_invocations WHERE idempotency_key = ?",
      "idempotency.adapter.secret-output.invoke",
    );
    assert.equal(secretOutputRow.status, "failed");
    assert.equal(secretOutputRow.response_json, null);

    const nextManifest = { ...manifest, adapterVersion: "0.1.1" };
    fx.runtime.adapters.register({
      projectId: fx.projectId,
      actor: fx.owner,
      manifest: nextManifest,
      idempotencyKey: "idempotency.adapter.local-read.v2",
    });
    const versionedInvocation = {
      projectId: fx.projectId,
      jobId: claimed.jobId,
      actor: reviewer.ref,
      claim: claimed.claim,
      adapterId: manifest.adapterId,
      operation: "inspect",
      deadline: "2026-07-13T12:05:00.000Z",
      inputArtifactIds: [source.artifactId],
      parameters: claimed,
    };
    await assert.rejects(
      fx.runtime.adapterHost.invoke({ ...versionedInvocation, adapterVersion: nextManifest.adapterVersion, idempotencyKey: "idempotency.adapter.invoke.v2.unregistered" }),
      /adapter_launcher_not_registered/,
    );
    assert.deepEqual(await fx.runtime.adapterHost.invoke({
      ...versionedInvocation,
      adapterVersion: manifest.adapterVersion,
      idempotencyKey: "idempotency.adapter.invoke.v1.explicit",
    }), claimed, "the v1 executor remains bound to v1 after the active manifest advances");
    fx.runtime.adapterHost.registerInProcessHandler(nextManifest.adapterId, (envelope) => {
      seenVersions.push(envelope.adapterVersion);
      return envelope.parameters;
    }, nextManifest.adapterVersion);
    assert.deepEqual(await fx.runtime.adapterHost.invoke({
      ...versionedInvocation,
      adapterVersion: nextManifest.adapterVersion,
      idempotencyKey: "idempotency.adapter.invoke.v2.registered",
    }), claimed);
    assert.deepEqual(seenVersions, [manifest.adapterVersion, manifest.adapterVersion, nextManifest.adapterVersion]);
  } finally {
    fx.cleanup();
  }
});

test("bounded one-use authorization applies to side-effecting API adapters without browser-only events", async () => {
  const fx = createFixture("api-authorization");
  try {
    const reviewer = fx.addIdentity("reviewer_api", ["reviewer"]);
    const source = fx.registerArtifact({ text: "bounded API source" });
    const manifest = apiWriteManifest();
    fx.runtime.adapters.register({
      projectId: fx.projectId,
      actor: fx.owner,
      manifest,
      idempotencyKey: "idempotency.adapter.api-write",
    });
    const brokerScript = path.join(fx.root, "api-broker.mjs");
    const proofPath = path.join(fx.root, "api-broker-proof.json");
    fs.writeFileSync(brokerScript, `
      import fs from "node:fs";
      let buffer = "";
      let envelope;
      process.stdin.setEncoding("utf8");
      process.stdin.on("data", (chunk) => {
        buffer += chunk;
        for (;;) {
          const newline = buffer.indexOf("\\n");
          if (newline < 0) break;
          const message = JSON.parse(buffer.slice(0, newline));
          buffer = buffer.slice(newline + 1);
          if (!envelope) {
            envelope = message;
            process.stdout.write(JSON.stringify({ protocol: "bridge2.adapter-fence-request.v1", operationId: envelope.operationId }) + "\\n");
          } else {
            fs.writeFileSync(process.argv[2], JSON.stringify({ envelope, grant: message }));
            process.stdout.write(JSON.stringify(envelope.parameters));
          }
        }
      });
    `);
    fx.runtime.adapterHost.registerIsolatedBroker(manifest.adapterId, { command: process.execPath, args: [brokerScript, proofPath] });
    const claimed = createClaimed(fx, reviewer, source, "job.synthetic.api-write", "api-write");
    const grant = fx.runtime.approvals.createGrant({
      projectId: fx.projectId,
      jobId: claimed.jobId,
      actor: fx.owner,
      grantedTo: reviewer.ref,
      claim: claimed.claim,
      adapterIds: [manifest.adapterId],
      actions: ["push"],
      conditions: [{ name: "record", operator: "equals", value: "synthetic" }],
      origins: ["https://api.example.invalid"],
      destinations: ["https://api.example.invalid/records"],
      sideEffectClasses: ["external_reversible"],
      expiresAt: "2026-07-13T13:00:00.000Z",
      maxUses: 1,
      idempotencyKey: "idempotency.grant.api-write",
    });
    const networkContext = {
      origin: "https://api.example.invalid",
      destination: "https://api.example.invalid/records",
      conditions: { record: "synthetic" },
    };
    const authorization = fx.runtime.approvals.authorizeAdapterAction({
      projectId: fx.projectId,
      jobId: claimed.jobId,
      actor: reviewer.ref,
      claim: claimed.claim,
      adapterId: manifest.adapterId,
      operation: "push",
      ...networkContext,
      inputArtifactIds: [source.artifactId],
      parameters: claimed,
      idempotencyKey: "idempotency.authorize.api-write",
    });
    assert.equal(authorization.decision, "allow");
    assert.equal(fx.runtime.approvals.require(grant.grantId).status, "exhausted");
    assert.equal(
      fx.runtime.journal.list(fx.projectId).some((event) => event.eventType === "browser.authorization_decided" && event.aggregate.id === authorization.actionId),
      false,
    );
    const invocation = {
      projectId: fx.projectId,
      jobId: claimed.jobId,
      actor: reviewer.ref,
      claim: claimed.claim,
      adapterId: manifest.adapterId,
      operation: "push",
      deadline: "2026-07-13T12:05:00.000Z",
      inputArtifactIds: [source.artifactId],
      parameters: claimed,
      authorization: { decision: "allow", actionId: authorization.actionId },
      networkContext,
      idempotencyKey: "idempotency.invoke.api-write",
    };
    assert.deepEqual(await fx.runtime.adapterHost.invoke(invocation), claimed);
    const proof = JSON.parse(fs.readFileSync(proofPath, "utf8"));
    assert.equal(proof.envelope.generation, claimed.claim.generation);
    assert.equal(proof.envelope.claimId, claimed.claim.claimId);
    assert.equal(proof.envelope.fencingToken, claimed.claim.fencingToken);
    assert.equal(proof.envelope.authorization, undefined);
    assert.equal(proof.grant.authorization.actionId, authorization.actionId);
    assert.equal(fx.runtime.store.get("SELECT status FROM adapter_action_authorizations WHERE action_id = ?", authorization.actionId).status, "consumed");
    fx.runtime.jobs.advanceGeneration({
      projectId: fx.projectId,
      actor: fx.owner,
      expectedGeneration: 1,
      newGeneration: 2,
      approvalRef: "approval.takeover.synthetic.api-replay",
      targetHostId: fx.owner.hostId,
      reason: "Prove a completed invocation remains replayable without reserving stale work.",
      idempotencyKey: "idempotency.takeover.api-replay",
    });
    assert.deepEqual(await fx.runtime.adapterHost.invoke(invocation), claimed, "completed replay precedes active-generation reservation checks");
  } finally {
    fx.cleanup();
  }
});

test("bounded grants fail closed when the current adapter manifest disables preapproval", () => {
  const fx = createFixture("adapter-preapproval-disabled");
  try {
    const reviewer = fx.addIdentity("reviewer_preapproval_disabled", ["reviewer"]);
    const source = fx.registerArtifact({ text: "preapproval manifest drift" });
    const manifest = apiWriteManifest();
    fx.runtime.adapters.register({
      projectId: fx.projectId,
      actor: fx.owner,
      manifest,
      idempotencyKey: "idempotency.adapter.preapproval.v1",
    });
    const claimed = createClaimed(fx, reviewer, source, "job.synthetic.preapproval-disabled", "preapproval-disabled");
    const grantInput = {
      projectId: fx.projectId,
      jobId: claimed.jobId,
      actor: fx.owner,
      grantedTo: reviewer.ref,
      claim: claimed.claim,
      adapterIds: [manifest.adapterId],
      actions: ["push"],
      conditions: [{ name: "record", operator: "equals", value: "synthetic" }],
      origins: ["https://api.example.invalid"],
      destinations: ["https://api.example.invalid/records"],
      sideEffectClasses: ["external_reversible"],
      expiresAt: "2026-07-13T13:00:00.000Z",
      maxUses: 2,
      idempotencyKey: "idempotency.grant.preapproval.v1",
    };
    fx.runtime.approvals.createGrant(grantInput);
    assert.throws(() => fx.runtime.approvals.createGrant({
      ...grantInput,
      origins: ["https://user:password@api.example.invalid"],
      idempotencyKey: "idempotency.grant.credential-uri",
    }), /credential_material_forbidden_in_uri/);

    const disabled = {
      ...manifest,
      adapterVersion: "0.1.1",
      security: {
        ...manifest.security,
        approvalPolicy: { ...manifest.security.approvalPolicy, preapproval: "disabled" },
      },
    };
    fx.runtime.adapters.register({
      projectId: fx.projectId,
      actor: fx.owner,
      manifest: disabled,
      idempotencyKey: "idempotency.adapter.preapproval.v2-disabled",
    });
    assert.throws(() => fx.runtime.approvals.createGrant({
      ...grantInput,
      idempotencyKey: "idempotency.grant.preapproval.disabled",
    }), /adapter_bounded_grants_disabled/);
    assert.throws(() => fx.runtime.approvals.authorizeAdapterAction({
      projectId: fx.projectId,
      jobId: claimed.jobId,
      actor: reviewer.ref,
      claim: claimed.claim,
      adapterId: manifest.adapterId,
      operation: "push",
      origin: "https://api.example.invalid",
      destination: "https://api.example.invalid/records",
      conditions: { record: "synthetic" },
      inputArtifactIds: [source.artifactId],
      parameters: claimed,
      idempotencyKey: "idempotency.authorize.preapproval.disabled",
    }), /adapter_bounded_grants_disabled/);
  } finally {
    fx.cleanup();
  }
});

test("approval command replays precede expired fences, time bounds, and active manifest drift", () => {
  const fx = createFixture("approval-replay-order");
  try {
    const reviewer = fx.addIdentity("reviewer_replay_order", ["reviewer"]);
    const source = fx.registerArtifact({ text: "approval replay ordering" });
    const manifest = browserManifest();
    fx.runtime.adapters.register({
      projectId: fx.projectId,
      actor: fx.owner,
      manifest,
      idempotencyKey: "idempotency.adapter.replay-order",
    });
    const claimed = createClaimed(fx, reviewer, source, "job.synthetic.replay-order", "replay-order");
    const grantInput = {
      projectId: fx.projectId,
      jobId: claimed.jobId,
      actor: fx.owner,
      grantedTo: reviewer.ref,
      claim: claimed.claim,
      adapterIds: [manifest.adapterId],
      actions: ["compose"],
      conditions: [{ name: "artifact_class", operator: "equals", value: "synthetic" }],
      destinations: ["https://example.invalid/drafts"],
      origins: ["https://example.invalid"],
      sideEffectClasses: ["external_reversible"],
      approvalPromptClasses: ["confirm_save_draft"],
      expiresAt: "2026-07-13T13:00:00.000Z",
      maxUses: 2,
      idempotencyKey: "idempotency.grant.replay-order",
    };
    const grant = fx.runtime.approvals.createGrant(grantInput);
    const actionInput = {
      projectId: fx.projectId,
      jobId: claimed.jobId,
      actor: reviewer.ref,
      claim: claimed.claim,
      adapterId: manifest.adapterId,
      operation: "compose",
      origin: "https://example.invalid",
      destination: "https://example.invalid/drafts",
      conditions: { artifact_class: "synthetic" },
      inputArtifactIds: [source.artifactId],
      parameters: claimed,
      approvalPromptClass: "confirm_save_draft",
      idempotencyKey: "idempotency.action.replay-order",
    };
    const decision = fx.runtime.approvals.authorizeBrowserAction(actionInput);
    assert.equal(decision.decision, "allow");

    fx.clock.value = "2026-07-13T14:00:00.000Z";
    fx.runtime.adapters.register({
      projectId: fx.projectId,
      actor: fx.owner,
      manifest: { ...manifest, adapterVersion: "0.1.1" },
      idempotencyKey: "idempotency.adapter.replay-order.v2",
    });
    assert.deepEqual(fx.runtime.approvals.createGrant(grantInput), grant);
    assert.deepEqual(fx.runtime.approvals.authorizeBrowserAction(actionInput), decision);
  } finally {
    fx.cleanup();
  }
});

test("historical owner authority preserves sealed overrides and decision waivers after revocation", () => {
  const fx = createFixture("historical-owner-authority");
  try {
    const reviewer = fx.addIdentity("reviewer_historical_owner", ["reviewer"]);
    const successor = fx.addIdentity("successor_owner", ["owner"]);
    const source = fx.registerArtifact({ text: "historical authority source" });
    const decision = fx.registerArtifact({ kind: "decision", text: "Owner approves the independence waiver." });
    assert.throws(() => fx.runtime.jobs.create({
      projectId: fx.projectId,
      actor: fx.owner,
      idempotencyKey: "idempotency.historical-waiver.generic-rejected",
      jobId: "job.synthetic.generic-waiver-rejected",
      mode: "independent_review",
      requiredRole: "reviewer",
      independence: {
        policy: "waived_by_owner",
        waiverReason: "Synthetic waiver requires a decision artifact.",
        waiverApprovalArtifactId: source.artifactId,
      },
      target: { artifactIds: [source.artifactId], instructions: "Reject a generic waiver artifact.", acceptanceCriteria: ["Decision evidence is required."] },
    }), /owner_waiver_artifact_required/);

    const job = fx.runtime.jobs.create({
      projectId: fx.projectId,
      actor: fx.owner,
      idempotencyKey: "idempotency.historical-authority.create",
      jobId: "job.synthetic.historical-authority",
      mode: "independent_review",
      requiredRole: "reviewer",
      independence: {
        policy: "waived_by_owner",
        waiverReason: "The owner decision expressly approves this synthetic waiver.",
        waiverApprovalArtifactId: decision.artifactId,
      },
      target: { artifactIds: [source.artifactId], instructions: "Exercise historical owner authority.", acceptanceCriteria: ["Retain immutable authority evidence."] },
      approvalPolicyOverride: { reason: "Exercise the owner-only draft.4 override." },
    });
    fx.runtime.identity.revokeRole({
      projectId: fx.projectId,
      actor: successor.ref,
      principalId: fx.owner.principalId,
      role: "owner",
      idempotencyKey: "idempotency.historical-authority.revoke-owner",
    });
    assert.equal(fx.runtime.jobs.requireForProject(fx.projectId, job.jobId).approvalPolicyOverride.overrideId, job.approvalPolicyOverride.overrideId);
    const claimable = fx.runtime.jobs.makeClaimable({
      projectId: fx.projectId,
      jobId: job.jobId,
      actor: successor.ref,
      idempotencyKey: "idempotency.historical-authority.claimable",
    });
    assert.equal(claimable.independence.waiverApprovalArtifactId, decision.artifactId);
    assert.equal(fx.runtime.jobs.claim({
      projectId: fx.projectId,
      jobId: job.jobId,
      actor: reviewer.ref,
      idempotencyKey: "idempotency.historical-authority.claim",
    }).status, "claimed");
  } finally {
    fx.cleanup();
  }
});

test("sealed citation attestations survive verifier revocation while new attestations require live authority", () => {
  const fx = createFixture("citation-history");
  try {
    const reviewer = fx.addIdentity("citation_verifier", ["reviewer"]);
    const source = fx.registerArtifact({ text: "citation source" });
    const citation = {
      citationId: "citation.synthetic.verified.001",
      sourceArtifactId: source.artifactId,
      locator: { type: "line", value: "1" },
      claim: "The synthetic source is present.",
      verification: {
        status: "verified",
        method: "synthetic line comparison",
        verifiedBy: reviewer.ref,
        verifiedAt: fx.clock.value,
      },
    };
    fx.registerArtifact({ actor: reviewer.ref, kind: "review", text: "verified citation", citations: [citation] });
    fx.runtime.identity.revokeSession({
      projectId: fx.projectId,
      actor: fx.owner,
      sessionId: reviewer.session.sessionId,
      idempotencyKey: "idempotency.citation-history.revoke-verifier",
    });
    assert.doesNotThrow(() => fx.runtime.artifacts.assertCitations([citation], fx.projectId, true));
    assert.throws(() => fx.runtime.artifacts.assertCitations(
      [{ ...citation, citationId: "citation.synthetic.verified.002" }],
      fx.projectId,
      false,
      reviewer.ref,
    ), /session_not_active/);
  } finally {
    fx.cleanup();
  }
});

test("identity administration is authorized, replay-idempotent, and preserves role grant and revocation provenance", () => {
  const fx = createFixture("identity-admin");
  try {
    const administrator = fx.addIdentity("identity_administrator", ["administrator"]);
    const target = fx.addIdentity("identity_target", ["collaborator", "reviewer"]);
    const assigned = fx.runtime.store.get(
      "SELECT * FROM project_roles WHERE project_id = ? AND principal_id = ? AND role = 'reviewer' AND status = 'active'",
      fx.projectId,
      target.ref.principalId,
    );
    assert.equal(assigned.granted_by_principal_id, fx.owner.principalId);
    assert.equal(assigned.granted_by_session_id, fx.owner.sessionId);
    assert.equal(assigned.granted_by_host_id, fx.owner.hostId);
    assert.equal(assigned.granted_generation, 1);

    const revokeInput = {
      projectId: fx.projectId,
      actor: administrator.ref,
      principalId: target.ref.principalId,
      role: "reviewer",
      idempotencyKey: "idempotency.identity.revoke-reviewer",
    };
    const revoked = fx.runtime.identity.revokeRole(revokeInput);
    assert.deepEqual(fx.runtime.identity.revokeRole(revokeInput), revoked);
    assert.equal(fx.runtime.identity.hasRole(fx.projectId, target.ref.principalId, "reviewer"), false);
    const historical = fx.runtime.store.get("SELECT * FROM project_roles WHERE role_grant_id = ?", assigned.role_grant_id);
    assert.equal(historical.status, "revoked");
    assert.equal(historical.revoked_by_principal_id, administrator.ref.principalId);
    assert.equal(historical.revoked_by_session_id, administrator.ref.sessionId);
    assert.equal(historical.revoked_by_host_id, administrator.ref.hostId);
    assert.equal(historical.revoked_generation, 1);
    assert.throws(
      () => fx.runtime.identity.revokeRole({ ...revokeInput, idempotencyKey: "idempotency.identity.revoke-reviewer-fresh" }),
      /role_not_active/,
    );

    const disableInput = {
      projectId: fx.projectId,
      actor: administrator.ref,
      principalId: target.ref.principalId,
      idempotencyKey: "idempotency.identity.disable-target",
    };
    const disabled = fx.runtime.identity.disablePrincipal(disableInput);
    assert.deepEqual(fx.runtime.identity.disablePrincipal(disableInput), disabled);
    assert.equal(fx.runtime.store.get("SELECT status FROM principals WHERE principal_id = ?", target.ref.principalId).status, "disabled");
    assert.equal(fx.runtime.store.get("SELECT status FROM sessions WHERE session_id = ?", target.ref.sessionId).status, "revoked");
    assert.deepEqual(fx.runtime.identity.roles(fx.projectId, target.ref.principalId), []);
    assert.throws(
      () => fx.runtime.identity.disablePrincipal({ ...disableInput, idempotencyKey: "idempotency.identity.disable-target-fresh" }),
      /principal_not_active/,
    );

    const secondaryHost = {
      hostId: "host.synthetic.quarantine-target",
      instanceId: "instance.synthetic.quarantine-target",
      hostnameHash: "a".repeat(64),
      platform: "windows",
      status: "active",
      registeredAt: fx.clock.value,
    };
    fx.runtime.identity.registerHost({
      projectId: fx.projectId,
      actor: fx.owner,
      host: secondaryHost,
      idempotencyKey: "idempotency.identity.register-secondary-host",
    });
    const rawCredentialSession = {
      sessionId: "session.synthetic.raw-credential",
      principalId: fx.owner.principalId,
      hostId: secondaryHost.hostId,
      startedAt: fx.clock.value,
      expiresAt: "2026-07-13T13:00:00.000Z",
      status: "active",
      authentication: { method: "service_token", assurance: "strong", credentialRef: "Bearer raw-secret-token" },
      transportBinding: {
        transport: "stdio",
        transportSessionId: "stdio-raw-credential-0001",
        serverInstanceId: "server.synthetic.raw-credential",
      },
    };
    assert.throws(() => fx.runtime.identity.createSession({
      projectId: fx.projectId,
      actor: fx.owner,
      session: rawCredentialSession,
      idempotencyKey: "idempotency.identity.raw-credential",
    }), /invalid_credential_reference/);
    const opaqueCredentialSession = {
      ...rawCredentialSession,
      sessionId: "session.synthetic.opaque-credential",
      authentication: { ...rawCredentialSession.authentication, credentialRef: "broker-ref:synthetic-owner-token" },
      transportBinding: {
        ...rawCredentialSession.transportBinding,
        transportSessionId: "stdio-opaque-credential-0001",
      },
    };
    assert.equal(fx.runtime.identity.createSession({
      projectId: fx.projectId,
      actor: fx.owner,
      session: opaqueCredentialSession,
      idempotencyKey: "idempotency.identity.opaque-credential",
    }).authentication.credentialRef, "broker-ref:synthetic-owner-token");
    const futureSession = {
      ...opaqueCredentialSession,
      sessionId: "session.synthetic.future",
      startedAt: "2026-07-13T13:00:00.000Z",
      expiresAt: "2026-07-13T14:00:00.000Z",
      transportBinding: {
        ...opaqueCredentialSession.transportBinding,
        transportSessionId: "stdio-future-session-0001",
      },
    };
    fx.runtime.identity.createSession({
      projectId: fx.projectId,
      actor: fx.owner,
      session: futureSession,
      idempotencyKey: "idempotency.identity.future-session",
    });
    assert.throws(() => fx.runtime.identity.authorize(fx.projectId, {
      principalId: futureSession.principalId,
      sessionId: futureSession.sessionId,
      hostId: futureSession.hostId,
    }), /session_not_started/);
    const hostInput = {
      projectId: fx.projectId,
      actor: administrator.ref,
      hostId: secondaryHost.hostId,
      status: "quarantined",
      idempotencyKey: "idempotency.identity.quarantine-host",
    };
    const quarantined = fx.runtime.identity.setHostStatus(hostInput);
    assert.deepEqual(fx.runtime.identity.setHostStatus(hostInput), quarantined);
    assert.equal(fx.runtime.store.get("SELECT status FROM hosts WHERE host_id = ?", secondaryHost.hostId).status, "quarantined");
    assert.throws(
      () => fx.runtime.identity.setHostStatus({ ...hostInput, idempotencyKey: "idempotency.identity.quarantine-host-fresh" }),
      /host_not_active/,
    );
  } finally {
    fx.cleanup();
  }
});
