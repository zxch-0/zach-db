/*
 * zach-db — moteur « Guns.lol views ».
 *
 * Récolte des proxys, tunnel CONNECT, envoi des vues. Réservé au serveur et à
 * la CLI : un navigateur ne peut pas ouvrir de tunnel vers un proxy HTTP.
 *
 * Zéro dépendance : node:http, node:tls, node:crypto et fetch.
 *
 * Le proof-of-work de guns.lol est résolu ici, en Node pur : SHA-256 pour la
 * force brute des cinq nibbles retirés au sceau, BLAKE3 pour le score et
 * l'intégrité du nonce. BLAKE3 est recoupé sur les vecteurs officiels.
 *
 * Une vue suit l'ordre exact de guns.lol — page, pixel, /api/view, événement
 * signé — et chaque couche rapporte ce qu'elle a répondu. Une couche qui
 * échoue trois fois de suite est abandonnée en cours de route.
 */
import http from 'node:http';
import net from 'node:net';
import tls from 'node:tls';
import { createHash } from 'node:crypto';
import {
  BROWSERS,
  PIXEL_HOST,
  PORT,
  PROFILE_HOST,
  PROXY_SOURCES,
  RECORD_ALT_PATH,
  RECORD_PATH,
  VIEW_PATH,
  describeProxy,
  documentHeaders,
  extractSlug,
  guessViews,
  parseChallenge,
  parseProxyJson,
  parseProxyList,
  pathOf,
  pickBrowser,
  pixelHeaders,
  pixelUrl,
  profilePath,
  profileUrl,
  recordHeaders,
  viewHeaders,
} from './guns.js';

export { PROXY_SOURCES, BROWSERS };

/* ------------------------------------------------------------------ *
 * 1. Configuration (surchargée par la requête, sinon par l'environnement)
 * ------------------------------------------------------------------ */

function num(value, fallback, min, max) {
  const parsed = Number(value);
  if (!Number.isFinite(parsed) || parsed <= 0) return fallback;
  return Math.min(max, Math.max(min, Math.round(parsed)));
}

function flag(value) {
  return value === true || value === 1 || value === '1' || value === 'true' || value === 'on' || value === 'yes';
}

export function config(overrides = {}) {
  const env = typeof process !== 'undefined' && process.env ? process.env : {};
  const views = num(overrides.views || env.GUNS_VIEWS, 15, 1, 500);
  return {
    views,
    rounds: num(overrides.rounds || env.GUNS_ROUNDS, 1, 1, 20),
    proxies: num(overrides.proxies || env.GUNS_PROXIES, 1500, 50, 6000),
    concurrency: num(overrides.concurrency || env.GUNS_CONCURRENCY, 6, 1, 32),
    validateConcurrency: num(overrides.validateConcurrency || env.GUNS_VALIDATE_CONCURRENCY, 80, 1, 400),
    validateMax: num(overrides.validateMax || env.GUNS_VALIDATE_MAX, Math.max(views + 5, 20), 1, 6000),
    perSource: num(overrides.perSource || env.GUNS_PROXY_PER_SOURCE, 400, 20, 5000),
    timeoutMs: num(overrides.timeout || env.GUNS_TIMEOUT_MS, 8000, 1000, 30000),
    validateTimeout: num(overrides.validateTimeout || env.GUNS_VALIDATE_TIMEOUT_MS, 4500, 800, 20000),
    budgetMs: num(overrides.budget || env.GUNS_BUDGET_MS, 60000, 5000, 300000),
    validateBudgetMs: num(overrides.validateBudget || env.GUNS_VALIDATE_BUDGET_MS, 30000, 3000, 300000),
    turnstile: String(overrides.turnstile || env.GUNS_TURNSTILE || '').trim(),
    directOnly: flag(overrides.direct) || flag(overrides.directOnly),
    read: flag(overrides.read),
    refresh: flag(overrides.refresh),
  };
}

const LAYER_NAMES = ['page', 'pixel', 'view', 'record'];

/** « page,pixel » → { page: true, pixel: true, view: false, record: false }. */
function normalizeLayers(input) {
  const layers = { page: true, pixel: true, view: true, record: true };
  if (!input) return layers;
  const wanted = String(input).toLowerCase().split(/[,\s]+/).filter(Boolean);
  if (!wanted.length) return layers;
  for (const name of LAYER_NAMES) layers[name] = wanted.includes(name);
  if (!LAYER_NAMES.some((name) => layers[name])) return { page: true, pixel: true, view: true, record: true };
  return layers;
}

function timeoutSignal(ms) {
  return typeof AbortSignal !== 'undefined' && AbortSignal.timeout ? AbortSignal.timeout(ms) : undefined;
}

/* ------------------------------------------------------------------ *
 * 2. BLAKE3 — cent lignes, aucune dépendance
 * ------------------------------------------------------------------ */

const BLAKE3_IV = new Uint32Array([
  0x6a09e667, 0xbb67ae85, 0x3c6ef372, 0xa54ff53a,
  0x510e527f, 0x9b05688c, 0x1f83d9ab, 0x5be0cd19,
]);
const BLAKE3_PERMUTATION = [2, 6, 3, 10, 7, 0, 4, 13, 1, 11, 12, 5, 9, 14, 15, 8];
const CHUNK_START = 1;
const CHUNK_END = 2;
const PARENT = 4;
const ROOT = 8;
const BLOCK_LEN = 64;
const CHUNK_LEN = 1024;

