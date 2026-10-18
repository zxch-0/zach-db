/*
 * zach-db — interface « Discord lookup ».
 *
 * Deux temps :
 *   1. l'identifiant est décodé sur place, dans le navigateur, pendant la
 *      frappe — date de création, worker, incrément, liens. Aucun réseau,
 *      aucun jeton : cette partie répond toujours ;
 *   2. le serveur est appelé (/api/discord/user) et relaie Discord avec son
 *      propre jeton bot. Le jeton ne descend jamais jusqu'ici.
 *
 * Le reste n'est que de la mise en page : profil, drapeaux décodés, visuels du
 * CDN, serveurs communs, et la réponse brute en JSON.
 */
import { copyText } from './chrome.js'; // sélecteur d'outil + décor commun à toutes les pages
import { decodeSnowflake, defaultAvatar, extractId } from './lib/discord.js';

const el = (id) => document.getElementById(id);
const fmt = new Intl.NumberFormat('en-US');
const n = (value) => fmt.format(value);
const clean = (value) => (value === null || value === undefined || value === '' ? '—' : String(value));

let controller = null; // recherche en cours, pour pouvoir l'annuler
let lastPayload = null;

/* ==================================================================
 * petites écritures
 * ================================================================== */

function set(id, value) {
  const node = el(id);
  if (node) node.textContent = clean(value);
}

function show(id, visible) {
  const node = el(id);
  if (node) node.hidden = !visible;
}

/** Un lien externe dans une case de données (CDN, profil Discord…). */
function linkIn(id, url, label) {
  const node = el(id);
  if (!node) return;
  node.textContent = '';
  if (!url) {
    node.textContent = '—';
    return;
  }
  const anchor = document.createElement('a');
  anchor.href = url;
  anchor.target = '_blank';
  anchor.rel = 'noopener noreferrer';
  anchor.textContent = label || url;
  node.appendChild(anchor);
}

function status(text) {
  const node = el('dstatus');
  if (node) node.textContent = text;
}

/** Barre indéterminée : le serveur ne renvoie qu'une réponse, on ne sait pas
 *  combien de serveurs il est en train d'interroger. */
function stage(text, busy) {
  show('dprogress', Boolean(busy));
  const pct = el('dpct');
  if (pct) pct.textContent = text;
  const cancel = el('dcancel');
  if (cancel) cancel.disabled = !busy;
  const go = el('dgo');
  if (go) go.disabled = Boolean(busy);
  if (typeof document.body !== 'undefined' && document.body.classList) {
    document.body.classList.toggle('is-busy', Boolean(busy));
  }
}

function note(id, text) {
  const node = el(id);
  if (!node) return;
  node.textContent = text || '';
  node.hidden = !text;
}

/** Vide une liste puis la remplit d'éléments construits à la main. */
function fill(list, items, build) {
  if (!list) return;
  list.textContent = '';
  for (const item of items) list.appendChild(build(item));
}

/* ==================================================================
 * 01 — le flocon de neige, décodé pendant la frappe
 * ================================================================== */

/** La règle des bits : 42 + 5 + 5 + 12, dessinée case par case. */
function renderBits(snow) {
  const box = el('dbits');
  if (!box) return;
  box.textContent = '';
  if (!snow.valid || !Array.isArray(snow.segments)) {
    box.hidden = true;
    return;
  }
  box.hidden = false;
  for (const part of snow.segments) {
    const cell = document.createElement('div');
    cell.className = 'bits-cell';

    const label = document.createElement('b');
    label.textContent = part.name;

    const binary = document.createElement('code');
    binary.textContent = part.binary;

    const value = document.createElement('span');
    value.textContent = part.name === 'timestamp'
      ? new Date(snow.timestamp).toISOString()
      : part.bits + ' bits → ' + n(part.value);

    cell.append(label, binary, value);
    box.appendChild(cell);
  }
}

function renderSnowflake(input) {
  const snow = decodeSnowflake(input);

  set('dsnowId', snow.valid ? snow.id : null);
  set('dcreated', snow.valid ? snow.date.utc : null);
  set('dage', snow.valid ? snow.age.text : null);
  set('dts', snow.valid ? n(snow.timestamp) + ' ms' : null);
  set('dunix', snow.valid ? n(snow.date.unix) + ' s' : null);
  set('dworker', snow.valid ? snow.worker : null);
  set('dprocess', snow.valid ? snow.process : null);
  set('dincrement', snow.valid ? snow.increment : null);
  set('dhex', snow.valid ? snow.hex : null);
  set('dmention', snow.valid ? '<@' + snow.id + '>' : null);
  linkIn('dprofileLink', snow.valid ? 'https://discord.com/users/' + snow.id : null);
  linkIn('ddefaultAvatar', snow.valid ? defaultAvatar(snow.id, '0') : null);
  renderBits(snow);

  return snow;
}

