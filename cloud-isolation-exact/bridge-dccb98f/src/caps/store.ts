import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import crypto from "node:crypto";
import { DatabaseSync } from "node:sqlite";
import { invariant } from "../v2/core/errors.js";
import type { CapsConfig } from "./config.js";
import { CapsSearchIndex } from "./search-index.js";
import type { CapabilityBase, InstalledWorking, InstalledBroken, AvailableForInstall, SourceLane } from "./types.js";
import { PricingSortTier } from "./types.js";

export class CapsStore {
  public db: DatabaseSync;
  public searchIndex: CapsSearchIndex;
  private _inTransaction = false;

  private transaction<T>(fn: () => T): T {
    if (this._inTransaction) return fn();
    this.db.exec("BEGIN IMMEDIATE");
    this._inTransaction = true;
    try {
      const res = fn();
      this.db.exec("COMMIT");
      this._inTransaction = false;
      return res;
    } catch (e) {
      this.db.exec("ROLLBACK");
      this._inTransaction = false;
      throw e;
    }
  }

  constructor(private readonly config: CapsConfig) {
    const isNew = !fs.existsSync(config.databasePath);
    this.db = new DatabaseSync(config.databasePath);
    this.db.exec("PRAGMA journal_mode = WAL;");
    this.db.exec("PRAGMA foreign_keys = ON;");

    // Integrity check
    const integrity = this.db.prepare("PRAGMA integrity_check;").get() as { integrity_check: string };
    invariant(integrity.integrity_check === "ok", "caps_db_integrity_check_failed");

    this.applyMigrations(isNew);
    this.db.exec(`
      CREATE TABLE IF NOT EXISTS _caps_census_receipts (
        report_id TEXT PRIMARY KEY NOT NULL,
        canonical_hash TEXT NOT NULL,
        caller_provenance TEXT NOT NULL,
        observed_at TEXT NOT NULL,
        result_summary TEXT NOT NULL
      ) STRICT;
    `);

    this.searchIndex = new CapsSearchIndex(this.db);
    // Note: FTS index rebuilding is usually triggered by a refresh or backfill
    // To ensure consistency, we'll expose a method to rebuild it.
  }

  public getConfig(): CapsConfig {
    return { ...this.config };
  }

  private applyMigrations(isNew: boolean) {
    this.db.exec("CREATE TABLE IF NOT EXISTS _caps_migrations (version INTEGER PRIMARY KEY, checksum TEXT);");
    const currentVersionRow = this.db.prepare("SELECT MAX(version) as v FROM _caps_migrations").get() as { v: number | null };
    const currentVersion = currentVersionRow.v ?? 0;

    const migrationsDir = fileURLToPath(new URL("../../migrations/caps", import.meta.url));
    if (!fs.existsSync(migrationsDir)) return;

    const files = fs.readdirSync(migrationsDir)
      .filter(f => f.endsWith('.sql'))
      .sort();

    for (const file of files) {
      const match = file.match(/^(\d+)_/);
      if (!match) continue;
      const version = parseInt(match[1], 10);
      if (version <= currentVersion) continue;

      if (!isNew && version > currentVersion) {
        this.backupDatabase(`pre-migration-${version}`);
      }

      const sql = fs.readFileSync(path.join(migrationsDir, file), "utf8");

      const checksum = crypto.createHash("sha256").update(Buffer.from(sql.replace(/\r\n/g, "\n"), "utf8")).digest("hex");

      this.db.exec("BEGIN IMMEDIATE");
      try {
        this.db.exec(sql);
        this.db.prepare("INSERT INTO _caps_migrations (version, checksum) VALUES (?, ?)").run(version, checksum);
        this.db.exec("COMMIT");
      } catch (err) {
        this.db.exec("ROLLBACK");
        throw err;
      }
    }
  }

  public backupDatabase(label: string) {
    const backupDir = path.join(this.config.stateDirectory, "backup");
    fs.mkdirSync(backupDir, { recursive: true });

    // Copy DB, WAL, SHM consistently
    const ts = new Date().toISOString().replace(/[:.]/g, "-");
    const prefix = `caps-${ts}-${label}`;

    for (const ext of ["", "-wal", "-shm"]) {
      const src = `${this.config.databasePath}${ext}`;
      if (fs.existsSync(src)) {
        fs.copyFileSync(src, path.join(backupDir, `${prefix}.sqlite${ext}`));
      }
    }

    // Write hash manifest
    const dbHash = crypto.createHash("sha256").update(fs.readFileSync(this.config.databasePath)).digest("hex");
    fs.writeFileSync(path.join(backupDir, `${prefix}.manifest.txt`), `db: ${dbHash}\n`, "utf8");
  }