const MESSAGE_SCHEDULE = (() => {
  const schedule = [];
  let current = [0, 1, 2, 3, 4, 5, 6, 7, 8, 9, 10, 11, 12, 13, 14, 15];
  for (let round = 0; round < 7; round++) {
    schedule.push(current);
    const next = new Array(16);
    for (let i = 0; i < 16; i++) next[i] = current[BLAKE3_PERMUTATION[i]];
    current = next;
  }
  return schedule;
})();

function rotr(value, bits) {
  return ((value >>> bits) | (value << (32 - bits))) | 0;
}

function mix(state, a, b, c, d, mx, my) {
  state[a] = (state[a] + state[b] + mx) | 0;
  state[d] = rotr(state[d] ^ state[a], 16);
  state[c] = (state[c] + state[d]) | 0;
  state[b] = rotr(state[b] ^ state[c], 12);
  state[a] = (state[a] + state[b] + my) | 0;
  state[d] = rotr(state[d] ^ state[a], 8);
  state[c] = (state[c] + state[d]) | 0;
  state[b] = rotr(state[b] ^ state[c], 7);
}

function compress(chaining, block, counter, blockLen, flags) {
  const state = new Int32Array(16);
  for (let i = 0; i < 8; i++) state[i] = chaining[i];
  for (let i = 0; i < 4; i++) state[8 + i] = BLAKE3_IV[i];
  state[12] = counter | 0;
  state[13] = Math.floor(counter / 4294967296) | 0;
  state[14] = blockLen | 0;
  state[15] = flags | 0;

  for (let round = 0; round < 7; round++) {
    const s = MESSAGE_SCHEDULE[round];
    mix(state, 0, 4, 8, 12, block[s[0]], block[s[1]]);
    mix(state, 1, 5, 9, 13, block[s[2]], block[s[3]]);
    mix(state, 2, 6, 10, 14, block[s[4]], block[s[5]]);
    mix(state, 3, 7, 11, 15, block[s[6]], block[s[7]]);
    mix(state, 0, 5, 10, 15, block[s[8]], block[s[9]]);
    mix(state, 1, 6, 11, 12, block[s[10]], block[s[11]]);
    mix(state, 2, 7, 8, 13, block[s[12]], block[s[13]]);
    mix(state, 3, 4, 9, 14, block[s[14]], block[s[15]]);
  }

  const out = new Int32Array(16);
  for (let i = 0; i < 8; i++) {
    out[i] = state[i] ^ state[i + 8];
    out[i + 8] = state[i + 8] ^ chaining[i];
  }
  return out;
}

function blockWords(block) {
  const words = new Int32Array(16);
  for (let i = 0; i < 16; i++) {
    const at = i * 4;
    words[i] = (block[at] | (block[at + 1] << 8) | (block[at + 2] << 16) | (block[at + 3] << 24)) | 0;
  }
  return words;
}

function toBytes(input) {
  return typeof input === 'string' ? new TextEncoder().encode(input) : input;
}

/** Sortie de la compression du dernier bloc d'un chunk (16 mots). */
function chunkOutput(chunk, counter, extraFlags) {
  let chaining = BLAKE3_IV;
  const blocks = Math.max(1, Math.ceil(chunk.length / BLOCK_LEN));
  for (let index = 0; index < blocks; index++) {
    const start = index * BLOCK_LEN;
    const slice = chunk.subarray(start, Math.min(start + BLOCK_LEN, chunk.length));
    const block = new Uint8Array(BLOCK_LEN);
    block.set(slice);
    let flags = 0;
    if (index === 0) flags |= CHUNK_START;
    if (index === blocks - 1) flags |= CHUNK_END | (extraFlags || 0);
    const out = compress(chaining, blockWords(block), counter, slice.length, flags);
    if (index === blocks - 1) return out;
    chaining = out.subarray(0, 8);
  }
  return null;
}

function parentOutput(left, right, extraFlags) {
  const words = new Int32Array(16);
  for (let i = 0; i < 8; i++) words[i] = left[i];
  for (let i = 0; i < 8; i++) words[i + 8] = right[i];
  return compress(BLAKE3_IV, words, 0, BLOCK_LEN, PARENT | (extraFlags || 0));
}

function firstBytes(words) {
  const bytes = new Uint8Array(32);
  for (let i = 0; i < 8; i++) {
    const word = words[i];
    bytes[i * 4] = word & 0xff;
    bytes[i * 4 + 1] = (word >>> 8) & 0xff;
    bytes[i * 4 + 2] = (word >>> 16) & 0xff;
    bytes[i * 4 + 3] = (word >>> 24) & 0xff;
  }
  return bytes;
}

/**
 * BLAKE3 (mode « hash »), 32 octets. Chaque chunk porte son compteur ; les
 * sous-arbres fusionnent quand leurs tailles sont égales, et la dernière
 * compression parente porte le drapeau ROOT.
 */
