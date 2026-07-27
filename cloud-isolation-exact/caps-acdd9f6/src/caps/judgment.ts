import crypto from 'node:crypto';
import type {
  JudgmentRequest,
  JudgmentResponse,
  JudgmentRequestDiffCandidate,
  JudgmentVerdict,
  IngestionReceipt
} from './types.js';
import type { MailboxService } from '../v2/mailbox/service.js';
import type { CapsStore } from './store.js';
import { PricingSortTier } from './types.js';

export class JudgmentError extends Error {
  constructor(public readonly code: string, message?: string) {
    super(message || code);
    this.name = 'JudgmentError';
  }
}

export function sha256(data: string | Buffer): string {
  return crypto.createHash('sha256').update(data).digest('hex');
}

export function serializeCanonical(obj: unknown): string {
  if (obj === null) return 'null';
  if (typeof obj === 'boolean' || typeof obj === 'number' || typeof obj === 'string') {
    return JSON.stringify(obj);
  }
  if (Array.isArray(obj)) {
    return '[' + obj.map(item => serializeCanonical(item)).join(',') + ']';
  }
  if (typeof obj === 'object') {
    const keys = Object.keys(obj).sort();
    let out = '{';
    for (let i = 0; i < keys.length; i++) {
      if (i > 0) out += ',';
      out += JSON.stringify(keys[i]) + ':' + serializeCanonical((obj as Record<string, unknown>)[keys[i]]);
    }
    out += '}';
    return out;
  }
  throw new Error(`cannot serialize type ${typeof obj}`);
}

function isStr(v: unknown, maxLen = 65536): v is string {
  return typeof v === 'string' && Buffer.byteLength(v, 'utf8') <= maxLen;
}
function isTimestamp(v: unknown): v is string {
  if (!isStr(v, 64)) return false;
  if (!v.endsWith('Z')) return false;
  const d = Date.parse(v);
  return !Number.isNaN(d);
}
function isArr(v: unknown, maxLen = 1000): v is any[] {
  if (!Array.isArray(v) || v.length > maxLen) return false;
  for (let i = 0; i < v.length; i++) {
    if (!(i in v)) return false;
  }
  return true;
}
function isObj(v: unknown): v is Record<string, unknown> {
  return typeof v === 'object' && v !== null && !Array.isArray(v);
}
function checkKeys(obj: Record<string, unknown>, allowed: string[]) {
  const allowedSet = new Set(allowed);
  for (const k of Object.keys(obj)) {
    if (!allowedSet.has(k)) throw new JudgmentError('unknown_fields_in_request'); // Using this specific error since tests expect it
  }
}

