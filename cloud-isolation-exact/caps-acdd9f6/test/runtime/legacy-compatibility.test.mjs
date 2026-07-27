import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { DatabaseSync } from "node:sqlite";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StdioClientTransport } from "@modelcontextprotocol/sdk/client/stdio.js";
import { LegacyBridgeFacade } from "../../dist/v2/compat/legacy-core.js";
import { resolveLane } from "../../dist/v2/compat/lanes.js";

function fixture(label) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), `bridge2-legacy-${label}-`));
  const stateRoot = path.join(root, "state-root");
  const project = path.join(root, "Legacy Project");
  fs.mkdirSync(path.join(project, "src"), { recursive: true });
  fs.writeFileSync(path.join(project, "src", "index.ts"), "export const value = 1;\n");
  const clock = { value: new Date("2026-07-13T20:00:00.000Z") };
  const create = (lane, sessionId = `${lane}:session`) => new LegacyBridgeFacade({
    stateRoot,
    recoveryRoot: path.join(root, "recovery"),
    config: { agent: lane, host: "legacy-test-host", sessionId, bridgeHome: stateRoot, project },
    lane: () => ({ lane, warning: null, ambiguous: false }),
    now: () => new Date(clock.value),
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
        // Windows can keep a just-closed SQLite/WAL or child-process handle alive
        // briefly after the close event. Retry only this disposable fixture tree.
        await new Promise((resolve) => setTimeout(resolve, 250));
      }
    }
  };
  return { root, stateRoot, project, clock, create, cleanup };
}

