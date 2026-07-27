#!/usr/bin/env node
import path from "node:path";
import { fileURLToPath } from "node:url";
import { getConfig } from "./config.js";
import * as core from "./core.js";
import * as catalog from "./catalog.js";
import * as openrouter from "./openrouter.js";
import { writeProtocolDoc, claudeMcpSnippet, codexTomlSnippet } from "./templates.js";

const SERVER_JS = path.join(path.dirname(fileURLToPath(import.meta.url)), "server.js");

function out(o: unknown): void {
  console.log(typeof o === "string" ? o : JSON.stringify(o, null, 2));
}
function die(msg: string): never {
  console.error(msg);
  process.exit(1);
}

const HELP = `codex-claude-bridge — coordinate Codex CLI and Claude Code on shared projects

Usage: bridge <command> [args] [--flags]

Setup
  init <name> [path] [--remote <url>]   Register a project, write CLAUDE.md/AGENTS.md protocol, print wiring snippets
  register <name> <path> [--remote url] Register a project without touching docs
  snippets                              Print the Claude .mcp.json and Codex config.toml snippets
  home                                  Print the resolved BRIDGE_HOME

Coordination (default project = current directory; override with --project <name|path>)
  sync [project]                        Control holder, leases, tasks, and files changed since you last synced
  claim <paths...> [--note s] [--ttl m] Lease files/dirs before editing (denied if the other agent holds them)
  release [paths...]                    Release your leases (all if no paths given)
  handoff [to] [--note s]               Pass the control token to the other agent
  log <summary> [--files a,b,c]         Record work to the journal + cross-project ledger

Session / roles (boss = whoever sends the first command; switchable anytime; auto-closes after 60m idle)
  set-boss <codex|claude>               Override the session boss
  reap [--idle <minutes>]               Close out sessions idle past the threshold (default 60)

Tasks
  task-add <title>                      Add a shared task
  task-update <id> <todo|doing|done>    Update a task

Backup / restore / dashboard
  backup [project]                      git bundle -> BRIDGE_HOME (+ push to remote if set)
  restore <project> [dest]              Clone a project from its bundle/remote on another machine
  list                                  All registered projects at a glance
  recent [--project p] [--limit n]      Recent cross-project activity

Router catalog (OpenRouter model reference: cost / context / modality; cached in BRIDGE_HOME, refreshed 3x/day)
  catalog status                        Show cache age, model count, and whether it is stale (>8h)
  catalog refresh                       Force a pull now (used by the 06/14/22 scheduler / npm run catalog-sync)
  catalog ensure                        Refresh only if stale, then report (the lazy 8h guard)
  catalog get <model-id>                Print one normalized model record
  catalog path                          Print the catalog cache directory

Router calls (authenticated OpenRouter; needs OPENROUTER_API_KEY — set via: setx OPENROUTER_API_KEY "sk-or-...")
  openrouter status                     Show whether a key is set + the default (free) ping model
  openrouter ping [model]               Tiny round-trip to prove key + connectivity (uses a :free model)
  openrouter chat <model> "<prompt>"    One-shot completion against any catalog model

Identity comes from $BRIDGE_AGENT (codex|claude); unset = "unknown" (fine for human CLI use).`;

interface Parsed { positional: string[]; flags: Record<string, string | boolean>; }
function parse(argv: string[]): Parsed {
  const positional: string[] = [];
  const flags: Record<string, string | boolean> = {};
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (a.startsWith("--")) {
      const eq = a.indexOf("=");
      if (eq >= 0) flags[a.slice(2, eq)] = a.slice(eq + 1);
      else if (i + 1 < argv.length && !argv[i + 1].startsWith("--")) flags[a.slice(2)] = argv[++i];
      else flags[a.slice(2)] = true;
    } else {
      positional.push(a);
    }
  }
  return { positional, flags };
}

function flagStr(v: string | boolean | undefined): string | undefined {
  return typeof v === "string" ? v : undefined;
}

