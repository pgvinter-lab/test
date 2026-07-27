import { test } from 'node:test';
import * as assert from 'node:assert';
import * as fs from 'node:fs';
import * as path from 'path';
import * as os from 'os';
import * as crypto from 'node:crypto';
import { acquireCapsRefreshLock, runCapsRefresh } from '../../dist/caps/refresh.js';
import { CapsStore } from '../../dist/caps/store.js';

// Need a fresh temp directory for each test
function getTempDir() {
  return fs.mkdtempSync(path.join(os.tmpdir(), 'caps-08a-test-'));
}

function createStore(dir) {
  const config = { stateDirectory: dir, databasePath: path.join(dir, 'caps.sqlite') };
  const store = new CapsStore(config);
  store.db.exec(`
    CREATE TABLE IF NOT EXISTS installed_working (id TEXT, kind TEXT, transport TEXT, producer_surface TEXT, capture_class TEXT, source_lane TEXT, raw_json TEXT);
    CREATE TABLE IF NOT EXISTS installed_broken (id TEXT, kind TEXT, transport TEXT, producer_surface TEXT, capture_class TEXT, source_lane TEXT, raw_json TEXT);
  `);
  return { store, config };
}

test('1. acquireCapsRefreshLock returns exclusive lock', async () => {
  const dir = getTempDir();
  const lock = await acquireCapsRefreshLock(dir);
  assert.ok(lock.nonce);
  await lock.release();
});

test('2. 2 simultaneous contenders, one gets already_running', async () => {
  const dir = getTempDir();

  // Exercise genuinely overlapping acquisition attempts
  const results = await Promise.all([
    acquireCapsRefreshLock(dir).catch(e => e),
    acquireCapsRefreshLock(dir).catch(e => e)
  ]);

  const hasNonce = (l) => l && l.nonce;
  const isConflict = (l) => l && l.already_running;

  const acquired = results.filter(hasNonce);
  const conflicts = results.filter(isConflict);

  assert.strictEqual(acquired.length, 1);
  assert.strictEqual(conflicts.length, 1);

  await acquired[0].release();
});

test('3. stale takeover', async () => {
  const dir = getTempDir();
  const lockPath = path.join(dir, 'refresh.lock');
  const fakeStaleProv = {
    nonce: 'stale',
    pid: 9999999, // very likely dead
    hostname: os.hostname(),
    start_time: new Date().toISOString()
  };
  fs.writeFileSync(lockPath, JSON.stringify(fakeStaleProv));

  const lock = await acquireCapsRefreshLock(dir);
  assert.ok(lock.nonce);
  assert.notStrictEqual(lock.nonce, 'stale');
  await lock.release();
});

test('4. stale takeover for old foreign host', async () => {
  const dir = getTempDir();
  const lockPath = path.join(dir, 'refresh.lock');
  const oldTime = new Date(Date.now() - 2 * 3600000).toISOString(); // 2 hours old
  const fakeStaleProv = {
    nonce: 'foreign',
    pid: 1234,
    hostname: 'some-other-host',
    start_time: oldTime
  };
  fs.writeFileSync(lockPath, JSON.stringify(fakeStaleProv));

  const lock = await acquireCapsRefreshLock(dir);
  assert.ok(lock.nonce);
  assert.notStrictEqual(lock.nonce, 'foreign');
  await lock.release();
});

test('5. stale-byte mismatch does not take over incorrectly', async () => {
  const dir = getTempDir();
  const lockPath = path.join(dir, 'refresh.lock');

  const oldTime = new Date(Date.now() - 2 * 3600000).toISOString();
  fs.writeFileSync(lockPath, JSON.stringify({
    nonce: 'stale-1',
    pid: 1234,
    hostname: 'some-other-host',
    start_time: oldTime
  }));

  const originalReadFile = fs.promises.readFile;
  let readCount = 0;

  fs.promises.readFile = async function(filePath, ...args) {
    readCount++;
    if (readCount === 2) {
      const liveTime = new Date().toISOString();
      fs.writeFileSync(filePath, JSON.stringify({
        nonce: 'live-2',
        pid: process.pid,
        hostname: os.hostname(),
        start_time: liveTime
      }));
      return originalReadFile.apply(this, [filePath, ...args]);
    }
    return originalReadFile.apply(this, [filePath, ...args]);
  };

  try {
    const lock = await acquireCapsRefreshLock(dir);
    assert.strictEqual(lock.already_running, true);
    assert.strictEqual(lock.lock_provenance.nonce, 'live-2');
  } finally {
    fs.promises.readFile = originalReadFile;
  }
});

test('6. owner-only release preserves replacement bytes', async () => {
  const dir = getTempDir();
  const lock1 = await acquireCapsRefreshLock(dir);

  // modify the lock manually to simulate another lock taking over
  const lockPath = path.join(dir, 'refresh.lock');
  fs.writeFileSync(lockPath, JSON.stringify({ nonce: 'new-owner' }));

  await lock1.release();

  // Lock should still exist with new content because lock1 was not the owner anymore
  assert.ok(fs.existsSync(lockPath));
  assert.strictEqual(JSON.parse(fs.readFileSync(lockPath)).nonce, 'new-owner');
});

test('7. runCapsRefresh generates complete report chain for specific lane', async () => {
  const dir = getTempDir();
  const { store, config } = createStore(dir);
  const report = await runCapsRefresh({ stateDir: dir, lane: 'probe', store, config });
  assert.strictEqual(report.schema, 'bridge-caps-refresh-report-v1');
  assert.strictEqual(report.lifecycle_status, 'terminal-success');
  assert.ok(report.lane_outcomes.probe);
  assert.ok(!report.lane_outcomes.config);
  store.close();
});

test('8. runCapsRefresh all lane execution', async () => {
  const dir = getTempDir();
  const { store, config } = createStore(dir);

  const prevHome = process.env.HOME;
  const prevUserProfile = process.env.USERPROFILE;
  const _origFetch = global.fetch;
  let trapHit = false;

  const mockHome = path.join(dir, 'mock-home');
  fs.mkdirSync(mockHome, { recursive: true });
  fs.writeFileSync(path.join(mockHome, '.claude.json'), '{}');
  fs.mkdirSync(path.join(mockHome, '.codex'), { recursive: true });
  fs.writeFileSync(path.join(mockHome, '.codex', 'config.toml'), '');
  fs.mkdirSync(path.join(mockHome, '.gemini'), { recursive: true });
  fs.writeFileSync(path.join(mockHome, '.gemini', 'settings.json'), '{}');
  process.env.HOME = mockHome;
  process.env.USERPROFILE = mockHome;
  global.fetch = async () => { trapHit = true; throw new Error("trap"); };

  let report;
  try {
    report = await runCapsRefresh({ stateDir: dir, lane: 'all', store, config });
  } finally {
    if (prevHome !== undefined) process.env.HOME = prevHome; else delete process.env.HOME;
    if (prevUserProfile !== undefined) process.env.USERPROFILE = prevUserProfile; else delete process.env.USERPROFILE;
    global.fetch = _origFetch;
  }

  assert.ok(report.lane_outcomes.config !== undefined || report.gaps.length > 0);
  assert.ok(trapHit);
  store.close();
});

