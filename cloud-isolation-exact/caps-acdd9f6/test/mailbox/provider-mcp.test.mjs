import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StdioClientTransport } from "@modelcontextprotocol/sdk/client/stdio.js";
import { initializeMailboxConfig, loadMailboxConfig } from "../../dist/v2/mailbox/config.js";
import { installMailboxIntegrations } from "../../dist/v2/mailbox/install.js";
import { MailboxService } from "../../dist/v2/mailbox/service.js";

test("Antigravity MCP take crosses the no-retry boundary before exposing a prompt", async () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "bridge-mailbox-mcp-"));
  const stateDirectory = path.join(root, "state");
  const configPath = path.join(stateDirectory, "config.json");
  const config = initializeMailboxConfig({ stateDirectory, exchangeRoot: path.join(root, "exchange") });
  const mailbox = new MailboxService(config);
  mailbox.send({
    projectId: "project.synthetic",
    sender: { principalId: "principal.codex", sessionId: "session.synthetic", hostId: "host.synthetic" },
    provider: "antigravity",
    prompt: "Synthetic Antigravity MCP prompt.",
    idempotencyKey: "mailbox-antigravity-mcp-idempotency",
    approvalRef: "approval.synthetic.antigravity-mcp",
  });
  const transport = new StdioClientTransport({
    command: process.execPath,
    args: [path.resolve("dist/v2/mailbox/cli.js"), "provider-mcp", "--provider", "antigravity", "--config", configPath],
  });
  const client = new Client({ name: "mailbox-provider-test", version: "0.0.0" });
  try {
    await client.connect(transport);
    const names = (await client.listTools()).tools.map((tool) => tool.name);
    assert.deepEqual(names.sort(), ["bridge_mailbox_complete", "bridge_mailbox_fail", "bridge_mailbox_heartbeat", "bridge_mailbox_take"].sort());
    const taken = await client.callTool({ name: "bridge_mailbox_take", arguments: {} });
    const claim = JSON.parse(taken.content[0].text);
    assert.equal(claim.message.prompt, "Synthetic Antigravity MCP prompt.");
    assert.equal(mailbox.get(claim.message.messageId).status, "sent");
    const completed = await client.callTool({
      name: "bridge_mailbox_complete",
      arguments: { deliveryId: claim.deliveryId, deliveryToken: claim.deliveryToken, response: "Synthetic Antigravity MCP response." },
    });
    assert.equal(JSON.parse(completed.content[0].text).status, "completed");
  } finally {
    await client.close().catch(() => undefined);
    mailbox.close();
    fs.rmSync(root, { recursive: true, force: true });
  }
});

test("Chrome integration keeps delivery secrets out of page context", () => {
  const root = path.resolve("integrations/chrome-mailbox");
  const background = fs.readFileSync(path.join(root, "background.js"), "utf8");
  const content = fs.readFileSync(path.join(root, "content.js"), "utf8");
  const manifest = JSON.parse(fs.readFileSync(path.join(root, "manifest.json"), "utf8"));
  const exampleConfig = JSON.parse(fs.readFileSync(path.join(root, "config.example.json"), "utf8"));
  assert.doesNotMatch(content, /deliveryToken/u);
  assert.doesNotMatch(background, /bridge-mailbox-prepare",\s*claim/u);
  assert.doesNotMatch(background, /tabs\[0\]/u);
  assert.doesNotMatch(background, /gemini|antigravity/iu);
  assert.doesNotMatch(content, /gemini|antigravity/iu);
  assert.equal(manifest.host_permissions.some((origin) => /gemini|antigravity/iu.test(origin)), false);
  assert.equal(manifest.content_scripts.flatMap((script) => script.matches).some((origin) => /gemini|antigravity/iu.test(origin)), false);
  assert.deepEqual(exampleConfig.targets.map((target) => target.provider), ["web"]);
  assert.equal(exampleConfig.targets[0].nodeId, "example");
  assert.doesNotMatch(JSON.stringify(manifest), /<all_urls>/u);
  assert.equal(manifest.permissions.includes("tabs"), false);
});

test("integration installer packages exact-origin WEB targets and a local Antigravity MCP plugin", () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "bridge-mailbox-integrations-"));
  try {
    const configPath = path.join(root, "custom-config", "mailbox.json");
    const config = initializeMailboxConfig({
      stateDirectory: path.join(root, "state"),
      exchangeRoot: path.join(root, "exchange"),
      configPath,
    });
    const installed = JSON.parse(execFileSync(process.execPath, [
      path.resolve("dist/v2/mailbox/cli.js"),
      "install-integrations",
      "--config",
      configPath,
    ], { encoding: "utf8", windowsHide: true }));
    assert.equal(installed.ok, true);
    assert.equal(installed.antigravityPluginDirectory, config.integrations.antigravityPluginDirectory);
    assert.match(installed.antigravityInstallCommand, /^agy plugin install /u);

    const chromeConfig = JSON.parse(fs.readFileSync(path.join(installed.chromeExtensionDirectory, "config.json"), "utf8"));
    assert.deepEqual(
      chromeConfig.targets.map((target) => `${target.provider}:${target.nodeId}`).sort(),
      ["chatgpt:chatgpt", "web:perplexity"],
    );
    const perplexity = chromeConfig.targets.find((target) => target.nodeId === "perplexity");
    assert.equal(perplexity.origin, "https://www.perplexity.ai");
    assert.equal(perplexity.auth.mode, "browser-profile");
    const chromeManifest = JSON.parse(fs.readFileSync(path.join(installed.chromeExtensionDirectory, "manifest.json"), "utf8"));
    assert.equal(chromeManifest.host_permissions.includes("https://www.perplexity.ai/*"), true);
    assert.equal(chromeManifest.host_permissions.includes("<all_urls>"), false);
    assert.equal(
      chromeManifest.content_scripts.flatMap((script) => script.matches).includes("https://www.perplexity.ai/*"),
      true,
    );
    assert.equal(fs.existsSync(config.integrations.webBrowserProfileDirectory), false);

    const plugin = JSON.parse(fs.readFileSync(path.join(installed.antigravityPluginDirectory, "plugin.json"), "utf8"));
    assert.equal(plugin.$schema, "https://antigravity.google/schemas/v1/plugin.json");
    assert.equal(plugin.name, "bridge-mailbox");
    const mcp = JSON.parse(fs.readFileSync(path.join(installed.antigravityPluginDirectory, "mcp_config.json"), "utf8"));
    assert.equal(mcp.mcpServers["bridge-mailbox"].command, process.execPath);
    assert.deepEqual(mcp.mcpServers["bridge-mailbox"].args, [path.join(installed.antigravityPluginDirectory, "server.mjs")]);
    const server = fs.readFileSync(path.join(installed.antigravityPluginDirectory, "server.mjs"), "utf8");
    assert.match(server, /"antigravity"/u);
    assert.doesNotMatch(server, /"gemini"/u);
    assert.match(server, new RegExp(escapeRegExp(JSON.stringify(path.resolve(configPath))), "u"));
    assert.doesNotMatch(server, new RegExp(escapeRegExp(JSON.stringify(path.join(config.stateDirectory, "config.json"))), "u"));
    assert.ok(fs.statSync(path.join(installed.antigravityPluginDirectory, "rules", "bridge-mailbox.md")).isFile());
    const peerRule = fs.readFileSync(path.join(installed.antigravityPluginDirectory, "rules", "bridge-peer-protocol.md"), "utf8");
    const peerSkill = fs.readFileSync(path.join(installed.antigravityPluginDirectory, "skills", "bridge-peer-protocol", "SKILL.md"), "utf8");
    for (const guidance of [peerRule, peerSkill]) {
      assert.match(guidance, /bridge_task_add.*board row only/su);
      assert.match(guidance, /bridge_handoff.*control token only/su);
      assert.match(guidance, /bridge_task_dispatch/u);
      assert.match(guidance, /bridge_a2a_send/u);
      assert.match(guidance, /terminal: true/u);
      assert.match(guidance, /artifactId/u);
    }
    assert.match(peerSkill, /^---\nname: bridge-peer-protocol\n/su);
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
});