test("legacy compatibility keeps Codex, Claude Code, and Claude Cowork distinct in SQLite", async () => {
  const fx = fixture("lanes");
  const codex = fx.create("codex");
  const code = fx.create("claude_desktop_code");
  const cowork = fx.create("claude_desktop_cowork");
  try {
    const first = await codex.sync(fx.project);
    assert.equal(first.firstSync, true);
    assert.equal(first.you.agent, "codex");
    await code.sync(fx.project);
    await cowork.sync(fx.project);

    assert.equal((await codex.claim({ project: fx.project, paths: ["src"], ttlMinutes: 10 })).ok, true);
    const allocatorState = () => {
      const probe = new DatabaseSync(path.join(fx.stateRoot, "projects", "legacy-project", "state", "bridge2.sqlite"), { readOnly: true });
      try {
        return {
          nextToken: probe.prepare("SELECT next_fencing_token FROM projects").get().next_fencing_token,
          claimGroups: probe.prepare("SELECT COUNT(DISTINCT claim_group_id) AS count FROM legacy_file_leases").get().count,
          leases: probe.prepare("SELECT COUNT(*) AS count FROM legacy_file_leases").get().count,
        };
      } finally {
        probe.close();
      }
    };
    const allocationAfterFirstClaim = allocatorState();
    assert.equal((await codex.claim({ project: fx.project, paths: ["src"], ttlMinutes: 10 })).ok, true);
    assert.deepEqual(allocatorState(), allocationAfterFirstClaim, "a no-op repeat claim must not consume an unrepresented fencing token");
    const codeConflict = await code.claim({ project: fx.project, paths: ["src/api"], ttlMinutes: 10 });
    assert.equal(codeConflict.ok, false);
    assert.equal(codeConflict.conflicts[0].heldBy, "codex");

    assert.equal((await cowork.claim({ project: fx.project, paths: ["docs"], ttlMinutes: 10 })).ok, true);
    const codeCoworkConflict = await code.claim({ project: fx.project, paths: ["docs/review"], ttlMinutes: 10 });
    assert.equal(codeCoworkConflict.ok, false, "Code and Cowork must not collapse into one Claude lease owner");
    assert.equal(codeCoworkConflict.conflicts[0].heldBy, "claude_desktop_cowork");

    const handoff = await codex.handoff({ project: fx.project, to: "cowork", note: "synthetic handoff" });
    assert.equal(handoff.control, "claude_desktop_cowork");
    const task = await code.taskAdd({ project: fx.project, title: "Synthetic compatibility task", owner: "code" });
    assert.equal(task.ok, true);
    assert.equal((await code.taskUpdate({ project: fx.project, id: task.id, status: "doing", owner: "cowork" })).task.owner, "claude_desktop_cowork");
    assert.equal((await codex.log({ project: fx.project, summary: "Synthetic compatibility log", files: ["src/index.ts"] })).ok, true);

    const codeSync = await code.sync(fx.project);
    assert.ok(codeSync.changedByOther.some((entry) => entry.agent === "codex" && entry.action === "log"));
    assert.ok(codeSync.othersLeases.some((lease) => lease.agent === "codex"));
    assert.ok(codeSync.othersLeases.some((lease) => lease.agent === "claude_desktop_cowork"));

    fx.clock.value = new Date(fx.clock.value.getTime() + 11 * 60_000);
    const expirySync = await code.sync(fx.project);
    assert.deepEqual(expirySync.othersLeases, []);

    assert.equal((await codex.release({ project: fx.project })).remaining.length, 0);
    assert.equal((await cowork.release({ project: fx.project, paths: ["docs"] })).remaining.length, 0);
    const handle = codex.open(fx.project);
    const generationCheck = handle.runtime.doctor.run({ projectId: handle.projectId, hostId: handle.actor.hostId })
      .checks.find((check) => check.checkId === "check.generation.active");
    assert.equal(generationCheck.status, "pass", generationCheck.detail);
    assert.match(generationCheck.detail, /2 compatibility claim group\(s\)/u);
    const listed = await code.listProjects();
    assert.equal(listed.projects.length, 1);
    assert.equal((await code.backup({ project: fx.project })).ok, false);
    assert.equal((await code.restore({ project: fx.project })).ok, false);

    const databasePath = path.join(fx.stateRoot, "projects", "legacy-project", "state", "bridge2.sqlite");
    const auditPath = path.join(fx.stateRoot, "projects", "legacy-project", "audit", "events.jsonl");
    const database = new DatabaseSync(databasePath, { readOnly: true });
    try {
      const principals = database.prepare("SELECT principal_id FROM principals WHERE principal_id LIKE 'principal.compat.%' ORDER BY principal_id").all();
      assert.deepEqual(principals.map((row) => row.principal_id), [
        "principal.compat.claude_desktop_code",
        "principal.compat.claude_desktop_cowork",
        "principal.compat.codex",
      ]);
      const eventCount = database.prepare("SELECT COUNT(*) AS count FROM events WHERE event_type = 'collaboration.command_recorded'").get().count;
      const mirrorCount = database.prepare("SELECT COUNT(*) AS count FROM audit_mirror_entries WHERE file_appended = 1").get().count;
      assert.equal(eventCount, mirrorCount);
      assert.ok(eventCount >= 12);
      const fenced = database.prepare("SELECT MIN(generation) AS generation, MIN(fencing_token) AS token FROM legacy_file_leases").get();
      assert.equal(fenced.generation, 1);
      assert.ok(fenced.token >= 1);
      assert.equal(database.prepare("SELECT MAX(version) AS version FROM schema_migrations").get().version, 3);
      assert.equal(fs.readFileSync(auditPath, "utf8").trim().split("\n").length, eventCount);
      const events = database.prepare(
        "SELECT envelope_json FROM events WHERE event_type = 'collaboration.command_recorded' ORDER BY sequence",
      ).all().map((row) => JSON.parse(row.envelope_json));
      const syncWithExpiry = events.find((event) => event.data.operation === "bridge_sync" && event.data.outcome.expiredLeases === 2);
      assert.ok(syncWithExpiry, "lease expiration must be recorded in the complete command outcome");
      const syncWithChanges = events.find((event) => event.data.operation === "bridge_sync"
        && event.data.agent === "claude_desktop_code"
        && event.data.outcome.changedActivities?.some((entry) => entry.action === "log"));
      assert.ok(syncWithChanges, "sync audit must retain the complete observed activity envelope");
      const taskAdded = events.find((event) => event.data.operation === "bridge_task_add");
      assert.deepEqual({
        title: taskAdded.data.outcome.taskTitle,
        status: taskAdded.data.outcome.taskStatus,
        owner: taskAdded.data.outcome.taskOwner,
      }, {
        title: "Synthetic compatibility task",
        status: "todo",
        owner: "claude_desktop_code",
      });
      const taskUpdated = events.find((event) => event.data.operation === "bridge_task_update" && event.data.outcome.ok);
      assert.equal(taskUpdated.data.outcome.taskOwner, "claude_desktop_cowork");
      assert.ok(events.some((event) => event.data.operation === "bridge_backup" && event.data.outcome.ok === false));
      assert.ok(events.some((event) => event.data.operation === "bridge_restore" && event.data.outcome.ok === false));
    } finally {
      database.close();
    }
  } finally {
    codex.close();
    code.close();
    cowork.close();
    await fx.cleanup();
  }
});

