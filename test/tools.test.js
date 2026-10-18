/*
 * Le registre des outils (public/lib/tools.js) est la source de vérité du site :
 * l'accueil affiche une carte par outil, l'en-tête un sélecteur sur chaque page,
 * et GET /api/tools renvoie la même liste. Ce test vérifie que tout cela est
 * cohérent, pour qu'ajouter un outil ne puisse pas casser le hub en silence.
 */
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { TOOLS, STATUS, availableTools, findToolById, findToolByPath, normalizePath }
  from '../public/lib/tools.js';

const ROOT = path.join(path.dirname(fileURLToPath(import.meta.url)), '..');
const read = (file) => fs.readFileSync(path.join(ROOT, file), 'utf8');

const home = read('public/index.html');
const chrome = read('public/chrome.js');
const pages = (tool) => ['public/index.html', 'public/tools/' + tool.id + '/index.html'];

test('registre : au moins un outil, champs complets et identifiants uniques', () => {
  assert.ok(TOOLS.length >= 1, 'le registre est vide');
  assert.ok(availableTools().length >= 1, 'aucun outil disponible');

  const ids = new Set();
  const paths = new Set();
  for (const tool of TOOLS) {
    assert.match(tool.id, /^[a-z0-9][a-z0-9-]*$/, 'id invalide : ' + tool.id);
    assert.ok(!ids.has(tool.id), 'id en double : ' + tool.id);
    ids.add(tool.id);

    assert.ok(!paths.has(tool.path), 'chemin en double : ' + tool.path);
    paths.add(tool.path);
    assert.equal(tool.path, '/tools/' + tool.id + '/', 'le chemin suit public/tools/<id>/');

    assert.ok(STATUS.includes(tool.status), 'statut inconnu : ' + tool.status);
    for (const field of ['name', 'short', 'tagline', 'description', 'input', 'output', 'api', 'cli']) {
      assert.equal(typeof tool[field], 'string', field + ' manquant pour ' + tool.id);
      assert.ok(tool[field].trim().length > 0, field + ' vide pour ' + tool.id);
    }
    assert.match(tool.api, /^\/api\//, 'route API invalide pour ' + tool.id);
    assert.ok(Array.isArray(tool.tags) && tool.tags.length > 0, 'tags manquants pour ' + tool.id);
    assert.ok(Array.isArray(tool.points) && tool.points.length > 0, 'points manquants pour ' + tool.id);
  }
});

test('registre : la page de chaque outil disponible existe', () => {
  for (const tool of availableTools()) {
    const file = path.join(ROOT, 'public', tool.path.replace(/^\/|\/$/g, ''), 'index.html');
    assert.ok(fs.existsSync(file), 'page manquante : ' + file);
    const text = fs.readFileSync(file, 'utf8');
    assert.match(text, /<html lang="en">/, tool.id + ' : langue absente');
    assert.match(text, /id="toolSwitcherBtn"/, tool.id + ' : sélecteur d’outil absent');
    assert.match(text, /href="\/"/, tool.id + ' : aucun retour à l’accueil');
  }
});

/* Le menu déroulant de l'en-tête, et tout ce qui se trouve en dehors. */
function splitMenu(text, page) {
  const id = text.indexOf('id="toolSwitcher"');
  assert.ok(id > -1, 'sélecteur d’outil absent de ' + page);
  const start = text.lastIndexOf('<details', id); // la classe « has-current » est sur la balise
  assert.ok(start > -1, 'sélecteur sans <details> dans ' + page);
  const end = text.indexOf('</details>', start);
  assert.ok(end > start, 'sélecteur mal fermé dans ' + page);
  return { block: text.slice(start, end), outside: text.slice(0, start) + text.slice(end + 10) };
}

const HOME = 'public/index.html';
const toolPage = (tool) => 'public/tools/' + tool.id + '/index.html';
const pagePath = (page) => (page === HOME ? '/' : '/' + page.replace(/^public\//, '').replace(/index\.html$/, ''));

test('accueil : aucune citation d’outil en dehors du menu déroulant', () => {
  const { block, outside } = splitMenu(home, HOME);

  for (const tool of TOOLS) {
    // le menu propose bien l'outil…
    assert.ok(block.includes('href="' + tool.path + '"'), 'outil absent du menu : ' + tool.id);
    assert.ok(block.includes(tool.name), 'nom absent du menu : ' + tool.id);
    // …et rien d'autre sur la page n'en parle
    for (const citation of [tool.path, tool.name, tool.short, tool.id, tool.api, tool.cli]) {
      assert.ok(!outside.includes(citation), 'l’accueil cite l’outil hors du menu : ' + citation);
    }
  }

  // l'accueil est une vitrine : aucun traitement, aucun bouton plein, aucun chiffre d'outil
  assert.ok(!home.includes('id="groupForm"'), 'l’accueil ne traite rien');
  assert.ok(!home.includes('btn-solid'), 'aucun bouton plein sur l’accueil');
  assert.ok(!home.includes('data-tool='), 'plus de carte d’outil sur l’accueil');
  assert.match(home, /id="signal"/, 'oscilloscope présent');
  assert.match(home, /id="voidCanvas"/, 'fond animé présent');
  assert.match(home, /<script src="\/home.js" type="module">/, 'moteur visuel chargé par l’accueil');
});

test('le menu déroulant recopie le registre, sur chaque page', () => {
  const pages = [HOME, ...TOOLS.map(toolPage)];
  for (const page of pages) {
    const text = read(page);
    const { block } = splitMenu(text, page);

    // accueil d'abord, puis chaque outil dans l'ordre du registre
    const hrefs = [...block.matchAll(/class="tool-item"[^>]*href="([^"]+)"/g)].map((m) => m[1]);
    assert.deepEqual(hrefs, ['/', ...TOOLS.map((tool) => tool.path)], 'menu de ' + page);

    for (const tool of TOOLS) {
      assert.ok(block.includes(tool.name), 'nom manquant dans le menu de ' + page);
      assert.ok(block.includes(tool.tagline), 'accroche manquante dans le menu de ' + page);
    }
    assert.ok(block.includes('<b>' + availableTools().length + ' online</b>'),
      'compte d’outils en ligne faux dans ' + page);

    // une seule entrée courante : la page elle-même
    const current = [...block.matchAll(/href="([^"]+)"[^>]*aria-current="page"/g)].map((m) => m[1]);
    assert.deepEqual(current, [pagePath(page)], 'entrée courante du menu de ' + page);
    assert.equal(block.split('has-current').length - 1, page === HOME ? 0 : 1,
      'le sélecteur ne passe en négatif que sur une page d’outil (' + page + ')');
  }

  // chrome.js retrouve l'outil courant depuis le registre, pour nommer le sélecteur
  assert.match(chrome, /from '\.\/lib\/tools\.js'/, 'chrome.js n’importe pas le registre');
  assert.match(chrome, /findToolByPath/, 'chrome.js ne retrouve pas l’outil courant');
});

test('recherche par chemin et par identifiant', () => {
  assert.equal(normalizePath('/tools/group-by-site'), '/tools/group-by-site/');
  assert.equal(normalizePath('/'), '/');
  assert.equal(normalizePath(''), '/');

  const tool = TOOLS[0];
  assert.equal(findToolById(tool.id), tool);
  assert.equal(findToolById('nope'), null);
  assert.equal(findToolByPath(tool.path), tool);
  assert.equal(findToolByPath(tool.path.replace(/\/$/, '')), tool, 'chemin sans slash final');
  assert.equal(findToolByPath('/'), null, 'l’accueil n’est pas un outil');
  assert.equal(findToolByPath('/tools/inconnu/'), null);
});
