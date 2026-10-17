/*
 * zach-db — interface « Trier par site ».
 *
 * Une seule vue : le fichier est analysé dans un Web Worker (compteurs par
 * site, liste affichée en direct), puis un clic sur un site relit le fichier
 * pour n'en extraire que les valeurs. Une barre de progression suit
 * l'avancement de la lecture du .txt, ligne à ligne.
 *
 * Rien ne transite par le réseau. Cas particulier : si l'URL contient
 * ?dir=/dossier, le serveur lit les fichiers (flux HTTP) à la place.
 */
import './chrome.js'; // sélecteur d'outil + décor commun à toutes les pages

const MEMORY_CAP = 64 * 1024 * 1024; // garde-fou mémoire
const PREVIEW_CHARS = 48 * 1024;
const LIST_LIMIT = 1000; // lignes de sites affichées d'un coup

const el = (id) => document.getElementById(id);
const fmt = new Intl.NumberFormat('en-US');
const n = (value) => fmt.format(value);
const plural = (count, singular, pluralForm = singular + 's') =>
  n(count) + ' ' + (count === 1 ? singular : pluralForm);
const mb = (bytes) => (bytes / 1048576).toFixed(1) + ' MB';
const dirParam = new URL(location.href).searchParams.get('dir');

let worker = null;
let passId = 0;
let abortController = null;

/* ================= Web Worker ================= */

function ensureWorker() {
  if (worker) return worker;
  worker = new Worker('/worker.js', { type: 'module' });
  worker.onerror = (event) => {
    el('gstatus').textContent = 'Worker error: ' + (event.message || 'unknown error');
  };
  return worker;
}

/** Envoie une passe au worker et résout avec le message "done". */
function runWorker(message, handlers = {}) {
  const id = ++passId;
  return new Promise((resolve, reject) => {
    const onMessage = (event) => {
      const data = event.data || {};
      if (data.id !== id) return;
      if (data.type === 'chunk') {
        if (handlers.onChunk) handlers.onChunk(data.data);
        return;
      }
      if (data.type === 'sites') {
        if (handlers.onSites) handlers.onSites(data);
        return;
      }
      if (data.type === 'progress') {
        if (handlers.onProgress) handlers.onProgress(data);
        return;
      }
      worker.removeEventListener('message', onMessage);
      if (data.type === 'done') resolve(data);
      else if (data.type === 'cancelled') reject(Object.assign(new Error('Cancelled'), { code: 'CANCELLED' }));
      else reject(new Error(data.message || 'Worker error'));
    };
    worker.addEventListener('message', onMessage);
    worker.postMessage({ ...message, id });
  });
}

function cancelWorker() {
  if (worker) worker.postMessage({ type: 'cancel' });
  if (abortController) abortController.abort();
}

/* ================= outils ================= */

function trimPreview(chunks, limit = PREVIEW_CHARS) {
  let text = '';
  for (const chunk of chunks) {
    text += chunk;
    if (text.length >= limit) return text.slice(0, limit) + '\n[...]';
  }
  return text;
}

function download(blob, filename) {
  const url = URL.createObjectURL(blob);
  const link = document.createElement('a');
  link.href = url;
  link.download = filename;
  document.body.appendChild(link);
  link.click();
  link.remove();
  setTimeout(() => URL.revokeObjectURL(url), 60000);
}

function textBlob(text) {
  return new Blob([text], { type: 'text/plain;charset=utf-8' });
}

function countLines(text) {
  let count = 0;
  let index = -1;
  while ((index = text.indexOf('\n', index + 1)) !== -1) count++;
  return count;
}

function readMode(form, name, regexInput) {
  const mode = form.querySelector('input[name="' + name + '"]:checked').value;
  const regex = regexInput.value.trim();
  if (mode === 'custom') {
    try {
      new RegExp(regex || '([a-z0-9._-]+):([a-z0-9._-]+)'); // validation avant lancement
    } catch (err) {
      throw new Error('Invalid regex: ' + err.message);
    }
  }
  return { mode, regex };
}

function cleanName(name) {
  return (name || 'zach-db').replace(/\.[^.]+$/, '').replace(/[^\w.-]+/g, '_') || 'zach-db';
}

function sourceFromFiles(files) {
  if (files.length === 1) return { source: files[0], base: cleanName(files[0].name) };
  const parts = [];
  files.forEach((file, index) => {
    if (index) parts.push('\n'); // séparation entre deux fichiers
    parts.push(file);
  });
  return { source: new Blob(parts, { type: 'text/plain' }), base: 'zach-db' };
}