export function blake3(input) {
  const bytes = toBytes(input);
  if (bytes.length <= CHUNK_LEN) return firstBytes(chunkOutput(bytes, 0, ROOT));

  const stack = [];
  let lastParent = null;
  const chunks = Math.ceil(bytes.length / CHUNK_LEN);
  for (let index = 0; index < chunks; index++) {
    const chunk = bytes.subarray(index * CHUNK_LEN, (index + 1) * CHUNK_LEN);
    let cv = chunkOutput(chunk, index, 0).subarray(0, 8);
    let total = index + 1;
    while ((total & 1) === 0) {
      const left = stack.pop();
      lastParent = { left, right: cv };
      cv = parentOutput(left, cv, 0).subarray(0, 8);
      total >>= 1;
    }
    stack.push(cv);
  }

  let node = stack.pop();
  let root = null;
  while (stack.length) {
    const left = stack.pop();
    if (stack.length === 0) root = parentOutput(left, node, ROOT);
    else node = parentOutput(left, node, 0).subarray(0, 8);
  }
  if (root === null) root = parentOutput(lastParent.left, lastParent.right, ROOT);
  return firstBytes(root);
}

export function blake3Hex(input) {
  return Buffer.from(blake3(input)).toString('hex');
}

/* ------------------------------------------------------------------ *
 * 3. Proof-of-work
 * ------------------------------------------------------------------ */

/**
 * Le sceau : le « target » amputé de « positions » nibbles, qu'on réinsère en
 * ordre croissant — exactement comme le serveur les a retirés. Le dernier
 * nibble varie le plus vite, le socle n'est reconstruit qu'une fois par tour.
 */
export function findSeal(target, positions, targetHash, suffix) {
  const count = positions.length;
  const hex = '0123456789abcdef';
  const hash = () => createHash('sha256');

  if (count === 0) {
    return hash().update(target).update(suffix).digest().equals(targetHash) ? target : null;
  }

  const head = positions.slice(0, count - 1);
  const slot = positions[count - 1];
  const combo = new Array(Math.max(count - 1, 1)).fill(0);
  const rounds = 16 ** (count - 1);

  for (let step = 0; step < rounds; step++) {
    const list = target.split('');
    for (let i = 0; i < count - 1; i++) list.splice(head[i], 0, hex[combo[i]]);
    const base = list.join('');

    for (let last = 0; last < 16; last++) {
      const candidate = base.slice(0, slot) + hex[last] + base.slice(slot);
      if (hash().update(candidate).update(suffix).digest().equals(targetHash)) return candidate;
    }
    for (let i = count - 2; i >= 0; i--) {
      if (++combo[i] < 16) break;
      combo[i] = 0;
    }
  }
  return null;
}

/** Score : octets égaux (8 points chacun), puis zéros de tête du premier écart. */
function powScore(seal, challengeHashBytes, salt, timestamp) {
  const target = blake3(Buffer.concat([
    challengeHashBytes,
    Buffer.from(salt, 'utf8'),
    Buffer.from(String(timestamp), 'utf8'),
  ]));
  const sealHash = blake3(seal);
  let score = 0;
  for (let i = 0; i < 32; i++) {
    if (sealHash[i] === target[i]) {
      score += 8;
      continue;
    }
    const xor = sealHash[i] ^ target[i];
    let zeros = 0;
    for (let bit = 7; bit >= 0; bit--) {
      if (xor & (1 << bit)) break;
      zeros++;
    }
    score |= zeros;
    return score;
  }
  return 256;
}

function uint32le(value) {
  const bytes = Buffer.alloc(4);
  bytes.writeUInt32LE(value >>> 0, 0);
  return bytes;
}

function buildNonce(seal, positions, difficulty, key8, challengeHashBytes, score) {
  const nonceHex = positions.map((position) => seal[position] || '0').join('');
  const partial = Buffer.concat([
    Buffer.from([0x51, difficulty]),
    Buffer.from(nonceHex, 'latin1'),
    uint32le(score),
  ]);
  const integrity = blake3(Buffer.concat([partial, key8, challengeHashBytes])).subarray(0, 8);
  return Buffer.concat([partial, integrity]).toString('base64url');
}

/** Le sceau part au serveur avec deux caractères tirés au hasard : c'est voulu. */
function mangleSeal(seal, timestamp, salt, random) {
  const hex = '0123456789abcdef';
  const last = salt ? salt.charCodeAt(salt.length - 1) : 48;
  const first = timestamp % 10;
  const second = 16 + ((timestamp + last) % 24);
  const draw = () => hex[Math.min(15, Math.floor(random() * 16))];
  let out = seal.slice(0, first) + draw() + seal.slice(first);
  out = out.slice(0, second) + draw() + out.slice(second);
  return out;
}

/**
 * Le challenge « _gpp_ch » → le tableau signé attendu par guns.lol :
 * [jeton, horodatage, empreinte, sel, sceau, nonce].
 * Le nonce est bâti sur le sceau d'origine, le sceau rendu est brouillé après
 * coup : c'est l'ordre du serveur, et il est respecté à l'identique.
 */
export function solvePow(challenge, options = {}) {
  if (!Array.isArray(challenge) || challenge.length < 4) throw new Error('challenge _gpp_ch illisible');
  const [timestamp, challengeHash, salt, tokenB64] = challenge;
  const token = Buffer.from(String(tokenB64), 'base64url');
  if (token.length < 80) throw new Error('jeton de challenge trop court');

  const difficulty = token[2];
  if (difficulty < 1 || difficulty > 8) throw new Error('difficulté inattendue : ' + difficulty);

  const positions = [];
  for (let i = 0; i < difficulty; i++) positions.push(token[3 + i]);
  const sorted = [...positions].sort((a, b) => a - b);
  const target = token.subarray(21, 80).toString('latin1');
  const key8 = token.subarray(13, 21);
  const challengeHashBytes = Buffer.from(String(challengeHash), 'hex');
  const suffix = Buffer.from(String(salt) + String(timestamp), 'utf8');

  const seal = findSeal(target, sorted, challengeHashBytes, suffix);
  if (!seal) throw new Error('aucun sceau trouvé pour ce challenge');

  const score = powScore(seal, challengeHashBytes, String(salt), String(timestamp));
  const nonce = buildNonce(seal, positions, difficulty, key8, challengeHashBytes, score);
  const mangled = mangleSeal(seal, Number(timestamp), String(salt), options.random || Math.random);

  return [String(tokenB64), timestamp, challengeHash, salt, mangled, nonce];
}

