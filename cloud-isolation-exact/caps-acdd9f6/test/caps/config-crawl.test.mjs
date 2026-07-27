/**
 * test/caps/config-crawl.test.mjs
 * Unit and integration tests for the config crawl lane.
 * Validates bounded execution, credential-blind parsing, schema conformance,
 * and robust handling of malformed inputs across all four target families.
 */

import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import os from "node:os";
import { fileURLToPath } from "node:url";

import { CapsStore } from "../../dist/caps/store.js";
import { CrawlTargetsManager, CrawlTargetRejectionError } from "../../dist/caps/crawl-targets.js";
import { CrawlConfigLane, sanitizeArgs, sanitizeUrl, parseCodexToml, compareOrdinal } from "../../dist/caps/crawl-config.js";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const FIXTURES_DIR = path.resolve(__dirname, "../fixtures/caps/config-crawl");
let config;
let store;
let TEMP_STATE_DIR;

test.beforeEach(() => {
  TEMP_STATE_DIR = path.resolve(os.tmpdir(), `caps-crawl-test-${Date.now()}-${Math.random().toString(36).substring(7)}`);
  fs.mkdirSync(TEMP_STATE_DIR, { recursive: true });
  const dbPath = path.join(TEMP_STATE_DIR, "caps.sqlite");
  config = { stateDirectory: TEMP_STATE_DIR, databasePath: dbPath };
  store = new CapsStore(config);
});

test.afterEach(() => {
  try {
    if (store) store.close();
  } finally {
    if (TEMP_STATE_DIR && fs.existsSync(TEMP_STATE_DIR)) {
      try {
        fs.rmSync(TEMP_STATE_DIR, { recursive: true, force: true });
      } catch (e) {}
    }
  }
});

test("Test 1: crawl-targets accepts valid absolute paths", () => {
  const manager = new CrawlTargetsManager(config);
  assert.equal(manager.isValidTarget("C:\\valid\\project"), true);
  assert.equal(manager.isValidTarget("/opt/valid/project"), true);
});

test("Test 2: crawl-targets rejects relative paths", () => {
  const manager = new CrawlTargetsManager(config);
  assert.equal(manager.isValidTarget("./relative/path"), false);
  assert.equal(manager.isValidTarget("relative/path"), false);
});

test("Test 3: crawl-targets rejects repository-escaping paths", () => {
  const manager = new CrawlTargetsManager(config);
  assert.equal(manager.isValidTarget("C:\\valid\\..\\escaped"), false);
  assert.equal(manager.isValidTarget("/opt/valid/../escaped"), false);
});

test("Test 4: crawl-targets rejects Drive-exchange paths", () => {
  const manager = new CrawlTargetsManager(config);
  assert.equal(manager.isValidTarget("C:\\Users\\Bob\\Google Drive\\project"), false);
  assert.equal(manager.isValidTarget("/Users/Alice/My Drive/project"), false);
  assert.equal(manager.isValidTarget("/opt/Bridge Exchange/data"), false);
});

test("Test 5: crawl-targets skips non-existent symlink checks safely", () => {
  const manager = new CrawlTargetsManager(config);
  // An absolute path that does not exist should be "valid" in terms of syntax,
  // the crawler will just skip it when it can't find the file.
  assert.equal(manager.isValidTarget(path.join(TEMP_STATE_DIR, "non-existent-dir")), true);
});

test("Test 5b: crawl-targets rejects target that is a symlink/junction", () => {
  const manager = new CrawlTargetsManager(config);
  const realDir = path.join(TEMP_STATE_DIR, "real-target");
  const linkDir = path.join(TEMP_STATE_DIR, "link-target");

  fs.mkdirSync(realDir, { recursive: true });

  try {
    // Attempt junction on Windows, otherwise dir symlink
    fs.symlinkSync(realDir, linkDir, process.platform === 'win32' ? 'junction' : 'dir');
  } catch (e) {
    // If creation fails, we inject a seam to prove the logic
    fs.mkdirSync(linkDir, { recursive: true });
    const originalLstat = fs.lstatSync;
    try {
      fs.lstatSync = (p, opts) => {
         if (p === linkDir) return { isSymbolicLink: () => true };
         return originalLstat(p, opts);
      };
      assert.equal(manager.isValidTarget(linkDir), false);
    } finally {
      fs.lstatSync = originalLstat;
    }
    return;
  }

  assert.equal(manager.isValidTarget(linkDir), false);
});

test("Test 5c: crawl-targets rejects target where ancestor is a symlink/junction", () => {
  const manager = new CrawlTargetsManager(config);
  const realAncestor = path.join(TEMP_STATE_DIR, "real-ancestor");
  const linkAncestor = path.join(TEMP_STATE_DIR, "link-ancestor");

  fs.mkdirSync(realAncestor, { recursive: true });
  const realTarget = path.join(realAncestor, "target");
  fs.mkdirSync(realTarget, { recursive: true });

  const targetPath = path.join(linkAncestor, "target");

  try {
    fs.symlinkSync(realAncestor, linkAncestor, process.platform === 'win32' ? 'junction' : 'dir');
  } catch (e) {
    fs.mkdirSync(linkAncestor, { recursive: true });
    const originalLstat = fs.lstatSync;
    try {
      fs.lstatSync = (p, opts) => {
         if (p === linkAncestor) return { isSymbolicLink: () => true };
         return originalLstat(p, opts);
      };
      assert.equal(manager.isValidTarget(targetPath), false);
    } finally {
      fs.lstatSync = originalLstat;
    }
    return;
  }

  assert.equal(manager.isValidTarget(targetPath), false);
});

