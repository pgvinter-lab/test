import type { DatabaseSync } from "node:sqlite";
import type { CapabilityBase } from "./types.js";

export interface SearchOptions {
  limit?: number;
  offset?: number;
}

export class CapsSearchIndex {
  private hasFts5 = false;

  constructor(private db: DatabaseSync) {
    this.detectFts5();
    if (this.hasFts5) {
      this.ensureFtsTable();
    }
  }

  private detectFts5() {
    try {
      this.db.exec("CREATE VIRTUAL TABLE IF NOT EXISTS _fts_detect USING fts5(col);");
      this.db.exec("DROP TABLE _fts_detect;");
      this.hasFts5 = true;
    } catch (e) {
      this.hasFts5 = false;
    }
  }

  private ensureFtsTable() {
    this.db.exec(`
      CREATE VIRTUAL TABLE IF NOT EXISTS caps_search_fts USING fts5(
        id UNINDEXED,
        table_name UNINDEXED,
        name,
        slug,
        description,
        curated_notes,
        tokenize='porter unicode61'
      );
    `);
  }

  public rebuildIndex() {
    if (!this.hasFts5) return;

    this.db.exec("BEGIN IMMEDIATE");
    try {
      this.db.exec("DELETE FROM caps_search_fts;");

      const tables = ['installed_working', 'installed_broken', 'available_for_install'];

      for (const table of tables) {
        this.db.exec(`
          INSERT INTO caps_search_fts (id, table_name, name, slug, description, curated_notes)
          SELECT id, '${table}', name, slug, description, curated_notes
          FROM ${table};
        `);
      }

      this.db.exec("COMMIT");
    } catch (error) {
      this.db.exec("ROLLBACK");
      // FTS is derived only, failure must not corrupt authority
      console.warn("Failed to rebuild FTS index", error);
    }
  }

  public insertRow(table: string, row: Pick<CapabilityBase, 'id' | 'name' | 'slug' | 'description' | 'curated_notes'>) {
    if (!this.hasFts5) return;
    this.db.prepare(`
      INSERT INTO caps_search_fts (id, table_name, name, slug, description, curated_notes)
      VALUES (?, ?, ?, ?, ?, ?)
    `).run(row.id, table, row.name, row.slug, row.description, row.curated_notes);
  }

  public deleteRow(id: string) {
    if (!this.hasFts5) return;
    this.db.prepare("DELETE FROM caps_search_fts WHERE id = ?").run(id);
  }

  public search(query: string, options: SearchOptions = {}) {
    const limit = options.limit ?? 50;

    if (this.hasFts5) {
      const stmt = this.db.prepare(`
        SELECT id, table_name
        FROM caps_search_fts
        WHERE caps_search_fts MATCH ?
        ORDER BY rank
        LIMIT ?
      `);
      // Sanitize FTS MATCH input (strip non-alphanumerics, keep the prefix star)
      const matchQuery = query.replace(/[^a-zA-Z0-9\s*]/g, '').trim() + '*';
      return stmt.all(matchQuery, limit) as { id: string; table_name: string }[];
    } else {
      // Fallback: escaped LIKE over name, slug, description, and curated_notes
      // Escape for LIKE: % _ \
      const escapedQuery = query.replace(/[\\%_]/g, '\\$&');
      const likeParam = `%${escapedQuery}%`;

      // Perform union across three tables
      const stmt = this.db.prepare(`
        SELECT id, 'installed_working' as table_name FROM installed_working
        WHERE name LIKE ? ESCAPE '\\' OR slug LIKE ? ESCAPE '\\' OR description LIKE ? ESCAPE '\\' OR curated_notes LIKE ? ESCAPE '\\'
        UNION ALL
        SELECT id, 'installed_broken' as table_name FROM installed_broken
        WHERE name LIKE ? ESCAPE '\\' OR slug LIKE ? ESCAPE '\\' OR description LIKE ? ESCAPE '\\' OR curated_notes LIKE ? ESCAPE '\\'
        UNION ALL
        SELECT id, 'available_for_install' as table_name FROM available_for_install
        WHERE name LIKE ? ESCAPE '\\' OR slug LIKE ? ESCAPE '\\' OR description LIKE ? ESCAPE '\\' OR curated_notes LIKE ? ESCAPE '\\'
        LIMIT ?
      `);

      return stmt.all(
        likeParam, likeParam, likeParam, likeParam,
        likeParam, likeParam, likeParam, likeParam,
        likeParam, likeParam, likeParam, likeParam,
        limit
      ) as { id: string; table_name: string }[];
    }
  }
}
