/*
 * zach-db — interface.
 * 1) le fichier est lu en flux dans un Web Worker (rien n'est envoyé nulle part) ;
 * 2) une passe "comptage" mesure la sortie sans la garder en mémoire ;
 * 3) une passe "collecte" produit le(s) fichier(s) .txt.
 * La mémoire reste donc bornée, quelle que soit la taille du fichier.
 *
 * Cas particulier : si l'URL contient ?dir=/dossier, la liste de fichiers est
 * lue par le serveur (flux HTTP) au lieu du disque du navigateur.
 */
const SMALL = 16 * 1024 * 1024; // en dessous : une seule passe
const PART = 32 * 1024 * 1024; // taille visée pour chaque fichier de sortie
const MEMORY_CAP = 64 * 1024 * 1024; // garde-fou mémoire
const PREVIEW_CHARS = 48 * 1024;

const el = (id) => document.getElementById(id);
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

const fmt = new Intl.NumberFormat('fr-FR');
const n = (value) => fmt.format(value);
const mb = (bytes) => (bytes / 1048576).toFixed(1) + ' Mo';
const dirParam = new URL(location.href).searchParams.get('dir');

let worker = null;
let passId = 0;
let abortController = null;
let busy = false;
let current = null; // { opts, base, multipart, stats, names }

/* ---------- worker ---------- */

function ensureWorker() {
  if (worker) return worker;
  worker = new Worker('/worker.js', { type: 'module' });
  worker.onerror = (event) => {
    statusEl.textContent = 'erreur worker : ' + (event.message || 'inconnue');
    setBusy(false);
  };
  return worker;
}

function options() {
  const mode = form.querySelector('input[name="mode"]:checked').value;
  const regex = regexInput.value.trim();
  if (mode === 'custom') {
    try {
      // on valide la regex avant de lancer quoi que ce soit
      new RegExp(regex || '([a-z0-9._-]+):([a-z0-9._-]+)');
    } catch (err) {
      throw new Error('regex invalide : ' + err.message);
    }
  }
  return { mode, regex, dedupe: dedupeInput.checked, hosts: hostsInput.checked };
}

/** Une passe dans le worker. Résout { text, tooBig, stats }. */
function runPass({ source, opts, count = false, skip = 0, limit = Infinity, label = 'lecture' }) {
  const id = ++passId;
  const chunks = [];
  const started = Date.now();
  let keptChars = 0;
  let tooBig = false;

  return new Promise((resolve, reject) => {
    const onMessage = (event) => {
      const data = event.data || {};
      if (data.id !== id) return;

      if (data.type === 'chunk') {
        if (tooBig) return;
        keptChars += data.data.length;
        if (keptChars * 2 > MEMORY_CAP) {
          tooBig = true;
          worker.postMessage({ type: 'cancel' });
          return;
        }
        chunks.push(data.data);
        preview.textContent = trimPreview(chunks);
        return;
      }

      if (data.type === 'progress') {
        statusEl.textContent = progressLine(label, data, source.size, started);
        return;
      }

      worker.removeEventListener('message', onMessage);
      if (data.type === 'done') {
        resolve({
          text: count ? null : chunks.join(''),
          tooBig,
          stats: data,
        });
      } else if (data.type === 'cancelled') {
        if (tooBig) resolve({ text: null, tooBig: true, stats: null });
        else reject(Object.assign(new Error('annulé'), { code: 'CANCELLED' }));
      } else if (data.type === 'error') {
        reject(new Error(data.message));
      }
    };

    worker.addEventListener('message', onMessage);
    worker.postMessage({
      type: 'pass',
      id,
      source,
      options: opts,
      pass: { count, skip, limit },
    });
  });
}

function progressLine(label, data, total, started) {
  const seconds = (Date.now() - started) / 1000;
  const percent = total ? ' ' + Math.floor((data.loaded / total) * 100) + '%' : '';
  const speed = seconds > 0.2 ? ' — ' + (data.lines / seconds / 1e6).toFixed(1) + ' M lignes/s' : '';
  return label + '…' + percent + ' ' + n(data.loaded) + ' / ' + n(total) + ' octets — ' +
    n(data.lines) + ' lignes — ' + n(data.matched) + ' couples' + speed;
}

function trimPreview(chunks) {
  let text = '';
  for (const chunk of chunks) {
    text += chunk;
    if (text.length >= PREVIEW_CHARS) return text.slice(0, PREVIEW_CHARS) + '\n[...]';
  }
  return text;
}

/* ---------- sortie ---------- */

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

function cleanName(name) {
  return (name || 'zach-db').replace(/\.[^.]+$/, '').replace(/[^\w.-]+/g, '_') || 'zach-db';
}

function partName(base, index, total) {
  if (total <= 1) return base + '-' + stamp() + '.txt';
  return base + '-part' + String(index + 1).padStart(3, '0') + '.txt';
}