/* ==================================================================
 * 02 — le profil renvoyé par le serveur
 * ================================================================== */

function pill(text) {
  const node = document.createElement('span');
  node.className = 'pill';
  node.textContent = text;
  return node;
}

function badge(flag) {
  const node = document.createElement('span');
  node.className = 'badge';
  const name = document.createElement('b');
  name.textContent = flag.name;
  const label = document.createElement('em');
  label.textContent = flag.label + ' · bit ' + flag.bit;
  node.append(name, label);
  return node;
}

/** Une case de la grille de données. */
function fact(label, value, url) {
  const cell = document.createElement('div');
  const dt = document.createElement('dt');
  dt.textContent = label;
  const dd = document.createElement('dd');
  if (url) {
    const anchor = document.createElement('a');
    anchor.href = url;
    anchor.target = '_blank';
    anchor.rel = 'noopener noreferrer';
    anchor.textContent = clean(value);
    dd.appendChild(anchor);
  } else {
    dd.textContent = clean(value);
  }
  cell.append(dt, dd);
  return cell;
}

/** Toutes les données du profil, dans l'ordre où Discord les raconte. */
function renderProfile(payload) {
  const profile = payload.profile;
  const user = payload.user || {};
  show('dprofileBox', true);

  const mode = el('dmode');
  if (mode) {
    mode.textContent = payload.mode === 'online'
      ? 'discord api v10 · ' + n(payload.elapsed || 0) + ' ms'
      : 'decoded from the id alone';
  }

  // bannière et avatar : images du CDN, chargées seulement maintenant
  const banner = el('dbanner');
  if (banner) {
    if (profile.assets.banner) {
      banner.style.backgroundImage = 'url("' + profile.assets.banner + '")';
      banner.classList.remove('is-empty');
    } else {
      banner.style.backgroundImage = '';
      banner.classList.add('is-empty');
    }
  }
  const avatar = el('davatar');
  if (avatar) {
    avatar.src = profile.assets.avatar || profile.assets.avatarDefault;
    avatar.hidden = false;
  }

  set('ddisplay', profile.display);
  set('dusername', '@' + clean(profile.username) +
    (profile.legacyTag ? ' · ' + profile.legacyTag : '') +
    (profile.bot ? ' · bot' : ''));

  const pills = el('dpills');
  const marks = [];
  if (profile.bot) marks.push('bot');
  if (profile.system) marks.push('system');
  if (profile.verified === true) marks.push('verified');
  if (profile.mfa === true) marks.push('2fa on');
  if (profile.premium) marks.push(profile.premium.name);
  if (!marks.length) marks.push('human account');
  fill(pills, marks, pill);

  const badges = el('dbadges');
  if (profile.flags.list.length) {
    fill(badges, profile.flags.list, badge);
  } else if (badges) {
    badges.textContent = '';
    const empty = document.createElement('span');
    empty.className = 'badge badge-none';
    empty.textContent = 'no public badge';
    badges.appendChild(empty);
  }

  // la grille : un champ par case, rien n'est masqué
  const facts = el('dfacts');
  const rows = [
    ['user id', profile.id],
    ['username', profile.username],
    ['global name', profile.globalName],
    ['discriminator', profile.discriminator],
    ['legacy tag', profile.legacyTag],
    ['mention', profile.mention],
    ['created (utc)', profile.created.valid ? profile.created.date.utc : null],
    ['account age', profile.created.valid ? profile.created.age.text : null],
    ['timestamp', profile.created.valid ? n(profile.created.timestamp) + ' ms' : null],
    ['worker / process', profile.created.valid ? profile.created.worker + ' / ' + profile.created.process : null],
    ['increment', profile.created.valid ? profile.created.increment : null],
    ['bot', profile.bot ? 'yes' : 'no'],
    ['system', profile.system ? 'yes' : 'no'],
    ['mfa enabled', profile.mfa === null ? null : profile.mfa ? 'yes' : 'no'],
    ['verified', profile.verified === null ? null : profile.verified ? 'yes' : 'no'],
    ['locale', profile.locale],
    ['nitro', profile.premium ? profile.premium.name : null],
    ['accent colour', profile.accentColor],
    ['public flags', profile.flags.raw],
    ['avatar hash', profile.avatarHash],
    ['banner hash', profile.bannerHash],
    ['decoration sku', profile.decoration && profile.decoration.sku_id],
    ['primary guild', profile.primaryGuild && (profile.primaryGuild.server_label || profile.primaryGuild.identity_guild_id)],
    ['profile', profile.url],
  ];
  const kept = rows.filter((row) => row[1] !== null && row[1] !== undefined && row[1] !== '');
  fill(facts, kept, (row) => fact(row[0], row[1], row[0] === 'profile' ? row[1] : null));

  // accent colour : la seule touche de couleur, et c'est une donnée
  if (profile.accentColor && facts) {
    for (const cell of Array.from(facts.children)) {
      const label = cell.querySelector ? cell.querySelector('dt') : null;
      if (!label || label.textContent !== 'accent colour') continue;
      const value = cell.querySelector('dd');
      if (!value) continue;
      const swatch = document.createElement('i');
      swatch.className = 'swatch';
      swatch.style.background = profile.accentColor;
      value.appendChild(swatch);
      break;
    }
  }

  set('statFields', n(Object.keys(user).length));
  set('statBadges', n(profile.flags.list.length));
  set('statMs', n(payload.elapsed || 0));
}

