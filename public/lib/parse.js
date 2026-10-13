/*
 * zach-db — moteur d'extraction.
 * Partagé par le navigateur (worker), le serveur (API) et la CLI.
 * Zéro dépendance, traitement en flux (mémoire constante), ligne par ligne.
 *
 * Objectif : être le plus rapide possible. On évite donc toute allocation
 * inutile : pas de trim() systématique, pas de split(), pas de regex sur le
 * chemin le plus courant (modes "last" et "first"), décodage non-streaming.
 */

export const MODES = ['last', 'first', 'longest', 'all', 'custom'];

/* ------------------------------------------------------------------ *
 * 1. Ce qu'on considère comme un "segment" (user ou pass)
 * ------------------------------------------------------------------ */

/*
 * Un segment est une suite de caractères acceptés : lettres (accents
 * compris), chiffres, '.', '_', '@', '+', '-'. Tout le reste (espace, '/',
 * '[', ']', '(', ')', '<', '>', '"', '#', '?', '&', '%', '\', '|'…) coupe le
 * segment. C'est volontairement restrictif pour ne pas attraper des morceaux
 * d'URL. Pour élargir, on utilise le mode "custom".
 */
const IS_ASCII_TOKEN = new Uint8Array(128);
for (let code = 48; code <= 57; code++) IS_ASCII_TOKEN[code] = 1; // 0-9
for (let code = 65; code <= 90; code++) IS_ASCII_TOKEN[code] = 1; // A-Z
for (let code = 97; code <= 122; code++) IS_ASCII_TOKEN[code] = 1; // a-z
for (const ch of '._@+-') IS_ASCII_TOKEN[ch.charCodeAt(0)] = 1;

const UNICODE_TOKEN_RE = /[\p{L}\p{N}]/u;
const UNICODE_CACHE = new Map(); // code unit → booléen (mémoïsé)

function isUnicodeToken(code) {
  let known = UNICODE_CACHE.get(code);
  if (known === undefined) {
    known = UNICODE_TOKEN_RE.test(String.fromCharCode(code));
    UNICODE_CACHE.set(code, known);
  }
  return known;
}

function isTokenAt(line, index) {
  const code = line.charCodeAt(index);
  if (code < 128) return IS_ASCII_TOKEN[code] === 1;
  return isUnicodeToken(code);
}

// Pour les modes qui utilisent encore une regex (all / longest / custom).
const TOKEN_CLASS = 'A-Za-z0-9._@+\\-\\p{L}\\p{N}';
const TOKEN_SRC = `[${TOKEN_CLASS}]`;
/* Un "run" = des segments séparés par ':' (au moins deux). On le découpe
 * ensuite pour obtenir tous les couples adjacents : u:p:x → u:p et p:x.
 * (Une regex globale seule raterait le dernier couple d'un run, car le
 * premier match consommerait le segment du milieu.) */
const RUN_RE = new RegExp(`${TOKEN_SRC}+(?::${TOKEN_SRC}+)+`, 'gu');
const DEFAULT_CUSTOM_SRC = `(${TOKEN_SRC}+):(${TOKEN_SRC}+)`;

const IPV4_RE = /^[0-9]{1,3}(\.[0-9]{1,3}){3}$/;
const DOMAIN_RE = /^[a-z0-9-]+(\.[a-z0-9-]+)+$/i;
const PORT_RE = /^[0-9]{1,5}$/;

/**
 * "monsite.com:8080" ou "sub.domain.co:443" → hôte:port d'une URL, pas un
 * couple identifiant:mot de passe. Les adresses IP (127.0.0.1:8080) sont
 * conservées car elles servent souvent de couple user:pass.
 */
function isHostPort(left, right) {
  if (!PORT_RE.test(right)) return false; // la partie droite n'est pas un port
  if (left.indexOf('.') === -1) return false;
  if (IPV4_RE.test(left)) return false;
  return DOMAIN_RE.test(left);
}

/* ------------------------------------------------------------------ *
 * 2. Chemin rapide : modes "last" et "first" (scan manuel, sans allocation)
 * ------------------------------------------------------------------ */

