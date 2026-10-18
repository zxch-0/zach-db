/*
 * La préférence de mouvement : qui décide, et comment on peut trancher.
 *
 * Le réglage du système reste le défaut — c'est une exigence d'accessibilité.
 * Ce test vérifie donc DEUX choses : que rien ne change quand le visiteur n'a
 * rien demandé, et que la bascule d'en-tête (system → live → still) prend
 * effet partout, sans rechargement : dans le moteur de l'accueil, dans le CSS,
 * et sur les trois pages du site à l'identique.
 *
 * Comme pour les autres tests, tout se joue dans Node avec un navigateur
 * fictif : matchMedia, localStorage, location et une pincée de DOM.
 */
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = path.join(path.dirname(fileURLToPath(import.meta.url)), '..');
const read = (file) => fs.readFileSync(path.join(ROOT, file), 'utf8');

const PAGES = [
  'public/index.html',
  'public/tools/group-by-site/index.html',
  'public/tools/discord-lookup/index.html',
];

/* ---------- navigateur fictif ---------- */

const store = new Map();
const classes = new Set();
const url = { pathname: '/', search: '', hash: '' };
let systemReduced = false;
let replaced = null;
let clickHandler = null;
let valueNode = null;

function reset() {
  store.clear();
  classes.clear();
  url.pathname = '/';
  url.search = '';
  url.hash = '';
  systemReduced = false;
  replaced = null;
  clickHandler = null;

  valueNode = { textContent: '' };
  const button = {
    attributes: new Map(),
    setAttribute(name, value) {
      this.attributes.set(name, value);
    },
    getAttribute(name) {
      return this.attributes.has(name) ? this.attributes.get(name) : null;
    },
    addEventListener(type, handler) {
      if (type === 'click') clickHandler = handler;
    },
    querySelector: (selector) => (selector === '.motion-val' ? valueNode : null),
  };

  globalThis.localStorage = {
    getItem: (key) => (store.has(key) ? store.get(key) : null),
    setItem: (key, value) => store.set(key, String(value)),
    removeItem: (key) => store.delete(key),
  };
  globalThis.location = url;
  globalThis.history = { replaceState: (state, title, to) => { replaced = to; } };
  globalThis.matchMedia = (query) => ({
    media: query,
    matches: /reduced-motion/.test(query) ? systemReduced : false,
    addEventListener() {},
  });
  globalThis.document = {
    documentElement: {
      classList: {
        add: (name) => classes.add(name),
        remove: (name) => classes.delete(name),
        toggle: (name, on) => (on ? classes.add(name) : classes.delete(name)),
        contains: (name) => classes.has(name),
      },
    },
    getElementById: (id) => (id === 'motionSwitch' ? button : null),
  };
  return button;
}

const motion = await import('../public/lib/motion.js');

/* ---------- qui décide ---------- */

test('par défaut, c’est le système qui décide', () => {
  reset();
  systemReduced = false;
  assert.equal(motion.readMotion(), 'system');
  assert.equal(motion.motionReduced(), false, 'le système autorise le mouvement');

  systemReduced = true;
  assert.equal(motion.readMotion(), 'system', 'aucun choix n’est inventé');
  assert.equal(motion.motionReduced(), true, 'le système demande moins de mouvement');
});

test('live anime même quand le système refuse, still gèle même quand il autorise', () => {
  reset();
  systemReduced = true;
  motion.setMotion('live');
  assert.equal(motion.motionReduced(), false, 'le visiteur a demandé l’animation');
  assert.equal(store.get(motion.MOTION_KEY), 'live', 'le choix survit au rechargement');
  assert.ok(classes.has('motion-live') && !classes.has('motion-still'), 'classes posées sur <html>');

  reset();
  systemReduced = false;
  motion.setMotion('still');
  assert.equal(motion.motionReduced(), true, 'le visiteur a demandé le gel');
  assert.ok(classes.has('motion-still') && !classes.has('motion-live'));
});

test('revenir à system rend la main au système et efface le stockage', () => {
  reset();
  systemReduced = true;
  motion.setMotion('live');
  motion.setMotion('system');
  assert.equal(store.has(motion.MOTION_KEY), false, 'rien ne reste stocké');
  assert.equal(classes.size, 0, 'aucune classe de forçage');
  assert.equal(motion.motionReduced(), true, 'le système reprend la main');
});