test("Test 6: sanitizeArgs strips inline token flags", () => {
  const input = ["--token=secret123", "--port", "8080"];
  const expected = ["--token=[REDACTED]", "--port", "8080"];
  assert.deepEqual(sanitizeArgs(input), expected);
});

test("Test 7: sanitizeArgs strips standalone credential values", () => {
  const input = ["--api-key", "mysecretkey", "main.py"];
  const expected = ["--api-key", "[REDACTED]", "main.py"];
  assert.deepEqual(sanitizeArgs(input), expected);
});

test("Test 8: sanitizeArgs handles complex credential shapes", () => {
  const input = ["-e", "PASSWORD=supersecret", "start", "--cookie", "session=123"];
  const expected = ["-e", "PASSWORD=[REDACTED]", "start", "--cookie", "[REDACTED]"];
  assert.deepEqual(sanitizeArgs(input), expected);
});

test("Test 9: sanitizeUrl strips credentials and query parameters", () => {
  assert.equal(
    sanitizeUrl("http://user:password@localhost:8080/mcp?foo=bar#hash"),
    "http://localhost:8080/mcp"
  );
  assert.equal(sanitizeUrl(null), null);
  assert.equal(sanitizeUrl("invalid-url"), null);
});

test("Test 10: parseCodexToml parses standard declarations", () => {
  const toml = `
[mcp_servers.test_1]
command = "node"
args = ["app.js"]
enabled = true
`;
  const parsed = parseCodexToml(toml, "test.toml");
  assert.ok(parsed.mcp_servers.test_1);
  assert.equal(parsed.mcp_servers.test_1.command, "node");
  assert.deepEqual(parsed.mcp_servers.test_1.args, ["app.js"]);
  assert.equal(parsed.mcp_servers.test_1.enabled, true);
});

test("Test 11: parseCodexToml ignores unsupported syntax gracefully without failing", () => {
  const toml = `
[mcp_servers.unsupported]
command = "node"
args = { foo = "bar" }
`;
  // The custom parser will see args isn't a string or array and skip it.
  const parsed = parseCodexToml(toml, "test.toml", () => {});
  assert.equal(parsed.mcp_servers.unsupported, undefined);
});

test("Test 12: parseCodexToml ignores complex nested tables", () => {
  const toml = `
[mcp_servers.complex]
command = "python"
[[mcp_servers.complex.env]]
key = "val"
`;
  const parsed = parseCodexToml(toml, "test.toml", () => {});
  assert.equal(parsed.mcp_servers.complex, undefined);
});

test("Test 13: crawl-config handles malformed JSON without crashing", () => {
  const lane = new CrawlConfigLane(config, store);
  const homeDir = path.join(TEMP_STATE_DIR, "malformed-home");
  fs.mkdirSync(homeDir, { recursive: true });
  fs.copyFileSync(
    path.join(FIXTURES_DIR, "malformed.json"),
    path.join(homeDir, ".claude.json")
  );

  // Should not throw
  assert.doesNotThrow(() => lane.executeCrawl(homeDir));
});

test("Test 14: crawl-config extracts and sanitizes from claude.json", () => {
  const lane = new CrawlConfigLane(config, store);
  const homeDir = path.join(TEMP_STATE_DIR, "claude-home");
  fs.mkdirSync(homeDir, { recursive: true });
  fs.copyFileSync(
    path.join(FIXTURES_DIR, "claude.json"),
    path.join(homeDir, ".claude.json")
  );

  lane.executeCrawl(homeDir);

  const brokenRows = store.db.prepare("SELECT * FROM installed_broken WHERE surface_owner = 'claude'").all();
  // Expecting 3 global servers + 2 project servers = 5 rows
  assert.equal(brokenRows.length, 5);

  const server1 = brokenRows.find(r => r.name === 'global-server-1');
  assert.ok(server1);
  assert.equal(server1.failure_reason, 'verification_pending');
  assert.ok(!server1.raw_json.includes('global_secret_key_12345'), 'Secret key leaked in raw_json');
  assert.ok(!server1.raw_json.includes('this_is_a_secret_token_that_should_be_stripped'), 'Env var leaked in raw_json');
});

test("Test 15: crawl-config extracts and sanitizes from codex.toml", () => {
  const lane = new CrawlConfigLane(config, store);
  const homeDir = path.join(TEMP_STATE_DIR, "codex-home");
  const codexDir = path.join(homeDir, ".codex");
  fs.mkdirSync(codexDir, { recursive: true });
  fs.copyFileSync(
    path.join(FIXTURES_DIR, "codex.toml"),
    path.join(codexDir, "config.toml")
  );

  lane.executeCrawl(homeDir);

  const brokenRows = store.db.prepare("SELECT * FROM installed_broken WHERE surface_owner = 'codex'").all();
  assert.equal(brokenRows.length, 5, "Expected exactly 5 codex servers");

  const s1 = brokenRows.find(r => r.name === 'test_server_1');
  assert.ok(s1);
  assert.ok(!s1.raw_json.includes('codex_secret_token_1'), 'Codex secret token leaked');
});

