// Regression tests for the high-severity review fixes (H1-H6). Drives the built CLI
// as separate agent processes against temp BRIDGE_HOME/project dirs, like e2e.mjs.
import { execFileSync } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import assert from "node:assert";

const root = fs.mkdtempSync(path.join(os.tmpdir(), "bridge-fixes-"));
const HOME = path.join(root, "home");
fs.mkdirSync(HOME, { recursive: true });
const CLI = path.resolve("dist/cli.js");
const HOST_SHARD = `ledger.${os.hostname().replace(/[^A-Za-z0-9._-]/g, "_")}.jsonl`;

let pass = 0;
const ok = (c, l) => { assert.ok(c, l); console.log("  PASS:", l); pass++; };
function run(agent, args, opts = {}) {
  const stdout = execFileSync("node", [CLI, ...args], {
    env: { ...process.env, BRIDGE_AGENT: agent, BRIDGE_HOME: HOME, ...(opts.env || {}) },
    encoding: "utf8", cwd: opts.cwd,
  });
  return JSON.parse(stdout);
}
function git(dir, args) {
  execFileSync("git", ["-C", dir, "-c", "user.email=t@t", "-c", "user.name=t", ...args], { stdio: "ignore" });
}

try {
  console.log("temp root:", root);

  // ---- H3: corrupt state.json is quarantined, not silently overwritten-to-default ----
  const P1 = path.join(root, "p1");
  run("claude", ["register", "p1", P1]);
  run("codex", ["claim", "src", "--project", "p1"]);
  const stateFile = path.join(P1, ".connector", "state.json");
  fs.writeFileSync(stateFile, "{ this is :: not valid json ");          // corrupt it
  const s3 = run("claude", ["sync", "--project", "p1"]);                 // must not crash
  ok(s3.project === "p1", "H3: sync recovers after a corrupt state.json (no crash)");
  const quarantined = fs.readdirSync(path.join(P1, ".connector")).filter((f) => f.startsWith("state.json.corrupt."));
  ok(quarantined.length === 1, "H3: corrupt state.json quarantined to state.json.corrupt.<ts>");
  ok(/not valid json/.test(fs.readFileSync(path.join(P1, ".connector", quarantined[0]), "utf8")),
    "H3: the original corrupt bytes are preserved (not destroyed by overwrite)");

  // ---- H1: ledger is per-host sharded; reads merge shards + legacy file ----
  const P2 = path.join(root, "p2");
  run("claude", ["register", "p2", P2]);
  run("claude", ["log", "did a thing", "--files", "a.js", "--project", "p2"]);
  ok(fs.existsSync(path.join(HOME, HOST_SHARD)), "H1: ledger append writes the per-host shard ledger.<host>.jsonl");
  ok(!fs.existsSync(path.join(HOME, "ledger.jsonl")), "H1: appends do NOT write the shared ledger.jsonl (no Drive-conflict file)");
  // seed a legacy single-file entry + confirm the merging reader unions both
  fs.appendFileSync(path.join(HOME, "ledger.jsonl"),
    JSON.stringify({ ts: 1, iso: "1970-01-01T00:00:00Z", host: "oldhost", agent: "codex", project: "p2", action: "legacy-entry", note: "x" }) + "\n");
  const rec = run("claude", ["recent", "--project", "p2", "--limit", "50"]);
  ok(rec.entries.some((e) => e.action === "legacy-entry"), "H1: ledgerReadAll merges legacy ledger.jsonl");
  ok(rec.entries.some((e) => e.action === "log"), "H1: ledgerReadAll merges the host shard");

  // ---- H5: backup refuses a dirty tree unless forced ----
  const P3 = path.join(root, "p3");
  run("claude", ["register", "p3", P3]);
  fs.writeFileSync(path.join(P3, "a.txt"), "v1\n");
  git(P3, ["add", "-A"]); git(P3, ["commit", "-m", "init"]);
  fs.writeFileSync(path.join(P3, "a.txt"), "v2 uncommitted\n");          // make it dirty
  const b1 = run("claude", ["backup", "p3"]);
  ok(b1.ok === false && b1.dirty === true, "H5: backup refuses a dirty tree (would silently omit uncommitted work)");
  const b2 = run("claude", ["backup", "p3", "--force"]);
  ok(b2.ok === true && fs.existsSync(b2.bundle), "H5: backup --force bundles the committed state");

  // ---- H6: reap closes an idle session but KEEPS live (unexpired) leases ----
  const P4 = path.join(root, "p4");
  run("claude", ["register", "p4", P4]);
  run("codex", ["claim", "src", "--project", "p4", "--ttl", "120"]);     // 2h TTL, very much alive
  const r = run("reaper", ["reap", "--idle", "0"]);
  ok(r.closed.some((c) => c.project === "p4"), "H6: reap closes the idle session");
  const s6 = run("claude", ["sync", "--project", "p4"]);
  ok(s6.othersLeases.some((l) => l.agent === "codex" && l.paths.includes("src")),
    "H6: reap kept the other agent's live lease (no clobber window)");

  // ---- H4: BRIDGE_PROJECT pins the project; an unregistered cwd-guess is flagged ----
  const P5 = path.join(root, "p5");
  run("claude", ["register", "p5", P5]);
  const sPin = run("claude", ["sync"], { env: { BRIDGE_PROJECT: "p5" }, cwd: root });
  ok(sPin.project === "p5", "H4: BRIDGE_PROJECT pins resolution regardless of cwd");
  ok(!sPin.projectWarning, "H4: a pinned, registered project emits no guess warning");
  const unrelated = path.join(root, "unrelated");
  fs.mkdirSync(unrelated, { recursive: true });
  const sGuess = run("claude", ["sync"], { cwd: unrelated });
  ok(!!sGuess.projectWarning, "H4: an unregistered cwd-guessed project surfaces a projectWarning");

  console.log(`\nALL ${pass} FIX-REGRESSION CHECKS PASSED`);
} catch (e) {
  console.error("\nFAILED:", e.message);
  process.exitCode = 1;
} finally {
  try { fs.rmSync(root, { recursive: true, force: true }); } catch {}
}
