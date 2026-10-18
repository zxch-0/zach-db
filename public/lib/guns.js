/*
 * zach-db — outil « Guns.lol views » : ce qui se partage entre le navigateur,
 * le serveur et la CLI.
 *
 * Aucun import, aucun accès réseau : ce fichier décrit guns.lol (adresses,
 * en-têtes crédibles, lecture d'un pseudo, lecture des listes de proxys). Le
 * transport, lui, est dans guns-api.js, réservé au serveur et à la CLI.
 *
 * Comment guns.lol enregistre une vue (constaté en octobre 2026) :
 *   1. GET  /<pseudo>                 la page, qui porte un challenge « _gpp_ch » ;
 *   2. GET  sa.guns.lol/simple.gif?…  le pixel d'analytics (pageview) ;
 *   3. POST /api/view/<pseudo>        l'ancien point d'entrée, encore vivant ;
 *   4. POST /api/analytics/record     l'événement « view » signé (PoW + Turnstile).
 * Les vues sont dédupliquées par adresse IP et par jour : un proxy utilisable
 * vaut une vue, et les listes publiques gratuites n'en donnent que 5 à 15 %.
 */

export const PROFILE_HOST = 'guns.lol';
export const PIXEL_HOST = 'sa.guns.lol';
export const PROFILE_BASE = 'https://' + PROFILE_HOST;
export const PIXEL_BASE = 'https://' + PIXEL_HOST;
export const PORT = 443;
export const VIEW_PATH = '/api/view/';
export const RECORD_PATH = '/api/analytics/record';
export const RECORD_ALT_PATH = '/api/analytics/view';
export const PIXEL_PATH = '/simple.gif';

/* ------------------------------------------------------------------ *
 * 1. Le pseudo
 * ------------------------------------------------------------------ */

const SLUG_RE = /^[A-Za-z0-9][A-Za-z0-9._-]{0,39}$/;

function safeDecode(value) {
  try {
    return decodeURIComponent(value);
  } catch {
    return value;
  }
}

function acceptSlug(candidate) {
  const slug = String(candidate == null ? '' : candidate).trim();
  if (!slug) return null;
  return SLUG_RE.test(slug) ? slug : null;
}

/**
 * Pseudo d'un profil guns.lol, ou null. Accepte le pseudo nu, « @pseudo »,
 * « guns.lol/pseudo » et l'adresse complète — y compris celle d'un autre hôte,
 * dont on garde alors le premier segment du chemin. Le schéma, la query, le
 * slash final et l'ancre sont ignorés.
 */
