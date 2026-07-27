import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { DatabaseSync } from "node:sqlite";
import { MigrationManager, sha256 } from "../../dist/v2/index.js";

const appliedAt = "2026-07-15T12:00:00.000Z";
const migrationId = "migration.001.portable";
const lfSql = [
  "CREATE TABLE portable_migration(",
  "  id TEXT PRIMARY KEY",
  ") STRICT;",
  "",
].join("\n");
const crlfSql = lfSql.replace(/\n/gu, "\r\n");

function checksum(sql) {
  return sha256(Buffer.from(sql, "utf8"));
}

function withMigration(sql, callback) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "bridge2-migration-checksum-"));
  const migrationsDir = path.join(root, "migrations");
  const databasePath = path.join(root, "state.sqlite");
  fs.mkdirSync(migrationsDir);
  fs.writeFileSync(path.join(migrationsDir, "001_portable.sql"), sql);
  const database = new DatabaseSync(databasePath);
  const manager = new MigrationManager(database, migrationsDir, () => appliedAt);
  manager.bootstrap();
  try {
    callback({ database, manager });
  } finally {
    database.close();
    fs.rmSync(root, { recursive: true, force: true });
  }
}

function recordLegacyMigration(database, storedChecksum) {
  database.prepare(
    "INSERT INTO schema_migrations(version, migration_id, checksum, applied_at) VALUES (?, ?, ?, ?)",
  ).run(1, migrationId, storedChecksum, appliedAt);
}

for (const fixture of [
  { label: "LF-created database against a CRLF checkout", storedSql: lfSql, packagedSql: crlfSql },
  { label: "CRLF-created database against an LF checkout", storedSql: crlfSql, packagedSql: lfSql },
]) {
  test(`migration verification accepts a legacy ${fixture.label}`, () => {
    withMigration(fixture.packagedSql, ({ database, manager }) => {
      recordLegacyMigration(database, checksum(fixture.storedSql));
      assert.deepEqual(manager.verify(), { currentVersion: 1, pending: 0, checksumsValid: true });
    });
  });
}

test("newly applied migrations store the canonical LF checksum", () => {
  withMigration(crlfSql, ({ database, manager }) => {
    const applied = manager.apply();
    const row = database.prepare(
      "SELECT checksum FROM schema_migrations WHERE version = 1",
    ).get();

    assert.equal(applied.length, 1);
    assert.equal(applied[0].checksum, checksum(lfSql));
    assert.equal(row.checksum, checksum(lfSql));
    assert.notEqual(row.checksum, checksum(crlfSql));
    assert.equal(database.prepare(
      "SELECT COUNT(*) AS count FROM sqlite_schema WHERE type = 'table' AND name = 'portable_migration'",
    ).get().count, 1);
  });
});

test("migration verification still rejects real content drift", () => {
  const changedSql = lfSql.replace("id TEXT PRIMARY KEY", "changed_id TEXT PRIMARY KEY");
  withMigration(changedSql, ({ database, manager }) => {
    recordLegacyMigration(database, checksum(lfSql));
    assert.throws(() => manager.verify(), /migration_checksum_mismatch/u);
  });
});

test("line-ending changes inside a multiline SQL literal remain semantic drift", () => {
  const literalLfSql = "CREATE TABLE literal_value(value TEXT);\nINSERT INTO literal_value VALUES ('a\nb');\n";
  const literalCrLfSql = literalLfSql.replace(/\n/gu, "\r\n");
  withMigration(literalCrLfSql, ({ database, manager }) => {
    recordLegacyMigration(database, checksum(literalLfSql));
    assert.throws(() => manager.verify(), /migration_checksum_mismatch/u);
  });
});

for (const fixture of [
  {
    label: "mixed line endings",
    sql: "CREATE TABLE mixed_eol(\r\n  id TEXT PRIMARY KEY\n) STRICT;\r\n",
  },
  {
    label: "a bare CR",
    sql: "CREATE TABLE bare_cr(\r  id TEXT PRIMARY KEY\r) STRICT;\r",
  },
]) {
  test(`migration verification accepts an exact legacy file with ${fixture.label}`, () => {
    withMigration(fixture.sql, ({ database, manager }) => {
      recordLegacyMigration(database, checksum(fixture.sql));
      assert.deepEqual(manager.verify(), { currentVersion: 1, pending: 0, checksumsValid: true });
    });
  });
}
