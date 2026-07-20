# ADR-0002 — GTM tool routing (Variant B: WITHOUT Perplexity) — RECOMMENDED

- **Status:** Proposed (recommended over ADR-0001)
- **Date:** 2026-07-20
- **Task:** t-20260720-gtm-tool-routing
- **Actor:** cowork
- **Sibling:** ADR-0001 (Variant A — WITH Perplexity).

> Recommended because Perplexity output quality tested **low**, and the enrichment slot
> can be rerouted to **in-stack Google/Claude grounding** — likely a quality *upgrade*
> (Gemini 3 + Google's index) with **one fewer vendor** to run.

---

## Context

Identical to ADR-0001 (same app, same two loops, same Challenger/Sandler/MEDDPICC
layering). The only thing that changes is the **enrichment engine** and the tool
inventory: Perplexity is dropped.

## Decision — routing table

| Pipeline stage | Tool | Rationale |
|----------------|------|-----------|
| **Source** target accounts | App + **Gemini API (Google Search grounding)** | Fast, cited, high-volume ICP signal detection on Google's index |
| **Enrich** per-account intel | **Gemini grounded search** (primary) + **Claude web search** (synthesis) | In-stack, cited (`groundingMetadata`), high-volume; Claude reasons over the evidence |
| **No-API / gated sources** | **Antigravity browser agents** | Navigate + screenshot sites with no API; Artifacts as proof (use sparingly — slow) |
| **Segment insight** (Challenger) | **Gemini DR** (Drive-grounded) / **GPT DR** (public) | Low-volume deep research; one insight per *segment* |
| **Score + qualify** (MEDDPICC/Sandler) | **Claude Code** | Reasoning over the frameworks; flag gaps; disqualify weak fits |
| **Draft outreach** (Challenger msg) | **Claude** | Nuanced, on-methodology copy per persona/channel |
| **Pipeline + tasks + cockpit** | **ClickUp** | Stages, reminders, dashboards, approvals; Brain for triage |
| **Build/harden the app** | **Codex** + **Claude Code** + **Antigravity** | The build loop |

## Enrichment layer (the differentiator vs Variant A)

**Primary engine:** **Gemini API with Google Search grounding** (`google_search` tool).
Returns grounded answers plus `groundingMetadata` (source URIs) — the direct Perplexity-
Sonar analog, riding Google's index with a Gemini 3 model. Fast and high-volume.

**Synthesis + validation:** **Claude** (Claude Code `WebSearch`/`WebFetch`, or the Claude
API web-search tool). Claude orchestrates enrichment: calls Gemini-grounding as a sub-step,
then reasons over and validates the evidence before writing the record. This gives you a
**two-model cross-check** on every account — the disagreement between them is itself signal.

**No-API / login-gated sources:** **Antigravity browser agents** — navigate, extract,
screenshot; WebP-recording Artifacts as proof of work. Reserve for sources that have no
API and matter enough to justify the latency.

**Optional out-of-stack upgrade:** a purpose-built agentic-search API (e.g. Exa or Tavily)
if you later want retrieval tuned for enrichment volume. Not required — noted so the slot
is a clean seam, not a rewrite.

**Enrichment output schema:** identical to ADR-0001 (same JSON contract, same
`source_url`-per-field requirement), so the downstream scorer and ClickUp mapping do not
change between variants. Only the producer behind the seam differs.

## Why this likely beats Variant A on quality

- **Better index + model** — Google Search grounding + Gemini 3 vs Sonar's retrieval.
- **Built-in cross-check** — Gemini gathers, Claude validates; two vendors disagreeing on a
  fact surfaces bad data instead of laundering it (the PROTOCOL's "preserve disagreement").
- **Fewer moving parts** — no extra vendor, key, or egress dependency.
- **Same seam** — if it underperforms, the enrichment interface is unchanged, so swapping in
  Exa/Tavily (or back to Perplexity) is a config change, not a refactor.

## Methodology → ClickUp schema

Identical to ADR-0001 (Space/Lists/statuses, MEDDPICC 8-field + Sandler-gate + Challenger
custom fields, automations, Brain-as-triage). Unchanged by dropping Perplexity.

## Volume / cost rule

- **Gemini grounded search = per-account** (high volume, real-time).
- **Deep Research = per-segment** (a handful/mo; never per account).
- **Claude = reasoning/copy/validation** over both.
- **Antigravity browser = exception path** for no-API sources only.

## System of record + the one gate

Identical to ADR-0001: **App DB canonical, ClickUp projection, git canonical for code.**
**Outward-action gate** on all outreach — AI drafts/scores, a human sends. No LinkedIn
scraping. Warm the domain.

## Consequences

- (+) Likely higher enrichment quality; two-model cross-check per account.
- (+) One fewer vendor; enrichment stays inside the existing model stack.
- (+) Clean seam — provider swap is config, not refactor.
- (−) Gemini grounding + Claude validation is a two-call path (slightly more orchestration
  than one Perplexity call) — mitigated by caching and trigger-based re-enrichment.
- (−) Heavy reliance on Google/Anthropic; no independent third search vendor unless the
  optional Exa/Tavily upgrade is taken.
