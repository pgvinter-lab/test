import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

import {
  capsGet,
  capsSearch,
} from "../../dist/caps/search.js";
import { CapsService } from "../../dist/caps/service.js";
import { CapsStore } from "../../dist/caps/store.js";

const FUTURE = "2099-01-01T00:00:00.000Z";
const OBSERVED = "2026-07-24T00:00:00.000Z";

const CODE_CONTEXT = Object.freeze({
  principal: "principal.code",
  session: "session.code",
  host: "host.code",
  canonical_lane: "code",
  client_name: "claude-code",
});
const CODEX_CONTEXT = Object.freeze({
  principal: "principal.codex",
  session: "session.codex",
  host: "host.codex",
  canonical_lane: "codex",
  client_name: "codex",
});
const AGY_CONTEXT = Object.freeze({
  principal: "principal.agy",
  session: "session.agy",
  host: "host.agy",
  canonical_lane: "antigravity",
  client_name: "agy",
});

function makeStore(t) {
  const directory = fs.mkdtempSync(
    path.join(os.tmpdir(), "bridge-caps-search-"),
  );
  const config = {
    databasePath: path.join(directory, "caps.sqlite"),
    stateDirectory: directory,
  };
  const store = new CapsStore(config);
  t.after(() => {
    try {
      store.close();
    } catch {
      // The test already closed it.
    }
    fs.rmSync(directory, { recursive: true, force: true });
  });
  return store;
}

function capability(id, overrides = {}) {
  return {
    id,
    kind: "tool",
    name: id,
    slug: id.replace(/[^A-Za-z0-9._-]/g, "-"),
    source_url: `https://example.invalid/${id}`,
    surface_owner: "claude",
    transport: "hosted",
    description: "search target",
    pricing: "free",
    official: 0,
    stars: 0,
    install_command: null,
    source_lane: "census",
    producer_surface: "code",
    capture_class: "guaranteed",
    observed_at: OBSERVED,
    last_verified: OBSERVED,
    stale_at: FUTURE,
    curated_notes: null,
    tools_json: null,
    detail_json: null,
    provenance_json: '{"source":"test"}',
    raw_json: null,
    ...overrides,
  };
}

function insert(store, table, id, overrides = {}) {
  store.upsertCapability(table, capability(id, overrides));
}

test("pricing tiers are immutable before relevance or status", (t) => {
  const store = makeStore(t);
  insert(store, "available_for_install", "free-weak", {
    pricing: "free",
    name: "weak",
    description: "target",
    capture_class: "best-effort",
  });
  insert(store, "installed_working", "unknown-mid", {
    pricing: "unknown",
    name: "target middle",
  });
  insert(store, "installed_working", "paid-perfect", {
    pricing: "paid",
    name: "target",
    official: 1,
    stars: 999_999,
  });
  store.searchIndex.rebuildIndex();

  assert.deepEqual(
    capsSearch(store, "target", undefined, CODE_CONTEXT)
      .map((hit) => hit.id),
    ["free-weak", "unknown-mid", "paid-perfect"],
  );
});

test("runtime options and identifiers fail closed without SQL widening", async (t) => {
  const store = makeStore(t);
  insert(store, "installed_working", "safe");
  store.searchIndex.rebuildIndex();

  for (const options of [
    { includePaidFirst: true },
    { caller_surface: "claude" },
    { table_origin: "installed_working; DROP TABLE installed_working;--" },
    { kind: "provider" },
    { surface_owner: "attacker" },
    { limit: 0 },
    { limit: 51 },
    { limit: 1.5 },
    null,
  ]) {
    assert.throws(
      () => capsSearch(store, "", options, CODE_CONTEXT),
      /caps_search_/,
    );
  }
  assert.throws(
    () => capsSearch(store, { query: "safe" }, undefined, CODE_CONTEXT),
    /caps_search_query_invalid/,
  );
  assert.throws(
    () => capsSearch(store, "safe", undefined, {
      ...CODEX_CONTEXT,
      source_surface: "claude",
    }),
    /unauthorized_source_surface/,
  );
  await assert.rejects(
    capsGet(store, "../caps.sqlite", CODE_CONTEXT),
    /caps_get_id_invalid/,
  );
  assert.equal(
    store.db.prepare(
      "SELECT count(*) AS count FROM installed_working",
    ).get().count,
    1,
  );
});

