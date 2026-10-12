#!/usr/bin/env node
/*
 * zach-db — benchmark.
 *
 *   node bench.js                 # génère ~200 Mo en mémoire et mesure le moteur
 *   node bench.js gros.txt        # mesure sur un fichier existant
 *   node bench.js --mb=1000       # taille du fichier généré
 *   node bench.js --sites=200     # nombre de sites distincts dans les données générées
 */
import fs from 'node:fs';
import { createProcessor } from './public/lib/parse.js';
import { createGrouper } from './public/lib/group.js';

const large = Number((process.argv.find((a) => a.startsWith('--mb=')) || '').slice(5)) || 200;
const siteCount = Number((process.argv.find((a) => a.startsWith('--sites=')) || '').slice(8)) || 50;
const file = process.argv[2] && !process.argv[2].startsWith('--') ? process.argv[2] : null;

function generate(mb) {
  const target = mb * 1024 * 1024;
  const parts = [];
  let size = 0;
  let i = 0;
  while (size < target) {
    const line = `[${i}] https://www.site${i % siteCount}.com/tr/CreateAccount:Thou_mirib${i % 97}:N2Z6PQXg4XLnTS${i % 1000}]\n`;
    parts.push(line);
    size += line.length;
    i++;
  }
  return parts.join('');
}

function measure(label, text, options = {}) {
  for (const pass of [1, 2]) {
    const processor = createProcessor(options);
    const started = Date.now();
    let out = '';
    const chunk = 4 << 20;
    for (let i = 0; i < text.length; i += chunk) out += processor.push(text.slice(i, i + chunk));
    out += processor.flush();
    const seconds = (Date.now() - started) / 1000;
    const stats = processor.stats();
    if (pass === 2 || process.env.ZACH_BENCH_ALL) {
      console.log(
        label.padEnd(22) + seconds.toFixed(2) + ' s  ' +
        (text.length / 1048576 / seconds).toFixed(0).padStart(4) + ' Mo/s  ' +
        stats.lines + ' lignes → ' + stats.outLines + ' lignes (' +
        (stats.outChars / 1048576).toFixed(1) + ' Mo)'
      );
    }
  }
}

let text;
if (file) {
  text = fs.readFileSync(file, 'utf8');
  console.log('fichier : ' + file + ' (' + (text.length / 1048576).toFixed(1) + ' Mo)');
} else {
  text = generate(large);
  console.log('texte généré : ' + (text.length / 1048576).toFixed(1) + ' Mo');
}
measure('mode last (défaut)', text);
measure('mode first', text, { mode: 'first' });
measure('mode all', text, { mode: 'all' });
measure('mode last + dedupe', text, { dedupe: true });

/* ---------- tri par site ---------- */

function measureGroup(label, text, options = {}) {
  for (const pass of [1, 2]) {
    const grouper = createGrouper(options);
    const started = Date.now();
    const chunk = 4 << 20;
    for (let i = 0; i < text.length; i += chunk) grouper.push(text.slice(i, i + chunk));
    grouper.flush();
    const seconds = (Date.now() - started) / 1000;
    const stats = grouper.stats();
    if (pass === 2 || process.env.ZACH_BENCH_ALL) {
      console.log(
        label.padEnd(22) + seconds.toFixed(2) + ' s  ' +
        (text.length / 1048576 / seconds).toFixed(0).padStart(4) + ' Mo/s  ' +
        grouper.sites().size + ' sites — ' + stats.kept + ' valeurs rangées'
      );
    }
  }
}

console.log('tri par site (' + siteCount + ' sites) :');
measureGroup('group (sous-domaines)', text);
measureGroup('group + dedupe', text, { dedupe: true });
measureGroup('group site unique', text, { onlySite: 'site' + Math.floor(siteCount / 2) + '.com' });
