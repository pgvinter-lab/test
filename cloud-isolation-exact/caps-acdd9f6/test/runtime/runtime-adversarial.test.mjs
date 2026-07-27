import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { BridgeRuntime, sha256 } from "../../dist/v2/index.js";
import { browserManifest, createFixture, localReadAdapterManifest, session } from "./helpers.mjs";

test("live database and audit paths reject collisions and reparse ancestors", () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "bridge2-state-paths-"));
  try {
    const databasePath = path.join(root, "state.sqlite");
    assert.throws(() => new BridgeRuntime({
      databasePath,
      auditMirrorPath: databasePath,
      initialize: true,
    }), /audit_mirror_sqlite_path_collision/);
    assert.throws(() => new BridgeRuntime({
      databasePath,
      auditMirrorPath: `${databasePath}-wal`,
      initialize: true,
    }), /audit_mirror_sqlite_path_collision/);

    const physical = path.join(root, "physical-state");
    const linked = path.join(root, "linked-state");
    fs.mkdirSync(physical);
    fs.symlinkSync(physical, linked, process.platform === "win32" ? "junction" : "dir");
    assert.throws(() => new BridgeRuntime({
      databasePath: path.join(linked, "nested", "state.sqlite"),
      auditMirrorPath: path.join(root, "audit.jsonl"),
      initialize: true,
    }), /database_path_reparse_forbidden/);
    assert.equal(fs.existsSync(path.join(physical, "nested")), false, "reparse rejection must happen before creating through the junction");

    const hardlinkDatabase = path.join(root, "hardlink-state.sqlite");
    const initialized = new BridgeRuntime({ databasePath: hardlinkDatabase, initialize: true });
    initialized.close();
    const hardlinkAudit = path.join(root, "hardlink-audit.jsonl");
    fs.linkSync(hardlinkDatabase, hardlinkAudit);
    assert.throws(() => new BridgeRuntime({
      databasePath: hardlinkDatabase,
      auditMirrorPath: hardlinkAudit,
    }), /audit_mirror_sqlite_path_collision/);
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
});

test("transient SQLite sidecar removal is treated as absence and rechecked after WAL initialization", () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "bridge2-sidecar-race-"));
  const databasePath = path.join(root, "state.sqlite");
  const auditMirrorPath = path.join(root, "audit.jsonl");
  const walPath = `${databasePath}-wal`;
  const originalStatSync = fs.statSync;
  let runtime;
  let walStatCalls = 0;
  try {
    fs.writeFileSync(auditMirrorPath, "", "utf8");
    fs.writeFileSync(walPath, "transient", "utf8");
    fs.statSync = (target, options) => {
      if (path.resolve(String(target)) === path.resolve(walPath)) {
        walStatCalls += 1;
        if (walStatCalls === 1) fs.rmSync(walPath, { force: true });
      }
      return originalStatSync(target, options);
    };

    runtime = new BridgeRuntime({ databasePath, auditMirrorPath, initialize: true });
    assert.ok(walStatCalls >= 2, "the collision guard must recheck sidecars after WAL initialization");
  } finally {
    fs.statSync = originalStatSync;
    runtime?.close();
    fs.rmSync(root, { recursive: true, force: true });
  }
});