/** Visuels du CDN : chaque adresse, cliquable et copiable. */
function renderAssets(payload) {
  const profile = payload.profile;
  const assets = profile.assets;
  const list = el('dassets');
  show('dassetsBox', Boolean(list));
  if (!list) return;

  const entries = [
    ['avatar', assets.avatar],
    ['avatar (png)', assets.avatarPng],
    ['avatar (webp)', assets.avatarWebp],
    ['avatar (gif)', assets.avatarGif],
    ['default avatar', assets.avatarDefault],
    ['banner', assets.banner],
    ['banner (gif)', assets.bannerGif],
    ['avatar decoration', assets.decoration],
    ['profile page', assets.profile],
  ].filter((entry) => entry[1]);

  list.textContent = '';
  for (const [label, url] of entries) {
    const item = document.createElement('li');

    const name = document.createElement('span');
    name.className = 'asset-name';
    name.textContent = label;

    const anchor = document.createElement('a');
    anchor.className = 'asset-url';
    anchor.href = url;
    anchor.target = '_blank';
    anchor.rel = 'noopener noreferrer';
    anchor.textContent = url;

    const button = document.createElement('button');
    button.type = 'button';
    button.className = 'copy';
    button.setAttribute('data-copytext', url);
    button.textContent = 'Copy';

    item.append(name, anchor, button);
    list.appendChild(item);
  }
}

/* ==================================================================
 * 03 — serveurs communs
 * ================================================================== */

function renderGuilds(payload) {
  const guilds = payload.guilds;
  if (!guilds || !guilds.enabled) {
    show('dguildBox', false);
    return;
  }
  show('dguildBox', true);
  set('dguildSummary', guilds.mutual.length + ' found · ' + guilds.checked + '/' + guilds.total + ' checked');
  set('statServers', n(guilds.mutual.length));

  const list = el('dguilds');
  if (!list) return;
  list.textContent = '';

  if (!guilds.mutual.length) {
    const empty = document.createElement('li');
    empty.className = 'guild guild-none';
    empty.textContent = 'No server in common with the bot.';
    list.appendChild(empty);
  }

  for (const member of guilds.mutual) {
    const item = document.createElement('li');
    item.className = 'guild';

    const head = document.createElement('div');
    head.className = 'guild-head';
    const name = document.createElement('strong');
    name.textContent = (member.guild && member.guild.name) || 'unknown server';
    const id = document.createElement('span');
    id.textContent = (member.guild && member.guild.id) || '—';
    head.append(name, id);

    const body = document.createElement('div');
    body.className = 'guild-body';
    const lines = [];
    if (member.nick) lines.push('nickname: ' + member.nick);
    if (member.joinedAt) lines.push('joined: ' + member.joinedAt.slice(0, 19).replace('T', ' ') + ' UTC');
    if (member.premiumSince) lines.push('boosting since: ' + member.premiumSince.slice(0, 10));
    if (member.mutedUntil) lines.push('timed out until: ' + member.mutedUntil.slice(0, 19).replace('T', ' '));
    if (member.pending) lines.push('pending membership');
    const meta = document.createElement('p');
    meta.textContent = lines.length ? lines.join(' · ') : 'member, no extra detail';
    body.appendChild(meta);

    if (member.roles.length) {
      const chips = document.createElement('p');
      chips.className = 'role-chips';
      for (const role of member.roles) {
        const chip = document.createElement('span');
        chip.className = 'chip';
        chip.textContent = role.name;
        chips.appendChild(chip);
      }
      body.appendChild(chips);
    }

    item.append(head, body);
    list.appendChild(item);
  }

  note('dguildNote', [guilds.stopped, guilds.errors.length ? guilds.errors.length + ' errors' : '']
    .filter(Boolean).join(' · '));
}

