const fs = require('node:fs');
const { JSDOM, VirtualConsole } = require('jsdom');

const MARKETPLACE_ORIGIN = 'https://www.facebook.com';
const MIN_INTERVAL_MS = 1;
const TEXT_NODE = 3;
const BLOCK_TAGS = new Set([
  'ARTICLE', 'ASIDE', 'DIV', 'FOOTER', 'H1', 'H2', 'H3', 'H4', 'H5', 'H6', 'HEADER', 'LI', 'MAIN', 'NAV', 'OL', 'P',
  'SECTION', 'TABLE', 'TR', 'UL',
]);

function approximateInnerText(node) {
  if (node.nodeType === TEXT_NODE) return node.data;
  if (node.tagName === 'BR') return '\n';
  const text = [...node.childNodes].map(approximateInnerText).join('');
  return BLOCK_TAGS.has(node.tagName) ? `\n${text}\n` : text;
}

function flushPromises() {
  return new Promise((resolve) => setImmediate(resolve));
}

function createFakeClock() {
  const timers = new Map();
  let now = 0;
  let nextId = 1;

  function schedule(callback, delay, repeatEvery) {
    const id = nextId++;
    timers.set(id, { callback, dueAt: now + Math.max(0, Number(delay) || 0), repeatEvery });
    return id;
  }

  function nextDueTimer(limit) {
    let earliest = null;
    for (const [id, timer] of timers) {
      if (timer.dueAt <= limit && (!earliest || timer.dueAt < earliest.timer.dueAt)) earliest = { id, timer };
    }
    return earliest;
  }

  async function advance(ms) {
    const end = now + ms;
    for (let due = nextDueTimer(end); due; due = nextDueTimer(end)) {
      now = due.timer.dueAt;
      if (due.timer.repeatEvery) due.timer.dueAt += due.timer.repeatEvery;
      else timers.delete(due.id);
      due.timer.callback();
      await flushPromises();
    }
    now = end;
  }

  return {
    setTimeout: (callback, delay) => schedule(callback, delay, null),
    setInterval: (callback, delay) => schedule(callback, delay, Math.max(MIN_INTERVAL_MS, Number(delay) || 0)),
    clearTimer: (id) => timers.delete(id),
    advance,
  };
}

function createGreasemonkey(storedValues) {
  const values = new Map(Object.entries(storedValues));
  const requests = [];
  return {
    values,
    requests,
    api: {
      GM_getValue: (key, fallback) => (values.has(key) ? values.get(key) : fallback),
      GM_setValue: (key, value) => { values.set(key, value); },
      GM_deleteValue: (key) => { values.delete(key); },
      GM_addStyle: () => {},
      GM_xmlhttpRequest: (options) => { requests.push({ ...options, answered: false }); },
    },
  };
}

function captureConsole(messages) {
  const virtualConsole = new VirtualConsole();
  for (const level of ['log', 'info', 'warn', 'error']) {
    virtualConsole.on(level, (...args) => messages.push({ level, text: args.map(String).join(' ') }));
  }
  virtualConsole.on('jsdomError', (error) => messages.push({ level: 'jsdomError', text: error.message }));
  return virtualConsole;
}

function openMarketplace({ scriptPath, path, mainHtml = '', stored = {} }) {
  const consoleMessages = [];
  const openedUrls = [];
  const dom = new JSDOM(`<!doctype html><html><body><div role="main">${mainHtml}</div></body></html>`, {
    url: MARKETPLACE_ORIGIN + path,
    runScripts: 'outside-only',
    virtualConsole: captureConsole(consoleMessages),
  });
  const { window } = dom;
  const clock = createFakeClock();
  const greasemonkey = createGreasemonkey(stored);

  Object.assign(window, greasemonkey.api, {
    setTimeout: clock.setTimeout,
    setInterval: clock.setInterval,
    clearTimeout: clock.clearTimer,
    clearInterval: clock.clearTimer,
    open: (url) => { openedUrls.push(url); return null; },
  });
  Object.defineProperty(window.HTMLElement.prototype, 'innerText', {
    configurable: true,
    get() { return approximateInnerText(this).replace(/\n{2,}/g, '\n').trim(); },
  });

  function main() {
    return window.document.querySelector('div[role="main"]');
  }

  function setMain(html) {
    main().innerHTML = html;
  }

  function navigate(nextPath, html) {
    window.history.pushState({}, '', MARKETPLACE_ORIGIN + nextPath);
    if (html !== undefined) setMain(html);
  }

  function pendingRequests(urlPart) {
    return greasemonkey.requests.filter((request) => !request.answered && request.url.includes(urlPart));
  }

  async function respond(request, status, body) {
    request.answered = true;
    request.onload({ status, responseText: typeof body === 'string' ? body : JSON.stringify(body) });
    await flushPromises();
  }

  window.eval(fs.readFileSync(scriptPath, 'utf8'));

  return {
    window,
    document: window.document,
    values: greasemonkey.values,
    requests: greasemonkey.requests,
    consoleMessages,
    openedUrls,
    main,
    setMain,
    navigate,
    pendingRequests,
    respond,
    advance: clock.advance,
    flush: flushPromises,
    close: () => window.close(),
  };
}

module.exports = { openMarketplace };
