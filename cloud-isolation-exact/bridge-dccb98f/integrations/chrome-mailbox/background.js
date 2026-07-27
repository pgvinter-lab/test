let config;
let processing = false;

chrome.runtime.onInstalled.addListener(() => initialize());
chrome.runtime.onStartup.addListener(() => initialize());
chrome.alarms.onAlarm.addListener((alarm) => {
  if (alarm.name === "bridge-mailbox-poll") void tick();
});
chrome.tabs.onUpdated.addListener((_tabId, change, tab) => {
  if (change.status === "complete" && targetForUrl(tab.url)) void tick();
});

async function initialize() {
  config = await loadConfig();
  await chrome.alarms.create("bridge-mailbox-poll", {
    periodInMinutes: Math.max(0.5, config.pollSeconds / 60),
  });
  await tick();
}

async function tick() {
  if (processing) return;
  processing = true;
  try {
    config ??= await loadConfig();
    const { paused = false } = await chrome.storage.local.get("paused");
    if (paused) return;
    for (const provider of activeProviders()) await processProvider(provider);
    await chrome.storage.local.set({ lastPollAt: new Date().toISOString(), lastError: null });
  } catch (error) {
    await chrome.storage.local.set({
      lastPollAt: new Date().toISOString(),
      lastError: errorMessage(error),
    });
  } finally {
    processing = false;
  }
}

async function processProvider(provider) {
  const key = `pending:${provider}`;
  const stored = await chrome.storage.local.get(key);
  let pending = stored[key];
  if (pending?.phase === "dispatching" || pending?.phase === "submitted") {
    await failClaim(pending.claim, "browser_worker_interrupted_during_dispatch", false);
    await chrome.storage.local.remove(key);
    return;
  }
  if (pending?.phase === "sent") {
    const target = targetForMessage(pending.claim.message);
    const tab = await pendingTab(pending, target);
    if (!tab?.id) {
      await failClaim(pending.claim, "browser_dedicated_tab_missing_after_send", false);
      await chrome.storage.local.remove(key);
      return;
    }
    await collectAndComplete(tab.id, key, pending, target);
    return;
  }
  if (!pending) {
    const queued = await api(`/v1/messages?provider=${encodeURIComponent(provider)}&status=queued&limit=1`);
    if (!Array.isArray(queued) || queued.length === 0) return;
    const claim = await api("/v1/take", {
      method: "POST",
      body: { provider, consumerId: `provider.${provider}.chrome` },
    });
    if (!claim) return;
    pending = { claim, phase: "claimed" };
    await chrome.storage.local.set({ [key]: pending });
  }

  try {
    const target = targetForMessage(pending.claim.message);
    const tab = await ensureDedicatedTab(target, pending);
    pending.tabId = tab.id;
    await chrome.storage.local.set({ [key]: pending });
    const message = pending.claim.message;
    const prepared = await sendToTab(tab.id, {
      type: "bridge-mailbox-prepare",
      target,
      message: {
        messageId: message.messageId,
        recipient: message.recipient,
        webNodeId: message.webNodeId,
        prompt: message.prompt,
        expiresAt: message.expiresAt,
      },
    });
    pending = { ...pending, prepared, phase: "claimed" };
    await chrome.storage.local.set({ [key]: pending });
    await deliveryApi(pending.claim, "dispatching", {});
    pending.phase = "dispatching";
    await chrome.storage.local.set({ [key]: pending });
    await sendToTab(tab.id, { type: "bridge-mailbox-submit", target });
    pending.phase = "sent";
    await chrome.storage.local.set({ [key]: pending });
    await deliveryApi(pending.claim, "sent", {});
    await collectAndComplete(tab.id, key, pending, target);
  } catch (error) {
    const retryable = pending.phase === "claimed";
    await failClaim(pending.claim, errorMessage(error), retryable);
    await chrome.storage.local.remove(key);
    if (retryable && pending.tabId) {
      await chrome.tabs.remove(pending.tabId).catch(() => undefined);
    }
    throw error;
  }
}

async function collectAndComplete(tabId, key, pending, target) {
  const heartbeat = setInterval(() => {
    void deliveryApi(pending.claim, "heartbeat", {}).catch(() => undefined);
  }, 60_000);
  try {
    const result = await sendToTab(tabId, {
      type: "bridge-mailbox-collect",
      target,
      prepared: pending.prepared,
    });
    await deliveryApi(pending.claim, "complete", {
      response: result.response,
      conversationUrl: result.conversationUrl,
    });
    await chrome.storage.local.remove(key);
    await chrome.storage.local.set({
      lastCompletedAt: new Date().toISOString(),
      lastCompletedMessageId: pending.claim.message.messageId,
      lastCompletedNodeId: target.nodeId,
    });
  } finally {
    clearInterval(heartbeat);
  }
}

async function failClaim(claim, error, retryable) {
  try {
    await deliveryApi(claim, "fail", {
      errorCode: normalizeError(error),
      retryable,
    });
  } catch {
    // The lease may already have expired; the broker will sweep it safely.
  }
}

