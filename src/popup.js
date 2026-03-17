// popup.js — GrammarGuard Popup Controller

// State
let allMatches = [];
let activeFilter = 'all';
let dismissedIds = new Set();

// DOM refs
const enableToggle   = document.getElementById('enableToggle');
const languageSelect = document.getElementById('languageSelect');
const checkBtn       = document.getElementById('checkBtn');
const clearBtn       = document.getElementById('clearBtn');
const settingsBtn    = document.getElementById('settingsBtn');
const issuesList     = document.getElementById('issuesList');
const emptyState     = document.getElementById('emptyState');
const statsRow       = document.getElementById('statsRow');
const filterTabs     = document.getElementById('filterTabs');
const statErrors     = document.getElementById('statErrors');
const statWarnings   = document.getElementById('statWarnings');
const statStyle      = document.getElementById('statStyle');
const statTotal      = document.getElementById('statTotal');

const statusIdle     = document.getElementById('statusIdle');
const statusChecking = document.getElementById('statusChecking');
const statusOk       = document.getElementById('statusOk');
const statusError    = document.getElementById('statusError');
const statusErrorMsg = document.getElementById('statusErrorMsg');

// ── Init ──────────────────────────────────────────────────────────────
document.addEventListener('DOMContentLoaded', async () => {
  await loadSettings();
  loadCachedResults();
  bindEvents();
});

async function loadSettings() {
  const data = await chrome.storage.local.get(['enabled', 'language', 'dismissedIds']);
  enableToggle.checked = data.enabled !== false;
  if (data.language) languageSelect.value = data.language;
  if (data.dismissedIds) dismissedIds = new Set(data.dismissedIds);
}

function loadCachedResults() {
  chrome.tabs.query({ active: true, currentWindow: true }, async (tabs) => {
    if (!tabs[0]) return;
    const cached = await chrome.storage.session.get(`results_${tabs[0].id}`);
    const key = `results_${tabs[0].id}`;
    if (cached[key]) {
      allMatches = cached[key];
      renderResults(allMatches);
    }
  });
}

function bindEvents() {
  checkBtn.addEventListener('click', runCheck);
  clearBtn.addEventListener('click', clearResults);
  settingsBtn.addEventListener('click', () => chrome.runtime.openOptionsPage());

  enableToggle.addEventListener('change', () => {
    chrome.storage.local.set({ enabled: enableToggle.checked });
    chrome.tabs.query({ active: true, currentWindow: true }, (tabs) => {
      if (tabs[0]) {
        chrome.tabs.sendMessage(tabs[0].id, {
          action: enableToggle.checked ? 'enable' : 'disable'
        }).catch(() => {});
      }
    });
  });

  languageSelect.addEventListener('change', () => {
    chrome.storage.local.set({ language: languageSelect.value });
  });

  // Filter tabs
  document.querySelectorAll('.tab').forEach(tab => {
    tab.addEventListener('click', () => {
      document.querySelectorAll('.tab').forEach(t => t.classList.remove('active'));
      tab.classList.add('active');
      activeFilter = tab.dataset.filter;
      renderResults(allMatches);
    });
  });
}

// ── Check ─────────────────────────────────────────────────────────────
const CHUNK_SIZE = 1500;      // chars per API request — well within free tier timeout
const CHUNK_DELAY_MS = 700;   // pause between chunks to avoid rate limiting
const MAX_TOTAL_CHARS = 9000; // cap total text to keep things snappy

