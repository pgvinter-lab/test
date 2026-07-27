import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';
import { fileURLToPath, pathToFileURL } from 'node:url';

const testDirectory = path.dirname(fileURLToPath(import.meta.url));
const repositoryRoot = path.resolve(testDirectory, '..', '..');
const fixturePath = path.join(
  repositoryRoot,
  'test',
  'fixtures',
  'caps',
  'stdio-probe-server.mjs',
);

const { CapsStore } = await import(pathToFileURL(
  path.join(repositoryRoot, 'dist', 'caps', 'store.js'),
).href);
const {
  probeLocalStdio,
} = await import(pathToFileURL(
  path.join(repositoryRoot, 'dist', 'caps', 'stdio-probe.js'),
).href);
const {
  DEFAULT_OWNER_PROBE_POLICY,
  PROBE_POLICY,
  createOwnerProbePolicy,
  getProbeTimeouts,
  getSafeEnvironment,
  redactDiagnostic,
  requireOwnerProbePolicy,
  resolveExecutable,
  resolveProbeCommand,
  validateArguments,
} = await import(pathToFileURL(
  path.join(repositoryRoot, 'dist', 'caps', 'probe-policy.js'),
).href);

const nodeBasename = path.basename(process.execPath);

function makeHarness(t, label) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), `bridge-caps-p03-${label}-`));
  const stateDirectory = path.join(root, 'state');
  fs.mkdirSync(stateDirectory, { recursive: true });
  const store = new CapsStore({
    stateDirectory,
    databasePath: path.join(stateDirectory, 'caps.sqlite'),
  });
  t.after(() => {
    store.close();
    fs.rmSync(root, { recursive: true, force: true });
  });
  return {
    root,
    store,
    telemetry: path.join(root, 'fixture-telemetry.json'),
  };
}

function rawDeclaration(args, extra = {}) {
  return JSON.stringify({
    command: extra.command ?? nodeBasename,
    args,
    config_path: extra.configPath ?? 'C:\\fixture\\.mcp.json',
    project_scope: null,
    ...(extra.declaredEnvironment === undefined
      ? {}
      : { env: extra.declaredEnvironment }),
  });
}

function createCapability(store, table, id, args, extra = {}) {
  const observedAt = new Date(Date.now() - 5_000).toISOString();
  const provenance = {
    config_path: 'C:\\fixture\\.mcp.json',
    ...(extra.censusApproved ? { stdio_probe_approved: true } : {}),
    ...(extra.provenance ?? {}),
  };
  store.upsertCapability(table, {
    id,
    kind: 'server',
    name: `Fixture ${id}`,
    slug: `fixture-${id}`,
    source_url: null,
    surface_owner: 'claude',
    transport: extra.transport ?? 'stdio',
    description: 'Package 03 synthetic capability',
    pricing: extra.pricing ?? 'unknown',
    official: 0,
    stars: null,
    install_command: `${nodeBasename} ${args.join(' ')}`,
    source_lane: extra.sourceLane ?? 'config-crawl',
    producer_surface: extra.producerSurface ?? 'code',
    capture_class: extra.captureClass ?? 'guaranteed',
    observed_at: observedAt,
    last_verified: extra.lastVerified ?? observedAt,
    stale_at: new Date(Date.now() + 86_400_000).toISOString(),
    provenance_json: JSON.stringify(provenance),
    raw_json: Object.hasOwn(extra, 'rawJson')
      ? extra.rawJson
      : rawDeclaration(args, extra),
    curated_notes: extra.curatedNotes ?? null,
    tools_json: extra.toolsJson ?? null,
    detail_json: null,
    ...(table === 'installed_broken'
      ? {
          failure_reason: extra.failureReason ?? 'prior_failure',
          failure_observed_at: extra.failureObservedAt ?? observedAt,
        }
      : {}),
  });
}

function createFixtureCapability(harness, table, id, mode, extra = {}) {
  createCapability(
    harness.store,
    table,
    id,
    [fixturePath, mode, harness.telemetry],
    extra,
  );
}

function row(store, table, id) {
  return store.db.prepare(`SELECT * FROM ${table} WHERE id = ?`).get(id);
}

function readTelemetry(file) {
  return JSON.parse(fs.readFileSync(file, 'utf8'));
}

function pidIsAlive(pid) {
  if (!Number.isInteger(pid) || pid <= 0) {
    return false;
  }
  try {
    process.kill(pid, 0);
    return true;
  } catch {
    return false;
  }
}

async function waitForPidExit(pid, timeoutMs = 3_000) {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    if (!pidIsAlive(pid)) {
      return true;
    }
    await new Promise((resolve) => setTimeout(resolve, 25));
  }
  return !pidIsAlive(pid);
}

