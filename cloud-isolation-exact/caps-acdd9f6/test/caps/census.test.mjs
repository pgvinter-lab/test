import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

import { CapsStore } from "../../dist/caps/store.js";
import {
  mapTrustedContext,
  processCensusReport,
  validateRoster,
} from "../../dist/caps/census.js";
import { CapsService } from "../../dist/caps/service.js";

const fixture = JSON.parse(
  fs.readFileSync(
    new URL("../fixtures/caps/census-roster.json", import.meta.url),
    "utf8",
  ),
);

let sequence = 0;

function observed(offsetMs = 0) {
  return new Date(Date.now() - 60_000 + offsetMs).toISOString();
}

function codeContext(overrides = {}) {
  return {
    principal: "principal.code",
    session: "session.code",
    host: "host.local",
    canonical_lane: "code",
    client_name: "claude-code",
    ...overrides,
  };
}

function coworkContext(overrides = {}) {
  return {
    principal: "principal.cowork",
    session: "session.cowork",
    host: "host.local",
    canonical_lane: "cowork",
    client_name: "claude-cowork",
    ...overrides,
  };
}

function codexContext(overrides = {}) {
  return {
    principal: "principal.codex",
    session: "session.codex",
    host: "host.local",
    canonical_lane: "codex",
    client_name: "codex",
    ...overrides,
  };
}

function agyContext(overrides = {}) {
  return {
    principal: "principal.agy",
    session: "session.agy",
    host: "host.local",
    canonical_lane: "antigravity",
    client_name: "agy",
    ...overrides,
  };
}

function capability(overrides = {}) {
  return {
    kind: "tool",
    name: "Echo",
    slug: "echo",
    transport: "stdio",
    description: "Echoes bounded text",
    pricing: "free",
    official: 1,
    tools_json: JSON.stringify([
      {
        name: "echo",
        description: "Echo text",
        inputSchema: {
          type: "object",
          properties: { text: { type: "string" } },
        },
      },
    ]),
    detail_json: JSON.stringify({ version: "1.0.0" }),
    command: "echo-tool",
    last_call_json: JSON.stringify({ ok: true }),
    ...overrides,
  };
}

function roster(overrides = {}) {
  sequence += 1;
  return {
    schema: "bridge-caps-roster-v1",
    report_id: `report-${sequence}`,
    observed_at: observed(),
    complete: false,
    capabilities: [capability()],
    failures: [],
    ...overrides,
  };
}

function failureReport(slug = "echo", overrides = {}) {
  return roster({
    capabilities: [],
    failures: [{
      slug,
      command: `${slug}-tool`,
      failure_reason: "timeout",
      failure_class: "transport.timeout",
    }],
    ...overrides,
  });
}

function makeStore(t) {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), "caps-census-"));
  const config = {
    stateDirectory: directory,
    databasePath: path.join(directory, "caps.sqlite"),
  };
  const store = new CapsStore(config);
  t.after(() => {
    try {
      store.close();
    } catch {
      // A restart test may close the first handle itself.
    }
    fs.rmSync(directory, { recursive: true, force: true });
  });
  return { store, config };
}

function seed(store, table, overrides = {}) {
  const slug = overrides.slug ?? `seed-${++sequence}`;
  const data = {
    id: overrides.id ?? `seed.${slug}.${sequence}`,
    kind: "tool",
    name: overrides.name ?? slug,
    slug,
    source_url: "https://example.invalid/public",
    surface_owner: "claude",
    transport: "stdio",
    description: "public description",
    pricing: "free",
    official: 0,
    stars: 7,
    install_command: `${slug}-tool`,
    source_lane: "probe",
    producer_surface: "code",
    capture_class: "guaranteed",
    observed_at: observed(-10_000),
    last_verified: observed(-10_000),
    stale_at: observed(86_400_000),
    curated_notes: "preserve this note",
    tools_json: JSON.stringify([]),
    detail_json: JSON.stringify({ public: true }),
    provenance_json: JSON.stringify({ public_index: { source: "seed" } }),
    raw_json: null,
    ...(table === "installed_broken"
      ? {
          failure_reason: "old.failure",
          failure_observed_at: observed(-10_000),
        }
      : {}),
    ...overrides,
  };
  store.upsertCapability(table, data);
  return data;
}

