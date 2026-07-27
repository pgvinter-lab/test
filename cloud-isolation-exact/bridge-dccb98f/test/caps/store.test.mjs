import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { DatabaseSync } from "node:sqlite";
import { CapsStore } from "../../dist/caps/store.js";
import { defaultCapsStateDirectory } from "../../dist/caps/config.js";

test("CapsStore offline schema and behavior", async (t) => {
  const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), "bridge2-caps-test-"));
  const dbPath = path.join(tempDir, "caps.sqlite");
  const config = { stateDirectory: tempDir, databasePath: dbPath };

  // Ensure migrations dir exists for the test if it runs from project root
  const migrationsDir = fileURLToPath(new URL("../../migrations/caps", import.meta.url));
  assert.ok(fs.existsSync(migrationsDir), "Migrations directory must exist");

  let store;

  t.after(() => {
    if (store) store.close();
    fs.rmSync(tempDir, { recursive: true, force: true });
  });

  await t.test("Initializes and applies migrations with WAL mode", () => {
    store = new CapsStore(config);
    const mode = store.db.prepare("PRAGMA journal_mode;").get();
    assert.equal(mode.journal_mode.toLowerCase(), "wal");
    const integrity = store.db.prepare("PRAGMA integrity_check;").get();
    assert.equal(integrity.integrity_check, "ok");
  });

  await t.test("Schema constraints and strict tables", () => {
    // Check tables exist
    const tables = store.db.prepare("SELECT name FROM sqlite_master WHERE type='table' AND name IN ('installed_working', 'installed_broken', 'available_for_install')").all();
    assert.equal(tables.length, 3, "Must have exactly 3 owner tables");

    // Test JSON constraint
    assert.throws(() => {
      store.db.prepare(`
        INSERT INTO installed_working (
          id, kind, name, slug, surface_owner, transport, pricing, official, source_lane, producer_surface, capture_class, observed_at, last_verified, stale_at, provenance_json
        ) VALUES (
          'test1', 'server', 't1', 't1', 'agy', 'stdio', 'free', 0, 'probe', 'antigravity', 'observed', '2026-07-24T00:00:00Z', '2026-07-24T00:00:00Z', '2026-07-25T00:00:00Z', 'invalid-json'
        )
      `).run();
    }, /CHECK constraint failed/);

    // Test Pricing constraint
    assert.throws(() => {
      store.db.prepare(`
        INSERT INTO installed_working (
          id, kind, name, slug, surface_owner, transport, pricing, official, source_lane, producer_surface, capture_class, observed_at, last_verified, stale_at, provenance_json
        ) VALUES (
          'test1', 'server', 't1', 't1', 'agy', 'stdio', 'very-expensive', 0, 'probe', 'antigravity', 'observed', '2026-07-24T00:00:00Z', '2026-07-24T00:00:00Z', '2026-07-25T00:00:00Z', '{"test":1}'
        )
      `).run();
    }, /CHECK constraint failed/);

    // Config presence is installation evidence only. Package 02 records these
    // rows as verification_pending with no fabricated verification timestamp.
    store.db.prepare(`
      INSERT INTO installed_broken (
        id, kind, name, slug, surface_owner, transport, pricing, official,
        source_lane, producer_surface, capture_class, observed_at,
        last_verified, stale_at, provenance_json, failure_reason,
        failure_observed_at
      ) VALUES (
        'pending-null', 'server', 'Pending', 'pending', 'agy', 'stdio',
        'unknown', 0, 'config-crawl', 'antigravity', 'guaranteed',
        '2026-07-24T00:00:00Z', NULL, '2026-07-24T00:00:00Z',
        '{"source":"config"}', 'verification_pending',
        '2026-07-24T00:00:00Z'
      )
    `).run();
    const pending = store.db.prepare(
      "SELECT last_verified, failure_reason FROM installed_broken WHERE id = 'pending-null'",
    ).get();
    assert.equal(pending.last_verified, null);
    assert.equal(pending.failure_reason, "verification_pending");
    store.db.prepare("DELETE FROM installed_broken WHERE id = 'pending-null'").run();
  });

  await t.test("Forward migration preserves existing broken rows and relaxes only verification time", () => {
    const upgradeDir = fs.mkdtempSync(path.join(os.tmpdir(), "bridge2-caps-upgrade-"));
    const upgradePath = path.join(upgradeDir, "caps.sqlite");
    let migrated;
    try {
      const legacy = new DatabaseSync(upgradePath);
      legacy.exec("CREATE TABLE _caps_migrations (version INTEGER PRIMARY KEY, checksum TEXT);");
      legacy.exec(fs.readFileSync(path.join(migrationsDir, "001_caps_store.sql"), "utf8"));
      legacy.prepare("INSERT INTO _caps_migrations (version, checksum) VALUES (1, 'legacy-test')").run();
      legacy.prepare(`
        INSERT INTO installed_broken (
          id, kind, name, slug, surface_owner, transport, pricing, official,
          source_lane, producer_surface, capture_class, observed_at,
          last_verified, stale_at, curated_notes, provenance_json,
          failure_reason, failure_observed_at
        ) VALUES (
          'legacy-broken', 'server', 'Legacy Broken', 'legacy-broken', 'agy',
          'stdio', 'unknown', 0, 'probe', 'antigravity', 'observed',
          '2026-07-23T00:00:00Z', '2026-07-23T00:00:00Z',
          '2026-07-24T00:00:00Z', 'preserve me', '{"source":"probe"}',
          'timeout', '2026-07-23T00:00:00Z'
        )
      `).run();
      legacy.close();

      migrated = new CapsStore({ stateDirectory: upgradeDir, databasePath: upgradePath });
      assert.equal(migrated.db.prepare("SELECT MAX(version) AS version FROM _caps_migrations").get().version, 2);
      const retained = migrated.db.prepare(
        "SELECT curated_notes, failure_reason, last_verified FROM installed_broken WHERE id = 'legacy-broken'",
      ).get();
      assert.equal(retained.curated_notes, "preserve me");
      assert.equal(retained.failure_reason, "timeout");
      assert.equal(retained.last_verified, "2026-07-23T00:00:00Z");
      migrated.db.prepare(`
        INSERT INTO installed_broken (
          id, kind, name, slug, surface_owner, transport, pricing, official,
          source_lane, producer_surface, capture_class, observed_at,
          last_verified, stale_at, provenance_json, failure_reason,
          failure_observed_at
        ) VALUES (
          'upgrade-pending', 'server', 'Pending', 'upgrade-pending', 'agy',
          'stdio', 'unknown', 0, 'config-crawl', 'antigravity', 'guaranteed',
          '2026-07-24T00:00:00Z', NULL, '2026-07-24T00:00:00Z',
          '{"source":"config"}', 'verification_pending',
          '2026-07-24T00:00:00Z'
        )
      `).run();
      assert.equal(
        migrated.db.prepare("SELECT last_verified FROM installed_broken WHERE id = 'upgrade-pending'").get().last_verified,
        null,
      );
      assert.ok(fs.readdirSync(path.join(upgradeDir, "backup")).some((file) => file.endsWith(".manifest.txt")));
    } finally {
      migrated?.close();
      fs.rmSync(upgradeDir, { recursive: true, force: true });
    }
  });

  await t.test("Idempotent upserts and curated_note preservation", () => {
    const data = {
      id: 'caps1', kind: 'server', name: 'Caps Test', slug: 'caps-test', source_url: null,
      surface_owner: 'agy', transport: 'stdio', description: 'desc', pricing: 'free', official: 0,
      stars: null, install_command: null, source_lane: 'probe', producer_surface: 'antigravity',
      capture_class: 'observed', observed_at: '2026-07-24T00:00:00Z', last_verified: '2026-07-24T00:00:00Z',
      stale_at: '2026-07-25T00:00:00Z', curated_notes: 'User note 1', tools_json: null, detail_json: null,
      provenance_json: '{"source":"test"}', raw_json: null
    };

    store.upsertCapability('installed_working', data);

    // Update with machine-generated changes and try to overwrite note
    const updatedData = { ...data, description: 'desc2', curated_notes: 'Should not overwrite' };
    store.upsertCapability('installed_working', updatedData);

    const row = store.db.prepare("SELECT * FROM installed_working WHERE id = 'caps1'").get();
    // According to F2: reusing an observation ID with changed canonical content updates machine fields only
    assert.equal(row.description, 'desc'); // Not updated because canonical hash changed
    assert.equal(row.curated_notes, 'User note 1'); // Preserved
  });

  await t.test("Atomic state moves (working to broken and back)", () => {
    store.moveWorkingToBroken('caps1', {
      source_lane: 'probe',
      failure_reason: 'Timeout',
      failure_observed_at: '2026-07-24T01:00:00Z',
      provenance_json: '{"source":"probe-fail"}'
    });

    assert.equal(store.db.prepare("SELECT count(*) as c FROM installed_working").get().c, 0);
    const broken = store.db.prepare("SELECT * FROM installed_broken WHERE id = 'caps1'").get();
    assert.equal(broken.failure_reason, 'Timeout');
    assert.equal(broken.curated_notes, 'User note 1'); // Note preserved during move

    store.moveBrokenToWorking('caps1', {
      source_lane: 'census',
      failure_observed_at: '2026-07-24T02:00:00Z',
      provenance_json: '{"source":"census-ok"}'
    });

    assert.equal(store.db.prepare("SELECT count(*) as c FROM installed_broken").get().c, 0);
    assert.equal(store.db.prepare("SELECT count(*) as c FROM installed_working").get().c, 1);
  });

  await t.test("Atomic state move (available to installed)", () => {
    const data = {
      id: 'caps2', kind: 'server', name: 'Caps Avail', slug: 'caps-avail', source_url: null,
      surface_owner: 'n/a', transport: 'http', description: 'desc', pricing: 'paid', official: 0,
      stars: null, install_command: 'npm install -g caps-avail', source_lane: 'mcpservers-search', producer_surface: 'external-index',
      capture_class: 'observed', observed_at: '2026-07-24T00:00:00Z', last_verified: '2026-07-24T00:00:00Z',
      stale_at: '2026-07-25T00:00:00Z', curated_notes: 'My note', tools_json: null, detail_json: null,
      provenance_json: '{"source":"search"}', raw_json: null, category: 'dev', detail_fetched_at: null,
      judgment_model: null, judgment_at: null, judgment_verdict: null, judgment_reason: null, judgment_surface: null
    };

    store.upsertCapability('available_for_install', data);

    store.moveAvailableToInstalled('caps-avail', 'npm install -g caps-avail', 'installed_working', {
      source_lane: 'probe',
      surface_owner: 'agy',
      last_verified: '2026-07-24T03:00:00Z',
      provenance_json: '{"source":"installed"}'
    });

    assert.equal(store.db.prepare("SELECT count(*) as c FROM available_for_install").get().c, 0);
    const installed = store.db.prepare("SELECT * FROM installed_working WHERE id = 'caps2'").get();
    assert.equal(installed.surface_owner, 'agy');
    assert.equal(installed.pricing, 'paid');
    assert.equal(installed.curated_notes, 'My note');
  });

  await t.test("FTS index rebuild and search", () => {
    store.searchIndex.rebuildIndex();

    // Normal search
    const results = store.searchIndex.search("caps");
    assert.ok(results.length >= 2, "Should find caps1 and caps2");

    // Test LIKE fallback explicitly
    // Force hasFts5 to false
    store.searchIndex.hasFts5 = false;
    const fallbackResults = store.searchIndex.search("caps");
    assert.ok(fallbackResults.length >= 2, "Fallback should find caps1 and caps2");

    // Test escaping in fallback
    const escapedResults = store.searchIndex.search("caps%");
    assert.equal(escapedResults.length, 0, "Should not find literal caps%");
  });

  await t.test("Idempotency and canonical hash updates", () => {
    const data = {
      id: 'caps3', kind: 'server', name: 'Original Name', slug: 'orig', source_url: null,
      surface_owner: 'agy', transport: 'stdio', description: 'desc', pricing: 'free', official: 0,
      stars: null, install_command: null, source_lane: 'probe', producer_surface: 'antigravity',
      capture_class: 'observed', observed_at: '2026-07-24T00:00:00Z', last_verified: '2026-07-24T00:00:00Z',
      stale_at: '2026-07-25T00:00:00Z', curated_notes: 'My note', tools_json: null, detail_json: null,
      provenance_json: '{"source":"test"}', raw_json: null
    };

    // First insert with idempotency key
    store.upsertCapability('installed_working', data, 'idempotency_key_1');

    // Attempt with same key but different canonical content -> fails closed
    const changedData = { ...data, name: 'Changed Name' };
    assert.throws(() => {
      store.upsertCapability('installed_working', changedData, 'idempotency_key_1');
    }, /idempotency_mismatch/);

    // Attempt with same key and same canonical content -> succeeds
    store.upsertCapability('installed_working', data, 'idempotency_key_1');

    // Attempt with NO idempotency key, but changed canonical content
    // -> Should only update machine fields
    const newMachineData = {
      ...changedData,
      last_verified: '2026-07-25T00:00:00Z' // updated machine field
    };
    store.upsertCapability('installed_working', newMachineData);

    const row = store.db.prepare("SELECT * FROM installed_working WHERE id = 'caps3'").get();

    // Non-machine field 'name' should remain the original, since canonical content changed and it was an update
    assert.equal(row.name, 'Original Name');
    // Machine field should be updated
    assert.equal(row.last_verified, '2026-07-25T00:00:00Z');
  });
});
