/*
 * zach-db — serveur.
 * Sert le site (public/) et une petite API d'extraction en flux.
 * Zéro dépendance, aucun framework, aucun build.
 *
 *   GET  /                            → l'accueil : la liste des outils
 *   GET  /tools/<id>/                 → la page d'un outil (ex. group-by-site)
 *   GET  /api/health                  → état du service
 *   GET  /api/tools                   → le registre des outils (JSON)
 *   POST /api/extract                 → corps = texte brut à traiter (curl)
 *   POST /api/extract?paths=1&dir=/x  → corps = liste de noms de fichiers du dossier /x
 *   GET  /api/extract?dir=/x          → tout le dossier /x
 *   GET  /api/discord/user?id=<flocon>→ profil Discord complet (?guilds=1 ajoute
 *                                       les serveurs communs) ; sans jeton, rend
 *                                       tout ce que l'identifiant raconte
 *   GET  /api/discord/flags           → la table des drapeaux publics décodés
 *   GET  /api/guns/views              → pousse des vues sur un profil guns.lol
 *                                       (?user=, ?views=, ?rounds=, ?direct=1)
 *   GET  /api/guns/proxies            → la réserve de proxys : sources, test
 *
 * Les ressources statiques sont servies avec ETag + no-cache : le navigateur
 * redemande, le serveur répond 304 si rien n'a changé (aucune feuille de style
 * périmée après une modification).
 *
 * Paramètres : mode=last|first|longest|all|custom, regex=…, dedupe=0|1, gz=0
 * Variables : PORT, HOST, ZACH_DB_DIR, ZACH_DB_BODY_LIMIT (octets, 256 Mo par défaut)
 * Discord   : DISCORD_TOKEN (jeton bot, secret — jamais envoyé au navigateur),
 *             DISCORD_API_BASE, DISCORD_TIMEOUT_MS, DISCORD_GUILD_CAP,
 *             DISCORD_RATE_MAX / DISCORD_RATE_WINDOW (garde-fou par adresse IP)
 */
import http from 'node:http';
import fs from 'node:fs';
import fsp from 'node:fs/promises';
import path from 'node:path';
import { once } from 'node:events';
import zlib, { createGzip, createBrotliCompress } from 'node:zlib';
import { fileURLToPath } from 'node:url';
import { createProcessor, MODES } from './public/lib/parse.js';
import { createGrouper } from './public/lib/group.js';
import { TOOLS, availableTools } from './public/lib/tools.js';
import { lookup as discordLookup, flagTable } from './public/lib/discord-api.js';
import { boost as gunsBoost, inspectPool as gunsPool } from './public/lib/guns-api.js';

const ROOT = path.dirname(fileURLToPath(import.meta.url));
const PUBLIC = path.join(ROOT, 'public');

const PORT = Number(process.env.PORT) || 3000;
const HOST = process.env.HOST || '0.0.0.0';
const BODY_LIMIT = Number(process.env.ZACH_DB_BODY_LIMIT) || 256 * 1024 * 1024;
const DATA_DIR = process.env.ZACH_DB_DIR ? path.resolve(process.env.ZACH_DB_DIR) : null;
const VERSION = '1.0.0';

const MIME = new Map([
  ['.html', 'text/html; charset=utf-8'],
  ['.css', 'text/css; charset=utf-8'],
  ['.js', 'text/javascript; charset=utf-8'],
  ['.mjs', 'text/javascript; charset=utf-8'],
  ['.json', 'application/json; charset=utf-8'],
  ['.txt', 'text/plain; charset=utf-8'],
  ['.svg', 'image/svg+xml'],
  ['.ico', 'image/x-icon'],
  ['.png', 'image/png'],
  ['.jpg', 'image/jpeg'],
  ['.webp', 'image/webp'],
  ['.webmanifest', 'application/manifest+json'],
]);

/** Erreur qui invalide le flux déjà commencé : on coupe la connexion au lieu
 *  de renvoyer un fichier tronqué en douce. */