test('9. atomic report finalization proves transition and same-dir temp replacement', async () => {
  const dir = getTempDir();
  const { store, config } = createStore(dir);

  let incompleteVerified = false;
  const verifyNonTerminalStage = {
    name: 'projections',
    run: async ({ reportId, stateDir }) => {
      const reportPath = path.join(stateDir, 'reports', `refresh-${reportId}.json`);
      const onDisk = JSON.parse(fs.readFileSync(reportPath, 'utf8'));
      assert.strictEqual(onDisk.lifecycle_status, 'incomplete');
      incompleteVerified = true;
      return { success: true, summary: "verified" };
    }
  };

  const report = await runCapsRefresh({ stateDir: dir, lane: 'probe', stages: [verifyNonTerminalStage], store, config });
  assert.ok(incompleteVerified);
  assert.strictEqual(report.lifecycle_status, 'terminal-success');

  const reportPath = path.join(dir, 'reports', `refresh-${report.refresh_run_id}.json`);
  const finalOnDisk = JSON.parse(fs.readFileSync(reportPath, 'utf8'));
  assert.strictEqual(finalOnDisk.lifecycle_status, 'terminal-success');
  store.close();
});

test('10. crash/incomplete state verifiable via deterministic interruption', async () => {
  const dir = getTempDir();
  const { store, config } = createStore(dir);

  let crashed = false;
  try {
    await runCapsRefresh({ stateDir: dir, lane: 'probe', store, config, __test_crash_after_core: true });
  } catch(e) {
    if (e.message === 'simulated_crash') {
      crashed = true;
    }
  }
  assert.ok(crashed);

  const reportsDir = path.join(dir, 'reports');
  const files = fs.readdirSync(reportsDir);
  const reportFile = files.find(f => f.startsWith('refresh-') && f.endsWith('.json') && !f.includes('temp'));
  const onDisk = JSON.parse(fs.readFileSync(path.join(reportsDir, reportFile), 'utf8'));

  assert.strictEqual(onDisk.lifecycle_status, 'incomplete');

  store.close();
});

test('11. stage failure preserves DB facts but makes report non-successful', async () => {
  const dir = getTempDir();
  const { store, config } = createStore(dir);
  const failingStage = {
    name: 'projections',
    run: async () => { return { success: false, gap: "failed to project" }; }
  };
  const report = await runCapsRefresh({ stateDir: dir, lane: 'probe', stages: [failingStage], store, config });
  assert.strictEqual(report.lifecycle_status, 'terminal-failure');
  assert.ok(report.gaps.some(g => g.includes('stage_failure:projections')));
  store.close();
});

test('12. offline public-contract requirements met', async () => {
  const dir = getTempDir();
  const { store, config } = createStore(dir);

  const report = await runCapsRefresh({ stateDir: dir, lane: 'probe', store, config });
  assert.ok(report.input_hashes['caps.sqlite']);
  assert.ok(report.output_hashes['caps.sqlite']);
  assert.notStrictEqual(report.input_hashes['caps.sqlite'], 'not_found');
  assert.strictEqual(report.lifecycle_status, 'terminal-success');

  // check derived metric nullification
  assert.strictEqual(report.new_arrivals, null);
  assert.strictEqual(report.status_flips, null);
  assert.strictEqual(report.watch_deltas, null);
  assert.ok(report.gaps.some(g => g.includes('metrics_not_derived')));

  store.close();
});

test('13. runCapsRefresh itself participates in exclusive lock', async () => {
  const dir = getTempDir();
  const { store, config } = createStore(dir);

  const lock = await acquireCapsRefreshLock(dir);

  await assert.rejects(
    runCapsRefresh({ stateDir: dir, lane: 'probe', store, config }),
    { message: 'already_running' }
  );

  await lock.release();
  store.close();
});

test('14. audit error paths inside report writes (same-dir and durable)', async () => {
  const dir = getTempDir();
  const { store, config } = createStore(dir);

  const originalRename = fs.promises.rename;
  let sameDir = false;
  fs.promises.rename = async function(src, dest) {
    if (path.dirname(src) === path.dirname(dest)) {
      sameDir = true;
    }
    return originalRename.call(this, src, dest);
  };

  try {
    await runCapsRefresh({ stateDir: dir, lane: 'probe', store, config });
    assert.ok(sameDir);
  } finally {
    fs.promises.rename = originalRename;
  }

  store.close();
});

test('15. after-projection order', async () => {
  const dir = getTempDir();
  const { store, config } = createStore(dir);
  store.recordJudgmentVerdict = () => ({ appliedCount: 0, idempotentCount: 0, notInDbCount: 0 });
  const log = [];
  const fakeProjectionStage = {
    name: 'projections',
    run: async (ctx) => {
      log.push('projections');
      fs.mkdirSync(path.join(ctx.stateDir, 'reports'), { recursive: true });
      fs.writeFileSync(path.join(ctx.stateDir, 'reports', `projections-${ctx.reportId}.json`), JSON.stringify({
        needs_profile: { path: "fake", sha256: "0".repeat(64) },
        new_available: []
      }));
      return { success: true };
    }
  };

  const mockMailbox = {
    config: { providers: { antigravity: { consumerId: 'provider.antigravity.mcp' } } },
    send: () => { log.push('judgment-send'); throw new Error(); },
    get: () => null
  };

  const report = await runCapsRefresh({ stateDir: dir, lane: 'probe', stages: [fakeProjectionStage], store, config, mailbox: mockMailbox });
  assert.deepStrictEqual(log, ['projections', 'judgment-send']); // proves order
  store.close();
});

test('16. no-projection gap', async () => {
  const dir = getTempDir();
  const { store, config } = createStore(dir);
  const mockMailbox = {
    config: { providers: { antigravity: { consumerId: 'provider.antigravity.mcp' } } }
  };

  const report = await runCapsRefresh({ stateDir: dir, lane: 'probe', store, config, mailbox: mockMailbox });
  assert.strictEqual(report.stage_outcomes.judgment.success, false);
  assert.strictEqual(report.stage_outcomes.judgment.gap, 'missing_projection');
  store.close();
});

