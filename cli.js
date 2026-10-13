#!/usr/bin/env node
/*
 * zach-db — ligne de commande (fichiers de n'importe quelle taille, mémoire constante).
 *
 *   node cli.js gros.txt -o sortie.txt --mode=last --dedupe
 *   node cli.js dossier/*.txt -o sortie.txt --mode=first
 *   zcat gros.txt.gz | node cli.js --mode=last > sortie.txt
 *
 * Tri par site :
 *   node cli.js gros.txt --group                       # liste site + compteurs
 *   node cli.js gros.txt --group --json                # la même en JSON
 *   node cli.js gros.txt --group --site=roblox.com -o roblox.txt
 *   node cli.js gros.txt --group --split=dossier/      # un .txt par site
 *
 * Options : -o/--out, --mode, --regex, --dedupe, --stats, --group, --site,
 *           --split, --json, --exact, --keep-hosts, --help
 */
import fs from 'node:fs';
import fsp from 'node:fs/promises';
import path from 'node:path';
import { once } from 'node:events';
import zlib from 'node:zlib';
import { createProcessor, MODES } from './public/lib/parse.js';
import { createGrouper, NO_SITE } from './public/lib/group.js';

function usage() {
  process.stdout.write(`zach-db — extrait les morceaux "xxxx:xxxx" de gros fichiers texte

usage : node cli.js [fichiers...] [options]

options :
  -o, --out <fichier>   fichier de sortie (défaut : stdout)
      --mode <mode>     last (défaut) | first | longest | all | custom
      --regex <regex>   regex perso, premier groupe capturant = valeur gardée
      --dedupe          supprime les doublons
      --keep-hosts      garde aussi les faux couples "domaine.tld:port"
      --stats           affiche les compteurs sur la sortie d'erreur
  -h, --help            cette aide

tri par site :
      --group           ne sort pas les valeurs : liste les sites trouvés
      --json            avec --group : liste en JSON
      --site <nom>      ne sort que les valeurs d'un site (roblox.com…)
      --split <dossier> écrit un fichier .txt par site dans <dossier>
      --exact           garde l'hôte exact (www. inclus, sous-domaines
                        non regroupés)

entrées : fichiers .txt / .log / .csv / .gz, ou stdin (rien à lire = stdin)
`);
}

function parseArgs(argv) {
  const options = {
    mode: 'last', regex: '', dedupe: false, hosts: false, out: null, stats: false,
    group: false, json: false, exact: false, site: null, split: null, inputs: [],
  };
  for (let i = 0; i < argv.length; i++) {
    const arg = argv[i];
    if (arg === '-h' || arg === '--help') options.help = true;
    else if (arg === '-o' || arg === '--out') options.out = argv[++i];
    else if (arg.startsWith('--out=')) options.out = arg.slice(6);
    else if (arg === '--mode') options.mode = argv[++i];
    else if (arg.startsWith('--mode=')) options.mode = arg.slice(7);
    else if (arg === '--regex') options.regex = argv[++i];
    else if (arg.startsWith('--regex=')) options.regex = arg.slice(8);
    else if (arg === '--dedupe') options.dedupe = true;
    else if (arg === '--keep-hosts') options.hosts = true;
    else if (arg === '--group') options.group = true;
    else if (arg === '--json') options.json = true;
    else if (arg === '--exact') options.exact = true;
    else if (arg === '--site') options.site = argv[++i];
    else if (arg.startsWith('--site=')) options.site = arg.slice(7);
    else if (arg === '--split') options.split = argv[++i];
    else if (arg.startsWith('--split=')) options.split = arg.slice(8);
    else if (arg === '--stats') options.stats = true;
    else if (arg.startsWith('-') && arg !== '-') throw new Error('option inconnue : ' + arg);
    else options.inputs.push(arg);
  }
  if (!MODES.includes(options.mode)) throw new Error('mode inconnu : ' + options.mode + ' (' + MODES.join(', ') + ')');
  return options;
}

function siteFileName(site) {
  const base = site === NO_SITE ? 'sans-site' : site.replace(/[^A-Za-z0-9._-]+/g, '_');
  return base.slice(0, 100) + '.txt';
}

/** Un fichier par site, écrit au fil de l'eau (cache de descripteurs borné). */
function createSplitWriter(dir, cap = 128) {
  const streams = new Map(); // fichier → flux (ordre d'insertion = LRU)
  const pending = new Map(); // site → morceaux en attente

  async function streamFor(site) {
    const name = siteFileName(site);
    let stream = streams.get(name);
    if (stream) {
      streams.delete(name); // remis en tête (LRU)
      streams.set(name, stream);
      return stream;
    }
    if (streams.size >= cap) {
      const [oldestName, oldest] = streams.entries().next().value;
      streams.delete(oldestName);
      await new Promise((resolve) => oldest.end(resolve));
    }
    const file = path.join(dir, name);
    await fsp.rm(file, { force: true });
    stream = fs.createWriteStream(file, { flags: 'a', highWaterMark: 1 << 20 });
    streams.set(name, stream);
    return stream;
  }

  return {
    value(site, text) {
      let list = pending.get(site);
      if (!list) pending.set(site, (list = []));
      list.push(text, '\n');
    },
    /** À appeler après chaque bloc lu : écrit tout ce qui est en attente. */
    async flushPending() {
      for (const [site, list] of pending) {
        if (list.length === 0) continue;
        const text = list.join('');
        list.length = 0;
        const stream = await streamFor(site);
        if (!stream.write(text)) await once(stream, 'drain');
      }
    },
    async closeAll() {
      for (const stream of streams.values()) {
        await new Promise((resolve) => stream.end(resolve));
      }
      streams.clear();
    },
    get files() {
      return streams.size;
    },
  };
}