function fatal(message) {
  const err = new Error(message);
  err.fatal = true;
  return err;
}

function sendJson(res, status, payload) {
  const body = JSON.stringify(payload);
  res.writeHead(status, {
    'content-type': 'application/json; charset=utf-8',
    'cache-control': 'no-store',
    'content-length': Buffer.byteLength(body),
  });
  res.end(body);
}

function sendText(res, status, text, type = 'text/plain; charset=utf-8') {
  res.writeHead(status, { 'content-type': type, 'cache-control': 'no-store' });
  res.end(text);
}

/* ---------- fichiers statiques ---------- */

/** Fichier statique : ETag + no-cache, donc jamais de CSS ou de JS périmé.
 *  Le navigateur conserve la ressource mais la revalide à chaque visite ; si
 *  rien n'a changé, le serveur répond 304 sans renvoyer un octet. */
async function serveFile(req, res, file, type, revalidate) {
  try {
    const stat = await fsp.stat(file);
    const etag = '"' + stat.size.toString(16) + '-' + Math.round(stat.mtimeMs).toString(16) + '"';
    const cacheControl = revalidate ? 'no-cache' : 'no-store';
    if (revalidate && req.headers['if-none-match'] === etag) {
      res.writeHead(304, { etag, 'cache-control': cacheControl });
      return res.end();
    }
    res.writeHead(200, {
      'content-type': type,
      'content-length': stat.size,
      'cache-control': cacheControl,
      etag,
      'last-modified': stat.mtime.toUTCString(),
    });
    if (req.method === 'HEAD') res.end();
    else fs.createReadStream(file).pipe(res);
  } catch {
    sendText(res, 404, 'Not found\n');
  }
}

async function serveStatic(req, res, url) {
  let relative;
  try {
    relative = decodeURIComponent(url.pathname);
  } catch {
    return sendText(res, 400, 'Invalid path\n');
  }
  if (relative.includes('\0')) return sendText(res, 400, 'Invalid path\n');

  const target = path.resolve(PUBLIC, '.' + relative);
  if (target !== PUBLIC && !target.startsWith(PUBLIC + path.sep)) {
    return sendText(res, 403, 'Forbidden\n');
  }

  // Un dossier (/, /tools/group-by-site…) sert son index.html ; sans slash
  // final on redirige, pour que les liens relatifs de la page fonctionnent.
  let file = target;
  try {
    const stat = await fsp.stat(target);
    if (stat.isDirectory()) {
      if (!relative.endsWith('/')) {
        res.writeHead(301, { location: url.pathname + '/' + url.search, 'cache-control': 'no-store' });
        return res.end();
      }
      file = path.join(target, 'index.html');
    }
  } catch {
    // le chemin n'existe pas : la suite renverra le 404
  }

  const type = MIME.get(path.extname(file).toLowerCase());
  if (!type) return sendText(res, 404, 'Not found\n');
  return serveFile(req, res, file, type, path.basename(file) !== 'index.html');
}

/* ---------- extraction ---------- */

function readOptions(url) {
  const params = url.searchParams;
  const mode = params.get('mode') || 'last';
  if (!MODES.includes(mode)) {
    throw new Error('Unknown mode: ' + mode + ' (expected: ' + MODES.join(', ') + ')');
  }
  const regex = params.get('regex') || '';
  if (mode === 'custom') {
    try {
      new RegExp(regex || '([a-z0-9._-]+):([a-z0-9._-]+)');
    } catch (err) {
      throw new Error('Invalid regex: ' + err.message);
    }
  }
  const dedupe = ['1', 'true', 'on', 'yes'].includes((params.get('dedupe') || '').toLowerCase());
  const hosts = ['1', 'true', 'on', 'yes'].includes((params.get('hosts') || '').toLowerCase());
  return { mode, regex, dedupe, hosts };
}

