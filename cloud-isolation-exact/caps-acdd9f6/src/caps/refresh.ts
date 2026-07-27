import * as fs from 'fs';
import * as path from 'path';
import * as os from 'os';
import * as crypto from 'crypto';
import { CapsConfig } from './config.js';
import { CapsStore } from './store.js';
import { CrawlConfigLane } from './crawl-config.js';
import { McpserversIndexer } from './mcpservers.js';
import { probeLocalStdio } from './stdio-probe.js';
import { JudgmentService, buildJudgmentRequest } from './judgment.js';
import type { MailboxService } from '../v2/mailbox/service.js';

export type CapsRefreshLane = "config" | "probe" | "mcpservers" | "all";
export type CapsRefreshStageName = "projections" | "judgment";

export interface CapsRefreshStageCtx {
  reportId: string;
  stateDir: string;
}

export interface CapsRefreshStageOutcome {
  success: boolean;
  gap?: string;
  summary?: string;
  count?: number;
}

export interface CapsRefreshStage {
  name: CapsRefreshStageName;
  run(ctx: CapsRefreshStageCtx): Promise<CapsRefreshStageOutcome>;
}

export interface CapsRefreshLockHandle {
  release(): Promise<void>;
  nonce: string;
  provenance: any;
}

export interface CapsRefreshLockConflict {
  already_running: true;
  lock_provenance: any;
}

export type CapsRefreshLockResult = CapsRefreshLockHandle | CapsRefreshLockConflict;

export interface BridgeCapsRefreshReportV1 {
  schema: 'bridge-caps-refresh-report-v1';
  refresh_run_id: string;
  lifecycle_status: 'running' | 'incomplete' | 'terminal-success' | 'terminal-failure';
  start_at: string;
  end_at?: string;
  producer_provenance: string;
  capture_provenance: string;
  lane_outcomes: Record<string, any>;
  stage_outcomes: Record<string, any>;
  new_arrivals: number | null;
  status_flips: number | null;
  watch_deltas: number | null;
  gaps: string[];
  input_hashes: Record<string, string>;
  output_hashes: Record<string, string>;
}

function isPidAlive(pid: number): boolean {
  try {
    process.kill(pid, 0);
    return true;
  } catch (e: any) {
    return e.code === 'EPERM';
  }
}

export async function acquireCapsRefreshLock(stateDir: string): Promise<CapsRefreshLockResult> {
  const lockPath = path.join(stateDir, 'refresh.lock');
  let attempt = 0;
  while (attempt < 5) {
    attempt++;
    const nonce = crypto.randomBytes(16).toString('hex');
    const start_time = new Date().toISOString();
    const provenance = {
      nonce,
      pid: process.pid,
      hostname: os.hostname(),
      start_time
    };
    const lockBytes = Buffer.from(JSON.stringify(provenance, null, 2), 'utf-8');

    try {
      const handle = await fs.promises.open(lockPath, 'wx');
      try {
        await handle.write(lockBytes);
        await handle.sync();
      } finally {
        await handle.close();
      }
      return {
        nonce,
        provenance,
        release: async () => {
          try {
            const currentBytes = await fs.promises.readFile(lockPath);
            if (currentBytes.equals(lockBytes)) {
              await fs.promises.unlink(lockPath);
            }
          } catch (e: any) {
            if (e.code !== 'ENOENT') throw e;
          }
        }
      };
    } catch (e: any) {
      if (e.code !== 'EEXIST') throw e;
      // Lock exists, validate it
      let currentBytes: Buffer;
      try {
        currentBytes = await fs.promises.readFile(lockPath);
      } catch (err: any) {
        if (err.code === 'ENOENT') continue; // was deleted, retry
        throw err;
      }

      let currentProv: any = {};
      try {
        currentProv = JSON.parse(currentBytes.toString('utf-8'));
      } catch (err) {
        // invalid JSON, treat as stale
      }

      const isSameHost = currentProv.hostname === os.hostname();
      const hasPid = typeof currentProv.pid === 'number';

      let isAlive = false;
      if (isSameHost && hasPid) {
        isAlive = isPidAlive(currentProv.pid);
      } else if (!isSameHost && currentProv.start_time) {
        // Explicit tested age policy: older than 1 hour is dead
        const ageMs = Date.now() - new Date(currentProv.start_time).getTime();
        isAlive = ageMs < 3600000;
      } else {
        // malformed
        isAlive = false;
      }

      if (isAlive) {
        return { already_running: true, lock_provenance: currentProv };
      }

      // Stale, verify bytes and remove
      let latestBytes: Buffer;
      try {
        latestBytes = await fs.promises.readFile(lockPath);
      } catch (err: any) {
        if (err.code === 'ENOENT') continue;
        throw err;
      }

      if (latestBytes.equals(currentBytes)) {
        try {
          await fs.promises.unlink(lockPath);
        } catch (err: any) {
          if (err.code !== 'ENOENT') throw err;
        }
        // retry exclusive create
      }
    }
  }
  throw new Error("acquireCapsRefreshLock max retries exceeded");
}