/* ---------- traitement d'un fichier local ---------- */

async function runLocal(source, base, opts) {
  current = { opts, base, multipart: 1, stats: null, names: [] };
  previewBox.hidden = false;

  if (source.size > SMALL) {
    return runLocalMultiPass(source, base, opts);
  }

  const result = await runPass({ source, opts, label: 'extraction' });
  if (result.tooBig) return runLocalMultiPass(source, base, opts);

  const name = partName(base, 0, 1);
  download(textBlob(result.text), name);
  finish(result.stats, [name]);
}

async function runLocalMultiPass(source, base, opts) {
  statusEl.textContent = 'comptage…';
  const counted = await runPass({ source, opts, count: true, label: 'comptage' });
  const stats = counted.stats;
  const totalOut = stats.outChars;
  current.stats = stats;

  if (stats.matched === 0) {
    finish(stats, []);
    return;
  }

  const parts = Math.max(1, Math.ceil(totalOut / PART));
  current.multipart = parts;
  const names = [];
  let skip = 0;

  for (let index = 0; index < parts; index++) {
    const result = await runPass({
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

/* ---------- traitement côté serveur (?dir=/dossier) ---------- */

async function runRemote(paths, opts) {
  const base = 'zach-db';
  current = { opts, base, multipart: 1, stats: null, names: [] };
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
    const elapsed = (Date.now() - started) / 1000;
    statusEl.textContent = 'lecture serveur… ' + mb(chars) + ' reçus en ' + elapsed.toFixed(1) + ' s';
    preview.textContent = trimPreview(chunks);
  }

  const text = chunks.join('');
  const outLines = text ? countLines(text) : 0;
  const name = base + '-' + stamp() + '.txt';
  download(textBlob(text), name);
  finish({
    bytes: 0, lines: 0, matched: outLines, outLines, outChars: text.length,
    ms: Date.now() - started,
  }, [name], true);
}

function countLines(text) {
  let count = 0;
  let index = -1;
  while ((index = text.indexOf('\n', index + 1)) !== -1) count++;
  return count;
}

/* ---------- fin ---------- */

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

function setBusy(value) {
  busy = value;
  runButton.disabled = value;
  cancelButton.disabled = !value;
  fileInput.disabled = value;
  filesInput.disabled = value;
  if (value) downloadButton.disabled = true;
}

/* ---------- événements ---------- */

form.addEventListener('submit', async (event) => {
  event.preventDefault();
  if (busy) return;

  let opts;
  try {
    opts = options();
  } catch (err) {
    statusEl.textContent = err.message;
    return;
  }

  const files = Array.from(fileInput.files || []);
  const listed = filesInput.value.split('\n').map((line) => line.trim()).filter(Boolean);
  preview.textContent = '';
  downloadButton.textContent = 'Télécharger .txt';
  setBusy(true);

  try {
    if (files.length === 0) {
      if (listed.length === 0) throw new Error('choisissez un fichier .txt (ou une liste de fichiers avec ?dir=…).');
      if (!dirParam) {
        throw new Error('lecture de chemins locaux impossible depuis le navigateur : utilisez ?dir=/dossier, l’API curl ou la CLI.');
      }
      await runRemote(listed, opts);
      return;
    }
    if (files.length === 1) {
      await runLocal(files[0], cleanName(files[0].name), opts);
    } else {
      // plusieurs fichiers : concaténés dans un Blob (aucune copie des données)
      const parts = [];
      files.forEach((file, index) => {
        if (index) parts.push('\n');
        parts.push(file);
      });
      await runLocal(new Blob(parts, { type: 'text/plain' }), 'zach-db', opts);
    }
  } catch (err) {
    if (err.code === 'CANCELLED' || err.name === 'AbortError') statusEl.textContent = 'annulé.';
    else statusEl.textContent = 'erreur : ' + err.message;
    setBusy(false);
  }
});

cancelButton.addEventListener('click', () => {
  if (worker) worker.postMessage({ type: 'cancel' });
  if (abortController) abortController.abort();
  statusEl.textContent = 'annulation…';
});

downloadButton.addEventListener('click', async () => {
  if (!current) return;
  setBusy(true);
  try {
    const files = Array.from(fileInput.files || []);
    if (files.length === 1) await runLocal(files[0], cleanName(files[0].name), current.opts);
    else if (files.length > 1) {
      const parts = [];
      files.forEach((file, index) => {
        if (index) parts.push('\n');
        parts.push(file);
      });
      await runLocal(new Blob(parts, { type: 'text/plain' }), 'zach-db', current.opts);
    }
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

metaEl.textContent = dirParam ? 'traitement serveur · ?dir=' + dirParam : 'traitement local · 0 envoi';
if (dirParam) filesInput.placeholder = 'un nom de fichier par ligne, lu dans le dossier ' + dirParam;
ensureWorker();