export function validateJudgmentRequest(req: unknown): JudgmentRequest {
  if (!isObj(req)) throw new JudgmentError('invalid_request');
  checkKeys(req, ['schema_version', 'refresh_run_id', 'generated_at', 'needs_profile', 'diff', 'rules', 'response_contract']);

  if (req.schema_version !== 'bridge-caps-judgment-v1') throw new JudgmentError('invalid_schema_version');
  if (!isStr(req.refresh_run_id, 255)) throw new JudgmentError('invalid_refresh_run_id');
  if (!isTimestamp(req.generated_at)) throw new JudgmentError('invalid_timestamp');

  const prof = req.needs_profile;
  if (!isObj(prof)) throw new JudgmentError('invalid_needs_profile');
  checkKeys(prof, ['path', 'sha256']);
  if (!isStr(prof.path, 1024)) throw new JudgmentError('invalid_profile_path');
  if (!isStr(prof.sha256, 64) || !/^[a-f0-9]{64}$/.test(prof.sha256)) throw new JudgmentError('invalid_sha256');

  const diff = req.diff;
  if (!isObj(diff)) throw new JudgmentError('invalid_diff');
  checkKeys(diff, ['new_available', 'status_flips', 'watch_deltas']);

  if (!isArr(diff.new_available)) throw new JudgmentError('invalid_new_available');
  if (!isArr(diff.status_flips)) throw new JudgmentError('invalid_status_flips');
  if (!isArr(diff.watch_deltas)) throw new JudgmentError('invalid_watch_deltas');

  for (const f of diff.status_flips) {
    if (!isStr(f, 255)) throw new JudgmentError('invalid_status_flip_id');
  }
  for (const w of diff.watch_deltas) {
    if (!isStr(w, 255)) throw new JudgmentError('invalid_watch_delta_id');
  }

  const seenIds = new Set<string>();
  for (const cand of diff.new_available) {
    if (!isObj(cand)) throw new JudgmentError('invalid_candidate');
    checkKeys(cand, ['id', 'name', 'kind', 'pricing', 'category', 'one_liner', 'source_url', 'ask_first']);

    if (!isStr(cand.id, 255)) throw new JudgmentError('invalid_candidate_id');
    if (seenIds.has(cand.id)) throw new JudgmentError('duplicate_candidate_id');
    seenIds.add(cand.id);

    if (!isStr(cand.name, 1024)) throw new JudgmentError('invalid_candidate_name');
    if (cand.kind !== 'server' && cand.kind !== 'tool' && cand.kind !== 'skill') throw new JudgmentError('invalid_kind');
    if (cand.pricing !== 'free' && cand.pricing !== 'unknown' && cand.pricing !== 'paid') throw new JudgmentError('invalid_pricing');

    if (cand.category !== null && !isStr(cand.category, 255)) throw new JudgmentError('invalid_category');
    if (cand.one_liner !== null && !isStr(cand.one_liner, 4096)) throw new JudgmentError('invalid_one_liner');
    if (cand.source_url !== null && !isStr(cand.source_url, 4096)) throw new JudgmentError('invalid_source_url');

    if (cand.pricing === 'paid' && cand.ask_first !== true) throw new JudgmentError('invalid_ask_first');
    if (cand.pricing !== 'paid' && cand.ask_first !== false) throw new JudgmentError('invalid_ask_first');
  }

  const rules = req.rules;
  if (!isObj(rules)) throw new JudgmentError('invalid_rules');
  checkKeys(rules, ['free_first', 'paid_ask_first']);
  if (rules.free_first !== true) throw new JudgmentError('invalid_rule_literal');
  if (rules.paid_ask_first !== true) throw new JudgmentError('invalid_rule_literal');

  const contract = req.response_contract;
  if (!isObj(contract)) throw new JudgmentError('invalid_response_contract');
  checkKeys(contract, ['model', 'judged_at', 'verdicts']);
  if (!isStr(contract.model, 255)) throw new JudgmentError('invalid_contract_model');
  if (!isStr(contract.judged_at, 255)) throw new JudgmentError('invalid_contract_judged_at');

  if (!isArr(contract.verdicts)) throw new JudgmentError('invalid_contract_verdicts');
  const seenVerdicts = new Set<string>();
  for (const v of contract.verdicts) {
    if (!isObj(v)) throw new JudgmentError('invalid_contract_verdict');
    checkKeys(v, ['id', 'verdict', 'reason', 'pricing_ack']);
    if (!isStr(v.id, 255)) throw new JudgmentError('invalid_contract_verdict_id');
    if (seenVerdicts.has(v.id)) throw new JudgmentError('duplicate_contract_verdict_id');
    seenVerdicts.add(v.id);
    if (!isStr(v.verdict, 255)) throw new JudgmentError('invalid_contract_verdict_enum');
    if (!isStr(v.reason, 65536)) throw new JudgmentError('invalid_contract_verdict_reason');
    if (!isStr(v.pricing_ack, 255)) throw new JudgmentError('invalid_contract_verdict_pricing');
  }

  return req as unknown as JudgmentRequest;
}

export function validateJudgmentResponseTopLevel(res: unknown): { model: string, judged_at: string, verdicts: unknown[] } {
  if (!isObj(res)) throw new JudgmentError('invalid_response');
  const allowedSet = new Set(['model', 'judged_at', 'verdicts']);
  for (const k of Object.keys(res)) {
    if (!allowedSet.has(k)) throw new JudgmentError('unknown_fields_in_response');
  }

  if (!isStr(res.model, 1024)) throw new JudgmentError('invalid_model');
  if (!isTimestamp(res.judged_at)) throw new JudgmentError('invalid_timestamp');

  if (!isArr(res.verdicts)) throw new JudgmentError('invalid_verdicts');

  return res as { model: string, judged_at: string, verdicts: unknown[] };
}

