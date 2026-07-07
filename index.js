/*
 * Janitor Import — SillyTavern extension
 *
 * Pastes a JanitorAI character URL into SillyTavern and (one click) drops in:
 *   - the character card (image + chara_card_v2 JSON), even when the definition is hidden;
 *   - attached public lorebooks downloaded as-is;
 *   - attached CLOSED lorebooks: trigger-extracted by chatting with the bot on JanitorAI
 *     under your own session, then rebuilt into a structured SillyTavern World Info via
 *     the LLM you already have configured inside SillyTavern (no extra API keys).
 *
 * Optional: floating "🌐 Translate keys" FAB rewrites every entry's trigger keys
 * (and secondary keys) to your roleplay language — handy for Russian RP where
 * lorebooks ship English keys.
 *
 * How it works (mirrored from hydall/JAR, minus Playwright):
 *   1. window.open('https://janitorai.com/characters/<uuid>') opens a popup tab in the
 *      SAME Chrome profile. It shares the logged-in janitorai.com cookies + CF
 *      clearance + localStorage (Supabase token).
 *   2. We inject a bridge script into the popup. The bridge patches window.fetch to
 *      cache /generateAlpha request/response bodies and answers window.postMessage RPCs.
 *   3. Probe "." → read the card out of the first intercepted generateAlpha → ship the
 *      card back as our second message so as many closed-lorebook keys fire as
 *      possible → second interception is the prompt we strip & rebuild.
 *   4. Rebuild uses the same SYSTEM_PROMPT hydall/JAR ships (ext/extract.js), then
 *      maps the response through the same worldinfo entry schema (ext/worldinfo.js),
 *      so output imports into SillyTavern's World Info with no warnings.
 *
 * Limits (same as JAR):
 *   - Cloudflare Turnstile hates "headless" — we use your real Chrome so this is fine.
 *   - "Advanced" / Nine API lorebooks (script is JavaScript source) only leak through
 *     the trigger path; we handle them via that.
 *   - Use a throwaway JanitorAI account; their anti-scrape is aggressive.
 */

'use strict';

console.log('[JanitorImport] index.js loaded (v1.0.5)');

