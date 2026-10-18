/*
 * zach-db — interface « Guns.lol views ».
 *
 * Le navigateur ne fait presque rien : il lit le pseudo, appelle le serveur
 * (/api/guns/views) et raconte ce qui revient, ligne par ligne. Tout le réseau
 * — récolte des proxys, tunnel CONNECT, envoi des vues — se passe sur le
 * serveur, seul capable d'ouvrir un tunnel vers un proxy HTTP.
 */
import { copyText } from './chrome.js';
import { extractSlug } from './lib/guns.js';

const el = (id) => document.getElementById(id);
const fmt = new Intl.NumberFormat('en-US');
const n = (value) => fmt.format(Number(value) || 0);

let controller = null;
let lastPayload = null;

function set(id, value) {
  const node = el(id);
  if (node) node.textContent = value === null || value === undefined || value === '' ? '—' : String(value);
}

function show(id, visible) {
  const node = el(id);
  if (node) node.hidden = !visible;
}

function note(id, text) {
  const node = el(id);
  if (!node) return;
  node.textContent = text || '';
  node.hidden = !text;
}

function status(text) {
  set('gstatus', text);
}

function stage(text, busy) {
  show('gprogress', Boolean(busy));
  set('gpct', text);
  const cancel = el('gcancel');
  if (cancel) cancel.disabled = !busy;
  const go = el('ggo');
  if (go) go.disabled = Boolean(busy);
  if (typeof document.body !== 'undefined' && document.body.classList) {
    document.body.classList.toggle('is-busy', Boolean(busy));
  }
}

function empty(list, text) {
  const node = list;
  if (!node) return;
  node.textContent = '';
  const item = document.createElement('li');
  item.className = list.id === 'gproxies' ? 'pool-empty' : 'log-empty';
  item.textContent = text;
  node.appendChild(item);
}

/* ==================================================================
 * 01 — la cible
 * ================================================================== */

function readForm() {
  const user = el('guser');
  const views = el('gviews');
  const concurrency = el('gconc');
  const direct = el('gdirect');
  const read = el('gread');
  return {
    text: user ? user.value : '',
    views: views && views.value ? Number(views.value) : 15,
    concurrency: concurrency && concurrency.value ? Number(concurrency.value) : 6,
    direct: Boolean(direct && direct.checked),
    read: Boolean(read && read.checked),
  };
}

/* ==================================================================
 * 02 — la réserve de proxys
 * ================================================================== */

function renderPool(pool) {
  const list = el('gproxies');
  const stats = el('gpoolStats');
  if (stats) {
    stats.textContent = '';
    const rows = [
      ['sources answered', pool.sources.filter((source) => !source.error).length + ' / ' + pool.sources.length],
      ['proxies harvested', n(pool.harvested)],
      ['tunnel + TLS tested', n(pool.tested)],
      ['usable', n(pool.alive)],
      ['dead', n(pool.dead)],
      ['elapsed', n(pool.elapsed) + ' ms'],
    ];
    for (const [label, value] of rows) {
      const cell = document.createElement('div');
      const dt = document.createElement('dt');
      dt.textContent = label;
      const dd = document.createElement('dd');
      dd.textContent = value;
      cell.append(dt, dd);
      stats.appendChild(cell);
    }
  }

  if (!list) return;
  if (!pool.sources.length) {
    empty(list, 'No source answered.');
    return;
  }
  list.textContent = '';
  for (const source of pool.sources) {
    const item = document.createElement('li');
    item.className = 'pool-item';
    const name = document.createElement('b');
    name.textContent = source.name;
    const count = document.createElement('span');
    count.textContent = source.error ? source.error : n(source.count) + ' kept';
    item.append(name, count);
    list.appendChild(item);
  }
  for (const entry of pool.sample || []) {
    const item = document.createElement('li');
    item.className = 'pool-item';
    const name = document.createElement('b');
    name.textContent = entry.proxy;
    const count = document.createElement('span');
    count.textContent = n(entry.ms) + ' ms';
    item.append(name, count);
    list.appendChild(item);
  }
}

