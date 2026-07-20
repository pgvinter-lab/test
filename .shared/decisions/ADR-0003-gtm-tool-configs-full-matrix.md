# ADR-0003 — GTM tool configuration matrix (supersedes 0001, 0002)

- **Status:** Proposed · **rebuilt on researched capability/performance evidence (2026-07-20)**
- **Task:** t-20260720-gtm-tool-routing
- **Actor:** cowork
- **Supersedes:** ADR-0001, ADR-0002.

Optimization axes (cost is **not** one — bundled subscriptions):
**Q** = quality of work · **S** = speed / throughput · **M** = maintenance simplicity.

Deliverable: **4 versions × 3 options = 12 configs.** Versions = which tools are available.
Options = which axis is prioritized. Decisions below rest on the researched evidence in
Part D — not inference. The Bridge treats Claude Code, Codex, and Antigravity as **peers**;
no orchestrator is privileged by incumbency.

---

## Part A — Tool profiles + verified benchmarks

**Agentic-coding benchmarks — last independently-verified generation (Nov 2025).** Newer
point releases each vendor ships have likely moved these; the many "2026" figures on SEO
blogs (GPT-5.6 "Sol" 96%, "Claude Fable 5" 95%, etc.) are **unverified and mutually
inconsistent** — not cited here.

| Conductor (default model) | SWE-bench Verified | Terminal-Bench 2.0 | Context | Native cross-family routing |
|---|---|---|---|---|
| **Claude Code** (Opus 4.5) | **80.9%** | **59.3%** | 200K | **No** (Anthropic only; others via MCP) |
| **Codex** (GPT-5.1-Codex-Max) | 77.9% | 58.1% | **400K + compaction** (24h+ autonomous) | **No** (GPT only; others via MCP) |
| **Antigravity** (Gemini 3 Pro) | 76.2% | 54.2% | **1M** | **Yes** — `agy --model` → Gemini/Claude/GPT-OSS |

| Tool | Strengths (verified) | Weaknesses (verified) | Role here |
|------|----------------------|-----------------------|-----------|
| **Claude Code** | Highest benchmark scores; **strongest first-party-documented orchestration** — deterministic workflows (docs: "hundreds of agents"), agent teams w/ **file-locked** shared task list, `/batch` 5–30 PR subagents, deepest hooks, headless `-p`, scheduled routines | No native non-Claude routing; agent teams still experimental | **Default conductor**, qualify/score, high-quality drafting |
| **Claude Cowork** | Same engine, desktop GUI; **computer-use** (screen/browse/operate apps); builds docs/sheets/decks; MCP connectors; subagents | Machine-bound (desktop must be on; not headless/always-on) | Polished dossiers/decks, no-API portal enrichment, human review |
| **Codex** | Parallel isolated sandboxes w/ **tiered network control** (read-only / workspace-write / full / allow-list); `codex mcp-server` + **Agents SDK** deterministic pipelines; **compaction → 24h+ long-horizon** | Single-vendor; orchestration lives in a separate SDK; field reports of instability past ~4 local parallel sessions | Build/maintain, scheduled enrichment/scoring jobs, long-horizon automation |
| **ChatGPT / GPT** | Strong reasoning/copy; Deep Research via Responses API (+ MCP/site-restrict) | **DR under-enumerates** (stops ~a couple dozen); self-reported citations | Draft co-primary, qualify panel (2nd model), per-segment research |
| **Antigravity (+Gemini)** | **Only native cross-family router**; Agent Manager (parallel isolated workspaces), `agy` CLI + Python/TS/Go SDK, **`/schedule` cron**, background tasks; headless (`--print`/`--headless`); 1M context; free | Headless-observability gap (self-admitted RFC); docs largely 3rd-party; provenance not independently confirmed; rocky launch | **Speed conductor** (parallel + fast-model routing), Gemini research, browser enrichment/verification, app UI |
| **Perplexity** | **Sonar API: JSON-schema structured output + inline citations** — best *structured cited enrichment* API of the set; SimpleQA F=0.858 | Rated low by you (likely the consumer app, not Sonar API); **does not enumerate** account lists; extra vendor | **Enrichment** (structured, cited) — not sourcing |
| **ClickUp (+Brain)** | Pipeline/CRM spine; custom fields; automations; webhooks; API; Brain triage | Not git-auditable; external dep; sync-drift | Pipeline, tasks, human cockpit, MEDDPICC/Sandler/Challenger fields |
| **Sourcing = LLM-native (your app)** | The app enumerates accounts with LLMs by design. Made robust with **parallel multi-angle grounded sweeps + loop-until-dry + a verification pass** — this beats the single-call "stops after a couple dozen" failure | **Recall ceiling + hallucination risk remain** — mitigated by breadth/iteration/verification, not eliminated | App owns the Source row; optional escape hatch if recall ever binds: LLM-operated directory scrape (Antigravity browser / Cowork) or a data-provider MCP |

