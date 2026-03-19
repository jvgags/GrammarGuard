// background.js - GrammarGuard service worker
// Network fetches stay here so content scripts can work around page-level limits.

const PUBLIC_API_URL = 'https://api.languagetool.org/v2/check';
const CHUNK_SIZE = 1400;
const CHUNK_DELAY = 200;

let dictCache = new Set();

function refreshDict(raw) {
  if (Array.isArray(raw)) {
    dictCache = new Set(raw.map(word => word.toLowerCase().trim()).filter(Boolean));
    return;
  }

  if (typeof raw === 'string') {
    dictCache = new Set(raw.split('\n').map(word => word.toLowerCase().trim()).filter(Boolean));
    return;
  }

  dictCache = new Set();
}

chrome.storage.local.get('personalDict', data => refreshDict(data.personalDict));

chrome.storage.onChanged.addListener(changes => {
  if (changes.personalDict) {
    refreshDict(changes.personalDict.newValue);
  }
});

const APP_URL = chrome.runtime.getURL('popup.html');

chrome.action.onClicked.addListener(() => {
  chrome.tabs.query({ url: APP_URL }, tabs => {
    if (tabs.length > 0) {
      chrome.tabs.update(tabs[0].id, { active: true });
      chrome.windows.update(tabs[0].windowId, { focused: true });
      return;
    }

    chrome.tabs.create({ url: APP_URL });
  });
});

chrome.runtime.onInstalled.addListener(() => {
  chrome.contextMenus.create({ id: 'checkSelection', title: 'Check with GrammarGuard', contexts: ['selection'] });
  chrome.contextMenus.create({ id: 'checkPage', title: 'Check entire page', contexts: ['page'] });
});

chrome.contextMenus.onClicked.addListener(async (info, tab) => {
  if (!tab?.id) return;

  if (info.menuItemId === 'checkSelection' && info.selectionText) {
    try {
      const matches = await checkChunked(info.selectionText.substring(0, CHUNK_SIZE), { language: 'auto' });
      chrome.tabs.sendMessage(tab.id, { action: 'showContextResult', matches, text: info.selectionText }).catch(() => {});
    } catch (_) {
      // Ignore context menu failures.
    }
    return;
  }

  if (info.menuItemId === 'checkPage') {
    chrome.action.openPopup().catch(() => {});
  }
});

chrome.runtime.onMessage.addListener((msg, sender, sendResponse) => {
  if (msg.action === 'getSynonyms' || msg.action === 'fetchSynonyms') {
    getSynonyms(msg.word || '')
      .then(synonyms => sendResponse({ success: true, synonyms }))
      .catch(error => sendResponse({ success: false, error: error.message }));
    return true;
  }

  if (msg.action === 'ping') {
    sendResponse({ alive: true });
    return true;
  }

  if (msg.action === 'checkTextChunked') {
    checkChunked(msg.text || '', buildCheckOptions(msg))
      .then(matches => sendResponse({ success: true, matches }))
      .catch(error => sendResponse({ success: false, error: error.message }));
    return true;
  }

  if (msg.action === 'addToDict') {
    const word = (msg.word || '').trim().toLowerCase();
    if (!word) {
      sendResponse({ success: false });
      return true;
    }

    chrome.storage.local.get('personalDict', data => {
      const current = Array.isArray(data.personalDict) ? [...data.personalDict] : [];
      if (!current.includes(word)) {
        current.push(word);
      }

      chrome.storage.local.set({ personalDict: current }, () => {
        refreshDict(current);
        sendResponse({ success: true });
      });
    });
    return true;
  }

  if (msg.action === 'getSettings') {
    chrome.storage.local.get(null, data => sendResponse(data));
    return true;
  }
});

chrome.tabs.onUpdated.addListener((tabId, changeInfo) => {
  if (changeInfo.status === 'complete') {
    chrome.storage.session.remove(`results_${tabId}`).catch(() => {});
  }
});

async function checkChunked(text, options = {}) {
  const normalizedText = (text || '').replace(/\r\n/g, '\n').replace(/\r/g, '\n');
  const chunks = splitChunks(normalizedText, CHUNK_SIZE);
  const allMatches = [];
  let runningOffset = 0;

  for (let index = 0; index < chunks.length; index += 1) {
    const chunk = chunks[index];
    const rawMatches = await checkSingle(chunk, options);

    for (const match of rawMatches) {
      const offset = Number(match.offset);
      const length = Number(match.length);
      if (!Number.isFinite(offset) || !Number.isFinite(length)) continue;
      if (offset < 0 || length <= 0 || offset + length > chunk.length) continue;

      const absoluteOffset = runningOffset + offset;
      const chunkText = chunk.slice(offset, offset + length);
      const fullText = normalizedText.slice(absoluteOffset, absoluteOffset + length);

      if (chunkText !== fullText) {
        continue;
      }

      allMatches.push({ ...match, offset: absoluteOffset, length });
    }

    runningOffset += chunk.length;
    if (index < chunks.length - 1) {
      await sleep(CHUNK_DELAY);
    }
  }

  if (dictCache.size === 0) {
    return allMatches;
  }

  return allMatches.filter(match => {
    if (match.rule?.issueType !== 'misspelling') {
      return true;
    }

    const word = normalizedText.slice(match.offset, match.offset + match.length).toLowerCase().trim();
    return !dictCache.has(word);
  });
}