/* ================= barre de progression ================= */

const progressEl = el('gprogress');
const barEl = el('gbar');
const pctEl = el('gpct');

function progressReset() {
  progressEl.hidden = false;
  progressEl.classList.remove('indeterminate');
  progressEl.setAttribute('aria-valuenow', '0');
  barEl.style.width = '0%';
  pctEl.textContent = '0 lines · 0%';
}

/** Avancement réel : lignes traitées et octets lus dans le .txt. */
function progressTo(loaded, total, lines) {
  const ratio = total > 0 ? Math.min(1, loaded / total) : 0;
  const pct = Math.round(ratio * 100);
  progressEl.classList.remove('indeterminate');
  progressEl.setAttribute('aria-valuenow', String(pct));
  barEl.style.width = pct + '%';
  pctEl.textContent = (lines === undefined ? '' : n(lines) + ' lines · ') + pct + '%';
}

/** Total inconnu (flux serveur) : animation le temps de la lecture. */
function progressLive() {
  progressEl.hidden = false;
  progressEl.classList.add('indeterminate');
  barEl.style.width = '';
  pctEl.textContent = '…';
}

function progressDone(lines) {
  progressEl.classList.remove('indeterminate');
  progressEl.setAttribute('aria-valuenow', '100');
  barEl.style.width = '100%';
  pctEl.textContent = (lines === undefined ? '' : n(lines) + ' lines · ') + '100%';
}

function progressHide() {
  progressEl.hidden = true;
}

/* ================= statistiques ================= */

const statSites = el('statSites');
const statValues = el('statValues');
const statLines = el('statLines');
const statBytes = el('statBytes');

function setStats({ sites, values, lines, bytes }) {
  if (sites !== undefined) statSites.textContent = sites;
  if (values !== undefined) statValues.textContent = values;
  if (lines !== undefined) statLines.textContent = lines;
  if (bytes !== undefined) statBytes.textContent = bytes;
}

function resetStats() {
  setStats({ sites: '0', values: '0', lines: '0', bytes: '0.0 MB' });
}

/** Petit sursaut des compteurs quand un chiffre change (100 % CSS). */
function bumpStats() {
  for (const node of [statSites, statValues, statLines]) {
    node.classList.remove('bump');
    void node.offsetWidth; // relance l’animation
    node.classList.add('bump');
  }
}

/* ==================================================================
 * Trier par site
 * ================================================================== */

const groupForm = el('groupForm');
const gfileInput = el('gfile');
const gfilesInput = el('gfiles');
const gregexInput = el('gregex');
const gsubInput = el('gsub');
const gdedupeInput = el('gdedupe');
const ghostsInput = el('ghosts');
const gscanButton = el('gscan');
const gcancelButton = el('gcancel');
const gstatusEl = el('gstatus');
const gfilterInput = el('gfilter');
const gsummaryEl = el('gsummary');
const gsitesEl = el('gsites');
const gresultEl = el('gresult');
const gtitreEl = el('gtitre');
const gsaveButton = el('gsave');
const gprevButton = el('gprev');
const gtextEl = el('gtext');
const gwarnEl = el('gwarn');
const metaEl = el('meta');

const GROUP_SITES = new Map(); // site → { site, count, bytes }
let groupBusy = false;
let groupJob = null; // { source, opts, base, remote, stats, site, siteText }

function groupOptions() {
  const { mode, regex } = readMode(groupForm, 'gmode', gregexInput);
  return {
    mode,
    regex,
    dedupe: gdedupeInput.checked,
    hosts: ghostsInput.checked,
    stripSubdomains: gsubInput.checked,
  };
}

function setGroupBusy(value) {
  groupBusy = value;
  gscanButton.disabled = value;
  gcancelButton.disabled = !value;
  gfileInput.disabled = value;
  gfilesInput.disabled = value;
  if (value) gsaveButton.disabled = true;
  // le décor (halos, bandeau, scintillement) se met en pause pendant le traitement
  if (document.body && document.body.classList) document.body.classList.toggle('busy', value);
}

function replaceSites(list) {
  GROUP_SITES.clear();
  for (const entry of list) GROUP_SITES.set(entry.site, entry);
}