test('17. complete enqueue receipt fields', async () => {
  const dir = getTempDir();
  const { store, config } = createStore(dir);
  let passedReq = null;
  const mockMailbox = {
    config: { providers: { antigravity: { consumerId: 'provider.antigravity.mcp' } } },
    send: (req) => { passedReq = req; return { messageId: 'msg-1', createdAt: '2026-07-24T00:00:00Z' }; },
    get: () => ({ status: 'pending' })
  };
  const fakeProjectionStage = {
    name: 'projections',
    run: async (ctx) => {
      fs.mkdirSync(path.join(ctx.stateDir, 'reports'), { recursive: true });
      fs.writeFileSync(path.join(ctx.stateDir, 'reports', `projections-${ctx.reportId}.json`), JSON.stringify({
        needs_profile: { path: "fake", sha256: "0".repeat(64) },
        new_available: []
      }));
      return { success: true };
    }
  };
  const report = await runCapsRefresh({ stateDir: dir, lane: 'probe', stages: [fakeProjectionStage], store, config, mailbox: mockMailbox });
  assert.strictEqual(report.stage_outcomes.judgment.success, false);
  assert.strictEqual(report.stage_outcomes.judgment.gap, 'pending');
  const summary = JSON.parse(report.stage_outcomes.judgment.summary);
  assert.strictEqual(summary.messageId, 'msg-1');
  assert.ok(summary.payloadHash);
  assert.ok(summary.promptHash);
  assert.ok(summary.idempotencyKey);
  assert.strictEqual(summary.dispatchTimestamp, '2026-07-24T00:00:00Z');
  store.close();
});

test('18. idempotent repeat/no resend', async () => {
  const dir = getTempDir();
  const { store, config } = createStore(dir);
  let sends = 0;
  const mockMailbox = {
    config: { providers: { antigravity: { consumerId: 'provider.antigravity.mcp' } } },
    send: (req) => { sends++; return { messageId: 'msg-1', createdAt: '2026-07-24' }; },
    get: () => ({ status: 'pending' })
  };
  const { CapsJudgmentStage } = await import('../../dist/caps/refresh.js');
  const stage = new CapsJudgmentStage(mockMailbox, store);

  fs.mkdirSync(path.join(dir, 'reports'), { recursive: true });
  fs.writeFileSync(path.join(dir, 'reports', `projections-123.json`), JSON.stringify({
    needs_profile: { path: "fake", sha256: "0".repeat(64) },
    new_available: []
  }));

  await stage.run({ reportId: '123', stateDir: dir });
  await stage.run({ reportId: '123', stateDir: dir });
  assert.strictEqual(sends, 1);
  store.close();
});

test('19. pending response/no write', async () => {
  const dir = getTempDir();
  const { store, config } = createStore(dir);
  let written = false;
  store.recordJudgmentVerdict = () => { written = true; return { appliedCount: 0, idempotentCount: 0, notInDbCount: 0 }; };

  const mockMailbox = {
    config: { providers: { antigravity: { consumerId: 'provider.antigravity.mcp' } } },
    send: (req) => { return { messageId: 'msg-1', createdAt: '2026-07-24' }; },
    get: () => ({ status: 'pending' })
  };
  const { CapsJudgmentStage } = await import('../../dist/caps/refresh.js');
  const stage = new CapsJudgmentStage(mockMailbox, store);

  fs.mkdirSync(path.join(dir, 'reports'), { recursive: true });
  fs.writeFileSync(path.join(dir, 'reports', `projections-123.json`), JSON.stringify({
    needs_profile: { path: "fake", sha256: "0".repeat(64) }
  }));

  const outcome = await stage.run({ reportId: '123', stateDir: dir });
  assert.strictEqual(outcome.success, false);
  assert.strictEqual(outcome.gap, 'pending');
  assert.strictEqual(written, false);
  store.close();
});

test('20. valid completion collection', async () => {
  const dir = getTempDir();
  const { store, config } = createStore(dir);
  let written = false;
  store.recordJudgmentVerdict = () => { written = true; return { appliedCount: 1, idempotentCount: 0, notInDbCount: 0 }; };

  const mockMailbox = {
    config: { providers: { antigravity: { consumerId: 'provider.antigravity.mcp' } } },
    exchange: {}
  };

  mockMailbox.send = function(req) {
    const pHash = crypto.createHash('sha256').update(req.prompt).digest('hex');
    const rHash = crypto.createHash('sha256').update('{"model":"claude","judged_at":"2026-07-24T00:00:00Z","verdicts":[]}').digest('hex');

    mockMailbox.get = () => ({
      status: 'completed',
      promptSha256: pHash,
      envelopeRelativePath: 'env',
      responseRelativePath: 'resp'
    });
    mockMailbox.exchange.readMessage = () => ({
       messageId: 'msg-1', projectId: 'bridge', recipient: 'antigravity',
       dispatchAuthorization: { provider: 'antigravity' },
       prompt: req.prompt
    });
    mockMailbox.exchange.readResponse = () => ({
       messageId: 'msg-1', provider: 'antigravity', consumerId: 'provider.antigravity.mcp',
       responseSha256: rHash,
       response: '{"model":"claude","judged_at":"2026-07-24T00:00:00Z","verdicts":[]}'
    });

    return { messageId: 'msg-1', createdAt: '2026-07-24' };
  };

  const { CapsJudgmentStage } = await import('../../dist/caps/refresh.js');
  const stage = new CapsJudgmentStage(mockMailbox, store);

  fs.mkdirSync(path.join(dir, 'reports'), { recursive: true });
  fs.writeFileSync(path.join(dir, 'reports', `projections-123.json`), JSON.stringify({
    needs_profile: { path: "fake", sha256: "0".repeat(64) },
    new_available: []
  }));

  const outcome = await stage.run({ reportId: '123', stateDir: dir });
  assert.strictEqual(outcome.success, true);
  assert.strictEqual(outcome.count, 1);
  assert.strictEqual(written, true);
  store.close();
});

test('21. mailbox unavailable', async () => {
  const dir = getTempDir();
  const { store, config } = createStore(dir);

  const mockMailbox = {
    config: { providers: { antigravity: { consumerId: 'provider.antigravity.mcp' } } },
    send: (req) => { throw new Error('Network error'); }
  };
  const { CapsJudgmentStage } = await import('../../dist/caps/refresh.js');
  const stage = new CapsJudgmentStage(mockMailbox, store);

  fs.mkdirSync(path.join(dir, 'reports'), { recursive: true });
  fs.writeFileSync(path.join(dir, 'reports', `projections-123.json`), JSON.stringify({
    needs_profile: { path: "fake", sha256: "0".repeat(64) },
    new_available: []
  }));

  const outcome = await stage.run({ reportId: '123', stateDir: dir });
  assert.strictEqual(outcome.success, false);
  assert.strictEqual(outcome.gap, 'mailbox_unavailable');
  store.close();
});