/* ==================================================================
 * 04 — réponse brute, débit, erreurs
 * ================================================================== */

function renderRaw(payload) {
  const box = el('drawBox');
  const pre = el('draw');
  if (!box || !pre) return;
  const body = Object.assign({}, payload);
  delete body.status;
  pre.textContent = JSON.stringify(body, null, 2);
  box.hidden = false;
  const save = el('dsave');
  if (save) save.disabled = false;
}

function renderRateLimit(payload) {
  const limit = payload.ratelimit;
  if (!limit) {
    note('dratelimit', '');
    return;
  }
  const reset = limit.reset ? Math.max(0, Math.round(limit.reset - Date.now() / 1000)) : null;
  note('dratelimit', 'discord rate limit: ' + limit.remaining + '/' + limit.limit +
    ' left in this bucket' + (reset === null ? '' : ', resets in ' + reset + ' s') +
    (limit.global ? ' · global limit hit' : ''));
}

/** Télécharge la dernière réponse, telle quelle. */
function download() {
  if (!lastPayload) return;
  const body = Object.assign({}, lastPayload);
  delete body.status;
  const blob = new Blob([JSON.stringify(body, null, 2)], { type: 'application/json' });
  const url = URL.createObjectURL(blob);
  const anchor = document.createElement('a');
  anchor.href = url;
  anchor.download = 'discord-' + (body.id || 'lookup') + '.json';
  document.body.appendChild(anchor);
  anchor.click();
  anchor.remove();
  const timer = setTimeout(() => URL.revokeObjectURL(url), 4000);
  if (timer && typeof timer.unref === 'function') timer.unref(); // ne retient pas Node (tests)
}

/* ==================================================================
 * la recherche
 * ================================================================== */

function readForm() {
  const input = el('did');
  const mutual = el('dmutual');
  const size = el('dsize');
  return {
    text: input ? input.value : '',
    guilds: Boolean(mutual && mutual.checked),
    size: size && size.value ? Number(size.value) : 1024,
  };
}

async function run(options) {
  const snow = renderSnowflake(options.text);
  if (!snow.valid) {
    show('dprofileBox', false);
    show('dassetsBox', false);
    show('dguildBox', false);
    note('dnotice', options.text.trim()
      ? 'That is not a Discord snowflake: expected 17 to 20 digits, a mention, or a profile URL.'
      : 'Type a Discord user ID to begin.');
    note('dratelimit', '');
    status(options.text.trim() ? 'Invalid ID.' : 'Ready. Decoding an ID needs neither network nor token.');
    return;
  }

  note('dnotice', '');
  controller = typeof AbortController === 'function' ? new AbortController() : null;
  stage(options.guilds ? 'asking the server, then every mutual server…' : 'asking the server…', true);
  status('Looking up ' + snow.id + '…');

  const query = new URLSearchParams({ id: snow.id, size: String(options.size) });
  if (options.guilds) query.set('guilds', '1');

  try {
    const response = await fetch('/api/discord/user?' + query.toString(), {
      headers: { accept: 'application/json' },
      signal: controller ? controller.signal : undefined,
    });
    const payload = await response.json();
    payload.status = response.status;
    lastPayload = payload;

    if (payload.ok && payload.profile) {
      renderProfile(payload);
      renderAssets(payload);
      renderGuilds(payload);
      note('dnotice', '');
      note('dwarn', '');
      status('Found ' + payload.profile.display + ' (' + payload.profile.id + ') · ' +
        n(payload.profile.flags.list.length) + ' badge(s) · ' +
        (payload.guilds && payload.guilds.enabled ? n(payload.guilds.mutual.length) + ' mutual server(s)' : 'servers not searched') +
        ' · ' + n(payload.elapsed || 0) + ' ms.');
    } else {
      show('dprofileBox', false);
      show('dassetsBox', false);
      show('dguildBox', false);
      if (payload.mode === 'offline') {
        note('dnotice', (payload.notice || 'Offline mode.') +
          ' The snowflake above is complete: creation date, worker, process and increment come from the ID itself.');
        status('Decoded offline — no token on this server.');
      } else {
        note('dnotice', (payload.error || 'Lookup failed.') +
          (payload.code ? ' (code ' + payload.code + ')' : '') +
          (payload.retry_after ? ' — retry in ' + payload.retry_after + ' s' : '') +
          '. The snowflake above is still valid: the account was created ' +
          (snow.date ? snow.date.utc : 'at ' + snow.timestamp) + '.');
        status('Discord answer: ' + response.status + '.');
      }
      note('dwarn', payload.error || '');
    }

    renderRaw(payload);
    renderRateLimit(payload);
    set('dmeta', payload.mode === 'online' ? 'discord api v10 · token on the server' : 'offline decode · no token');
    if (payload.ok && payload.profile) set('statServers', n(payload.guilds && payload.guilds.enabled ? payload.guilds.mutual.length : 0));
  } catch (err) {
    show('dprofileBox', false);
    show('dassetsBox', false);
    show('dguildBox', false);
    if (err && err.name === 'AbortError') {
      note('dnotice', '');
      status('Cancelled.');
    } else {
      note('dnotice', 'The server could not be reached: ' + ((err && err.message) || 'network error') + '.');
      status('Lookup failed.');
    }
  } finally {
    controller = null;
    stage('done', false);
  }
}

