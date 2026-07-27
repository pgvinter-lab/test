# Bridge Capability Catalog ("caps") — Design for Decomposition

- Status: DESIGN HANDOFF — Codex decomposes into AGY work packages; AGY implements ALL code
- Date: 2026-07-23
- Author: Claude Code (claude_desktop_code), from owner-directed design session
- Supersedes: board task `task.legacy.efe3ffa9-1933-497f-9262-dd3235df6a46` (earlier scoped row)
- Owner decisions embedded here are REQUIREMENTS, not suggestions. Codex may attach enforcement
  and sequencing, and must FLAG disagreements in the packages rather than silently altering scope.

## 1. Mission

One queryable capability catalog for the whole multi-LLM system, carried by Bridge:

1. **Installed** — every MCP server/tool on every surface (Claude Code, Codex, Gemini/AGY,
   hosted claude.ai fleet), split working vs broken.
2. **Available** — an index of the public mcpservers.org directory (10,139 servers at scan time
   2026-07-23, 15 categories, plus its separate agent-skills library), refreshed daily.
3. Any connected agent can ask "who can do X and how do I reach it" in one call, and a model
   (not code) judges whether an available-but-not-installed tool meets an immediate need.

Catalog ≠ proxy. Bridge stores metadata and routing recipes only. It NEVER holds upstream
credentials, never proxies tool calls, never exposes a public endpoint or tunnel.

## 2. Roles (owner-directed)

- **AGY (Antigravity)**: writes ALL implementation code, package by package.
- **Codex**: breaks this design into standalone AGY-executable work packages as `.md` files in
  `docs/caps/agy-packages/` (NN-name.md), each with enforcement rules; sequences them against the
  in-flight mailbox v3 stream (Codex holds control and owns sequencing).
- **Claude**: design owner; reviews packages/output on request.
- **Owner**: throws packages to AGY; approves anything paid or outward.

## 3. Store — SQLite, three tables (OWNER SPEC — exact)

Engine: `node:sqlite` (repo already contract-tests it: `test/contract/node-sqlite.mjs`).
Location: Bridge state directory (follow `src/v2/mailbox/config.ts` conventions for resolving a
state dir; caps gets its own subdirectory/DB file, e.g. `caps.sqlite`). Never inside the repo or
the Drive exchange.

Tables (owner named these — keep the names):

1. **`installed_working`** — reachable, verified capabilities on our surfaces.
2. **`installed_broken`** — installed but failing: auth-expired/auth-pending (e.g. the ~55
   claude.ai connectors currently listed auth-required), probe failures, census-reported call
   failures. Rows carry the failure reason + when observed.
3. **`available_for_install`** — the mcpservers.org index (servers AND skills), not installed here.

Common columns (all three): id, kind (server|tool|skill), name, slug/source-url, surface/owner
(claude|codex|gemini|agy|clickup-hosted|n/a), transport (stdio|http|hosted), description,
**pricing (free|paid|unknown)**, official flag, stars (available rows), install command (available
rows), source lane (config-crawl|probe|census|mcpservers-sitemap|mcpservers-search), observed_at,
last_verified, curated_notes (NEVER machine-overwritten), raw JSON blob.

Tool-level detail (per-server tools list + schemas) hangs off installed rows from probe/census;
lazily-fetched detail pages hang off available rows.

State transitions: working ↔ broken (probe/census evidence only — never inference);
available → installed_* when a crawl/census detects local presence (match by slug/command).

### Free vs paid — enforcement reflex (OWNER SPEC)

Every row is segmented free|paid|unknown. **Paid is ALWAYS down-voted**: a hard sort tier — in
every query surface (`caps_search`, projections, judgment shortlists), paid rows rank below ALL
free rows regardless of relevance score; unknown ranks between. This is code, not a weight, and
not overridable by a caller flag. Additionally: judgment lanes may propose paid tools only as
ask-first items, clearly labeled; nothing paid is ever auto-proposed as the primary answer while
a free candidate exists.

## 4. Data lanes (sense/compress only — no filtering of meaning)

1. **Config crawl** (daily + on demand): parse `~/.claude.json` (top-level + per-project
   mcpServers), project `.mcp.json` files from a crawl-targets config, `~/.codex/config.toml`
   (`[mcp_servers.*]` — targeted TOML subset parser is acceptable; document its limits),
   `~/.gemini/settings.json`. Parse failures are recorded as warnings, never fabricated.
2. **Local stdio live-probe** (daily): spawn → MCP initialize → tools/list → kill, capturing real
   tool names/schemas. Timeouts bounded; failures → installed_broken with reason.
3. **Census** (event-driven): `caps_report` upserts an agent's live roster — the ONLY lane that
   can see hosted rosters (claude.ai fleet, Codex plugin tool surfaces). Census also carries
   failure reports ("tool X errored") which flip working → broken.
4. **mcpservers.org index** (daily): sitemap (`sitemap.xml` → `servers/1..6.xml`, `skills.xml`)
   for the slug universe; listing/category/search pages for name+blurb+category+badges in bulk;
   `/search?page=1&query=…` for a configurable watch-term list (stated totals). One paced
   backfill for the initial ~10k (sequential, delayed, honest UA); daily incremental = slug diff
   (site sorts newest-first) + watch-term count deltas. Detail pages fetched lazily only for
   judgment-shortlisted rows. All fetch outcomes logged; parse failure = recorded gap, never a
   guessed row. Skills library indexed the same way into available_for_install with kind=skill.