function escapeRegExp(value) {
  return value.replace(/[.*+?^${}()|[\]\\]/gu, "\\$&");
}

test("integration paths reject junctions and symlinks that escape mailbox state", () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "bridge-mailbox-integration-reparse-"));
  try {
    const stateDirectory = path.join(root, "state");
    const configPath = path.join(stateDirectory, "config.json");
    const config = initializeMailboxConfig({
      stateDirectory,
      exchangeRoot: path.join(root, "exchange"),
    });
    const outside = path.join(root, "outside");
    const reparse = path.join(stateDirectory, "integration-link");
    fs.mkdirSync(outside);
    fs.symlinkSync(outside, reparse, process.platform === "win32" ? "junction" : "dir");
    const escaped = {
      ...config,
      integrations: {
        ...config.integrations,
        antigravityPluginDirectory: path.join(reparse, "antigravity-plugin"),
      },
    };
    fs.writeFileSync(configPath, `${JSON.stringify(escaped, null, 2)}\n`, "utf8");
    assert.throws(() => loadMailboxConfig(configPath), /mailbox_integration_reparse_forbidden/u);
    assert.throws(() => installMailboxIntegrations(escaped), /mailbox_integration_reparse_forbidden/u);
    assert.equal(fs.existsSync(path.join(outside, "antigravity-plugin")), false);
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
});

test("integration installer rejects a symlinked output file without touching its target", () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "bridge-mailbox-integration-leaf-link-"));
  try {
    const config = initializeMailboxConfig({
      stateDirectory: path.join(root, "state"),
      exchangeRoot: path.join(root, "exchange"),
    });
    const outsideFile = path.join(root, "outside-sentinel.json");
    const pluginPath = path.join(config.integrations.antigravityPluginDirectory, "plugin.json");
    fs.mkdirSync(config.integrations.antigravityPluginDirectory, { recursive: true });
    fs.writeFileSync(outsideFile, "OUTSIDE_SENTINEL\n", "utf8");
    fs.symlinkSync(outsideFile, pluginPath, "file");
    assert.throws(() => installMailboxIntegrations(config), /mailbox_integration_reparse_forbidden/u);
    assert.equal(fs.readFileSync(outsideFile, "utf8"), "OUTSIDE_SENTINEL\n");
    assert.equal(fs.existsSync(path.join(config.integrations.antigravityPluginDirectory, "server.mjs")), false);
    fs.unlinkSync(pluginPath);
    const danglingTarget = path.join(root, "outside-created-through-link.json");
    const mcpConfigPath = path.join(config.integrations.antigravityPluginDirectory, "mcp_config.json");
    fs.symlinkSync(danglingTarget, mcpConfigPath, "file");
    assert.throws(() => installMailboxIntegrations(config), /mailbox_integration_reparse_forbidden/u);
    assert.equal(fs.existsSync(danglingTarget), false);
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
});
