import fs from "node:fs";
import path from "node:path";
import { spawn } from "node:child_process";
import { canonicalize } from "../core/canonical.js";
import { invariant } from "../core/errors.js";
import {
  assertContainedPathWithoutReparse,
  loadMailboxConfig,
  writeJsonAtomic,
} from "./config.js";
import type { MailboxConfig, WebNodeProfile } from "./types.js";
import { readWebNodeProfile } from "./web-node-profile.js";

export interface InstalledWebNodeProfile {
  profile: WebNodeProfile;
  configPath: string;
  changed: boolean;
}

export function installWebNodeProfile(
  configPath: string,
  profilePath: string,
  overwrite = false,
): InstalledWebNodeProfile {
  const resolvedConfigPath = path.resolve(configPath);
  const config = loadMailboxConfig(resolvedConfigPath);
  const profile = readWebNodeProfile(profilePath);
  const existing = config.webNodes[profile.nodeId];
  if (existing && canonicalize(existing) === canonicalize(profile)) {
    return { profile, configPath: resolvedConfigPath, changed: false };
  }
  invariant(!existing || overwrite, "web_node_profile_exists");
  const updated: MailboxConfig = {
    ...config,
    webNodes: {
      ...config.webNodes,
      [profile.nodeId]: profile,
    },
  };
  writeJsonAtomic(resolvedConfigPath, updated, true);
  loadMailboxConfig(resolvedConfigPath);
  return { profile, configPath: resolvedConfigPath, changed: true };
}

export function listWebNodeProfiles(config: MailboxConfig): Array<{
  nodeId: string;
  displayName: string;
  enabled: boolean;
  origin: string;
  startUrl: string;
}> {
  return Object.values(config.webNodes)
    .map((profile) => ({
      nodeId: profile.nodeId,
      displayName: profile.displayName,
      enabled: profile.enabled,
      origin: profile.origin,
      startUrl: profile.startUrl,
    }))
    .sort((left, right) => left.nodeId.localeCompare(right.nodeId));
}

export function launchBridgeWebBrowser(config: MailboxConfig, nodeId: string): {
  started: true;
  pid: number;
  nodeId: string;
  url: string;
  browserProfileDirectory: string;
  extensionDirectory: string;
  auth: "browser-owned";
} {
  const profile = config.webNodes[nodeId];
  invariant(profile?.enabled, "web_node_not_found_or_disabled", { nodeId });
  const browserProfileDirectory = config.integrations.webBrowserProfileDirectory;
  const extensionDirectory = config.integrations.chromeExtensionDirectory;
  assertContainedPathWithoutReparse(browserProfileDirectory, config.stateDirectory, "web_browser_profile_reparse_forbidden");
  assertContainedPathWithoutReparse(extensionDirectory, config.stateDirectory, "web_browser_extension_reparse_forbidden");
  invariant(fs.existsSync(path.join(extensionDirectory, "manifest.json")), "web_browser_extension_not_installed");
  fs.mkdirSync(browserProfileDirectory, { recursive: true, mode: 0o700 });
  const profileStat = fs.lstatSync(browserProfileDirectory);
  invariant(profileStat.isDirectory() && !profileStat.isSymbolicLink(), "web_browser_profile_invalid");

  const executable = chromeExecutable();
  const child = spawn(executable, [
    `--user-data-dir=${browserProfileDirectory}`,
    `--load-extension=${extensionDirectory}`,
    "--no-first-run",
    "--disable-background-mode",
    profile.startUrl,
  ], {
    detached: true,
    windowsHide: false,
    stdio: "ignore",
  });
  invariant(typeof child.pid === "number", "web_browser_start_failed");
  child.unref();
  return {
    started: true,
    pid: child.pid,
    nodeId,
    url: profile.startUrl,
    browserProfileDirectory,
    extensionDirectory,
    auth: "browser-owned",
  };
}

function chromeExecutable(): string {
  const configured = process.env.BRIDGE_CHROME_PATH?.trim();
  const candidates = [
    configured,
    process.env.PROGRAMFILES ? path.join(process.env.PROGRAMFILES, "Google", "Chrome", "Application", "chrome.exe") : undefined,
    process.env["PROGRAMFILES(X86)"] ? path.join(process.env["PROGRAMFILES(X86)"], "Google", "Chrome", "Application", "chrome.exe") : undefined,
    process.env.LOCALAPPDATA ? path.join(process.env.LOCALAPPDATA, "Google", "Chrome", "Application", "chrome.exe") : undefined,
  ].filter((candidate): candidate is string => Boolean(candidate));
  for (const candidate of candidates) {
    const stat = fs.lstatSync(candidate, { throwIfNoEntry: false });
    if (stat?.isFile() && !stat.isSymbolicLink()) return candidate;
  }
  throw new Error("web_browser_chrome_not_found");
}