const quickPolicy = () => createOwnerProbePolicy({
  initializeMs: 750,
  toolsListMs: 750,
  totalMs: 3_000,
});

test('01 defaults are the package-specified 10s, 10s, and 25s', () => {
  assert.deepEqual(DEFAULT_OWNER_PROBE_POLICY.timeouts, {
    initializeMs: 10_000,
    toolsListMs: 10_000,
    totalMs: 25_000,
  });
});

test('02 owner timeout values are clamped to hard minimums and maximums', () => {
  assert.deepEqual(getProbeTimeouts({
    initializeMs: -1,
    toolsListMs: Number.MAX_SAFE_INTEGER,
    totalMs: Number.POSITIVE_INFINITY,
  }), {
    initializeMs: PROBE_POLICY.MIN_PHASE_MS,
    toolsListMs: PROBE_POLICY.MAX_PHASE_MS,
    totalMs: PROBE_POLICY.DEFAULT_TOTAL_MS,
  });
});

test('03 a plain caller object cannot impersonate owner probe policy', async (t) => {
  const harness = makeHarness(t, 'untrusted-policy');
  createFixtureCapability(harness, 'available_for_install', 'untrusted-policy', 'success');
  await assert.rejects(
    probeLocalStdio(
      harness.store,
      'untrusted-policy',
      { timeouts: { initializeMs: 1, toolsListMs: 1, totalMs: 1 } },
    ),
    /probe_policy_untrusted_override/,
  );
  assert(row(harness.store, 'available_for_install', 'untrusted-policy'));
});

test('04 policies created by the owner factory carry an unforgeable runtime brand', () => {
  const policy = createOwnerProbePolicy({ initializeMs: 123 });
  assert.equal(requireOwnerProbePolicy(policy), policy);
  assert.throws(
    () => requireOwnerProbePolicy({ ...policy }),
    /probe_policy_untrusted_override/,
  );
});

test('05 child environment contains only the explicit runtime allowlist', () => {
  const environment = getSafeEnvironment();
  const allowed = new Set([
    'PATH',
    'SystemRoot',
    'SystemDrive',
    'TEMP',
    'TMP',
    'USERPROFILE',
  ]);
  for (const key of Object.keys(environment)) {
    assert(allowed.has(key), `unexpected child environment key: ${key}`);
  }
  assert(environment.PATH);
});

test('06 ambient secret variables are never copied into the child environment', (t) => {
  const original = process.env.P03_TEST_API_KEY;
  process.env.P03_TEST_API_KEY = 'sk-ambient-secret-value-123456';
  t.after(() => {
    if (original === undefined) {
      delete process.env.P03_TEST_API_KEY;
    } else {
      process.env.P03_TEST_API_KEY = original;
    }
  });
  const environment = getSafeEnvironment();
  assert.equal(environment.P03_TEST_API_KEY, undefined);
  assert(!Object.values(environment).includes('sk-ambient-secret-value-123456'));
});

test('07 declared secret environment is rejected rather than forwarded', () => {
  assert.throws(
    () => getSafeEnvironment({ OPENAI_API_KEY: 'sk-declared-secret' }),
    /probe_policy_secret_env_rejected/,
  );
});

test('08 even non-secret declared environment is rejected for credential-blind probing', () => {
  assert.throws(
    () => getSafeEnvironment({ FIXTURE_MODE: 'enabled' }),
    /probe_policy_declared_env_rejected/,
  );
});

test('09 PATH is absolute-only and contains no empty current-directory entry', () => {
  const pathValue = getSafeEnvironment().PATH;
  assert(pathValue);
  const entries = pathValue.split(path.delimiter);
  assert(entries.length > 0);
  assert(entries.every((entry) => entry.length > 0 && path.isAbsolute(entry)));
});

test('10 child home and temp point to isolated probe directories, not the real profile', () => {
  const environment = getSafeEnvironment();
  assert.notEqual(
    path.resolve(environment.USERPROFILE).toLowerCase(),
    path.resolve(process.env.USERPROFILE ?? os.homedir()).toLowerCase(),
  );
  assert(environment.USERPROFILE.startsWith(PROBE_POLICY.WORKING_DIRECTORY));
  assert(environment.TEMP.startsWith(PROBE_POLICY.WORKING_DIRECTORY));
  assert.equal(environment.TEMP, environment.TMP);
});

test('11 executable basenames resolve to an existing file through safe PATH', () => {
  const resolved = resolveExecutable(nodeBasename);
  assert(fs.statSync(resolved).isFile());
  assert.equal(
    fs.realpathSync(resolved).toLowerCase(),
    fs.realpathSync(process.execPath).toLowerCase(),
  );
});

