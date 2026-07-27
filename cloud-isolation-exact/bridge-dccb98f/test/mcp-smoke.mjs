// Spawns the bridge as a real MCP stdio server and drives it with the MCP client,
// exactly as Claude/Codex would — validates the server handshake + tool round-trip.
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StdioClientTransport } from "@modelcontextprotocol/sdk/client/stdio.js";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import assert from "node:assert";

const HOME = fs.mkdtempSync(path.join(os.tmpdir(), "bridge-mcp-"));
const SERVER = path.resolve("dist/server.js");

const transport = new StdioClientTransport({
  command: "node",
  args: [SERVER],
  env: {
    ...process.env,
    BRIDGE_AGENT: "claude",
    BRIDGE_LANE: "claude_desktop_code",
    BRIDGE_HOME: HOME,
    BRIDGE2_HOME: HOME,
  },
});
const client = new Client({ name: "smoke", version: "0.0.0" });

try {
  await client.connect(transport);
  console.log("  PASS: connected to bridge MCP server");

  const { tools } = await client.listTools();
  const names = tools.map((t) => t.name);
  for (const expected of ["bridge_sync", "bridge_claim", "bridge_handoff", "bridge_backup", "bridge_list_projects"]) {
    assert.ok(names.includes(expected), `missing tool ${expected}`);
  }
  console.log(`  PASS: server advertises ${names.length} tools (${names.join(", ")})`);

  const res = await client.callTool({ name: "bridge_list_projects", arguments: {} });
  const payload = JSON.parse(res.content[0].text);
  assert.ok(payload.you.agent === "claude_desktop_code", "lane identity propagated via BRIDGE_LANE");
  assert.ok(Array.isArray(payload.projects), "list_projects returns an array");
  console.log("  PASS: bridge_list_projects round-trip (identity=claude_desktop_code)");

  console.log("\nMCP SMOKE PASSED");
} catch (e) {
  console.error("\nFAILED:", e.message);
  process.exitCode = 1;
} finally {
  await client.close().catch(() => {});
  try { fs.rmSync(HOME, { recursive: true, force: true }); } catch {}
}