test("within-tier ordering is status then relevance/capture/official/stars/name/id", (t) => {
  const store = makeStore(t);
  insert(store, "installed_working", "working-guaranteed", {
    capture_class: "guaranteed",
    official: 0,
    stars: 0,
  });
  insert(store, "installed_working", "working-observed", {
    capture_class: "observed",
    official: 1,
    stars: 100,
  });
  insert(store, "installed_working", "working-best", {
    capture_class: "best-effort",
    official: 1,
    stars: 10_000,
  });
  insert(store, "installed_broken", "broken-guaranteed", {
    capture_class: "guaranteed",
    official: 1,
    stars: 10_000,
    failure_reason: "offline",
    failure_observed_at: OBSERVED,
  });
  insert(store, "available_for_install", "available-guaranteed", {
    capture_class: "guaranteed",
    official: 1,
    stars: 10_000,
  });

  assert.deepEqual(
    capsSearch(store, "", { kind: "tool" }, CODEX_CONTEXT)
      .map((hit) => hit.id),
    [
      "working-guaranteed",
      "working-observed",
      "working-best",
      "broken-guaranteed",
      "available-guaranteed",
    ],
  );
});

test("search count, descriptions, and serialized payload are compact", (t) => {
  const store = makeStore(t);
  for (let index = 0; index < 70; index += 1) {
    insert(store, "installed_working", `bounded-${String(index).padStart(2, "0")}`, {
      description: `${"x".repeat(2_000)}\nsecond line`,
    });
  }
  const hits = capsSearch(store, "", { limit: 50 }, CODEX_CONTEXT);
  assert.equal(hits.length, 50);
  assert.ok(
    Buffer.byteLength(JSON.stringify(hits), "utf8") <= 64 * 1024,
  );
  assert.ok(hits.every((hit) =>
    Buffer.byteLength(hit.description, "utf8") <= 512
    && !/[\r\n]/.test(hit.description)));
});

test("FTS path is table-bound and LIKE fallback escapes wildcards", (t) => {
  const store = makeStore(t);
  insert(store, "installed_working", "fts-hit", {
    name: "Needle service",
  });
  insert(store, "installed_working", "literal-hit", {
    name: "literal 100%_ match",
  });
  insert(store, "installed_working", "wildcard-decoy", {
    name: "literal 100XX match",
  });
  insert(store, "installed_working", "raw-only", {
    name: "ordinary",
    description: "ordinary",
    raw_json: '{"hidden":"rawsecretmarker"}',
  });
  store.searchIndex.rebuildIndex();
  assert.deepEqual(
    capsSearch(store, "needle", undefined, CODEX_CONTEXT)
      .map((hit) => hit.id),
    ["fts-hit"],
  );

  store.db.exec("DROP TABLE caps_search_fts");
  assert.deepEqual(
    capsSearch(store, "100%_", undefined, CODEX_CONTEXT)
      .map((hit) => hit.id),
    ["literal-hit"],
  );
  assert.deepEqual(
    capsSearch(store, "rawsecretmarker", undefined, CODEX_CONTEXT),
    [],
  );
});