export interface RunCapsRefreshParams {
  lane: CapsRefreshLane;
  stages?: CapsRefreshStage[];
  stateDir?: string;
  config?: CapsConfig;
  store?: CapsStore;
  mailbox?: MailboxService;
  __test_crash_after_core?: boolean;
}

export class CapsJudgmentStage implements CapsRefreshStage {
  name: CapsRefreshStageName = 'judgment';
  private svc: JudgmentService;

  constructor(
    private mailbox: MailboxService,
    private store: CapsStore,
    private projectId: string = 'bridge',
    private sender: { principalId: string, sessionId: string, hostId: string } = { principalId: 'antigravity', sessionId: 'local', hostId: os.hostname() },
    private approvalRef: string = 'factory-run'
  ) {
    this.svc = new JudgmentService(mailbox, store, projectId, sender, approvalRef);
  }

  async run(ctx: CapsRefreshStageCtx): Promise<CapsRefreshStageOutcome> {
    try {
      const projPath = path.join(ctx.stateDir, 'reports', `projections-${ctx.reportId}.json`);
      let projData;
      try {
        const bytes = await fs.promises.readFile(projPath, 'utf8');
        projData = JSON.parse(bytes);
      } catch (e: any) {
        if (e.code === 'ENOENT') return { success: false, gap: 'missing_projection' };
        return { success: false, gap: 'invalid_content' };
      }

      if (!projData || typeof projData !== 'object' || !projData.needs_profile) {
        return { success: false, gap: 'invalid_content' };
      }

      let req;
      try {
        const profilePayload = {
          path: String(projData.needs_profile.path).slice(0, 1024),
          sha256: String(projData.needs_profile.sha256).slice(0, 64)
        };
        req = buildJudgmentRequest(
          ctx.reportId,
          new Date().toISOString(),
          profilePayload,
          projData.new_available || [],
          projData.status_flips || [],
          projData.watch_deltas || []
        );
      } catch (e: any) {
        return { success: false, gap: 'invalid_content' };
      }

      let receipt;
      try {
        receipt = await this.svc.dispatchJudgment(req);
      } catch (e: any) {
        console.error("dispatchJudgment threw:", e);
        if (e && e.code === 'invalid_consumer_identity') return { success: false, gap: 'mailbox_unavailable' };
        if (e && e.name === 'JudgmentError') return { success: false, gap: 'invalid_content' };
        return { success: false, gap: 'mailbox_unavailable' };
      }

      let msg;
      try {
        msg = this.mailbox.get(receipt.messageId);
      } catch (e: any) {
        return { success: false, gap: 'mailbox_unavailable', summary: JSON.stringify(receipt) };
      }

      const summaryData: any = { ...receipt, status: msg?.status };
      if (msg?.responseSha256) {
        summaryData.responseSha256 = msg.responseSha256;
      }

      if (!msg || msg.status !== 'completed') {
        return { success: false, gap: 'pending', summary: JSON.stringify(summaryData) };
      }

      try {
        const ingestReceipt = await this.svc.ingestVerdict(
          receipt.messageId,
          ctx.reportId,
          receipt.payloadHash,
          receipt.promptHash
        );

        if (ingestReceipt.gapClasses) {
          summaryData.gapClasses = ingestReceipt.gapClasses;
        }
        if (typeof ingestReceipt.appliedCount === 'number') summaryData.appliedCount = ingestReceipt.appliedCount;
        if (typeof ingestReceipt.idempotentCount === 'number') summaryData.idempotentCount = ingestReceipt.idempotentCount;
        if (ingestReceipt.provenance) summaryData.provenance = ingestReceipt.provenance;

        const summaryJson = JSON.stringify(summaryData);

        if (ingestReceipt.gapClasses && ingestReceipt.gapClasses.length > 0) {
          let topGap = 'stage_error';
          const hasInvalid = ingestReceipt.gapClasses.some(c => ['response_corrupted', 'malformed_verdict', 'duplicate_verdict'].includes(c));
          const hasIncomplete = ingestReceipt.gapClasses.some(c => ['not_in_request', 'missing_verdict'].includes(c));
          const hasDbGap = ingestReceipt.gapClasses.includes('not_in_db');

          if (hasInvalid) topGap = 'invalid_content';
          else if (hasIncomplete) topGap = 'response_incomplete';
          else if (hasDbGap) topGap = 'projection_db_gap';

          return { success: false, gap: topGap, count: ingestReceipt.appliedCount, summary: summaryJson };
        }

        return { success: true, count: ingestReceipt.appliedCount, summary: summaryJson };
      } catch (e: any) {
        const summaryJson = JSON.stringify(summaryData);
        if (e && e.name === 'JudgmentError') {
          const code = e.code;
          if (code.includes('mismatch')) return { success: false, gap: 'binding_mismatch', summary: summaryJson };
          if (code.includes('malformed') || code.includes('corrupt') || code.includes('missing')) return { success: false, gap: 'invalid_content', summary: summaryJson };
        }
        return { success: false, gap: 'stage_error', summary: summaryJson };
      }
    } catch (e: any) {
      return { success: false, gap: 'stage_error' };
    }
  }
}

