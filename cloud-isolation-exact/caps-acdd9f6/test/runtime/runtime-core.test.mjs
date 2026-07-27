import assert from "node:assert/strict";
import fs from "node:fs";
import test from "node:test";
import { BridgeRuntime, hashAuditEntry, hashEvent } from "../../dist/v2/index.js";
import { createFixture } from "./helpers.mjs";

test("authoritative lifecycle, idempotency, fencing, and contract-shaped audit journal", () => {
  const fx = createFixture("core");
  try {
    const reviewer = fx.addIdentity("reviewer", ["reviewer"]);
    const source = fx.registerArtifact({ text: "synthetic contract input" });
    const createInput = {
      projectId: fx.projectId,
      actor: fx.owner,
      idempotencyKey: "idempotency.job.create.core",
      jobId: "job.synthetic.core",
      mode: "independent_review",
      requiredRole: "reviewer",
      independence: { policy: "required", excludedPrincipalIds: [] },
      target: {
        artifactIds: [source.artifactId],
        instructions: "Review the synthetic artifact and preserve disagreements.",
        acceptanceCriteria: ["Return a synthetic review artifact."],
      },
    };
    const created = fx.runtime.jobs.create(createInput);
    assert.equal(created.status, "queued");
    assert.ok(created.independence.excludedPrincipalIds.includes(fx.owner.principalId));
    const replay = fx.runtime.jobs.create(createInput);
    assert.deepEqual(replay, created);
    assert.throws(
      () => fx.runtime.jobs.create({ ...createInput, target: { ...createInput.target, instructions: "Different request" } }),
      /idempotency_key_reused/,
    );

    const claimable = fx.runtime.jobs.makeClaimable({
      projectId: fx.projectId,
      jobId: created.jobId,
      actor: fx.owner,
      idempotencyKey: "idempotency.job.claimable.core",
    });
    const eventCount = fx.runtime.journal.list(fx.projectId).length;
    assert.deepEqual(
      fx.runtime.jobs.makeClaimable({
        projectId: fx.projectId,
        jobId: created.jobId,
        actor: fx.owner,
        idempotencyKey: "idempotency.job.claimable.core",
      }),
      claimable,
    );
    assert.equal(fx.runtime.journal.list(fx.projectId).length, eventCount, "idempotent replay must append no event");

    const claimed = fx.runtime.jobs.claim({
      projectId: fx.projectId,
      jobId: created.jobId,
      actor: reviewer.ref,
      idempotencyKey: "idempotency.job.claim.core",
    });
    assert.equal(claimed.attempt, 1);
    assert.equal(claimed.claim.generation, 1);
    fx.runtime.jobs.start({
      projectId: fx.projectId,
      jobId: created.jobId,
      actor: reviewer.ref,
      claim: claimed.claim,
      idempotencyKey: "idempotency.job.start.core",
    });
    const citation = {
      citationId: "citation.synthetic.core",
      sourceArtifactId: source.artifactId,
      locator: { type: "section", value: "synthetic" },
      claim: "The synthetic source supports the test claim.",
      verification: {
        status: "verified",
        method: "synthetic direct inspection",
        verifiedBy: reviewer.ref,
        verifiedAt: fx.clock.value,
      },
    };
    const resultArtifact = fx.registerArtifact({
      actor: reviewer.ref,
      kind: "review",
      text: "synthetic review result",
      parents: [source.artifactId],
      citations: [citation],
    });
    const completed = fx.runtime.jobs.complete({
      projectId: fx.projectId,
      jobId: created.jobId,
      actor: reviewer.ref,
      claim: claimed.claim,
      idempotencyKey: "idempotency.job.complete.core",
      result: {
        outcome: "accepted",
        artifactIds: [resultArtifact.artifactId],
        disagreements: [],
        citations: [citation],
      },
    });
    assert.equal(completed.status, "completed");
    assert.throws(
      () => fx.runtime.jobs.amendInstructions({
        projectId: fx.projectId,
        jobId: completed.jobId,
        actor: fx.owner,
        text: "Terminal jobs cannot be amended.",
        materialAmendment: false,
        idempotencyKey: "idempotency.terminal.amend",
      }),
      /terminal_job_instructions_immutable/,
    );

    fx.runtime.schemas.validateNamed("review-job.schema.json", completed);
    fx.runtime.schemas.validateNamed("artifact.schema.json", resultArtifact);
    const events = fx.runtime.journal.list(fx.projectId);
    const mirrorRows = fx.runtime.store.all("SELECT entry_json FROM audit_mirror_entries ORDER BY mirror_sequence");
    const mirrors = mirrorRows.map((row) => JSON.parse(row.entry_json));
    assert.equal(mirrors.length, events.length);
    events.forEach((event, index) => {
      fx.runtime.schemas.validateNamed("event.schema.json", event);
      assert.equal(hashEvent(event), event.hash);
      if (index) assert.equal(event.previousHash, events[index - 1].hash);
    });
    mirrors.forEach((entry, index) => {
      fx.runtime.schemas.validateNamed("audit-mirror-entry.schema.json", entry);
      assert.equal(hashAuditEntry(entry), entry.mirrorHash);
      if (index) assert.equal(entry.previousMirrorHash, mirrors[index - 1].mirrorHash);
    });
    assert.equal(fs.readFileSync(fx.auditMirrorPath, "utf8").trim().split("\n").length, events.length);
  } finally {
    fx.cleanup();
  }
});