test("native ownership is trusted, exact, and tool-specific", (t) => {
  const store = makeStore(t);
  insert(store, "installed_working", "native-tool", {
    name: "bridge.exact_tool",
    surface_owner: "claude",
  });
  insert(store, "installed_working", "single-server", {
    kind: "server",
    surface_owner: "claude",
    tools_json: '[{"name":"server.only_tool"}]',
  });
  insert(store, "installed_working", "multi-server", {
    kind: "server",
    surface_owner: "claude",
    tools_json: '[{"name":"one"},{"name":"two"}]',
  });
  const hits = capsSearch(store, "", undefined, CODE_CONTEXT);
  assert.equal(
    hits.find((hit) => hit.id === "native-tool").recipe.exact_tool_name,
    "bridge.exact_tool",
  );
  assert.equal(
    hits.find((hit) => hit.id === "single-server").recipe.exact_tool_name,
    "server.only_tool",
  );
  assert.equal(
    hits.find((hit) => hit.id === "multi-server").recipe.type,
    "diagnostic-unverified",
  );
  assert.equal(
    capsSearch(store, "", { surface_owner: "claude" }, CODEX_CONTEXT)[0]
      .recipe.type,
    "a2a-claude",
  );
});

test("AGY mailbox and Claude/Codex A2A recipes are exact inert templates", (t) => {
  const store = makeStore(t);
  insert(store, "installed_working", "agy-tool", {
    surface_owner: "agy",
  });
  insert(store, "installed_working", "claude-tool", {
    surface_owner: "claude",
  });
  insert(store, "installed_working", "codex-tool", {
    surface_owner: "codex",
  });

  const byId = new Map(
    capsSearch(store, "", undefined, AGY_CONTEXT)
      .map((hit) => [hit.id, hit]),
  );
  assert.deepEqual(byId.get("claude-tool").recipe.template, {
    tool: "bridge_a2a_send",
    arguments: {
      target: "claude",
      prompt: "<owner-approved task>",
    },
  });
  assert.deepEqual(byId.get("codex-tool").recipe.template, {
    tool: "bridge_a2a_send",
    arguments: {
      target: "codex",
      prompt: "<owner-approved task>",
    },
  });
  const agyFromCodex = capsSearch(
    store,
    "",
    { surface_owner: "agy" },
    CODEX_CONTEXT,
  )[0];
  assert.deepEqual(agyFromCodex.recipe.template, {
    tool: "bridge_mailbox_send",
    arguments: {
      provider: "antigravity",
      prompt: "<owner-approved task>",
    },
  });
  assert.doesNotMatch(JSON.stringify(byId), /provider.*claude|provider.*codex/);
});

test("ClickUp fails closed off-surface and Gemini stays retired even on-surface", (t) => {
  const store = makeStore(t);
  insert(store, "installed_working", "clickup-tool", {
    surface_owner: "clickup-hosted",
    name: "clickup.exact",
  });
  insert(store, "installed_working", "gemini-tool", {
    surface_owner: "gemini",
    name: "gemini.exact",
  });
  assert.equal(
    capsSearch(store, "", { surface_owner: "clickup-hosted" }, CODE_CONTEXT)[0]
      .recipe.type,
    "unavailable-clickup",
  );
  assert.equal(
    capsSearch(
      store,
      "",
      { surface_owner: "clickup-hosted" },
      { ...CODE_CONTEXT, source_surface: "clickup-hosted" },
    )[0].recipe.type,
    "native",
  );
  assert.equal(
    capsSearch(
      store,
      "",
      { surface_owner: "gemini" },
      { ...CODE_CONTEXT, source_surface: "gemini" },
    )[0].recipe.type,
    "unavailable-gemini",
  );
});

test("available, broken, stale, and invalid evidence never claim callable", (t) => {
  const store = makeStore(t);
  insert(store, "available_for_install", "available", {
    install_command: "npx safe-package",
    pricing: "unknown",
  });
  insert(store, "installed_broken", "broken", {
    failure_reason: "probe_timeout",
    failure_observed_at: OBSERVED,
  });
  insert(store, "installed_working", "stale", {
    stale_at: "2026-07-24T00:00:00.000Z",
  });
  insert(store, "installed_working", "invalid-evidence", {
    last_verified: "not-a-date",
  });
  const byId = new Map(
    capsSearch(store, "", undefined, CODEX_CONTEXT)
      .map((hit) => [hit.id, hit]),
  );
  assert.equal(byId.get("available").recipe.type, "available-install");
  assert.equal(
    byId.get("available").recipe.requires_owner_confirmation,
    true,
  );
  assert.equal(byId.get("broken").recipe.type, "diagnostic-broken");
  assert.equal(byId.get("stale").recipe.type, "diagnostic-stale");
  assert.equal(
    byId.get("invalid-evidence").recipe.type,
    "diagnostic-stale",
  );
  assert.ok([...byId.values()].every((hit) =>
    !["available", "broken", "stale", "invalid-evidence"].includes(hit.id)
    || hit.recipe.is_callable === false));
});