function renderSites() {
  const filter = gfilterInput.value.trim().toLowerCase();
  let entries = [...GROUP_SITES.values()];
  entries.sort((a, b) => b.bytes - a.bytes || b.count - a.count || (a.site < b.site ? -1 : a.site > b.site ? 1 : 0));
  if (filter) entries = entries.filter((entry) => entry.site.toLowerCase().includes(filter));

  const fragment = document.createDocumentFragment();
  for (const entry of entries.slice(0, LIST_LIMIT)) {
    const li = document.createElement('li');
    const button = document.createElement('button');
    button.type = 'button';
    button.className = 'siteLink';
    button.textContent = entry.site;
    button.addEventListener('click', () => openSite(entry.site));
    const info = document.createElement('span');
    info.className = 'count';
    info.textContent = plural(entry.count, 'value') + ' · ' + mb(entry.bytes);
    li.append(button, info);
    fragment.append(li);
  }
  gsitesEl.replaceChildren(fragment);

  const total = GROUP_SITES.size;
  if (filter) {
    if (entries.length === 0) {
      gsummaryEl.textContent = 'No sites match "' + filter + '".';
    } else if (entries.length > LIST_LIMIT) {
      gsummaryEl.textContent = 'Showing the first ' + n(LIST_LIMIT) + ' of ' + n(entries.length) +
        ' matching sites — refine your filter.';
    } else {
      gsummaryEl.textContent = 'Showing ' + n(entries.length) + ' of ' + n(total) + ' ' +
        (total === 1 ? 'site' : 'sites') + ' — click a site to open it.';
    }
  } else if (total === 0) {
    gsummaryEl.textContent = 'No sites found yet.';
  } else if (total > LIST_LIMIT) {
    gsummaryEl.textContent = 'Showing the first ' + n(LIST_LIMIT) + ' of ' + plural(total, 'site') +
      ' — use the filter to see more.';
  } else {
    gsummaryEl.textContent = plural(total, 'site') + ' — click a site to open it.';
  }
}

/** Écran de lecture d'un site. */
function showSiteTitle(site) {
  const entry = GROUP_SITES.get(site);
  gtitreEl.textContent = site + (entry ? ' — ' + plural(entry.count, 'value') + ' · ' + mb(entry.bytes) : '');
  gresultEl.hidden = false;
  gwarnEl.hidden = true;
  gtextEl.textContent = 'Loading…';
  gsaveButton.disabled = true;
  gresultEl.scrollIntoView({ block: 'nearest' });
}

async function openSite(site) {
  if (!groupJob || groupBusy) return;
  showSiteTitle(site);
  setGroupBusy(true);
  progressReset();
  const chunks = [];
  let kept = 0;
  let full = false;
  const started = Date.now();

  try {
    if (groupJob.remote) {
      progressLive();
      const text = await remoteSiteText(site);
      gtextEl.textContent = trimPreview([text]);
      groupJob.site = site;
      groupJob.siteText = text;
      progressDone();
      gstatusEl.textContent = 'Site ' + site + ': ' + plural(countLines(text), 'value') + ' (' +
        mb(text.length) + ') in ' + ((Date.now() - started) / 1000).toFixed(2) + ' s';
    } else {
      const total = groupJob.source.size;
      const stats = await runWorker({
        type: 'group',
        source: groupJob.source,
        options: groupJob.opts,
        pass: { onlySite: site, count: false, maxTextBytes: MEMORY_CAP },
      }, {
        onChunk(chunk) {
          if (full) return;
          kept += chunk.length;
          if (kept * 2 > MEMORY_CAP) {
            full = true;
            return;
          }
          chunks.push(chunk);
          gtextEl.textContent = trimPreview(chunks);
        },
        onProgress(data) {
          progressTo(data.loaded, total, data.lines);
          const percent = total ? Math.floor((data.loaded / total) * 100) : 0;
          gstatusEl.textContent = 'Site ' + site + '… ' + percent + '% — ' + n(data.loaded) + ' / ' +
            n(total) + ' ' + (total === 1 ? 'byte' : 'bytes') + ' — ' + n(data.lines) + ' lines — ' + n(data.kept) + ' values';
        },
      });

      groupJob.site = site;
      groupJob.siteText = chunks.join('');
      gtextEl.textContent = trimPreview(chunks);
      progressDone(stats.lines);
      gstatusEl.textContent = 'Site ' + site + ': ' + plural(stats.outLines, 'value') + ' (' +
        mb(stats.outChars) + ') in ' + (stats.ms / 1000).toFixed(2) + ' s';
      if (full || stats.truncated) {
        gwarnEl.hidden = false;
        gwarnEl.textContent = 'Output is too large for browser memory; the downloaded .txt file is partial. ' +
          'Use the CLI (node cli.js file.txt --group --site=' + site + ') or the API (?site=' + site + ').';
      }
    }
    gsaveButton.disabled = !groupJob.siteText;
  } catch (err) {
    if (err.code === 'CANCELLED' || err.name === 'AbortError') gstatusEl.textContent = 'Cancelled.';
    else gstatusEl.textContent = 'Error: ' + err.message;
    gtextEl.textContent = '';
    progressHide();
  } finally {
    gsaveButton.textContent = 'Download ' + site + '.txt';
    setGroupBusy(false);
  }
}

