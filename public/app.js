/*
 * zach-db — interface.
 *
 * Une seule fonction côté navigateur : « Trier par site ». Chaque ligne d'un
 * .txt est lue en flux dans un Web Worker, rangée par site (roblox.com,
 * netflix.com, …) et sa valeur xxxx:xxxx extraite au passage — le tri extrait
 * donc déjà les couples, pas besoin d'une seconde passe côté interface.
 *
 * Deux temps :
 *   1. analyse  → une passe complète qui ne garde que des compteurs par site ;
 *   2. clic     → une passe ciblée qui écrit les valeurs d'un seul site.
 *
 * Rien ne transite par le réseau, sauf si l'URL contient ?dir=/dossier : dans
 * ce cas le serveur lit les fichiers et diffuse la réponse en flux.
 */
const MEMORY_CAP = 64 * 1024 * 1024; // garde-fou mémoire du navigateur
const PREVIEW_CHARS = 256 * 1024; // texte affiché à l'écran (le .txt, lui, est complet)
const LIST_LIMIT = 1000; // lignes de sites affichées d'un coup
const DEFAULT_REGEX = '([a-z0-9._-]+):([a-z0-9._-]+)';

const el = (id) => document.getElementById(id);
const fmt = new Intl.NumberFormat('fr-FR');
const n = (value) => fmt.format(value);
const dirParam = new URL(location.href).searchParams.get('dir');

const fr = (value, digits) => Number(value || 0).toFixed(digits).replace('.', ',');

/** Taille lisible : 812 o, 12,4 Ko, 1,2 Mo, 3,14 Go. */
function human(bytes) {
  const value = Number(bytes) || 0;
  if (value >= 1073741824) return fr(value / 1073741824, 2) + ' Go';
  if (value >= 1048576) return fr(value / 1048576, value >= 104857600 ? 0 : 1) + ' Mo';
  if (value >= 1024) return fr(value / 1024, value >= 102400 ? 0 : 1) + ' Ko';
  return n(value) + ' o';
}

/** Durée lisible : 3,2 s. */
const secs = (value, digits = 1) => fr(value, digits) + ' s';

/* ============================ éléments ============================ */

const form = el('form');
const fileInput = el('file');
const pathsInput = el('paths');
const pathsBox = el('pathsBox');
const drop = el('drop');
const dropTitle = el('dropTitle');
const dropSub = el('dropSub');
const regexInput = el('regex');
const regexBox = el('regexBox');
const subInput = el('sub');
const dedupeInput = el('dedupe');
const hostsInput = el('hosts');
const runButton = el('run');
const cancelButton = el('cancel');

const metaEl = el('meta');
const phaseEl = el('phase');
const progressEl = el('progress');
const barEl = el('bar');
const fillEl = el('fill');
const toplineFill = el('toplineFill');
const pctEl = el('pct');
const progressMetaEl = el('progressMeta');
const statusEl = el('status');
const tiles = {
  bytes: el('statBytes'),
  lines: el('statLines'),
  sites: el('statSites'),
  values: el('statValues'),
  speed: el('statSpeed'),
  time: el('statTime'),
};

const resultsEl = el('resultats');
const summaryEl = el('summary');
const filterInput = el('filter');
const sitesEl = el('sites');
const emptyEl = el('empty');
const exportButton = el('exportList');
const resultEl = el('result');
const resultTitle = el('resultTitle');
const resultMeta = el('resultMeta');
const saveButton = el('save');
const copyButton = el('copy');
const backButton = el('back');
const textEl = el('text');
const warnEl = el('warn');

/* ============================ état ============================ */

const SITES = new Map(); // site → { site, count, bytes }
let worker = null;
let passId = 0;
let abortController = null;
let busy = false;
let clock = null;
let startedAt = 0;
let selected = null;
let job = null; // { source, opts, base, remote, paths, stats, site, siteText }

/* ============================ petits outils ============================ */

const has = (node) => node !== null && node !== undefined;
const text = (node, value) => { if (has(node)) node.textContent = value; };
const cls = (node, name, on) => { if (has(node) && node.classList) node.classList.toggle(name, on); };

