/*
 * AI Studio owned-tab driver — injected into the tab via
 * mcp__Claude_in_Chrome__javascript_tool. Defines window.__CONN, the surface the
 * connector agent calls each step. Inject ONCE per attach; globals persist until
 * the page navigates (a new chat re-injects).
 *
 * The QUIESCENCE CORE is identical to ../gemini/inject.gemini.js — only SEL,
 * insert() (textarea-aware), run(), and `platform` differ.
 * SELECTORS ARE BEST-EFFORT, NOT YET LIVE-VERIFIED — calibrate on first attach (see AGENT.md).
 */
(() => {
  const SEL = {
    composer: 'ms-autosize-textarea textarea, textarea[aria-label*="prompt" i], textarea, [contenteditable="true"]',
    runBtn: 'button[aria-label*="Run" i], run-button button, button.run-button',
    stopBtn: 'button[aria-label*="Stop" i], button.stop-button',
    assistantTurn: 'ms-chat-turn, .chat-turn-container, [class*="turn-content"]',
    uploadBtn: 'button[aria-label*="Insert" i], button[aria-label*="Upload" i], button[aria-label*="add" i]',
    newChat: 'a[href*="new_chat"], button[aria-label*="New" i]',
    downloadLink: 'a[download], a[href^="blob:"]',
  };

  const turns = () => document.querySelectorAll(SEL.assistantTurn);
  const lastAssistant = () => { const n = turns(); return n.length ? n[n.length - 1] : null; };

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

  // The ONE place composer text entry is enforced.
  //   L-C3:  contenteditable composers take document.execCommand('insertText') — NOT raw key typing.
  //   L-C11: AI Studio's composer is an Angular Material <textarea>; execCommand/el.value=... are
  //          IGNORED by Angular's model. Set the value via the native prototype setter, then dispatch
  //          an 'input' event so Angular's two-way binding picks it up. This is the textarea exception
  //          to L-C3. Existing content is selected/cleared first so insert REPLACES rather than appends.
  function setText(e, text) {
    e.focus();
    if (e.isContentEditable || e.getAttribute('contenteditable') === 'true') {
      document.execCommand('selectAll', false, null);    // replace, don't append
      document.execCommand('insertText', false, text);   // L-C3: contenteditable path
      return true;
    }
    // L-C11: <textarea> exception — native value setter + dispatched 'input' event.
    if (typeof e.select === 'function') e.select();        // clear existing on the next set
    const proto = e.tagName === 'TEXTAREA' ? HTMLTextAreaElement.prototype : HTMLInputElement.prototype;
    const d = Object.getOwnPropertyDescriptor(proto, 'value');
    if (d && d.set) { d.set.call(e, text); } else { e.value = text; }
    e.dispatchEvent(new Event('input', { bubbles: true }));
    return true;
  }

  // The Run button has NO aria-label (verified 2026-06-25) — find it by visible text.
  const runButton = () => [...document.querySelectorAll('button')].find((b) => /^\s*Run\b/.test((b.textContent || '').trim())) || null;
  // ms-chat-turn innerText carries Material icon ligatures — strip them from scraped text.
  const ICON = /^(more_vert|thumb_up|thumb_down|content_copy|edit|refresh|tune|sync|done|close|chevron_right)$/;
  const clean = (s) => (s || '').split('\n').filter((l) => !ICON.test(l.trim())).join('\n').trim();

  window.__CONN = {
    platform: 'aistudio',
    url: () => location.href,
    loggedIn: () => !!document.querySelector(SEL.composer),
    lastText: () => clean(lastAssistant() ? lastAssistant().innerText : ''),
    downloads: () => Array.from(document.querySelectorAll(SEL.downloadLink))
      .map((a) => ({ href: a.href, name: a.getAttribute('download') || a.textContent.trim() })),
    newChat: () => { const b = document.querySelector(SEL.newChat); if (b) { b.click(); } else { location.href = '/prompts/new_chat'; } return true; },
    // Click a control by visible text (menu items, toggles) — DOM/text-addressed, no pixels.
    clickText: (t) => { const el = [...document.querySelectorAll('button,[role="menuitem"],a')].find((e) => (e.textContent || '').trim().toLowerCase().includes(String(t).toLowerCase())); if (el) { el.click(); return true; } return false; },

    // Insert prompt text into the composer. Routes through setText so the lesson is enforced in ONE
    // place: L-C11 (textarea native-value-setter + 'input' event) for AI Studio's Angular Material
    // <textarea>, or L-C3 (execCommand insertText) if the composer is ever a contenteditable.
    insert: (text) => { const e = document.querySelector(SEL.composer); return e ? setText(e, text) : false; },

    // Submit: click the text-'Run' button (it has NO aria-label), else CSS fallback, else Ctrl+Enter.
    run: () => {
      const b = runButton() || document.querySelector(SEL.runBtn);
      if (b && !b.disabled) { b.click(); return true; }
      const c = document.querySelector(SEL.composer);
      if (c) { c.focus(); c.dispatchEvent(new KeyboardEvent('keydown', { key: 'Enter', ctrlKey: true, bubbles: true })); return true; }
      return false;
    },

    // Call IMMEDIATELY BEFORE Run — snapshot turn count + reset the timer.
    mark: () => { window.__base = turns().length; window.__quiet = null; return window.__base; },

    /*
     * isSettled() — true when the NEW reply is COMPLETE. AI Studio gives CLEAN signals
     * (verified 2026-06-25): Run re-enables and Stop disappears when generation ends.
     * TODO(you): if you enable Code execution / grounding, generation pauses for tool calls —
     * widen quiesce or gate on the Run button only so a mid-run pause isn't read as "done".
     */
    isSettled: () => {
      if (turns().length <= (window.__base || 0)) return false;
      if (document.querySelector(SEL.stopBtn)) return false;            // streaming
      const run = runButton();
      if (run && run.disabled) return false;                            // mid-generation
      return quietMs() >= 1200;                                         // baseline: 1.2s with no text growth
    },
  };

  return { ok: true, platform: 'aistudio', loggedIn: window.__CONN.loggedIn(), url: location.href };
})();
