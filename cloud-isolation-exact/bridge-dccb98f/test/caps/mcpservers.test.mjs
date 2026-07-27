import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

import {
  MCPSERVERS_USER_AGENT,
  RateLimitError,
  fetchWithPolicy,
} from "../../dist/caps/fetch-policy.js";
import {
  parseCapabilityUrl,
  parseDetail,
  parseListings,
  parseRootSitemaps,
  parseSearchTotal,
  parseSitemapEntries,
} from "../../dist/caps/mcpservers-parser.js";
import { McpserversIndexer } from "../../dist/caps/mcpservers.js";
import { CapsStore } from "../../dist/caps/store.js";

const FIXTURE_DIRECTORY = new URL("../fixtures/caps/", import.meta.url);

function fixture(name) {
  return fs.readFileSync(new URL(name, FIXTURE_DIRECTORY), "utf8");
}

function response(body, status = 200, headers = {}) {
  return new Response(body, { status, headers });
}

function makeStore(t) {
  const directory = fs.mkdtempSync(
    path.join(os.tmpdir(), "bridge-caps-mcpservers-"),
  );
  const config = {
    stateDirectory: directory,
    databasePath: path.join(directory, "caps.sqlite"),
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
  return { directory, config, store };
}

function seedInstalled(store, overrides = {}) {
  const data = {
    id: "installed.test-server",
    kind: "server",
    name: "Installed Test Server",
    slug: "test-server",
    source_url: "https://mcpservers.org/servers/test-server",
    surface_owner: "codex",
    transport: "stdio",
    description: "installed description",
    pricing: "paid",
    official: 1,
    stars: 9000,
    install_command: "owner-command",
    source_lane: "probe",
    producer_surface: "codex",
    capture_class: "observed",
    observed_at: "2026-07-23T00:00:00.000Z",
    last_verified: "2026-07-23T00:00:00.000Z",
    stale_at: "2026-07-25T00:00:00.000Z",
    curated_notes: "installed owner note",
    tools_json: "[]",
    detail_json: "{}",
    provenance_json: '{"source":"probe"}',
    raw_json: null,
    ...overrides,
  };
  store.upsertCapability("installed_working", data);
  return store.db.prepare(
    "SELECT * FROM installed_working WHERE id = ?",
  ).get(data.id);
}

function makeNetwork(overrides = {}) {
  let currentTime = Date.parse("2026-07-24T12:00:00.000Z");
  const history = [];
  const sleeps = [];
  let serverSitemap = fixture("mcpservers-server-sitemap.xml");
  let skillSitemap = fixture("mcpservers-skills-sitemap.xml");
  let listing = fixture("mcpservers-listing.html");
  let detail = fixture("mcpservers-detail.html");
  let watchTotal = 562;
  let failBulkWithRateLimit = false;
  let failDetail = false;

  const sleepImpl = async (milliseconds, signal) => {
    if (signal?.aborted) {
      const error = new Error("aborted");
      error.name = "AbortError";
      throw error;
    }
    sleeps.push(milliseconds);
    currentTime += milliseconds;
  };

  const fetchImpl = async (rawUrl, init) => {
    history.push({
      url: rawUrl,
      userAgent: init.headers["User-Agent"],
      redirect: init.redirect,
    });
    const url = new URL(rawUrl);
    if (url.pathname === "/sitemap.xml") {
      return response(fixture("mcpservers-root-sitemap.xml"));
    }
    if (url.pathname === "/servers/1.xml") {
      return response(serverSitemap);
    }
    if (url.pathname === "/skills.xml") {
      return response(skillSitemap);
    }
    if (url.pathname === "/search") {
      return response(`<h1>Found ${watchTotal} results</h1>`);
    }
    if (
      (url.pathname === "/all" || url.pathname === "/agent-skills")
      && url.searchParams.get("page") === "1"
    ) {
      if (failBulkWithRateLimit) {
        return response("", 429, { "Retry-After": "0" });
      }
      return response(listing);
    }
    if (
      (url.pathname === "/all" || url.pathname === "/agent-skills")
      && url.searchParams.get("page") !== "1"
    ) {
      return response('<main data-page-end="true"></main>');
    }
    if (
      url.pathname === "/servers/test-server"
      || url.pathname === "/servers/paid-server"
      || url.pathname.startsWith("/agent-skills/")
    ) {
      return failDetail
        ? response("", 503)
        : response(detail);
    }
    return response("not found", 404);
  };

  return {
    history,
    sleeps,
    fetchImpl,
    sleepImpl,
    nowImpl: () => currentTime,
    setServerSitemap(value) {
      serverSitemap = value;
    },
    setSkillSitemap(value) {
      skillSitemap = value;
    },
    setListing(value) {
      listing = value;
    },
    setDetail(value) {
      detail = value;
    },
    setWatchTotal(value) {
      watchTotal = value;
    },
    setBulkRateLimit(value) {
      failBulkWithRateLimit = value;
    },
    setDetailFailure(value) {
      failDetail = value;
    },
  };
}

function makeIndexer(store, config, network, overrides = {}) {
  return new McpserversIndexer(store, config, {
    watchTerms: ["official", "curated"],
    sleepImpl: network.sleepImpl,
    nowImpl: network.nowImpl,
    fetchPolicy: {
      fetchImpl: network.fetchImpl,
      sleepImpl: network.sleepImpl,
      nowImpl: network.nowImpl,
      timeoutMs: 1_000,
    },
    ...overrides,
  });
}

test("root parser accepts only supported exact-origin sitemap declarations", () => {
  const input = `${fixture("mcpservers-root-sitemap.xml")}
    <loc>https://evil.example/servers/2.xml</loc>
    <loc>https://mcpservers.org/unsupported.xml</loc>`;
  const parsed = parseRootSitemaps(input);
  assert.deepEqual(
    parsed.value,
    [
      { url: "https://mcpservers.org/servers/1.xml", kind: "server" },
      { url: "https://mcpservers.org/skills.xml", kind: "skill" },
    ],
  );
  assert.deepEqual(
    parsed.gaps.sort(),
    ["root_sitemap_location_invalid", "root_sitemap_path_unsupported"],
  );
});

test("sitemap parser preserves server/skill identity, author, and lastmod", () => {
  const servers = parseSitemapEntries(
    fixture("mcpservers-server-sitemap.xml"),
    "server",
  );
  const skills = parseSitemapEntries(
    fixture("mcpservers-skills-sitemap.xml"),
    "skill",
  );
  assert.equal(servers.value.length, 3);
  assert.equal(skills.value.length, 2);
  assert.equal(skills.value[0].author, "acme");
  assert.equal(
    servers.value.find((entry) => entry.slug === "shared-slug").identity,
    "server:https://mcpservers.org/servers/shared-slug",
  );
  assert.equal(
    skills.value.find((entry) => entry.slug === "shared-slug").identity,
    "skill:https://mcpservers.org/agent-skills/acme/shared-slug",
  );
  assert.match(servers.value[0].lastmod, /^\d{4}-/);
  assert.deepEqual(servers.gaps, []);
  assert.deepEqual(skills.gaps, []);
});

test("capability URL parser rejects spoofed and unsupported paths", () => {
  assert.equal(
    parseCapabilityUrl("https://mcpservers.org/servers/alpha").kind,
    "server",
  );
  assert.equal(
    parseCapabilityUrl("https://mcpservers.org/agent-skills/acme/alpha").kind,
    "skill",
  );
  assert.equal(
    parseCapabilityUrl("https://mcpservers.org/tools/alpha"),
    null,
  );
  assert.equal(
    parseCapabilityUrl("https://mcpservers.org.evil/servers/alpha"),
    null,
  );
  assert.equal(
    parseCapabilityUrl("https://mcpservers.org/servers/not%2Fsafe"),
    null,
  );
});

test("listing parser extracts explicit public evidence without guessing", () => {
  const parsed = parseListings(fixture("mcpservers-listing.html"));
  assert.equal(parsed.value.length, 6);
  assert.deepEqual(parsed.gaps, []);
  const free = parsed.value.find((item) => item.slug === "test-server");
  assert.equal(free.name, "Test & Server");
  assert.equal(free.pricing, "free");
  assert.equal(free.curated, true);
  assert.equal(free.install_command, "npx @mcp/test");
  const paid = parsed.value.find((item) => item.slug === "paid-server");
  assert.equal(paid.pricing, "paid");
  assert.equal(paid.official, 1);
  assert.equal(paid.stars, 1024);
  const sponsor = parsed.value.find((item) => item.slug === "sponsor-server");
  assert.equal(sponsor.sponsor, true);
  assert.equal(
    parsed.value.filter((item) => item.slug === "shared-slug").length,
    2,
  );
});

test("listing parser emits structured gaps for drift and unsafe evidence", () => {
  const parsed = parseListings(`
    <div class="card"><a href="/tools/guess" class="title">Guess</a></div>
    <div class="card"><a href="/servers/no-name"></a></div>
    <div class="card"><a href="/servers/unsafe" class="title">Unsafe</a>
      <code class="install">token=supersecret123</code>
      <div class="pricing">maybe</div>
    </div>
  `);
  assert.equal(parsed.value.length, 1);
  assert.equal(parsed.value[0].install_command, null);
  assert.equal(parsed.value[0].pricing, "unknown");
  assert.ok(parsed.gaps.includes("listing_identity_invalid"));
  assert.ok(parsed.gaps.includes("listing_name_invalid"));
  assert.ok(parsed.gaps.includes("listing_install_invalid"));
  assert.ok(parsed.gaps.includes("listing_pricing_unrecognized"));
});

test("search totals and detail parsing remain bounded and sanitized", () => {
  assert.equal(parseSearchTotal("Found 10,139 servers"), 10_139);
  assert.equal(parseSearchTotal("562 results"), 562);
  assert.equal(parseSearchTotal("No total here"), null);
  const parsed = parseDetail(fixture("mcpservers-detail.html"));
  assert.equal(parsed.value.description, "Enriched public description");
  assert.equal(parsed.value.category, "Developer Tools");
  assert.equal(parsed.value.install_command, "npx @mcp/test@2");
  assert.doesNotMatch(JSON.stringify(parsed.value), /privateToken/);
});

test("fetch policy enforces exact HTTPS origin, credentials, port, and fragment", async () => {
  const rejected = [
    "http://mcpservers.org/",
    "https://evil.example/",
    "https://mcpservers.org.evil/",
    "https://user@mcpservers.org/",
    "https://mcpservers.org:444/",
    "https://mcpservers.org/#fragment",
  ];
  for (const url of rejected) {
    await assert.rejects(fetchWithPolicy(url), /fetch_policy_/);
  }
});

test("fetch policy sends honest UA, rejects redirects and nonretryable status", async () => {
  let observed;
  const ok = await fetchWithPolicy("https://mcpservers.org/test", {
    fetchImpl: async (url, init) => {
      observed = { url, init };
      return response("hello");
    },
  });
  assert.equal(ok.text, "hello");
  assert.equal(ok.bytes, 5);
  assert.match(ok.sha256, /^[a-f0-9]{64}$/);
  assert.equal(observed.init.headers["User-Agent"], MCPSERVERS_USER_AGENT);
  assert.equal(observed.init.redirect, "error");

  const redirected = response("redirected");
  Object.defineProperty(redirected, "redirected", { value: true });
  await assert.rejects(
    fetchWithPolicy("https://mcpservers.org/redirect", {
      fetchImpl: async () => redirected,
      sleepImpl: async () => {
        throw new Error("redirect must not retry");
      },
    }),
    /fetch_policy_redirect_rejected/,
  );

  let attempts = 0;
  await assert.rejects(
    fetchWithPolicy("https://mcpservers.org/missing", {
      fetchImpl: async () => {
        attempts += 1;
        return response("", 404);
      },
    }),
    /fetch_policy_status_404/,
  );
  assert.equal(attempts, 1);
});

test("fetch policy performs no more than three transient retries", async () => {
  let attempts = 0;
  const sleeps = [];
  const result = await fetchWithPolicy("https://mcpservers.org/retry", {
    fetchImpl: async () => {
      attempts += 1;
      if (attempts === 1) throw new TypeError("network");
      if (attempts === 2) return response("", 503);
      return response("recovered");
    },
    sleepImpl: async (milliseconds) => sleeps.push(milliseconds),
  });
  assert.equal(result.attempts, 3);
  assert.equal(attempts, 3);
  assert.deepEqual(sleeps, [1000, 2000]);

  attempts = 0;
  await assert.rejects(
    fetchWithPolicy("https://mcpservers.org/retry-exhausted", {
      fetchImpl: async () => {
        attempts += 1;
        throw new TypeError("network");
      },
      sleepImpl: async () => {},
    }),
    /fetch_policy_network_retries_exhausted/,
  );
  assert.equal(attempts, 4);
});

test("fetch policy honors Retry-After and returns a terminal rate-limit error", async () => {
  let attempts = 0;
  const sleeps = [];
  await assert.rejects(
    fetchWithPolicy("https://mcpservers.org/rate-limited", {
      fetchImpl: async () => {
        attempts += 1;
        return response("", 429, { "Retry-After": "2" });
      },
      sleepImpl: async (milliseconds) => sleeps.push(milliseconds),
    }),
    (error) => {
      assert.ok(error instanceof RateLimitError);
      assert.equal(error.retryAfterMs, 2000);
      assert.equal(error.attempts, 4);
      return true;
    },
  );
  assert.equal(attempts, 4);
  assert.deepEqual(sleeps, [2000, 2000, 2000]);
});

test("fetch policy enforces declared and streamed byte bounds", async () => {
  await assert.rejects(
    fetchWithPolicy("https://mcpservers.org/declared-large", {
      maxBytes: 5,
      fetchImpl: async () =>
        response("", 200, { "Content-Length": "6" }),
    }),
    /fetch_policy_byte_limit_exceeded/,
  );
  const stream = new ReadableStream({
    start(controller) {
      controller.enqueue(new TextEncoder().encode("123456"));
      controller.close();
    },
  });
  await assert.rejects(
    fetchWithPolicy("https://mcpservers.org/stream-large", {
      maxBytes: 5,
      fetchImpl: async () => new Response(stream),
    }),
    /fetch_policy_byte_limit_exceeded/,
  );
  await assert.rejects(
    fetchWithPolicy("https://mcpservers.org/bad-length", {
      fetchImpl: async () =>
        response("", 200, { "Content-Length": "unknown" }),
    }),
    /fetch_policy_content_length_invalid/,
  );
});

test("fetch policy timeout remains active through body consumption", async () => {
  const fetchImpl = async (_url, init) => {
    const stream = new ReadableStream({
      start(controller) {
        init.signal.addEventListener("abort", () => {
          controller.error(new Error("aborted"));
        }, { once: true });
      },
    });
    return new Response(stream);
  };
  await assert.rejects(
    fetchWithPolicy("https://mcpservers.org/slow-body", {
      timeoutMs: 10,
      fetchImpl,
    }),
    /fetch_policy_aborted/,
  );
});

test("fetch policy option bounds fail closed", async () => {
  await assert.rejects(
    fetchWithPolicy("https://mcpservers.org/test", { timeoutMs: 20_001 }),
    /fetch_policy_timeout_invalid/,
  );
  await assert.rejects(
    fetchWithPolicy("https://mcpservers.org/test", {
      maxBytes: 5 * 1024 * 1024 + 1,
    }),
    /fetch_policy_max_bytes_invalid/,
  );
});

test("initial refresh uses bulk pages only and indexes servers plus skills", async (t) => {
  const { config, store } = makeStore(t);
  const network = makeNetwork();
  const report = await makeIndexer(store, config, network).runRefresh();
  assert.deepEqual(report.errors, []);
  assert.equal(report.processed, 5);
  assert.equal(report.pending, 0);
  assert.equal(report.stated_totals.servers.value, 3);
  assert.equal(report.stated_totals.skills.value, 2);
  assert.equal(report.stated_totals["watch:official"].value, 562);
  assert.equal(report.stated_totals["watch:official"].previous, null);

  const rows = store.db.prepare(
    "SELECT * FROM available_for_install ORDER BY source_url",
  ).all();
  assert.equal(rows.length, 5);
  assert.equal(rows.some((row) => row.slug === "sponsor-server"), false);
  assert.equal(rows.filter((row) => row.slug === "shared-slug").length, 2);
  assert.equal(new Set(rows.map((row) => row.id)).size, 5);
  assert.ok(rows.every((row) => row.id.startsWith("caps.public.")));
  assert.ok(rows.every((row) => row.producer_surface === "external-index"));

  const urls = network.history.map((entry) => entry.url);
  assert.equal(
    urls.some((url) => /search\?page=1&query=(?!curated|official)/.test(url)),
    false,
  );
  assert.equal(
    urls.some((rawUrl) => {
      const url = new URL(rawUrl);
      return (
        /^\/servers\/[^/]+$/.test(url.pathname)
          && !url.pathname.endsWith(".xml")
      ) || /^\/agent-skills\/[^/]+\/[^/]+$/.test(url.pathname);
    }),
    false,
  );
  assert.ok(urls.includes("https://mcpservers.org/all?page=1"));
  assert.ok(urls.includes("https://mcpservers.org/agent-skills?page=1"));
  assert.ok(network.sleeps.filter((value) => value > 0).every(
    (value) => value >= 750,
  ));
  assert.ok(fs.existsSync(path.join(
    config.stateDirectory,
    "mcpservers-backfill-v1.json",
  )));
  assert.ok(fs.existsSync(path.join(
    config.stateDirectory,
    "mcpservers-refresh-v1.json",
  )));
  assert.equal(
    report.fetch_log.some((entry) => "text" in entry),
    false,
  );
});

test("unchanged daily refresh fetches no bulk pages and reports watch deltas", async (t) => {
  const { config, store } = makeStore(t);
  const network = makeNetwork();
  const indexer = makeIndexer(store, config, network);
  await indexer.runRefresh();
  network.history.length = 0;
  network.setWatchTotal(570);
  const report = await indexer.runRefresh();
  assert.equal(report.processed, 0);
  assert.equal(report.diff.new_count, 0);
  assert.equal(report.diff.changed_count, 0);
  assert.equal(report.stated_totals["watch:official"].previous, 562);
  assert.equal(report.stated_totals["watch:official"].delta, 8);
  assert.equal(
    network.history.some((entry) =>
      entry.url.includes("/all?page=")
      || entry.url.includes("/agent-skills?page=")),
    false,
  );
});

test("changed sitemap evidence updates only the changed row and preserves owner fields", async (t) => {
  const { config, store } = makeStore(t);
  const network = makeNetwork();
  const indexer = makeIndexer(store, config, network);
  await indexer.runRefresh();
  const before = store.db.prepare(
    "SELECT * FROM available_for_install WHERE slug = 'test-server'",
  ).get();
  store.db.prepare(`
    UPDATE available_for_install
    SET curated_notes = 'owner note',
        judgment_model = 'agy',
        judgment_at = '2026-07-24T12:00:00.000Z',
        judgment_verdict = 'keep',
        judgment_reason = 'owner-approved',
        judgment_surface = 'antigravity'
    WHERE id = ?
  `).run(before.id);
  network.setServerSitemap(
    fixture("mcpservers-server-sitemap.xml").replace(
      "2026-07-23T00:00:00.000Z",
      "2026-07-24T00:00:00.000Z",
    ),
  );
  const report = await indexer.runRefresh();
  assert.equal(report.diff.changed_count, 1);
  assert.equal(report.processed, 1);
  const after = store.db.prepare(
    "SELECT * FROM available_for_install WHERE id = ?",
  ).get(before.id);
  assert.equal(after.curated_notes, "owner note");
  assert.equal(after.judgment_model, "agy");
  assert.equal(after.judgment_verdict, "keep");
  assert.equal(after.judgment_reason, "owner-approved");
  const provenance = JSON.parse(after.provenance_json);
  assert.ok(provenance.public_index.previous_observation);
});

test("removed sitemap identity is reported but its last-good row is retained", async (t) => {
  const { config, store } = makeStore(t);
  const network = makeNetwork();
  const indexer = makeIndexer(store, config, network);
  await indexer.runRefresh();
  const paid = store.db.prepare(
    "SELECT * FROM available_for_install WHERE slug = 'paid-server'",
  ).get();
  network.setServerSitemap(
    fixture("mcpservers-server-sitemap.xml").replace(
      /  <url>\s*<loc>https:\/\/mcpservers\.org\/servers\/paid-server<\/loc>[\s\S]*?<\/url>\s*/m,
      "",
    ),
  );
  const report = await indexer.runRefresh();
  assert.equal(report.diff.removed_count, 1);
  assert.ok(report.diff.removed.some((identity) =>
    identity.includes("paid-server")));
  assert.deepEqual(
    store.db.prepare(
      "SELECT * FROM available_for_install WHERE id = ?",
    ).get(paid.id),
    paid,
  );
});

test("public refresh never mutates an installed row or creates its duplicate", async (t) => {
  const { config, store } = makeStore(t);
  const installed = seedInstalled(store);
  const network = makeNetwork();
  const report = await makeIndexer(store, config, network).runRefresh();
  assert.equal(report.skipped_installed, 1);
  assert.deepEqual(
    store.db.prepare(
      "SELECT * FROM installed_working WHERE id = ?",
    ).get(installed.id),
    installed,
  );
  assert.equal(
    store.db.prepare(`
      SELECT count(*) AS count
      FROM available_for_install
      WHERE source_url = 'https://mcpservers.org/servers/test-server'
    `).get().count,
    0,
  );
});

test("rate limit stops the whole bulk pass and checkpoint retains pending work", async (t) => {
  const { config, store } = makeStore(t);
  const network = makeNetwork();
  network.setBulkRateLimit(true);
  const report = await makeIndexer(store, config, network).runRefresh();
  assert.equal(report.pending, 5);
  assert.equal(
    network.history.some((entry) =>
      entry.url.includes("/agent-skills?page=")),
    false,
  );
  const state = JSON.parse(fs.readFileSync(path.join(
    config.stateDirectory,
    "mcpservers-backfill-v1.json",
  ), "utf8"));
  assert.equal(state.pending.length, 5);
  assert.equal(state.phase, "server");

  network.setBulkRateLimit(false);
  network.history.length = 0;
  const resumed = await makeIndexer(store, config, network).runRefresh();
  assert.equal(resumed.pending, 0);
  assert.equal(
    store.db.prepare(
      "SELECT count(*) AS count FROM available_for_install",
    ).get().count,
    5,
  );
});

test("parser drift preserves last-good row and leaves changed identity pending", async (t) => {
  const { config, store } = makeStore(t);
  const network = makeNetwork();
  const indexer = makeIndexer(store, config, network);
  await indexer.runRefresh();
  const before = store.db.prepare(
    "SELECT * FROM available_for_install WHERE slug = 'test-server'",
  ).get();
  network.setServerSitemap(
    fixture("mcpservers-server-sitemap.xml").replace(
      "2026-07-23T00:00:00.000Z",
      "2026-07-24T00:00:00.000Z",
    ),
  );
  network.setListing(`
    <div class="card"><a href="/servers/test-server"></a></div>
  `);
  const report = await indexer.runRefresh();
  assert.ok(report.pending >= 1);
  assert.ok(report.gaps.some((gap) => gap.includes("listing_name_invalid")));
  const after = store.db.prepare(
    "SELECT * FROM available_for_install WHERE id = ?",
  ).get(before.id);
  const {
    observed_at: beforeObservedAt,
    last_verified: beforeLastVerified,
    stale_at: beforeStaleAt,
    provenance_json: beforeProvenance,
    ...beforeFacts
  } = before;
  const {
    observed_at: afterObservedAt,
    last_verified: afterLastVerified,
    stale_at: afterStaleAt,
    provenance_json: afterProvenance,
    ...afterFacts
  } = after;
  assert.deepEqual(afterFacts, beforeFacts);
  assert.notEqual(afterObservedAt, beforeObservedAt);
  assert.notEqual(afterLastVerified, beforeLastVerified);
  assert.notEqual(afterStaleAt, beforeStaleAt);
  assert.equal(
    JSON.parse(afterProvenance).public_index.sitemap_seen_at,
    afterObservedAt,
  );
  assert.equal(
    JSON.parse(beforeProvenance).public_index.sitemap_seen_at,
    undefined,
  );
});

test("lazy detail stores only sanitized fields and preserves notes and judgments", async (t) => {
  const { config, store } = makeStore(t);
  const network = makeNetwork();
  const indexer = makeIndexer(store, config, network);
  await indexer.runRefresh();
  const row = store.db.prepare(
    "SELECT * FROM available_for_install WHERE slug = 'test-server'",
  ).get();
  store.db.prepare(`
    UPDATE available_for_install
    SET curated_notes = 'keep note', judgment_verdict = 'keep'
    WHERE id = ?
  `).run(row.id);
  const enriched = await indexer.enrichDetail(row.id);
  assert.equal(enriched.description, "Enriched public description");
  assert.equal(enriched.category, "Developer Tools");
  assert.equal(enriched.install_command, "npx @mcp/test@2");
  assert.equal(enriched.curated_notes, "keep note");
  assert.equal(enriched.judgment_verdict, "keep");
  assert.ok(enriched.detail_fetched_at);
  assert.doesNotMatch(enriched.detail_json, /privateToken|must-not-be-stored/);
  assert.equal("raw_html" in JSON.parse(enriched.detail_json), false);
});

test("lazy detail failure returns the last-good row and installed IDs are unavailable", async (t) => {
  const { config, store } = makeStore(t);
  const network = makeNetwork();
  const indexer = makeIndexer(store, config, network);
  await indexer.runRefresh();
  const row = store.db.prepare(
    "SELECT * FROM available_for_install WHERE slug = 'test-server'",
  ).get();
  network.setDetailFailure(true);
  assert.deepEqual(await indexer.enrichDetail(row.id), row);
  seedInstalled(store, { id: "installed.other", slug: "other" });
  await assert.rejects(
    indexer.enrichDetail("installed.other"),
    /mcpservers_detail_not_available/,
  );
});

test("corrupt checkpoint is recorded as a gap and safely superseded", async (t) => {
  const { config, store } = makeStore(t);
  fs.writeFileSync(
    path.join(config.stateDirectory, "mcpservers-backfill-v1.json"),
    '{"schema":"wrong"}',
    "utf8",
  );
  const network = makeNetwork();
  const report = await makeIndexer(store, config, network).runRefresh();
  assert.ok(report.gaps.includes("checkpoint_shape_invalid"));
  const state = JSON.parse(fs.readFileSync(path.join(
    config.stateDirectory,
    "mcpservers-backfill-v1.json",
  ), "utf8"));
  assert.equal(state.schema, "bridge-caps-mcpservers-state-v1");
});

test("indexer configuration is bounded and default pacing cannot be weakened", (t) => {
  const { config, store } = makeStore(t);
  assert.throws(
    () => new McpserversIndexer(store, config, { requestDelayMs: 749 }),
    /mcpservers_request_delay_invalid/,
  );
  assert.throws(
    () => new McpserversIndexer(store, config, {
      watchTerms: ["token=supersecret123"],
    }),
    /mcpservers_watch_term_invalid/,
  );
  assert.throws(
    () => new McpserversIndexer(store, config, { maxBulkPages: 1001 }),
    /mcpservers_max_bulk_pages_invalid/,
  );
});
