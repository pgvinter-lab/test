/*
 * ChatGPT owned-tab driver — injected into the tab via
 * mcp__Claude_in_Chrome__javascript_tool. Defines window.__CONN, the surface the
 * connector agent calls each step. Inject ONCE per attach; the globals persist
 * until the page navigates (a new chat re-injects).
 *
 * Self-contained on purpose. Keep the QUIESCENCE CORE in sync with
 * ../gemini/inject.gemini.js — only SEL and `platform` should differ.
 */
(() => {
  const SEL = {
    composer: '#prompt-textarea, div[contenteditable="true"]',
    sendBtn: '[data-testid="send-button"]',
    stopBtn: '[data-testid="stop-button"]',
    assistantTurn: '[data-message-author-role="assistant"]',
    newChat: 'a[href="/"], button[aria-label*="New chat" i]',
    downloadLink: 'a[download], a[href^="blob:"]',
  };

  const turns = () => document.querySelectorAll(SEL.assistantTurn);
  const lastAssistant = () => { const n = turns(); return n.length ? n[n.length - 1] : null; };

  // L-C3: composer text entry must use document.execCommand('insertText'), NOT raw key
  // typing (CDP 'type' froze the renderer; newline sends early). This is the ONE place the
  // lesson is enforced — every text-entry path routes through here.
  // Handles contenteditable (ProseMirror, the live composer) AND a plain <textarea> fallback,
  // selecting any existing content first so insert REPLACES rather than appends.
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
      // Last resort if execCommand is unavailable on this node: native setter + input event.
      const proto = e.tagName === 'TEXTAREA' ? HTMLTextAreaElement.prototype : HTMLInputElement.prototype;
      const d = Object.getOwnPropertyDescriptor(proto, 'value');
      if (d && d.set) d.set.call(e, text); else e.value = text;
      e.dispatchEvent(new Event('input', { bubbles: true }));
    }
    return true;
  }

  // ---- QUIESCENCE CORE (keep identical across connectors) -------------------
  // How long (ms) the last assistant turn's text has been UNCHANGED. Resets the
  // timer whenever the text grows (i.e. it's still streaming). 0 = changed just now.
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
    platform: 'chatgpt',
    url: () => location.href,
    loggedIn: () => !!document.querySelector(SEL.composer),
    lastText: () => { const el = lastAssistant(); return el ? el.innerText : ''; },
    downloads: () => Array.from(document.querySelectorAll(SEL.downloadLink))
      .map((a) => ({ href: a.href, name: a.getAttribute('download') || a.textContent.trim() })),
    newChat: () => { const b = document.querySelector(SEL.newChat); if (b) { b.click(); } else { location.href = '/'; } return true; },
    // L-C3: insert prompt text via execCommand('insertText') (drives ProseMirror through proper
    // input events; avoids the CDP 'type' freeze and newline-sends-early). Focuses the composer and
    // replaces any existing content. ORDERING with modes is the caller's job — see sendWithMode and
    // L-C4: insert must run BEFORE a tool mode is enabled, never after (editing clears the mode).
    insert: (text) => { const e = document.querySelector(SEL.composer); if (!e) return false; return setComposerText(e, text); },
    // Click a control by visible text (menu items) — DOM/text-addressed, layout-independent.
    // Activate a tool from the + menu: open menu, then clickText('Deep research'), then verify the pill.
    clickText: (t) => { const el = [...document.querySelectorAll('button,[role="menuitem"],a')].find((e) => (e.textContent || '').trim().toLowerCase().includes(String(t).toLowerCase())); if (el) { el.click(); return true; } return false; },
    // Click the send affordance (CSS-addressed, layout-independent).
    send: () => { const b = document.querySelector(SEL.sendBtn); if (b && !b.disabled) { b.click(); return true; } return false; },

    /*
     * sendWithMode(text, mode) — enforce the L-C4 ordering so a caller CANNOT get it wrong:
     *   1. insert(text)   — put the prompt in the composer FIRST
     *   2. activate mode  — open the tools menu (selectors.toolsBtn) and pick the mode label
     *   3. send()         — submit
     * L-C4: enabling a mode and THEN editing clears the active mode, so text must go in first.
     * `mode` is a key in capabilities.abilities (here: 'deep_research' | 'canvas'). Returns a
     * step report; the caller still mark()s before this and polls isSettled() after. For
     * deep_research the plan/clarifier turn still needs the long settleTimeout + plan-card fallback.
     */
    sendWithMode: (text, mode) => {
      const r = { mode, inserted: false, toolsOpened: false, modeActivated: false, sent: false };
      // L-C4 step 1 — text FIRST, before any mode is active.
      r.inserted = window.__CONN.insert(text);
      if (!r.inserted) return r;
      // L-C4 step 2 — open the + / tools menu, then select the mode by label, THEN (caller) verify the pill.
      const toolsBtn = document.querySelector('[data-testid="composer-plus-btn"]'); // selectors.toolsBtn
      if (toolsBtn) { toolsBtn.click(); r.toolsOpened = true; }
      const label = mode === 'deep_research' ? 'Deep research' : mode === 'canvas' ? 'Canvas' : mode;
      r.modeActivated = window.__CONN.clickText(label);
      // L-C4 step 3 — send only after text is in AND the mode is enabled.
      r.sent = window.__CONN.send();
      return r;
    },

    // Call IMMEDIATELY BEFORE sending: snapshot the turn count + reset the timer so
    // a previous answer can never be mistaken for the new one.
    mark: () => { window.__base = turns().length; window.__quiet = null; return window.__base; },

    /*
     * isSettled() — return true when the NEW reply is COMPLETE. The one decision
     * worth tuning yourself; the baseline below is pure quiescence (portable, works
     * today) but has higher latency and can false-settle on a long mid-stream pause.
     *
     * TODO(you): blend in the SIGNAL for precision + lower latency. Sketch:
     *     if (document.querySelector(SEL.stopBtn)) return false;     // definitely streaming
     *     if (document.querySelector(SEL.sendBtn)) return quietMs() > 250;  // send re-enabled = strong "done"
     * Then pick the quiet threshold for YOUR latency-vs-truncation budget.
     */
    isSettled: () => {
      if (turns().length <= (window.__base || 0)) return false; // new answer not here yet
      return quietMs() >= 800; // baseline: 800ms with no text growth
    },
  };

  return { ok: true, platform: 'chatgpt', loggedIn: window.__CONN.loggedIn(), url: location.href };
})();