test('12 executable shell metacharacters and redaction placeholders are rejected', () => {
  assert.throws(
    () => resolveExecutable(`${nodeBasename};whoami`),
    /probe_policy_shell_metacharacters_rejected/,
  );
  assert.throws(
    () => resolveExecutable('[REDACTED]'),
    /probe_policy_redacted_command_rejected/,
  );
});

test('13 relative executable paths are rejected', () => {
  assert.throws(
    () => resolveExecutable(`.${path.sep}${nodeBasename}`),
    /probe_policy_relative_path_rejected/,
  );
  assert.throws(
    () => resolveExecutable(`..${path.sep}${nodeBasename}`),
    /probe_policy_relative_path_rejected/,
  );
});

test('14 absolute executable outside safe PATH roots is rejected', (t) => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'bridge-p03-unapproved-'));
  const fakeExecutable = path.join(root, process.platform === 'win32' ? 'fake.exe' : 'fake');
  fs.writeFileSync(fakeExecutable, 'not executable', 'utf8');
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  assert.throws(
    () => resolveExecutable(fakeExecutable),
    /probe_policy_unapproved_absolute_path/,
  );
});

test('14b Windows npx shim resolves to node plus npx-cli without a shell', () => {
  if (process.platform !== 'win32') {
    return;
  }
  const resolved = resolveProbeCommand('npx', ['--version']);
  assert.equal(
    fs.realpathSync(resolved.executable).toLowerCase(),
    fs.realpathSync(process.execPath).toLowerCase(),
  );
  assert.match(resolved.args[0].replaceAll('\\', '/'), /\/npm\/bin\/npx-cli\.js$/i);
  assert.deepEqual(resolved.args.slice(1), ['--version']);
  assert(!resolved.args[0].toLowerCase().endsWith('.cmd'));
  assert(!resolved.args[0].toLowerCase().endsWith('.ps1'));
});

test('15 argument validation returns a defensive copy of safe argv', () => {
  const source = ['--flag=value', fixturePath];
  const validated = validateArguments(source);
  assert.deepEqual(validated, source);
  assert.notEqual(validated, source);
});

test('16 argument validation rejects non-arrays, non-strings, and too many entries', () => {
  assert.throws(() => validateArguments('not-an-array'), /invalid_arguments/);
  assert.throws(() => validateArguments(['ok', 3]), /invalid_arguments/);
  assert.throws(
    () => validateArguments(Array(PROBE_POLICY.MAX_ARGUMENT_COUNT + 1).fill('x')),
    /invalid_arguments/,
  );
});

test('16b argument validation rejects metacharacters and redaction placeholders', () => {
  assert.throws(
    () => validateArguments(['--flag', 'one|two']),
    /argument_metacharacters_rejected/,
  );
  assert.throws(
    () => validateArguments(['--token', '[REDACTED]']),
    /redacted_argument_rejected/,
  );
});

test('17 arbitrary commands cannot be supplied because unknown identity never spawns', async (t) => {
  const harness = makeHarness(t, 'unknown-id');
  const outcome = await probeLocalStdio(harness.store, 'not-in-store', quickPolicy());
  assert.equal(outcome.code, 'capability_not_found');
  assert.equal(outcome.status, 'broken');
  assert.equal(fs.existsSync(harness.telemetry), false);
});

test('18 non-stdio record is classified broken without spawning', async (t) => {
  const harness = makeHarness(t, 'non-stdio');
  createFixtureCapability(
    harness,
    'available_for_install',
    'non-stdio',
    'success',
    { transport: 'http' },
  );
  const outcome = await probeLocalStdio(harness.store, 'non-stdio', quickPolicy());
  assert.equal(outcome.code, 'invalid_transport');
  assert(row(harness.store, 'installed_broken', 'non-stdio'));
  assert.equal(fs.existsSync(harness.telemetry), false);
});

test('19 non-code or non-guaranteed capture is not executable evidence', async (t) => {
  const harness = makeHarness(t, 'capture-class');
  createFixtureCapability(
    harness,
    'available_for_install',
    'capture-class',
    'success',
    { producerSurface: 'external-index', captureClass: 'reported' },
  );
  const outcome = await probeLocalStdio(harness.store, 'capture-class', quickPolicy());
  assert.equal(outcome.code, 'invalid_source_capture');
  assert(row(harness.store, 'installed_broken', 'capture-class'));
});

