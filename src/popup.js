// popup.js — GrammarGuard

const $ = id => document.getElementById(id);

let allMatches   = [];
let activeFilter = 'all';
let language     = 'auto';
let dictionary   = new Set();
let activeTooltip = null; // currently open inline tooltip
let currentSettings = {};
let synonymSelection = null;

// ── Init ──────────────────────────────────────────────────────────────
document.addEventListener('DOMContentLoaded', async () => {
  const stored = await chrome.storage.local.get(['language', 'personalDict', 'theme', 'editorText', 'checkSpelling', 'checkGrammar', 'checkStyle', 'checkPunctuation', 'apiKey', 'apiUsername']);
  currentSettings = stored;
  language = stored.language || 'en-US';
  $('langSelect').value = language || 'en-US';
  if (Array.isArray(stored.personalDict))
    dictionary = new Set(stored.personalDict.map(w => w.toLowerCase().trim()));
  applyTheme(stored.theme || 'light');

  // Restore last editor text
  if (stored.editorText) {
    $('editor').value = stored.editorText;
    updateCharCount();
  }

  bindEvents();
  setStatus('idle', 'Ready — paste text and click Check Now');
});

// ── Events ────────────────────────────────────────────────────────────
function bindEvents() {
  $('langSelect').addEventListener('change', () => {
    language = $('langSelect').value;
    currentSettings.language = language;
    chrome.storage.local.set({ language });
  });

  // Theme buttons
  document.querySelectorAll('.theme-btn').forEach(btn => {
    btn.addEventListener('click', () => {
      applyTheme(btn.dataset.theme);
      chrome.storage.local.set({ theme: btn.dataset.theme });
    });
  });

  $('settingsLink').addEventListener('click', e => { e.preventDefault(); chrome.runtime.openOptionsPage(); });
  $('checkBtn').addEventListener('click', runCheck);
  $('clearBtn').addEventListener('click', clearAll);

  $('clearTextBtn').addEventListener('click', () => {
    $('editor').value = '';
    $('mirror').innerHTML = '';
    updateCharCount();
    clearAll();
    chrome.storage.local.remove('editorText');
  });

  $('editor').addEventListener('input', () => {
    updateCharCount();
    updateMirrorHL($('editor').value, allMatches);
    saveEditorText();
  });

  $('editor').addEventListener('scroll', syncMirrorScroll);

  // Re-sync mirror size on resize (scrollbar may appear/disappear)
  new ResizeObserver(() => {
    syncMirrorSize();
    syncMirrorScroll();
  }).observe($('editor'));

  // Filter tabs
  document.querySelectorAll('.fbtn').forEach(btn => {
    btn.addEventListener('click', () => {
      document.querySelectorAll('.fbtn').forEach(b => b.classList.remove('active'));
      btn.classList.add('active');
      activeFilter = btn.dataset.f;
      renderIssues();
    });
  });

  // Close tooltip on outside click
  document.addEventListener('click', e => {
    if (activeTooltip && !activeTooltip.contains(e.target)) closeTooltip();
  });

  // Click on textarea: browser sets selectionStart to clicked char position.
  // We use that directly — no mirror hit-testing needed.
  $('editor').addEventListener('click', onEditorClick);
  $('editor').addEventListener('dblclick', onEditorDblClick);
  $('editor').addEventListener('keyup', e => {
    // Also trigger on keyboard navigation so tooltip closes when cursor moves away
    if (['ArrowLeft','ArrowRight','ArrowUp','ArrowDown','Home','End'].includes(e.key)) {
      closeTooltip();
    }
  });
}

function updateCharCount() {
  $('charCount').textContent = `${$('editor').value.length} chars`;
}

function applyTheme(theme) {
  document.documentElement.setAttribute('data-theme', theme);
  document.querySelectorAll('.theme-btn').forEach(b => b.classList.toggle('active', b.dataset.theme === theme));
}

