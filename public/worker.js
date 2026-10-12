/*
 * zach-db — worker.
 * Travaille hors du thread principal : l'onglet reste fluide même sur des
 * fichiers de plusieurs Go. La mémoire reste bornée car le résultat peut être
 * découpé en plusieurs passes (compter d'abord, collecter ensuite par tranches).
 */
import { createProcessor } from './lib/parse.js';

const CANCELLED = 'zach-db:cancelled';

let cancelFlag = false;

async function runPass(message) {
  const { id, source, options, pass } = message;
  const started = Date.now();
  cancelFlag = false;

  const processor = createProcessor({
    mode: options.mode,
    regex: options.regex,
    dedupe: options.dedupe,
    hosts: options.hosts,
    count: pass.count,
    skip: pass.skip,
    limit: pass.limit,
  });

  let loaded = 0;
  let lastReport = 0;

  const writer = new WritableStream({
    write(chunk) {
      if (cancelFlag) throw new Error(CANCELLED);
      loaded += chunk.length;
      const out = processor.pushBytes(chunk);
      if (out) self.postMessage({ type: 'chunk', id, data: out });
      const now = Date.now();
      if (now - lastReport >= 200) {
        lastReport = now;
        const stats = processor.stats();
        self.postMessage({
          type: 'progress', id, loaded, lines: stats.lines, matched: stats.matched,
        });
      }
    },
  });

  try {
    await source.stream().pipeTo(writer);
    const tail = processor.flush();
    if (tail) self.postMessage({ type: 'chunk', id, data: tail });
    const stats = processor.stats();
    self.postMessage({
      type: 'done',
      id,
      count: !!pass.count,
      bytes: source.size,
      loaded,
      lines: stats.lines,
      matched: stats.matched,
      outLines: stats.outLines,
      outChars: stats.outChars,
      emittedBytes: stats.emittedBytes,
      ms: Date.now() - started,
    });
  } catch (err) {
    const text = String((err && err.message) || err);
    if (text.includes(CANCELLED)) self.postMessage({ type: 'cancelled', id, ms: Date.now() - started });
    else self.postMessage({ type: 'error', id, message: text });
  }
}

self.onmessage = (event) => {
  const data = event.data || {};
  if (data.type === 'pass') runPass(data);
  else if (data.type === 'cancel') cancelFlag = true;
};
