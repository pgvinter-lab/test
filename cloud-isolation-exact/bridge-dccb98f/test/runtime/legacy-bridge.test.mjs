import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { LegacyBridgeFacade } from "../../dist/v2/compat/legacy-core.js";

function fixture() {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "bridge2-legacy-worker-"));
  const stateRoot = path.join(root, "state");
  const project = path.join(root, "project");
  fs.mkdirSync(project, { recursive: true });
  const create = (lane) => new LegacyBridgeFacade({
    stateRoot,
    recoveryRoot: path.join(root, "recovery"),
    config: {
      agent: lane,
      host: "legacy-worker-test-host",
      sessionId: `${lane}:session`,
      bridgeHome: stateRoot,
      project,
    },
    lane: () => ({ lane, warning: null, ambiguous: false }),
    now: () => new Date("2026-07-17T20:00:00.000Z"),
  });
  const cleanup = async () => {
    const deadline = Date.now() + 30_000;
    for (;;) {
      try {
        fs.rmSync(root, { recursive: true, force: true });
        return;
      } catch (error) {
        const retryable = process.platform === "win32"
          && ["EBUSY", "ENOTEMPTY", "EPERM"].includes(error?.code);
        if (!retryable || Date.now() >= deadline) throw error;
        await new Promise((resolve) => setTimeout(resolve, 250));
      }
    }
  };
  return { project, create, cleanup };
}

test("google_antigravity can update only its own tasks with monotonic status and no owner reassignment", async () => {
  const fx = fixture();
  const coordinator = fx.create("codex");
  const worker = fx.create("google_antigravity");
  try {
    const owned = await coordinator.taskAdd({
      project: fx.project,
      title: "Antigravity-owned task",
      owner: "google_antigravity",
    });
    const foreign = await coordinator.taskAdd({
      project: fx.project,
      title: "Coordinator-owned task",
      owner: "codex",
    });

    const foreignDenied = await worker.taskUpdate({
      project: fx.project,
      id: foreign.id,
      status: "doing",
    });
    assert.equal(foreignDenied.ok, false);
    assert.match(foreignDenied.message, /only tasks currently owned/u);

    const reassignmentDenied = await worker.taskUpdate({
      project: fx.project,
      id: owned.id,
      owner: "codex",
    });
    assert.equal(reassignmentDenied.ok, false);
    assert.match(reassignmentDenied.message, /may not reassign/u);

    const started = await worker.taskUpdate({
      project: fx.project,
      id: owned.id,
      status: "doing",
      owner: "google_antigravity",
    });
    assert.equal(started.ok, true);
    assert.equal(started.task.status, "doing");
    assert.equal(started.task.owner, "google_antigravity");

    const idempotent = await worker.taskUpdate({
      project: fx.project,
      id: owned.id,
      status: "doing",
    });
    assert.equal(idempotent.ok, true);
    assert.equal(idempotent.task.status, "doing");

    const backwardDenied = await worker.taskUpdate({
      project: fx.project,
      id: owned.id,
      status: "todo",
    });
    assert.equal(backwardDenied.ok, false);
    assert.match(backwardDenied.message, /may not move task status backward/u);

    const completed = await worker.taskUpdate({
      project: fx.project,
      id: owned.id,
      status: "done",
    });
    assert.equal(completed.ok, true);
    assert.equal(completed.task.status, "done");

    const terminalIdempotent = await worker.taskUpdate({
      project: fx.project,
      id: owned.id,
      status: "done",
    });
    assert.equal(terminalIdempotent.ok, true);

    const terminalBackwardDenied = await worker.taskUpdate({
      project: fx.project,
      id: owned.id,
      status: "doing",
    });
    assert.equal(terminalBackwardDenied.ok, false);

    const coordinatorUpdate = await coordinator.taskUpdate({
      project: fx.project,
      id: foreign.id,
      status: "doing",
      owner: "claude_desktop_code",
    });
    assert.equal(coordinatorUpdate.ok, true);
    const coordinatorBackwardReassignment = await coordinator.taskUpdate({
      project: fx.project,
      id: foreign.id,
      status: "todo",
      owner: "claude_desktop_cowork",
    });
    assert.equal(coordinatorBackwardReassignment.ok, true);
    assert.equal(coordinatorBackwardReassignment.task.status, "todo");
    assert.equal(coordinatorBackwardReassignment.task.owner, "claude_desktop_cowork");
  } finally {
    coordinator.close();
    worker.close();
    await fx.cleanup();
  }
});
