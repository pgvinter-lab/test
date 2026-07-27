#!/usr/bin/env node
import crypto from "node:crypto";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { MailboxBroker } from "./broker.js";
import { defaultMailboxConfigPath, initializeMailboxConfig, loadMailboxConfig } from "./config.js";
import { installMailboxAutostart, installMailboxIntegrations, removeMailboxAutostart, startMailboxAutostart } from "./install.js";
import { migrateMailboxToCurrent } from "./migrate-web.js";
import { runMailboxProviderStdio } from "./provider-mcp.js";
import { MailboxService } from "./service.js";
import { readWebNodeProfile } from "./web-node-profile.js";
import { installWebNodeProfile, launchBridgeWebBrowser, listWebNodeProfiles } from "./web-node-runtime.js";
import type { MailboxMessageStatus, MailboxProvider } from "./types.js";

interface ParsedArguments {
  command?: string;
  options: Map<string, string | true>;
}

async function main(): Promise<void> {
  const args = parse(process.argv.slice(2));
  if (args.command === "init") {
    const config = initializeMailboxConfig({
      exchangeRoot: required(args, "exchange"),
      stateDirectory: optional(args, "state"),
      configPath: optional(args, "config"),
      port: optionalNumber(args, "port"),
      overwrite: flag(args, "overwrite"),
    });
    output({ ok: true, configPath: path.resolve(optional(args, "config") ?? path.join(config.stateDirectory, "config.json")), config });
    return;
  }
  if (args.command === "migrate") {
    const configPath = path.resolve(optional(args, "config") ?? defaultMailboxConfigPath());
    output({ ok: true, ...await migrateMailboxToCurrent(configPath) });
    return;
  }
  if (args.command === "web-node-validate") {
    output({ ok: true, profile: readWebNodeProfile(required(args, "profile")) });
    return;
  }

  const configPath = path.resolve(optional(args, "config") ?? defaultMailboxConfigPath());
  const config = loadMailboxConfig(configPath);
  if (args.command === "install-integrations") {
    output({ ok: true, ...installMailboxIntegrations(config, configPath) });
    return;
  }
  if (args.command === "web-node-add") {
    const installed = installWebNodeProfile(
      configPath,
      required(args, "profile"),
      flag(args, "overwrite"),
    );
    const updated = loadMailboxConfig(configPath);
    output({
      ok: true,
      ...installed,
      integrations: installMailboxIntegrations(updated, configPath),
      extensionReloadRequired: installed.changed,
    });
    return;
  }
  if (args.command === "web-node-list") {
    output({ ok: true, webNodes: listWebNodeProfiles(config) });
    return;
  }
  if (args.command === "web-browser-start") {
    output({ ok: true, ...launchBridgeWebBrowser(config, required(args, "node")) });
    return;
  }
  if (args.command === "autostart-install") {
    output({ ok: true, ...installMailboxAutostart(configPath) });
    return;
  }
  if (args.command === "autostart-start") {
    output({ ok: true, ...startMailboxAutostart(configPath) });
    return;
  }
  if (args.command === "autostart-remove") {
    output({ ok: true, ...removeMailboxAutostart() });
    return;
  }
  if (args.command === "broker") {
    const broker = new MailboxBroker(config);
    const started = await broker.start();
    process.stderr.write(`[bridge-mailbox] ready at ${started.url}\n`);
    await waitForSignal();
    await broker.stop();
    return;
  }
  if (args.command === "provider-mcp") {
    const selected = provider(args);
    if (selected === "web") throw new Error("web_provider_uses_browser_worker");
    await runMailboxProviderStdio(config, selected);
    return;
  }

  const mailbox = new MailboxService(config);
  try {
    if (args.command === "send" || args.command === "web-send") {
      const promptOption = optional(args, "prompt");
      const promptFile = optional(args, "prompt-file");
      if (Boolean(promptOption) === Boolean(promptFile)) throw new Error("exactly_one_prompt_source_required");
      const agent = normalizeId(process.env.BRIDGE_AGENT || "owner");
      const selectedProvider = args.command === "web-send" ? "web" : provider(args);
      output(mailbox.send({
        projectId: required(args, "project"),
        provider: selectedProvider,
        ...(selectedProvider === "web" ? { webNodeId: required(args, "node") } : {}),
        prompt: promptFile ? fs.readFileSync(path.resolve(promptFile), "utf8") : promptOption!,
        idempotencyKey: optional(args, "idempotency") ?? `mailbox.cli.${crypto.randomUUID()}`,
        approvalRef: optional(args, "approval") ?? `approval.direct-cli.${crypto.randomUUID()}`,
        sender: {
          principalId: optional(args, "principal") ?? `principal.${agent}`,
          sessionId: optional(args, "session") ?? `session.${agent}.${process.pid}`,
          hostId: optional(args, "host") ?? `host.${normalizeId(os.hostname())}`,
        },
        priority: flag(args, "high") ? "high" : "normal",
        sensitivity: (optional(args, "sensitivity") as "public" | "internal" | undefined) ?? "internal",
        expiresAt: optional(args, "expires"),
      }));
      return;
    }
    if (args.command === "web-result") {
      output(mailbox.webNodeResult(required(args, "message")));
      return;
    }
    if (args.command === "status") {
      const record = mailbox.get(required(args, "message"));
      if (!record) throw new Error("mailbox_message_not_found");
      output(record);
      return;
    }
    if (args.command === "list") {
      output(mailbox.list({
        ...(optional(args, "provider") ? { provider: provider(args) } : {}),
        ...(optional(args, "status") ? { status: optional(args, "status") as MailboxMessageStatus } : {}),
        limit: optionalNumber(args, "limit"),
      }));
      return;
    }
    if (args.command === "doctor") {
      output(mailbox.doctor());
      return;
    }
  } finally {
    mailbox.close();
  }
  throw new Error("usage: bridge-mailbox <init|migrate|install-integrations|web-node-validate|web-node-add|web-node-list|web-browser-start|web-send|web-result|autostart-install|autostart-start|autostart-remove|broker|provider-mcp|send|status|list|doctor> [options]");
}