test('20 unapproved source lane is classified broken and never repairs by inference', async (t) => {
  const harness = makeHarness(t, 'source-lane');
  createFixtureCapability(
    harness,
    'installed_broken',
    'source-lane',
    'success',
    { sourceLane: 'mcpservers-search' },
  );
  const outcome = await probeLocalStdio(harness.store, 'source-lane', quickPolicy());
  assert.equal(outcome.code, 'invalid_source_lane');
  const repeated = await probeLocalStdio(harness.store, 'source-lane', quickPolicy());
  assert.equal(repeated.code, 'invalid_source_lane');
  assert(row(harness.store, 'installed_broken', 'source-lane'));
  assert.equal(row(harness.store, 'installed_working', 'source-lane'), undefined);
  assert.equal(fs.existsSync(harness.telemetry), false);
});

test('21 malformed raw_json is classified broken before spawn', async (t) => {
  const harness = makeHarness(t, 'bad-raw-json');
  createCapability(
    harness.store,
    'available_for_install',
    'bad-raw-json',
    [],
    { rawJson: null },
  );
  const outcome = await probeLocalStdio(harness.store, 'bad-raw-json', quickPolicy());
  assert.equal(outcome.code, 'invalid_raw_json');
  assert(row(harness.store, 'installed_broken', 'bad-raw-json'));
});

test('22 redacted config argv is refused rather than executed', async (t) => {
  const harness = makeHarness(t, 'redacted-argv');
  createCapability(
    harness.store,
    'available_for_install',
    'redacted-argv',
    [fixturePath, 'success', '[REDACTED]'],
  );
  const outcome = await probeLocalStdio(harness.store, 'redacted-argv', quickPolicy());
  assert.equal(outcome.code, 'probe_policy_redacted_argument_rejected');
  assert.equal(fs.existsSync(harness.telemetry), false);
});

test('23 declared env in a stored config cannot smuggle a credential', async (t) => {
  const harness = makeHarness(t, 'declared-env');
  createCapability(
    harness.store,
    'available_for_install',
    'declared-env',
    [fixturePath, 'success', harness.telemetry],
    { declaredEnvironment: { GITHUB_TOKEN: 'ghp_fixture_secret_123456' } },
  );
  const outcome = await probeLocalStdio(harness.store, 'declared-env', quickPolicy());
  assert.equal(outcome.code, 'probe_policy_secret_env_rejected');
  assert.equal(fs.existsSync(harness.telemetry), false);
});

test('24 success captures server identity, protocol version, and real tool schemas', async (t) => {
  const harness = makeHarness(t, 'success-capture');
  createFixtureCapability(harness, 'available_for_install', 'success-capture', 'success');
  const outcome = await probeLocalStdio(harness.store, 'success-capture', quickPolicy());
  assert.equal(outcome.code, 'ok');
  assert.equal(outcome.toolCount, 2);
  const working = row(harness.store, 'installed_working', 'success-capture');
  assert(working);
  const tools = JSON.parse(working.tools_json);
  assert.deepEqual(tools.map((tool) => tool.name), ['fixture_echo', 'fixture_status']);
  assert.equal(tools[0].inputSchema.type, 'object');
  const provenance = JSON.parse(working.provenance_json);
  assert.equal(provenance.probe.protocol_version, '2024-11-05');
  assert.equal(provenance.probe.server_info.name, 'synthetic-stdio-fixture');
  assert.equal(provenance.probe.outcome, 'working');
});

test('25 exact method order is initialize, initialized notification, tools/list', async (t) => {
  const harness = makeHarness(t, 'method-order');
  createFixtureCapability(harness, 'available_for_install', 'method-order', 'success');
  await probeLocalStdio(harness.store, 'method-order', quickPolicy());
  const telemetry = readTelemetry(harness.telemetry);
  assert.deepEqual(telemetry.methods, [
    'initialize',
    'notifications/initialized',
    'tools/list',
  ]);
  assert.equal(telemetry.receivedToolCall, false);
  assert(!telemetry.methods.includes('tools/call'));
  assert(!telemetry.methods.some((method) => method.startsWith('prompts/')));
  assert(!telemetry.methods.some((method) => method.startsWith('resources/')));
});