test("doctor binds relational event columns and flags forbidden-name symlinks without following them", (t) => {
  const fx = createFixture("doctor-relational-integrity");
  try {
    const source = fx.registerArtifact({ text: "doctor relational binding" });
    fx.runtime.jobs.create({
      projectId: fx.projectId,
      actor: fx.owner,
      idempotencyKey: "idempotency.doctor.relational-event",
      jobId: "job.synthetic.doctor-relational-event",
      mode: "collaboration",
      requiredRole: "collaborator",
      independence: { policy: "not_required", excludedPrincipalIds: [] },
      target: {
        artifactIds: [source.artifactId],
        instructions: "Create an immutable event for relational binding verification.",
        acceptanceCriteria: ["Doctor detects relational-column corruption."],
      },
    });
    fx.runtime.store.exec("DROP TRIGGER events_no_update");
    fx.runtime.store.run(
      "UPDATE events SET event_type = 'review_job.cancelled' WHERE project_id = ? AND sequence = (SELECT MAX(sequence) FROM events WHERE project_id = ?)",
      fx.projectId,
      fx.projectId,
    );
    const relationalDoctor = fx.runtime.doctor.run({ projectId: fx.projectId, hostId: fx.owner.hostId });
    assert.equal(relationalDoctor.checks.find((check) => check.checkId === "check.events.sequence").status, "fail");

    const sourceRoot = path.join(fx.root, "doctor-source");
    fs.mkdirSync(sourceRoot);
    const external = path.join(fx.root, "external-secret-placeholder");
    fs.writeFileSync(external, "synthetic placeholder\n");
    try {
      fs.symlinkSync(external, path.join(sourceRoot, ".env"), "file");
    } catch (error) {
      t.diagnostic(`symlink secret-placement subcheck unavailable: ${error.message}`);
      return;
    }
    const secretDoctor = fx.runtime.doctor.run({ projectId: fx.projectId, hostId: fx.owner.hostId, sourceRoot });
    assert.equal(secretDoctor.checks.find((check) => check.checkId === "check.secrets.placement").status, "fail");

    const recoveryRoot = path.join(fx.root, "doctor-recovery");
    const recoveryKeyDirectory = path.join(recoveryRoot, "recovery-keys");
    fs.mkdirSync(recoveryKeyDirectory, { recursive: true });
    fs.writeFileSync(path.join(recoveryKeyDirectory, "bridge2-test.private.pem"), "synthetic private-key placeholder\n");
    const unapprovedKeyDoctor = fx.runtime.doctor.run({ projectId: fx.projectId, hostId: fx.owner.hostId, recoveryRoot });
    assert.equal(unapprovedKeyDoctor.checks.find((check) => check.checkId === "check.secrets.placement").status, "fail");
    const approvedKeyDoctor = fx.runtime.doctor.run({
      projectId: fx.projectId,
      hostId: fx.owner.hostId,
      recoveryRoot,
      recoveryKeyDirectories: [recoveryKeyDirectory],
    });
    assert.equal(approvedKeyDoctor.checks.find((check) => check.checkId === "check.secrets.placement").status, "pass");
    const nestedKeyDirectory = path.join(recoveryKeyDirectory, "nested");
    fs.mkdirSync(nestedKeyDirectory);
    fs.writeFileSync(path.join(nestedKeyDirectory, "bridge2-nested.private.pem"), "synthetic nested private-key placeholder\n");
    const nestedKeyDoctor = fx.runtime.doctor.run({
      projectId: fx.projectId,
      hostId: fx.owner.hostId,
      recoveryRoot,
      recoveryKeyDirectories: [recoveryKeyDirectory],
    });
    assert.equal(nestedKeyDoctor.checks.find((check) => check.checkId === "check.secrets.placement").status, "fail");
    fs.rmSync(nestedKeyDirectory, { recursive: true });
    fs.writeFileSync(path.join(recoveryKeyDirectory, ".env"), "synthetic forbidden placeholder\n");
    const overbroadExceptionDoctor = fx.runtime.doctor.run({
      projectId: fx.projectId,
      hostId: fx.owner.hostId,
      recoveryRoot,
      recoveryKeyDirectories: [recoveryKeyDirectory],
    });
    assert.equal(overbroadExceptionDoctor.checks.find((check) => check.checkId === "check.secrets.placement").status, "fail");
  } finally {
    fx.cleanup();
  }
});

function createClaimed(fx, actor, source, jobId, suffix, leaseMs = 60_000) {
  const created = fx.runtime.jobs.create({
    projectId: fx.projectId,
    actor: fx.owner,
    idempotencyKey: `idempotency.adversarial.create.${suffix}`,
    jobId,
    mode: "independent_review",
    requiredRole: "reviewer",
    independence: { policy: "required", excludedPrincipalIds: [] },
    target: {
      artifactIds: [source.artifactId],
      instructions: "Perform the bounded synthetic adversarial review.",
      acceptanceCriteria: ["Preserve contract and authorization invariants."],
    },
  });
  fx.runtime.jobs.makeClaimable({
    projectId: fx.projectId,
    jobId,
    actor: fx.owner,
    idempotencyKey: `idempotency.adversarial.claimable.${suffix}`,
  });
  return fx.runtime.jobs.claim({
    projectId: fx.projectId,
    jobId,
    actor: actor.ref,
    leaseMs,
    idempotencyKey: `idempotency.adversarial.claim.${suffix}`,
  });
}

async function waitForFile(filePath, timeoutMs = 5000) {
  const deadline = Date.now() + timeoutMs;
  while (!fs.existsSync(filePath)) {
    if (Date.now() >= deadline) throw new Error(`Timed out waiting for ${filePath}`);
    await new Promise((resolve) => setTimeout(resolve, 10));
  }
}