function expectCode(fn, code) {
  assert.throws(fn, (error) => error instanceof Error && error.message === code);
}

test("fixture contains representative closed-schema reports", () => {
  assert.equal(validateRoster(fixture.valid_code_complete).schema, "bridge-caps-roster-v1");
  assert.equal(validateRoster(fixture.valid_cowork_incremental).complete, false);
  expectCode(
    () => validateRoster(fixture.invalid_secret_tools_json),
    "credential_leak_rejected",
  );
});

test("roster schema is closed at the report and row levels", () => {
  expectCode(() => validateRoster({ ...roster(), source_surface: "agy" }), "unknown_field_in_roster");
  const badCapability = roster();
  badCapability.capabilities[0].surface_owner = "agy";
  expectCode(() => validateRoster(badCapability), "unknown_field_in_capability");
  const badFailure = failureReport();
  badFailure.failures[0].principal = "spoof";
  expectCode(() => validateRoster(badFailure), "unknown_field_in_failure");
});

test("schema, report ID, UTC timestamp, and future bounds are enforced", () => {
  expectCode(() => validateRoster({ ...roster(), schema: "v2" }), "invalid_schema");
  expectCode(() => validateRoster({ ...roster(), report_id: "bad id" }), "invalid_report_id");
  expectCode(() => validateRoster({ ...roster(), observed_at: "2026-07-24" }), "invalid_observed_at");
  expectCode(
    () => validateRoster({ ...roster(), observed_at: new Date(Date.now() + 600_000).toISOString() }),
    "invalid_observed_at",
  );
});

test("report and row count bounds are enforced", () => {
  expectCode(
    () => validateRoster({ ...roster(), capabilities: Array(501).fill(capability()) }),
    "invalid_capabilities",
  );
  expectCode(
    () => validateRoster({ ...roster(), capabilities: [], failures: Array(501).fill({ slug: "x", failure_reason: "timeout" }) }),
    "invalid_failures",
  );
  expectCode(
    () => validateRoster({ ...roster(), capabilities: [], padding: "x".repeat(1_100_000) }),
    "report_too_large",
  );
});

test("capability enums, strings, detail objects, and command bounds are enforced", () => {
  for (const [field, value, code] of [
    ["kind", "plugin", "invalid_kind"],
    ["transport", "socket", "invalid_transport"],
    ["pricing", "premium", "invalid_pricing"],
    ["official", true, "invalid_official"],
    ["slug", "not valid", "invalid_slug"],
  ]) {
    expectCode(
      () => validateRoster(roster({ capabilities: [capability({ [field]: value })] })),
      code,
    );
  }
  expectCode(
    () => validateRoster(roster({ capabilities: [capability({ description: "x".repeat(8_193) })] })),
    "invalid_description",
  );
  expectCode(
    () => validateRoster(roster({ capabilities: [capability({ command: "x\nwhoami" })] })),
    "invalid_command",
  );
  expectCode(
    () => validateRoster(roster({ capabilities: [capability({ detail_json: "[]" })] })),
    "invalid_detail_json",
  );
  expectCode(
    () => validateRoster(roster({ capabilities: [capability({ last_call_json: "\"ok\"" })] })),
    "invalid_last_call_json",
  );
});

test("malformed JSON maps to stable validation errors", () => {
  expectCode(
    () => validateRoster(roster({ capabilities: [capability({ tools_json: "{" })] })),
    "invalid_tools_json",
  );
  expectCode(
    () => validateRoster(roster({ capabilities: [capability({ detail_json: "{" })] })),
    "invalid_detail_json",
  );
});