  public close() {
    this.db.close();
  }

  public upsertCapability(table: 'installed_working' | 'installed_broken' | 'available_for_install', data: CapabilityBase & Record<string, any>, idempotencyKey?: string) {
    this.transaction(() => {
      const canonicalFields = ['kind', 'name', 'slug', 'source_url', 'surface_owner', 'transport', 'description', 'pricing', 'official', 'stars', 'install_command', 'source_lane', 'producer_surface', 'capture_class', 'tools_json', 'detail_json'];
      const canonicalObj: any = {};
      for (const k of canonicalFields) canonicalObj[k] = data[k] ?? null;
      const canonicalHash = crypto.createHash('sha256').update(JSON.stringify(canonicalObj)).digest('hex');

      if (idempotencyKey) {
        const idemp = this.db.prepare("SELECT canonical_hash FROM _caps_idempotency WHERE idempotency_key = ?").get(idempotencyKey) as { canonical_hash: string } | undefined;
        if (idemp) {
          if (idemp.canonical_hash !== canonicalHash) throw new Error("idempotency_mismatch");
        } else {
          this.db.prepare("INSERT INTO _caps_idempotency (idempotency_key, canonical_hash) VALUES (?, ?)").run(idempotencyKey, canonicalHash);
        }
      }

      const existing = this.db.prepare(`SELECT * FROM ${table} WHERE id = ?`).get(data.id) as any;
      const curated_notes = existing ? existing.curated_notes : data.curated_notes;

      const machineFields = ['last_verified', 'stale_at', 'observed_at', 'provenance_json', 'raw_json', 'failure_reason', 'failure_observed_at'];
      const allowedColumns = ['id', ...canonicalFields, ...machineFields, 'curated_notes'];

      if (existing) {
        const rowObj: any = {};
        for (const k of canonicalFields) rowObj[k] = existing[k] ?? null;
        const existingHash = crypto.createHash('sha256').update(JSON.stringify(rowObj)).digest('hex');

        let toUpdate: string[];
        if (existingHash !== canonicalHash) {
          toUpdate = machineFields.filter(c => c in data);
        } else {
          toUpdate = allowedColumns.filter(c => c in data && c !== 'id' && c !== 'curated_notes');
        }

        // Filter out columns not in table schema by checking existing keys
        toUpdate = toUpdate.filter(c => c in existing);

        if (toUpdate.length > 0) {
          const sets = toUpdate.map(c => `${c} = ?`).join(', ');
          const values = toUpdate.map(c => data[c]);
          this.db.prepare(`UPDATE ${table} SET ${sets} WHERE id = ?`).run(...values, data.id);
        }
      } else {
        const tableInfo = this.db.prepare(`PRAGMA table_info(${table})`).all() as any[];
        const validCols = new Set(tableInfo.map(c => c.name));

        const toInsert = allowedColumns.filter(c => (c in data || c === 'curated_notes') && validCols.has(c));
        const placeholders = toInsert.map(() => '?').join(', ');
        const values = toInsert.map(c => c === 'curated_notes' ? curated_notes : data[c]);
        this.db.prepare(`INSERT INTO ${table} (${toInsert.join(', ')}) VALUES (${placeholders})`).run(...values);
      }

      this.searchIndex.deleteRow(data.id);
      this.searchIndex.insertRow(table, {
        id: data.id,
        name: data.name,
        slug: data.slug,
        description: data.description,
        curated_notes: curated_notes
      });
    });
  }

