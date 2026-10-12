#!/usr/bin/env node
/*
 * zach-db — ligne de commande (fichiers de n'importe quelle taille, mémoire constante).
 *
 *   node cli.js gros.txt -o sortie.txt --mode=last --dedupe
 *   node cli.js dossier/*.txt -o sortie.txt --mode=first
 *   zcat gros.txt.gz | node cli.js --mode=last > sortie.txt
 *
 * Options : -o/--out, --mode, --regex, --dedupe, --stats, --help
 */
import fs from 'node:fs';
import fsp from 'node:fs/promises';
import path from 'node:path';
import { once } from 'node:events';
import zlib from 'node:zlib';
import { createProcessor, MODES } from './public/lib/parse.js';

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

entrées : fichiers .txt / .log / .csv / .gz, ou stdin (rien à lire = stdin)
`);
}

function parseArgs(argv) {
  const options = { mode: 'last', regex: '', dedupe: false, hosts: false, out: null, stats: false, inputs: [] };
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
    else if (arg === '--stats') options.stats = true;
    else if (arg.startsWith('-') && arg !== '-') throw new Error('option inconnue : ' + arg);
    else options.inputs.push(arg);
  }
  if (!MODES.includes(options.mode)) throw new Error('mode inconnu : ' + options.mode + ' (' + MODES.join(', ') + ')');
  return options;
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