test("atomic claims, lease expiry, and generation takeover reject every stale writer", () => {
  const fx = createFixture("fencing");
  let second;
  try {
    const reviewerA = fx.addIdentity("reviewer_a", ["reviewer"]);
    const reviewerB = fx.addIdentity("reviewer_b", ["reviewer"]);
    const source = fx.registerArtifact({ text: "claim race source" });
    const makeJob = (jobId, suffix) => {
      fx.runtime.jobs.create({
        projectId: fx.projectId,
        actor: fx.owner,
        idempotencyKey: `idempotency.create.${suffix}`,
        jobId,
        mode: "independent_review",
        requiredRole: "reviewer",
        independence: { policy: "required", excludedPrincipalIds: [] },
        target: { artifactIds: [source.artifactId], instructions: "Synthetic fenced work.", acceptanceCriteria: ["Finish safely."] },
      });
      fx.runtime.jobs.makeClaimable({ projectId: fx.projectId, jobId, actor: fx.owner, idempotencyKey: `idempotency.claimable.${suffix}` });
    };

    makeJob("job.synthetic.race", "race");
    second = new BridgeRuntime({ databasePath: fx.databasePath, auditMirrorPath: fx.auditMirrorPath, now: () => fx.clock.value });
    const winner = fx.runtime.jobs.claim({
      projectId: fx.projectId,
      jobId: "job.synthetic.race",
      actor: reviewerA.ref,
      idempotencyKey: "idempotency.race.winner",
    });
    assert.throws(
      () => second.jobs.claim({
        projectId: fx.projectId,
        jobId: "job.synthetic.race",
        actor: reviewerB.ref,
        idempotencyKey: "idempotency.race.loser",
      }),
      /job_not_claimable/,
    );
    assert.equal(fx.runtime.store.get("SELECT COUNT(*) AS count FROM job_claims WHERE job_id = ?", "job.synthetic.race").count, 1);

    makeJob("job.synthetic.expiry", "expiry");
    const expiring = fx.runtime.jobs.claim({
      projectId: fx.projectId,
      jobId: "job.synthetic.expiry",
      actor: reviewerA.ref,
      leaseMs: 1000,
      idempotencyKey: "idempotency.expiry.claim",
    });
    assert.throws(
      () => fx.runtime.jobs.expireClaim({
        projectId: fx.projectId,
        jobId: "job.synthetic.expiry",
        actor: fx.owner,
        at: "2099-01-01T00:00:00.000Z",
        idempotencyKey: "idempotency.expiry.future-injection",
      }),
      /claim_not_expired/,
      "caller-supplied future time must not override the authoritative runtime clock",
    );
    fx.clock.value = "2026-07-13T12:00:02.000Z";
    assert.throws(
      () => fx.runtime.jobs.start({
        projectId: fx.projectId,
        jobId: "job.synthetic.expiry",
        actor: reviewerA.ref,
        claim: expiring.claim,
        idempotencyKey: "idempotency.expiry.late-start",
      }),
      /claim_expired/,
    );
    fx.runtime.jobs.expireClaim({
      projectId: fx.projectId,
      jobId: "job.synthetic.expiry",
      actor: fx.owner,
      idempotencyKey: "idempotency.expiry.cleanup",
    });
    const reclaimed = fx.runtime.jobs.claim({
      projectId: fx.projectId,
      jobId: "job.synthetic.expiry",
      actor: reviewerB.ref,
      idempotencyKey: "idempotency.expiry.reclaim",
    });
    assert.ok(reclaimed.claim.fencingToken > expiring.claim.fencingToken);
    fx.runtime.jobs.start({
      projectId: fx.projectId,
      jobId: reclaimed.jobId,
      actor: reviewerB.ref,
      claim: reclaimed.claim,
      idempotencyKey: "idempotency.expiry.start-reclaimed",
    });
    const generation = fx.runtime.jobs.advanceGeneration({
      projectId: fx.projectId,
      actor: fx.owner,
      expectedGeneration: 1,
      newGeneration: 2,
      approvalRef: "approval.takeover.synthetic.core",
      targetHostId: fx.owner.hostId,
      reason: "Synthetic owner-confirmed takeover.",
      idempotencyKey: "idempotency.takeover.synthetic",
    });
    assert.equal(generation, 2);
    const pendingTakeoverDoctor = fx.runtime.doctor.run({ projectId: fx.projectId, hostId: fx.owner.hostId });
    assert.match(
      pendingTakeoverDoctor.checks.find((check) => check.checkId === "check.generation.active").detail,
      /1 forced takeover\(s\) await/,
    );
    const reconciliationArtifact = fx.registerArtifact({
      actor: fx.owner,
      kind: "report",
      text: "Synthetic post-takeover reconciliation report.",
    });
    const reconciliationInput = {
      projectId: fx.projectId,
      actor: fx.owner,
      approvalRef: "approval.takeover.synthetic.core",
      reportArtifactId: reconciliationArtifact.artifactId,
      summary: "Owner reviewed the forced takeover and accepted the recovered generation state.",
      idempotencyKey: "idempotency.takeover.synthetic.reconcile",
    };
    const reconciliation = fx.runtime.jobs.reconcileTakeover(reconciliationInput);
    assert.deepEqual(fx.runtime.jobs.reconcileTakeover(reconciliationInput), reconciliation);
    assert.equal(
      fx.runtime.store.get("SELECT COUNT(*) AS count FROM runtime_operation_reports WHERE operation = 'project.reconcile_takeover'").count,
      1,
    );
    assert.throws(() => fx.runtime.jobs.reconcileTakeover({
      ...reconciliationInput,
      idempotencyKey: "idempotency.takeover.synthetic.reconcile-second",
    }), /takeover_already_reconciled/);
    assert.throws(
      () => fx.runtime.jobs.awaitInput({
        projectId: fx.projectId,
        jobId: reclaimed.jobId,
        actor: reviewerB.ref,
        claim: reclaimed.claim,
        reason: "This stale writer must fail.",
        idempotencyKey: "idempotency.stale.after-takeover",
      }),
      /stale_fencing_token/,
    );
    assert.equal(winner.claim.generation, 1);
  } finally {
    try { second?.close(); } catch {}
    fx.cleanup();
  }
});