(function () {
    // -------- CONFIG -------------------------------------------------------------

    const JANITOR_ORIGIN = 'https://janitorai.com';


    // Best-effort selectors. JanitorAI rebrands often, keep these loose.
    const INPUT_SELECTORS = [
        'textarea[placeholder]',
        'form textarea',
        'textarea',
        'div[contenteditable="true"]',
    ];
    const SEND_SELECTORS = [
        'button[aria-label*="send" i]',
        'button[class*="sendButton" i]',
        'button[type="submit"]',
    ];
    const STOP_SELECTOR = 'button[aria-label*="stop" i], button[aria-label*="cancel" i]';

    // -------- ENTRY POINT --------------------------------------------------------

    function onReady(cb) {
        let done = false;
        const trigger = () => {
            if (done) return;
            done = true;
            setTimeout(cb, 0);
        };
        // Preferred: use SillyTavern's own APP_READY event (this is how native
        // extensions boot). The #extensions_settings container only exists after this.
        try {
            const ctx = window.SillyTavern && window.SillyTavern.getContext && window.SillyTavern.getContext();
            if (ctx && ctx.eventSource && ctx.event_types && ctx.event_types.APP_READY) {
                ctx.eventSource.on(ctx.event_types.APP_READY, trigger);
            }
        } catch (_) { }
        // Fallbacks: run now if DOM is already up, plus retry on a timer in case
        // #extensions_settings mounts a little later.
        if (document.readyState === 'loading') {
            document.addEventListener('DOMContentLoaded', () => setTimeout(trigger, 500), { once: true });
        } else {
            setTimeout(trigger, 500);
        }
        setTimeout(trigger, 1500);
        setTimeout(trigger, 4000);
    }



    // -------- UI HELPERS ---------------------------------------------------------

    function toast(text, kind, ms) {
        kind = kind || 'info';
        ms = ms || 3500;
        try {
            const ctx = window.SillyTavern && window.SillyTavern.getContext && window.SillyTavern.getContext();
            if (ctx && ctx.toastr) {
                const t = ctx.toastr;
                (t[kind] || t.info)(text);
                return;
            }
        } catch (_) { }
        let host = document.getElementById('ji-toast-host');
        if (!host) {
            host = document.createElement('div');
            host.id = 'ji-toast-host';
            document.body.appendChild(host);
        }
        const node = document.createElement('div');
        node.className = 'ji-toast';
        node.textContent = text;
        host.appendChild(node);
        setTimeout(() => { node.classList.add('ji-toast--hide'); }, Math.max(0, ms - 400));
        setTimeout(() => node.remove(), ms);
    }


    function buildModal(opts) {
        const title = opts && opts.title;
        const body = opts && opts.body;
        const width = (opts && opts.width) || '';
        const overlay = document.createElement('div');
        overlay.className = 'ji-overlay';
        overlay.id = 'ji-modal-overlay';
        const card = document.createElement('div');
        card.className = 'ji-modal';
        if (width) card.style.width = width;
        const head = document.createElement('div');
        head.className = 'ji-modal-head';
        head.textContent = title;
        card.appendChild(head);
        if (body) card.appendChild(body);
        overlay.appendChild(card);
        overlay.addEventListener('click', (e) => { if (e.target === overlay) overlay.remove(); });
        document.body.appendChild(overlay);
        return { overlay: overlay, card: card, head: head };
    }

    function row(labelText, control, opts) {
        opts = opts || {};
        const r = document.createElement('label');
        r.className = 'ji-row';
        const lbl = document.createElement('span');
        lbl.className = 'ji-row-label';
        lbl.textContent = labelText;
        if (opts.labelWidth) lbl.style.minWidth = opts.labelWidth;
        r.appendChild(lbl);
        if (control instanceof HTMLElement) control.classList.add('ji-row-control');
        r.appendChild(control);
        return r;
    }

    function checkbox(checked) {
        const cb = document.createElement('input');
        cb.type = 'checkbox';
        cb.className = 'ji-checkbox';
        cb.checked = !!checked;
        return cb;
    }
    function textInput(value) {
        const i = document.createElement('input');
        i.type = 'text';
        i.className = 'ji-input';
        i.value = value || '';
        return i;
    }
    function select(options, selected) {
        const s = document.createElement('select');
        s.className = 'ji-select';
        for (let i = 0; i < options.length; i++) {
            const o = document.createElement('option');
            o.value = options[i][0];
            o.textContent = options[i][1];
            if (selected != null && String(options[i][0]) === String(selected)) o.selected = true;
            s.appendChild(o);
        }
        return s;
    }
    function button(label, kind) {
        const b = document.createElement('button');
        b.type = 'button';
        b.textContent = label;
        b.className = 'ji-btn ji-btn--' + (kind || 'secondary');
        return b;
    }

    function progressArea() {
        const wrap = document.createElement('div');
        wrap.className = 'ji-progress';
        const bar = document.createElement('div');
        bar.className = 'ji-progress-bar';
        const fill = document.createElement('div');
        fill.className = 'ji-progress-fill';
        bar.appendChild(fill);
        const log = document.createElement('div');
        log.className = 'ji-log';
        wrap.appendChild(bar);
        wrap.appendChild(log);
        wrap.setProgress = function (frac) { fill.style.width = (Math.min(100, Math.max(0, frac * 100)) | 0) + '%'; };
        wrap.log = function (msg) {
            const line = document.createElement('div');
            line.textContent = msg;
            log.appendChild(line);
            log.scrollTop = log.scrollHeight;
        };
        return wrap;
    }


    // -------- BRIDGE SOURCE -----------------------------------------------------
    //
    // The bridge runs inside the janitorai.com popup. It patches window.fetch,
    // caches /generateAlpha response bodies, finds the Supabase token in
    // cookies/localStorage, and answers postMessage RPCs from the parent.
    //
    // We assemble it as concatenation of single-quoted strings (no template
    // literals) so this file survives being saved, copied around, and reloaded
    // without any ${} placeholders collapsing into literal text.

    function makeBridgeSource() {
        const selectorsJson = JSON.stringify(INPUT_SELECTORS);
        const sendSelectorsJson = JSON.stringify(SEND_SELECTORS);
        const stopSelectorJson = JSON.stringify(STOP_SELECTOR);
        // Build the bridge source. We open an IIFE on the janitorai.com side.
        return [
            "(function(){",
            "if (window.__ji_bridge_installed) return;",
            "window.__ji_bridge_installed = true;",
            "var JANITOR = 'https://janitorai.com';",
            "var INPUT_SELECTORS = " + selectorsJson + ";",
            "var SEND_SELECTORS = " + sendSelectorsJson + ";",
            "var STOP_SELECTOR = " + stopSelectorJson + ";",
            // fetch interception
            "var captures = new Map();",
            "function setCap(tag, side, value){ var cur = captures.get(tag) || {}; cur[side] = value; captures.set(tag, cur); }",
            "var _fetch = window.fetch.bind(window);",
            "window.fetch = async function(input, init){",
            "  var url = (typeof input === 'string') ? input : (input && input.url) || '';",
            "  var method = (init && init.method) || (input && input.method) || 'GET';",
            "  var tag = url;",
            "  try {",
            "    if (tag) setCap(tag, 'req', { url: url, method: method, body: init && init.body });",
            "    var resp = await _fetch(input, init);",
            "    if (tag && /generateAlpha/i.test(url)) {",
            "      try {",
            "        var clone = resp.clone();",
            "        var payload = await clone.json().catch(async function(){",
            "          var text = await clone.text();",
            "          var i = text.indexOf('{'), j = text.lastIndexOf('}');",
            "          return (i >= 0 && j > i) ? JSON.parse(text.slice(i, j + 1)) : null;",
            "        });",
            "        if (payload && Array.isArray(payload.messages)) setCap(tag, 'res', payload);",
            "      } catch (_) {}",
            "    }",
            "    return resp;",
            "  } catch (e) { throw e; }",
            "};",
            // token extraction (copy of JAR's autotrigger.findToken)
            "function findToken() {",
            "  function b64(s) { try { return atob(s); } catch (e) {} try { return atob(s.replace(/-/g, '+').replace(/_/g, '/')); } catch (e) {} return null; }",
            "  function extract(rawIn) {",
            "    var raw = rawIn; if (!raw) return null;",
            "    try { raw = decodeURIComponent(raw); } catch (e) {}",
            "    if (raw.indexOf('base64-') === 0) raw = raw.slice(7);",
            "    if (raw.indexOf('eyJ') === 0 && raw.split('.').length === 3) return raw;",
            "    var ss = [b64(raw), raw];",
            "    for (var i = 0; i < ss.length; i++) {",
            "      var s = ss[i]; if (!s) continue;",
            "      var mm = s.match(/\"access_token\":\"(eyJ[^\"]+)\"/); if (mm) return mm[1];",
            "      try { var o = JSON.parse(s); var c = o && (o.access_token || o.accessToken || (o.currentSession && o.currentSession.access_token)); if (typeof c === 'string' && c.indexOf('eyJ') === 0) return c; } catch (e) {}",
            "    }",
            "    return null;",
            "  }",
            "  try {",
            "    var parts = {};",
            "    var cookies = (document.cookie || '').split('; ');",
            "    for (var c = 0; c < cookies.length; c++) {",
            "      var ck = cookies[c]; var eq = ck.indexOf('='); if (eq < 0) continue;",
            "      var m = ck.slice(0, eq).match(/^(sb-.*-auth-token)(?:\\.(\\d+))?$/); if (!m) continue;",
            "      var base = m[1]; var idx = m[2] ? parseInt(m[2], 10) : 0;",
            "      if (!parts[base]) parts[base] = {}; parts[base][idx] = ck.slice(eq + 1);",
            "    }",
            "    for (var base2 in parts) {",
            "      var idxs = Object.keys(parts[base2]).map(Number).sort(function(a, b) { return a - b; });",
            "      var joined = ''; for (var j = 0; j < idxs.length; j++) joined += parts[base2][idxs[j]];",
            "      var t = extract(joined); if (t) return t;",
            "    }",
            "  } catch (e) {}",
            "  try {",
            "    for (var k = 0; k < localStorage.length; k++) {",
            "      var t2 = extract(localStorage.getItem(localStorage.key(k))); if (t2) return t2;",
            "    }",
            "  } catch (e) {}",
            "  return null;",
            "}",
            "async function authedFetch(url, init) {",
            "  init = init || {};",
            "  var token = findToken();",
            "  var headers = { accept: 'application/json, text/plain, */*' };",
            "  if (init.headers) for (var k in init.headers) headers[k] = init.headers[k];",
            "  if (token) headers.authorization = 'Bearer ' + token;",
            "  var r = await fetch(url, Object.assign({ credentials: 'include' }, init, { headers: headers }));",
            "  return { status: r.status, body: await r.text() };",
            "}",
            // DOM helpers (chat composer)
            "async function findInput(timeout) {",
            "  timeout = timeout || 12000;",
            "  var deadline = Date.now() + timeout;",
            "  while (Date.now() < deadline) {",
            "    for (var i = 0; i < INPUT_SELECTORS.length; i++) {",
            "      var sel = INPUT_SELECTORS[i];",
            "      var loc = document.querySelectorAll(sel);",
            "      for (var j = loc.length - 1; j >= 0; j--) {",
            "        var el = loc[j];",
            "        if (el && el.offsetParent !== null) return { el: el, sel: sel };",
            "      }",
            "    }",
            "    await new Promise(function(r){ setTimeout(r, 250); });",
            "  }",
            "  return null;",
            "}",
            "async function sendMsg(text) {",
            "  var found = await findInput(); if (!found) throw new Error('chat input not found');",
            "  var el = found.el; var sel = found.sel;",
            "  el.scrollIntoView({ block: 'center' });",
            "  el.click();",
            "  if (sel.indexOf('contenteditable') >= 0) {",
            "    el.textContent = '';",
            "    document.execCommand('insertText', false, text);",
            "    if (!el.textContent) el.textContent = text;",
            "  } else {",
            "    el.value = text;",
            "    el.dispatchEvent(new Event('input', { bubbles: true }));",
            "    el.dispatchEvent(new Event('change', { bubbles: true }));",
            "  }",
            "  await new Promise(function(r){ setTimeout(r, 200); });",
            "  // abort any in-flight stop button",
            "  var stopBtns = document.querySelectorAll(STOP_SELECTOR);",
            "  for (var s = 0; s < stopBtns.length; s++) { try { stopBtns[s].click(); } catch (_) {} }",
            "  await new Promise(function(r){ setTimeout(r, 200); });",
            "  // try send button",
            "  for (var si = 0; si < SEND_SELECTORS.length; si++) {",
            "    var ss2 = SEND_SELECTORS[si];",
            "    var btns = document.querySelectorAll(ss2);",
            "    for (var bi = btns.length - 1; bi >= 0; bi--) {",
            "      var b = btns[bi]; if (b && b.offsetParent !== null && !b.disabled) { b.click(); return; }",
            "    }",
            "  }",
            "  // last resort: Enter",
            "  el.dispatchEvent(new KeyboardEvent('keydown', { key: 'Enter', code: 'Enter', bubbles: true }));",
            "}",
            // worldinfo schemapass
            "function asArray(v) {",
            "  if (Array.isArray(v)) return v.map(function(x){ return String(x).trim(); }).filter(Boolean);",
            "  if (typeof v === 'string') return v.split(',').map(function(x){ return x.trim(); }).filter(Boolean);",
            "  return [];",
            "}",
            "function buildEntry(raw, uid) {",
            "  var key = asArray(raw.key || raw.keys || raw.keywords || raw.keysRaw);",
            "  var keysecondary = asArray(raw.keysecondary || raw.secondary_keys || (raw.filters && raw.filters.notWith));",
            "  var content = String(raw.content || raw.text || '').trim();",
            "  var comment = String(raw.comment || raw.title || raw.name || raw.category || ('Entry ' + uid)).trim();",
            "  var order = Number.isFinite(raw.order) ? raw.order : (Number.isFinite(raw.priority) ? raw.priority : (Number.isFinite(raw.insertion_order) ? raw.insertion_order : 100));",
            "  var constant = raw.constant === true;",
            "  var probability = raw.probability === undefined ? 100 : (raw.probability <= 1 ? raw.probability * 100 : raw.probability);",
            "  return {",
            "    uid: uid, key: key, keysecondary: keysecondary, comment: comment, content: content, constant: constant,",
            "    selective: !constant, order: order,",
            "    position: Number.isFinite(raw.position) ? raw.position : 0,",
            "    disable: raw.enabled === false, displayIndex: uid,",
            "    addMemo: true, group: '', groupOverride: false, groupWeight: 100,",
            "    sticky: 0, cooldown: 0, delay: 0, probability: probability, depth: 4, useProbability: true,",
            "    role: null, vectorized: false, excludeRecursion: false, preventRecursion: false,",
            "    delayUntilRecursion: false, scanDepth: null,",
            "    caseSensitive: raw.case_sensitive !== undefined ? raw.case_sensitive : null,",
            "    matchWholeWords: raw.matchWholeWords !== undefined ? raw.matchWholeWords : null,",
            "    useGroupScoring: null, automationId: '', selectiveLogic: Number.isFinite(raw.selectiveLogic) ? raw.selectiveLogic : 0,",
            "    ignoreBudget: false, matchPersonaDescription: false, matchCharacterDescription: false,",
            "    matchCharacterPersonality: false, matchCharacterDepthPrompt: false, matchScenario: false,",
            "    matchCreatorNotes: false, outletName: '', triggers: [],",
            "    characterFilter: { isExclude: false, names: [], tags: [] }",
            "  };",
            "}",
            "function buildWorldInfo(rawEntries) {",
            "  var entries = {}; var uid = 0;",
            "  for (var i = 0; i < rawEntries.length; i++) {",
            "    var raw = rawEntries[i]; if (!raw) continue;",
            "    var e = buildEntry(raw, uid);",
            "    if (!e.content) { uid++; continue; }",
            "    entries[String(uid)] = e; uid++;",
            "  }",
            "  return { entries: entries };",
            "}",
            // RPC plumbing
            "window.addEventListener('message', async function(ev) {",
            "  var data = ev.data || {};",
            "  if (data.__ji !== true) return;",
            "  var id = data.id; var op = data.op; var args = data.args || {};",
            "  function reply(ok, payload) { try { ev.source.postMessage({ __ji: true, id: id, ok: ok, payload: payload }, ev.origin || '*'); } catch (_) {} }",
            "  try {",
            "    if (op === 'ping') {",
            "      var r = await authedFetch(JANITOR + '/hampter/profiles/mine');",
            "      reply(true, { loggedIn: r.status === 200 });",
            "      return;",
            "    }",
            "    if (op === 'inspect') {",
            "      var rr = await authedFetch(JANITOR + '/hampter/characters/' + args.characterId);",
            "      if (rr.status >= 400) throw new Error('inspect HTTP ' + rr.status);",
            "      reply(true, JSON.parse(rr.body));",
            "      return;",
            "    }",
            "    if (op === 'fetchPublicLorebook') {",
            "      var rr2 = await authedFetch(JANITOR + '/hampter/script/' + args.scriptId);",
            "      if (rr2.status >= 400) { reply(false, 'HTTP ' + rr2.status); return; }",
            "      var rec = JSON.parse(rr2.body);",
            "      var entries = [];",
            "      if (Array.isArray(rec.script)) entries = rec.script;",
            "      else if (typeof rec.script === 'string' && rec.script.trim()) {",
            "        try { var a = JSON.parse(rec.script); if (Array.isArray(a)) entries = a; } catch (_) {}",
            "      }",
            "      reply(true, {",
            "        id: String(rec.id || args.scriptId),",
            "        title: rec.title || '',",
            "        description: rec.description || '',",
            "        is_public: rec.is_public !== false,",
            "        worldInfo: buildWorldInfo(entries),",
            "        entryCount: entries.length",
            "      });",
            "      return;",
            "    }",
            "    if (op === 'createChat') {",
            "      var rr3 = await authedFetch(JANITOR + '/hampter/chats', {",
            "        method: 'POST',",
            "        headers: { 'content-type': 'application/json' },",
            "        body: JSON.stringify({ character_id: args.characterId })",
            "      });",
            "      if (rr3.status >= 400) throw new Error('createChat HTTP ' + rr3.status + ' ' + String(rr3.body).slice(0, 200));",
            "      var d = JSON.parse(rr3.body);",
            "      reply(true, String(d.id));",
            "      return;",
            "    }",
            "    if (op === 'deleteChat') {",
            "      var rr4 = await authedFetch(JANITOR + '/hampter/chats/' + args.chatId, { method: 'DELETE' });",
            "      reply(true, { status: rr4.status });",
            "      return;",
            "    }",
            "    if (op === 'gotoChat') {",
            "      window.location.href = JANITOR + '/chats/' + args.chatId;",
            "      reply(true, true);",
            "      return;",
            "    }",
            "    if (op === 'sendMessage') {",
            "      await sendMsg(args.text); reply(true, true);",
            "      return;",
            "    }",
            "    if (op === 'interceptGenerateAlpha') {",
            "      var timeout = args.timeout || 90000;",
            "      var deadline = Date.now() + timeout;",
            "      function sendFinal(ok2, payload2, err) { try { ev.source.postMessage({ __ji: true, id: id, ok: ok2, payload: payload2, error: err }, ev.origin || '*'); } catch (_) {} }",
            "      try {",
            "        while (Date.now() < deadline) {",
            "          var captured = null; var capturedKey = null;",
            "          captures.forEach(function(v, k) { if (v && v.res && !captured) { captured = v.res; capturedKey = k; } });",
            "          if (captured) { captures.delete(capturedKey); sendFinal(true, captured); return; }",
            "          await new Promise(function(r){ setTimeout(r, 300); });",
            "        }",
            "        sendFinal(false, null, 'timeout waiting for generateAlpha');",
            "      } catch (e) { sendFinal(false, null, String(e.message || e)); }",
            "      return;",
            "    }",
            "    reply(false, 'unknown op: ' + op);",
            "  } catch (e) {",
            "    reply(false, String(e.message || e));",
            "  }",
            "});",
            "window.__ji_bridge_ready = true;",
            "})();"
        ].join("\n");
    }
    const BRIDGE_SOURCE = makeBridgeSource();

    // -------- BRIDGE TRANSPORT ---------------------------------------------------

    function openJanitorPopup(url) {
        const features = 'width=1280,height=820,noopener=no,scrollbars=yes';
        return window.open(url, 'janitor_import_popup', features) || null;
    }

    function injectBridge(win, log) {
        return new Promise(function (resolve, reject) {
            const deadline = Date.now() + 30000;
            function tick() {
                if (Date.now() > deadline) {
                    reject(new Error('bridge install timeout — popup may be blocked (allow popups for this site)'));
                    return;
                }
                try {
                    var d = win.document;
                    if (d && d.documentElement && !d.getElementById('__ji_bridge__')) {
                        var s = d.createElement('script');
                        s.id = '__ji_bridge__';
                        s.textContent = BRIDGE_SOURCE;
                        d.documentElement.appendChild(s);
                        setTimeout(function () {
                            if (win.__ji_bridge_ready) { log('bridge injected (ready)'); resolve(true); }
                            else setTimeout(tick, 300);
                        }, 200);
                        return;
                    }
                    if (win.__ji_bridge_ready) { resolve(true); return; }
                } catch (_) { /* cross-origin until page mounts */ }
                setTimeout(tick, 300);
            }
            tick();
        });
    }

    function rpc(win, op, args, timeoutMs) {
        args = args || {};
        timeoutMs = timeoutMs || 90000;
        return new Promise(function (resolve, reject) {
            const id = 'rpc_' + Math.random().toString(36).slice(2, 10);
            function onMsg(ev) {
                if (!ev.data || ev.data.__ji !== true || ev.data.id !== id) return;
                window.removeEventListener('message', onMsg);
                if (ev.data.ok) resolve(ev.data.payload);
                else reject(new Error(typeof ev.data.payload === 'string' ? ev.data.payload : (ev.data.error || 'rpc failed')));
            }
            window.addEventListener('message', onMsg);
            try { win.postMessage({ __ji: true, id: id, op: op, args: args }, '*'); }
            catch (e) { window.removeEventListener('message', onMsg); reject(e); }
            setTimeout(function () {
                window.removeEventListener('message', onMsg);
                reject(new Error('rpc "' + op + '" timed out'));
            }, timeoutMs);
        });
    }

    function popupLocation(win) { try { return win.location.href; } catch (_) { return ''; } }

    function popupWaitUrl(win, needle, timeoutMs) {
        timeoutMs = timeoutMs || 30000;
        return new Promise(function (resolve, reject) {
            const deadline = Date.now() + timeoutMs;
            function tick() {
                if (Date.now() > deadline) return reject(new Error('popup did not navigate to ' + needle));
                const u = popupLocation(win);
                if (u && u.indexOf(needle) >= 0) return resolve(u);
                setTimeout(tick, 350);
            }
            tick();
        });
    }

    // -------- CHARACTER ID -------------------------------------------------------

    function parseCharacterId(input) {
        const s = String(input || '').trim();
        const m = s.match(/[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}/i);
        if (!m) throw new Error('Не нашёл UUID персонажа в URL. Ожидаю ссылку вида https://janitorai.com/characters/<UUID>...');
        return m[0];
    }

    function isCardPublic(meta) {
        return !!(meta && meta.showdefinition
            && (String(meta.personality || '').trim() || String(meta.scenario || '').trim()));
    }

    function firstMessagesFromMeta(meta) {
        const out = [];
        function push(v) {
            const s = String(v == null ? '' : v).trim();
            if (s && out.indexOf(s) < 0) out.push(s);
        }
        if (meta) {
            if (Array.isArray(meta.first_messages)) meta.first_messages.forEach(push);
            push(meta.first_message);
            if (Array.isArray(meta.alternate_greetings)) meta.alternate_greetings.forEach(push);
        }
        return out;
    }

    function htmlToText(html) {
        return String(html || '')
            .replace(/<br\s*\/?>/gi, '\n')
            .replace(/<\/(p|div|li|h\d)>/gi, '\n')
            .replace(/<[^>]+>/g, '')
            .replace(/&nbsp;/g, ' ').replace(/&amp;/g, '&').replace(/&lt;/g, '<')
            .replace(/&gt;/g, '>').replace(/&#39;|&apos;/g, "'").replace(/&quot;/g, '"')
            .replace(/\n{3,}/g, '\n\n').replace(/[ \t]+/g, ' ').trim();
    }

    function avatarUrl(meta) {
        if (!meta) return null;
        var av = meta.avatar || meta.profile_image || '';
        if (!av) return null;
        return /^https?:\/\//i.test(av) ? av : 'https://ella.janitorai.com/bot-avatars/' + av + '?width=1200';
    }

    // -------- SEPARATION (port of JAR's src/separate.js) -----------------------

    function getSystemContent(payload) {
        const msgs = (payload && Array.isArray(payload.messages)) ? payload.messages : [];
        for (let i = 0; i < msgs.length; i++) {
            const m = msgs[i];
            if (m && m.role === 'system' && typeof m.content === 'string') return m.content;
        }
        return '';
    }

    function stripWrappers(text) {
        let out = text;
        out = out.replace(/^\s*(?:\[[^\]]*\]\s*)+/, '');
        out = out.replace(/<[^<>\n]*?Persona>[\s\S]*?<\/[^<>\n]*?Persona>/gi, '\n');
        out = out.replace(/<Scenario>[\s\S]*?<\/Scenario>/gi, '\n');
        out = out.replace(/<Example[^<>\n]*>[\s\S]*?<\/Example[^<>\n]*>/gi, '\n');
        return out;
    }

    function norm(s) { return s.replace(/\s+/g, ' ').trim().toLowerCase(); }

    function subtractKnownCard(text, knownCard) {
        if (!knownCard || !knownCard.trim()) return text;
        const known = new Set();
        const klines = knownCard.split('\n');
        for (let i = 0; i < klines.length; i++) {
            const n = norm(klines[i]);
            if (n.length >= 12) known.add(n);
        }
        const kept = [];
        const tlines = text.split('\n');
        for (let i = 0; i < tlines.length; i++) {
            const n = norm(tlines[i]);
            if (n.length >= 12 && known.has(n)) continue;
            kept.push(tlines[i]);
        }
        return kept.join('\n');
    }

    function loosePattern(needle) {
        return needle
            .replace(/[.*+?^${}()|[\]\\]/g, '\\$&')
            .replace(/\s+/g, '\\s+')
            .replace(/['\u2018\u2019\u02BC]/g, "['\\u2018\\u2019\\u02BC]")
            .replace(/["\u201C\u201D]/g, '["\\u201C\\u201D]')
            .replace(/[-\u2013\u2014]/g, '[-\\u2013\\u2014]');
    }

    function stripPublicEntries(text, publicContents) {
        if (!Array.isArray(publicContents) || !publicContents.length) return text;
        let out = text;
        for (let i = 0; i < publicContents.length; i++) {
            const needle = String(publicContents[i] || '').trim();
            if (needle.length < 12) continue;
            let re;
            try { re = new RegExp(loosePattern(needle), 'gi'); }
            catch (_) { continue; }
            out = out.replace(re, '\n');
        }
        return out;
    }

    function tidy(text) {
        return text.replace(/[ \t]+\n/g, '\n').replace(/\n{3,}/g, '\n\n').trim();
    }

    function extractCard(payload) {
        const sys = getSystemContent(payload);
        const re = /<([^<>\n]*?)Persona>([\s\S]*?)<\/[^<>\n]*?Persona>/gi;
        let m;
        while ((m = re.exec(sys))) {
            if (/^\s*user/i.test(m[1])) continue;
            return m[2].trim();
        }
        return '';
    }

    function extractCharName(payload) {
        const sys = getSystemContent(payload);
        const m = sys.match(/<([^<>\n]*?)Persona>/i);
        if (m) {
            let name = m[1].replace(/['\u2019]s\s*$/i, '').trim();
            if (name.toLowerCase() !== 'user') return name;
        }
        return '';
    }

    function extractScenario(payload) {
        const sys = getSystemContent(payload);
        const m = sys.match(/<Scenario>([\s\S]*?)<\/Scenario>/i);
        return m ? m[1].trim() : '';
    }

    function extractExample(payload) {
        const sys = getSystemContent(payload);
        const m = sys.match(/<Example[^<>\n]*?>([\s\S]*?)<\/Example[^<>\n]*?>/i);
        return m ? m[1].trim() : '';
    }

    function extractFirstMessage(payload) {
        const msgs = (payload && Array.isArray(payload.messages)) ? payload.messages : [];
        for (let i = 0; i < msgs.length; i++) {
            const m = msgs[i];
            if (m && m.role === 'assistant' && typeof m.content === 'string') return m.content.trim();
        }
        return '';
    }

    function publicEntryContents(books) {
        const out = [];
        if (!Array.isArray(books)) return out;
        for (let i = 0; i < books.length; i++) {
            const b = books[i];
            if (!b || !b.worldInfo || !b.worldInfo.entries) continue;
            const entries = b.worldInfo.entries;
            for (const k in entries) {
                if (!Object.prototype.hasOwnProperty.call(entries, k)) continue;
                const e = entries[k];
                if (e && typeof e.content === 'string' && e.content.trim()) out.push(e.content);
            }
        }
        return out;
    }

    function separate(payload, knownCard, publicContents) {
        const systemContent = getSystemContent(payload);
        let t = stripWrappers(systemContent);
        t = subtractKnownCard(t, knownCard);
        t = stripPublicEntries(t, publicContents);
        const lorebookText = tidy(t);
        const entryBlocks = lorebookText.split(/\n\s*\n/).map(function (b) { return b.trim(); }).filter(Boolean);
        return { systemContent: systemContent, lorebookText: lorebookText, entries: entryBlocks };
    }

    // -------- LLM CLIENT (uses ST's own settings) -------------------------------

    function getSTApiConfig() {
        const ctx = window.SillyTavern && window.SillyTavern.getContext && window.SillyTavern.getContext();
        let baseUrl = '', apiKey = '', model = '';
        try { baseUrl = (ctx && ctx.getApiUrl && ctx.getApiUrl()) || ''; } catch (_) { }
        if (!baseUrl) {
            try { baseUrl = localStorage.getItem('ApiUrl') || localStorage.getItem('apiUrl') || ''; } catch (_) { }
        }
        try { apiKey = (ctx && ctx.getApiKey && ctx.getApiKey()) || ''; } catch (_) { }
        if (!apiKey) {
            try { apiKey = localStorage.getItem('ApiKey') || localStorage.getItem('apiKey') || ''; } catch (_) { }
        }
        try { model = (ctx && ctx.getModel && ctx.getModel()) || ''; } catch (_) { }
        if (!model) {
            try { model = localStorage.getItem('Model') || localStorage.getItem('model') || ''; } catch (_) { }
        }
        baseUrl = String(baseUrl || '').replace(/\/+$/, '');
        return { baseUrl: baseUrl, apiKey: apiKey, model: model };
    }

    function stLlmAvailable() {
        const c = getSTApiConfig();
        return !!(c.baseUrl && c.model);
    }

    function chatCompletion(opts) {
        return new Promise(function (resolve, reject) {
            const cfg = getSTApiConfig();
            if (!cfg.baseUrl || !cfg.model) {
                return reject(new Error('ST API не настроен. Открой SillyTavern → API Connections и подключи любую модель.'));
            }
            const timeoutMs = opts.timeoutMs || 120000;
            const messages = opts.messages || [];
            const temperature = (opts.temperature != null) ? opts.temperature : 0.2;
            const json = !!opts.json;
            const ctl = new AbortController();
            const t = setTimeout(function () { ctl.abort(); }, timeoutMs);
            const headers = { 'Content-Type': 'application/json' };
            if (cfg.apiKey) headers.Authorization = 'Bearer ' + cfg.apiKey;
            const body = { model: cfg.model, temperature: temperature, messages: messages };
            if (json) body.response_format = { type: 'json_object' };
            fetch(cfg.baseUrl + '/v1/chat/completions', {
                method: 'POST', headers: headers, signal: ctl.signal, body: JSON.stringify(body),
            }).then(function (resp) {
                if (!resp.ok) {
                    return resp.text().then(function (t2) {
                        throw new Error('LLM HTTP ' + resp.status + ': ' + (t2 || '').slice(0, 400));
                    });
                }
                return resp.json();
            }).then(function (data) {
                clearTimeout(t);
                const content = (data && data.choices && data.choices[0] && data.choices[0].message && data.choices[0].message.content) || '';
                if (!content) throw new Error('LLM вернул пустой ответ.');
                resolve(content);
            }).catch(function (e) {
                clearTimeout(t);
                reject(e);
            });
        });
    }

    // -------- LOREBOOK REBUILD PROMPTS (mirror of JAR's extract.js) -------------

    const SYSTEM_PROMPT =
        'You reconstruct a SillyTavern World Info (lorebook) from raw text.\n' +
        '\n' +
        'You are given text that was extracted from an LLM chat prompt. It contains one or more\n' +
        'lorebook entries that a roleplay platform injected into the prompt because their trigger\n' +
        'keywords matched. The character card and user persona have already been removed; what\n' +
        'remains is lorebook entry bodies concatenated together (often separated by blank lines).\n' +
        '\n' +
        'Your job:\n' +
        '1. Split the text into discrete, self-contained World Info entries. Each coherent block\n' +
        '   about one topic (a person, place, faction, item, rule, lore fact) is one entry. Do NOT\n' +
        '   merge unrelated topics; do NOT split a single topic across entries.\n' +
        '2. For each entry, write:\n' +
        '   - "content": the entry body, cleaned up but faithful to the source (keep the facts).\n' +
        '   - "key": an array of primary trigger keywords/phrases a chat would mention to surface\n' +
        '     this entry (names, aliases, places, distinctive nouns). Infer them from the content,\n' +
        '     and from the character card if one is provided as context.\n' +
        '   - "keysecondary": optional array of secondary keywords (leave [] if not needed).\n' +
        '   - "comment": a short title for the entry (the topic name).\n' +
        '   - "order": optional integer insertion order (lower = inserted earlier); default 100.\n' +
        '3. Output ONLY a JSON object of the form:\n' +
        '   { "entries": [ { "comment": "...", "key": ["..."], "keysecondary": [], "content": "...", "order": 100 }, ... ] }\n' +
        'No markdown, no prose, no code fences — JSON only.';

    function buildRebuildMessages(lorebookText, opts) {
        opts = opts || {};
        const parts = [];
        if (opts.card) parts.push('CONTEXT — character card. Use ONLY to infer keys. Do NOT output as entries:\n\n' + opts.card);
        if (opts.catalog) parts.push('CONTEXT — public catalog description. Use ONLY to infer keys:\n\n' + opts.catalog);
        if (opts.scenario) parts.push('CONTEXT — scenario. Use ONLY to infer keys:\n\n' + opts.scenario);
        if (opts.greetings) parts.push('CONTEXT — opening message(s). Use ONLY to infer keys:\n\n' + opts.greetings);
        if (opts.lorebookDescs) parts.push('CONTEXT — attached public lorebook titles + descriptions. Use ONLY to infer keys:\n\n' + opts.lorebookDescs);
        if (opts.extra) parts.push('CONTEXT — extra notes:\n\n' + opts.extra);
        parts.push('Raw lorebook text to convert into entries:\n\n' + lorebookText);
        return [
            { role: 'system', content: SYSTEM_PROMPT },
            { role: 'user', content: parts.join('\n\n---\n\n') }
        ];
    }

    function stripFences(text) {
        let t = String(text).trim();
        const fence = t.match(/^```(?:json)?\s*([\s\S]*?)\s*```$/i);
        if (fence) t = fence[1].trim();
        const first = t.search(/[[{]/);
        const lastObj = t.lastIndexOf('}');
        const lastArr = t.lastIndexOf(']');
        const last = Math.max(lastObj, lastArr);
        if (first >= 0 && last > first) t = t.slice(first, last + 1);
        return t;
    }

    function rebuildLorebook(lorebookText, opts, log) {
        return new Promise(function (resolve, reject) {
            if (!lorebookText.trim()) return reject(new Error('Закрытый лорбук пустой — триггер не сработал или у персонажа нет закрытого лорбука.'));
            log('LLM-rebuild: ' + lorebookText.length + ' chars → /v1/chat/completions');
            const messages = buildRebuildMessages(lorebookText, opts);
            chatCompletion({ messages: messages, temperature: 0.2, json: true, timeoutMs: 240000 })
                .then(function (reply) {
                    let parsed;
                    try { parsed = JSON.parse(stripFences(reply)); }
                    catch (_) { return reject(new Error('LLM ответ не парсится как JSON. Покажи в логе.')); }
                    let entries;
                    if (Array.isArray(parsed)) entries = parsed;
                    else if (parsed && Array.isArray(parsed.entries)) entries = parsed.entries;
                    else if (parsed && parsed.entries && typeof parsed.entries === 'object') entries = Object.values(parsed.entries);
                    else entries = [];
                    if (!entries.length) return reject(new Error('LLM не выделил ни одной записи. Возможно, закрытые лорбуки не сработали на триггерах.'));
                    resolve(entries);
                })
                .catch(reject);
        });
    }

    // -------- WORLDINFO BUILDER (mirror of JAR's worldinfo.js) ------------------

    function asArrayWI(v) {
        if (Array.isArray(v)) return v.map(function (x) { return String(x).trim(); }).filter(Boolean);
        if (typeof v === 'string') return v.split(',').map(function (x) { return x.trim(); }).filter(Boolean);
        return [];
    }

    function buildEntryWI(raw, uid) {
        const key = asArrayWI(raw.key || raw.keys || raw.keywords);
        const keysecondary = asArrayWI(raw.keysecondary || raw.secondary_keys || raw.keySecondary);
        const content = String(raw.content || raw.text || '').trim();
        const comment = String(raw.comment || raw.title || raw.name || raw.category || ('Entry ' + uid)).trim();
        const order = Number.isFinite(raw.order) ? raw.order
            : Number.isFinite(raw.priority) ? raw.priority
                : Number.isFinite(raw.insertion_order) ? raw.insertion_order : 100;
        const constant = raw.constant === true;
        const probability = raw.probability === undefined ? 100
            : (raw.probability <= 1 ? raw.probability * 100 : raw.probability);
        return {
            uid: uid, key: key, keysecondary: keysecondary, comment: comment, content: content, constant: constant,
            selective: !constant, order: order,
            position: Number.isFinite(raw.position) ? raw.position : 0,
            disable: raw.enabled === false, displayIndex: uid,
            addMemo: true, group: '', groupOverride: false, groupWeight: 100,
            sticky: 0, cooldown: 0, delay: 0, probability: probability, depth: 4, useProbability: true,
            role: null, vectorized: false, excludeRecursion: false, preventRecursion: false,
            delayUntilRecursion: false, scanDepth: null,
            caseSensitive: raw.case_sensitive !== undefined ? raw.case_sensitive : null,
            matchWholeWords: raw.matchWholeWords !== undefined ? raw.matchWholeWords : null,
            useGroupScoring: null, automationId: '', selectiveLogic: Number.isFinite(raw.selectiveLogic) ? raw.selectiveLogic : 0,
            ignoreBudget: false, matchPersonaDescription: false, matchCharacterDescription: false,
            matchCharacterPersonality: false, matchCharacterDepthPrompt: false, matchScenario: false, matchCreatorNotes: false,
            outletName: '', triggers: [],
            characterFilter: { isExclude: false, names: [], tags: [] }
        };
    }

    function buildWorldInfoWI(rawEntries) {
        const entries = {};
        let uid = 0;
        for (let i = 0; i < rawEntries.length; i++) {
            const raw = rawEntries[i];
            if (!raw) continue;
            const e = buildEntryWI(raw, uid);
            if (!e.content) { uid++; continue; }
            entries[String(uid)] = e;
            uid++;
        }
        return { entries: entries };
    }

    // -------- CHARACTER CARD ----------------------------------------------------

    function fetchAsDataUrl(url) {
        return new Promise(function (resolve) {
            try {
                fetch(url).then(function (r) {
                    if (!r.ok) return resolve('');
                    r.blob().then(function (b) {
                        const fr = new FileReader();
                        fr.onloadend = function () { resolve(fr.result || ''); };
                        fr.onerror = function () { resolve(''); };
                        fr.readAsDataURL(b);
                    }, function () { resolve(''); });
                }, function () { resolve(''); });
            } catch (_) { resolve(''); }
        });
    }

    function buildCardData(o) {
        const data = {
            name: o.name || 'unnamed',
            description: o.description || '',
            personality: '',
            scenario: o.scenario || '',
            first_mes: o.firstMessage || '',
            mes_example: o.exampleMessages || '',
            creator_notes: o.creatorNotes || '',
            tags: Array.isArray(o.tags) ? o.tags : String(o.tags || '').split(',').map(function (t) { return t.trim(); }).filter(Boolean),
            alternate_greetings: o.alternateGreetings || [],
            talkativeness: 0.5, fav: false,
            creator: 'janitor-import-ext',
            character_version: '1.0',
        };
        return { spec: 'chara_card_v2', spec_version: '2.0', data: data, avatar: o.avatarBase64 || 'none' };
    }

    function dataURLtoBlob(dataUrl) {
        if (!dataUrl || !dataUrl.startsWith('data:')) return new Blob([new Uint8Array(0)], { type: 'image/png' });
        const i = dataUrl.indexOf(',');
        if (i < 0) return new Blob([new Uint8Array(0)], { type: 'image/png' });
        const meta = dataUrl.slice(0, i);
        const b64 = dataUrl.slice(i + 1);
        const mimeMatch = meta.match(/data:([^;]+)/);
        const mime = (mimeMatch && mimeMatch[1]) || 'image/png';
        try {
            const bin = atob(b64);
            const u8 = new Uint8Array(bin.length);
            for (let j = 0; j < bin.length; j++) u8[j] = bin.charCodeAt(j);
            return new Blob([u8], { type: mime });
        } catch (_) {
            return new Blob([new Uint8Array(0)], { type: 'image/png' });
        }
    }

    function downloadBlob(content, filename, mime, isBase64) {
        let url;
        try {
            if (isBase64) {
                const bin = atob(content);
                const u8 = new Uint8Array(bin.length);
                for (let i = 0; i < bin.length; i++) u8[i] = bin.charCodeAt(i);
                url = URL.createObjectURL(new Blob([u8], { type: mime }));
            } else {
                url = URL.createObjectURL(new Blob([content], { type: mime }));
            }
        } catch (_) {
            url = URL.createObjectURL(new Blob([content || ''], { type: mime }));
        }
        const a = document.createElement('a');
        a.href = url;
        a.download = filename;
        document.body.appendChild(a);
        a.click();
        setTimeout(function () { URL.revokeObjectURL(url); a.remove(); }, 0);
    }

    function importCharacter(characterData, fileBase) {
        return new Promise(function (resolve) {
            const v2 = JSON.stringify(characterData);
            const form = new FormData();
            form.append('avatar', dataURLtoBlob(characterData.avatar && characterData.avatar !== 'none' ? characterData.avatar : ''), 'avatar.png');
            form.append('chara', v2);
            fetch('/api/characters/import', { method: 'POST', body: form }).then(function (r) {
                if (r.ok) { r.json().then(function (j) { resolve(j || { ok: true }); }).catch(function () { resolve({ ok: true }); }); return; }
                downloadBlob(v2, fileBase + '.json', 'application/json');
                if (characterData.avatar && characterData.avatar.startsWith('data:')) {
                    downloadBlob(characterData.avatar.split(',')[1], fileBase + '.png', 'image/png', true);
                }
                resolve({ ok: false, fallback: true });
            }).catch(function () {
                downloadBlob(v2, fileBase + '.json', 'application/json');
                if (characterData.avatar && characterData.avatar.startsWith('data:')) {
                    downloadBlob(characterData.avatar.split(',')[1], fileBase + '.png', 'image/png', true);
                }
                resolve({ ok: false, fallback: true });
            });
        });
    }

    function importWorldInfo(name, worldInfo) {
        return new Promise(function (resolve) {
            const file = new File([JSON.stringify(worldInfo)], name + '.json', { type: 'application/json' });
            const form = new FormData();
            form.append('name', name);
            form.append('file', file);
            fetch('/api/worldinfo/import', { method: 'POST', body: form }).then(function (r) {
                if (r.ok) { r.json().then(function (j) { resolve(j || { ok: true }); }).catch(function () { resolve({ ok: true }); }); return; }
                try {
                    const ctx = window.SillyTavern && window.SillyTavern.getContext && window.SillyTavern.getContext();
                    if (ctx && typeof ctx.saveWorldInfo === 'function') {
                        Promise.resolve(ctx.saveWorldInfo(name, worldInfo, true)).then(function () { resolve({ ok: true }); }, function () { fallbackDownload(); });
                        return;
                    }
                } catch (_) { }
                fallbackDownload();
                function fallbackDownload() {
                    downloadBlob(JSON.stringify(worldInfo), name + '.json', 'application/json');
                    resolve({ ok: false, fallback: true });
                }
            }).catch(function () {
                fallbackDownload();
                function fallbackDownload() {
                    downloadBlob(JSON.stringify(worldInfo), name + '.json', 'application/json');
                    resolve({ ok: false, fallback: true });
                }
            });
        });
    }

    // -------- TRANSLATION SERVICE (keys → target language) -----------------------

    const TRANSLATE_SYS =
        'You translate roleplay lorebook trigger keys (names, places, items, factions, races, spells, terms) into the target language.\n' +
        '\n' +
        'Rules:\n' +
        '- Output ONLY a JSON object of the form: { "translations": [ "<translated 1>", "<translated 2>", ... ] }\n' +
        '- The output array MUST have the same length and order as the input array.\n' +
        '- Keep proper-noun transliterations that the community already uses in the target language.\n' +
        '- Return each noun in nominative singular form (Russian: именительный падеж, единственное число — "магия", NOT "магию" / "магии" / "магией").\n' +
        '- DO NOT add explanations, markdown, or anything else. JSON only.';

    function translateKeysBatch(keys, targetLang, log) {
        return new Promise(function (resolve, reject) {
            if (!stLlmAvailable()) return reject(new Error('ST API не настроен.'));
            if (!keys.length) return resolve([]);
            log('Translating ' + keys.length + ' keys → ' + targetLang);
            chatCompletion({
                temperature: 0.3, json: true, timeoutMs: 180000,
                messages: [
                    { role: 'system', content: TRANSLATE_SYS },
                    { role: 'user', content: 'Target language: ' + targetLang + '\n\nKeys (JSON array, in order):\n' + JSON.stringify(keys) }
                ]
            }).then(function (reply) {
                let parsed;
                try { parsed = JSON.parse(stripFences(reply)); }
                catch (_) {
                    const m = reply.match(/"translations"\s*:\s*\[([\s\S]*?)\]/);
                    if (m) {
                        try { parsed = { translations: JSON.parse('[' + m[1] + ']') }; }
                        catch (_) { return reject(new Error('LLM не вернул JSON массив переводов.')); }
                    } else {
                        return reject(new Error('LLM не вернул JSON массив переводов.'));
                    }
                }
                const arr = (parsed && Array.isArray(parsed.translations)) ? parsed.translations : [];
                if (arr.length !== keys.length) return reject(new Error('LLM вернул ' + arr.length + ' переводов на ' + keys.length + ' ключей. Retry.'));
                resolve(arr.map(function (x, i) { return String(x || '').trim() || keys[i]; }));
            }).catch(reject);
        });
    }

    function translateWorldInfoKeys(worldInfo, targetLang, log) {
        return new Promise(function (resolve, reject) {
            const entries = Object.values(worldInfo.entries || {});
            const keyIndex = [];
            const seen = new Set();
            for (let i = 0; i < entries.length; i++) {
                const e = entries[i];
                for (let fi = 0; fi < 2; fi++) {
                    const field = fi === 0 ? 'key' : 'keysecondary';
                    const arr = Array.isArray(e[field]) ? e[field] : [];
                    for (let j = 0; j < arr.length; j++) {
                        const original = arr[j];
                        if (!original || seen.has(original)) continue;
                        seen.add(original);
                        keyIndex.push({ entryUid: e.uid, field: field, idx: j, original: original });
                    }
                }
            }
            if (!keyIndex.length) { log('no keys to translate'); return resolve(worldInfo); }
            const BATCH = 40;
            const translation = new Map();
            const batches = [];
            for (let i = 0; i < keyIndex.length; i += BATCH) batches.push(keyIndex.slice(i, i + BATCH));
            let chain = Promise.resolve();
            batches.forEach(function (slice) {
                chain = chain.then(function () {
                    const keys = slice.map(function (k) { return k.original; });
                    return translateKeysBatch(keys, targetLang, log).then(function (tr) {
                        for (let j = 0; j < slice.length; j++) translation.set(slice[j].original, tr[j]);
                    });
                });
            });
            chain.then(function () {
                const newEntries = JSON.parse(JSON.stringify(worldInfo.entries));
                for (const uidStr in newEntries) {
                    if (!Object.prototype.hasOwnProperty.call(newEntries, uidStr)) continue;
                    const e = newEntries[uidStr];
                    for (let fi = 0; fi < 2; fi++) {
                        const field = fi === 0 ? 'key' : 'keysecondary';
                        const arr = Array.isArray(e[field]) ? e[field] : [];
                        for (let i = 0; i < arr.length; i++) {
                            if (arr[i] && translation.has(arr[i])) {
                                const newVal = translation.get(arr[i]);
                                const next = arr.slice(0, i).concat([newVal]).concat(arr.slice(i + 1))
                                    .map(function (s) { return String(s || '').trim(); }).filter(Boolean);
                                const uniq = [];
                                const seen2 = new Set();
                                for (let k = 0; k < next.length; k++) {
                                    const key = next[k].toLowerCase();
                                    if (!seen2.has(key)) { seen2.add(key); uniq.push(next[k]); }
                                }
                                e[field] = uniq;
                            }
                        }
                    }
                }
                resolve(Object.assign({}, worldInfo, { entries: newEntries }));
            }).catch(reject);
        });
    }

    function listWorldInfos() {
        try {
            const ctx = window.SillyTavern && window.SillyTavern.getContext && window.SillyTavern.getContext();
            if (ctx && Array.isArray(ctx.worldInfoNames)) return ctx.worldInfoNames.map(function (n) { return { name: n }; });
            const raw = localStorage.getItem('worldInfo');
            if (!raw) return [];
            const data = JSON.parse(raw);
            const out = [];
            for (const k in data) {
                if (!Object.prototype.hasOwnProperty.call(data, k)) continue;
                out.push({ name: (data[k] && data[k].name) || k });
            }
            return out;
        } catch (_) { return []; }
    }

    function loadWorldInfoByName(name) {
        try {
            const ctx = window.SillyTavern && window.SillyTavern.getContext && window.SillyTavern.getContext();
            if (ctx && typeof ctx.loadWorldInfo === 'function') return ctx.loadWorldInfo(name);
        } catch (_) { }
        try {
            const raw = localStorage.getItem('worldInfo');
            if (!raw) return null;
            const data = JSON.parse(raw);
            return (data && data[name]) ? data[name] : null;
        } catch (_) { return null; }
    }

    // -------- CHAT TRIGGERS (probe + closed-lorebook extraction) ----------------

    function runChatProbe(characterId, greetingsAll, popup) {
        return new Promise(function (resolve, reject) {
            let chatId = null;
            rpc(popup, 'createChat', { characterId: characterId }, 60000).then(function (cid) {
                chatId = cid;
                return rpc(popup, 'gotoChat', { chatId: cid }, 60000);
            }).then(function () {
                return popupWaitUrl(popup, '/chats/' + chatId, 30000);
            }).then(function () { return injectBridge(popup, function () { }); })
            .then(function () { return new Promise(function (r) { setTimeout(r, 1500); }); })
            .then(function () { return rpc(popup, 'sendMessage', { text: '.' }, 30000); })
            .then(function () { return rpc(popup, 'interceptGenerateAlpha', { tag: 'probe_' + chatId, timeout: 60000 }, 65000); })
            .then(function (probePayload) {
                const card = extractCard(probePayload);
                if (!card) return reject(new Error('Не нашёл блок <...Persona> в первом перехваченном запросе.'));
                const firstMsg = (greetingsAll && greetingsAll[0]) || '';
                const trigger = firstMsg ? (card + '\n\n' + firstMsg) : card;
                return new Promise(function (r) { setTimeout(r, 800); })
                    .then(function () { return rpc(popup, 'sendMessage', { text: trigger }, 30000); })
                    .then(function () { return rpc(popup, 'interceptGenerateAlpha', { tag: 'main_' + chatId, timeout: 120000 }, 125000); })
                    .then(function (payload) {
                        const built = buildCardData({
                            name: extractCharName(payload) || '',
                            description: card,
                            scenario: extractScenario(payload) || '',
                            firstMessage: extractFirstMessage(payload) || (greetingsAll && greetingsAll[0]) || '',
                            alternateGreetings: (greetingsAll && greetingsAll.slice(1)) || [],
                            exampleMessages: extractExample(payload) || '',
                            creatorNotes: '', tags: [], avatarBase64: ''
                        });
                        resolve({ characterData: built, chatId: chatId });
                    });
            }).catch(reject);
        });
    }

    function extractClosedLorebookRaw(characterId, ctxOpts, greetingsAll, popup) {
        return new Promise(function (resolve, reject) {
            let chatId = null;
            rpc(popup, 'createChat', { characterId: characterId }, 60000).then(function (cid) {
                chatId = cid;
                return rpc(popup, 'gotoChat', { chatId: cid }, 60000);
            }).then(function () {
                return popupWaitUrl(popup, '/chats/' + chatId, 30000);
            }).then(function () { return injectBridge(popup, function () { }); })
            .then(function () { return new Promise(function (r) { setTimeout(r, 1500); }); })
            .then(function () { return rpc(popup, 'sendMessage', { text: '.' }, 30000); })
            .then(function () { return rpc(popup, 'interceptGenerateAlpha', { tag: 'cb_probe_' + chatId, timeout: 60000 }, 65000); })
            .then(function (probePayload) {
                const card = extractCard(probePayload);
                if (!card) return reject(new Error('Не нашёл карточку в первом перехвате.'));
                const firstMsg = (greetingsAll && greetingsAll[0]) || '';
                const trigger = firstMsg ? (card + '\n\n' + firstMsg) : card;
                return new Promise(function (r) { setTimeout(r, 800); })
                    .then(function () { return rpc(popup, 'sendMessage', { text: trigger }, 30000); })
                    .then(function () { return rpc(popup, 'interceptGenerateAlpha', { tag: 'cb_main_' + chatId, timeout: 120000 }, 125000); })
                    .then(function (payload) {
                        // best-effort cleanup
                        try { rpc(popup, 'deleteChat', { chatId: chatId }, 15000).catch(function () { }); } catch (_) { }
                        const pubContents = []; // we don't have public books here in this call path
                        const sep = separate(payload, card, pubContents);
                        resolve({ rawText: sep.lorebookText, card: card });
                    });
            }).catch(reject);
        });
    }

    // -------- MAIN FLOW --------------------------------------------------------

    function runImport(opts) {
        const url = opts.url;
        const wantCard = !!opts.wantCard;
        const wantPublicLore = !!opts.wantPublicLore;
        const wantClosedLore = !!opts.wantClosedLore;
        const translateKeysTo = opts.translateKeysTo || '';
        const log = opts.log || function () { };
        const prog = opts.prog || function () { };

        return new Promise(function (resolve, reject) {
            let characterId;
            try { characterId = parseCharacterId(url); }
            catch (e) { return reject(e); }
            const openUrl = /^https?:/.test(url) ? url : (JANITOR_ORIGIN + '/characters/' + characterId);

            let popup = null;
            prog(0.05);
            log('Открываю ' + openUrl + ' во всплывающей вкладке…');
            popup = openJanitorPopup(openUrl);
            if (!popup) return reject(new Error('Не удалось открыть всплывающее окно — разреши попапы для SillyTavern и попробуй снова.'));

            popupWaitUrl(popup, '/characters/' + characterId, 45000).then(function () {
                prog(0.12);
                log('Внедряю мост в janitorai.com…');
                return injectBridge(popup, log);
            }).then(function () {
                prog(0.18);
                log('Читаю метаданные персонажа…');
                return rpc(popup, 'inspect', { characterId: characterId }, 60000);
            }).then(function (meta) {
                if (!meta || !meta.id) throw new Error('Пустой ответ метаданных — попробуй снова.');
                const greetingsAll = firstMessagesFromMeta(meta);

                function stepPublicLorebooks() {
                    if (!wantPublicLore) return Promise.resolve([]);
                    const scripts = (meta.scripts || []).filter(function (s) {
                        return s && (s.type === 'lorebook' || s.type === 'advanced') && s.id;
                    });
                    if (!scripts.length) { log('Публичных лорбуков нет.'); return Promise.resolve([]); }
                    log('Найдено ' + scripts.length + ' привязанных лорбуков, скачиваю…');
                    const out = [];
                    let i = 0;
                    function next() {
                        if (i >= scripts.length) return Promise.resolve(out);
                        const s = scripts[i];
                        log('  [' + (i + 1) + '/' + scripts.length + '] ' + (s.title || s.id));
                        prog(0.20 + 0.18 * (i + 1) / Math.max(1, scripts.length));
                        return rpc(popup, 'fetchPublicLorebook', { scriptId: String(s.id) }, 60000)
                            .then(function (r) { out.push(r); })
                            .catch(function (e) { log('  ✗ не удалось: ' + (e.message || e)); })
                            .then(function () { i++; return next(); });
                    }
                    return next();
                }

                function stepCard() {
                    if (!wantCard) return Promise.resolve(null);
                    if (isCardPublic(meta)) {
                        log('Карточка публичная — беру поля напрямую.');
                        const avUrl = avatarUrl(meta);
                        return fetchAsDataUrl(avUrl || '').then(function (avatarBase64) {
                            return buildCardData({
                                name: meta.name,
                                description: meta.personality || '',
                                scenario: meta.scenario || '',
                                firstMessage: greetingsAll[0] || '',
                                alternateGreetings: greetingsAll.slice(1),
                                exampleMessages: meta.example_dialogs || '',
                                creatorNotes: meta.description || '',
                                tags: meta.custom_tags || [],
                                avatarBase64: avatarBase64 || ''
                            });
                        });
                    }
                    log('Карточка закрытая — извлекаю через чат-триггер.');
                    if (!stLlmAvailable()) log('⚠ ST API не настроен — закрытая карточка не может быть декодирована без LLM. Открой API Connections.');
                    return runChatProbe(characterId, greetingsAll, popup).then(function (res) { return res.characterData; });
                }

                function stepClosedLore(characterData) {
                    if (!wantClosedLore) return Promise.resolve(null);
                    log('Создаю чат и триггерю закрытый лорбук…');
                    return extractClosedLorebookRaw(characterId, null, greetingsAll, popup).then(function (res) {
                        const rawText = res.rawText;
                        if (!rawText.trim()) {
                            log('Закрытый лорбук не сработал на триггерах — возможно, нужен закрытый аккаунт или его вообще нет.');
                            return null;
                        }
                        log('Получил ' + rawText.length + ' символов потенциального закрытого лорбука.');
                        const opts = {
                            card: (characterData && characterData.description) || '',
                            catalog: htmlToText(meta.description),
                            scenario: meta.scenario || '',
                            greetings: greetingsAll.join('\n\n---\n\n'),
                            lorebookDescs: publicBooks.map(function (b) {
                                return '- ' + b.title + (b.description ? ': ' + b.description : '');
                            }).join('\n')
                        };
                        return rebuildLorebook(rawText, opts, log).then(function (rawEntries) {
                            let wi = buildWorldInfoWI(rawEntries);
                            if (translateKeysTo && wi.entries && Object.keys(wi.entries).length) {
                                return translateWorldInfoKeys(wi, translateKeysTo, log).then(function (newWi) { return newWi; });
                            }
                            return wi;
                        });
                    });
                }

                let publicBooks = [];
                return stepPublicLorebooks().then(function (pb) {
                    publicBooks = pb;
                    prog(0.42);
                    return stepCard();
                }).then(function (characterData) {
                    prog(0.55);
                    return stepClosedLore(characterData).then(function (closedWI) {
                        prog(0.92);
                        const mergedWorldInfo = (publicBooks.length || closedWI)
                            ? (function () {
                                const out = { entries: {} };
                                let uid = 0;
                                for (let pi = 0; pi < publicBooks.length; pi++) {
                                    const b = publicBooks[pi];
                                    if (!b.worldInfo || !b.worldInfo.entries) continue;
                                    for (const k in b.worldInfo.entries) {
                                        if (!Object.prototype.hasOwnProperty.call(b.worldInfo.entries, k)) continue;
                                        const e = b.worldInfo.entries[k];
                                        if (!e.content) continue;
                                        const e2 = Object.assign({}, e, { uid: uid, displayIndex: uid });
                                        out.entries[String(uid)] = e2;
                                        uid++;
                                    }
                                }
                                if (closedWI) {
                                    for (const k in closedWI.entries) {
                                        if (!Object.prototype.hasOwnProperty.call(closedWI.entries, k)) continue;
                                        const e = closedWI.entries[k];
                                        if (!e.content) continue;
                                        const e2 = Object.assign({}, e, { uid: uid, displayIndex: uid });
                                        out.entries[String(uid)] = e2;
                                        uid++;
                                    }
                                }
                                return Object.keys(out.entries).length ? out : null;
                            })()
                            : null;
                        prog(0.96);
                        const baseName = (meta.name || 'character').replace(/[^\w.\- ]+/g, '_').slice(0, 60);
                        const results = { character: null, world: null, warnings: [], characterData: characterData, mergedWorldInfo: mergedWorldInfo, publicBooks: publicBooks };
                        let chain = Promise.resolve();
                        if (characterData) {
                            chain = chain.then(function () {
                                return importCharacter(characterData, baseName).then(function (r) {
                                    if (r && r.ok !== false) {
                                        results.character = baseName;
                                        log('✅ Персонаж "' + baseName + '" импортирован.');
                                    } else if (r && r.fallback) {
                                        results.warnings.push('Не удалось импортировать карточку автоматически — скачал файлы рядом. Перетащи .png + .json в SillyTavern.');
                                    }
                                });
                            });
                        }
                        if (mergedWorldInfo && Object.keys(mergedWorldInfo.entries).length) {
                            const wb = baseName + ' — World';
                            chain = chain.then(function () {
                                return importWorldInfo(wb, mergedWorldInfo).then(function (r) {
                                    if (r && r.ok !== false) {
                                        results.world = wb;
                                        log('✅ Лорбук "' + wb + '" сохранён (' + Object.keys(mergedWorldInfo.entries).length + ' записей).');
                                    } else if (r && r.fallback) {
                                        results.warnings.push('Лорбук скачан файлом — перетащи его во вкладку World Info.');
                                    }
                                });
                            });
                        }
                        return chain.then(function () {
                            prog(1.0);
                            try { popup.close(); } catch (_) { }
                            resolve(results);
                        });
                    });
                });
            }).catch(function (e) {
                // Make the error path sticky: keep the popup so the user can see what happened.
                try { if (popup) popup.close(); } catch (_) { }
                reject(e);
            });
        });
    }

    // -------- MODAL ENTRY POINTS -------------------------------------------------

    function buildMainModal() {
        const urlInput = textInput('');
        urlInput.placeholder = 'https://janitorai.com/characters/<UUID>...';
        const cardCb = checkbox(true);
        const publicCb = checkbox(true);
        const closedCb = checkbox(true);
        const translateCb = checkbox(false);
        const langSel = select([
            ['ru-RU', 'Russian'], ['uk-UA', 'Ukrainian'], ['en-US', 'English'],
            ['zh-CN', 'Chinese'], ['es-ES', 'Spanish'], ['ja-JP', 'Japanese'],
            ['__other__', 'Other…']
        ], 'ru-RU');
        const otherInput = textInput('');
        otherInput.placeholder = 'Custom language code/name';
        otherInput.style.display = 'none';
        langSel.addEventListener('change', function () {
            otherInput.style.display = langSel.value === '__other__' ? '' : 'none';
        });

        const body = document.createElement('div');
        body.appendChild(row('JanitorAI URL', urlInput, { labelWidth: '130px' }));
        body.appendChild(row('Import character card', cardCb, { labelWidth: '160px' }));
        body.appendChild(row('Public lorebooks', publicCb, { labelWidth: '160px' }));
        body.appendChild(row('Closed lorebooks (LLM)', closedCb, { labelWidth: '180px' }));
        body.appendChild(row('Translate trigger keys →', translateCb, { labelWidth: '180px' }));
        body.appendChild(row('Target language', langSel, { labelWidth: '180px' }));
        body.appendChild(row('', otherInput));
        const prog = progressArea();
        body.appendChild(prog);

        const cancel = button('Cancel', 'secondary');
        const go = button('Extract →', 'primary');
        const buttons = document.createElement('div');
        buttons.className = 'ji-modal-buttons';
        buttons.appendChild(cancel); buttons.appendChild(go);
        body.appendChild(buttons);


        const m = buildModal({ title: '🐰 Janitor Import', body });
        cancel.onclick = function () { m.overlay.remove(); };

        go.onclick = function () {
            const url = urlInput.value.trim();
            if (!url) { toast('Вставь ссылку на JanitorAI-персонажа.', 'error'); return; }
            go.disabled = true; cancel.disabled = true;
            const logFn = function (s) { prog.log(s); };
            const progressFn = function (f) { prog.setProgress(f); };
            let translateKeysTo = '';
            if (translateCb.checked) {
                translateKeysTo = (langSel.value === '__other__') ? otherInput.value.trim() : langSel.value;
                if (!translateKeysTo) { toast('Выбери язык или введи свой.', 'error'); go.disabled = false; cancel.disabled = false; return; }
                if (!stLlmAvailable()) toast('ST API не настроен — ключи не переведу. Открой API Connections в SillyTavern и подключи любую модель.', 'warning', 6000);
            }
            runImport({
                url: url,
                wantCard: cardCb.checked,
                wantPublicLore: publicCb.checked,
                wantClosedLore: closedCb.checked,
                translateKeysTo: translateKeysTo,
                log: logFn, prog: progressFn
            }).then(function (res) {
                logFn('— Готово —');
                if (res.warnings && res.warnings.length) {
                    for (let i = 0; i < res.warnings.length; i++) logFn('⚠ ' + res.warnings[i]);
                }
                toast('Импорт завершён: ' + (res.character || '(нет карточки)') + (res.world ? ' + ' + res.world : ''), 'success', 4000);
            }).catch(function (e) {
                logFn('✗ ' + (e.message || e));
                toast(e.message || String(e), 'error', 6000);
            }).then(function () {
                go.disabled = false; cancel.disabled = false;
            });
        };

        return m.overlay;
    }

    function buildTranslateModal() {
        const all = listWorldInfos();
        const options = [['__current__', '— Use currently-bound lorebook —']];
        for (let i = 0; i < all.length; i++) options.push([all[i].name, all[i].name]);
        const wiSel = select(options, '__current__');

        const langSel = select([
            ['ru-RU', 'Russian'], ['uk-UA', 'Ukrainian'], ['en-US', 'English'],
            ['zh-CN', 'Chinese'], ['es-ES', 'Spanish'], ['ja-JP', 'Japanese'],
            ['__other__', 'Other…']
        ], 'ru-RU');
        const otherInput = textInput('');
        otherInput.placeholder = 'Custom language code/name';
        otherInput.style.display = 'none';
        langSel.addEventListener('change', function () {
            otherInput.style.display = langSel.value === '__other__' ? '' : 'none';
        });

        const body = document.createElement('div');
        body.appendChild(row('World Info', wiSel, { labelWidth: '160px' }));
        body.appendChild(row('Translate keys →', langSel, { labelWidth: '180px' }));
        body.appendChild(row('', otherInput));
        const prog = progressArea();
        body.appendChild(prog);

        const cancel = button('Cancel', 'secondary');
        const go = button('Translate →', 'primary');
        const buttons = document.createElement('div');
        buttons.className = 'ji-modal-buttons';
        buttons.appendChild(cancel); buttons.appendChild(go);
        body.appendChild(buttons);


        const m = buildModal({ title: '🌐 Translate trigger keys', body });
        cancel.onclick = function () { m.overlay.remove(); };

        go.onclick = function () {
            const target = (langSel.value === '__other__') ? otherInput.value.trim() : langSel.value;
            if (!target) { toast('Укажи язык.', 'error'); return; }
            if (!stLlmAvailable()) { toast('ST API не настроен.', 'error'); return; }

            let name = '';
            let wi = null;
            if (wiSel.value === '__current__') {
                try {
                    const ctx = window.SillyTavern && window.SillyTavern.getContext && window.SillyTavern.getContext();
                    const bound = (ctx && ctx.chat && ctx.chat.metadata && ctx.chat.metadata.world_info)
                        || (ctx && ctx.characterData && ctx.characterData.data && ctx.characterData.data.extensions && ctx.characterData.data.extensions.world);
                    if (typeof bound === 'string') { name = bound; wi = loadWorldInfoByName(bound); }
                    else if (bound && typeof bound === 'object') { wi = bound; name = (ctx.characterData.data.name) || 'lorebook'; }
                } catch (_) { }
                if (!wi) {
                    try {
                        const ctx = window.SillyTavern && window.SillyTavern.getContext && window.SillyTavern.getContext();
                        const cn = ctx && ctx.chat && ctx.chat.metadata && ctx.chat.metadata.world_info;
                        if (cn) { name = cn; wi = loadWorldInfoByName(cn); }
                    } catch (_) { }
                }
                if (!wi) { toast('Сейчас к чату не привязан ни один лорбук. Выбери конкретный из списка.', 'error', 5000); return; }
            } else {
                name = wiSel.value;
                wi = loadWorldInfoByName(name);
                if (!wi) { toast('Не смог загрузить лорбук "' + name + '" из ST.', 'error'); return; }
            }

            go.disabled = true; cancel.disabled = true;
            const logFn = function (s) { prog.log(s); };
            translateWorldInfoKeys(wi, target, logFn).then(function (newWi) {
                return importWorldInfo(name, newWi).then(function (r) {
                    if (r && r.ok !== false) {
                        logFn('✅ Переведено ' + Object.keys(newWi.entries).length + ' записей.');
                        toast('Лорбук "' + name + '" обновлён (' + Object.keys(newWi.entries).length + ' записей).', 'success', 4000);
                    } else {
                        logFn('⚠ Не удалось сохранить через API — скачал файл рядом.');
                        toast('Не удалось сохранить через ST API — файл скачан рядом, перетащи его во вкладку World Info.', 'warning', 6000);
                    }
                });
            }).catch(function (e) {
                logFn('✗ ' + (e.message || e));
                toast(e.message || String(e), 'error', 6000);
            }).then(function () { go.disabled = false; cancel.disabled = false; });
        };

        return m.overlay;
    }

    // -------- INSTALL UI --------------------------------------------------------
    //
    // SillyTavern extensions render their controls into #extensions_settings as a
    // collapsible "inline-drawer". That's the panel the user actually sees. We
    // add that here (primary UI) and ALSO drop floating buttons as a shortcut.

    function createSettingsDrawer() {
        const container = document.getElementById('extensions_settings')
            || document.getElementById('extensions_settings2')
            || document.querySelector('[data-extension-settings], .extensions_settings');
        if (!container) return false;
        if (document.getElementById('ji_settings_root')) return true;

        const html =
            '<div class="ji-settings" id="ji_settings_root">' +
            '  <div class="inline-drawer">' +
            '    <div class="inline-drawer-toggle inline-drawer-header">' +
            '      <b>🐰 Janitor Import</b>' +
            '      <div class="inline-drawer-icon fa-solid fa-circle-chevron-down down"></div>' +
            '    </div>' +
            '    <div class="inline-drawer-content">' +
            '      <p style="opacity:.85;margin:4px 0 10px;">Импорт персонажей и лорбуков с JanitorAI (в т.ч. закрытых) + перевод триггер-ключей.</p>' +
            '      <div class="ji-modal-buttons" style="justify-content:flex-start;">' +
            '        <button type="button" class="ji-btn ji-btn--primary" id="ji_open_import">🐰 Import from JanitorAI</button>' +
            '        <button type="button" class="ji-btn ji-btn--secondary" id="ji_open_translate">🌐 Translate keys</button>' +
            '      </div>' +
            '    </div>' +
            '  </div>' +
            '</div>';
        container.insertAdjacentHTML('beforeend', html);

        const bImport = document.getElementById('ji_open_import');
        const bTranslate = document.getElementById('ji_open_translate');
        if (bImport) bImport.addEventListener('click', function () { buildMainModal(); });
        if (bTranslate) bTranslate.addEventListener('click', function () { buildTranslateModal(); });
        return true;
    }

    function installFab() {
        if (document.getElementById('ji-fab')) return;
        if (!document.body) return;
        const host = document.createElement('div');
        host.id = 'ji-fab';
        host.style.position = 'fixed';
        host.style.right = '20px';
        host.style.bottom = '20px';
        host.style.zIndex = '2147483647';
        host.style.display = 'flex';
        host.style.flexDirection = 'column';
        host.style.gap = '8px';
        host.style.alignItems = 'flex-end';
        host.style.pointerEvents = 'auto';

        const importFab = button('🐰 Janitor Import', 'primary');
        importFab.classList.add('ji-fab-btn');
        importFab.style.borderRadius = '999px';
        importFab.style.padding = '10px 16px';
        importFab.style.boxShadow = '0 6px 20px rgba(0,0,0,.35)';
        importFab.style.fontWeight = '600';
        importFab.onclick = function () { buildMainModal(); };

        const translateFab = button('🌐 Translate keys', 'secondary');
        translateFab.classList.add('ji-fab-btn');
        translateFab.style.borderRadius = '999px';
        translateFab.style.padding = '10px 16px';
        translateFab.style.boxShadow = '0 6px 20px rgba(0,0,0,.35)';
        translateFab.style.fontWeight = '600';
        translateFab.onclick = function () { buildTranslateModal(); };

        host.appendChild(importFab);
        host.appendChild(translateFab);
        document.body.appendChild(host);
    }

    let jiInitDone = false;
    function initUI() {
        // Drawer is the primary, discoverable UI (Extensions panel). FAB is a bonus.
        const drawerOk = createSettingsDrawer();
        installFab();
        if (drawerOk && !jiInitDone) {
            jiInitDone = true;
            toast('Janitor Import loaded.', 'info', 2500);
        }
    }

    onReady(initUI);
    initUI();
    // #extensions_settings can mount a bit after APP_READY; keep trying briefly.
    let jiTries = 0;
    const jiPoll = setInterval(function () {
        jiTries++;
        if (document.getElementById('ji_settings_root') || jiTries > 40) {
            clearInterval(jiPoll);
            return;
        }
        initUI();
    }, 500);
})();
