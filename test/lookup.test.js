/*
 * Discord lookup : la page et son contrôleur (public/lookup.js).
 *
 * Comme pour l'autre outil, on charge le module dans un DOM simulé construit à
 * partir des identifiants réellement présents dans la page, avec un `fetch`
 * qui rend une réponse toute prête. Objectif : aucune faute de frappe
 * (élément manquant), et un affichage complet du profil, des drapeaux, des
 * visuels, des serveurs communs et de la réponse brute.
 */
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { describeUser } from '../public/lib/discord.js';

const ROOT = path.join(path.dirname(fileURLToPath(import.meta.url)), '..');
const PAGE = 'public/tools/discord-lookup/index.html';
const html = fs.readFileSync(path.join(ROOT, PAGE), 'utf8');
const source = fs.readFileSync(path.join(ROOT, 'public/lookup.js'), 'utf8');
const ids = [...new Set([...html.matchAll(/id="([^"]+)"/g)].map((match) => match[1]))];

const KNOWN = '175928847299117063';

/* ---------- réponses prêtes à être rendues ---------- */

const USER = {
  id: KNOWN,
  username: 'wumpus',
  discriminator: '0',
  global_name: 'Wumpus',
  avatar: 'a_1f3b9c8d7e6f5a4b3c2d1e0f9a8b7c6d',
  banner: 'f0e1d2c3b4a5968778695a4b3c2d1e0f',
  accent_color: 7506394,
  bot: false,
  mfa_enabled: true,
  locale: 'en-US',
  verified: true,
  public_flags: 4194305,
  premium_type: 2,
};

const online = () => ({
  ok: true,
  mode: 'online',
  id: KNOWN,
  token: true,
  elapsed: 214,
  source: 'Discord API v10',
  snowflake: {
    id: KNOWN, valid: true, epoch: 1420070400000, timestamp: 1462015105796,
    date: { iso: '2016-04-30T11:18:25.796Z', utc: 'Sat, 30 Apr 2016 11:18:25 GMT', day: '2016-04-30', time: '11:18:25', unix: 1462015105 },
    age: { ms: 1, seconds: 1, minutes: 1, hours: 1, days: 3822, years: 10, months: 5, calendarDays: 18, text: '10 years, 5 months, 18 days', short: '10y 5mo 18d' },
    worker: 1, process: 0, increment: 7,
    binary: '0'.repeat(64), hex: '0x271065AC1020007', bigint: KNOWN,
    segments: [
      { name: 'timestamp', bits: 42, binary: '0'.repeat(42), value: 41944705796 },
      { name: 'worker', bits: 5, binary: '00001', value: 1 },
      { name: 'process', bits: 5, binary: '00000', value: 0 },
      { name: 'increment', bits: 12, binary: '000000000111', value: 7 },
    ],
  },
  user: USER,
  profile: describeUser(USER, { size: 1024 }),
  guilds: { enabled: false, total: 0, checked: 0, mutual: [], stopped: null, errors: [] },
  ratelimit: { limit: 5, remaining: 4, reset: Date.now() / 1000 + 30, bucket: 'b', global: false },
});

const offline = () => ({
  ok: true,
  mode: 'offline',
  id: KNOWN,
  token: false,
  elapsed: 0,
  snowflake: online().snowflake,
  notice: 'No DISCORD_TOKEN on the server: everything below is decoded from the ID itself.',
});

const withGuilds = () => {
  const payload = online();
  payload.guilds = {
    enabled: true, total: 2, checked: 2, stopped: null, errors: [],
    mutual: [{
      guild: { id: '111111111111111111', name: 'zach-db', icon: null },
      nick: 'zach', guildAvatar: null,
      joined_at: '2021-03-04T05:06:07.890+00:00', joinedAt: '2021-03-04T05:06:07.890+00:00',
      premiumSince: '2022-01-02T03:04:05.678+00:00', pending: false, mutedUntil: null,
      roles: [{ id: '333333333333333333', name: 'Moderator', position: 3, color: null, hoist: true, managed: false }],
    }],
  };
  return payload;
};

/* ---------- DOM simulé ---------- */

function makeClassList(node) {
  const set = new Set();
  return {
    add: (...names) => names.forEach((name) => set.add(name)),
    remove: (...names) => names.forEach((name) => set.delete(name)),
    contains: (name) => set.has(name),
    toggle: (name, force) => {
      const wanted = force === undefined ? !set.has(name) : Boolean(force);
      if (wanted) set.add(name);
      else set.delete(name);
      return wanted;
    },
    _set: set,
    get value() {
      return [...set].join(' ');
    },
    _node: node,
  };
}

function makeNode(tag, id) {
  const node = {
    tagName: String(tag || 'div').toUpperCase(),
    id: id || '',
    children: [],
    listeners: new Map(),
    attributes: new Map(),
    hidden: false,
    disabled: false,
    checked: false,
    value: '',
    src: '',
    href: '',
    download: '',
    style: { setProperty(name, value) { this[name] = value; } },
    get textContent() {
      return (node._text || '') + node.children.map((child) => child.textContent).join('');
    },
    set textContent(value) {
      node.children = [];
      node._text = value === null || value === undefined ? '' : String(value);
    },
    get lastChild() {
      return node.children[node.children.length - 1] || null;
    },
    get firstChild() {
      return node.children[0] || null;
    },
    append(...kids) {
      node.children.push(...kids);
    },
    appendChild(kid) {
      node.children.push(kid);
      return kid;
    },
    insertBefore(kid) {
      node.children.unshift(kid);
      return kid;
    },
    replaceChildren(...kids) {
      node.children = kids;
    },
    remove() {},
    click() {
      const handler = node.listeners.get('click');
      if (handler) handler({ target: node, preventDefault() {} });
    },
    focus() {},
    scrollIntoView() {},
    setAttribute(name, value) {
      node.attributes.set(name, String(value));
    },
    getAttribute(name) {
      return node.attributes.has(name) ? node.attributes.get(name) : null;
    },
    removeAttribute(name) {
      node.attributes.delete(name);
    },
    hasAttribute(name) {
      return node.attributes.has(name);
    },
    addEventListener(type, handler) {
      node.listeners.set(type, handler);
    },
    removeEventListener(type) {
      node.listeners.delete(type);
    },
    querySelector(selector) {
      const wanted = selector.replace(/^\./, '');
      const walk = (list) => {
        for (const child of list) {
          if (selector.startsWith('.') ? child.classList.contains(wanted) : child.tagName === wanted.toUpperCase()) return child;
          const found = walk(child.children);
          if (found) return found;
        }
        return null;
      };
      return walk(node.children);
    },
    querySelectorAll() {
      return [];
    },
    closest(selector) {
      if (selector === '[data-copytext]' && node.attributes.has('data-copytext')) return node;
      return null;
    },
    contains(other) {
      return other === node;
    },
  };
  node.classList = makeClassList(node);
  // className et classList décrivent la même chose, comme dans un navigateur
  Object.defineProperty(node, 'className', {
    get: () => node.classList.value,
    set: (value) => {
      node.classList._set.clear();
      String(value || '').split(/\s+/).filter(Boolean).forEach((name) => node.classList._set.add(name));
    },
  });
  return node;
}

const nodes = new Map();
for (const id of ids) nodes.set(id, makeNode('div', id));
const byId = (id) => nodes.get(id) || null;

const documentListeners = new Map();
globalThis.document = {
  hidden: false,
  activeElement: null,
  documentElement: Object.assign(makeNode('html'), { scrollTop: 0, scrollHeight: 4000, clientHeight: 900 }),
  body: makeNode('body'),
  getElementById: byId,
  createElement: (tag) => makeNode(tag),
  createDocumentFragment: () => makeNode('fragment'),
  querySelector: () => null,
  querySelectorAll: () => [],
  addEventListener: (type, handler) => documentListeners.set(type, handler),
  removeEventListener: (type) => documentListeners.delete(type),
  execCommand: () => true,
};

globalThis.location = {
  href: 'http://localhost:3000/tools/discord-lookup/?id=' + KNOWN,
  search: '?id=' + KNOWN,
  pathname: '/tools/discord-lookup/',
  hash: '',
};
globalThis.history = { replaceState: () => {} };
globalThis.matchMedia = (query) => ({ media: query, matches: false });
// Node expose `navigator` en lecture seule : on le redéfinit pour la copie
Object.defineProperty(globalThis, 'navigator', {
  value: { clipboard: { writeText: async () => {} } },
  configurable: true,
  writable: true,
});

const downloads = [];
const realCreateObjectURL = URL.createObjectURL;
URL.createObjectURL = (blob) => {
  downloads.push(blob);
  return 'blob:test';
};
URL.revokeObjectURL = () => {};

const requests = [];
let answer = online();
globalThis.fetch = async (url) => {
  requests.push(String(url));
  // l'état du jeton est lu sur /api/health, comme le fait la page
  if (String(url).startsWith('/api/health')) {
    return { ok: true, status: 200, json: async () => ({ ok: true, discord: true }) };
  }
  return { ok: answer.ok !== false, status: answer.status || 200, json: async () => answer };
};
const flush = () => new Promise((resolve) => setTimeout(resolve, 20));

/* ==================================================================
 * la page
 * ================================================================== */

test('page : chaque élément demandé par lookup.js existe', () => {
  const used = [...new Set([...source.matchAll(/el\('([^']+)'\)/g)].map((match) => match[1]))];
  assert.ok(used.length >= 20, 'assez d’éléments repérés : ' + used.length);
  for (const id of used) {
    assert.ok(html.includes('id="' + id + '"'), 'élément #' + id + ' absent de ' + PAGE);
  }
  assert.equal(new Set(ids).size, ids.length, 'aucun identifiant en double');

  // la page est autonome : son module, son formulaire, aucune ressource distante
  assert.match(html, /<script src="\/lookup.js" type="module">/);
  assert.match(html, /<form id="lookupForm">/);
  assert.match(html, /<meta name="color-scheme" content="light dark">/, 'la page suit le thème du système');
  for (const match of html.matchAll(/<(?:script|link|iframe)\b[^>]*\b(?:src|href)="(https?:\/\/[^"]+)"/gi)) {
    assert.fail('ressource externe chargée par la page : ' + match[1]);
  }
  // l'avatar est une <img> sans adresse dans le HTML : c'est le résultat qui la donne
  const images = [...html.matchAll(/<img\b[^>]*>/gi)];
  assert.equal(images.length, 1, 'une seule image : l’avatar');
  assert.ok(!/\bsrc=/.test(images[0][0]), 'l’avatar n’a pas d’adresse figée dans la page');
  assert.match(images[0][0], /\balt="/, 'l’avatar a un texte alternatif');
  assert.match(images[0][0], /referrerpolicy="no-referrer"/, 'pas de référent envoyé au CDN');
});

test('aucun import externe, et le module partage le décor commun', () => {
  for (const match of source.matchAll(/import\s+[^;]*from\s+['"]([^'"]+)['"]/g)) {
    assert.ok(match[1].startsWith('./') || match[1].startsWith('/'), 'import externe : ' + match[1]);
  }
  assert.match(source, /from '\.\/chrome\.js'/, 'le sélecteur d’outil et le décor sont partagés');
  assert.match(source, /from '\.\/lib\/discord\.js'/, 'le décodage du flocon vient du module commun');
});

/* ==================================================================
 * le contrôleur
 * ================================================================== */

test('lookup.js : le flocon est décodé pendant la frappe, sans réseau', async () => {
  const { renderSnowflake } = await import('../public/lookup.js');
  await flush(); // la recherche lancée par ?id= se termine

  // le décodage local ne demande rien : deux requêtes au chargement, l'état du
  // jeton puis le profil — jamais une requête vers discord.com depuis le navigateur
  assert.deepEqual(requests.map((url) => url.split('?')[0]), ['/api/health', '/api/discord/user']);
  assert.match(requests[1], /^\/api\/discord\/user\?id=175928847299117063/);

  const snow = renderSnowflake(KNOWN);
  assert.equal(snow.valid, true);
  assert.equal(byId('dsnowId').textContent, KNOWN);
  assert.equal(byId('dcreated').textContent, 'Sat, 30 Apr 2016 11:18:25 GMT');
  assert.equal(byId('dworker').textContent, '1');
  assert.equal(byId('dincrement').textContent, '7');
  assert.equal(byId('dhex').textContent, '0x271065AC1020007');
  assert.equal(byId('dmention').textContent, '<@' + KNOWN + '>');
  assert.equal(byId('dbits').children.length, 4, 'la règle des bits a quatre cases');
  assert.equal(byId('dbits').children[0].querySelector('code').textContent.length, 42, '42 bits d’horodatage');

  // le lien de profil est un vrai lien, pas du texte
  const profile = byId('dprofileLink').firstChild;
  assert.equal(profile.href, 'https://discord.com/users/' + KNOWN);
  assert.equal(profile.getAttribute('rel') || profile.rel, 'noopener noreferrer');
});

test('lookup.js : le profil en ligne s’affiche en entier', async () => {
  await flush();

  assert.equal(byId('dprofileBox').hidden, false, 'la carte de profil est montrée');
  assert.equal(byId('ddisplay').textContent, 'Wumpus');
  assert.match(byId('dusername').textContent, /@wumpus/);
  assert.match(byId('dmode').textContent, /214 ms/, 'le temps de réponse est dit');

  // drapeaux décodés, un par badge
  const badges = byId('dbadges').children;
  assert.deepEqual(badges.map((badge) => badge.querySelector('b').textContent),
    ['Discord Employee', 'Active Developer']);
  assert.match(badges[0].querySelector('em').textContent, /bit 0/);

  // pastilles de type de compte
  const pills = byId('dpills').children.map((pill) => pill.textContent);
  assert.ok(pills.includes('2fa on') && pills.includes('Nitro') && pills.includes('verified'), pills.join(', '));

  // la grille de données : aucun champ important ne manque
  const facts = byId('dfacts').children;
  const labels = facts.map((cell) => cell.querySelector('dt').textContent);
  for (const label of ['user id', 'username', 'global name', 'created (utc)', 'account age',
    'worker / process', 'increment', 'bot', 'mfa enabled', 'locale', 'nitro', 'accent colour',
    'public flags', 'avatar hash', 'banner hash', 'profile']) {
    assert.ok(labels.includes(label), 'champ absent de la grille : ' + label);
  }
  const accent = facts.find((cell) => cell.querySelector('dt').textContent === 'accent colour');
  assert.equal(accent.querySelector('dd').textContent.trim().slice(0, 7), '#7289da');
  assert.ok(accent.querySelector('dd').lastChild.classList.contains('swatch'), 'la couleur est montrée');

  // visuels du CDN : l'image n'est chargée qu'à ce moment-là
  assert.match(byId('davatar').src, /^https:\/\/cdn\.discordapp\.com\/avatars\/.*\.gif\?size=1024$/);
  assert.equal(byId('davatar').hidden, false);
  assert.match(byId('dbanner').style.backgroundImage, /cdn\.discordapp\.com\/banners\//);
  const assets = byId('dassets').children;
  assert.ok(assets.length >= 6, 'les adresses de visuels sont listées : ' + assets.length);
  assert.deepEqual(assets[0].children.map((kid) => kid.tagName), ['SPAN', 'A', 'BUTTON']);
  assert.equal(assets[0].querySelector('button').getAttribute('data-copytext').slice(0, 8), 'https://');
  assert.equal(byId('dassetsBox').hidden, false);

  // compteurs et réponse brute
  assert.equal(byId('statBadges').textContent, '2');
  assert.equal(byId('statMs').textContent, '214');
  assert.equal(byId('statFields').textContent, Object.keys(USER).length.toLocaleString('en-US'));
  assert.equal(byId('drawBox').hidden, false);
  assert.equal(byId('dsave').disabled, false);
  const raw = JSON.parse(byId('draw').textContent);
  assert.equal(raw.mode, 'online');
  assert.equal(raw.profile.display, 'Wumpus');
  assert.match(byId('dstatus').textContent, /Wumpus/);
  assert.match(byId('dratelimit').textContent, /4\/5 left in this bucket/);
  assert.match(byId('dmeta').textContent, /token on the server/);
  assert.equal(byId('dguildBox').hidden, true, 'les serveurs communs ne sont pas cherchés par défaut');
});

test('lookup.js : boutons copier, téléchargement et couleurs', async () => {
  // copie déléguée d'une adresse de visuel
  const button = byId('dassets').children[0].querySelector('button');
  documentListeners.get('click')({ target: button });
  await flush();
  assert.equal(button.textContent, 'Copied');

  // la réponse brute se télécharge
  const { download } = await import('../public/lookup.js');
  download();
  assert.equal(downloads.length, 1, 'un fichier JSON est préparé');
  assert.equal(downloads[0].type, 'application/json');

  // les couleurs restent éteintes tant qu'on ne les demande pas
  assert.equal(document.body.classList.contains('show-colors'), false);
  const colors = byId('dcolors');
  colors.checked = true;
  colors.listeners.get('change')({ target: colors });
  assert.equal(document.body.classList.contains('show-colors'), true, 'le site repasse en couleur à la demande');
  colors.checked = false;
  colors.listeners.get('change')({ target: colors });
  assert.equal(document.body.classList.contains('show-colors'), false);
});

test('lookup.js : serveurs communs, pseudos et rôles', async () => {
  answer = withGuilds();
  const { run } = await import('../public/lookup.js');
  requests.length = 0;
  await run({ text: KNOWN, guilds: true, size: 512 });

  assert.equal(requests.length, 1);
  assert.match(requests[0], /guilds=1/, 'l’option est transmise au serveur');
  assert.match(requests[0], /size=512/, 'la taille des visuels aussi');

  assert.equal(byId('dguildBox').hidden, false);
  assert.match(byId('dguildSummary').textContent, /1 found · 2\/2 checked/);
  const guild = byId('dguilds').children[0];
  assert.equal(guild.classList.contains('guild'), true);
  assert.equal(guild.querySelector('strong').textContent, 'zach-db');
  assert.match(guild.querySelector('p').textContent, /nickname: zach/);
  assert.match(guild.querySelector('p').textContent, /joined: 2021-03-04 05:06:07 UTC/);
  assert.match(guild.querySelector('p').textContent, /boosting since: 2022-01-02/);
  assert.deepEqual(guild.querySelector('.role-chips').children.map((chip) => chip.textContent), ['Moderator']);
  assert.equal(byId('statServers').textContent, '1');
});

test('lookup.js : sans jeton, la page explique et garde le flocon', async () => {
  answer = offline();
  const { run } = await import('../public/lookup.js');
  await run({ text: KNOWN, guilds: false, size: 1024 });

  assert.equal(byId('dprofileBox').hidden, true, 'pas de carte de profil sans jeton');
  assert.equal(byId('dassetsBox').hidden, true);
  assert.equal(byId('dguildBox').hidden, true);
  assert.equal(byId('dnotice').hidden, false);
  assert.match(byId('dnotice').textContent, /DISCORD_TOKEN/);
  assert.equal(byId('dcreated').textContent, 'Sat, 30 Apr 2016 11:18:25 GMT', 'le flocon reste décodé');
  assert.match(byId('dstatus').textContent, /offline/i);
  assert.match(byId('dmeta').textContent, /offline decode/);
  assert.equal(JSON.parse(byId('draw').textContent).mode, 'offline');
});

test('lookup.js : identifiant invalide, compte inconnu, serveur muet', async () => {
  const { run } = await import('../public/lookup.js');

  requests.length = 0;
  await run({ text: 'pas un identifiant', guilds: false, size: 1024 });
  assert.equal(requests.length, 0, 'rien n’est demandé au serveur pour une saisie invalide');
  assert.equal(byId('dprofileBox').hidden, true);
  assert.match(byId('dnotice').textContent, /not a Discord snowflake/);
  assert.match(byId('dstatus').textContent, /Invalid ID/);

  answer = { ok: false, mode: 'error', status: 404, id: KNOWN, code: 10013, error: 'Unknown User', snowflake: online().snowflake, elapsed: 88 };
  await run({ text: KNOWN, guilds: false, size: 1024 });
  assert.equal(byId('dprofileBox').hidden, true);
  assert.match(byId('dnotice').textContent, /Unknown User \(code 10013\)/);
  assert.match(byId('dnotice').textContent, /Sat, 30 Apr 2016/, 'la date de création reste utile');
  assert.match(byId('dstatus').textContent, /404/);

  const broken = globalThis.fetch;
  globalThis.fetch = async () => {
    throw new Error('network down');
  };
  await run({ text: KNOWN, guilds: false, size: 1024 });
  assert.match(byId('dnotice').textContent, /network down/);
  assert.match(byId('dstatus').textContent, /Lookup failed/);
  globalThis.fetch = broken;
});

test.after(() => {
  URL.createObjectURL = realCreateObjectURL;
});
