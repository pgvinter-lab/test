# ADR-0003 — GTM tool configuration matrix (supersedes 0001, 0002)

- **Status:** Proposed
- **Date:** 2026-07-20
- **Task:** t-20260720-gtm-tool-routing
- **Actor:** cowork
- **Supersedes:** ADR-0001, ADR-0002 (both narrower single-variant drafts).

Optimization axes (cost is **not** one — everything runs on bundled subscriptions):

- **Q — Quality of work** (accuracy, depth, defensible sourcing, on-methodology copy)
- **S — Speed** (end-to-end throughput per account/segment)
- **M — Maintenance simplicity** (ease of updating, reconfiguring, fewest moving parts)

Deliverable: **4 versions × 3 options = 12 configs.** Versions = which tools are
available. Options = which axis is prioritized.

---

## Part A — Tool profiles (verified 2026-07-20)

| Tool | Real strengths | Real weaknesses | Natural roles here |
|------|----------------|-----------------|--------------------|
| **Claude Code** | Correctness; skills/hooks/MCP/**deterministic workflows**; subagents; runs headless/CI/anywhere | Terminal (not for non-devs); one-task depth | Qualify/score, orchestration glue, high-quality drafting, build (judgment) |
| **Claude Cowork** | Same engine as Claude Code, **desktop GUI + computer-use** (screen/mouse/browse/operate apps), builds docs/sheets/decks, MCP connectors, parallel subagents | **Machine-bound** (needs the desktop on; not headless/always-on) | Polished deliverables (dossiers/decks), computer-use enrichment on no-API portals, human review surface |
| **Codex** | **Parallel async** (cloud sandboxes → PRs); local CLI is a full agent (net+MCP+tools); **Agents SDK** for deterministic pipelines; codebase depth; test-iterate | Cloud default is no-net (must enable); shines on code/automation | Build/maintain (PR factory), scheduled data-processing/enrichment jobs, automation backbone |
| **ChatGPT / GPT** | Strong reasoning + copy; **Deep Research** (analyst reports); custom GPTs; connectors | DR rate-limited; self-reported citations (verify); less automation-customizable than Claude Code | Co-primary drafting, 2nd model in qualification panel, public-web segment research, human-facing custom GPTs |
| **Antigravity (+Gemini)** | **Agent Manager** (parallel async agents); **Artifacts** = task lists/plans/**screenshots/browser recordings** as proof; browser+terminal+editor; model-optional; `agy` CLI does **cited deep web research**; free | Another orchestrator (overlap risk); IDE GUI for interactive; model-labeling skepticism | Browser-driven enrichment+verification (Artifacts as evidence), **Gemini deep research**, app UI build, parallel fan-out |
| **Perplexity** | Fast, cited, real-time web; Sonar **API** for high-volume | **Quality rated low in your testing**; extra vendor; Comet no Linux | Per-account enrichment (only with quality controls) |
| **ClickUp (+Brain)** | Pipeline/CRM spine; custom fields; automations; webhooks; API; **Brain** triage (bundled) | Not git/auditable; external dep; sync-drift risk | Pipeline tracking, tasks/reminders, human cockpit, MEDDPICC/Sandler/Challenger fields |

**GTM roles (rows used below):** Source · Enrich · Challenger insight · Qualify/Gate
(MEDDPICC+Sandler) · Draft · Send (human-gated) · Track/Cockpit · Build/Maintain ·
Orchestrator (the single conductor — never let two tools conduct).

**Methodology layering (constant across all 12):** Challenger = how you open (insight);
Sandler = how you converse + gate (upfront contracts, pain funnel, disqualify);
MEDDPICC = the scorecard you record/inspect.

---

## Part B — The 12 configs

Each version: a role→tool table (Q / S / M columns), then an axis-score line and what
changes vs V1.

### Version 1 — ALL TOOLS

| Role | Q (Quality-first) | S (Speed-first) | M (Maintenance-simple) |
|------|-------------------|-----------------|------------------------|
| Source | Antigravity `agy` + GPT DR → Claude Code ICP-dedup | Antigravity Agent Manager parallel discovery + Perplexity bulk | Perplexity (or `agy`) single pass |
| Enrich | Perplexity **+** Antigravity browser Artifacts **+** Claude validation | Perplexity API only | Perplexity API, one call/account |
| Challenger insight | GPT DR **+** Gemini(`agy`) DR → Claude synthesizes reframe | Single GPT DR/segment | GPT DR/segment |
| Qualify/Gate | **Claude Code + GPT panel** (2-model) | Claude Code single-model, fast | Claude Code single-model |
| Draft | Claude Code primary + GPT challenger (A/B) | GPT templated at volume | Claude Code (or Cowork) one pass |
| Send (gated) | Human; Cowork builds the dossier/deck | Human, batch via ClickUp | Human via ClickUp |
| Track/Cockpit | ClickUp + Brain | ClickUp + automations | ClickUp |
| Build/Maintain | Codex PRs + Claude Code judgment + Antigravity UI | Codex cloud parallel PRs | Claude Code only |
| Orchestrator | Claude Code (Bridge) conducts; Antigravity/Codex fan out *within* tasks | Antigravity Agent Manager | Claude Code |

Axis scores — **Q:** Quality **H** / Speed L–M / Maint **L**. **S:** Speed **H** / Quality M / Maint M. **M:** Maint **H** / Quality M / Speed M.
**Pick:** Q for landing named target accounts; S for wide top-of-funnel sweeps; M if you'll be reconfiguring often.

### Version 2 — ALL MINUS PERPLEXITY

Enrichment reroutes to in-stack web (likely a quality upgrade per your Perplexity read).

| Role | Q | S | M |
|------|---|---|---|
| Source | Antigravity `agy` + GPT DR → Claude ICP-dedup | Antigravity Agent Manager parallel | Antigravity `agy` single pass |
| Enrich | **Antigravity `agy` (Gemini, cited) + Claude Code WebSearch cross-check** | Antigravity `agy` only | Claude Code WebSearch (or Cowork browse) |
| Challenger insight | GPT DR + Gemini(`agy`) DR → Claude synthesis | GPT DR/segment | GPT DR/segment |
| Qualify/Gate | Claude Code + GPT panel | Claude Code single | Claude Code single |
| Draft | Claude Code + GPT challenger | GPT templated | Claude Code |
| Send | Human; Cowork dossier | Human batch | Human |
| Track/Cockpit | ClickUp + Brain | ClickUp | ClickUp |
| Build/Maintain | Codex + Claude Code + Antigravity | Codex cloud | Claude Code |
| Orchestrator | Claude Code | Antigravity Agent Manager | Claude Code |

Axis scores — **Q:** Quality **H** / Speed M / Maint M (one fewer vendor). **S:** Speed **H** / Quality M / Maint M. **M:** Maint **H** / Quality M / Speed M.
**Lost vs V1:** the single cheap high-volume enrichment call; gained a two-engine cross-check and one fewer integration. **This is the recommended version** given the Perplexity quality signal.

### Version 3 — ALL MINUS CLICKUP

Cockpit/pipeline moves to app-native + generated views.

| Role | Q | S | M |
|------|---|---|---|
| Source | Antigravity `agy` + GPT DR → Claude ICP-dedup | Antigravity parallel + Perplexity | Perplexity/`agy` single |
| Enrich | Perplexity + Antigravity Artifacts + Claude | Perplexity API | Perplexity API |
| Challenger insight | GPT DR + Gemini DR → Claude | GPT DR | GPT DR |
| Qualify/Gate | Claude Code + GPT panel | Claude Code single | Claude Code single |
| Draft | Claude Code + GPT challenger | GPT templated | Claude Code |
| Send | Human; **Cowork builds the dossier/deck** | Human batch | Human |
| Track/Cockpit | **App DB + Claude-generated dashboard; Cowork builds a live pipeline spreadsheet**; GitHub Projects as light board | App DB + GitHub Projects | **App DB only** (single source, minimal) |
| Build/Maintain | Codex + Claude Code + Antigravity | Codex cloud | Claude Code |
| Orchestrator | Claude Code | Antigravity | Claude Code |

Axis scores — **Q:** Quality **H** / Speed M / Maint M. **S:** Speed **H** / Quality M / Maint M. **M:** Maint **H** (fewest surfaces) / Quality M / Speed M.
**Lost vs V1:** the ready-made board, mobile cockpit, Brain triage, no-code automations — now app work or Cowork-generated views. **Trade:** app DB is already canonical, so you lose the *human UI*, not the data.

### Version 4 — ALL MINUS PERPLEXITY & CLICKUP

Both substitutions combined — the leanest external-vendor footprint (only your own subscriptions' native agents).

| Role | Q | S | M |
|------|---|---|---|
| Source | Antigravity `agy` + GPT DR → Claude ICP-dedup | Antigravity Agent Manager parallel | Antigravity `agy` single |
| Enrich | **Antigravity `agy` + Claude Code WebSearch cross-check** | Antigravity `agy` | Claude Code WebSearch (or Cowork browse) |
| Challenger insight | GPT DR + Gemini(`agy`) DR → Claude | GPT DR | GPT DR |
| Qualify/Gate | Claude Code + GPT panel | Claude Code single | Claude Code single |
| Draft | Claude Code + GPT challenger | GPT templated | Claude Code |
| Send | Human; Cowork dossier/deck | Human batch | Human |
| Track/Cockpit | App DB + Claude dashboard; Cowork pipeline sheet | App DB + GitHub Projects | App DB only |
| Build/Maintain | Codex + Claude Code + Antigravity | Codex cloud | Claude Code |
| Orchestrator | Claude Code | Antigravity | Claude Code |

Axis scores — **Q:** Quality **H** / Speed M / Maint **M–H**. **S:** Speed **H** / Quality M / Maint M. **M:** Maint **H** (leanest possible) / Quality M / Speed M.
**Lost vs V1:** both the cheap enrichment call *and* the ready cockpit. **Gained:** everything lives inside the tools you already run (Claude/Codex/Antigravity/GPT) + the app — nothing external to babysit. Highest reconfigurability.

---

## Part C — Recommendation

1. **Adopt Version 2 (minus Perplexity), Quality option**, as the primary running config:
   enrichment via Antigravity `agy` (Gemini, cited) cross-checked by Claude Code; a
   Claude+GPT qualification panel; Claude-primary drafting with a GPT challenger; ClickUp
   as the cockpit; Codex as the build/automation backbone. It scores Quality **H** with
   Maintenance **M** and drops the one tool you rated low — best quality-per-unit-effort.
2. **Keep Version 4 as the fallback** if you decide to shed external surfaces (Perplexity
   *and* ClickUp) — it's the most reconfigurable and self-contained, at the cost of the
   human cockpit.
3. **Reach for the Speed option within a version** only for wide top-of-funnel sweeps; use
   the **Maintenance-simple option** during periods when you're actively rewiring the app.
4. **Invariants across all 12:**
   - **One orchestrator per config** — never let Antigravity, Codex, and Claude Code all
     conduct; pick one, the others fan out *inside* a task.
   - **App DB canonical; ClickUp (when present) is a projection.**
   - **Outward-action gate:** AI drafts/scores/enriches autonomously; a **human sends.**
     No LinkedIn scraping; warm the domain.
   - **Two-model steps (panel, A/B) exist to surface disagreement**, per PROTOCOL — not to
     average it away.

## Sources (verified 2026-07-20)

- Antigravity models/CLI: https://antigravity.google/docs/models · https://www.networkershome.com/blog/google-antigravity-guide/
- Antigravity `agy` deep research: https://github.com/MarcosNahuel/antigravity-plugin-cc
- Claude Cowork: https://www.anthropic.com/product/claude-cowork · https://support.claude.com/en/articles/13345190-get-started-with-claude-cowork
- Codex CLI/MCP/Agents SDK: https://developers.openai.com/codex/cli · https://developers.openai.com/codex/mcp · https://developers.openai.com/codex/guides/agents-sdk