async function ensureDedicatedTab(target, pending) {
  const existing = await pendingTab(pending, target);
  if (existing) return waitForTabReady(existing.id, target);
  if (!config.autoOpen) throw new Error("browser_adapter_auto_open_disabled");
  const created = await chrome.tabs.create({ url: target.startUrl, active: false });
  pending.tabId = created.id;
  return waitForTabReady(created.id, target);
}

async function pendingTab(pending, target) {
  if (!pending?.tabId) return undefined;
  try {
    const tab = await chrome.tabs.get(pending.tabId);
    return isTargetUrl(tab.url, target) ? tab : undefined;
  } catch {
    return undefined;
  }
}

async function waitForTabReady(tabId, target) {
  const deadline = Date.now() + 30_000;
  while (Date.now() < deadline) {
    const tab = await chrome.tabs.get(tabId);
    if (tab.status === "complete" && isTargetUrl(tab.url, target)) return tab;
    await new Promise((resolve) => setTimeout(resolve, 250));
  }
  throw new Error("browser_adapter_tab_load_timeout");
}

function deliveryApi(claim, action, body) {
  return api(`/v1/deliveries/${encodeURIComponent(claim.deliveryId)}/${action}`, {
    method: "POST",
    body: { deliveryToken: claim.deliveryToken, ...body },
  });
}

async function api(route, options = {}) {
  const response = await fetch(`${config.brokerUrl}${route}`, {
    method: options.method ?? "GET",
    headers: {
      Authorization: `Bearer ${config.brokerToken}`,
      "Content-Type": "application/json",
    },
    ...(options.body ? { body: JSON.stringify(options.body) } : {}),
  });
  const text = await response.text();
  const value = text ? JSON.parse(text) : undefined;
  if (!response.ok) throw new Error(value?.error ?? `mailbox_http_${response.status}`);
  return value;
}

async function sendToTab(tabId, message) {
  const result = await chrome.tabs.sendMessage(tabId, message);
  if (!result?.ok) throw new Error(result?.error ?? "browser_adapter_no_response");
  return result;
}

async function loadConfig() {
  const response = await fetch(chrome.runtime.getURL("config.json"));
  if (!response.ok) throw new Error("browser_adapter_config_missing");
  const value = await response.json();
  if (!/^http:\/\/(?:127\.0\.0\.1|localhost|\[::1\]):\d+$/u.test(value.brokerUrl)) {
    throw new Error("browser_adapter_broker_not_loopback");
  }
  if (typeof value.brokerToken !== "string" || value.brokerToken.length < 40) {
    throw new Error("browser_adapter_token_invalid");
  }
  if (!Array.isArray(value.targets) || value.targets.length === 0) {
    throw new Error("browser_adapter_targets_missing");
  }
  const identities = new Set();
  for (const target of value.targets) {
    validateTarget(target);
    const identity = `${target.provider}:${target.nodeId}`;
    if (identities.has(identity)) throw new Error("browser_adapter_target_duplicate");
    identities.add(identity);
  }
  return value;
}

function validateTarget(target) {
  if (target?.provider !== "chatgpt" && target?.provider !== "web") {
    throw new Error("browser_adapter_provider_invalid");
  }
  if (!/^[a-z0-9][a-z0-9-]{1,47}$/u.test(target.nodeId)) {
    throw new Error("browser_adapter_node_id_invalid");
  }
  let origin;
  let start;
  try {
    origin = new URL(target.origin);
    start = new URL(target.startUrl);
  } catch {
    throw new Error("browser_adapter_target_url_invalid");
  }
  if (origin.protocol !== "https:" || origin.origin !== target.origin || start.origin !== origin.origin) {
    throw new Error("browser_adapter_target_origin_invalid");
  }
  for (const field of ["composer", "submit", "response", "busy"]) {
    if (!Array.isArray(target.selectors?.[field])) {
      throw new Error("browser_adapter_selectors_invalid");
    }
  }
  if (!Number.isSafeInteger(target.behavior?.timeoutMs) || !Number.isSafeInteger(target.behavior?.settleMs)) {
    throw new Error("browser_adapter_behavior_invalid");
  }
}

function activeProviders() {
  const found = new Set(config.targets.map((target) => target.provider));
  return ["chatgpt", "web"].filter((provider) => found.has(provider));
}

function targetForMessage(message) {
  const target = config.targets.find((candidate) =>
    candidate.provider === message.recipient &&
    (message.recipient !== "web" || candidate.nodeId === message.webNodeId));
  if (!target) throw new Error("browser_adapter_target_not_found");
  return target;
}

function targetForUrl(value) {
  return config?.targets?.find((target) => isTargetUrl(value, target));
}

function isTargetUrl(value, target) {
  if (typeof value !== "string") return false;
  try {
    return new URL(value).origin === target.origin;
  } catch {
    return false;
  }
}

function normalizeError(value) {
  return errorMessage(value).replace(/[^A-Za-z0-9._:-]/gu, "_").slice(0, 180);
}

function errorMessage(value) {
  return value instanceof Error ? value.message : String(value);
}