async function main(): Promise<void> {
  const [cmd, ...rest] = process.argv.slice(2);
  const { positional, flags } = parse(rest);
  const project = flagStr(flags.project) ?? flagStr(flags.p);

  switch (cmd) {
    case undefined:
    case "help":
    case "--help":
    case "-h":
      out(HELP);
      break;

    case "home":
      out(getConfig().bridgeHome);
      break;

    case "snippets":
      out(`--- Claude: .mcp.json (in the project) ---\n${claudeMcpSnippet(SERVER_JS)}\n\n--- Codex: ~/.codex/config.toml ---\n${codexTomlSnippet(SERVER_JS)}`);
      break;

    case "init": {
      const name = positional[0];
      if (!name) die("usage: bridge init <name> [path] [--remote <url>]");
      const p = positional[1] ?? process.cwd();
      const reg = await core.registerProject({ name, path: p, remote: flagStr(flags.remote) });
      const cl = writeProtocolDoc(path.join(reg.path, "CLAUDE.md"));
      const ag = writeProtocolDoc(path.join(reg.path, "AGENTS.md"));
      out({ ...reg, protocolDocs: { "CLAUDE.md": cl, "AGENTS.md": ag } });
      out(`\n--- Claude: add to ${path.join(reg.path, ".mcp.json")} ---\n${claudeMcpSnippet(SERVER_JS, reg.name)}`);
      out(`\n--- Codex: add to ~/.codex/config.toml (or ${path.join(reg.path, ".codex", "config.toml")}) ---\n${codexTomlSnippet(SERVER_JS, reg.name)}`);
      break;
    }

    case "register": {
      const name = positional[0];
      const p = positional[1];
      if (!name || !p) die("usage: bridge register <name> <path> [--remote <url>]");
      out(await core.registerProject({ name, path: p, remote: flagStr(flags.remote) }));
      break;
    }

    case "sync":
      out(await core.sync(positional[0] ?? project));
      break;

    case "claim": {
      if (positional.length === 0) die("usage: bridge claim <paths...> [--note s] [--ttl <minutes>]");
      const ttl = flagStr(flags.ttl);
      out(await core.claim({ paths: positional, project, note: flagStr(flags.note), ttlMinutes: ttl ? Number(ttl) : undefined }));
      break;
    }

    case "release":
      out(await core.release({ paths: positional.length ? positional : undefined, project }));
      break;

    case "handoff":
      out(await core.handoff({ to: positional[0], note: flagStr(flags.note), project }));
      break;

    case "set-boss": {
      const to = positional[0];
      if (!to) die("usage: bridge set-boss <codex|claude>");
      out(await core.setBoss({ to, project }));
      break;
    }

    case "reap": {
      const idle = flagStr(flags.idle) ?? flagStr(flags.idleMinutes);
      out(await core.reap({ idleMinutes: idle ? Number(idle) : undefined }));
      break;
    }

    case "log": {
      const summary = positional.join(" ").trim();
      if (!summary) die('usage: bridge log "<summary>" [--files a,b,c]');
      const files = flagStr(flags.files)?.split(",").map((s) => s.trim()).filter(Boolean);
      out(await core.log({ summary, files, project }));
      break;
    }

    case "task-add": {
      const title = positional.join(" ").trim();
      if (!title) die('usage: bridge task-add "<title>"');
      out(await core.taskAdd({ title, project, owner: flagStr(flags.owner) }));
      break;
    }

    case "task-update": {
      const id = positional[0];
      const status = positional[1] as "todo" | "doing" | "done" | undefined;
      if (!id) die("usage: bridge task-update <id> <todo|doing|done>");
      out(await core.taskUpdate({ id, status, owner: flagStr(flags.owner), project }));
      break;
    }

    case "backup":
      out(await core.backup({ project: positional[0] ?? project, force: !!(flags.force || flags["allow-dirty"]) }));
      break;

    case "restore": {
      const name = positional[0];
      if (!name) die("usage: bridge restore <project> [dest]");
      out(await core.restore({ project: name, dest: positional[1] ?? flagStr(flags.dest) }));
      break;
    }

    case "list":
      out(await core.listProjects());
      break;

    case "recent": {
      const limit = flagStr(flags.limit);
      out(await core.recent({ project, limit: limit ? Number(limit) : undefined }));
      break;
    }

    case "catalog": {
      const sub = positional[0] ?? "status";
      const round1 = (n: number) => Math.round(n * 10) / 10;
      switch (sub) {
        case "status": {
          const c = catalog.loadCatalog();
          const age = catalog.catalogAgeHours();
          out({
            path: catalog.modelsPath(),
            source: c.meta.source,
            fetchedAt: c.meta.fetchedAt || null,
            ageHours: age === null ? null : round1(age),
            stale: catalog.isStale(),
            count: c.meta.count,
            ok: c.meta.ok,
            error: c.meta.error,
          });
          break;
        }
        case "refresh": {
          const meta = await catalog.refreshCatalog();
          out({ refreshed: true, ...meta });
          break;
        }
        case "ensure": {
          const c = await catalog.ensureFresh();
          const age = catalog.catalogAgeHours();
          out({ ensured: true, fetchedAt: c.meta.fetchedAt || null, ageHours: age === null ? null : round1(age), stale: catalog.isStale(), count: c.meta.count });
          break;
        }
        case "get": {
          const id = positional[1];
          if (!id) die("usage: bridge catalog get <model-id>");
          const m = catalog.getModel(id);
          out(m ?? { error: `not found: ${id}` });
          break;
        }
        case "path":
          out(catalog.catalogDir());
          break;
        default:
          die("usage: bridge catalog <status|refresh|ensure|get <id>|path>");
      }
      break;
    }

    case "openrouter": {
      const sub = positional[0] ?? "status";
      switch (sub) {
        case "status":
          out({ keySet: openrouter.hasApiKey(), base: "https://openrouter.ai/api/v1", defaultPingModel: openrouter.defaultPingModel() });
          break;
        case "ping": {
          const r = await openrouter.ping(positional[1]);
          out({ ok: true, requested: r.picked, modelUsed: r.model, reply: r.text.slice(0, 200), usage: r.usage });
          break;
        }
        case "chat": {
          const model = positional[1];
          const prompt = positional.slice(2).join(" ").trim();
          if (!model || !prompt) die('usage: bridge openrouter chat <model-id> "<prompt>"');
          const r = await openrouter.chat({ model, messages: [{ role: "user", content: prompt }] });
          out({ modelUsed: r.model, reply: r.text, usage: r.usage });
          break;
        }
        default:
          die('usage: bridge openrouter <status|ping [model]|chat <model> "<prompt>">');
      }
      break;
    }

    default:
      die(`unknown command: ${cmd}\n\n${HELP}`);
  }
}

main().catch((e) => die((e as Error).message));