async function runCheck() {
  if (!enableToggle.checked) {
    showStatus('error', 'GrammarGuard is disabled for this page');
    return;
  }

  showStatus('checking');
  checkBtn.disabled = true;

  try {
    const [tab] = await chrome.tabs.query({ active: true, currentWindow: true });
    if (!tab) throw new Error('No active tab');

    // Extract focused/visible text from the page
    let textResult;
    try {
      [textResult] = await chrome.scripting.executeScript({
        target: { tabId: tab.id },
        func: extractPageText,
      });
    } catch (e) {
      throw new Error('Cannot access this page (restricted URL)');
    }

    const fullText = textResult?.result?.trim();
    if (!fullText || fullText.length < 5) {
      throw new Error('No readable text found on this page');
    }

    const text = fullText.substring(0, MAX_TOTAL_CHARS);
    const language = languageSelect.value === 'auto' ? 'auto' : languageSelect.value;

    // Route ALL API calls through the background service worker.
    // This avoids Edge/Firefox Tracking Prevention blocking fetch() in the popup.
    updateCheckingStatus(1, 1);
    allMatches = await new Promise((resolve, reject) => {
      chrome.runtime.sendMessage(
        { action: 'checkTextChunked', text, language },
        (response) => {
          if (chrome.runtime.lastError) return reject(new Error(chrome.runtime.lastError.message));
          if (response && response.success) resolve(response.matches || []);
          else reject(new Error((response && response.error) || 'Check failed'));
        }
      );
    });

    // Cache results
    await chrome.storage.session.set({ [`results_${tab.id}`]: allMatches });

    // Send highlights to content script
    chrome.tabs.sendMessage(tab.id, {
      action: 'highlight',
      matches: allMatches,
      text: text
    }).catch(() => {});

    showStatus(allMatches.length === 0 ? 'ok' : 'idle');
    renderResults(allMatches);

  } catch (err) {
    console.error('[GrammarGuard]', err);
    showStatus('error', err.message || 'Unknown error');
  } finally {
    checkBtn.disabled = false;
  }
}

// API calls are handled by background.js via chrome.runtime.sendMessage
// (checkChunk removed — no fetch() in popup or content scripts)

// Split text into chunks at sentence boundaries where possible
function splitIntoChunks(text, maxSize) {
  if (text.length <= maxSize) return [text];

  const chunks = [];
  let start = 0;

  while (start < text.length) {
    let end = start + maxSize;
    if (end >= text.length) {
      chunks.push(text.substring(start));
      break;
    }

    // Try to break at a sentence boundary (. ! ? followed by space)
    let breakAt = -1;
    for (let i = end; i > start + maxSize / 2; i--) {
      if (/[.!?]/.test(text[i]) && (i + 1 >= text.length || text[i + 1] === ' ' || text[i + 1] === '\n')) {
        breakAt = i + 1;
        break;
      }
    }

    // Fall back to word boundary
    if (breakAt === -1) {
      for (let i = end; i > start + maxSize / 2; i--) {
        if (text[i] === ' ' || text[i] === '\n') {
          breakAt = i + 1;
          break;
        }
      }
    }

    if (breakAt === -1) breakAt = end; // hard cut

    chunks.push(text.substring(start, breakAt));
    start = breakAt;
  }

  return chunks.filter(c => c.trim().length > 0);
}

function updateCheckingStatus(current, total) {
  const el = document.querySelector('#statusChecking span');
  if (el) {
    el.textContent = total > 1
      ? `Checking… (${current}/${total} sections)`
      : 'Checking grammar…';
  }
}

function sleep(ms) {
  return new Promise(resolve => setTimeout(resolve, ms));
}

// Injected into page — extracts visible, meaningful text only
function extractPageText() {
  const skipTags = new Set([
    'SCRIPT','STYLE','NOSCRIPT','IFRAME','OBJECT','EMBED',
    'CODE','PRE','NAV','FOOTER','HEADER','ASIDE'
  ]);

  // Prefer focused editable element first
  const active = document.activeElement;
  if (active && (active.tagName === 'TEXTAREA' || active.tagName === 'INPUT')) {
    return active.value || '';
  }
  if (active && active.contentEditable === 'true') {
    return active.innerText || '';
  }

  // Otherwise get main content area
  const main = document.querySelector('main, article, [role="main"], .content, #content, #main') || document.body;

  const walker = document.createTreeWalker(
    main,
    NodeFilter.SHOW_TEXT,
    {
      acceptNode(node) {
        let el = node.parentElement;
        while (el) {
          if (skipTags.has(el.tagName)) return NodeFilter.FILTER_REJECT;
          // Skip hidden elements
          const style = window.getComputedStyle(el);
          if (style.display === 'none' || style.visibility === 'hidden') return NodeFilter.FILTER_REJECT;
          el = el.parentElement;
        }
        const txt = node.textContent.trim();
        if (txt.length < 3) return NodeFilter.FILTER_REJECT;
        return NodeFilter.FILTER_ACCEPT;
      }
    }
  );

  const parts = [];
  let node;
  while ((node = walker.nextNode())) {
    const t = node.textContent.trim();
    if (t) parts.push(t);
  }

  // Join with spaces, collapse whitespace
  return parts.join(' ').replace(/\s+/g, ' ').trim();
}