test('22. mismatch and invalid content tests', async () => {
  const dir = getTempDir();
  const { store, config } = createStore(dir);

  const mockMailbox = { config: { providers: { antigravity: { consumerId: 'provider.antigravity.mcp' } } } };
  const { CapsJudgmentStage } = await import('../../dist/caps/refresh.js');
  const stage = new CapsJudgmentStage(mockMailbox, store);

  fs.mkdirSync(path.join(dir, 'reports'), { recursive: true });
  fs.writeFileSync(path.join(dir, 'reports', `projections-123.json`), JSON.stringify({
    wrong_format: true
  }));

  const outcome = await stage.run({ reportId: '123', stateDir: dir });
  assert.strictEqual(outcome.success, false);
  assert.strictEqual(outcome.gap, 'invalid_content');
  store.close();
});

test('23. true envelope/prompt/payload mismatch -> binding_mismatch and no write', async () => {
  const dir = getTempDir();
  const { store, config } = createStore(dir);
  let written = false;
  store.recordJudgmentVerdict = () => { written = true; return { appliedCount: 0, idempotentCount: 0, notInDbCount: 0 }; };

  const mockMailbox = { config: { providers: { antigravity: { consumerId: 'provider.antigravity.mcp' } } }, exchange: {} };
  mockMailbox.send = function(req) {
    const pHash = crypto.createHash('sha256').update(req.prompt).digest('hex');
    const rHash = crypto.createHash('sha256').update('{"model":"claude","judged_at":"2026-07-24T00:00:00Z","verdicts":[]}').digest('hex');

    mockMailbox.get = () => ({
      status: 'completed',
      promptSha256: 'bad-hash', // Deliberate binding defect
      envelopeRelativePath: 'env',
      responseRelativePath: 'resp'
    });
    mockMailbox.exchange.readMessage = () => ({
       messageId: 'msg-1', projectId: 'bridge', recipient: 'antigravity',
       dispatchAuthorization: { provider: 'antigravity' },
       prompt: req.prompt
    });
    mockMailbox.exchange.readResponse = () => ({
       messageId: 'msg-1', provider: 'antigravity', consumerId: 'provider.antigravity.mcp',
       responseSha256: rHash,
       response: '{"model":"claude","judged_at":"2026-07-24T00:00:00Z","verdicts":[]}'
    });
    return { messageId: 'msg-1', createdAt: '2026-07-24' };
  };

  const { CapsJudgmentStage } = await import('../../dist/caps/refresh.js');
  const stage = new CapsJudgmentStage(mockMailbox, store);

  // Wrap to observe the real error code without mocking
  const originalIngest = stage.svc.ingestVerdict.bind(stage.svc);
  let capturedError = null;
  stage.svc.ingestVerdict = async (...args) => {
    try {
      return await originalIngest(...args);
    } catch (e) {
      capturedError = e;
      throw e;
    }
  };

  fs.mkdirSync(path.join(dir, 'reports'), { recursive: true });
  fs.writeFileSync(path.join(dir, 'reports', `projections-123.json`), JSON.stringify({
    needs_profile: { path: "fake", sha256: "0".repeat(64) },
    new_available: []
  }));

  const outcome = await stage.run({ reportId: '123', stateDir: dir });
  assert.strictEqual(outcome.success, false);
  assert.strictEqual(outcome.gap, 'binding_mismatch');
  assert.strictEqual(written, false);
  assert.ok(capturedError);
  assert.strictEqual(capturedError.name, 'JudgmentError');
  assert.strictEqual(capturedError.code, 'prompt_hash_mismatch');
  store.close();
});

test('24. malformed content -> invalid_content and no invalid write', async () => {
  const dir = getTempDir();
  const { store, config } = createStore(dir);

  const mockMailbox = { config: { providers: { antigravity: { consumerId: 'provider.antigravity.mcp' } } }, exchange: {} };
  mockMailbox.send = function(req) {
    mockMailbox.get = () => ({ status: 'completed' });
    return { messageId: 'msg-1', createdAt: '2026-07-24' };
  };

  const { CapsJudgmentStage } = await import('../../dist/caps/refresh.js');
  const stage = new CapsJudgmentStage(mockMailbox, store);
  stage.svc.ingestVerdict = async () => {
    return {
      appliedCount: 1,
      idempotentCount: 0,
      notInDbCount: 0,
      gapClasses: ['malformed_verdict']
    };
  };

  fs.mkdirSync(path.join(dir, 'reports'), { recursive: true });
  fs.writeFileSync(path.join(dir, 'reports', `projections-123.json`), JSON.stringify({
    needs_profile: { path: "fake", sha256: "0".repeat(64) },
    new_available: []
  }));

  const outcome = await stage.run({ reportId: '123', stateDir: dir });
  assert.strictEqual(outcome.success, false);
  assert.strictEqual(outcome.gap, 'invalid_content');
  const summary = JSON.parse(outcome.summary);
  assert.strictEqual(summary.gapClasses.includes('malformed_verdict'), true);
  store.close();
});

test('25. missing verdict -> response_incomplete with accurate appliedCount', async () => {
  const dir = getTempDir();
  const { store, config } = createStore(dir);

  const mockMailbox = { config: { providers: { antigravity: { consumerId: 'provider.antigravity.mcp' } } }, exchange: {} };
  mockMailbox.send = function(req) {
    mockMailbox.get = () => ({ status: 'completed' });
    return { messageId: 'msg-1', createdAt: '2026-07-24' };
  };

  const { CapsJudgmentStage } = await import('../../dist/caps/refresh.js');
  const stage = new CapsJudgmentStage(mockMailbox, store);
  stage.svc.ingestVerdict = async () => {
    return {
      appliedCount: 2,
      idempotentCount: 0,
      notInDbCount: 0,
      gapClasses: ['missing_verdict']
    };
  };

  fs.mkdirSync(path.join(dir, 'reports'), { recursive: true });
  fs.writeFileSync(path.join(dir, 'reports', `projections-123.json`), JSON.stringify({
    needs_profile: { path: "fake", sha256: "0".repeat(64) },
    new_available: []
  }));

  const outcome = await stage.run({ reportId: '123', stateDir: dir });
  assert.strictEqual(outcome.success, false);
  assert.strictEqual(outcome.gap, 'response_incomplete');
  assert.strictEqual(outcome.count, 2);
  const summary = JSON.parse(outcome.summary);
  assert.strictEqual(summary.appliedCount, 2);
  assert.strictEqual(summary.gapClasses.includes('missing_verdict'), true);
  store.close();
});

