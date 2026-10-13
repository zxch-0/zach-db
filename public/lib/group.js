/*
 * zach-db — tri par site.
 *
 * Prend des lignes du type "https://www.xxx.com/xx/1111:1111" et les range
 * par nom de site (roblox.com, netflix.com, …), en gardant pour chacune la
 * partie "1111:1111" (ou ce que demandent les modes habituels).
 *
 * Aucune ligne ne garde la ligne entière : on ne stocke que les couples
 * extraits, ce qui permet de trier de gros fichiers sans tout charger.
 * Zéro dépendance, mémoire bornée.
 */
import { createLineExtractor, createBytesDecoder, createLineFeeder } from './parse.js';

export const NO_SITE = '(sans site)';

/* TLD en deux lettres → on garde un label de plus ("roblox.co.uk"). */
const SECOND_LEVEL = new Set(['co', 'com', 'net', 'org', 'gov', 'edu', 'ac', 'or', 'ne', 'go', 'in', 'me', 'gouv', 'asso', 'nom']);

const IPV4_RE = /^[0-9]{1,3}(\.[0-9]{1,3}){3}$/;
const HOST_RE = /^[a-z0-9_-]+(\.[a-z0-9_-]+)+$/i;
/* hôte trouvé sans schéma (ligne du type "roblox.com/login:u:p") */
const BARE_HOST_RE = /(?:(?:[0-9]{1,3}\.){3}[0-9]{1,3}|(?:[a-z0-9-]+\.)+[a-z]{2,})(?=[:\/]|$)/i;

function isTruthy(value) {
  return value === true || value === 1 || value === '1' || value === 'true' || value === 'on';
}

/** Caractères autorisés dans un nom d'hôte (lecture directe, sans regex). */
function readHost(line, start) {
  let i = start;
  const len = line.length;
  while (i < len) {
    const code = line.charCodeAt(i);
    const ok =
      (code >= 48 && code <= 57) || // 0-9
      (code >= 97 && code <= 122) || // a-z
      (code >= 65 && code <= 90) || // A-Z
      code === 45 || code === 46 || code === 95; // - . _
    if (!ok) break;
    i++;
  }
  return line.slice(start, i).replace(/\.+$/, '');
}

function isHostLike(host) {
  if (!host || host.indexOf('.') === -1) return false;
  if (/^[0-9.]+$/.test(host)) return IPV4_RE.test(host);
  return HOST_RE.test(host);
}

/**
 * Site d'une ligne, ou null si la ligne n'en contient pas.
 * Gère "https://…", "http://…", "//…", "site.com/x:u:p", les sous-domaines,
 * les ports et les IP (IPv4).
 */