function log(message) {
  text(statusEl, message);
}

function phase(message) {
  text(phaseEl, message);
}

function stamp() {
  const now = new Date();
  const pad = (value) => String(value).padStart(2, '0');
  return now.getFullYear() + pad(now.getMonth() + 1) + pad(now.getDate()) + '-' +
    pad(now.getHours()) + pad(now.getMinutes()) + pad(now.getSeconds());
}

function safeName(name) {
  return String(name || 'zach-db').replace(/[^\w.-]+/g, '_') || 'zach-db';
}

function cleanName(name) {
  return (name || 'zach-db').replace(/\.[^.]+$/, '').replace(/[^\w.-]+/g, '_') || 'zach-db';
}

function download(blob, filename) {
  const url = URL.createObjectURL(blob);
  const link = document.createElement('a');
  link.href = url;
  link.download = filename;
  document.body.appendChild(link);
  link.click();
  link.remove();
  const release = setTimeout(() => URL.revokeObjectURL(url), 60000);
  // dans Node (tests) : ne pas retenir le processus ; dans un navigateur, no-op
  if (release && typeof release.unref === 'function') release.unref();
}

function textBlob(value) {
  return new Blob([value], { type: 'text/plain;charset=utf-8' });
}

function countLines(value) {
  let count = 0;
  let index = -1;
  while ((index = value.indexOf('\n', index + 1)) !== -1) count++;
  return count;
}

/** Le début du texte, pour l'aperçu à l'écran seulement. */
function trimPreview(chunks, limit = PREVIEW_CHARS) {
  let out = '';
  for (const chunk of chunks) {
    out += chunk;
    if (out.length >= limit) return out.slice(0, limit);
  }
  return out;
}

function flash(button, message) {
  if (!has(button)) return;
  const before = button.textContent;
  button.textContent = message;
  setTimeout(() => { button.textContent = before; }, 1500);
}

/* ============================ barre de progression ============================ */

/**
 * La barre suit l'avancement réel du traitement des lignes : le worker lit le
 * fichier en flux et annonce les octets consommés, donc `loaded / taille` est
 * exactement la part des lignes déjà traitées.
 */
function barMode(mode) {
  if (!has(progressEl) || !progressEl.classList) return;
  progressEl.classList.remove('running', 'indeterminate', 'done');
  if (mode) progressEl.classList.add(mode);
}

function setBar(ratio) {
  const value = Math.max(0, Math.min(1, Number(ratio) || 0));
  const width = (value * 100).toFixed(2) + '%';
  if (has(fillEl) && fillEl.style) fillEl.style.width = width;
  if (has(toplineFill) && toplineFill.style) toplineFill.style.width = width;
  if (has(barEl) && barEl.setAttribute) barEl.setAttribute('aria-valuenow', String(Math.floor(value * 100)));
  text(pctEl, Math.floor(value * 100) + '\u00a0%');
}

function setTile(key, value) {
  text(tiles[key], value);
}

function resetTiles() {
  setTile('bytes', '0');
  setTile('lines', '0');
  setTile('sites', '0');
  setTile('values', '0');
  setTile('speed', '—');
  setTile('time', secs(0));
}

/** Mise à jour barre + compteurs, à chaque annonce du worker. */
function report(data, total, label) {
  const seconds = (Date.now() - startedAt) / 1000;
  const loaded = data.loaded || 0;
  const values = data.kept !== undefined ? data.kept : (data.matched || 0);
  const siteCount = data.sites !== undefined ? data.sites : SITES.size;
  const speed = seconds > 0.02 && loaded ? loaded / seconds : 0;

  if (total) {
    setBar(loaded / total);
    barMode('running');
  }

  setTile('bytes', human(loaded));
  setTile('lines', n(data.lines || 0));
  setTile('sites', n(siteCount));
  setTile('values', n(values));
  setTile('speed', speed ? human(speed) + '/s' : '—');

  const left = speed > 0 && total > loaded ? (total - loaded) / speed : 0;
  const remaining = !left ? '' : ' · reste ' +
    (left < 1 ? 'moins d’une seconde'
      : left < 10 ? 'environ ' + secs(left)
      : 'environ ' + secs(Math.round(left), 0));
  text(progressMetaEl,
    label + ' · ' + n(loaded) + (total ? ' / ' + n(total) : '') + ' octets · ' +
    n(data.lines || 0) + ' lignes · ' + n(values) + ' valeurs · ' + n(siteCount) + ' sites' +
    (speed ? ' · ' + human(speed) + '/s' : '') + remaining);
}