test('26 fixture proves ambient secret names were absent from actual child env', async (t) => {
  const original = process.env.P03_AMBIENT_TOKEN;
  process.env.P03_AMBIENT_TOKEN = 'ambient-secret-not-for-child';
  t.after(() => {
    if (original === undefined) {
      delete process.env.P03_AMBIENT_TOKEN;
    } else {
      process.env.P03_AMBIENT_TOKEN = original;
    }
  });
  const harness = makeHarness(t, 'actual-env');
  createFixtureCapability(harness, 'available_for_install', 'actual-env', 'success');
  await probeLocalStdio(harness.store, 'actual-env', quickPolicy());
  const telemetry = readTelemetry(harness.telemetry);
  assert(!telemetry.envKeys.includes('P03_AMBIENT_TOKEN'));
  assert(!telemetry.envKeys.some((key) =>
    /token|secret|password|api_?key|credential/i.test(key)));
  assert(telemetry.runtimePaths.USERPROFILE.startsWith(PROBE_POLICY.WORKING_DIRECTORY));
  assert(telemetry.runtimePaths.TEMP.startsWith(PROBE_POLICY.WORKING_DIRECTORY));
  assert.equal(telemetry.runtimePaths.TEMP, telemetry.runtimePaths.TMP);
});

test('27 schema credential defaults are redacted while the schema shape is retained', async (t) => {
  const harness = makeHarness(t, 'schema-redaction');
  createFixtureCapability(harness, 'available_for_install', 'schema-redaction', 'success');
  await probeLocalStdio(harness.store, 'schema-redaction', quickPolicy());
  const tools = JSON.parse(
    row(harness.store, 'installed_working', 'schema-redaction').tools_json,
  );
  assert.equal(
    tools[0].inputSchema.properties.apiKey.default,
    '[REDACTED]',
  );
  assert.equal(tools[0].inputSchema.properties.apiKey.type, 'string');
});

test('28 malformed JSON-RPC is a stable broken classification', async (t) => {
  const harness = makeHarness(t, 'malformed');
  createFixtureCapability(harness, 'available_for_install', 'malformed', 'malformed_protocol');
  const outcome = await probeLocalStdio(harness.store, 'malformed', quickPolicy());
  assert.equal(outcome.code, 'malformed_protocol');
  assert.match(row(harness.store, 'installed_broken', 'malformed').failure_reason, /^malformed_protocol/);
});

test('29 initialize JSON-RPC error is classified without exposing raw error state', async (t) => {
  const harness = makeHarness(t, 'init-error');
  createFixtureCapability(harness, 'available_for_install', 'init-error', 'explicit_error');
  const outcome = await probeLocalStdio(harness.store, 'init-error', quickPolicy());
  assert.equal(outcome.code, 'initialize_protocol_error');
  assert.match(
    row(harness.store, 'installed_broken', 'init-error').failure_reason,
    /^initialize_protocol_error/,
  );
});

test('30 tools/list JSON-RPC error is classified independently', async (t) => {
  const harness = makeHarness(t, 'tools-error');
  createFixtureCapability(
    harness,
    'available_for_install',
    'tools-error',
    'explicit_error_tools',
  );
  const outcome = await probeLocalStdio(harness.store, 'tools-error', quickPolicy());
  assert.equal(outcome.code, 'tools_list_protocol_error');
});

test('31 early process exit is classified and persisted', async (t) => {
  const harness = makeHarness(t, 'early-exit');
  createFixtureCapability(harness, 'available_for_install', 'early-exit', 'early_exit');
  const outcome = await probeLocalStdio(harness.store, 'early-exit', quickPolicy());
  assert.equal(outcome.code, 'early_exit');
  assert(row(harness.store, 'installed_broken', 'early-exit'));
});

test('32 initialize timeout uses a stable phase-specific reason', async (t) => {
  const harness = makeHarness(t, 'init-timeout');
  createFixtureCapability(
    harness,
    'available_for_install',
    'init-timeout',
    'hang_initialize',
  );
  const outcome = await probeLocalStdio(
    harness.store,
    'init-timeout',
    createOwnerProbePolicy({ initializeMs: 100, toolsListMs: 500, totalMs: 1_000 }),
  );
  assert.equal(outcome.code, 'initialize_timeout');
});

test('33 tools/list timeout uses a stable phase-specific reason', async (t) => {
  const harness = makeHarness(t, 'tools-timeout');
  createFixtureCapability(
    harness,
    'available_for_install',
    'tools-timeout',
    'hang_tools',
  );
  const outcome = await probeLocalStdio(
    harness.store,
    'tools-timeout',
    createOwnerProbePolicy({ initializeMs: 500, toolsListMs: 100, totalMs: 1_000 }),
  );
  assert.equal(outcome.code, 'tools_list_timeout');
});

test('34 absolute total deadline wins over a longer phase deadline', async (t) => {
  const harness = makeHarness(t, 'total-timeout');
  createFixtureCapability(
    harness,
    'available_for_install',
    'total-timeout',
    'total_timeout',
  );
  const outcome = await probeLocalStdio(
    harness.store,
    'total-timeout',
    createOwnerProbePolicy({ initializeMs: 500, toolsListMs: 1_000, totalMs: 250 }),
  );
  assert.equal(outcome.code, 'total_timeout');
});