/** Fichiers d'un dossier autorisé (ZACH_DB_DIR), vérifiés avant l'envoi des en-têtes. */
async function listDir(dirParam, wanted) {
  if (!DATA_DIR) throw new Error('Server-side directory access is disabled (set ZACH_DB_DIR on the server)');
  // dir=/ → la racine de ZACH_DB_DIR ; dir=/sous → ZACH_DB_DIR/sous
  const relative = String(dirParam || '').replace(/^\/+/, '');
  const target = path.resolve(DATA_DIR, relative);
  if (target !== DATA_DIR && !target.startsWith(DATA_DIR + path.sep)) {
    throw new Error('Path is outside the allowed directory');
  }
  const entries = await fsp.readdir(target, { withFileTypes: true });
  const available = new Set(entries.filter((entry) => entry.isFile() && !entry.name.startsWith('.')).map((e) => e.name));
  const names = wanted.length ? wanted : [...available].sort();
  const files = [];
  for (const name of names) {
    if (name.includes('/') || name.includes('\\') || name.includes('\0')) {
      throw new Error('Invalid filename: ' + name);
    }
    if (!available.has(name)) throw new Error('File not found: ' + name);
    const full = path.join(target, name);
    await fsp.access(full, fs.constants.R_OK);
    files.push(full);
  }
  return files;
}

/** Écriture dans la réponse avec respect du débit, et détection du client parti. */
function createWriter(res, sink) {
  let closed = false;
  let notify = null;
  res.on('close', () => {
    if (!res.writableEnded) {
      closed = true;
      if (notify) notify();
    }
  });
  return {
    get closed() {
      return closed;
    },
    async write(text) {
      if (this.closed) throw new Error('Client disconnected');
      if (!sink.write(text)) {
        await Promise.race([once(sink, 'drain'), new Promise((resolve) => (notify = resolve))]);
      }
    },
  };
}

/** Source 1 : le corps de la requête. */
async function* bodySource(req) {
  let received = 0;
  for await (const chunk of req) {
    received += chunk.length;
    if (received > BODY_LIMIT) throw fatal('Request body too large (' + BODY_LIMIT + ' bytes max)');
    yield chunk;
  }
}

/** Source 2 : des fichiers du disque du serveur. */
async function* fileSource(files) {
  let first = true;
  for (const file of files) {
    if (!first) yield Buffer.from('\n'); // séparation entre deux fichiers
    first = false;
    for await (const chunk of fs.createReadStream(file, { highWaterMark: 1 << 20 })) yield chunk;
  }
}

/**
 * Détermine la source à traiter : le corps de la requête, ou des fichiers du
 * disque du serveur (?dir=/…). Renvoie null si la réponse est déjà partie.
 */
async function resolveSource(req, res, url) {
  const params = url.searchParams;
  const dirParam = params.get('dir');
  if (dirParam === null) return { source: bodySource(req), label: 'corps' };

  let wanted = [];
  if (req.method === 'POST') {
    if (params.get('paths') !== '1') {
      sendJson(res, 400, {
        error: 'Ambiguous request: a text body and dir= cannot be used together; add ?paths=1 (the body must list filenames)',
      });
      return null;
    }
    let raw = '';
    for await (const chunk of req) {
      raw += chunk;
      if (raw.length > 1 << 20) {
        sendJson(res, 400, { error: 'File list is too long' });
        return null;
      }
    }
    wanted = raw.split('\n').map((line) => line.trim()).filter(Boolean);
  }

  let files;
  try {
    files = await listDir(dirParam, wanted);
  } catch (err) {
    sendJson(res, 400, { error: err.message });
    return null;
  }
  if (files.length === 0) {
    sendJson(res, 400, { error: 'No files to process' });
    return null;
  }
  return { source: fileSource(files), label: 'dir:' + dirParam };
}

