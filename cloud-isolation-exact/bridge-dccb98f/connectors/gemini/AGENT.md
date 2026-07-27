# Gemini connector — playbook

Identical to the ChatGPT playbook; only the platform specifics differ. Read
[`capabilities.json`](./capabilities.json) and honor [`../PROTOCOL.md`](../PROTOCOL.md).
**Return only the result JSON.** Try the **Gemini CLI first** when available; this tab is the fallback.

> **Capability limit (verified 2026-06-25).** The Gemini web app **cannot create Google Drive folders** — its Workspace access only creates Docs/Sheets. A "create a folder tree in Drive" request returns a write-up + a ready-to-run Apps Script, NOT real folders. To actually materialize a tree, hand the tree to the Google Drive MCP or run the script. Insert prompts via `window.__CONN.insert(text)` (`execCommand('insertText')`, works cleanly here).

## 1. Attach (find-or-create the owned tab)

1. `list_connected_browsers` → `select_browser` Chrome.
2. `tabs_context_mcp` → find a tab matching `https://gemini.google.com/*`.
   - found → select it; record id in `../state.json`.
   - none → `tabs_create_mcp` → `navigate` to `https://gemini.google.com/app`; record id.
3. Inject `inject.gemini.js` via `javascript_tool`. `loggedIn:false` → `{ ok:false, error:"login_required" }`.

## 2. New session (only if `session:"new"`)

`window.__CONN.newChat()`, then re-inject `inject.gemini.js` (navigation clears globals).

## 3. Select the ability / mode  (mechanism — ordering per step 4)

Activate **DOM-first, no pixels**: open tools via `document.querySelector(selectors.toolsBtn).click()`
(aria "Upload & tools"); pick by text `window.__CONN.clickText('Deep Research')` (or switch model via
`selectors.modelPicker`). **Verify the mode chip before sending.** Reserve coordinate clicks for
elements that ignore `.click()`.

## 4. Compose & send

1. Apply `promptSyntax.modeWrapper` if present.
2. `javascript_tool` → `window.__CONN.mark()` right before sending.
3. `form_input` the prompt; submit.
4. **Deep Research only:** Gemini returns a *research plan* first — click **Start research** to run it
   (auto-confirm if `command.unattended`). The final report comes after; don't scrape the plan.

## 5. Wait for settle

Poll `window.__CONN.isSettled()` until `true` or the mode's `settleTimeoutMs`. Timeout → return
partial `text`, `settledBy:"timeout"`, `error:"settle_timeout"`.

## 6. Scrape

`window.__CONN.lastText()` for the reply; `window.__CONN.url()` for the permalink (persist in state).

## 7. Downloads (only if `expectFiles`)

`window.__CONN.downloads()`, click each, Code resolves newest from `~/Downloads`.

## 8. Return

PROTOCOL result JSON. Login wall/captcha → `login_required`/`blocked` so Code falls back to the CLI.
No prose.