/** Dernier couple de la ligne, en partant de la fin (donc très peu de travail). */
function lastPair(line, keepHosts) {
  const len = line.length;
  let i = len - 1;
  while (i >= 0) {
    while (i >= 0 && !isTokenAt(line, i)) i--;
    if (i < 0) return null;
    const end = i; // dernier caractère du segment
    while (i >= 0 && isTokenAt(line, i)) i--;
    const start = i + 1; // premier caractère du segment

    // le segment est-il précédé de ':' et d'un autre segment ? → couple x:y
    if (start >= 2 && line.charCodeAt(start - 1) === 58 && isTokenAt(line, start - 2)) {
      let head = start - 2;
      while (head > 0 && isTokenAt(line, head - 1)) head--;
      const left = line.slice(head, start - 1);
      const right = line.slice(start, end + 1);
      if (keepHosts || !isHostPort(left, right)) return left + ':' + right;
      i = start - 2; // c'était un hôte:port : on remonte au segment précédent
      continue;
    }
    i = start - 1; // ce segment n'ouvre aucun couple : on continue à gauche
  }
  return null;
}

/** Premier couple de la ligne (on s'arrête dès qu'on en tient un). */
function firstPair(line, keepHosts) {
  const len = line.length;
  let i = 0;
  while (i < len) {
    while (i < len && !isTokenAt(line, i)) i++;
    if (i >= len) return null;
    const start = i;
    while (i < len && isTokenAt(line, i)) i++;
    const end = i; // exclusif

    if (i < len && line.charCodeAt(i) === 58 && i + 1 < len && isTokenAt(line, i + 1)) {
      let k = i + 1;
      while (k < len && isTokenAt(line, k)) k++;
      const left = line.slice(start, end);
      const right = line.slice(i + 1, k);
      if (keepHosts || !isHostPort(left, right)) return left + ':' + right;
      i = i + 1; // hôte:port ignoré : on repart du segment suivant
      continue;
    }
    if (i < len && line.charCodeAt(i) === 58) i++; // ':' sans segment derrière
  }
  return null;
}

/** Tous les couples de la ligne (mode "all" et "longest"). */
function collectPairs(line, out, keepHosts) {
  out.length = 0;
  RUN_RE.lastIndex = 0;
  let m;
  while ((m = RUN_RE.exec(line)) !== null) {
    const segments = m[0].split(':');
    for (let i = 0; i + 1 < segments.length; i++) {
      const left = segments[i];
      const right = segments[i + 1];
      if (!keepHosts && isHostPort(left, right)) continue;
      out.push(left + ':' + right);
    }
  }
  return out;
}

function compileCustom(source) {
  const raw = String(source == null ? '' : source).trim() || DEFAULT_CUSTOM_SRC;
  let body = raw;
  let flags = 'g';
  const delimited = /^\/([\s\S]*)\/([a-z]*)$/.exec(raw);
  if (delimited) {
    body = delimited[1];
    flags = delimited[2] || '';
  }
  if (!flags.includes('g')) flags += 'g';
  if (!flags.includes('u')) flags += 'u';
  return new RegExp(body, flags); // lève une erreur si la regex est invalide
}

function extractLine(line, mode, customRe, keepHosts, scratch) {
  if (mode === 'last') return lastPair(line, keepHosts);
  if (mode === 'first') return firstPair(line, keepHosts);

  if (mode === 'custom') {
    const trimmed = line.trim();
    if (!trimmed) return null;
    customRe.lastIndex = 0;
    let res = null;
    let m;
    while ((m = customRe.exec(trimmed)) !== null) {
      const value = m.length > 1 && m[1] !== undefined ? m[1] : m[0];
      if (value) res = res === null ? value : res + '\n' + value;
      if (m[0] === '') customRe.lastIndex++;
    }
    return res;
  }

  const pairs = collectPairs(line, scratch, keepHosts);
  const count = pairs.length;
  if (count === 0) return null;
  if (mode === 'all') {
    let res = pairs[0];
    for (let i = 1; i < count; i++) res += '\n' + pairs[i];
    return res;
  }
  // longest : la partie droite (le "pass") la plus longue ; à égalité, le
  // couple le plus à droite (les identifiants sont en général à la fin).
  let best = pairs[0];
  let bestLen = -1;
  for (let i = 0; i < count; i++) {
    const pair = pairs[i];
    const len = pair.length - pair.indexOf(':') - 1;
    if (len >= bestLen) {
      bestLen = len;
      best = pair;
    }
  }
  return best;
}

