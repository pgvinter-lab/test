/*
 * Gemini owned-tab driver — injected into the tab via
 * mcp__Claude_in_Chrome__javascript_tool. Defines window.__CONN, the surface the
 * connector agent calls each step. Inject ONCE per attach; globals persist until
 * the page navigates (a new chat re-injects).
 *
 * Self-contained on purpose. The QUIESCENCE CORE is identical to
 * ../chatgpt/inject.chatgpt.js — only SEL and `platform` differ.
 */
(() => {
  const SEL = {
    composer: 'div.ql-editor[contenteditable="true"], rich-textarea [contenteditable="true"], textarea',
    sendBtn: 'button[aria-label*="Send" i], button.send-button',
    stopBtn: 'button[aria-label*="Stop" i], button[aria-label*="Cancel" i]',
    assistantTurn: 'message-content, .model-response-text, [class*="response-container"]',
    newChat: '[aria-label*="New chat" i], a[href$="/app"]',
    downloadLink: 'a[download], a[href^="blob:"]',
  };

  const turns = () => document.querySelectorAll(SEL.assistantTurn);
  const lastAssistant = () => { const n = turns(); return n.length ? n[n.length - 1] : null; };

  // L-C3: composer text entry must use document.execCommand('insertText'), NOT raw key typing
  // (avoids the CDP 'type' freeze and newline-sends-early). The ONE place the lesson is enforced —
  // every text-entry path routes through here. Handles the Quill ql-editor (contenteditable) and a
  // plain <textarea> fallback, selecting existing content first so insert REPLACES rather than appends.
  function setComposerText(e, text) {
    e.focus();
    if (e.isContentEditable || e.getAttribute('contenteditable') === 'true') {
      document.execCommand('selectAll', false, null);   // replace, don't append
      document.execCommand('insertText', false, text);  // L-C3: proper input events
      return true;
    }
    // <textarea> fallback: select existing value, then insertText (still execCommand, per L-C3).
    if (typeof e.select === 'function') e.select();
    if (!document.execCommand('insertText', false, text)) {
      const proto = e.tagName === 'TEXTAREA' ? HTMLTextAreaElement.prototype : HTMLInputElement.prototype;
      const d = Object.getOwnPropertyDescriptor(proto, 'value');
      if (d && d.set) d.set.call(e, text); else e.value = text;
      e.dispatchEvent(new Event('input', { bubbles: true }));
    }
    return true;
  }

  // ---- QUIESCENCE CORE (keep identical across connectors) -------------------
  function quietMs() {
    const el = lastAssistant();
    const text = el ? el.innerText : '';
    const now = Date.now();
    const s = window.__quiet || (window.__quiet = { text: null, since: now });
    if (text !== s.text) { s.text = text; s.since = now; return 0; }
    return now - s.since;
  }
  // --------------------------------------------------------------------------

  window.__CONN = {
    platform: 'gemini',
    url: () => location.href,
    loggedIn: () => !!document.querySelector(SEL.composer),
    lastText: () => { const el = lastAssistant(); return el ? el.innerText : ''; },
    downloads: () => Array.from(document.querySelectorAll(SEL.downloadLink))
      .map((a) => ({ href: a.href, name: a.getAttribute('download') || a.textContent.trim() })),
    newChat: () => { const b = document.querySelector(SEL.newChat); if (b) { b.click(); } else { location.href = '/app'; } return true; },
    // L-C3: insert prompt text via execCommand('insertText') (drives the Quill ql-editor through
    // proper input events; avoids the CDP 'type' freeze and newline-sends-early). Focuses the composer
    // and replaces any existing content. ORDERING with modes is the caller's job — see sendWithMode and
    // L-C4: insert must run BEFORE a tool mode is enabled, never after (editing clears the mode).
    insert: (text) => { const e = document.querySelector(SEL.composer); if (!e) return false; return setComposerText(e, text); },
    // Click a control by visible text (menu items) — DOM/text-addressed, layout-independent.
    clickText: (t) => { const el = [...document.querySelectorAll('button,[role="menuitem"],a')].find((e) => (e.textContent || '').trim().toLowerCase().includes(String(t).toLowerCase())); if (el) { el.click(); return true; } return false; },
    // Click the send affordance (CSS-addressed, layout-independent).
    send: () => { const b = document.querySelector(SEL.sendBtn); if (b && !b.disabled) { b.click(); return true; } return false; },

    /*
     * sendWithMode(text, mode) — enforce the L-C4 ordering so a caller CANNOT get it wrong:
     *   1. insert(text)   — put the prompt in the composer FIRST
     *   2. activate mode  — open prompt tools (selectors.toolsBtn = 'Upload & tools') and pick the mode
     *   3. send()         — submit
     * L-C4: enabling a mode and THEN editing clears the active mode, so text must go in first.
     * `mode` is a key in capabilities.abilities (here: 'deep_research' | 'canvas'). Returns a step
     * report; caller still mark()s before and polls isSettled() after. NOTE (deep_research): Gemini
     * returns a research PLAN first — after this, the caller must click 'Start research' to confirm,
     * and isSettled must fire on the REPORT, not the plan.
     */
    sendWithMode: (text, mode) => {
      const r = { mode, inserted: false, toolsOpened: false, modeActivated: false, sent: false };
      // L-C4 step 1 — text FIRST, before any mode is active.
      r.inserted = window.__CONN.insert(text);
      if (!r.inserted) return r;
      // L-C4 step 2 — open the prompt tools menu, then select the mode by label.
      const toolsBtn = document.querySelector('button[aria-label="Upload & tools"]'); // selectors.toolsBtn
      if (toolsBtn) { toolsBtn.click(); r.toolsOpened = true; }
      const label = mode === 'deep_research' ? 'Deep Research' : mode === 'canvas' ? 'Canvas' : mode;
      r.modeActivated = window.__CONN.clickText(label);
      // L-C4 step 3 — send only after text is in AND the mode is enabled.
      r.sent = window.__CONN.send();
      return r;
    },

    // Call IMMEDIATELY BEFORE sending — snapshot turn count + reset the timer.
    mark: () => { window.__base = turns().length; window.__quiet = null; return window.__base; },

    /*
     * isSettled() — true when the NEW reply is COMPLETE. Tune this yourself.
     * Baseline = pure quiescence (1s, Gemini renders in larger chunks than ChatGPT).
     *
     * TODO(you): blend in the SIGNAL. Sketch:
     *     if (document.querySelector(SEL.stopBtn)) return false;     // streaming
     *     if (document.querySelector(SEL.sendBtn)) return quietMs() > 300;
     * NOTE: in deep_research, do NOT treat the research-PLAN turn as the final answer —
     * the playbook confirms the plan first; isSettled should fire on the report, not the plan.
     */
    isSettled: () => {
      if (turns().length <= (window.__base || 0)) return false;
      return quietMs() >= 1000; // baseline: 1000ms with no text growth
    },
  };

  return { ok: true, platform: 'gemini', loggedIn: window.__CONN.loggedIn(), url: location.href };
})();