export function buildJudgmentRequest(
  refreshRunId: string,
  generatedAt: string,
  needsProfile: { path: string; sha256: string },
  newAvailable: Omit<JudgmentRequestDiffCandidate, 'ask_first'>[],
  statusFlips: string[],
  watchDeltas: string[]
): JudgmentRequest {
  const sorted = [...newAvailable].sort((a, b) => {
    if (a.pricing !== b.pricing) {
      return PricingSortTier[a.pricing] - PricingSortTier[b.pricing];
    }
    return a.id.localeCompare(b.id);
  });

  const hasFree = sorted.some(c => c.pricing === 'free');
  if (sorted.length > 0 && sorted[0].pricing === 'paid' && hasFree) {
    throw new JudgmentError('invalid_primary_paid', 'Cannot have paid primary while free candidate exists');
  }

  const candidates: JudgmentRequestDiffCandidate[] = sorted.map(c => ({
    ...c,
    ask_first: c.pricing === 'paid'
  }));

  return {
    schema_version: 'bridge-caps-judgment-v1',
    refresh_run_id: refreshRunId,
    generated_at: generatedAt,
    needs_profile: needsProfile,
    diff: {
      new_available: candidates,
      status_flips: statusFlips,
      watch_deltas: watchDeltas
    },
    rules: {
      free_first: true,
      paid_ask_first: true
    },
    response_contract: {
      model: '<model name>',
      judged_at: '<ISO-8601 timestamp>',
      verdicts: candidates.map(c => ({
        id: c.id,
        verdict: '<immediate-need|watch|no>' as JudgmentVerdict,
        reason: '<reason string>',
        pricing_ack: '<free|unknown|paid>' as any
      }))
    }
  };
}

export class JudgmentService {
  private dispatchReceipts = new Map<string, {
    payloadHash: string;
    receipt: {
      messageId: string;
      payloadHash: string;
      promptHash: string;
      idempotencyKey: string;
      dispatchTimestamp: string;
    };
  }>();
  constructor(
    private readonly mailbox: MailboxService,
    private readonly store: CapsStore,
    private readonly projectId: string,
    private readonly sender: { principalId: string; sessionId: string; hostId: string },
    private readonly approvalRef: string
  ) {
    if (mailbox.config.providers.antigravity?.consumerId !== 'provider.antigravity.mcp') {
      throw new JudgmentError('invalid_consumer_identity');
    }
  }

  public async dispatchJudgment(requestObj: unknown): Promise<{
    messageId: string;
    payloadHash: string;
    promptHash: string;
    idempotencyKey: string;
    dispatchTimestamp: string;
  }> {
    const validReq = validateJudgmentRequest(requestObj);
    const canonicalJson = serializeCanonical(validReq);

    let reparsed: unknown;
    try {
      reparsed = JSON.parse(canonicalJson);
    } catch {
      throw new JudgmentError('noncanonical_reparse');
    }
    if (serializeCanonical(reparsed) !== canonicalJson) {
      throw new JudgmentError('noncanonical_reparse');
    }

    const payloadHash = sha256(canonicalJson);

    const existing = this.dispatchReceipts.get(validReq.refresh_run_id);
    if (existing) {
      if (existing.payloadHash !== payloadHash) {
        throw new JudgmentError('run_payload_conflict');
      }
      return existing.receipt;
    }

    const idempotencyKey = `judgment:${validReq.refresh_run_id}:${payloadHash}`;
    const prompt = canonicalJson;
    const promptHash = sha256(prompt);

    const message = this.mailbox.send({
      projectId: this.projectId,
      sender: this.sender,
      provider: 'antigravity',
      prompt,
      idempotencyKey,
      approvalRef: this.approvalRef
    });

    const receipt = {
      messageId: message.messageId,
      payloadHash,
      promptHash,
      idempotencyKey,
      dispatchTimestamp: message.createdAt
    };

    this.dispatchReceipts.set(validReq.refresh_run_id, { payloadHash, receipt });
    return receipt;
  }

