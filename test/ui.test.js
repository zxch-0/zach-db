/*
 * Test de fumée de l'interface : on charge public/app.js dans Node avec un
 * DOM simulé construit à partir des identifiants réellement présents dans la
 * page de l'outil. Objectif : attraper les fautes de frappe (élément manquant,
 * fonction mal nommée, variable non déclarée) sans navigateur.
 *
 * L'habillage partagé (sélecteur d'outil, décor) est dans public/chrome.js :
 * ses identifiants doivent exister sur toutes les pages du site.
 */
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = path.join(path.dirname(fileURLToPath(import.meta.url)), '..');
const PAGES = {
  home: 'public/index.html',
  tool: 'public/tools/group-by-site/index.html',
};
const html = fs.readFileSync(path.join(ROOT, PAGES.tool), 'utf8');
const home = fs.readFileSync(path.join(ROOT, PAGES.home), 'utf8');
const app = fs.readFileSync(path.join(ROOT, 'public/app.js'), 'utf8');
const chrome = fs.readFileSync(path.join(ROOT, 'public/chrome.js'), 'utf8');

const ids = [...html.matchAll(/id="([^"]+)"/g)].map((match) => match[1]);

function fakeNode(id) {
  const node = {
    id,
    textContent: '',
    value: '',
    placeholder: '',
    hidden: false,
    disabled: false,
    checked: false,
    files: [],
    className: '',
    attributes: new Map(),
    listeners: new Map(),
    setAttribute(name, value) {
      node.attributes.set(name, value);
    },
    getAttribute(name) {
      return node.attributes.has(name) ? node.attributes.get(name) : null;
    },
    addEventListener(type, handler) {
      node.listeners.set(type, handler);
    },
    removeEventListener(type) {
      node.listeners.delete(type);
    },
    appendChild() {},
    append() {},
    replaceChildren() {},
    remove() {},
    click() {},
    focus() {},
    scrollIntoView() {},
    querySelector() {
      return null;
    },
    querySelectorAll() {
      return [];
    },
    insertBefore() {},
    classList: { add() {}, remove() {}, toggle() {} },
    style: {},
  };
  return node;
}

const nodes = new Map(ids.map((id) => [id, fakeNode(id)]));

globalThis.document = {
  getElementById: (id) => nodes.get(id) || null,
  createElement: () => fakeNode('created'),
  createDocumentFragment: () => fakeNode('fragment'),
  body: fakeNode('body'),
  addEventListener() {},
};

globalThis.location = { href: 'http://localhost:3000/tools/group-by-site/', hash: '', pathname: '/tools/group-by-site/', search: '' };
globalThis.history = { replaceState() {} };

const workerMessages = [];
globalThis.Worker = class {
  constructor(url) {
    this.url = url;
  }
  postMessage(message) {
    workerMessages.push(message);
  }
  addEventListener() {}
  removeEventListener() {}
};

const downloads = [];
const realCreateObjectURL = URL.createObjectURL;
URL.createObjectURL = (blob) => {
  downloads.push(blob);
  return 'blob:test';
};
URL.revokeObjectURL = () => {};

test('app.js se charge sans erreur et branche ses écouteurs', async () => {
  await import('../public/app.js?smoke=1');

  // un écouteur est bien posé sur les éléments interactifs attendus
  for (const [id, type] of [
    ['groupForm', 'submit'],
    ['gfile', 'change'],
    ['gregex', 'input'],
    ['gfilter', 'input'],
    ['gsave', 'click'],
    ['gprev', 'click'],
    ['gcancel', 'click'],
  ]) {
    const node = nodes.get(id);
    assert.ok(node.listeners.has(type), id + ' : pas d’écouteur ' + type);
  }

  assert.equal(nodes.get('meta').textContent.length > 0, true, 'pied de page renseigné');
  assert.equal(nodes.get('gsummary').textContent, 'No sites found yet.', 'empty state is in English');
  assert.equal(workerMessages.length, 0, 'aucune passe lancée au chargement');
});

