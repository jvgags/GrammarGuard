// options.js — GrammarGuard Settings Page

const DEFAULTS = {
  enabled: true,
  language: 'auto',
  autoCheck: true,
  checkDelay: 1500,
  checkSpelling: true,
  checkGrammar: true,
  checkStyle: true,
  checkPunctuation: true,
  pickyMode: false,
  highlightStyle: 'underline',
  inlineTheme: 'soft',
  showBadge: true,
  showToasts: true,
  personalDict: '',
  ignoredSites: '',
  apiKey: '',
  apiUsername: ''
};

const fields = {
  enableGlobal:    { key: 'enabled',          type: 'checkbox' },
  defaultLanguage: { key: 'language',          type: 'select' },
  autoCheck:       { key: 'autoCheck',         type: 'checkbox' },
  checkDelay:      { key: 'checkDelay',        type: 'number' },
  checkSpelling:   { key: 'checkSpelling',     type: 'checkbox' },
  checkGrammar:    { key: 'checkGrammar',      type: 'checkbox' },
  checkStyle:      { key: 'checkStyle',        type: 'checkbox' },
  checkPunctuation:{ key: 'checkPunctuation',  type: 'checkbox' },
  pickyMode:       { key: 'pickyMode',         type: 'checkbox' },
  highlightStyle:  { key: 'highlightStyle',    type: 'select' },
  inlineTheme:     { key: 'inlineTheme',       type: 'select' },
  showBadge:       { key: 'showBadge',         type: 'checkbox' },
  showToasts:      { key: 'showToasts',        type: 'checkbox' },
  personalDict:    { key: 'personalDict',      type: 'textarea' },
  ignoredSites:    { key: 'ignoredSites',      type: 'textarea' },
  apiKey:          { key: 'apiKey',            type: 'text' },
  apiUsername:     { key: 'apiUsername',       type: 'text' }
};

document.addEventListener('DOMContentLoaded', async () => {
  await loadSettings();
  bindEvents();
  updateWordCount();
});

async function loadSettings() {
  const data = await chrome.storage.local.get(Object.values(fields).map(f => f.key));

  for (const [elemId, cfg] of Object.entries(fields)) {
    const el = document.getElementById(elemId);
    if (!el) continue;
    let val = data[cfg.key] !== undefined ? data[cfg.key] : DEFAULTS[cfg.key];
    // personalDict is stored as array, display as newline-separated text
    if (cfg.key === 'personalDict' && Array.isArray(val)) val = val.join('\n');
    if (cfg.type === 'checkbox') el.checked = val;
    else el.value = val;
  }
}

function bindEvents() {
  document.getElementById('saveBtn').addEventListener('click', saveSettings);
  document.getElementById('resetBtn').addEventListener('click', resetSettings);
  document.getElementById('clearDict').addEventListener('click', () => {
    document.getElementById('personalDict').value = '';
    updateWordCount();
  });
  document.getElementById('personalDict').addEventListener('input', updateWordCount);
}

async function saveSettings() {
  const data = {};
  for (const [elemId, cfg] of Object.entries(fields)) {
    const el = document.getElementById(elemId);
    if (!el) continue;
    if (cfg.type === 'checkbox') data[cfg.key] = el.checked;
    else if (cfg.type === 'number') data[cfg.key] = parseInt(el.value, 10) || DEFAULTS[cfg.key];
    else if (cfg.key === 'personalDict') {
      // Store as array of lowercase trimmed words
      data[cfg.key] = el.value.split('\n').map(w => w.trim().toLowerCase()).filter(Boolean);
    } else data[cfg.key] = el.value;
  }
  await chrome.storage.local.set(data);

  const msg = document.getElementById('savedMsg');
  msg.classList.add('visible');
  setTimeout(() => msg.classList.remove('visible'), 2500);
}

async function resetSettings() {
  if (!confirm('Reset all settings to defaults?')) return;
  await chrome.storage.local.set(DEFAULTS);
  await loadSettings();
  updateWordCount();
}

function updateWordCount() {
  const val = document.getElementById('personalDict').value.trim();
  const count = val ? val.split('\n').filter(w => w.trim()).length : 0;
  document.getElementById('wordCount').textContent = `${count} word${count !== 1 ? 's' : ''}`;
}



