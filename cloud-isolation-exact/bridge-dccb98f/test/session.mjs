// Verifies the session/roles model: first-command-wins boss, sticky, user switch, idle reap.
import { execFileSync } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import assert from "node:assert";

const root = fs.mkdtempSync(path.join(os.tmpdir(), "bridge-sess-"));
const HOME = path.join(root, "home");
const PROJ = path.join(root, "proj");
fs.mkdirSync(HOME, { recursive: true });
fs.mkdirSync(PROJ, { recursive: true });
const CLI = path.resolve("dist/cli.js");

function as(agent, args) {
  return JSON.parse(execFileSync("node", [CLI, ...args], { env: { ...process.env, BRIDGE_AGENT: agent, BRIDGE_HOME: HOME }, encoding: "utf8" }));
}
let pass = 0;
const ok = (c, l) => { assert.ok(c, l); console.log("  PASS:", l); pass++; };

try {
  as("claude", ["register", "p", PROJ]);

  const s1 = as("codex", ["sync", "--project", "p"]);
  ok(s1.session?.boss === "codex" && s1.session.youAreBoss === true, "first command (codex) becomes boss");
  ok(s1.openedNewSession === true, "first command opens a new session");

  const s2 = as("claude", ["sync", "--project", "p"]);
  ok(s2.session.boss === "codex" && s2.session.youAreBoss === false, "boss is sticky — claude sees codex as boss");
  ok(s2.openedNewSession === false, "claude joining does not open a new session");

  const sb = as("claude", ["set-boss", "claude", "--project", "p"]);
  ok(sb.ok && sb.boss === "claude", "set-boss switches the boss");

  const s3 = as("codex", ["sync", "--project", "p"]);
  ok(s3.session.boss === "claude" && s3.session.bossSetBy === "user", "switch persists (bossSetBy=user)");

  const r = as("reaper", ["reap", "--idle", "0"]);
  ok(r.closed.some((c) => c.project === "p"), "reap closes the idle session");

  const s4 = as("codex", ["sync", "--project", "p"]);
  ok(s4.session.boss === "codex" && s4.openedNewSession === true, "after close, next command starts a fresh session + boss");

  console.log(`\nSESSION TESTS PASSED (${pass})`);
} catch (e) {
  console.error("\nFAILED:", e.message);
  process.exitCode = 1;
} finally {
  try { fs.rmSync(root, { recursive: true, force: true }); } catch {}
}
