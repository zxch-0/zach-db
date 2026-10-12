/*
 * zach-db — interface.
 *
 * Onglet 1 « Extraire » : sort les couples xxxx:xxxx d'un fichier.
 * Onglet 2 « Trier par site » : range les lignes par site (roblox.com,
 *   netflix.com, …) puis affiche les valeurs d'un site au clic.
 *
 * Dans les deux cas : lecture en flux dans un Web Worker, passages successifs
 * (compter puis collecter) pour garder une mémoire bornée, rien n'est envoyé.
 *
 * Cas particulier : si l'URL contient ?dir=/dossier, le serveur lit les
 * fichiers (flux HTTP) au lieu du disque du navigateur.
 */
const SMALL = 16 * 1024 * 1024; // en dessous : une seule passe
const PART = 32 * 1024 * 1024; // taille visée pour chaque fichier de sortie
const MEMORY_CAP = 64 * 1024 * 1024; // garde-fou mémoire
const PREVIEW_CHARS = 48 * 1024;
const LIST_LIMIT = 1000; // lignes de sites affichées d'un coup

const el = (id) => document.getElementById(id);
const fmt = new Intl.NumberFormat('fr-FR');
const n = (value) => fmt.format(value);
const mb = (bytes) => (bytes / 1048576).toFixed(1) + ' Mo';
const dirParam = new URL(location.href).searchParams.get('dir');

let worker = null;
let passId = 0;
let abortController = null;

/* ================= onglets ================= */

const TABS = [
  { name: 'extract', tab: el('tab-extract'), panel: el('panel-extract') },
  { name: 'sites', tab: el('tab-sites'), panel: el('panel-sites') },
];

function showTab(name, updateHash = true) {
  for (const item of TABS) {
    const active = item.name === name;
    item.tab.setAttribute('aria-selected', String(active));
    item.panel.hidden = !active;
  }
  if (updateHash) history.replaceState(null, '', name === 'sites' ? '#sites' : location.pathname + location.search);
}

for (const item of TABS) item.tab.addEventListener('click', () => showTab(item.name));

/* ================= Web Worker ================= */