// ── Check ─────────────────────────────────────────────────────────────
async function runCheck() {
  const text = $('editor').value;
  if (text.trim().length < 3) { setStatus('err', 'Please enter some text first'); return; }

  setStatus('checking', 'Checking…');
  $('checkBtn').disabled = true;
  closeTooltip();

  try {
    // Normalize line endings so offsets match between textarea and API
    const normText = text.replace(/\r\n/g, '\n').replace(/\r/g, '\n');
    const raw = await bgCheck(normText.slice(0, 5600));
    allMatches = raw.filter(m => {
      if (m.rule?.issueType !== 'misspelling') return true;
      const w = normText.slice(m.offset, m.offset + m.length).toLowerCase().trim();
      return !dictionary.has(w);
    });

    // Use normalized text for mirror so offsets stay consistent
    updateMirrorHL(normText, allMatches);
    // Also update editor value to normalized form silently
    if (normText !== text) { $('editor').value = normText; }

    if (allMatches.length === 0) {
      setStatus('ok', 'No issues found — great writing!');
      hideStats();
      $('emptyState').style.display = '';
      $('emptyState').innerHTML = `<svg width="44" height="44" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1" opacity=".15"><path d="M22 11.08V12a10 10 0 11-5.93-9.14"/><polyline points="22 4 12 14.01 9 11.01"/></svg><p style="color:var(--green);font-weight:600">No issues found!</p><p class="empty-sub">Your text looks great</p>`;
    } else {
      setStatus('idle', `Found ${allMatches.length} issue${allMatches.length !== 1 ? 's' : ''} — click underlined words to fix`);
      renderStats();
      renderIssues();
    }
  } catch (e) {
    setStatus('err', e.message || 'Check failed');
  } finally {
    $('checkBtn').disabled = false;
  }
}

function bgCheck(text) {
  return new Promise((resolve, reject) => {
    chrome.runtime.sendMessage(
      { action: 'checkTextChunked', text, language, settings: currentSettings },
      r => {
        if (chrome.runtime.lastError) return reject(new Error(chrome.runtime.lastError.message));
        if (r && r.success) return resolve(r.matches || []);
        reject(new Error((r && r.error) || 'No response from background'));
      }
    );
  });
}

// ── Mirror underlines ─────────────────────────────────────────────────
function updateMirrorHL(text, matches) {
  // Sync mirror dimensions to textarea BEFORE rendering so word-wrap is identical
  syncMirrorSize();

  const len = text.length;
  const valid = [...matches]
    .filter(m => {
      const o = Number(m.offset), l = Number(m.length);
      return Number.isFinite(o) && Number.isFinite(l) && o >= 0 && l > 0 && o + l <= len;
    })
    .sort((a, b) => a.offset - b.offset);

  let html = '', cursor = 0;
  for (const m of valid) {
    if (m.offset < cursor) continue;
    html += esc(text.slice(cursor, m.offset));
    const c  = getClass(m);
    const mc = { spelling: 'sp', grammar: 'gr', style: 'st' }[c] || 'gr';
    const idx = matches.indexOf(m);
    html += `<mark class="${mc}" data-idx="${idx}">${esc(text.slice(m.offset, m.offset + m.length))}</mark>`;
    cursor = m.offset + m.length;
  }
  html += esc(text.slice(cursor));
  // No trailing ​ — it shifts character positions
  $('mirror').innerHTML = html;
  syncMirrorScroll();
}

