import fs from "node:fs";
import { loadCapsConfig } from "./config.js";
import { CapsStore } from "./store.js";
import { CapsService } from "./service.js";
import { validateNeedsProfile } from "./needs-profile.js";

function out(o: unknown): void {
  console.log(JSON.stringify(o, null, 2));
}

function die(msg: string): never {
  console.error(msg);
  process.exit(1);
}

export async function runCapsCommand(positional: string[], flags: Record<string, string | boolean>): Promise<void> {
  const sub = positional[0] ?? "status";

  const cfg = loadCapsConfig();
  const dbExists = fs.existsSync(cfg.databasePath);

  switch (sub) {
    case "status": {
      const path = await import("node:path");
      const fsNode = await import("node:fs");
      let needsState = "not_installed";
      try {
        const needsPath = path.join(cfg.stateDirectory, "NEEDS.json");
        if (fsNode.existsSync(needsPath)) {
          const stat = fsNode.statSync(needsPath);
          if (stat.size > 25000) {
            needsState = "error";
          } else {
            const data = JSON.parse(fsNode.readFileSync(needsPath, "utf8"));
            needsState = validateNeedsProfile(data) ? "installed" : "error";
          }
        }
      } catch {
         needsState = "error";
      }

      if (!dbExists) {
        out({ state: "not_installed", needsState, searchMode: "fallback" });
        return;
      }

      let store: CapsStore | null = null;
      try {
        store = new CapsStore(cfg);

        const tables = ["installed_working", "installed_broken", "available_for_install", "_caps_migrations", "_caps_census_receipts", "_caps_idempotency"];
        const tableRows: Record<string, number> = {};
        let ftsMode = false;

        for (const t of tables) {
          try {
            const res = store.db.prepare(`SELECT COUNT(*) as c FROM ${t}`).get() as { c: number };
            tableRows[t] = res.c;
          } catch {
            tableRows[t] = 0;
          }
        }

        const pricingTiers: Record<string, number> = {};
        try {
          const tiers = store.db.prepare(`
            SELECT pricing, COUNT(*) as c FROM (
              SELECT pricing FROM installed_working
              UNION ALL SELECT pricing FROM installed_broken
              UNION ALL SELECT pricing FROM available_for_install
            ) GROUP BY pricing
          `).all() as { pricing: string, c: number }[];
          for (const t of tiers) {
            pricingTiers[t.pricing] = t.c;
          }
        } catch {}

        try {
          const ftsCheck = store.db.prepare("SELECT 1 FROM sqlite_master WHERE type = 'table' AND name = 'caps_search_fts'").get();
          ftsMode = !!ftsCheck;
        } catch {}

        let migrationState = "unknown";
        try {
          const m = store.db.prepare("SELECT MAX(version) as v FROM _caps_migrations").get() as { v: number | null };
          migrationState = m && m.v !== null && m.v > 0 ? "ok" : "pending";
        } catch {
          migrationState = "error";
        }

        let integrityState = "unknown";
        try {
          const quick = store.db.prepare("PRAGMA quick_check(1)").get() as { quick_check: string };
          integrityState = quick.quick_check === "ok" ? "ok" : "error";
        } catch {
          integrityState = "error";
        }

        let lastRefresh = null;
        try {
          const path = await import("node:path");
          const fs = await import("node:fs");
          const reportDir = path.join(cfg.stateDirectory, "reports");
          if (fs.existsSync(reportDir)) {
             const files = fs.readdirSync(reportDir)
                             .filter(f => f.startsWith("refresh-") && f.endsWith(".json"))
                             .sort()
                             .reverse()
                             .slice(0, 50);
             let latestData: any = null;
             let latestTs = 0;
             let latestId = "";
             for (const file of files) {
               try {
                 const filePath = path.join(reportDir, file);
                 const stat = fs.statSync(filePath);
                 if (stat.size > 250000) continue; // bound file size

                 const data = JSON.parse(fs.readFileSync(filePath, "utf8"));
                 if (data && typeof data === 'object' && !Array.isArray(data) && data.schema === "bridge-caps-refresh-report-v1") {
                    const lifecycle = data.lifecycle_status;
                    if (["running", "incomplete", "terminal-success", "terminal-failure"].includes(lifecycle)) {
                      if (typeof data.refresh_run_id === "string" && data.refresh_run_id.length > 0 && data.refresh_run_id.length <= 256) {
                         const startAtStr = data.start_at;
                         const endAtStr = data.end_at;
                         const isValidIso = (s: any) => typeof s === "string" && !isNaN(new Date(s).getTime()) && new Date(s).toISOString() === s;

                         let currentTs = 0;
                         let selectedTimestamp = null;
                         let valid = true;

                         if (!isValidIso(startAtStr)) {
                             valid = false;
                         } else if (endAtStr !== undefined) {
                             if (!isValidIso(endAtStr)) {
                                 valid = false;
                             } else {
                                 currentTs = new Date(endAtStr).getTime();
                                 selectedTimestamp = endAtStr;
                             }
                         } else {
                             if (lifecycle === "terminal-success" || lifecycle === "terminal-failure") {
                                 valid = false;
                             } else {
                                 currentTs = new Date(startAtStr).getTime();
                                 selectedTimestamp = startAtStr;
                             }
                         }

                         if (valid && currentTs > 0) {
                           if (currentTs > latestTs || (currentTs === latestTs && data.refresh_run_id > latestId)) {
                              latestTs = currentTs;
                              latestId = data.refresh_run_id;
                              latestData = { ...data, _selected_timestamp: selectedTimestamp };
                           }
                         }
                      }
                    }
                  }
               } catch {}
             }
             if (latestData) {
               const lifecycle = latestData.lifecycle_status;
               let result = "incomplete";
               if (lifecycle === "terminal-success") result = "success";
               if (lifecycle === "terminal-failure") result = "failure";
               lastRefresh = {
                 lifecycle,
                 result,
                 timestamp: latestData._selected_timestamp
               };
             }
          }
        } catch {}

        let censusDue = true;
        let lastCensus = null;
        try {
          const rows = store.db.prepare("SELECT observed_at FROM _caps_census_receipts").all() as { observed_at: string }[];
          let latestTs = 0;
          let latestStr = null;
          for (const row of rows) {
             const obs = row.observed_at;
             if (typeof obs === "string") {
                const ts = new Date(obs).getTime();
                if (!isNaN(ts) && new Date(obs).toISOString() === obs) {
                   if (ts > latestTs) {
                      latestTs = ts;
                      latestStr = obs;
                   }
                }
             }
          }
          if (latestStr) {
             const ageMs = Date.now() - latestTs;
             if (ageMs >= 0 && ageMs < (1000 * 60 * 60 * 24)) {
                censusDue = false;
                lastCensus = latestStr;
             } else {
                censusDue = true;
                lastCensus = latestStr;
             }
          }
        } catch {}

        out({
          state: "installed",
          needsState,
          searchMode: ftsMode ? "fts" : "fallback",
          dbPath: cfg.databasePath,
          integrityState,
          migrationState,
          tableRows,
          pricingTiers,
          ftsMode,
          lastRefresh,
          lastCensus,
          censusDue,
          projectionState: "not_installed",
          pendingJudgment: "not_available"
        });
      } finally {
        if (store) store.close();
      }
      break;
    }

    case "search": {
      if (!dbExists) die("caps database not installed");
      const query = positional.slice(1).join(" ").trim();
      const store = new CapsStore(cfg);
      try {
        const service = new CapsService(store);
        const hits = service.search(query, { limit: 50 }, {
          principal: "cli", session: "cli", host: "localhost", canonical_lane: "code", client_name: "code"
        });
        out(hits);
      } finally {
        store.close();
      }
      break;
    }

    case "get": {
      if (!dbExists) die("caps database not installed");
      const id = positional[1];
      if (!id) die("usage: bridge caps get <id>");
      const store = new CapsStore(cfg);
      try {
        const service = new CapsService(store);
        const res = await service.get(id, {
          principal: "cli", session: "cli", host: "localhost", canonical_lane: "code", client_name: "code"
        });
        if (!res) die(`not found: ${id}`);
        out(res);
      } finally {
        store.close();
      }
      break;
    }

    case "refresh": {
      const lane = flags.lane;
      if (!lane || !["config", "probe", "mcpservers", "all"].includes(String(lane))) {
        die("usage: bridge caps refresh [--lane config|probe|mcpservers|all]");
      }

      const orchestrator = await import("./refresh.js");
      try {
        const res = await orchestrator.runCapsRefresh({ lane: String(lane) as any });
        out(res);
      } catch (e: any) {
        if (e.message === 'already_running') {
          const path = await import('node:path');
          const fs = await import('node:fs');
          let provenance: any = null;
          try {
            const lockBytes = fs.readFileSync(path.join(cfg.stateDirectory, 'refresh.lock'), 'utf8');
            const parsed = JSON.parse(lockBytes);
            if (typeof parsed === 'object' && parsed !== null && !Array.isArray(parsed)) {
               const keys = Object.keys(parsed);
               if (keys.length === 4 && keys.includes("nonce") && keys.includes("pid") && keys.includes("hostname") && keys.includes("start_time")) {
                 const nonce = typeof parsed.nonce === 'string' ? parsed.nonce.trim() : "";
                 const pid = parsed.pid;
                 const hostname = typeof parsed.hostname === 'string' ? parsed.hostname.trim() : "";
                 const start_time = typeof parsed.start_time === 'string' ? parsed.start_time.trim() : "";
                 const isValidIso = (str: string) => {
                   try { return new Date(str).toISOString() === str; } catch { return false; }
                 };
                 if (nonce.length > 0 && nonce.length < 1024 &&
                     Number.isSafeInteger(pid) && pid > 0 &&
                     hostname.length > 0 && hostname.length < 1024 &&
                     start_time.length > 0 && start_time.length < 1024 && isValidIso(start_time)) {
                   provenance = { nonce, pid, hostname, start_time };
                 }
               }
            }
          } catch {}
          if (!provenance) {
             provenance = { error: "malformed" };
          }
          out({ schema: "bridge-caps-refresh-report-v1", lifecycle_status: "already_running", held_lock: provenance });
          process.exitCode = 0;
        } else {
          throw e;
        }
      }
      break;
    }

    case "backfill": {
      let store: CapsStore | null = null;
      try {
        store = new CapsStore(cfg);
        if (!flags.resume) {
          const path = await import("node:path");
          const statePath = path.join(cfg.stateDirectory, "mcpservers-backfill-v1.json");
          if (fs.existsSync(statePath)) {
            fs.rmSync(statePath, { force: true });
          }
        }
        const { McpserversIndexer } = await import("./mcpservers.js");
        const indexer = new McpserversIndexer(store, cfg);
        const res = await indexer.runRefresh();
        out(res);
      } finally {
        if (store) store.close();
      }
      break;
    }

    default:
      die(`unknown caps subcommand: ${sub}`);
  }
}