test("Test 16: crawl-config extracts and maps gemini-settings to agy", () => {
  const lane = new CrawlConfigLane(config, store);
  const homeDir = path.join(TEMP_STATE_DIR, "gemini-home");
  const geminiDir = path.join(homeDir, ".gemini");
  fs.mkdirSync(geminiDir, { recursive: true });
  fs.copyFileSync(
    path.join(FIXTURES_DIR, "gemini-settings.json"),
    path.join(geminiDir, "settings.json")
  );

  lane.executeCrawl(homeDir);

  const agyRows = store.db.prepare("SELECT * FROM installed_broken WHERE surface_owner = 'agy'").all();
  assert.equal(agyRows.length, 3, "Expected exactly 3 AGY servers");

  const gemRows = store.db.prepare("SELECT * FROM installed_broken WHERE surface_owner = 'gemini'").all();
  assert.equal(gemRows.length, 0, "Expected exactly 0 legacy gemini servers (D5)");

  for (const row of agyRows) {
    assert.ok(!row.raw_json.includes('agy_secret_pwd_456'), 'AGY password leaked');
  }
});

test("Test 17: crawl-config processes explicit project .mcp.json files", () => {
  const lane = new CrawlConfigLane(config, store);
  const homeDir = path.join(TEMP_STATE_DIR, "project-home");
  fs.mkdirSync(homeDir, { recursive: true });

  const mockProjectDir = path.join(TEMP_STATE_DIR, "mock-project");
  fs.mkdirSync(mockProjectDir, { recursive: true });
  fs.copyFileSync(
    path.join(FIXTURES_DIR, "project-mcp.json"),
    path.join(mockProjectDir, ".mcp.json")
  );

  // Set up the targets manager
  const targetsPath = path.join(TEMP_STATE_DIR, "crawl-targets.json");
  fs.writeFileSync(targetsPath, JSON.stringify({ projects: [mockProjectDir] }), "utf8");

  lane.executeCrawl(homeDir);

  const allProjectRows = store.db.prepare("SELECT * FROM installed_broken WHERE source_lane = 'config-crawl' AND surface_owner = 'n/a'").all();
  const projectRows = allProjectRows.filter(r => {
    const prov = JSON.parse(r.provenance_json);
    return prov.project_scope != null;
  });
  assert.equal(projectRows.length, 2, "Expected exactly 2 project-mcp servers");

  const pgServer = projectRows.find(r => r.name === 'local-postgres');
  assert.ok(pgServer);
  assert.ok(!pgServer.raw_json.includes('secretpassword'), 'Postgres DB password leaked');
  assert.ok(!pgServer.raw_json.includes('supersecretpassword123'), 'Postgres ENV password leaked');
});

test("Test 18: crawl-config idempotency preserves curated_notes and does not duplicate", () => {
  const lane = new CrawlConfigLane(config, store);
  const homeDir = path.join(TEMP_STATE_DIR, "idemp-home");
  fs.mkdirSync(homeDir, { recursive: true });
  fs.copyFileSync(
    path.join(FIXTURES_DIR, "claude.json"),
    path.join(homeDir, ".claude.json")
  );

  lane.executeCrawl(homeDir);

  const rowsBefore = store.db.prepare("SELECT * FROM installed_broken WHERE surface_owner = 'claude'").all();
  const countBefore = rowsBefore.length;
  assert.ok(countBefore > 0);

  const testId = rowsBefore[0].id;
  store.db.prepare("UPDATE installed_broken SET curated_notes = 'test notes' WHERE id = ?").run(testId);

  // Run crawl again
  lane.executeCrawl(homeDir);

  const rowsAfter = store.db.prepare("SELECT * FROM installed_broken WHERE surface_owner = 'claude'").all();
  assert.equal(rowsAfter.length, countBefore, "Idempotency failed: duplicated rows");

  const updatedRow = rowsAfter.find(r => r.id === testId);
  assert.equal(updatedRow.curated_notes, 'test notes', "Idempotency failed: curated_notes overwritten");
});

test("Test 19: All generated raw_json values are free of synthetic secrets", () => {
  // Broad sweep over everything collected in the DB so far
  const allBroken = store.db.prepare("SELECT raw_json FROM installed_broken").all();
  const secrets = [
    'global_secret_key_12345',
    'this_is_a_secret_token_that_should_be_stripped',
    'xyz123',
    'go_hunter2',
    'supersecretpassword',
    'abcd9876',
    'test_api_key_098',
    'secretpassword',
    'sqlite_token_xyz',
    'codex_secret_token_1',
    'codex_api_key_999',
    'agy_secret_pwd_456',
    'legacy_token_111',
    'asdfghjkl',
    'super_secret_ruby_trap_123',
    'session_cookie_secret_val'
  ];

  for (const row of allBroken) {
    for (const secret of secrets) {
      assert.ok(!row.raw_json.includes(secret), `Secret leaked in raw_json: ${secret}`);
    }
  }
});

test("Test 20: Capabilities do not appear in installed_working without explicit census/probe, and default to verification_pending", () => {
  const lane = new CrawlConfigLane(config, store);
  const homeDir = path.join(TEMP_STATE_DIR, "working-home");
  fs.mkdirSync(homeDir, { recursive: true });
  fs.copyFileSync(path.join(FIXTURES_DIR, "claude.json"), path.join(homeDir, ".claude.json"));
  lane.executeCrawl(homeDir);

  const workingRows = store.db.prepare("SELECT * FROM installed_working").all();
  assert.equal(workingRows.length, 0, "No rows should be inserted into installed_working by config-crawl");

  const brokenRows = store.db.prepare("SELECT * FROM installed_broken WHERE source_lane = 'config-crawl'").all();
  assert.ok(brokenRows.length > 0, "Expected to have config-crawl rows");
  for (const row of brokenRows) {
    assert.equal(row.failure_reason, 'verification_pending', 'Must have failure_reason verification_pending');
    assert.equal(row.last_verified, null, 'Must have last_verified as null');
  }
});