test("ambiguous generic Claude clients fail closed when claiming files", async () => {
  const fx = fixture("ambiguous-lane");
  const ambiguous = new LegacyBridgeFacade({
    stateRoot: fx.stateRoot,
    recoveryRoot: path.join(fx.root, "recovery"),
    config: { agent: "claude", host: "legacy-test-host", sessionId: "ambiguous:session", bridgeHome: fx.stateRoot, project: fx.project },
    lane: () => resolveLane({ configuredAgent: "claude", clientName: "claude-desktop" }),
    now: () => new Date(fx.clock.value),
  });
  try {
    const sync = await ambiguous.sync(fx.project);
    assert.equal(sync.you.agent, "claude_desktop_code");
    assert.match(sync.laneWarning, /Set BRIDGE_LANE/u);
    const claim = await ambiguous.claim({ project: fx.project, paths: ["src"] });
    assert.equal(claim.ok, false);
    assert.match(claim.message, /Set BRIDGE_LANE/u);
    const database = new DatabaseSync(path.join(fx.stateRoot, "projects", "legacy-project", "state", "bridge2.sqlite"), { readOnly: true });
    try {
      const row = database.prepare(
        "SELECT envelope_json FROM events WHERE event_type = 'collaboration.command_recorded' ORDER BY sequence DESC LIMIT 1",
      ).get();
      const event = JSON.parse(row.envelope_json);
      assert.equal(event.data.operation, "bridge_claim");
      assert.equal(event.data.outcome.ok, false);
      assert.equal(database.prepare("SELECT COUNT(*) AS count FROM legacy_file_leases").get().count, 0);
    } finally {
      database.close();
    }
  } finally {
    ambiguous.close();
    await fx.cleanup();
  }
});

test("same-basename projects receive immutable collision-safe state bindings", async () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "bridge2-legacy-collision-"));
  const stateRoot = path.join(root, "state-root");
  const projectA = path.join(root, "parent-a", "Shared Name");
  const projectB = path.join(root, "parent-b", "Shared Name");
  fs.mkdirSync(projectA, { recursive: true });
  fs.mkdirSync(projectB, { recursive: true });
  const create = (project, sessionId) => new LegacyBridgeFacade({
    stateRoot,
    recoveryRoot: path.join(root, "recovery"),
    config: { agent: "codex", host: "collision-test-host", sessionId, bridgeHome: stateRoot, project },
    lane: () => ({ lane: "codex", warning: null, ambiguous: false }),
    now: () => new Date("2026-07-13T20:00:00.000Z"),
  });
  const facadeA = create(projectA, "collision:a");
  const facadeB = create(projectB, "collision:b");
  try {
    await facadeA.sync(projectA);
    await facadeB.sync(projectB);
    assert.equal((await facadeA.claim({ project: projectA, paths: ["src"] })).ok, true);
    assert.equal((await facadeB.claim({ project: projectB, paths: ["src"] })).ok, true);
    const directories = fs.readdirSync(path.join(stateRoot, "projects"), { withFileTypes: true })
      .filter((entry) => entry.isDirectory())
      .map((entry) => entry.name)
      .sort();
    assert.equal(directories.length, 2);
    assert.ok(directories.includes("shared-name"));
    assert.ok(directories.some((entry) => /^shared-name-[a-f0-9]{10}$/u.test(entry)));
    const manifests = directories.map((directory) => JSON.parse(fs.readFileSync(
      path.join(stateRoot, "projects", directory, "config", "project.json"),
      "utf8",
    )));
    assert.deepEqual(new Set(manifests.map((manifest) => manifest.path)), new Set([projectA, projectB]));
  } finally {
    facadeA.close();
    facadeB.close();
    fs.rmSync(root, { recursive: true, force: true });
  }
});