**Methodology layering (constant):** Challenger opens (insight) · Sandler runs the
conversation + gates · MEDDPICC is the recorded scorecard.

---

## Part B — The 12 configs

**Roles:** Source · Enrich · Challenger insight · Qualify/Gate · Draft · Send (gated) ·
Track/Cockpit · Build/Maintain · Orchestrator.

**Source is the same across Q/S/M within a version.** The app enumerates with LLMs — the
lever isn't which model but *how hard you sweep*: Q/S/M vary breadth (how many facets),
iteration (loop-until-dry vs one pass), and verification depth (anti-hallucination).

### Version 1 — ALL TOOLS

| Role | Q (Quality) | S (Speed) | M (Maint-simple) |
|------|-------------|-----------|------------------|
| Source | **Parallel multi-angle `agy` sweeps** (sub-vertical × geo × trigger) → **loop-until-dry** → Claude Code dedup + **verify (anti-hallucination)** | Few-facet single `agy` sweep, light dedup | One grounded query → Claude dedup |
| Enrich | **Perplexity Sonar (JSON-schema, cited)** + Antigravity browser Artifacts + Claude validation | Perplexity Sonar only | Perplexity Sonar, 1 call/acct |
| Challenger insight | GPT DR + Gemini(`agy`) DR → Claude reframe | Single GPT DR/segment | GPT DR/segment |
| Qualify/Gate | **Claude Code + GPT panel** | Claude Code single | Claude Code single |
| Draft | Claude Code + GPT challenger (A/B) | GPT templated | Claude Code / Cowork |
| Send · gated | Human; Cowork dossier/deck | Human, batch via ClickUp | Human via ClickUp |
| Track/Cockpit | ClickUp + Brain | ClickUp + automations | ClickUp |
| Build/Maintain | Codex PRs + Claude Code + Antigravity UI | Codex cloud parallel | Claude Code only |
| **Orchestrator** | **Claude Code** — top benchmarks + strongest documented orchestration + hook quality-gates; Codex/`agy` wrapped as MCP servers | **Antigravity `agy`** — native parallel + routes each subtask to the fastest fit; Claude/Codex as MCP peers | **Claude Code** — strongest single-tool first-party story, fewest parts |

Axis shape — **Q:** Quality **H** / Speed M / Maint L · **S:** Speed **H** / Quality M / Maint M · **M:** Maint **H** / Quality M / Speed M.

### Version 2 — MINUS PERPLEXITY  ·  ★ recommended