function startClock() {
  stopClock();
  startedAt = Date.now();
  clock = setInterval(() => setTile('time', secs((Date.now() - startedAt) / 1000)), 100);
  // dans Node (tests) : ne pas retenir le processus ; dans un navigateur, no-op
  if (clock && typeof clock.unref === 'function') clock.unref();
}

function stopClock() {
  if (clock) clearInterval(clock);
  clock = null;
}

/* ============================ Web Worker ============================ */

function ensureWorker() {
  if (worker) return worker;
  worker = new Worker('/worker.js', { type: 'module' });
  worker.onerror = (event) => {
    const message = 'erreur worker : ' + ((event && event.message) || 'inconnue');
    log(message);
    phase('erreur');
  };
  return worker;
}

/** Envoie une passe au worker et résout avec le message « done ». */
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
      else if (data.type === 'cancelled') reject(Object.assign(new Error('annulé'), { code: 'CANCELLED' }));
      else reject(new Error(data.message || 'erreur worker'));
    };
    worker.addEventListener('message', onMessage);
    worker.postMessage({ ...message, id });
  });
}

function cancelWorker() {
  if (worker) worker.postMessage({ type: 'cancel' });
  if (abortController) abortController.abort();
}

/* ============================ réglages ============================ */

function checkedMode() {
  const input = form.querySelector('input[name="mode"]:checked');
  return input ? input.value : 'last';
}

function options() {
  const mode = checkedMode();
  const regex = regexInput.value.trim();
  if (mode === 'custom') {
    try {
      new RegExp(regex || DEFAULT_REGEX); // validée avant le lancement
    } catch (err) {
      throw new Error('regex invalide : ' + err.message);
    }
  }
  return {
    mode,
    regex,
    dedupe: !!dedupeInput.checked,
    hosts: !!hostsInput.checked,
    stripSubdomains: !!subInput.checked,
  };
}

/** Le champ regex n'apparaît que si le mode « regex perso » est choisi. */
function syncMode() {
  const custom = checkedMode() === 'custom';
  if (has(regexBox)) regexBox.hidden = !custom;
}

function setBusy(value) {
  busy = value;
  runButton.disabled = value;
  cancelButton.disabled = !value;
  fileInput.disabled = value;
  pathsInput.disabled = value;
  cls(drop, 'busy', value);
  cls(document.body, 'busy', value);
  if (value) {
    saveButton.disabled = true;
    copyButton.disabled = true;
    filterInput.disabled = true;
    exportButton.disabled = true;
  } else {
    filterInput.disabled = SITES.size === 0;
    exportButton.disabled = SITES.size === 0;
  }
}

/* ============================ source ============================ */