test('35 aggregate stdout overflow aborts before unbounded buffering', async (t) => {
  const harness = makeHarness(t, 'stdout-overflow');
  createFixtureCapability(
    harness,
    'available_for_install',
    'stdout-overflow',
    'oversized_output',
  );
  const outcome = await probeLocalStdio(harness.store, 'stdout-overflow', quickPolicy());
  assert.equal(outcome.code, 'stdout_overflow');
});

test('36 stderr overflow is bounded and classified', async (t) => {
  const harness = makeHarness(t, 'stderr-overflow');
  createFixtureCapability(
    harness,
    'available_for_install',
    'stderr-overflow',
    'stderr_overflow',
  );
  const outcome = await probeLocalStdio(harness.store, 'stderr-overflow', quickPolicy());
  assert.equal(outcome.code, 'stderr_overflow');
});

test('37 a single oversized input schema is refused', async (t) => {
  const harness = makeHarness(t, 'schema-overflow');
  createFixtureCapability(
    harness,
    'available_for_install',
    'schema-overflow',
    'oversized_schema',
  );
  const outcome = await probeLocalStdio(harness.store, 'schema-overflow', quickPolicy());
  assert.equal(outcome.code, 'schema_overflow');
});

test('38 aggregate schema bytes are bounded across many individually valid tools', async (t) => {
  const harness = makeHarness(t, 'total-schema-overflow');
  createFixtureCapability(
    harness,
    'available_for_install',
    'total-schema-overflow',
    'total_schema_overflow',
  );
  const outcome = await probeLocalStdio(
    harness.store,
    'total-schema-overflow',
    quickPolicy(),
  );
  assert.equal(outcome.code, 'total_schema_overflow');
});

test('39 oversized tool descriptions are classified rather than truncated silently', async (t) => {
  const harness = makeHarness(t, 'description-overflow');
  createFixtureCapability(
    harness,
    'available_for_install',
    'description-overflow',
    'description_overflow',
  );
  const outcome = await probeLocalStdio(
    harness.store,
    'description-overflow',
    quickPolicy(),
  );
  assert.equal(outcome.code, 'tool_description_overflow');
});

test('39b deeply nested schemas hit an explicit sanitizer depth bound', async (t) => {
  const harness = makeHarness(t, 'schema-depth');
  createFixtureCapability(
    harness,
    'available_for_install',
    'schema-depth',
    'deep_schema',
  );
  const outcome = await probeLocalStdio(harness.store, 'schema-depth', quickPolicy());
  assert.equal(outcome.code, 'schema_depth_overflow');
});

test('40 secret-like stderr is redacted before entering failure evidence', async (t) => {
  const harness = makeHarness(t, 'secret-stderr');
  createFixtureCapability(
    harness,
    'available_for_install',
    'secret-stderr',
    'secret_stderr',
  );
  const outcome = await probeLocalStdio(harness.store, 'secret-stderr', quickPolicy());
  assert.equal(outcome.code, 'early_exit');
  const broken = row(harness.store, 'installed_broken', 'secret-stderr');
  assert(!broken.failure_reason.includes('AKIAIOSFODNN7EXAMPLE'));
  assert(!broken.failure_reason.includes('eyJhbGciOiJIUzI1NiJ9'));
  assert(!broken.failure_reason.includes('sk-fixture-secret-value'));
  assert(broken.failure_reason.includes('[REDACTED]'));
  assert(!broken.provenance_json.includes('AKIAIOSFODNN7EXAMPLE'));
});

test('41 redaction handles common key, bearer, AWS, JWT, and provider token forms', () => {
  const redacted = redactDiagnostic([
    'OPENAI_API_KEY=sk-provider-token-value-123456789',
    'Authorization: Bearer abcdefghijklmnopqrstuvwxyz',
    'AWS_ACCESS_KEY_ID=AKIAIOSFODNN7EXAMPLE',
    'jwt=eyJabcdefghijk.eyJabcdefghijk.abcdefghijk',
    'GITHUB_TOKEN=ghp_abcdefghijklmnopqrstuvwxyz',
  ].join('\n'));
  assert(!redacted.includes('sk-provider-token'));
  assert(!redacted.includes('abcdefghijklmnopqrstuvwxyz'));
  assert(!redacted.includes('AKIAIOSFODNN7EXAMPLE'));
  assert(!redacted.includes('eyJabcdefghijk'));
  assert(redacted.includes('[REDACTED]'));
});

