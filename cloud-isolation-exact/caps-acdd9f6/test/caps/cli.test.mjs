import test from "node:test";
import assert from "node:assert";
import { execFile } from "node:child_process";
import { promisify } from "node:util";
import path from "node:path";
import fs from "node:fs";
import os from "node:os";
import { fileURLToPath, pathToFileURL } from "node:url";
import { DatabaseSync } from "node:sqlite";

const exec = promisify(execFile);
const __dirname = path.dirname(fileURLToPath(import.meta.url));
const cliPath = path.resolve(__dirname, "../../dist/cli.js");

function runCli(args, env = {}) {
  return exec(process.execPath, [cliPath, ...args], {
    env: { ...process.env, ...env }
  });
}

function validNeedsProfile(sourcePath) {
  return {
    schema: "bridge-caps-needs-v1",
    profile_id: "test-profile",
    owner_managed: true,
    updated_at: "2026-07-24T00:00:00.000Z",
    provenance: {
      source_path: sourcePath,
      source_section: "bridge:caps:generated",
      source_sha256: "0".repeat(64),
      observed_at: "2026-07-24T00:00:00.000Z",
      capture_class: "guaranteed",
      producer_surface: "code"
    },
    needs: []
  };
}

test("caps cli boundary tests", async (t) => {
  const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), "bridge-caps-test-"));

  // Isolate environment
  const fakeHome = path.join(tempDir, "home");
  const fakeAppdata = path.join(tempDir, "appdata");
  const fakeConfig = path.join(tempDir, "config");
  const fakePath = path.join(tempDir, "bin");

  fs.mkdirSync(fakeHome, { recursive: true });
  fs.mkdirSync(fakeAppdata, { recursive: true });
  fs.mkdirSync(fakeConfig, { recursive: true });
  fs.mkdirSync(fakePath, { recursive: true });

  const env = {
    BRIDGE_CAPS_STATE_DIR: tempDir,
    HOME: fakeHome,
    USERPROFILE: fakeHome,
    APPDATA: fakeAppdata,
    LOCALAPPDATA: fakeAppdata,
    XDG_CONFIG_HOME: fakeConfig,
    PATH: fakePath
  };

  // Setup fake database for search/get tests
  const dbPath = path.join(tempDir, "caps.sqlite");
  const { CapsStore } = await import(pathToFileURL(path.resolve(__dirname, "../../dist/caps/store.js")).href);
  const store = new CapsStore({ databasePath: dbPath, stateDirectory: tempDir });
  store.db.exec(`
    INSERT INTO available_for_install (id, kind, name, slug, surface_owner, transport, pricing, official, source_lane, producer_surface, capture_class, observed_at, last_verified, stale_at, provenance_json)
    VALUES
    ('free-1', 'server', 'Free 1', 'free-1', 'n/a', 'stdio', 'free', 0, 'mcpservers-search', 'external-index', 'reported', '2026', '2026', '2026', '{}'),
    ('paid-1', 'server', 'Paid 1', 'paid-1', 'n/a', 'stdio', 'paid', 0, 'mcpservers-search', 'external-index', 'reported', '2026', '2026', '2026', '{}'),
    ('free-2', 'server', 'Free 2', 'free-2', 'n/a', 'stdio', 'free', 0, 'mcpservers-search', 'external-index', 'reported', '2026', '2026', '2026', '{}'),
    ('unknown-1', 'server', 'Unknown 1', 'unknown-1', 'n/a', 'stdio', 'unknown', 0, 'mcpservers-search', 'external-index', 'reported', '2026', '2026', '2026', '{}');

    INSERT INTO caps_search_fts (rowid, id, name, slug, description, curated_notes, table_name) VALUES
    (1, 'free-1', 'Free 1 matchtoken', 'free-1', '', '', 'available_for_install'),
    (2, 'paid-1', 'Paid 1 matchtoken', 'paid-1', '', '', 'available_for_install'),
    (3, 'free-2', 'Free 2 matchtoken', 'free-2', '', '', 'available_for_install'),
    (4, 'unknown-1', 'Unknown 1 matchtoken', 'unknown-1', '', '', 'available_for_install');
  `);
  store.close();

  // Create preload script for mcpservers.org interception
  const preloadPath = path.join(tempDir, "preload-net.mjs");
  const requestLogPath = path.join(tempDir, "request-log.json");
  const interruptFlagPath = path.join(tempDir, "interrupt-flag");
  fs.writeFileSync(preloadPath, `
import fs from "node:fs";
import path from "node:path";
const originalFetch = globalThis.fetch;

const requestLogPath = ${JSON.stringify(requestLogPath)};
const interruptFlagPath = ${JSON.stringify(interruptFlagPath)};

if (!fs.existsSync(requestLogPath)) {
  fs.writeFileSync(requestLogPath, "[]");
}

const allowedUrls = new Set([
  "https://mcpservers.org/sitemap.xml",
  "https://mcpservers.org/servers/1.xml",
  "https://mcpservers.org/skills.xml",
  "https://mcpservers.org/all",
  "https://mcpservers.org/all?page=1",
  "https://mcpservers.org/all?page=2",
  "https://mcpservers.org/agent-skills",
  "https://mcpservers.org/agent-skills?page=1",
  "https://mcpservers.org/search?page=1&query=official",
  "https://mcpservers.org/search?page=1&query=curated",
  "https://mcpservers.org/servers/test-server",
  "https://mcpservers.org/servers/paid-server",
  "https://mcpservers.org/servers/shared-slug"
]);

globalThis.fetch = async (url, options) => {
  const strUrl = url.toString();
  if (!allowedUrls.has(strUrl)) {
    throw new Error("Network not allowed in test: " + strUrl);
  }

  const logs = JSON.parse(fs.readFileSync(requestLogPath, "utf8"));
  logs.push({ url: strUrl, flagExists: fs.existsSync(interruptFlagPath), flagPath: interruptFlagPath });
  fs.writeFileSync(requestLogPath, JSON.stringify(logs));

  if (fs.existsSync(interruptFlagPath) && (strUrl === "https://mcpservers.org/all" || strUrl === "https://mcpservers.org/all?page=1")) {
     const statePath = path.join(${JSON.stringify(tempDir)}, "mcpservers-backfill-v1.json");
     if (fs.existsSync(statePath)) {
       const cp = JSON.parse(fs.readFileSync(statePath, "utf8"));
       if (cp.schema === "bridge-caps-mcpservers-state-v1") {
         fs.unlinkSync(interruptFlagPath);
         process.exit(2);
       }
     }
  }

  const fix = (name) => {
    const p = path.resolve(${JSON.stringify(__dirname)}, "../../test/fixtures/caps", name);
    if (!fs.existsSync(p)) {
      throw new Error("Missing fixture: " + name);
    }
    return fs.readFileSync(p, "utf8");
  };

  if (strUrl === "https://mcpservers.org/sitemap.xml") {
    return new Response(fix("mcpservers-root-sitemap.xml"), { status: 200, headers: { "Content-Type": "text/xml" } });
  }
  if (strUrl === "https://mcpservers.org/servers/1.xml") {
    return new Response(fix("mcpservers-server-sitemap.xml"), { status: 200, headers: { "Content-Type": "text/xml" } });
  }
  if (strUrl === "https://mcpservers.org/skills.xml") {
    return new Response(fix("mcpservers-skills-sitemap.xml"), { status: 200, headers: { "Content-Type": "text/xml" } });
  }
  if (strUrl === "https://mcpservers.org/all" || strUrl === "https://mcpservers.org/all?page=1") return new Response(fix("mcpservers-listing.html"), { status: 200, headers: { "Content-Type": "text/html" } });
  if (strUrl === "https://mcpservers.org/all?page=2") return new Response('<div data-page-end="true"></div>', { status: 200, headers: { "Content-Type": "text/html" } });
  if (strUrl === "https://mcpservers.org/agent-skills" || strUrl === "https://mcpservers.org/agent-skills?page=1") return new Response('<div data-page-end="true"></div>', { status: 200, headers: { "Content-Type": "text/html" } });
  if (strUrl === "https://mcpservers.org/search?page=1&query=official" || strUrl === "https://mcpservers.org/search?page=1&query=curated") {
    return new Response(fix("mcpservers-search.html"), { status: 200, headers: { "Content-Type": "text/html" } });
  }
  if (strUrl === "https://mcpservers.org/servers/test-server" || strUrl === "https://mcpservers.org/servers/paid-server" || strUrl === "https://mcpservers.org/servers/shared-slug") {
    return new Response(fix("mcpservers-detail.html"), { status: 200, headers: { "Content-Type": "text/html" } });
  }

  throw new Error("Unhandled URL inside allowed set: " + strUrl);
};
`);
  const runEnv = { ...env, NODE_OPTIONS: `--import "${pathToFileURL(preloadPath).href}"` };

  t.after(() => {
    fs.rmSync(tempDir, { recursive: true, force: true });
  });

  await t.test("help command includes caps", async () => {
    const { stdout } = await runCli(["help"], runEnv);
    assert.match(stdout, /caps status/);
    assert.match(stdout, /caps search <query>/);
  });

  await t.test("needsState derived from NEEDS.json", async () => {
    // missing -> not_installed
    const { stdout: out1 } = await runCli(["caps", "status"], runEnv);
    assert.strictEqual(JSON.parse(out1).needsState, "not_installed");

    // valid installed
    const needsPath = path.join(tempDir, "NEEDS.json");
    fs.writeFileSync(needsPath, JSON.stringify(validNeedsProfile(path.join(tempDir, "CATALOG.md"))));
    const { stdout: out2 } = await runCli(["caps", "status"], runEnv);
    assert.strictEqual(JSON.parse(out2).needsState, "installed");

    // malformed (wrong schema)
    fs.writeFileSync(needsPath, JSON.stringify({
       schema: "wrong-schema",
       profile_id: "test-profile",
       owner_managed: true
    }));
    const { stdout: out3 } = await runCli(["caps", "status"], runEnv);
    assert.strictEqual(JSON.parse(out3).needsState, "error");

    // cleanup
    fs.rmSync(needsPath, { force: true });
  });

  await t.test("status outputs valid json with exact fields and no secrets", async () => {
    // Create valid NEEDS.json for test
    const needsPath = path.join(tempDir, "NEEDS.json");
    fs.writeFileSync(needsPath, JSON.stringify(validNeedsProfile(path.join(tempDir, "CATALOG.md"))));
    // Seed receipts sorting opposite times
    const reportDir = path.join(tempDir, "reports");
    fs.mkdirSync(reportDir, { recursive: true });
    // Valid older receipt
    fs.writeFileSync(path.join(reportDir, "refresh-2000.json"), JSON.stringify({
      schema: "bridge-caps-refresh-report-v1", lifecycle_status: "terminal-failure", refresh_run_id: "fail-1",
      start_at: "2026-01-02T00:00:00.000Z", end_at: "2026-01-02T00:00:00.000Z"
    }));
    // valid running fallback to start_at
    fs.writeFileSync(path.join(reportDir, "refresh-2001.json"), JSON.stringify({
      schema: "bridge-caps-refresh-report-v1", lifecycle_status: "running", refresh_run_id: "run-1",
      start_at: "2026-01-04T00:00:00.000Z"
    }));
    // INVALID CASES (should be ignored, making 2001 the winner):
    // wrong schema
    fs.writeFileSync(path.join(reportDir, "refresh-2005.json"), JSON.stringify({
      schema: "wrong-schema", lifecycle_status: "terminal-success", refresh_run_id: "succ-invalid",
      start_at: "2026-01-05T00:00:00.000Z", end_at: "2026-01-05T00:00:00.000Z"
    }));
    // wrong lifecycle
    fs.writeFileSync(path.join(reportDir, "refresh-2006.json"), JSON.stringify({
      schema: "bridge-caps-refresh-report-v1", lifecycle_status: "unknown-status", refresh_run_id: "id",
      start_at: "2026-01-06T00:00:00.000Z", end_at: "2026-01-06T00:00:00.000Z"
    }));
    // malformed start_at
    fs.writeFileSync(path.join(reportDir, "refresh-2007.json"), JSON.stringify({
      schema: "bridge-caps-refresh-report-v1", lifecycle_status: "running", refresh_run_id: "id",
      start_at: "not-an-iso"
    }));
    // malformed present end_at
    fs.writeFileSync(path.join(reportDir, "refresh-2008.json"), JSON.stringify({
      schema: "bridge-caps-refresh-report-v1", lifecycle_status: "running", refresh_run_id: "id",
      start_at: "2026-01-08T00:00:00.000Z", end_at: "not-an-iso"
    }));
    // overlong run ID
    fs.writeFileSync(path.join(reportDir, "refresh-2009.json"), JSON.stringify({
      schema: "bridge-caps-refresh-report-v1", lifecycle_status: "running", refresh_run_id: "a".repeat(257),
      start_at: "2026-01-09T00:00:00.000Z"
    }));
    // empty run ID
    fs.writeFileSync(path.join(reportDir, "refresh-2010.json"), JSON.stringify({
      schema: "bridge-caps-refresh-report-v1", lifecycle_status: "running", refresh_run_id: "",
      start_at: "2026-01-10T00:00:00.000Z"
    }));
    // terminal-without-end
    fs.writeFileSync(path.join(reportDir, "refresh-2011.json"), JSON.stringify({
      schema: "bridge-caps-refresh-report-v1", lifecycle_status: "terminal-success", refresh_run_id: "id",
      start_at: "2026-01-11T00:00:00.000Z"
    }));
    // malformed JSON
    fs.writeFileSync(path.join(reportDir, "refresh-2012.json"), "{ malformed json");

    // Seed census
    const { CapsStore } = await import(pathToFileURL(path.resolve(__dirname, "../../dist/caps/store.js")).href);
    const s1 = new CapsStore({ databasePath: dbPath, stateDirectory: tempDir });

    // Seed sentinel
    s1.db.exec(`INSERT INTO _caps_census_receipts (report_id, canonical_hash, caller_provenance, observed_at, result_summary) VALUES ('test-sentinel', 'hash-s', '{}', '2025-01-01T00:00:00.000Z', '{"sentinel":"CAPS_STATUS_SECRET_SENTINEL_7F4A"}')`);
    s1.close();

    const { stdout: out2 } = await runCli(["caps", "status"], runEnv);
    const res = JSON.parse(out2);
    // Remove isolated census checks from this bulk assertion (handled below)
    assert.strictEqual(res.state, "installed");
    assert.strictEqual(res.needsState, "installed");
    assert.strictEqual(res.searchMode, "fts");
    assert.strictEqual(res.dbPath, dbPath);
    assert.strictEqual(res.integrityState, "ok");
    assert.strictEqual(res.migrationState, "ok");
    assert.deepStrictEqual(Object.keys(res.tableRows).sort(), [
      "_caps_census_receipts", "_caps_idempotency", "_caps_migrations",
      "available_for_install", "installed_broken", "installed_working"
    ].sort());
    assert.strictEqual(res.tableRows.available_for_install, 4);
    assert.strictEqual(typeof res.tableRows._caps_migrations, "number");
    assert.strictEqual(res.pricingTiers.free, 2);
    assert.strictEqual(res.pricingTiers.paid, 1);
    assert.strictEqual(res.pricingTiers.unknown, 1);
    assert.strictEqual(res.ftsMode, true);
    assert.strictEqual(res.projectionState, "not_installed");
    assert.strictEqual(res.pendingJudgment, "not_available");

    // Missing degrade
    fs.rmSync(reportDir, { recursive: true, force: true });
    const { stdout: out3 } = await runCli(["caps", "status"], runEnv);
    assert.strictEqual(JSON.parse(out3).lastRefresh, null);

    const rawOut = out2.toLowerCase();
    assert.ok(!rawOut.includes("secret"), "Must not leak secret");
    assert.ok(!rawOut.includes("credential"), "Must not leak credential");
    assert.ok(!rawOut.includes("insert into"), "Must not emit db dump");
    assert.ok(!rawOut.includes("7f4a"), "Must not emit secret sentinel");
  });

  await t.test("census matrix", async () => {
    const { CapsStore } = await import(pathToFileURL(path.resolve(__dirname, "../../dist/caps/store.js")).href);
    const freshTs = new Date().toISOString();

    // Test: missing => due true/null
    let isoDir = path.join(tempDir, "iso1");
    fs.mkdirSync(isoDir, { recursive: true });
    let s = new CapsStore({ databasePath: path.join(isoDir, "caps.sqlite"), stateDirectory: isoDir });
    s.close();
    let out = await runCli(["caps", "status"], { BRIDGE_CAPS_STATE_DIR: isoDir });
    let res = JSON.parse(out.stdout);
    assert.strictEqual(res.censusDue, true);
    assert.strictEqual(res.lastCensus, null);

    // Test: stale canonical => due true/exact stale lastCensus
    isoDir = path.join(tempDir, "iso2");
    fs.mkdirSync(isoDir, { recursive: true });
    s = new CapsStore({ databasePath: path.join(isoDir, "caps.sqlite"), stateDirectory: isoDir });
    s.db.exec(`INSERT INTO _caps_census_receipts (report_id, canonical_hash, caller_provenance, observed_at, result_summary) VALUES ('id1', 'hash1', '{}', '2025-01-01T00:00:00.000Z', '{}')`);
    s.close();
    out = await runCli(["caps", "status"], { BRIDGE_CAPS_STATE_DIR: isoDir });
    res = JSON.parse(out.stdout);
    assert.strictEqual(res.censusDue, true);
    assert.strictEqual(res.lastCensus, "2025-01-01T00:00:00.000Z");

    // Test: fresh canonical => due false/exact fresh lastCensus
    isoDir = path.join(tempDir, "iso3");
    fs.mkdirSync(isoDir, { recursive: true });
    s = new CapsStore({ databasePath: path.join(isoDir, "caps.sqlite"), stateDirectory: isoDir });
    s.db.exec(`INSERT INTO _caps_census_receipts (report_id, canonical_hash, caller_provenance, observed_at, result_summary) VALUES ('id2', 'hash2', '{}', '${freshTs}', '{}')`);
    s.close();
    out = await runCli(["caps", "status"], { BRIDGE_CAPS_STATE_DIR: isoDir });
    res = JSON.parse(out.stdout);
    assert.strictEqual(res.censusDue, false);
    assert.strictEqual(res.lastCensus, freshTs);

    // Test: malformed-only => due true with no fabricated valid freshness
    isoDir = path.join(tempDir, "iso4");
    fs.mkdirSync(isoDir, { recursive: true });
    s = new CapsStore({ databasePath: path.join(isoDir, "caps.sqlite"), stateDirectory: isoDir });
    s.db.exec(`INSERT INTO _caps_census_receipts (report_id, canonical_hash, caller_provenance, observed_at, result_summary) VALUES ('id3', 'hash3', '{}', 'not-a-date', '{}')`);
    s.close();
    out = await runCli(["caps", "status"], { BRIDGE_CAPS_STATE_DIR: isoDir });
    res = JSON.parse(out.stdout);
    assert.strictEqual(res.censusDue, true);
    assert.strictEqual(res.lastCensus, null);

    // Test: future-only => due true and a truthful bounded representation
    isoDir = path.join(tempDir, "iso5");
    fs.mkdirSync(isoDir, { recursive: true });
    s = new CapsStore({ databasePath: path.join(isoDir, "caps.sqlite"), stateDirectory: isoDir });
    s.db.exec(`INSERT INTO _caps_census_receipts (report_id, canonical_hash, caller_provenance, observed_at, result_summary) VALUES ('id4', 'hash4', '{}', '2099-01-01T00:00:00.000Z', '{}')`);
    s.close();
    out = await runCli(["caps", "status"], { BRIDGE_CAPS_STATE_DIR: isoDir });
    res = JSON.parse(out.stdout);
    assert.strictEqual(res.censusDue, true);
    assert.strictEqual(res.lastCensus, "2099-01-01T00:00:00.000Z");
  });

  await t.test("search handles valid query and outputs json", async () => {
    const { stdout } = await runCli(["caps", "search", "something"], runEnv);
    const res = JSON.parse(stdout);
    assert.ok(Array.isArray(res));
  });

  await t.test("search paid-last order (if db exists)", async () => {
    const { stdout } = await runCli(["caps", "search", "matchtoken"], runEnv);
    const res = JSON.parse(stdout);
    assert.ok(Array.isArray(res) && res.length > 0, "Must return results");
    let foundPaid = false;
    let hasFree = false;
    let hasUnknown = false;
    let hasPaid = false;
    for (const hit of res) {
      if (hit.pricing === "free") hasFree = true;
      if (hit.pricing === "unknown") hasUnknown = true;
      if (hit.pricing === "paid") hasPaid = true;
      if (hit.pricing === "paid") foundPaid = true;
      if (foundPaid) {
        assert.ok(hit.pricing !== "free" && hit.pricing !== "unknown", "Free/unknown tier found after paid tier");
      }
    }
    assert.ok(hasFree, "Must return free item");
    assert.ok(hasUnknown, "Must return unknown item");
    assert.ok(hasPaid, "Must return paid item");
  });

  await t.test("get outputs json or not found", async () => {
    try {
      const { stdout } = await runCli(["caps", "get", "missing-id"], runEnv);
      JSON.parse(stdout);
    } catch (e) {
      assert.match(e.stderr, /not found/);
    }
  });

  for (const lane of ["config", "probe", "mcpservers", "all"]) {
    await t.test(`refresh --lane ${lane}`, async () => {
      const { stdout } = await runCli(["caps", "refresh", "--lane", lane], runEnv);
      const jsonStart = stdout.indexOf('{');
      const parsed = JSON.parse(jsonStart >= 0 ? stdout.slice(jsonStart) : stdout);
      const lifecycle = parsed.lifecycle_status;
      assert.strictEqual(lifecycle, "terminal-success");
      assert.ok(parsed.end_at);
      assert.ok(parsed.lane_outcomes);

      const expectedKeys = ["config", "probe", "mcpservers"].sort();
      const actualKeys = Object.keys(parsed.lane_outcomes).sort();

      if (lane !== "all") {
        assert.deepStrictEqual(actualKeys, [lane]);
        assert.ok(parsed.lane_outcomes[lane]);
      } else {
        assert.deepStrictEqual(actualKeys, ["config", "mcpservers", "probe"]);
      }

      if (lane === "config" || lane === "all") {
        const cfg = parsed.lane_outcomes.config;
        assert.ok(cfg.started_at && cfg.completed_at);
        assert.strictEqual(typeof cfg.observation_count, "number");
        assert.ok(Array.isArray(cfg.gaps));
      }
      if (lane === "probe" || lane === "all") {
        const prb = parsed.lane_outcomes.probe;
        assert.strictEqual(prb.success, true);
        assert.ok(Number.isFinite(prb.count));
        assert.strictEqual(typeof prb.truncated, "boolean");
        assert.ok(Array.isArray(prb.outcomes));
        assert.strictEqual(prb.outcomes.length, prb.count);
        for (const out of prb.outcomes) assert.strictEqual(out.success, true);
      }
      if (lane === "mcpservers" || lane === "all") {
        const mcp = parsed.lane_outcomes.mcpservers;
        assert.strictEqual(mcp.schema, "bridge-caps-mcpservers-refresh-v1");
        assert.ok(mcp.finished_at);
        assert.ok(Array.isArray(mcp.errors));
        assert.ok(Array.isArray(mcp.gaps));
        assert.ok(Array.isArray(mcp.fetch_log));
        if (mcp.errors.length !== 0) console.log(mcp.errors); assert.strictEqual(mcp.errors.length, 0);
        assert.ok(mcp.processed >= 0);
        assert.ok(mcp.pending >= 0);
      }
    });
  }

  await t.test("refresh rejected lane", async () => {
    try {
      await runCli(["caps", "refresh", "--lane", "invalid"], runEnv);
      assert.fail("Should have failed");
    } catch (e) {
      assert.strictEqual(e.code, 1);
      assert.match(e.stderr, /usage: bridge caps refresh/);
    }
  });

  await t.test("held lock returns exit 0 (already_running)", async () => {
    const validLock = { nonce: "test-nonce", pid: process.pid, hostname: "remote-host", start_time: new Date().toISOString() };
    const lockBytes = JSON.stringify(validLock);
    const lockPath = path.join(tempDir, "refresh.lock");
    fs.writeFileSync(lockPath, lockBytes);

    const { stdout } = await runCli(["caps", "refresh", "--lane", "all"], runEnv);
    const res = JSON.parse(stdout);
    assert.strictEqual(res.schema, "bridge-caps-refresh-report-v1");
    assert.strictEqual(res.lifecycle_status, "already_running");
    assert.strictEqual(res.held_lock.nonce, "test-nonce");
    assert.strictEqual(res.held_lock.pid, process.pid);
    assert.strictEqual(res.held_lock.hostname, "remote-host");
    assert.strictEqual(res.held_lock.start_time, validLock.start_time);

    // Assert exact lock bytes unchanged
    const afterBytes = fs.readFileSync(lockPath, "utf8");
    assert.strictEqual(afterBytes, lockBytes);

    // Test malformed lock (extra fields)
    const malformed1 = { ...validLock, extra: "field" };
    fs.writeFileSync(lockPath, JSON.stringify(malformed1));
    const { stdout: outM1 } = await runCli(["caps", "refresh", "--lane", "all"], runEnv);
    assert.deepStrictEqual(JSON.parse(outM1).held_lock, { error: "malformed" });
    assert.strictEqual(fs.readFileSync(lockPath, "utf8"), JSON.stringify(malformed1));

    // Test malformed lock (invalid ISO)
    const malformed2 = { ...validLock, start_time: "not-an-iso", hostname: os.hostname() };
    fs.writeFileSync(lockPath, JSON.stringify(malformed2));
    const { stdout: outM2 } = await runCli(["caps", "refresh", "--lane", "all"], runEnv);
    assert.deepStrictEqual(JSON.parse(outM2).held_lock, { error: "malformed" });
    assert.strictEqual(fs.readFileSync(lockPath, "utf8"), JSON.stringify(malformed2));
  });

  await t.test("nonzero-error stability for invalid subcommand", async () => {
    try {
      await runCli(["caps", "invalid_command"], runEnv);
      assert.fail("Should have failed");
    } catch (e) {
      assert.strictEqual(e.code, 1);
      assert.match(e.stderr, /unknown caps subcommand: invalid_command/);
    }
  });

  await t.test("backfill fixture-backed", async () => {
    const { stdout } = await runCli(["caps", "backfill"], runEnv);
    const parsed = JSON.parse(stdout);
    assert.strictEqual(parsed.schema, "bridge-caps-mcpservers-refresh-v1");
  });

  await t.test("backfill deterministic interruption and resume", async () => {
    const statePath = path.join(tempDir, "mcpservers-backfill-v1.json");
    fs.rmSync(statePath, { force: true });
    fs.rmSync(dbPath, { force: true });
    fs.writeFileSync(path.join(tempDir, "interrupt-flag"), "1");
    fs.writeFileSync(requestLogPath, "[]");

    try {
      await runCli(["caps", "backfill"], runEnv);
      assert.fail("Should have been interrupted");
    } catch (e) {
      assert.strictEqual(e.code, 2, "Process must exit with code 2 on interruption");
    }

    assert.ok(fs.existsSync(statePath), "Checkpoint file must exist after interruption");

    const cp = JSON.parse(fs.readFileSync(statePath, "utf8"));
    assert.strictEqual(cp.schema, "bridge-caps-mcpservers-state-v1");
    assert.ok(typeof cp.universe_hash === 'string' && cp.universe_hash.length > 0);
    assert.ok(typeof cp.entries === "object" && !Array.isArray(cp.entries) && cp.entries !== null);
    assert.ok(Object.keys(cp.entries).length <= 25000);
    assert.ok(Array.isArray(cp.pending) && cp.pending.length > 0);
    assert.ok(["server", "skill", "done"].includes(cp.phase));
    assert.ok(Number.isInteger(cp.server_page) && cp.server_page >= 1);
    assert.ok(Number.isInteger(cp.skill_page) && cp.skill_page >= 1);
    assert.strictEqual(new Date(cp.updated_at).toISOString(), cp.updated_at);

    const cpStr = fs.readFileSync(statePath, "utf8");
    const { createHash } = await import("node:crypto");
    const cpHash = createHash("sha256").update(cpStr).digest("hex");

    const logsBefore = JSON.parse(fs.readFileSync(requestLogPath, "utf8"));
    assert.ok(logsBefore.length > 0);

    const { stdout } = await runCli(["caps", "backfill", "--resume"], runEnv);
    const jsonStart = stdout.indexOf('{');
    const parsed = JSON.parse(jsonStart >= 0 ? stdout.slice(jsonStart) : stdout);

    assert.strictEqual(parsed.schema, "bridge-caps-mcpservers-refresh-v1");
    assert.strictEqual(new Date(parsed.finished_at).toISOString(), parsed.finished_at);
    assert.ok(Number.isInteger(parsed.pending) && parsed.pending >= 0);
    assert.ok(Number.isInteger(parsed.processed) && parsed.processed >= 0);
    assert.ok(Number.isInteger(parsed.skipped_installed) && parsed.skipped_installed >= 0);
    assert.ok(Array.isArray(parsed.gaps));
    assert.ok(Array.isArray(parsed.errors));
    assert.strictEqual(parsed.errors.length, 0);
    assert.ok(Array.isArray(parsed.fetch_log));
    assert.ok(parsed.processed + parsed.skipped_installed + parsed.pending >= 0);

    const cpAfterStr = fs.readFileSync(statePath, "utf8");
    const cpAfterHash = createHash("sha256").update(cpAfterStr).digest("hex");
    assert.notStrictEqual(cpAfterHash, cpHash);

    const cpAfter = JSON.parse(cpAfterStr);
    assert.strictEqual(cpAfter.universe_hash, cp.universe_hash);
    assert.deepStrictEqual(cpAfter.entries, cp.entries);
    assert.ok(cpAfter.pending.length <= cp.pending.length);
    if (cp.phase === "server") assert.ok(["server", "skill", "done"].includes(cpAfter.phase));
    if (cp.phase === cpAfter.phase) {
      if (cp.phase === "server") assert.ok(cpAfter.server_page >= cp.server_page);
      if (cp.phase === "skill") assert.ok(cpAfter.skill_page >= cp.skill_page);
    }

    const logsAfter = JSON.parse(fs.readFileSync(requestLogPath, "utf8"));
    assert.ok(logsAfter.length > logsBefore.length);
    for (let i = 0; i < logsBefore.length; i++) {
      assert.deepStrictEqual(logsAfter[i], logsBefore[i]);
    }
  });

  await t.test("Network logs pure", () => {
    if (fs.existsSync(requestLogPath)) {
      const logs = JSON.parse(fs.readFileSync(requestLogPath, "utf8"));
      assert.ok(logs.length > 0, "Log must be nonempty");
      const allowedUrls = new Set([
        "https://mcpservers.org/sitemap.xml",
        "https://mcpservers.org/servers/1.xml",
        "https://mcpservers.org/skills.xml",
        "https://mcpservers.org/all",
        "https://mcpservers.org/all?page=1",
        "https://mcpservers.org/all?page=2",
        "https://mcpservers.org/agent-skills",
        "https://mcpservers.org/agent-skills?page=1",
        "https://mcpservers.org/search?page=1&query=official",
        "https://mcpservers.org/search?page=1&query=curated",
        "https://mcpservers.org/servers/test-server",
        "https://mcpservers.org/servers/paid-server",
        "https://mcpservers.org/servers/shared-slug"
      ]);
      for (const log of logs) {
        const url = typeof log === 'string' ? log : log.url;
        assert.ok(allowedUrls.has(url), "Unexpected network request: " + url);
      }
    }
  });

  await t.test("stdout purity JSON check", async () => {
    const { stdout } = await runCli(["caps", "status"], runEnv);
    const parsed = JSON.parse(stdout);
    assert.ok(parsed);
  });
});