test('chrome.js habille l’en-tête : le sélecteur porte l’outil courant', async () => {
  const { initChrome } = await import('../public/chrome.js');
  // DOM simulé un peu plus complet : les sélections renvoient des listes vides
  document.querySelectorAll = () => [];

  initChrome(); // ne doit rien casser, même sans vrai DOM
  assert.equal(nodes.get('toolSwitcherName').textContent, 'Group by site',
    'l’outil courant est nommé dans l’en-tête');
  assert.ok(nodes.get('toolSwitcherBtn').listeners.has('keydown'), 'le déclencheur ouvre au clavier');
  assert.ok(nodes.get('toolMenu').listeners.has('keydown'), 'le menu gère Échap et les flèches');

  // sur l’accueil, aucun outil n’est courant
  location.pathname = '/';
  initChrome();
  assert.equal(nodes.get('toolSwitcherName').textContent, 'All tools', 'accueil : « All tools »');
  location.pathname = '/tools/group-by-site/';
});

/* Contexte 2D fantôme : toute méthode renvoie une fonction qui ne fait rien,
   tout gradient répond addColorStop. De quoi exécuter le vrai code de dessin. */
function fakeContext() {
  const gradient = { addColorStop() {} };
  const target = {
    createLinearGradient: () => gradient,
    createRadialGradient: () => gradient,
    lineWidth: 1,
    fillStyle: '',
    strokeStyle: '',
  };
  return new Proxy(target, {
    get(box, prop) {
      if (prop in box) return box[prop];
      return () => {};
    },
    set(box, prop, value) {
      box[prop] = value;
      return true;
    },
  });
}

const fakeBox = () => ({ width: 1200, height: 780, top: 0, left: 0, right: 1200, bottom: 780 });

test('home.js dessine ses trois calques, décode sa ligne et remplit la télémétrie', async () => {
  // le DOM simulé reçoit les identifiants de l'accueil, une taille et un contexte
  for (const id of [...home.matchAll(/id="([^"]+)"(?![^>]*data-)/g)].map((m) => m[1])) {
    if (!nodes.has(id)) nodes.set(id, fakeNode(id));
  }
  for (const node of nodes.values()) {
    node.getBoundingClientRect = fakeBox;
    node.getContext = fakeContext;
  }

  const decodeNode = fakeNode('decode');
  const decodeText = home.match(/data-decode="([^"]+)"/)[1];
  decodeNode.attributes.set('data-decode', decodeText);
  document.querySelectorAll = (selector) => (selector === '[data-decode]' ? [decodeNode] : []);

  // mouvement réduit : le moteur doit composer une image fixe, sans minuterie
  globalThis.matchMedia = (query) => ({ media: query, matches: /reduced-motion/.test(query) });

  await import('../public/home.js?smoke=1');

  assert.equal(decodeNode.textContent, decodeText, 'la ligne décodée retombe sur son texte');
  assert.match(nodes.get('telClock').textContent, /^\d{2}:\d{2}:\d{2}$/, 'heure locale affichée');
  assert.equal(nodes.get('telFps').textContent, 'still frame', 'mouvement réduit : image fixe annoncée');
  assert.equal(nodes.get('telPointer').textContent, '0.50 / 0.50', 'pointeur au centre par défaut');
  assert.equal(Number(nodes.get('telDust').textContent.replace(/[^0-9]/g, '')) > 20, true,
    'poussière comptée');
  assert.equal(nodes.get('coreNodes').textContent, '504', '12 parallèles x 36 points + anneau de balayage');
});