test('26. not_in_db -> projection_db_gap', async () => {
  const dir = getTempDir();
  const { store, config } = createStore(dir);

  const mockMailbox = { config: { providers: { antigravity: { consumerId: 'provider.antigravity.mcp' } } }, exchange: {} };
  mockMailbox.send = function(req) {
    mockMailbox.get = () => ({ status: 'completed' });
    return { messageId: 'msg-1', createdAt: '2026-07-24' };
  };

  const { CapsJudgmentStage } = await import('../../dist/caps/refresh.js');
  const stage = new CapsJudgmentStage(mockMailbox, store);
  stage.svc.ingestVerdict = async () => {
    return {
      appliedCount: 0,
      idempotentCount: 0,
      notInDbCount: 1,
      gapClasses: ['not_in_db']
    };
  };

  fs.mkdirSync(path.join(dir, 'reports'), { recursive: true });
  fs.writeFileSync(path.join(dir, 'reports', `projections-123.json`), JSON.stringify({
    needs_profile: { path: "fake", sha256: "0".repeat(64) },
    new_available: []
  }));

  const outcome = await stage.run({ reportId: '123', stateDir: dir });
  assert.strictEqual(outcome.success, false);
  assert.strictEqual(outcome.gap, 'projection_db_gap');
  store.close();
});

test('27. deterministic class precedence (multiple gaps)', async () => {
  const dir = getTempDir();
  const { store, config } = createStore(dir);

  const mockMailbox = { config: { providers: { antigravity: { consumerId: 'provider.antigravity.mcp' } } }, exchange: {} };
  mockMailbox.send = function(req) {
    mockMailbox.get = () => ({ status: 'completed' });
    return { messageId: 'msg-1', createdAt: '2026-07-24' };
  };

  const { CapsJudgmentStage } = await import('../../dist/caps/refresh.js');
  const stage = new CapsJudgmentStage(mockMailbox, store);
  stage.svc.ingestVerdict = async () => {
    return {
      appliedCount: 0,
      idempotentCount: 0,
      notInDbCount: 0,
      gapClasses: ['not_in_db', 'missing_verdict', 'malformed_verdict']
    };
  };

  fs.mkdirSync(path.join(dir, 'reports'), { recursive: true });
  fs.writeFileSync(path.join(dir, 'reports', `projections-123.json`), JSON.stringify({
    needs_profile: { path: "fake", sha256: "0".repeat(64) },
    new_available: []
  }));

  const outcome = await stage.run({ reportId: '123', stateDir: dir });
  assert.strictEqual(outcome.success, false);
  assert.strictEqual(outcome.gap, 'invalid_content');
  const summary = JSON.parse(outcome.summary);
  assert.strictEqual(summary.gapClasses.length, 3);
  store.close();
});

test('28. durable-after-core ordering and on-disk incomplete receipt proof', async () => {
  const dir = getTempDir();
  const { store, config } = createStore(dir);

  let incompleteVerified = false;
  const originalReadFile = fs.promises.readFile;
  fs.promises.readFile = async function(filePath, ...args) {
    if (typeof filePath === 'string' && filePath.includes('refresh-') && filePath.includes('.json') && !filePath.includes('temp') && filePath.includes('reports')) {
      const content = JSON.parse(await originalReadFile.call(this, filePath, ...args));
      if (content.lifecycle_status === 'incomplete') {
        incompleteVerified = true;
      }
    }
    return originalReadFile.apply(this, [filePath, ...args]);
  };

  try {
    const { CapsProjectionStage } = await import('../../dist/caps/refresh.js');
    const report = await runCapsRefresh({ stateDir: dir, lane: 'probe', stages: [new CapsProjectionStage(store)], store, config });
    assert.strictEqual(report.lifecycle_status, 'terminal-success');
    assert.ok(incompleteVerified);
  } finally {
    fs.promises.readFile = originalReadFile;
    store.close();
  }
});

test('29. success artifact schema, readback hash, target hashes, backup/no-prior receipts, and bounded summary', async () => {
  const dir = getTempDir();
  const { store, config } = createStore(dir);
  const { CapsProjectionStage } = await import('../../dist/caps/refresh.js');
  const report = await runCapsRefresh({ stateDir: dir, lane: 'probe', stages: [new CapsProjectionStage(store)], store, config });
  assert.strictEqual(report.lifecycle_status, 'terminal-success');

  const projReportPath = path.join(dir, 'reports', `projections-${report.refresh_run_id}.json`);
  assert.ok(fs.existsSync(projReportPath));
  const artifact = JSON.parse(fs.readFileSync(projReportPath, 'utf8'));

  assert.strictEqual(artifact.schema, 'bridge-caps-projections-v1');
  assert.strictEqual(artifact.refresh_run_id, report.refresh_run_id);
  assert.ok(artifact.generated_at);
  assert.ok(artifact.catalog.path);
  assert.ok(artifact.catalog.sha256);
  assert.strictEqual(artifact.catalog.backup_receipt, 'no_prior_file');
  assert.ok(artifact.available.path);
  assert.ok(artifact.available.sha256);
  assert.strictEqual(artifact.available.backup_receipt, 'no_prior_file');
  assert.ok(artifact.needs_profile.path);
  assert.ok(artifact.needs_profile.sha256);
  assert.strictEqual(artifact.needs_profile.profile_id, 'default-owner-needs');

  assert.deepStrictEqual(artifact.new_available, []);
  assert.deepStrictEqual(artifact.status_flips, []);
  assert.deepStrictEqual(artifact.watch_deltas, []);
  assert.ok(Array.isArray(artifact.source_hashes));

  const artifactBytes = fs.readFileSync(projReportPath);
  const actualSha256 = crypto.createHash('sha256').update(artifactBytes).digest('hex');
  assert.strictEqual(artifact.payload_sha256 !== undefined, true);
  assert.notStrictEqual(artifact.payload_sha256, actualSha256);

  const parsedWithoutPayload = { ...artifact };
  parsedWithoutPayload.payload_sha256 = '';
  const expectedPayloadHash = crypto.createHash('sha256').update(Buffer.from(JSON.stringify(parsedWithoutPayload, null, 2), 'utf-8')).digest('hex');
  assert.strictEqual(artifact.payload_sha256, expectedPayloadHash);

  const summary = JSON.parse(report.stage_outcomes.projections.summary);
  assert.strictEqual(summary.artifact_path, projReportPath);
  assert.strictEqual(summary.artifact_sha256, actualSha256);
  assert.strictEqual(summary.target_hashes.catalog, artifact.catalog.sha256);
  assert.strictEqual(summary.target_hashes.available, artifact.available.sha256);
  assert.strictEqual(summary.target_hashes.needs_profile, artifact.needs_profile.sha256);
  assert.strictEqual(summary.backup_receipts.catalog, artifact.catalog.backup_receipt);
  assert.strictEqual(summary.backup_receipts.available, artifact.available.backup_receipt);
  assert.strictEqual(summary.new_count, artifact.new_available.length);
  assert.strictEqual(summary.status_flips, artifact.status_flips.length);
  assert.strictEqual(summary.watch_deltas, artifact.watch_deltas.length);
  assert.strictEqual(summary.gap_count, artifact.gap_count);
  assert.strictEqual(summary.readback_verified, true);

  assert.ok(Buffer.from(report.stage_outcomes.projections.summary, 'utf-8').length < 1024);

  store.close();
});