test("contract validation, idempotency, immutable storage, and running-claim recovery fail closed", () => {
  const fx = createFixture("adversarial-core");
  try {
    const reviewer = fx.addIdentity("adversarial_reviewer", ["reviewer"]);
    const source = fx.registerArtifact({ text: "adversarial contract source" });
    const generatedInput = {
      projectId: fx.projectId,
      actor: fx.owner,
      idempotencyKey: "idempotency.generated-job.replay",
      mode: "independent_review",
      requiredRole: "reviewer",
      independence: { policy: "required", excludedPrincipalIds: [] },
      target: {
        artifactIds: [source.artifactId],
        instructions: "Generate an identifier exactly once under idempotent replay.",
        acceptanceCriteria: ["Replay returns the original identifier."],
      },
    };
    const generated = fx.runtime.jobs.create(generatedInput);
    assert.deepEqual(fx.runtime.jobs.create(generatedInput), generated);
    const refreshedOwnerSession = session(
      "owner_refreshed",
      fx.owner.principalId,
      fx.owner.hostId,
      fx.clock.value,
      "stdio-owner-refreshed-session-0001",
    );
    fx.runtime.identity.createSession({
      projectId: fx.projectId,
      actor: fx.owner,
      session: refreshedOwnerSession,
      idempotencyKey: "idempotency.adversarial.owner-refreshed-session",
    });
    const refreshedOwner = { principalId: fx.owner.principalId, sessionId: refreshedOwnerSession.sessionId, hostId: fx.owner.hostId };
    assert.deepEqual(
      fx.runtime.jobs.create({ ...generatedInput, actor: refreshedOwner }),
      generated,
      "principal-scoped idempotency must survive the caller refreshing its session",
    );

    const claimed = createClaimed(fx, reviewer, source, "job.synthetic.invalid-result", "invalid-result");
    fx.runtime.jobs.start({
      projectId: fx.projectId,
      jobId: claimed.jobId,
      actor: reviewer.ref,
      claim: claimed.claim,
      idempotencyKey: "idempotency.adversarial.start.invalid-result",
    });
    const resultArtifact = fx.registerArtifact({ actor: reviewer.ref, kind: "review", text: "valid result shell", parents: [source.artifactId] });
    const eventCount = fx.runtime.journal.list(fx.projectId).length;
    assert.throws(() => fx.runtime.jobs.complete({
      projectId: fx.projectId,
      jobId: claimed.jobId,
      actor: reviewer.ref,
      claim: claimed.claim,
      idempotencyKey: "idempotency.adversarial.invalid-completion",
      result: {
        outcome: "bogus",
        artifactIds: [resultArtifact.artifactId],
        disagreements: [{ arbitrary: "must not enter immutable audit" }],
        citations: [],
      },
    }), /contract_schema_validation_failed|invalid_identifier/);
    assert.equal(fx.runtime.jobs.require(claimed.jobId).status, "running");
    assert.equal(fx.runtime.journal.list(fx.projectId).length, eventCount);

    const citation = {
      citationId: "citation.synthetic.adversarial",
      sourceArtifactId: source.artifactId,
      locator: { type: "section", value: "adversarial" },
      claim: "The source supports the bounded synthetic review.",
      verification: {
        status: "verified",
        method: "synthetic inspection",
        verifiedBy: reviewer.ref,
        verifiedAt: fx.clock.value,
      },
    };
    const citedResult = fx.registerArtifact({
      actor: reviewer.ref,
      kind: "review",
      text: "citation-bound review result",
      parents: [source.artifactId],
      citations: [citation],
    });
    assert.throws(() => fx.runtime.jobs.complete({
      projectId: fx.projectId,
      jobId: claimed.jobId,
      actor: reviewer.ref,
      claim: claimed.claim,
      idempotencyKey: "idempotency.adversarial.forged-citation-verifier",
      result: {
        outcome: "accepted",
        artifactIds: [citedResult.artifactId],
        disagreements: [],
        citations: [{
          ...citation,
          verification: { ...citation.verification, verifiedBy: { ...fx.owner, sessionId: reviewer.ref.sessionId } },
        }],
      },
    }), /citation_record_binding_mismatch/);
    assert.throws(() => fx.runtime.jobs.complete({
      projectId: fx.projectId,
      jobId: claimed.jobId,
      actor: reviewer.ref,
      claim: claimed.claim,
      idempotencyKey: "idempotency.adversarial.rebound-citation",
      result: {
        outcome: "accepted",
        artifactIds: [citedResult.artifactId],
        disagreements: [],
        citations: [{ ...citation, claim: "A post-registration claim substitution." }],
      },
    }), /citation_record_binding_mismatch/);
    assert.equal(fx.runtime.jobs.require(claimed.jobId).status, "running");

    assert.throws(() => fx.runtime.journal.append({
      projectId: fx.projectId,
      eventType: "review_job.claimable",
      aggregateId: "job.nonexistent",
      actor: fx.owner,
      data: {},
    }), /write_transaction_required/);

    const mirror = fx.runtime.store.get("SELECT * FROM audit_mirror_entries ORDER BY mirror_sequence LIMIT 1");
    assert.throws(() => fx.runtime.store.run(
      `INSERT OR REPLACE INTO audit_mirror_entries(
        project_id, mirror_sequence, event_id, mirrored_at, previous_mirror_hash, mirror_hash, entry_json, file_appended
      ) VALUES (?, ?, ?, ?, ?, ?, '{}', ?)`,
      mirror.project_id,
      mirror.mirror_sequence,
      mirror.event_id,
      mirror.mirrored_at,
      mirror.previous_mirror_hash,
      mirror.mirror_hash,
      mirror.file_appended,
    ), /immutable_audit_mirror/);

    const stored = fx.runtime.jobs.require(claimed.jobId);
    const forgedOverride = {
      overrideId: "policy_override.forged",
      invokedBy: fx.owner,
      invokedAt: fx.clock.value,
      reason: "forged post-creation override",
      scope: { jobId: claimed.jobId, overriddenRules: ["M-3", "L-4"] },
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
    assert.throws(
      () => fx.runtime.store.run(
        "UPDATE review_jobs SET document_json = ? WHERE job_id = ?",
        JSON.stringify({ ...stored, approvalPolicyOverride: forgedOverride }),
        stored.jobId,
      ),
      /immutable_job_security_binding/,
    );
    assert.throws(
      () => fx.runtime.store.run(
        `INSERT INTO approval_policy_overrides(
          override_id, job_id, invoked_by_principal_id, invoked_by_session_id, invoked_by_host_id, invoked_at, document_json
        ) VALUES (?, ?, ?, ?, ?, ?, ?)`,
        forgedOverride.overrideId,
        claimed.jobId,
        fx.owner.principalId,
        fx.owner.sessionId,
        fx.owner.hostId,
        fx.clock.value,
        JSON.stringify(forgedOverride),
      ),
      /invalid_approval_policy_override_binding/,
    );
    fx.runtime.store.run("DROP TRIGGER override_security_bindings_valid_insert");
    fx.runtime.store.run(
      `INSERT INTO approval_policy_overrides(
        override_id, job_id, invoked_by_principal_id, invoked_by_session_id, invoked_by_host_id, invoked_at, document_json
      ) VALUES (?, ?, ?, ?, ?, ?, ?)`,
      forgedOverride.overrideId,
      claimed.jobId,
      fx.owner.principalId,
      fx.owner.sessionId,
      fx.owner.hostId,
      fx.clock.value,
      JSON.stringify(forgedOverride),
    );
    assert.throws(() => fx.runtime.store.transaction(() => fx.runtime.journal.append({
      projectId: fx.projectId,
      eventType: "review_job.created",
      aggregateId: claimed.jobId,
      actor: fx.owner,
      data: {
        mode: stored.mode,
        instructionSetId: stored.target.instructions.instructionSetId,
        instructionVersion: stored.target.instructions.version,
        approvalPolicyOverride: forgedOverride,
      },
      audit: { instructionSets: [stored.target.instructions] },
    })), /approval_policy_override_relational_binding_mismatch/);

    const releasable = createClaimed(fx, reviewer, source, "job.synthetic.explicit-release", "explicit-release");
    const released = fx.runtime.jobs.releaseClaim({
      projectId: fx.projectId,
      jobId: releasable.jobId,
      actor: reviewer.ref,
      claim: releasable.claim,
      idempotencyKey: "idempotency.adversarial.explicit-release",
    });
    assert.equal(released.status, "claimable");
    assert.equal(released.claim, undefined);
    assert.deepEqual(fx.runtime.jobs.releaseClaim({
      projectId: fx.projectId,
      jobId: releasable.jobId,
      actor: reviewer.ref,
      claim: releasable.claim,
      idempotencyKey: "idempotency.adversarial.explicit-release",
    }), released, "claim release is idempotent after the active binding has been cleared");
    const releasedRow = fx.runtime.store.get("SELECT status, ended_at FROM job_claims WHERE claim_id = ?", releasable.claim.claimId);
    assert.equal(releasedRow.status, "released");
    assert.equal(releasedRow.ended_at, fx.clock.value);
    const releaseEvent = fx.runtime.journal.list(fx.projectId).find((event) =>
      event.eventType === "review_job.claimable" && event.aggregate.id === releasable.jobId &&
      event.idempotencyKey === "idempotency.adversarial.explicit-release",
    );
    assert.equal(releaseEvent.actor.principalId, reviewer.ref.principalId);
    const releaseMirror = fx.runtime.store.all("SELECT entry_json FROM audit_mirror_entries ORDER BY mirror_sequence")
      .map((row) => JSON.parse(row.entry_json))
      .find((entry) => entry.event.eventId === releaseEvent.eventId);
    assert.equal(releaseMirror.actions[0].actionId, releasable.claim.claimId);
    assert.equal(releaseMirror.actions[0].operation, "claim.release");
    assert.equal(releaseMirror.actions[0].destination, `bridge://runtime/claims/${releasable.claim.claimId}`);
    assert.equal(releaseMirror.outcomes[0].status, "succeeded");

    const expiring = createClaimed(fx, reviewer, source, "job.synthetic.running-expiry", "running-expiry", 1000);
    fx.runtime.jobs.start({
      projectId: fx.projectId,
      jobId: expiring.jobId,
      actor: reviewer.ref,
      claim: expiring.claim,
      idempotencyKey: "idempotency.adversarial.start.expiring",
    });
    fx.clock.value = "2026-07-13T12:00:02.000Z";
    const requeued = fx.runtime.jobs.expireClaim({
      projectId: fx.projectId,
      jobId: expiring.jobId,
      actor: fx.owner,
      idempotencyKey: "idempotency.adversarial.expire-running",
    });
    assert.equal(requeued.status, "claimable");
    assert.equal(requeued.claim, undefined);
  } finally {
    fx.cleanup();
  }
});

test("adapter dispatch requires a one-time database-bound authorization and child-process broker", async () => {
  const fx = createFixture("adversarial-adapter");
  try {
    const reviewer = fx.addIdentity("adapter_reviewer", ["reviewer"]);
    const source = fx.registerArtifact({ text: "adapter authorization source" });
    const manifest = browserManifest();
    fx.runtime.adapters.register({
      projectId: fx.projectId,
      actor: fx.owner,
      manifest,
      idempotencyKey: "idempotency.adversarial.browser-manifest",
    });
    const brokerScript = path.join(fx.root, "isolated-broker.mjs");
    const brokerProof = path.join(fx.root, "isolated-broker-proof.json");
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
            fs.writeFileSync(process.argv[2], JSON.stringify({ pid: process.pid, env: Object.keys(process.env).sort(), envelope, grant: message }));
            process.stdout.write(JSON.stringify(envelope.parameters));
          }
        }
      });
    `);
    fx.runtime.adapterHost.registerIsolatedBroker(manifest.adapterId, {
      command: process.execPath,
      args: [brokerScript, brokerProof],
    });
    const claimed = createClaimed(fx, reviewer, source, "job.synthetic.adapter-proof", "adapter-proof");
    const grantInput = {
      projectId: fx.projectId,
      jobId: claimed.jobId,
      actor: fx.owner,
      grantedTo: reviewer.ref,
      claim: claimed.claim,
      adapterIds: [manifest.adapterId],
      actions: ["compose"],
      conditions: [{ name: "recipient", operator: "equals", value: "synthetic" }],
      destinations: ["https://example.invalid/drafts"],
      origins: ["https://example.invalid"],
      sideEffectClasses: ["external_reversible"],
      approvalPromptClasses: ["confirm_save_draft"],
      expiresAt: "2026-07-13T12:10:00.000Z",
      maxUses: 2,
      idempotencyKey: "idempotency.adversarial.browser-grant",
    };
    const grant = fx.runtime.approvals.createGrant(grantInput);
    const refreshedOwnerSession = session(
      "owner_adapter_refreshed",
      fx.owner.principalId,
      fx.owner.hostId,
      fx.clock.value,
      "stdio-owner-adapter-refreshed-0001",
    );
    fx.runtime.identity.createSession({
      projectId: fx.projectId,
      actor: fx.owner,
      session: refreshedOwnerSession,
      idempotencyKey: "idempotency.adversarial.owner-adapter-refreshed-session",
    });
    const refreshedOwner = { principalId: fx.owner.principalId, sessionId: refreshedOwnerSession.sessionId, hostId: fx.owner.hostId };
    assert.deepEqual(
      fx.runtime.approvals.createGrant({ ...grantInput, actor: refreshedOwner }),
      grant,
      "approval creation idempotency must survive the grantor refreshing its session",
    );
    const networkContext = {
      origin: "https://example.invalid",
      destination: "https://example.invalid/drafts",
      conditions: { recipient: "synthetic" },
      approvalPromptClass: "confirm_save_draft",
    };
    const invocation = {
      projectId: fx.projectId,
      jobId: claimed.jobId,
      actor: reviewer.ref,
      claim: claimed.claim,
      adapterId: manifest.adapterId,
      operation: "compose",
      deadline: "2026-07-13T12:05:00.000Z",
      inputArtifactIds: [source.artifactId],
      parameters: claimed,
      networkContext,
    };
    await assert.rejects(() => fx.runtime.adapterHost.invoke({
      ...invocation,
      authorization: { decision: "allow", actionId: "action.forged" },
      idempotencyKey: "idempotency.adversarial.forged-dispatch",
    }), /adapter_action_not_authorized/);
    assert.equal(fs.existsSync(brokerProof), false);

    const actionCitation = {
      citationId: "citation.synthetic.adapter-action",
      sourceArtifactId: source.artifactId,
      locator: { type: "section", value: "authorization" },
      claim: "The source supports the exact adapter action.",
      verification: {
        status: "verified",
        method: "synthetic inspection",
        verifiedBy: reviewer.ref,
        verifiedAt: fx.clock.value,
      },
    };
    fx.registerArtifact({
      actor: reviewer.ref,
      kind: "review",
      text: "adapter action citation record",
      parents: [source.artifactId],
      citations: [actionCitation],
    });
    assert.throws(() => fx.runtime.approvals.authorizeBrowserAction({
      projectId: fx.projectId,
      jobId: claimed.jobId,
      actor: reviewer.ref,
      claim: claimed.claim,
      adapterId: manifest.adapterId,
      operation: "compose",
      ...networkContext,
      inputArtifactIds: [source.artifactId],
      parameters: claimed,
      citations: [{ ...actionCitation, claim: "A substituted authorization claim." }],
      idempotencyKey: "idempotency.adversarial.rebound-action-citation",
    }), /citation_record_binding_mismatch/);
    assert.equal(fx.runtime.approvals.require(grant.grantId).usesConsumed, 0);

    const missingPromptClass = fx.runtime.approvals.authorizeBrowserAction({
      projectId: fx.projectId,
      jobId: claimed.jobId,
      actor: reviewer.ref,
      claim: claimed.claim,
      adapterId: manifest.adapterId,
      operation: "compose",
      origin: networkContext.origin,
      destination: networkContext.destination,
      conditions: networkContext.conditions,
      inputArtifactIds: [source.artifactId],
      parameters: claimed,
      idempotencyKey: "idempotency.adversarial.missing-prompt-class",
    });
    assert.equal(missingPromptClass.decision, "ask", "omitting a grant-bound prompt class must fail closed");

    const authorization = fx.runtime.approvals.authorizeBrowserAction({
      projectId: fx.projectId,
      jobId: claimed.jobId,
      actor: reviewer.ref,
      claim: claimed.claim,
      adapterId: manifest.adapterId,
      operation: "compose",
      ...networkContext,
      inputArtifactIds: [source.artifactId],
      parameters: claimed,
      idempotencyKey: "idempotency.adversarial.authorize-action",
    });
    assert.equal(authorization.decision, "allow");
    const authorizedInvocation = {
      ...invocation,
      authorization: { decision: "allow", actionId: authorization.actionId },
      idempotencyKey: "idempotency.adversarial.authorized-dispatch",
    };
    await assert.rejects(() => fx.runtime.adapterHost.invoke({
      ...authorizedInvocation,
      networkContext: {
        origin: networkContext.origin,
        destination: networkContext.destination,
        conditions: networkContext.conditions,
      },
      idempotencyKey: "idempotency.adversarial.prompt-class-strip",
    }), /adapter_action_authorization_binding_mismatch/);
    assert.deepEqual(await fx.runtime.adapterHost.invoke(authorizedInvocation), claimed);
    assert.deepEqual(await fx.runtime.adapterHost.invoke(authorizedInvocation), claimed, "idempotent replay does not re-consume authority");
    await assert.rejects(() => fx.runtime.adapterHost.invoke({
      ...authorizedInvocation,
      idempotencyKey: "idempotency.adversarial.authorization-reuse",
    }), /adapter_action_not_authorized/);
    const proof = JSON.parse(fs.readFileSync(brokerProof, "utf8"));
    assert.notEqual(proof.pid, process.pid, "credentialed adapter code must execute in another process");
    assert.deepEqual(Object.keys(proof.envelope).sort(), [
      "adapter", "claimId", "deadline", "fence", "fencingToken", "generation", "idempotencyKey", "inputArtifactIds", "operationId", "parameters", "protocol",
    ]);
    assert.equal(proof.envelope.generation, claimed.claim.generation);
    assert.equal(proof.envelope.claimId, claimed.claim.claimId);
    assert.equal(proof.envelope.fencingToken, claimed.claim.fencingToken);
    assert.deepEqual(Object.keys(proof.grant.authorization).sort(), [
      "actionId", "approvalPromptClass", "conditions", "destination", "origin",
    ]);
    assert.equal(proof.envelope.networkAllowlist, undefined, "the broker receives one target, never the manifest allowlist");
    assert.equal(proof.envelope.principal, undefined);
    assert.equal(proof.grant.authorization.approvalPromptClass, "confirm_save_draft");
    assert.equal(proof.envelope.authorization, undefined, "action authority is withheld until the just-in-time fence succeeds");
    assert.equal(proof.grant.deadline, proof.envelope.deadline);
    const osBaselineEnvironment = [
      "HOMEDRIVE", "HOMEPATH", "LOGONSERVER", "PATH", "SYSTEMDRIVE", "SystemRoot", "TEMP", "TMP",
      "USERDOMAIN", "USERNAME", "USERPROFILE", "WINDIR",
    ];
    assert.equal(proof.env.every((name) => osBaselineEnvironment.includes(name)), true, `unexpected broker env: ${proof.env.join(",")}`);
    assert.equal(proof.env.some((name) => /token|secret|password|cookie|authorization|api.?key/i.test(name)), false);
  } finally {
    fx.cleanup();
  }
});

test("adapter output cannot commit after generation takeover races a delayed child process", async () => {
  const fx = createFixture("adapter-takeover-race");
  try {
    const reviewer = fx.addIdentity("race_adapter_reviewer", ["reviewer"]);
    const source = fx.registerArtifact({ text: "adapter takeover race source" });
    const manifest = browserManifest();
    fx.runtime.adapters.register({
      projectId: fx.projectId,
      actor: fx.owner,
      manifest,
      idempotencyKey: "idempotency.race-adapter.manifest",
    });
    const startedPath = path.join(fx.root, "race-adapter-started.json");
    const releasePath = path.join(fx.root, "race-adapter-release");
    const effectPath = path.join(fx.root, "race-adapter-effect.json");
    const brokerScript = path.join(fx.root, "race-adapter-broker.mjs");
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
            fs.writeFileSync(process.argv[2], JSON.stringify(envelope));
            const timer = setInterval(() => {
              if (!fs.existsSync(process.argv[3])) return;
              clearInterval(timer);
              process.stdout.write(JSON.stringify({ protocol: "bridge2.adapter-fence-request.v1", operationId: envelope.operationId }) + "\\n");
            }, 10);
          } else {
            fs.writeFileSync(process.argv[4], JSON.stringify({ envelope, grant: message }));
            process.stdout.write(JSON.stringify(envelope.parameters));
          }
        }
      });
    `);
    fx.runtime.adapterHost.registerIsolatedBroker(manifest.adapterId, {
      command: process.execPath,
      args: [brokerScript, startedPath, releasePath, effectPath],
    });
    const claimed = createClaimed(fx, reviewer, source, "job.synthetic.adapter-takeover-race", "adapter-takeover-race");
    fx.runtime.approvals.createGrant({
      projectId: fx.projectId,
      jobId: claimed.jobId,
      actor: fx.owner,
      grantedTo: reviewer.ref,
      claim: claimed.claim,
      adapterIds: [manifest.adapterId],
      actions: ["compose"],
      conditions: [{ name: "recipient", operator: "equals", value: "race" }],
      destinations: ["https://example.invalid/drafts"],
      origins: ["https://example.invalid"],
      sideEffectClasses: ["external_reversible"],
      expiresAt: "2026-07-13T12:10:00.000Z",
      maxUses: 1,
      idempotencyKey: "idempotency.race-adapter.grant",
    });
    const networkContext = {
      origin: "https://example.invalid",
      destination: "https://example.invalid/drafts",
      conditions: { recipient: "race" },
    };
    const authorization = fx.runtime.approvals.authorizeBrowserAction({
      projectId: fx.projectId,
      jobId: claimed.jobId,
      actor: reviewer.ref,
      claim: claimed.claim,
      adapterId: manifest.adapterId,
      operation: "compose",
      ...networkContext,
      inputArtifactIds: [source.artifactId],
      parameters: claimed,
      idempotencyKey: "idempotency.race-adapter.authorize",
    });
    const invocation = fx.runtime.adapterHost.invoke({
      projectId: fx.projectId,
      jobId: claimed.jobId,
      actor: reviewer.ref,
      claim: claimed.claim,
      adapterId: manifest.adapterId,
      operation: "compose",
      deadline: "2026-07-13T12:05:00.000Z",
      inputArtifactIds: [source.artifactId],
      parameters: claimed,
      authorization: { decision: "allow", actionId: authorization.actionId },
      networkContext,
      idempotencyKey: "idempotency.race-adapter.invoke",
    });
    await waitForFile(startedPath);
    const dispatchedEnvelope = JSON.parse(fs.readFileSync(startedPath, "utf8"));
    assert.equal(dispatchedEnvelope.generation, claimed.claim.generation);
    assert.equal(dispatchedEnvelope.claimId, claimed.claim.claimId);
    assert.equal(dispatchedEnvelope.fencingToken, claimed.claim.fencingToken);
    fx.runtime.jobs.advanceGeneration({
      projectId: fx.projectId,
      actor: fx.owner,
      expectedGeneration: 1,
      newGeneration: 2,
      approvalRef: "approval.takeover.synthetic.adapter-race",
      targetHostId: fx.owner.hostId,
      reason: "Invalidate the delayed adapter writer under a synthetic race.",
      idempotencyKey: "idempotency.race-adapter.takeover",
    });
    fs.writeFileSync(releasePath, "release\n");
    await assert.rejects(invocation, /stale_fencing_token/);
    await new Promise((resolve) => setTimeout(resolve, 100));
    assert.equal(fs.existsSync(effectPath), false, "a stale broker must never receive authority to perform its synthetic side effect");
    const row = fx.runtime.store.get("SELECT status, response_json, error_code FROM adapter_invocations WHERE idempotency_key = ?", "idempotency.race-adapter.invoke");
    assert.equal(row.status, "failed");
    assert.equal(row.response_json, null);
    assert.equal(row.error_code, "stale_fencing_token");
  } finally {
    fx.cleanup();
  }
});