test('app.js et la page de l’outil sont cohérents', () => {
  // tous les identifiants utilisés par el('…') existent
  for (const id of new Set([...app.matchAll(/el\('([^']+)'\)/g)].map((match) => match[1]))) {
    assert.ok(html.includes('id="' + id + '"'), 'élément #' + id + ' absent de ' + PAGES.tool);
  }

  // l'outil charge l'habillage partagé (sélecteur d'outil + décor)
  assert.match(app, /import\s+'\.\/chrome\.js'/, 'app.js importe chrome.js');
  assert.match(chrome, /from '\.\/lib\/tools\.js'/, 'chrome.js lit le registre des outils');

  // une seule vue de traitement : l'ancien onglet « Extraire » a bien disparu
  assert.ok(!html.includes('id="panel-extract"'), 'panneau Extraire retiré');
  assert.ok(!html.includes('id="tab-extract"'), 'onglet Extraire retiré');
  assert.ok(!html.includes('>Extraire<'), 'bouton Extraire retiré');
  assert.ok(html.includes('id="groupForm"'), 'formulaire « Trier par site » présent');

  // la barre de progression est en place et pilotée par app.js
  for (const id of ['gprogress', 'gbar', 'gpct']) {
    assert.ok(html.includes('id="' + id + '"'), 'élément #' + id + ' absent de ' + PAGES.tool);
  }
  assert.match(app, /progressTo\(/, 'la barre avance avec les messages de progression');
  assert.match(app, /progressDone\(/, 'la barre se termine à 100 %');

  // la liste des sites est bien un <ul>
  assert.match(html, /<ul id="gsites"/);
  // les modes proposés correspondent au moteur
  const groupModes = [...html.matchAll(/name="gmode" value="([a-z]+)"/g)].map((m) => m[1]);
  assert.deepEqual(groupModes, ['last', 'first', 'longest', 'all', 'custom']);
  assert.ok(!/name="mode"/.test(html), 'plus de modes pour l’extraction seule');
});

test('le sélecteur d’outil est présent sur toutes les pages', () => {
  for (const [name, page] of Object.entries(PAGES)) {
    const text = name === 'home' ? home : html;
    for (const id of ['toolSwitcher', 'toolSwitcherBtn', 'toolSwitcherName', 'toolMenu']) {
      assert.ok(text.includes('id="' + id + '"'), 'élément #' + id + ' absent de la page ' + name);
    }
    // un <details> : le menu s'ouvre au clic, même sans JavaScript
    assert.match(text, /<details class="toolswitch[^"]*" id="toolSwitcher">/, 'sélecteur <details> sur ' + name);
    assert.match(text, /<summary class="toolswitch-btn" id="toolSwitcherBtn"/, 'déclencheur <summary> sur ' + name);
    // le menu est écrit dans la page : aucune navigation ne dépend du registre JS
    const menu = text.slice(text.indexOf('id="toolMenu"'), text.indexOf('</details>'));
    assert.match(menu, /class="tool-item"[^>]*href="\//, 'le menu liste au moins l’accueil sur ' + name);
    assert.match(menu, /<span class="tool-item-text">/, 'entrée de menu renseignée sur ' + name);
  }

  // la page outil dit d'où elle vient, et la marque ramène à l'accueil
  assert.match(html, /<nav class="crumb" aria-label="Breadcrumb">/);
  assert.match(html, /<a class="brand" href="\/"/);
  assert.match(home, /<a class="brand" href="\/" aria-current="page">/);

  // le logo est un SVG dessiné sur place, jamais une image
  for (const [name, text] of [['accueil', home], ['outil', html]]) {
    assert.match(text, /<svg class="logo" viewBox="0 0 48 48"/, 'logo absent de ' + name);
    assert.match(text, /class="logo-z"/, 'le Z du logo absent de ' + name);
    assert.ok(!/<img\b/i.test(text), name + ' ne doit contenir aucune balise <img>');
    assert.match(text, /<span class="brand-sub">tools by zach<\/span>/, 'signature « tools by zach » sur ' + name);
  }

  // aucune ressource distante n'est chargée : les liens sortants restent des liens utilisateur.
  for (const [name, text] of [['accueil', home], ['outil', html]]) {
    for (const match of text.matchAll(/<(?:script|link|img|iframe)\b[^>]*\b(?:src|href)="(https?:\/\/[^"]+)"/gi)) {
      assert.fail('ressource externe chargée par ' + name + ' : ' + match[1]);
    }
  }
  for (const source of [app, chrome]) {
    for (const match of source.matchAll(/import\s+[^;]*from\s+['"]([^'"]+)['"]/g)) {
      assert.ok(match[1].startsWith('./') || match[1].startsWith('/'), 'import externe : ' + match[1]);
    }
  }
});

test('le bouton Discord ouvre le serveur communautaire en nouvel onglet', () => {
  for (const [name, text] of [['accueil', home], ['outil', html]]) {
    const link = text.match(/<a\b(?=[^>]*\bclass="discord-link")([^>]*)>/);
    assert.ok(link, 'bouton Discord absent de ' + name);
    assert.match(link[1], /\bhref="https:\/\/discord\.gg\/uKZAZS8kY9"/);
    assert.match(link[1], /\btarget="_blank"/);
    assert.match(link[1], /\brel="noopener noreferrer"/);
    assert.match(text, /<svg class="discord-logo"[^>]*aria-hidden="true"/);
  }
});

test('aucun emoji dans le site', () => {
  // pictogrammes, symboles et drapeaux emoji. Les signes typographiques du
  // projet (→, ·, —, « ») ne sont pas concernés : ils s’affichent en noir.
  const emoji = /[\u{1F000}-\u{1FAFF}\u{2600}-\u{27BF}\u{2B00}-\u{2BFF}\u{25A0}-\u{25FF}\u{FE0F}\u{1F1E6}-\u{1F1FF}\u{20E3}]/u;
  const files = [
    PAGES.home,
    PAGES.tool,
    'public/styles.css',
    'public/app.js',
    'public/home.js',
    'public/chrome.js',
    'public/worker.js',
    'public/lib/parse.js',
    'public/lib/group.js',
    'public/lib/tools.js',
  ];
  for (const file of files) {
    const text = fs.readFileSync(path.join(ROOT, file), 'utf8');
    const found = text.match(emoji);
    assert.equal(found, null, file + ' contient un pictogramme : ' + found);
  }
});

test('la décoration reste sobre, accessible et sans ressource distante', () => {
  const css = fs.readFileSync(path.join(ROOT, 'public/styles.css'), 'utf8');

  // le décor est bien dans les deux pages (halos, grain, bandeau, fil de lecture)
  for (const marker of ['ambient-noise', 'marquee-track', 'scroll-line', 'reveal']) {
    assert.ok(home.includes(marker), 'décor absent de l’accueil : ' + marker);
    assert.ok(html.includes(marker), 'décor absent de la page outil : ' + marker);
  }
  assert.ok(home.includes('void-canvas'), 'fond animé absent de l’accueil');
  assert.ok(html.includes('ambient-grid'), 'grille absente de la page outil');

  // l'accueil impose le noir, les autres pages suivent le système
  assert.match(home, /<html lang="en" class="void">/, 'accueil en fond noir imposé');
  assert.match(home, /<meta name="color-scheme" content="dark">/);
  assert.match(html, /<meta name="color-scheme" content="light dark">/);

  // les animations se coupent quand l’utilisateur le demande
  assert.match(css, /@media \(prefers-reduced-motion: reduce\)/, 'mouvement réduit géré');
  // le thème sombre est la base ; le clair suit le système, sauf sur l'accueil
  assert.match(css, /@media \(prefers-color-scheme: light\) \{\s*:root:not\(\.void\)/,
    'thème clair réservé aux pages qui suivent le système');
  assert.match(css, /html\.void \{ color-scheme: dark; \}/, 'accueil : noir imposé');
  // aucune image ni police distante : le décor est fait de CSS
  // (les data URI contiennent eux-mêmes un url(%23n) : on les retire avant)
  const withoutData = css.replace(/url\(\s*(["'])data:[\s\S]*?\1\s*\)/g, 'URL');
  for (const match of withoutData.matchAll(/url\(\s*["']?(?!#)[^)]*\)/g)) {
    assert.fail('ressource externe dans styles.css : ' + match[0]);
  }
  for (const match of css.matchAll(/@import|@font-face/g)) {
    assert.fail('import externe dans styles.css : ' + match[0]);
  }
  // toute animation utilisée doit avoir ses @keyframes
  const declared = new Set([...css.matchAll(/@keyframes\s+([\w-]+)/g)].map((m) => m[1]));
  for (const match of css.matchAll(/animation(?:-name)?:\s*([\w-]+)/g)) {
    if (match[1] === 'none') continue;
    assert.ok(declared.has(match[1]), 'animation sans @keyframes : ' + match[1]);
  }
  // sélecteur d'outil, logo et instruments de l'accueil sont habillés
  for (const marker of [
    '.toolswitch-btn', '.toolswitch-menu', '.tool-item', '.crumb',
    '.logo-ring', '.logo-z', '.void-canvas', '.core-canvas', '.telemetry', '.signal-canvas',
  ]) {
    assert.ok(css.includes(marker), 'style manquant : ' + marker);
  }
  // plus aucune carte d'outil dans le CSS : l'accueil ne cite pas les outils
  for (const marker of ['.tool-card', '.tools-grid', '.tool-meta', '.badge-on']) {
    assert.ok(!css.includes(marker), 'style d’outil encore présent : ' + marker);
  }
});

test.after(() => {
  URL.createObjectURL = realCreateObjectURL;
});