async function remoteSiteText(site) {
  abortController = new AbortController();
  const query = '/api/group?site=' + encodeURIComponent(site) +
    '&mode=' + encodeURIComponent(groupJob.opts.mode) +
    '&regex=' + encodeURIComponent(groupJob.opts.regex) +
    '&dedupe=' + (groupJob.opts.dedupe ? 1 : 0) +
    '&hosts=' + (groupJob.opts.hosts ? 1 : 0) +
    '&subdomains=' + (groupJob.opts.stripSubdomains ? 1 : 0) +
    (dirParam ? '&dir=' + encodeURIComponent(dirParam) + '&paths=1' : '');
  const response = await fetch(query, {
    method: 'POST',
    headers: { 'content-type': 'text/plain;charset=utf-8' },
    body: groupJob.paths.join('\n'),
    signal: abortController.signal,
  });
  if (!response.ok || !response.body) {
    throw new Error('Server: ' + response.status + ' ' + (await response.text()).slice(0, 200));
  }
  const reader = response.body.getReader();
  const chunks = [];
  let chars = 0;
  for (;;) {
    const { value, done } = await reader.read();
    if (done) break;
    const text = new TextDecoder().decode(value, { stream: true });
    chars += text.length;
    if (chars * 2 > MEMORY_CAP) {
      await reader.cancel();
      gwarnEl.hidden = false;
      gwarnEl.textContent = 'Output is too large for browser memory; only the beginning will be available in the .txt file. ' +
        'Use the API directly: curl … ?site=' + site + ' -o ' + site + '.txt';
      break;
    }
    chunks.push(text);
  }
  return chunks.join('');
}

async function groupScan() {
  let opts;
  try {
    opts = groupOptions();
  } catch (err) {
    gstatusEl.textContent = err.message;
    return;
  }

  const files = Array.from(gfileInput.files || []);
  const listed = gfilesInput.value.split('\n').map((line) => line.trim()).filter(Boolean);
  gresultEl.hidden = true;
  gsaveButton.disabled = true;
  replaceSites([]);
  renderSites();
  resetStats();
  setGroupBusy(true);
  progressReset();

  try {
    if (files.length === 0) {
      if (listed.length === 0) throw new Error('Choose a .txt file (or provide a list with ?dir=…).');
      if (!dirParam) throw new Error('The browser cannot read server-side file paths. Use ?dir=/directory, the curl API, or the CLI.');
      await groupRemoteScan(listed, opts);
      return;
    }

    const { source, base } = sourceFromFiles(files);
    groupJob = { source, opts, base, remote: false, stats: null };
    gstatusEl.textContent = 'Analyzing…';

    const stats = await runWorker({
      type: 'group',
      source,
      options: opts,
      pass: { count: true, maxTextBytes: 0 },
    }, {
      onSites(data) {
        replaceSites(data.sites);
        renderSites();
        statSites.textContent = n(data.total);
        gstatusEl.textContent = 'Analyzing… ' + n(GROUP_SITES.size) + ' of ' + plural(data.total, 'site') +
          (data.live ? ' (live list)' : '');
      },
      onProgress(data) {
        progressTo(data.loaded, source.size, data.lines);
        setStats({
          sites: n(data.sites),
          values: n(data.kept),
          lines: n(data.lines),
          bytes: mb(data.loaded),
        });
        gstatusEl.textContent = 'Analyzing… ' + n(data.loaded) + ' / ' + n(source.size) + ' ' +
          (source.size === 1 ? 'byte' : 'bytes') + ' — ' + n(data.lines) + ' lines — ' + n(data.sites) + ' sites';
      },
    });

    groupJob.stats = stats;
    progressDone(stats.lines);
    setStats({
      sites: n(stats.sites),
      values: n(stats.kept),
      lines: n(stats.lines),
      bytes: mb(stats.bytes),
    });
    bumpStats();
    gstatusEl.textContent = [
      'Done.',
      'Read: ' + plural(stats.bytes, 'byte') + ' (' + mb(stats.bytes) + ') in ' + (stats.ms / 1000).toFixed(2) + ' s',
      'Lines: ' + n(stats.lines) + ' — matched lines: ' + n(stats.matched) + ' — skipped: ' + n(stats.skipped),
      'Sites: ' + n(stats.sites) + ' — values: ' + n(stats.kept),
      'Click a site to view its values.',
    ].join('\n');
    renderSites();
  } catch (err) {
    progressHide();
    if (err.code === 'CANCELLED' || err.name === 'AbortError') gstatusEl.textContent = 'Cancelled.';
    else gstatusEl.textContent = 'Error: ' + err.message;
  } finally {
    setGroupBusy(false);
  }
}

