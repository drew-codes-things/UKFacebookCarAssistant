// ==UserScript==
// @name         UKFacebookCarAssistant
// @namespace    https://github.com/drew-codes-things/UKFacebookCarAssistant
// @version      1.1.1
// @description  DVSA MOT history, price/watchlist filtering, and time-waster flagging for Facebook Marketplace
// @author       drew-codes-things
// @match        https://www.facebook.com/marketplace/*
// @grant        GM_setValue
// @grant        GM_getValue
// @grant        GM_deleteValue
// @grant        GM_addStyle
// @grant        GM_xmlhttpRequest
// @connect      login.microsoftonline.com
// @connect      history.mot.api.gov.uk
// @run-at       document-idle
// @noframes
// ==/UserScript==

const CarAssistantMot = (() => {
  'use strict';

  const API_URL = 'https://history.mot.api.gov.uk/v1/trade/vehicles/registration/';
  const TOKEN_SCOPE = 'https://tapi.dvsa.gov.uk/.default';
  const TOKEN_URL_RE = /^https:\/\/login\.microsoftonline\.com\/[A-Za-z0-9.-]+\/oauth2\/v2\.0\/token$/;
  const KM_PER_MILE = 1.609344;
  const DAY_MS = 24 * 60 * 60 * 1000;
  const DAYS_PER_YEAR = 365.25;
  const MOT_GAP_DAYS = 425;
  const MIN_YEARS_FOR_RATE = 0.5;

  const PLATE_PATTERNS = [
    /\b([A-Z]{2}\d{2})\s?([A-Z]{3})\b/gi,
    /\b([A-HJ-PR-Y]\d{1,3})\s?([A-Z]{3})\b/gi,
    /\b([A-Z]{3}\d{1,3}[A-HJ-PR-Y])\b/gi,
  ];
  const DRIVEN_RE = /driven\s+(\d[\d,.]*)\s*(k)?\s*(miles|mi|km|kilomet(?:re|er)s)\b/i;
  const MILEAGE_RE = /\b(\d[\d,.]*)\s*(k)?\s*(miles|mi|km|kilomet(?:re|er)s)\b/i;

  const ERROR_MESSAGES = {
    'MOTH-NF-01': 'No MOT or vehicle record found for that registration.',
    'MOTH-IV-03': 'The DVSA says that registration is not valid.',
    'MOTH-UA-01': 'The DVSA rejected your credentials. Check them in Settings.',
    'MOTH-FB-02': 'The access token expired.',
    'MOTH-FB-03': 'The DVSA did not recognise your API key. Check it in Settings.',
    'MOTH-RL-01': 'Daily DVSA allowance used up. It resets 24 hours after it ran out.',
    'MOTH-RL-02': 'Too many lookups in a short time. Wait a few minutes and try again.',
  };

  function normalisePlate(raw) {
    const plate = String(raw || '').toUpperCase().replace(/[^A-Z0-9]/g, '');
    return /^[A-Z0-9]{2,8}$/.test(plate) ? plate : '';
  }

  function findPlates(text) {
    const found = [];
    for (const pattern of PLATE_PATTERNS) {
      for (const match of String(text || '').matchAll(pattern)) {
        const plate = normalisePlate(match[0]);
        if (plate && /\d/.test(plate) && !found.includes(plate)) found.push(plate);
      }
    }
    return found;
  }

  function parseMileageMatch(match) {
    if (!match) return null;
    const thousands = Boolean(match[2]);
    const digits = thousands ? match[1].replace(/,/g, '') : match[1].replace(/[,.]/g, '');
    const value = Math.round(parseFloat(digits) * (thousands ? 1000 : 1));
    if (!Number.isFinite(value) || value <= 0) return null;
    return { value, unit: /^k/i.test(match[3]) ? 'KM' : 'MI' };
  }

  function parseListingMileage(text) {
    const source = String(text || '');
    return parseMileageMatch(source.match(DRIVEN_RE)) || parseMileageMatch(source.match(MILEAGE_RE));
  }

  function toMiles(value, unit) {
    return unit === 'KM' ? Math.round(value / KM_PER_MILE) : value;
  }

  function isValidTokenUrl(url) {
    return TOKEN_URL_RE.test(String(url || '').trim());
  }

  function missingCredentials(credentials) {
    const needed = { tokenUrl: 'token URL', clientId: 'client ID', clientSecret: 'client secret', apiKey: 'API key' };
    return Object.keys(needed).filter((key) => !String((credentials || {})[key] || '').trim()).map((key) => needed[key]);
  }

  function tokenRequestBody(credentials) {
    return new URLSearchParams({
      grant_type: 'client_credentials',
      client_id: credentials.clientId.trim(),
      client_secret: credentials.clientSecret.trim(),
      scope: TOKEN_SCOPE,
    }).toString();
  }

  function vehicleUrl(plate) {
    const normalised = normalisePlate(plate);
    if (!normalised) throw new Error(`"${plate}" is not a valid registration`);
    return API_URL + encodeURIComponent(normalised);
  }

  function errorMessage(status, body) {
    let parsed = {};
    try {
      parsed = typeof body === 'string' ? JSON.parse(body) : body || {};
    } catch {
      parsed = {};
    }
    const code = parsed.errorCode || '';
    if (ERROR_MESSAGES[code]) return ERROR_MESSAGES[code];
    if (status === 404) return ERROR_MESSAGES['MOTH-NF-01'];
    if (status === 429) return ERROR_MESSAGES['MOTH-RL-02'];
    if (status === 401 || status === 403) return ERROR_MESSAGES['MOTH-UA-01'];
    const detail = parsed.errorMessage || parsed.error_description || '';
    return `DVSA lookup failed (HTTP ${status}${code ? `, ${code}` : ''})${detail ? `: ${detail}` : ''}`;
  }

  function planMotCheck(raw, credentials) {
    const plate = normalisePlate(raw);
    if (missingCredentials(credentials).length) return { action: 'govuk', plate };
    return plate ? { action: 'dvsa', plate } : { action: 'invalid', plate: '' };
  }

  function dayNumber(value) {
    const date = new Date(value);
    return Math.floor(Date.UTC(date.getUTCFullYear(), date.getUTCMonth(), date.getUTCDate()) / DAY_MS);
  }

  function byDate(tests) {
    return [...tests].sort((a, b) => new Date(a.completedDate) - new Date(b.completedDate));
  }

  function mileageReadings(tests) {
    return byDate(tests)
      .filter((test) => test.odometerResultType === 'READ' && test.odometerValue)
      .map((test) => ({
        date: test.completedDate,
        miles: toMiles(parseInt(test.odometerValue, 10), test.odometerUnit),
      }))
      .filter((reading) => Number.isFinite(reading.miles));
  }

  function mileageRollbacks(readings) {
    return readings.slice(1)
      .map((reading, index) => ({ date: reading.date, before: readings[index].miles, after: reading.miles }))
      .filter((step) => step.after < step.before);
  }

  function readingsSinceLastRollback(readings, rollbacks) {
    if (!rollbacks.length) return readings;
    const lastDrop = rollbacks[rollbacks.length - 1].date;
    return readings.slice(readings.findIndex((reading) => reading.date === lastDrop));
  }

  function milesPerYear(readings) {
    if (readings.length < 2) return null;
    const first = readings[0];
    const last = readings[readings.length - 1];
    const years = (dayNumber(last.date) - dayNumber(first.date)) / DAYS_PER_YEAR;
    if (years < MIN_YEARS_FOR_RATE) return null;
    return Math.round((last.miles - first.miles) / years);
  }

  function motGaps(tests) {
    const sorted = byDate(tests);
    return sorted.slice(1)
      .map((test, index) => ({
        from: sorted[index].completedDate,
        to: test.completedDate,
        days: dayNumber(test.completedDate) - dayNumber(sorted[index].completedDate),
      }))
      .filter((gap) => gap.days > MOT_GAP_DAYS);
  }

  function motStatus(vehicle, today) {
    const expiries = (vehicle.motTests || []).map((test) => test.expiryDate).filter(Boolean).sort();
    const expiry = expiries[expiries.length - 1] || vehicle.motTestDueDate || null;
    if (!expiry) return { state: 'unknown', expiry: null, daysLeft: null };
    const daysLeft = dayNumber(expiry) - dayNumber(today);
    const firstDue = !expiries.length;
    if (firstDue) return { state: daysLeft >= 0 ? 'first-due' : 'expired', expiry, daysLeft };
    return { state: daysLeft >= 0 ? 'valid' : 'expired', expiry, daysLeft };
  }

  function defectCounts(test) {
    const counts = {};
    for (const defect of (test && test.defects) || []) {
      const type = defect.dangerous ? 'DANGEROUS' : defect.type || 'OTHER';
      counts[type] = (counts[type] || 0) + 1;
    }
    return counts;
  }

  function formatDate(value) {
    if (!value) return '?';
    const date = new Date(value);
    return date.toLocaleDateString('en-GB', { day: 'numeric', month: 'short', year: 'numeric', timeZone: 'UTC' });
  }

  function formatMiles(miles) {
    return `${miles.toLocaleString('en-GB')} miles`;
  }

  function warningsFor(vehicle, summary, listingMileage) {
    const warnings = [];
    if (summary.status.state === 'expired') warnings.push(`MOT expired on ${formatDate(summary.status.expiry)}.`);
    if (vehicle.hasOutstandingRecall === 'Yes') warnings.push('Has an outstanding safety recall that has not been fixed.');
    for (const step of summary.rollbacks) {
      warnings.push(`Mileage went down: ${formatMiles(step.before)} then ${formatMiles(step.after)} on ${formatDate(step.date)}.`);
    }
    const lastReading = summary.readings[summary.readings.length - 1];
    if (listingMileage && lastReading) {
      const listedMiles = toMiles(listingMileage.value, listingMileage.unit);
      if (listedMiles < lastReading.miles) {
        warnings.push(`Listing says ${formatMiles(listedMiles)}, but the MOT on ${formatDate(lastReading.date)} read ${formatMiles(lastReading.miles)}.`);
      }
    }
    if (summary.latestDefects.DANGEROUS) warnings.push('The latest MOT recorded dangerous defects.');
    for (const gap of summary.gaps) {
      warnings.push(`No MOT between ${formatDate(gap.from)} and ${formatDate(gap.to)} (possibly off the road or untested).`);
    }
    return warnings;
  }

  function summarise(vehicle, today = new Date(), listingMileage = null) {
    const tests = vehicle.motTests || [];
    const newestFirst = byDate(tests).reverse();
    const readings = mileageReadings(tests);
    const summary = {
      title: [vehicle.make, vehicle.model].filter(Boolean).join(' ') || vehicle.registration || 'Unknown vehicle',
      details: [vehicle.primaryColour, vehicle.fuelType, vehicle.engineSize ? `${vehicle.engineSize} cc` : '']
        .filter(Boolean).join(' · '),
      firstUsed: vehicle.firstUsedDate || vehicle.registrationDate || null,
      recall: vehicle.hasOutstandingRecall || 'Unknown',
      status: motStatus(vehicle, today),
      tests: newestFirst,
      failures: tests.filter((test) => test.testResult === 'FAILED').length,
      readings,
      rollbacks: mileageRollbacks(readings),
      gaps: motGaps(tests),
      latestDefects: defectCounts(newestFirst[0]),
    };
    summary.perYear = milesPerYear(readingsSinceLastRollback(readings, summary.rollbacks));
    summary.warnings = warningsFor(vehicle, summary, listingMileage);
    return summary;
  }

  return {
    normalisePlate, findPlates, parseListingMileage, toMiles, isValidTokenUrl, missingCredentials,
    tokenRequestBody, vehicleUrl, errorMessage, summarise, defectCounts, formatDate, formatMiles, planMotCheck,
  };
})();