/* ---------- tri par site ---------- */

async function groupMain(options) {
  if (options.split) await fsp.mkdir(options.split, { recursive: true });
  const split = options.split ? createSplitWriter(options.split) : null;
  const grouper = createGrouper({
    mode: options.mode,
    regex: options.regex,
    dedupe: options.dedupe,
    hosts: options.hosts,
    stripSubdomains: !options.exact,
    onlySite: split ? null : options.site || null,
    keepText: !split && Boolean(options.site),
    onValue: split ? (site, text) => split.value(site, text) : undefined,
  });

  const sources = options.inputs.length ? options.inputs : ['-'];
  const started = Date.now();
  let bytesIn = 0;

  for (const file of sources) {
    const stream = file === '-' ? process.stdin : readFile(file);
    for await (const chunk of stream) {
      bytesIn += chunk.length;
      grouper.pushBytes(chunk);
      if (split) await split.flushPending();
    }
    grouper.push('\n');
    if (split) await split.flushPending();
  }
  grouper.flush();
  if (split) {
    await split.flushPending();
    await split.closeAll();
  }

  const stats = grouper.stats();
  const seconds = (Date.now() - started) / 1000;

  if (options.site) {
    const entry = grouper.site(String(options.site).toLowerCase());
    const text = entry ? entry.text : '';
    if (options.out) await fsp.writeFile(options.out, text);
    else if (text) await new Promise((resolve) => process.stdout.write(text, resolve));
    process.stderr.write(
      'site : ' + options.site + '\n' +
      'lignes : ' + (entry ? entry.count : 0) + ' (' + (entry ? entry.bytes : 0) + ' octets)\n' +
      (options.out ? 'écrit : ' + path.resolve(options.out) + '\n' : '') +
      (entry && entry.truncated ? 'attention : sortie conservée partiellement (mémoire)\n' : '')
    );
    return;
  }

  const list = grouper.order();
  const body = options.json
    ? JSON.stringify({
        sites: list.map((entry) => ({ site: entry.site, count: entry.count, bytes: entry.bytes })),
        total: list.length,
        stats,
      }, null, 2) + '\n'
    : list.map((entry) => entry.site + '\t' + entry.count + '\t' + entry.bytes).join('\n') +
      (list.length ? '\n' : '');

  if (options.out) await fsp.writeFile(options.out, body);
  else if (body) await new Promise((resolve) => process.stdout.write(body, resolve));

  process.stderr.write(
    'entrée : ' + bytesIn + ' octets\n' +
    'lignes : ' + stats.lines + ' — avec couple : ' + stats.matched + ' — ignorées : ' + stats.skipped + '\n' +
    'sites : ' + list.length + ' — valeurs : ' + stats.kept + '\n' +
    (split ? 'fichiers écrits : ' + options.split + '/\n' : '') +
    'durée : ' + seconds.toFixed(2) + ' s (' + (bytesIn / 1048576 / (seconds || 1)).toFixed(1) + ' Mo/s)\n'
  );
}

async function* readFile(file) {
  const stream = file.endsWith('.gz')
    ? fs.createReadStream(file).pipe(zlib.createGunzip())
    : fs.createReadStream(file, { highWaterMark: 1 << 20 });
  for await (const chunk of stream) yield chunk;
}

async function main() {
  const options = parseArgs(process.argv.slice(2));
  if (options.help) return usage();

  const sources = options.inputs.length ? options.inputs : ['-'];
  for (const file of sources) {
    if (file === '-') continue;
    const stat = await fsp.stat(file);
    if (!stat.isFile()) throw new Error('ce n’est pas un fichier : ' + file);
  }

  if (options.group || options.site || options.split) return groupMain(options);

  const out = options.out ? fs.createWriteStream(options.out, { highWaterMark: 1 << 20 }) : process.stdout;
  const processor = createProcessor({
    mode: options.mode,
    regex: options.regex,
    dedupe: options.dedupe,
    hosts: options.hosts,
  });
  const started = Date.now();
  let bytesIn = 0;

  async function write(text) {
    if (text && !out.write(text)) await once(out, 'drain');
  }

  for (const file of sources) {
    const stream = file === '-' ? process.stdin : readFile(file);
    for await (const chunk of stream) {
      bytesIn += chunk.length;
      await write(processor.pushBytes(chunk));
    }
    await write(processor.push('\n')); // séparation entre deux fichiers
  }
  await write(processor.flush());

  if (options.out) await new Promise((resolve) => out.end(resolve));
  else if (process.stdout.writable) await new Promise((resolve) => process.stdout.write('', resolve));

  const stats = processor.stats();
  const seconds = (Date.now() - started) / 1000;
  if (options.stats) {
    process.stderr.write(
      'entrée : ' + bytesIn + ' octets\n' +
      'lignes : ' + stats.lines + '\ncouples trouvés : ' + stats.matched + '\n' +
      'sortie : ' + stats.outLines + ' lignes / ' + stats.outChars + ' octets\n' +
      'durée : ' + seconds.toFixed(2) + ' s (' + (bytesIn / 1048576 / (seconds || 1)).toFixed(1) + ' Mo/s)\n'
    );
  }
  if (options.out) {
    process.stderr.write('écrit : ' + path.resolve(options.out) + ' (' + stats.outLines + ' lignes)\n');
  }
}

main().catch((err) => {
  process.stderr.write('zach-db : ' + err.message + '\n');
  process.exitCode = 1;
});