/**
 * Fabrique un extracteur de ligne réutilisable : renvoie la valeur extraite
 * ('user:pass', plusieurs lignes pour le mode "all") ou null.
 * Utilisé par createProcessor et par createGrouper (tri par site).
 */
export function createLineExtractor(options = {}) {
  const mode = MODES.includes(options.mode) ? options.mode : 'last';
  const customRe = mode === 'custom' ? compileCustom(options.regex) : null;
  const keepHosts = isTruthy(options.hosts);
  const scratch = [];
  return (line) => {
    if (line.length && line.charCodeAt(line.length - 1) === 13) line = line.slice(0, -1);
    return extractLine(line, mode, customRe, keepHosts, scratch);
  };
}

/**
 * Découpe un texte en lignes au fil de l'eau (les lignes à cheval sur deux
 * blocs sont conservées) et passe chacune à `onLine`.
 * `onLine` renvoie ce qu'il faut accumuler (ou null). Le texte accumulé est
 * renvoyé par push()/flush().
 */
export function createLineFeeder(onLine) {
  let rest = '';
  let single = null;

  function collect(line) {
    const out = onLine(line);
    if (out === null || out === '') return;
    single = single === null ? out : single + out;
  }

  function take() {
    const out = single === null ? '' : single;
    single = null;
    return out;
  }

  return {
    push(text) {
      if (rest) {
        text = rest + text;
        rest = '';
      }
      let start = 0;
      let nl;
      while ((nl = text.indexOf('\n', start)) !== -1) {
        collect(text.slice(start, nl));
        start = nl + 1;
      }
      if (start < text.length) rest = text.slice(start);
      return take();
    },
    flush() {
      if (rest) {
        const line = rest;
        rest = '';
        collect(line);
      }
      return take();
    },
  };
}

/* ------------------------------------------------------------------ *
 * 3. Décodage des octets (UTF-8, UTF-16 avec BOM)
 * ------------------------------------------------------------------ */

const BOM_LE = [0xff, 0xfe];
const BOM_BE = [0xfe, 0xff];

/**
 * Décodeur d'octets incrémental réutilisable (UTF-8, ou UTF-16 si BOM).
 * Le décodage se fait sans le mode streaming de TextDecoder (beaucoup plus
 * rapide) : les séquences UTF-8 à cheval sur deux blocs sont conservées.
 */
export function createBytesDecoder() {
  let decoder = new TextDecoder('utf-8');
  let ready = false;
  let pending = null;
  return {
    pushBytes(bytes) {
      if (!ready) {
        ready = true;
        if (bytes.length >= 2) {
          if (bytes[0] === BOM_LE[0] && bytes[1] === BOM_LE[1]) decoder = new TextDecoder('utf-16le');
          else if (bytes[0] === BOM_BE[0] && bytes[1] === BOM_BE[1]) {
            try {
              decoder = new TextDecoder('utf-16be');
            } catch {
              /* certains runtimes n'ont pas utf-16be : on reste en utf-8 */
            }
          }
        }
      }
      if (pending) {
        bytes = concatBytes(pending, bytes);
        pending = null;
      }
      const tail = incompleteTail(bytes, bytes.length);
      if (tail === 0) return decoder.decode(bytes);
      const body = bytes.subarray(0, bytes.length - tail);
      pending = bytes.subarray(bytes.length - tail);
      return decoder.decode(body);
    },
    flush() {
      const out = pending ? decoder.decode(pending) : '';
      pending = null;
      return out + decoder.decode();
    },
  };
}

/**
 * Longueur de la séquence UTF-8 incomplète en fin de bloc (0 si le bloc
 * s'arrête proprement). Permet d'utiliser decode() sans mode streaming, qui
 * est bien plus rapide.
 */
function incompleteTail(bytes, end) {
  if (end === 0) return 0;
  const last = bytes[end - 1];
  if (last < 0x80) return 0; // ASCII
  if (last >= 0xc0) return 1; // octet de tête seul
  let i = end - 2;
  let count = 1;
  while (i >= 0 && count < 3 && (bytes[i] & 0xc0) === 0x80) {
    i--;
    count++;
  }
  if (i < 0) return 0;
  const lead = bytes[i];
  const need = lead >= 0xf0 ? 4 : lead >= 0xe0 ? 3 : lead >= 0xc0 ? 2 : 1;
  const have = end - i;
  return have < need ? have : 0;
}