test('42 available candidate moves transactionally to broken on live failure', async (t) => {
  const harness = makeHarness(t, 'available-broken');
  createFixtureCapability(
    harness,
    'available_for_install',
    'available-broken',
    'explicit_error',
  );
  await probeLocalStdio(harness.store, 'available-broken', quickPolicy());
  assert.equal(row(harness.store, 'available_for_install', 'available-broken'), undefined);
  assert(row(harness.store, 'installed_broken', 'available-broken'));
});

test('43 broken capability repairs to working only after a live success', async (t) => {
  const harness = makeHarness(t, 'broken-working');
  createFixtureCapability(
    harness,
    'installed_broken',
    'broken-working',
    'success',
  );
  const outcome = await probeLocalStdio(harness.store, 'broken-working', quickPolicy());
  assert.equal(outcome.status, 'working');
  assert.equal(row(harness.store, 'installed_broken', 'broken-working'), undefined);
  const working = row(harness.store, 'installed_working', 'broken-working');
  assert(working);
  assert.equal(JSON.parse(working.tools_json).length, 2);
});

test('44 working capability degrades to broken on a later live failure', async (t) => {
  const harness = makeHarness(t, 'working-broken');
  createFixtureCapability(
    harness,
    'installed_working',
    'working-broken',
    'early_exit',
    { lastVerified: new Date().toISOString() },
  );
  const outcome = await probeLocalStdio(harness.store, 'working-broken', quickPolicy());
  assert.equal(outcome.status, 'broken');
  assert.equal(row(harness.store, 'installed_working', 'working-broken'), undefined);
  assert(row(harness.store, 'installed_broken', 'working-broken'));
});

test('45 repeated failure refreshes evidence for an already-broken capability', async (t) => {
  const harness = makeHarness(t, 'broken-refresh');
  const oldFailure = new Date(Date.now() - 86_400_000).toISOString();
  createFixtureCapability(
    harness,
    'installed_broken',
    'broken-refresh',
    'explicit_error_tools',
    { failureObservedAt: oldFailure },
  );
  await probeLocalStdio(harness.store, 'broken-refresh', quickPolicy());
  const broken = row(harness.store, 'installed_broken', 'broken-refresh');
  assert.notEqual(broken.failure_observed_at, oldFailure);
  assert.match(broken.failure_reason, /^tools_list_protocol_error/);
});

test('46 curated notes and paid pricing survive broken-to-working repair', async (t) => {
  const harness = makeHarness(t, 'preserve-repair');
  createFixtureCapability(
    harness,
    'installed_broken',
    'preserve-repair',
    'success',
    { curatedNotes: 'Owner-authored note', pricing: 'paid' },
  );
  await probeLocalStdio(harness.store, 'preserve-repair', quickPolicy());
  const working = row(harness.store, 'installed_working', 'preserve-repair');
  assert.equal(working.curated_notes, 'Owner-authored note');
  assert.equal(working.pricing, 'paid');
});

test('47 curated notes and pricing survive working-to-broken degradation', async (t) => {
  const harness = makeHarness(t, 'preserve-degrade');
  createFixtureCapability(
    harness,
    'installed_working',
    'preserve-degrade',
    'early_exit',
    {
      curatedNotes: 'Do not overwrite this note',
      pricing: 'free',
      lastVerified: new Date().toISOString(),
    },
  );
  await probeLocalStdio(harness.store, 'preserve-degrade', quickPolicy());
  const broken = row(harness.store, 'installed_broken', 'preserve-degrade');
  assert.equal(broken.curated_notes, 'Do not overwrite this note');
  assert.equal(broken.pricing, 'free');
});

test('48 source capture semantics remain code and guaranteed after probing', async (t) => {
  const harness = makeHarness(t, 'capture-preserved');
  createFixtureCapability(
    harness,
    'available_for_install',
    'capture-preserved',
    'success',
  );
  await probeLocalStdio(harness.store, 'capture-preserved', quickPolicy());
  const working = row(harness.store, 'installed_working', 'capture-preserved');
  assert.equal(working.producer_surface, 'code');
  assert.equal(working.capture_class, 'guaranteed');
  assert.equal(working.source_lane, 'probe');
});

test('49 successful verification advances last_verified and records cleanup provenance', async (t) => {
  const harness = makeHarness(t, 'verification-time');
  createFixtureCapability(
    harness,
    'available_for_install',
    'verification-time',
    'success',
  );
  const before = Date.now();
  await probeLocalStdio(harness.store, 'verification-time', quickPolicy());
  const working = row(harness.store, 'installed_working', 'verification-time');
  assert(Date.parse(working.last_verified) >= before);
  const provenance = JSON.parse(working.provenance_json);
  assert.match(provenance.probe.cleanup_method, /stdin-eof|already-exited/);
  assert(Number.isInteger(provenance.probe.pid));
});

