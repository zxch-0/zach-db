/*
 * Teste le worker du navigateur dans Node, avec un faux `self`
 * (postMessage / onmessage), pour vérifier le protocole utilisé par app.js :
 * analyse (compteurs par site), valeurs ciblées d'un site, annulation.
 */
import test from 'node:test';
import assert from 'node:assert/strict';

let instances = 0;

/** Source compatible avec le worker : { size, stream() }. */
function sourceFrom(text, chunkSize = 1 << 20, delay = 0) {
  const bytes = Buffer.from(text, 'utf8');
  return {
    size: bytes.length,
    // Comme un File du navigateur : chaque appel à stream() repart du début,
    // ce dont dépendent les passes multiples.
    stream() {
      let offset = 0;
      return new ReadableStream({
        async pull(controller) {
          if (offset >= bytes.length) return controller.close();
          if (delay) await new Promise((resolve) => setTimeout(resolve, delay));
          controller.enqueue(new Uint8Array(bytes.subarray(offset, offset + chunkSize)));
          offset += chunkSize;
          return undefined;
        },
      });
    },
  };
}

const SITES_TEXT = [
  'https://www.roblox.com/tr/CreateAccount:Thou_miriba:N2Z6PQXg4XLnTSi',
  'http://www.netflix.com/browse/login:user1:pass1',
  'https://account.roblox.com/login:user2:pass2',
  'https://monsite.com:443/a:user4:pass4',
].join('\n') + '\n';

/** Démarre une passe de groupement dans une nouvelle instance du worker. */
async function startGroup({ source, options = {}, pass = {} }) {
  const id = ++instances;
  const messages = [];
  let finish = null;
  const done = new Promise((resolve) => {
    finish = resolve;
  });

  globalThis.self = {
    postMessage(message) {
      messages.push(message);
      if (message.type === 'done' || message.type === 'error' || message.type === 'cancelled') finish(message);
    },
    onmessage: null,
  };

  await import('../public/worker.js?case=' + id);
  globalThis.self.onmessage({
    data: {
      type: 'group',
      id,
      source,
      options: { mode: 'last', stripSubdomains: true, ...options },
      pass: { count: false, maxTextBytes: Infinity, ...pass },
    },
  });

  const result = await done;
  return {
    result,
    messages,
    chunks: messages.filter((message) => message.type === 'chunk').map((message) => message.data).join(''),
    lastSites: messages.filter((message) => message.type === 'sites').pop() || null,
  };
}

test('worker group : la liste des sites arrive pendant et à la fin', async () => {
  const run = await startGroup({ source: sourceFrom(SITES_TEXT, 128), pass: { count: true, maxTextBytes: 0 } });
  assert.equal(run.result.type, 'done');
  assert.equal(run.chunks, '', 'une passe de comptage ne transfère aucun texte');

  const final = run.lastSites;
  assert.equal(final.live, false);
  assert.equal(final.total, 3);
  const byName = new Map(final.sites.map((entry) => [entry.site, entry]));
  assert.equal(byName.get('roblox.com').count, 2);
  assert.equal(byName.get('netflix.com').count, 1);
  assert.equal(byName.get('monsite.com').count, 1);
  assert.ok(final.sites[0].bytes >= final.sites[1].bytes, 'trié du plus gros au plus petit');
  assert.equal(run.result.sites, 3);
  assert.equal(run.result.kept, 4);
});

test('worker group : les valeurs d’un seul site sont diffusées', async () => {
  const run = await startGroup({ source: sourceFrom(SITES_TEXT, 64), pass: { onlySite: 'roblox.com' } });
  assert.equal(run.result.type, 'done');
  assert.equal(run.chunks, 'Thou_miriba:N2Z6PQXg4XLnTSi\nuser2:pass2\n');
  assert.equal(run.result.outLines, 2);
  assert.equal(run.result.outChars, run.chunks.length);
  assert.equal(run.lastSites, null, 'pas de liste de sites en passe ciblée');
});

test('worker group : dédoublonnage par site', async () => {
  const text = 'https://a.com/x:u1:p1\nhttps://b.com/x:u1:p1\nhttps://a.com/y:u1:p1\n';
  const run = await startGroup({ source: sourceFrom(text), options: { dedupe: true }, pass: { onlySite: 'a.com' } });
  assert.equal(run.chunks, 'u1:p1\n');
  assert.equal(run.result.outLines, 1);
});

test('worker group : annulation', async () => {
  const big = Array.from({ length: 40000 }, (_, i) => 'https://www.roblox.com/x:user' + i + ':pass' + i).join('\n');
  const id = ++instances;
  const messages = [];
  let finish = null;
  const done = new Promise((resolve) => {
    finish = resolve;
  });
  globalThis.self = {
    postMessage(message) {
      messages.push(message);
      if (message.type === 'done' || message.type === 'cancelled' || message.type === 'error') finish(message);
    },
    onmessage: null,
  };
  await import('../public/worker.js?case=' + id);
  const send = (data) => globalThis.self.onmessage({ data });
  send({
    type: 'group', id, source: sourceFrom(big, 4096, 1),
    options: { mode: 'last' }, pass: { count: true },
  });
  while (!messages.some((message) => message.type === 'progress')) {
    await new Promise((resolve) => setTimeout(resolve, 1));
  }
  send({ type: 'cancel' });
  const result = await done;
  assert.equal(result.type, 'cancelled');
  assert.equal(messages.some((message) => message.type === 'done'), false);
});
