import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { DatabaseSync } from "node:sqlite";
import { invariant } from "../core/errors.js";
import { canonicalize, hashEvent } from "../core/canonical.js";
import { ContractSchemaRegistry } from "../core/schema-registry.js";

const EXAMPLE_SCHEMAS: Record<string, string> = {
  "adapter.valid.json": "adapter.schema.json",
  "approval-grant.valid.json": "approval-grant.schema.json",
  "artifact.valid.json": "artifact.schema.json",
  "audit-mirror-entry.valid.json": "audit-mirror-entry.schema.json",
  "backup-manifest.valid.json": "backup-manifest.schema.json",
  "doctor.valid.json": "doctor.schema.json",
  "event.valid.json": "event.schema.json",
  "migration.valid.json": "migration.schema.json",
  "principal.valid.json": "principal.schema.json",
  "restore-manifest.valid.json": "restore-manifest.schema.json",
  "review-job.valid.json": "review-job.schema.json",
};

export interface ContractCompatibilityResult {
  ok: true;
  validatedExamples: number;
  nodeSqlite: "passed";
  frozenEventHash: "passed";
  unicodeScalarOrdering: "passed";
}

/**
 * Runs the packaged, executable compatibility gate used during isolated
 * recovery. It deliberately validates the installed Bridge runtime contract,
 * not the restored project repository (ordinary projects do not vendor Bridge
 * schemas or test fixtures).
 */
export function verifyPackagedContractCompatibility(packageRoot: string): ContractCompatibilityResult {
  const contractRoot = path.join(path.resolve(packageRoot), "contracts", "v0.1.0-draft.4");
  const schemaDirectory = path.join(contractRoot, "schemas");
  const exampleDirectory = path.join(contractRoot, "examples");
  invariant(fs.existsSync(path.join(contractRoot, "README.md")), "restored_contract_readme_missing");
  const registry = new ContractSchemaRegistry(schemaDirectory);
  let validatedExamples = 0;
  for (const [exampleName, schemaName] of Object.entries(EXAMPLE_SCHEMAS)) {
    const examplePath = path.join(exampleDirectory, exampleName);
    invariant(fs.existsSync(examplePath), "restored_contract_example_missing", { exampleName });
    registry.validateNamed(schemaName, JSON.parse(fs.readFileSync(examplePath, "utf8")));
    validatedExamples += 1;
  }

  const event = JSON.parse(fs.readFileSync(path.join(exampleDirectory, "event.valid.json"), "utf8")) as
    Record<string, unknown> & { hash: string };
  invariant(hashEvent(event) === event.hash, "packaged_contract_event_hash_mismatch");
  const scalarVector = canonicalize({ "\u{1F600}": "supplementary", "\uE000": "bmp-private-use" });
  invariant(
    scalarVector === `{${JSON.stringify("\uE000")}:"bmp-private-use",${JSON.stringify("\u{1F600}")}:"supplementary"}`,
    "packaged_contract_unicode_scalar_order_mismatch",
  );
  verifyNodeSqliteContract();
  return {
    ok: true,
    validatedExamples,
    nodeSqlite: "passed",
    frozenEventHash: "passed",
    unicodeScalarOrdering: "passed",
  };
}

/** Backward-compatible alias; the argument is the Bridge package root. */
export const verifyRestoredContractSurface = verifyPackagedContractCompatibility;

function verifyNodeSqliteContract(): void {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "bridge2-recovery-contract-"));
  const databasePath = path.join(root, "contract.sqlite");
  let database: DatabaseSync | undefined;
  try {
    database = new DatabaseSync(databasePath);
    const mode = database.prepare("PRAGMA journal_mode = WAL").get() as { journal_mode: string };
    invariant(String(mode.journal_mode).toLowerCase() === "wal", "packaged_contract_wal_unavailable");
    database.exec(`
      PRAGMA foreign_keys = ON;
      CREATE TABLE contract_probe(id TEXT PRIMARY KEY, value TEXT NOT NULL) STRICT;
      BEGIN IMMEDIATE;
      INSERT INTO contract_probe(id, value) VALUES ('probe.1', 'rollback');
      ROLLBACK;
    `);
    const count = database.prepare("SELECT COUNT(*) AS count FROM contract_probe").get() as { count: number };
    const integrity = database.prepare("PRAGMA integrity_check").get() as { integrity_check: string };
    invariant(Number(count.count) === 0, "packaged_contract_transaction_rollback_failed");
    invariant(integrity.integrity_check === "ok", "packaged_contract_sqlite_integrity_failed");
  } finally {
    database?.close();
    fs.rmSync(root, { recursive: true, force: true });
  }
}