if (typeof module === 'object' && module.exports) {
  module.exports = CarAssistantMot;
} else {
  startCarAssistant(CarAssistantMot);
}

function startCarAssistant(mot) {
  'use strict';

  const STORAGE_KEYS = {
    MOT_HISTORY: 'cba_mot_history',
    WATCHLIST: 'cba_watchlist',
    SETTINGS: 'cba_settings',
    DVSA_CREDENTIALS: 'cba_dvsa_credentials',
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
      --void: #0a0a0b;
      --panel: rgba(255, 255, 255, .045);
      --panel-raised: rgba(255, 255, 255, .07);
      --line: rgba(255, 255, 255, .08);
      --line-bright: rgba(255, 255, 255, .14);
      --signal: #e5383b;
      --signal-deep: #7a0f14;
      --signal-soft: #f5c2c3;
      --phosphor: #4ade80;
      --amber: #fbbf24;
      --text: #ececec;
      --text-dim: #a1a1a6;
      --text-faint: #6b6b72;
      --mono: 'IBM Plex Mono', ui-monospace, SFMono-Regular, Menlo, monospace;
      --sans: 'IBM Plex Sans', -apple-system, BlinkMacSystemFont, sans-serif;

      position: fixed;
      top: 80px;
      right: 16px;
      width: 300px;
      max-height: 85vh;
      overflow-y: auto;
      background: radial-gradient(120% 70% at 0% 0%, rgba(160, 20, 28, .38), transparent 60%), linear-gradient(165deg, #1c0608 0%, #0d0b0c 42%, #070708 100%);
      color: var(--text);
      border: 1px solid var(--line-bright);
      border-radius: 16px;
      box-shadow: 0 16px 40px rgba(0, 0, 0, .45);
      font: 13px/1.5 var(--sans);
      z-index: 999999;
    }
    #cba-widget * { box-sizing: border-box; }
    #cba-widget ::-webkit-scrollbar { width: 8px; }
    #cba-widget ::-webkit-scrollbar-thumb { background: var(--line-bright); border-radius: 999px; }
    #cba-widget ::-webkit-scrollbar-track { background: transparent; }

    #cba-header {
      display: flex; align-items: center; justify-content: space-between;
      padding: 12px 14px; cursor: move; background: rgba(10, 10, 11, .55);
      border-bottom: 1px solid var(--line);
      font-family: var(--sans); font-weight: 600; font-size: 13px; color: var(--text);
      user-select: none;
    }
    #cba-header button {
      background: none; border: none; color: var(--text-dim); cursor: pointer;
      font-family: var(--sans); font-size: 14px;
    }
    #cba-header button:hover { color: var(--signal); }

    #cba-body { padding: 12px; }
    #cba-body.cba-hidden { display: none; }

    .cba-section {
      position: relative; margin-bottom: 12px; padding: 12px;
      background: var(--panel); border: 1px solid var(--line); border-radius: 12px;
    }
    .cba-section:last-child { margin-bottom: 0; }
    .cba-section h4 {
      margin: 0 0 8px; font-family: var(--sans); font-size: 12px; font-weight: 600; color: var(--signal-soft);
    }

    .cba-row { display: flex; gap: 6px; margin-bottom: 6px; align-items: center; }
    .cba-row input[type="text"], .cba-row input[type="number"], .cba-widget-textarea {
      flex: 1; background: var(--panel-raised); border: 1px solid var(--line); color: var(--text);
      border-radius: 10px; padding: 7px 10px; font: 12px var(--sans); width: 100%;
    }
    .cba-row input:focus, .cba-widget-textarea:focus {
      outline: none; border-color: rgba(229, 56, 59, .55);
    }
    .cba-widget-textarea { min-height: 70px; resize: vertical; }

    .cba-btn {
      background: linear-gradient(135deg, var(--signal), var(--signal-deep)); border: 1px solid transparent; color: #fff;
      padding: 7px 12px; border-radius: 10px; cursor: pointer;
      font: 500 12px var(--sans);
      white-space: nowrap; transition: filter .15s ease;
    }
    .cba-btn:hover { filter: brightness(1.12); }
    .cba-btn:active { transform: scale(.97); }
    .cba-btn.secondary { background: var(--panel-raised); border-color: var(--line-bright); color: var(--text-dim); }
    .cba-btn.secondary:hover { filter: none; background: rgba(255, 255, 255, .11); color: var(--text); }

    .cba-hint { color: var(--text-faint); font-size: 11px; margin-top: 4px; }
    .cba-warn { color: var(--amber); font-size: 11px; margin-top: 4px; }

    #cba-widget details summary { color: var(--text-dim); cursor: pointer; font-size: 12px; }
    #cba-mot-history { list-style: none; margin: 6px 0 0; padding: 0; max-height: 140px; overflow-y: auto; }
    #cba-mot-history li { padding: 4px 0; border-bottom: 1px solid var(--line); font: 11px var(--mono); }
    #cba-mot-history a { color: var(--signal-soft); text-decoration: none; }
    #cba-mot-history a:hover { color: #fff; text-decoration: underline; }
    #cba-mot-history .cba-ts { color: var(--text-faint); float: right; }

    .cba-chip { margin: 0 4px 4px 0; padding: 2px 10px; border-radius: 999px; }
    .cba-mot-title { font-weight: 600; font-size: 13px; margin: 8px 0 0; }
    .cba-sub { color: var(--text-dim); font: 11px var(--mono); }
    .cba-mot-status { font: 600 12px var(--sans); margin: 6px 0; }
    .cba-good { color: var(--phosphor); }
    .cba-bad { color: var(--signal); }
    .cba-mot-warnings {
      margin: 6px 0; padding: 6px 8px 6px 24px; font-size: 11px; color: var(--signal-soft);
      background: rgba(229, 56, 59, .14); border: 1px solid rgba(229, 56, 59, .4); border-radius: 10px;
    }
    .cba-mot-tests { list-style: none; margin: 6px 0 0; padding: 0; max-height: 260px; overflow-y: auto; }
    .cba-mot-tests > li { border-top: 1px solid var(--line); padding: 5px 0; font-size: 11px; }
    .cba-mot-tests ul { margin: 3px 0 0; padding-left: 14px; color: var(--text-dim); }
    .cba-defect-DANGEROUS, .cba-defect-MAJOR, .cba-defect-FAIL { color: var(--signal); }
    .cba-defect-MINOR { color: var(--amber); }
    #cba-dvsa-settings { margin-top: 8px; }
    #cba-dvsa-settings .cba-row input { flex: 1; width: 100%; background: var(--panel-raised); border: 1px solid var(--line); color: var(--text); border-radius: 10px; padding: 7px 10px; font: 12px var(--sans); }

    .cba-flag-banner {
      position: sticky; top: 0; z-index: 999998; padding: 10px 12px; margin: -12px -12px 12px;
      background: rgba(28, 6, 8, .92); backdrop-filter: blur(12px); border-bottom: 2px solid var(--amber);
      font: 12px var(--sans); color: var(--text);
    }
    .cba-flag-banner ul { margin: 6px 0 0; padding-left: 16px; color: var(--text-dim); }
    .cba-flag-banner ul li { margin-bottom: 2px; }
    .cba-collapse-toggle { margin-top: 8px; }

    #cba-status-text { font-family: var(--sans); }

    @media (prefers-reduced-motion: reduce) {
      #cba-widget *, #cba-widget *::before, #cba-widget *::after { transition-duration: .001ms !important; }
    }
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
        <div id="cba-mot-detected"></div>
        <div id="cba-mot-result"></div>
        <details>
          <summary style="cursor:pointer;color:#b0b3b8;">History (<span id="cba-mot-count">0</span>)</summary>
          <ul id="cba-mot-history"></ul>
        </details>
        <details id="cba-dvsa-settings"></details>
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

  const REQUEST_TIMEOUT_MS = 20000;
  const TOKEN_EXPIRY_MARGIN_MS = 60 * 1000;
  const PLATE_SCAN_RETRIES = 8;
  const PLATE_SCAN_RETRY_MS = 500;
  const SECRET_FIELDS = ['clientSecret', 'apiKey'];
  const NO_TOKEN = { value: '', expiresAt: 0 };

  const motCache = new Map();
  let dvsaToken = NO_TOKEN;
  let listingMileage = null;

  const motResult = document.getElementById('cba-mot-result');
  const motDetected = document.getElementById('cba-mot-detected');

  function element(tag, attributes = {}, children = []) {
    const node = document.createElement(tag);
    for (const [name, value] of Object.entries(attributes)) {
      if (name === 'text') node.textContent = value;
      else if (name === 'onclick') node.addEventListener('click', value);
      else node.setAttribute(name, value);
    }
    for (const child of [].concat(children)) {
      if (child) node.append(child);
    }
    return node;
  }

  function loadDvsaCredentials() {
    const saved = loadJSON(STORAGE_KEYS.DVSA_CREDENTIALS, {});
    return saved && typeof saved === 'object' ? saved : {};
  }

  function request(options) {
    return new Promise((resolve, reject) => {
      GM_xmlhttpRequest({
        timeout: REQUEST_TIMEOUT_MS,
        ...options,
        onload: (response) => resolve(response),
        onerror: () => reject(new Error(`could not reach ${new URL(options.url).host}`)),
        ontimeout: () => reject(new Error(`${new URL(options.url).host} did not answer in time`)),
      });
    });
  }

  function parseJsonOrEmpty(text) {
    try {
      return JSON.parse(text);
    } catch {
      return {};
    }
  }

  async function dvsaAccessToken(credentials) {
    if (dvsaToken.value && Date.now() < dvsaToken.expiresAt) return dvsaToken.value;
    if (!mot.isValidTokenUrl(credentials.tokenUrl)) {
      throw new Error('The token URL must be the login.microsoftonline.com/.../oauth2/v2.0/token address from your DVSA email.');
    }
    const response = await request({
      method: 'POST',
      url: credentials.tokenUrl.trim(),
      headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
      data: mot.tokenRequestBody(credentials),
    });
    const body = parseJsonOrEmpty(response.responseText);
    if (response.status !== 200 || !body.access_token) {
      throw new Error(`Sign-in to the DVSA API failed (HTTP ${response.status}${body.error ? `, ${body.error}` : ''}). Check your client ID and secret.`);
    }
    dvsaToken = { value: body.access_token, expiresAt: Date.now() + body.expires_in * 1000 - TOKEN_EXPIRY_MARGIN_MS };
    return dvsaToken.value;
  }

  async function fetchVehicle(plate, retried = false) {
    const credentials = loadDvsaCredentials();
    const response = await request({
      method: 'GET',
      url: mot.vehicleUrl(plate),
      headers: {
        Accept: 'application/json',
        Authorization: `Bearer ${await dvsaAccessToken(credentials)}`,
        'X-API-Key': credentials.apiKey.trim(),
      },
    });
    if (response.status === 200) return JSON.parse(response.responseText);
    if ((response.status === 401 || response.status === 403) && !retried) {
      dvsaToken = NO_TOKEN;
      return fetchVehicle(plate, true);
    }
    throw new Error(mot.errorMessage(response.status, response.responseText));
  }

  function renderMotTests(tests) {
    return element('ul', { class: 'cba-mot-tests' }, tests.map((test) => {
      const reading = test.odometerResultType === 'READ' && test.odometerValue
        ? `${Number(test.odometerValue).toLocaleString('en-GB')} ${test.odometerUnit === 'KM' ? 'km' : 'miles'}`
        : 'mileage not read';
      const passed = test.testResult === 'PASSED';
      const defects = (test.defects || []).map((defect) => {
        const type = defect.dangerous ? 'DANGEROUS' : defect.type || 'OTHER';
        return element('li', { class: `cba-defect-${type.replace(/\s+/g, '-')}`, text: `${type}: ${defect.text || '(no description)'}` });
      });
      return element('li', {}, [
        element('span', { class: passed ? 'cba-good' : 'cba-bad', text: passed ? 'PASS' : 'FAIL' }),
        element('span', { text: ` ${mot.formatDate(test.completedDate)} · ${reading}` }),
        defects.length ? element('ul', {}, defects) : null,
      ]);
    }));
  }

  function renderVehicle(vehicle) {
    const summary = mot.summarise(vehicle, new Date(), listingMileage);
    const { status } = summary;
    const statusText = {
      valid: `MOT valid until ${mot.formatDate(status.expiry)} (${status.daysLeft} days left)`,
      'first-due': `First MOT due ${mot.formatDate(status.expiry)}`,
      expired: `MOT EXPIRED ${mot.formatDate(status.expiry)}`,
      unknown: 'No MOT expiry on record',
    }[status.state];
    const facts = [
      summary.firstUsed ? `First used ${mot.formatDate(summary.firstUsed)}` : '',
      `${summary.tests.length} tests, ${summary.failures} failed`,
      summary.perYear !== null ? `about ${mot.formatMiles(summary.perYear)} a year` : '',
      `Recall outstanding: ${summary.recall}`,
    ].filter(Boolean);
    motResult.replaceChildren(
      element('div', { class: 'cba-mot-title', text: `${summary.title} (${mot.normalisePlate(vehicle.registration)})` }),
      element('div', { class: 'cba-sub', text: summary.details }),
      element('div', { class: `cba-mot-status ${status.state === 'expired' ? 'cba-bad' : 'cba-good'}`, text: statusText }),
      element('div', { class: 'cba-sub', text: facts.join(' · ') }),
      summary.warnings.length
        ? element('ul', { class: 'cba-mot-warnings' }, summary.warnings.map((warning) => element('li', { text: warning })))
        : element('div', { class: 'cba-hint cba-good', text: 'No red flags in the MOT history.' }),
      renderMotTests(summary.tests),
    );
  }

  async function lookUpMot(plate) {
    motResult.replaceChildren(element('div', { class: 'cba-hint', text: `Looking up ${plate}…` }));
    try {
      if (!motCache.has(plate)) motCache.set(plate, await fetchVehicle(plate));
      renderVehicle(motCache.get(plate));
    } catch (error) {
      console.error('[UKFacebookCarAssistant] MOT lookup failed', error);
      motResult.replaceChildren(element('div', { class: 'cba-warn', text: error.message }));
    }
  }

  function showPlateFormatWarning(formatted, verb) {
    const warn = document.getElementById('cba-mot-warn');
    const unusual = !isCurrentFormat(formatted);
    warn.style.display = unusual ? 'block' : 'none';
    warn.textContent = unusual
      ? `Doesn't match the current plate format (e.g. AB12 CDE) - ${verb} anyway, older formats exist too.`
      : '';
  }

  function checkMot(raw) {
    if (!String(raw || '').trim()) return;
    const input = document.getElementById('cba-mot-input');
    const formatted = formatPlate(raw);
    const plan = mot.planMotCheck(raw, loadDvsaCredentials());
    if (plan.action === 'invalid') {
      motResult.replaceChildren(element('div', { class: 'cba-warn', text: 'Enter a UK registration, e.g. AB12 CDE.' }));
      return;
    }
    input.value = '';
    addMotHistory(formatted);
    if (plan.action === 'govuk') {
      showPlateFormatWarning(formatted, 'opening');
      window.open(buildMotUrl(formatted), '_blank');
      motResult.replaceChildren(element('div', { class: 'cba-hint', text: 'Opened gov.uk. Add DVSA API access below to see the full history here.' }));
      return;
    }
    showPlateFormatWarning(formatted, 'checking');
    lookUpMot(plan.plate);
  }

  document.getElementById('cba-mot-btn').addEventListener('click', () => {
    checkMot(document.getElementById('cba-mot-input').value);
  });

  document.getElementById('cba-mot-input').addEventListener('keydown', (e) => {
    if (e.key === 'Enter') document.getElementById('cba-mot-btn').click();
  });

  function fillDvsaSettings() {
    const saved = loadDvsaCredentials();
    const fields = {
      tokenUrl: element('input', { type: 'url', placeholder: 'Token URL from your DVSA email', autocomplete: 'off' }),
      clientId: element('input', { type: 'text', placeholder: 'Client ID', autocomplete: 'off' }),
      clientSecret: element('input', { type: 'password', placeholder: saved.clientSecret ? 'Client secret (saved)' : 'Client secret', autocomplete: 'new-password' }),
      apiKey: element('input', { type: 'password', placeholder: saved.apiKey ? 'API key (saved)' : 'API key', autocomplete: 'new-password' }),
    };
    fields.tokenUrl.value = saved.tokenUrl || '';
    fields.clientId.value = saved.clientId || '';
    const message = element('div', { class: 'cba-hint' });

    function save() {
      const next = { ...loadDvsaCredentials() };
      for (const [name, input] of Object.entries(fields)) {
        const value = input.value.trim();
        if (value || !SECRET_FIELDS.includes(name)) next[name] = value;
      }
      if (next.tokenUrl && !mot.isValidTokenUrl(next.tokenUrl)) {
        message.textContent = 'That token URL is not a login.microsoftonline.com/.../oauth2/v2.0/token address.';
        return;
      }
      saveJSON(STORAGE_KEYS.DVSA_CREDENTIALS, next);
      dvsaToken = NO_TOKEN;
      SECRET_FIELDS.forEach((name) => {
        fields[name].value = '';
        if (next[name]) fields[name].placeholder = `${fields[name].placeholder.replace(/ \(saved\)$/, '')} (saved)`;
      });
      const missing = mot.missingCredentials(next);
      message.textContent = missing.length ? `Saved. Still needed: ${missing.join(', ')}.` : 'Saved in this browser only.';
    }

    function forget() {
      GM_deleteValue(STORAGE_KEYS.DVSA_CREDENTIALS);
      dvsaToken = NO_TOKEN;
      Object.values(fields).forEach((input) => { input.value = ''; });
      fields.clientSecret.placeholder = 'Client secret';
      fields.apiKey.placeholder = 'API key';
      message.textContent = 'DVSA access removed from this browser.';
    }

    document.getElementById('cba-dvsa-settings').replaceChildren(
      element('summary', { text: 'DVSA API access' }),
      element('p', { class: 'cba-hint', text: 'Register at documentation.history.mot.api.gov.uk. Values stay in Tampermonkey storage on this browser and are only sent to Microsoft sign-in and the DVSA API.' }),
      ...Object.values(fields).map((input) => element('div', { class: 'cba-row' }, input)),
      element('div', { class: 'cba-row' }, [
        element('button', { class: 'cba-btn', text: 'Save', onclick: save }),
        element('button', { class: 'cba-btn secondary', text: 'Forget', onclick: forget }),
      ]),
      message,
    );
  }

  function listingText() {
    const main = document.querySelector('div[role="main"]');
    return main ? main.innerText : '';
  }

  function scanListingForPlates(attempt = 0) {
    motDetected.replaceChildren();
    listingMileage = null;
    if (!adapter.isIndividualListing()) return;
    const text = listingText();
    const plates = mot.findPlates(text);
    if (!plates.length && attempt < PLATE_SCAN_RETRIES) {
      setTimeout(() => scanListingForPlates(attempt + 1), PLATE_SCAN_RETRY_MS);
      return;
    }
    listingMileage = mot.parseListingMileage(text);
    if (!plates.length) return;
    motDetected.append(
      element('div', { class: 'cba-hint', text: 'Spotted in the listing (tap to check):' }),
      ...plates.map((plate) => element('button', { class: 'cba-btn secondary cba-chip', text: plate, onclick: () => checkMot(plate) })),
    );
  }

  fillDvsaSettings();
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
      motResult.replaceChildren();
      scanListingForPlates();
      setTimeout(() => {
        if (adapter.isSearchGrid()) applyFilters();
        if (adapter.isIndividualListing()) runIndividualListingChecks();
      }, 400);
    }
  }, 600);

  if (adapter.isSearchGrid()) applyFilters();
  if (adapter.isIndividualListing()) runIndividualListingChecks();
  scanListingForPlates();
}