// Copy textarea's exact pixel dimensions to the mirror so word-wrap is identical.
// The textarea's scrollbar eats ~17px of width — we must exclude it.
function syncMirrorSize() {
  const ed = $('editor');
  const mi = $('mirror');
  const cs = window.getComputedStyle(ed);

  // clientWidth excludes scrollbar; use it as mirror width
  mi.style.width  = ed.clientWidth  + 'px';
  mi.style.height = ed.clientHeight + 'px';

  // Keep font properties in sync with computed values (handles theme changes)
  mi.style.fontFamily    = cs.fontFamily;
  mi.style.fontSize      = cs.fontSize;
  mi.style.fontWeight    = cs.fontWeight;
  mi.style.lineHeight    = cs.lineHeight;
  mi.style.letterSpacing = cs.letterSpacing;
  mi.style.wordSpacing   = cs.wordSpacing;
  mi.style.padding       = cs.padding;
  mi.style.paddingTop    = cs.paddingTop;
  mi.style.paddingRight  = cs.paddingRight;
  mi.style.paddingBottom = cs.paddingBottom;
  mi.style.paddingLeft   = cs.paddingLeft;
  mi.style.tabSize       = cs.tabSize;
}

function syncMirrorScroll() {
  $('mirror').scrollTop  = $('editor').scrollTop;
  $('mirror').scrollLeft = $('editor').scrollLeft;
}

// ── Click on textarea → find match at click position → tooltip ───────
function onEditorClick(e) {
  if (!allMatches.length) return;

  // The browser moves textarea.selectionStart to the clicked character position.
  // We use requestAnimationFrame to read it after the browser updates it.
  requestAnimationFrame(() => {
    const pos = $('editor').selectionStart;
    if (pos === null || pos === undefined) return;

    // Find a match that spans this character position
    const match = allMatches.find(m => pos >= m.offset && pos < m.offset + m.length);
    if (!match) { closeTooltip(); return; }

    const idx = allMatches.indexOf(match);
    closeTooltip();

    // Position tooltip near the click point
    showInlineTooltip(match, idx, e.clientX, e.clientY);
    highlightIssueCard(idx);
  });
}

// ── Double-click → synonym lookup ─────────────────────────────────────
function onEditorDblClick(e) {
  requestAnimationFrame(async () => {
    const ed = $('editor');
    const selection = getTrimmedSynonymSelection(ed);
    if (!selection) return;
    const { start, end, word } = selection;
    if (!word || word.length < 2 || /\s/.test(word)) return;
    closeTooltip();
    showSynonymTooltip(word, e.clientX, e.clientY, { start, end });
  });
}
async function showSynonymTooltip(word, clickX, clickY, selection = null) {
  synonymSelection = selection || getTrimmedSynonymSelection($('editor'));
  const tip = $("inlineTooltip");
  tip.classList.remove('hidden');

  // Show loading state immediately
  tip.innerHTML = `
    <div class="tip-head">
      <span class="tip-type syn">Synonyms</span>
      <button class="tip-close" id="tipClose">✕</button>
    </div>
    <div class="tip-msg" style="display:flex;align-items:center;gap:8px">
      <span class="tip-spinner"></span>
      <span>Looking up <em>${esc(word)}</em>…</span>
    </div>`;

  positionTooltip(tip, clickX, clickY, 300, 80);
  activeTooltip = tip;
  $('tipClose').addEventListener('click', e => { e.stopPropagation(); closeTooltip(); });

  try {
    // Route through background to avoid tracking prevention
    // Background returns a flat string array from Datamuse
    const synonyms = await new Promise((resolve, reject) => {
      chrome.runtime.sendMessage({ action: 'fetchSynonyms', word }, r => {
        if (chrome.runtime.lastError) return reject(new Error(chrome.runtime.lastError.message));
        if (r && r.success) return resolve(r.synonyms || []);
        reject(new Error(r?.error || 'Lookup failed'));
      });
    });

    if (!synonyms.length) {
      tip.innerHTML = `
        <div class="tip-head">
          <span class="tip-type syn">Synonyms</span>
          <button class="tip-close" id="tipClose">✕</button>
        </div>
        <div class="tip-msg" style="padding:10px 14px;opacity:.7">No synonyms found for <em>${esc(word)}</em></div>`;
      $('tipClose').addEventListener('click', e => { e.stopPropagation(); closeTooltip(); });
      positionTooltip(tip, clickX, clickY, 260, 80);
      return;
    }

    tip.innerHTML = `
      <div class="tip-head">
        <span class="tip-type syn">${esc(word)}</span>
        <button class="tip-close" id="tipClose">✕</button>
      </div>
      <div class="tip-syn-section">
        <div class="tip-syn-label">Synonyms — double-click to replace</div>
        <div class="tip-sugs">${synonyms.map(s =>
          `<button class="tip-sug tip-syn-btn" data-val="${esc(s)}">${esc(s)}</button>`
        ).join('')}</div>
      </div>`;

    positionTooltip(tip, clickX, clickY, 320, 150);
        $('tipClose').addEventListener('click', e => { e.stopPropagation(); closeTooltip(); });

    tip.querySelectorAll('.tip-syn-btn').forEach(btn => {
      btn.addEventListener('mousedown', e => {
        e.preventDefault();
        e.stopPropagation();
        replaceSynonym(btn.dataset.val || btn.textContent || '');
        closeTooltip();
      });
    });

  } catch (err) {
    tip.innerHTML = `
      <div class="tip-head">
        <span class="tip-type syn">Synonyms</span>
        <button class="tip-close" id="tipClose">✕</button>
      </div>
      <div class="tip-msg" style="opacity:.6">Could not fetch synonyms</div>`;
    $('tipClose').addEventListener('click', e => { e.stopPropagation(); closeTooltip(); });
    positionTooltip(tip, clickX, clickY, 280, 70);
  }
}