test("job project boundaries, inner authorization, and mandatory audit projection fail closed", () => {
  const fx = createFixture("runtime-inner-authorization");
  try {
    const target = fx.addIdentity("inner_auth_target", []);
    const originalAuthorize = fx.runtime.identity.authorize.bind(fx.runtime.identity);
    let authorizationCalls = 0;
    fx.runtime.identity.authorize = (...args) => {
      const result = originalAuthorize(...args);
      authorizationCalls += 1;
      if (authorizationCalls === 1) {
        fx.runtime.store.run("UPDATE sessions SET status = 'revoked', closed_at = ? WHERE session_id = ?", fx.clock.value, fx.owner.sessionId);
      }
      return result;
    };
    assert.throws(() => fx.runtime.identity.assignRole({
      projectId: fx.projectId,
      actor: fx.owner,
      principalId: target.ref.principalId,
      role: "worker",
      idempotencyKey: "idempotency.inner-auth.role",
    }), /session_not_active/);
    assert.equal(fx.runtime.identity.hasRole(fx.projectId, target.ref.principalId, "worker"), false);
    fx.runtime.identity.authorize = originalAuthorize;
    fx.runtime.store.run("UPDATE sessions SET status = 'active', closed_at = NULL WHERE session_id = ?", fx.owner.sessionId);

    const source = fx.registerArtifact({ text: "project boundary source" });
    const queued = fx.runtime.jobs.create({
      projectId: fx.projectId,
      actor: fx.owner,
      idempotencyKey: "idempotency.project-bound.create",
      jobId: "job.synthetic.project-bound",
      mode: "collaboration",
      requiredRole: "collaborator",
      independence: { policy: "not_required" },
      target: { artifactIds: [source.artifactId], instructions: "Enforce the job project boundary.", acceptanceCriteria: ["Reject another project id."] },
    });
    assert.throws(() => fx.runtime.jobs.makeClaimable({
      projectId: "project.synthetic.other",
      jobId: queued.jobId,
      actor: fx.owner,
      idempotencyKey: "idempotency.project-bound.wrong-project",
    }), /job_project_mismatch/);

    const configuredMirror = fx.runtime.store.auditMirrorPath;
    fx.runtime.store.auditMirrorPath = undefined;
    assert.throws(() => fx.runtime.jobs.create({
      projectId: fx.projectId,
      actor: fx.owner,
      idempotencyKey: "idempotency.audit-mirror.required",
      jobId: "job.synthetic.audit-mirror-required",
      mode: "collaboration",
      requiredRole: "collaborator",
      independence: { policy: "not_required" },
      target: { artifactIds: [source.artifactId], instructions: "Require a durable audit mirror.", acceptanceCriteria: ["Roll back without JSONL projection."] },
    }), /audit_mirror_path_required/);
    assert.equal(fx.runtime.jobs.get("job.synthetic.audit-mirror-required"), undefined);
    fx.runtime.store.auditMirrorPath = configuredMirror;
  } finally {
    fx.cleanup();
  }
});

