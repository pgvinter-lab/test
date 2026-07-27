import assert from "node:assert/strict";
import test from "node:test";
import { createFixture, session } from "./helpers.mjs";

function commandRecord(fx, operation, idempotencyKey) {
  return fx.runtime.store.get(
    `SELECT project_id, principal_id, session_id, host_id, generation,
            operation, idempotency_key, request_hash, response_json, created_at
     FROM idempotency_records
     WHERE project_id = ? AND principal_id = ? AND operation = ? AND idempotency_key = ?`,
    fx.projectId,
    fx.owner.principalId,
    operation,
    idempotencyKey,
  );
}

function assertAttribution(record, { fx, actor = fx.owner, generation, at, operation, idempotencyKey }) {
  assert.ok(record, `missing idempotency record for ${operation}`);
  assert.equal(record.project_id, fx.projectId);
  assert.equal(record.principal_id, actor.principalId);
  assert.equal(record.session_id, actor.sessionId);
  assert.equal(record.host_id, actor.hostId);
  assert.equal(record.generation, generation);
  assert.equal(record.created_at, at);
  assert.equal(record.operation, operation);
  assert.equal(record.idempotency_key, idempotencyKey);
  assert.equal(typeof record.request_hash, "string");
  assert.equal(typeof record.response_json, "string");
}

test("accepted commands preserve immutable actor, generation, and time attribution across replay", () => {
  const fx = createFixture("command-attribution");
  try {
    assertAttribution(commandRecord(fx, "identity.bootstrap_owner", "idempotency.bootstrap.owner"), {
      fx,
      generation: 1,
      at: "2026-07-13T12:00:00.000Z",
      operation: "identity.bootstrap_owner",
      idempotencyKey: "idempotency.bootstrap.owner",
    });

    fx.clock.value = "2026-07-13T12:01:00.000Z";
    const reviewer = fx.addIdentity("command_audit_reviewer", ["reviewer"]);
    assertAttribution(commandRecord(
      fx,
      "identity.register_principal",
      "idempotency.principal.command_audit_reviewer.1",
    ), {
      fx,
      generation: 1,
      at: fx.clock.value,
      operation: "identity.register_principal",
      idempotencyKey: "idempotency.principal.command_audit_reviewer.1",
    });
    const roleKey = "idempotency.role.command_audit_reviewer.reviewer.1";
    const originalRoleRecord = commandRecord(fx, "identity.assign_role", roleKey);
    assertAttribution(originalRoleRecord, {
      fx,
      generation: 1,
      at: fx.clock.value,
      operation: "identity.assign_role",
      idempotencyKey: roleKey,
    });

    fx.clock.value = "2026-07-13T12:02:00.000Z";
    assert.equal(fx.runtime.jobs.advanceGeneration({
      projectId: fx.projectId,
      actor: fx.owner,
      expectedGeneration: 1,
      newGeneration: 2,
      approvalRef: "approval.takeover.synthetic.command-audit-generation-2",
      targetHostId: fx.owner.hostId,
      reason: "Synthetic command-attribution generation transition.",
      idempotencyKey: "idempotency.command-audit.generation-2",
    }), 2);
    assertAttribution(commandRecord(
      fx,
      "project.advance_generation",
      "idempotency.command-audit.generation-2",
    ), {
      fx,
      generation: 2,
      at: fx.clock.value,
      operation: "project.advance_generation",
      idempotencyKey: "idempotency.command-audit.generation-2",
    });

    fx.clock.value = "2026-07-13T12:03:00.000Z";
    const refreshedHost = {
      ...fx.host,
      hostId: "host.command-audit-refreshed",
      instanceId: "instance.command-audit-refreshed.001",
      hostnameHash: "1".repeat(64),
      registeredAt: fx.clock.value,
    };
    fx.runtime.identity.registerHost({
      projectId: fx.projectId,
      actor: fx.owner,
      host: refreshedHost,
      idempotencyKey: "idempotency.command-audit.refreshed-host",
    });
    const refreshedSession = {
      ...session(
        "command_audit_owner_refresh",
        fx.owner.principalId,
        refreshedHost.hostId,
        fx.clock.value,
        "stdio-command-audit-owner-refreshed-session-0001",
      ),
      sessionId: "session.command-audit-owner-refresh.001",
    };
    fx.runtime.identity.createSession({
      projectId: fx.projectId,
      actor: fx.owner,
      session: refreshedSession,
      idempotencyKey: "idempotency.command-audit.refreshed-session",
    });
    const refreshedActor = {
      principalId: fx.owner.principalId,
      sessionId: refreshedSession.sessionId,
      hostId: refreshedHost.hostId,
    };

    fx.clock.value = "2026-07-13T12:04:00.000Z";
    const revisionBeforeReplay = fx.runtime.store.get(
      "SELECT state_revision FROM projects WHERE project_id = ?",
      fx.projectId,
    ).state_revision;
    assert.deepEqual(fx.runtime.identity.assignRole({
      projectId: fx.projectId,
      actor: refreshedActor,
      principalId: reviewer.ref.principalId,
      role: "reviewer",
      idempotencyKey: roleKey,
    }), JSON.parse(originalRoleRecord.response_json));
    assert.deepEqual(
      commandRecord(fx, "identity.assign_role", roleKey),
      originalRoleRecord,
      "a principal-scoped replay must not rewrite original command attribution",
    );
    assert.equal(
      fx.runtime.store.get("SELECT state_revision FROM projects WHERE project_id = ?", fx.projectId).state_revision,
      revisionBeforeReplay,
      "an idempotent read replay must not advance the authoritative state revision",
    );

    fx.clock.value = "2026-07-13T12:05:00.000Z";
    const source = fx.registerArtifact({ text: "command attribution source" });
    assertAttribution(commandRecord(fx, "artifact.register", "idempotency.artifact.1"), {
      fx,
      generation: 2,
      at: fx.clock.value,
      operation: "artifact.register",
      idempotencyKey: "idempotency.artifact.1",
    });

    fx.clock.value = "2026-07-13T12:06:00.000Z";
    fx.runtime.jobs.create({
      projectId: fx.projectId,
      actor: fx.owner,
      jobId: "job.synthetic.command-audit",
      mode: "independent_review",
      requiredRole: "reviewer",
      independence: { policy: "required", excludedPrincipalIds: [] },
      target: {
        artifactIds: [source.artifactId],
        instructions: "Review the synthetic command-attribution source artifact.",
        acceptanceCriteria: ["Return a synthetic review."],
      },
      idempotencyKey: "idempotency.command-audit.job",
    });
    assertAttribution(commandRecord(fx, "review_job.create", "idempotency.command-audit.job"), {
      fx,
      generation: 2,
      at: fx.clock.value,
      operation: "review_job.create",
      idempotencyKey: "idempotency.command-audit.job",
    });

    assert.throws(
      () => fx.runtime.store.run(
        "UPDATE idempotency_records SET created_at = created_at WHERE idempotency_key = ?",
        "idempotency.command-audit.job",
      ),
      /immutable_idempotency_record/,
    );
    assert.throws(
      () => fx.runtime.store.run(
        "DELETE FROM idempotency_records WHERE idempotency_key = ?",
        "idempotency.command-audit.job",
      ),
      /immutable_idempotency_record/,
    );
    const takeover = fx.runtime.store.get(
      "SELECT takeover_id FROM generation_takeovers WHERE project_id = ? AND to_generation = 2",
      fx.projectId,
    );
    assert.ok(takeover);
    assert.throws(
      () => fx.runtime.store.run(
        "UPDATE generation_takeovers SET reason = reason WHERE takeover_id = ?",
        takeover.takeover_id,
      ),
      /immutable_generation_takeover/,
    );
    assert.throws(
      () => fx.runtime.store.run("DELETE FROM generation_takeovers WHERE takeover_id = ?", takeover.takeover_id),
      /immutable_generation_takeover/,
    );

    fx.runtime.store.run("UPDATE projects SET status = 'read_only' WHERE project_id = ?", fx.projectId);
    assert.throws(
      () => fx.runtime.identity.assignRole({
        projectId: fx.projectId,
        actor: refreshedActor,
        principalId: reviewer.ref.principalId,
        role: "observer",
        idempotencyKey: "idempotency.command-audit.read-only-rejected",
      }),
      /project_not_active/,
    );
    assert.equal(fx.runtime.store.get(
      "SELECT COUNT(*) AS count FROM idempotency_records WHERE idempotency_key = ?",
      "idempotency.command-audit.read-only-rejected",
    ).count, 0);
    assert.deepEqual(fx.runtime.identity.assignRole({
      projectId: fx.projectId,
      actor: refreshedActor,
      principalId: reviewer.ref.principalId,
      role: "reviewer",
      idempotencyKey: roleKey,
    }), JSON.parse(originalRoleRecord.response_json), "read-only mode still permits an exact replay");
  } finally {
    fx.cleanup();
  }
});