async function groupRemoteScan(paths, opts) {
  groupJob = { opts, remote: true, paths, base: 'zach-db', stats: null };
  gstatusEl.textContent = 'Analyzing on the server…';
  progressLive();
  abortController = new AbortController();
  const query = '/api/group?format=json' +
    '&mode=' + encodeURIComponent(opts.mode) +
    '&regex=' + encodeURIComponent(opts.regex) +
    '&dedupe=' + (opts.dedupe ? 1 : 0) +
    '&hosts=' + (opts.hosts ? 1 : 0) +
    '&subdomains=' + (opts.stripSubdomains ? 1 : 0) +
    (dirParam ? '&dir=' + encodeURIComponent(dirParam) + '&paths=1' : '');
  const response = await fetch(query, {
    method: 'POST',
    headers: { 'content-type': 'text/plain;charset=utf-8' },
    body: paths.join('\n'),
    signal: abortController.signal,
  });
  const payload = await response.json();
  if (!response.ok) throw new Error(payload.error || ('Server: ' + response.status));
  replaceSites(payload.sites);
  renderSites();
  progressDone();
  bumpStats();
  setStats({
    sites: n(payload.total),
    values: n(payload.stats.kept),
    lines: n(payload.stats.lines),
    bytes: '—',
  });
  gstatusEl.textContent = [
    'Done (server-side).',
    'Sites: ' + n(payload.total) + ' — values: ' + n(payload.stats.kept),
    'Click a site to view its values.',
  ].join('\n');
}

groupForm.addEventListener('submit', async (event) => {
  event.preventDefault();
  if (groupBusy) return;
  await groupScan();
});

gcancelButton.addEventListener('click', () => {
  cancelWorker();
  gstatusEl.textContent = 'Cancelling…';
});

gfilterInput.addEventListener('input', renderSites);

gsaveButton.addEventListener('click', () => {
  if (!groupJob || !groupJob.siteText) return;
  const name = (groupJob.site || 'zach-db').replace(/[^\w.-]+/g, '_') + '.txt';
  download(textBlob(groupJob.siteText), name);
});

gprevButton.addEventListener('click', () => {
  gresultEl.hidden = true;
  gtitreEl.textContent = 'Site';
});

gfileInput.addEventListener('change', () => {
  const list = gfileInput.files || [];
  if (list.length) {
    let size = 0;
    for (const file of list) size += file.size;
    metaEl.textContent = plural(list.length, 'file') + ' · ' + mb(size);
  }
});

gregexInput.addEventListener('input', () => {
  if (gregexInput.value.trim()) groupForm.querySelector('input[name="gmode"][value="custom"]').checked = true;
});

/* ==================================================================
 * Décor propre à cet outil — glisser-déposer d'un .txt sur la zone de
 * dépôt. Le reste (sélecteur d'outil, fil de lecture, apparitions, halo
 * des cartes, compteurs, démonstration qui s'écrit, boutons copier) est
 * partagé par toutes les pages : voir public/chrome.js.
 * ================================================================== */

/** Glisser-déposer d'un .txt directement sur la zone de fichier. */
function initDrop() {
  const zone = gfileInput && gfileInput.closest ? gfileInput.closest('.drop') : null;
  if (!zone) return;
  const mark = (on) => zone.classList.toggle('is-drag', on);
  for (const type of ['dragenter', 'dragover']) {
    zone.addEventListener(type, (event) => {
      event.preventDefault();
      mark(true);
    });
  }
  for (const type of ['dragleave', 'dragend']) zone.addEventListener(type, () => mark(false));
  zone.addEventListener('drop', (event) => {
    event.preventDefault();
    mark(false);
    const files = event.dataTransfer && event.dataTransfer.files;
    if (!files || !files.length) return;
    gfileInput.files = files;
    gfileInput.dispatchEvent(new Event('change'));
  });
}

/* ================= démarrage ================= */

metaEl.textContent = dirParam ? 'Server-side processing · ?dir=' + dirParam : 'Local processing · no upload';
if (dirParam) {
  gfilesInput.placeholder = 'Enter one filename per line; files will be read from ' + dirParam;
}
renderSites();
ensureWorker();
initDrop();