function replaceSynonym(replacement) {
  const ed = $('editor');
  const start = synonymSelection?.start;
  const end = synonymSelection?.end;
  if (!Number.isInteger(start) || !Number.isInteger(end) || end <= start) return;
  const v = ed.value;
  ed.value = v.slice(0, start) + replacement + v.slice(end);
  ed.setSelectionRange(start, start + replacement.length);
  ed.focus();
  updateCharCount();
  saveEditorText();
  const diff = replacement.length - (end - start);
  allMatches.forEach(m => { if (m.offset >= end) m.offset += diff; });
  synonymSelection = null;
  updateMirrorHL(ed.value, allMatches);
}

function getTrimmedSynonymSelection(editor) {
  if (!editor) return null;
  let start = editor.selectionStart;
  let end = editor.selectionEnd;
  if (!Number.isInteger(start) || !Number.isInteger(end) || end <= start) {
    return null;
  }
  const value = editor.value || '';
  while (start < end && /\s/.test(value[start])) {
    start += 1;
  }
  while (end > start && /\s/.test(value[end - 1])) {
    end -= 1;
  }
  if (end <= start) {
    return null;
  }
  return {
    start,
    end,
    word: value.slice(start, end).toLowerCase()
  };
}
function positionTooltip(tip, clickX, clickY, tipW, tipH) {
  let left = clickX;
  let top  = clickY + 18;
  if (left + tipW > window.innerWidth  - 10) left = window.innerWidth  - tipW - 10;
  if (top  + tipH > window.innerHeight - 10) top  = clickY - tipH - 8;
  if (left < 10) left = 10;
  if (top  < 10) top  = 10;
  tip.style.left  = left + 'px';
  tip.style.top   = top  + 'px';
  tip.style.width = tipW + 'px';
}

