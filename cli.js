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
 * Discord lookup :
 *   node cli.js discord 175928847299117063             # ce que dit l'identifiant
 *   DISCORD_TOKEN=... node cli.js discord <id>          # profil complet
 *   node cli.js discord <id> --guilds --json -o w.json  # serveurs communs, en JSON
 *
 * Guns.lol views :
 *   node cli.js guns <pseudo>                          # des vues, via des proxys
 *   node cli.js guns <pseudo> --views=25 --json -o r.json
 *   node cli.js guns <pseudo> --direct                  # sans proxy, une vue par tour
 *
 * Options : -o/--out, --mode, --regex, --dedupe, --stats, --group, --site,
 *           --split, --json, --exact, --keep-hosts, --help,
 *           discord, --token, --guilds, --size
 */
import fs from 'node:fs';
import fsp from 'node:fs/promises';
import path from 'node:path';
import { once } from 'node:events';
import zlib from 'node:zlib';
import { createProcessor, MODES } from './public/lib/parse.js';
import { createGrouper, NO_SITE } from './public/lib/group.js';
import { lookup as discordLookup } from './public/lib/discord-api.js';
import { boost as gunsBoost, inspectPool as gunsPool } from './public/lib/guns-api.js';

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

discord lookup :
  discord <id>          tout ce que raconte un identifiant Discord
      --token <jeton>   jeton bot (défaut : DISCORD_TOKEN) ; sans jeton, la
                        sortie reste utile : date de création, worker, liens
      --guilds          cherche aussi les serveurs communs avec le bot
      --size <côté>     taille des visuels demandés au CDN (16 à 4096, 1024)
      --json            la réponse complète en JSON

guns.lol views :
  guns <pseudo>         pousse des vues sur un profil, une par proxy public
      --views <n>       nombre de vues (défaut : 15)
      --rounds <n>      tours successifs (défaut : 1)
      --proxies <n>     proxys récoltés au plus (défaut : 1500)
      --concurrency <n> vues en parallèle (défaut : 6)
      --direct          sans proxy : l'adresse du serveur, une vue par tour
      --read            lit aussi le compteur, avant et après (au mieux)
      --pool            ne fait que tester la réserve de proxys
      --json            le rapport complet en JSON

