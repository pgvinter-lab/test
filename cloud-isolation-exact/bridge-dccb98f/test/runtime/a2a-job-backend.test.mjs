// Behavioral tests for the concrete JobBackedA2ATaskBackend (Phase A, D-026 —
// "do the recommendation"): an inbound A2A message becomes a Bridge review job,
// synthesizing a `prompt` artifact and a default acceptance criterion. Exercised
// with fake JobService/ArtifactService (the port design needs no store fixture).

import assert from "node:assert/strict";
import test from "node:test";
import { JobBackedA2ATaskBackend } from "../../dist/v2/a2a/job-backend.js";

const NOW = "2026-07-14T00:00:00.000Z";
const ACTOR = { principalId: "principal.pgvin.codex", sessionId: "session.codex.1", hostId: "host.desk" };
const CALLER = { peer: "codex", principalId: ACTOR.principalId };

function fakeArtifacts() {
  const calls = [];
  const byId = new Map();
  return {
    calls,
    // Mirrors ArtifactService.get: undefined until registered. The backend checks
    // this before registering so a retry on a later clock tick stays idempotent.
    get(artifactId) {
      return byId.get(artifactId);
    },
    register(args) {
      calls.push(args);
      byId.set(args.artifact.artifactId, args.artifact);
      return args.artifact;
    },
  };
}

function fakeJobs(readBack) {
  const calls = { create: [], requireForProject: [], cancel: [] };
  return {
    calls,
    create(input) {
      calls.create.push(input);
      return { jobId: input.jobId, projectId: input.projectId, status: "queued", updatedAt: NOW, target: input.target };
    },
    requireForProject(projectId, jobId) {
      calls.requireForProject.push({ projectId, jobId });
      return { jobId, projectId, updatedAt: NOW, ...(readBack ?? { status: "running" }) };
    },
    cancel(input) {
      calls.cancel.push(input);
      return { jobId: input.jobId, projectId: input.projectId, status: "cancelled", updatedAt: NOW };
    },
  };
}

function makeBackend(jobs, artifacts) {
  return new JobBackedA2ATaskBackend({
    jobs,
    artifacts,
    resolve: () => ({ projectId: "project.test", actor: ACTOR }),
    now: () => NOW,
  });
}

function textMessage(messageId, text) {
  return { message: { kind: "message", role: "user", messageId, parts: [{ kind: "text", text }] } };
}

test("send registers a prompt artifact and creates a collaboration job", async () => {
  const jobs = fakeJobs();
  const artifacts = fakeArtifacts();
  const backend = makeBackend(jobs, artifacts);

  const taskResult = await backend.send(textMessage("msg-1", "summarize the filing"), CALLER);

  // One artifact registered, kind "prompt", attributed to the resolved actor.
  assert.equal(artifacts.calls.length, 1);
  const artifact = artifacts.calls[0].artifact;
  assert.equal(artifact.kind, "prompt");
  assert.equal(artifact.projectId, "project.test");
  assert.deepEqual(artifact.createdBy, ACTOR);
  assert.match(artifact.content.sha256, /^[a-f0-9]{64}$/);
  assert.equal(artifact.provenance.origin, "agent");
  assert.equal(artifact.locations[0].storageClass, "local");

  // One job created, targeting that artifact + exactly one synthesized criterion.
  assert.equal(jobs.calls.create.length, 1);
  const created = jobs.calls.create[0];
  assert.equal(created.mode, "collaboration");
  assert.equal(created.requiredRole, "worker");
  assert.deepEqual(created.target.artifactIds, [artifact.artifactId]);
  assert.equal(created.target.instructions, "summarize the filing");
  assert.equal(created.target.acceptanceCriteria.length, 1);

  // Returned A2A task: id == jobId, queued -> "submitted".
  assert.equal(taskResult.kind, "task");
  assert.equal(taskResult.id, created.jobId);
  assert.equal(taskResult.status.state, "submitted");
  assert.equal(taskResult.status.timestamp, NOW);
});

test("send is idempotent for identical messages (deterministic ids)", async () => {
  const jobs = fakeJobs();
  const backend = makeBackend(jobs, fakeArtifacts());
  const a = await backend.send(textMessage("msg-2", "same body"), CALLER);
  const b = await backend.send(textMessage("msg-2", "same body"), CALLER);
  assert.equal(a.id, b.id);
  assert.equal(jobs.calls.create[0].jobId, jobs.calls.create[1].jobId);
  assert.equal(jobs.calls.create[0].idempotencyKey, jobs.calls.create[1].idempotencyKey);
});

test("same messageId with different content yields a different job (no false merge)", async () => {
  const jobs = fakeJobs();
  const backend = makeBackend(jobs, fakeArtifacts());
  const a = await backend.send(textMessage("msg-3", "body one"), CALLER);
  const b = await backend.send(textMessage("msg-3", "body two"), CALLER);
  assert.notEqual(a.id, b.id);
});

test("a message with no text parts still produces non-empty instructions", async () => {
  const jobs = fakeJobs();
  const backend = makeBackend(jobs, fakeArtifacts());
  const message = { message: { kind: "message", role: "user", messageId: "msg-4", parts: [{ kind: "data", data: { k: 1 } }] } };
  await backend.send(message, CALLER);
  const instructions = jobs.calls.create[0].target.instructions;
  assert.ok(instructions.length > 0);
  assert.match(instructions, /non-text parts/);
});

test("get is scoped to the caller's project and projects job status", async () => {
  const jobs = fakeJobs({ status: "running" });
  const backend = makeBackend(jobs, fakeArtifacts());
  const taskResult = await backend.get({ id: "job.a2a-abc" }, CALLER);
  assert.deepEqual(jobs.calls.requireForProject[0], { projectId: "project.test", jobId: "job.a2a-abc" });
  assert.equal(taskResult.status.state, "working");
});

test("get surfaces a completed job's result artifacts", async () => {
  const jobs = fakeJobs({ status: "completed", result: { artifactIds: ["artifact.result-1"] } });
  const backend = makeBackend(jobs, fakeArtifacts());
  const taskResult = await backend.get({ id: "job.done" }, CALLER);
  assert.equal(taskResult.status.state, "completed");
  assert.equal(taskResult.artifacts.length, 1);
  assert.equal(taskResult.artifacts[0].artifactId, "artifact.result-1");
  assert.deepEqual(taskResult.artifacts[0].parts[0], { kind: "data", data: { bridgeArtifactId: "artifact.result-1" } });
});

test("cancel passes a reason and maps cancelled -> canceled", async () => {
  const jobs = fakeJobs();
  const backend = makeBackend(jobs, fakeArtifacts());
  const taskResult = await backend.cancel({ id: "job.a2a-xyz" }, CALLER);
  assert.equal(jobs.calls.cancel[0].jobId, "job.a2a-xyz");
  assert.ok(jobs.calls.cancel[0].reason.length > 0);
  assert.equal(taskResult.status.state, "canceled");
});
