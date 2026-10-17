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

test('accueil : une carte par outil, avec son lien et son statut', () => {
  for (const tool of TOOLS) {
    const start = home.indexOf('data-tool="' + tool.id + '"');
    assert.ok(start > -1, 'carte absente de l’accueil pour ' + tool.id);
    const card = home.slice(start, home.indexOf('</article>', start));
    assert.ok(card.includes(tool.name), 'nom absent de la carte ' + tool.id);
    if (tool.status === 'available') {
      assert.ok(card.includes('href="' + tool.path + '"'), 'lien absent de la carte ' + tool.id);
      assert.ok(card.includes('badge-on'), 'badge « available » absent de la carte ' + tool.id);
      for (const point of tool.points) {
        assert.ok(card.includes(point), 'point manquant dans la carte ' + tool.id + ' : ' + point);
      }
    } else {
      assert.ok(card.includes('badge-soon'), 'badge « soon » absent de la carte ' + tool.id);
    }
  }

  // l'accueil ne contient pas l'outil lui-même : c'est le rôle de sa page
  assert.ok(!home.includes('id="groupForm"'), 'l’accueil ne doit pas embarquer le traitement');
  assert.match(home, /id="tools"/, 'section #tools absente de l’accueil');
  assert.match(home, /<script src="\/chrome\.js" type="module">/, 'habillage non chargé par l’accueil');
});

test('le sélecteur d’outil est construit depuis le registre', () => {
  assert.match(chrome, /from '\.\/lib\/tools\.js'/, 'chrome.js n’importe pas le registre');
  assert.match(chrome, /TOOLS/, 'chrome.js n’utilise pas la liste des outils');
  assert.match(chrome, /findToolByPath/, 'chrome.js ne retrouve pas l’outil courant');
  // chaque page du site porte le sélecteur
  for (const tool of TOOLS) {
    for (const page of pages(tool)) {
      assert.match(read(page), /id="toolMenu"/, 'menu absent de ' + page);
    }
  }
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
