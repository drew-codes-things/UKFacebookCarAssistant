// ==UserScript==
// @name         UKFacebookCarAssistant
// @namespace    https://github.com/drew-codes-things/UKFacebookCarAssistant
// @version      1.0.0
// @description  MOT checks, price/watchlist filtering, and time-waster flagging for Facebook Marketplace
// @author       drew-codes-things
// @match        https://www.facebook.com/marketplace/*
// @grant        GM_setValue
// @grant        GM_getValue
// @grant        GM_addStyle
// @run-at       document-idle
// @noframes
// ==/UserScript==

(function () {
  'use strict';

  const STORAGE_KEYS = {
    MOT_HISTORY: 'cba_mot_history',
    WATCHLIST: 'cba_watchlist',
    SETTINGS: 'cba_settings',
  };

  const DEFAULT_SETTINGS = {
    priceMin: '',
    priceMax: '',
    widgetCollapsed: false,
  };

  function loadJSON(key, fallback) {
    try {
      const raw = GM_getValue(key, null);
      if (raw === null || raw === undefined) return fallback;
      return JSON.parse(raw);
    } catch (err) {
      console.warn('[UKFacebookCarAssistant] failed to load', key, err);
      return fallback;
    }
  }

  function saveJSON(key, value) {
    try {
      GM_setValue(key, JSON.stringify(value));
    } catch (err) {
      console.error('[UKFacebookCarAssistant] failed to save', key, err);
    }
  }

  const state = {
    motHistory: loadJSON(STORAGE_KEYS.MOT_HISTORY, []),
    watchlist: loadJSON(STORAGE_KEYS.WATCHLIST, []),
    settings: Object.assign({}, DEFAULT_SETTINGS, loadJSON(STORAGE_KEYS.SETTINGS, {})),
  };

  function persistSettings() {
    saveJSON(STORAGE_KEYS.SETTINGS, state.settings);
  }

  const CURRENCY_RE = /[£$]\s?\d[\d,]*(\.\d{1,2})?/;

  function textOf(el) {
    return el ? el.textContent.replace(/\s+/g, ' ').trim() : '';
  }

  function parsePriceNumber(text) {
    const m = text && text.match(CURRENCY_RE);
    if (!m) return null;
    const digits = m[0].replace(/[^\d.]/g, '');
    const n = parseFloat(digits);
    return Number.isNaN(n) ? null : n;
  }

  const FB_CARD_ANCESTOR_LEVELS = 3;

  function fbCardFromAnchor(anchor) {
    let node = anchor;
    for (let i = 0; i < FB_CARD_ANCESTOR_LEVELS && node.parentElement; i++) {
      node = node.parentElement;
    }
    return node;
  }

  const FACEBOOK_ADAPTER = {
    isSearchGrid() {
      return /\/marketplace\/(category|search)?/.test(location.pathname) &&
        !/\/marketplace\/item\//.test(location.pathname);
    },

    isIndividualListing() {
      return /\/marketplace\/item\/\d+/.test(location.pathname);
    },

    getListingCards() {
      const anchors = Array.from(document.querySelectorAll('a[href*="/marketplace/item/"]'));
      const seen = new Set();
      const cards = [];
      for (const a of anchors) {
        const card = fbCardFromAnchor(a);
        if (seen.has(card)) continue;
        seen.add(card);
        cards.push(card);
      }
      return cards;
    },

    _spanTexts(card) {
      return Array.from(card.querySelectorAll('span'))
        .map((s) => textOf(s))
        .filter((t) => t.length > 0);
    },

    getTitle(card) {
      const texts = this._spanTexts(card);
      let best = '';
      for (const t of texts) {
        if (CURRENCY_RE.test(t) && t.length < 20) continue;
        if (t.length > best.length) best = t;
      }
      return best;
    },

    getPriceText(card) {
      const texts = this._spanTexts(card);
      return texts.find((t) => CURRENCY_RE.test(t)) || '';
    },

    getDescription() {
      const main = document.querySelector('div[role="main"]') || document.body;
      const candidates = Array.from(main.querySelectorAll('span'))
        .map((s) => textOf(s))
        .filter((t) => t.length > 40);
      candidates.sort((a, b) => b.length - a.length);
      return candidates[0] || '';
    },

    getCollapseTarget() {
      return document.querySelector('div[role="main"]');
    },
  };

  const adapter = FACEBOOK_ADAPTER;

  GM_addStyle(`
    #cba-widget {
      --void: #07090c;
      --panel: #0e1116;
      --panel-raised: #12161c;
      --line: #1e252b;
      --line-bright: #313a42;
      --signal: #ff4d2e;
      --phosphor: #35d67c;
      --amber: #ffb020;
      --text: #d7dbde;
      --text-dim: #7d8891;
      --text-faint: #4b545c;
      --mono: 'IBM Plex Mono', ui-monospace, SFMono-Regular, Menlo, monospace;
      --sans: 'IBM Plex Sans', -apple-system, BlinkMacSystemFont, sans-serif;

      position: fixed;
      top: 80px;
      right: 16px;
      width: 300px;
      max-height: 85vh;
      overflow-y: auto;
      background: var(--panel);
      color: var(--text);
      border: 1px solid var(--line);
      border-radius: 2px;
      box-shadow: 0 4px 18px rgba(0,0,0,0.5);
      font: 13px/1.5 var(--sans);
      z-index: 999999;
    }
    #cba-widget * { box-sizing: border-box; }
    #cba-widget ::-webkit-scrollbar { width: 8px; }
    #cba-widget ::-webkit-scrollbar-thumb { background: var(--line-bright); border-radius: 2px; }
    #cba-widget ::-webkit-scrollbar-track { background: var(--panel); }

    #cba-header {
      display: flex; align-items: center; justify-content: space-between;
      padding: 10px 12px; cursor: move; background: var(--panel-raised);
      border-bottom: 1px solid var(--line);
      font-family: var(--mono); font-weight: 600; font-size: 12px;
      text-transform: uppercase; letter-spacing: .04em; color: var(--text);
      user-select: none;
    }
    #cba-header span::after { content: "_"; color: var(--signal); animation: cba-blink 1.1s steps(1) infinite; margin-left: 2px; }
    @keyframes cba-blink { 0%, 49% { opacity: 1; } 50%, 100% { opacity: 0; } }
    #cba-header button {
      background: none; border: none; color: var(--text-dim); cursor: pointer;
      font-family: var(--mono); font-size: 14px;
    }
    #cba-header button:hover { color: var(--signal); }

    #cba-body { padding: 12px; }
    #cba-body.cba-hidden { display: none; }

    .cba-section { position: relative; margin-bottom: 16px; border-top: 1px solid var(--line); padding-top: 12px; }
    .cba-section:first-child { border-top: none; padding-top: 0; }
    .cba-section h4 {
      margin: 0 0 8px; font-family: var(--mono); font-size: 11px; font-weight: 600;
      text-transform: uppercase; letter-spacing: .04em; color: var(--signal);
    }
    .cba-section h4::before { content: "// "; color: var(--text-faint); }

    .cba-row { display: flex; gap: 6px; margin-bottom: 6px; align-items: center; }
    .cba-row input[type="text"], .cba-row input[type="number"], .cba-widget-textarea {
      flex: 1; background: var(--panel-raised); border: 1px solid var(--line); color: var(--text);
      border-radius: 2px; padding: 6px 8px; font: 12px var(--mono); width: 100%;
    }
    .cba-row input:focus, .cba-widget-textarea:focus {
      outline: none; border-color: var(--signal);
    }
    .cba-widget-textarea { min-height: 70px; resize: vertical; }

    .cba-btn {
      background: transparent; border: 1px solid var(--signal); color: var(--signal);
      padding: 6px 12px; border-radius: 2px; cursor: pointer;
      font: 11px var(--mono); font-weight: 500; text-transform: uppercase; letter-spacing: .03em;
      white-space: nowrap; transition: background-color .15s ease, color .15s ease;
    }
    .cba-btn:hover { background-color: var(--signal); color: var(--void); }
    .cba-btn:active { transform: scale(.97); }
    .cba-btn.secondary { border-color: var(--line-bright); color: var(--text-dim); }
    .cba-btn.secondary:hover { background-color: var(--panel-raised); color: var(--text); border-color: var(--text-dim); }

    .cba-hint { color: var(--text-faint); font-size: 11px; margin-top: 4px; font-family: var(--mono); }
    .cba-warn { color: var(--amber); font-size: 11px; margin-top: 4px; font-family: var(--mono); }

    #cba-widget details summary { color: var(--text-dim); cursor: pointer; font-family: var(--mono); font-size: 11px; }
    #cba-mot-history { list-style: none; margin: 6px 0 0; padding: 0; max-height: 140px; overflow-y: auto; }
    #cba-mot-history li { padding: 4px 0; border-bottom: 1px solid var(--line); font: 11px var(--mono); }
    #cba-mot-history a { color: var(--signal); text-decoration: none; }
    #cba-mot-history a:hover { color: #ff7a5c; text-decoration: underline; }
    #cba-mot-history .cba-ts { color: var(--text-faint); float: right; }

    .cba-flag-banner {
      position: sticky; top: 0; z-index: 999998; padding: 10px 12px; margin: -12px -12px 12px;
      background: var(--panel-raised); border-bottom: 2px solid var(--amber);
      font: 11px var(--mono); color: var(--text);
    }
    .cba-flag-banner ul { margin: 6px 0 0; padding-left: 16px; color: var(--text-dim); }
    .cba-flag-banner ul li { margin-bottom: 2px; }
    .cba-collapse-toggle { margin-top: 8px; }

    #cba-status-text { font-family: var(--mono); }
  `);

  const widgetRoot = document.createElement('div');
  widgetRoot.id = 'cba-widget';
  widgetRoot.innerHTML = `
    <div id="cba-header">
      <span>UKFacebookCarAssistant</span>
      <button id="cba-collapse-btn" title="Collapse/expand">${state.settings.widgetCollapsed ? '▸' : '▾'}</button>
    </div>
    <div id="cba-body" class="${state.settings.widgetCollapsed ? 'cba-hidden' : ''}">

      <div class="cba-section" id="cba-section-mot">
        <h4>1. MOT Check</h4>
        <div class="cba-row">
          <input type="text" id="cba-mot-input" placeholder="e.g. AB12 CDE" />
          <button class="cba-btn" id="cba-mot-btn">Check</button>
        </div>
        <div class="cba-warn" id="cba-mot-warn" style="display:none;"></div>
        <details>
          <summary style="cursor:pointer;color:#b0b3b8;">History (<span id="cba-mot-count">0</span>)</summary>
          <ul id="cba-mot-history"></ul>
        </details>
      </div>

      <div class="cba-section" id="cba-section-price">
        <h4>2. Price Filter</h4>
        <div class="cba-row">
          <input type="number" min="0" id="cba-price-min" placeholder="Min £" />
          <input type="number" min="0" id="cba-price-max" placeholder="Max £" />
        </div>
        <div class="cba-hint">Both blank = inactive.</div>
      </div>

      <div class="cba-section" id="cba-section-watchlist">
        <h4>3. Watchlist</h4>
        <textarea class="cba-widget-textarea" id="cba-watchlist-input" placeholder="Hyundai i10&#10;Ford Fiesta&#10;VW Golf GTI"></textarea>
        <div class="cba-row" style="margin-top:6px;">
          <button class="cba-btn secondary" id="cba-watchlist-export">Export .txt</button>
          <button class="cba-btn secondary" id="cba-watchlist-import">Import .txt</button>
          <input type="file" id="cba-watchlist-file" accept=".txt" style="display:none;" />
        </div>
        <div class="cba-hint">Empty = inactive. One search per line; a listing must match all words on at least one line.</div>
      </div>

      <div class="cba-section" id="cba-status">
        <h4>Status</h4>
        <div class="cba-hint" id="cba-status-text">-</div>
      </div>

    </div>
  `;
  document.documentElement.appendChild(widgetRoot);

  document.getElementById('cba-collapse-btn').addEventListener('click', () => {
    state.settings.widgetCollapsed = !state.settings.widgetCollapsed;
    persistSettings();
    document.getElementById('cba-body').classList.toggle('cba-hidden', state.settings.widgetCollapsed);
    document.getElementById('cba-collapse-btn').textContent = state.settings.widgetCollapsed ? '▸' : '▾';
  });

  (function enableDrag() {
    const header = document.getElementById('cba-header');
    let dragging = false, offsetX = 0, offsetY = 0;
    header.addEventListener('mousedown', (e) => {
      if (e.target.tagName === 'BUTTON') return;
      dragging = true;
      const rect = widgetRoot.getBoundingClientRect();
      offsetX = e.clientX - rect.left;
      offsetY = e.clientY - rect.top;
      e.preventDefault();
    });
    document.addEventListener('mousemove', (e) => {
      if (!dragging) return;
      widgetRoot.style.left = `${e.clientX - offsetX}px`;
      widgetRoot.style.top = `${e.clientY - offsetY}px`;
      widgetRoot.style.right = 'auto';
    });
    document.addEventListener('mouseup', () => { dragging = false; });
  })();

  function setStatus(text) {
    const el = document.getElementById('cba-status-text');
    if (el) el.textContent = text;
  }

  const PLATE_CURRENT_FORMAT_RE = /^[A-Z]{2}\d{2}[A-Z]{3}$/;

  function formatPlate(raw) {
    let v = raw.toUpperCase().trim();
    v = v.replace(/[^A-Z0-9 ]/g, '');
    v = v.replace(/\s+/g, '+');
    return v;
  }

  function isCurrentFormat(formatted) {
    return PLATE_CURRENT_FORMAT_RE.test(formatted.replace(/\+/g, ''));
  }

  function buildMotUrl(formatted) {
    return `https://www.check-mot.service.gov.uk/results?registration=${formatted}`;
  }

  function addMotHistory(plate) {
    state.motHistory.unshift({ plate, timestamp: Date.now() });
    state.motHistory = state.motHistory.slice(0, 20);
    saveJSON(STORAGE_KEYS.MOT_HISTORY, state.motHistory);
    renderMotHistory();
  }

  function renderMotHistory() {
    const list = document.getElementById('cba-mot-history');
    const count = document.getElementById('cba-mot-count');
    state.motHistory = state.motHistory.filter(
      (entry) => entry && typeof entry.plate === 'string' && /^[A-Z0-9+]{1,12}$/.test(entry.plate)
    );
    count.textContent = state.motHistory.length;
    list.innerHTML = state.motHistory
      .map((entry) => {
        const date = new Date(entry.timestamp).toLocaleDateString();
        const displayPlate = entry.plate.replace(/\+/g, ' ');
        return `<li><a href="${buildMotUrl(entry.plate)}" target="_blank" rel="noopener">${displayPlate}</a><span class="cba-ts">${date}</span></li>`;
      })
      .join('');
  }

  document.getElementById('cba-mot-btn').addEventListener('click', () => {
    const input = document.getElementById('cba-mot-input');
    const warn = document.getElementById('cba-mot-warn');
    const raw = input.value;
    if (!raw.trim()) return;
    const formatted = formatPlate(raw);
    if (!isCurrentFormat(formatted)) {
      warn.style.display = 'block';
      warn.textContent = "Doesn't match the current plate format (e.g. AB12 CDE) - opening anyway, older formats exist too.";
    } else {
      warn.style.display = 'none';
    }
    window.open(buildMotUrl(formatted), '_blank');
    addMotHistory(formatted);
    input.value = '';
  });

  document.getElementById('cba-mot-input').addEventListener('keydown', (e) => {
    if (e.key === 'Enter') document.getElementById('cba-mot-btn').click();
  });

  renderMotHistory();

  const priceMinInput = document.getElementById('cba-price-min');
  const priceMaxInput = document.getElementById('cba-price-max');
  const watchlistInput = document.getElementById('cba-watchlist-input');

  priceMinInput.value = state.settings.priceMin;
  priceMaxInput.value = state.settings.priceMax;
  watchlistInput.value = state.watchlist.join('\n');

  function debounce(fn, wait) {
    let t;
    return (...args) => {
      clearTimeout(t);
      t = setTimeout(() => fn(...args), wait);
    };
  }

  const debouncedApplyFilters = debounce(applyFilters, 150);

  priceMinInput.addEventListener('input', () => {
    state.settings.priceMin = priceMinInput.value;
    persistSettings();
    debouncedApplyFilters();
  });
  priceMaxInput.addEventListener('input', () => {
    state.settings.priceMax = priceMaxInput.value;
    persistSettings();
    debouncedApplyFilters();
  });
  watchlistInput.addEventListener('input', debounce(() => {
    state.watchlist = watchlistInput.value.split('\n').map((l) => l.trim()).filter(Boolean);
    saveJSON(STORAGE_KEYS.WATCHLIST, state.watchlist);
    debouncedApplyFilters();
  }, 300));

  document.getElementById('cba-watchlist-export').addEventListener('click', () => {
    const blob = new Blob([state.watchlist.join('\n')], { type: 'text/plain' });
    const url = URL.createObjectURL(blob);
    const a = document.createElement('a');
    a.href = url;
    a.download = 'car-watchlist.txt';
    document.body.appendChild(a);
    a.click();
    a.remove();
    URL.revokeObjectURL(url);
  });

  document.getElementById('cba-watchlist-import').addEventListener('click', () => {
    document.getElementById('cba-watchlist-file').click();
  });

  document.getElementById('cba-watchlist-file').addEventListener('change', (e) => {
    const file = e.target.files[0];
    if (!file) return;
    const reader = new FileReader();
    reader.onload = () => {
      const lines = String(reader.result).split(/\r?\n/).map((l) => l.trim()).filter(Boolean);
      state.watchlist = lines;
      saveJSON(STORAGE_KEYS.WATCHLIST, state.watchlist);
      watchlistInput.value = lines.join('\n');
      applyFilters();
    };
    reader.readAsText(file);
    e.target.value = '';
  });

  function watchlistMatch(title) {
    if (state.watchlist.length === 0) return true;
    const lowerTitle = title.toLowerCase();
    return state.watchlist.some((line) => {
      const words = line.toLowerCase().split(/\s+/).filter(Boolean);
      if (words.length === 0) return false;
      return words.every((w) => lowerTitle.includes(w));
    });
  }

  function applyFilters() {
    if (!adapter.isSearchGrid()) return;

    const minActive = state.settings.priceMin !== '' && !Number.isNaN(Number(state.settings.priceMin));
    const maxActive = state.settings.priceMax !== '' && !Number.isNaN(Number(state.settings.priceMax));
    const priceMin = minActive ? Number(state.settings.priceMin) : null;
    const priceMax = maxActive ? Number(state.settings.priceMax) : null;

    const watchlistActive = state.watchlist.length > 0;

    const cards = adapter.getListingCards();
    let shown = 0;

    for (const card of cards) {
      let visible = true;

      if (minActive || maxActive) {
        const priceText = adapter.getPriceText(card);
        const price = parsePriceNumber(priceText);
        if (price !== null) {
          if (minActive && price < priceMin) visible = false;
          if (maxActive && price > priceMax) visible = false;
        }
      }

      if (visible && watchlistActive) {
        const title = adapter.getTitle(card);
        if (!watchlistMatch(title)) visible = false;
      }

      card.style.display = visible ? '' : 'none';
      if (visible) shown++;
    }

    setStatus(`${shown}/${cards.length} listings shown`);
  }

  const NO_FIRM_PRICE_RE = /\b(obo|o\.?b\.?o\.?|make offer|poa|or offers|offers invited)\b/i;
  const SCAM_PHRASES_RE = /\b(no test drives?|courier only|selling (for|on behalf of) a friend|no returns|must sell today|cash only.{0,15}collect|can'?t view before buying)\b/i;
  const MILEAGE_RE = /\b\d{1,3}(?:[,.]?\d{3}|k)?\s?(miles|mi\.?|km|kilometres|kilometers)\b/i;
  const MOT_MENTION_RE = /\bmot\b/i;
  const SERVICE_HISTORY_RE = /\bservice history\b/i;

  const TIME_WASTER_THRESHOLD = 2;

  function scoreListing(descriptionText, priceText) {
    const combined = `${priceText || ''} ${descriptionText || ''}`;
    const flags = [];

    if (NO_FIRM_PRICE_RE.test(combined)) flags.push('No firm price (OBO/offers/POA)');
    if (SCAM_PHRASES_RE.test(combined)) flags.push('Scam/red-flag phrasing');
    if (!MILEAGE_RE.test(descriptionText)) flags.push('No mileage mentioned');
    if (!MOT_MENTION_RE.test(descriptionText)) flags.push('No MOT mentioned');
    if (!SERVICE_HISTORY_RE.test(descriptionText)) flags.push('No service history mentioned');

    return flags;
  }

  let collapseState = { collapsed: false, originalStyles: null };

  function clearBanner() {
    const existing = document.getElementById('cba-flag-banner');
    if (existing) existing.remove();
  }

  function insertBanner(html) {
    clearBanner();
    const banner = document.createElement('div');
    banner.id = 'cba-flag-banner';
    banner.className = 'cba-flag-banner';
    banner.innerHTML = html;
    const body = document.getElementById('cba-body');
    body.insertBefore(banner, body.firstChild);
  }

  function collapseTarget(target) {
    if (!target || collapseState.collapsed) return;
    collapseState.originalStyles = {
      maxHeight: target.style.maxHeight,
      overflow: target.style.overflow,
    };
    target.style.maxHeight = '140px';
    target.style.overflow = 'hidden';
    collapseState.collapsed = true;
  }

  function expandTarget(target) {
    if (!target || !collapseState.collapsed) return;
    target.style.maxHeight = collapseState.originalStyles.maxHeight;
    target.style.overflow = collapseState.originalStyles.overflow;
    collapseState.collapsed = false;
  }

  const DESCRIPTION_RETRIES = 6;
  const DESCRIPTION_RETRY_MS = 500;

  function runIndividualListingChecks(attempt = 0) {
    if (!adapter.isIndividualListing()) {
      clearBanner();
      return;
    }

    const description = adapter.getDescription();
    if (!description) {
      if (attempt < DESCRIPTION_RETRIES) {
        setTimeout(() => runIndividualListingChecks(attempt + 1), DESCRIPTION_RETRY_MS);
        return;
      }
      setStatus('Could not read listing description (selectors may need updating).');
      return;
    }

    const target = adapter.getCollapseTarget();
    const flags = scoreListing(description, '');

    if (flags.length >= TIME_WASTER_THRESHOLD) {
      insertBanner(
        `⚠ ${flags.length} flags
         <ul>${flags.map((f) => `<li>${f}</li>`).join('')}</ul>
         <div class="cba-collapse-toggle"><button class="cba-btn secondary" id="cba-expand-btn">Expand listing</button></div>`
      );
      collapseTarget(target);
      document.getElementById('cba-expand-btn').addEventListener('click', () => {
        expandTarget(target);
        clearBanner();
      });
    } else {
      clearBanner();
      expandTarget(target);
    }
  }

  const debouncedApplyFiltersFromDom = debounce(() => {
    if (adapter.isSearchGrid()) applyFilters();
  }, 250);

  const observer = new MutationObserver(debouncedApplyFiltersFromDom);
  observer.observe(document.body, { childList: true, subtree: true });

  let lastPath = location.href;
  setInterval(() => {
    if (location.href !== lastPath) {
      lastPath = location.href;
      collapseState = { collapsed: false, originalStyles: null };
      clearBanner();
      setTimeout(() => {
        if (adapter.isSearchGrid()) applyFilters();
        if (adapter.isIndividualListing()) runIndividualListingChecks();
      }, 400);
    }
  }, 600);

  if (adapter.isSearchGrid()) applyFilters();
  if (adapter.isIndividualListing()) runIndividualListingChecks();
})();