test("Test 21: executeCrawl returns structured report with deterministic gaps", () => {
  const lane = new CrawlConfigLane(config, store);
  const homeDir = path.join(TEMP_STATE_DIR, "report-home");
  fs.mkdirSync(homeDir, { recursive: true });

  // Create malformed targets
  const targetsPath = path.join(TEMP_STATE_DIR, "crawl-targets.json");
  fs.writeFileSync(targetsPath, "not valid json");

  // Run crawl
  const report = lane.executeCrawl(homeDir);

  assert.ok(report.started_at);
  assert.ok(report.completed_at);
  assert.equal(typeof report.observation_count, 'number');
  assert.ok(Array.isArray(report.gaps));

  // Missing file gaps
  const claudeMissing = report.gaps.find(g => g.family === 'claude' && g.kind === 'missing');
  assert.ok(claudeMissing, 'Should report missing .claude.json');
  assert.equal(typeof claudeMissing.config_path, 'string');
  assert.equal(typeof claudeMissing.message, 'string');

  // Malformed crawl-targets gap
  const targetsMalformed = report.gaps.find(g => g.family === 'project' && g.kind === 'malformed');
  assert.ok(targetsMalformed, 'Should report malformed crawl-targets.json');
  assert.equal(targetsMalformed.config_path, targetsPath);

  // Deterministic order
  const sortedGaps = [...report.gaps].sort((a, b) => {
       if (a.config_path !== b.config_path) return compareOrdinal(a.config_path, b.config_path);
       if (a.line !== b.line) return (a.line || 0) - (b.line || 0);
       return compareOrdinal(a.message, b.message);
  });
  assert.deepEqual(report.gaps, sortedGaps, 'Gaps must be deterministically ordered');
});

test("Test 22: R3-3 preserve oldest first-seen provenance and curated_notes", () => {
  const lane = new CrawlConfigLane(config, store);
  const homeDir = path.join(TEMP_STATE_DIR, "prov-home");
  fs.mkdirSync(homeDir, { recursive: true });
  fs.copyFileSync(path.join(FIXTURES_DIR, "claude.json"), path.join(homeDir, ".claude.json"));

  lane.executeCrawl(homeDir);

  let rows = store.db.prepare("SELECT * FROM installed_broken WHERE name = 'global-server-1'").all();
  assert.equal(rows.length, 1);
  const firstProv = JSON.parse(rows[0].provenance_json);
  const firstObservedAt = firstProv.first_observed_at;
  assert.ok(firstObservedAt);

  // Set curated_notes manually
  store.db.prepare("UPDATE installed_broken SET curated_notes = 'user note', observed_at = '2000-01-01T00:00:00.000Z' WHERE id = ?").run(rows[0].id);

  // Second crawl
  lane.executeCrawl(homeDir);

  rows = store.db.prepare("SELECT * FROM installed_broken WHERE name = 'global-server-1'").all();
  assert.equal(rows.length, 1);

  const secondProv = JSON.parse(rows[0].provenance_json);
  assert.equal(secondProv.first_observed_at, firstObservedAt); // Byte-for-byte the oldest value
  assert.equal(rows[0].curated_notes, 'user note');
  assert.notEqual(rows[0].observed_at, '2000-01-01T00:00:00.000Z'); // Should advance
});

test("Test 23: R3-4 prevent cross-authority-table duplication", () => {
  const lane = new CrawlConfigLane(config, store);
  const homeDir = path.join(TEMP_STATE_DIR, "dup-home");
  fs.mkdirSync(homeDir, { recursive: true });
  fs.copyFileSync(path.join(FIXTURES_DIR, "claude.json"), path.join(homeDir, ".claude.json"));

  // Crawl to populate broken
  lane.executeCrawl(homeDir);

  let brokenRows = store.db.prepare("SELECT * FROM installed_broken WHERE name = 'global-server-1'").all();
  assert.equal(brokenRows.length, 1);
  const id = brokenRows[0].id;

  // Move to working
  const row = store.db.prepare("SELECT * FROM installed_broken WHERE id = ?").get(id);
  store.db.prepare(`
    INSERT INTO installed_working (
      id, kind, name, slug, source_url, surface_owner, transport, description, pricing, official,
      stars, install_command, source_lane, producer_surface, capture_class, observed_at, last_verified,
      stale_at, provenance_json, raw_json, curated_notes, tools_json, detail_json
    ) VALUES (
      ?, ?, ?, ?, ?, ?, ?, ?, ?, ?,
      ?, ?, ?, ?, ?, ?, ?,
      ?, ?, ?, ?, ?, ?
    )
  `).run(
    row.id, row.kind, row.name, row.slug, row.source_url, row.surface_owner, row.transport, row.description, row.pricing, row.official,
    row.stars, row.install_command, row.source_lane, row.producer_surface, row.capture_class, row.observed_at, '2001-01-01T00:00:00.000Z',
    row.stale_at, row.provenance_json, row.raw_json, row.curated_notes, row.tools_json, row.detail_json
  );
  store.db.prepare("DELETE FROM installed_broken WHERE id = ?").run(id);

  // Set working-specific metadata
  store.db.prepare("UPDATE installed_working SET source_lane = 'probe' WHERE id = ?").run(id);

  // Second crawl
  lane.executeCrawl(homeDir);

  brokenRows = store.db.prepare("SELECT * FROM installed_broken WHERE id = ?").all(id);
  assert.equal(brokenRows.length, 0, 'Should not create a broken duplicate');

  const workingRows = store.db.prepare("SELECT * FROM installed_working WHERE id = ?").all(id);
  assert.equal(workingRows.length, 1, 'Should preserve the row in installed_working');
  assert.equal(workingRows[0].source_lane, 'probe', 'Should preserve probe lane');
  assert.equal(workingRows[0].last_verified, '2001-01-01T00:00:00.000Z', 'Should preserve verification time');
});

