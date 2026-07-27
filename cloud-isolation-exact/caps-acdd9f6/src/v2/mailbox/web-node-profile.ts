import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { invariant } from "../core/errors.js";
import {
  WEB_NODE_PROFILE_VERSION,
  type WebNodeProfile,
} from "./types.js";

const MAX_SELECTOR_COUNT = 12;
const MAX_SELECTOR_LENGTH = 240;

export const CHATGPT_BROWSER_PROFILE: WebNodeProfile = {
  schemaVersion: WEB_NODE_PROFILE_VERSION,
  nodeId: "chatgpt",
  displayName: "ChatGPT",
  enabled: true,
  origin: "https://chatgpt.com",
  startUrl: "https://chatgpt.com/",
  auth: {
    mode: "browser-profile",
    signInHint: "Sign in once in the dedicated Bridge browser profile.",
  },
  selectors: {
    composer: ["#prompt-textarea", "[data-testid='prompt-textarea']", "textarea"],
    submit: ["[data-testid='send-button']", "button[aria-label*='Send']"],
    response: ["[data-message-author-role='assistant']"],
    busy: ["[data-testid='stop-button']", "button[aria-label*='Stop']"],
  },
  behavior: {
    submitMode: "button-or-enter",
    responseMode: "last-new-node",
    timeoutMs: 12 * 60_000,
    settleMs: 1_000,
    stablePolls: 5,
    maxBytes: 1024 * 1024,
  },
};

export function validateWebNodeProfile(value: unknown): WebNodeProfile {
  invariant(value !== null && typeof value === "object" && !Array.isArray(value), "web_node_profile_invalid");
  const profile = value as WebNodeProfile;
  invariant(profile.schemaVersion === WEB_NODE_PROFILE_VERSION, "web_node_profile_version_unsupported");
  invariant(isWebNodeId(profile.nodeId), "web_node_id_invalid");
  invariant(typeof profile.displayName === "string" && profile.displayName.trim().length >= 2 && profile.displayName.length <= 80, "web_node_display_name_invalid");
  invariant(typeof profile.enabled === "boolean", "web_node_enabled_invalid");

  const origin = parseHttpsUrl(profile.origin, "web_node_origin_invalid");
  invariant(origin.pathname === "/" && origin.search === "" && origin.hash === "", "web_node_origin_invalid");
  const start = parseHttpsUrl(profile.startUrl, "web_node_start_url_invalid");
  invariant(start.origin === origin.origin, "web_node_start_origin_mismatch");

  invariant(profile.auth?.mode === "browser-profile", "web_node_auth_mode_invalid");
  invariant(
    profile.auth.signInHint === undefined ||
    (typeof profile.auth.signInHint === "string" && profile.auth.signInHint.length <= 240),
    "web_node_sign_in_hint_invalid",
  );

  for (const field of ["composer", "submit", "response", "busy"] as const) {
    const selectors = profile.selectors?.[field];
    invariant(Array.isArray(selectors) && selectors.length <= MAX_SELECTOR_COUNT, "web_node_selectors_invalid", { field });
    if (field === "composer" || field === "response") {
      invariant(selectors.length > 0, "web_node_selectors_required", { field });
    }
    for (const selector of selectors) validateSelector(selector, field);
  }

  invariant(
    profile.behavior?.submitMode === "button-or-enter" ||
    profile.behavior?.submitMode === "button-only" ||
    profile.behavior?.submitMode === "enter-only",
    "web_node_submit_mode_invalid",
  );
  invariant(profile.behavior.responseMode === "last-new-node", "web_node_response_mode_invalid");
  integerBetween(profile.behavior.timeoutMs, 30_000, 30 * 60_000, "web_node_timeout_invalid");
  integerBetween(profile.behavior.settleMs, 250, 10_000, "web_node_settle_invalid");
  integerBetween(profile.behavior.stablePolls, 2, 30, "web_node_stable_polls_invalid");
  integerBetween(profile.behavior.maxBytes, 1_024, 1024 * 1024, "web_node_max_bytes_invalid");

  return structuredClone(profile);
}

export function readWebNodeProfile(profilePath: string): WebNodeProfile {
  const resolved = path.resolve(profilePath);
  const stat = fs.lstatSync(resolved);
  invariant(stat.isFile() && !stat.isSymbolicLink(), "web_node_profile_file_invalid");
  return validateWebNodeProfile(JSON.parse(fs.readFileSync(resolved, "utf8")));
}

export function bundledWebNodeProfilePath(nodeId: string): string {
  invariant(isWebNodeId(nodeId), "web_node_id_invalid");
  return fileURLToPath(new URL(`../../../integrations/web-nodes/profiles/${nodeId}.json`, import.meta.url));
}

export function loadBundledWebNodeProfile(nodeId: string): WebNodeProfile {
  return readWebNodeProfile(bundledWebNodeProfilePath(nodeId));
}

export function defaultWebNodeProfiles(): Record<string, WebNodeProfile> {
  const perplexity = loadBundledWebNodeProfile("perplexity");
  return { [perplexity.nodeId]: perplexity };
}

export function isWebNodeId(value: string): boolean {
  return typeof value === "string" && /^[a-z0-9][a-z0-9-]{1,47}$/u.test(value);
}

function parseHttpsUrl(value: string, code: string): URL {
  let parsed: URL;
  try {
    parsed = new URL(value);
  } catch {
    throw new Error(code);
  }
  invariant(parsed.protocol === "https:" && parsed.username === "" && parsed.password === "", code);
  return parsed;
}

function validateSelector(value: string, field: string): void {
  invariant(
    typeof value === "string" &&
    value.length > 0 &&
    value.length <= MAX_SELECTOR_LENGTH &&
    !/[\u0000\r\n]/u.test(value) &&
    value !== "*",
    "web_node_selector_invalid",
    { field },
  );
}

function integerBetween(value: number, minimum: number, maximum: number, code: string): void {
  invariant(Number.isSafeInteger(value) && value >= minimum && value <= maximum, code);
}