export class CapsProjectionStage implements CapsRefreshStage {
  name: CapsRefreshStageName = 'projections';

  constructor(private store: CapsStore) {}

  async run(ctx: CapsRefreshStageCtx): Promise<CapsRefreshStageOutcome> {
    try {
      const resolvedStateDir = path.resolve(ctx.stateDir);
      const validatePath = (p: string) => {
        const resolved = path.resolve(p);
        if (!resolved.startsWith(resolvedStateDir + path.sep) && resolved !== resolvedStateDir) {
           throw new Error('path_escape');
        }
        return resolved;
      };

      const coreReceiptPath = validatePath(path.join(ctx.stateDir, 'reports', `refresh-${ctx.reportId}.json`));
      let coreReceipt;
      try {
        const receiptBytes = await fs.promises.readFile(coreReceiptPath);
        if (receiptBytes.length > 5 * 1024 * 1024) throw new Error('core_receipt_too_large');
        coreReceipt = JSON.parse(receiptBytes.toString('utf8'));
      } catch (e: any) {
        return { success: false, gap: 'missing_core_receipt' };
      }

      if (coreReceipt.lifecycle_status !== 'incomplete') {
         return { success: false, gap: 'core_not_incomplete' };
      }
      if (coreReceipt.schema !== 'bridge-caps-refresh-report-v1') {
        return { success: false, gap: 'invalid_core_receipt_schema' };
      }
      if (coreReceipt.refresh_run_id !== ctx.reportId) {
        return { success: false, gap: 'run_id_mismatch' };
      }

      const catalogPath = validatePath(path.join(ctx.stateDir, 'CATALOG.md'));
      const availablePath = validatePath(path.join(ctx.stateDir, 'AVAILABLE.md'));
      const needsPath = validatePath(path.join(ctx.stateDir, 'NEEDS.json'));

      const workingRows = this.store.db.prepare("SELECT * FROM installed_working LIMIT 10001").all() as any[];
      if (workingRows.length > 10000) throw new Error('installed_working_limit_exceeded');
      const brokenRows = this.store.db.prepare("SELECT * FROM installed_broken LIMIT 10001").all() as any[];
      if (brokenRows.length > 10000) throw new Error('installed_broken_limit_exceeded');
      const availableRows = this.store.db.prepare("SELECT * FROM available_for_install LIMIT 10001").all() as any[];
      if (availableRows.length > 10000) throw new Error('available_for_install_limit_exceeded');

      const { Projections } = await import('./projections.js');
      const proj = new Projections(ctx.stateDir);

      const generatedCatalogSection = proj.renderCatalogSection(workingRows, brokenRows);
      const catalogSpliceResult = proj.spliceCatalog(catalogPath, generatedCatalogSection);
      if (catalogSpliceResult.error) {
        return { success: false, gap: `catalog_splice_error:${catalogSpliceResult.error}` };
      }

      const catalogPostBytes = await fs.promises.readFile(catalogPath);
      const catalogPostSha256 = crypto.createHash('sha256').update(catalogPostBytes).digest('hex');

      const observedAt = new Date().toISOString();
      const { initializeNeedsProfile } = await import('./needs-profile.js');
      const needsProfile = initializeNeedsProfile(
        needsPath,
        catalogPath,
        'bridge:caps:generated',
        catalogPostSha256,
        observedAt
      );

      const needsProfileBytes = await fs.promises.readFile(needsPath);
      const needsProfileSha256 = crypto.createHash('sha256').update(needsProfileBytes).digest('hex');

      let newAvailableOut: any[] = [];
      let candidatesOut: any[] = [];
      let gaps: string[] = [];

      let mcpFacts = coreReceipt.lane_outcomes?.mcpservers;
      let valid = true;
      let reason = '';

      const isPlainObj = (val: any) => val && typeof val === 'object' && !Array.isArray(val);
      const isIso = (val: any) => typeof val === 'string' && val.length <= 100 && Number.isFinite(Date.parse(val)) && new Date(val).toISOString() === val;
      const isStrArr = (arr: any, max: number, maxItemBytes: number) =>
        Array.isArray(arr) &&
        arr.length <= max &&
        arr.every((x: any) =>
          typeof x === 'string' &&
          Buffer.byteLength(x, 'utf-8') <= maxItemBytes
        );
      const isFiniteNat = (n: any) => typeof n === 'number' && Number.isFinite(n) && n >= 0 && Number.isInteger(n);

      if (!isPlainObj(mcpFacts)) { valid = false; reason = 'not_object'; }
      else if (mcpFacts.schema !== 'bridge-caps-mcpservers-refresh-v1') { valid = false; reason = 'bad_schema'; }
      else if (!isIso(mcpFacts.started_at) || !isIso(mcpFacts.finished_at)) { valid = false; reason = 'bad_timestamps'; }
      else if (
        !isPlainObj(mcpFacts.stated_totals) ||
        Object.keys(mcpFacts.stated_totals).length > 1000 ||
        Object.keys(mcpFacts.stated_totals).some((key) =>
          key.length === 0 ||
          Buffer.byteLength(key, 'utf-8') > 2048
        )
      ) { valid = false; reason = 'bad_stated_totals'; }
      else if (!isPlainObj(mcpFacts.diff)) { valid = false; reason = 'bad_diff'; }
      else if (!isStrArr(mcpFacts.diff.new, 1000, 1024) || !isStrArr(mcpFacts.diff.changed, 1000, 1024) || !isStrArr(mcpFacts.diff.removed, 1000, 1024)) { valid = false; reason = 'bad_diff_arrays'; }
      else if (!isFiniteNat(mcpFacts.diff.new_count) || !isFiniteNat(mcpFacts.diff.changed_count) || !isFiniteNat(mcpFacts.diff.removed_count) ||
               mcpFacts.diff.new_count !== mcpFacts.diff.new.length ||
               mcpFacts.diff.changed_count !== mcpFacts.diff.changed.length ||
               mcpFacts.diff.removed_count !== mcpFacts.diff.removed.length) { valid = false; reason = 'bad_diff_counts'; }
      else if (!isFiniteNat(mcpFacts.processed) || !isFiniteNat(mcpFacts.skipped_installed) || !isFiniteNat(mcpFacts.pending)) { valid = false; reason = 'bad_stats'; }
      else if (!isStrArr(mcpFacts.gaps, 100, 2000) || !isStrArr(mcpFacts.errors, 100, 2000)) { valid = false; reason = 'bad_gaps_errors'; }
      else if (!Array.isArray(mcpFacts.fetch_log) || mcpFacts.fetch_log.length > 2000) { valid = false; reason = 'bad_fetch_log'; }

      if (valid) {
        for (const st of Object.values(mcpFacts.stated_totals)) {
          if (!isPlainObj(st)) { valid = false; reason = 'bad_stated_total'; break; }
          const keys = Object.keys(st as any).sort().join(',');
          if (keys !== 'delta,observed_at,previous,response_sha256,source_url,value') { valid = false; reason = 'bad_stated_total'; break; }
          if (!isFiniteNat((st as any).value)) { valid = false; reason = 'bad_stated_total'; break; }
          if ((st as any).previous !== null && !isFiniteNat((st as any).previous)) { valid = false; reason = 'bad_stated_total'; break; }
          if ((st as any).delta !== null && (typeof (st as any).delta !== 'number' || !Number.isInteger((st as any).delta) || !Number.isFinite((st as any).delta))) { valid = false; reason = 'bad_stated_total'; break; }
          if ((st as any).previous === null && (st as any).delta !== null) { valid = false; reason = 'bad_stated_total'; break; }
          if ((st as any).previous !== null && (st as any).delta !== (st as any).value - (st as any).previous) { valid = false; reason = 'bad_stated_total'; break; }
          if (!isIso((st as any).observed_at)) { valid = false; reason = 'bad_stated_total'; break; }
          if (typeof (st as any).source_url !== 'string' || !/^https?:\/\/.+/.test((st as any).source_url) || (st as any).source_url.length > 2000) { valid = false; reason = 'bad_stated_total'; break; }
          if (typeof (st as any).response_sha256 !== 'string' || !/^[0-9a-f]{64}$/i.test((st as any).response_sha256)) { valid = false; reason = 'bad_stated_total'; break; }
        }
      }

      if (valid) {
        for (const log of mcpFacts.fetch_log) {
          if (!isPlainObj(log)) { valid = false; reason = 'bad_fetch_log'; break; }
          if (typeof (log as any).url !== 'string' || !/^https?:\/\/.+/.test((log as any).url) || (log as any).url.length > 2000) { valid = false; reason = 'bad_fetch_log'; break; }
          if ((log as any).outcome !== 'ok' && (log as any).outcome !== 'error') { valid = false; reason = 'bad_fetch_log'; break; }
          if ((log as any).status !== undefined && !isFiniteNat((log as any).status)) { valid = false; reason = 'bad_fetch_log'; break; }
          if ((log as any).bytes !== undefined && !isFiniteNat((log as any).bytes)) { valid = false; reason = 'bad_fetch_log'; break; }
          if ((log as any).attempts !== undefined && !isFiniteNat((log as any).attempts)) { valid = false; reason = 'bad_fetch_log'; break; }
          if ((log as any).parser !== undefined && (typeof (log as any).parser !== 'string' || (log as any).parser.length > 100)) { valid = false; reason = 'bad_fetch_log'; break; }
          if ((log as any).error !== undefined && (typeof (log as any).error !== 'string' || (log as any).error.length > 2000)) { valid = false; reason = 'bad_fetch_log'; break; }
          if ((log as any).sha256 !== undefined && (typeof (log as any).sha256 !== 'string' || !/^[0-9a-f]{64}$/i.test((log as any).sha256))) { valid = false; reason = 'bad_fetch_log'; break; }
          if ((log as any).outcome === 'ok' && !(log as any).sha256) { valid = false; reason = 'bad_fetch_log'; break; }
        }
      }

      if (!valid) {
        gaps.push(`missing_provenance: ${reason}`);
        mcpFacts = null;
      } else {
        gaps.push(...mcpFacts.gaps.map(String));
        gaps.push(...mcpFacts.errors.map(String));
      }

      let priorAvailableCount = availableRows.length;
      if (mcpFacts && mcpFacts.diff && typeof mcpFacts.diff.new_count === 'number' && typeof mcpFacts.diff.removed_count === 'number') {
        const computed = availableRows.length - mcpFacts.diff.new_count + mcpFacts.diff.removed_count;
        if (Number.isFinite(computed) && computed >= 0) {
          priorAvailableCount = computed;
        } else {
          gaps.push('invalid_prior: available_count');
        }
      } else {
        gaps.push('missing_prior: available_count');
      }

      let priorBrokenCount = brokenRows.length;
      gaps.push('missing_prior: broken_count');

      if (mcpFacts && mcpFacts.diff && Array.isArray(mcpFacts.diff.new)) {
        for (const identity of mcpFacts.diff.new) {
          const idStr = String(identity).slice(0, 1024);
          const row = availableRows.find((r: any) => r.source_url === idStr);
          if (row) {
            let valid = true;
            if (!['server', 'tool', 'skill'].includes(row.kind)) { gaps.push(`invalid_kind:${row.id}`); valid = false; }
            if (!['free', 'unknown', 'paid'].includes(row.pricing)) { gaps.push(`invalid_pricing:${row.id}`); valid = false; }
            if (valid) {
              newAvailableOut.push(row);
              candidatesOut.push({
                id: String(row.id).slice(0, 255),
                name: String(row.name).slice(0, 255),
                kind: String(row.kind).slice(0, 128),
                pricing: String(row.pricing).slice(0, 128),
                category: row.category == null ? null : String(row.category).slice(0, 128),
                one_liner: row.description == null ? null : String(row.description).slice(0, 255),
                source_url: row.source_url == null ? null : String(row.source_url).slice(0, 1024),
                ask_first: row.pricing === 'paid'
              });
            }
          } else {
            gaps.push(`unmapped_provenance: ${idStr}`.slice(0, 255));
          }
        }
      } else {
        gaps.push('missing_provenance: new_arrivals');
      }

      let statusFlipsOut: string[] = [];
      if (mcpFacts && mcpFacts.diff) {
         if (Array.isArray(mcpFacts.diff.changed)) {
            statusFlipsOut.push(...mcpFacts.diff.changed.map(String));
         }
         if (Array.isArray(mcpFacts.diff.removed)) {
            statusFlipsOut.push(...mcpFacts.diff.removed.map(String));
         }
      } else {
        gaps.push('missing_provenance: status_flips');
      }
      statusFlipsOut = Array.from(new Set(statusFlipsOut)).slice(0, 100);
      candidatesOut = Array.from(new Map(candidatesOut.map(item => [item.id, item])).values()).slice(0, 100);
      newAvailableOut = Array.from(new Map(newAvailableOut.map(item => [item.id, item])).values()).slice(0, 100);

      let watchDeltasOut: string[] = [];
      if (mcpFacts) {
         for (const key of Object.keys(mcpFacts.stated_totals)) {
            const st = mcpFacts.stated_totals[key];
            if (!isPlainObj(st)) continue;
            if (!isFiniteNat(st.value)) continue;
            if (st.previous !== null && !isFiniteNat(st.previous)) continue;
            if (st.delta !== null && (typeof st.delta !== 'number' || !Number.isFinite(st.delta) || !Number.isInteger(st.delta))) continue;
            if (!isIso(st.observed_at)) continue;
            if (typeof st.source_url !== 'string' || !/^https?:\/\/.+/.test(st.source_url) || st.source_url.length > 2000) continue;
            if (typeof st.response_sha256 !== 'string' || !/^[0-9a-f]{64}$/i.test(st.response_sha256)) continue;

            if (key.startsWith('watch:') && st.delta !== null && st.delta !== 0) {
               watchDeltasOut.push(`${String(key).slice(0,128)}=${st.delta}`);
            }
         }
      } else {
        gaps.push('missing_provenance: watch_deltas');
      }
      watchDeltasOut = Array.from(new Set(watchDeltasOut)).slice(0, 100);

      let sourceHashes: string[] = [];
      const addHash = (h: any) => {
         if (typeof h === 'string' && /^[0-9a-f]{64}$/i.test(h)) {
            sourceHashes.push(h.toLowerCase());
         } else if (h) {
            gaps.push(`malformed_hash: ${String(h).slice(0,128)}`);
         }
      };

      const checkHashMap = (mapObj: any, name: string) => {
        if (mapObj === undefined) return;
        if (!mapObj || typeof mapObj !== 'object' || Array.isArray(mapObj) || Object.keys(mapObj).length > 100) {
          gaps.push(`malformed_${name}`);
          return;
        }
        for (const [k, v] of Object.entries(mapObj)) {
          if (typeof k !== 'string' || k.length > 255) {
            gaps.push(`malformed_${name}`);
            return;
          }
          if (typeof v !== 'string' || !/^[0-9a-f]{64}$/i.test(v)) {
            gaps.push(`malformed_${name}`);
            return;
          }
        }
        Object.values(mapObj).forEach(addHash);
      };

      checkHashMap(coreReceipt.input_hashes, 'input_hashes');
      checkHashMap(coreReceipt.output_hashes, 'output_hashes');
      if (mcpFacts) {
        Object.values(mcpFacts.stated_totals).forEach((st: any) => {
          addHash(st.response_sha256);
        });
      }
      let fetchGaps: any[] = [];
      if (mcpFacts && Array.isArray(mcpFacts.fetch_log)) {
         mcpFacts.fetch_log.forEach((log: any) => {
            if (log && typeof log === 'object' && typeof log.sha256 === 'string' && /^[0-9a-f]{64}$/i.test(log.sha256)) {
               addHash(log.sha256);
            }
         });
      }
      sourceHashes = Array.from(new Set(sourceHashes)).sort().slice(0, 100);
      gaps = Array.from(new Set(gaps)).slice(0, 100);

      fetchGaps = fetchGaps.slice(0, 100);

      const availResult = proj.generateAvailable(
        availablePath,
        availableRows,
        brokenRows,
        newAvailableOut,
        priorAvailableCount,
        priorBrokenCount,
        fetchGaps,
        sourceHashes
      );

      const availPostBytes = await fs.promises.readFile(availablePath);
      const availPostSha256 = crypto.createHash('sha256').update(availPostBytes).digest('hex');

      const artifactPath = validatePath(path.join(ctx.stateDir, 'reports', `projections-${ctx.reportId}.json`));
      const artifact: any = {
        schema: 'bridge-caps-projections-v1',
        refresh_run_id: ctx.reportId,
        generated_at: new Date().toISOString(),
        catalog: {
          path: catalogPath,
          sha256: catalogPostSha256,
          backup_receipt: catalogSpliceResult.receipt
        },
        available: {
          path: availablePath,
          sha256: availPostSha256,
          backup_receipt: availResult.receipt
        },
        needs_profile: {
          path: needsPath,
          sha256: needsProfileSha256,
          profile_id: needsProfile.profile_id,
          provenance: needsProfile.provenance
        },
        new_available: candidatesOut,
        status_flips: statusFlipsOut,
        watch_deltas: watchDeltasOut,
        source_hashes: sourceHashes,
        gap_count: gaps.length,
        gaps: gaps.slice(0, 100)
      };

      artifact.payload_sha256 = '';
      const payloadBytes = Buffer.from(JSON.stringify(artifact, null, 2), 'utf-8');
      artifact.payload_sha256 = crypto.createHash('sha256').update(payloadBytes).digest('hex');

      const finalArtifactBytes = Buffer.from(JSON.stringify(artifact, null, 2), 'utf-8');
      if (finalArtifactBytes.length > 5 * 1024 * 1024) throw new Error('artifact_too_large');

      const expectedArtifactSha256 = crypto.createHash('sha256').update(finalArtifactBytes).digest('hex');

      const summaryPayload = JSON.stringify({
        artifact_path: artifactPath,
        artifact_sha256: expectedArtifactSha256,
        target_hashes: {
          catalog: catalogPostSha256,
          available: availPostSha256,
          needs_profile: needsProfileSha256
        },
        backup_receipts: {
          catalog: catalogSpliceResult.receipt,
          available: availResult.receipt
        },
        new_count: candidatesOut.length,
        status_flips: statusFlipsOut.length,
        watch_deltas: watchDeltasOut.length,
        gap_count: gaps.length,
        readback_verified: true
      });
      if (Buffer.from(summaryPayload, 'utf-8').length > 1024) throw new Error('summary_too_large');

      const tempNonce = crypto.randomBytes(8).toString('hex');
      const artifactTempPath = validatePath(path.join(ctx.stateDir, 'reports', `projections-${ctx.reportId}.${tempNonce}.json`));

      let handle;
      let renamed = false;
      try {
        handle = await fs.promises.open(artifactTempPath, 'wx');
        await handle.writeFile(finalArtifactBytes);
        await handle.sync();
        await handle.close();
        handle = undefined;
        await fs.promises.rename(artifactTempPath, artifactPath);
        renamed = true;

        const readbackBytes = await fs.promises.readFile(artifactPath);
        if (!readbackBytes.equals(finalArtifactBytes)) {
          throw new Error('readback_mismatch');
        }
        const readbackSha = crypto.createHash('sha256').update(readbackBytes).digest('hex');
        if (readbackSha !== expectedArtifactSha256) {
          throw new Error('readback_sha_mismatch');
        }
      } finally {
        if (handle) {
          try { await handle.close(); } catch {}
        }
        if (!renamed) {
          try { await fs.promises.unlink(artifactTempPath); } catch {}
        }
      }

      return {
        success: true,
        summary: summaryPayload,
        count: candidatesOut.length + statusFlipsOut.length + watchDeltasOut.length
      };

    } catch (e: any) {
      return { success: false, gap: e.message || 'unknown_error' };
    }
  }
}