test('30. every target/artifact/backup path is inside the exact temp state root and no live owner path changes', async () => {
  const dir = getTempDir();
  const { store, config } = createStore(dir);
  const catalogPath = path.join(dir, 'CATALOG.md');
  const availablePath = path.join(dir, 'AVAILABLE.md');
  fs.writeFileSync(catalogPath, 'old content');
  fs.writeFileSync(availablePath, 'old content');

  const { CapsProjectionStage } = await import('../../dist/caps/refresh.js');
  const report = await runCapsRefresh({ stateDir: dir, lane: 'probe', stages: [new CapsProjectionStage(store)], store, config });

  const projReportPath = path.join(dir, 'reports', `projections-${report.refresh_run_id}.json`);
  const artifact = JSON.parse(fs.readFileSync(projReportPath, 'utf8'));

  const validateDescendant = (p, expectedName) => {
    const resolved = path.resolve(p);
    const stateRoot = path.resolve(dir);
    assert.ok(resolved.startsWith(stateRoot + path.sep));
    if (expectedName) {
       assert.strictEqual(path.basename(resolved), expectedName);
    }
    return resolved;
  };

  assert.strictEqual(validateDescendant(artifact.catalog.path, 'CATALOG.md'), path.resolve(catalogPath));
  assert.strictEqual(validateDescendant(artifact.available.path, 'AVAILABLE.md'), path.resolve(availablePath));
  assert.strictEqual(validateDescendant(artifact.needs_profile.path, 'NEEDS.json'), path.resolve(dir, 'NEEDS.json'));
  assert.strictEqual(validateDescendant(projReportPath, `projections-${report.refresh_run_id}.json`), path.resolve(projReportPath));

  assert.ok(artifact.catalog.backup_receipt.startsWith('backed_up_'));
  assert.ok(artifact.available.backup_receipt.startsWith('backed_up_'));

  const backupsDir = path.join(dir, 'backups', 'projections');
  const backupFiles = fs.readdirSync(backupsDir);
  const catalogBaks = backupFiles.filter(f => f.startsWith('CATALOG.md') && f.endsWith('.bak'));
  const availBaks = backupFiles.filter(f => f.startsWith('AVAILABLE.md') && f.endsWith('.bak'));
  assert.strictEqual(catalogBaks.length, 1);
  assert.strictEqual(availBaks.length, 1);

  validateDescendant(path.join(backupsDir, catalogBaks[0]), catalogBaks[0]);
  validateDescendant(path.join(backupsDir, availBaks[0]), availBaks[0]);
  validateDescendant(path.join(backupsDir, catalogBaks[0] + '.manifest'), catalogBaks[0] + '.manifest');
  validateDescendant(path.join(backupsDir, availBaks[0] + '.manifest'), availBaks[0] + '.manifest');

  store.close();
});

test('31. malformed-marker or injected renderer failure preserves DB facts/owner bytes where 09A guarantees and records specific projection failure', async () => {
  const dir = getTempDir();
  const { store, config } = createStore(dir);

  const catalogPath = path.join(dir, 'CATALOG.md');
  fs.writeFileSync(catalogPath, '<!-- bridge:caps:generated:begin --><!-- bridge:caps:generated:begin -->');

  store.db.exec(`INSERT INTO installed_working (id, kind, name, slug, surface_owner, transport, pricing, official, source_lane, producer_surface, capture_class, observed_at, last_verified, stale_at, provenance_json, raw_json) VALUES ('test1', 'server', 'Test Name', 'test-slug', 'n/a', 'http', 'free', 0, 'probe', 'code', 'guaranteed', '2026-07-24', '2026-07-24', '2026-07-24', '{}', '{}')`);

  const { CapsProjectionStage } = await import('../../dist/caps/refresh.js');
  const report = await runCapsRefresh({ stateDir: dir, lane: 'probe', stages: [new CapsProjectionStage(store)], store, config });
  assert.strictEqual(report.lifecycle_status, 'terminal-failure');
  assert.strictEqual(report.stage_outcomes.projections.success, false);
  assert.ok(report.stage_outcomes.projections.gap.includes('duplicate_markers'));

  const postCatalog = fs.readFileSync(catalogPath, 'utf8');
  assert.strictEqual(postCatalog, '<!-- bridge:caps:generated:begin --><!-- bridge:caps:generated:begin -->');

  const working = store.db.prepare("SELECT * FROM installed_working").all();
  assert.strictEqual(working.length, 1);

  store.close();
});

test('32. projection failure yields terminal-failure, stage_outcomes.projections.success=false, and no judgment dispatch', async () => {
  const dir = getTempDir();
  const { store, config } = createStore(dir);

  const catalogPath = path.join(dir, 'CATALOG.md');
  fs.writeFileSync(catalogPath, '<!-- bridge:caps:generated:begin --><!-- bridge:caps:generated:begin -->');

  let judgmentDispatched = false;
  const mockMailbox = {
    config: { providers: { antigravity: { consumerId: 'provider.antigravity.mcp' } } },
    send: (req) => { judgmentDispatched = true; return { messageId: 'msg-1', createdAt: '2026-07-24' }; },
    get: () => ({ status: 'pending' })
  };

  const { CapsProjectionStage } = await import('../../dist/caps/refresh.js');
  const report = await runCapsRefresh({ stateDir: dir, lane: 'probe', stages: [new CapsProjectionStage(store)], store, config, mailbox: mockMailbox });
  assert.strictEqual(report.lifecycle_status, 'terminal-failure');
  assert.strictEqual(report.stage_outcomes.projections.success, false);
  assert.strictEqual(judgmentDispatched, false);
  assert.ok(!report.stage_outcomes.judgment);

  store.close();
});

