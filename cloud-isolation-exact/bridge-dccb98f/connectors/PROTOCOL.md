# Connector protocol

The contract between **Code** (orchestrator) and a **connector** (owned-tab driver). Platform-neutral;
the per-platform specifics live in `<platform>/capabilities.json`.

## Command (Code → connector)

```jsonc
{
  "connector": "chatgpt" | "gemini",
  "action":    "submit" | "new_session" | "attach" | "status",
  "prompt":    "string",          // required for submit
  "mode":      "default",         // a key in capabilities.abilities (e.g. "deep_research")
  "session":   "current" | "new", // "new" opens a fresh chat first (default "current")
  "expectFiles": false,           // harvest downloads produced by this turn
  "timeoutMs": 600000,            // override per-mode default (Deep Research needs much more)
  "unattended": true              // auto-answer clarifying prompts with "proceed" vs. pause for human
}
```

## Result (connector → Code)

```jsonc
{
  "ok": true,
  "connector": "chatgpt",
  "text": "…assistant reply, scraped as markdown…",
  "files": [{ "name": "report.csv", "path": "C:\\Users\\example\\Downloads\\report.csv" }],
  "url": "https://chatgpt.com/c/abc-123",   // conversation permalink == thread identity (persist it)
  "mode": "deep_research",
  "settledBy": "signal" | "quiescence" | "timeout",
  "error": null
}
```

On failure: `{ "ok": false, "error": "<code>", ... }`. Error codes are a closed set so Code can route
a fallback deterministically:

| code | meaning | Code's move |
|------|---------|-------------|
| `login_required` | composer absent / login wall | surface to human; skip this surface this round |
| `blocked` | captcha / bot-check / rate limit | back off; try the CLI surface if one exists |
| `tab_lost` | owned tab closed or navigated away | re-`attach` once, then retry |
| `settle_timeout` | no settle within `timeoutMs` | return partial `text`; mark low-trust |
| `no_new_turn` | submit produced no new assistant message | retry once, then `blocked` |

## Lifecycle (one command)

```
DETACHED ─attach─▶ READY ─submit─▶ STREAMING ─isSettled()─▶ SETTLING ─scrape─▶ READY
                     │                                                            │
                     └────────────── new_session (fresh thread) ◀────────────────┘
```

## Settle contract (the load-bearing rule)

**Never scrape before the answer is complete.** The driver must:

1. `window.__CONN.mark()` *immediately before* sending — snapshots the current assistant-turn count
   so a *previous* reply can't be mistaken for the new one (the classic "scraped the last turn" bug).
2. Poll `window.__CONN.isSettled()` until `true` or `timeoutMs`.
3. Only then call `window.__CONN.lastText()`.

`isSettled()` is the one piece of genuine judgment — see the TODO in each `inject.<platform>.js`.

## Concurrency & the focus lease

One in-flight command **per connector** (serialize via a per-tab mailbox). Across connectors, split by
what the action touches:

- **DOM / tab-scoped** (`javascript_tool` with a `tabId`, `navigate`) — addressed per tab, no shared
  cursor → **run concurrently**. This is why the drivers are DOM-first (`insert`, `clickText`,
  `querySelector().click()`): semantic actions parallelize safely.
- **Focus actions** (`computer` click/type/screenshot) — one cursor, one foreground tab, one viewport
  → **serialize**. A connector must hold the **focus lease** before any `computer` action and release
  it immediately after. The lease lives in `state.json → focusLease {heldBy, since}` (stale after 60s),
  mirroring the bridge's file-lease primitive. DOM-level work needs no lease.

The parallelism win is in the **waiting**, not the clicking: a 20-min Deep Research run overlaps with
another connector's whole job. Fan out the (quick, focus-serialized) dispatch, then let the long waits
run concurrently and harvest each when `isSettled()`.

## Downloads

Clicking a download affordance lands the file in the **OS Downloads dir**. The connector reports the
expected name; Code resolves the actual path by taking the newest matching file in `~/Downloads`
(Windows: `%USERPROFILE%\Downloads`) and reads it with the host file tools.