test("tool arrays, counts, and object shape are enforced", () => {
  expectCode(
    () => validateRoster(roster({ capabilities: [capability({ tools_json: "{}" })] })),
    "invalid_tools_json",
  );
  expectCode(
    () => validateRoster(roster({ capabilities: [capability({ tools_json: JSON.stringify(Array(1_001).fill({ name: "x", inputSchema: {} })) })] })),
    "invalid_tools_json",
  );
  expectCode(
    () => validateRoster(roster({ capabilities: [capability({ tools_json: JSON.stringify(["x"]) })] })),
    "invalid_tool",
  );
  expectCode(
    () => validateRoster(roster({ capabilities: [capability({ tools_json: JSON.stringify([{ name: "x" }]) })] })),
    "invalid_tool_schema",
  );
});

test("per-schema and aggregate schema byte bounds are enforced", () => {
  const properties = Object.fromEntries(
    Array.from({ length: 4_000 }, (_, index) => [`field${index}`, { type: "string" }]),
  );
  const oneHuge = [{ name: "huge", inputSchema: { type: "object", properties } }];
  expectCode(
    () => validateRoster(roster({ capabilities: [capability({ tools_json: JSON.stringify(oneHuge) })] })),
    "schema_too_large",
  );
  const aggregateProperties = Object.fromEntries(
    Array.from({ length: 1_800 }, (_, index) => [`field${index}`, { type: "string" }]),
  );
  const aggregate = Array.from({ length: 5 }, (_, index) => ({
    name: `tool-${index}`,
    inputSchema: { type: "object", properties: aggregateProperties },
  }));
  expectCode(
    () => validateRoster(roster({ capabilities: [capability({ tools_json: JSON.stringify(aggregate) })] })),
    "schemas_too_large",
  );
});

test("nested JSON depth and prototype keys are rejected", () => {
  let deep = "leaf";
  for (let index = 0; index < 50; index += 1) deep = { nested: deep };
  expectCode(
    () => validateRoster(roster({ capabilities: [capability({ detail_json: JSON.stringify(deep) })] })),
    "json_too_deep",
  );
  const prototypeJson = '{"__proto__":{"polluted":true}}';
  expectCode(
    () => validateRoster(roster({ capabilities: [capability({ detail_json: prototypeJson })] })),
    "prototype_key_rejected",
  );
});

test("credential-shaped evidence is rejected before hashing or storage", () => {
  for (const secret of [
    "Bearer abcdefghijklmnop",
    "AKIA1234567890ABCDEF",
    "token=supersecret123",
    "ghp_abcdefghijklmnopqrstuvwxyz",
    "xoxb-1234567890123456",
  ]) {
    expectCode(
      () => validateRoster(roster({ capabilities: [capability({ description: secret })] })),
      "credential_leak_rejected",
    );
  }
  expectCode(
    () => validateRoster(failureReport("echo", {
      failures: [{ slug: "echo", failure_reason: "token=supersecret123" }],
    })),
    "credential_leak_rejected",
  );
});

test("secret defaults inside schemas are redacted deterministically", () => {
  const input = roster({
    capabilities: [capability({
      tools_json: JSON.stringify([{
        name: "secure",
        inputSchema: {
          type: "object",
          properties: {
            apiKey: { type: "string", default: "sk_abcdefghijklmnop" },
          },
        },
      }]),
    })],
  });
  const parsed = validateRoster(input);
  assert.match(parsed.capabilities[0].tools_json, /\[REDACTED\]/);
  assert.doesNotMatch(parsed.capabilities[0].tools_json, /abcdefghijklmnop/);
});

test("credential-named scalar fields are redacted even without recognizable token syntax", () => {
  const input = roster({
    capabilities: [capability({
      detail_json: JSON.stringify({
        apiKey: "plain-but-private",
        nested: { password: "short-secret" },
      }),
    })],
  });
  const parsed = validateRoster(input);
  assert.deepEqual(
    JSON.parse(parsed.capabilities[0].detail_json),
    {
      apiKey: "[REDACTED]",
      nested: { password: "[REDACTED]" },
    },
  );
});

