import assert from "node:assert/strict";
import fs from "node:fs";
import http from "node:http";
import path from "node:path";
import test from "node:test";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StdioClientTransport } from "@modelcontextprotocol/sdk/client/stdio.js";
import { StreamableHTTPClientTransport } from "@modelcontextprotocol/sdk/client/streamableHttp.js";
import {
  StreamableHttpBoundary,
  availableRuntimeTools,
  canonicalize,
  hashEvent,
} from "../../dist/v2/index.js";
import { createFixture } from "./helpers.mjs";

function context(fx, identity) {
  return {
    projectId: fx.projectId,
    actor: identity.ref,
    transport: {
      transport: identity.session.transportBinding.transport,
      transportSessionId: identity.session.transportBinding.transportSessionId,
      serverInstanceId: identity.session.transportBinding.serverInstanceId,
    },
  };
}

test("server-derived MCP profiles hide unauthorized tools and keep admin disabled by default", () => {
  const fx = createFixture("profiles");
  try {
    const reviewer = fx.addIdentity("reviewer_profiles", ["reviewer"]);
    const administrator = fx.addIdentity("administrator_profiles", ["administrator"]);
    const reviewerTools = availableRuntimeTools(fx.runtime, context(fx, reviewer));
    assert.ok(reviewerTools.includes("bridge_v2_claim_job"));
    assert.ok(reviewerTools.includes("bridge_v2_release_job"));
    assert.ok(reviewerTools.includes("bridge_v2_complete_job"));
    assert.ok(reviewerTools.includes("bridge_v2_invoke_adapter"));
    assert.ok(reviewerTools.includes("bridge_v2_list_approval_grants"));
    assert.ok(!reviewerTools.includes("bridge_v2_create_approval_grant"));
    assert.ok(!reviewerTools.includes("bridge_v2_takeover"));
    assert.ok(!reviewerTools.includes("bridge_v2_assign_role"));

    const ownerIdentity = { ref: fx.owner, session: fx.ownerSession };
    const ownerTools = availableRuntimeTools(fx.runtime, context(fx, ownerIdentity));
    assert.ok(ownerTools.includes("bridge_v2_takeover"));
    assert.ok(ownerTools.includes("bridge_v2_backup"));
    assert.ok(ownerTools.includes("bridge_v2_restore_plan"));
    assert.ok(ownerTools.includes("bridge_v2_migration_plan"));
    assert.ok(ownerTools.includes("bridge_v2_migrate"));
    assert.ok(ownerTools.includes("bridge_v2_amend_instructions"));
    assert.ok(ownerTools.includes("bridge_v2_create_approval_grant"));
    assert.ok(ownerTools.includes("bridge_v2_register_adapter"));
    assert.ok(ownerTools.includes("bridge_v2_register_artifact"), "owners must be able to register a takeover reconciliation report artifact");
    assert.ok(!ownerTools.includes("bridge_v2_claim_job"), "owner role must not imply reviewer or worker authority");

    const adminDefault = availableRuntimeTools(fx.runtime, context(fx, administrator));
    assert.ok(!adminDefault.includes("bridge_v2_assign_role"));
    const adminEnabled = availableRuntimeTools(fx.runtime, { ...context(fx, administrator), adminEnabled: true });
    assert.ok(adminEnabled.includes("bridge_v2_assign_role"));
    assert.ok(adminEnabled.includes("bridge_v2_revoke_role"));
    assert.ok(adminEnabled.includes("bridge_v2_disable_principal"));
    assert.ok(adminEnabled.includes("bridge_v2_set_host_status"));
    assert.ok(adminEnabled.includes("bridge_v2_register_host"));
    assert.ok(adminEnabled.includes("bridge_v2_create_session"));
    assert.ok(adminEnabled.includes("bridge_v2_revoke_session"));
  } finally {
    fx.cleanup();
  }
});