test("caps_get returns a bounded sanitized full row without mutating owner data", async (t) => {
  const store = makeStore(t);
  insert(store, "installed_working", "full-row", {
    curated_notes: "api_key=supersecretvalue",
    tools_json:
      '[{"name":"safe","api_key":"sk-abcdefghijklmnop"}]',
    detail_json:
      '{"authorization":"Bearer abcdefghijklmnop","nested":{"ok":true}}',
    provenance_json:
      '{"cookie":"session=supersecret","source":"test"}',
    raw_json: '{"password":"hunter12345"}',
  });
  const before = store.db.prepare(
    "SELECT curated_notes FROM installed_working WHERE id = ?",
  ).get("full-row").curated_notes;
  const row = await capsGet(store, "full-row", CODE_CONTEXT);
  assert.equal(row.table_origin, "installed_working");
  assert.equal(row.curated_notes, "[REDACTED]");
  assert.equal(row.tools_json[0].api_key, "[REDACTED]");
  assert.equal(row.detail_json.authorization, "[REDACTED]");
  assert.equal(row.provenance_json.cookie, "[REDACTED]");
  assert.equal(row.raw_json.password, "[REDACTED]");
  assert.equal(
    store.db.prepare(
      "SELECT curated_notes FROM installed_working WHERE id = ?",
    ).get("full-row").curated_notes,
    before,
  );
});

test("caps_get lazy enrichment is offline-injectable and preserves last-good on failure", async (t) => {
  const store = makeStore(t);
  insert(store, "available_for_install", "public-success", {
    source_url: "https://mcpservers.org/servers/public-success",
    source_lane: "mcpservers-sitemap",
    producer_surface: "external-index",
  });
  insert(store, "available_for_install", "public-failure", {
    source_url: "https://mcpservers.org/servers/public-failure",
    source_lane: "mcpservers-sitemap",
    producer_surface: "external-index",
  });
  const successRow = store.db.prepare(
    "SELECT * FROM available_for_install WHERE id = ?",
  ).get("public-success");
  const called = [];
  const success = await capsGet(
    store,
    "public-success",
    CODE_CONTEXT,
    {
      async enrichDetail(id, signal) {
        called.push({ id, aborted: signal.aborted });
        return {
          ...successRow,
          detail_json: '{"description":"fresh"}',
        };
      },
    },
  );
  assert.deepEqual(called, [{ id: "public-success", aborted: false }]);
  assert.equal(success.detail_json.description, "fresh");

  const failure = await capsGet(
    store,
    "public-failure",
    CODE_CONTEXT,
    {
      async enrichDetail() {
        throw new Error("offline fixture failure");
      },
    },
  );
  assert.equal(failure.id, "public-failure");
  assert.equal(failure.detail_json, null);
});

test("CapsService exposes synchronous compact search and sanitized async get", async (t) => {
  const store = makeStore(t);
  insert(store, "installed_working", "service-tool");
  store.searchIndex.rebuildIndex();
  const service = new CapsService(store);
  const hits = service.search("service", { limit: 1 }, CODEX_CONTEXT);
  assert.equal(Array.isArray(hits), true);
  assert.equal(hits[0].id, "service-tool");
  assert.equal((await service.get("service-tool", CODEX_CONTEXT)).id, "service-tool");
});
