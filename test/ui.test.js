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
  assert.ok(nodes.get('gsummary').textContent.length > 0, 'la liste vide est annoncée');
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
  // aucune ressource externe : le site reste autonome et rapide
  for (const match of html.matchAll(/(?:src|href)="(https?:\/\/[^"]+)"/g)) {
    assert.fail('ressource externe chargée par la page : ' + match[1]);
  }
  for (const match of app.matchAll(/import\s+[^;]*from\s+['"]([^'"]+)['"]/g)) {
    assert.ok(match[1].startsWith('./') || match[1].startsWith('/'), 'import externe : ' + match[1]);
  }
});

test.after(() => {
  URL.createObjectURL = realCreateObjectURL;
});
