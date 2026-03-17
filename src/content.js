// content.js - GrammarGuard inline editor support
(function () {
  'use strict';

  const state = {
    settings: {
      enabled: true,
      language: 'auto',
      autoCheck: false,
      checkDelay: 1500,
      checkSpelling: true,
      checkGrammar: true,
      checkStyle: true,
      checkPunctuation: true,
      showBadge: true,
      showToasts: true,
      inlineTheme: 'soft',
      ignoredSites: []
    },
    activeSession: null,
    sessions: new WeakMap(),
    overlay: null,
    overlayContent: null,
    badge: null,
    tooltip: null,
    syncScheduled: false
  };

  const EDITABLE_INPUT_TYPES = new Set(['', 'email', 'search', 'tel', 'text', 'url']);

  init();

  async function init() {
    state.settings = await loadSettings();
    createUi();
    bindGlobalEvents();
  }

  function createUi() {
    state.overlay = document.createElement('div');
    state.overlay.className = 'gg-overlay hidden';
    state.overlayContent = document.createElement('div');
    state.overlayContent.className = 'gg-overlay-content';
    state.overlay.appendChild(state.overlayContent);

    state.badge = document.createElement('button');
    state.badge.type = 'button';
    state.badge.className = 'gg-badge hidden';
    state.badge.addEventListener('mousedown', event => {
      event.preventDefault();
      event.stopPropagation();
    });
    state.badge.addEventListener('click', event => {
      event.preventDefault();
      event.stopPropagation();
      if (state.activeSession) {
        state.activeSession.element.focus();
        runCheck(state.activeSession, true);
      }
    });

    state.tooltip = document.createElement('div');
    state.tooltip.className = 'gg-tooltip hidden';

    document.documentElement.appendChild(state.overlay);
    document.documentElement.appendChild(state.badge);
    document.documentElement.appendChild(state.tooltip);
    applyInlineTheme();
  }

  function bindGlobalEvents() {
    document.addEventListener('focusin', onFocusIn, true);
    document.addEventListener('focusout', onFocusOut, true);
    document.addEventListener('input', onInput, true);
    document.addEventListener('click', onClick, true);
    document.addEventListener('dblclick', onDoubleClick, true);
    document.addEventListener('selectionchange', onSelectionChange, true);
    window.addEventListener('scroll', scheduleSync, true);
    window.addEventListener('resize', scheduleSync, true);

    chrome.storage.onChanged.addListener(changes => {
      let needsReload = false;
      for (const key of Object.keys(changes)) {
        if (key in state.settings) {
          needsReload = true;
          break;
        }
      }
      if (needsReload) {
        loadSettings().then(settings => {
          state.settings = settings;
          applyInlineTheme();
          if (state.activeSession) {
            state.activeSession.dictionary = new Set(settings.personalDict);
            scheduleSync();
          }
        });
      }
    });

    chrome.runtime.onMessage.addListener((message, sender, sendResponse) => {
      if (message.action === 'showContextResult') {
        showToast(`Selection check found ${(message.matches || []).length} issues.`);
        sendResponse({ ok: true });
      }
    });
  }

  async function onFocusIn(event) {
    const element = getEditableTarget(event.target);
    if (!element || isIgnoredSite() || !state.settings.enabled) {
      return;
    }

    const session = getSession(element);
    setActiveSession(session);

    if (session.type === 'plain') {
      syncPlainOverlay(session);
    } else {
      clearOverlay();
    }

    if (state.settings.autoCheck) {
      scheduleCheck(session, true);
    } else {
      updateBadge(session);
    }
  }

  function onFocusOut(event) {
    if (!state.activeSession) {
      return;
    }

    const related = event.relatedTarget;
    if (related && (state.tooltip.contains(related) || state.badge.contains(related))) {
      return;
    }

    window.setTimeout(() => {
      const session = state.activeSession;
      const active = document.activeElement;
      if (!session) {
        return;
      }
      if (active && (state.tooltip.contains(active) || state.badge.contains(active))) {
        return;
      }

      if (!active || getEditableTarget(active) !== session.element) {
        hideTooltip();
        if (session.type === 'plain') {
          clearOverlay();
        }
        state.badge.classList.add('hidden');
        state.activeSession = null;
      }
    }, 0);
  }

  function onInput(event) {
    const element = getEditableTarget(event.target);
    if (!element) {
      return;
    }

    const session = getSession(element);
    session.lastText = getEditableText(session);
    clearRenderedMatches(session);
    scheduleCheck(session, false);
  }

  function onClick(event) {
    if (state.tooltip.contains(event.target)) {
      return;
    }

    if (state.activeSession?.type === 'plain' && event.target === state.activeSession.element) {
      const session = state.activeSession;
      window.requestAnimationFrame(() => {
        const position = session.element.selectionStart;
        const match = findMatchAt(session.matches, position);
        if (match) {
          showMatchTooltip(session, match, event.clientX, event.clientY);
        } else {
          hideTooltip();
        }
      });
      return;
    }

    const marker = event.target.closest('.gg-ce-mark');
    if (marker && state.activeSession?.type === 'rich') {
      const index = Number(marker.dataset.idx);
      const match = state.activeSession.matches[index];
      if (match) {
        const rect = marker.getBoundingClientRect();
        showMatchTooltip(state.activeSession, match, rect.left, rect.bottom + 8);
        event.preventDefault();
        event.stopPropagation();
      }
      return;
    }

    if (!state.badge.contains(event.target)) {
      hideTooltip();
    }
  }

  function onDoubleClick(event) {
    const session = state.activeSession;
    if (!session) {
      return;
    }

    if (session.type === 'plain' && event.target === session.element) {
      window.requestAnimationFrame(() => {
        const word = session.element.value.slice(session.element.selectionStart, session.element.selectionEnd).trim();
        if (word) {
          showSynonyms(session, word, event.clientX, event.clientY);
        }
      });
      return;
    }

    if (session.type === 'rich' && session.element.contains(event.target)) {
      const selection = window.getSelection();
      const word = selection ? selection.toString().trim() : '';
      if (word && !/\s/.test(word)) {
        showSynonyms(session, word, event.clientX, event.clientY);
      }
    }
  }

  function onSelectionChange() {
    if (state.activeSession?.type === 'plain') {
      scheduleSync();
    }
  }

  function getEditableTarget(node) {
    if (!(node instanceof Element)) {
      return null;
    }

    const direct = node.closest('textarea, input, [contenteditable="true"], [contenteditable=""], [contenteditable="plaintext-only"]');
    if (!direct) {
      return null;
    }

    if (direct instanceof HTMLTextAreaElement) {
      return direct;
    }

    if (direct instanceof HTMLInputElement) {
      const type = (direct.type || '').toLowerCase();
      return EDITABLE_INPUT_TYPES.has(type) ? direct : null;
    }

    if (direct.isContentEditable) {
      return direct;
    }

    return null;
  }

  function getSession(element) {
    if (state.sessions.has(element)) {
      return state.sessions.get(element);
    }

    const session = {
      element,
      type: element.isContentEditable ? 'rich' : 'plain',
      timer: null,
      matches: [],
      renderedNodes: [],
      lastText: getEditableText({ element, type: element.isContentEditable ? 'rich' : 'plain' }),
      dictionary: new Set(state.settings.personalDict)
    };

    state.sessions.set(element, session);
    return session;
  }

  function setActiveSession(session) {
    state.activeSession = session;
    scheduleSync();
  }

  function scheduleCheck(session, immediate) {
    if (!session || !state.settings.enabled || isIgnoredSite()) {
      return;
    }

    if (session.timer) {
      clearTimeout(session.timer);
    }

    const delay = immediate ? 0 : Math.max(300, Number(state.settings.checkDelay) || 1500);
    session.timer = window.setTimeout(() => runCheck(session, false), delay);
  }

  async function runCheck(session, fromManualTrigger) {
    if (!session || !state.settings.enabled) {
      return;
    }

    const text = getEditableText(session);
    session.lastText = text;
    if (text.trim().length < 3) {
      session.matches = [];
      clearRenderedMatches(session);
      updateBadge(session);
      return;
    }

    session.dictionary = new Set(state.settings.personalDict);
    showBadge(session, 'Checking...');

    try {
      const response = await sendMessage({
        action: 'checkTextChunked',
        text,
        language: state.settings.language,
        settings: state.settings
      });

      const matches = (response.matches || []).filter(match => shouldKeepMatch(session, text, match));
      session.matches = matches;
      renderMatches(session, text);
      updateBadge(session);

      if (fromManualTrigger && !matches.length) {
        showToast('No issues found in this field.');
      }
    } catch (error) {
      showBadge(session, 'Retry');
      if (fromManualTrigger || state.settings.showToasts) {
        showToast(error.message || 'Check failed');
      }
    }
  }

  function shouldKeepMatch(session, text, match) {
    if (match.rule?.issueType !== 'misspelling') {
      return true;
    }

    const word = text.slice(match.offset, match.offset + match.length).toLowerCase().trim();
    return !session.dictionary.has(word);
  }

  function renderMatches(session, text) {
    hideTooltip();
    if (session.type === 'plain') {
      renderPlainMatches(session, text);
      return;
    }

    renderRichMatches(session, text);
  }

  function renderPlainMatches(session, text) {
    syncPlainOverlay(session);
    const validMatches = [...session.matches]
      .filter(match => isValidMatch(match, text.length))
      .sort((left, right) => left.offset - right.offset);

    let html = '';
    let cursor = 0;
    for (const match of validMatches) {
      if (match.offset < cursor) {
        continue;
      }
      html += escapeHtml(text.slice(cursor, match.offset));
      html += `<mark class="gg-mark ${getIssueClass(match)}" data-offset="${match.offset}">${escapeHtml(text.slice(match.offset, match.offset + match.length))}</mark>`;
      cursor = match.offset + match.length;
    }
    html += escapeHtml(text.slice(cursor));

    state.overlayContent.innerHTML = html;

  }

  function renderRichMatches(session, text) {
    clearRenderedMatches(session);
    let textNodes = collectTextNodes(session.element);
    const validMatches = [...session.matches]
      .map((match, index) => ({ match, index }))
      .filter(({ match }) => isValidMatch(match, text.length))
      .sort((left, right) => right.match.offset - left.match.offset);

    for (const { match, index } of validMatches) {
      const start = locateRangeBoundary(textNodes, match.offset, false);
      const end = locateRangeBoundary(textNodes, match.offset + match.length, true);
      if (!start || !end) {
        continue;
      }

      const range = document.createRange();
      range.setStart(start.node, start.offset);
      range.setEnd(end.node, end.offset);
      if (range.collapsed) {
        continue;
      }

      const extracted = range.extractContents();
      const mark = document.createElement('span');
      mark.className = `gg-ce-mark ${getIssueClass(match)}`;
      mark.dataset.idx = String(index);
      mark.appendChild(extracted);
      range.insertNode(mark);
      session.renderedNodes.push(mark);
      textNodes = collectTextNodes(session.element);
    }
  }

  function clearRenderedMatches(session) {
    if (session.type === 'plain') {
      state.overlayContent.innerHTML = '';
      return;
    }

    for (const mark of session.renderedNodes.splice(0)) {
      if (!mark.isConnected) {
        continue;
      }
      const fragment = document.createDocumentFragment();
      while (mark.firstChild) {
        fragment.appendChild(mark.firstChild);
      }
      mark.replaceWith(fragment);
    }
    normalizeNode(session.element);
  }

  function syncPlainOverlay(session) {
    if (!session || session.type !== 'plain') {
      return;
    }

    const rect = session.element.getBoundingClientRect();
    if (rect.width === 0 || rect.height === 0) {
      clearOverlay();
      return;
    }

    const style = window.getComputedStyle(session.element);
    state.overlay.classList.remove('hidden');
    state.overlay.style.left = `${rect.left + window.scrollX}px`;
    state.overlay.style.top = `${rect.top + window.scrollY}px`;
    state.overlay.style.width = `${rect.width}px`;
    state.overlay.style.height = `${rect.height}px`;
    state.overlay.style.padding = style.padding;
    state.overlay.style.font = style.font;
    state.overlay.style.lineHeight = style.lineHeight;
    state.overlay.style.letterSpacing = style.letterSpacing;
    state.overlay.style.textAlign = style.textAlign;
    state.overlay.style.whiteSpace = session.element instanceof HTMLInputElement ? 'pre' : 'pre-wrap';
    state.overlay.style.wordBreak = 'break-word';
    state.overlay.style.borderRadius = style.borderRadius;
    state.overlay.scrollTop = session.element.scrollTop;
    state.overlay.scrollLeft = session.element.scrollLeft;
  }

  function clearOverlay() {
    state.overlay.classList.add('hidden');
    state.overlayContent.innerHTML = '';
  }

  function updateBadge(session, customText) {
    if (!session || !state.settings.showBadge) {
      state.badge.classList.add('hidden');
      return;
    }

    const rect = session.element.getBoundingClientRect();
    if (rect.width === 0 || rect.height === 0) {
      state.badge.classList.add('hidden');
      return;
    }

    const count = session.matches.length;
    if (!customText && count === 0) {
      state.badge.classList.add('hidden');
      return;
    }

    state.badge.textContent = customText || `${count} issue${count === 1 ? '' : 's'}`;
    state.badge.classList.remove('hidden');
    state.badge.classList.toggle('has-issues', !customText && count > 0);
    state.badge.style.left = `${rect.right + window.scrollX - 88}px`;
    state.badge.style.top = `${rect.top + window.scrollY + 8}px`;
  }

  function showBadge(session, customText) {
    updateBadge(session, customText);
  }

  async function showSynonyms(session, word, x, y) {
    const clean = word.trim();
    rememberSynonymTarget(session);
    if (!clean || clean.length < 2) {
      return;
    }

    showTooltip(x, y, `
      <div class="gg-tip-head">
        <span class="gg-tip-tag synonym">Synonyms</span>
        <button type="button" class="gg-tip-close" data-close>Close</button>
      </div>
      <div class="gg-tip-body muted">Looking up <strong>${escapeHtml(clean)}</strong>...</div>
    `);

    try {
      const response = await sendMessage({ action: 'fetchSynonyms', word: clean });
      const synonyms = response.synonyms || [];
      const chips = synonyms.length
        ? synonyms.map(value => `<button type="button" class="gg-chip synonym" data-synonym="${escapeHtml(value)}">${escapeHtml(value)}</button>`).join('')
        : '<div class="gg-tip-body muted">No synonyms found.</div>';

      showTooltip(x, y, `
        <div class="gg-tip-head">
          <span class="gg-tip-tag synonym">${escapeHtml(clean)}</span>
          <button type="button" class="gg-tip-close" data-close>Close</button>
        </div>
        <div class="gg-tip-body">
          <div class="gg-tip-label">Choose a synonym</div>
          <div class="gg-chip-row">${chips}</div>
        </div>
      `);

      state.tooltip.querySelectorAll('[data-synonym]').forEach(button => {
        button.addEventListener('mousedown', event => {
          event.preventDefault();
          event.stopPropagation();
          replaceSelectedWord(session, button.dataset.synonym || button.textContent || '');
        });
      });
    } catch (error) {
      showTooltip(x, y, `
        <div class="gg-tip-head">
          <span class="gg-tip-tag synonym">Synonyms</span>
          <button type="button" class="gg-tip-close" data-close>Close</button>
        </div>
        <div class="gg-tip-body muted">Could not fetch synonyms.</div>
      `);
    }
  }

  function showMatchTooltip(session, match, x, y) {
    const text = getEditableText(session);
    const value = text.slice(match.offset, match.offset + match.length);
    const suggestions = (match.replacements || []).slice(0, 6).map(item => item.value).filter(Boolean);
    const actions = suggestions.length
      ? suggestions.map(value => `<button type="button" class="gg-chip" data-replace="${escapeHtml(value)}">${escapeHtml(value)}</button>`).join('')
      : '<div class="gg-tip-body muted">No suggestions available.</div>';
    const dictionaryButton = match.rule?.issueType === 'misspelling'
      ? `<button type="button" class="gg-secondary" data-dict="${escapeHtml(value)}">Add to dictionary</button>`
      : '';

    showTooltip(x, y, `
      <div class="gg-tip-head">
        <span class="gg-tip-tag ${getIssueClass(match)}">${escapeHtml(getIssueLabel(match))}</span>
        <button type="button" class="gg-tip-close" data-close>Close</button>
      </div>
      <div class="gg-tip-body">${escapeHtml(match.message || 'Suggestion')}</div>
      <div class="gg-tip-body">
        <div class="gg-tip-label">Suggestions</div>
        <div class="gg-chip-row">${actions}</div>
      </div>
      <div class="gg-tip-actions">
        ${dictionaryButton}
        <button type="button" class="gg-secondary" data-ignore="${match.offset}">Dismiss</button>
      </div>
    `);

    state.tooltip.querySelectorAll('[data-replace]').forEach(button => {
      button.addEventListener('click', () => applyReplacement(session, match, button.dataset.replace || ''));
    });

    const dictButton = state.tooltip.querySelector('[data-dict]');
    if (dictButton) {
      dictButton.addEventListener('click', () => addWordToDictionary(session, dictButton.dataset.dict || ''));
    }

    const dismissButton = state.tooltip.querySelector('[data-ignore]');
    if (dismissButton) {
      dismissButton.addEventListener('click', () => {
        session.matches = session.matches.filter(item => item !== match);
        renderMatches(session, getEditableText(session));
        updateBadge(session);
        hideTooltip();
      });
    }
  }

  function showTooltip(x, y, html) {
    state.tooltip.innerHTML = html;
    state.tooltip.classList.remove('hidden');
    state.tooltip.style.left = `${x + window.scrollX}px`;
    state.tooltip.style.top = `${y + window.scrollY}px`;

    const closeButton = state.tooltip.querySelector('[data-close]');
    if (closeButton) {
      closeButton.addEventListener('click', hideTooltip);
    }

    const rect = state.tooltip.getBoundingClientRect();
    if (rect.right > window.innerWidth - 12) {
      state.tooltip.style.left = `${window.scrollX + window.innerWidth - rect.width - 12}px`;
    }
    if (rect.bottom > window.innerHeight - 12) {
      state.tooltip.style.top = `${window.scrollY + window.innerHeight - rect.height - 12}px`;
    }
  }

  function hideTooltip() {
    state.tooltip.classList.add('hidden');
    state.tooltip.innerHTML = '';
  }

  async function applyReplacement(session, match, replacement) {
    if (session.type === 'plain') {
      const element = session.element;
      const value = element.value;
      element.value = value.slice(0, match.offset) + replacement + value.slice(match.offset + match.length);
      element.dispatchEvent(new Event('input', { bubbles: true }));
    } else {
      replaceContentEditableRange(session, match.offset, match.length, replacement);
      session.element.dispatchEvent(new Event('input', { bubbles: true }));
    }

    hideTooltip();
    scheduleCheck(session, true);
  }

  function replaceSelectedWord(session, replacement) {
    if (!replacement) {
      return;
    }

    const target = state.synonymTarget;
    if (!target || target.session !== session) {
      return;
    }

    if (session.type === 'plain') {
      const element = session.element;
      const start = target.start;
      const end = target.end;
      if (!Number.isInteger(start) || !Number.isInteger(end) || end <= start) {
        return;
      }
      const value = element.value;
      element.value = value.slice(0, start) + replacement + value.slice(end);
      element.focus();
      element.setSelectionRange(start, start + replacement.length);
      element.dispatchEvent(new Event('input', { bubbles: true }));
    } else {
      const selection = window.getSelection();
      if (!target.range) {
        return;
      }
      const range = target.range.cloneRange();
      range.deleteContents();
      range.insertNode(document.createTextNode(replacement));
      if (selection) {
        selection.removeAllRanges();
        const caret = document.createRange();
        caret.setStart(range.endContainer, range.endOffset);
        caret.collapse(true);
        selection.addRange(caret);
      }
      session.element.dispatchEvent(new Event('input', { bubbles: true }));
    }

    state.synonymTarget = null;
    hideTooltip();
    scheduleCheck(session, true);
  }

  async function addWordToDictionary(session, word) {
    const clean = word.toLowerCase().trim();
    if (!clean) {
      return;
    }

    await sendMessage({ action: 'addToDict', word: clean });
    state.settings.personalDict = Array.from(new Set([...state.settings.personalDict, clean]));
    session.dictionary = new Set(state.settings.personalDict);
    session.matches = session.matches.filter(match => {
      const text = getEditableText(session).slice(match.offset, match.offset + match.length).toLowerCase().trim();
      return text !== clean;
    });
    renderMatches(session, getEditableText(session));
    updateBadge(session);
    hideTooltip();
  }

  function replaceContentEditableRange(session, startOffset, length, replacement) {
    clearRenderedMatches(session);
    const entries = collectTextNodes(session.element);
    const start = locateRangeBoundary(entries, startOffset, false);
    const end = locateRangeBoundary(entries, startOffset + length, true);
    if (!start || !end) {
      return;
    }

    const range = document.createRange();
    range.setStart(start.node, start.offset);
    range.setEnd(end.node, end.offset);
    range.deleteContents();
    range.insertNode(document.createTextNode(replacement));
    normalizeNode(session.element);
  }

  function rememberSynonymTarget(session) {
    if (session.type === 'plain') {
      state.synonymTarget = {
        session,
        start: session.element.selectionStart,
        end: session.element.selectionEnd
      };
      return;
    }

    const selection = window.getSelection();
    state.synonymTarget = {
      session,
      range: selection && selection.rangeCount ? selection.getRangeAt(0).cloneRange() : null
    };
  }

  function collectTextNodes(root) {
    const walker = document.createTreeWalker(root, NodeFilter.SHOW_TEXT, {
      acceptNode(node) {
        if (!node.textContent) {
          return NodeFilter.FILTER_REJECT;
        }
        if (node.parentElement?.closest('.gg-tooltip')) {
          return NodeFilter.FILTER_REJECT;
        }
        return NodeFilter.FILTER_ACCEPT;
      }
    });

    const entries = [];
    let current = walker.nextNode();
    let offset = 0;
    while (current) {
      const entry = {
        node: current,
        start: offset,
        end: offset + current.textContent.length
      };
      entries.push(entry);
      offset = entry.end;
      current = walker.nextNode();
    }
    return entries;
  }


  function locateRangeBoundary(entries, absoluteOffset, isEnd) {
    if (!entries.length) {
      return null;
    }

    for (let index = 0; index < entries.length; index += 1) {
      const entry = entries[index];
      const localOffset = absoluteOffset - entry.start;

      if (absoluteOffset < entry.end) {
        return { node: entry.node, offset: Math.max(0, localOffset) };
      }

      if (absoluteOffset === entry.end) {
        if (isEnd || index === entries.length - 1) {
          return { node: entry.node, offset: entry.node.textContent.length };
        }
      }
    }

    const last = entries[entries.length - 1];
    return { node: last.node, offset: last.node.textContent.length };
  }

  function normalizeNode(node) {
    node.normalize();
  }

  function findMatchAt(matches, offset) {
    return matches.find(match => offset >= match.offset && offset < match.offset + match.length) || null;
  }

  function isValidMatch(match, textLength) {
    return Number.isFinite(match.offset) && Number.isFinite(match.length) && match.offset >= 0 && match.length > 0 && match.offset + match.length <= textLength;
  }

  function getIssueClass(match) {
    const issueType = (match.rule?.issueType || '').toLowerCase();
    const category = (match.rule?.category?.id || '').toLowerCase();
    if (issueType === 'misspelling') return 'spelling';
    if (issueType.includes('style') || category.includes('style')) return 'style';
    return 'grammar';
  }

  function getIssueLabel(match) {
    const kind = getIssueClass(match);
    if (kind === 'spelling') return 'Spelling';
    if (kind === 'style') return 'Style';
    return 'Grammar';
  }

  function getEditableText(session) {
    if (session.type === 'plain') {
      return session.element.value.replace(/\r\n/g, '\n').replace(/\r/g, '\n');
    }

    return (session.element.textContent || '').replace(/\r\n/g, '\n').replace(/\r/g, '\n');
  }

  function scheduleSync() {
    if (state.syncScheduled) {
      return;
    }

    state.syncScheduled = true;
    window.requestAnimationFrame(() => {
      state.syncScheduled = false;
      if (!state.activeSession) {
        return;
      }

      if (state.activeSession.type === 'plain') {
        syncPlainOverlay(state.activeSession);
      }
      updateBadge(state.activeSession);
    });
  }

  function isIgnoredSite() {
    const host = window.location.hostname.toLowerCase();
    return state.settings.ignoredSites.some(site => host === site || host.endsWith(`.${site}`));
  }


  function applyInlineTheme() {
    const theme = state.settings.inlineTheme || 'soft';
    if (state.overlay) state.overlay.dataset.ggTheme = theme;
    if (state.badge) state.badge.dataset.ggTheme = theme;
    if (state.tooltip) state.tooltip.dataset.ggTheme = theme;
  }
  function showToast(message) {
    if (!state.settings.showToasts) {
      return;
    }

    const toast = document.createElement('div');
    toast.className = 'gg-toast';
    toast.dataset.ggTheme = state.settings.inlineTheme || 'soft';
    toast.textContent = message;
    document.documentElement.appendChild(toast);
    window.setTimeout(() => toast.classList.add('visible'), 10);
    window.setTimeout(() => {
      toast.classList.remove('visible');
      window.setTimeout(() => toast.remove(), 180);
    }, 2200);
  }

  async function loadSettings() {
    const stored = await chrome.storage.local.get(null);
    return {
      enabled: stored.enabled !== false,
      language: stored.language || 'auto',
      autoCheck: stored.autoCheck !== false,
      checkDelay: stored.checkDelay || 1500,
      checkSpelling: stored.checkSpelling !== false,
      checkGrammar: stored.checkGrammar !== false,
      checkStyle: stored.checkStyle !== false,
      checkPunctuation: stored.checkPunctuation !== false,
      showBadge: stored.showBadge !== false,
      showToasts: stored.showToasts !== false,
      inlineTheme: stored.inlineTheme || 'soft',
      personalDict: Array.isArray(stored.personalDict) ? stored.personalDict : [],
      ignoredSites: String(stored.ignoredSites || '')
        .split('\n')
        .map(site => site.trim().toLowerCase())
        .filter(Boolean),
      apiKey: stored.apiKey || '',
      apiUsername: stored.apiUsername || ''
    };
  }

  function sendMessage(payload) {
    return new Promise((resolve, reject) => {
      chrome.runtime.sendMessage(payload, response => {
        if (chrome.runtime.lastError) {
          reject(new Error(chrome.runtime.lastError.message));
          return;
        }
        if (!response) {
          reject(new Error('No response from background worker.'));
          return;
        }
        if (response.success === false) {
          reject(new Error(response.error || 'Request failed.'));
          return;
        }
        resolve(response);
      });
    });
  }

  function escapeHtml(value) {
    return String(value || '')
      .replace(/&/g, '&amp;')
      .replace(/</g, '&lt;')
      .replace(/>/g, '&gt;')
      .replace(/"/g, '&quot;');
  }
})();