test("Test 24: R3-5 D6 redaction matrix", () => {
  // --header, -H, --header=...
  assert.deepEqual(sanitizeArgs(['--header', 'Authorization: Bearer secret', 'next-arg']), ['--header', '[REDACTED]', 'next-arg']);
  assert.deepEqual(sanitizeArgs(['-H', 'Authorization: Bearer secret', 'next-arg']), ['-H', '[REDACTED]', 'next-arg']);
  assert.deepEqual(sanitizeArgs(['--header=Authorization: Bearer secret', 'next-arg']), ['--header=[REDACTED]', 'next-arg']);

  // OAuth/client-secret/access-token/refresh-token
  assert.deepEqual(sanitizeArgs(['--client-secret', '123', 'next']), ['--client-secret', '[REDACTED]', 'next']);
  assert.deepEqual(sanitizeArgs(['--access-token=xyz', 'next']), ['--access-token=[REDACTED]', 'next']);
  assert.deepEqual(sanitizeArgs(['--refresh-token', 'abc', 'next']), ['--refresh-token', '[REDACTED]', 'next']);

  // cookie and credential
  assert.deepEqual(sanitizeArgs(['--cookie', 'session=1', 'next']), ['--cookie', '[REDACTED]', 'next']);
  assert.deepEqual(sanitizeArgs(['--credential=abc', 'next']), ['--credential=[REDACTED]', 'next']);

  // browser --profile-directory, --user-data-dir, and profile path
  assert.deepEqual(sanitizeArgs(['--profile-directory', 'Profile 1', 'next']), ['--profile-directory', '[REDACTED]', 'next']);
  assert.deepEqual(sanitizeArgs(['--user-data-dir=/tmp/foo', 'next']), ['--user-data-dir=[REDACTED]', 'next']);

  // URI userinfo/query/fragment in a positional arg
  assert.deepEqual(sanitizeArgs(['http://user:pass@host/path?q=1#frag', 'next']), ['http://host/path', 'next']);

  // inline equals and following-value forms
  assert.deepEqual(sanitizeArgs(['api_key=123', 'next']), ['api_key=[REDACTED]', 'next']);
});

test("Test 25: R5-9 Real All-Channel Secret Sweep", () => {
  const lane = new CrawlConfigLane(config, store);
  const homeDir = path.join(TEMP_STATE_DIR, "d7-home");
  fs.mkdirSync(homeDir, { recursive: true });
  fs.copyFileSync(path.join(FIXTURES_DIR, "claude.json"), path.join(homeDir, ".claude.json"));
  const codexDir = path.join(homeDir, ".codex");
  fs.mkdirSync(codexDir, { recursive: true });
  fs.copyFileSync(path.join(FIXTURES_DIR, "codex.toml"), path.join(codexDir, "config.toml"));
  const geminiDir = path.join(homeDir, ".gemini");
  fs.mkdirSync(geminiDir, { recursive: true });
  fs.copyFileSync(path.join(FIXTURES_DIR, "gemini-settings.json"), path.join(geminiDir, "settings.json"));
  const mockProjectDir = path.join(TEMP_STATE_DIR, "mock-project");
  fs.mkdirSync(mockProjectDir, { recursive: true });
  fs.copyFileSync(path.join(FIXTURES_DIR, "project-mcp.json"), path.join(mockProjectDir, ".mcp.json"));

  const targetsPath = path.join(TEMP_STATE_DIR, "crawl-targets.json");
  fs.writeFileSync(targetsPath, JSON.stringify({ projects: [mockProjectDir] }), "utf8");

  // Include malformed
  fs.copyFileSync(path.join(FIXTURES_DIR, "malformed.json"), path.join(homeDir, "malformed.json"));

  let warnings = [];
  let errors = [];
  const origWarn = console.warn;
  const origError = console.error;

  console.warn = (...args) => warnings.push(args.join(" "));
  console.error = (...args) => errors.push(args.join(" "));

  let report;
  try {
    report = lane.executeCrawl(homeDir);
  } finally {
    console.warn = origWarn;
    console.error = origError;
  }

  const secrets = [
    'global_secret_key_12345',
    'this_is_a_secret_token_that_should_be_stripped',
    'xyz123',
    'go_hunter2',
    'supersecretpassword',
    'abcd9876',
    'test_api_key_098',
    'secretpassword',
    'sqlite_token_xyz',
    'codex_secret_token_1',
    'codex_api_key_999',
    'agy_secret_pwd_456',
    'legacy_token_111',
    'asdfghjkl',
    'super_secret_ruby_trap_123',
    'session_cookie_secret_val'
  ];
  const allBroken = store.db.prepare("SELECT * FROM installed_broken").all();

  for (const row of allBroken) {
    for (const secret of secrets) {
      assert.ok(!JSON.stringify(row).includes(secret), `Secret leaked in stored row: ${secret}`);
      assert.ok(!row.raw_json.includes(secret), `Secret leaked in raw_json: ${secret}`);
      assert.ok(!row.provenance_json.includes(secret), `Secret leaked in provenance_json: ${secret}`);
    }
  }

  for (const gap of report.gaps) {
    for (const secret of secrets) {
      assert.ok(!JSON.stringify(gap).includes(secret), `Secret leaked in gap: ${secret}`);
    }
  }

  for (const w of warnings) {
    for (const secret of secrets) {
      assert.ok(!w.includes(secret), `Secret leaked in warning: ${secret}`);
    }
  }
  for (const e of errors) {
    for (const secret of secrets) {
      assert.ok(!e.includes(secret), `Secret leaked in error: ${secret}`);
    }
  }
});

