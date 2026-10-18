/*
 * Le fond de l'accueil est-il VRAIMENT animé ?
 *
 * On ne peut pas ouvrir un navigateur ici, alors on rejoue la boucle dans Node :
 * un requestAnimationFrame virtuel, une horloge virtuelle, et un contexte 2D qui
 * enregistre chaque tracé au lieu de le dessiner. On compare ensuite les images
 * successives des trois calques (grille de fond, noyau filaire, oscilloscope).
 *
 * Ce test échoue si la boucle ne tourne pas, si un calque reste figé, si le
 * canvas n'est pas dimensionné, ou si le fond n'est plus derrière le contenu.
 */
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = path.join(path.dirname(fileURLToPath(import.meta.url)), '..');
const read = (file) => fs.readFileSync(path.join(ROOT, file), 'utf8');
const home = read('public/index.html');
const css = read('public/styles.css');

const CANVASES = ['voidCanvas', 'coreCanvas', 'signalCanvas'];

/* ---------- environnement navigateur fictif ---------- */

const recorders = new Map();
const rafQueue = [];
let clock = 0;

function makeRecorder() {
  const rec = { ops: [] };
  const gradient = { addColorStop() {} };
  const numbers = (list) => list.map((value) => (typeof value === 'number' ? Math.round(value * 100) / 100 : value));
  const target = {
    createLinearGradient: () => gradient,
    createRadialGradient: () => gradient,
    lineWidth: 1,
    fillStyle: '',
    strokeStyle: '',
  };
  rec.context = new Proxy(target, {
    get(box, prop) {
      if (prop in box) return box[prop];
      return (...args) => {
        rec.ops.push(String(prop) + '(' + numbers(args).join(',') + ')');
      };
    },
    set(box, prop, value) {
      box[prop] = value;
      return true;
    },
  });
  return rec;
}

function fakeNode(id, sizes) {
  const rec = makeRecorder();
  recorders.set(id, rec);
  return {
    id,
    textContent: '',
    hidden: false,
    open: false,
    width: 0,
    height: 0,
    attributes: new Map(),
    setAttribute(name, value) {
      this.attributes.set(name, value);
    },
    getAttribute(name) {
      return this.attributes.has(name) ? this.attributes.get(name) : null;
    },
    removeAttribute(name) {
      this.attributes.delete(name);
    },
    addEventListener() {},
    removeEventListener() {},
    appendChild() {},
    append() {},
    replaceChildren() {},
    focus() {},
    querySelector() {
      return null;
    },
    querySelectorAll() {
      return [];
    },
    classList: { add() {}, remove() {}, toggle() {} },
    style: { setProperty() {} },
    getBoundingClientRect: () => sizes,
    getContext: () => rec.context,
  };
}

const sizes = { width: 1440, height: 900, top: 0, left: 0, right: 1440, bottom: 900 };
const nodes = new Map();
for (const id of [...home.matchAll(/id="([^"]+)"/g)].map((m) => m[1])) {
  nodes.set(id, fakeNode(id, sizes));
}

globalThis.performance = { now: () => clock };
globalThis.requestAnimationFrame = (callback) => rafQueue.push(callback);
globalThis.cancelAnimationFrame = () => {};
globalThis.devicePixelRatio = 1;
globalThis.innerWidth = 1440;
globalThis.innerHeight = 900;
globalThis.window = { addEventListener() {} };
globalThis.matchMedia = (query) => ({ media: query, matches: false });
globalThis.document = {
  hidden: false,
  activeElement: null,
  documentElement: { scrollTop: 0, scrollHeight: 4000, clientHeight: 900 },
  body: fakeNode('body', sizes),
  getElementById: (id) => nodes.get(id) || null,
  createElement: (tag) => fakeNode('created-' + tag, sizes),
  createDocumentFragment: () => fakeNode('fragment', sizes),
  querySelectorAll: () => [],
  addEventListener() {},
};

const signature = (id) => recorders.get(id).ops.join('|');
const opsOf = (id) => recorders.get(id).ops;

function playFrames(count, stepMs = 16.7) {
  const frames = [];
  for (let i = 0; i < count; i++) {
    for (const id of CANVASES) recorders.get(id).ops.length = 0;
    const callback = rafQueue.shift();
    assert.equal(typeof callback, 'function', 'la boucle ne se réarme pas à l’image ' + (i + 1));
    clock += stepMs;
    callback(clock);
    frames.push({
      void: signature('voidCanvas'),
      core: signature('coreCanvas'),
      signal: signature('signalCanvas'),
      pending: rafQueue.length,
    });
  }
  return frames;
}