export async function runCapsRefresh(params: RunCapsRefreshParams): Promise<BridgeCapsRefreshReportV1> {
  const { loadCapsConfig } = await import('./config.js');
  const config = params.config || loadCapsConfig();
  const stateDir = params.stateDir || config.stateDirectory;
  const ownsStore = !params.store;

  const lock = await acquireCapsRefreshLock(stateDir);
  if ('already_running' in lock) {
    throw new Error('already_running');
  }

  let store = params.store;
  try {
    if (!store) {
      const { CapsStore } = await import('./store.js');
      store = new CapsStore(config);
    }

    const runId = crypto.randomUUID();
    const reportPath = path.join(stateDir, 'reports', `refresh-${runId}.json`);
    const reportTempPath = path.join(stateDir, 'reports', `refresh-${runId}.temp.json`);
    await fs.promises.mkdir(path.join(stateDir, 'reports'), { recursive: true });

    const report: BridgeCapsRefreshReportV1 = {
      schema: 'bridge-caps-refresh-report-v1',
      refresh_run_id: runId,
      lifecycle_status: 'running',
      start_at: new Date().toISOString(),
      producer_provenance: 'antigravity-08a',
      capture_provenance: 'local-refresh',
      lane_outcomes: {},
      stage_outcomes: {},
      new_arrivals: null,
      status_flips: null,
      watch_deltas: null,
      gaps: [],
      input_hashes: {},
      output_hashes: {}
    };

    const writeTempReport = async (r: BridgeCapsRefreshReportV1) => {
      let handle;
      try {
        handle = await fs.promises.open(reportTempPath, 'w');
        await handle.write(JSON.stringify(r, null, 2));
        await handle.sync();
      } finally {
        if (handle) await handle.close();
      }
      await fs.promises.rename(reportTempPath, reportPath);
    };

    const getDbHash = () => {
      try {
        const buf = fs.readFileSync(config.databasePath);
        return crypto.createHash('sha256').update(buf).digest('hex');
      } catch {
        return 'not_found';
      }
    };
    report.input_hashes = { 'caps.sqlite': getDbHash() };

    // Persist running receipt
    await writeTempReport(report);

    let success = true;
    try {
      if (params.lane === 'all' || params.lane === 'config') {
        const configLane = new CrawlConfigLane(config, store);
        report.lane_outcomes.config = configLane.executeCrawl();
      }
      if (params.lane === 'all' || params.lane === 'probe') {
        const probeQuery = `
          SELECT id FROM (
            SELECT id, transport, producer_surface, capture_class, source_lane, raw_json FROM installed_working
            UNION ALL
            SELECT id, transport, producer_surface, capture_class, source_lane, raw_json FROM installed_broken
          )
          WHERE transport = 'stdio'
            AND producer_surface = 'code'
            AND capture_class = 'guaranteed'
            AND source_lane IN ('config-crawl', 'probe')
            AND raw_json IS NOT NULL
          ORDER BY id
          LIMIT 101
        `;
        const rows = store.db.prepare(probeQuery).all() as {id: string}[];
        const isTruncated = rows.length > 100;
        const targetRows = isTruncated ? rows.slice(0, 100) : rows;

        const outcomes = [];
        for (const row of targetRows) {
          outcomes.push(await probeLocalStdio(store, row.id));
        }
        report.lane_outcomes.probe = { success: true, count: outcomes.length, truncated: isTruncated, outcomes };
      }
      if (params.lane === 'all' || params.lane === 'mcpservers') {
        const indexer = new McpserversIndexer(store, config);
        report.lane_outcomes.mcpservers = await indexer.runRefresh();
      }

      report.gaps.push('metrics_not_derived: new_arrivals, status_flips, watch_deltas');

      // Atomically persist completed core facts as nonterminal before stages
      report.lifecycle_status = 'incomplete';
      await writeTempReport(report);

      if (params.__test_crash_after_core) {
        throw new Error('simulated_crash');
      }

      if (params.stages || params.mailbox || params.lane === 'all') {
        let finalStages = params.stages ? [...params.stages] : [];
        if (params.lane === 'all') {
          const pIdx = finalStages.findIndex(s => s.name === 'projections');
          if (pIdx === -1) {
            finalStages.push(new CapsProjectionStage(store));
          }
        }
        if (params.mailbox) {
          const jStage = new CapsJudgmentStage(params.mailbox, store);
          const pIdx = finalStages.findIndex(s => s.name === 'projections');
          if (pIdx >= 0) {
            finalStages.splice(pIdx + 1, 0, jStage);
          } else {
            finalStages.push(jStage);
          }
        }
        for (const stage of finalStages) {
          try {
            const outcome = await stage.run({ reportId: runId, stateDir });
            report.stage_outcomes[stage.name] = {
              success: Boolean(outcome.success),
              gap: outcome.gap ? String(outcome.gap).slice(0, 1024) : undefined,
              summary: outcome.summary ? String(outcome.summary).slice(0, 1024) : undefined,
              count: typeof outcome.count === 'number' ? outcome.count : undefined,
            };
            if (!outcome.success) {
              success = false;
              report.gaps.push(`stage_failure:${stage.name}${outcome.gap ? ` - ${outcome.gap}` : ''}`);
              if (stage.name === 'projections') {
                break; // A projection failure makes judgment ineligible for dispatch
              }
            }
          } catch (e: any) {
            success = false;
            report.stage_outcomes[stage.name] = { success: false, gap: e.message };
            report.gaps.push(`stage_throw:${stage.name} - ${e.message}`);
          }
        }
      }
    } catch (e: any) {
      success = false;
      if (e.message !== 'simulated_crash') {
        report.gaps.push(`lane_throw - ${e.message}`);
      } else {
        throw e;
      }
    }

    report.output_hashes = { 'caps.sqlite': getDbHash() };
    report.end_at = new Date().toISOString();
    report.lifecycle_status = success ? 'terminal-success' : 'terminal-failure';
    await writeTempReport(report);

    return report;
  } finally {
    await lock.release();
    if (ownsStore && store) store.close();
  }
}