test("Test 26: R3-7 D8 stale_at deterministic window", () => {
  const lane = new CrawlConfigLane(config, store);
  const homeDir = path.join(TEMP_STATE_DIR, "d8-home");
  const codexDir = path.join(homeDir, ".codex");
  fs.mkdirSync(codexDir, { recursive: true });
  fs.copyFileSync(path.join(FIXTURES_DIR, "codex.toml"), path.join(codexDir, "config.toml"));

  lane.executeCrawl(homeDir);

  const row = store.db.prepare("SELECT * FROM installed_broken WHERE name = 'test_server_1'").get();
  assert.ok(row, 'Row should exist');

  const observed = new Date(row.observed_at);
  const stale = new Date(row.stale_at);
  const diffHours = (stale.getTime() - observed.getTime()) / (1000 * 60 * 60);

  assert.equal(diffHours, 24, 'stale_at must be exactly 24 hours after observed_at');
});

test("Test 27: R5-4 Replace Cline basename test with Claude", () => {
  const lane = new CrawlConfigLane(config, store);
  const homeDir = path.join(TEMP_STATE_DIR, "d9-home");
  fs.mkdirSync(homeDir, { recursive: true });

  fs.writeFileSync(path.join(homeDir, ".claude.json"), JSON.stringify({
    mcpServers: {
      test1: {
        command: "C:\\Program Files\\nodejs\\node.exe",
        args: ["--version"]
      },
      test2: {
        command: "/usr/local/bin/python",
        args: ["-V"]
      }
    }
  }));

  lane.executeCrawl(homeDir);

  const row1 = store.db.prepare("SELECT * FROM installed_broken WHERE name = 'test1'").get();
  assert.equal(row1.install_command, "node.exe --version");
  assert.ok(!row1.raw_json.includes("Program Files"));

  const row2 = store.db.prepare("SELECT * FROM installed_broken WHERE name = 'test2'").get();
  assert.equal(row2.install_command, "python -V");
  assert.ok(!row2.raw_json.includes("usr/local"));
});

test("Test 28: R3-10 D10 Canonical Gemini container", () => {
  const lane = new CrawlConfigLane(config, store);
  const homeDir = path.join(TEMP_STATE_DIR, "d10-home");
  const geminiDir = path.join(homeDir, ".gemini");
  fs.mkdirSync(geminiDir, { recursive: true });
  fs.copyFileSync(path.join(FIXTURES_DIR, "gemini-settings.json"), path.join(geminiDir, "settings.json"));

  lane.executeCrawl(homeDir);

  // canonical top-level mcpServers
  const canonicalRow = store.db.prepare("SELECT * FROM installed_broken WHERE surface_owner = 'agy' AND name = 'canonical-only-server'").get();
  assert.ok(canonicalRow, "Should pick up canonical-only-server from top-level mcpServers");
  assert.equal(canonicalRow.install_command, "go.exe run . --authorization [REDACTED]");

  // overlap test
  const agyRow = store.db.prepare("SELECT * FROM installed_broken WHERE surface_owner = 'agy' AND name = 'agy-test-server'").get();
  assert.ok(agyRow, "Should pick up agy-test-server");
  // Ensure we picked the top-level mcpServers version which uses 'node', not the nested one which uses 'python'
  assert.ok(agyRow.install_command.startsWith("node"), "Canonical top-level mcpServers must win");
});

test("Test 29: R3-11 D11 Quoted Codex TOML keys", () => {
  const lane = new CrawlConfigLane(config, store);
  const homeDir = path.join(TEMP_STATE_DIR, "d11-home");
  const codexDir = path.join(homeDir, ".codex");
  fs.mkdirSync(codexDir, { recursive: true });
  fs.copyFileSync(path.join(FIXTURES_DIR, "codex.toml"), path.join(codexDir, "config.toml"));

  lane.executeCrawl(homeDir);

  const quotedRow = store.db.prepare("SELECT * FROM installed_broken WHERE surface_owner = 'codex' AND name = 'quoted-name'").get();
  assert.ok(quotedRow, "Should parse quoted-name from codex.toml");
  assert.equal(quotedRow.install_command, "node quoted.js");
});

