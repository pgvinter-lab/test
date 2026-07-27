import fs from "node:fs";
import path from "node:path";
import { execFileSync, spawn } from "node:child_process";
import { fileURLToPath, pathToFileURL } from "node:url";
import { canonicalize } from "../core/canonical.js";
import { invariant } from "../core/errors.js";
import { assertContainedPathWithoutReparse, mailboxBrokerUrl, readBrokerToken, writeJsonAtomic } from "./config.js";
import type { MailboxConfig } from "./types.js";
import { CHATGPT_BROWSER_PROFILE } from "./web-node-profile.js";

export interface InstalledMailboxIntegrations {
  chromeExtensionDirectory: string;
  antigravityPluginDirectory: string;
  chromeLoadInstructions: string;
  webBrowserStartCommand: string;
  antigravityInstallCommand: string;
}

const AUTOSTART_TASK = "Bridge Mailbox Broker";

export function installMailboxIntegrations(
  config: MailboxConfig,
  configPath = path.join(config.stateDirectory, "config.json"),
): InstalledMailboxIntegrations {
  const packageRoot = fileURLToPath(new URL("../../../", import.meta.url));
  const chromeSource = path.join(packageRoot, "integrations", "chrome-mailbox");
  const chromeTarget = config.integrations.chromeExtensionDirectory;
  const antigravityTarget = config.integrations.antigravityPluginDirectory;
  const antigravityRules = path.join(antigravityTarget, "rules");
  const antigravitySkills = path.join(antigravityTarget, "skills");
  const bridgePeerSkill = path.join(antigravitySkills, "bridge-peer-protocol");
  const serverPath = path.join(antigravityTarget, "server.mjs");
  const pluginPath = path.join(antigravityTarget, "plugin.json");
  const mcpConfigPath = path.join(antigravityTarget, "mcp_config.json");
  const rulePath = path.join(antigravityRules, "bridge-mailbox.md");
  const peerRulePath = path.join(antigravityRules, "bridge-peer-protocol.md");
  const peerSkillPath = path.join(bridgePeerSkill, "SKILL.md");
  assertInstallTarget(chromeTarget, config.stateDirectory);
  const antigravityPaths = [
    antigravityTarget,
    antigravityRules,
    antigravitySkills,
    bridgePeerSkill,
    serverPath,
    pluginPath,
    mcpConfigPath,
    rulePath,
    peerRulePath,
    peerSkillPath,
  ];
  for (const candidate of antigravityPaths) {
    assertInstallTarget(candidate, config.stateDirectory);
  }
  replaceDirectory(chromeSource, chromeTarget, config.stateDirectory);
  const browserTargets = [
    ...(config.providers.chatgpt.enabled ? [{ provider: "chatgpt" as const, profile: CHATGPT_BROWSER_PROFILE }] : []),
    ...(config.providers.web.enabled
      ? Object.values(config.webNodes)
        .filter((profile) => profile.enabled)
        .map((profile) => ({ provider: "web" as const, profile }))
      : []),
  ];
  const webMatches = [...new Set(browserTargets.map(({ profile }) => `${profile.origin}/*`))].sort();
  writeJsonAtomic(path.join(chromeTarget, "manifest.json"), {
    manifest_version: 3,
    name: "Bridge WEB Nodes",
    version: "0.3.0",
    description: "Dispatches approved Bridge messages through exact-origin browser WEB node profiles.",
    permissions: ["alarms", "storage"],
    host_permissions: [
      "http://127.0.0.1/*",
      "http://localhost/*",
      "http://[::1]/*",
      ...webMatches,
    ],
    background: { service_worker: "background.js" },
    action: {
      default_title: "Bridge WEB Nodes",
      default_popup: "popup.html",
    },
    content_scripts: [{
      matches: webMatches,
      js: ["content.js"],
      run_at: "document_idle",
    }],
  }, true);
  writeJsonAtomic(path.join(chromeTarget, "config.json"), {
    brokerUrl: mailboxBrokerUrl(config),
    brokerToken: readBrokerToken(config),
    pollSeconds: Math.max(30, Math.ceil(config.delivery.pollIntervalMs / 1000)),
    autoOpen: true,
    targets: browserTargets.map(({ provider, profile }) => ({ provider, ...profile })),
  }, true);

  fs.mkdirSync(antigravityRules, { recursive: true, mode: 0o700 });
  fs.mkdirSync(bridgePeerSkill, { recursive: true, mode: 0o700 });
  for (const candidate of antigravityPaths) {
    assertInstallTarget(candidate, config.stateDirectory);
  }
  const providerModule = pathToFileURL(fileURLToPath(new URL("./provider-mcp.js", import.meta.url))).href;
  const configModule = pathToFileURL(fileURLToPath(new URL("./config.js", import.meta.url))).href;
  const serializedConfigPath = JSON.stringify(path.resolve(configPath));
  fs.writeFileSync(serverPath,
    `import { runMailboxProviderStdio } from ${JSON.stringify(providerModule)};\n` +
    `import { loadMailboxConfig } from ${JSON.stringify(configModule)};\n` +
    `await runMailboxProviderStdio(loadMailboxConfig(${serializedConfigPath}), "antigravity");\n`,
    { encoding: "utf8", mode: 0o600 },
  );
  fs.writeFileSync(pluginPath, `${canonicalize({
    $schema: "https://antigravity.google/schemas/v1/plugin.json",
    name: "bridge-mailbox",
    description: "Connect Antigravity to the local Bridge mailbox and enforce truthful A2A and task-board receipts.",
  })}\n`, { encoding: "utf8", mode: 0o600 });
  fs.writeFileSync(mcpConfigPath, `${canonicalize({
    mcpServers: {
      "bridge-mailbox": {
        command: process.execPath,
        args: [serverPath],
        cwd: antigravityTarget,
      },
    },
  })}\n`, { encoding: "utf8", mode: 0o600 });
  fs.writeFileSync(rulePath,
    "# Bridge mailbox\n\n" +
    "Only call `bridge_mailbox_take` when the owner asks you to check the Bridge mailbox. " +
    "A successful take has already crossed the irreversible dispatch boundary. Preserve the prompt exactly, " +
    "use `bridge_mailbox_heartbeat` if work is long, then return the complete answer with `bridge_mailbox_complete`. " +
    "Never change the provider or destination and never reuse a delivery token.\n",
    { encoding: "utf8", mode: 0o600 },
  );
  fs.writeFileSync(peerRulePath,
    `# Bridge peer protocol\n\n${bridgePeerProtocolGuidance()}\n`,
    { encoding: "utf8", mode: 0o600 },
  );
  fs.writeFileSync(peerSkillPath,
    "---\n" +
    "name: bridge-peer-protocol\n" +
    "description: Use whenever Antigravity records, hands off, dispatches, verifies, or reports work through Bridge task-board or A2A tools.\n" +
    "---\n\n" +
    "# Bridge peer protocol\n\n" +
    `${bridgePeerProtocolGuidance()}\n`,
    { encoding: "utf8", mode: 0o600 },
  );

  const enabledWebNodes = config.providers.web.enabled ? Object.keys(config.webNodes).filter(k => config.webNodes[k].enabled) : [];
  const nodeArgs = enabledWebNodes.length > 0 ? enabledWebNodes.map(id => `--node ${id}`).join(" ") : "";

  return {
    chromeExtensionDirectory: chromeTarget,
    antigravityPluginDirectory: antigravityTarget,
    chromeLoadInstructions: `Open chrome://extensions in the dedicated Bridge browser, enable Developer mode, and load unpacked: ${chromeTarget}`,
    webBrowserStartCommand: `bridge-mailbox web-browser-start ${nodeArgs} --config "${path.resolve(configPath)}"`.replace("  ", " "),
    antigravityInstallCommand: `agy plugin install "${antigravityTarget}"`,
  };
}

