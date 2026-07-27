// Real-binary contract smoke for the Google Antigravity CLI. This intentionally
// exercises only local metadata commands: it does not accept onboarding terms,
// contact a model, or require a successful remote response.

import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { existsSync, mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { setTimeout as delay } from "node:timers/promises";
import { buildPeerArgv, peerCliSpec } from "../../dist/v2/a2a/peer-dispatch.js";

const ANSI = /[\u001B\u009B][[\]()#;?]*(?:(?:(?:[a-zA-Z\d]*(?:;[-a-zA-Z\d/#&.:=?%@~_]+)*)?\u0007)|(?:(?:\d{1,4}(?:[;:]\d{0,4})*)?[\dA-PR-TZcf-nq-uy=><~]))/g;

function locateAgy() {
  const configured = process.env.BRIDGE_AGY_PATH?.trim();
  if (configured) return configured;
  if (process.platform === "win32") {
    if (process.env.LOCALAPPDATA) {
      const installed = join(process.env.LOCALAPPDATA, "agy", "bin", "agy.exe");
      if (existsSync(installed)) return installed;
    }
    const located = spawnSync("where.exe", ["agy.exe"], { encoding: "utf8", timeout: 10_000, windowsHide: true });
    if (!located.error && located.status === 0) return located.stdout.split(/\r?\n/, 1)[0].trim();
    return undefined;
  }
  const probe = spawnSync("agy", ["--version"], { encoding: "utf8", timeout: 20_000 });
  return !probe.error && probe.status === 0 ? "agy" : undefined;
}

function runMetadata(command, args, cwd) {
  assert.ok(args.length === 1 && ["--version", "--help"].includes(args[0]), "metadata smoke only permits fixed local flags");
  const env = { ...process.env, NO_COLOR: "1", TERM: "dumb" };
  // agy 1.1.2 does not reliably return when Node gives it a fresh capture pipe on
  // Windows. Inherit the existing handles, and let PowerShell persist the fixed
  // metadata output for deterministic assertions.
  const executable = process.platform === "win32" ? "powershell.exe" : command;
  const outputPath = join(cwd, `agy-${args[0].slice(2)}.txt`);
  const invocationArgs = process.platform === "win32"
    ? [
        "-NoLogo",
        "-NoProfile",
        "-NonInteractive",
        "-Command",
        `& $env:BRIDGE_AGY_SMOKE_EXE ${args[0]} 2>&1 | Out-File -LiteralPath $env:BRIDGE_AGY_SMOKE_OUTPUT -Encoding ascii; exit $LASTEXITCODE`,
      ]
    : args;
  if (process.platform === "win32") {
    env.BRIDGE_AGY_SMOKE_EXE = command;
    env.BRIDGE_AGY_SMOKE_OUTPUT = outputPath;
  }
  const result = spawnSync(executable, invocationArgs, {
    cwd,
    encoding: "utf8",
    env,
    stdio: process.platform === "win32" ? "inherit" : "pipe",
    timeout: 30_000,
    // The Windows CLI requires a console. `windowsHide: true` maps to a
    // no-console creation mode and makes even `--version` wait indefinitely.
    windowsHide: false,
  });
  assert.equal(result.error, undefined, `agy ${args.join(" ")} failed to spawn: ${result.error?.message}`);
  const output = process.platform === "win32"
    ? (existsSync(outputPath) ? readFileSync(outputPath, "utf8") : "")
    : `${result.stdout || ""}\n${result.stderr || ""}`;
  assert.equal(result.status, 0, `agy ${args.join(" ")} failed: ${output}`);
  return output.replace(ANSI, "");
}

async function removeSmokeWorkspace(cwd) {
  const deadline = Date.now() + 30_000;
  for (;;) {
    try {
      rmSync(cwd, { recursive: true, force: true });
      return;
    } catch (error) {
      if (error?.code !== "EPERM" || Date.now() >= deadline) throw error;
      // agy can return metadata before its Windows process releases the cwd.
      await delay(250);
    }
  }
}

const agy = locateAgy();
if (process.env.BRIDGE_RUN_AGY_CLI_SMOKE !== "1") {
  console.log("AGY CLI SMOKE SKIPPED: set BRIDGE_RUN_AGY_CLI_SMOKE=1 for the opt-in real-binary check");
} else if (!agy) {
  console.log("AGY CLI SMOKE SKIPPED: agy is not installed");
} else {
  // agy loads workspace-local agent configuration before even printing metadata.
  // An empty directory keeps this contract smoke independent of the repository's
  // installed agent/plugin folders and avoids exercising project initialization.
  const cwd = mkdtempSync(join(tmpdir(), "bridge-agy-smoke-"));
  let verifiedVersion;
  try {
    const version = runMetadata(agy, ["--version"], cwd).trim();
    assert.match(version, /^\d+\.\d+\.\d+(?:[-+][0-9A-Za-z.-]+)?$/);
    verifiedVersion = version;

    const help = runMetadata(agy, ["--help"], cwd);
    assert.match(help, /^\s*--print\s+Run a single prompt non-interactively/m);
    assert.match(help, /^\s*-p\s+Short alias for --print/m);
    assert.match(help, /^\s*--model\s+/m);
    assert.match(help, /^\s*--new-project\s+/m);
    assert.match(help, /^\s*--mode\s+/m);
    assert.match(help, /^\s*--dangerously-skip-permissions\s+/m);
    assert.match(help, /^\s*--print-timeout\s+/m);
    assert.doesNotMatch(help, /^\s+exec\s+/m, "the real CLI must not advertise the retired guessed `exec` subcommand");

    const prompt = "--api-key flag-shaped-content";
    const spec = peerCliSpec("antigravity");
    assert.equal(spec.command, "agy");
    assert.equal(spec.promptMode, "option-value");
    assert.deepEqual(
      buildPeerArgv(spec, prompt),
      [
        "--new-project",
        "--model",
        "Gemini 3.1 Pro (High)",
        "--mode",
        "accept-edits",
        "--dangerously-skip-permissions",
        "--print-timeout",
        "20m",
        `--print=${prompt}`,
      ],
    );

  } finally {
    await removeSmokeWorkspace(cwd);
  }
  console.log(`AGY CLI SMOKE PASSED: agy ${verifiedVersion}; --print present; exec absent; dispatcher argv matches`);
}