// ── Render ────────────────────────────────────────────────────────────
function renderResults(matches) {
  // Filter by active tab and dismissed
  const filtered = matches.filter(m => {
    if (dismissedIds.has(getMatchId(m))) return false;
    if (activeFilter === 'all') return true;
    const cat = getCategoryKey(m);
    return cat === activeFilter;
  });

  // Update stats
  const errors   = matches.filter(m => getIssueType(m) === 'error').length;
  const warnings = matches.filter(m => getIssueType(m) === 'warning').length;
  const style    = matches.filter(m => getIssueType(m) === 'style').length;

  statErrors.textContent   = errors;
  statWarnings.textContent = warnings;
  statStyle.textContent    = style;
  statTotal.textContent    = matches.length;

  if (matches.length > 0) {
    statsRow.classList.remove('hidden');
    filterTabs.classList.remove('hidden');
  } else {
    statsRow.classList.add('hidden');
    filterTabs.classList.add('hidden');
  }

  // Clear list
  issuesList.innerHTML = '';

  if (filtered.length === 0) {
    issuesList.appendChild(emptyState);
    if (allMatches.length > 0) {
      emptyState.querySelector('p').innerHTML = 'No issues in this category';
    } else {
      emptyState.querySelector('p').innerHTML = 'Run a check to see<br/>grammar &amp; spelling issues';
    }
    return;
  }

  filtered.forEach((match, idx) => {
    issuesList.appendChild(createIssueCard(match, idx));
  });
}

function createIssueCard(match, idx) {
  const type = getIssueType(match);
  const card = document.createElement('div');
  card.className = 'issue-card';
  card.dataset.id = getMatchId(match);

  const dotClass = { error: 'dot-error', warning: 'dot-warning', style: 'dot-style' }[type] || 'dot-other';

  // Build context snippet
  const context = match.context?.text || '';
  const ctxOffset = match.context?.offset || 0;
  const ctxLen = match.context?.length || 0;
  const before = escHtml(context.substring(0, ctxOffset));
  const marked = escHtml(context.substring(ctxOffset, ctxOffset + ctxLen));
  const after  = escHtml(context.substring(ctxOffset + ctxLen));
  const ctxHtml = `${before}<mark>${marked}</mark>${after}`;

  // Suggestions
  const suggestions = (match.replacements || []).slice(0, 6).map(r => r.value);

  card.innerHTML = `
    <div class="issue-header">
      <div class="issue-type-dot ${dotClass}"></div>
      <div class="issue-main">
        <div class="issue-rule">${escHtml(match.rule?.issueType || match.rule?.id || 'issue')}</div>
        <div class="issue-message">${escHtml(match.message)}</div>
        <div class="issue-context">${ctxHtml}</div>
      </div>
      <svg class="issue-toggle" width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.5">
        <polyline points="6 9 12 15 18 9"/>
      </svg>
    </div>
    <div class="issue-body">
      <div class="suggestions-label">Suggestions</div>
      <div class="suggestions-list">
        ${suggestions.length > 0
          ? suggestions.map(s => `<button class="suggestion-btn" data-value="${escHtml(s)}">${escHtml(s)}</button>`).join('')
          : '<span class="no-suggestions">No suggestions available</span>'
        }
      </div>
      <div class="issue-actions">
        <button class="action-link dismiss">
          <svg width="11" height="11" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.5">
            <line x1="18" y1="6" x2="6" y2="18"/><line x1="6" y1="6" x2="18" y2="18"/>
          </svg>
          Dismiss
        </button>
        <button class="action-link more-info" data-url="${match.rule?.urls?.[0]?.value || ''}">
          <svg width="11" height="11" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2">
            <circle cx="12" cy="12" r="10"/><line x1="12" y1="16" x2="12" y2="12"/><line x1="12" y1="8" x2="12.01" y2="8"/>
          </svg>
          More info
        </button>
      </div>
    </div>
  `;

  // Toggle body
  const header = card.querySelector('.issue-header');
  const body   = card.querySelector('.issue-body');
  const toggle = card.querySelector('.issue-toggle');
  header.addEventListener('click', () => {
    const open = body.classList.toggle('open');
    toggle.classList.toggle('open', open);
  });

  // Dismiss
  card.querySelector('.action-link.dismiss').addEventListener('click', (e) => {
    e.stopPropagation();
    const id = getMatchId(match);
    dismissedIds.add(id);
    chrome.storage.local.set({ dismissedIds: [...dismissedIds] });
    card.style.animation = 'none';
    card.style.opacity = '0';
    card.style.transition = 'opacity .2s';
    setTimeout(() => {
      allMatches = allMatches.filter(m => getMatchId(m) !== id);
      renderResults(allMatches);
    }, 200);
  });

  // More info
  const moreInfoBtn = card.querySelector('.action-link.more-info');
  moreInfoBtn.addEventListener('click', (e) => {
    e.stopPropagation();
    const url = moreInfoBtn.dataset.url;
    if (url) chrome.tabs.create({ url });
    else chrome.tabs.create({ url: `https://languagetool.org/insights/post/grammar-checker/` });
  });

  // Apply suggestion
  card.querySelectorAll('.suggestion-btn').forEach(btn => {
    btn.addEventListener('click', (e) => {
      e.stopPropagation();
      const value = btn.dataset.value;
      chrome.tabs.query({ active: true, currentWindow: true }, (tabs) => {
        if (tabs[0]) {
          chrome.tabs.sendMessage(tabs[0].id, {
            action: 'applyFix',
            matchOffset: match.offset,
            matchLength: match.length,
            replacement: value
          }).catch(() => {});
        }
      });
      // Remove card
      const id = getMatchId(match);
      dismissedIds.add(id);
      allMatches = allMatches.filter(m => getMatchId(m) !== id);
      renderResults(allMatches);
    });
  });

  return card;
}