test("real and junction project paths share one lease space", async () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "bridge2-legacy-alias-"));
  const stateRoot = path.join(root, "state-root");
  const project = path.join(root, "real-project");
  const alias = path.join(root, "junction-alias");
  fs.mkdirSync(path.join(project, "src"), { recursive: true });
  fs.symlinkSync(project, alias, process.platform === "win32" ? "junction" : "dir");
  const create = (projectPath, lane, sessionId) => new LegacyBridgeFacade({
    stateRoot,
    recoveryRoot: path.join(root, "recovery"),
    config: { agent: lane, host: "alias-test-host", sessionId, bridgeHome: stateRoot, project: projectPath },
    lane: () => ({ lane, warning: null, ambiguous: false }),
    now: () => new Date("2026-07-13T20:00:00.000Z"),
  });
  const codex = create(project, "codex", "alias:codex");
  const cowork = create(alias, "claude_desktop_cowork", "alias:cowork");
  try {
    await codex.sync(project);
    await cowork.sync(alias);
    assert.equal((await codex.claim({ project, paths: ["src"] })).ok, true);
    const denied = await cowork.claim({ project: alias, paths: ["src/child"] });
    assert.equal(denied.ok, false);
    assert.equal(denied.conflicts[0].heldBy, "codex");
    const directories = fs.readdirSync(path.join(stateRoot, "projects"), { withFileTypes: true })
      .filter((entry) => entry.isDirectory());
    assert.equal(directories.length, 1);
  } finally {
    codex.close();
    cowork.close();
    fs.rmSync(root, { recursive: true, force: true });
  }
});

test("legacy claims remain atomic across competing WAL writer processes", async () => {
  const fx = fixture("race");
  const bootstrap = fx.create("codex", "bootstrap:session");
  try { await bootstrap.sync(fx.project); }
  finally { bootstrap.close(); }

  const start = path.join(fx.root, "start");
  const workers = ["claude_desktop_code", "claude_desktop_cowork"].map((lane, index) => {
    const ready = path.join(fx.root, `ready-${index}`);
    const result = path.join(fx.root, `result-${index}.json`);
    const child = spawn(process.execPath, [
      path.resolve("test/runtime/legacy-claim-worker.mjs"),
      fx.stateRoot,
      fx.project,
      lane,
      `${lane}:race:${index}`,
      ready,
      start,
      result,
    ], { cwd: process.cwd(), stdio: ["ignore", "pipe", "pipe"] });
    return { child, ready, result };
  });
  try {
    await waitFor(() => workers.every((worker) => fs.existsSync(worker.ready)), 10_000);
    fs.writeFileSync(start, "go\n");
    await Promise.all(workers.map((worker) => childExit(worker.child)));
    const results = workers.map((worker) => JSON.parse(fs.readFileSync(worker.result, "utf8")));
    assert.equal(results.filter((result) => result.ok).length, 1);
    assert.equal(results.filter((result) => !result.ok).length, 1);
    assert.equal(results.find((result) => !result.ok).conflicts.length, 1);
  } finally {
    for (const worker of workers) if (worker.child.exitCode === null) worker.child.kill();
    await fx.cleanup();
  }
});

test("legacy registry import preserves control, sessions, and tasks without importing live leases", async () => {
  const fx = fixture("import");
  const connector = path.join(fx.project, ".connector");
  fs.mkdirSync(connector, { recursive: true });
  fs.writeFileSync(path.join(connector, "state.json"), JSON.stringify({
    control: "claude",
    leases: [],
    tasks: [{ id: "t1-synthetic", title: "Synthetic imported task", status: "todo", owner: "cowork", ts: fx.clock.value.getTime() }],
    session: {
      boss: "code",
      bossSetBy: "user",
      startedAt: fx.clock.value.getTime() - 60_000,
      lastActivity: fx.clock.value.getTime(),
      status: "active",
    },
  }));
  const registryPath = path.join(fx.root, "registry.json");
  fs.writeFileSync(registryPath, JSON.stringify({
    projects: { synthetic: { name: "Imported Synthetic", path: fx.project } },
  }));
  const facade = fx.create("codex", "import:session");
  try {
    const imported = await facade.importLegacyRegistry(registryPath);
    assert.equal(imported.ok, true);
    assert.equal(imported.projects, 1);
    assert.equal(imported.imported[0].imported, true);
    assert.equal((await facade.importLegacyRegistry(registryPath)).imported[0].imported, false);
    const sync = await facade.sync(fx.project);
    assert.equal(sync.control, "claude_desktop_code");
    assert.equal(sync.session.boss, "claude_desktop_code");
    assert.equal(sync.openTasks[0].owner, "claude_desktop_cowork");
    assert.equal(sync.registered, true);

    assert.equal((await facade.handoff({ project: fx.project, to: "cowork", note: "Synthetic post-import control" })).control, "claude_desktop_cowork");
    const changedState = JSON.parse(fs.readFileSync(path.join(connector, "state.json"), "utf8"));
    changedState.control = "codex";
    fs.writeFileSync(path.join(connector, "state.json"), JSON.stringify(changedState));
    const reimported = await facade.importLegacyRegistry(registryPath);
    assert.equal(reimported.imported[0].imported, true);
    assert.equal((await facade.sync(fx.project)).control, "claude_desktop_cowork");
    const database = new DatabaseSync(path.join(fx.stateRoot, "projects", "legacy-project", "state", "bridge2.sqlite"), { readOnly: true });
    try {
      const imports = database.prepare(
        "SELECT envelope_json FROM events WHERE event_type = 'collaboration.command_recorded' ORDER BY sequence",
      ).all().map((row) => JSON.parse(row.envelope_json)).filter((event) => event.data.operation === "legacy_import");
      assert.equal(imports.length, 2);
      assert.equal(imports[1].data.outcome.controlImported, false);
    } finally {
      database.close();
    }
  } finally {
    facade.close();
    await fx.cleanup();
  }
});