test("duplicate and contradictory statuses fail closed", () => {
  expectCode(
    () => validateRoster(roster({ capabilities: [capability(), capability({ name: "Other" })] })),
    "duplicate_capability",
  );
  expectCode(
    () => validateRoster(failureReport("echo", {
      failures: [
        { slug: "echo", failure_reason: "timeout" },
        { slug: "echo", failure_reason: "offline" },
      ],
    })),
    "duplicate_failure",
  );
  expectCode(
    () => validateRoster(roster({
      failures: [{ slug: "echo", failure_reason: "timeout" }],
    })),
    "conflicting_capability_status",
  );
});

test("trusted Code context maps to Claude owner and guaranteed capture", () => {
  const mapped = mapTrustedContext(codeContext());
  assert.equal(mapped.surface_owner, "claude");
  assert.equal(mapped.producer_surface, "code");
  assert.equal(mapped.capture_class, "guaranteed");
  assert.match(mapped.evidence_scope, /^census:code:claude:/);
});

test("trusted Cowork context maps separately with best-effort capture", () => {
  const mapped = mapTrustedContext(coworkContext());
  assert.equal(mapped.surface_owner, "claude");
  assert.equal(mapped.producer_surface, "cowork");
  assert.equal(mapped.capture_class, "best-effort");
  assert.notEqual(mapped.evidence_scope, mapTrustedContext(codeContext()).evidence_scope);
});

test("trusted Codex and Antigravity contexts map to reported capture", () => {
  assert.deepEqual(
    {
      owner: mapTrustedContext(codexContext()).surface_owner,
      producer: mapTrustedContext(codexContext()).producer_surface,
      capture: mapTrustedContext(codexContext()).capture_class,
    },
    { owner: "codex", producer: "codex", capture: "reported" },
  );
  assert.deepEqual(
    {
      owner: mapTrustedContext(agyContext()).surface_owner,
      producer: mapTrustedContext(agyContext()).producer_surface,
      capture: mapTrustedContext(agyContext()).capture_class,
    },
    { owner: "agy", producer: "antigravity", capture: "reported" },
  );
});

test("caller lane and client must be an exact registered pair", () => {
  expectCode(
    () => mapTrustedContext(codeContext({ canonical_lane: "cowork" })),
    "caller_context_mismatch",
  );
  expectCode(
    () => mapTrustedContext(codeContext({ client_name: "unknown" })),
    "caller_context_mismatch",
  );
  expectCode(
    () => mapTrustedContext(codeContext({ principal: "" })),
    "invalid_principal",
  );
});

test("only Code may explicitly ingest another source surface", () => {
  const mapped = mapTrustedContext(codeContext({ source_surface: "agy" }));
  assert.equal(mapped.surface_owner, "agy");
  assert.equal(mapped.producer_surface, "code");
  assert.equal(mapped.capture_class, "guaranteed");
  const coworkTranscript = mapTrustedContext(
    codeContext({ source_surface: "cowork" }),
  );
  assert.equal(coworkTranscript.surface_owner, "claude");
  assert.equal(coworkTranscript.producer_surface, "code");
  assert.equal(coworkTranscript.capture_class, "best-effort");
  expectCode(
    () => mapTrustedContext(coworkContext({ source_surface: "agy" })),
    "unauthorized_source_surface",
  );
  expectCode(
    () => mapTrustedContext(codeContext({ source_surface: "unregistered" })),
    "unknown_source_surface",
  );
});

test("caller context rejects credential-shaped provenance", () => {
  expectCode(
    () => mapTrustedContext(codeContext({ session: "token=supersecret123" })),
    "credential_leak_rejected",
  );
});

