# ADR-0001 — GTM tool routing (Variant A: WITH Perplexity)

- **Status:** Superseded by ADR-0003
- **Date:** 2026-07-20
- **Task:** t-20260720-gtm-tool-routing
- **Actor:** cowork
- **Sibling:** ADR-0002 (Variant B — WITHOUT Perplexity). Pick one to adopt.

> Two variants exist because Perplexity output quality was rated **low** in testing.
> This variant keeps Perplexity but adds quality controls. If those controls do not
> lift quality, adopt ADR-0002, which reroutes the same slot to in-stack grounding.

---

## Context

The product is a prospecting/marketing app that (1) searches for target accounts and
(2) runs a hybrid **Challenger / MEDDPICC / Sandler** motion to sell an AI-consulting
service. Available tools: **Claude Code, Codex, Antigravity, Perplexity, ClickUp**
(+ GPT and Gemini Deep Research).

Two loops must be kept separate:

- **Build loop** — improving the app (code). Git-canonical.
- **Run loop** — operating the sales motion (research → insight → qualify → engage → track).
  App-DB-canonical, ClickUp as the human cockpit.

The three methodologies are **layers, not rivals**:

| Layer | Methodology | Governs |
|-------|-------------|---------|
| Open | Challenger | The tailored commercial insight that reframes the prospect's status quo |
| Converse | Sandler | Upfront contracts, pain funnel, disqualify fast, no free consulting |
| Inspect | MEDDPICC | The deal scorecard you record and pressure-test |

## Decision — routing table

| Pipeline stage | Tool | Rationale |
|----------------|------|-----------|
| **Source** target accounts | App + **Perplexity Sonar API** | Real-time, cited, high-volume ICP signal detection |
| **Enrich** per-account intel | **Perplexity Sonar API** | Per-account, high-volume, cheap; sourced evidence → MEDDPICC/Sandler |
| **Segment insight** (Challenger) | **Gemini DR** (Drive-grounded) / **GPT DR** (public) | Low-volume deep research; one insight per *segment*, reused across accounts |
| **Score + qualify** (MEDDPICC/Sandler) | **Claude Code** | Reasoning over the frameworks; flag gaps; disqualify weak fits |
| **Draft outreach** (Challenger msg) | **Claude** | Nuanced, on-methodology copy per persona/channel |
| **Browser-only data / proof** | **Antigravity** | Browser control + WebP-recording Artifacts as evidence |
| **Pipeline + tasks + cockpit** | **ClickUp** | Stages, reminders, dashboards, human approvals; Brain for triage |
| **Build/harden the app** | **Codex** (PR factory) + **Claude Code** (judgment) + **Antigravity** (UI) | The build loop |

## Enrichment layer (the differentiator vs Variant B)

**Engine:** Perplexity Sonar API, called per account at the Source/Enrich stages.

**Quality controls (because raw quality tested low):**
1. Use the **Sonar reasoning tier**, not the base model.
2. Constrain sourcing with **`search_domain_filter` / allowed-domains** to authoritative
   sources (company site, Crunchbase, LinkedIn company pages, reputable trade press);
   block content farms.
3. **Force structured extraction** — the prompt must return JSON with a fixed schema and a
   `source_url` per field; reject any field lacking a citation.
4. **Post-validate with Claude** — a cheap Claude pass checks each claim against its cited
   URL and drops/flag unsupported ones before the record is written. (This is the
   PROTOCOL's "summaries are pointers, not proof" rule, enforced.)
5. Cache per-account results; re-enrich only on a trigger (news/funding/role change).

**Enrichment output schema (per account):**
```json
{
  "account": "", "domain": "",
  "icp_fit_score": 0.0,
  "triggers": [{"type":"funding|hiring|launch|leadership","detail":"","source_url":""}],
  "tech_stack": [{"name":"","source_url":""}],
  "ai_readiness_signals": [{"signal":"","source_url":""}],
  "economic_buyer_guess": {"name":"","title":"","source_url":""},
  "competition": [{"name":"","source_url":""}],
  "pain_hypotheses": [{"pain":"","evidence":"","source_url":""}]
}
```

## Methodology → ClickUp schema (operational spine)

- **Space:** Prospecting → **Lists** per segment/campaign; each **account = a card**.
- **Statuses:** Sourced → Researched → Insight-ready → Engaged → Qualified → Opportunity → Won / Disqualified.
- **Custom fields:**
  - MEDDPICC (8): Metrics, Economic Buyer, Decision Criteria, Decision Process, Paper
    Process, Identified Pain, Champion, Competition.
  - Sandler gates: Upfront-Contract Set? (bool), Pain Quantified ($), Budget Confirmed,
    Timeline.
  - Challenger: Insight Hook, Reframe.
- **Automations:** follow-up reminders; stage-change → webhook to the app.
- **ClickUp Brain:** weekly pipeline digest, "deals with no Champion", "what's stalled".
  Triage lens only — not a source of truth.

## Volume / cost rule

- **Perplexity = per-account** (hundreds/mo, real-time).
- **Deep Research = per-segment** (a handful/mo — GPT DR ≈ 250/mo Pro; never per account).
- **Claude = reasoning/copy** over both.

## System of record + the one gate

- **App DB is canonical** for account data + methodology state. **ClickUp is a projection.**
  Git stays canonical for code.
- **Outward-action gate:** outreach is irreversible/outward-facing. AI drafts and scores
  autonomously; **a human presses send.** No LinkedIn scraping (ToS). Warm the domain.

## Consequences

- (+) Single cheap real-time citation engine for high-volume enrichment.
- (+) One prompt/integration for Source + Enrich.
- (−) Quality risk is real (observed); depends on the controls above holding.
- (−) One more vendor + API key + egress dependency to manage.
- If controls do not lift quality → adopt **ADR-0002**.