/* ------------------------------------------------------------------ *
 * 4. Transport : CONNECT + TLS, écrit à la main
 * ------------------------------------------------------------------ */

/** Tunnel vers « host:port » à travers un proxy HTTP (méthode CONNECT). */
export function tunnel(proxy, host, port, timeoutMs) {
  return new Promise((resolve, reject) => {
    const headers = { host: host + ':' + port, 'proxy-connection': 'keep-alive' };
    if (proxy.auth) headers['proxy-authorization'] = 'Basic ' + Buffer.from(proxy.auth).toString('base64');

    const request = http.request({
      host: proxy.host,
      port: proxy.port,
      method: 'CONNECT',
      path: host + ':' + port,
      headers,
      agent: false,
      timeout: timeoutMs,
    });

    let settled = false;
    const fail = (err) => {
      if (settled) return;
      settled = true;
      request.destroy();
      reject(err);
    };

    request.on('connect', (response, socket) => {
      if (response.statusCode !== 200) {
        socket.destroy();
        return fail(new Error('CONNECT ' + response.statusCode));
      }
      const secure = tls.connect({ socket, servername: host, rejectUnauthorized: false });
      secure.once('secureConnect', () => {
        if (settled) return;
        settled = true;
        resolve(secure);
      });
      secure.once('error', fail);
      secure.setTimeout(timeoutMs, () => fail(new Error('TLS trop lent')));
    });
    request.on('timeout', () => fail(new Error('proxy trop lent')));
    request.on('error', fail);
  });
}

function parseResponse(buffer) {
  const text = buffer.toString('latin1');
  const split = text.indexOf('\r\n\r\n');
  const head = split === -1 ? text : text.slice(0, split);
  let body = split === -1 ? Buffer.alloc(0) : buffer.subarray(split + 4);

  const lines = head.split('\r\n');
  const statusLine = lines.shift() || '';
  const match = /^HTTP\/\d\.\d\s+(\d{3})/.exec(statusLine);
  const status = match ? Number(match[1]) : 0;

  const headers = {};
  for (const line of lines) {
    const colon = line.indexOf(':');
    if (colon === -1) continue;
    const name = line.slice(0, colon).trim().toLowerCase();
    const value = line.slice(colon + 1).trim();
    if (name === 'set-cookie') {
      if (!Array.isArray(headers[name])) headers[name] = [];
      headers[name].push(value);
    } else {
      headers[name] = headers[name] ? headers[name] + ', ' + value : value;
    }
  }

  if (String(headers['transfer-encoding'] || '').includes('chunked')) body = dechunk(body);
  return { status, headers, body: body.toString('utf8') };
}

/** Retire l'encodage « chunked » : guns.lol répond souvent sans content-length. */
function dechunk(buffer) {
  const parts = [];
  let cursor = 0;
  for (;;) {
    const end = buffer.indexOf('\r\n', cursor);
    if (end === -1) break;
    const size = parseInt(buffer.subarray(cursor, end).toString('latin1').split(';')[0].trim(), 16);
    if (!Number.isFinite(size) || size < 0) break;
    cursor = end + 2;
    if (size === 0) break;
    parts.push(buffer.subarray(cursor, cursor + size));
    cursor += size + 2;
  }
  return parts.length ? Buffer.concat(parts) : buffer;
}

function overSocket(socket, request) {
  return new Promise((resolve, reject) => {
    let raw = request.method + ' ' + request.path + ' HTTP/1.1\r\nHost: ' + request.host + '\r\n';
    for (const [name, value] of Object.entries(request.headers || {})) {
      if (value === undefined || value === null || value === '') continue;
      raw += name + ': ' + value + '\r\n';
    }
    raw += 'connection: close\r\n\r\n';

    const chunks = [];
    const maxBytes = request.maxBytes || 32768;
    let size = 0;
    let done = false;
    const finish = (err, value) => {
      if (done) return;
      done = true;
      if (err) reject(err);
      else resolve(value);
    };

    socket.setTimeout(request.timeoutMs, () => {
      socket.destroy();
      finish(new Error('réponse trop lente'));
    });
    socket.on('data', (chunk) => {
      chunks.push(chunk);
      size += chunk.length;
      if (size >= maxBytes) {
        socket.destroy();
        finish(null, parseResponse(Buffer.concat(chunks)));
      }
    });
    socket.on('end', () => finish(null, parseResponse(Buffer.concat(chunks))));
    socket.on('error', (err) => finish(err));

    socket.write(raw);
    if (request.body) socket.write(request.body);
  });
}

/**
 * Poignée de main SOCKS5 (sans authentification) : on négocie, on demande la
 * connexion à « host:port » par nom de domaine — c'est le proxy qui résout,
 * donc aucune dépendance à l'IPv6 local.
 */