test("read-only recovery takeover requires a completed restore bound to the active target host and generation", () => {
  const fx = createFixture("recovery-takeover");
  try {
    fx.runtime.store.run("UPDATE projects SET status = 'read_only' WHERE project_id = ?", fx.projectId);
    assert.throws(
      () => fx.runtime.jobs.advanceGeneration({
        projectId: fx.projectId,
        actor: fx.owner,
        expectedGeneration: 1,
        newGeneration: 2,
        approvalRef: "approval.takeover.synthetic.missing-restore",
        targetHostId: fx.owner.hostId,
        reason: "A read-only project cannot activate without completed restore evidence.",
        idempotencyKey: "idempotency.takeover.missing-restore",
      }),
      /invalid_identifier|completed_restore_required/,
    );
    const restoreId = "restore.synthetic.recovery-takeover";
    const restore = {
      restoreId,
      projectId: fx.projectId,
      status: "completed",
      mode: "new_host",
      targetHostId: fx.owner.hostId,
      expectedSourceGeneration: 1,
      takeover: { mode: "no_takeover" },
    };
    fx.runtime.store.run(
      "INSERT INTO restore_manifests(restore_id, backup_id, project_id, requested_at, status, manifest_json) VALUES (?, ?, ?, ?, 'completed', ?)",
      restoreId,
      "backup.synthetic.recovery-takeover",
      fx.projectId,
      fx.clock.value,
      JSON.stringify(restore),
    );
    assert.equal(fx.runtime.jobs.advanceGeneration({
      projectId: fx.projectId,
      actor: fx.owner,
      expectedGeneration: 1,
      newGeneration: 2,
      approvalRef: "approval.takeover.synthetic.recovery",
      targetHostId: fx.owner.hostId,
      restoreId,
      reason: "Activate only after verified isolated recovery completed for this host.",
      idempotencyKey: "idempotency.takeover.recovery",
    }), 2);
    const project = fx.runtime.store.get("SELECT active_generation, status FROM projects WHERE project_id = ?", fx.projectId);
    assert.equal(project.active_generation, 2);
    assert.equal(project.status, "active");
    const takeover = fx.runtime.store.get("SELECT * FROM generation_takeovers WHERE approval_ref = ?", "approval.takeover.synthetic.recovery");
    assert.equal(takeover.target_host_id, fx.owner.hostId);
    assert.equal(takeover.restore_id, restoreId);
    const event = fx.runtime.journal.list(fx.projectId).at(-1);
    const mirror = JSON.parse(fx.runtime.store.get("SELECT entry_json FROM audit_mirror_entries WHERE event_id = ?", event.eventId).entry_json);
    assert.equal(mirror.outcomes[0].outcomeId, "approval.takeover.synthetic.recovery");
    assert.equal(mirror.outcomes[0].status, "succeeded");
  } finally {
    fx.cleanup();
  }
});