test("state revisions cover non-event commands and the database permits only one project", () => {
  const fx = createFixture("state-revision-singleton");
  try {
    const before = fx.runtime.store.get(
      "SELECT state_revision FROM projects WHERE project_id = ?",
      fx.projectId,
    ).state_revision;
    const eventBefore = fx.runtime.store.get(
      "SELECT COALESCE(MAX(sequence), 0) AS sequence FROM events WHERE project_id = ?",
      fx.projectId,
    ).sequence;
    fx.runtime.identity.registerHost({
      projectId: fx.projectId,
      actor: fx.owner,
      host: {
        ...fx.host,
        hostId: "host.state-revision-secondary",
        instanceId: "instance.state-revision-secondary.001",
        hostnameHash: "2".repeat(64),
      },
      idempotencyKey: "idempotency.state-revision.register-host",
    });
    assert.equal(
      fx.runtime.store.get("SELECT state_revision FROM projects WHERE project_id = ?", fx.projectId).state_revision,
      before + 1,
    );
    assert.equal(
      fx.runtime.store.get("SELECT COALESCE(MAX(sequence), 0) AS sequence FROM events WHERE project_id = ?", fx.projectId).sequence,
      eventBefore,
      "a non-event identity mutation still invalidates an older backup revision",
    );

    assert.throws(() => fx.runtime.store.run(
      `INSERT INTO projects(project_id, active_generation, next_fencing_token, state_revision, status, created_at, updated_at)
       VALUES (?, 1, 0, 0, 'active', ?, ?)`,
      "project.synthetic.second-forbidden",
      fx.clock.value,
      fx.clock.value,
    ), /singleton_project_database_required/);
  } finally {
    fx.cleanup();
  }
});