function showInlineTooltip(match, idx, clickX, clickY) {
  const text = $('editor').value;
  const word = text.slice(match.offset, match.offset + match.length);
  const cls  = getClass(match);
  const sugs = (match.replacements || []).slice(0, 6).map(r => r.value);
  const typeLabel = { spelling: 'Spelling', grammar: 'Grammar', style: 'Style' }[cls] || 'Issue';

  const tip = $('inlineTooltip');
  tip.classList.remove('hidden');

  tip.innerHTML = `
    <div class="tip-head">
      <span class="tip-type ${cls.substring(0,2)}">${typeLabel}</span>
      <button class="tip-close" id="tipClose">�</button>
    </div>
    <div class="tip-msg">${esc(match.message)}</div>
    ${sugs.length
      ? `<div class="tip-sugs">${sugs.map(s => `<button class="tip-sug" data-val="${esc(s)}">${esc(s)}</button>`).join('')}</div>`
      : `<div style="padding:4px 12px 10px;font-size:12px;opacity:.5">No suggestions available</div>`}
    <div class="tip-footer">
      ${cls === 'spelling' ? `<button class="tip-dict" data-word="${esc(word)}">+ Add to dictionary</button>` : '<span></span>'}
      <button class="tip-dismiss">Dismiss</button>
    </div>`;

  positionTooltip(tip, clickX, clickY, 280, 160);
  activeTooltip = tip;

  $('tipClose').addEventListener('click', e => { e.stopPropagation(); closeTooltip(); });

  tip.querySelectorAll('.tip-sug').forEach(btn => {
    btn.addEventListener('click', e => {
      e.stopPropagation();
      applyFix(match, btn.dataset.val || btn.textContent || '');
      closeTooltip();
    });
  });

  const dismissBtn = tip.querySelector('.tip-dismiss');
  if (dismissBtn) {
    dismissBtn.addEventListener('click', e => {
      e.stopPropagation();
      allMatches = allMatches.filter(m => m !== match);
      updateMirrorHL($('editor').value, allMatches);
      renderStats();
      renderIssues();
      closeTooltip();
      if (!allMatches.length) {
        setStatus('ok', 'All issues resolved!');
        hideStats();
      }
    });
  }

  const dictBtn = tip.querySelector('.tip-dict');
  if (dictBtn) {
    dictBtn.addEventListener('click', e => {
      e.stopPropagation();
      addWordToDict(dictBtn.dataset.word);
      closeTooltip();
    });
  }
}
function closeTooltip() {
  const tip = $('inlineTooltip');
  if (tip) { tip.classList.add('hidden'); tip.innerHTML = ''; }
  activeTooltip = null;
  document.querySelectorAll('.issue-card.highlight').forEach(c => c.classList.remove('highlight'));
}

function highlightIssueCard(matchIdx) {
  document.querySelectorAll('#issuesList .issue-card').forEach(card => {
    if (parseInt(card.dataset.idx) === matchIdx) {
      card.classList.add('highlight');
      card.scrollIntoView({ behavior: 'smooth', block: 'nearest' });
    }
  });
}


// ── Scroll editor to match + get coords ──────────────────────────────
function scrollEditorToMatch(match) {
  const ed     = $('editor');
  const mirror = $('mirror');
  const markEl = mirror.querySelector('mark[data-idx="' + allMatches.indexOf(match) + '"]');
  if (!markEl) return;
  const markRect   = markEl.getBoundingClientRect();
  const mirrorRect = mirror.getBoundingClientRect();
  const relTop = markRect.top - mirrorRect.top + mirror.scrollTop;
  ed.scrollTop = Math.max(0, relTop - ed.clientHeight / 2 + markRect.height / 2);
  syncMirrorScroll();
}

function getMatchCoords(match) {
  const mirror = $('mirror');
  const markEl = mirror.querySelector('mark[data-idx="' + allMatches.indexOf(match) + '"]');
  if (!markEl) return null;
  const r = markEl.getBoundingClientRect();
  return { x: r.left, y: r.bottom + 6 };
}

// ── Stats ─────────────────────────────────────────────────────────────
function renderStats() {
  $('nErrors').textContent  = allMatches.filter(m => getClass(m) === 'spelling').length;
  $('nGrammar').textContent = allMatches.filter(m => getClass(m) === 'grammar').length;
  $('nStyle').textContent   = allMatches.filter(m => getClass(m) === 'style').length;
  $('nTotal').textContent   = allMatches.length;
  $('statsSection').style.display  = '';
  $('filterSection').style.display = '';
}

function hideStats() {
  $('statsSection').style.display  = 'none';
  $('filterSection').style.display = 'none';
}

