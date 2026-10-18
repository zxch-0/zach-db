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

/** « hote:port », pour les journaux. Le schéma n'apparaît que s'il n'est pas http. */
export function describeProxy(proxy) {
  if (!proxy) return 'direct';
  return (proxy.scheme ? proxy.scheme + '://' : '') + proxy.host + ':' + proxy.port;
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
 *
 * Le choix des listes fait toute la différence. Les listes « http » fourre-tout
 * charrient des milliers d'adresses mortes ; celles-ci sont revérifiées en
 * continu et annoncent explicitement le protocole, donc elles contiennent une
 * majorité de proxys réellement capables de CONNECT. `scheme` et `type` sont
 * facultatifs : sans eux, une source est une liste texte de proxys HTTP.
 */
export const PROXY_SOURCES = [
  { name: 'monosans', url: 'https://raw.githubusercontent.com/monosans/proxy-list/main/proxies/https.txt' },
  { name: 'proxifly', url: 'https://raw.githubusercontent.com/proxifly/free-proxy-list/main/proxies/protocols/https/data.txt' },
  { name: 'mmpx12', url: 'https://raw.githubusercontent.com/mmpx12/proxy-list/master/https.txt' },
  { name: 'roosterkid', url: 'https://raw.githubusercontent.com/roosterkid/openproxylist/main/HTTPS_RAW.txt' },
  { name: 'zloi-user', url: 'https://raw.githubusercontent.com/zloi-user/hideip.me/main/https.txt' },
  { name: 'hookzof', url: 'https://raw.githubusercontent.com/hookzof/socks5_list/master/proxy.txt', scheme: 'socks5' },
  { name: 'geonode', url: 'https://proxylist.geonode.com/api/proxy-list?limit=500&page=1&sort_by=lastChecked&sort_type=desc&protocols=http%2Chttps%2Csocks5', type: 'json' },
  // Les mêmes listes, mais servies par leur site plutôt qu'en texte brut.
  { name: 'proxyscrape-http', url: 'https://api.proxyscrape.com/v2/?request=displayproxies&protocol=http&timeout=10000&country=all&ssl=all&anonymity=all' },
  { name: 'proxyscrape-socks5', url: 'https://api.proxyscrape.com/v2/?request=displayproxies&protocol=socks5&timeout=10000&country=all', scheme: 'socks5' },
  { name: 'proxy-list-dl', url: 'https://www.proxy-list.download/api/v1/get?type=https' },
  // Les sites qui ne publient qu'une page HTML : lus par parseProxyHtml —
  // paires de cases <td>ip</td><td>port</td>, sinon tout « ip:port » en clair.
  { name: 'free-proxy-list.net', url: 'https://free-proxy-list.net/', type: 'html' },
  { name: 'us-proxy', url: 'https://www.us-proxy.org/', type: 'html' },
  { name: 'sslproxies', url: 'https://www.sslproxies.org/', type: 'html' },
  { name: 'proxypremium', url: 'https://proxypremium.top/download-proxy-list', type: 'html' },
  { name: 'free-proxy.cz', url: 'http://free-proxy.cz/en/proxylist/country/all/http/ping/all', type: 'html' },
  { name: 'hidemyname', url: 'https://hidemy.name/en/proxy-list/', type: 'html' },
  { name: 'openproxy', url: 'https://openproxy.space/list', type: 'html' },
  { name: 'ipfail', url: 'https://webtools.ipfail.org/free-proxy-tools', type: 'html' },
];

/**
 * Une ligne de liste → { host, port, auth, scheme? }. Le schéma vient de la
 * ligne si elle en porte un (« socks5://… »), sinon de `options.scheme`. Il
 * n'est posé sur l'objet que lorsqu'il n'est pas « http » : la forme de retour
 * historique est donc préservée à l'octet près pour les listes HTTP.
 */
export function parseProxyLine(line, options = {}) {
  let text = String(line == null ? '' : line).trim();
  if (!text || text.startsWith('#') || text.startsWith('//')) return null;

  let scheme = options.scheme === 'socks5' ? 'socks5' : 'http';
  const declared = /^([a-zA-Z][a-zA-Z0-9+.-]*):\/\//.exec(text);
  if (declared) {
    const name = declared[1].toLowerCase();
    scheme = name === 'socks5' || name === 'socks5h' || name === 'socks' ? 'socks5' : 'http';
    text = text.slice(declared[0].length);
  }

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

  const proxy = { host, port, auth: auth || null };
  if (scheme !== 'http') proxy.scheme = scheme;
  return proxy;
}

/** Toute une liste, dédoublonnée par schéma et par hote:port. */
export function parseProxyList(text, options = {}) {
  const limit = Number(options.limit) > 0 ? Number(options.limit) : Infinity;
  const seen = new Set();
  const out = [];
  for (const raw of String(text || '').split(/[\s,;]+/)) {
    const proxy = parseProxyLine(raw, options);
    if (!proxy) continue;
    const key = (proxy.scheme || 'http') + '://' + proxy.host + ':' + proxy.port;
    if (seen.has(key)) continue;
    seen.add(key);
    out.push(proxy);
    if (out.length >= limit) break;
  }
  return out;
}

/**
 * Une liste JSON (Geonode) : le protocole, l'anonymat et la date du dernier
 * contrôle sont fournis, donc rien n'est deviné. « http » gagne quand il est
 * disponible, sinon SOCKS5.
 */
export function parseProxyJson(text, options = {}) {
  const limit = Number(options.limit) > 0 ? Number(options.limit) : Infinity;
  let rows;
  try {
    rows = JSON.parse(String(text || ''));
  } catch {
    return [];
  }

  const list = Array.isArray(rows) ? rows : (rows && Array.isArray(rows.data) ? rows.data : []);
  const seen = new Set();
  const out = [];
  for (const row of list) {
    if (!row) continue;
    const host = String(row.ip || row.host || '').trim();
    const port = Number(row.port);
    if (!host || !Number.isInteger(port) || port < 1 || port > 65535) continue;

    const protocols = Array.isArray(row.protocols)
      ? row.protocols.map((value) => String(value).toLowerCase())
      : [];
    const scheme = protocols.includes('socks5') && !protocols.includes('http') ? 'socks5' : 'http';
    const key = scheme + '://' + host + ':' + port;
    if (seen.has(key)) continue;
    seen.add(key);

    const proxy = {
      host,
      port,
      auth: row.username && row.password ? row.username + ':' + row.password : null,
      anonymous: String(row.anonymityLevel || '').toLowerCase() !== 'transparent',
    };
    if (scheme !== 'http') proxy.scheme = scheme;
    out.push(proxy);
    if (out.length >= limit) break;
  }
  return out;
}

/** Base64 → texte, Node ou navigateur ; renvoie '' si indécodable. */
function decodeBase64(blob) {
  try {
    if (typeof Buffer !== 'undefined') return Buffer.from(String(blob), 'base64').toString('latin1');
    if (typeof atob === 'function') return atob(String(blob));
  } catch { /* du bruit quelconque : ignoré */ }
  return '';
}

/** Le texte d'une case de tableau : les balises partent, le contenu reste. */
function cellText(html) {
  return String(html).replace(/<[^>]*>/g, ' ');
}

/**
 * Une page HTML de liste (free-proxy-list.net, us-proxy.org, sslproxies.org,
 * proxypremium.top, hidemy.name, free-proxy.cz, openproxy.space…) : ces sites
 * ne publient pas de texte brut, alors on lit le tableau. Deux passes qui se
 * complètent :
 *
 * 1. ligne par ligne, une case qui contient une adresse IP suivie d'une case
 *    qui ne contient qu'un numéro de port — les balises internes sont
 *    ignorées, et les blocs Base64.decode("…") de free-proxy.cz sont décodés
 *    avant, puisqu'ils écrivent l'IP à l'affichage ;
 * 2. en repli, tout « ip:port » en clair n'importe où dans la page (JSON
 *    embarqué, attributs, texte), pour les sites sans tableau strict.
 *
 * Les octets > 255, les ports hors plage et les doublons sont écartés ; la
 * validation au tunnel fera le tri du reste, comme pour les listes texte.
 */
export function parseProxyHtml(text, options = {}) {
  const limit = Number(options.limit) > 0 ? Number(options.limit) : Infinity;
  let page = String(text || '');

  page = page.replace(/Base64\.decode\(["'`]([A-Za-z0-9+/=]+)["'`]\)/g, (all, blob) => {
    const decoded = decodeBase64(blob);
    return decoded ? ' ' + decoded + ' ' : ' ';
  });

  const IP = /(\d{1,3}(?:\.\d{1,3}){3})/;
  const seen = new Set();
  const out = [];
  const push = (host, portText) => {
    if (out.length >= limit) return;
    const octets = String(host).split('.').map(Number);
    const port = Number(portText);
    if (octets.length !== 4 || octets.some((value) => !Number.isInteger(value) || value < 0 || value > 255)) return;
    if (!Number.isInteger(port) || port < 1 || port > 65535) return;
    const proxy = { host: octets.join('.'), port, auth: null };
    if (options.scheme === 'socks5') proxy.scheme = 'socks5';
    const key = (proxy.scheme || 'http') + '://' + proxy.host + ':' + proxy.port;
    if (seen.has(key)) return;
    seen.add(key);
    out.push(proxy);
  };

  const ROW = /<tr[^>]*>([\s\S]*?)<\/tr>/gi;
  const CELL = /<td[^>]*>([\s\S]*?)<\/td>/gi;
  let row;
  while ((row = ROW.exec(page)) !== null && out.length < limit) {
    const cells = [];
    let cell;
    CELL.lastIndex = 0;
    while ((cell = CELL.exec(row[1])) !== null) cells.push(cellText(cell[1]).trim());
    for (let i = 0; i + 1 < cells.length; i++) {
      const ip = IP.exec(cells[i]);
      if (ip && /^(\d{1,5})$/.test(cells[i + 1])) {
        push(ip[1], cells[i + 1]);
        break;
      }
    }
  }

  const BARE = /\b(\d{1,3}(?:\.\d{1,3}){3}):(\d{1,5})\b/g;
  let bare;
  while ((bare = BARE.exec(page)) !== null && out.length < limit) push(bare[1], bare[2]);

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