async function testPool() {
  const button = el('gpool');
  if (button) button.disabled = true;
  const waiting = 'harvesting the public lists, then trying a tunnel + TLS on each candidate…';
  note('gpoolNote', waiting);
  // The server answers only once the whole sweep is over; without a clock the
  // note looks frozen, and nothing used to give up if the sweep never ended.
  const startedAt = Date.now();
  const ticker = setInterval(() => {
    const seconds = Math.round((Date.now() - startedAt) / 1000);
    note('gpoolNote', waiting + ' ' + seconds + ' s elapsed — the server answers only when the sweep is over.');
  }, 1000);
  const control = typeof AbortController === 'function' ? new AbortController() : null;
  const giveUp = setTimeout(() => { if (control) control.abort(); }, 180000);
  try {
    const response = await fetch('/api/guns/proxies', {
      headers: { accept: 'application/json' },
      signal: control ? control.signal : undefined,
    });
    const payload = await response.json();
    if (!response.ok) {
      note('gpoolNote', payload.error || 'The pool could not be tested.');
      empty(el('gproxies'), 'Nothing tested.');
      return;
    }
    renderPool(payload);
    note('gpoolNote', payload.alive
      ? payload.alive + ' usable proxies out of ' + payload.tested + ' tested — a view costs one address, so that is the ceiling.'
      : 'No proxy answered: the boost will fall back to the server address.');
  } catch (err) {
    note('gpoolNote', control && control.signal.aborted
      ? 'No answer after three minutes: the server is overloaded or waking up — try again in a moment.'
      : 'The server could not be reached: ' + ((err && err.message) || 'network error'));
  } finally {
    clearInterval(ticker);
    clearTimeout(giveUp);
    if (button) button.disabled = false;
  }
}

/* ==================================================================
 * 03 — le journal
 * ================================================================== */

function renderLog(attempts) {
  const list = el('glog');
  if (!list) return;
  if (!attempts.length) {
    empty(list, 'No attempt yet.');
    return;
  }
  list.textContent = '';
  for (const entry of attempts) {
    const item = document.createElement('li');
    item.className = 'log-item ' + (entry.ok ? 'is-ok' : entry.steps.includes(' 0') ? 'is-skip' : 'is-fail');

    const when = document.createElement('span');
    when.className = 'log-time';
    when.textContent = n(entry.ms) + ' ms';

    const tag = document.createElement('span');
    tag.className = 'log-tag';
    tag.textContent = entry.ok ? 'view ' + entry.via : 'miss';

    const message = document.createElement('span');
    message.className = 'log-msg';
    message.textContent = entry.proxy + ' · ' + entry.steps + (entry.note ? ' · ' + entry.note : '');

    item.append(when, tag, message);
    list.appendChild(item);
  }
}

function renderCounts(report) {
  set('cAttempts', n(report.views.attempts));
  set('cAccepted', n(report.views.accepted));
  set('cFailed', n(report.views.failed));
  set('cPool', n(report.pool.alive));
  set('cPage', n(report.steps.page.ok) + '/' + n(report.steps.page.tried));
  set('cPixel', n(report.steps.pixel.ok) + '/' + n(report.steps.pixel.tried));
  set('cView', n(report.steps.view.ok) + '/' + n(report.steps.view.tried));
  set('cRecord', n(report.steps.record.ok) + '/' + n(report.steps.record.tried));
  set('cCounter', report.counter.after !== null
    ? n(report.counter.after) + (report.counter.delta === null ? '' : ' (' + (report.counter.delta >= 0 ? '+' : '') + n(report.counter.delta) + ')')
    : (report.counter.fromPages !== null ? n(report.counter.fromPages) + ' (read)' : 'unreadable'));
}

function renderRaw(report) {
  const box = el('grawBox');
  const pre = el('graw');
  if (!box || !pre) return;
  const body = { ...report };
  delete body.status;
  pre.textContent = JSON.stringify(body, null, 2);
  box.hidden = false;
  const save = el('gsave');
  if (save) save.disabled = false;
}

/* ==================================================================
 * la passe
 * ================================================================== */

