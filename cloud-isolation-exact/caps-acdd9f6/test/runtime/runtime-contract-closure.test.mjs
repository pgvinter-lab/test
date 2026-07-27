import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import fs from "node:fs";
import path from "node:path";
import { pathToFileURL } from "node:url";
import test from "node:test";
import { createFixture, principal, session } from "./helpers.mjs";

test("idempotency follows project-principal-operation scope across a refreshed session", () => {
  const fx = createFixture("idempotency-session-refresh");
  try {
    const target = fx.addIdentity("idempotency_target", []);
    const refreshedSession = {
      ...session(
        "owner_refresh",
        fx.owner.principalId,
        fx.owner.hostId,
        fx.clock.value,
        "stdio-owner-refreshed-session-0001",
      ),
      sessionId: "session.owner.refresh.001",
    };
    fx.runtime.identity.createSession({
      projectId: fx.projectId,
      actor: fx.owner,
      session: refreshedSession,
      idempotencyKey: "idempotency.session.owner.refresh",
    });
    const request = {
      projectId: fx.projectId,
      actor: fx.owner,
      principalId: target.ref.principalId,
      role: "observer",
      idempotencyKey: "idempotency.role.session.refresh",
    };
    const first = fx.runtime.identity.assignRole(request);
    const replay = fx.runtime.identity.assignRole({
      ...request,
      actor: {
        principalId: fx.owner.principalId,
        hostId: fx.owner.hostId,
        sessionId: refreshedSession.sessionId,
      },
    });
    assert.deepEqual(replay, first);
  } finally {
    fx.cleanup();
  }
});

test("principal, session, and host mutations enforce the strict contract schema", () => {
  const fx = createFixture("identity-contract");
  try {
    const invalidPrincipal = {
      ...principal("invalid_extra", fx.clock.value),
      unexpectedAuthorizationLabel: "owner",
    };
    assert.throws(
      () => fx.runtime.identity.registerPrincipal({
        projectId: fx.projectId,
        actor: fx.owner,
        principal: invalidPrincipal,
        idempotencyKey: "idempotency.invalid.principal.extra",
      }),
      /contract_schema_validation_failed/,
    );
    assert.throws(
      () => fx.runtime.identity.registerPrincipal({
        projectId: fx.projectId,
        actor: fx.owner,
        principal: { ...principal("invalid_length", fx.clock.value), displayName: "x".repeat(201) },
        idempotencyKey: "idempotency.invalid.principal.length",
      }),
      /contract_schema_validation_failed/,
    );

    const identity = fx.addIdentity("identity_schema_target", []);
    assert.throws(
      () => fx.runtime.identity.createSession({
        projectId: fx.projectId,
        actor: fx.owner,
        session: {
          ...session(
            "bad_auth",
            identity.ref.principalId,
            fx.host.hostId,
            fx.clock.value,
            "stdio-invalid-auth-session-0001",
          ),
          sessionId: "session.bad_auth.001",
          authentication: { method: "display_name_trust", assurance: "absolute" },
        },
        idempotencyKey: "idempotency.invalid.session.auth",
      }),
      /contract_schema_validation_failed/,
    );
    assert.throws(
      () => fx.runtime.identity.registerHost({
        projectId: fx.projectId,
        actor: fx.owner,
        host: {
          ...fx.host,
          hostId: "host.invalid.extra",
          instanceId: "instance.invalid.extra",
          localPassword: "forbidden",
        },
        idempotencyKey: "idempotency.invalid.host.extra",
      }),
      /contract_schema_validation_failed/,
    );
  } finally {
    fx.cleanup();
  }
});

test("concurrent runtime processes serialize JSONL outbox append and acknowledgement", async () => {
  const rounds = Number.parseInt(process.env.BRIDGE_WAL_RACE_ROUNDS ?? "1", 10);
  assert.ok(Number.isInteger(rounds) && rounds >= 1 && rounds <= 100, "BRIDGE_WAL_RACE_ROUNDS must be between 1 and 100");
  for (let round = 1; round <= rounds; round += 1) {
    await runMirrorConcurrencyRound(round);
  }
});

async function runMirrorConcurrencyRound(round) {
  const fx = createFixture(`mirror-concurrency-${round}`);
  let runtimeClosed = false;
  try {
    const source = fx.registerArtifact({ text: "mirror concurrency source" });
    fx.runtime.jobs.create({
      projectId: fx.projectId,
      actor: fx.owner,
      idempotencyKey: "idempotency.job.create.mirror.concurrent",
      jobId: "job.synthetic.mirror.concurrent",
      mode: "collaboration",
      requiredRole: "collaborator",
      independence: { policy: "not_required", excludedPrincipalIds: [] },
      target: {
        artifactIds: [source.artifactId],
        instructions: "Create exactly one pending audit row.",
        acceptanceCriteria: ["The row is appended once."],
      },
    });
    const rows = fx.runtime.store.all(
      "SELECT project_id, mirror_sequence FROM audit_mirror_entries ORDER BY mirror_sequence",
    );
    assert.equal(rows.length, 1);
    fx.runtime.store.run(
      "UPDATE audit_mirror_entries SET file_appended = 0 WHERE project_id = ? AND mirror_sequence = ?",
      rows[0].project_id,
      rows[0].mirror_sequence,
    );
    fs.writeFileSync(fx.auditMirrorPath, "", "utf8");
    fx.runtime.close();
    runtimeClosed = true;

    const gate = path.join(fx.root, "mirror-flush.gate");
    const worker = path.join(fx.root, "mirror-flush-worker.mjs");
    const storeModule = pathToFileURL(path.resolve("dist/v2/storage/store.js")).href;
    fs.writeFileSync(worker, `
      import fs from "node:fs";
      import { setTimeout as delay } from "node:timers/promises";
      import { BridgeStore } from ${JSON.stringify(storeModule)};
      while (!fs.existsSync(process.argv[4])) await delay(2);
      const store = new BridgeStore({ databasePath: process.argv[2], auditMirrorPath: process.argv[3] });
      try { store.flushAuditMirror(); } finally { store.close(); }
    `, "utf8");
    const launch = () => spawn(process.execPath, [worker, fx.databasePath, fx.auditMirrorPath, gate], {
      stdio: ["ignore", "pipe", "pipe"],
    });
    const workers = Array.from({ length: 4 }, launch);
    fs.writeFileSync(gate, "go", "utf8");
    const waitFor = (child) => new Promise((resolve, reject) => {
      let stderr = "";
      child.stderr.on("data", (chunk) => { stderr += String(chunk); });
      child.once("error", reject);
      child.once("exit", (code) => code === 0 ? resolve() : reject(new Error(`worker exited ${code}: ${stderr}`)));
    });
    await Promise.all(workers.map(waitFor));

    const lines = fs.readFileSync(fx.auditMirrorPath, "utf8").trimEnd().split("\n").filter(Boolean);
    assert.equal(lines.length, 1, "one outbox row must produce one JSONL line");
    const { DatabaseSync } = await import("node:sqlite");
    const database = new DatabaseSync(fx.databasePath, { readOnly: true });
    try {
      const state = database.prepare("SELECT file_appended FROM audit_mirror_entries").get();
      assert.equal(Number(state.file_appended), 1);
    } finally {
      database.close();
    }
  } finally {
    if (!runtimeClosed) fx.cleanup();
    else fs.rmSync(fx.root, { recursive: true, force: true });
  }
}