test('la bascule passe d’un cran à l’autre dans l’ordre', () => {
  reset();
  assert.deepEqual(motion.MOTION_STATES, ['system', 'live', 'still']);
  assert.equal(motion.nextMotion(), 'live');
  motion.setMotion('live');
  assert.equal(motion.nextMotion(), 'still');
  motion.setMotion('still');
  assert.equal(motion.nextMotion(), 'system');
});

test('?motion=… l’emporte, est gardé, puis l’URL redevient propre', () => {
  reset();
  systemReduced = true;
  url.pathname = '/tools/discord-lookup/';
  url.search = '?motion=live';
  assert.equal(motion.readMotion(), 'live', 'l’URL gagne sur le stockage');
  assert.equal(motion.motionReduced(), false);

  motion.initMotion();
  assert.equal(store.get(motion.MOTION_KEY), 'live', 'le cran demandé est gardé');
  assert.equal(replaced, '/tools/discord-lookup/', 'le paramètre est retiré de l’adresse');
});

test('un stockage illisible ou absent ne casse rien', () => {
  reset();
  systemReduced = true;
  motion.setMotion('system'); // aucun cran de session ne traîne
  store.set(motion.MOTION_KEY, 'oui');
  assert.equal(motion.readMotion(), 'system', 'une valeur inconnue est ignorée');
  assert.equal(motion.motionReduced(), true);

  // navigation privée : plus de stockage du tout, le cran vaut pour l'onglet
  delete globalThis.localStorage;
  delete globalThis.location;
  assert.equal(motion.readMotion(), 'system');
  motion.setMotion('live');
  assert.equal(motion.motionReduced(), false, 'le choix tient sans localStorage');
});

test('les modules qui animent sont prévenus sans rechargement', () => {
  reset();
  systemReduced = true;
  const seen = [];
  motion.onMotionChange((choice) => seen.push(choice));
  motion.setMotion('live');
  motion.setMotion('still');
  motion.setMotion('system');
  assert.deepEqual(seen, ['live', 'still', 'system']);
});

test('la bascule d’en-tête affiche toujours le cran en cours', () => {
  const button = reset();
  systemReduced = true;
  motion.initMotion();
  assert.equal(valueNode.textContent, 'system');
  assert.equal(button.getAttribute('data-state'), 'system');
  assert.match(button.getAttribute('aria-label'), /system setting/);

  clickHandler(); // system → live
  assert.equal(valueNode.textContent, 'live');
  assert.equal(button.getAttribute('data-state'), 'live');
  assert.equal(motion.motionReduced(), false);
  assert.ok(classes.has('motion-live'));

  clickHandler(); // live → still
  assert.equal(valueNode.textContent, 'still');
  assert.equal(motion.motionReduced(), true);

  clickHandler(); // still → system
  assert.equal(valueNode.textContent, 'system');
  assert.equal(motion.motionReduced(), true, 'le système reprend la main');
  assert.equal(classes.size, 0);
});

/* ---------- la bascule est partout, identique ---------- */

test('les trois pages portent la même bascule, dans l’en-tête', () => {
  const marks = [];
  for (const file of PAGES) {
    const text = read(file);
    const at = text.indexOf('<button class="motion-switch"');
    assert.ok(at > -1, file + ' : bascule absente');
    marks.push(text.slice(at, text.indexOf('</button>', at)));

    const head = text.slice(text.indexOf('<header class="site-head">'), text.indexOf('</header>'));
    assert.ok(head.includes('id="motionSwitch"'), file + ' : bascule hors de l’en-tête');
    assert.match(text, /<span class="motion-key">Motion<\/span>/, file + ' : libellé');
    assert.match(text, /<b class="motion-val">system<\/b>/, file + ' : cran par défaut affiché');
    assert.match(text, /data-state="system"/, file + ' : état par défaut');
    assert.match(text, /type="button"/, file + ' : pas de formulaire déclenché');

    // le cran est posé avant la première image, sinon la page clignote
    const headScript = text.slice(text.indexOf('<script>'), text.indexOf('</script>'));
    assert.match(headScript, /localStorage\.getItem\('zach-db-motion'\)/, file + ' : choix lu avant peinture');
    assert.match(headScript, /classList\.add\('motion-' \+ asked\)/, file + ' : classe posée avant peinture');
  }
  assert.equal(new Set(marks).size, 1, 'la bascule diffère d’une page à l’autre');
});