function concatBytes(a, b) {
  const merged = new Uint8Array(a.length + b.length);
  merged.set(a, 0);
  merged.set(b, a.length);
  return merged;
}

function isTruthy(value) {
  return value === true || value === 1 || value === '1' || value === 'true' || value === 'on';
}

/* ------------------------------------------------------------------ *
 * 4. Processeur en flux
 * ------------------------------------------------------------------ */

/**
 * Crée un processeur en flux.
 *
 * options :
 *   mode    'last' | 'first' | 'longest' | 'all' | 'custom'
 *   regex   source de regex (mode custom)
 *   dedupe  ne garder qu'une fois chaque valeur
 *   hosts   true => ne pas ignorer les faux couples "domaine.tld:port"
 *   count   true => on ne produit aucun texte, on compte seulement
 *   skip    nombre d'octets de sortie à sauter (passes multiples)
 *   limit   nombre d'octets de sortie à produire au maximum
 *
 * Retour : { push(text), pushBytes(uint8array), flush(), stats() }
 * stats() = { lines, matched, outLines, outChars, emittedBytes }
 * outChars = taille totale de la sortie ; emittedBytes = octets renvoyés par
 * cette passe (utile pour les passes multiples). '\n' est compté (1 octet).
 */
export function createProcessor(options = {}) {
  const opts = options || {};
  const mode = MODES.includes(opts.mode) ? opts.mode : 'last';
  const customRe = mode === 'custom' ? compileCustom(opts.regex) : null;
  const seen = isTruthy(opts.dedupe) ? new Set() : null;
  const countOnly = isTruthy(opts.count);
  const keepHosts = isTruthy(opts.hosts);
  const skipBytes = Number(opts.skip) > 0 ? Number(opts.skip) : 0;
  const limitBytes = Number(opts.limit) > 0 ? Number(opts.limit) : Infinity;
  const windowEnd = skipBytes + limitBytes;
  const stats = { lines: 0, matched: 0, outLines: 0, outChars: 0, emittedBytes: 0 };
  let pos = 0; // position dans la sortie complète

  const decode = createBytesDecoder();
  const readLine = createLineExtractor({ mode, regex: opts.regex, hosts: keepHosts });

  /**
   * Comptabilise un bloc de sortie (1 ou plusieurs lignes, '\n' final inclus)
   * puis le renvoie seulement s'il tombe dans la fenêtre demandée.
   */
  function emit(block, rows, bytes) {
    stats.outLines += rows;
    stats.outChars += bytes;
    const start = pos;
    pos += bytes;
    if (countOnly) return null;
    if (start < skipBytes || start >= windowEnd) return null;
    stats.emittedBytes += bytes;
    return block;
  }

  function handleLine(line) {
    stats.lines++;
    const out = readLine(line);
    if (out === null) return null;
    stats.matched++;

    // Sans dédoublonnage : la ligne extraite part telle quelle.
    if (seen === null) return emit(countOnly ? '' : out + '\n', 1, out.length + 1);

    // Avec dédoublonnage : on filtre chaque valeur puis on regroupe.
    let kept = '';
    let keptRows = 0;
    let keptBytes = 0;
    let from = 0;
    for (;;) {
      const nl = out.indexOf('\n', from);
      const piece = nl === -1 ? out.slice(from) : out.slice(from, nl);
      if (!seen.has(piece)) {
        seen.add(piece);
        if (!countOnly) kept += (keptRows === 0 ? '' : '\n') + piece;
        keptRows++;
        keptBytes += piece.length + 1;
      }
      if (nl === -1) break;
      from = nl + 1;
    }
    if (keptRows === 0) return null;
    return emit(countOnly ? '' : kept + '\n', keptRows, keptBytes);
  }

  const feed = createLineFeeder(handleLine);

  function push(text) {
    return feed.push(text);
  }

  function pushBytes(bytes) {
    return push(decode.pushBytes(bytes));
  }

  function flush() {
    return push(decode.flush()) + feed.flush();
  }

  return {
    mode,
    push,
    pushBytes,
    flush,
    stats: () => ({ ...stats }),
  };
}

/** Raccourci pratique (tests, petites chaînes) : texte entier → texte extrait. */
export function extract(text, options = {}) {
  const processor = createProcessor(options);
  return processor.push(text) + processor.flush();
}