/** En-têtes + compression pour une réponse en flux. */
function startStream(req, res, url, { name, type, disposition = 'attachment' }) {
  const accepts = String(req.headers['accept-encoding'] || '');
  const compress = url.searchParams.get('gz') !== '0'
    ? (accepts.includes('gzip') ? 'gzip' : accepts.includes('br') ? 'br' : null)
    : null;

  const headers = { 'content-type': type, 'cache-control': 'no-store', 'x-accel-buffering': 'no' };
  if (disposition) {
    headers['content-disposition'] =
      disposition + '; filename="' + String(name || 'zach-db.txt').replace(/[^\w.-]+/g, '_') + '"';
  }

  let sink = res;
  let compressor = null;
  if (compress === 'gzip') {
    compressor = createGzip({ level: 1 });
    headers['content-encoding'] = 'gzip';
  } else if (compress === 'br') {
    compressor = createBrotliCompress({ params: { [zlib.constants.BROTLI_PARAM_QUALITY]: 0 } });
    headers['content-encoding'] = 'br';
  }
  res.writeHead(200, headers);
  if (compressor) {
    compressor.pipe(res);
    sink = compressor;
  }
  return { writer: createWriter(res, sink), compressor };
}

/** Termine proprement une réponse en flux (ou coupe si le transfert a échoué). */
function endStream(res, compressor, failure, writer) {
  if (failure && !writer.closed) {
    // Transfert déjà commencé : on coupe plutôt que de livrer un fichier tronqué.
    process.stderr.write('[zach-db] flux interrompu : ' + failure.message + '\n');
    res.destroy();
    if (compressor) compressor.destroy();
    return;
  }
  if (compressor) compressor.end();
  else res.end();
}

async function handleExtract(req, res, url) {
  let options;
  try {
    options = readOptions(url);
  } catch (err) {
    return sendJson(res, 400, { error: err.message });
  }

  const resolved = await resolveSource(req, res, url);
  if (resolved === null) return undefined;
  const { source, label } = resolved;

  // Tout est validé : les en-têtes peuvent partir.
  const { writer, compressor } = startStream(req, res, url, {
    name: url.searchParams.get('name') || 'zach-db-extract.txt',
    type: 'text/plain; charset=utf-8',
  });
  const processor = createProcessor(options);
  let bytesIn = 0;
  let failure = null;

  try {
    for await (const chunk of source) {
      if (writer.closed) break;
      bytesIn += chunk.length;
      const out = processor.pushBytes(chunk);
      if (out) await writer.write(out);
    }
    if (!writer.closed) {
      const tail = processor.flush();
      if (tail) await writer.write(tail);
    }
  } catch (err) {
    failure = err;
  }

  const stats = processor.stats();
  process.stdout.write(
    '[zach-db] extract mode=' + options.mode + ' dedupe=' + (options.dedupe ? 1 : 0) +
    ' entrée=' + bytesIn + 'o sortie=' + stats.outLines + ' lignes/' + stats.outChars + 'o' +
    ' source=' + label + '\n'
  );
  endStream(res, compressor, failure, writer);
  return undefined;
}

/* ---------- groupement par site ---------- */

const MAX_SITES_JSON = 50000;

/** Passe de groupement ciblée sur un site, écrite au fil de l'eau. */
async function runGrouped(req, res, source, options, site, subdomains, writer, compressor, encode, log) {
  const pending = [];
  const grouper = createGrouper({
    mode: options.mode, regex: options.regex, hosts: options.hosts, dedupe: options.dedupe,
    stripSubdomains: !subdomains, onlySite: site, keepText: false, maxTextBytes: 0,
    onValue: (name, value) => pending.push(encode(value)),
  });
  let bytesIn = 0;
  let failure = null;

  try {
    for await (const chunk of source) {
      if (writer.closed) break;
      bytesIn += chunk.length;
      grouper.pushBytes(chunk);
      if (pending.length) {
        await writer.write(pending.join(''));
        pending.length = 0;
      }
    }
    if (!writer.closed) {
      grouper.flush();
      if (pending.length) await writer.write(pending.join(''));
      pending.length = 0;
    }
  } catch (err) {
    failure = err;
  }

  log(grouper, bytesIn);
  endStream(res, compressor, failure, writer);
  return undefined;
}

