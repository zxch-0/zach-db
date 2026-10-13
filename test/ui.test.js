/*
 * Test de fumée de l'interface : public/app.js est chargé dans Node avec un
 * DOM simulé construit à partir des identifiants réellement présents dans
 * index.html, puis on rejoue une analyse complète avec un faux worker.
 *
 * Objectif : attraper les fautes de frappe (élément manquant, fonction mal
 * nommée), vérifier que la barre de progression suit bien l'avancement des
 * lignes, et que la page ne propose plus qu'un seul traitement (tri par site).
 */
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = path.join(path.dirname(fileURLToPath(import.meta.url)), '..');
const nf = new Intl.NumberFormat('fr-FR');
const n = (value) => nf.format(value);

const html = fs.readFileSync(path.join(ROOT, 'public/index.html'), 'utf8');
const css = fs.readFileSync(path.join(ROOT, 'public/styles.css'), 'utf8');
const app = fs.readFileSync(path.join(ROOT, 'public/app.js'), 'utf8');

const ids = [...html.matchAll(/id="([^"]+)"/g)].map((match) => match[1]);

/* états de départ réellement écrits dans la page (hidden, disabled) */
const initial = new Map();
for (const [, attrs] of html.matchAll(/<[a-z]+\b([^>]*)>/gi)) {
  const id = /id="([^"]+)"/.exec(attrs);
  if (!id) continue;
  initial.set(id[1], {
    hidden: /\bhidden\b/.test(attrs),
    disabled: /\bdisabled\b/.test(attrs),
  });
}

/* ---------- DOM simulé ---------- */

function fakeNode(id, tagName = 'div') {
  const node = {
    id,
    tagName,
    textContent: '',
    value: '',
    placeholder: '',
    hidden: false,
    disabled: false,
    checked: false,
    files: [],
    className: '',
    children: [],
    attributes: new Map(),
    listeners: new Map(),
    style: {},
    dataset: {},
    classes: new Set(),
  };
  Object.assign(node, {
    setAttribute(name, value) {
      node.attributes.set(name, value);
    },
    getAttribute(name) {
      return node.attributes.has(name) ? node.attributes.get(name) : null;
    },
    hasAttribute(name) {
      return node.attributes.has(name);
    },
    addEventListener(type, handler) {
      const list = node.listeners.get(type) || [];
      list.push(handler);
      node.listeners.set(type, list);
    },
    removeEventListener(type, handler) {
      const list = node.listeners.get(type) || [];
      const index = list.indexOf(handler);
      if (index !== -1) list.splice(index, 1);
    },
    /** utilitaire de test : déclenche un événement écouté */
    dispatch(type, event = {}) {
      for (const handler of [...(node.listeners.get(type) || [])]) handler(event);
    },
    appendChild(child) {
      node.children.push(child);
      return child;
    },
    append(...kids) {
      node.children.push(...kids);
    },
    replaceChildren(...kids) {
      node.children = [...kids];
    },
    remove() {},
    click() {},
    focus() {},
    select() {},
    scrollIntoView() {},
    querySelector() {
      return null;
    },
    querySelectorAll() {
      return [];
    },
    classList: {
      add(...names) {
        for (const name of names) node.classes.add(name);
      },
      remove(...names) {
        for (const name of names) node.classes.delete(name);
      },
      toggle(name, on) {
        const wanted = on === undefined ? !node.classes.has(name) : !!on;
        if (wanted) node.classes.add(name);
        else node.classes.delete(name);
        return wanted;
      },
      contains(name) {
        return node.classes.has(name);
      },
    },
  });
  return node;
}

/** Cherche un nœud portant la classe donnée (className ou classList). */
function findAll(node, className, out = []) {
  const classes = node.classes || new Set();
  if (classes.has(className) || String(node.className || '').split(/\s+/).includes(className)) out.push(node);
  for (const child of node.children || []) findAll(child, className, out);
  return out;
}

const find = (node, className) => findAll(node, className)[0] || null;

const nodes = new Map(ids.map((id) => {
  const node = fakeNode(id);
  const state = initial.get(id);
  if (state) {
    node.hidden = state.hidden;
    node.disabled = state.disabled;
  }
  return [id, node];
}));
const get = (id) => nodes.get(id);

