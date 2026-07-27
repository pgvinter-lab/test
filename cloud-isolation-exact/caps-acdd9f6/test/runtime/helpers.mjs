import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { BridgeRuntime, sha256 } from "../../dist/v2/index.js";

export function createFixture(label = "runtime") {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), `bridge2-${label}-`));
  const databasePath = path.join(root, "state", "bridge2.sqlite");
  const auditMirrorPath = path.join(root, "audit", "events.jsonl");
  const clock = { value: "2026-07-13T12:00:00.000Z" };
  const runtime = new BridgeRuntime({
    databasePath,
    auditMirrorPath,
    initialize: true,
    now: () => clock.value,
  });
  const projectId = "project.synthetic";
  const host = {
    hostId: "host.synthetic",
    instanceId: "instance.synthetic.001",
    hostnameHash: "0".repeat(64),
    platform: "windows",
    status: "active",
    registeredAt: clock.value,
  };
  const ownerPrincipal = principal("owner", clock.value);
  const ownerSession = session("owner", ownerPrincipal.principalId, host.hostId, clock.value, "stdio-owner-session-0001");
  const owner = { principalId: ownerPrincipal.principalId, sessionId: ownerSession.sessionId, hostId: host.hostId };
  runtime.identity.bootstrapOwner({
    projectId,
    principal: ownerPrincipal,
    host,
    session: ownerSession,
    idempotencyKey: "idempotency.bootstrap.owner",
  });

  let identityCounter = 0;
  function addIdentity(name, roles, transport = "stdio") {
    identityCounter += 1;
    const record = principal(name, clock.value);
    runtime.identity.registerPrincipal({
      projectId,
      actor: owner,
      principal: record,
      idempotencyKey: `idempotency.principal.${name}.${identityCounter}`,
    });
    const transportSessionId = `${transport}-${name}-session-${String(identityCounter).padStart(8, "0")}`;
    const recordSession = session(name, record.principalId, host.hostId, clock.value, transportSessionId, transport);
    runtime.identity.createSession({
      projectId,
      actor: owner,
      session: recordSession,
      idempotencyKey: `idempotency.session.${name}.${identityCounter}`,
    });
    for (const role of roles) {
      runtime.identity.assignRole({
        projectId,
        actor: owner,
        principalId: record.principalId,
        role,
        idempotencyKey: `idempotency.role.${name}.${role}.${identityCounter}`,
      });
    }
    return {
      principal: record,
      session: recordSession,
      ref: { principalId: record.principalId, sessionId: recordSession.sessionId, hostId: host.hostId },
    };
  }

  let artifactCounter = 0;
  function registerArtifact({ actor = owner, kind = "source", text = "synthetic", parents = [], citations = [], sensitivity = "internal", locations } = {}) {
    artifactCounter += 1;
    const artifactId = `artifact.synthetic.${String(artifactCounter).padStart(4, "0")}`;
    const artifact = {
      schemaVersion: "0.1.0-draft.4",
      artifactId,
      projectId,
      kind,
      createdAt: clock.value,
      createdBy: actor,
      sensitivity,
      content: { mediaType: "text/plain", sizeBytes: Buffer.byteLength(text), sha256: sha256(Buffer.from(text)) },
      locations: locations ?? [{ storageClass: "local", uri: `file:///synthetic/${artifactId}.txt`, encrypted: false }],
      provenance: { origin: actor.principalId === owner.principalId ? "human" : "agent", parentArtifactIds: parents, captureMethod: "synthetic runtime test" },
      citations,
      retention: { policy: "project" },
    };
    return runtime.artifacts.register({ actor, artifact, idempotencyKey: `idempotency.artifact.${artifactCounter}` });
  }

  function cleanup() {
    try { runtime.close(); } catch {}
    fs.rmSync(root, { recursive: true, force: true });
  }

  return { root, databasePath, auditMirrorPath, clock, runtime, projectId, host, owner, ownerPrincipal, ownerSession, addIdentity, registerArtifact, cleanup };
}

export function principal(name, at) {
  return {
    principalId: `principal.${name}`,
    kind: name === "owner" ? "human" : "agent",
    displayName: `Synthetic ${name}`,
    issuer: "synthetic-tests",
    subject: `subject:${name}`,
    status: "active",
    createdAt: at,
  };
}

export function session(name, principalId, hostId, at, transportSessionId, transport = "stdio") {
  return {
    sessionId: `session.${name}.001`,
    principalId,
    hostId,
    startedAt: at,
    expiresAt: "2027-07-13T12:00:00.000Z",
    status: "active",
    authentication: { method: "local_process", assurance: "local" },
    transportBinding: { transport, transportSessionId, serverInstanceId: "instance.server.synthetic" },
  };
}

export function browserManifest() {
  const reviewSchema = "https://bridge2.local/contracts/v0.1.0-draft.4/schemas/review-job.schema.json";
  return {
    schemaVersion: "0.1.0-draft.4",
    adapterId: "adapter.browser.synthetic",
    adapterVersion: "0.1.0-draft.4",
    interfaceVersion: "0.1.0-draft.4",
    displayName: "Synthetic Browser",
    kind: "browser",
    operations: {
      compose: { inputSchema: reviewSchema, outputSchema: reviewSchema, idempotent: true, sideEffectClass: "external_reversible", timeoutMs: 5000 },
    },
    capabilities: ["synthetic_compose"],
    transports: ["stdio"],
    security: {
      credentialMode: "brokered",
      networkAccess: ["https://example.invalid", "https://example.invalid/drafts"],
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

export function localReadAdapterManifest() {
  const reviewSchema = "https://bridge2.local/contracts/v0.1.0-draft.4/schemas/review-job.schema.json";
  return {
    schemaVersion: "0.1.0-draft.4",
    adapterId: "adapter.local.synthetic",
    adapterVersion: "0.1.0-draft.4",
    interfaceVersion: "0.1.0-draft.4",
    displayName: "Synthetic Local Reader",
    kind: "local_process",
    operations: {
      inspect: { inputSchema: reviewSchema, outputSchema: reviewSchema, idempotent: true, sideEffectClass: "read_only", timeoutMs: 5000 },
    },
    capabilities: ["synthetic_read"],
    transports: ["in_process"],
    security: {
      credentialMode: "none",
      networkAccess: [],
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
