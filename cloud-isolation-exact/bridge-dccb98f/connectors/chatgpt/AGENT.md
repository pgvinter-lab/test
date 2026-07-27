# ChatGPT connector — playbook

Drive the owned ChatGPT tab through `mcp__Claude_in_Chrome__*`. Read
[`capabilities.json`](./capabilities.json) for abilities, prompt syntax, and selectors. Honor
[`../PROTOCOL.md`](../PROTOCOL.md) for the command/result shape. **Return only the result JSON.**

## 1. Attach (find-or-create the owned tab)

1. `list_connected_browsers` → confirm Chrome is connected; `select_browser` it.
2. `tabs_context_mcp` → find a tab whose URL matches `https://chatgpt.com/*`.
   - found → that's the owned tab; `switch_browser`/select it. Record its id in `../state.json`.
   - none → `tabs_create_mcp`, then `navigate` to `https://chatgpt.com/`. Record the new id.
3. Inject the driver: `javascript_tool` with the full contents of `inject.chatgpt.js`.
   - result `loggedIn:false` → return `{ ok:false, error:"login_required" }`.

## 2. New session (only if `session:"new"`)

`javascript_tool` → `window.__CONN.newChat()`, then re-inject `inject.chatgpt.js` (navigation clears
the globals). This gives a fresh thread; `session:"current"` keeps the warm thread (preferred mid-loop).

## 3. Select the ability / mode  (mechanism — for ordering see step 4)

Activate **DOM-first, no pixels** (verified 2026-06-25):
1. Open the tools menu: `document.querySelector(selectors.toolsBtn).click()` (aria "Add files and more").
2. Pick the item by text: `window.__CONN.clickText('Deep research')` — text-addressed, survives layout
   shifts (do NOT click fixed coordinates; the menu moves as the composer grows).
3. **Verify** it took before sending — confirm the mode pill is present; if not, reopen and retry.
Reserve coordinate clicks for an element that ignores a programmatic `.click()`.

## 4. Compose & send

> **Ordering + technique (verified 2026-06-25).** Insert the prompt FIRST, enable the mode SECOND, send THIRD — `selectAll`+`insertText` clears the active Deep Research tool, so the mode must be turned on *after* text is in. Insert with `window.__CONN.insert(text)` (uses `execCommand('insertText')`); the `type` action froze the renderer on this page. If a JS/type call returns a CDP timeout, **screenshot to check whether it landed before retrying** — it usually did; blind retry double-submits.

1. If `mode` has a `promptSyntax.modeWrapper`, wrap `command.prompt` accordingly.
2. `window.__CONN.insert(prompt)`; THEN (re-)enable the mode from step 3.
3. `window.__CONN.mark()`, then submit by clicking `send-button`.
4. If unattended and the model asks scoping questions, answer "proceed with reasonable assumptions". (Deep Research may instead skip questions, show a research plan, and begin — that's expected; settle on the final report, not the plan.)

## 5. Wait for settle (never scrape early)

Poll `javascript_tool` → `window.__CONN.isSettled()` every ~1.5s until `true` or
`command.timeoutMs` (use the mode's `settleTimeoutMs` — Deep Research is long). Timeout → still return
partial `text` with `settledBy:"timeout"` and `error:"settle_timeout"`.

## 6. Scrape

`javascript_tool` → `window.__CONN.lastText()` for the reply; `window.__CONN.url()` for the permalink
(persist it as thread identity in `state.json`).

> **Deep Research is different (verified 2026-06-25).** The DR report renders in a **canvas/document
> pane**, NOT a `data-message-author-role="assistant"` turn — so `get_page_text` AND `lastText()` miss
> it, and a raw JS innerText return is **blocked by the privacy guard** (the citation URLs trip the
> cookie/query-string filter). Detect completion via the "Research completed in Xm" line, then capture
> the report through the canvas **Download** button (file → OS Downloads → read), not by scraping text.

## 7. Downloads (only if `expectFiles`)

`window.__CONN.downloads()` to list affordances; click each via the page; then have Code take the
newest matching file from `~/Downloads` and return `{name, path}`.

## 8. Return

Emit the PROTOCOL result JSON. On a login wall/captcha return `login_required`/`blocked` so Code can
fall back. No prose.
