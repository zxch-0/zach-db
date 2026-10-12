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
  const values = [...html.matchAll(/name="mode" value="([a-z]+)"/g)].map((match) => match[1]);
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
  assert.match((await sub.json()).error, /invalide/);
});

test('api : erreurs propres', async () => {
  const mode = await fetch(base + '/api/extract?mode=nope', { method: 'POST', body: 'a:b' });
  assert.equal(mode.status, 400);
  assert.match((await mode.json()).error, /mode inconnu/);

  const traversal = await fetch(base + '/api/extract?dir=/../');
  assert.equal(traversal.status, 400);
  assert.match((await traversal.json()).error, /hors du dossier/);

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