// ── Clear ─────────────────────────────────────────────────────────────
function clearResults() {
  allMatches = [];
  dismissedIds.clear();
  chrome.storage.local.set({ dismissedIds: [] });
  statsRow.classList.add('hidden');
  filterTabs.classList.add('hidden');
  showStatus('idle');
  issuesList.innerHTML = '';
  issuesList.appendChild(emptyState);
  emptyState.querySelector('p').innerHTML = 'Run a check to see<br/>grammar &amp; spelling issues';

  chrome.tabs.query({ active: true, currentWindow: true }, (tabs) => {
    if (tabs[0]) {
      chrome.tabs.sendMessage(tabs[0].id, { action: 'clearHighlights' }).catch(() => {});
      chrome.storage.session.remove(`results_${tabs[0].id}`);
    }
  });
}

// ── Status ────────────────────────────────────────────────────────────
function showStatus(type, msg) {
  statusIdle.classList.add('hidden');
  statusChecking.classList.add('hidden');
  statusOk.classList.add('hidden');
  statusError.classList.add('hidden');
  if (type === 'idle')     statusIdle.classList.remove('hidden');
  if (type === 'checking') statusChecking.classList.remove('hidden');
  if (type === 'ok')       statusOk.classList.remove('hidden');
  if (type === 'error') {
    statusError.classList.remove('hidden');
    statusErrorMsg.textContent = msg || 'Unknown error';
  }
}

// ── Helpers ───────────────────────────────────────────────────────────
function getIssueType(match) {
  const issueType = match.rule?.issueType?.toLowerCase() || '';
  const cat = match.rule?.category?.id?.toLowerCase() || '';
  if (issueType === 'misspelling' || cat === 'typos') return 'error';
  if (issueType.includes('grammar') || cat.includes('grammar')) return 'error';
  if (issueType.includes('style') || cat.includes('style') || cat.includes('redundancy')) return 'style';
  if (issueType.includes('hint') || issueType.includes('suggestion')) return 'style';
  return 'warning';
}

function getCategoryKey(match) {
  const issueType = match.rule?.issueType?.toLowerCase() || '';
  if (issueType === 'misspelling') return 'misspelling';
  const type = getIssueType(match);
  if (type === 'error') return 'grammar';
  if (type === 'style') return 'style';
  return 'grammar';
}

function getMatchId(match) {
  return `${match.offset}_${match.length}_${match.rule?.id}`;
}

function escHtml(str) {
  if (!str) return '';
  return str
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;');
}