test("default dist/server.js is a drop-in legacy MCP surface backed by Bridge 2.0", async () => {
  const fx = fixture("stdio");
  let codexClient;
  let codeClient;
  try {
    ({ client: codexClient } = await mcpClient(fx, "codex", "codex"));
    const tools = await codexClient.listTools();
    for (const name of ["bridge_sync", "bridge_claim", "bridge_release", "bridge_log", "bridge_handoff"]) {
      assert.ok(tools.tools.some((tool) => tool.name === name));
    }
    const sync = payload(await codexClient.callTool({ name: "bridge_sync", arguments: { project: fx.project } }));
    assert.equal(sync.you.agent, "codex");
    assert.equal(payload(await codexClient.callTool({ name: "bridge_claim", arguments: { project: fx.project, paths: ["src"] } })).ok, true);

    ({ client: codeClient } = await mcpClient(fx, "claude", "claude_desktop_code"));
    const denied = payload(await codeClient.callTool({ name: "bridge_claim", arguments: { project: fx.project, paths: ["src/child"] } }));
    assert.equal(denied.ok, false);
    assert.equal(denied.conflicts[0].heldBy, "codex");
    assert.equal(payload(await codexClient.callTool({ name: "bridge_release", arguments: { project: fx.project } })).ok, true);
  } finally {
    try { await codeClient?.close(); } catch {}
    try { await codexClient?.close(); } catch {}
    await fx.cleanup();
  }
});

async function mcpClient(fx, agent, lane) {
  const transport = new StdioClientTransport({
    command: process.execPath,
    args: [path.resolve("dist/server.js")],
    env: {
      ...process.env,
      BRIDGE_AGENT: agent,
      BRIDGE_LANE: lane,
      BRIDGE_PROJECT: fx.project,
      BRIDGE2_HOME: fx.stateRoot,
      BRIDGE2_RECOVERY_ROOT: path.join(fx.root, "recovery"),
    },
    stderr: "pipe",
  });
  const client = new Client({ name: `legacy-${lane}-test`, version: "0.1.2" });
  await client.connect(transport);
  return { client, transport };
}

function payload(result) {
  return JSON.parse(result.content[0].text);
}

function childExit(child) {
  return new Promise((resolve, reject) => {
    let stderr = "";
    child.stderr.on("data", (chunk) => { stderr += chunk.toString(); });
    child.once("error", reject);
    // `exit` can precede closure of the child's piped stdio handles. Waiting for
    // `close` prevents Windows from racing temp-tree cleanup against those handles.
    child.once("close", (code) => code === 0 ? resolve() : reject(new Error(`worker exited ${code}: ${stderr}`)));
  });
}

async function waitFor(predicate, timeoutMs) {
  const start = Date.now();
  while (!predicate()) {
    if (Date.now() - start > timeoutMs) throw new Error("timed out waiting for worker readiness");
    await new Promise((resolve) => setTimeout(resolve, 20));
  }
}