test('50 successful child process is gone when probe returns', async (t) => {
  const harness = makeHarness(t, 'success-cleanup');
  createFixtureCapability(
    harness,
    'available_for_install',
    'success-cleanup',
    'success',
  );
  await probeLocalStdio(harness.store, 'success-cleanup', quickPolicy());
  const telemetry = readTelemetry(harness.telemetry);
  assert.equal(await waitForPidExit(telemetry.pid), true);
  assert.equal(pidIsAlive(telemetry.pid), false);
});

test('51 timeout kills the Windows fixture process tree, not only its parent', async (t) => {
  const harness = makeHarness(t, 'tree-cleanup');
  createFixtureCapability(
    harness,
    'available_for_install',
    'tree-cleanup',
    'child_tree_hang',
  );
  const outcome = await probeLocalStdio(
    harness.store,
    'tree-cleanup',
    createOwnerProbePolicy({ initializeMs: 150, toolsListMs: 500, totalMs: 1_000 }),
  );
  assert.equal(outcome.code, 'initialize_timeout');
  const telemetry = readTelemetry(harness.telemetry);
  assert(Number.isInteger(telemetry.childPid));
  assert.equal(await waitForPidExit(telemetry.pid), true);
  assert.equal(await waitForPidExit(telemetry.childPid), true);
});

test('52 a later live success repairs the same row after an earlier live failure', async (t) => {
  const harness = makeHarness(t, 'later-success');
  createFixtureCapability(
    harness,
    'available_for_install',
    'later-success',
    'explicit_error',
  );
  const first = await probeLocalStdio(harness.store, 'later-success', quickPolicy());
  assert.equal(first.status, 'broken');
  const successRaw = rawDeclaration([fixturePath, 'success', harness.telemetry]);
  harness.store.db.prepare(
    "UPDATE installed_broken SET raw_json = ? WHERE id = ?",
  ).run(successRaw, 'later-success');
  const second = await probeLocalStdio(harness.store, 'later-success', quickPolicy());
  assert.equal(second.status, 'working');
  assert.equal(row(harness.store, 'installed_broken', 'later-success'), undefined);
  assert(row(harness.store, 'installed_working', 'later-success'));
});

test('53 approved census evidence may be probed and captured', async (t) => {
  const harness = makeHarness(t, 'census-approved');
  createFixtureCapability(
    harness,
    'available_for_install',
    'census-approved',
    'success',
    {
      sourceLane: 'census',
      censusApproved: true,
      configPath: null,
      rawJson: rawDeclaration(
        [fixturePath, 'success', harness.telemetry],
        { configPath: null },
      ),
    },
  );
  const outcome = await probeLocalStdio(harness.store, 'census-approved', quickPolicy());
  assert.equal(outcome.code, 'ok');
});

test('54 census evidence without explicit stdio approval never spawns', async (t) => {
  const harness = makeHarness(t, 'census-unapproved');
  createFixtureCapability(
    harness,
    'available_for_install',
    'census-unapproved',
    'success',
    {
      sourceLane: 'census',
      configPath: null,
      rawJson: rawDeclaration(
        [fixturePath, 'success', harness.telemetry],
        { configPath: null },
      ),
    },
  );
  const outcome = await probeLocalStdio(
    harness.store,
    'census-unapproved',
    quickPolicy(),
  );
  assert.equal(outcome.code, 'invalid_source_lane');
  assert.equal(fs.existsSync(harness.telemetry), false);
});

test('55 failure evidence uses a stable code and bounded diagnostic text', async (t) => {
  const harness = makeHarness(t, 'bounded-diagnostic');
  createFixtureCapability(
    harness,
    'available_for_install',
    'bounded-diagnostic',
    'secret_stderr',
  );
  await probeLocalStdio(harness.store, 'bounded-diagnostic', quickPolicy());
  const failureReason = row(
    harness.store,
    'installed_broken',
    'bounded-diagnostic',
  ).failure_reason;
  assert.match(failureReason, /^early_exit/);
  assert(
    Buffer.byteLength(failureReason, 'utf8')
      <= PROBE_POLICY.MAX_DIAGNOSTIC_BYTES,
  );
});

test('56 tests leave telemetry only in their bounded temp roots, never repository root', () => {
  const repositoryArtifacts = fs.readdirSync(repositoryRoot).filter((name) =>
    /^stdio-probe-telemetry-|^test\d+\.db$/.test(name));
  assert.deepEqual(repositoryArtifacts, []);
});