test('les pages restent utilisables sans JavaScript', () => {
  // sans JS, la classe n'est jamais posée : c'est le CSS qui répond au système
  for (const file of PAGES) {
    const text = read(file);
    const headScript = text.slice(text.indexOf('<script>'), text.indexOf('</script>'));
    assert.match(headScript, /try \{/, file + ' : le stockage peut être refusé');
    assert.match(headScript, /\} catch \(ignored\) \{\}/, file + ' : aucune exception ne bloque la page');
  }
});

/* ---------- le CSS gèle dans les deux sens ---------- */

test('le CSS gèle autant par choix que par réglage système', () => {
  const css = read('public/styles.css');
  const opener = '@media (prefers-reduced-motion: reduce) {';
  const at = css.indexOf(opener);
  assert.ok(at > -1, 'bloc mouvement réduit absent');
  const after = css.slice(at + opener.length);
  const systemInner = after.slice(0, after.indexOf('\n}\n'));

  const stillStart = css.indexOf('html.motion-still { scroll-behavior: auto; }');
  const stillEnd = css.indexOf('/* ---- pause du décor');
  assert.ok(stillStart > at && stillEnd > stillStart, 'bloc de gel forcé absent');
  const stillInner = css.slice(stillStart, stillEnd);

  // mêmes règles, à la classe de garde près : les deux blocs ne peuvent pas diverger
  const norm = (block, guard) => block.replaceAll(guard, '').replace(/\s+/g, ' ').trim();
  assert.equal(norm(systemInner, ':not(.motion-live)'), norm(stillInner, '.motion-still'));

  // le forçage libère bien le décor : le bloc système ne s'applique pas en motion-live
  assert.ok(systemInner.includes('html:not(.motion-live)'), 'le bloc système ignore motion-live');
  assert.ok(!/^\s*html \{/m.test(systemInner), 'une règle non gardée s’est glissée dans le bloc système');
});

test('la bascule est habillée, en noir et blanc, dans les deux thèmes', () => {
  const css = read('public/styles.css');
  const at = css.indexOf('\n.motion-switch {\n'); // la règle de base, pas son réglage étroit
  assert.ok(at > -1, 'règle de base de la bascule absente');
  const rule = css.slice(at, css.indexOf('}', at));
  for (const property of ['border: 1px solid var(--hair-2)', 'border-radius: 999px', 'font-family: var(--mono)', 'cursor: pointer']) {
    assert.ok(rule.includes(property), '.motion-switch : ' + property + ' manquant');
  }
  assert.match(css, /\.motion-switch:focus-visible \{ outline: 2px solid var\(--ink\); outline-offset: 2px; \}/,
    'focus visible au clavier');
  // cran forcé : la bascule passe en négatif, sans couleur
  const forcedAt = css.indexOf('\nhtml.motion-live .motion-switch,');
  const forced = css.slice(forcedAt, css.indexOf('}', forcedAt));
  for (const property of ['background: var(--ink)', 'border-color: var(--ink)', 'color: var(--paper)']) {
    assert.ok(forced.includes(property), 'état forcé : ' + property + ' manquant');
  }
  assert.ok(!/#[0-9a-f]{3,8}|rgb\(|hsl\(/i.test(rule + forced), 'une couleur s’est glissée dans la bascule');
  // écrans étroits : la bascule rejoint les autres commandes et ne garde que son cran
  assert.match(css, /\.motion-switch \{ order: 1; \}/);
  assert.match(css, /\.motion-key \{ display: none; \}/);
  // encore faut-il que ces réglages passent APRÈS la base, sinon ils ne servent à rien
  assert.ok(css.indexOf('.motion-key { display: none; }') > css.indexOf('\n.motion-key {\n'),
    'le réglage étroit est écrasé par la règle de base');
});

test('le moteur et l’habillage consultent le module, pas le média brut', () => {
  const home = read('public/home.js');
  const chrome = read('public/chrome.js');

  assert.match(home, /import \{ motionReduced, onMotionChange \} from '\.\/lib\/motion\.js';/);
  assert.match(home, /let reducedMotion = motionReduced\(\);/, 'le cran peut changer en cours de route');
  assert.match(home, /onMotionChange\(/, 'le fond suit la bascule');
  assert.ok(!/prefers-reduced-motion/.test(home), 'home.js ne lit plus le média en direct');

  assert.match(chrome, /import \{ motionReduced, initMotion, onMotionChange \} from '\.\/lib\/motion\.js';/);
  assert.match(chrome, /initMotion\(\);/, 'la bascule est armée avec le reste de l’habillage');
  assert.ok(!/prefers-reduced-motion/.test(chrome), 'chrome.js ne lit plus le média en direct');
});
