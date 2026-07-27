import test from "node:test";
import assert from "node:assert";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StdioClientTransport } from "@modelcontextprotocol/sdk/client/stdio.js";
import { DatabaseSync } from "node:sqlite";
import { pathToFileURL, fileURLToPath } from "node:url";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const storeModule = await import(
  pathToFileURL(path.resolve(__dirname, "../../dist/caps/store.js")).href
);
const mcpModule = await import(
  pathToFileURL(path.resolve(__dirname, "../../dist/caps/mcp.js")).href
);
const censusModule = await import(
  pathToFileURL(path.resolve(__dirname, "../../dist/caps/census.js")).href
);
const CapsStore = storeModule.CapsStore;
const CapsMcpRuntime = mcpModule.CapsMcpRuntime;
const deriveTrustedCapsContext = mcpModule.deriveTrustedCapsContext;
const mapTrustedContext = censusModule.mapTrustedContext;
const SERVER = path.resolve("dist/server.js");

const EXISTING_BRIDGE_TOOLS = [
  "bridge_a2a_get",
  "bridge_a2a_send",
  "bridge_backup",
  "bridge_claim",
  "bridge_handoff",
  "bridge_list_projects",
  "bridge_log",
  "bridge_mailbox_doctor",
  "bridge_mailbox_list",
  "bridge_mailbox_send",
  "bridge_mailbox_status",
  "bridge_reap",
  "bridge_recent",
  "bridge_register_project",
  "bridge_release",
  "bridge_restore",
  "bridge_set_boss",
  "bridge_sync",
  "bridge_task_add",
  "bridge_task_dispatch",
  "bridge_task_update",
  "bridge_web_node_list",
  "bridge_web_node_result",
  "bridge_web_node_send",
];

function databaseRows(databasePath, table) {
  const database = new DatabaseSync(databasePath);
  try {
    return database.prepare(`SELECT * FROM ${table} ORDER BY id`).all();
  } finally {
    database.close();
  }
}

function capabilitySnapshot(databasePath) {
  return JSON.stringify({
    installed_working: databaseRows(databasePath, "installed_working"),
    installed_broken: databaseRows(databasePath, "installed_broken"),
    available_for_install: databaseRows(databasePath, "available_for_install"),
  });
}

async function closeConnection(connection) {
  if (connection.closed) return;
  connection.closed = true;
  await connection.client.close().catch(() => {});
  if (connection.transport.childProcess?.exitCode === null) {
    connection.transport.childProcess.kill();
  }
}

async function callIsRejected(client, request) {
  try {
    const response = await client.callTool(request);
    return response.isError === true;
  } catch {
    return true;
  }
}

