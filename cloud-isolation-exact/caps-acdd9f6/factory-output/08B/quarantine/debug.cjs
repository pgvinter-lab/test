const cp = require('child_process');
const fs = require('fs');
const tempDir = fs.mkdtempSync(require('path').join(require('os').tmpdir(), 'test-'));
fs.mkdirSync(tempDir + '/bin'); fs.mkdirSync(tempDir + '/home'); fs.mkdirSync(tempDir + '/appdata'); fs.mkdirSync(tempDir + '/config');

const preloadPath = tempDir + '/preload-net.mjs';
const requestLogPath = tempDir + '/request-log.json';
const interruptFlagPath = tempDir + '/interrupt-flag';
fs.writeFileSync(preloadPath, `
import fs from "node:fs";
import path from "node:path";
const originalFetch = globalThis.fetch;

const allowedUrls = new Set([
  "https://mcpservers.org/sitemap.xml",
  "https://mcpservers.org/servers/1.xml",
  "https://mcpservers.org/skills.xml",
  "https://mcpservers.org/all",
  "https://mcpservers.org/all?page=1",
  "https://mcpservers.org/all?page=2",
  "https://mcpservers.org/agent-skills",
  "https://mcpservers.org/agent-skills?page=1",
  "https://mcpservers.org/search?page=1&query=",
  "https://mcpservers.org/search?page=2&query=",
  "https://mcpservers.org/servers/test-server",
  "https://mcpservers.org/servers/paid-server",
  "https://mcpservers.org/servers/shared-slug"
]);

globalThis.fetch = async (url, options) => {
  const strUrl = url.toString();
  if (!allowedUrls.has(strUrl)) throw new Error("Network not allowed in test: " + strUrl);
  
  const fix = (name) => {
    const p = path.resolve('${require('path').resolve(__dirname, "test/fixtures/caps").replace(/\\/g, '\\\\')}', name);
    return fs.readFileSync(p, "utf8");
  };

  try {
    if (strUrl === "https://mcpservers.org/sitemap.xml") return new Response(fix("mcpservers-root-sitemap.xml"), { status: 200, headers: { "Content-Type": "text/xml" } });
    if (strUrl === "https://mcpservers.org/servers/1.xml") return new Response(fix("mcpservers-server-sitemap.xml"), { status: 200, headers: { "Content-Type": "text/xml" } });
    if (strUrl === "https://mcpservers.org/skills.xml") return new Response(fix("mcpservers-skills-sitemap.xml"), { status: 200, headers: { "Content-Type": "text/xml" } });
  } catch (e) {
    console.error("FIX ERROR", e);
    throw e;
  }
  return new Response("", { status: 200 });
};
`);

try {
  const out = cp.execSync('node dist/cli.js caps refresh --lane mcpservers', { 
    env: { ...process.env, BRIDGE_CAPS_STATE_DIR: tempDir, NODE_OPTIONS: `--import "${require('url').pathToFileURL(preloadPath).href}"` } 
  });
  console.log(JSON.parse(out).lane_outcomes.mcpservers.errors);
} catch (e) {
  console.error("EXEC ERROR:", e.message);
  console.error("STDERR:", e.stderr?.toString());
  console.error("STDOUT:", e.stdout?.toString());
}