  public async ingestVerdict(
    messageId: string,
    refreshRunId: string,
    expectedPayloadHash: string,
    expectedPromptHash: string
  ): Promise<IngestionReceipt> {
    const message = this.mailbox.get(messageId);
    if (!message) throw new JudgmentError('message_not_found');

    if (message.status !== 'completed') throw new JudgmentError('message_not_completed');
    if (message.promptSha256 !== expectedPromptHash) throw new JudgmentError('prompt_hash_mismatch');

    if (!message.envelopeRelativePath) throw new JudgmentError('envelope_missing');
    const envelope = this.mailbox.exchange.readMessage(message.envelopeRelativePath);
    if (envelope.messageId !== messageId) throw new JudgmentError('envelope_message_id_mismatch');
    if (envelope.projectId !== this.projectId) throw new JudgmentError('envelope_project_id_mismatch');
    if (envelope.recipient !== 'antigravity') throw new JudgmentError('envelope_recipient_mismatch');
    if (envelope.dispatchAuthorization.provider !== 'antigravity') throw new JudgmentError('envelope_auth_provider_mismatch');
    if (sha256(envelope.prompt) !== expectedPromptHash) throw new JudgmentError('envelope_prompt_hash_mismatch');

    let promptReq: JudgmentRequest;
    try {
      promptReq = validateJudgmentRequest(JSON.parse(envelope.prompt));
    } catch (e: any) {
      throw new JudgmentError('prompt_malformed');
    }

    if (promptReq.refresh_run_id !== refreshRunId) throw new JudgmentError('refresh_run_id_mismatch');

    const canonicalPrompt = serializeCanonical(promptReq);
    if (sha256(canonicalPrompt) !== expectedPayloadHash) throw new JudgmentError('payload_hash_mismatch');

    if (!message.responseRelativePath) throw new JudgmentError('response_missing');
    const responseData = this.mailbox.exchange.readResponse(message.responseRelativePath);
    if (responseData.messageId !== messageId) throw new JudgmentError('response_message_id_mismatch');
    if (responseData.provider !== 'antigravity') throw new JudgmentError('response_provider_mismatch');
    if (responseData.consumerId !== 'provider.antigravity.mcp') throw new JudgmentError('response_consumer_mismatch');
    if (responseData.responseSha256 !== sha256(responseData.response)) throw new JudgmentError('response_hash_mismatch');

    let parsed: unknown;
    let validTopLevel;
    try {
      parsed = JSON.parse(responseData.response);
      validTopLevel = validateJudgmentResponseTopLevel(parsed);
    } catch {
      return {
        responseHash: responseData.responseSha256,
        appliedCount: 0,
        idempotentCount: 0,
        gapClasses: ['response_corrupted'],
        provenance: { producer_surface: 'antigravity', capture_class: 'reported' }
      };
    }

    const requestIds = new Set(promptReq.diff.new_available.map(c => c.id));
    const verdictsToApply = [];
    const gapClasses = new Set<string>();
    const seenResponseIds = new Set<string>();

    for (const v of validTopLevel.verdicts) {
      if (!isObj(v)) { gapClasses.add('malformed_verdict'); continue; }

      const vAllowed = new Set(['id', 'verdict', 'reason', 'pricing_ack']);
      let hasUnknown = false;
      for (const k of Object.keys(v)) {
        if (!vAllowed.has(k)) hasUnknown = true;
      }
      if (hasUnknown) { gapClasses.add('malformed_verdict'); continue; }

      if (!isStr(v.id, 255)) { gapClasses.add('malformed_verdict'); continue; }
      if (seenResponseIds.has(v.id)) { gapClasses.add('duplicate_verdict'); continue; }
      seenResponseIds.add(v.id);

      if (v.verdict !== 'immediate-need' && v.verdict !== 'watch' && v.verdict !== 'no') { gapClasses.add('malformed_verdict'); continue; }
      if (!isStr(v.reason, 65536)) { gapClasses.add('malformed_verdict'); continue; }
      if (v.pricing_ack !== 'free' && v.pricing_ack !== 'unknown' && v.pricing_ack !== 'paid') { gapClasses.add('malformed_verdict'); continue; }

      if (!requestIds.has(v.id)) {
        gapClasses.add('not_in_request');
        continue;
      }
      verdictsToApply.push({
        id: v.id,
        judgment_model: validTopLevel.model,
        judgment_at: validTopLevel.judged_at,
        judgment_verdict: v.verdict,
        judgment_reason: v.reason,
        judgment_surface: 'antigravity'
      });
    }

    for (const reqId of requestIds) {
      if (!seenResponseIds.has(reqId)) gapClasses.add('missing_verdict');
    }

    const { appliedCount, idempotentCount, notInDbCount } = this.store.recordJudgmentVerdict(verdictsToApply);
    if (notInDbCount > 0) gapClasses.add('not_in_db');

    return {
      responseHash: responseData.responseSha256,
      appliedCount,
      idempotentCount,
      gapClasses: Array.from(gapClasses),
      provenance: { producer_surface: 'antigravity', capture_class: 'reported' }
    };
  }
}