test("Streamable HTTP boundary is disabled by default and refuses an unapproved remote bind", () => {
  const fx = createFixture("http-boundary");
  try {
    assert.throws(
      () => new StreamableHttpBoundary(fx.runtime, {
        enabled: true,
        bindHost: "0.0.0.0",
        allowedOrigins: ["https://example.invalid"],
        authenticate: async () => { throw new Error("unused"); },
      }),
      /remote_http_policy_not_approved/,
    );
    const local = new StreamableHttpBoundary(fx.runtime, {
      allowedOrigins: ["https://example.invalid"],
      authenticate: async () => { throw new Error("disabled"); },
    });
    assert.equal(local.listenHost, "127.0.0.1");
  } finally {
    fx.cleanup();
  }
});

test("real loopback Streamable HTTP authenticates a server-bound identity and executes a mutation", async () => {
  const fx = createFixture("http-live");
  let client;
  let server;
  let boundary;
  try {
    const collaborator = fx.addIdentity("collaborator_http", ["collaborator"], "streamable_http");
    const source = fx.registerArtifact({ text: "streamable HTTP project source" });
    const authentication = {
      projectId: fx.projectId,
      actor: collaborator.ref,
      transportSessionId: collaborator.session.transportBinding.transportSessionId,
      serverInstanceId: collaborator.session.transportBinding.serverInstanceId,
    };
    boundary = new StreamableHttpBoundary(fx.runtime, {
      enabled: true,
      bindHost: "127.0.0.1",
      allowedOrigins: ["https://bridge2.local"],
      authenticate: async () => authentication,
    });
    server = http.createServer((request, response) => {
      boundary.handle(request, response).catch((error) => {
        response.statusCode = 500;
        response.end(String(error));
      });
    });
    await new Promise((resolve, reject) => {
      server.once("error", reject);
      server.listen(0, "127.0.0.1", resolve);
    });
    const address = server.address();
    assert.equal(typeof address, "object");
    const transport = new StreamableHTTPClientTransport(new URL(`http://127.0.0.1:${address.port}/mcp`), {
      requestInit: { headers: { origin: "https://bridge2.local" } },
    });
    client = new Client({ name: "bridge2-http-test", version: "0.1.0" });
    await client.connect(transport);
    const whoami = JSON.parse((await client.callTool({ name: "bridge_v2_whoami", arguments: {} })).content[0].text);
    assert.deepEqual(whoami.actor, collaborator.ref);
    const created = JSON.parse((await client.callTool({
      name: "bridge_v2_create_job",
      arguments: {
        input: {
          idempotencyKey: "idempotency.http.create-job",
          jobId: "job.synthetic.http.live",
          mode: "collaboration",
          requiredRole: "worker",
          independence: { policy: "not_required", excludedPrincipalIds: [] },
          target: {
            artifactIds: [source.artifactId],
            instructions: "Prove the live Streamable HTTP boundary executes a server-attributed mutation.",
            acceptanceCriteria: ["The persisted requester is the authenticated HTTP principal."],
          },
        },
      },
    })).content[0].text);
    assert.equal(created.requestedBy.principalId, collaborator.ref.principalId);
    assert.equal(fx.runtime.jobs.require(created.jobId).requestedBy.sessionId, collaborator.ref.sessionId);
  } finally {
    try { await client?.close(); } catch {}
    try { await boundary?.close(); } catch {}
    if (server) await new Promise((resolve) => server.close(resolve));
    fx.cleanup();
  }
});

