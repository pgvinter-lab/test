# AI Studio connector — playbook

Same shape as the Gemini/ChatGPT playbooks; honor [`../PROTOCOL.md`](../PROTOCOL.md). **Return only the result JSON.** AI Studio's strength is **fast native multimodal** (audio/video → text, large-context doc review) and Gemini-model chat without the Workspace UI. There is no AI-Studio CLI — this tab is the surface.

> **First attach = calibrate.** Selectors in `capabilities.json` are best-effort. Verify them live and re-anchor `inject.aistudio.js` before trusting `isSettled()` / `lastText()`.

## 1. Attach (find-or-create the owned tab)
1. `list_connected_browsers` → `select_browser` Chrome.
2. `tabs_context_mcp` → find a tab matching `https://aistudio.google.com/*`.
   - found → select it; record id in `../state.json` (stateKey `aistudio`).
   - none → `tabs_create_mcp` → `navigate` to `https://aistudio.google.com/prompts/new_chat`; record id.
3. Inject `inject.aistudio.js` via `javascript_tool`. `loggedIn:false` → `{ ok:false, error:"login_required" }`.

## 2. New session (only if `session:"new"`)
`window.__CONN.newChat()` (navigates to a fresh prompt), then re-inject `inject.aistudio.js` (navigation clears globals).

## 3. Select ability / mode
From `capabilities.abilities[command.mode]`. Optional: open the model switcher and pick the tier (e.g. Gemini 2.5 Pro) if `activate` asks.

## 4. Uploads (multimodal turns)
If `command.uploads` is non-empty: open the **insert/upload** control, then `file_upload` each absolute path. Wait until each attachment chip shows as ready before composing.

## 5. Compose & send
1. Apply `promptSyntax.modeWrapper` if present.
2. `javascript_tool` → `window.__CONN.mark()` right before Run.
3. Insert the prompt via `window.__CONN.insert(text)` (handles the AI Studio textarea), then press **Run** (`window.__CONN.run()` or `form_input` submit; Run is also Ctrl/Cmd+Enter).

## 6. Wait for settle
Poll `window.__CONN.isSettled()` until `true` or the mode's `settleTimeoutMs`. Timeout → partial `text`, `settledBy:"timeout"`, `error:"settle_timeout"`.

## 7. Scrape
`window.__CONN.lastText()` for the reply; `window.__CONN.url()` for the permalink (persist in state).

## 8. Downloads (only if `expectFiles`)
`window.__CONN.downloads()`, click each; Code resolves the newest from `~/Downloads`.

## 9. Return
PROTOCOL result JSON. Login wall/captcha → `login_required`/`blocked`. No prose.