test("same report and attribution replays the original result without mutation", (t) => {
  const { store } = makeStore(t);
  const input = roster({ complete: true });
  const first = processCensusReport(store, input, codeContext());
  const before = store.db.prepare("SELECT * FROM installed_working WHERE slug = 'echo'").get();
  const second = processCensusReport(store, structuredClone(input), codeContext());
  const after = store.db.prepare("SELECT * FROM installed_working WHERE slug = 'echo'").get();
  assert.equal(first.replayed, false);
  assert.equal(second.replayed, true);
  assert.deepEqual(
    { ...second, replayed: false },
    first,
  );
  assert.deepEqual(after, before);
});

test("canonical key and row order produce the same receipt hash", (t) => {
  const { store } = makeStore(t);
  const alpha = capability({ slug: "alpha", name: "Alpha" });
  const beta = capability({
    slug: "beta",
    name: "Beta",
    tools_json: JSON.stringify([
      { name: "zeta", inputSchema: { type: "object", properties: { b: {}, a: {} } } },
      { name: "alpha", inputSchema: { properties: {}, type: "object" } },
    ]),
  });
  const first = roster({ capabilities: [beta, alpha] });
  processCensusReport(store, first, codeContext());
  const reordered = structuredClone(first);
  reordered.capabilities.reverse();
  reordered.capabilities[0].tools_json = JSON.stringify(
    JSON.parse(reordered.capabilities[0].tools_json).reverse(),
  );
  assert.equal(processCensusReport(store, reordered, codeContext()).replayed, true);
});

test("same report ID with changed content, time, or tools fails closed", (t) => {
  const { store } = makeStore(t);
  const input = roster();
  processCensusReport(store, input, codeContext());
  for (const changed of [
    { ...structuredClone(input), observed_at: observed(-20_000) },
    { ...structuredClone(input), complete: !input.complete },
    {
      ...structuredClone(input),
      capabilities: [capability({
        tools_json: JSON.stringify([{ name: "changed", inputSchema: {} }]),
      })],
    },
  ]) {
    expectCode(
      () => processCensusReport(store, changed, codeContext()),
      "receipt_hash_mismatch",
    );
  }
});

test("same report ID from changed trusted attribution fails closed", (t) => {
  const { store } = makeStore(t);
  const input = roster();
  processCensusReport(store, input, codeContext());
  expectCode(
    () => processCensusReport(store, input, codeContext({ session: "session.other" })),
    "receipt_provenance_mismatch",
  );
});

test("receipt arbitration holds across two store handles", (t) => {
  const { store, config } = makeStore(t);
  const second = new CapsStore(config);
  try {
    const input = roster();
    assert.equal(processCensusReport(store, input, codeContext()).replayed, false);
    assert.equal(processCensusReport(second, input, codeContext()).replayed, true);
    assert.equal(
      store.db.prepare("SELECT count(*) AS count FROM _caps_census_receipts").get().count,
      1,
    );
  } finally {
    second.close();
  }
});

test("receipts persist across a process-style close and reopen", (t) => {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), "caps-census-restart-"));
  const config = {
    stateDirectory: directory,
    databasePath: path.join(directory, "caps.sqlite"),
  };
  const input = roster();
  const first = new CapsStore(config);
  processCensusReport(first, input, codeContext());
  first.close();
  const second = new CapsStore(config);
  t.after(() => {
    second.close();
    fs.rmSync(directory, { recursive: true, force: true });
  });
  assert.ok(second.getCensusReceipt(input.report_id));
  assert.equal(processCensusReport(second, input, codeContext()).replayed, true);
});

test("new hosted capability receives deterministic census identity and full evidence", (t) => {
  const { store } = makeStore(t);
  const input = roster({
    capabilities: [capability({ transport: "hosted", pricing: "unknown" })],
  });
  processCensusReport(store, input, codeContext());
  const row = store.db.prepare("SELECT * FROM installed_working WHERE slug = 'echo'").get();
  assert.match(row.id, /^caps\.census\.[a-f0-9]{32}$/);
  assert.equal(row.transport, "hosted");
  assert.equal(row.producer_surface, "code");
  assert.equal(row.capture_class, "guaranteed");
  assert.equal(row.observed_at, input.observed_at);
  assert.deepEqual(JSON.parse(row.detail_json).last_call, { ok: true });
  assert.equal(JSON.parse(row.provenance_json).census.report_id, input.report_id);
});