function socks5Handshake(socket, host, port, timeoutMs) {
  return new Promise((resolve, reject) => {
    const name = Buffer.from(host, 'utf8');
    let stage = 0;
    let buffer = Buffer.alloc(0);
    let settled = false;

    const finish = (err) => {
      if (settled) return;
      settled = true;
      socket.removeListener('data', onData);
      socket.removeListener('error', onError);
      socket.setTimeout(0);
      if (err) {
        socket.destroy();
        reject(err);
      } else {
        resolve(socket);
      }
    };

    const onError = (err) => finish(err);
    const onData = (chunk) => {
      buffer = Buffer.concat([buffer, chunk]);

      if (stage === 0) {
        if (buffer.length < 2) return;
        if (buffer[0] !== 0x05) return finish(new Error('SOCKS5 version ' + buffer[0]));
        if (buffer[1] !== 0x00) return finish(new Error('SOCKS5 auth ' + buffer[1]));
        buffer = buffer.subarray(2);
        stage = 1;
        socket.write(Buffer.concat([
          Buffer.from([0x05, 0x01, 0x00, 0x03, name.length]),
          name,
          Buffer.from([(port >> 8) & 0xff, port & 0xff]),
        ]));
        return;
      }

      if (buffer.length < 5) return;
      const status = buffer[1];
      if (status !== 0x00) return finish(new Error('SOCKS5 refus ' + status));
      const kind = buffer[3];
      const need = kind === 0x01 ? 10 : kind === 0x04 ? 22 : 7 + buffer[4];
      if (buffer.length < need) return;
      finish(null);
    };

    socket.setTimeout(timeoutMs, () => finish(new Error('SOCKS5 trop lent')));
    socket.on('data', onData);
    socket.on('error', onError);
    socket.write(Buffer.from([0x05, 0x01, 0x00]));
  });
}

/** Tunnel SOCKS5 puis TLS, sur le même modèle que le CONNECT. */
function socks5Tunnel(proxy, host, port, timeoutMs) {
  return new Promise((resolve, reject) => {
    const socket = net.connect({ host: proxy.host, port: proxy.port });
    let settled = false;
    const fail = (err) => {
      if (settled) return;
      settled = true;
      socket.destroy();
      reject(err);
    };

    socket.setTimeout(timeoutMs, () => fail(new Error('SOCKS5 injoignable')));
    socket.once('error', fail);
    socket.once('connect', () => {
      socket.setTimeout(0);
      socks5Handshake(socket, host, port, timeoutMs)
        .then(() => {
          if (settled) return;
          const secure = tls.connect({ socket, servername: host, rejectUnauthorized: false });
          secure.once('secureConnect', () => {
            if (settled) return;
            settled = true;
            resolve(secure);
          });
          secure.once('error', fail);
          secure.setTimeout(timeoutMs, () => fail(new Error('TLS trop lent')));
        })
        .catch(fail);
    });
  });
}

/** Ouvre un tunnel vers « host:port » : CONNECT, ou SOCKS5 selon le proxy. */
export function connectVia(proxy, host, port, timeoutMs) {
  if (proxy && proxy.scheme === 'socks5') return socks5Tunnel(proxy, host, port, timeoutMs);
  return tunnel(proxy, host, port, timeoutMs);
}

/** Une requête à travers un proxy : un tunnel, une requête, on referme. */
async function throughProxy(proxy, request, ctx) {
  const socket = await connectVia(proxy, request.host, PORT, ctx.timeoutMs);
  try {
    return await overSocket(socket, { ...request, timeoutMs: ctx.timeoutMs });
  } finally {
    socket.destroy();
  }
}

/** La même requête, mais depuis l'adresse du serveur. */
async function direct(request, ctx) {
  const url = request.url || 'https://' + request.host + request.path;
  const response = await fetch(url, {
    method: request.method,
    headers: request.headers,
    body: request.body == null ? undefined : request.body,
    redirect: 'follow',
    signal: timeoutSignal(ctx.timeoutMs),
  });
  const body = await response.text();
  const headers = {};
  for (const [name, value] of response.headers) headers[name.toLowerCase()] = value;
  if (typeof response.headers.getSetCookie === 'function') {
    const cookies = response.headers.getSetCookie();
    if (cookies.length) headers['set-cookie'] = cookies;
  }
  return { status: response.status, headers, body: body.slice(0, 262144) };
}

/* ------------------------------------------------------------------ *
 * 5. Récolte et tri des proxys
 * ------------------------------------------------------------------ */

const CACHE = { at: 0, proxies: [], sources: [] };
const CACHE_MS = 5 * 60 * 1000;

export function sourceList() {
  const env = typeof process !== 'undefined' && process.env ? process.env : {};
  const custom = String(env.GUNS_PROXY_SOURCES || '').split(',').map((url) => url.trim()).filter(Boolean);
  if (!custom.length) return PROXY_SOURCES;
  return custom.map((url, index) => ({ name: 'source-' + (index + 1), url }));
}

function shuffle(list, random = Math.random) {
  for (let i = list.length - 1; i > 0; i--) {
    const j = Math.floor(random() * (i + 1));
    [list[i], list[j]] = [list[j], list[i]];
  }
  return list;
}