test("Test 30: R3-12 D12 Preserve safe config metadata", () => {
  const lane = new CrawlConfigLane(config, store);
  const homeDir = path.join(TEMP_STATE_DIR, "d12-home");
  const codexDir = path.join(homeDir, ".codex");
  fs.mkdirSync(codexDir, { recursive: true });
  fs.copyFileSync(path.join(FIXTURES_DIR, "codex.toml"), path.join(codexDir, "config.toml"));

  lane.executeCrawl(homeDir);

  const row = store.db.prepare("SELECT * FROM installed_broken WHERE name = 'test_server_1'").get();

  const rawObj = JSON.parse(row.raw_json);
  assert.ok(rawObj.config_path, "raw_json should include safe config_path");
  assert.ok(rawObj.project_scope === null || rawObj.project_scope === false || typeof rawObj.project_scope === 'string', "raw_json should include safe project_scope");

  const provObj = JSON.parse(row.provenance_json);
  assert.ok(provObj.config_path, "provenance_json should include safe config_path");
});

test("Test 31: R3-13 D13 Deterministic bounded dedupe", () => {
  const lane = new CrawlConfigLane(config, store);
  const homeDir = path.join(TEMP_STATE_DIR, "d13-home");
  fs.mkdirSync(homeDir, { recursive: true });

  const geminiDir = path.join(homeDir, ".gemini");
  fs.mkdirSync(geminiDir, { recursive: true });

  const conf1 = path.join(homeDir, ".claude.json");
  const conf2 = path.join(geminiDir, "settings.json");

  // Create exact duplicate declarations in the same file to test deduplication
  fs.writeFileSync(conf1, JSON.stringify({
    mcpServers: {
      "same-server": { command: "echo", args: ["1"] },
    },
    projects: {
      "proj1": { mcpServers: { "same-server": { command: "echo", args: ["1"] } } }
    }
  }));

  lane.executeCrawl(homeDir);

  const rows = store.db.prepare("SELECT * FROM installed_broken WHERE name = 'same-server'").all();
  // We expect 2 rows: one global, one project
  assert.equal(rows.length, 2, "Should deduplicate identical servers but preserve scopes");
});

test("Test 32: D14 extra TOML trap coverage", () => {
  const lane = new CrawlConfigLane(config, store);
  const homeDir = path.join(TEMP_STATE_DIR, "d14-home");
  const codexDir = path.join(homeDir, ".codex");
  fs.mkdirSync(codexDir, { recursive: true });
  fs.copyFileSync(
    path.join(FIXTURES_DIR, "codex.toml"),
    path.join(codexDir, "config.toml")
  );

  lane.executeCrawl(homeDir);
  const row = store.db.prepare("SELECT * FROM installed_broken WHERE surface_owner = 'codex' AND name = 'quoted-key-trap'").get();
  assert.ok(row, "Should parse quoted-key-trap from codex.toml");
  assert.ok(!row.raw_json.includes('super_secret_ruby_trap_123'), 'Secret leaked in raw_json');
});

test("Test 33: D15 toml parser does not crash on empty input", () => {
  const parsed = parseCodexToml("", "empty.toml", () => {});
  assert.deepEqual(parsed, { mcp_servers: {} });
});

test("Test 34: R5-3 Negative tests for similarly named files outside allowlist", () => {
  const lane = new CrawlConfigLane(config, store);
  const homeDir = path.join(TEMP_STATE_DIR, "neg-home");
  fs.mkdirSync(homeDir, { recursive: true });

  fs.writeFileSync(path.join(homeDir, "gemini-settings.json"), JSON.stringify({ mcpServers: { s1: { command: "a" } } }));
  fs.writeFileSync(path.join(homeDir, "codex.toml"), `[mcp_servers.s2]\ncommand="b"`);

  lane.executeCrawl(homeDir);

  const rows = store.db.prepare("SELECT * FROM installed_broken").all();
  assert.equal(rows.length, 0, "Similarly named files outside allowlist must be ignored");
});

test("Test 35: R5-5 Determinism reversed keys in two isolated stores", () => {
  const lane1 = new CrawlConfigLane(config, store);
  const homeDir1 = path.join(TEMP_STATE_DIR, "det-home1");
  fs.mkdirSync(homeDir1, { recursive: true });
  fs.writeFileSync(path.join(homeDir1, ".claude.json"), JSON.stringify({
    mcpServers: {
      a: { command: "node", args: ["1"] },
      b: { args: ["2"], command: "python" }
    }
  }));

  lane1.executeCrawl(homeDir1);
  const rows1 = store.db.prepare("SELECT * FROM installed_broken ORDER BY name").all();

  // Create isolated store 2
  const dbPath2 = path.join(TEMP_STATE_DIR, "caps2.sqlite");
  const config2 = { stateDirectory: TEMP_STATE_DIR, databasePath: dbPath2 };
  const store2 = new CapsStore(config2);

  const lane2 = new CrawlConfigLane(config2, store2);
  const homeDir2 = path.join(TEMP_STATE_DIR, "det-home2");
  fs.mkdirSync(homeDir2, { recursive: true });
  fs.writeFileSync(path.join(homeDir2, ".claude.json"), JSON.stringify({
    mcpServers: {
      b: { command: "python", args: ["2"] },
      a: { args: ["1"], command: "node" }
    }
  }));

  lane2.executeCrawl(homeDir2);
  const rows2 = store2.db.prepare("SELECT * FROM installed_broken ORDER BY name").all();

  store2.close();

  assert.equal(rows1.length, 2);
  assert.equal(rows2.length, 2);

  // They should be identical IDs and payloads
  assert.equal(rows1[0].id, rows2[0].id);
  assert.equal(rows1[1].id, rows2[1].id);
  const raw1 = JSON.parse(rows1[0].raw_json);
  const raw2 = JSON.parse(rows2[0].raw_json);
  assert.equal(raw1.command, raw2.command);
  assert.deepEqual(raw1.args, raw2.args);
});