  public moveWorkingToBroken(id: string, evidence: { source_lane: 'probe' | 'census', failure_reason: string, failure_observed_at: string, provenance_json: string }) {
    invariant(evidence.source_lane === 'probe' || evidence.source_lane === 'census', "caps_move_requires_evidence");
    this.transaction(() => {
      const source = this.db.prepare("SELECT * FROM installed_working WHERE id = ?").get(id) as unknown as InstalledWorking;
      if (!source) throw new Error("not_found");

      this.db.prepare(`
        INSERT INTO installed_broken (
          id, kind, name, slug, source_url, surface_owner, transport, description, pricing, official, stars,
          install_command, source_lane, producer_surface, capture_class, observed_at, last_verified, stale_at,
          curated_notes, tools_json, detail_json, provenance_json, raw_json, failure_reason, failure_observed_at
        ) VALUES (
          ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?,
          ?, ?, ?, ?, ?, ?, ?,
          ?, ?, ?, ?, ?, ?, ?
        )
      `).run(
        source.id, source.kind, source.name, source.slug, source.source_url, source.surface_owner, source.transport, source.description, source.pricing, source.official, source.stars,
        source.install_command, evidence.source_lane, source.producer_surface, source.capture_class, source.observed_at, evidence.failure_observed_at, source.stale_at,
        source.curated_notes, source.tools_json, source.detail_json, evidence.provenance_json, source.raw_json, evidence.failure_reason, evidence.failure_observed_at
      );

      this.db.prepare("DELETE FROM installed_working WHERE id = ?").run(id);

      this.searchIndex.deleteRow(id);
      this.searchIndex.insertRow('installed_broken', {
        id: source.id,
        name: source.name,
        slug: source.slug,
        description: source.description,
        curated_notes: source.curated_notes
      });
    });
  }

  public moveBrokenToWorking(id: string, evidence: { source_lane: 'probe' | 'census', failure_observed_at: string, provenance_json: string }) {
    invariant(evidence.source_lane === 'probe' || evidence.source_lane === 'census', "caps_move_requires_evidence");
    this.transaction(() => {
      const source = this.db.prepare("SELECT * FROM installed_broken WHERE id = ?").get(id) as unknown as InstalledBroken;
      if (!source) throw new Error("not_found");

      this.db.prepare(`
        INSERT INTO installed_working (
          id, kind, name, slug, source_url, surface_owner, transport, description, pricing, official, stars,
          install_command, source_lane, producer_surface, capture_class, observed_at, last_verified, stale_at,
          curated_notes, tools_json, detail_json, provenance_json, raw_json
        ) VALUES (
          ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?,
          ?, ?, ?, ?, ?, ?, ?,
          ?, ?, ?, ?, ?
        )
      `).run(
        source.id, source.kind, source.name, source.slug, source.source_url, source.surface_owner, source.transport, source.description, source.pricing, source.official, source.stars,
        source.install_command, evidence.source_lane, source.producer_surface, source.capture_class, source.observed_at, evidence.failure_observed_at, source.stale_at,
        source.curated_notes, source.tools_json, source.detail_json, evidence.provenance_json, source.raw_json
      );

      this.db.prepare("DELETE FROM installed_broken WHERE id = ?").run(id);

      this.searchIndex.deleteRow(id);
      this.searchIndex.insertRow('installed_working', {
        id: source.id,
        name: source.name,
        slug: source.slug,
        description: source.description,
        curated_notes: source.curated_notes
      });
    });
  }

