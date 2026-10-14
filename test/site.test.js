/*
 * Teste le serveur HTTP de bout en bout (site + API), avec un dossier
 * ZACH_DB_DIR temporaire pour les modes dir/paths.
 */
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import http from 'node:http';
import zlib from 'node:zlib';
import { once } from 'node:events';

const DATA_DIR = fs.mkdtempSync(path.join(os.tmpdir(), 'zach-db-test-'));
fs.writeFileSync(path.join(DATA_DIR, 'sample1.txt'),
  '[https://www.roblox.com/tr/CreateAccount:Thou_miriba:N2Z6PQXg4XLnTSi](x)1111\nhttps://site.com:443/a:user1:pass1\n');
fs.writeFileSync(path.join(DATA_DIR, 'sample2.txt'), 'alpha:beta42\n');

process.env.ZACH_DB_DIR = DATA_DIR;
const { createServer } = await import('../server.js');

const server = createServer();
await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
const base = 'http://127.0.0.1:' + server.address().port;

test.after(() => {
  server.close();
  fs.rmSync(DATA_DIR, { recursive: true, force: true });
});

test('le site et ses ressources sont servis', async () => {
  const page = await fetch(base + '/');
  assert.equal(page.status, 200);
  assert.match(page.headers.get('content-type'), /text\/html/);
  const html = await page.text();
  assert.match(html, /zach-db/);
  assert.match(html, /<html lang="en">/);

  for (const [file, type] of [
    ['/styles.css', /text\/css/],
    ['/app.js', /javascript/],
    ['/worker.js', /javascript/],
    ['/lib/parse.js', /javascript/],
  ]) {
    const response = await fetch(base + file);
    assert.equal(response.status, 200, file);
    assert.match(response.headers.get('content-type'), type, file);
    assert.ok((await response.text()).length > 0, file);
  }

  // les identifiants d'éléments utilisés par app.js existent dans la page
  const app = await (await fetch(base + '/app.js')).text();
  const ids = [...app.matchAll(/el\('([^']+)'\)/g)].map((match) => match[1]);
  assert.ok(ids.length >= 5, 'ids trouvés : ' + ids.join(', '));
  for (const id of new Set(ids)) {
    assert.ok(html.includes('id="' + id + '"'), 'élément #' + id + ' absent de index.html');
  }

  // les modes proposés dans la page correspondent au moteur
  const { MODES } = await import('../public/lib/parse.js');
  const values = [...html.matchAll(/name="gmode" value="([a-z]+)"/g)].map((match) => match[1]);
  assert.deepEqual(values, MODES);
});

test('api : corps brut, modes et dédoublonnage', async () => {
  const sample = '[https://www.roblox.com/tr/CreateAccount:Thou_miriba:N2Z6PQXg4XLnTSi](https://www.roblox.com/tr/CreateAccount:Thou_miriba:N2Z6PQXg4XLnTSi)1111\n';
  const response = await fetch(base + '/api/extract', { method: 'POST', body: sample });
  assert.equal(response.status, 200);
  assert.match(response.headers.get('content-disposition'), /attachment; filename="zach-db-extract.txt"/);
  assert.equal(await response.text(), 'Thou_miriba:N2Z6PQXg4XLnTSi\n');

  const all = await fetch(base + '/api/extract?mode=all&dedupe=1&name=r.txt', { method: 'POST', body: 'a:b c:d\na:b\n' });
  assert.equal(await all.text(), 'a:b\nc:d\n');
  assert.match(all.headers.get('content-disposition'), /filename="r.txt"/);

  const hosts = await fetch(base + '/api/extract?hosts=1', { method: 'POST', body: 'https://monsite.com:8080/x\n' });
  assert.equal(await hosts.text(), 'monsite.com:8080\n');
});

test('api : gzip quand le client l’accepte', async () => {
  const body = 'a:b\n'.repeat(500);
  const headers = await new Promise((resolve, reject) => {
    const request = http.request(base + '/api/extract', { method: 'POST', headers: { 'accept-encoding': 'gzip' } },
      (response) => {
        assert.equal(response.headers['content-encoding'], 'gzip');
        resolve(response);
      });
    request.on('error', reject);
    request.end(body);
  });
  const chunks = [];
  for await (const chunk of headers.pipe(zlib.createGunzip())) chunks.push(chunk);
  assert.equal(Buffer.concat(chunks).toString(), 'a:b\n'.repeat(500));
});

test('api : lecture d’un dossier du serveur', async () => {
  const all = await fetch(base + '/api/extract?dir=/');
  assert.equal(all.status, 200);
  assert.equal(await all.text(), 'Thou_miriba:N2Z6PQXg4XLnTSi\nuser1:pass1\nalpha:beta42\n');

  const one = await fetch(base + '/api/extract?dir=/&paths=1', { method: 'POST', body: 'sample2.txt\n' });
  assert.equal(await one.text(), 'alpha:beta42\n');

  const sub = await fetch(base + '/api/extract?dir=/&paths=1', { method: 'POST', body: 'sub/x.txt' });
  assert.equal(sub.status, 400);
  assert.match((await sub.json()).error, /Invalid filename/);
});

test('api : erreurs propres', async () => {
  const mode = await fetch(base + '/api/extract?mode=nope', { method: 'POST', body: 'a:b' });
  assert.equal(mode.status, 400);
  assert.match((await mode.json()).error, /Unknown mode/);

  const traversal = await fetch(base + '/api/extract?dir=/../');
  assert.equal(traversal.status, 400);
  assert.match((await traversal.json()).error, /outside the allowed directory/);

  const method = await fetch(base + '/api/extract');
  assert.equal(method.status, 405);

  const missing = await fetch(base + '/rien');
  assert.equal(missing.status, 404);

  const health = await fetch(base + '/api/health');
  assert.equal(health.status, 200);
  assert.equal((await health.json()).ok, true);
});

test('api : gros corps envoyé en flux', async () => {
  const lines = 200000;
  const text = Array.from({ length: lines }, (_, i) => 'https://x.com/a/b:user' + i + ':pass' + i).join('\n') + '\n';
  const response = await fetch(base + '/api/extract', { method: 'POST', body: text });
  assert.equal(response.status, 200);
  const out = await response.text();
  const outLines = out.split('\n');
  assert.equal(outLines.length, lines + 1);
  assert.equal(outLines[0], 'user0:pass0');
  assert.equal(outLines[lines - 1], 'user' + (lines - 1) + ':pass' + (lines - 1));
});

/* ---------- API de tri par site ---------- */

test('api group : liste des sites (JSON, TSV, exact)', async () => {
  const body = [
    'https://www.roblox.com/tr/CreateAccount:Thou_miriba:N2Z6PQXg4XLnTSi',
    'http://www.netflix.com/browse/login:user1:pass1',
    'https://account.roblox.com/login:user2:pass2',
    'https://monsite.com:443/a:user4:pass4',
  ].join('\n') + '\n';

  const json = await (await fetch(base + '/api/group', { method: 'POST', body })).json();
  assert.equal(json.total, 3);
  assert.equal(json.truncated, false);
  const byName = new Map(json.sites.map((entry) => [entry.site, entry]));
  assert.equal(byName.get('roblox.com').count, 2);
  assert.equal(byName.get('netflix.com').count, 1);
  assert.deepEqual(json.sites.map((entry) => entry.site), ['roblox.com', 'monsite.com', 'netflix.com']);
  assert.equal(json.stats.kept, 4);

  const tsv = await fetch(base + '/api/group?format=tsv', { method: 'POST', body });
  assert.equal(tsv.headers.get('content-type'), 'text/plain; charset=utf-8');
  assert.equal(await tsv.text(), 'roblox.com\t2\t40\nmonsite.com\t1\t12\nnetflix.com\t1\t12\n');

  const exact = await (await fetch(base + '/api/group?subdomains=0', { method: 'POST', body })).json();
  assert.deepEqual([...exact.sites.map((entry) => entry.site)].sort(),
    ['account.roblox.com', 'monsite.com', 'www.netflix.com', 'www.roblox.com']);
});

test('api group : un site, en texte et en ndjson', async () => {
  const body = [
    'https://www.roblox.com/a:x1:y1',
    'https://www.netflix.com/b:x2:y2',
    'https://account.roblox.com/c:x3:y3',
  ].join('\n') + '\n';

  const response = await fetch(base + '/api/group?site=roblox.com', { method: 'POST', body });
  assert.equal(response.status, 200);
  assert.equal(response.headers.get('content-type'), 'text/plain; charset=utf-8');
  assert.match(response.headers.get('content-disposition'), /zach-db-roblox.com.txt/);
  assert.equal(await response.text(), 'x1:y1\nx3:y3\n');

  const ndjson = await (await fetch(base + '/api/group?site=roblox.com&format=ndjson', { method: 'POST', body })).text();
  assert.equal(ndjson, '"x1:y1"\n"x3:y3"\n');

  const none = await fetch(base + '/api/group?site=spotify.com', { method: 'POST', body });
  assert.equal(none.status, 200);
  assert.equal(await none.text(), '');

  // /api/extract?group=1 fonctionne aussi
  const alias = await (await fetch(base + '/api/extract?group=1&site=netflix.com', { method: 'POST', body })).text();
  assert.equal(alias, 'x2:y2\n');
});

test('api group : dossier du serveur et erreurs', async () => {
  const liste = await fetch(base + '/api/group?dir=/');
  assert.equal(liste.status, 200);
  const payload = await liste.json();
  // sample2.txt ("alpha:beta42") n'a pas d'URL → bucket "(sans site)"
  assert.deepEqual([...payload.sites.map((entry) => entry.site)].sort(),
    ['(sans site)', 'roblox.com', 'site.com']);

  const one = await fetch(base + '/api/group?dir=/&paths=1&site=site.com', { method: 'POST', body: 'sample1.txt\n' });
  assert.equal(await one.text(), 'user1:pass1\n');

  const bad = await fetch(base + '/api/group?dir=/../');
  assert.equal(bad.status, 400);
  assert.match((await bad.json()).error, /outside the allowed directory/);
});

test('api group : gros corps en flux', async () => {
  const lines = 100000;
  const sites = ['roblox.com', 'netflix.com', 'spotify.com'];
  const text = Array.from({ length: lines }, (_, i) =>
    'https://www.' + sites[i % sites.length] + '/x:user' + i + ':pass' + i).join('\n') + '\n';

  const payload = await (await fetch(base + '/api/group', { method: 'POST', body: text })).json();
  assert.equal(payload.total, 3);
  let total = 0;
  for (const entry of payload.sites) {
    assert.ok(entry.count >= Math.floor(lines / 3), entry.site + ' : ' + entry.count);
    total += entry.count;
  }
  assert.equal(total, lines, 'aucune valeur perdue');

  const started = Date.now();
  const response = await fetch(base + '/api/group?site=netflix.com', { method: 'POST', body: text });
  const out = await response.text();
  assert.equal(out.split('\n').filter(Boolean).length, 33333);
  assert.ok(Date.now() - started < 30000);
  assert.match(out.split('\n')[0], /^user\d+:pass\d+$/);
});
