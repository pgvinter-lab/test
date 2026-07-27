import fs from 'node:fs';
import crypto from 'node:crypto';

export interface NeedsProfileProvenance {
  source_path: string;
  source_section: string;
  source_sha256: string;
  observed_at: string;
  capture_class: 'guaranteed';
  producer_surface: 'code';
}

export interface Need {
  id: string;
  title: string;
  purpose: string;
  match_terms: string[];
  priority: 'high' | 'medium' | 'low';
  free_first_policy: boolean;
}

export interface NeedsProfile {
  schema: 'bridge-caps-needs-v1';
  profile_id: string;
  owner_managed: true;
  updated_at: string;
  provenance: NeedsProfileProvenance;
  needs: Need[];
}

export const SEEDED_NEEDS: Need[] = [
  {
    id: "G2",
    title: "Venue Profile Fetcher",
    purpose: "Fetch court/venue specific rules, procedures, and profiles.",
    match_terms: ["venue", "court", "profile", "rules", "fetcher"],
    priority: "high",
    free_first_policy: true
  },
  {
    id: "G3",
    title: "Per-venue Deadline Engine",
    purpose: "Calculate and track deadlines according to specific venue rules.",
    match_terms: ["deadline", "timeline", "rules", "engine", "venue"],
    priority: "high",
    free_first_policy: true
  },
  {
    id: "G4",
    title: "Judge and Opposing Counsel Analytics",
    purpose: "Analyze histories and tendencies of judges and opposing counsel from free sources.",
    match_terms: ["judge", "counsel", "analytics", "history", "tendencies"],
    priority: "medium",
    free_first_policy: true
  },
  {
    id: "G5",
    title: "Jurisdiction-correct Forms and Templates",
    purpose: "Provide correct legal forms and templates based on jurisdiction.",
    match_terms: ["forms", "templates", "jurisdiction", "correct"],
    priority: "high",
    free_first_policy: true
  }
];

export function validateNeedsProfile(data: any): data is NeedsProfile {
  if (!data || typeof data !== 'object') return false;

  const topKeys = Object.keys(data).sort();
  const expectedTopKeys = ['schema', 'profile_id', 'owner_managed', 'updated_at', 'provenance', 'needs'].sort();
  if (topKeys.join(',') !== expectedTopKeys.join(',')) return false;

  if (data.schema !== 'bridge-caps-needs-v1') return false;
  if (typeof data.profile_id !== 'string' || data.profile_id.trim() === '' || data.profile_id.length > 255) return false;
  if (data.owner_managed !== true) return false;
  if (typeof data.updated_at !== 'string' || !/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(\.\d+)?Z$/.test(data.updated_at)) return false;

  const p = data.provenance;
  if (!p || typeof p !== 'object') return false;

  const provKeys = Object.keys(p).sort();
  const expectedProvKeys = ['source_path', 'source_section', 'source_sha256', 'observed_at', 'capture_class', 'producer_surface'].sort();
  if (provKeys.join(',') !== expectedProvKeys.join(',')) return false;

  if (typeof p.source_path !== 'string' || p.source_path.trim() === '' || p.source_path.length > 1024) return false;
  if (typeof p.source_section !== 'string' || p.source_section.trim() === '' || p.source_section.length > 255) return false;
  if (typeof p.source_sha256 !== 'string' || !/^[0-9a-f]{64}$/.test(p.source_sha256)) return false;
  if (typeof p.observed_at !== 'string' || !/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(\.\d+)?Z$/.test(p.observed_at)) return false;
  if (p.capture_class !== 'guaranteed') return false;
  if (p.producer_surface !== 'code') return false;

  if (!Array.isArray(data.needs) || data.needs.length > 100) return false;

  for (const n of data.needs) {
    if (!n || typeof n !== 'object') return false;

    const needKeys = Object.keys(n).sort();
    const expectedNeedKeys = ['id', 'title', 'purpose', 'match_terms', 'priority', 'free_first_policy'].sort();
    if (needKeys.join(',') !== expectedNeedKeys.join(',')) return false;

    if (typeof n.id !== 'string' || n.id.trim() === '' || n.id.length > 100) return false;
    if (typeof n.title !== 'string' || n.title.trim() === '' || n.title.length > 255) return false;
    if (typeof n.purpose !== 'string' || n.purpose.trim() === '' || n.purpose.length > 1024) return false;
    if (typeof n.free_first_policy !== 'boolean') return false;
    if (!['high', 'medium', 'low'].includes(n.priority)) return false;

    if (!Array.isArray(n.match_terms) || n.match_terms.length > 50) return false;
    for (const term of n.match_terms) {
      if (typeof term !== 'string' || term.trim() === '' || term.length > 100) return false;
    }
  }

  return true;
}

export function initializeNeedsProfile(
  targetPath: string,
  sourcePath: string,
  sourceSection: string,
  sourceSha256: string,
  observedAt: string
): NeedsProfile {
  let stat;
  try {
    stat = fs.lstatSync(sourcePath);
  } catch (e) {
    throw new Error("invalid_source_path");
  }
  if (!stat.isFile()) {
    throw new Error("invalid_source_path");
  }

  const sourceBytes = fs.readFileSync(sourcePath);
  const computedSha256 = crypto.createHash('sha256').update(sourceBytes).digest('hex');
  if (computedSha256 !== sourceSha256) {
    throw new Error("source_hash_mismatch");
  }

  const actualObservedAt = new Date().toISOString();

  let fd: number | null = null;
  const profile: NeedsProfile = {
    schema: 'bridge-caps-needs-v1',
    profile_id: 'default-owner-needs',
    owner_managed: true,
    updated_at: new Date().toISOString(),
    provenance: {
      source_path: sourcePath,
      source_section: sourceSection,
      source_sha256: computedSha256,
      observed_at: actualObservedAt,
      capture_class: 'guaranteed',
      producer_surface: 'code'
    },
    needs: SEEDED_NEEDS
  };

  try {
    fd = fs.openSync(targetPath, 'wx');
    fs.writeSync(fd, JSON.stringify(profile, null, 2));
    fs.fsyncSync(fd);
    fs.closeSync(fd);
    fd = null;
    return profile;
  } catch (err: any) {
    if (fd !== null) {
      try { fs.closeSync(fd); } catch (e) {}
    }
    if (err.code === 'EEXIST') {
      const content = fs.readFileSync(targetPath, 'utf8');
      let parsed;
      try {
        parsed = JSON.parse(content);
      } catch (e) {
        throw new Error("invalid_needs_profile");
      }
      if (!validateNeedsProfile(parsed)) {
        throw new Error("invalid_needs_profile");
      }
      return parsed;
    }
    throw err;
  }
}
