import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { LegacyBridgeFacade } from "../../dist/v2/compat/legacy-core.js";

function fixture(runProcess) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "bridge2-antigravity-a2a-"));
  const stateRoot = path.join(root, "state");
  const project = path.join(root, "project");
  fs.mkdirSync(project, { recursive: true });
  const calls = [];
  const facade = new LegacyBridgeFacade({
    stateRoot,
    recoveryRoot: path.join(root, "recovery"),
    config: {
      agent: "antigravity",
      host: "antigravity-a2a-test-host",
      sessionId: "antigravity:a2a:test",
      bridgeHome: stateRoot,
      project,
    },
    lane: () => ({ lane: "google_antigravity", warning: null, ambiguous: false }),
    runProcess: async (command, args, input) => {
      calls.push({ command, args: [...args], input });
      if (runProcess) return runProcess(command, args, input);
      return { stdout: "BRIDGE_A2A_TERMINAL_SENTINEL", stderr: "", code: 0 };
    },
  });
  const cleanup = async () => {
    facade.close();
    const deadline = Date.now() + 30_000;
    for (;;) {
      try {
        fs.rmSync(root, { recursive: true, force: true });
        return;
      } catch (error) {
        if (process.platform !== "win32" || !["EBUSY", "ENOTEMPTY", "EPERM"].includes(error?.code) || Date.now() >= deadline) throw error;
        await new Promise((resolve) => setTimeout(resolve, 100));
      }
    }
  };
  return { root, stateRoot, project, facade, calls, cleanup };
}

test("Antigravity A2A send reaches a subscription peer and returns a terminal durable receipt", async () => {
  const fx = fixture();
  try {
    const result = await fx.facade.a2aSend({
      project: fx.project,
      target: "codex",
      prompt: "Return the synthetic sentinel only.",
      idempotencyKey: "antigravity-a2a-terminal-1",
    });
    assert.equal(result.ok, true);
    assert.equal(result.channel, "a2a");
    assert.equal(result.source, "antigravity");
    assert.equal(result.target, "codex");
    assert.equal(result.terminal, true);
    assert.equal(result.state, "completed");
    assert.equal(result.output, "BRIDGE_A2A_TERMINAL_SENTINEL");
    assert.match(result.taskId, /^job\.a2a-/u);
    assert.equal(result.artifactIds.length, 1);
    assert.equal(fx.calls.length, 1);
    assert.equal(fx.calls[0].command, "codex");
    assert.deepEqual(fx.calls[0].args, ["exec", "--skip-git-repo-check"]);
    assert.equal(fx.calls[0].input, "Return the synthetic sentinel only.");

    const readBack = await fx.facade.a2aGet({ project: fx.project, id: result.taskId });
    assert.equal(readBack.state, "completed");
    assert.equal(readBack.output, "BRIDGE_A2A_TERMINAL_SENTINEL");

    const replay = await fx.facade.a2aSend({
      project: fx.project,
      target: "codex",
      prompt: "Return the synthetic sentinel only.",
      idempotencyKey: "antigravity-a2a-terminal-1",
    });
    assert.equal(replay.taskId, result.taskId);
    assert.equal(replay.output, "BRIDGE_A2A_TERMINAL_SENTINEL");
    assert.equal(fx.calls.length, 1, "an idempotent replay must not invoke the peer twice");

    await assert.rejects(() => fx.facade.a2aSend({
      project: fx.project,
      target: "codex",
      prompt: "A different operation must not reuse the same key.",
      idempotencyKey: "antigravity-a2a-terminal-1",
    }), /idempotency_key_reused/u);
    assert.equal(fx.calls.length, 1);
  } finally {
    await fx.cleanup();
  }
});

test("concurrent identical A2A sends share one peer execution", async () => {
  let release;
  const gate = new Promise((resolve) => { release = resolve; });
  const fx = fixture(async () => {
    await gate;
    return { stdout: "BRIDGE_A2A_CONCURRENT_SENTINEL", stderr: "", code: 0 };
  });
  try {
    const request = {
      project: fx.project,
      target: "codex",
      prompt: "Return the concurrent sentinel only.",
      idempotencyKey: "antigravity-a2a-concurrent-1",
    };
    const first = fx.facade.a2aSend(request);
    while (fx.calls.length === 0) await new Promise((resolve) => setImmediate(resolve));
    const second = fx.facade.a2aSend(request);
    await new Promise((resolve) => setImmediate(resolve));
    assert.equal(fx.calls.length, 1, "a concurrent replay must join the active execution");
    release();
    const results = await Promise.all([first, second]);
    assert.equal(results[0].state, "completed");
    assert.equal(results[1].state, "completed");
    assert.equal(results[0].taskId, results[1].taskId);
    assert.equal(results[0].output, "BRIDGE_A2A_CONCURRENT_SENTINEL");
    assert.equal(results[1].output, "BRIDGE_A2A_CONCURRENT_SENTINEL");
    assert.equal(fx.calls.length, 1);
  } finally {
    release?.();
    await fx.cleanup();
  }
});

test("board rows are explicit non-dispatch ACKs and close only after bridge_task_dispatch completes", async () => {
  const fx = fixture();
  try {
    const task = await fx.facade.taskAdd({
      project: fx.project,
      title: "Synthetic board task",
      owner: "codex",
    });
    assert.equal(task.ok, true);
    assert.equal(task.boardOnly, true);
    assert.deepEqual(task.dispatch, { state: "not_dispatched", reason: "board_entry_only" });

    const dispatched = await fx.facade.taskDispatch({
      project: fx.project,
      id: task.id,
      idempotencyKey: "antigravity-board-dispatch-1",
    });
    assert.equal(dispatched.ok, true);
    assert.equal(dispatched.channel, "a2a");
    assert.equal(dispatched.boardTask.status, "done");
    assert.equal(dispatched.state, "completed");
    const sync = await fx.facade.sync(fx.project);
    assert.equal(sync.openTasks.some((item) => item.id === task.id), false);
  } finally {
    await fx.cleanup();
  }
});

test("a peer execution failure is terminal failed and cannot close the board row", async () => {
  const fx = fixture(async () => ({ stdout: "", stderr: "synthetic failure", code: 9 }));
  try {
    const task = await fx.facade.taskAdd({ project: fx.project, title: "Must remain open", owner: "codex" });
    const result = await fx.facade.taskDispatch({
      project: fx.project,
      id: task.id,
      idempotencyKey: "antigravity-board-failure-1",
    });
    assert.equal(result.ok, false);
    assert.equal(result.terminal, true);
    assert.equal(result.state, "failed");
    assert.equal(result.boardTask.status, "todo");
    const sync = await fx.facade.sync(fx.project);
    assert.equal(sync.openTasks.find((item) => item.id === task.id)?.status, "todo");
  } finally {
    await fx.cleanup();
  }
});