  public moveAvailableToInstalled(slug: string, command: string | null, targetTable: 'installed_working' | 'installed_broken', additionalFields: Record<string, any>) {
    this.transaction(() => {
      const normalizedSlug = slug.toLowerCase().trim();
      let source = this.db.prepare("SELECT * FROM available_for_install WHERE lower(slug) = ?").get(normalizedSlug) as unknown as AvailableForInstall | undefined;

      if (!source && command) {
        // Redacted normalized command matching
        // Basic naive normalization for now
        const normalizedCmd = command.toLowerCase().replace(/[^a-z0-9\s]/g, '').replace(/\s+/g, ' ').trim();
        const rows = this.db.prepare("SELECT * FROM available_for_install WHERE install_command IS NOT NULL").all() as unknown as AvailableForInstall[];
        source = rows.find(r => {
          if (!r.install_command) return false;
          const rCmd = r.install_command.toLowerCase().replace(/[^a-z0-9\s]/g, '').replace(/\s+/g, ' ').trim();
          return rCmd === normalizedCmd;
        });
      }

      if (!source) throw new Error("not_found");

      const insertSql = `
        INSERT INTO ${targetTable} (
          id, kind, name, slug, source_url, surface_owner, transport, description, pricing, official, stars,
          install_command, source_lane, producer_surface, capture_class, observed_at, last_verified, stale_at,
          curated_notes, tools_json, detail_json, provenance_json, raw_json${targetTable === 'installed_broken' ? ', failure_reason, failure_observed_at' : ''}
        ) VALUES (
          ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?,
          ?, ?, ?, ?, ?, ?, ?,
          ?, ?, ?, ?, ?${targetTable === 'installed_broken' ? ', ?, ?' : ''}
        )
      `;

      const values = [
        source.id, source.kind, source.name, source.slug, source.source_url, additionalFields.surface_owner ?? source.surface_owner, source.transport, source.description, source.pricing, source.official, source.stars,
        source.install_command, additionalFields.source_lane ?? source.source_lane, source.producer_surface, source.capture_class, source.observed_at, additionalFields.last_verified ?? source.last_verified, source.stale_at,
        source.curated_notes, source.tools_json, source.detail_json, additionalFields.provenance_json ?? source.provenance_json, source.raw_json
      ];

      if (targetTable === 'installed_broken') {
        values.push(additionalFields.failure_reason ?? 'unknown');
        values.push(additionalFields.failure_observed_at ?? new Date().toISOString());
      }

      this.db.prepare(insertSql).run(...values);
      this.db.prepare("DELETE FROM available_for_install WHERE id = ?").run(source.id);

      this.searchIndex.deleteRow(source.id);
      this.searchIndex.insertRow(targetTable, {
        id: source.id,
        name: source.name,
        slug: source.slug,
        description: source.description,
        curated_notes: source.curated_notes
      });
    });
  }

  public getCensusReceipt(reportId: string): CensusReceiptRow | undefined {
    return this.db.prepare(
      "SELECT * FROM _caps_census_receipts WHERE report_id = ?",
    ).get(reportId) as unknown as CensusReceiptRow | undefined;
  }

  public applyCensusReportAtomic<T>(
    receipt: Omit<CensusReceiptRow, "result_summary">,
    operations: () => T,
  ): { replayed: boolean; result: T } {
    return this.transaction(() => {
      const existing = this.getCensusReceipt(receipt.report_id);
      if (existing) {
        if (existing.canonical_hash !== receipt.canonical_hash) {
          throw new Error("receipt_hash_mismatch");
        }
        if (existing.caller_provenance !== receipt.caller_provenance) {
          throw new Error("receipt_provenance_mismatch");
        }
        return {
          replayed: true,
          result: JSON.parse(existing.result_summary) as T,
        };
      }

      const result = operations();
      this.db.prepare(`
        INSERT INTO _caps_census_receipts (
          report_id, canonical_hash, caller_provenance, observed_at, result_summary
        ) VALUES (?, ?, ?, ?, ?)
      `).run(
        receipt.report_id,
        receipt.canonical_hash,
        receipt.caller_provenance,
        receipt.observed_at,
        JSON.stringify(result),
      );
      return { replayed: false, result };
    });
  }

  public updateCensusInstalledRow(
    table: "installed_working" | "installed_broken",
    id: string,
    fields: Record<string, string | number | null>,
  ): void {
    const allowed = new Set([
      "kind", "name", "slug", "surface_owner", "transport", "description",
      "pricing", "official", "install_command", "source_lane",
      "producer_surface", "capture_class", "observed_at", "last_verified",
      "stale_at", "tools_json", "detail_json", "provenance_json",
      "failure_reason", "failure_observed_at",
    ]);
    const entries = Object.entries(fields).filter(([key]) => allowed.has(key));
    if (entries.length === 0) return;
    const assignments = entries.map(([key]) => `${key} = ?`).join(", ");
    this.db.prepare(`UPDATE ${table} SET ${assignments} WHERE id = ?`).run(
      ...entries.map(([, value]) => value),
      id,
    );
    const row = this.db.prepare(`SELECT * FROM ${table} WHERE id = ?`).get(id) as any;
    if (row) {
      this.searchIndex.deleteRow(id);
      this.searchIndex.insertRow(table, {
        id: row.id,
        name: row.name,
        slug: row.slug,
        description: row.description,
        curated_notes: row.curated_notes,
      });
    }
  }
}

interface CensusReceiptRow {
  report_id: string;
  canonical_hash: string;
  caller_provenance: string;
  observed_at: string;
  result_summary: string;
}