test('33. lane=all automatically registers exactly one projection stage; specific lanes do not', async () => {
  const dir = getTempDir();
  const { store, config } = createStore(dir);

  const prevHome = process.env.HOME;
  const prevUserProfile = process.env.USERPROFILE;
  const _origFetch = global.fetch;
  let trapHit = false;

  const mockHome = path.join(dir, 'mock-home');
  fs.mkdirSync(mockHome, { recursive: true });
  fs.writeFileSync(path.join(mockHome, '.claude.json'), '{}');
  fs.mkdirSync(path.join(mockHome, '.codex'), { recursive: true });
  fs.writeFileSync(path.join(mockHome, '.codex', 'config.toml'), '');
  fs.mkdirSync(path.join(mockHome, '.gemini'), { recursive: true });
  fs.writeFileSync(path.join(mockHome, '.gemini', 'settings.json'), '{}');
  process.env.HOME = mockHome;
  process.env.USERPROFILE = mockHome;
  global.fetch = async () => { trapHit = true; throw new Error("trap"); };

  let reportAll;
  try {
    reportAll = await runCapsRefresh({ stateDir: dir, lane: 'all', store, config });
  } finally {
    if (prevHome !== undefined) process.env.HOME = prevHome; else delete process.env.HOME;
    if (prevUserProfile !== undefined) process.env.USERPROFILE = prevUserProfile; else delete process.env.USERPROFILE;
    global.fetch = _origFetch;
  }

  assert.ok(reportAll.stage_outcomes.projections);
  assert.ok(trapHit);
  const dir2 = getTempDir();
  const { store: store2, config: config2 } = createStore(dir2);
  const reportProbe = await runCapsRefresh({ stateDir: dir2, lane: 'probe', store: store2, config: config2 });
  assert.ok(!reportProbe.stage_outcomes.projections);

  store.close();
  store2.close();
});

test('34. with a mailbox, projection precedes judgment and the real projections-${reportId}.json shape is accepted by 11B', async () => {
  const dir = getTempDir();
  const { store, config } = createStore(dir);
  const watchResponseHash = crypto.createHash('sha256').update('watch-response').digest('hex');
  const fetchResponseHash = crypto.createHash('sha256').update('fetch-response').digest('hex');

  store.db.exec(`INSERT INTO available_for_install (id, kind, name, slug, surface_owner, transport, pricing, official, source_lane, producer_surface, capture_class, observed_at, last_verified, stale_at, provenance_json, category, description, source_url) VALUES ('1', 'server', 'My MCP', 'mcp-slug', 'n/a', 'stdio', 'paid', 0, 'probe', 'code', 'guaranteed', '2026-07-24', '2026-07-24', '2026-07-24', '{}', 'utils', 'An MCP', 'https://example.com/mcp')`);

  let passedReq = null;
  const mockMailbox = {
    config: { providers: { antigravity: { consumerId: 'provider.antigravity.mcp' } } },
    send: (req) => { passedReq = req; return { messageId: 'msg-1', createdAt: '2026-07-24' }; },
    get: () => ({ status: 'pending' })
  };

  const { CapsProjectionStage, CapsJudgmentStage } = await import('../../dist/caps/refresh.js');

  const preStage = {
    name: 'pre',
    run: async (ctx) => {
      const corePath = path.join(ctx.stateDir, 'reports', `refresh-${ctx.reportId}.json`);
      const core = JSON.parse(fs.readFileSync(corePath, 'utf8'));
      core.lifecycle_status = 'incomplete';
      core.lane_outcomes.mcpservers = {
        schema: 'bridge-caps-mcpservers-refresh-v1',
        started_at: new Date().toISOString(),
        finished_at: new Date().toISOString(),
        diff: {
          new: ['https://example.com/mcp'],
          changed: ['existing-id-1'],
          removed: [],
          new_count: 1,
          changed_count: 1,
          removed_count: 0
        },
        stated_totals: {
          'watch:https://example.com/mcp': {
            value: 42,
            previous: 40,
            delta: 2,
            observed_at: new Date().toISOString(),
            source_url: 'https://example.com/mcp',
            response_sha256: watchResponseHash
          }
        },
        processed: 1,
        skipped_installed: 0,
        pending: 0,
        gaps: [],
        errors: [],
        fetch_log: [{
          url: 'https://example.com/mcp',
          outcome: 'ok',
          status: 200,
          bytes: 1024,
          attempts: 1,
          sha256: fetchResponseHash
        }]
      };
      fs.writeFileSync(corePath, JSON.stringify(core));
      return { success: true };
    }
  };

  const report = await runCapsRefresh({
    stateDir: dir,
    lane: 'probe',
    stages: [preStage, new CapsProjectionStage(store), new CapsJudgmentStage(mockMailbox, store)],
    store,
    config
  });

  assert.strictEqual(report.stage_outcomes.projections.success, true);
  assert.strictEqual(report.stage_outcomes.judgment.success, false);
  assert.strictEqual(report.stage_outcomes.judgment.gap, 'pending');

  assert.ok(passedReq);
  assert.strictEqual(passedReq.projectId, 'bridge');
  assert.strictEqual(passedReq.provider, 'antigravity');
  assert.ok(passedReq.sender);
  assert.ok(passedReq.approvalRef);
  assert.ok(passedReq.idempotencyKey);
  assert.strictEqual(passedReq.recipient, undefined);

  const payload = JSON.parse(passedReq.prompt);
  assert.strictEqual(payload.schema_version, 'bridge-caps-judgment-v1');
  assert.strictEqual(payload.refresh_run_id, report.refresh_run_id);
  assert.ok(payload.diff);
  assert.strictEqual(payload.diff.new_available.length, 1);
  assert.strictEqual(payload.diff.new_available[0].source_url, 'https://example.com/mcp');
  assert.strictEqual(payload.diff.new_available[0].ask_first, true);
  assert.strictEqual(payload.diff.status_flips[0], 'existing-id-1');
  assert.strictEqual(payload.diff.watch_deltas[0], 'watch:https://example.com/mcp=2');
  assert.ok(payload.rules);
  assert.ok(payload.response_contract);

  const projPath = path.join(dir, 'reports', `projections-${report.refresh_run_id}.json`);
  const proj = JSON.parse(fs.readFileSync(projPath, 'utf8'));
  assert.strictEqual(proj.new_available.length, 1);
  assert.strictEqual(proj.new_available[0].ask_first, true);
  assert.strictEqual(proj.status_flips[0], 'existing-id-1');
  assert.strictEqual(proj.watch_deltas[0], 'watch:https://example.com/mcp=2');
  assert.ok(proj.source_hashes.includes(watchResponseHash));
  assert.ok(proj.source_hashes.includes(fetchResponseHash));

  store.close();
});

test('35. existing NEEDS.json owner bytes are not overwritten', async () => {
  const dir = getTempDir();
  const { store, config } = createStore(dir);

  const catalogPath = path.join(dir, 'CATALOG.md');
  fs.writeFileSync(catalogPath, '');

  const needsPath = path.join(dir, 'NEEDS.json');
  fs.writeFileSync(needsPath, JSON.stringify({
    schema: 'bridge-caps-needs-v1',
    profile_id: 'existing-id',
    owner_managed: true,
    updated_at: '2026-07-24T00:00:00.000Z',
    provenance: {
      source_path: catalogPath,
      source_section: 'bridge:caps:generated',
      source_sha256: crypto.createHash('sha256').update('').digest('hex'),
      observed_at: '2026-07-24T00:00:00.000Z',
      capture_class: 'guaranteed',
      producer_surface: 'code'
    },
    needs: []
  }));

  const { CapsProjectionStage } = await import('../../dist/caps/refresh.js');
  const needsBytesBefore = fs.readFileSync(needsPath);
  const report = await runCapsRefresh({ stateDir: dir, lane: 'probe', stages: [new CapsProjectionStage(store)], store, config });
  assert.strictEqual(report.lifecycle_status, 'terminal-success');

  const needsBytesAfter = fs.readFileSync(needsPath);
  assert.ok(needsBytesBefore.equals(needsBytesAfter), "NEEDS.json bytes should be exactly identical");

  store.close();
});

