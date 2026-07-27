# Registry routing — staged for the global systems-registry

Paste the two `###` blocks below into `~/.claude/registry/systems-registry.md` under **## Systems**,
and add the two routing-hint lines. Left staged (not auto-applied) because that file is your global,
all-projects system-of-record. These surfaces are **transport variants** of existing participants —
the *model* is the same, the *wire* is a Claude-in-Chrome owned tab.

```md
### chatgpt-web — ChatGPT (web, owned tab) — UI-only capabilities
- Surface: **`chatgpt`** (independent participant; Code attributes its output back by this surface).
- Strengths: **Deep Research** (no API equivalent), Canvas, code-interpreter file outputs, warm
  per-thread context across loop rounds.
- Dispatch: Claude-in-Chrome owned tab via `connectors/chatgpt/` (playbook + manifest + injectable driver).
- Reliability: dispatch MEDIUM (DOM/anti-bot fragility; settle-detection dependent); analysis HIGH.
- Availability: Chrome connected + signed in to chatgpt.com.

### gemini-web — Gemini (web, owned tab) — CLI fallback + UI-only
- Surface: **`gemini`** (same surface as the API/CLI participant; this is its browser transport).
- Strengths: Gemini Deep Research, Canvas, native multimodal; **fallback when the Gemini CLI is down**.
- Dispatch: Claude-in-Chrome owned tab via `connectors/gemini/`. Code tries CLI first, falls back here.
- Reliability: dispatch MEDIUM; analysis HIGH.
- Availability: Chrome connected + signed in to gemini.google.com.
```

Add to **## Routing hints**:

```md
- chatgpt-web → Deep Research reports, Canvas artifacts, UI-only ChatGPT capabilities.
- gemini-web  → Gemini Deep Research / multimodal; automatic fallback for a failed Gemini CLI call.
```

## Reconcile weighting (your call)

Both are UI-scraped, so weight them on **verifiable content**, not surface. The genuine policy
decision is `mergeWeight(surface, claim)` — how a sourced Deep Research claim counts vs. a CLI
answer, and how any low-trust/outlier surface is *quarantined rather than averaged* into the master.
Encode it where Code synthesizes; this file just declares the surfaces exist.
