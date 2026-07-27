chrome.runtime.onMessage.addListener((message, _sender, sendResponse) => {
  void handle(message).then(
    (value) => sendResponse({ ok: true, ...value }),
    (error) => sendResponse({
      ok: false,
      error: error instanceof Error ? error.message : String(error),
    }),
  );
  return true;
});

async function handle(message) {
  const target = validatedTarget(message.target);
  if (message.type === "bridge-mailbox-prepare") return prepare(message.message, target);
  if (message.type === "bridge-mailbox-submit") return submit(target);
  if (message.type === "bridge-mailbox-collect") return collect(message.prepared, target);
  throw new Error("browser_adapter_command_unknown");
}

async function prepare(message, target) {
  if (message?.recipient !== target.provider) throw new Error("browser_adapter_provider_mismatch");
  if (target.provider === "web" && message.webNodeId !== target.nodeId) {
    throw new Error("browser_adapter_node_mismatch");
  }
  if (target.provider !== "web" && message.webNodeId !== undefined) {
    throw new Error("browser_adapter_node_not_supported");
  }
  if (Date.parse(message.expiresAt) <= Date.now()) throw new Error("browser_adapter_message_expired");
  const composer = await waitForElement(target.selectors.composer, 30_000);
  const existing = normalizedText(composerText(composer));
  if (existing && existing !== normalizedText(message.prompt)) {
    throw new Error("browser_adapter_composer_not_empty");
  }
  setComposerText(composer, message.prompt);
  await sleep(300);
  if (normalizedText(composerText(composer)) !== normalizedText(message.prompt)) {
    throw new Error("browser_adapter_composer_write_failed");
  }
  return {
    responseCount: responseNodes(target).length,
    preparedAt: new Date().toISOString(),
    targetIdentity: `${target.provider}:${target.nodeId}`,
  };
}

async function submit(target) {
  const composer = await waitForElement(target.selectors.composer, 10_000);
  const mode = target.behavior.submitMode;
  let button;
  if (mode !== "enter-only" && target.selectors.submit.length > 0) {
    button = await waitForEnabledButton(target.selectors.submit, mode === "button-only" ? 10_000 : 3_000);
  }
  if (button) {
    button.click();
  } else {
    if (mode === "button-only") throw new Error("browser_adapter_submit_button_not_found");
    dispatchEnter(composer);
  }
  await sleep(500);
  return { submittedAt: new Date().toISOString() };
}

async function collect(prepared = {}, target) {
  if (prepared.targetIdentity !== `${target.provider}:${target.nodeId}`) {
    throw new Error("browser_adapter_prepared_target_mismatch");
  }
  const baseline = Number(prepared.responseCount ?? 0);
  const deadline = Date.now() + target.behavior.timeoutMs;
  let prior = "";
  let stable = 0;
  while (Date.now() < deadline) {
    if (location.origin !== target.origin) throw new Error("browser_adapter_origin_changed");
    const nodes = responseNodes(target);
    const candidate = nodes.length > baseline
      ? (nodes[nodes.length - 1]?.innerText ?? nodes[nodes.length - 1]?.textContent ?? "").trim()
      : "";
    const generating = target.selectors.busy.some((selector) => visible(document.querySelector(selector)));
    if (candidate && candidate === prior && !generating) stable += 1;
    else stable = 0;
    prior = candidate;
    if (stable >= target.behavior.stablePolls) {
      if (new TextEncoder().encode(candidate).length > target.behavior.maxBytes) {
        throw new Error("browser_adapter_response_too_large");
      }
      return { response: candidate, conversationUrl: location.href };
    }
    await sleep(target.behavior.settleMs);
  }
  throw new Error("browser_adapter_response_timeout");
}

function validatedTarget(target) {
  if (target?.provider !== "chatgpt" && target?.provider !== "web") {
    throw new Error("browser_adapter_provider_invalid");
  }
  if (location.origin !== target.origin) throw new Error("browser_adapter_origin_invalid");
  if (!/^[a-z0-9][a-z0-9-]{1,47}$/u.test(target.nodeId)) {
    throw new Error("browser_adapter_node_id_invalid");
  }
  for (const field of ["composer", "submit", "response", "busy"]) {
    const values = target.selectors?.[field];
    if (!Array.isArray(values) || values.length > 12 || values.some((value) =>
      typeof value !== "string" || value.length === 0 || value.length > 240)) {
      throw new Error("browser_adapter_selectors_invalid");
    }
  }
  if (target.selectors.composer.length === 0 || target.selectors.response.length === 0) {
    throw new Error("browser_adapter_selectors_required");
  }
  return target;
}

function responseNodes(target) {
  const seen = new Set();
  for (const selector of target.selectors.response) {
    for (const node of document.querySelectorAll(selector)) {
      if (node instanceof HTMLElement && visible(node)) seen.add(node);
    }
  }
  return [...seen].sort((left, right) => {
    if (left === right) return 0;
    return left.compareDocumentPosition(right) & Node.DOCUMENT_POSITION_FOLLOWING ? -1 : 1;
  });
}

async function waitForElement(candidates, timeout) {
  const deadline = Date.now() + timeout;
  while (Date.now() < deadline) {
    for (const selector of candidates) {
      const element = document.querySelector(selector);
      if (element instanceof HTMLElement && visible(element)) return element;
    }
    await sleep(250);
  }
  throw new Error("browser_adapter_composer_not_found");
}

async function waitForEnabledButton(candidates, timeout) {
  const deadline = Date.now() + timeout;
  while (Date.now() < deadline) {
    for (const selector of candidates) {
      const element = document.querySelector(selector);
      if (element instanceof HTMLButtonElement && !element.disabled && visible(element)) return element;
    }
    await sleep(200);
  }
  return undefined;
}

function setComposerText(element, value) {
  element.focus();
  if (element instanceof HTMLTextAreaElement || element instanceof HTMLInputElement) {
    const prototype = element instanceof HTMLTextAreaElement
      ? HTMLTextAreaElement.prototype
      : HTMLInputElement.prototype;
    const descriptor = Object.getOwnPropertyDescriptor(prototype, "value");
    if (!descriptor?.set) throw new Error("browser_adapter_native_setter_missing");
    descriptor.set.call(element, value);
  } else {
    const selection = getSelection();
    selection?.selectAllChildren(element);
    const inserted = document.execCommand("insertText", false, value);
    if (!inserted) element.textContent = value;
  }
  element.dispatchEvent(new InputEvent("input", {
    bubbles: true,
    inputType: "insertText",
    data: value,
  }));
  element.dispatchEvent(new Event("change", { bubbles: true }));
}

function dispatchEnter(element) {
  for (const type of ["keydown", "keypress", "keyup"]) {
    element.dispatchEvent(new KeyboardEvent(type, {
      key: "Enter",
      code: "Enter",
      keyCode: 13,
      which: 13,
      bubbles: true,
      cancelable: true,
    }));
  }
}

function composerText(element) {
  return "value" in element ? element.value : element.innerText ?? element.textContent ?? "";
}

function normalizedText(value) {
  return String(value).replace(/\r\n?/gu, "\n").replace(/\u00a0/gu, " ").trim();
}

function visible(element) {
  return element instanceof HTMLElement && element.offsetParent !== null;
}

function sleep(milliseconds) {
  return new Promise((resolve) => setTimeout(resolve, milliseconds));
}