function parse(argv: string[]): ParsedArguments {
  const [command, ...rest] = argv;
  const options = new Map<string, string | true>();
  for (let index = 0; index < rest.length; index += 1) {
    const token = rest[index];
    if (!token.startsWith("--")) throw new Error(`unexpected_argument:${token}`);
    const name = token.slice(2);
    const next = rest[index + 1];
    if (next && !next.startsWith("--")) {
      options.set(name, next);
      index += 1;
    } else options.set(name, true);
  }
  return { command, options };
}

function required(args: ParsedArguments, name: string): string {
  const value = optional(args, name);
  if (!value) throw new Error(`missing_option:${name}`);
  return value;
}

function optional(args: ParsedArguments, name: string): string | undefined {
  const value = args.options.get(name);
  return typeof value === "string" ? value : undefined;
}

function optionalNumber(args: ParsedArguments, name: string): number | undefined {
  const value = optional(args, name);
  if (value === undefined) return undefined;
  const parsed = Number(value);
  if (!Number.isSafeInteger(parsed)) throw new Error(`invalid_number:${name}`);
  return parsed;
}

function flag(args: ParsedArguments, name: string): boolean {
  return args.options.get(name) === true;
}

function provider(args: ParsedArguments): MailboxProvider {
  const value = required(args, "provider");
  if (value !== "chatgpt" && value !== "antigravity" && value !== "web") throw new Error("mailbox_provider_invalid");
  return value;
}

function normalizeId(value: string): string {
  const normalized = value.toLowerCase().replace(/[^a-z0-9._:-]+/gu, "-").replace(/^-|-$/gu, "");
  return normalized.length >= 3 ? normalized.slice(0, 120) : `id-${normalized || "unknown"}`;
}

function waitForSignal(): Promise<void> {
  return new Promise((resolve) => {
    process.once("SIGINT", resolve);
    process.once("SIGTERM", resolve);
  });
}

function output(value: unknown): void {
  process.stdout.write(`${JSON.stringify(value, null, 2)}\n`);
}

main().catch((error) => {
  process.stderr.write(`${JSON.stringify({ ok: false, error: error instanceof Error ? error.message : String(error) })}\n`);
  process.exitCode = 1;
});
