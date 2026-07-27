import { spawn } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { BridgeRuntimeError, invariant } from "../core/errors.js";
import type { RunProcess } from "./peer-dispatch.js";

const DEFAULT_TIMEOUT_MS = 10 * 60 * 1000;
const DEFAULT_MAX_OUTPUT_BYTES = 8 * 1024 * 1024;
const FORBIDDEN_ENV = /(?:^|_)(?:API_?KEY|ACCESS_?TOKEN|AUTH_?TOKEN|BEARER|PASSWORD|SECRET|CREDENTIALS?)(?:_|$)/iu;

export interface SubscriptionProcessRunnerOptions {
  readonly cwd: string;
  readonly timeoutMs?: number;
  readonly maxOutputBytes?: number;
}

interface ResolvedLaunch {
  readonly command: string;
  readonly prefixArgs: readonly string[];
}

/**
 * Shell-free runner for the three frozen subscription CLI command names.
 *
 * The peer dispatcher owns the allowed argv shape. This runner owns the other
 * half of the boundary: resolve only those command names to installed binaries,
 * remove API-key-shaped environment variables, never invoke a shell, bind the
 * child to the delegated project, and bound execution time/output.
 */
export function createSubscriptionProcessRunner(options: SubscriptionProcessRunnerOptions): RunProcess {
  const cwd = fs.realpathSync.native(path.resolve(options.cwd));
  invariant(fs.statSync(cwd).isDirectory(), "a2a_process_runner_cwd_invalid", { cwd });
  const timeoutMs = options.timeoutMs ?? DEFAULT_TIMEOUT_MS;
  const maxOutputBytes = options.maxOutputBytes ?? DEFAULT_MAX_OUTPUT_BYTES;
  invariant(Number.isSafeInteger(timeoutMs) && timeoutMs >= 1_000, "a2a_process_runner_timeout_invalid");
  invariant(Number.isSafeInteger(maxOutputBytes) && maxOutputBytes >= 1_024, "a2a_process_runner_output_limit_invalid");

  return async (command, args, input) => {
    const launch = resolveLaunch(command);
    const childArgs = [...launch.prefixArgs, ...args];
    return new Promise((resolve, reject) => {
      const child = spawn(launch.command, childArgs, {
        cwd,
        env: sanitizedEnvironment(),
        shell: false,
        windowsHide: true,
        stdio: ["pipe", "pipe", "pipe"],
      });
      let stdout = "";
      let stderr = "";
      let outputBytes = 0;
      let settled = false;
      const timer = setTimeout(() => {
        terminateExactChild(child.pid);
        finish(new BridgeRuntimeError("a2a_peer_dispatch_timeout", { command, timeoutMs }));
      }, timeoutMs);

      const finish = (error?: Error, code?: number | null): void => {
        if (settled) return;
        settled = true;
        clearTimeout(timer);
        if (error) reject(error);
        else resolve({ stdout, stderr, code: code ?? 1 });
      };
      const capture = (stream: "stdout" | "stderr", chunk: Buffer): void => {
        outputBytes += chunk.length;
        if (outputBytes > maxOutputBytes) {
          terminateExactChild(child.pid);
          finish(new BridgeRuntimeError("a2a_peer_dispatch_output_limit", { command, maxOutputBytes }));
          return;
        }
        if (stream === "stdout") stdout += chunk.toString("utf8");
        else stderr += chunk.toString("utf8");
      };

      child.stdout.on("data", (chunk: Buffer) => capture("stdout", chunk));
      child.stderr.on("data", (chunk: Buffer) => capture("stderr", chunk));
      child.once("error", (error) => finish(error));
      child.once("close", (code) => finish(undefined, code));
      if (input !== undefined) child.stdin.end(input, "utf8");
      else child.stdin.end();
    });
  };
}

function resolveLaunch(command: string): ResolvedLaunch {
  const home = os.homedir();
  const localAppData = process.env.LOCALAPPDATA?.trim() || path.join(home, "AppData", "Local");
  const appData = process.env.APPDATA?.trim() || path.join(home, "AppData", "Roaming");
  switch (command) {
    case "agy":
      return existingLaunch([
        { command: path.join(localAppData, "agy", "bin", "agy.exe"), prefixArgs: [] },
      ], "antigravity");
    case "claude":
      return existingLaunch([
        { command: path.join(appData, "npm", "node_modules", "@anthropic-ai", "claude-code", "bin", "claude.exe"), prefixArgs: [] },
      ], "claude");
    case "codex": {
      const script = path.join(appData, "npm", "node_modules", "@openai", "codex", "bin", "codex.js");
      return existingLaunch([
        { command: process.execPath, prefixArgs: [script], requiredPath: script },
      ], "codex");
    }
    default:
      throw new BridgeRuntimeError("a2a_process_runner_command_not_allowed", { command });
  }
}

function existingLaunch(
  candidates: readonly (ResolvedLaunch & { readonly requiredPath?: string })[],
  peer: string,
): ResolvedLaunch {
  for (const candidate of candidates) {
    const required = candidate.requiredPath ?? candidate.command;
    if (path.isAbsolute(candidate.command) && fs.existsSync(candidate.command) && fs.existsSync(required)) {
      return { command: path.resolve(candidate.command), prefixArgs: [...candidate.prefixArgs] };
    }
  }
  throw new BridgeRuntimeError("a2a_peer_cli_not_installed", { peer });
}

function sanitizedEnvironment(): NodeJS.ProcessEnv {
  const result: NodeJS.ProcessEnv = {};
  for (const [key, value] of Object.entries(process.env)) {
    if (value === undefined || FORBIDDEN_ENV.test(key)) continue;
    result[key] = value;
  }
  return result;
}

function terminateExactChild(pid: number | undefined): void {
  if (!pid || !Number.isSafeInteger(pid) || pid <= 0) return;
  if (process.platform === "win32") {
    const killer = spawn("taskkill.exe", ["/PID", String(pid), "/T", "/F"], {
      shell: false,
      windowsHide: true,
      stdio: "ignore",
    });
    killer.unref();
    return;
  }
  try { process.kill(pid, "SIGTERM"); } catch { /* already exited */ }
}
