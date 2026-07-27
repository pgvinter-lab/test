import assert from "node:assert/strict";
import fs from "node:fs";
import net from "node:net";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { MailboxBroker } from "../../dist/v2/mailbox/broker.js";
import { initializeMailboxConfig, loadMailboxConfig, mailboxBrokerUrl, readBrokerToken } from "../../dist/v2/mailbox/config.js";
import { MailboxService } from "../../dist/v2/mailbox/service.js";

function fixture() {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "bridge-mailbox-"));
  const stateDirectory = path.join(root, "state");
  const exchangeRoot = path.join(root, "drive", "Bridge Exchange");
  const config = initializeMailboxConfig({ exchangeRoot, stateDirectory });
  return { root, stateDirectory, exchangeRoot, config, configPath: path.join(stateDirectory, "config.json") };
}

function input(overrides = {}) {
  return {
    projectId: "project.synthetic",
    sender: {
      principalId: "principal.codex",
      sessionId: "session.synthetic",
      hostId: "host.synthetic",
    },
    provider: "chatgpt",
    prompt: "Synthetic mailbox contract prompt. No user data.",
    idempotencyKey: "mailbox-test-idempotency-0001",
    approvalRef: "approval.synthetic.0001",
    ...overrides,
  };
}

test("mailbox delivery is provider-bound, durable, and idempotent", () => {
  const { root, stateDirectory, exchangeRoot, config } = fixture();
  const first = new MailboxService(config);
  const second = new MailboxService(config);
  try {
    const queued = first.send(input());
    assert.equal(queued.status, "queued");
    assert.equal(queued.approvalRef, "approval.synthetic.0001");
    assert.equal(first.send(input()).messageId, queued.messageId);
    assert.throws(() => first.send(input({ prompt: "different" })), /mailbox_idempotency_key_reused/u);
    assert.ok(queued.envelopeRelativePath);
    assert.match(queued.envelopeRelativePath, /^v3\/projects\/[^/]+\/chatgpt\/inbox\//u);
    assert.deepEqual(Object.keys(config.providers).sort(), ["antigravity", "chatgpt", "web"]);
    assert.equal(path.relative(exchangeRoot, config.databasePath).startsWith(".."), true);
    assert.equal(path.relative(stateDirectory, config.databasePath).startsWith(".."), false);

    const claim = first.take("chatgpt", "provider.chatgpt.test");
    assert.ok(claim);
    assert.equal(claim.message.prompt, input().prompt);
    assert.equal(claim.message.dispatchAuthorization.useCount, 1);
    assert.deepEqual(claim.message.dispatchAuthorization.destination, {
      kind: "browser-origin",
      origin: "https://chatgpt.com",
    });
    assert.equal(second.take("chatgpt", "provider.chatgpt.other"), undefined);
    assert.equal(first.take("antigravity", "provider.antigravity.test"), undefined);

    first.markDispatching(claim.deliveryId, claim.deliveryToken);
    first.markSent(claim.deliveryId, claim.deliveryToken);
    const complete = first.complete({
      deliveryId: claim.deliveryId,
      deliveryToken: claim.deliveryToken,
      response: "Synthetic response.",
      conversationUrl: "https://chatgpt.com/c/synthetic",
    });
    assert.equal(complete.status, "completed");
    assert.equal(first.complete({
      deliveryId: claim.deliveryId,
      deliveryToken: claim.deliveryToken,
      response: "Synthetic response.",
      conversationUrl: "https://chatgpt.com/c/synthetic",
    }).status, "completed");
    assert.throws(() => first.complete({
      deliveryId: claim.deliveryId,
      deliveryToken: claim.deliveryToken,
      response: "changed response",
    }), /mailbox_response_retry_conflict/u);
    assert.equal(first.store.verifyEventChain().ok, true);
    assert.equal(first.store.database.prepare("PRAGMA user_version").get().user_version, 3);
    const messagesSql = first.store.database.prepare("SELECT sql FROM sqlite_master WHERE type = 'table' AND name = 'mailbox_messages'").get().sql;
    assert.match(messagesSql, /sensitivity IN \('public','internal'\)/u);
    assert.doesNotMatch(messagesSql, /confidential|restricted/u);
    const doctor = first.doctor();
    assert.equal(doctor.database.journalMode, "wal");
    assert.equal(doctor.database.auditMirror.count, doctor.database.events);
    const audit = fs.readFileSync(config.auditMirrorPath, "utf8");
    assert.match(audit, /approval\.synthetic\.0001/u);
    assert.doesNotMatch(audit, new RegExp(input().prompt.replace(/[.*+?^${}()|[\]\\]/gu, "\\$&"), "u"));
    assert.doesNotMatch(audit, /Synthetic response\./u);
    assert.doesNotMatch(audit, new RegExp(claim.deliveryToken, "u"));
  } finally {
    second.close();
    first.close();
    fs.rmSync(root, { recursive: true, force: true });
  }
});

test("generic WEB nodes bind node, origin, browser response, and readable Drive output", () => {
  const { root, exchangeRoot, config } = fixture();
  const mailbox = new MailboxService(config);
  try {
    assert.throws(() => mailbox.send(input({
      provider: "web",
      idempotencyKey: "mailbox-web-node-missing",
    })), /web_node_id_required/u);
    assert.throws(() => mailbox.send(input({
      provider: "web",
      webNodeId: "unknown",
      idempotencyKey: "mailbox-web-node-unknown",
    })), /web_node_not_found_or_disabled/u);

    const queued = mailbox.send(input({
      provider: "web",
      webNodeId: "perplexity",
      prompt: "Return the word synthetic.",
      idempotencyKey: "mailbox-web-perplexity-idempotency",
      approvalRef: "approval.synthetic.web.perplexity",
    }));
    assert.match(queued.envelopeRelativePath, /^v3\/projects\/[^/]+\/web\/inbox\//u);
    assert.equal(mailbox.webNodeResult(queued.messageId).message.status, "queued");

    const claim = mailbox.take("web", "provider.web.chrome");
    assert.ok(claim);
    assert.equal(claim.message.webNodeId, "perplexity");
    assert.deepEqual(claim.message.dispatchAuthorization.destination, {
      kind: "browser-origin",
      origin: "https://www.perplexity.ai",
      webNodeId: "perplexity",
    });
    mailbox.markDispatching(claim.deliveryId, claim.deliveryToken);
    mailbox.markSent(claim.deliveryId, claim.deliveryToken);
    assert.throws(() => mailbox.complete({
      deliveryId: claim.deliveryId,
      deliveryToken: claim.deliveryToken,
      response: "synthetic",
      conversationUrl: "https://example.com/not-perplexity",
    }), /mailbox_conversation_origin_mismatch/u);
    assert.equal(mailbox.complete({
      deliveryId: claim.deliveryId,
      deliveryToken: claim.deliveryToken,
      response: "synthetic",
      conversationUrl: "https://www.perplexity.ai/search/synthetic",
    }).status, "completed");

    const result = mailbox.webNodeResult(queued.messageId);
    assert.equal(result.webNodeId, "perplexity");
    assert.equal(result.displayName, "Perplexity");
    assert.equal(result.response, "synthetic");
    assert.equal(result.conversationUrl, "https://www.perplexity.ai/search/synthetic");
    assert.match(result.driveOutputRelativePath, /^v3\/projects\/[^/]+\/web\/outputs\/perplexity\//u);
    assert.equal(path.relative(exchangeRoot, result.driveOutputPath).startsWith(".."), false);
    const markdown = fs.readFileSync(result.driveOutputPath, "utf8");
    assert.match(markdown, /^# Perplexity response/mu);
    assert.match(markdown, /## Prompt[\s\S]+Return the word synthetic\./u);
    assert.match(markdown, /## Response\s+synthetic/u);
  } finally {
    mailbox.close();
    fs.rmSync(root, { recursive: true, force: true });
  }
});

test("heartbeat never shortens a delivery lease", () => {
  const { root, config } = fixture();
  let milliseconds = Date.parse("2026-07-14T12:00:00.000Z");
  const mailbox = new MailboxService(config, () => new Date(milliseconds).toISOString());
  try {
    mailbox.send(input({ idempotencyKey: "mailbox-heartbeat-idempotency" }));
    const claim = mailbox.take("chatgpt", "provider.chatgpt.test");
    assert.ok(claim);
    milliseconds += 60_000;
    assert.equal(mailbox.heartbeat(claim.deliveryId, claim.deliveryToken).leaseExpiresAt, claim.leaseExpiresAt);
    milliseconds += 13 * 60_000;
    assert.ok(Date.parse(mailbox.heartbeat(claim.deliveryId, claim.deliveryToken).leaseExpiresAt) > Date.parse(claim.leaseExpiresAt));
  } finally {
    mailbox.close();
    fs.rmSync(root, { recursive: true, force: true });
  }
});

test("configuration paths stay contained and IPv6 loopback URLs are valid", () => {
  const { root, config, configPath } = fixture();
  try {
    config.broker.host = "::1";
    assert.equal(mailboxBrokerUrl(config).startsWith("http://[::1]:"), true);
    config.integrations.chromeExtensionDirectory = path.join(root, "outside-state");
    fs.writeFileSync(configPath, `${JSON.stringify(config)}\n`, "utf8");
    assert.throws(() => loadMailboxConfig(configPath), /mailbox_runtime_path_outside_state_forbidden/u);
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
});

test("unsupported sensitivity cannot imply protection the exchange does not provide", () => {
  const { root, config } = fixture();
  const mailbox = new MailboxService(config);
  try {
    assert.throws(() => mailbox.send(input({ sensitivity: "restricted" })), /mailbox_sensitivity_not_supported/u);
  } finally {
    mailbox.close();
    fs.rmSync(root, { recursive: true, force: true });
  }
});

test("retired Gemini cannot receive new mailbox work", () => {
  const { root, config } = fixture();
  const mailbox = new MailboxService(config);
  try {
    assert.throws(() => mailbox.send(input({
      provider: "gemini",
      idempotencyKey: "mailbox-retired-gemini-idempotency",
    })), /mailbox_provider_invalid/u);
    assert.throws(() => mailbox.take("gemini", "provider.gemini.test"), /mailbox_provider_invalid/u);
  } finally {
    mailbox.close();
    fs.rmSync(root, { recursive: true, force: true });
  }
});

test("Antigravity responses cannot fabricate a browser conversation URL", () => {
  const { root, config } = fixture();
  const mailbox = new MailboxService(config);
  try {
    mailbox.send(input({
      provider: "antigravity",
      idempotencyKey: "mailbox-antigravity-no-browser-url",
    }));
    const claim = mailbox.take("antigravity", "provider.antigravity.test");
    assert.ok(claim);
    mailbox.markDispatching(claim.deliveryId, claim.deliveryToken);
    mailbox.markSent(claim.deliveryId, claim.deliveryToken);
    assert.throws(() => mailbox.complete({
      deliveryId: claim.deliveryId,
      deliveryToken: claim.deliveryToken,
      response: "Synthetic Antigravity response.",
      conversationUrl: "https://antigravity.google/synthetic",
    }), /mailbox_conversation_url_not_supported/u);
    assert.equal(mailbox.complete({
      deliveryId: claim.deliveryId,
      deliveryToken: claim.deliveryToken,
      response: "Synthetic Antigravity response.",
    }).status, "completed");
  } finally {
    mailbox.close();
    fs.rmSync(root, { recursive: true, force: true });
  }
});

test("pre-dispatch failures retry while post-dispatch failures become uncertain", () => {
  const { root, config } = fixture();
  const mailbox = new MailboxService(config);
  try {
    const retryMessage = mailbox.send(input({
      provider: "antigravity",
      idempotencyKey: "mailbox-test-idempotency-retry",
      approvalRef: "approval.synthetic.retry",
    }));
    const firstClaim = mailbox.take("antigravity", "provider.antigravity.test");
    assert.ok(firstClaim);
    assert.equal(mailbox.fail(firstClaim.deliveryId, firstClaim.deliveryToken, "tab_not_ready", true).status, "queued");
    const retried = mailbox.take("antigravity", "provider.antigravity.test");
    assert.ok(retried);
    assert.equal(mailbox.get(retryMessage.messageId).attempt, 2);
    mailbox.markDispatching(retried.deliveryId, retried.deliveryToken);
    assert.equal(mailbox.fail(retried.deliveryId, retried.deliveryToken, "browser_restart", true).status, "uncertain");
    assert.equal(mailbox.take("antigravity", "provider.antigravity.test"), undefined);
  } finally {
    mailbox.close();
    fs.rmSync(root, { recursive: true, force: true });
  }
});

test("loopback broker requires its external bearer token", async () => {
  const { root, config } = fixture();
  config.broker.port = await freePort();
  const broker = new MailboxBroker(config);
  const { url } = await broker.start();
  try {
    assert.equal((await fetch(`${url}/health`)).status, 401);
    const token = readBrokerToken(config);
    const response = await fetch(`${url}/v1/messages`, {
      method: "POST",
      headers: { Authorization: `Bearer ${token}`, "Content-Type": "application/json" },
      body: JSON.stringify(input({ idempotencyKey: "mailbox-broker-idempotency" })),
    });
    assert.equal(response.status, 201);
    assert.equal((await response.json()).status, "queued");
    const health = await fetch(`${url}/health`, { headers: { Authorization: `Bearer ${token}` } });
    assert.equal(health.status, 200);
    assert.equal((await health.json()).database.journalMode, "wal");
  } finally {
    await broker.stop();
    fs.rmSync(root, { recursive: true, force: true });
  }
});

async function freePort() {
  const server = net.createServer();
  await new Promise((resolve, reject) => server.listen(0, "127.0.0.1", resolve).once("error", reject));
  const address = server.address();
  const port = typeof address === "object" && address ? address.port : 0;
  await new Promise((resolve, reject) => server.close((error) => error ? reject(error) : resolve()));
  return port;
}
