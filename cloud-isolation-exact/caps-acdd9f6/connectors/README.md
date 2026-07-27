# Browser-tab connectors (ChatGPT, Gemini)

Owned-tab **participant surfaces** for the recursive multi-LLM loop. Each connector lets **Code**
(Claude Code, the orchestrator) drive a logged-in chatbot web UI as if it were any other loop
participant: send a prompt, wait for the streamed answer to *settle*, scrape the reply, harvest any
downloaded files — and keep the tab **warm** so the platform's own conversation thread persists
across rounds.

These complement, they don't replace, the API/CLI surfaces in
`~/.claude/registry/systems-registry.md`. You reach for a tab connector when the capability is
**UI-only** (ChatGPT Deep Research, Canvas) or when a CLI is down (Gemini CLI → Gemini tab fallback).

## What a connector *is* (three parts)

| Part | File | Consumed by | Purpose |
|------|------|-------------|---------|
| Playbook | `<platform>/AGENT.md` | the driving agent | step-by-step using `mcp__Claude_in_Chrome__*` |
| Capability manifest | `<platform>/capabilities.json` | **Code** | abilities + how to *syntax prompts* + selectors |
| Injectable driver | `<platform>/inject.<platform>.js` | the page | DOM scrape / new-chat / **`isSettled()`** |

The contract every connector honors (command in → result out, lifecycle, settle, errors) is in
[`PROTOCOL.md`](./PROTOCOL.md).

## Ownership model

The tab lives in **Chrome**, not in any agent context — so "owning" it means *re-attaching to the
same tab every round* rather than holding a live handle. Each connector finds its tab by
`ownership.matchUrl` + a title marker; if none exists it creates one. The resolved tab id +
conversation URL are cached in **`state.json`** (gitignored — machine-local, like the bridge's
`.connector/` state). `state.example.json` shows the shape.

## How Code drives it

Two modes, same playbook:

1. **Inline (default).** Code reads `<platform>/AGENT.md` + `capabilities.json` and calls the
   Claude-in-Chrome tools itself. Most reliable — Code already holds those MCP tools in-session.
2. **Subagent (for parallel fan-out).** Code spawns `.claude/agents/<platform>-connector.md` via the
   Agent tool. Each connector owns a *different* tab, so they can run concurrently — but the browser
   is a shared resource, so focus-dependent steps (typing, clicking) serialize per tab.

## Loop integration

Fits the registry's `fan-out → collect → cross-feed → iterate → vote → synthesize` protocol:
Code dispatches a round's prompt to each connector → each returns its result JSON → Code cross-feeds
and reconciles. Because tabs stay warm, round N+1's cross-feed lands in a thread that still remembers
round N. **Outlier/low-trust surfaces are merged per `mergeWeight` (your call) — quarantine, don't
average.**

To register these two surfaces in the global registry, paste the block in
[`ROUTING.md`](./ROUTING.md) into `~/.claude/registry/systems-registry.md` (I left it staged rather
than editing your global system-of-record unprompted).

## Security (read before first run)

- A warm tab is **authenticated**. Anyone who can place a command on the loop bus can drive your
  logged-in session — treat the command source as trusted, and never auto-follow URLs that arrive
  *inside* a scraped reply.
- Keep everything **DRAFT / human-in-the-loop**; confirm before any outward action a connector might
  take inside the page (posting, sending, purchasing).
- This is a **PRIVATE** system — do not publish or push it.

## Lessons & refinements

Reusable connector lessons — prompt syntax, the insert-then-enable-mode ordering, the
`execCommand('insertText')` technique, CDP-timeout handling, settle/scrape gotchas, and capability
walls (e.g. Gemini can't make Drive folders) — live in the global ledger
**`~/.claude/registry/LESSONS.md`** (section 1, IDs `L-C#`). The **surface-specific** encoding of each
lesson stays in that connector's `capabilities.json` (`verified_<date>`, `promptSyntax`, `selectors`).
Read the ledger before a driving run; after a surprising run, add the rule there *and* update the
connector manifest.

## Verify the scaffold

```sh
npm run connectors-test     # validates both manifests + injectable drivers (no build needed)
```