function ensureWorker() {
  if (worker) return worker;
  worker = new Worker('/worker.js', { type: 'module' });
  worker.onerror = (event) => {
    el('status').textContent = 'erreur worker : ' + (event.message || 'inconnue');
    el('gstatus').textContent = 'erreur worker : ' + (event.message || 'inconnue');
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

/* ================= outils communs ================= */

function trimPreview(chunks, limit = PREVIEW_CHARS) {
  let text = '';
  for (const chunk of chunks) {
    text += chunk;
    if (text.length >= limit) return text.slice(0, limit) + '\n[...]';
  }
  return text;
}

function stamp() {
  const now = new Date();
  const pad = (value) => String(value).padStart(2, '0');
  return now.getFullYear() + pad(now.getMonth() + 1) + pad(now.getDate()) + '-' +
    pad(now.getHours()) + pad(now.getMinutes()) + pad(now.getSeconds());
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

function readMode(form, name, regexInput, label) {
  const mode = form.querySelector('input[name="' + name + '"]:checked').value;
  const regex = regexInput.value.trim();
  if (mode === 'custom') {
    try {
      new RegExp(regex || '([a-z0-9._-]+):([a-z0-9._-]+)'); // validation avant lancement
    } catch (err) {
      throw new Error('regex invalide : ' + err.message);
    }
  }
  return { mode, regex };
}

function cleanName(name) {
  return (name || 'zach-db').replace(/\.[^.]+$/, '').replace(/[^\w.-]+/g, '_') || 'zach-db';
}

/* ==================================================================
 * Onglet 1 — Extraire
 * ================================================================== */

const form = el('form');
const fileInput = el('file');
const filesInput = el('files');
const regexInput = el('regex');
const dedupeInput = el('dedupe');
const hostsInput = el('hosts');
const runButton = el('run');
const cancelButton = el('cancel');
const downloadButton = el('download');
const statusEl = el('status');
const previewBox = el('previewBox');
const preview = el('preview');
const metaEl = el('meta');

let busy = false;
let current = null; // { opts, base, multipart, stats, names }

function extractOptions() {
  const { mode, regex } = readMode(form, 'mode', regexInput);
  return { mode, regex, dedupe: dedupeInput.checked, hosts: hostsInput.checked };
}

function setBusy(value) {
  busy = value;
  runButton.disabled = value;
  cancelButton.disabled = !value;
  fileInput.disabled = value;
  filesInput.disabled = value;
  if (value) downloadButton.disabled = true;
}

/** Extraction locale : une passe si c'est petit, sinon comptage puis tranches. */
async function extractPass({ source, opts, count = false, skip = 0, limit = Infinity, label = 'lecture' }) {
  const chunks = [];
  const started = Date.now();
  let keptChars = 0;
  let tooBig = false;

  try {
    const stats = await runWorker({ type: 'pass', source, options: opts, pass: { count, skip, limit } }, {
      onChunk(chunk) {
        if (tooBig) return;
        keptChars += chunk.length;
        if (keptChars * 2 > MEMORY_CAP) {
          tooBig = true;
          worker.postMessage({ type: 'cancel' });
          return;
        }
        chunks.push(chunk);
        preview.textContent = trimPreview(chunks);
      },
      onProgress(data) {
        statusEl.textContent = progressLine(label, data, source.size, started);
      },
    });
    return { text: count ? null : chunks.join(''), tooBig: false, stats };
  } catch (err) {
    if (err.code === 'CANCELLED' && tooBig) return { text: null, tooBig: true, stats: null };
    throw err;
  }
}

function progressLine(label, data, total, started) {
  const seconds = (Date.now() - started) / 1000;
  const percent = total ? ' ' + Math.floor((data.loaded / total) * 100) + '%' : '';
  const speed = seconds > 0.2 ? ' — ' + (data.lines / seconds / 1e6).toFixed(1) + ' M lignes/s' : '';
  return label + '…' + percent + ' ' + n(data.loaded) + ' / ' + n(total) + ' octets — ' +
    n(data.lines) + ' lignes — ' + n(data.matched) + ' couples' + speed;
}

function localFiles() {
  return Array.from(fileInput.files || []);
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

function partName(base, index, total) {
  if (total <= 1) return base + '-' + stamp() + '.txt';
  return base + '-part' + String(index + 1).padStart(3, '0') + '.txt';
}

async function runLocal(source, base, opts) {
  current = { opts, base, multipart: 1, stats: null, names: [] };
  previewBox.hidden = false;

  if (source.size <= SMALL) {
    const result = await extractPass({ source, opts, label: 'extraction' });
    if (!result.tooBig) {
      const name = partName(base, 0, 1);
      download(textBlob(result.text), name);
      finish(result.stats, [name]);
      return;
    }
  }
  return runLocalMultiPass(source, base, opts);
}

async function runLocalMultiPass(source, base, opts) {
  statusEl.textContent = 'comptage…';
  const counted = await extractPass({ source, opts, count: true, label: 'comptage' });
  const stats = counted.stats;
  current.stats = stats;

  if (stats.matched === 0) {
    finish(stats, []);
    return;
  }

  const parts = Math.max(1, Math.ceil(stats.outChars / PART));
  current.multipart = parts;
  const names = [];
  let skip = 0;

  for (let index = 0; index < parts; index++) {
    const result = await extractPass({
      source,
      opts,
      skip,
      limit: PART,
      label: 'extraction partie ' + (index + 1) + '/' + parts,
    });
    if (!result.text) break;
    const name = partName(base, index, parts);
    download(textBlob(result.text), name);
    names.push(name);
    skip += result.stats.emittedBytes;
  }

  finish(stats, names);
}

/** Extraction depuis des fichiers du serveur (?dir=…). */
async function runRemote(paths, opts) {
  current = { opts, base: 'zach-db', multipart: 1, stats: null, names: [] };
  previewBox.hidden = false;
  preview.textContent = '';
  statusEl.textContent = 'lecture serveur…';

  abortController = new AbortController();
  const started = Date.now();
  const query = '/api/extract?mode=' + encodeURIComponent(opts.mode) +
    '&regex=' + encodeURIComponent(opts.regex) + '&dedupe=' + (opts.dedupe ? 1 : 0) +
    '&hosts=' + (opts.hosts ? 1 : 0) +
    (dirParam ? '&dir=' + encodeURIComponent(dirParam) + '&paths=1' : '');
  const response = await fetch(query, {
    method: 'POST',
    headers: { 'content-type': 'text/plain;charset=utf-8' },
    body: paths.join('\n'),
    signal: abortController.signal,
  });
  if (!response.ok || !response.body) {
    throw new Error('serveur : ' + response.status + ' ' + (await response.text()).slice(0, 300));
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
      throw new Error('sortie trop volumineuse pour le navigateur — utilisez l’API curl (voir plus bas).');
    }
    chunks.push(text);
    statusEl.textContent = 'lecture serveur… ' + mb(chars) + ' reçus en ' +
      ((Date.now() - started) / 1000).toFixed(1) + ' s';
    preview.textContent = trimPreview(chunks);
  }

  const text = chunks.join('');
  const name = 'zach-db-' + stamp() + '.txt';
  download(textBlob(text), name);
  finish({
    bytes: 0, lines: 0, matched: countLines(text), outLines: countLines(text),
    outChars: text.length, ms: Date.now() - started,
  }, [name], true);
}

function finish(stats, names, remote = false) {
  const seconds = Math.max(stats.ms, 1) / 1000;
  const lines = ['terminé.'];
  if (remote) {
    lines.push('source : serveur (le serveur lit les fichiers, le navigateur écrit le .txt)');
  } else {
    lines.push('lu : ' + n(stats.bytes) + ' octets (' + mb(stats.bytes) + ') en ' + seconds.toFixed(2) +
      ' s (' + mb(stats.bytes / seconds) + '/s)');
  }
  if (stats.lines) lines.push('lignes : ' + n(stats.lines) + ' — couples trouvés : ' + n(stats.matched));
  lines.push('sortie : ' + n(stats.outLines) + ' lignes (' + mb(stats.outChars) + ')');
  if (names.length === 1) lines.push('fichier téléchargé : ' + names[0]);
  else if (names.length > 1) lines.push(names.length + ' fichiers téléchargés : ' + names.join(', '));
  if (stats.matched === 0) lines.push('aucun couple trouvé — essayez un autre mode ou une regex perso.');
  statusEl.textContent = lines.join('\n');

  downloadButton.disabled = stats.matched === 0;
  downloadButton.textContent = current && current.multipart > 1
    ? 'Relancer l’export (' + current.multipart + ' fichiers)'
    : 'Télécharger .txt';
  setBusy(false);
}

form.addEventListener('submit', async (event) => {
  event.preventDefault();
  if (busy) return;

  let opts;
  try {
    opts = extractOptions();
  } catch (err) {
    statusEl.textContent = err.message;
    return;
  }

  const files = localFiles();
  const listed = filesInput.value.split('\n').map((line) => line.trim()).filter(Boolean);
  preview.textContent = '';
  downloadButton.textContent = 'Télécharger .txt';
  setBusy(true);

  try {
    if (files.length === 0) {
      if (listed.length === 0) throw new Error('choisissez un fichier .txt (ou une liste avec ?dir=…).');
      if (!dirParam) {
        throw new Error('lecture de chemins locaux impossible depuis le navigateur : utilisez ?dir=/dossier, l’API curl ou la CLI.');
      }
      await runRemote(listed, opts);
      return;
    }
    const { source, base } = sourceFromFiles(files);
    await runLocal(source, base, opts);
  } catch (err) {
    if (err.code === 'CANCELLED' || err.name === 'AbortError') statusEl.textContent = 'annulé.';
    else statusEl.textContent = 'erreur : ' + err.message;
    setBusy(false);
  }
});

cancelButton.addEventListener('click', () => {
  cancelWorker();
  statusEl.textContent = 'annulation…';
});

downloadButton.addEventListener('click', async () => {
  if (!current || busy) return;
  const files = localFiles();
  if (files.length === 0) return;
  setBusy(true);
  try {
    const { source, base } = sourceFromFiles(files);
    await runLocal(source, base, current.opts);
  } catch (err) {
    if (err.code !== 'CANCELLED') statusEl.textContent = 'erreur : ' + err.message;
    setBusy(false);
  }
});

fileInput.addEventListener('change', () => {
  const list = fileInput.files || [];
  if (list.length) {
    let size = 0;
    for (const file of list) size += file.size;
    metaEl.textContent = n(list.length) + ' fichier(s) · ' + mb(size);
  }
});

regexInput.addEventListener('input', () => {
  if (regexInput.value.trim()) form.querySelector('input[name="mode"][value="custom"]').checked = true;
});

/* ==================================================================
 * Onglet 2 — Trier par site
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
    info.textContent = n(entry.count) + (entry.count > 1 ? ' valeurs' : ' valeur') + ' · ' + mb(entry.bytes);
    li.append(button, ' ', info);
    fragment.append(li);
  }
  gsitesEl.replaceChildren(fragment);

  const total = GROUP_SITES.size;
  if (filter) {
    gsummaryEl.textContent = entries.length + ' site(s) sur ' + n(total) + ' — ' +
      (entries.length > LIST_LIMIT ? 'affichage limité à ' + LIST_LIMIT + ', affinez le filtre' : 'cliquez sur un site');
  } else if (total === 0) {
    gsummaryEl.textContent = 'aucun site pour le moment.';
  } else {
    gsummaryEl.textContent = n(total) + ' site(s) — ' +
      (total > LIST_LIMIT ? 'affichage limité à ' + LIST_LIMIT + ' (filtrez pour en voir d’autres)' : 'cliquez sur un site');
  }
}

/** Écran de lecture d'un site. */
function showSiteTitle(site) {
  const entry = GROUP_SITES.get(site);
  gtitreEl.textContent = site + (entry ? ' — ' + n(entry.count) + ' valeurs · ' + mb(entry.bytes) : '');
  gresultEl.hidden = false;
  gwarnEl.hidden = true;
  gtextEl.textContent = 'lecture…';
  gsaveButton.disabled = true;
  gresultEl.scrollIntoView({ block: 'nearest' });
}

async function openSite(site) {
  if (!groupJob || groupBusy) return;
  showSiteTitle(site);
  setGroupBusy(true);
  const chunks = [];
  let kept = 0;
  let full = false;
  const started = Date.now();

  try {
    if (groupJob.remote) {
      const text = await remoteSiteText(site);
      gtextEl.textContent = trimPreview([text]);
      groupJob.site = site;
      groupJob.siteText = text;
      gstatusEl.textContent = 'site ' + site + ' : ' + n(countLines(text)) + ' valeurs (' +
        mb(text.length) + ') en ' + ((Date.now() - started) / 1000).toFixed(2) + ' s';
    } else {
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
          gstatusEl.textContent = 'site ' + site + '… ' + n(data.loaded) + ' / ' + n(groupJob.source.size) +
            ' octets — ' + n(data.kept) + ' valeurs';
        },
      });

      groupJob.site = site;
      groupJob.siteText = chunks.join('');
      gtextEl.textContent = trimPreview(chunks);
      gstatusEl.textContent = 'site ' + site + ' : ' + n(stats.outLines) + ' valeurs (' +
        mb(stats.outChars) + ') en ' + (stats.ms / 1000).toFixed(2) + ' s';
      if (full || stats.truncated) {
        gwarnEl.hidden = false;
        gwarnEl.textContent = 'sortie trop grosse pour la mémoire du navigateur : le .txt téléchargé est ' +
          'partiel. Utilisez la CLI (node cli.js fichier --group --site=' + site + ') ou l’API (?site=' + site + ').';
      }
    }
    gsaveButton.disabled = !groupJob.siteText;
  } catch (err) {
    if (err.code === 'CANCELLED') gstatusEl.textContent = 'annulé.';
    else gstatusEl.textContent = 'erreur : ' + err.message;
    gtextEl.textContent = '';
  } finally {
    gsaveButton.textContent = 'Télécharger ' + site + '.txt';
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
    throw new Error('serveur : ' + response.status + ' ' + (await response.text()).slice(0, 200));
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
      gwarnEl.textContent = 'sortie trop grosse pour le navigateur : le .txt contiendra le début seulement. ' +
        'Utilisez l’API en direct : curl … ?site=' + site + ' -o ' + site + '.txt';
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
  setGroupBusy(true);

  try {
    if (files.length === 0) {
      if (listed.length === 0) throw new Error('choisissez un fichier .txt (ou une liste avec ?dir=…).');
      if (!dirParam) throw new Error('lecture de chemins locaux impossible depuis le navigateur : utilisez ?dir=/dossier, l’API curl ou la CLI.');
      await groupRemoteScan(listed, opts);
      return;
    }

    const { source, base } = sourceFromFiles(files);
    groupJob = { source, opts, base, remote: false, stats: null };
    gstatusEl.textContent = 'analyse…';

    const stats = await runWorker({
      type: 'group',
      source,
      options: opts,
      pass: { count: true, maxTextBytes: 0 },
    }, {
      onSites(data) {
        replaceSites(data.sites);
        renderSites();
        gstatusEl.textContent = 'analyse… ' + n(GROUP_SITES.size) + ' sites sur ' + n(data.total) +
          (data.live ? ' (liste en cours)' : '');
      },
      onProgress(data) {
        gstatusEl.textContent = 'analyse… ' + n(data.loaded) + ' / ' + n(source.size) + ' octets — ' +
          n(data.lines) + ' lignes — ' + n(data.sites) + ' sites';
      },
    });

    groupJob.stats = stats;
    gstatusEl.textContent = [
      'terminé.',
      'lu : ' + n(stats.bytes) + ' octets (' + mb(stats.bytes) + ') en ' + (stats.ms / 1000).toFixed(2) + ' s',
      'lignes : ' + n(stats.lines) + ' — avec couple : ' + n(stats.matched) + ' — ignorées : ' + n(stats.skipped),
      'sites : ' + n(stats.sites) + ' — valeurs : ' + n(stats.kept) + ' (' + mb(stats.bytes) + ')',
      'cliquez sur un site pour voir ses valeurs.',
    ].join('\n');
    renderSites();
  } catch (err) {
    if (err.code === 'CANCELLED' || err.name === 'AbortError') gstatusEl.textContent = 'annulé.';
    else gstatusEl.textContent = 'erreur : ' + err.message;
  } finally {
    setGroupBusy(false);
  }
}

async function groupRemoteScan(paths, opts) {
  groupJob = { opts, remote: true, paths, base: 'zach-db', stats: null };
  gstatusEl.textContent = 'analyse serveur…';
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
  if (!response.ok) throw new Error(payload.error || ('serveur : ' + response.status));
  replaceSites(payload.sites);
  renderSites();
  gstatusEl.textContent = [
    'terminé (côté serveur).',
    'sites : ' + n(payload.total) + ' — valeurs : ' + n(payload.stats.kept),
    'cliquez sur un site pour voir ses valeurs.',
  ].join('\n');
}

groupForm.addEventListener('submit', async (event) => {
  event.preventDefault();
  if (groupBusy) return;
  await groupScan();
});

gcancelButton.addEventListener('click', () => {
  cancelWorker();
  gstatusEl.textContent = 'annulation…';
});

gfilterInput.addEventListener('input', renderSites);

gsaveButton.addEventListener('click', () => {
  if (!groupJob || !groupJob.siteText) return;
  const name = (groupJob.site || 'zach-db').replace(/[^\w.-]+/g, '_') + '.txt';
  download(textBlob(groupJob.siteText), name);
});

gprevButton.addEventListener('click', () => {
  gresultEl.hidden = true;
  gtitreEl.textContent = 'site';
});

gfileInput.addEventListener('change', () => {
  const list = gfileInput.files || [];
  if (list.length) {
    let size = 0;
    for (const file of list) size += file.size;
    metaEl.textContent = n(list.length) + ' fichier(s) · ' + mb(size);
  }
});

gregexInput.addEventListener('input', () => {
  if (gregexInput.value.trim()) groupForm.querySelector('input[name="gmode"][value="custom"]').checked = true;
});

/* ================= démarrage ================= */

metaEl.textContent = dirParam ? 'traitement serveur · ?dir=' + dirParam : 'traitement local · 0 envoi';
if (dirParam) {
  filesInput.placeholder = 'un nom de fichier par ligne, lu dans le dossier ' + dirParam;
  gfilesInput.placeholder = filesInput.placeholder;
}
if (location.hash === '#sites') showTab('sites', false);
renderSites();
ensureWorker();
