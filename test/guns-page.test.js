/*
 * Fumée de la page « Guns.lol views » : on charge public/guns.js dans Node avec
 * un DOM simulé construit à partir des identifiants réellement présents dans la
 * page. Objectif : attraper une faute de frappe sans navigateur.
 */
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = path.join(path.dirname(fileURLToPath(import.meta.url)), '..');
const PAGE = 'public/tools/guns-views/index.html';
const html = fs.readFileSync(path.join(ROOT, PAGE), 'utf8');
const module = fs.readFileSync(path.join(ROOT, 'public/guns.js'), 'utf8');

function fakeNode(id) {
  const node = {
    id,
    textContent: '',
    value: '',
    placeholder: '',
    hidden: false,
    disabled: false,
    checked: false,
    className: '',
    attributes: new Map(),
    listeners: new Map(),
    setAttribute(name, value) { node.attributes.set(name, value); },
    getAttribute(name) { return node.attributes.has(name) ? node.attributes.get(name) : null; },
    addEventListener(type, handler) { node.listeners.set(type, handler); },
    removeEventListener(type) { node.listeners.delete(type); },
    appendChild() {},
    append() {},
    replaceChildren() {},
    remove() {},
    click() {},
    focus() {},
    scrollIntoView() {},
    querySelector() { return null; },
    querySelectorAll() { return []; },
    insertBefore() {},
    classList: { add() {}, remove() {}, toggle() {} },
    style: {},
  };
  return node;
}

const ids = [...html.matchAll(/id="([^"]+)"/g)].map((match) => match[1]);
const nodes = new Map(ids.map((id) => [id, fakeNode(id)]));

globalThis.document = {
  getElementById: (id) => nodes.get(id) || null,
  createElement: () => fakeNode('created'),
  body: fakeNode('body'),
  addEventListener() {},
};
globalThis.location = { href: 'http://localhost:3000/tools/guns-views/', pathname: '/tools/guns-views/', search: '', hash: '' };
globalThis.history = { replaceState() {} };
globalThis.fetch = async () => ({
  ok: true,
  status: 200,
  headers: { get: () => null },
  json: async () => ({ ok: true, guns: true }),
});

test('guns.js se charge sans erreur et branche ses écouteurs', async () => {
  await import('../public/guns.js?smoke=1');

  for (const [id, type] of [
    ['gunForm', 'submit'],
    ['guser', 'input'],
    ['gcancel', 'click'],
    ['gpool', 'click'],
    ['gsave', 'click'],
    ['gcopy', 'click'],
  ]) {
    const node = nodes.get(id);
    assert.ok(node, 'élément #' + id + ' absent de ' + PAGE);
    assert.ok(node.listeners.has(type), id + ' : pas d’écouteur ' + type);
  }

  assert.equal(nodes.get('gstatus').textContent.length > 0, true, 'état initial renseigné');
  await new Promise((resolve) => setTimeout(resolve, 0));
  assert.equal(nodes.get('gmeta').textContent, 'server ready · proxies harvested on demand');
});

test('le module et la page sont d’accord sur les identifiants', () => {
  const used = new Set([...module.matchAll(/el\('([^']+)'\)/g)].map((match) => match[1]));
  assert.ok(used.size >= 15, 'identifiants trouvés : ' + used.size);
  for (const id of used) {
    assert.ok(html.includes('id="' + id + '"'), 'élément #' + id + ' absent de ' + PAGE);
  }

  // la page charge son module, l'habillage partagé et le socle isomorphe
  assert.match(html, /<script src="\/guns\.js" type="module">/);
  assert.match(module, /import\s+\{\s*copyText\s*\}\s+from\s+'\.\/chrome\.js'/);
  assert.match(module, /from '\.\/lib\/guns\.js'/);

  // aucun identifiant en double, aucune image dans la page
  const unique = new Set(ids);
  assert.equal(unique.size, ids.length, 'identifiant en double dans ' + PAGE);
  assert.equal([...html.matchAll(/<img\b/gi)].length, 0, 'aucune balise <img>');
});
