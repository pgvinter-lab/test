// Structural validation for the browser-tab connectors. Plain node, no build needed.
//   node test/connectors.mjs   (or: npm run connectors-test)
// Checks each platform manifest has the keys Code relies on, and each injectable
// driver exposes the methods the playbook calls. It does NOT open a browser.
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..", "connectors");
const PLATFORMS = ["chatgpt", "gemini", "aistudio"];
const REQUIRED_MANIFEST_KEYS = ["id", "surface", "baseUrl", "ownership", "abilities", "promptSyntax", "settle", "selectors"];
const REQUIRED_DRIVER_TOKENS = ["window.__CONN", "isSettled", "mark:", "lastText:", "newChat:", "loggedIn:"];

let failures = 0;
const fail = (m) => { console.error("  ✗ " + m); failures++; };
const pass = (m) => console.log("  ✓ " + m);

for (const p of PLATFORMS) {
  console.log(`\n[${p}]`);

  // manifest
  const manifestPath = path.join(root, p, "capabilities.json");
  try {
    const m = JSON.parse(fs.readFileSync(manifestPath, "utf8"));
    for (const k of REQUIRED_MANIFEST_KEYS) {
      if (m[k] === undefined) fail(`capabilities.json missing key: ${k}`);
    }
    if (m.surface !== p) fail(`capabilities.surface "${m.surface}" != "${p}"`);
    if (!m.abilities || !m.abilities.default) fail("capabilities.abilities.default missing");
    if (failures === 0 || m.id) pass(`capabilities.json valid (id=${m.id}, abilities=${Object.keys(m.abilities || {}).join("/")})`);
  } catch (e) {
    fail(`capabilities.json unreadable/invalid JSON: ${e.message}`);
  }

  // driver
  const driverPath = path.join(root, p, `inject.${p}.js`);
  try {
    const src = fs.readFileSync(driverPath, "utf8");
    for (const tok of REQUIRED_DRIVER_TOKENS) {
      if (!src.includes(tok)) fail(`inject.${p}.js missing: ${tok}`);
    }
    if (!src.includes("TODO")) fail(`inject.${p}.js: expected an isSettled() TODO tuning marker`);
    pass(`inject.${p}.js exposes the driver surface`);
  } catch (e) {
    fail(`inject.${p}.js unreadable: ${e.message}`);
  }
}

console.log(failures === 0 ? "\nPASS — connectors structurally valid" : `\nFAIL — ${failures} problem(s)`);
process.exit(failures === 0 ? 0 : 1);