export function siteFromLine(line) {
  // Ne considérer que les lignes commençant par http:// ou https://
  if (!/^https?:\/\//i.test(line)) return null;

  let start = -1;
  const scheme = line.indexOf('://');
  if (scheme !== -1) {
    start = scheme + 3;
    // userinfo : scheme://user:pass@hote/…
    const at = line.indexOf('@', start);
    if (at !== -1) {
      const slash = line.indexOf('/', start);
      if (slash === -1 || at < slash) start = at + 1;
    }
  } else if (line.startsWith('//')) {
    start = 2;
  } else {
    BARE_HOST_RE.lastIndex = 0;
    const match = BARE_HOST_RE.exec(line);
    if (!match) return null;
    start = match.index;
  }
  const host = readHost(line, start);
  return isHostLike(host) ? host : null;
}

/** "www.roblox.com" → "roblox.com" ; "a.b.co.uk" → "b.co.uk" ; IP inchangée. */
export function normalizeSite(host, options = {}) {
  let site = String(host).toLowerCase();
  if (options.stripSubdomains === false) return site;
  if (site.startsWith('www.')) site = site.slice(4);
  if (IPV4_RE.test(site)) return site;
  const labels = site.split('.');
  if (labels.length <= 2) return site;
  const tld = labels[labels.length - 1];
  const sld = labels[labels.length - 2];
  const keep = tld.length === 2 && SECOND_LEVEL.has(sld) ? 3 : 2;
  return labels.slice(-keep).join('.');
}

/**
 * Regroupe les lignes par site.
 *
 * options :
 *   mode / regex / hosts / dedupe   comme le moteur d'extraction
 *   stripSubdomains                 true (défaut) → "www." retiré et
 *                                   sous-domaines regroupés ; false → hôte exact
 *   keepText                        false → on ne garde que les compteurs
 *   maxTextBytes                    limite du texte conservé en mémoire
 *   onlySite                        ne traiter qu'un seul site
 *   noSiteLabel                     nom du groupe pour les lignes sans hôte
 *   onValue                         fonction(site, valeur) appelée pour chaque
 *                                   valeur gardée (permet d'écrire au fil de
 *                                   l'eau sans rien garder en mémoire)
 *
 * Retour : { push, pushBytes, flush, site(name), order(), stats() }
 * Chaque entrée : { site, count, bytes, text, truncated }
 */
export function createGrouper(options = {}) {
  const opts = options || {};
  const readLine = createLineExtractor(opts);
  const decode = createBytesDecoder();
  const dedupe = isTruthy(opts.dedupe);
  const keepText = opts.keepText !== false;
  const maxTextBytes = Number(opts.maxTextBytes) > 0 ? Number(opts.maxTextBytes) : Infinity;
  const onlySite = opts.onlySite ? String(opts.onlySite).toLowerCase() : null;
  const noSiteLabel = opts.noSiteLabel || NO_SITE;
  const onValue = typeof opts.onValue === 'function' ? opts.onValue : null;

  const sites = new Map(); // site → entrée
  const stats = { lines: 0, matched: 0, kept: 0, bytes: 0, skipped: 0, dropped: 0 };
  let textBytes = 0;

  function entryFor(site) {
    let entry = sites.get(site);
    if (!entry) {
      entry = { site, count: 0, bytes: 0, text: '', truncated: false, seen: dedupe ? new Set() : null };
      sites.set(site, entry);
    }
    return entry;
  }

  function handleLine(line) {
    stats.lines++;
    const pair = readLine(line);
    if (pair === null) {
      if (line.length !== 0) stats.skipped++; // les lignes vides ne comptent pas comme "ignorées"
      return null;
    }
    stats.matched++;

    const host = siteFromLine(line);
    if (host === null) {
      if (line.length !== 0) stats.skipped++; // lignes sans http:// ou https://
      return null;
    }
    const site = normalizeSite(host, opts);
    if (onlySite !== null && site !== onlySite) return null;

    const entry = entryFor(site);
    let from = 0;
    for (;;) {
      const nl = pair.indexOf('\n', from);
      const piece = nl === -1 ? pair.slice(from) : pair.slice(from, nl);
      const last = nl === -1;
      from = nl + 1;

      if (entry.seen !== null) {
        if (entry.seen.has(piece)) {
          if (last) break;
          continue;
        }
        entry.seen.add(piece);
      }

      const size = piece.length + 1;
      entry.count++;
      entry.bytes += size;
      stats.kept++;
      stats.bytes += size;
      if (onValue !== null) onValue(site, piece, entry);
      if (keepText) {
        if (textBytes + size <= maxTextBytes) {
          entry.text += piece + '\n';
          textBytes += size;
        } else {
          entry.truncated = true; // valeurs comptées mais texte non conservé
          stats.dropped++;
        }
      }
      if (last) break;
    }
    return null;
  }

  const feed = createLineFeeder(handleLine);

  return {
    push(text) {
      feed.push(text);
    },
    pushBytes(bytes) {
      feed.push(decode.pushBytes(bytes));
    },
    flush() {
      feed.push(decode.flush());
      feed.flush();
    },
    site(name) {
      return sites.get(name) || null;
    },
    sites() {
      return sites;
    },
    /** Sites triés : du plus gros au plus petit. */
    order() {
      return [...sites.values()].sort(
        (a, b) => b.bytes - a.bytes || b.count - a.count || (a.site < b.site ? -1 : a.site > b.site ? 1 : 0)
      );
    },
    storedBytes() {
      return textBytes;
    },
    stats: () => ({ ...stats }),
  };
}