test("deterministic identity is stable across independent databases", (t) => {
  const left = makeStore(t).store;
  const right = makeStore(t).store;
  const input = roster();
  const rightInput = structuredClone(input);
  rightInput.report_id = `${input.report_id}-right`;
  processCensusReport(left, input, codeContext());
  processCensusReport(right, rightInput, codeContext());
  assert.equal(
    left.db.prepare("SELECT id FROM installed_working").get().id,
    right.db.prepare("SELECT id FROM installed_working").get().id,
  );
});

test("Code and Cowork preserve separate facts even with the same owner and slug", (t) => {
  const { store } = makeStore(t);
  processCensusReport(store, roster(), codeContext());
  processCensusReport(store, roster(), coworkContext());
  const rows = store.db.prepare(
    "SELECT id, producer_surface, capture_class FROM installed_working WHERE slug = 'echo' ORDER BY producer_surface",
  ).all();
  assert.equal(rows.length, 2);
  assert.notEqual(rows[0].id, rows[1].id);
  assert.deepEqual(
    rows.map((row) => [row.producer_surface, row.capture_class]),
    [["code", "guaranteed"], ["cowork", "best-effort"]],
  );
});

test("available row moves to working by slug and preserves notes, paid tier, and public provenance", (t) => {
  const { store } = makeStore(t);
  const seeded = seed(store, "available_for_install", {
    id: "available.echo",
    slug: "echo",
    name: "Indexed Echo",
    pricing: "paid",
    curated_notes: "owner note",
  });
  const input = roster({
    capabilities: [capability({ name: "Live Echo", pricing: "free" })],
  });
  processCensusReport(store, input, codeContext());
  assert.equal(
    store.db.prepare("SELECT count(*) AS count FROM available_for_install").get().count,
    0,
  );
  const row = store.db.prepare("SELECT * FROM installed_working WHERE id = ?").get(seeded.id);
  assert.equal(row.name, "Live Echo");
  assert.equal(row.pricing, "paid");
  assert.equal(row.curated_notes, "owner note");
  const provenance = JSON.parse(row.provenance_json);
  assert.equal(provenance.public_index.source, "seed");
  assert.equal(provenance.census.outcome, "working");
});

test("available row moves to broken by normalized command evidence", (t) => {
  const { store } = makeStore(t);
  const seeded = seed(store, "available_for_install", {
    id: "available.command",
    slug: "different-slug",
    install_command: "npm run live",
  });
  const input = failureReport("reported-slug", {
    failures: [{
      slug: "reported-slug",
      command: "NPM   RUN   LIVE",
      failure_reason: "launch.failed",
      failure_class: "process.exit",
    }],
  });
  const result = processCensusReport(store, input, codeContext());
  assert.equal(result.broken, 1);
  const row = store.db.prepare("SELECT * FROM installed_broken WHERE id = ?").get(seeded.id);
  assert.equal(row.failure_reason, "launch.failed");
  assert.equal(row.curated_notes, "preserve this note");
  assert.equal(JSON.parse(row.provenance_json).census.failure_class, "process.exit");
});

test("failure transitions only the exact owner and evidence scope", (t) => {
  const { store } = makeStore(t);
  processCensusReport(store, roster(), codeContext());
  processCensusReport(store, roster(), coworkContext());
  const result = processCensusReport(store, failureReport(), codeContext());
  assert.equal(result.broken, 1);
  assert.equal(
    store.db.prepare("SELECT count(*) AS count FROM installed_working WHERE producer_surface = 'cowork'").get().count,
    1,
  );
  const broken = store.db.prepare("SELECT * FROM installed_broken").get();
  assert.equal(broken.producer_surface, "code");
  assert.equal(broken.failure_reason, "timeout");
});