/** Récolte les listes publiques, dédoublonne, garde un cache de cinq minutes. */
export async function harvest(options = {}) {
  const now = Date.now();
  if (!options.refresh && CACHE.proxies.length && now - CACHE.at < CACHE_MS) {
    return { proxies: CACHE.proxies, sources: CACHE.sources, cached: true };
  }

  const sources = options.sources || sourceList();
  const perSource = num(options.perSource, 400, 20, 5000);
  const limit = num(options.limit, 1500, 50, 6000);
  const timeout = num(options.timeout, 12000, 2000, 30000);

  const answers = await Promise.all(sources.map(async (source) => {
    try {
      const response = await fetch(source.url, {
        headers: { accept: 'text/plain,*/*' },
        signal: timeoutSignal(timeout),
      });
      if (!response.ok) {
        return { name: source.name, type: source.type, scheme: source.scheme, text: null, error: 'HTTP ' + response.status };
      }
      return { name: source.name, type: source.type, scheme: source.scheme, text: await response.text(), error: null };
    } catch (err) {
      return { name: source.name, type: source.type, scheme: source.scheme, text: null, error: (err && err.message) || 'réseau' };
    }
  }));

  const seen = new Set();
  const proxies = [];
  const report = [];
  for (const answer of answers) {
    if (!answer.text) {
      report.push({ name: answer.name, count: 0, error: answer.error });
      continue;
    }
    const parser = answer.type === 'json' ? parseProxyJson : parseProxyList;
    let kept = 0;
    for (const proxy of parser(answer.text, { limit: perSource, scheme: answer.scheme })) {
      const key = (proxy.scheme || 'http') + '://' + proxy.host + ':' + proxy.port;
      if (seen.has(key)) continue;
      seen.add(key);
      proxies.push(proxy);
      kept++;
      if (proxies.length >= limit) break;
    }
    report.push({ name: answer.name, count: kept });
  }

  shuffle(proxies, options.random);
  CACHE.at = Date.now();
  CACHE.proxies = proxies;
  CACHE.sources = report;
  return { proxies, sources: report, cached: false };
}

export function clearCache() {
  CACHE.at = 0;
  CACHE.proxies = [];
  CACHE.sources = [];
}

/**
 * Trie les candidats pour de bon : tunnel CONNECT (ou SOCKS5), puis une vraie
 * requête HTTP sur `guns.lol:443`. Une poignée de main TLS seule ne prouve
 * rien — un proxy peut la terminer et ne jamais relayer. Seuls 2xx et 3xx
 * passent ; un 403 ou un 429 reste dans la réserve, mais classé après.
 */
export async function validate(proxies, options = {}) {
  const env = typeof process !== 'undefined' && process.env ? process.env : {};
  const concurrency = num(options.concurrency || env.GUNS_VALIDATE_CONCURRENCY, 120, 1, 400);
  const timeout = num(options.timeout || env.GUNS_VALIDATE_TIMEOUT_MS, 5000, 800, 20000);
  const max = num(options.max || env.GUNS_VALIDATE_MAX, 0, 0, 6000);
  const deadline = options.deadline || Infinity;

  const alive = [];
  const dead = [];
  const started = Date.now();
  let cursor = 0;

  async function worker() {
    for (;;) {
      if (Date.now() > deadline) return;
      if (max && alive.length >= max) return;
      const index = cursor++;
      if (index >= proxies.length) return;

      const proxy = proxies[index];
      const at = Date.now();
      try {
        const socket = await connectVia(proxy, PROFILE_HOST, PORT, timeout);
        try {
          const response = await overSocket(socket, {
            host: PROFILE_HOST,
            path: '/',
            method: 'GET',
            headers: {
              ...documentHeaders(BROWSERS[0], Math.random),
              accept: 'text/html,*/*',
              connection: 'close',
            },
            timeoutMs: timeout,
            maxBytes: 2048,
          });
          const status = response.status;
          if (status >= 400 && status !== 403 && status !== 429) throw new Error('HTTP ' + status);
          alive.push({ ...proxy, ms: Date.now() - at, status, challenged: status === 403 || status === 429 });
        } finally {
          socket.destroy();
        }
      } catch (err) {
        dead.push({ ...proxy, error: (err && err.message) || 'échec' });
      }
    }
  }

  await Promise.all(Array.from({ length: Math.min(concurrency, proxies.length || 1) }, worker));

  // les proxys propres d'abord, les plus rapides en tête : un 403 de Cloudflare
  // n'est pas un échec, mais il passe après ceux qui répondent vraiment.
  alive.sort((a, b) =>
    (Number(Boolean(a.challenged)) - Number(Boolean(b.challenged))) || (a.ms - b.ms));

  return { alive, dead, tested: alive.length + dead.length, ms: Date.now() - started };
}

/* ------------------------------------------------------------------ *
 * 6. Une vue
 * ------------------------------------------------------------------ */

function collectCookies(jar, headers) {
  const cookies = headers && headers['set-cookie'];
  if (!cookies) return;
  for (const entry of Array.isArray(cookies) ? cookies : [cookies]) {
    const pair = String(entry).split(';')[0].trim();
    if (pair && !jar.includes(pair)) jar.push(pair);
  }
}

function withCookies(headers, jar) {
  if (!jar.length) return headers;
  return { ...headers, cookie: jar.join('; ') };
}