entrées : fichiers .txt / .log / .csv / .gz, ou stdin (rien à lire = stdin)
`);
}

function parseArgs(argv) {
  const options = {
    mode: 'last', regex: '', dedupe: false, hosts: false, out: null, stats: false,
    group: false, json: false, exact: false, site: null, split: null, inputs: [],
    command: null, token: null, guilds: false, size: null,
    views: null, rounds: null, proxies: null, concurrency: null,
    direct: false, read: false, pool: false,
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
    else if (arg === '--token') options.token = argv[++i];
    else if (arg.startsWith('--token=')) options.token = arg.slice(8);
    else if (arg === '--guilds') options.guilds = true;
    else if (arg === '--size') options.size = argv[++i];
    else if (arg.startsWith('--size=')) options.size = Number(arg.slice(7));
    else if (arg === '--views') options.views = argv[++i];
    else if (arg.startsWith('--views=')) options.views = arg.slice(8);
    else if (arg === '--rounds') options.rounds = argv[++i];
    else if (arg.startsWith('--rounds=')) options.rounds = arg.slice(9);
    else if (arg === '--proxies') options.proxies = argv[++i];
    else if (arg.startsWith('--proxies=')) options.proxies = arg.slice(10);
    else if (arg === '--concurrency') options.concurrency = argv[++i];
    else if (arg.startsWith('--concurrency=')) options.concurrency = arg.slice(14);
    else if (arg === '--direct') options.direct = true;
    else if (arg === '--read') options.read = true;
    else if (arg === '--pool') options.pool = true;
    else if (arg.startsWith('-') && arg !== '-') throw new Error('option inconnue : ' + arg);
    else options.inputs.push(arg);
  }
  if (options.inputs[0] === 'discord') options.command = 'discord';
  if (options.inputs[0] === 'guns') options.command = 'guns';
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

/* ==================================================================
   discord lookup — ce que raconte un identifiant
   ================================================================== */

const line = (label, value) => (value === null || value === undefined || value === '' ? '' :
  label.padEnd(15) + ': ' + value + '\n');

/** Âge en français : la CLI parle français, la page parle anglais. */
function ageFr(age) {
  const parts = [];
  if (age.years) parts.push(age.years + (age.years > 1 ? ' ans' : ' an'));
  if (age.months) parts.push(age.months + (age.months > 1 ? ' mois' : ' mois'));
  if (age.calendarDays || !parts.length) parts.push(age.calendarDays + (age.calendarDays > 1 ? ' jours' : ' jour'));
  return parts.join(', ');
}

function discordText(payload) {
  let out = '';
  const snow = payload.snowflake || {};

  out += 'identifiant    : ' + (payload.id || '-') + '\n';
  if (snow.valid) {
    out += line('créé le', snow.date.iso);
    out += line('âge', ageFr(snow.age));
    out += line('worker', snow.worker + '   process : ' + snow.process + '   incrément : ' + snow.increment);
    out += line('binaire', snow.binary);
  } else {
    out += 'flocon         : invalide (' + (snow.reason || '?') + ')\n';
  }

  const profile = payload.profile;
  if (profile) {
    out += '\n';
    out += line('nom affiché', profile.display);
    out += line('pseudo', profile.username);
    if (profile.legacyTag) out += line('ancienne balise', profile.legacyTag);
    out += line('discriminateur', profile.discriminator);
    out += line('type', [profile.bot ? 'bot' : null, profile.system ? 'system' : null]
      .filter(Boolean).join(', ') || 'compte humain');
    if (profile.mfa !== null) out += line('2FA', profile.mfa ? 'oui' : 'non');
    if (profile.locale) out += line('langue', profile.locale);
    if (profile.premium) out += line('nitro', profile.premium.name);
    if (profile.accentColor) out += line('couleur', profile.accentColor);
    out += line('drapeaux', profile.flags.list.length
      ? profile.flags.list.map((flag) => flag.name + ' (bit ' + flag.bit + ')').join(', ')
      : 'aucun');
    out += line('public_flags', profile.flags.raw);
    out += line('avatar', profile.assets.avatar || profile.assets.avatarDefault);
    if (profile.assets.banner) out += line('bannière', profile.assets.banner);
    if (profile.assets.decoration) out += line('décoration', profile.assets.decoration);
    out += line('mention', profile.mention);
    out += line('profil', profile.url);
  }

  const guilds = payload.guilds;
  if (guilds && guilds.enabled) {
    out += '\nserveurs communs : ' + guilds.mutual.length +
      ' trouvé(s), ' + guilds.checked + '/' + guilds.total + ' vérifié(s)\n';
    for (const member of guilds.mutual) {
      out += '  - ' + (member.guild ? member.guild.name : '?') +
        (member.nick ? ' (pseudo : ' + member.nick + ')' : '') +
        (member.joinedAt ? ' — rejoint le ' + member.joinedAt.slice(0, 10) : '') +
        (member.roles.length ? ' — rôles : ' + member.roles.map((role) => role.name).join(', ') : '') + '\n';
    }
    if (guilds.stopped) out += '  (arrêt : ' + guilds.stopped + ')\n';
  }

  if (payload.mode === 'offline') {
    out += '\nSans jeton, la sortie s\'arrête à ce que l\'identifiant raconte.\n' +
      'Un jeton bot donne le profil complet :\n' +
      '  DISCORD_TOKEN=... node cli.js discord ' + (payload.id || '<id>') + '\n';
  }
  if (payload.error) out += '\nerreur : ' + payload.error + '\n';
  return out;
}

async function discordMain(options) {
  const payload = await discordLookup(options.inputs[1] || '', {
    guilds: options.guilds,
    size: options.size,
    token: options.token,
  });
  const body = options.json
    ? JSON.stringify(payload, null, 2) + '\n'
    : discordText(payload);

  if (options.out) {
    await fsp.writeFile(options.out, body);
    process.stderr.write('écrit : ' + path.resolve(options.out) + '\n');
  } else {
    await new Promise((resolve) => process.stdout.write(body, resolve));
  }
  if (!payload.ok) process.exitCode = 1;
}

/* ==================================================================
   guns.lol views — une vue par proxy public
   ================================================================== */

function gunsText(report) {
  let out = '';
  out += 'profil         : ' + (report.slug || '-') + '  (' + (report.target || '-') + ')\n';
  if (!report.ok) {
    out += 'erreur         : ' + report.error + (report.hint ? ' — ' + report.hint : '') + '\n';
    return out;
  }

  out += 'mode           : ' + report.mode + '\n';
  out += 'proxys         : ' + report.pool.harvested + ' récoltés, ' + report.pool.tested +
    ' testés, ' + report.pool.alive + ' utilisables, ' + report.pool.dead + ' morts (' +
    report.pool.ms + ' ms)\n';
  out += 'couches        : page ' + report.steps.page.ok + '/' + report.steps.page.tried +
    ' · pixel ' + report.steps.pixel.ok + '/' + report.steps.pixel.tried +
    ' · view ' + report.steps.view.ok + '/' + report.steps.view.tried +
    ' · événement ' + report.steps.record.ok + '/' + report.steps.record.tried + '\n';
  out += 'vues           : ' + report.views.accepted + ' acceptées sur ' + report.views.attempts +
    ' tentées (' + report.views.failed + ' échecs)\n';
  out += 'compteur       : ' + (report.counter.after !== null
    ? report.counter.after + (report.counter.delta === null ? '' : ' (' + report.counter.delta + ')')
    : report.counter.fromPages !== null ? report.counter.fromPages + ' (lu dans la page)' : 'illisible') + '\n';
  out += 'durée          : ' + report.elapsed + ' ms' + (report.truncated ? ' (arrêt anticipé)' : '') + '\n';

  if (report.notes.length) {
    out += '\nnotes :\n';
    for (const line of report.notes) out += '  - ' + line + '\n';
  }
  if (report.pool.sources.length) {
    out += '\nsources :\n';
    for (const source of report.pool.sources) {
      out += '  ' + source.name.padEnd(22) + (source.error ? source.error : source.count + ' gardés') + '\n';
    }
  }
  out += '\nLes vues mettent quelques minutes à apparaître : le compteur est celui de guns.lol.\n';
  return out;
}

async function gunsMain(options) {
  if (options.pool) {
    const pool = await gunsPool({ proxies: options.proxies, concurrency: options.concurrency });
    const body = options.json
      ? JSON.stringify(pool, null, 2) + '\n'
      : 'proxys         : ' + pool.harvested + ' récoltés, ' + pool.tested + ' testés, ' +
        pool.alive + ' utilisables, ' + pool.dead + ' morts (' + pool.elapsed + ' ms)\n' +
        (pool.sample.length
          ? '\nutilisables :\n' + pool.sample.map((entry) => '  ' + entry.proxy + '  ' + entry.ms + ' ms').join('\n') + '\n'
          : '') +
        (pool.sources.length
          ? '\nsources :\n' + pool.sources.map((source) => '  ' + source.name.padEnd(22) + (source.error || source.count + ' gardés')).join('\n') + '\n'
          : '');
    if (options.out) {
      await fsp.writeFile(options.out, body);
      process.stderr.write('écrit : ' + path.resolve(options.out) + '\n');
    } else {
      await new Promise((resolve) => process.stdout.write(body, resolve));
    }
    return;
  }

  const report = await gunsBoost(options.inputs[1] || '', {
    views: options.views,
    rounds: options.rounds,
    proxies: options.proxies,
    concurrency: options.concurrency,
    direct: options.direct,
    read: options.read,
  });

  const body = options.json ? JSON.stringify(report, null, 2) + '\n' : gunsText(report);
  if (options.out) {
    await fsp.writeFile(options.out, body);
    process.stderr.write('écrit : ' + path.resolve(options.out) + '\n');
  } else {
    await new Promise((resolve) => process.stdout.write(body, resolve));
  }
  if (!report.ok || !report.views.accepted) process.exitCode = 1;
}

async function main() {
  const options = parseArgs(process.argv.slice(2));
  if (options.help) return usage();
  if (options.command === 'discord') return discordMain(options);
  if (options.command === 'guns') return gunsMain(options);

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