function describeFiles() {
  const list = fileInput.files || [];
  let size = 0;
  for (const file of list) size += file.size || 0;

  if (!list.length) {
    text(dropTitle, 'Déposez vos fichiers .txt');
    text(dropSub, 'ou cliquez pour parcourir — plusieurs fichiers acceptés');
    text(metaEl, dirParam ? 'serveur · ?dir=' + dirParam : 'local · aucun envoi');
    return;
  }
  text(dropTitle, list.length === 1 ? list[0].name : n(list.length) + ' fichiers .txt');
  text(dropSub, human(size) + ' — lus en flux, dans votre navigateur');
  text(metaEl, n(list.length) + ' fichier(s) · ' + human(size));
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

/* ============================ liste des sites ============================ */

const byWeight = (a, b) =>
  b.bytes - a.bytes || b.count - a.count || (a.site < b.site ? -1 : a.site > b.site ? 1 : 0);

function replaceSites(list) {
  SITES.clear();
  for (const entry of list || []) SITES.set(entry.site, entry);
}

function resetSites() {
  replaceSites([]);
  renderSites();
}

function renderSites() {
  if (!has(sitesEl)) return;
  const filter = (filterInput.value || '').trim().toLowerCase();
  const all = [...SITES.values()].sort(byWeight);
  const shown = filter ? all.filter((entry) => entry.site.toLowerCase().includes(filter)) : all;
  const maxBytes = all.length ? all[0].bytes || 1 : 1;

  const fragment = document.createDocumentFragment();
  shown.slice(0, LIST_LIMIT).forEach((entry, index) => {
    const li = document.createElement('li');
    if (entry.site === selected) li.className = 'selected';

    const button = document.createElement('button');
    button.type = 'button';
    button.className = 'site-row';
    if (busy) button.disabled = true;
    if (entry.site === selected && button.setAttribute) button.setAttribute('aria-current', 'true');
    button.addEventListener('click', () => openSite(entry.site));

    const rank = document.createElement('span');
    rank.className = 'rank';
    rank.textContent = String(index + 1).padStart(2, '0');

    const name = document.createElement('span');
    name.className = 'name';
    name.textContent = entry.site;
    if (name.setAttribute) name.setAttribute('title', entry.site);

    const share = document.createElement('span');
    share.className = 'share';
    const bar = document.createElement('i');
    if (bar.style) bar.style.width = Math.max(2, Math.round((entry.bytes / maxBytes) * 100)) + '%';
    share.appendChild(bar);

    const num = document.createElement('span');
    num.className = 'num';
    num.textContent = n(entry.count);

    const size = document.createElement('span');
    size.className = 'size';
    size.textContent = human(entry.bytes);

    button.append(rank, name, share, num, size);
    li.appendChild(button);
    fragment.append(li);
  });
  sitesEl.replaceChildren(fragment);

  if (has(emptyEl)) {
    emptyEl.hidden = shown.length > 0;
    text(emptyEl, SITES.size
      ? (filter ? 'aucun site ne contient « ' + filter + ' ».' : '—')
      : 'La liste apparaîtra ici, triée du plus gros au plus petit.');
  }

  const total = SITES.size;
  if (!total) {
    text(summaryEl, 'aucune analyse pour le moment');
  } else if (filter) {
    text(summaryEl, n(shown.length) + ' site(s) sur ' + n(total) +
      (shown.length > LIST_LIMIT ? ' — affichage limité à ' + n(LIST_LIMIT) + ', affinez le filtre' : ''));
  } else {
    text(summaryEl, n(total) + ' site(s)' +
      (total > LIST_LIMIT ? ' — affichage limité à ' + n(LIST_LIMIT) + ', filtrez pour en voir d’autres'
        : ' — cliquez pour voir les valeurs'));
  }
}

/* ============================ détail d'un site ============================ */

function showDetail(site) {
  selected = site;
  cls(resultsEl, 'open', true);
  if (has(resultEl)) resultEl.hidden = false;
  text(resultTitle, site);
  const entry = SITES.get(site);
  text(resultMeta, entry ? n(entry.count) + ' valeurs · ' + human(entry.bytes) : 'lecture…');
  if (has(warnEl)) warnEl.hidden = true;
  text(textEl, 'lecture…');
  saveButton.disabled = true;
  copyButton.disabled = true;
  text(saveButton, 'Télécharger ' + safeName(site) + '.txt');
  if (has(resultEl) && resultEl.scrollIntoView) {
    resultEl.scrollIntoView({ block: 'nearest' });
  }
}

function closeDetail() {
  selected = null;
  if (job) {
    job.site = null;
    job.siteText = '';
  }
  cls(resultsEl, 'open', false);
  if (has(resultEl)) resultEl.hidden = true;
  text(textEl, '');
  saveButton.disabled = true;
  copyButton.disabled = true;
  renderSites();
}

function showSiteText(site, stats, chunks) {
  const full = (job && job.siteText) || '';
  text(textEl, chunks ? trimPreview(chunks) : full.slice(0, PREVIEW_CHARS));
  const values = stats ? stats.outLines : countLines(full);
  const bytes = stats ? stats.outChars : full.length;
  const seconds = stats ? stats.ms / 1000 : 0;
  text(resultMeta, n(values) + ' valeurs · ' + human(bytes) +
    (seconds ? ' · lues en ' + secs(seconds, 2) : '') +
    (full.length > PREVIEW_CHARS
      ? ' · aperçu ' + human(PREVIEW_CHARS) + ' sur ' + human(full.length) + ', le .txt téléchargé contient tout'
      : ''));
  text(phaseEl, site + ' — ' + n(values) + ' valeurs');
  saveButton.disabled = !full;
  copyButton.disabled = !full;
}

async function openSite(site) {
  if (!job || busy) return;
  showDetail(site);
  renderSites();
  setBusy(true);
  startClock();
  setBar(0);
  barMode('idle');
  phase('lecture de ' + site);
  text(progressMetaEl, 'seconde passe : seules les valeurs de ' + site + ' sont écrites.');

  const chunks = [];
  let kept = 0;
  let capped = false;

  try {
    if (job.remote) {
      barMode('indeterminate');
      setBar(0.32);
      const started = Date.now();
      const value = await remoteSiteText(site);
      job.site = site;
      job.siteText = value;
      setBar(1);
      barMode('done');
      showSiteText(site, { outLines: countLines(value), outChars: value.length, ms: Date.now() - started });
      log(['site ' + site + ' : ' + n(countLines(value)) + ' valeurs (' + human(value.length) + ')',
        'source : serveur (dossier ?dir=' + dirParam + ')'].join('\n'));
    } else {
      const stats = await runWorker({
        type: 'group',
        source: job.source,
        options: job.opts,
        pass: { onlySite: site, count: false, maxTextBytes: MEMORY_CAP },
      }, {
        onChunk(chunk) {
          if (capped) return;
          kept += chunk.length;
          if (kept * 2 > MEMORY_CAP) {
            capped = true; // on arrête de garder le texte, les compteurs continuent
            return;
          }
          chunks.push(chunk);
          text(textEl, trimPreview(chunks));
        },
        onProgress(data) {
          report(data, job.source.size, 'lecture de ' + site);
        },
      });

      job.site = site;
      job.siteText = chunks.join('');
      setBar(1);
      barMode('done');
      showSiteText(site, stats, chunks);
      log([
        'site ' + site + ' : ' + n(stats.outLines) + ' valeurs (' + human(stats.outChars) + ') en ' +
          secs(stats.ms / 1000, 2),
        'fichier lu : ' + n(stats.bytes) + ' octets — ' + n(stats.lines) + ' lignes parcourues',
        stats.outLines === 0 ? 'aucune valeur pour ce site avec ces réglages.' : 'téléchargez le .txt, ou copiez l’aperçu.',
      ].join('\n'));

      if (capped || stats.truncated) {
        if (has(warnEl)) warnEl.hidden = false;
        text(warnEl, 'sortie trop grosse pour la mémoire du navigateur : le .txt téléchargé est partiel. ' +
          'Utilisez la CLI (node cli.js fichier --group --site=' + site + ') ou l’API (?site=' + site + ').');
      }
    }
  } catch (err) {
    barMode('idle');
    setBar(0);
    if (err.code === 'CANCELLED' || err.name === 'AbortError') {
      log('annulé.');
      phase('annulé');
    } else {
      log('erreur : ' + err.message);
      phase('erreur');
    }
    text(textEl, '');
  } finally {
    stopClock();
    setBusy(false);
    renderSites();
  }
}

/** Valeurs d'un site, lues par le serveur (?dir=…). */
async function remoteSiteText(site) {
  abortController = new AbortController();
  const query = '/api/group?site=' + encodeURIComponent(site) +
    '&mode=' + encodeURIComponent(job.opts.mode) +
    '&regex=' + encodeURIComponent(job.opts.regex) +
    '&dedupe=' + (job.opts.dedupe ? 1 : 0) +
    '&hosts=' + (job.opts.hosts ? 1 : 0) +
    '&subdomains=' + (job.opts.stripSubdomains ? 1 : 0) +
    (dirParam ? '&dir=' + encodeURIComponent(dirParam) + '&paths=1' : '');
  const response = await fetch(query, {
    method: 'POST',
    headers: { 'content-type': 'text/plain;charset=utf-8' },
    body: job.paths.join('\n'),
    signal: abortController.signal,
  });
  if (!response.ok || !response.body) {
    throw new Error('serveur : ' + response.status + ' ' + (await response.text()).slice(0, 200));
  }
  const reader = response.body.getReader();
  const chunks = [];
  let chars = 0;
  for (;;) {
    const { value, done } = await reader.read();
    if (done) break;
    const piece = new TextDecoder().decode(value, { stream: true });
    chars += piece.length;
    if (chars * 2 > MEMORY_CAP) {
      await reader.cancel();
      if (has(warnEl)) warnEl.hidden = false;
      text(warnEl, 'sortie trop grosse pour le navigateur : le .txt contiendra le début seulement. ' +
        'Utilisez l’API en direct : curl … ?site=' + site + ' -o ' + site + '.txt');
      break;
    }
    chunks.push(piece);
    text(progressMetaEl, 'lecture serveur · ' + human(chars) + ' reçus pour ' + site);
  }
  return chunks.join('');
}

/* ============================ analyse ============================ */

/** Amène un bloc sous les yeux s'il est hors écran (fin d'analyse, clic…). */
function reveal(node) {
  if (!has(node) || typeof node.getBoundingClientRect !== 'function') return;
  const rect = node.getBoundingClientRect();
  const screen = (typeof window !== 'undefined' && window.innerHeight) || 0;
  if (rect.top < screen && rect.bottom > 0) return; // déjà visible
  if (node.scrollIntoView) node.scrollIntoView({ behavior: 'smooth', block: 'start' });
}

function finishScan(stats) {
  const seconds = Math.max(stats.ms, 1) / 1000;
  setBar(1);
  barMode('done');
  renderSites();

  setTile('bytes', human(stats.bytes));
  setTile('lines', n(stats.lines));
  setTile('sites', n(stats.sites));
  setTile('values', n(stats.kept));
  setTile('speed', human(stats.bytes / seconds) + '/s');
  setTile('time', secs(seconds, 2));
  text(progressMetaEl, n(stats.bytes) + ' octets · ' + n(stats.lines) + ' lignes · ' +
    n(stats.sites) + ' sites · ' + n(stats.kept) + ' valeurs · ' + secs(seconds, 2));
  phase(stats.kept ? 'terminé — cliquez sur un site' : 'terminé — aucune valeur');

  log([
    'terminé.',
    'lu : ' + n(stats.bytes) + ' octets (' + human(stats.bytes) + ') en ' + secs(seconds, 2) +
      ' (' + human(stats.bytes / seconds) + '/s)',
    'lignes : ' + n(stats.lines) + ' — avec couple : ' + n(stats.matched) + ' — ignorées : ' + n(stats.skipped),
    'sites : ' + n(stats.sites) + ' — valeurs : ' + n(stats.kept) + ' (' + human(stats.bytes) + ')',
    stats.kept === 0
      ? 'aucune valeur trouvée — essayez un autre mode, ou une regex perso.'
      : 'cliquez sur un site pour afficher ses valeurs.',
  ].join('\n'));

  if (stats.sites) reveal(resultsEl);
}

async function scan() {
  let opts;
  try {
    opts = options();
  } catch (err) {
    log(err.message);
    phase('réglage invalide');
    return;
  }

  const files = Array.from(fileInput.files || []);
  const listed = (pathsInput.value || '').split('\n').map((line) => line.trim()).filter(Boolean);

  closeDetail();
  resetSites();
  resetTiles();
  setBusy(true);
  startClock();
  setBar(0);
  barMode('idle');
  phase('préparation');

  try {
    if (files.length === 0) {
      if (listed.length === 0) throw new Error('choisissez un fichier .txt (ou une liste avec ?dir=…).');
      if (!dirParam) {
        throw new Error('le navigateur ne peut pas lire un chemin local : ajoutez ?dir=/dossier à l’URL, ' +
          'ou utilisez l’API curl / la CLI.');
      }
      await remoteScan(listed, opts);
      return;
    }

    const { source, base } = sourceFromFiles(files);
    job = { source, opts, base, remote: false, paths: null, stats: null, site: null, siteText: '' };
    phase('analyse du fichier');
    text(progressMetaEl, 'première passe : les lignes sont rangées par site, seules les valeurs sont gardées.');

    const stats = await runWorker({
      type: 'group',
      source,
      options: opts,
      pass: { count: true, maxTextBytes: 0 },
    }, {
      onSites(data) {
        replaceSites(data.sites);
        renderSites();
        phase('analyse — ' + n(SITES.size) + ' site(s) en cours');
      },
      onProgress(data) {
        report(data, source.size, 'analyse');
      },
    });

    job.stats = stats;
    finishScan(stats);
  } catch (err) {
    barMode('idle');
    setBar(0);
    if (err.code === 'CANCELLED' || err.name === 'AbortError') {
      log('annulé.');
      phase('annulé');
    } else {
      log('erreur : ' + err.message);
      phase('erreur');
    }
  } finally {
    stopClock();
    setBusy(false);
    renderSites();
  }
}

/** Analyse faite par le serveur (dossier ?dir=…). */
async function remoteScan(paths, opts) {
  job = { source: null, opts, base: 'zach-db', remote: true, paths, stats: null, site: null, siteText: '' };
  phase('analyse côté serveur');
  barMode('indeterminate');
  setBar(0.32);
  text(progressMetaEl, 'le serveur lit le dossier ' + dirParam + ' et renvoie la liste des sites.');
  abortController = new AbortController();

  const query = '/api/group?format=json' +
    '&mode=' + encodeURIComponent(opts.mode) +
    '&regex=' + encodeURIComponent(opts.regex) +
    '&dedupe=' + (opts.dedupe ? 1 : 0) +
    '&hosts=' + (opts.hosts ? 1 : 0) +
    '&subdomains=' + (opts.stripSubdomains ? 1 : 0) +
    '&dir=' + encodeURIComponent(dirParam) + '&paths=1';
  const response = await fetch(query, {
    method: 'POST',
    headers: { 'content-type': 'text/plain;charset=utf-8' },
    body: paths.join('\n'),
    signal: abortController.signal,
  });
  const payload = await response.json();
  if (!response.ok) throw new Error(payload.error || ('serveur : ' + response.status));

  replaceSites(payload.sites);
  setBar(1);
  barMode('done');
  setTile('sites', n(payload.total));
  setTile('values', n(payload.stats.kept));
  setTile('lines', n(payload.stats.lines || 0));
  setTile('bytes', human(payload.stats.bytes || 0));
  text(progressMetaEl, n(payload.total) + ' sites · ' + n(payload.stats.kept) + ' valeurs · analyse serveur');
  phase('terminé — cliquez sur un site');
  log([
    'terminé (côté serveur).',
    'sites : ' + n(payload.total) + ' — valeurs : ' + n(payload.stats.kept),
    'cliquez sur un site pour voir ses valeurs.',
  ].join('\n'));
  if (payload.total) reveal(resultsEl);
}

/* ============================ écouteurs ============================ */

form.addEventListener('submit', (event) => {
  event.preventDefault();
  if (busy) return;
  scan();
});

form.addEventListener('change', syncMode);

cancelButton.addEventListener('click', () => {
  cancelWorker();
  phase('annulation…');
  log('annulation…');
});

regexInput.addEventListener('input', () => {
  if (!(regexInput.value || '').trim()) return;
  const custom = form.querySelector('input[name="mode"][value="custom"]');
  if (custom) custom.checked = true;
  syncMode();
});

fileInput.addEventListener('change', describeFiles);

/* dépôt direct de fichiers sur la zone */
if (has(drop)) {
  for (const type of ['dragenter', 'dragover']) {
    drop.addEventListener(type, (event) => {
      if (event.preventDefault) event.preventDefault();
      cls(drop, 'over', true);
    });
  }
  for (const type of ['dragleave', 'dragend']) {
    drop.addEventListener(type, () => cls(drop, 'over', false));
  }
  drop.addEventListener('drop', (event) => {
    if (event.preventDefault) event.preventDefault();
    cls(drop, 'over', false);
    if (busy) return;
    const transferred = event.dataTransfer && event.dataTransfer.files;
    if (transferred && transferred.length) {
      try {
        fileInput.files = transferred;
      } catch {
        /* certains navigateurs refusent l'affectation : le dépôt natif a déjà rempli le champ */
      }
      describeFiles();
    }
  });
}

filterInput.addEventListener('input', renderSites);

backButton.addEventListener('click', () => {
  closeDetail();
  if (has(sitesEl) && sitesEl.scrollIntoView) sitesEl.scrollIntoView({ block: 'nearest' });
});

saveButton.addEventListener('click', () => {
  if (!job || !job.siteText) return;
  download(textBlob(job.siteText), safeName(job.site || 'zach-db') + '.txt');
  flash(saveButton, 'Téléchargé');
});

copyButton.addEventListener('click', async () => {
  const value = job && job.siteText;
  if (!value) return;
  const clipboard = globalThis.navigator && navigator.clipboard;
  if (clipboard && clipboard.writeText) {
    try {
      await clipboard.writeText(value);
      flash(copyButton, 'Copié');
      return;
    } catch {
      /* on tente la méthode de secours */
    }
  }
  flash(copyButton, legacyCopy(value) ? 'Copié' : 'Copie impossible');
});

function legacyCopy(value) {
  try {
    const area = document.createElement('textarea');
    area.value = value;
    if (area.style) {
      area.style.position = 'fixed';
      area.style.opacity = '0';
    }
    document.body.appendChild(area);
    if (area.focus) area.focus();
    if (area.select) area.select();
    const ok = typeof document.execCommand === 'function' && document.execCommand('copy');
    area.remove();
    return !!ok;
  } catch {
    return false;
  }
}

exportButton.addEventListener('click', () => {
  if (!SITES.size) return;
  const rows = [...SITES.values()].sort(byWeight)
    .map((entry) => entry.site + '\t' + entry.count + '\t' + entry.bytes);
  download(textBlob(rows.join('\n') + '\n'), 'zach-db-sites-' + stamp() + '.tsv');
  flash(exportButton, 'Liste exportée');
});

document.addEventListener('keydown', (event) => {
  if (event.key === 'Escape' && has(resultEl) && !resultEl.hidden) closeDetail();
});

/* surbrillance de la section visible dans la navigation */
function initSpy() {
  const nav = el('nav');
  if (typeof IntersectionObserver !== 'function' || !nav || !nav.querySelectorAll) return;
  const pairs = [];
  for (const link of Array.from(nav.querySelectorAll('a[data-spy]'))) {
    const id = link.dataset ? link.dataset.spy : link.getAttribute('data-spy');
    const section = document.getElementById(id);
    if (section) pairs.push([section, link]);
  }
  if (!pairs.length) return;
  const observer = new IntersectionObserver((entries) => {
    for (const entry of entries) {
      if (!entry.isIntersecting) continue;
      const pair = pairs.find((item) => item[0] === entry.target);
      if (!pair) continue;
      for (const item of pairs) cls(item[1], 'active', item === pair);
    }
  }, { rootMargin: '-70px 0px -60% 0px', threshold: 0 });
  for (const pair of pairs) observer.observe(pair[0]);
}

/* ============================ démarrage ============================ */

if (dirParam) {
  if (has(pathsBox)) pathsBox.hidden = false;
  pathsInput.placeholder = 'un nom de fichier par ligne, lu dans le dossier ' + dirParam;
  text(metaEl, 'serveur · ?dir=' + dirParam);
}

syncMode();
describeFiles();
renderSites();
initSpy();
ensureWorker();
log(dirParam
  ? 'prêt — lecture du dossier serveur ' + dirParam + '.'
  : 'prêt — déposez un .txt : il est lu et trié ici, aucun octet n’est envoyé.');
