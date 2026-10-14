/*
 * Test de fumée de l'interface : on charge public/app.js dans Node avec un
 * DOM simulé construit à partir des identifiants réellement présents dans
 * index.html. Objectif : attraper les fautes de frappe (élément manquant,
 * fonction mal nommée, variable non déclarée) sans navigateur.
 */
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = path.join(path.dirname(fileURLToPath(import.meta.url)), '..');
const html = fs.readFileSync(path.join(ROOT, 'public/index.html'), 'utf8');
const app = fs.readFileSync(path.join(ROOT, 'public/app.js'), 'utf8');

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

globalThis.location = { href: 'http://localhost:3000/', hash: '', pathname: '/', search: '' };
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

test('app.js et index.html sont cohérents', () => {
  // tous les identifiants utilisés par el('…') existent
  for (const id of new Set([...app.matchAll(/el\('([^']+)'\)/g)].map((match) => match[1]))) {
    assert.ok(html.includes('id="' + id + '"'), 'élément #' + id + ' absent de index.html');
  }

  // une seule vue : l'ancien onglet « Extraire » a bien disparu
  assert.ok(!html.includes('id="panel-extract"'), 'panneau Extraire retiré');
  assert.ok(!html.includes('id="tab-extract"'), 'onglet Extraire retiré');
  assert.ok(!html.includes('>Extraire<'), 'bouton Extraire retiré');
  assert.ok(html.includes('id="groupForm"'), 'formulaire « Trier par site » présent');

  // la barre de progression est en place et pilotée par app.js
  for (const id of ['gprogress', 'gbar', 'gpct']) {
    assert.ok(html.includes('id="' + id + '"'), 'élément #' + id + ' absent de index.html');
  }
  assert.match(app, /progressTo\(/, 'la barre avance avec les messages de progression');
  assert.match(app, /progressDone\(/, 'la barre se termine à 100 %');

  // la liste des sites est bien un <ul>
  assert.match(html, /<ul id="gsites"/);
  // les modes proposés correspondent au moteur
  const groupModes = [...html.matchAll(/name="gmode" value="([a-z]+)"/g)].map((m) => m[1]);
  assert.deepEqual(groupModes, ['last', 'first', 'longest', 'all', 'custom']);
  assert.ok(!/name="mode"/.test(html), 'plus de modes pour l’extraction seule');
  // aucune ressource distante n'est chargée : les liens sortants restent des liens utilisateur.
  for (const match of html.matchAll(/<(?:script|link|img|iframe)\b[^>]*\b(?:src|href)="(https?:\/\/[^\"]+)"/gi)) {
    assert.fail('ressource externe chargée par la page : ' + match[1]);
  }
  for (const match of app.matchAll(/import\s+[^;]*from\s+['"]([^'"]+)['"]/g)) {
    assert.ok(match[1].startsWith('./') || match[1].startsWith('/'), 'import externe : ' + match[1]);
  }
});

test('le bouton Discord ouvre le serveur communautaire en nouvel onglet', () => {
  const link = html.match(/<a\b(?=[^>]*\bclass="discord-link")([^>]*)>/);
  assert.ok(link, 'bouton Discord absent de l’en-tête');
  assert.match(link[1], /\bhref="https:\/\/discord\.gg\/uKZAZS8kY9"/);
  assert.match(link[1], /\btarget="_blank"/);
  assert.match(link[1], /\brel="noopener noreferrer"/);
  assert.match(html, /<svg class="discord-logo"[^>]*aria-hidden="true"/);
});

test('aucun emoji dans le site', () => {
  // pictogrammes, symboles et drapeaux emoji. Les signes typographiques du
  // projet (→, ·, —, « ») ne sont pas concernés : ils s’affichent en noir.
  const emoji = /[\u{1F000}-\u{1FAFF}\u{2600}-\u{27BF}\u{2B00}-\u{2BFF}\u{25A0}-\u{25FF}\u{FE0F}\u{1F1E6}-\u{1F1FF}\u{20E3}]/u;
  const files = [
    'public/index.html',
    'public/styles.css',
    'public/app.js',
    'public/worker.js',
    'public/lib/parse.js',
    'public/lib/group.js',
  ];
  for (const file of files) {
    const text = fs.readFileSync(path.join(ROOT, file), 'utf8');
    const found = text.match(emoji);
    assert.equal(found, null, file + ' contient un pictogramme : ' + found);
  }
});

test('la décoration reste sobre, accessible et sans ressource distante', () => {
  const css = fs.readFileSync(path.join(ROOT, 'public/styles.css'), 'utf8');

  // le décor est bien dans la page (grille, halos, bandeau, fil de lecture)
  for (const marker of ['ambient-grid', 'ambient-noise', 'marquee-track', 'scroll-line', 'reveal']) {
    assert.ok(html.includes(marker), 'décor absent de index.html : ' + marker);
  }

  // les animations se coupent quand l’utilisateur le demande
  assert.match(css, /@media \(prefers-reduced-motion: reduce\)/, 'mouvement réduit géré');
  // le thème suit le réglage du système, sans thème clair imposé
  assert.match(css, /@media \(prefers-color-scheme: dark\)/, 'thème sombre automatique');
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
});

test.after(() => {
  URL.createObjectURL = realCreateObjectURL;
});