test("migration inventory rejects late lower versions and missing applied files", () => {
  const fx = createFixture("adversarial-migrations");
  let runtime;
  try {
    const migrationCopy = path.join(fx.root, "migration-inventory");
    fs.cpSync(path.resolve("migrations"), migrationCopy, { recursive: true });
    const v5 = "CREATE TABLE synthetic_v5(id TEXT PRIMARY KEY) STRICT;\n";
    fs.writeFileSync(path.join(migrationCopy, "005_late.sql"), v5);
    fx.runtime.close();
    runtime = new BridgeRuntime({
      databasePath: fx.databasePath,
      auditMirrorPath: fx.auditMirrorPath,
      migrationsDir: migrationCopy,
      now: () => fx.clock.value,
    });
    runtime.store.run(
      "INSERT INTO schema_migrations(version, migration_id, checksum, applied_at) VALUES (5, ?, ?, ?)",
      "migration.005.late",
      sha256(Buffer.from(v5)),
      fx.clock.value,
    );
    fs.writeFileSync(path.join(migrationCopy, "004_inserted_late.sql"), "CREATE TABLE synthetic_v4(id TEXT PRIMARY KEY) STRICT;\n");
    assert.throws(() => runtime.store.migrations.pending(), /non_forward_migration_detected/);
    fs.rmSync(path.join(migrationCopy, "005_late.sql"));
    assert.throws(() => runtime.store.migrations.pending(), /applied_migration_file_missing/);
  } finally {
    try { runtime?.close(); } catch {}
    fx.cleanup();
  }
});