globalThis.document = {
  getElementById: (id) => nodes.get(id) || null,
  createElement: (tagName) => fakeNode('created', tagName),
  createDocumentFragment: () => fakeNode('fragment', '#fragment'),
  body: fakeNode('body', 'body'),
  addEventListener() {},
};

globalThis.location = { href: 'http://localhost:3000/', hash: '', pathname: '/', search: '' };
globalThis.history = { replaceState() {} };

/* ---------- faux worker ---------- */

const workerMessages = [];
const workers = [];

globalThis.Worker = class {
  constructor(url) {
    this.url = url;
    this.listeners = new Map();
    workers.push(this);
  }

  postMessage(message) {
    workerMessages.push(message);
  }

  addEventListener(type, handler) {
    const list = this.listeners.get(type) || [];
    list.push(handler);
    this.listeners.set(type, list);
  }

  removeEventListener(type, handler) {
    const list = this.listeners.get(type) || [];
    const index = list.indexOf(handler);
    if (index !== -1) list.splice(index, 1);
  }

  /** renvoie un message au code de la page, comme le vrai worker */
  emit(data) {
    for (const handler of [...(this.listeners.get('message') || [])]) handler({ data });
  }
};

const downloads = [];
const realCreateObjectURL = URL.createObjectURL;
URL.createObjectURL = (blob) => {
  downloads.push(blob);
  return 'blob:test';
};
URL.revokeObjectURL = () => {};

/** Laisse les promesses de l'interface se dérouler. */
const settle = async (turns = 8) => {
  for (let i = 0; i < turns; i++) await new Promise((resolve) => setTimeout(resolve, 0));
};

/* ---------- chargement ---------- */

test('app.js se charge et branche ses écouteurs', async () => {
  await import('../public/app.js?smoke=2');

  for (const [id, type] of [
    ['form', 'submit'],
    ['form', 'change'],
    ['cancel', 'click'],
    ['file', 'change'],
    ['drop', 'drop'],
    ['filter', 'input'],
    ['save', 'click'],
    ['copy', 'click'],
    ['back', 'click'],
    ['exportList', 'click'],
    ['regex', 'input'],
  ]) {
    const node = get(id);
    assert.ok(node, 'élément #' + id);
    assert.ok(node.listeners.has(type), id + ' : pas d’écouteur ' + type);
  }

  assert.equal(workerMessages.length, 0, 'aucune passe lancée au chargement');
  assert.ok(get('meta').textContent.length > 0, 'pastille d’état renseignée');
  assert.ok(get('summary').textContent.length > 0, 'la liste vide est annoncée');
  assert.ok(get('status').textContent.length > 0, 'le journal annonce l’état initial');
  assert.equal(get('fill').style.width, undefined, 'barre à zéro tant qu’aucun fichier n’est lu');
  assert.equal(get('result').hidden, true, 'le détail d’un site est masqué au départ');
});

/* ---------- une analyse complète, du dépôt au téléchargement ---------- */