// ── Issues panel ──────────────────────────────────────────────────────
function renderIssues() {
  const list = $('issuesList');
  $('emptyState').style.display = 'none';
  list.innerHTML = '';

  const text   = $('editor').value;
  const shown  = allMatches
    .map((m, i) => ({ m, i }))
    .filter(({ m }) => activeFilter === 'all' || getClass(m) === activeFilter);

  if (shown.length === 0) {
    const d = document.createElement('div');
    d.className = 'empty-state';
    d.innerHTML = '<p>No issues in this category</p>';
    list.appendChild(d);
    return;
  }

  shown.forEach(({ m, i }) => list.appendChild(buildCard(m, i, text)));
}

function buildCard(match, idx, text) {
  const cls  = getClass(match);
  const col  = { spelling: '#e53935', grammar: '#f57c00', style: '#1976d2' }[cls] || '#f57c00';
  const sugs = (match.replacements || []).slice(0, 6).map(r => r.value);
  const word = text.slice(match.offset, match.offset + match.length);
  const ctx  = match.context?.text || '';
  const co   = match.context?.offset || 0, cl = match.context?.length || 0;
  const ctxH = esc(ctx.slice(0, co)) + `<mark>${esc(ctx.slice(co, co + cl))}</mark>` + esc(ctx.slice(co + cl));

  const card = document.createElement('div');
  card.className = 'issue-card';
  card.dataset.idx = idx;

  card.innerHTML = `
    <div class="issue-head">
      <span class="issue-dot" style="background:${col}"></span>
      <div class="issue-info">
        <div class="issue-type">${esc(cls)}</div>
        <div class="issue-msg">${esc(match.message)}</div>
        ${ctx ? `<div class="issue-ctx">${ctxH}</div>` : ''}
      </div>
      <span class="chevron">▶</span>
    </div>
    <div class="issue-body">
      ${sugs.length ? `
        <div class="sug-label">Suggestions</div>
        <div class="sug-list">${sugs.map(s =>
          `<button class="sug-btn" data-val="${esc(s)}">${esc(s)}</button>`
        ).join('')}</div>` : ''}
      <div class="card-row">
        ${cls === 'spelling' ? `<button class="dict-btn" data-word="${esc(word)}">+ Add to dictionary</button>` : ''}
        <button class="dismiss-btn">Dismiss</button>
      </div>
    </div>`;

  card.querySelector('.issue-head').addEventListener('click', () => {
    const body = card.querySelector('.issue-body');
    const chev = card.querySelector('.chevron');
    const open = body.classList.toggle('open');
    chev.classList.toggle('open', open);
    // Scroll the editor to this word, then measure coords and show tooltip
    closeTooltip();
    scrollEditorToMatch(match);
    // rAF x2: first frame scrolls, second frame mirrors update, third we measure
    requestAnimationFrame(() => requestAnimationFrame(() => {
      const ed = $('editor');
      ed.focus();
      ed.setSelectionRange(match.offset, match.offset + match.length);
      const coords = getMatchCoords(match);
      const r = ed.getBoundingClientRect();
      showInlineTooltip(match, idx, coords ? coords.x : r.left + 40, coords ? coords.y : r.top + 60);
    }));
  });

  card.querySelectorAll('.sug-btn').forEach(btn => {
    btn.addEventListener('click', e => {
      e.stopPropagation();
      applyFix(match, btn.dataset.val || btn.textContent || '');
      card.remove();
    });
  });

  card.querySelector('.dismiss-btn').addEventListener('click', e => {
    e.stopPropagation();
    allMatches = allMatches.filter(m => m !== match);
    updateMirrorHL($('editor').value, allMatches);
    renderStats();
    renderIssues();
    if (!allMatches.length) {
      setStatus('ok', 'All issues resolved!');
      hideStats();
    }
  });

  const db = card.querySelector('.dict-btn');
  if (db) {
    db.addEventListener('click', e => {
      e.stopPropagation();
      addWordToDict(db.dataset.word.toLowerCase().trim());
    });
  }

  return card;
}

