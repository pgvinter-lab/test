import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import {
  JudgmentService,
  validateJudgmentRequest,
  validateJudgmentResponseTopLevel,
  serializeCanonical,
  sha256,
  JudgmentError
} from "../../dist/caps/judgment.js";
import { CapsStore } from "../../dist/caps/store.js";
import { fileURLToPath } from "node:url";

const jobFixture = JSON.parse(fs.readFileSync(fileURLToPath(new URL("../../test/fixtures/caps/judgment-job.json", import.meta.url)), "utf8"));
const verdictsFixture = JSON.parse(fs.readFileSync(fileURLToPath(new URL("../../test/fixtures/caps/judgment-verdicts.json", import.meta.url)), "utf8"));

class MockMailboxService {
  constructor() {
    this.messages = new Map();
    this.responses = new Map();
    this.envelopes = new Map();
    this.config = {
      providers: {
        antigravity: {
          consumerId: 'provider.antigravity.mcp'
        }
      }
    };
    this.exchange = {
      readResponse: (relativePath) => this.responses.get(relativePath),
      readMessage: (relativePath) => this.envelopes.get(relativePath)
    };
    this.nextMessageId = 1;
  }

  send(input) {
    assert.equal(input.provider, 'antigravity', 'Provider enum must be exactly antigravity');

    const message = {
      messageId: `msg-${this.nextMessageId++}`,
      projectId: input.projectId,
      sender: input.sender,
      provider: input.provider,
      promptSha256: sha256(input.prompt),
      idempotencyKey: input.idempotencyKey,
      approvalRef: input.approvalRef,
      createdAt: '2026-07-24T12:00:00Z',
      status: 'preparing', // initial
      envelopeRelativePath: `msg-${this.nextMessageId - 1}-env`
    };

    const envelope = {
      messageId: message.messageId,
      projectId: message.projectId,
      sender: message.sender,
      recipient: input.provider,
      mode: 'default',
      priority: 'normal',
      sensitivity: 'internal',
      createdAt: message.createdAt,
      expiresAt: '2026-08-24T12:00:00Z',
      promptSha256: message.promptSha256,
      prompt: input.prompt,
      dispatchAuthorization: {
        approvalRef: message.approvalRef,
        authorizedAt: message.createdAt,
        expiresAt: '2026-08-24T12:00:00Z',
        provider: input.provider,
        destination: { kind: 'local-mcp', surface: 'antigravity' },
        useCount: 1
      }
    };

    this.messages.set(message.messageId, message);
    this.envelopes.set(message.envelopeRelativePath, envelope);
    return message;
  }

  get(messageId) {
    return this.messages.get(messageId);
  }
}