test('le fond animé tourne : chaque image diffère de la précédente', async () => {
  await import('../public/home.js?anim=1');

  // la boucle est armée dès le chargement de la page
  assert.equal(rafQueue.length, 1, 'un premier frame est demandé au chargement');

  // les trois canvas ont une taille réelle (sinon rien n'est visible)
  for (const id of CANVASES) {
    const node = nodes.get(id);
    assert.ok(node, 'canvas #' + id + ' absent de l’accueil');
    assert.equal(node.width, 1440, id + ' : largeur du canvas');
    assert.ok(node.height > 0, id + ' : hauteur du canvas');
  }

  const frames = playFrames(6);

  // chaque calque bouge à chaque image
  for (const layer of ['void', 'core', 'signal']) {
    const distinct = new Set(frames.map((frame) => frame[layer])).size;
    assert.equal(distinct, frames.length, 'le calque « ' + layer + ' » se répète d’une image à l’autre');
  }

  // la boucle continue : une nouvelle image est demandée après chaque tracé
  assert.ok(frames.every((frame) => frame.pending === 1), 'la boucle s’arrête en cours de route');

  // le fond n'est pas un décor vide : des centaines de tracés par image
  for (const id of CANVASES) {
    assert.ok(opsOf(id).length > 60, id + ' : trop peu de tracés (' + opsOf(id).length + ')');
  }
});

test('la grille de fond défile vraiment vers l’horizon', async () => {
  // les lignes transversales partent de x = 0 : leurs ordonnées doivent glisser
  const horizontals = () => opsOf('voidCanvas')
    .filter((op) => op.startsWith('moveTo(0,'))
    .map((op) => Number(op.slice('moveTo(0,'.length, -1)));

  const before = horizontals();
  clock += 500; // une demi-seconde de défilement
  const callback = rafQueue.shift();
  for (const id of CANVASES) recorders.get(id).ops.length = 0;
  callback(clock);
  const after = horizontals();

  assert.ok(before.length >= 8, 'assez de lignes de grille tracées : ' + before.length);
  assert.equal(before.length, after.length, 'le nombre de lignes reste stable');
  assert.notDeepEqual(before, after, 'les lignes de la grille ne bougent pas');
  // la poussière et ses liens au curseur sont aussi de la partie
  assert.ok(opsOf('voidCanvas').some((op) => op.startsWith('fillRect(')), 'poussière dessinée');
});

test('mouvement réduit : une image fixe, aucune boucle', async () => {
  globalThis.matchMedia = (query) => ({ media: query, matches: /reduced-motion/.test(query) });
  const queued = rafQueue.length;
  for (const id of CANVASES) recorders.get(id).ops.length = 0;

  await import('../public/home.js?still=1');

  assert.equal(rafQueue.length, queued, 'aucune boucle ne démarre si le système demande moins de mouvement');
  for (const id of CANVASES) {
    assert.ok(opsOf(id).length > 60, id + ' : l’image fixe n’est pas composée');
  }
});

test('le fond animé est bien le fond de la page', () => {
  // le canvas est dans la page, avant le contenu, et couvre tout l'écran
  const at = home.indexOf('id="voidCanvas"');
  assert.ok(at > -1, 'canvas de fond absent de l’accueil');
  assert.ok(at > home.indexOf('class="ambient"'), 'le fond passe après les halos');
  assert.ok(at < home.indexOf('<main'), 'le fond est posé avant le contenu');

  const rule = css.slice(css.indexOf('.void-canvas {'), css.indexOf('}', css.indexOf('.void-canvas {')));
  for (const property of ['position: fixed', 'inset: 0', 'z-index: 0', 'width: 100%', 'height: 100%', 'pointer-events: none']) {
    assert.ok(rule.includes(property), '.void-canvas : ' + property + ' manquant');
  }

  // le contenu passe au-dessus, sans fond opaque dans l'accroche
  assert.match(css, /header, main, footer \{ position: relative; z-index: 1; \}/);
  const hero = css.slice(css.indexOf('.hero {'), css.indexOf('}', css.indexOf('.hero {')));
  assert.ok(!/background/.test(hero), 'l’accroche masque le fond animé');
  assert.match(css, /body \{[^}]*background: var\(--paper\)/s, 'le papier sert de fond au canvas');
  assert.match(home, /<html lang="en" class="void">/, 'accueil en noir imposé');
  assert.match(css, /html\.void \{ color-scheme: dark; \}/);
});