async function run(options) {
  const slug = extractSlug(options.text);
  if (!slug) {
    note('gnote', options.text.trim()
      ? 'That is not a guns.lol username: expected "username", "@username" or a profile link.'
      : 'Type a guns.lol username to begin.');
    status(options.text.trim() ? 'Invalid username.' : 'Ready.');
    return;
  }

  note('gnote', '');
  note('gwarn', '');
  controller = typeof AbortController === 'function' ? new AbortController() : null;
  stage('harvesting proxies, then sending views…', true);
  status('Working on guns.lol/' + slug + '…');

  const query = new URLSearchParams({ user: slug, views: String(options.views), concurrency: String(options.concurrency) });
  if (options.direct) query.set('direct', '1');
  if (options.read) query.set('read', '1');

  try {
    const response = await fetch('/api/guns/views?' + query.toString(), {
      headers: { accept: 'application/json' },
      signal: controller ? controller.signal : undefined,
    });
    const report = await response.json();
    report.status = response.status;
    lastPayload = report;

    if (!report.ok) {
      note('gnote', (report.error || 'The boost failed.') + (report.hint ? ' ' + report.hint : ''));
      status('Nothing sent.');
      return;
    }

    renderCounts(report);
    renderLog(report.attempts || []);
    renderRaw(report);
    set('gmeta', report.mode + ' · ' + n(report.elapsed) + ' ms');

    status(report.views.accepted + ' of ' + report.views.attempts + ' views accepted on guns.lol/' + slug +
      ' · ' + report.pool.alive + ' usable proxies' + (report.truncated ? ' · stopped early' : '') + '.');

    if (report.notes.length) note('gwarn', report.notes.join(' · '));
    if (!report.views.accepted) {
      note('gnote', 'Every layer failed: the proxies were probably already dead. Try the pool test again.');
    }
  } catch (err) {
    if (err && err.name === 'AbortError') {
      status('Cancelled.');
    } else {
      note('gnote', 'The server could not be reached: ' + ((err && err.message) || 'network error') + '.');
      status('Boost failed.');
    }
  } finally {
    controller = null;
    stage('done', false);
  }
}

function download() {
  if (!lastPayload) return;
  const body = { ...lastPayload };
  delete body.status;
  const blob = new Blob([JSON.stringify(body, null, 2)], { type: 'application/json' });
  const url = URL.createObjectURL(blob);
  const anchor = document.createElement('a');
  anchor.href = url;
  anchor.download = 'guns-' + (body.slug || 'views') + '.json';
  document.body.appendChild(anchor);
  anchor.click();
  anchor.remove();
  const timer = setTimeout(() => URL.revokeObjectURL(url), 4000);
  if (timer && typeof timer.unref === 'function') timer.unref();
}

/* ==================================================================
 * branchements
 * ================================================================== */

async function readHealth() {
  try {
    const response = await fetch('/api/health', { headers: { accept: 'application/json' } });
    const health = await response.json();
    if (health && health.ok) set('gmeta', 'server ready · proxies harvested on demand');
  } catch {
    set('gmeta', 'server unreachable');
  }
}

async function init() {
  const form = el('gunForm');
  const input = el('guser');
  const cancel = el('gcancel');
  const pool = el('gpool');
  const save = el('gsave');
  const copyRaw = el('gcopy');

  status('Ready. Harvesting and testing proxies happens on demand, on the server.');
  empty(el('glog'), 'No attempt yet.');
  empty(el('gproxies'), 'The pool has not been tested yet.');

  const params = typeof location !== 'undefined' && location.search ? new URLSearchParams(location.search) : null;
  const wanted = params ? extractSlug(params.get('user') || params.get('u') || '') : null;
  if (input && wanted) input.value = wanted;

  if (form) {
    form.addEventListener('submit', (event) => {
      event.preventDefault();
      run(readForm());
    });
  }
  if (input) {
    input.addEventListener('input', () => {
      const slug = extractSlug(input.value);
      if (slug && typeof history !== 'undefined' && history.replaceState) {
        history.replaceState(null, '', '?user=' + slug);
      }
    });
  }
  if (cancel) {
    cancel.addEventListener('click', () => {
      if (controller) controller.abort();
    });
  }
  if (pool) pool.addEventListener('click', testPool);
  if (save) save.addEventListener('click', download);
  if (copyRaw) {
    copyRaw.addEventListener('click', async () => {
      const pre = el('graw');
      const ok = await copyText(pre ? pre.textContent : '');
      copyRaw.textContent = ok ? 'Copied' : 'Copy failed';
      setTimeout(() => { copyRaw.textContent = 'Copy'; }, 1600);
    });
  }

  await readHealth();
  if (wanted) await run(readForm());
}

init().catch((err) => status('Startup error: ' + ((err && err.message) || err)));

export { run, testPool, download, renderLog, renderCounts };