// ── Apply fix ─────────────────────────────────────────────────────────
function applyFix(match, replacement) {
  const ed   = $('editor');
  const v    = ed.value;
  ed.value   = v.slice(0, match.offset) + replacement + v.slice(match.offset + match.length);
  const diff = replacement.length - match.length;
  allMatches = allMatches.filter(m => m !== match);
  allMatches.forEach(m => { if (m.offset > match.offset) m.offset += diff; });
  updateMirrorHL(ed.value, allMatches);
  updateCharCount();
  renderStats();
  renderIssues();
  if (!allMatches.length) { setStatus('ok', 'All issues resolved!'); hideStats(); }
}

// ── Dictionary ────────────────────────────────────────────────────────
function addWordToDict(word) {
  const w = (word || '').toLowerCase().trim();
  if (!w) return;
  dictionary.add(w);
  chrome.storage.local.get('personalDict', data => {
    const arr = Array.isArray(data.personalDict) ? data.personalDict : [];
    if (!arr.includes(w)) arr.push(w);
    chrome.storage.local.set({ personalDict: arr });
  });
  // Remove all misspelling matches for this word
  allMatches = allMatches.filter(m => {
    if (m.rule?.issueType !== 'misspelling') return true;
    return $('editor').value.slice(m.offset, m.offset + m.length).toLowerCase().trim() !== w;
  });
  updateMirrorHL($('editor').value, allMatches);
  renderStats();
  renderIssues();
  if (!allMatches.length) { setStatus('ok', 'All issues resolved!'); hideStats(); }
}

// ── Clear ─────────────────────────────────────────────────────────────
function clearAll() {
  allMatches = [];
  closeTooltip();
  $('mirror').innerHTML = '';
  $('issuesList').innerHTML = '';
  $('emptyState').style.display = '';
  $('emptyState').innerHTML = `
    <svg width="44" height="44" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1" opacity=".15">
      <path d="M14 2H6a2 2 0 00-2 2v16a2 2 0 002 2h12a2 2 0 002-2V8z"/>
      <polyline points="14 2 14 8 20 8"/>
      <line x1="16" y1="13" x2="8" y2="13"/>
      <line x1="16" y1="17" x2="8" y2="17"/>
    </svg>
    <p>Paste text and click <strong>Check Now</strong></p>
    <p class="empty-sub">Click any underlined word to see suggestions</p>`;
  hideStats();
  setStatus('idle', 'Ready — paste text and click Check Now');
}

// ── Status ────────────────────────────────────────────────────────────
function setStatus(type, msg) {
  const bar = $('statusBar');
  bar.className = `status-${type}`;
  if (type === 'checking') {
    bar.innerHTML = `<div class="spinner"></div><span>${esc(msg || 'Checking…')}</span>`;
  } else {
    bar.innerHTML = `<span class="status-dot"></span><span>${esc(msg || '')}</span>`;
  }
}

// ── Settings persistence ─────────────────────────────────────────────
let saveTimer = null;
function saveEditorText() {
  clearTimeout(saveTimer);
  saveTimer = setTimeout(() => {
    chrome.storage.local.set({ editorText: $('editor').value });
  }, 800); // debounce 800ms so we don't write on every keystroke
}

// ── Helpers ───────────────────────────────────────────────────────────
function getClass(m) {
  const it  = (m.rule?.issueType    || '').toLowerCase();
  const cat = (m.rule?.category?.id || '').toLowerCase();
  if (it === 'misspelling') return 'spelling';
  if (it.includes('grammar') || cat.includes('grammar')) return 'grammar';
  if (it.includes('style')   || cat.includes('style'))   return 'style';
  return 'grammar';
}

function esc(s) {
  return (s || '').replace(/&/g,'&amp;').replace(/</g,'&lt;').replace(/>/g,'&gt;').replace(/"/g,'&quot;');
}