function recordBody(slug, challenge, ctx) {
  const payload = { _t: ctx.turnstile || '' };
  try {
    payload._gpp_ch = solvePow(challenge, { random: ctx.random });
  } catch {
    payload._gpp_ch = challenge;
  }
  payload.username = slug;
  payload.deviceType = 'desktop';
  payload.event = 'view';
  payload.linkId = null;
  payload.referrer = '';
  return JSON.stringify(payload);
}

/**
 * Une vue complète, sur un proxy (ou en direct). Renvoie le détail de chaque
 * couche : c'est le rapport, pas une impression.
 */
async function attempt(proxy, slug, ctx) {
  const started = Date.now();
  const browser = pickBrowser(ctx.random);
  const result = { proxy: describeProxy(proxy), ok: false, via: null, ms: 0, steps: [], error: null, counter: null };
  const jar = [];
  let challenge = null;

  const call = async (label, request) => {
    let response;
    try {
      response = proxy
        ? await throughProxy(proxy, { ...request, headers: withCookies(request.headers, jar) }, ctx)
        : await direct({ ...request, headers: withCookies(request.headers, jar) }, ctx);
    } catch (err) {
      result.steps.push({ label, status: 0, ok: false, note: (err && err.message) || 'échec' });
      throw err;
    }
    collectCookies(jar, response.headers);
    const ok = response.status >= 200 && response.status < 400;
    result.steps.push({
      label,
      status: response.status,
      ok,
      note: response.headers['simple-analytics-feedback'] || '',
    });
    return response;
  };

  try {
    if (ctx.layers.page) {
      const response = await call('page', {
        host: PROFILE_HOST,
        path: profilePath(slug),
        method: 'GET',
        headers: documentHeaders(browser, ctx.random),
        maxBytes: 262144,
      });
      if (response.status >= 200 && response.status < 400) {
        challenge = parseChallenge(response.body);
        result.counter = guessViews(response.body);
      }
    }

    if (ctx.layers.pixel) {
      const url = pixelUrl(slug, { browser, random: ctx.random });
      await call('pixel', {
        host: PIXEL_HOST,
        path: pathOf(url),
        url,
        method: 'GET',
        headers: pixelHeaders(browser, slug, ctx.random),
        maxBytes: 8192,
      });
    }

    if (ctx.layers.view) {
      const response = await call('view', {
        host: PROFILE_HOST,
        path: VIEW_PATH + slug,
        method: 'POST',
        headers: { ...viewHeaders(browser, slug, ctx.random), 'content-length': '0' },
        maxBytes: 8192,
      });
      if (response.status >= 200 && response.status < 400) result.via = 'view';
    }

    if (ctx.layers.record && challenge) {
      const body = recordBody(slug, challenge, ctx);
      const response = await call('record', {
        host: PROFILE_HOST,
        path: RECORD_PATH,
        method: 'POST',
        headers: { ...recordHeaders(browser, slug, ctx.random), 'content-length': String(Buffer.byteLength(body)) },
        body,
        maxBytes: 16384,
      });
      if (response.status >= 200 && response.status < 400) {
        result.via = 'record';
      } else if (response.status === 400 || response.status === 404 || response.status === 405) {
        const alternate = await call('record-alt', {
          host: PROFILE_HOST,
          path: RECORD_ALT_PATH,
          method: 'POST',
          headers: { ...recordHeaders(browser, slug, ctx.random), 'content-length': String(Buffer.byteLength(body)) },
          body,
          maxBytes: 16384,
        });
        if (alternate.status >= 200 && alternate.status < 400) result.via = 'record';
      }
    }
  } catch (err) {
    result.error = (err && err.message) || 'échec';
  }

  result.ok = Boolean(result.via);
  result.ms = Date.now() - started;
  return result;
}

/** Le compteur affiché par la page, lu en direct (au mieux). */
async function readCounter(slug, ctx) {
  try {
    const response = await direct({
      host: PROFILE_HOST,
      path: profilePath(slug),
      method: 'GET',
      headers: documentHeaders(pickBrowser(ctx.random), ctx.random),
      maxBytes: 262144,
    }, ctx);
    return guessViews(response.body);
  } catch {
    return null;
  }
}

/* ------------------------------------------------------------------ *
 * 7. La passe complète
 * ------------------------------------------------------------------ */

/**
 * Pousse des vues sur un profil. Renvoie toujours un objet prêt à être envoyé :
 * « status » pour la réponse HTTP, le reste pour le corps.
 */