async function handleGroup(req, res, url) {
  const params = url.searchParams;
  let options;
  try {
    options = readOptions(url);
  } catch (err) {
    return sendJson(res, 400, { error: err.message });
  }
  const exact = ['0', 'false', 'off', 'no'].includes((params.get('subdomains') || '').toLowerCase());
  const site = params.get('site');
  const format = (params.get('format') || (site ? 'txt' : 'json')).toLowerCase();

  const resolved = await resolveSource(req, res, url);
  if (resolved === null) return undefined;
  const { source, label } = resolved;

  // 1) un seul site : les valeurs partent au fil de l'eau, rien n'est stocké.
  if (site) {
    if (format === 'ndjson') {
      const { writer, compressor } = startStream(req, res, url, {
        name: 'zach-db-' + site + '.ndjson',
        type: 'application/x-ndjson; charset=utf-8',
      });
      return runGrouped(req, res, source, options, site, exact, writer, compressor,
        (value) => JSON.stringify(value) + '\n',
        (grouper, bytesIn) => process.stdout.write('[zach-db] group site=' + site + ' ndjson entrée=' +
          bytesIn + 'o valeurs=' + grouper.stats().kept + '\n'));
    }
    const { writer, compressor } = startStream(req, res, url, {
      name: params.get('name') || 'zach-db-' + site + '.txt',
      type: 'text/plain; charset=utf-8',
    });
    return runGrouped(req, res, source, options, site, exact, writer, compressor,
      (value) => value + '\n',
      (grouper, bytesIn) => {
        const stats = grouper.stats();
        process.stdout.write('[zach-db] group site=' + site + ' entrée=' + bytesIn + 'o valeurs=' +
          stats.kept + ' sortie=' + stats.bytes + 'o\n');
      });
  }

  // 2) la liste des sites : un passage complet, puis la réponse.
  const grouper = createGrouper({
    mode: options.mode, regex: options.regex, hosts: options.hosts, dedupe: options.dedupe,
    stripSubdomains: !exact, keepText: false, maxTextBytes: 0,
  });
  let bytesIn = 0;
  let failure = null;
  try {
    for await (const chunk of source) {
      bytesIn += chunk.length;
      grouper.pushBytes(chunk);
    }
    grouper.flush();
  } catch (err) {
    failure = err;
  }
  if (failure) return sendJson(res, 400, { error: failure.message });

  const order = grouper.order();
  const stats = grouper.stats();
  const sites = order.slice(0, MAX_SITES_JSON).map((entry) => ({
    site: entry.site, count: entry.count, bytes: entry.bytes,
  }));
  process.stdout.write('[zach-db] group liste entrée=' + bytesIn + 'o sites=' + order.length +
    ' valeurs=' + stats.kept + ' source=' + label + '\n');

  if (format === 'tsv' || format === 'text') {
    const body = sites.map((entry) => entry.site + '\t' + entry.count + '\t' + entry.bytes).join('\n');
    return sendText(res, 200, body + (body ? '\n' : ''), 'text/plain; charset=utf-8');
  }
  return sendJson(res, 200, {
    total: order.length,
    truncated: order.length > MAX_SITES_JSON,
    sites,
    stats: { lines: stats.lines, matched: stats.matched, kept: stats.kept, skipped: stats.skipped },
  });
}

/* ---------- discord lookup ---------- */

const RATE_MAX = Number(process.env.DISCORD_RATE_MAX) || 30;
const RATE_WINDOW = Number(process.env.DISCORD_RATE_WINDOW) || 60000;
const hits = new Map(); // adresse IP → horodatages des recherches récentes

