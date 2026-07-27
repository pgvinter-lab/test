import fs from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';
import type { CapabilityBase, InstalledWorking, InstalledBroken, AvailableForInstall } from './types.js';
import { PricingSortTier } from './types.js';

export interface FetchGap {
  query: string;
  expected_count: number;
  found_count: number;
}

export class Projections {
  constructor(private capsStateDir: string) {}

  private writeBackupAndManifest(targetPath: string): { receipt: string } {
    if (!fs.existsSync(targetPath)) {
      return { receipt: 'no_prior_file' };
    }
    const backupsDir = path.join(this.capsStateDir, 'backups', 'projections');
    fs.mkdirSync(backupsDir, { recursive: true });

    const content = fs.readFileSync(targetPath);
    const hash = crypto.createHash('sha256').update(content).digest('hex');
    const filename = path.basename(targetPath);
    const ts = new Date().toISOString().replace(/[:.]/g, '-');
    const backupName = `${filename}.${ts}.bak`;
    const backupPath = path.join(backupsDir, backupName);
    const manifestPath = path.join(backupsDir, `${backupName}.manifest`);

    let backupFd: number | null = null;
    let manifestFd: number | null = null;
    try {
      backupFd = fs.openSync(backupPath, 'wx');
      fs.writeSync(backupFd, content);
      fs.fsyncSync(backupFd);
      fs.closeSync(backupFd);
      backupFd = null;

      manifestFd = fs.openSync(manifestPath, 'wx');
      fs.writeSync(manifestFd, `${filename}: ${hash}\n`, null, 'utf8');
      fs.fsyncSync(manifestFd);
      fs.closeSync(manifestFd);
      manifestFd = null;

      const writtenBackup = fs.readFileSync(backupPath);
      const writtenHash = crypto.createHash('sha256').update(writtenBackup).digest('hex');
      if (writtenHash !== hash) {
        throw new Error("Backup hash verification failed");
      }
    } catch (e) {
      if (backupFd !== null) { try { fs.closeSync(backupFd); } catch (err) {} }
      if (manifestFd !== null) { try { fs.closeSync(manifestFd); } catch (err) {} }
      if (fs.existsSync(backupPath)) { try { fs.unlinkSync(backupPath); } catch (err) {} }
      if (fs.existsSync(manifestPath)) { try { fs.unlinkSync(manifestPath); } catch (err) {} }
      throw e;
    }

    return { receipt: `backed_up_${hash}` };
  }

  private writeAtomic(targetPath: string, content: string | Buffer): void {
    const tempPath = `${targetPath}.tmp.${crypto.randomBytes(4).toString('hex')}`;
    let fd: number | null = null;
    try {
      fd = fs.openSync(tempPath, 'wx');
      if (typeof content === 'string') {
        fs.writeSync(fd, content, null, 'utf8');
      } else {
        fs.writeSync(fd, content);
      }
      fs.fsyncSync(fd);
      fs.closeSync(fd);
      fd = null;
      fs.renameSync(tempPath, targetPath);
    } catch (e) {
      if (fd !== null) { try { fs.closeSync(fd); } catch (err) {} }
      if (fs.existsSync(tempPath)) {
        try { fs.unlinkSync(tempPath); } catch (err) {}
      }
      throw e;
    }
  }

  public spliceCatalog(targetPath: string, generatedContent: string): { receipt: string, error?: string } {
    let content = fs.existsSync(targetPath) ? fs.readFileSync(targetPath, 'utf8') : '';
    const beginMarker = '<!-- bridge:caps:generated:begin -->';
    const endMarker = '<!-- bridge:caps:generated:end -->';

    const beginCount = content.split(beginMarker).length - 1;
    const endCount = content.split(endMarker).length - 1;

    if (beginCount > 1 || endCount > 1) {
      return { receipt: fs.existsSync(targetPath) ? 'error_no_backup' : 'no_prior_file', error: 'duplicate_markers' };
    }

    if (beginCount === 1 && endCount === 0) {
      return { receipt: fs.existsSync(targetPath) ? 'error_no_backup' : 'no_prior_file', error: 'begin_only_marker' };
    }

    if (beginCount === 0 && endCount === 1) {
      return { receipt: fs.existsSync(targetPath) ? 'error_no_backup' : 'no_prior_file', error: 'end_only_marker' };
    }

    const beginIdx = content.indexOf(beginMarker);
    const endIdx = content.indexOf(endMarker);

    if (beginIdx !== -1 && endIdx !== -1 && beginIdx > endIdx) {
      return { receipt: fs.existsSync(targetPath) ? 'error_no_backup' : 'no_prior_file', error: 'reversed_markers' };
    }

    // After validation, we back up the file.
    const backupReceipt = this.writeBackupAndManifest(targetPath);

    if (beginCount === 0 && endCount === 0) {
      // Append if both absent
      const nl = content.includes('\r\n') ? '\r\n' : '\n';
      const fileEndsWithNl = content.endsWith('\n') || content.length === 0;
      const prefixNl = fileEndsWithNl ? '' : nl;
      const newContent = `${content}${prefixNl}${beginMarker}${nl}${generatedContent}${nl}${endMarker}${nl}`;
      this.writeAtomic(targetPath, newContent);
      return { receipt: backupReceipt.receipt };
    }

    // Replace case
    const nl = content.includes('\r\n') ? '\r\n' : '\n';
    const before = content.slice(0, beginIdx + beginMarker.length);
    const after = content.slice(endIdx);

    // Ensure we preserve the newline immediately surrounding the generated content
    let block = generatedContent;
    if (!block.startsWith('\n') && !block.startsWith('\r\n')) {
      block = nl + block;
    }
    if (!block.endsWith('\n') && !block.endsWith('\r\n')) {
      block = block + nl;
    }

    const newContent = `${before}${block}${after}`;

    this.writeAtomic(targetPath, newContent);
    return { receipt: backupReceipt.receipt };
  }