## 5. MCP tools on the bridge server (`caps_*`)

Two-phase, ToolSearch-style, tiny serving surface:

- `caps_search(query, opts?)` → compact hits (name, kind, pricing, one-liner, table-of-origin)
  each with a **routing recipe computed for the calling agent** (identity from existing bridge
  session registration): "native: call <tool>" | "installed on <surface>: mailbox dispatch
  template attached" | "not installed: available, install cmd + pricing flag". Paid-downvote
  ordering enforced here.
- `caps_get(id)` → full row: schemas, detail, provenance, curated notes.
- `caps_report(roster)` → census upsert (rosters + failure reports); idempotent.
- `caps_refresh(lane?)` → trigger crawl/index refresh; returns a report.

Naming note: the CLI namespace `bridge catalog …` is TAKEN by the OpenRouter model catalog
(`src/catalog.ts` + `src/cli.ts`) — DO NOT touch it. Caps uses `bridge caps …` CLI and `caps_*`
tool names.

## 6. Refresh runtime

- CLI: `bridge caps refresh` (+ `status`, `search`, `backfill`) in the v2 CLI or a new
  `src/caps/cli.ts` entry — Codex picks placement consistent with build (`tsc` → `dist/`).
- **Daily schedule: Windows Task Scheduler → PowerShell wrapper → node dist entry.** Mirror the
  existing model-catalog 06/14/22 pattern (verify those entries while there). Must run with no
  model/session available (reflex).
- Post-refresh: drop a **judgment job into the mailbox antigravity lane** (existing
  `provider.antigravity.mcp`, v3 contract shapes) carrying the day's diff (new arrivals, status
  flips, watch-count deltas) + pointer to the needs profile. AGY judges "immediate need",
  verdicts return via normal mailbox completion with receipts; verdicts (model, timestamp,
  verdict, reason) land in AVAILABLE.md and on the rows.
- Per-prompt lane (separate, later package): prompt-router consults `caps_search`; in-session
  model judges; proposes installs — keyless proposable, paid/keyed ask-first; installs are
  ALWAYS owner-confirmed actions, never automatic.

## 7. Projections (files stay; DB is authority)

- `~/.claude/skills/capability-catalog/CATALOG.md` — INSTALLED projection. Machine content only
  inside `<!-- bridge:caps:generated:begin/end -->` markers (append block if absent). Everything
  outside markers, and curated_notes, are owner content — NEVER rewritten. Backup before write.
- `~/.claude/skills/capability-catalog/AVAILABLE.md` — fully generated: new-since-yesterday
  (servers + skills), watch-domain counts + deltas, AGY verdicts, broken-list summary, fetch log.
  Free listed before paid always (reflex above).

## 8. Enforcement rules (minimum set — Codex extends per package)

- No credentials stored, ever; no public endpoint/tunnel/cloud (ADR 0009 doctrine holds).
- Idempotent upserts; atomic writes (temp+rename); backup before touching any owner file.
- Provenance + staleness stamps on every row; catalog answers are hints — only probe/census
  evidence changes status.
- Paid-downvote is a code reflex (see §3) — not model-overridable.
- No new npm dependencies without listing them in the package .md; nothing paid.
- AGY must follow the Bridge protocol: `bridge_claim` before edits, `bridge_log` + release after;
  no-touch zones: `.connector/`, `src/catalog.ts` (model catalog), the mailbox v3 stream except
  where a package explicitly grants a file.
- Tests per repo patterns: `node --test` suites + contract-style fixtures (offline: config
  parsing, marker splice, sitemap diff, paid-downvote ordering); `npm run build` clean under
  strict tsc. Each package ships acceptance criteria + exact verification commands.

## 9. Open items for Codex during decomposition

1. FTS5 availability under `node:sqlite` (extend `test/contract/node-sqlite.mjs` finding; LIKE
   fallback is acceptable at 10k rows).
2. Verify the existing 06/14/22 scheduled tasks; register the caps daily task alongside.
3. Needs-profile file location + format for the judgment lane (seed from
   `capability-catalog/CATALOG.md` Gaps section G2–G5).
4. Exact mailbox judgment-job payload under the v3 contract (Codex owns contract fit).
5. Sequencing vs v3 migration and the ClickUp task — Codex holds control and decides order.

## Appendix — mcpservers.org scan facts (2026-07-23, live-fetched)

10,139 servers stated at `/all`; 15 categories (Development 2,979 … Cloud Storage 53); 32 topics;
562 official; 256 curated remote; working search endpoint `/search?page=1&query=…` with stated
totals; sitemap chain `sitemap.xml → servers/1..6.xml, skills.xml`; default sort newest-first;
separate `/agent-skills/<author>/<slug>` skills library; sponsor rows pinned sitewide (exclude);
`/all?q=` and `?category=` params are non-functional. Full scan in session record 2026-07-23.