function bridgePeerProtocolGuidance(): string {
  return [
    "Bridge coordination acknowledgements and execution receipts are different things.",
    "",
    "- `bridge_task_add` writes a board row only. It does not launch a worker or dispatch work.",
    "- `bridge_handoff` changes the shared control token only. It does not deliver a message or execute work.",
    "- Use `bridge_task_dispatch` to execute an existing board row. Use `bridge_a2a_send` for direct peer work.",
    "- Never report that work ran or completed unless the receipt has `channel: a2a`, `terminal: true`, `state: completed`, and at least one durable `artifactId`.",
    "- If an A2A result is uncertain, call `bridge_a2a_get` with its task id. A queued, submitted, working, failed, or missing task is not completed work.",
    "- A failed dispatch must leave its board row open. Report the terminal failure and task id; do not mark the row done manually.",
    "- Reuse an idempotency key only for the identical operation, task, target, and prompt. Create a new key for changed work.",
    "- Preserve the exact project and target named by the owner. The supported peer names are `antigravity`, `claude`, and `codex`.",
  ].join("\n");
}

export function installMailboxAutostart(configPath: string): { mode: "scheduled-task" | "startup-folder"; command: string; launcherPath?: string } {
  if (process.platform !== "win32") throw new Error("mailbox_autostart_windows_only");
  const cliPath = fileURLToPath(new URL("./cli.js", import.meta.url));
  const resolvedConfig = path.resolve(configPath);
  const command = `"${process.execPath}" "${cliPath}" broker --config "${resolvedConfig}"`;
  try {
    execFileSync("schtasks.exe", [
      "/Create", "/TN", AUTOSTART_TASK, "/SC", "ONLOGON", "/RL", "LIMITED", "/TR", command, "/F",
    ], { encoding: "utf8", windowsHide: true, stdio: "pipe" });
    return { mode: "scheduled-task", command };
  } catch {
    const launcherPath = startupLauncherPath();
    fs.mkdirSync(path.dirname(launcherPath), { recursive: true });
    fs.writeFileSync(launcherPath, `CreateObject("WScript.Shell").Run ${vbString(command)}, 0, False\r\n`, {
      encoding: "utf8",
      mode: 0o600,
    });
    return { mode: "startup-folder", command, launcherPath };
  }
}