test('une analyse pilote la barre de progression, la liste et le détail', async () => {
  get('file').files = [{ name: 'gros.txt', size: 1000 }];
  get('file').dispatch('change');
  assert.match(get('meta').textContent, /1 fichier/, 'la source est annoncée');
  assert.match(get('dropTitle').textContent, /gros\.txt/);

  get('form').dispatch('submit', { preventDefault() {} });
  await settle();

  assert.equal(workerMessages.length, 1, 'une passe d’analyse est partie');
  const first = workerMessages[0];
  assert.equal(first.type, 'group');
  assert.equal(first.pass.count, true, 'l’analyse ne garde que des compteurs');
  const worker = workers[0];

  /* --- la barre suit les lignes lues --- */
  await new Promise((resolve) => setTimeout(resolve, 30)); // le worker annonce après lecture
  worker.emit({
    type: 'progress', id: first.id, loaded: 250, total: 1000,
    lines: 2500, matched: 2400, kept: 2400, sites: 2,
  });
  assert.equal(get('fill').style.width, '25.00%', 'quart du fichier lu = quart de la barre');
  assert.equal(get('toplineFill').style.width, '25.00%', 'la barre fine du haut suit aussi');
  assert.match(get('pct').textContent, /^25/);
  assert.equal(get('bar').getAttribute('aria-valuenow'), '25');
  assert.ok(get('progress').classes.has('running'), 'la barre est marquée en cours');
  assert.match(get('progressMeta').textContent, /2\s?500 lignes/, 'le nombre de lignes est affiché');
  assert.match(get('progressMeta').textContent, /reste/, 'un temps restant est estimé');
  assert.equal(get('statLines').textContent, n(2500));
  assert.equal(get('statValues').textContent, n(2400));
  assert.notEqual(get('statSpeed').textContent, '—', 'le débit est calculé');

  /* --- la liste des sites se remplit en direct --- */
  worker.emit({
    type: 'sites', id: first.id, live: true, total: 2,
    sites: [
      { site: 'netflix.com', count: 1, bytes: 12 },
      { site: 'roblox.com', count: 2, bytes: 40 },
    ],
  });
  const rows = findAll(get('sites'), 'site-row');
  assert.equal(rows.length, 2, 'deux sites affichés');
  assert.equal(find(rows[0], 'name').textContent, 'roblox.com', 'trié du plus gros au plus petit');
  assert.equal(find(rows[0], 'num').textContent, '2');
  assert.equal(find(rows[0], 'rank').textContent, '01');
  assert.equal(find(rows[0], 'share').children[0].style.width, '100%', 'le plus gros site remplit sa jauge');
  assert.ok(Number.parseInt(find(rows[1], 'share').children[0].style.width, 10) < 100);
  assert.equal(get('empty').hidden, true, 'l’état vide disparaît');
  assert.match(get('summary').textContent, /2 site/, 'le résumé compte les sites');

  /* --- fin de l'analyse --- */
  worker.emit({
    type: 'done', id: first.id, bytes: 1000, loaded: 1000, lines: 10000, matched: 9000,
    kept: 9000, skipped: 1000, sites: 2, outLines: 0, outChars: 0, ms: 500,
  });
  await settle();

  assert.equal(get('fill').style.width, '100.00%', 'la barre se termine pleine');
  assert.ok(get('progress').classes.has('done'));
  assert.equal(get('run').disabled, false, 'le bouton principal redevient actif');
  assert.equal(get('cancel').disabled, true);
  assert.match(get('status').textContent, /terminé/);
  assert.match(get('status').textContent, new RegExp('lignes : ' + n(10000)));
  assert.equal(get('statSites').textContent, '2');
  assert.equal(get('filter').disabled, false, 'le filtre est utilisable');
  assert.equal(get('exportList').disabled, false);

  /* --- clic sur un site : seconde passe et affichage --- */
  find(get('sites'), 'site-row').dispatch('click');
  await settle();

  assert.equal(workerMessages.length, 2, 'une passe ciblée est partie');
  const second = workerMessages[1];
  assert.equal(second.pass.onlySite, 'roblox.com');
  assert.equal(get('result').hidden, false, 'le panneau de détail s’affiche');
  assert.ok(get('resultats').classes.has('open'), 'les résultats passent en deux colonnes');
  assert.equal(get('resultTitle').textContent, 'roblox.com');
  assert.ok(findAll(get('sites'), 'selected').length === 1, 'la ligne choisie est marquée');
  assert.equal(get('fill').style.width, '0.00%', 'la barre repart de zéro pour la seconde passe');

  worker.emit({ type: 'chunk', id: second.id, data: 'Thou_miriba:N2Z6\nuser2:pass2\n' });
  assert.match(get('text').textContent, /Thou_miriba:N2Z6/, 'les valeurs s’affichent au fil de l’eau');

  worker.emit({ type: 'progress', id: second.id, loaded: 500, total: 1000, lines: 5000, kept: 2, sites: 1 });
  assert.equal(get('fill').style.width, '50.00%', 'la seconde passe a sa propre progression');

  worker.emit({
    type: 'done', id: second.id, bytes: 1000, lines: 10000, matched: 9000, kept: 2, sites: 1,
    outLines: 2, outChars: 27, truncated: false, ms: 200,
  });
  await settle();

  assert.equal(get('fill').style.width, '100.00%');
  assert.equal(get('save').disabled, false, 'le téléchargement est proposé');
  assert.equal(get('copy').disabled, false);
  assert.match(get('save').textContent, /roblox\.com\.txt/);
  assert.match(get('resultMeta').textContent, /2 valeurs/, 'le résultat est chiffré');
  assert.equal(get('warn').hidden, true);

  /* --- téléchargement du site --- */
  get('save').dispatch('click');
  assert.equal(downloads.length, 1, 'un .txt est produit');

  /* --- retour à la liste --- */
  get('back').dispatch('click');
  await settle();
  assert.equal(get('result').hidden, true);
  assert.equal(get('resultats').classes.has('open'), false);
  assert.equal(get('save').disabled, true);
});

