// End-to-end test: drives the built CLI as two separate agent processes
// (BRIDGE_AGENT=codex vs claude) against a temp project + temp BRIDGE_HOME,
// exactly like the real two-tool setup. Asserts coordination, freshness, backup.
import { execFileSync } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import assert from "node:assert";

const root = fs.mkdtempSync(path.join(os.tmpdir(), "bridge-e2e-"));
const HOME = path.join(root, "home");
const PROJ = path.join(root, "proj");
fs.mkdirSync(HOME, { recursive: true });
fs.mkdirSync(PROJ, { recursive: true });
const CLI = path.resolve("dist/cli.js");

let pass = 0;
function ok(cond, label) {
  assert.ok(cond, label);
  console.log("  PASS:", label);
  pass++;
}
function as(agent, args) {
  const stdout = execFileSync("node", [CLI, ...args], {
    env: { ...process.env, BRIDGE_AGENT: agent, BRIDGE_HOME: HOME },
    encoding: "utf8",
  });
  return JSON.parse(stdout);
}
function git(args) {
  execFileSync("git", ["-c", "user.email=t@t", "-c", "user.name=t", ...args], { cwd: PROJ, stdio: "ignore" });
}

try {
  console.log("temp root:", root);

  // 1. register (as claude)
  const reg = as("claude", ["register", "testproj", PROJ]);
  ok(reg.ok && reg.name === "testproj", "register creates project");
  ok(/git repo/.test(reg.git), "register git-inits the repo");
  ok(fs.existsSync(path.join(PROJ, ".connector")), ".connector/ created");

  // seed a file
  fs.mkdirSync(path.join(PROJ, "src"), { recursive: true });
  fs.writeFileSync(path.join(PROJ, "src", "app.js"), "// v1\n");

  // 2. codex claims src
  const claim1 = as("codex", ["claim", "src", "--project", "testproj"]);
  ok(claim1.ok && claim1.granted.includes("src"), "codex claims src");

  // 3. claude sync sees codex's lease (baseline sync)
  const sync1 = as("claude", ["sync", "--project", "testproj"]);
  ok(sync1.firstSync === true, "claude first sync sets baseline");
  ok(sync1.othersLeases.some((l) => l.agent === "codex" && l.paths.includes("src")), "claude sees codex's lease on src");

  // 4. claude's overlapping claim is denied
  const claim2 = as("claude", ["claim", "src/app.js", "--project", "testproj"]);
  ok(claim2.ok === false && claim2.conflicts.length > 0, "overlapping claim denied");

  // 5. claude claims a non-overlapping path
  const claim3 = as("claude", ["claim", "docs", "--project", "testproj"]);
  ok(claim3.ok && claim3.granted.includes("docs"), "non-overlapping claim granted");

  // 6. codex edits the file + logs it
  fs.writeFileSync(path.join(PROJ, "src", "app.js"), "// v2 edited by codex\n");
  const logRes = as("codex", ["log", "edited app", "--files", "src/app.js", "--project", "testproj"]);
  ok(logRes.ok, "codex logs work");

  // 7. claude sync #2 surfaces the change + attributes it
  const sync2 = as("claude", ["sync", "--project", "testproj"]);
  ok(sync2.firstSync === false, "second sync is not first");
  ok(sync2.changedSinceLastSync.includes("src/app.js"), "freshness: app.js flagged changed since last sync");
  ok(sync2.changedByOther.some((e) => e.agent === "codex"), "freshness attributes change to codex");

  // 8. codex releases; claude sync no longer shows codex lease
  as("codex", ["release", "--project", "testproj"]);
  const sync3 = as("claude", ["sync", "--project", "testproj"]);
  ok(!sync3.othersLeases.some((l) => l.agent === "codex"), "codex lease cleared after release");

  // 9. handoff flips control
  const ho = as("codex", ["handoff", "claude", "--note", "your turn", "--project", "testproj"]);
  ok(ho.ok && ho.control === "claude", "handoff sets control to claude");

  // 10. backup round-trip (needs a commit)
  git(["add", "-A"]);
  git(["commit", "-m", "init"]);
  const bk = as("claude", ["backup", "testproj"]);
  ok(bk.ok && fs.existsSync(bk.bundle), "backup writes a git bundle to BRIDGE_HOME");

  const dest = path.join(root, "restored");
  const rs = as("claude", ["restore", "testproj", dest]);
  ok(rs.ok && fs.existsSync(path.join(dest, "src", "app.js")), "restore clones the bundle to a new dir");

  // 11. ledger + list sanity
  const recent = as("claude", ["recent", "--project", "testproj"]);
  ok(recent.count > 0 && recent.entries.some((e) => e.action === "backup"), "ledger records cross-project activity");

  console.log(`\nALL ${pass} CHECKS PASSED`);
} catch (e) {
  console.error("\nFAILED:", e.message);
  process.exitCode = 1;
} finally {
  try { fs.rmSync(root, { recursive: true, force: true }); } catch {}
}