test("repeated failure refreshes bounded evidence without duplicating rows", (t) => {
  const { store } = makeStore(t);
  processCensusReport(store, roster(), codeContext());
  const firstFailure = failureReport();
  processCensusReport(store, firstFailure, codeContext());
  const secondFailure = failureReport("echo", {
    observed_at: observed(1_000),
    failures: [{
      slug: "echo",
      failure_reason: "offline",
      failure_class: "transport.offline",
    }],
  });
  processCensusReport(store, secondFailure, codeContext());
  const row = store.db.prepare("SELECT * FROM installed_broken").get();
  assert.equal(row.failure_reason, "offline");
  assert.equal(row.failure_observed_at, secondFailure.observed_at);
  assert.equal(JSON.parse(row.provenance_json).census.failure_class, "transport.offline");
  assert.equal(store.db.prepare("SELECT count(*) AS count FROM installed_broken").get().count, 1);
});

test("successful evidence repairs a matching broken row and refreshes canonical fields", (t) => {
  const { store } = makeStore(t);
  processCensusReport(store, roster(), codeContext());
  processCensusReport(store, failureReport(), codeContext());
  const repair = roster({
    capabilities: [capability({
      name: "Echo Repaired",
      description: "Fresh evidence",
      tools_json: JSON.stringify([{ name: "fresh", inputSchema: {} }]),
    })],
  });
  const result = processCensusReport(store, repair, codeContext());
  assert.equal(result.repaired, 1);
  assert.equal(store.db.prepare("SELECT count(*) AS count FROM installed_broken").get().count, 0);
  const row = store.db.prepare("SELECT * FROM installed_working").get();
  assert.equal(row.name, "Echo Repaired");
  assert.equal(row.description, "Fresh evidence");
  assert.equal(JSON.parse(row.tools_json)[0].name, "fresh");
});

test("an exact census scope wins over an unrelated non-census row with the same slug", (t) => {
  const { store } = makeStore(t);
  processCensusReport(store, roster(), codeContext());
  const censusId = store.db.prepare(
    "SELECT id FROM installed_working WHERE slug = 'echo'",
  ).get().id;
  processCensusReport(store, failureReport(), codeContext());
  seed(store, "installed_working", {
    id: "probe.echo",
    slug: "echo",
    source_lane: "probe",
    curated_notes: "independent probe row",
  });
  const result = processCensusReport(store, roster(), codeContext());
  assert.equal(result.repaired, 1);
  assert.ok(store.db.prepare(
    "SELECT * FROM installed_working WHERE id = ?",
  ).get(censusId));
  const probe = store.db.prepare(
    "SELECT * FROM installed_working WHERE id = 'probe.echo'",
  ).get();
  assert.equal(probe.source_lane, "probe");
  assert.equal(probe.curated_notes, "independent probe row");
  assert.equal(store.db.prepare(
    "SELECT count(*) AS count FROM installed_broken",
  ).get().count, 0);
});

test("complete roster breaks an absent capability only within the same evidence scope", (t) => {
  const { store } = makeStore(t);
  processCensusReport(store, roster({
    complete: true,
    capabilities: [
      capability({ slug: "alpha", name: "Alpha" }),
      capability({ slug: "beta", name: "Beta" }),
    ],
  }), codeContext());
  const result = processCensusReport(store, roster({
    complete: true,
    capabilities: [capability({ slug: "alpha", name: "Alpha" })],
  }), codeContext());
  assert.equal(result.missing, 1);
  const broken = store.db.prepare("SELECT * FROM installed_broken WHERE slug = 'beta'").get();
  assert.equal(broken.failure_reason, "census_missing_from_complete_roster");
});

test("incremental absence never creates removal evidence", (t) => {
  const { store } = makeStore(t);
  processCensusReport(store, roster(), codeContext());
  const result = processCensusReport(store, roster({
    complete: false,
    capabilities: [],
  }), codeContext());
  assert.equal(result.missing, 0);
  assert.equal(store.db.prepare("SELECT count(*) AS count FROM installed_working").get().count, 1);
});