/* ---------- filtrage et export de la liste ---------- */

test('le filtre ne garde que les sites correspondants', async () => {
  get('filter').value = 'netflix';
  get('filter').dispatch('input');
  const rows = findAll(get('sites'), 'site-row');
  assert.equal(rows.length, 1);
  assert.equal(find(rows[0], 'name').textContent, 'netflix.com');
  assert.match(get('summary').textContent, /1 site\(s\) sur 2/);

  get('filter').value = '';
  get('filter').dispatch('input');
  assert.equal(findAll(get('sites'), 'site-row').length, 2);
});

/* ---------- cohérence page / code ---------- */

test('app.js et index.html sont cohérents', () => {
  // tous les identifiants utilisés par el('…') existent
  for (const id of new Set([...app.matchAll(/el\('([^']+)'\)/g)].map((match) => match[1]))) {
    assert.ok(html.includes('id="' + id + '"'), 'élément #' + id + ' absent de index.html');
  }

  // une seule fonction côté page : le tri par site (l’onglet « Extraire » a disparu)
  assert.equal((html.match(/<form/g) || []).length, 1, 'un seul formulaire');
  assert.equal((html.match(/type="file"/g) || []).length, 1, 'une seule entrée de fichier');
  for (const gone of ['tab-extract', 'panel-extract', 'tab-sites', 'panel-sites', 'groupForm', 'previewBox']) {
    assert.ok(!html.includes('id="' + gone + '"'), 'reste de l’ancienne interface : #' + gone);
  }
  assert.ok(!html.includes('role="tablist"'), 'plus d’onglets');

  // les modes proposés correspondent au moteur
  const modes = [...html.matchAll(/name="mode" value="([a-z]+)"/g)].map((match) => match[1]);
  assert.deepEqual(modes, ['last', 'first', 'longest', 'all', 'custom']);

  // la barre de progression est bien là, et accessible
  assert.match(html, /role="progressbar"/);
  assert.match(html, /id="fill"/);
  assert.match(css, /\.fill/, 'la barre est mise en forme');
  assert.match(css, /prefers-reduced-motion/, 'les animations peuvent être coupées');

  // aucune ressource externe : le site reste autonome
  for (const match of html.matchAll(/(?:src|href)="(https?:\/\/[^"]+)"/g)) {
    assert.fail('ressource externe chargée par la page : ' + match[1]);
  }
  for (const match of app.matchAll(/import\s+[^;]*from\s+['"]([^'"]+)['"]/g)) {
    assert.ok(match[1].startsWith('./') || match[1].startsWith('/'), 'import externe : ' + match[1]);
  }

  // noir et blanc : aucune couleur hors niveaux de gris
  const colors = [...css.matchAll(/#([0-9a-f]{3,8})\b/gi)].map((match) => match[1].toLowerCase());
  for (const color of colors) {
    const hex = color.length === 3 ? color.split('').map((c) => c + c).join('') : color;
    const [r, g, b] = [0, 2, 4].map((i) => Number.parseInt(hex.slice(i, i + 2), 16));
    assert.ok(Math.max(r, g, b) - Math.min(r, g, b) <= 8, 'couleur non grise : #' + color);
  }

  // aucun emoji dans l'interface
  const emoji = /[\u{1F000}-\u{1FAFF}\u{2600}-\u{27BF}\u{FE0F}\u{2B00}-\u{2BFF}]/u;
  for (const [name, source] of [['index.html', html], ['styles.css', css], ['app.js', app]]) {
    assert.ok(!emoji.test(source), 'emoji trouvé dans ' + name);
  }
});

test.after(() => {
  URL.createObjectURL = realCreateObjectURL;
});