async function checkSingle(text, options = {}) {
  const language = (!options.language || options.language === 'auto') ? 'en-US' : options.language;
  const enabledCategories = getEnabledCategories(options);
  const body = new URLSearchParams();

  body.append('text', text);
  body.append('language', language);
  body.append('enabledOnly', 'false');
  if (enabledCategories.length) {
    body.append('enabledCategories', enabledCategories.join(','));
  }
  if (options.pickyMode) {
    body.append('level', 'picky');
  }
  body.append('disabledRules', 'UNPAIRED_BRACKETS,UNPAIRED_QUOTES,EN_QUOTES,SMART_QUOTES,MULTIPLICATION_SIGN,DASH_RULE');

  if (options.username && options.apiKey) {
    body.append('username', options.username);
    body.append('apiKey', options.apiKey);
  }

  const response = await fetch(options.apiUrl || PUBLIC_API_URL, {
    method: 'POST',
    headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
    body: body.toString()
  });

  if (!response.ok) {
    const errorText = await response.text().catch(() => '');
    if (response.status === 500 && errorText.includes('longer than')) {
      return [];
    }
    throw new Error(`API error ${response.status}: ${errorText.substring(0, 120)}`);
  }

  const data = await response.json();
  return filterNoisyMatches(data.matches || []);
}

function filterNoisyMatches(matches) {
  const noisyRules = new Set([
    'UNPAIRED_BRACKETS',
    'UNPAIRED_QUOTES',
    'EN_QUOTES',
    'SMART_QUOTES',
    'MULTIPLICATION_SIGN',
    'DASH_RULE',
    'CURRENCY',
    'ELLIPSIS',
    'PLUS_MINUS',
    'NON_STANDARD_WORD',
    'COMMA_PARENTHESIS_WHITESPACE'
  ]);

  return matches.filter(match => {
    if (noisyRules.has(match.rule?.id)) {
      return false;
    }

    const message = (match.message || '').toLowerCase();
    if ((message.includes('unpaired') || message.includes('symbol')) && !match.replacements?.length) {
      return false;
    }

    return true;
  });
}

async function getSynonyms(word) {
  if (!word || word.trim().length < 2) {
    return [];
  }

  const clean = word.trim().toLowerCase().replace(/[^a-z'-]/g, '');
  if (!clean) {
    return [];
  }

  const [synonymsResponse, similarResponse] = await Promise.all([
    fetch(`https://api.datamuse.com/words?rel_syn=${encodeURIComponent(clean)}&max=16`),
    fetch(`https://api.datamuse.com/words?ml=${encodeURIComponent(clean)}&max=8`)
  ]);

  const synonyms = synonymsResponse.ok ? await synonymsResponse.json() : [];
  const similar = similarResponse.ok ? await similarResponse.json() : [];

  const seen = new Set([clean]);
  return [...synonyms, ...similar]
    .filter(entry => {
      if (!entry?.word || seen.has(entry.word)) {
        return false;
      }
      seen.add(entry.word);
      return true;
    })
    .sort((left, right) => (right.score || 0) - (left.score || 0))
    .slice(0, 20)
    .map(entry => entry.word);
}

function buildCheckOptions(msg = {}) {
  const settings = msg.settings || {};
  return {
    apiKey: (settings.apiKey || '').trim(),
    apiUrl: (settings.apiUrl || PUBLIC_API_URL).trim(),
    checkGrammar: settings.checkGrammar !== false,
    checkPunctuation: settings.checkPunctuation !== false,
    checkSpelling: settings.checkSpelling !== false,
    checkStyle: settings.checkStyle !== false,
    pickyMode: settings.pickyMode === true,
    language: msg.language || settings.language || 'auto',
    username: (settings.apiUsername || '').trim()
  };
}

function getEnabledCategories(options = {}) {
  const categories = [];
  if (options.checkSpelling !== false) categories.push('TYPOS');
  if (options.checkGrammar !== false) categories.push('GRAMMAR');
  if (options.checkStyle !== false) categories.push('STYLE');
  if (options.checkPunctuation !== false) categories.push('PUNCTUATION');
  return categories;
}

function splitChunks(text, maxSize) {
  if (text.length <= maxSize) {
    return [text];
  }

  const chunks = [];
  let start = 0;

  while (start < text.length) {
    let end = start + maxSize;
    if (end >= text.length) {
      chunks.push(text.substring(start));
      break;
    }

    let cut = -1;
    for (let cursor = end; cursor > start + maxSize / 2; cursor -= 1) {
      if (/[.!?]/.test(text[cursor]) && text[cursor + 1] === ' ') {
        cut = cursor + 1;
        break;
      }
    }

    if (cut === -1) {
      for (let cursor = end; cursor > start + maxSize / 2; cursor -= 1) {
        if (text[cursor] === ' ') {
          cut = cursor + 1;
          break;
        }
      }
    }

    if (cut === -1) {
      cut = end;
    }

    chunks.push(text.substring(start, cut));
    start = cut;
  }

  return chunks;
}

function sleep(ms) {
  return new Promise(resolve => setTimeout(resolve, ms));
}