test("MCP caps tools acceptance", async (t) => {
  const tmpBase = fs.mkdtempSync(path.join(os.tmpdir(), "bridge-caps-test-"));
  const home = path.join(tmpBase, "home");
  const capsDirectory = path.join(tmpBase, "caps");
  const databasePath = path.join(capsDirectory, "caps.sqlite");
  fs.mkdirSync(home);
  fs.mkdirSync(capsDirectory);
  fs.writeFileSync(
    path.join(home, ".claude.json"),
    JSON.stringify({
      mcpServers: {
        "refresh-fixture": {
          command: "node",
          args: ["--version"],
        },
      },
    }),
  );

  const store = new CapsStore({
    databasePath,
    stateDirectory: capsDirectory,
  });
  const now = new Date().toISOString();
  const baseCapability = {
    source_url: null,
    description: null,
    stars: null,
    install_command: null,
    source_lane: "census",
    producer_surface: "cowork",
    capture_class: "reported",
    observed_at: now,
    last_verified: now,
    stale_at: new Date(Date.now() + 86_400_000).toISOString(),
    curated_notes: "",
    provenance_json: "{}",
    raw_json: "{}",
  };
  store.upsertCapability("installed_working", {
    ...baseCapability,
    id: "caps.test.1",
    kind: "server",
    name: "Paid Test Server",
    slug: "paid-test",
    surface_owner: "claude",
    transport: "stdio",
    pricing: "paid",
    official: 0,
    tools_json: "[]",
    detail_json: "{}",
  });
  store.upsertCapability("installed_working", {
    ...baseCapability,
    id: "caps.test.2",
    kind: "server",
    name: "Free Test Server",
    slug: "free-test",
    surface_owner: "claude",
    transport: "stdio",
    pricing: "free",
    official: 0,
    tools_json: "[]",
    detail_json: "{}",
  });
  store.close();

  const connections = [];
  const connect = async (label, lane, clientName) => {
    const configuredAgent = lane === "codex"
      ? "codex"
      : lane === "antigravity"
        ? "google_antigravity"
        : "claude";
    const childEnvironment = {
      ...process.env,
      BRIDGE_AGENT: configuredAgent,
      BRIDGE_SESSION: `caps-test:${label}:${Date.now()}`,
      BRIDGE_HOME: home,
      BRIDGE2_HOME: home,
      BRIDGE_CAPS_STATE_DIR: capsDirectory,
      HOME: home,
      USERPROFILE: home,
    };
    if (lane) {
      childEnvironment.BRIDGE_LANE = lane;
    } else {
      delete childEnvironment.BRIDGE_LANE;
    }
    const transport = new StdioClientTransport({
      command: "node",
      args: [SERVER],
      env: childEnvironment,
    });
    const client = new Client({ name: clientName, version: "0.0.0" });
    await client.connect(transport);
    const connection = { client, transport, closed: false };
    connections.push(connection);
    return connection;
  };

  try {
    const cowork = await connect(
      "cowork",
      "claude_desktop_cowork",
      "claude-cowork",
    );
    const listed = await cowork.client.listTools();
    const toolNames = listed.tools.map((tool) => tool.name);

    await t.test("registers exactly four caps tools", () => {
      assert.deepStrictEqual(
        toolNames.filter((name) => name.startsWith("caps_")).sort(),
        ["caps_get", "caps_refresh", "caps_report", "caps_search"],
      );
    });

    await t.test("retains every pre-existing Bridge tool", () => {
      for (const name of EXISTING_BRIDGE_TOOLS) {
        assert.ok(toolNames.includes(name), `${name} remains registered`);
      }
    });

    await t.test("caps_search keeps free before paid", async () => {
      const response = await cowork.client.callTool({
        name: "caps_search",
        arguments: { query: "Test" },
      });
      const hits = JSON.parse(response.content[0].text);
      assert.strictEqual(hits.length, 2);
      assert.strictEqual(hits[0].pricing, "free");
      assert.strictEqual(hits[1].pricing, "paid");
      assert.strictEqual(typeof hits[0].recipe.is_callable, "boolean");
    });

    await t.test("caps_get returns a sanitized row and bounds its id", async () => {
      const response = await cowork.client.callTool({
        name: "caps_get",
        arguments: { id: "caps.test.2" },
      });
      const row = JSON.parse(response.content[0].text);
      assert.strictEqual(row.slug, "free-test");
      assert.strictEqual(row.table_origin, "installed_working");
      assert.strictEqual(
        await callIsRejected(cowork.client, {
          name: "caps_get",
          arguments: { id: "' OR 1=1 --" },
        }),
        true,
      );
    });

    await t.test("caps_report derives Cowork attribution", async () => {
      const roster = {
        schema: "bridge-caps-roster-v1",
        report_id: "report-123",
        observed_at: new Date().toISOString(),
        complete: true,
        capabilities: [{
          kind: "tool",
          name: "test_tool",
          slug: "test-tool",
          transport: "stdio",
          description: "A test tool",
          pricing: "free",
          official: 0,
          tools_json: "[]",
          detail_json: "{}",
        }],
        failures: [],
      };
      const response = await cowork.client.callTool({
        name: "caps_report",
        arguments: { roster },
      });
      const result = JSON.parse(response.content[0].text);
      assert.strictEqual(result.working, 1);
      const rows = databaseRows(databasePath, "installed_working");
      const row = rows.find((candidate) => candidate.slug === "test-tool");
      assert.ok(row);
      assert.strictEqual(row.producer_surface, "cowork");
      assert.strictEqual(row.capture_class, "best-effort");
    });

    await t.test("rejects caller-supplied surface identity", async () => {
      const rejected = await callIsRejected(cowork.client, {
        name: "caps_report",
        arguments: {
          roster: {
            schema: "bridge-caps-roster-v1",
            report_id: "spoofed-report",
            observed_at: new Date().toISOString(),
            complete: false,
            capabilities: [],
            failures: [],
            surface_owner: "codex",
          },
        },
      });
      assert.strictEqual(rejected, true);
    });

    await t.test("bridge_sync without a roster changes no capability facts", async () => {
      const before = capabilitySnapshot(databasePath);
      const response = await cowork.client.callTool({
        name: "bridge_sync",
        arguments: { project: home },
      });
      const result = JSON.parse(response.content[0].text);
      assert.deepStrictEqual(result.capsCensus, {
        schema_version: "bridge-caps-roster-v1",
        due: false,
        last_report_at: result.capsCensus.last_report_at,
      });
      assert.strictEqual(typeof result.capsCensus.last_report_at, "string");
      assert.strictEqual(capabilitySnapshot(databasePath), before);
    });

    await t.test("bridge_sync piggyback returns its durable receipt", async () => {
      const roster = {
        schema: "bridge-caps-roster-v1",
        report_id: "report-124",
        observed_at: new Date().toISOString(),
        complete: false,
        capabilities: [],
        failures: [],
      };
      const response = await cowork.client.callTool({
        name: "bridge_sync",
        arguments: { project: home, capsRoster: roster },
      });
      const result = JSON.parse(response.content[0].text);
      assert.strictEqual(result.capsCensus.due, false);
      assert.strictEqual(result.capsCensus.receipt.report_id, "report-124");
      assert.match(
        result.capsCensus.receipt.canonical_hash,
        /^[a-f0-9]{64}$/u,
      );
      const database = new DatabaseSync(databasePath);
      try {
        const receipt = database.prepare(
          "SELECT report_id FROM _caps_census_receipts WHERE report_id = ?",
        ).get("report-124");
        assert.strictEqual(receipt.report_id, "report-124");
      } finally {
        database.close();
      }
    });

    await t.test("bridge_sync rejects an invalid roster instead of swallowing it", async () => {
      const rejected = await callIsRejected(cowork.client, {
        name: "bridge_sync",
        arguments: {
          project: home,
          capsRoster: {
            schema: "bridge-caps-roster-v1",
            report_id: "report-125",
            observed_at: new Date().toISOString(),
            complete: false,
            capabilities: [],
            failures: [],
            surface_owner: "codex",
          },
        },
      });
      assert.strictEqual(rejected, true);
      const database = new DatabaseSync(databasePath);
      try {
        assert.strictEqual(
          database.prepare(
            "SELECT count(*) AS count FROM _caps_census_receipts WHERE report_id = ?",
          ).get("report-125").count,
          0,
        );
      } finally {
        database.close();
      }
    });

    await t.test("non-Code refresh is inert and returns an exact A2A request", async () => {
      const before = capabilitySnapshot(databasePath);
      const response = await cowork.client.callTool({
        name: "caps_refresh",
        arguments: { lane: "config-crawl" },
      });
      const result = JSON.parse(response.content[0].text);
      assert.strictEqual(result.code, "requires_code_orchestrator");
      assert.strictEqual(result.requires_code_orchestrator, true);
      assert.strictEqual(result.mutated, false);
      assert.strictEqual(
        result.a2a_request_template.tool,
        "bridge_a2a_send",
      );
      assert.deepStrictEqual(
        Object.keys(result.a2a_request_template.arguments).sort(),
        ["prompt", "target"],
      );
      assert.strictEqual(
        result.a2a_request_template.arguments.target,
        "claude",
      );
      assert.ok(
        result.a2a_request_template.arguments.prompt.includes(
          '{"lane":"config-crawl"}',
        ),
      );
      assert.strictEqual(capabilitySnapshot(databasePath), before);
    });

    await t.test("an existing Bridge tool still round-trips", async () => {
      const response = await cowork.client.callTool({
        name: "bridge_list_projects",
        arguments: {},
      });
      const result = JSON.parse(response.content[0].text);
      assert.ok(Array.isArray(result.projects));
    });
    await closeConnection(cowork);

    await t.test("registered lane and MCP client name must agree", () => {
      assert.throws(
        () => deriveTrustedCapsContext({
          principal: "claude",
          session: "test-session",
          host: "test-host",
          lane: "claude_desktop_code",
          lane_ambiguous: false,
          lane_configured: true,
          client_name: "claude-cowork",
        }),
        /caller_context_mismatch/u,
      );
    });

    await t.test("Codex and Antigravity retain distinct census provenance", () => {
      const cases = [
        {
          principal: "codex",
          lane: "codex",
          clientName: "codex",
          expectedProducer: "codex",
          expectedOwner: "codex",
        },
        {
          principal: "google_antigravity",
          lane: "antigravity",
          clientName: "agy",
          expectedProducer: "antigravity",
          expectedOwner: "agy",
        },
      ];
      for (const item of cases) {
        const context = deriveTrustedCapsContext({
          principal: item.principal,
          session: "test-session",
          host: "test-host",
          lane: item.lane,
          lane_ambiguous: false,
          lane_configured: true,
          client_name: item.clientName,
        });
        const attribution = mapTrustedContext(context);
        assert.strictEqual(
          attribution.producer_surface,
          item.expectedProducer,
        );
        assert.strictEqual(
          attribution.surface_owner,
          item.expectedOwner,
        );
      }
    });

    await t.test("ambiguous and falsely CLI-like clients gain no authority", () => {
      const base = {
        principal: "claude",
        session: "test-session",
        host: "test-host",
        lane: "claude_desktop_code",
        client_name: "generic-client",
      };
      assert.throws(
        () => deriveTrustedCapsContext({
          ...base,
          lane_ambiguous: true,
          lane_configured: false,
        }),
        /caller_lane_ambiguous/u,
      );
      assert.throws(
        () => deriveTrustedCapsContext({
          ...base,
          lane_ambiguous: false,
          lane_configured: false,
        }),
        /caller_client_identity_unrecognized/u,
      );
    });

    await t.test("Code refresh performs a real bounded local crawl", async () => {
      const context = deriveTrustedCapsContext({
        principal: "claude",
        session: "test-session",
        host: "test-host",
        lane: "claude_desktop_code",
        lane_ambiguous: false,
        lane_configured: true,
        client_name: "claude-code",
      });
      const runtime = new CapsMcpRuntime({
        config: {
          databasePath,
          stateDirectory: capsDirectory,
        },
        crawl_home: home,
      });
      try {
        const result = await runtime.refresh("config-crawl", context);
        assert.strictEqual(result.schema, "bridge-caps-refresh-v1");
        assert.strictEqual(result.lane, "config-crawl");
        assert.strictEqual(result.mutated, true);
        assert.ok(result.reports["config-crawl"].observation_count >= 1);
        const row = databaseRows(databasePath, "installed_broken")
          .find((candidate) => candidate.slug === "claude-refresh-fixture");
        assert.ok(row, "Code crawl persisted the configured server");
        assert.strictEqual(row.producer_surface, "code");
        assert.strictEqual(row.capture_class, "guaranteed");
        assert.strictEqual(row.source_lane, "config-crawl");
      } finally {
        runtime.close();
      }
    });
  } finally {
    for (const connection of connections.reverse()) {
      await closeConnection(connection);
    }
    fs.rmSync(tmpBase, { recursive: true, force: true });
  }
});
