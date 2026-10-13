/*
 * zach-db — worker.
 * Travaille hors du thread principal : la page reste fluide même sur des
 * fichiers de plusieurs Go, et la mémoire reste bornée.
 *
 * Deux types de message :
 *   { type: 'group' }   tri par site — analyse (compteurs) ou valeurs ciblées
 *   { type: 'cancel' }  annulation en cours de lecture
 */
import { createGrouper } from './lib/group.js';

const CANCELLED = 'zach-db:cancelled';
const MAX_SITES_SENT = 20000; // au-delà, la liste complète reste côté worker
const LIVE_SITES = 400; // taille du top envoyé pendant le traitement
const TEXT_STEP = 512 * 1024; // texte d'un site envoyé par paquets

let cancelFlag = false;

function toList(grouper, max) {
  const order = grouper.order();
  const size = Math.min(order.length, max);
  const list = new Array(size);
  for (let i = 0; i < size; i++) {
    const entry = order[i];
    list[i] = { site: entry.site, count: entry.count, bytes: entry.bytes, truncated: entry.truncated };
  }
  return { list, total: order.length, truncated: order.length > size };
}

/* ---------- tri par site ---------- */

async function runGroup(message) {
  const { id, source, options, pass } = message;
  const started = Date.now();
  cancelFlag = false;

  const onlySite = pass.onlySite || null;
  const withText = !!onlySite && !pass.count;

  const grouper = createGrouper({
    mode: options.mode,
    regex: options.regex,
    hosts: options.hosts,
    dedupe: options.dedupe,
    stripSubdomains: options.stripSubdomains,
    onlySite,
    keepText: withText,
    maxTextBytes: withText ? pass.maxTextBytes || Infinity : 0,
  });

  let loaded = 0;
  let lastReport = 0;
  let sentText = 0;
  let sentSites = 0;

  const writer = new WritableStream({
    write(chunk) {
      if (cancelFlag) throw new Error(CANCELLED);
      loaded += chunk.length;
      grouper.pushBytes(chunk);
      const now = Date.now();
      if (now - lastReport < 200) return;
      lastReport = now;

      const stats = grouper.stats();
      const siteCount = grouper.sites().size;
      self.postMessage({
        type: 'progress', id, loaded, lines: stats.lines, matched: stats.matched,
        kept: stats.kept, dropped: stats.dropped, sites: siteCount,
      });

      if (!onlySite && siteCount !== sentSites) {
        sentSites = siteCount;
        const live = toList(grouper, LIVE_SITES);
        self.postMessage({ type: 'sites', id, sites: live.list, total: live.total, live: true });
      }
      if (withText) {
        const entry = grouper.site(onlySite);
        if (entry && entry.text.length - sentText >= TEXT_STEP) {
          self.postMessage({ type: 'chunk', id, data: entry.text.slice(sentText) });
          sentText = entry.text.length;
        }
      }
    },
  });

  try {
    await source.stream().pipeTo(writer);
    grouper.flush();

    const entry = onlySite ? grouper.site(onlySite) : null;
    if (entry && entry.text.length > sentText) {
      self.postMessage({ type: 'chunk', id, data: entry.text.slice(sentText) });
      sentText = entry.text.length;
    }
    if (!onlySite) {
      const full = toList(grouper, MAX_SITES_SENT);
      self.postMessage({ type: 'sites', id, sites: full.list, total: full.total, truncated: full.truncated, live: false });
    }

    const stats = grouper.stats();
    self.postMessage({
      type: 'done',
      id,
      count: !!pass.count,
      bytes: source.size,
      loaded,
      lines: stats.lines,
      matched: stats.matched,
      kept: stats.kept,
      skipped: stats.skipped,
      dropped: stats.dropped,
      outLines: entry ? entry.count : stats.kept,
      outChars: entry ? entry.bytes : stats.bytes,
      sites: grouper.sites().size,
      stored: grouper.storedBytes(),
      truncated: entry ? entry.truncated : false,
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
  if (data.type === 'group') runGroup(data);
  else if (data.type === 'cancel') cancelFlag = true;
};