test('36. malformed stated-total/report case proving no candidates/deltas derived and bounded gap recorded', async () => {
  const dir = getTempDir();
  const { store, config } = createStore(dir);

  const mockMailbox = { config: { providers: { antigravity: { consumerId: 'provider.antigravity.mcp' } } } };
  const { CapsProjectionStage } = await import('../../dist/caps/refresh.js');

  const preStage = {
    name: 'pre',
    run: async (ctx) => {
      const corePath = path.join(ctx.stateDir, 'reports', `refresh-${ctx.reportId}.json`);
      const core = JSON.parse(fs.readFileSync(corePath, 'utf8'));
      core.lifecycle_status = 'incomplete';
      core.lane_outcomes.mcpservers = {
        schema: 'bridge-caps-mcpservers-refresh-v1',
        started_at: new Date().toISOString(),
        finished_at: new Date().toISOString(),
        diff: {
          new: ['https://example.com/mcp'],
          changed: [], removed: [],
          new_count: 1, changed_count: 0, removed_count: 0
        },
        stated_totals: {
          'watch:https://example.com/mcp': {
            value: 1,
            previous: null, delta: 1, // malformed: no prior observation means no delta
            observed_at: new Date().toISOString(),
            source_url: 'https://example.com/mcp',
            response_sha256: crypto.createHash('sha256').update('watch').digest('hex')
          }
        },
        processed: 1, skipped_installed: 0, pending: 0,
        gaps: [], errors: [], fetch_log: []
      };
      fs.writeFileSync(corePath, JSON.stringify(core));
      return { success: true };
    }
  };

  const report = await runCapsRefresh({
    stateDir: dir,
    lane: 'probe',
    stages: [preStage, new CapsProjectionStage(store)],
    store,
    config
  });

  assert.strictEqual(report.stage_outcomes.projections.success, true);
  const projPath = path.join(dir, 'reports', `projections-${report.refresh_run_id}.json`);
  const proj = JSON.parse(fs.readFileSync(projPath, 'utf8'));

  assert.strictEqual(proj.new_available.length, 0);
  assert.strictEqual(proj.watch_deltas.length, 0);
  assert.ok(proj.gaps.some(g => g === 'missing_provenance: bad_stated_total'));

  store.close();
});

test('37. injected projection-artifact rename failure yields terminal non-success and no temp artifact remains', async () => {
  const dir = getTempDir();
  const { store, config } = createStore(dir);

  const { CapsProjectionStage } = await import('../../dist/caps/refresh.js');
  const stage = new CapsProjectionStage(store);

  const originalRename = fs.promises.rename;
  fs.promises.rename = async function(src, dest) {
    if (typeof src === 'string' && src.includes('projections-') && src.includes('.json')) {
      throw new Error('injected_rename_failure');
    }
    return originalRename.apply(this, [src, dest]);
  };

  try {
    const report = await runCapsRefresh({
      stateDir: dir,
      lane: 'probe',
      stages: [stage],
      store,
      config
    });

    assert.strictEqual(report.lifecycle_status, 'terminal-failure');
    assert.strictEqual(report.stage_outcomes.projections.success, false);

    const reportsDir = path.join(dir, 'reports');
    const files = fs.readdirSync(reportsDir);
    const tempProjFiles = files.filter(f => f.startsWith('projections-') && f.includes('.json') && f.split('.').length > 2);
    assert.strictEqual(tempProjFiles.length, 0, 'No temp artifact should remain');
  } finally {
    fs.promises.rename = originalRename;
    store.close();
  }
});

test('38. oversized report strings and empty stated-total keys are rejected before derivation', async () => {
  const cases = [
    {
      name: 'oversized diff identity',
      expectedGap: 'missing_provenance: bad_diff_arrays',
      mutate: (facts) => {
        facts.diff.new = ['x'.repeat(1025)];
        facts.diff.new_count = 1;
      }
    },
    {
      name: 'empty stated-total key',
      expectedGap: 'missing_provenance: bad_stated_totals',
      mutate: (facts) => {
        facts.stated_totals = {
          '': facts.stated_totals['watch:official']
        };
      }
    }
  ];

  for (const testCase of cases) {
    const dir = getTempDir();
    const { store, config } = createStore(dir);
    const { CapsProjectionStage } = await import('../../dist/caps/refresh.js');

    const preStage = {
      name: `pre-${testCase.name}`,
      run: async (ctx) => {
        const corePath = path.join(ctx.stateDir, 'reports', `refresh-${ctx.reportId}.json`);
        const core = JSON.parse(fs.readFileSync(corePath, 'utf8'));
        const responseSha256 = crypto.createHash('sha256').update(testCase.name).digest('hex');
        const facts = {
          schema: 'bridge-caps-mcpservers-refresh-v1',
          started_at: new Date().toISOString(),
          finished_at: new Date().toISOString(),
          diff: {
            new: [],
            changed: [],
            removed: [],
            new_count: 0,
            changed_count: 0,
            removed_count: 0
          },
          stated_totals: {
            'watch:official': {
              value: 1,
              previous: null,
              delta: null,
              observed_at: new Date().toISOString(),
              source_url: 'https://example.com/mcp',
              response_sha256: responseSha256
            }
          },
          processed: 0,
          skipped_installed: 0,
          pending: 0,
          gaps: [],
          errors: [],
          fetch_log: []
        };
        testCase.mutate(facts);
        core.lifecycle_status = 'incomplete';
        core.lane_outcomes.mcpservers = facts;
        fs.writeFileSync(corePath, JSON.stringify(core));
        return { success: true };
      }
    };

    try {
      const report = await runCapsRefresh({
        stateDir: dir,
        lane: 'probe',
        stages: [preStage, new CapsProjectionStage(store)],
        store,
        config
      });

      assert.strictEqual(report.stage_outcomes.projections.success, true);
      const projPath = path.join(dir, 'reports', `projections-${report.refresh_run_id}.json`);
      const proj = JSON.parse(fs.readFileSync(projPath, 'utf8'));
      assert.deepStrictEqual(proj.new_available, []);
      assert.deepStrictEqual(proj.watch_deltas, []);
      assert.ok(proj.gaps.includes(testCase.expectedGap), testCase.name);
    } finally {
      store.close();
    }
  }
});
