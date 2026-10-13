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
const BARE_HOST_GLOBAL_RE = new RegExp(BARE_HOST_RE.source, 'gi');

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
 * les ports et les IP (IPv4). La ligne peut commencer par du texte ou par
 * un crochet : on cherche le premier hôte d'URL de la ligne.
 */
export function siteFromLine(line) {
  if (!line) return null;

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
  } else {
    const slashes = line.indexOf('//');
    if (slashes !== -1) {
      start = slashes + 2;
    } else {
      // Premier hôte nu de la ligne, en sautant les domaines d'adresse
      // email : dans "quelquun@gmail.com:motdepasse", "gmail.com" fait
      // partie du combo, ce n'est pas un site.
      BARE_HOST_GLOBAL_RE.lastIndex = 0;
      let match;
      start = -1;
      while ((match = BARE_HOST_GLOBAL_RE.exec(line)) !== null) {
        if (match.index > 0 && line[match.index - 1] === '@') continue;
        start = match.index;
        break;
      }
      if (start === -1) return null;
    }
  }
  const host = readHost(line, start);
  return isHostLike(host) ? host : null;
}

/* ------------------------------------------------------------------ *
 * Site réellement associé à un combo
 *
 * Un hôte cité sur la ligne ne suffit pas : seul compte l'hôte qui
 * précède le combo dans le même bloc (un bloc = le texte entre deux
 * crochets « [ » / « ] »). Ainsi :
 *   "faux.com [vrai.com:user:pass]"     → vrai.com
 *   "[faux.com] vrai.com:user:pass"     → vrai.com
 *   "faux.com [user:pass]"              → aucun site (« (sans site) »)
 *   "[https://a.com/x:u:p](https://b.com/y:u:p)" en mode « last »
 *                                       → b.com (le combo gardé est là)
 * Le domaine d'un email du combo n'est jamais un site :
 *   "[https://sso.exemple.com/login:quelquun@gmail.com:mdp](…)"
 *                                       → sso.exemple.com, pas gmail.com
 * ------------------------------------------------------------------ */

const HOST_SRC = String.raw`(?:[0-9]{1,3}\.){3}[0-9]{1,3}|[a-z0-9-]+(?:\.[a-z0-9-]+)+`;
const SCHEME_HOST_RE = new RegExp(String.raw`[a-z][a-z0-9+.-]*://(?:[^/\s@]*@)?(${HOST_SRC})`, 'gi');
const SLASH_HOST_RE = new RegExp(String.raw`//(${HOST_SRC})`, 'g');
const BARE_CANDIDATE_RE = new RegExp(String.raw`(${HOST_SRC})(?=[:/\s]|$)`, 'gi');

/**
 * Hôtes candidats dans `prefix` (texte situé avant le combo), avec la
 * position de fin de chacun. On retient ensuite le plus proche du combo.
 * Un mot pointé du chemin d'une URL ("login.php" dans
 * "site.com/login.php:user:pass") n'est pas un candidat : il est collé
 * au "/" du chemin, pas en début de bloc ou après un séparateur.
 */
function hostCandidatesBefore(prefix) {
  const candidates = [];
  const collect = (re, hostOf) => {
    re.lastIndex = 0;
    let match;
    while ((match = re.exec(prefix)) !== null) {
      const host = hostOf(match);
      if (host && isHostLike(host)) {
        candidates.push({ host, end: match.index + match[0].length });
      }
      if (match[0] === '') re.lastIndex++;
    }
  };

  // hôte d'autorité d'une URL : scheme://hôte/… (userinfo comprise)
  collect(SCHEME_HOST_RE, (match) => match[1]);
  // hôte après "//" (URL sans schéma) — le doublon éventuel avec le
  // cas précédent désigne le même hôte à la même place, sans effet.
  collect(SLASH_HOST_RE, (match) => match[1]);
  // hôte nu, seulement s'il ouvre un bloc ou suit un séparateur :
  // "vrai.com:user:pass", "prefix vrai.com/…", mais pas "…/login.php:…".
  // Un domaine juste après "@" est celui d'un email du combo
  // ("quelquun@gmail.com") : jamais un site, il est donc rejeté ici
  // comme les autres caractères non séparateurs.
  collect(BARE_CANDIDATE_RE, (match) => {
    const before = match.index === 0 ? '' : prefix[match.index - 1];
    if (before && !/[\s([{'"<|;,]/.test(before)) return null;
    return match[1];
  });

  let best = null;
  for (const candidate of candidates) {
    if (best === null || candidate.end >= best.end) best = candidate;
  }
  return best === null ? null : best.host;
}

/**
 * Site associé au combo `pair` extrait de `line`, ou null s'il n'y en a
 * pas. `pair` peut contenir plusieurs valeurs (mode "all" / "custom") :
 * on s'ancre sur la première, sauf en mode "last" où l'on s'ancre sur
 * la dernière, puisque c'est elle que l'extracteur a gardée. Le bloc
 * (entre crochets) qui contient ce combo fait foi : s'il n'a pas
 * d'hôte avant le combo, aucun site emprunté à un autre bloc ne compte.
 */
export function siteForPair(line, pair, options = {}) {
  if (!line || !pair) return null;
  const mode = ['last', 'first', 'longest', 'all', 'custom'].includes(options.mode)
    ? options.mode
    : 'last';
  const pieces = String(pair).split('\n');
  const anchor = mode === 'last' ? pieces[pieces.length - 1] : pieces[0];
  if (!anchor) return null;

  const blocks = String(line).split(/[\[\]]/);
  const order = blocks.map((_, index) => index);
  if (mode === 'last') order.reverse();

  for (const index of order) {
    const block = blocks[index];
    const at = mode === 'last' ? block.lastIndexOf(anchor) : block.indexOf(anchor);
    if (at === -1) continue;

    // le bloc du combo est trouvé : lui seul peut fournir le site
    const before = hostCandidatesBefore(block.slice(0, at));
    if (before !== null) return before;

    // combo dont la partie gauche est elle-même un hôte
    // ("monsite.com:8080" avec l'option hosts, "user.name:pass"…).
    // Une partie gauche d'email ("quelquun@gmail.com:mdp") ne compte
    // pas : son domaine n'est pas un site.
    const colon = anchor.indexOf(':');
    if (colon > 0) {
      const left = anchor.slice(0, colon);
      if (!left.includes('@') && isHostLike(left)) return left;
    }
    return null;
  }

  // combo introuvable tel quel dans la ligne (regex perso qui capture
  // un morceau transformé) : on retombe sur l'hôte avant sa première
  // valeur si elle apparaît dans un bloc, sinon aucun site.
  return null;
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

    // Seul le site situé avant le combo, dans le même bloc (hors de
    // tout crochet étranger au combo), compte. Sans site associé, la
    // valeur va dans le groupe « (sans site) » au lieu d'être perdue
    // ou rangée sous un site cité ailleurs sur la ligne.
    const host = siteForPair(line, pair, opts);
    const site = host === null ? noSiteLabel : normalizeSite(host, opts);
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