/* ==================================================================
 * branchements
 * ================================================================== */

/**
 * L'état du jeton, lu sur /api/health : la page dit tout de suite si le profil
 * complet est accessible ou si l'on reste sur le décodage local.
 */
async function readTokenState() {
  try {
    const response = await fetch('/api/health', { headers: { accept: 'application/json' } });
    const health = await response.json();
    const hasToken = Boolean(health && health.discord);
    set('dmeta', hasToken ? 'discord api v10 · token on the server' : 'discord api v10 · no token yet');
    if (!hasToken && !lastPayload) {
      status('Ready. No bot token on this server yet: the snowflake below is decoded here, in your browser.');
      note('dnotice', 'Offline mode — set DISCORD_TOKEN on the server (see “Bot token” at the bottom of the page) ' +
        'to fetch names, badges, avatar, banner and mutual servers.');
    }
    return hasToken;
  } catch {
    return null; // l'état du jeton est un confort, pas une condition de fonctionnement
  }
}

function applyColors() {
  const box = el('dcolors');
  if (typeof document.body !== 'undefined' && document.body.classList) {
    document.body.classList.toggle('show-colors', Boolean(box && box.checked));
  }
}

function keepUrl() {
  const snow = renderSnowflake(readForm().text);
  if (typeof history !== 'undefined' && history.replaceState && snow.valid) {
    history.replaceState(null, '', '?id=' + snow.id);
  }
}

async function init() {
  const form = el('lookupForm');
  const input = el('did');
  const colors = el('dcolors');
  const cancel = el('dcancel');
  const save = el('dsave');
  const copyRaw = el('drawCopy');

  applyColors();
  const tokenState = readTokenState(); // en parallèle, sans bloquer la saisie

  // ?id= dans l'adresse : on préremplit et on cherche tout de suite
  const params = typeof location !== 'undefined' && location.search
    ? new URLSearchParams(location.search)
    : null;
  const wanted = params ? extractId(params.get('id') || params.get('user') || '') : null;
  if (input && wanted) input.value = wanted;
  renderSnowflake(input ? input.value : '');

  if (input) {
    let pending = 0;
    input.addEventListener('input', () => {
      renderSnowflake(input.value); // immédiat, sans réseau
      clearTimeout(pending);
      pending = setTimeout(keepUrl, 400);
    });
  }
  if (colors) colors.addEventListener('change', applyColors);
  if (form) {
    form.addEventListener('submit', (event) => {
      event.preventDefault();
      run(readForm());
    });
  }
  if (cancel) {
    cancel.addEventListener('click', () => {
      if (controller) controller.abort();
    });
  }
  if (save) save.addEventListener('click', download);
  if (copyRaw) {
    copyRaw.addEventListener('click', async () => {
      const pre = el('draw');
      const ok = await copyText(pre ? pre.textContent : '');
      copyRaw.textContent = ok ? 'Copied' : 'Copy failed';
      setTimeout(() => { copyRaw.textContent = 'Copy'; }, 1600);
    });
  }

  // boutons « copier » des visuels, ajoutés après coup : écoute déléguée
  if (typeof document.addEventListener === 'function') {
    document.addEventListener('click', async (event) => {
      const button = event.target && event.target.closest ? event.target.closest('[data-copytext]') : null;
      if (!button) return;
      const ok = await copyText(button.getAttribute('data-copytext') || '');
      button.textContent = ok ? 'Copied' : 'Copy failed';
      setTimeout(() => { button.textContent = 'Copy'; }, 1600);
    });
  }

  await tokenState;
  if (wanted) await run(readForm());
}

init().catch((err) => status('Startup error: ' + ((err && err.message) || err)));

export { renderSnowflake, run, download };