test("Test 36: R5-6 TOML unsupported syntax direct tests", () => {
  const toml = `
[mcp_servers.valid]
command = "node"

[mcp_servers.unsupported_syntax]
args = { a = "b" }

[mcp_servers.another_unsupported]
unknown_field = "test"
command = "python"

[mcp_servers.quoted_key]
command = "go"
`;
  let gaps = [];
  const parsed = parseCodexToml(toml, "test.toml", (l, m) => gaps.push(m));

  assert.ok(parsed.mcp_servers.valid);
  assert.equal(parsed.mcp_servers.unsupported_syntax, undefined);
  assert.equal(parsed.mcp_servers.another_unsupported, undefined);
  assert.ok(parsed.mcp_servers.quoted_key);

  assert.equal(gaps.length, 2);
});

test("Test 37: R5-7 Preserve Existing Broken Evidence", () => {
  const lane = new CrawlConfigLane(config, store);
  const homeDir = path.join(TEMP_STATE_DIR, "pres-home");
  fs.mkdirSync(homeDir, { recursive: true });
  fs.writeFileSync(path.join(homeDir, ".claude.json"), JSON.stringify({
    mcpServers: { test: { command: "echo" } }
  }));

  lane.executeCrawl(homeDir);
  const row = store.db.prepare("SELECT * FROM installed_broken WHERE name = 'test'").get();

  // Set probe evidence
  store.db.prepare("UPDATE installed_broken SET source_lane = 'probe', failure_reason = 'tool_timeout', failure_observed_at = '2020-01-01' WHERE id = ?").run(row.id);

  lane.executeCrawl(homeDir);
  const updatedRow = store.db.prepare("SELECT * FROM installed_broken WHERE name = 'test'").get();

  assert.equal(updatedRow.source_lane, 'probe');
  assert.equal(updatedRow.failure_reason, 'tool_timeout');
  assert.equal(updatedRow.failure_observed_at, '2020-01-01');
});

test("Test 38: R5-10 Test state transitions through Package 01 API", () => {
  const lane = new CrawlConfigLane(config, store);
  const homeDir = path.join(TEMP_STATE_DIR, "state-home");
  fs.mkdirSync(homeDir, { recursive: true });
  fs.writeFileSync(path.join(homeDir, ".claude.json"), JSON.stringify({
    mcpServers: { state: { command: "echo" } }
  }));

  lane.executeCrawl(homeDir);
  const row = store.db.prepare("SELECT * FROM installed_broken WHERE name = 'state'").get();

  store.moveBrokenToWorking(row.id, { source_lane: "census", failure_observed_at: new Date().toISOString(), provenance_json: row.provenance_json });

  const w1 = store.db.prepare("SELECT * FROM installed_working WHERE id = ?").get(row.id);
  assert.ok(w1);
  assert.equal(w1.source_lane, 'census');

  lane.executeCrawl(homeDir);

  // Should still be exactly one authority row, and it's in working
  const breaks = store.db.prepare("SELECT * FROM installed_broken WHERE id = ?").all(row.id);
  assert.equal(breaks.length, 0);

  const w2 = store.db.prepare("SELECT * FROM installed_working WHERE id = ?").get(row.id);
  assert.ok(w2);
  assert.equal(w2.source_lane, 'census');
});

test("Test 39: compareOrdinal sorts predictably with punctuation, ASCII case, and non-ASCII", () => {
  const items = [
    "Z_uppercase",
    "a_lowercase",
    "_underscore",
    "ñ_nonascii",
    "A_uppercase"
  ];

  // Ordinal sort by code unit
  const expected = [
    "A_uppercase",
    "Z_uppercase",
    "_underscore",
    "a_lowercase",
    "ñ_nonascii"
  ];

  items.sort(compareOrdinal);
  assert.deepEqual(items, expected, "compareOrdinal must sort by code unit (ordinal), not locale");
});

test("Test 40: Target validation failure logs sanitized warning without leaking secret", () => {
  const manager = new CrawlTargetsManager(config);

  // Mock lstatSync to throw a synthetic secret
  const originalLstat = fs.lstatSync;
  let warnings = [];
  const origWarn = console.warn;
  console.warn = (...args) => warnings.push(args.join(" "));

  try {
    fs.lstatSync = (p, opts) => {
      throw new Error("synthetic_secret_reparse_failure_123");
    };

    // Test the specific isValidTarget branch first
    const isValid = manager.isValidTarget(path.join(TEMP_STATE_DIR, "test-target"));
    assert.equal(isValid, false, "Target should be rejected on stat failure");

    // Also test readTargets which uses the same try/catch path
    fs.writeFileSync(path.join(TEMP_STATE_DIR, "crawl-targets.json"), JSON.stringify({
      projects: [path.join(TEMP_STATE_DIR, "test-target-read")]
    }));
    const validTargets = manager.readTargets();
    assert.equal(validTargets.length, 0, "Targets should be empty on stat failure");

    assert.ok(warnings.length > 0, "Should emit a warning");
    for (const w of warnings) {
      assert.ok(!w.includes("synthetic_secret_reparse_failure_123"), "Warning must not leak the raw exception message");
      assert.ok(!w.includes("test-target"), "Warning must not leak the target path either");
      assert.ok(w.includes("reparse check failed"), "Warning should contain sanitized message");
    }
  } finally {
    fs.lstatSync = originalLstat;
    console.warn = origWarn;
  }
});