test("idempotent replay requires a live actor binding while allowing a refreshed authenticated session", () => {
  const fx = createFixture("adversarial-replay-authentication");
  try {
    const manifest = localReadAdapterManifest();
    const idempotencyKey = "idempotency.replay-authentication.adapter";
    const registered = fx.runtime.adapters.register({
      projectId: fx.projectId,
      actor: fx.owner,
      manifest,
      idempotencyKey,
    });

    assert.throws(() => fx.runtime.adapters.register({
      projectId: fx.projectId,
      actor: {
        principalId: fx.owner.principalId,
        sessionId: "session.forged.001",
        hostId: fx.owner.hostId,
      },
      manifest,
      idempotencyKey,
    }), /identity_binding_not_found/);

    const refreshed = session(
      "owner_refreshed",
      fx.owner.principalId,
      fx.owner.hostId,
      fx.clock.value,
      "stdio-owner-refreshed-0001",
    );
    fx.runtime.identity.createSession({
      projectId: fx.projectId,
      actor: fx.owner,
      session: refreshed,
      idempotencyKey: "idempotency.replay-authentication.session",
    });
    const replayed = fx.runtime.adapters.register({
      projectId: fx.projectId,
      actor: {
        principalId: fx.owner.principalId,
        sessionId: refreshed.sessionId,
        hostId: fx.owner.hostId,
      },
      manifest,
      idempotencyKey,
    });
    assert.deepEqual(replayed, registered);
  } finally {
    fx.cleanup();
  }
});

