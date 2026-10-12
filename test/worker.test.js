/*
 * Teste le worker du navigateur dans Node, avec un faux `self`
 * (postMessage / onmessage), pour vérifier le protocole utilisé par app.js :
 * passes de comptage, passes de collecte (skip/limit), annulation.
 */
import test from 'node:test';
import assert from 'node:assert/strict';
import { extract } from '../public/lib/parse.js';

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

/** Démarre une passe dans une nouvelle instance du worker. */
async function startPass({ source, options = {}, pass = {} }) {
  const id = ++instances;
  const messages = [];
  let finish = null;
  const done = new Promise((resolve) => {
    finish = resolve;
  });
  let send = null;

  globalThis.self = {
    postMessage(message) {
      messages.push(message);
      if (message.type === 'done' || message.type === 'error' || message.type === 'cancelled') finish(message);
    },
    onmessage: null,
  };

  await import('../public/worker.js?case=' + id);
  send = (data) => globalThis.self.onmessage({ data });
  send({
    type: 'pass',
    id,
    source,
    options: { mode: 'last', ...options },
    pass: { count: false, skip: 0, limit: Infinity, ...pass },
  });

  const result = await done;
  return {
    result,
    messages,
    cancel: () => send({ type: 'cancel' }),
    chunks: messages.filter((message) => message.type === 'chunk').map((message) => message.data).join(''),
  };
}

const LINES = 20000;
const TEXT = Array.from(
  { length: LINES },
  (_, i) => '[https://www.roblox.com/tr/CreateAccount:Thou_miriba:N2Z6PQXg4XLnTSi](x)1111' + i
).join('\n');

test('worker : extraction simple, mêmes résultats que le moteur', async () => {
  const run = await startPass({ source: sourceFrom(TEXT.length > 0 ? TEXT : 'a:b', 1 << 16) });
  assert.equal(run.result.type, 'done');
  assert.equal(run.chunks, extract(TEXT));
  assert.equal(run.result.lines, LINES);
  assert.equal(run.result.matched, LINES);
  assert.equal(run.result.outChars, run.chunks.length);
  assert.equal(run.result.bytes, Buffer.byteLength(TEXT));
});

test('worker : passe de comptage puis deux passes de collecte (comme le navigateur)', async () => {
  const text = Array.from({ length: 3000 }, (_, i) => 'x:user' + i + ':pass' + i).join('\n') + '\n';
  const source = sourceFrom(text, 4096);

  const counted = await startPass({ source, pass: { count: true } });
  assert.equal(counted.result.type, 'done');
  assert.equal(counted.chunks, '', 'une passe de comptage ne transfère aucun texte');
  assert.equal(counted.result.outChars, extract(text).length);

  const half = Math.ceil(counted.result.outChars / 2);
  const first = await startPass({ source, pass: { skip: 0, limit: half } });
  const second = await startPass({ source, pass: { skip: first.result.emittedBytes, limit: half } });
  assert.equal(first.chunks + second.chunks, extract(text), 'les deux tranches recollées = la sortie complète');
});

test('worker : dédoublonnage', async () => {
  const text = 'a:b\nc:d\na:b\n';
  const run = await startPass({ source: sourceFrom(text), options: { dedupe: true } });
  assert.equal(run.chunks, 'a:b\nc:d\n');
});

test('worker : annulation en cours de lecture', async () => {
  const big = Array.from({ length: 50000 }, (_, i) => 'x:user' + i + ':pass' + i).join('\n');
  const source = sourceFrom(big, 1 << 12, 1); // 4 Ko par lecture, avec une pause

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
  send({ type: 'pass', id, source, options: { mode: 'last' }, pass: { count: false, skip: 0, limit: Infinity } });

  while (!messages.some((message) => message.type === 'chunk')) {
    await new Promise((resolve) => setTimeout(resolve, 1));
  }
  send({ type: 'cancel' });
  const result = await done;
  assert.equal(result.type, 'cancelled');
  assert.equal(messages.some((message) => message.type === 'done'), false);
});