Enrichment loses the best structured-cited API → reroute to `agy`/Gemini + a Claude extraction/validation pass (Gemini DR can't emit structured output natively, so Claude does the schema step).

| Role | Q | S | M |
|------|---|---|---|
| Source | **Parallel multi-angle `agy` sweeps** → **loop-until-dry** → Claude Code dedup + **verify (anti-hallucination)** | Few-facet single `agy` sweep, light dedup | One grounded query → Claude dedup |
| Enrich | **`agy` (Gemini, cited) + Claude Code WebSearch cross-check + Claude schema-extract** | `agy` only | Claude Code WebSearch / Cowork browse |
| Challenger insight | GPT DR + Gemini(`agy`) DR → Claude | Single GPT DR | GPT DR |
| Qualify/Gate | Claude Code + GPT panel | Claude Code single | Claude Code single |
| Draft | Claude Code + GPT challenger | GPT templated | Claude Code |
| Send · gated | Human; Cowork dossier | Human, batch | Human |
| Track/Cockpit | ClickUp + Brain | ClickUp | ClickUp |
| Build/Maintain | Codex + Claude Code + Antigravity | Codex cloud | Claude Code |
| **Orchestrator** | **Claude Code** (Codex/`agy` as MCP peers) | **Antigravity `agy`** (Claude/Codex as MCP peers) | **Claude Code** |

**Lost vs V1:** Sonar's structured-cited enrichment API — replaced by `agy` + a Claude schema pass (more orchestration, one fewer vendor). **Recommended** given your Perplexity read — but see the Part C nuance before dropping Sonar blind.

### Version 3 — MINUS CLICKUP

Cockpit → app-native. You lose the human UI, not the data (app DB was canonical anyway).

| Role | Q | S | M |
|------|---|---|---|
| Source | **Parallel multi-angle `agy` sweeps** → **loop-until-dry** → Claude Code dedup + **verify (anti-hallucination)** | Few-facet single `agy` sweep, light dedup | One grounded query → Claude dedup |
| Enrich | Perplexity Sonar + Antigravity Artifacts + Claude | Perplexity Sonar | Perplexity Sonar |
| Challenger insight | GPT DR + Gemini DR → Claude | GPT DR | GPT DR |
| Qualify/Gate | Claude Code + GPT panel | Claude Code single | Claude Code single |
| Draft | Claude Code + GPT challenger | GPT templated | Claude Code |
| Send · gated | Human; **Cowork builds dossier/deck** | Human, batch | Human |
| Track/Cockpit | **App DB + Claude dashboard; Cowork pipeline sheet; GitHub Projects** | App DB + GitHub Projects | **App DB only** |
| Build/Maintain | Codex + Claude Code + Antigravity | Codex cloud | Claude Code |
| **Orchestrator** | **Claude Code** | **Antigravity `agy`** | **Claude Code** |

### Version 4 — MINUS PERPLEXITY & CLICKUP

Leanest footprint — everything inside tools you already run + the app + a source provider.

| Role | Q | S | M |
|------|---|---|---|
| Source | **Parallel multi-angle `agy` sweeps** → **loop-until-dry** → Claude Code dedup + **verify (anti-hallucination)** | Few-facet single `agy` sweep, light dedup | One grounded query → Claude dedup |
| Enrich | **`agy` (Gemini) + Claude Code WebSearch cross-check + Claude schema-extract** | `agy` only | Claude Code WebSearch / Cowork browse |
| Challenger insight | GPT DR + Gemini(`agy`) DR → Claude | GPT DR | GPT DR |
| Qualify/Gate | Claude Code + GPT panel | Claude Code single | Claude Code single |
| Draft | Claude Code + GPT challenger | GPT templated | Claude Code |
| Send · gated | Human; Cowork dossier/deck | Human, batch | Human |
| Track/Cockpit | App DB + Claude dashboard; Cowork sheet | App DB + GitHub Projects | App DB only |
| Build/Maintain | Codex + Claude Code + Antigravity | Codex cloud | Claude Code |
| **Orchestrator** | **Claude Code** | **Antigravity `agy`** | **Claude Code** |

---

## Part C — Recommendation

1. **Adopt Version 2 · Quality option** as primary: **Claude Code as conductor** (highest
   verified benchmarks + strongest documented orchestration + file-locked task list +
   hook quality-gates), with **Codex and `agy` exposed to it as MCP servers** so all three
   act as peers — cross-family reach via the documented MCP primitive, not a native router.
   Enrichment via `agy`/Gemini + a Claude schema/validation pass; Claude+GPT qualify panel;
   Claude-primary drafting with GPT challenger; ClickUp cockpit; Codex build/automation backbone.
2. **Switch the conductor to Antigravity `agy` only if native cross-family routing becomes a
   hard requirement** — it's the one tool that dispatches Gemini/Claude/GPT natively. Cost:
   its headless-observability story is least mature and least battle-tested.
3. **Two evidence-driven corrections you should act on regardless of version:**
   - **Harden LLM-native sourcing.** The app sources with LLMs by design; the recall
     ceiling is real but engineerable. Make Source a **parallel multi-angle grounded sweep
     + loop-until-dry + a verification pass** (each candidate confirmed to exist and match
     ICP, killing hallucinations) — that is the single biggest quality lever in the system.
     Escape hatch if recall ever binds: an LLM-operated directory scrape (Antigravity
     browser / Cowork) or a data-provider MCP — optional, not required.
   - **Re-test Perplexity before dropping it.** Your low rating was likely the consumer app;
     the **Sonar API supports JSON-schema structured output + citations**, which is the
     *best structured-cited enrichment API* in the set. If a quick Sonar-API test holds up,
     V1/V3 keep an enrichment engine that V2/V4 have to reconstruct with a Claude schema pass.
4. **Invariants across all 12:**
   - **One conductor; the other two agents wrapped as MCP servers** (both `codex mcp-server`
     and `agy` are built for this) — the peer-honoring pattern.
   - **App DB canonical; ClickUp (when present) is a projection.**
   - **Outward-action gate:** AI sources/enriches/scores/drafts; a **human sends.** No LinkedIn scraping; warm the domain.
   - **Two-model steps surface disagreement** (per PROTOCOL), not to average it away.

---

## Part D — Evidence (researched 2026-07-20)

**Orchestrators:** Opus 4.5 SWE-bench Verified 80.9% / Terminal-Bench 2.0 59.3% (200K);
GPT-5.1-Codex-Max 77.9% / 58.1% (400K + compaction, documented 24h+ task); Gemini 3 Pro
76.2% / 54.2% (1M). Native cross-family routing: Antigravity only (`agy --model`); Claude
Code & Codex single-vendor, reach others via MCP-server wrapping (`codex mcp-server`, `agy`).
No vendor publishes a hard concurrent-agent cap (all gate on rate limits). Claude Code has
the only official *deterministic workflows* docs page; Codex's orchestration is in the
separate Agents SDK; `agy` has a self-filed headless-observability RFC.

**Sourcing:** In a list-building eval, GPT Deep Research "often stops after a couple dozen";
Gemini ~16/query; vs Exa Websets 66 (low) / 320 (high). Gemini DR can't emit structured
output natively (needs a second extraction call). Perplexity Sonar supports JSON-schema +
citations but its accuracy lead is single-fact QA, not list recall. → **because the app is
LLM-native, the fix is engineering, not a vendor:** parallel multi-angle grounded sweeps +
loop-until-dry + a verification pass raise recall and kill hallucinations; a data provider
stays an optional escape hatch.

### Sources
- Claude Code workflows / agent-teams / hooks: https://code.claude.com/docs/en/workflows · https://code.claude.com/docs/en/agent-teams · https://code.claude.com/docs/en/hooks
- Opus 4.5: https://www.anthropic.com/news/claude-opus-4-5 · Gemini 3: https://blog.google/innovation-and-ai/technology/developers-tools/gemini-3-developers/ · GPT-5.1-Codex-Max: https://openai.com/index/gpt-5-1-codex-max/ · https://venturebeat.com/technology/openai-debuts-gpt-5-1-codex-max-coding-model-and-it-already-completed-a-24
- Codex subagents / Agents SDK / MCP-server: https://developers.openai.com/codex/subagents · https://developers.openai.com/codex/guides/agents-sdk · https://developers.openai.com/cookbook/examples/codex/codex_mcp_agents_sdk/building_consistent_workflows_codex_cli_agents_sdk
- `agy` CLI/CHANGELOG: https://github.com/google-antigravity/antigravity-cli · agy↔MCP bridge: https://github.com/davdittrich/delegate-agy
- Claude Code cross-family routing is not native (feature request): https://github.com/anthropics/claude-code/issues/34821
- Sourcing eval + providers: https://exa.ai/blog/websets-evals · https://ai.google.dev/gemini-api/docs/deep-research · https://www.cleanlist.ai/blog/2026-03-07-apollo-vs-zoominfo
- Perplexity Sonar structured output: https://community.perplexity.ai/t/structured-output-json-schema-support/73

**Residual unverified:** later model point-releases' benchmarks; exact concurrency caps;
Antigravity GitHub org's official Google provenance; a *named* `agy` "deep research" command.
