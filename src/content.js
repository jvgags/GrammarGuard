// GrammarGuard content.js — clean rewrite
(function () {
  'use strict';
  if (window.__gg) return;
  window.__gg = true;

  let language = 'auto';
  let dictionary = new Set(); // lowercase words added by user
  const state = new Map();    // field → { matches:[], badge:null }

  // ── Boot ─────────────────────────────────────────────────────────
  chrome.storage.local.get(['enabled', 'language', 'personalDict'], d => {
    if (d.enabled === false) return;
    language = d.language || 'auto';
    loadDict(d.personalDict);
    injectCSS();
    if (document.readyState === 'complete') scanAll();
    else window.addEventListener('load', scanAll, { once: true });
    new MutationObserver(debounce(() => {
      findFields().filter(f => !state.has(f)).forEach(f => checkField(f));
    }, 800)).observe(document.body, { childList: true, subtree: true });
  });

  chrome.storage.onChanged.addListener(changes => {
    if (changes.personalDict) loadDict(changes.personalDict.newValue);
  });

  // personalDict is stored as an array of strings
  function loadDict(val) {
    if (Array.isArray(val)) {
      dictionary = new Set(val.map(w => w.toLowerCase().trim()).filter(Boolean));
    } else if (typeof val === 'string') {
      dictionary = new Set(val.split('\n').map(w => w.toLowerCase().trim()).filter(Boolean));
    }
  }

  function inDict(word) {
    return dictionary.has((word || '').toLowerCase().trim());
  }

  function filterDict(matches, text) {
    return matches.filter(m => {
      if (m.rule?.issueType !== 'misspelling') return true;
      const word = text.slice(m.offset, m.offset + m.length);
      return !inDict(word);
    });
  }

  // ── CSS ───────────────────────────────────────────────────────────
  function injectCSS() {
    if (document.getElementById('gg-css')) return;
    const s = document.createElement('style');
    s.id = 'gg-css';
    s.textContent = `
      @keyframes gg-spin { to { transform:rotate(360deg) } }
      @keyframes gg-pop  { from{opacity:0;transform:scale(.75)} to{opacity:1;transform:scale(1)} }
      .gg-wrap { display:inline-block !important; position:relative !important; }
      .gg-mirror {
        position:absolute !important; top:0 !important; left:0 !important;
        pointer-events:none !important; z-index:0 !important;
        overflow:hidden !important;
        color:transparent !important;
        -webkit-text-fill-color:transparent !important;
        background:white !important;
      }
      .gg-field-wrapped {
        position:relative !important; z-index:1 !important;
        background:transparent !important;
      }
      .gg-mirror mark {
        background:transparent !important;
        color:transparent !important;
        -webkit-text-fill-color:transparent !important;
        padding:0; margin:0; border-radius:0;
      }
      .gg-mirror mark.gg-spell   { border-bottom:2px solid #e53935 }
      .gg-mirror mark.gg-grammar { border-bottom:2px solid #f57c00 }
      .gg-mirror mark.gg-style   { border-bottom:2px dashed #1976d2 }
      .gg-badge {
        position:fixed !important; z-index:2147483647 !important;
        display:inline-flex; align-items:center; gap:4px;
        padding:3px 8px 3px 6px; border-radius:999px;
        font:700 11px/1 system-ui,sans-serif; white-space:nowrap;
        user-select:none; box-shadow:0 1px 8px rgba(0,0,0,.18),0 0 0 1px rgba(0,0,0,.07);
        background:#fff; animation:gg-pop .15s ease forwards; transition:filter .1s;
      }
      .gg-badge.clickable { pointer-events:all !important; cursor:pointer }
      .gg-badge.clickable:hover { filter:brightness(.92) }
      .gg-spin {
        display:inline-block; width:9px; height:9px; flex-shrink:0;
        border:1.8px solid rgba(68,87,232,.2); border-top-color:#4457e8;
        border-radius:50%; animation:gg-spin .7s linear infinite;
      }
      .gg-panel {
        position:fixed !important; z-index:2147483647 !important;
        width:320px; max-height:390px; overflow-y:auto;
        background:#fff; border:1px solid #dde0ea; border-radius:12px;
        box-shadow:0 4px 24px rgba(0,0,0,.13),0 1px 4px rgba(0,0,0,.07);
        font:13px/1.4 system-ui,sans-serif; color:#1a1d2e;
      }
      .gg-panel::-webkit-scrollbar{width:4px}
      .gg-panel::-webkit-scrollbar-thumb{background:#dde0ea;border-radius:2px}
      .gg-panel-head {
        display:flex; align-items:center; justify-content:space-between;
        padding:11px 13px; border-bottom:1px solid #eef0f6;
        background:#f8f9fc; position:sticky; top:0;
        font-weight:700; font-size:13px;
      }
      .gg-count { background:rgba(217,48,37,.1);color:#d93025;border-radius:99px;padding:1px 8px;font-size:11px;font-weight:600;margin-left:6px }
      .gg-close { background:none;border:none;color:#9299b0;cursor:pointer;font-size:16px;padding:0 4px;line-height:1 }
      .gg-row { padding:10px 13px; border-bottom:1px solid #f0f2f7 }
      .gg-row:last-child { border-bottom:none }
      .gg-row-top { display:flex;align-items:flex-start;gap:7px;margin-bottom:5px }
      .gg-dot { display:inline-block;width:7px;height:7px;border-radius:50%;flex-shrink:0;margin-top:4px }
      .gg-msg { flex:1;font-size:12.5px;color:#2a2d40;line-height:1.45 }
      .gg-x { background:none;border:none;color:#9299b0;cursor:pointer;font-size:12px;padding:0 3px }
      .gg-ctx { font:10.5px/1.4 monospace;color:#6b7599;margin-bottom:7px;overflow:hidden;text-overflow:ellipsis;white-space:nowrap }
      .gg-ctx mark { border-radius:2px;padding:0 2px }
      .gg-sugs { display:flex;flex-wrap:wrap;gap:5px;margin-bottom:6px }
      .gg-sug { font:11px monospace;padding:3px 9px;border-radius:4px;cursor:pointer;background:rgba(68,87,232,.07);border:1px solid rgba(68,87,232,.2);color:#4457e8 }
      .gg-sug:hover { background:#4457e8;color:#fff;border-color:#4457e8 }
      .gg-dict-btn { display:inline-flex;align-items:center;gap:5px;background:none;border:1px solid #dde0ea;border-radius:5px;padding:3px 9px;font:12px system-ui,sans-serif;color:#5a6080;cursor:pointer;transition:all .12s }
      .gg-dict-btn:hover:not(:disabled) { background:#f0f4ff;border-color:#4457e8;color:#4457e8 }
      .gg-dict-btn:disabled { cursor:default;opacity:.6 }
      .gg-toast {
        position:fixed !important; bottom:20px; left:50%;
        transform:translateX(-50%) translateY(8px); z-index:2147483647 !important;
        background:#fff; border:1px solid #dde0ea; border-radius:8px;
        padding:8px 16px; font:13px system-ui,sans-serif; color:#1a1d2e;
        box-shadow:0 4px 16px rgba(0,0,0,.1); opacity:0;
        transition:opacity .25s,transform .25s; pointer-events:none; white-space:nowrap;
      }
    `;
    document.head.appendChild(s);
  }

  // ── Field discovery ──────────────────────────────────────────────
  function findFields() {
    const out = [];
    document.querySelectorAll(
      'textarea,input[type=text],input[type=search],input:not([type]),[contenteditable=true]'
    ).forEach(el => {
      if (el.offsetWidth > 30 && el.offsetHeight > 10 && !el.disabled && !el.readOnly)
        out.push(el);
    });
    return out;
  }

  function getText(el) {
    return (el.tagName === 'TEXTAREA' || el.tagName === 'INPUT')
      ? (el.value || '') : (el.innerText || '');
  }

  // ── Scan ─────────────────────────────────────────────────────────
  function scanAll() {
    // Start all fields immediately — background.js handles one request at a time
    findFields().forEach(f => checkField(f));
  }

  async function checkField(field) {
    if (!state.has(field)) state.set(field, { matches: [], badge: null });
    const text = getText(field).trim();
    if (text.length < 10) { attachBlur(field); return; }
    setBadge(field, 'checking');
    try {
      const raw = await bgCheck(text);
      const matches = filterDict(raw, text);
      state.get(field).matches = matches;
      setBadge(field, matches.length > 0 ? 'errors' : 'ok', matches);
      applyMirror(field, text, matches);
      attachBlur(field);
      attachInputSync(field);
    } catch (e) {
      console.warn('[GrammarGuard] check failed:', e.message, e.stack);
      setBadge(field, 'failed');
    }
  }

  // ── Background API ────────────────────────────────────────────────
  // Pings the service worker first to wake it (Chrome suspends it after
  // ~30s idle, causing sendMessage callbacks to never fire).
  // Hard 25s timeout so we never stay stuck on 'Checking...'.
  function bgCheck(text) {
    return new Promise((resolve, reject) => {
      let settled = false;

      const timer = setTimeout(() => {
        if (!settled) { settled = true; reject(new Error('Timed out — try again')); }
      }, 25000);

      function sendCheck() {
        chrome.runtime.sendMessage(
          { action: 'checkTextChunked', text: text.slice(0, 6000), language },
          r => {
            clearTimeout(timer);
            if (settled) return;
            settled = true;
            if (chrome.runtime.lastError) return reject(new Error(chrome.runtime.lastError.message));
            if (r && r.success) return resolve(r.matches || []);
            reject(new Error((r && r.error) || 'no response'));
          }
        );
      }

      // Wake the service worker, then send the real request
      chrome.runtime.sendMessage({ action: 'ping' }, () => {
        void chrome.runtime.lastError; // suppress 'no listener' warning on ping
        if (!settled) sendCheck();
      });
    });
  }

  // ── Mirror overlay ────────────────────────────────────────────────
  function applyMirror(field, text, matches) {
    if (field.contentEditable === 'true') {
      applyContentEditable(field, matches);
      return;
    }
    let wrapper = field._ggWrapper;
    let mirror  = field._ggMirror;

    if (!wrapper) {
      wrapper = document.createElement('div');
      wrapper.className = 'gg-wrap';
      const cs = window.getComputedStyle(field);
      wrapper.style.width  = field.offsetWidth  + 'px';
      wrapper.style.height = field.offsetHeight + 'px';
      if (cs.display === 'block') wrapper.style.display = 'block';
      field.parentNode.insertBefore(wrapper, field);
      wrapper.appendChild(field);
      field._ggWrapper = wrapper;

      mirror = document.createElement('div');
      mirror.className = 'gg-mirror';
      wrapper.insertBefore(mirror, field);
      field._ggMirror = mirror;

      const props = ['fontFamily','fontSize','fontWeight','fontStyle','lineHeight',
        'letterSpacing','wordSpacing','textTransform','textIndent',
        'paddingTop','paddingRight','paddingBottom','paddingLeft',
        'borderTopWidth','borderRightWidth','borderBottomWidth','borderLeftWidth','boxSizing'];
      props.forEach(p => mirror.style[p] = cs[p]);
      mirror.style.borderStyle = 'solid';
      mirror.style.borderColor = 'transparent';

      const isInput = field.tagName === 'INPUT';
      mirror.style.whiteSpace = isInput ? 'pre' : 'pre-wrap';
      mirror.style.wordWrap   = isInput ? 'normal' : 'break-word';
      mirror.style.overflowX  = 'hidden';
      mirror.style.overflowY  = 'hidden';

      field._ggOrigBg = field.style.background || '';
      field.classList.add('gg-field-wrapped');
      field.style.caretColor = cs.color;
    }

    mirror.style.width  = field.offsetWidth  + 'px';
    mirror.style.height = field.offsetHeight + 'px';
    updateMirrorHTML(mirror, text, matches);
    mirror.scrollTop  = field.scrollTop;
    mirror.scrollLeft = field.scrollLeft;
  }

  function updateMirrorHTML(mirror, text, matches) {
    const len = text.length;
    const valid = matches
      .filter(m => {
        const o = Number(m.offset), l = Number(m.length);
        return Number.isFinite(o) && Number.isFinite(l) && o >= 0 && l > 0 && o + l <= len;
      })
      .sort((a, b) => a.offset - b.offset);

    let html = '', cursor = 0;
    for (const m of valid) {
      if (m.offset < cursor) continue;
      html += escHtml(text.slice(cursor, m.offset));
      const cls = getClass(m);
      const mc  = { spelling:'gg-spell', grammar:'gg-grammar', style:'gg-style' }[cls] || 'gg-grammar';
      html += `<mark class="${mc}">${escHtml(text.slice(m.offset, m.offset + m.length))}</mark>`;
      cursor = m.offset + m.length;
    }
    html += escHtml(text.slice(cursor));
    mirror.innerHTML = html + '\u200b';
  }

  function removeMirror(field) {
    if (!field._ggWrapper) return;
    const w = field._ggWrapper;
    if (w.parentNode) { w.parentNode.insertBefore(field, w); w.remove(); }
    field._ggWrapper = null;
    field._ggMirror  = null;
    field.classList.remove('gg-field-wrapped');
    field.style.removeProperty('caret-color');
    if (field._ggOrigBg !== undefined) { field.style.background = field._ggOrigBg; delete field._ggOrigBg; }
  }

  // ── ContentEditable highlights ────────────────────────────────────
  function applyContentEditable(field, matches) {
    field.querySelectorAll('.gg-hl').forEach(s => s.replaceWith(document.createTextNode(s.textContent)));
    field.normalize();
    if (!matches.length) return;
    const plainLen = field.innerText.length;
    const valid = matches.filter(m =>
      Number.isFinite(m.offset) && Number.isFinite(m.length) &&
      m.offset >= 0 && m.length > 0 && m.offset + m.length <= plainLen
    );
    [...valid].sort((a, b) => b.offset - a.offset).forEach(m => injectSpan(field, m));
  }

  function injectSpan(root, match) {
    // Hard-validate offset/length before any DOM touching
    const o = Number(match.offset), l2 = Number(match.length);
    if (!Number.isFinite(o) || !Number.isFinite(l2) || o < 0 || l2 <= 0) return;

    const walker = document.createTreeWalker(root, NodeFilter.SHOW_TEXT);
    let node, n = 0;
    while ((node = walker.nextNode())) {
      const l = node.textContent.length;
      if (n + l > o) {
        const lo = o - n;
        // Must fit entirely within this single text node
        if (lo < 0 || lo + l2 > l) { n += l; continue; }
        const cls   = getClass(match);
        const color = { spelling:'#e53935', grammar:'#f57c00', style:'#1976d2' }[cls];
        const span  = document.createElement('span');
        span.className = 'gg-hl';
        span.style.cssText = `border-bottom:2px ${cls === 'style' ? 'dashed' : 'solid'} ${color}`;
        span.title = match.message;
        span.textContent = node.textContent.slice(lo, lo + l2);
        // splitText is safe because we verified lo < l and lo + l2 <= l above
        const after = node.splitText(lo);
        after.textContent = after.textContent.slice(l2);
        node.parentNode.insertBefore(span, after);
        return;
      }
      n += l;
    }
  }

  // ── Input sync ────────────────────────────────────────────────────
  function attachInputSync(field) {
    if (field._ggSync) return;
    field._ggSync = true;
    field.addEventListener('input', () => {
      const s = state.get(field);
      if (s && field._ggMirror) {
        updateMirrorHTML(field._ggMirror, getText(field), s.matches);
        field._ggMirror.scrollTop  = field.scrollTop;
        field._ggMirror.scrollLeft = field.scrollLeft;
      }
    });
    field.addEventListener('scroll', () => {
      if (field._ggMirror) {
        field._ggMirror.scrollTop  = field.scrollTop;
        field._ggMirror.scrollLeft = field.scrollLeft;
      }
    }, { passive: true });
  }

  // ── Badge ─────────────────────────────────────────────────────────
  function setBadge(field, status, matches = []) {
    const s = state.get(field);
    if (!s) return;
    if (s.badge) { s.badge.remove(); s.badge = null; }
    if (status === 'none') return;

    const b = document.createElement('div');
    b.className = 'gg-badge';

    if (status === 'checking') {
      b.style.color = '#4457e8';
      b.innerHTML = '<span class="gg-spin"></span><span>Checking\u2026</span>';
    } else if (status === 'ok') {
      b.style.color = '#1a9e52';
      b.innerHTML = '\u2713 <span>No issues</span>';
      setTimeout(() => {
        b.style.transition = 'opacity .4s';
        b.style.opacity = '0';
        setTimeout(() => { b.remove(); if (s.badge === b) s.badge = null; }, 420);
      }, 4000);
    } else if (status === 'errors') {
      const hasReal = matches.some(m => getClass(m) !== 'style');
      b.style.color = hasReal ? '#d93025' : '#1a7fc4';
      b.classList.add('clickable');
      const icon = hasReal
        ? `<svg width="10" height="10" viewBox="0 0 10 10" fill="none"><circle cx="5" cy="5" r="4.5" fill="rgba(217,48,37,.12)" stroke="#d93025" stroke-width="1"/><line x1="5" y1="3" x2="5" y2="6" stroke="#d93025" stroke-width="1.2" stroke-linecap="round"/><circle cx="5" cy="7.5" r=".6" fill="#d93025"/></svg>`
        : `<svg width="10" height="10" viewBox="0 0 10 10" fill="none"><circle cx="5" cy="5" r="4.5" fill="rgba(26,127,196,.12)" stroke="#1a7fc4" stroke-width="1"/><line x1="5" y1="3" x2="5" y2="6" stroke="#1a7fc4" stroke-width="1.2" stroke-linecap="round"/><circle cx="5" cy="7.5" r=".6" fill="#1a7fc4"/></svg>`;
      b.innerHTML = icon + `<span>${matches.length} issue${matches.length !== 1 ? 's' : ''}</span>`;
      b.addEventListener('click', e => { e.stopPropagation(); showPanel(field, s.matches); });
    } else if (status === 'failed') {
      b.style.color = '#c47a00';
      b.innerHTML = '\u26a0 <span>Failed</span>';
    }

    document.body.appendChild(b);
    s.badge = b;
    placeBadge(b, field);
  }

  function placeBadge(b, field) {
    const r  = field.getBoundingClientRect();
    const bw = b.offsetWidth  || 90;
    const bh = b.offsetHeight || 22;
    b.style.top  = Math.max(4, r.bottom - bh - 6) + 'px';
    b.style.left = Math.max(4, Math.min(r.right - bw - 6, window.innerWidth - bw - 8)) + 'px';
  }

  window.addEventListener('scroll', debounce(() => {
    state.forEach((s, f) => { if (s.badge) placeBadge(s.badge, f); });
  }, 50), { passive: true });

  window.addEventListener('resize', debounce(() => {
    state.forEach((s, f) => {
      if (s.badge) placeBadge(s.badge, f);
      if (f._ggMirror && s.matches.length) applyMirror(f, getText(f), s.matches);
    });
  }, 100), { passive: true });

  // ── Panel ─────────────────────────────────────────────────────────
  function showPanel(field, matches) {
    document.querySelectorAll('.gg-panel').forEach(p => p.remove());
    const panel = document.createElement('div');
    panel.className = 'gg-panel';

    const head = document.createElement('div');
    head.className = 'gg-panel-head';
    head.innerHTML = `<span>GrammarGuard <span class="gg-count">${matches.length}</span></span>`;
    const close = document.createElement('button');
    close.className = 'gg-close';
    close.textContent = '\xd7';
    close.onclick = () => panel.remove();
    head.appendChild(close);
    panel.appendChild(head);

    const fieldText = getText(field);
    matches.forEach((m, i) => panel.appendChild(buildRow(m, i, field, matches, panel, fieldText)));
    document.body.appendChild(panel);
    placePanel(panel, field);

    setTimeout(() => {
      document.addEventListener('click', function oc(e) {
        if (!panel.contains(e.target)) { panel.remove(); document.removeEventListener('click', oc); }
      });
    }, 0);
  }

  function buildRow(match, i, field, matches, panel, fieldText) {
    const cls = getClass(match);
    const col = { spelling:'#e53935', grammar:'#f57c00', style:'#1976d2' }[cls] || '#f57c00';
    const sugs = (match.replacements || []).slice(0, 5).map(r => r.value);

    const row = document.createElement('div');
    row.className = 'gg-row';

    // Top: dot + message + dismiss
    const top = document.createElement('div');
    top.className = 'gg-row-top';
    const dot = document.createElement('span');
    dot.className = 'gg-dot';
    dot.style.background = col;
    const msg = document.createElement('span');
    msg.className = 'gg-msg';
    msg.textContent = match.message;
    const x = document.createElement('button');
    x.className = 'gg-x';
    x.textContent = '\u2715';
    x.title = 'Dismiss';
    x.onclick = () => dismissMatch(match, i, field, matches, panel, row);
    top.append(dot, msg, x);
    row.appendChild(top);

    // Context snippet
    if (match.context?.text) {
      const co = match.context.offset || 0, cl2 = match.context.length || 0;
      const ctx = document.createElement('div');
      ctx.className = 'gg-ctx';
      ctx.appendChild(document.createTextNode(match.context.text.slice(0, co)));
      const mk = document.createElement('mark');
      mk.style.cssText = `background:${col}22;color:${col}`;
      mk.textContent = match.context.text.slice(co, co + cl2);
      ctx.appendChild(mk);
      ctx.appendChild(document.createTextNode(match.context.text.slice(co + cl2)));
      row.appendChild(ctx);
    }

    // Suggestion buttons
    if (sugs.length) {
      const sw = document.createElement('div');
      sw.className = 'gg-sugs';
      sugs.forEach(sv => {
        const btn = document.createElement('button');
        btn.className = 'gg-sug';
        btn.textContent = sv;
        btn.onclick = () => { applyFix(field, match, sv, matches); panel.remove(); };
        sw.appendChild(btn);
      });
      row.appendChild(sw);
    }

    // Add to Dictionary (spelling only)
    if (match.rule?.issueType === 'misspelling') {
      const word = fieldText.slice(match.offset, match.offset + match.length).trim();
      if (word) {
        const dictBtn = document.createElement('button');
        dictBtn.className = 'gg-dict-btn';
        dictBtn.innerHTML = `<svg width="11" height="11" viewBox="0 0 12 12" fill="none" style="flex-shrink:0"><rect x="1" y="1" width="10" height="10" rx="2" stroke="currentColor" stroke-width="1.2"/><line x1="6" y1="3.5" x2="6" y2="8.5" stroke="currentColor" stroke-width="1.2" stroke-linecap="round"/><line x1="3.5" y1="6" x2="8.5" y2="6" stroke="currentColor" stroke-width="1.2" stroke-linecap="round"/></svg> Add \u201c${word}\u201d to dictionary`;
        dictBtn.onclick = () => {
          dictionary.add(word.toLowerCase());
          // Persist
          chrome.storage.local.get(['personalDict'], d => {
            const arr = Array.isArray(d.personalDict) ? d.personalDict : [];
            if (!arr.includes(word.toLowerCase())) arr.push(word.toLowerCase());
            chrome.storage.local.set({ personalDict: arr });
          });
          showToast(`\u201c${word}\u201d added to dictionary`);
          dictBtn.textContent = '\u2713 Added';
          dictBtn.disabled = true;
          dictBtn.style.color = '#1a9e52';
          // Remove all matches for this word from this field
          for (let idx = matches.length - 1; idx >= 0; idx--) {
            const m = matches[idx];
            if (m.rule?.issueType === 'misspelling' &&
                fieldText.slice(m.offset, m.offset + m.length) === word) {
              matches.splice(idx, 1);
            }
          }
          updateField(field, matches);
          panel.querySelectorAll('.gg-row[data-word]').forEach(r => {
            if (r.dataset.word === word) r.remove();
          });
          updatePanelCount(panel, matches);
          if (!matches.length) setTimeout(() => panel.remove(), 600);
        };
        row.dataset.word = word;
        row.appendChild(dictBtn);
      }
    }

    return row;
  }

  function dismissMatch(match, i, field, matches, panel, row) {
    matches.splice(i, 1);
    updateField(field, matches);
    row.remove();
    updatePanelCount(panel, matches);
    if (!matches.length) panel.remove();
  }

  function updateField(field, matches) {
    state.get(field).matches = matches;
    if (field._ggMirror) updateMirrorHTML(field._ggMirror, getText(field), matches);
    else if (field.contentEditable === 'true') applyContentEditable(field, matches);
    setBadge(field, matches.length > 0 ? 'errors' : 'ok', matches);
  }

  function updatePanelCount(panel, matches) {
    const c = panel.querySelector('.gg-count');
    if (c) c.textContent = matches.length;
  }

  function placePanel(panel, field) {
    const r = field.getBoundingClientRect();
    let top  = (window.innerHeight - r.bottom) > 300 ? r.bottom + 8 : r.top - 400;
    let left = r.left;
    if (left + 325 > window.innerWidth) left = window.innerWidth - 325;
    panel.style.top  = Math.max(4, top)  + 'px';
    panel.style.left = Math.max(4, left) + 'px';
  }

  // ── Apply fix ─────────────────────────────────────────────────────
  function applyFix(field, match, replacement, matches) {
    if (field.tagName === 'TEXTAREA' || field.tagName === 'INPUT') {
      const v = field.value;
      field.value = v.slice(0, match.offset) + replacement + v.slice(match.offset + match.length);
      field.dispatchEvent(new Event('input', { bubbles: true }));
    } else {
      // Strip highlights first so innerText is clean and matches offsets
      field.querySelectorAll('.gg-hl').forEach(s => s.replaceWith(document.createTextNode(s.textContent)));
      field.normalize();
      const plain = field.innerText;
      field.innerText = plain.slice(0, match.offset) + replacement + plain.slice(match.offset + match.length);
      // Place caret after replacement
      try {
        const walker = document.createTreeWalker(field, NodeFilter.SHOW_TEXT);
        let node, n = 0, target = match.offset + replacement.length;
        while ((node = walker.nextNode())) {
          const l = node.textContent.length;
          if (n + l >= target) {
            const range = document.createRange();
            range.setStart(node, Math.min(target - n, l));
            range.collapse(true);
            const sel = window.getSelection();
            sel.removeAllRanges();
            sel.addRange(range);
            break;
          }
          n += l;
        }
      } catch (_) {}
    }

    const lenDiff = replacement.length - match.length;
    const idx = matches.indexOf(match);
    if (idx !== -1) matches.splice(idx, 1);
    matches.forEach(m => { if (m.offset > match.offset) m.offset += lenDiff; });
    updateField(field, matches);
    showToast(`\u2713 \u201c${replacement}\u201d applied`);
  }

  // ── Blur re-check ─────────────────────────────────────────────────
  function attachBlur(field) {
    if (field._ggBlur) return;
    field._ggBlur = true;
    let t;
    field.addEventListener('blur', () => {
      clearTimeout(t);
      t = setTimeout(async () => {
        const text = getText(field).trim();
        if (!state.has(field)) state.set(field, { matches: [], badge: null });
        if (text.length < 10) { removeMirror(field); setBadge(field, 'none'); return; }
        setBadge(field, 'checking');
        try {
          const raw = await bgCheck(text);
          const matches = filterDict(raw, text);
          state.get(field).matches = matches;
          setBadge(field, matches.length > 0 ? 'errors' : 'ok', matches);
          applyMirror(field, text, matches);
        } catch (e) { setBadge(field, 'failed'); }
      }, 600);
    });
  }

  // ── Toast ─────────────────────────────────────────────────────────
  function showToast(msg) {
    document.querySelectorAll('.gg-toast').forEach(t => t.remove());
    const t = document.createElement('div');
    t.className = 'gg-toast';
    t.textContent = msg;
    document.body.appendChild(t);
    requestAnimationFrame(() => { t.style.opacity = '1'; t.style.transform = 'translateX(-50%) translateY(0)'; });
    setTimeout(() => { t.style.opacity = '0'; setTimeout(() => t.remove(), 300); }, 3000);
  }

  // ── Messages from popup ───────────────────────────────────────────
  chrome.runtime.onMessage.addListener((msg, _, sendResponse) => {
    if (msg.action === 'clearHighlights') {
      state.forEach((s, f) => { if (s.badge) s.badge.remove(); removeMirror(f); });
      state.clear();
      document.querySelectorAll('.gg-panel').forEach(p => p.remove());
      sendResponse({ success: true });
    }
    if (msg.action === 'ping')   sendResponse({ alive: true });
    if (msg.action === 'enable') { scanAll(); sendResponse({ success: true }); }
    if (msg.action === 'disable') {
      state.forEach((s, f) => { if (s.badge) s.badge.remove(); removeMirror(f); });
      state.clear();
      sendResponse({ success: true });
    }
    return true;
  });

  // ── Helpers ───────────────────────────────────────────────────────
  function getClass(m) {
    const it  = (m.rule?.issueType    || '').toLowerCase();
    const cat = (m.rule?.category?.id || '').toLowerCase();
    if (it === 'misspelling') return 'spelling';
    if (it.includes('grammar') || cat.includes('grammar')) return 'grammar';
    if (it.includes('style')   || cat.includes('style'))   return 'style';
    return 'grammar';
  }
  function escHtml(s) { return s.replace(/&/g,'&amp;').replace(/</g,'&lt;').replace(/>/g,'&gt;'); }
  function debounce(fn, ms) { let t; return (...a) => { clearTimeout(t); t = setTimeout(() => fn(...a), ms); }; }

})();