export function extractSlug(input) {
  if (input == null) return null;
  let text = String(input).trim();
  if (!text) return null;
  text = text.replace(/^@+/, '').replace(/^[a-z][a-z0-9+.-]*:\/\//i, '');

  const address = /^(?:[^/?#\s]*@)?(?:www\.)?guns\.lol(?::\d+)?\/([^/?#\s]+)/i.exec(text);
  if (address) return acceptSlug(safeDecode(address[1]));

  // adresse d'un autre hôte : le premier segment du chemin, s'il existe
  const slash = text.indexOf('/');
  if (slash > 0 && text.slice(0, slash).includes('.')) {
    const segment = text.slice(slash + 1).split(/[?#]/)[0].split('/')[0];
    const fromPath = acceptSlug(safeDecode(segment));
    if (fromPath) return fromPath;
  }

  const token = text.split(/[\s/?#]+/)[0];
  return acceptSlug(safeDecode(token));
}

export const profileUrl = (slug) => PROFILE_BASE + '/' + slug;
export const profilePath = (slug) => '/' + slug;
export const viewPath = (slug) => VIEW_PATH + slug;
export const viewUrl = (slug) => PROFILE_BASE + VIEW_PATH + slug;
export const recordUrl = () => PROFILE_BASE + RECORD_PATH;

/** « hote:port », pour les journaux. */
export function describeProxy(proxy) {
  return proxy ? proxy.host + ':' + proxy.port : 'direct';
}

/* ------------------------------------------------------------------ *
 * 2. Les navigateurs simulés (l'adresse change, pas la crédibilité)
 * ------------------------------------------------------------------ */

function chromeUserAgent(system, version) {
  return 'Mozilla/5.0 (' + system + ') AppleWebKit/537.36 (KHTML, like Gecko) Chrome/' +
    version + '.0.0.0 Safari/537.36';
}

function chromeBrands(version) {
  return JSON.stringify([
    { brand: 'Not)A;Brand', version: '24' },
    { brand: 'Chromium', version },
    { brand: 'Google Chrome', version },
  ]);
}

function chromeHints(version) {
  return '"Not)A;Brand";v="24", "Chromium";v="' + version + '", "Google Chrome";v="' + version + '"';
}

const SYSTEMS = [
  { version: '151', system: 'Windows NT 10.0; Win64; x64', platform: '"Windows"', osName: 'Windows', osVersion: '15.0.0' },
  { version: '150', system: 'Windows NT 10.0; Win64; x64', platform: '"Windows"', osName: 'Windows', osVersion: '15.0.0' },
  { version: '151', system: 'Macintosh; Intel Mac OS X 10_15_7', platform: '"macOS"', osName: 'macOS', osVersion: '15.0.0' },
  { version: '149', system: 'X11; Linux x86_64', platform: '"Linux"', osName: 'Linux', osVersion: '' },
];

export const BROWSERS = SYSTEMS.map((entry) => ({
  ...entry,
  ua: chromeUserAgent(entry.system, entry.version),
  hints: chromeHints(entry.version),
  brands: chromeBrands(entry.version),
}));

const LANGUAGES = ['en-US,en;q=0.9', 'en-US,en;q=0.8', 'en-GB,en;q=0.9,fr;q=0.8'];
const TIMEZONES = ['Europe/Paris', 'Europe/London', 'America/New_York', 'Europe/Berlin'];

const pickFrom = (list, random) => list[Math.min(list.length - 1, Math.floor(random() * list.length))];

/** Un navigateur au hasard, pour qu'un même proxy ne se répète pas à l'identique. */
export function pickBrowser(random = Math.random) {
  return pickFrom(BROWSERS, random);
}

export function randomToken(length, random = Math.random) {
  const hex = '0123456789abcdef';
  let out = '';
  for (let i = 0; i < length; i++) out += hex[Math.floor(random() * 16)];
  return out;
}

function language(random) {
  return pickFrom(LANGUAGES, random);
}

/* ------------------------------------------------------------------ *
 * 3. Les en-têtes : une navigation, pas un robot
 * ------------------------------------------------------------------ */

const ACCEPT_HTML = 'text/html,application/xhtml+xml,application/xml;q=0.9,image/avif,image/webp,image/apng,*/*;q=0.8,application/signed-exchange;v=b3;q=0.7';

export function documentHeaders(browser, random = Math.random) {
  return {
    'user-agent': browser.ua,
    accept: ACCEPT_HTML,
    'accept-language': language(random),
    'cache-control': 'no-cache',
    pragma: 'no-cache',
    'upgrade-insecure-requests': '1',
    'sec-ch-ua': browser.hints,
    'sec-ch-ua-mobile': '?0',
    'sec-ch-ua-platform': browser.platform,
    'sec-fetch-dest': 'document',
    'sec-fetch-mode': 'navigate',
    'sec-fetch-site': 'none',
    'sec-fetch-user': '?1',
  };
}

export function pixelHeaders(browser, slug, random = Math.random) {
  return {
    'user-agent': browser.ua,
    accept: 'image/avif,image/webp,image/apng,image/svg+xml,image/*,*/*;q=0.8',
    'accept-language': language(random),
    'cache-control': 'no-cache',
    pragma: 'no-cache',
    referer: profileUrl(slug),
    'sec-ch-ua': browser.hints,
    'sec-ch-ua-mobile': '?0',
    'sec-ch-ua-platform': browser.platform,
    'sec-fetch-dest': 'image',
    'sec-fetch-mode': 'no-cors',
    'sec-fetch-site': 'same-site',
  };
}

export function viewHeaders(browser, slug, random = Math.random) {
  return {
    'user-agent': browser.ua,
    accept: '*/*',
    'accept-language': language(random),
    'cache-control': 'no-cache',
    pragma: 'no-cache',
    origin: PROFILE_BASE,
    referer: profileUrl(slug),
    username: slug,
    'sec-ch-ua': browser.hints,
    'sec-ch-ua-mobile': '?0',
    'sec-ch-ua-platform': browser.platform,
    'sec-fetch-dest': 'empty',
    'sec-fetch-mode': 'cors',
    'sec-fetch-site': 'same-origin',
  };
}

export function recordHeaders(browser, slug, random = Math.random) {
  return {
    'user-agent': browser.ua,
    accept: '*/*',
    'accept-language': language(random),
    'cache-control': 'no-cache',
    pragma: 'no-cache',
    'content-type': 'text/plain;charset=UTF-8',
    origin: PROFILE_BASE,
    referer: profileUrl(slug),
    'sec-ch-ua': browser.hints,
    'sec-ch-ua-mobile': '?0',
    'sec-ch-ua-platform': browser.platform,
    'sec-fetch-dest': 'empty',
    'sec-fetch-mode': 'cors',
    'sec-fetch-site': 'same-origin',
  };
}

/* ------------------------------------------------------------------ *
 * 4. Le pixel d'analytics
 * ------------------------------------------------------------------ */

/** Adresse du pixel, avec un identifiant de page neuf à chaque vue. */
export function pixelUrl(slug, options = {}) {
  const random = options.random || Math.random;
  const browser = options.browser || pickBrowser(random);
  const pageId = randomToken(32, random);
  const params = new URLSearchParams();

  params.set('version', 'custom_latest_11');
  params.set('hostname', PROFILE_HOST);
  params.set('ua', browser.ua);
  params.set('https', 'true');
  params.set('timezone', pickFrom(TIMEZONES, random));
  params.set('page_id', pageId);
  params.set('session_id', randomToken(32, random));
  params.set('sri', 'false');
  params.set('mobile', 'false');
  params.set('brands', browser.brands);
  params.set('os_name', browser.osName);
  params.set('os_version', browser.osVersion);
  params.set('path', profilePath(slug));
  params.set('viewport_width', String(1024 + Math.floor(random() * 900)));
  params.set('viewport_height', String(720 + Math.floor(random() * 400)));
  params.set('language', 'en-US');
  params.set('screen_width', '1920');
  params.set('screen_height', '1080');
  params.set('unique', 'true');
  params.set('id', pageId);
  params.set('type', 'pageview');
  params.set('time', String(Date.now()));

  return PIXEL_BASE + PIXEL_PATH + '?' + params.toString();
}

/** Le chemin d'une adresse absolue, pour le tunnel CONNECT. */
export function pathOf(url) {
  const at = String(url).indexOf('/', String(url).indexOf('://') + 3);
  return at === -1 ? '/' : String(url).slice(at);
}

/* ------------------------------------------------------------------ *
 * 5. Les listes de proxys
 * ------------------------------------------------------------------ */

/*
 * Sept listes publiques, tenues à jour par d'autres. Elles tombent parfois :
 * le serveur encaisse l'échec d'une source sans s'arrêter.
 */
export const PROXY_SOURCES = [
  { name: 'proxifly', url: 'https://raw.githubusercontent.com/proxifly/free-proxy-list/main/proxies/protocols/http/data.txt' },
  { name: 'TheSpeedX', url: 'https://raw.githubusercontent.com/TheSpeedX/PROXY-List/master/http.txt' },
  { name: 'monosans', url: 'https://raw.githubusercontent.com/monosans/proxy-list/main/proxies/http.txt' },
  { name: 'clarketm', url: 'https://raw.githubusercontent.com/clarketm/proxy-list/master/proxy-list-raw.txt' },
  { name: 'ShiftyTR', url: 'https://raw.githubusercontent.com/ShiftyTR/Proxy-List/master/http.txt' },
  { name: 'proxy-list.download', url: 'https://www.proxy-list.download/api/v1/get?type=http' },
  { name: 'proxyscrape', url: 'https://api.proxyscrape.com/v2/?request=displayproxies&protocol=http&timeout=10000&country=all&ssl=all&anonymity=all' },
];

/** Une ligne de liste → { host, port, auth }. Les lignes inutilisables sont ignorées. */
export function parseProxyLine(line) {
  let text = String(line == null ? '' : line).trim();
  if (!text || text.startsWith('#') || text.startsWith('//')) return null;

  text = text.replace(/^[a-zA-Z][a-zA-Z0-9+.-]*:\/\//, '');
  const slash = text.indexOf('/');
  if (slash !== -1) text = text.slice(0, slash);

  let auth = null;
  const at = text.lastIndexOf('@');
  if (at > 0) {
    auth = text.slice(0, at);
    text = text.slice(at + 1);
  }

  const colon = text.lastIndexOf(':');
  if (colon <= 0) return null;
  const host = text.slice(0, colon).trim();
  const port = Number(text.slice(colon + 1).trim());
  if (!host || !Number.isInteger(port) || port < 1 || port > 65535) return null;
  if (!/^[A-Za-z0-9._-]+$/.test(host)) return null;
  return { host, port, auth: auth || null };
}

/** Toute une liste, dédoublonnée par hote:port. */
export function parseProxyList(text, options = {}) {
  const limit = Number(options.limit) > 0 ? Number(options.limit) : Infinity;
  const seen = new Set();
  const out = [];
  for (const raw of String(text || '').split(/[\s,;]+/)) {
    const proxy = parseProxyLine(raw);
    if (!proxy) continue;
    const key = proxy.host + ':' + proxy.port;
    if (seen.has(key)) continue;
    seen.add(key);
    out.push(proxy);
    if (out.length >= limit) break;
  }
  return out;
}

/* ------------------------------------------------------------------ *
 * 6. Le challenge « _gpp_ch »
 * ------------------------------------------------------------------ */

/**
 * Le tableau du challenge, tel qu'il est écrit dans la page. Le HTML échappe
 * ses guillemets : on retire les barres obliques inverses avant de lire.
 * Renvoie null si le marqueur ou le tableau manquent.
 */
export function parseChallenge(html) {
  if (!html) return null;
  const text = String(html);
  const marker = '"_gpp_ch":';
  const at = text.indexOf(marker);
  if (at === -1) return null;

  let cursor = at + marker.length;
  while (cursor < text.length && /\s/.test(text[cursor])) cursor++;
  if (text[cursor] !== '[') return null;

  let depth = 0;
  let inString = false;
  let escaped = false;
  let end = -1;
  for (let i = cursor; i < text.length; i++) {
    const char = text[i];
    if (escaped) {
      escaped = false;
      continue;
    }
    if (char === '\\') {
      escaped = true;
      continue;
    }
    if (char === '"') {
      inString = !inString;
      continue;
    }
    if (inString) continue;
    if (char === '[') depth++;
    else if (char === ']') {
      depth--;
      if (depth === 0) {
        end = i + 1;
        break;
      }
    }
  }
  if (end === -1) return null;

  try {
    const value = JSON.parse(text.slice(cursor, end).replace(/\\/g, ''));
    return Array.isArray(value) && value.length >= 4 ? value : null;
  } catch {
    return null;
  }
}

/**
 * Compteur de vues lu dans la page — au mieux. guns.lol ne promet rien : si
 * aucun motif ne répond, on rend null plutôt qu'un chiffre inventé.
 */
export function guessViews(html) {
  if (!html) return null;
  const patterns = [
    /"total_views":\s*"?([\d.,\s]+)"?/i,
    /"view_count":\s*"?([\d.,\s]+)"?/i,
    /"views":\s*"?([\d.,\s]+)"?/i,
  ];
  for (const pattern of patterns) {
    const match = pattern.exec(html);
    if (!match) continue;
    const value = Number(String(match[1]).replace(/[^\d]/g, ''));
    if (Number.isFinite(value) && value > 0) return value;
  }
  return null;
}