/** Adresse du client (Render et les autres reverse-proxy ajoutent x-forwarded-for). */
function clientIp(req) {
  const forwarded = String(req.headers['x-forwarded-for'] || '').split(',')[0].trim();
  return forwarded || req.socket.remoteAddress || 'inconnue';
}

/**
 * Garde-fou : cette route relaie un jeton bot, elle ne doit pas pouvoir être
 * matraquée. Renvoie le nombre de secondes à attendre, 0 si tout va bien.
 */
function throttle(ip, max = RATE_MAX, windowMs = RATE_WINDOW, store = hits) {
  const now = Date.now();
  const recent = (store.get(ip) || []).filter((stamp) => now - stamp < windowMs);
  recent.push(now);
  store.set(ip, recent);
  if (store.size > 2000) {
    for (const [key, value] of store) if (!value.some((stamp) => now - stamp < windowMs)) store.delete(key);
  }
  if (recent.length > max) return Math.max(1, Math.ceil((windowMs - (now - recent[0])) / 1000));
  return 0;
}

async function handleDiscord(req, res, url) {
  const params = url.searchParams;
  const wait = throttle(clientIp(req));
  if (wait) {
    return sendJson(res, 429, {
      ok: false,
      error: 'Too many lookups from this address',
      retry_after: wait,
    });
  }

  const payload = await discordLookup(params.get('id') || params.get('user') || params.get('q') || '', {
    guilds: ['1', 'true', 'on', 'yes'].includes(String(params.get('guilds') || '').toLowerCase()),
    size: params.get('size'),
  });

  const { status, ...body } = payload;
  process.stdout.write('[zach-db] discord id=' + (payload.id || '-') + ' mode=' + payload.mode +
    ' ' + status + ' ' + (payload.elapsed || 0) + 'ms\n');
  return sendJson(res, status, body);
}

/* ---------- guns.lol views ---------- */

const GUNS_RATE_MAX = Number(process.env.GUNS_RATE_MAX) || 6;
const GUNS_RATE_WINDOW = Number(process.env.GUNS_RATE_WINDOW) || 60000;
const gunsHits = new Map(); // adresse IP → horodatages des passes récentes

/** Une passe coûte des centaines de connexions : elle est plafonnée plus bas. */
async function handleGuns(req, res, url) {
  const params = url.searchParams;
  const wait = throttle(clientIp(req), GUNS_RATE_MAX, GUNS_RATE_WINDOW, gunsHits);
  if (wait) {
    return sendJson(res, 429, {
      ok: false,
      error: 'Too many boosts from this address',
      retry_after: wait,
    });
  }

  const report = await gunsBoost(
    params.get('user') || params.get('u') || params.get('q') || params.get('target') || '',
    {
      views: params.get('views'),
      rounds: params.get('rounds'),
      proxies: params.get('proxies'),
      concurrency: params.get('concurrency'),
      layers: params.get('layers'),
      direct: params.get('direct'),
      read: params.get('read'),
      refresh: params.get('refresh'),
    }
  );

  const { status, ...body } = report;
  process.stdout.write('[zach-db] guns user=' + (report.slug || '-') + ' mode=' + report.mode +
    ' vues=' + report.views.accepted + '/' + report.views.attempts + ' ' + status + ' ' + (report.elapsed || 0) + 'ms\n');
  return sendJson(res, status, body);
}

async function handleGunsPool(req, res, url) {
  const wait = throttle(clientIp(req), GUNS_RATE_MAX, GUNS_RATE_WINDOW, gunsHits);
  if (wait) {
    return sendJson(res, 429, {
      ok: false,
      error: 'Too many pool tests from this address',
      retry_after: wait,
    });
  }

  const pool = await gunsPool({
    proxies: url.searchParams.get('proxies'),
    concurrency: url.searchParams.get('concurrency'),
    refresh: url.searchParams.get('refresh'),
  });
  process.stdout.write('[zach-db] guns pool récoltés=' + pool.harvested + ' testés=' + pool.tested +
    ' vivants=' + pool.alive + ' ' + pool.elapsed + 'ms\n');
  return sendJson(res, 200, pool);
}