test("Code complete roster cannot remove Cowork facts", (t) => {
  const { store } = makeStore(t);
  processCensusReport(store, roster(), coworkContext());
  const result = processCensusReport(store, roster({
    complete: true,
    capabilities: [],
  }), codeContext());
  assert.equal(result.missing, 0);
  assert.equal(
    store.db.prepare("SELECT count(*) AS count FROM installed_working WHERE producer_surface = 'cowork'").get().count,
    1,
  );
});

test("complete roster leaves other owners and non-census lanes untouched", (t) => {
  const { store } = makeStore(t);
  seed(store, "installed_working", {
    id: "codex.row",
    slug: "codex-row",
    surface_owner: "codex",
    source_lane: "census",
    producer_surface: "codex",
    capture_class: "reported",
  });
  seed(store, "installed_working", {
    id: "probe.row",
    slug: "probe-row",
    surface_owner: "claude",
    source_lane: "probe",
  });
  const result = processCensusReport(store, roster({
    complete: true,
    capabilities: [],
  }), codeContext());
  assert.equal(result.missing, 0);
  assert.equal(store.db.prepare("SELECT count(*) AS count FROM installed_working").get().count, 2);
});

test("Code explicit cross-surface ingestion may transition the cited owner", (t) => {
  const { store } = makeStore(t);
  seed(store, "installed_working", {
    id: "agy.row",
    slug: "agy-tool",
    surface_owner: "agy",
    producer_surface: "antigravity",
    capture_class: "reported",
  });
  const result = processCensusReport(
    store,
    failureReport("agy-tool", {
      failures: [{ slug: "agy-tool", failure_reason: "timeout" }],
    }),
    codeContext({ source_surface: "agy" }),
  );
  assert.equal(result.broken, 1);
  const row = store.db.prepare("SELECT * FROM installed_broken WHERE id = 'agy.row'").get();
  assert.equal(row.surface_owner, "agy");
  assert.equal(row.producer_surface, "code");
});

test("ordinary callers cannot mutate a different owner's matching slug", (t) => {
  const { store } = makeStore(t);
  seed(store, "installed_working", {
    id: "agy.echo",
    slug: "echo",
    surface_owner: "agy",
    producer_surface: "antigravity",
    capture_class: "reported",
  });
  const result = processCensusReport(store, failureReport(), codeContext());
  assert.equal(result.skipped, 1);
  assert.ok(store.db.prepare("SELECT * FROM installed_working WHERE id = 'agy.echo'").get());
});

test("unknown failure evidence is recorded as skipped and creates no capability", (t) => {
  const { store } = makeStore(t);
  const result = processCensusReport(store, failureReport("not-installed"), codeContext());
  assert.deepEqual(
    result,
    { repaired: 0, working: 0, broken: 0, missing: 0, skipped: 1, replayed: false },
  );
  assert.equal(store.db.prepare("SELECT count(*) AS count FROM installed_broken").get().count, 0);
});

test("transaction rollback removes both partial rows and receipt", (t) => {
  const { store } = makeStore(t);
  const input = roster();
  const original = store.upsertCapability.bind(store);
  store.upsertCapability = () => {
    throw new Error("injected_failure");
  };
  assert.throws(
    () => processCensusReport(store, input, codeContext()),
    /injected_failure/,
  );
  store.upsertCapability = original;
  assert.equal(store.getCensusReceipt(input.report_id), undefined);
  assert.equal(store.db.prepare("SELECT count(*) AS count FROM installed_working").get().count, 0);
});

test("CapsService exposes an unknown roster boundary and returns typed result shape", (t) => {
  const { store } = makeStore(t);
  const service = new CapsService(store);
  const result = service.reportCensus(roster(), codeContext());
  assert.deepEqual(
    Object.keys(result).sort(),
    ["broken", "missing", "repaired", "replayed", "skipped", "working"],
  );
  expectCode(
    () => service.reportCensus("not-an-object", codeContext()),
    "invalid_roster_object",
  );
});