test("completed adapter invocation replays for the same principal from a refreshed authenticated session", async () => {
  const fx = createFixture("adversarial-adapter-replay-session");
  try {
    const reviewer = fx.addIdentity("adapter_replay_reviewer", ["reviewer"]);
    const source = fx.registerArtifact({ text: "adapter replay source" });
    const manifest = localReadAdapterManifest();
    fx.runtime.adapters.register({
      projectId: fx.projectId,
      actor: fx.owner,
      manifest,
      idempotencyKey: "idempotency.adapter-replay.manifest",
    });
    const claimed = createClaimed(
      fx,
      reviewer,
      source,
      "job.synthetic.adapter-replay-session",
      "adapter-replay-session",
    );
    let dispatches = 0;
    fx.runtime.adapterHost.registerInProcessHandler(manifest.adapterId, () => {
      dispatches += 1;
      return claimed;
    });
    const invocation = {
      projectId: fx.projectId,
      jobId: claimed.jobId,
      actor: reviewer.ref,
      claim: claimed.claim,
      adapterId: manifest.adapterId,
      operation: "inspect",
      deadline: "2026-07-13T12:30:00.000Z",
      inputArtifactIds: [source.artifactId],
      parameters: claimed,
      idempotencyKey: "idempotency.adapter-replay.invoke",
    };
    const first = await fx.runtime.adapterHost.invoke(invocation);
    assert.equal(dispatches, 1);

    const refreshed = session(
      "adapter_replay_refreshed",
      reviewer.ref.principalId,
      reviewer.ref.hostId,
      fx.clock.value,
      "stdio-adapter-replay-refreshed-0001",
    );
    fx.runtime.identity.createSession({
      projectId: fx.projectId,
      actor: fx.owner,
      session: refreshed,
      idempotencyKey: "idempotency.adapter-replay.session",
    });
    const replayed = await fx.runtime.adapterHost.invoke({
      ...invocation,
      actor: {
        principalId: reviewer.ref.principalId,
        sessionId: refreshed.sessionId,
        hostId: reviewer.ref.hostId,
      },
    });
    assert.deepEqual(replayed, first);
    assert.equal(dispatches, 1, "a completed replay must not redispatch the adapter");
  } finally {
    fx.cleanup();
  }
});