export async function boost(target, options = {}) {
  const started = Date.now();
  const cfg = config(options);
  const slug = extractSlug(target);

  if (!slug) {
    return {
      status: 400,
      ok: false,
      mode: 'invalid',
      error: 'No guns.lol username found in the input',
      hint: 'Expected "username", "@username" or a https://guns.lol/username link',
      input: String(target == null ? '' : target).slice(0, 120),
    };
  }

  const ctx = {
    random: options.random || Math.random,
    layers: normalizeLayers(options.layers),
    timeoutMs: cfg.timeoutMs,
    turnstile: cfg.turnstile,
  };

  const report = {
    status: 200,
    ok: true,
    mode: 'proxied',
    slug,
    target: profileUrl(slug),
    layers: { ...ctx.layers },
    views: { requested: cfg.views * cfg.rounds, attempts: 0, accepted: 0, failed: 0 },
    steps: { page: { tried: 0, ok: 0 }, pixel: { tried: 0, ok: 0 }, view: { tried: 0, ok: 0 }, record: { tried: 0, ok: 0 } },
    pool: { sources: [], harvested: 0, tested: 0, alive: 0, dead: 0, ms: 0, cached: false },
    counter: { before: null, after: null, delta: null, fromPages: null },
    attempts: [],
    notes: [],
    elapsed: 0,
    truncated: false,
  };

  const failures = { page: 0, pixel: 0, view: 0, record: 0 };
  const drop = (label) => {
    const layer = label === 'record-alt' ? 'record' : label;
    if (!ctx.layers[layer]) return;
    ctx.layers[layer] = false;
    report.layers[layer] = false;
    report.notes.push('layer "' + layer + '" dropped after 3 consecutive failures');
  };

  const keep = (result) => {
    report.views.attempts++;
    if (result.ok) report.views.accepted++;
    else report.views.failed++;
    if (result.counter && report.counter.fromPages === null) report.counter.fromPages = result.counter;

    for (const step of result.steps) {
      const label = step.label === 'record-alt' ? 'record' : step.label;
      const entry = report.steps[label] || (report.steps[label] = { tried: 0, ok: 0 });
      entry.tried++;
      if (step.ok) {
        entry.ok++;
        failures[label] = 0;
      } else {
        failures[label]++;
        if (failures[label] >= 3) drop(label);
      }
    }

    if (report.attempts.length < 80) {
      report.attempts.push({
        proxy: result.proxy,
        ok: result.ok,
        via: result.via,
        ms: result.ms,
        steps: result.steps.map((step) => step.label + ' ' + step.status).join(' · '),
        note: result.error || '',
      });
    }
  };

  /* --- réserve de proxys --- */
  let alive = [];
  if (!cfg.directOnly) {
    const poolStarted = Date.now();
    const harvested = await harvest({
      limit: cfg.proxies,
      perSource: cfg.perSource,
      refresh: cfg.refresh,
      random: ctx.random,
    });
    report.pool.sources = harvested.sources;
    report.pool.harvested = harvested.proxies.length;
    report.pool.cached = harvested.cached;

    const validation = await validate(harvested.proxies, {
      concurrency: cfg.validateConcurrency,
      timeout: cfg.validateTimeout,
      max: cfg.validateMax,
      deadline: poolStarted + cfg.validateBudgetMs,
    });
    alive = validation.alive;
    report.pool.tested = validation.tested;
    report.pool.alive = alive.length;
    report.pool.dead = validation.dead.length;
    report.pool.ms = Date.now() - poolStarted;
    if (alive.length) {
      report.notes.push(alive.length + ' of ' + report.pool.tested + ' proxies answered the tunnel + TLS test');
    }
  } else {
    report.mode = 'direct';
    report.notes.push('Direct mode requested: the server address is used, so guns.lol counts one view per round.');
  }

  if (!cfg.directOnly && !alive.length) {
    report.mode = 'direct-fallback';
    report.notes.push('No usable proxy found: falling back to the server address (one view per round).');
  }

  if (cfg.read) report.counter.before = await readCounter(slug, ctx);

  /* --- les vues --- */
  const attempts = alive.length ? report.views.requested : cfg.rounds;
  const concurrency = Math.max(1, Math.min(cfg.concurrency, attempts, 32));
  let cursor = 0;

  async function worker() {
    for (;;) {
      if (Date.now() - started > cfg.budgetMs) {
        report.truncated = true;
        return;
      }
      const index = cursor++;
      if (index >= attempts) return;
      const proxy = alive.length ? alive[index % alive.length] : null;
      keep(await attempt(proxy, slug, ctx));
    }
  }

  await Promise.all(Array.from({ length: concurrency }, worker));

  if (alive.length && report.views.requested > alive.length) {
    report.notes.push(report.views.requested + ' views for ' + alive.length +
      ' distinct addresses: guns.lol deduplicates per address and per day, so the extra ones may not count');
  }

  if (cfg.read) {
    report.counter.after = await readCounter(slug, ctx);
    if (report.counter.before !== null && report.counter.after !== null) {
      report.counter.delta = report.counter.after - report.counter.before;
    }
    if (report.counter.delta === null) {
      report.notes.push('The counter was not readable: guns.lol does not promise it in the HTML');
    }
  }

  report.elapsed = Date.now() - started;
  if (!report.views.accepted) {
    report.notes.push('No layer answered 2xx: the proxies may all be dead, or guns.lol may be challenging them');
  }
  return report;
}

/** Réserve seule : sources, compteurs, échantillon. Pour le bouton « tester ». */
export async function inspectPool(options = {}) {
  const cfg = config(options);
  const started = Date.now();
  const harvested = await harvest({
    limit: cfg.proxies,
    perSource: cfg.perSource,
    refresh: flag(options.refresh),
  });
  const validation = await validate(harvested.proxies, {
    concurrency: cfg.validateConcurrency,
    timeout: cfg.validateTimeout,
    max: cfg.validateMax,
    deadline: started + cfg.validateBudgetMs,
  });

  return {
    ok: true,
    sources: harvested.sources,
    harvested: harvested.proxies.length,
    cached: harvested.cached,
    tested: validation.tested,
    alive: validation.alive.length,
    dead: validation.dead.length,
    sample: validation.alive.slice(0, 30).map((proxy) => ({ proxy: describeProxy(proxy), ms: proxy.ms })),
    deadSample: validation.dead.slice(0, 10).map((proxy) => ({ proxy: describeProxy(proxy), error: proxy.error })),
    elapsed: Date.now() - started,
  };
}