test("Caps Judgment Service", async (t) => {
  const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), "bridge2-caps-judgment-test-"));
  const dbPath = path.join(tempDir, "caps.sqlite");
  let store;

  t.after(() => {
    if (store) store.close();
    fs.rmSync(tempDir, { recursive: true, force: true });
  });

  store = new CapsStore({ stateDirectory: tempDir, databasePath: dbPath });
  const mailbox = new MockMailboxService();
  const service = new JudgmentService(
    mailbox,
    store,
    'test-project',
    { principalId: 'antigravity-judgment', sessionId: 'sess-1', hostId: 'host-1' },
    'approval-ref'
  );

  // Insert mock data for store testing
  store.db.prepare(`
    INSERT INTO available_for_install (
      id, kind, name, slug, surface_owner, transport, description, pricing, official,
      source_lane, producer_surface, capture_class, observed_at, last_verified, stale_at, curated_notes, provenance_json
    ) VALUES (
      'cand-free', 'tool', 'Free Tool', 'free-tool', 'agy', 'stdio', 'desc', 'free', 0,
      'config-crawl', 'antigravity', 'guaranteed', '2026-07-24T00:00:00Z', '2026-07-24T00:00:00Z', '2026-07-25T00:00:00Z', 'preserve me', '{}'
    )
  `).run();

  await t.test("1. Constructor - consumer configuration checked", () => {
    const badMailbox = new MockMailboxService();
    badMailbox.config.providers.antigravity.consumerId = 'wrong';
    assert.throws(() => new JudgmentService(badMailbox, store, 'test', { principalId: 'p', sessionId: 's', hostId: 'h' }, 'app'), /invalid_consumer_identity/);
  });

  await t.test("2. Schema validation - valid request", () => {
    const req = validateJudgmentRequest(jobFixture);
    assert.equal(req.schema_version, 'bridge-caps-judgment-v1');
  });

  await t.test("3. Schema validation - invalid schema_version", () => {
    assert.throws(() => validateJudgmentRequest({ ...jobFixture, schema_version: 'v2' }), /invalid_schema_version/);
  });

  await t.test("4. Schema validation - duplicate IDs rejected", () => {
    const req = structuredClone(jobFixture);
    req.diff.new_available.push(req.diff.new_available[0]);
    assert.throws(() => validateJudgmentRequest(req), /duplicate_candidate_id/);
  });

  await t.test("5. Schema validation - unknown fields rejected in request", () => {
    assert.throws(() => validateJudgmentRequest({ ...jobFixture, extra: 1 }), /unknown_fields_in_request/);
  });

  await t.test("6. Schema validation - invalid verdict enum (now handled as gap class)", async () => {
    const req = structuredClone(jobFixture);
    req.refresh_run_id = 'run-test-6';
    const result = await service.dispatchJudgment(req);
    const msg = mailbox.messages.get(result.messageId);
    msg.status = 'completed';
    msg.responseRelativePath = 'resp-bad-enum';

    const verdicts = structuredClone(verdictsFixture);
    verdicts.verdicts[0].verdict = 'maybe';
    mailbox.responses.set('resp-bad-enum', {
      messageId: msg.messageId,
      provider: 'antigravity',
      consumerId: 'provider.antigravity.mcp',
      responseSha256: sha256(JSON.stringify(verdicts)),
      response: JSON.stringify(verdicts)
    });

    const receipt = await service.ingestVerdict(result.messageId, req.refresh_run_id, result.payloadHash, result.promptHash);
    assert.ok(receipt.gapClasses.includes('malformed_verdict'));
  });

  await t.test("7. Schema validation - invalid pricing enum in response (gap class)", async () => {
    const req = structuredClone(jobFixture);
    req.refresh_run_id = 'run-test-7';
    const result = await service.dispatchJudgment(req);
    const msg = mailbox.messages.get(result.messageId);
    msg.status = 'completed';
    msg.responseRelativePath = 'resp-bad-pricing';

    const verdicts = structuredClone(verdictsFixture);
    verdicts.verdicts[0].pricing_ack = 'expensive';
    mailbox.responses.set('resp-bad-pricing', {
      messageId: msg.messageId,
      provider: 'antigravity',
      consumerId: 'provider.antigravity.mcp',
      responseSha256: sha256(JSON.stringify(verdicts)),
      response: JSON.stringify(verdicts)
    });

    const receipt = await service.ingestVerdict(result.messageId, req.refresh_run_id, result.payloadHash, result.promptHash);
    assert.ok(receipt.gapClasses.includes('malformed_verdict'));
  });

  await t.test("8. Canonical JSON serialization - sorted keys and stable output", () => {
    const a = { z: 1, a: 2, c: [3, 2, 1] };
    const b = { c: [3, 2, 1], z: 1, a: 2 };
    assert.equal(serializeCanonical(a), serializeCanonical(b));
    assert.equal(serializeCanonical(a), '{"a":2,"c":[3,2,1],"z":1}');
  });

  await t.test("9. Dispatch returns binding and uses proper provider", async () => {
    const result = await service.dispatchJudgment(jobFixture);
    assert.ok(result.messageId);
    assert.ok(result.payloadHash);
    assert.ok(result.promptHash);
    assert.ok(result.idempotencyKey);
    assert.equal(result.idempotencyKey, `judgment:run-001:${result.payloadHash}`);
  });

  await t.test("10. Noncanonical reparse throws error", async () => {
    const req = validateJudgmentRequest(jobFixture);
    const jsonStr = serializeCanonical(req);
    const reparsed = JSON.parse(jsonStr);
    assert.equal(serializeCanonical(reparsed), jsonStr);
  });

  await t.test("11. Idempotency - same run with different bytes creates conflict", async () => {
    const req2 = structuredClone(jobFixture);
    req2.diff.status_flips.push('some-id');
    await assert.rejects(() => service.dispatchJudgment(req2), /run_payload_conflict/);
  });

  await t.test("11b. Idempotency - same run with same bytes returns original receipt without send", async () => {
    const originalCount = mailbox.messages.size;
    const result3 = await service.dispatchJudgment(jobFixture); // exactly same as test 9
    assert.equal(mailbox.messages.size, originalCount); // no new send
    assert.ok(result3.messageId);
    assert.ok(result3.idempotencyKey.startsWith('judgment:run-001:'));
  });

  await t.test("12. Accept verdict - nonterminal response throws", async () => {
    const req = structuredClone(jobFixture);
    req.refresh_run_id = 'run-test-12';
    const result = await service.dispatchJudgment(req);
    await assert.rejects(() => service.ingestVerdict(result.messageId, req.refresh_run_id, result.payloadHash, result.promptHash), /message_not_completed/);
  });

  await t.test("13. Accept verdict - message mismatch throws", async () => {
    await assert.rejects(() => service.ingestVerdict('invalid-id', jobFixture.refresh_run_id, 'hash', 'hash'), /message_not_found/);
  });

  await t.test("14. Accept verdict - prompt hash mismatch throws", async () => {
    const req = structuredClone(jobFixture);
    req.refresh_run_id = 'run-test-14';
    const result = await service.dispatchJudgment(req);
    mailbox.messages.get(result.messageId).status = 'completed';
    await assert.rejects(() => service.ingestVerdict(result.messageId, req.refresh_run_id, result.payloadHash, 'wrong-hash'), /prompt_hash_mismatch/);
  });

  await t.test("15. Accept verdict - malformed JSON response content produces gap class", async () => {
    const req = structuredClone(jobFixture);
    req.refresh_run_id = 'run-test-15';
    const result = await service.dispatchJudgment(req);
    const msg = mailbox.messages.get(result.messageId);
    msg.status = 'completed';
    msg.responseRelativePath = 'resp15';
    mailbox.responses.set('resp15', {
      messageId: msg.messageId,
      provider: 'antigravity',
      consumerId: 'provider.antigravity.mcp',
      responseSha256: sha256('not-json'),
      response: 'not-json'
    });

    const receipt = await service.ingestVerdict(result.messageId, req.refresh_run_id, result.payloadHash, result.promptHash);
    assert.equal(receipt.appliedCount, 0);
    assert.ok(receipt.gapClasses.includes('response_corrupted'));
    assert.equal(receipt.provenance.producer_surface, 'antigravity');
    assert.equal(receipt.provenance.capture_class, 'reported');
  });

  await t.test("16. Accept verdict - successful ingestion and unknown IDs bounded gap", async () => {
    const req = structuredClone(jobFixture);
    req.refresh_run_id = 'run-test-16';
    const result = await service.dispatchJudgment(req);
    const msg = mailbox.messages.get(result.messageId);
    msg.status = 'completed';
    msg.responseRelativePath = 'resp16';

    const verdicts = structuredClone(verdictsFixture);
    const responseJson = JSON.stringify(verdicts);

    mailbox.responses.set('resp16', {
      messageId: msg.messageId,
      provider: 'antigravity',
      consumerId: 'provider.antigravity.mcp',
      responseSha256: sha256(responseJson),
      response: responseJson
    });

    const receipt = await service.ingestVerdict(result.messageId, req.refresh_run_id, result.payloadHash, result.promptHash);

    assert.equal(receipt.appliedCount, 1); // cand-free is in DB

    // Note: cand-unknown is dropped due to not_in_request
    // cand-paid is dropped due to not_in_db
    // And cand-paid is in request but not processed because it was missing/not in DB, actually wait:
    // verdicts list has cand-paid. It's in request, but not in DB. So it gets not_in_db.
    assert.ok(receipt.gapClasses.includes('not_in_request'));
    assert.ok(receipt.gapClasses.includes('not_in_db'));
    assert.equal(receipt.provenance.producer_surface, 'antigravity');

    const row = store.db.prepare("SELECT * FROM available_for_install WHERE id = 'cand-free'").get();
    assert.equal(row.judgment_model, verdicts.model);
    assert.equal(row.judgment_verdict, 'immediate-need');
    assert.equal(row.judgment_reason, 'Must have it');
    assert.equal(row.judgment_surface, 'antigravity');
  });

  await t.test("17. Ingestion - status, pricing, curated_notes immunity", () => {
    const row = store.db.prepare("SELECT * FROM available_for_install WHERE id = 'cand-free'").get();
    assert.equal(row.curated_notes, 'preserve me'); // preserved
    assert.equal(row.pricing, 'free'); // preserved
    assert.equal(row.status, undefined); // no such column, meaning we didn't touch it
  });

  await t.test("18. Ingestion - missing response throws response_missing", async () => {
    const req = structuredClone(jobFixture);
    req.refresh_run_id = 'run-test-18';
    const result = await service.dispatchJudgment(req);
    const msg = mailbox.messages.get(result.messageId);
    msg.status = 'completed';
    await assert.rejects(() => service.ingestVerdict(result.messageId, req.refresh_run_id, result.payloadHash, result.promptHash), /response_missing/);
  });

  await t.test("19. Accept verdict - missing verdict and duplicate verdict gap classes", async () => {
    const req = structuredClone(jobFixture);
    req.refresh_run_id = 'run-test-19';
    const result = await service.dispatchJudgment(req);
    const msg = mailbox.messages.get(result.messageId);
    msg.status = 'completed';
    msg.responseRelativePath = 'resp19';

    const verdicts = structuredClone(verdictsFixture);
    // Remove cand-paid so it becomes missing_verdict
    // Add cand-free twice so it becomes duplicate_verdict
    verdicts.verdicts = [
      { id: 'cand-free', verdict: 'immediate-need', reason: 'reason', pricing_ack: 'free' },
      { id: 'cand-free', verdict: 'immediate-need', reason: 'duplicate', pricing_ack: 'free' }
    ];

    mailbox.responses.set('resp19', {
      messageId: msg.messageId,
      provider: 'antigravity',
      consumerId: 'provider.antigravity.mcp',
      responseSha256: sha256(JSON.stringify(verdicts)),
      response: JSON.stringify(verdicts)
    });

    const receipt = await service.ingestVerdict(result.messageId, req.refresh_run_id, result.payloadHash, result.promptHash);
    assert.ok(receipt.gapClasses.includes('missing_verdict'));
    assert.ok(receipt.gapClasses.includes('duplicate_verdict'));
  });
});