export function startMailboxAutostart(configPath: string): { mode: "scheduled-task" | "detached"; started: true; pid?: number } {
  if (process.platform !== "win32") throw new Error("mailbox_autostart_windows_only");
  try {
    execFileSync("schtasks.exe", ["/Run", "/TN", AUTOSTART_TASK], { encoding: "utf8", windowsHide: true, stdio: "pipe" });
    return { mode: "scheduled-task", started: true };
  } catch {
    const cliPath = fileURLToPath(new URL("./cli.js", import.meta.url));
    const child = spawn(process.execPath, [cliPath, "broker", "--config", path.resolve(configPath)], {
      detached: true,
      windowsHide: true,
      stdio: "ignore",
    });
    child.unref();
    return { mode: "detached", started: true, pid: child.pid };
  }
}

export function removeMailboxAutostart(): { removed: true } {
  if (process.platform !== "win32") throw new Error("mailbox_autostart_windows_only");
  try { execFileSync("schtasks.exe", ["/End", "/TN", AUTOSTART_TASK], { encoding: "utf8", windowsHide: true, stdio: "ignore" }); }
  catch {}
  try { execFileSync("schtasks.exe", ["/Delete", "/TN", AUTOSTART_TASK, "/F"], { encoding: "utf8", windowsHide: true, stdio: "ignore" }); }
  catch {}
  fs.rmSync(startupLauncherPath(), { force: true });
  return { removed: true };
}

function startupLauncherPath(): string {
  const appData = process.env.APPDATA?.trim();
  if (!appData) throw new Error("mailbox_appdata_missing");
  return path.join(appData, "Microsoft", "Windows", "Start Menu", "Programs", "Startup", "Bridge Mailbox Broker.vbs");
}

function vbString(value: string): string {
  return `"${value.replace(/"/gu, '""')}"`;
}

function replaceDirectory(source: string, destination: string, allowedRoot: string): void {
  const resolvedSource = path.resolve(source);
  const resolvedDestination = path.resolve(destination);
  assertInstallTarget(resolvedDestination, allowedRoot);
  if (!fs.lstatSync(resolvedSource).isDirectory()) throw new Error("mailbox_integration_source_missing");
  if (fs.existsSync(resolvedDestination)) {
    const state = fs.lstatSync(resolvedDestination);
    if (!state.isDirectory() || state.isSymbolicLink()) throw new Error("mailbox_integration_target_invalid");
    fs.rmSync(resolvedDestination, { recursive: true, force: true });
  }
  fs.mkdirSync(path.dirname(resolvedDestination), { recursive: true, mode: 0o700 });
  fs.cpSync(resolvedSource, resolvedDestination, { recursive: true, errorOnExist: true, force: false });
}

function assertInstallTarget(candidate: string, allowedRoot: string): void {
  const relative = path.relative(path.resolve(allowedRoot), path.resolve(candidate));
  invariant(relative !== "" && !relative.startsWith("..") && !path.isAbsolute(relative), "mailbox_integration_target_outside_state");
  assertContainedPathWithoutReparse(candidate, allowedRoot, "mailbox_integration_reparse_forbidden");
}
