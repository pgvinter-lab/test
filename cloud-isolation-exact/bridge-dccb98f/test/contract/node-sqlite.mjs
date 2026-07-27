import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { DatabaseSync } from "node:sqlite";

const tempRoot = fs.mkdtempSync(path.join(os.tmpdir(), "bridge2-node-sqlite-"));
const databasePath = path.join(tempRoot, "contract.sqlite");

let hasFts5 = false;

try {
  const database = new DatabaseSync(databasePath);
  const journalMode = database.prepare("PRAGMA journal_mode = WAL").get().journal_mode;
  assert.equal(String(journalMode).toLowerCase(), "wal");
  database.exec(`
    PRAGMA foreign_keys = ON;
    CREATE TABLE state (
      id TEXT PRIMARY KEY,
      value TEXT NOT NULL
    ) STRICT;
    CREATE TABLE events (
      sequence INTEGER PRIMARY KEY,
      event_id TEXT NOT NULL UNIQUE
    ) STRICT;
  `);
  database.exec("BEGIN IMMEDIATE");
  database.prepare("INSERT INTO state (id, value) VALUES (?, ?)").run("state.001", "before-rollback");
  database.prepare("INSERT INTO events (sequence, event_id) VALUES (?, ?)").run(1, "event.001");
  database.exec("ROLLBACK");
  assert.equal(database.prepare("SELECT COUNT(*) AS count FROM state").get().count, 0);
  assert.equal(database.prepare("SELECT COUNT(*) AS count FROM events").get().count, 0);
  assert.equal(database.prepare("PRAGMA integrity_check").get().integrity_check, "ok");

  // Feature-detect FTS5
  try {
    database.exec("CREATE VIRTUAL TABLE fts_test USING fts5(text_col);");
    database.prepare("INSERT INTO fts_test (text_col) VALUES (?)").run("hello world");
    const count = database.prepare("SELECT COUNT(*) AS count FROM fts_test WHERE fts_test MATCH 'hello'").get().count;
    hasFts5 = count === 1;
  } catch (e) {
    console.warn("FTS5 not available:", e.message);
  }

  database.close();
} finally {
  fs.rmSync(tempRoot, { recursive: true, force: true });
}

console.log(`NODE:SQLITE CONTRACT PASSED: built-in DatabaseSync, WAL, atomic rollback, integrity check. FTS5 available: ${hasFts5}`);