/* ---------- serveur ---------- */

export function createServer() {
    const server = http.createServer(async (req, res) => {
    const started = Date.now();
    const url = new URL(req.url, 'http://' + (req.headers.host || 'localhost'));

    res.once('finish', () => {
    if (url.pathname.startsWith('/api/')) {
      process.stdout.write('[zach-db] ' + req.method + ' ' + url.pathname + ' ' + res.statusCode +
        ' ' + (Date.now() - started) + 'ms\n');
    }
  });

    try {
    if (url.pathname === '/api/health') {
      return sendJson(res, 200, {
        ok: true,
        version: VERSION,
        dir: DATA_DIR,
        discord: Boolean(process.env.DISCORD_TOKEN || process.env.DISCORD_BOT_TOKEN || process.env.ZACH_DB_DISCORD_TOKEN),
        guns: true,
        uptime: process.uptime(),
      });
    }
    if (url.pathname === '/api/tools') {
      return sendJson(res, 200, {
        total: TOOLS.length,
        available: availableTools().length,
        tools: TOOLS,
      });
    }
    if (url.pathname === '/api/discord/flags') {
      return sendJson(res, 200, flagTable());
    }
    if (url.pathname === '/api/discord/user' || url.pathname === '/api/discord') {
      if (req.method !== 'GET') {
        return sendJson(res, 405, { error: 'Use GET /api/discord/user?id=<snowflake>' });
      }
      return await handleDiscord(req, res, url);
    }
    if (url.pathname === '/api/guns/proxies') {
      if (req.method !== 'GET' && req.method !== 'HEAD') {
        return sendJson(res, 405, { error: 'Use GET /api/guns/proxies' });
      }
      return await handleGunsPool(req, res, url);
    }
    if (url.pathname === '/api/guns/views' || url.pathname === '/api/guns') {
      if (req.method !== 'GET' && req.method !== 'POST') {
        return sendJson(res, 405, { error: 'Use GET /api/guns/views?user=<username>' });
      }
      return await handleGuns(req, res, url);
    }
    if (url.pathname === '/api/extract' || url.pathname === '/api/group') {
      const group = url.pathname === '/api/group' ||
        ['1', 'true', 'on'].includes(url.searchParams.get('group'));
      if (req.method === 'POST' || (req.method === 'GET' && url.searchParams.get('dir') !== null)) {
        return group ? await handleGroup(req, res, url) : await handleExtract(req, res, url);
      }
      return sendJson(res, 405, { error: 'Use POST (body = text) or GET ?dir=/directory' });
    }
    if (req.method !== 'GET' && req.method !== 'HEAD') {
      return sendJson(res, 405, { error: 'Method not allowed' });
    }
    return await serveStatic(req, res, url);
    } catch (err) {
    process.stderr.write('[zach-db] erreur : ' + ((err && err.stack) || err) + '\n');
    if (!res.headersSent) sendJson(res, 500, { error: 'Server error' });
    else res.destroy();
    return undefined;
    }
});

  server.keepAliveTimeout = 120000;
  server.headersTimeout = 130000;
  server.requestTimeout = 0; // un gros fichier peut prendre du temps
  return server;
}

// Démarrage direct : node server.js
if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  const server = createServer();
  server.listen(PORT, HOST, () => {
    process.stdout.write('zach-db v' + VERSION + ' → http://' + HOST + ':' + PORT +
      (DATA_DIR ? ' (dossier autorisé : ' + DATA_DIR + ')' : '') + '\n');
  });

  for (const signal of ['SIGTERM', 'SIGINT']) {
    process.on(signal, () => {
      process.stdout.write('[zach-db] ' + signal + ' → arrêt\n');
      server.close(() => process.exit(0));
      setTimeout(() => process.exit(0), 5000).unref();
    });
  }
}