  public generateAvailable(
    targetPath: string,
    availableRows: AvailableForInstall[],
    brokenRows: InstalledBroken[],
    newAvailable: AvailableForInstall[],
    priorAvailCount: number,
    priorBrokenCount: number,
    fetchGaps: FetchGap[],
    sourceHashes: string[]
  ): { receipt: string } {
    const backupReceipt = this.writeBackupAndManifest(targetPath);

    const sortCaps = <T extends CapabilityBase>(caps: T[]) => {
      return [...caps].sort((a, b) => {
        const diff = PricingSortTier[a.pricing] - PricingSortTier[b.pricing];
        if (diff !== 0) return diff;
        return a.name.localeCompare(b.name);
      });
    };

    const sortedAvail = sortCaps(availableRows);
    const sortedBroken = sortCaps(brokenRows);
    const sortedNew = sortCaps(newAvailable);

    // Validate verdicts
    const validVerdicts = ['PASS', 'FAIL', 'PASS_APPROVED', 'FAIL_REJECTED', 'PENDING', 'N/A'];
    const validateRowVerdict = (row: AvailableForInstall) => {
      const v = row.judgment_verdict || 'N/A';
      if (!validVerdicts.includes(v)) {
        throw new Error(`Invalid AGY verdict column: ${v}`);
      }
      return v;
    };

    let content = `# Available Capabilities\n\n`;
    content += `> WARNING: This file is fully generated and is a hint-not-proof of capability state.\n`;

    const genData = { availableRows, brokenRows, newAvailable, fetchGaps, sourceHashes };
    const hashStr = crypto.createHash('sha256').update(JSON.stringify(genData)).digest('hex');
    content += `> Generation hash: ${hashStr}\n`;
    content += `> Source hashes: ${sourceHashes.join(', ')}\n\n`;

    content += `## New Servers/Skills Since Prior Day\n`;
    if (sortedNew.length === 0) {
      content += `- None\n`;
    }
    for (const row of sortedNew) {
      content += `- **${row.name}** (${row.slug}) - ${row.pricing} - Verdict: ${validateRowVerdict(row)}\n`;
    }

    content += `\n## Broken Summary\n`;
    if (sortedBroken.length === 0) {
      content += `- None\n`;
    }
    for (const row of sortedBroken) {
      content += `- **${row.name}** (${row.slug}) - ${row.pricing} - Broken since ${row.failure_observed_at}\n`;
    }

    content += `\n## Watch Totals & Deltas\n`;
    content += `Total available: ${availableRows.length} (Delta: ${availableRows.length - priorAvailCount})\n`;
    content += `Total broken: ${brokenRows.length} (Delta: ${brokenRows.length - priorBrokenCount})\n`;

    content += `\n## Fetch-gap Log\n`;
    if (fetchGaps.length === 0) {
      content += `- No gaps\n`;
    } else {
      for (const gap of fetchGaps.slice(0, 100)) { // bounded list
        content += `- Query: ${gap.query} | Expected: ${gap.expected_count} | Found: ${gap.found_count}\n`;
      }
    }

    this.writeAtomic(targetPath, content);
    return { receipt: backupReceipt.receipt };
  }

  public renderCatalogSection(workingRows: InstalledWorking[], brokenRows: InstalledBroken[]): string {
    const sortCaps = <T extends CapabilityBase>(caps: T[]) => {
      return [...caps].sort((a, b) => {
        const diff = PricingSortTier[a.pricing] - PricingSortTier[b.pricing];
        if (diff !== 0) return diff;
        return a.name.localeCompare(b.name);
      });
    };

    const sortedWorking = sortCaps(workingRows);
    const sortedBroken = sortCaps(brokenRows);

    let res = `### Installed Working\n\n`;
    for (const row of sortedWorking) {
      res += `- **${row.name}** (${row.slug}) - ${row.pricing} | Surface: ${row.surface_owner} | Class: ${row.capture_class} | Verified: ${row.last_verified} | Stale: ${row.stale_at} | Notes: ${row.curated_notes ?? 'None'}\n`;
    }

    res += `\n### Installed Broken\n\n`;
    for (const row of sortedBroken) {
      res += `- **${row.name}** (${row.slug}) - ${row.pricing} | Surface: ${row.surface_owner} | Class: ${row.capture_class} | Verified: ${row.last_verified} | Stale: ${row.stale_at} | Notes: ${row.curated_notes ?? 'None'}\n`;
    }

    return res.trim();
  }
}
