// background.js — GrammarGuard Service Worker
// ALL fetch() calls live here. Never in content scripts (Edge Tracking Prevention).

const API_URL     = 'https://api.languagetool.org/v2/check';
const CHUNK_SIZE  = 1400; // chars — just under the free tier timeout threshold
const CHUNK_DELAY = 200;  // ms between chunks (only fires when text needs splitting)

// ── Personal dictionary cache ─────────────────────────────────────────
// Cached in memory so we never do a storage round-trip during a check.
let dictCache = new Set();

function refreshDict(raw) {
  if (Array.isArray(raw))      dictCache = new Set(raw.map(w => w.toLowerCase().trim()).filter(Boolean));
  else if (typeof raw==='string') dictCache = new Set(raw.split('\n').map(w=>w.toLowerCase().trim()).filter(Boolean));
  else dictCache = new Set();
}

// Load dict once on startup
chrome.storage.local.get('personalDict', d => refreshDict(d.personalDict));

// Keep cache in sync when user adds words
chrome.storage.onChanged.addListener(changes => {
  if (changes.personalDict) refreshDict(changes.personalDict.newValue);
});

// ── Context Menu ──────────────────────────────────────────────────────
chrome.runtime.onInstalled.addListener(() => {
  chrome.contextMenus.create({ id:'checkSelection', title:'Check with GrammarGuard', contexts:['selection'] });
  chrome.contextMenus.create({ id:'checkPage',      title:'Check entire page',        contexts:['page'] });
});

chrome.contextMenus.onClicked.addListener(async (info, tab) => {
  if (!tab?.id) return;
  if (info.menuItemId === 'checkSelection' && info.selectionText) {
    try {
      const matches = await checkChunked(info.selectionText.substring(0, CHUNK_SIZE), 'auto');
      chrome.tabs.sendMessage(tab.id, { action:'showContextResult', matches, text:info.selectionText }).catch(()=>{});
    } catch(_) {}
  }
  if (info.menuItemId === 'checkPage') chrome.action.openPopup().catch(()=>{});
});

// ── Message Handler ───────────────────────────────────────────────────
chrome.runtime.onMessage.addListener((msg, sender, sendResponse) => {

  if (msg.action === 'ping') {
    sendResponse({ alive:true });
    return true;
  }

  if (msg.action === 'checkTextChunked') {
    checkChunked(msg.text, msg.language || 'auto')
      .then(matches => sendResponse({ success:true, matches }))
      .catch(err   => sendResponse({ success:false, error:err.message }));
    return true;
  }

  if (msg.action === 'addToDict') {
    const word = (msg.word || '').trim().toLowerCase();
    if (!word) { sendResponse({ success:false }); return true; }
    chrome.storage.local.get('personalDict', data => {
      const arr = Array.isArray(data.personalDict) ? data.personalDict : [];
      if (!arr.includes(word)) arr.push(word);
      chrome.storage.local.set({ personalDict: arr }, () => {
        refreshDict(arr); // update cache immediately
        sendResponse({ success:true });
      });
    });
    return true;
  }

  if (msg.action === 'getSettings') {
    chrome.storage.local.get(['enabled','language'], data => sendResponse(data));
    return true;
  }
});

// ── Tab cleanup ───────────────────────────────────────────────────────
chrome.tabs.onUpdated.addListener((tabId, changeInfo) => {
  if (changeInfo.status === 'complete')
    chrome.storage.session.remove(`results_${tabId}`).catch(()=>{});
});

// ── Chunked check ─────────────────────────────────────────────────────
async function checkChunked(text, language) {
  const chunks = splitChunks(text, CHUNK_SIZE);
  const all    = [];
  let offset   = 0;

  for (let i = 0; i < chunks.length; i++) {
    const raw      = await checkSingle(chunks[i], language);
    const chunkLen = chunks[i].length;
    for (const m of raw) {
      const o = Number(m.offset), l = Number(m.length);
      if (!Number.isFinite(o) || !Number.isFinite(l)) continue;
      if (o < 0 || l <= 0 || o + l > chunkLen) continue;
      all.push({ ...m, offset: o + offset, length: l });
    }
    offset += chunkLen;
    if (i < chunks.length - 1) await sleep(CHUNK_DELAY);
  }

  // Filter against cached personal dictionary — no storage I/O
  if (dictCache.size === 0) return all;
  return all.filter(m => {
    if (m.rule?.issueType !== 'misspelling') return true;
    const word = text.slice(m.offset, m.offset + m.length).toLowerCase().trim();
    return !dictCache.has(word);
  });
}

// ── Single API call ───────────────────────────────────────────────────
async function checkSingle(text, language) {
  const body = new URLSearchParams();
  body.append('text',        text);
  body.append('language',    language === 'auto' ? 'auto' : language);
  body.append('enabledOnly', 'false');

  const res = await fetch(API_URL, {
    method:  'POST',
    headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
    body:    body.toString()
  });

  if (!res.ok) {
    const txt = await res.text().catch(() => '');
    if (res.status === 500 && txt.includes('longer than')) return []; // skip timed-out chunk
    throw new Error(`API error ${res.status}: ${txt.substring(0, 80)}`);
  }

  const data = await res.json();
  return data.matches || [];
}

// ── Helpers ───────────────────────────────────────────────────────────
function splitChunks(text, maxSize) {
  if (text.length <= maxSize) return [text];
  const out = [];
  let s = 0;
  while (s < text.length) {
    let e = s + maxSize;
    if (e >= text.length) { out.push(text.substring(s)); break; }
    // Break at sentence boundary first, then word boundary
    let cut = -1;
    for (let i = e; i > s + maxSize / 2; i--) {
      if (/[.!?]/.test(text[i]) && text[i+1] === ' ') { cut = i + 1; break; }
    }
    if (cut === -1) for (let i = e; i > s + maxSize / 2; i--) {
      if (text[i] === ' ') { cut = i + 1; break; }
    }
    if (cut === -1) cut = e;
    out.push(text.substring(s, cut));
    s = cut;
  }
  return out.filter(c => c.trim());
}

function sleep(ms) { return new Promise(r => setTimeout(r, ms)); }