test("real stdio MCP transport exposes the reviewer profile and binds identity server-side", async () => {
  const fx = createFixture("stdio");
  let client;
  try {
    const reviewer = fx.addIdentity("reviewer_stdio", ["reviewer"]);
    const source = fx.registerArtifact({ text: "stdio read surface source" });
    const job = fx.runtime.jobs.create({
      projectId: fx.projectId,
      actor: fx.owner,
      idempotencyKey: "idempotency.transport.read-job",
      jobId: "job.synthetic.transport.read",
      mode: "independent_review",
      requiredRole: "reviewer",
      independence: { policy: "required", excludedPrincipalIds: [] },
      target: {
        artifactIds: [source.artifactId],
        instructions: "Exercise every project-filtered bridge.read operation.",
        acceptanceCriteria: ["Return only records from the bound project."],
      },
    });
    fx.runtime.jobs.makeClaimable({
      projectId: fx.projectId,
      jobId: job.jobId,
      actor: fx.owner,
      idempotencyKey: "idempotency.transport.make-claimable",
    });
    const connection = context(fx, reviewer);
    const contextPath = path.join(fx.root, "stdio-context.json");
    fs.writeFileSync(contextPath, JSON.stringify(connection));
    fx.runtime.close();
    const transport = new StdioClientTransport({
      command: process.execPath,
      args: [
        path.resolve("dist/v2/cli/main.js"),
        "serve-stdio",
        "--db", fx.databasePath,
        "--audit", fx.auditMirrorPath,
        "--context", contextPath,
      ],
      env: { ...process.env },
      stderr: "pipe",
    });
    client = new Client({ name: "bridge2-runtime-test", version: "0.1.0" });
    await client.connect(transport);
    const listed = await client.listTools();
    const names = listed.tools.map((tool) => tool.name);
    assert.ok(names.includes("bridge_v2_get_job"));
    assert.ok(names.includes("bridge_v2_whoami"));
    assert.ok(names.includes("bridge_v2_list_jobs"));
    assert.ok(names.includes("bridge_v2_get_artifact"));
    assert.ok(names.includes("bridge_v2_list_artifacts"));
    assert.ok(names.includes("bridge_v2_claim_job"));
    assert.ok(names.includes("bridge_v2_release_job"));
    assert.ok(!names.includes("bridge_v2_takeover"));
    const status = await client.callTool({ name: "bridge_v2_status", arguments: {} });
    const payload = JSON.parse(status.content[0].text);
    assert.equal(payload.projectId, fx.projectId);
    assert.equal(payload.generation, 1);
    const whoami = JSON.parse((await client.callTool({ name: "bridge_v2_whoami", arguments: {} })).content[0].text);
    assert.deepEqual(whoami.actor, reviewer.ref);
    assert.deepEqual(whoami.roles, ["reviewer"]);
    const jobs = JSON.parse((await client.callTool({ name: "bridge_v2_list_jobs", arguments: {} })).content[0].text);
    assert.deepEqual(jobs.map((entry) => entry.jobId), [job.jobId]);
    const fetchedJob = JSON.parse((await client.callTool({ name: "bridge_v2_get_job", arguments: { jobId: job.jobId } })).content[0].text);
    assert.equal(fetchedJob.projectId, fx.projectId);
    const artifacts = JSON.parse((await client.callTool({ name: "bridge_v2_list_artifacts", arguments: {} })).content[0].text);
    assert.deepEqual(artifacts.map((entry) => entry.artifactId), [source.artifactId]);
    const fetchedArtifact = JSON.parse((await client.callTool({ name: "bridge_v2_get_artifact", arguments: { artifactId: source.artifactId } })).content[0].text);
    assert.equal(fetchedArtifact.projectId, fx.projectId);
    const claimed = JSON.parse((await client.callTool({
      name: "bridge_v2_claim_job",
      arguments: { jobId: job.jobId, leaseMs: 60_000, idempotencyKey: "idempotency.transport.claim" },
    })).content[0].text);
    assert.equal(claimed.status, "claimed");
    assert.equal(claimed.claim.claimedBy.principalId, reviewer.ref.principalId);
    const released = JSON.parse((await client.callTool({
      name: "bridge_v2_release_job",
      arguments: { jobId: job.jobId, claim: claimed.claim, idempotencyKey: "idempotency.transport.release" },
    })).content[0].text);
    assert.equal(released.status, "claimable");
    assert.equal(released.claim, undefined);
  } finally {
    try { await client?.close(); } catch {}
    fx.cleanup();
  }
});

test("runtime hashing independently matches the frozen draft.4 vector and Unicode scalar ordering", () => {
  const event = JSON.parse(fs.readFileSync("contracts/v0.1.0-draft.4/examples/event.valid.json", "utf8"));
  assert.equal(hashEvent(event), event.hash);
  const supplementary = "\u{10000}";
  const bmp = "\uE000";
  assert.equal(canonicalize({ [bmp]: 1, [supplementary]: 2 }), `{${JSON.stringify(bmp)}:1,${JSON.stringify(supplementary)}:2}`);
});
