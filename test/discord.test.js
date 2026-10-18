/*
 * Discord lookup : le module de calculs, puis la route de bout en bout.
 *
 * Pour ne dépendre ni d'Internet ni d'un vrai jeton, un faux serveur Discord
 * répond à la place de l'officiel (DISCORD_API_BASE pointe vers lui) : il joue
 * l'utilisateur connu, l'utilisateur inconnu, le jeton refusé, la limite de
 * débit, les serveurs communs et leurs rôles.
 */
import test from 'node:test';
import assert from 'node:assert/strict';
import http from 'node:http';
import {
  EPOCH, PUBLIC_FLAGS, SNOWFLAKE_LAYOUT, accentHex, assetUrls, decodeFlags, decodeSnowflake,
  defaultAvatar, describeMember, describeUser, extractId, formatAge, formatDate, premiumOf,
} from '../public/lib/discord.js';
import { flagTable } from '../public/lib/discord-api.js';

/* ---------- données de référence ---------- */

const KNOWN = '175928847299117063'; // l'exemple de la documentation Discord
const UNKNOWN = '175928847299117099';
const GUILD_IN = '111111111111111111';
const GUILD_OUT = '222222222222222222';

const USER = {
  id: KNOWN,
  username: 'wumpus',
  discriminator: '0',
  global_name: 'Wumpus',
  avatar: 'a_1f3b9c8d7e6f5a4b3c2d1e0f9a8b7c6d',
  banner: 'f0e1d2c3b4a5968778695a4b3c2d1e0f',
  accent_color: 7506394,
  bot: false,
  system: false,
  mfa_enabled: true,
  locale: 'en-US',
  verified: true,
  flags: 4194305,
  public_flags: 4194305,
  premium_type: 2,
  avatar_decoration_data: { sku_id: '999', asset: 'deco-hash' },
};

const MEMBER = {
  user: { id: KNOWN, username: 'wumpus' },
  nick: 'zach',
  roles: ['333333333333333333', '444444444444444444'],
  joined_at: '2021-03-04T05:06:07.890+00:00',
  premium_since: '2022-01-02T03:04:05.678+00:00',
  pending: false,
  communication_disabled_until: null,
};

const ROLES = [
  { id: '333333333333333333', name: 'Moderator', position: 3, color: 0, hoist: true, managed: false },
  { id: '444444444444444444', name: 'Member', position: 1, color: 7506394, hoist: false, managed: false },
  { id: '555555555555555555', name: '@everyone', position: 0, color: 0, hoist: false, managed: false },
];

/* ---------- le faux Discord ---------- */

const seen = [];
let refuseToken = false;
let rateLimitOnce = false;

function reply(res, status, body, headers = {}) {
  const text = JSON.stringify(body);
  res.writeHead(status, { 'content-type': 'application/json', ...headers });
  res.end(text);
}

const discord = http.createServer((req, res) => {
  const auth = String(req.headers.authorization || '');
  seen.push({ url: req.url, auth, agent: String(req.headers['user-agent'] || '') });

  if (refuseToken) return reply(res, 401, { message: '401: Unauthorized' });
  if (rateLimitOnce) {
    rateLimitOnce = false;
    return reply(res, 429, { message: 'You are being rate limited.', retry_after: 0.5, code: 20000 });
  }

  const url = new URL(req.url, 'http://discord.test');
  const path = url.pathname;

  if (path === '/users/' + KNOWN) {
    return reply(res, 200, USER, {
      'x-ratelimit-limit': '5',
      'x-ratelimit-remaining': '4',
      'x-ratelimit-reset': String(Date.now() / 1000 + 30),
      'x-ratelimit-bucket': 'bucket-1',
    });
  }
  if (path === '/users/@me/guilds') {
    return reply(res, 200, [
      { id: GUILD_IN, name: 'zach-db', icon: null, owner: true },
      { id: GUILD_OUT, name: 'elsewhere', icon: null, owner: false },
    ]);
  }
  const member = path.match(/^\/guilds\/(\d+)\/members\/(\d+)$/);
  if (member) {
    if (member[1] === GUILD_IN && member[2] === KNOWN) return reply(res, 200, MEMBER);
    return reply(res, 404, { code: 10007, message: 'Unknown Member' });
  }
  if (/^\/guilds\/\d+\/roles$/.test(path)) return reply(res, 200, ROLES);
  if (/^\/users\/\d+$/.test(path)) return reply(res, 404, { code: 10013, message: 'Unknown User' });
  return reply(res, 404, { message: 'Unknown' });
});

await new Promise((resolve) => discord.listen(0, '127.0.0.1', resolve));

process.env.DISCORD_API_BASE = 'http://127.0.0.1:' + discord.address().port;
process.env.DISCORD_TOKEN = 'test-token';
process.env.DISCORD_GUILD_CAP = '5';
process.env.DISCORD_RATE_MAX = '25';
process.env.DISCORD_RATE_WINDOW = '60000';

const { createServer } = await import('../server.js');
const server = createServer();
await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
const base = 'http://127.0.0.1:' + server.address().port;

test.after(() => {
  server.close();
  discord.close();
});

const ask = async (query) => {
  const response = await fetch(base + '/api/discord/user?' + query);
  return { status: response.status, body: await response.json() };
};

/* ==================================================================
 * le flocon de neige
 * ================================================================== */

test('flocon : l’exemple de la documentation est décodé', () => {
  const snow = decodeSnowflake(KNOWN);
  assert.equal(snow.valid, true);
  assert.equal(snow.epoch, EPOCH);
  assert.equal(snow.timestamp, 1462015105796, 'millisecondes depuis l’epoch Discord');
  assert.equal(snow.date.iso, '2016-04-30T11:18:25.796Z');
  assert.equal(snow.worker, 1);
  assert.equal(snow.increment, 7);
  assert.equal(snow.binary.length, 64, 'les 64 bits sont écrits');
  assert.equal(snow.hex, '0x271065AC1020007');
});

test('flocon : la décomposition se reconstruit à l’identique', () => {
  for (const id of [KNOWN, '80351110224678912', '1000000000000000000', String(BigInt(Date.now() - EPOCH) << 22n)]) {
    const snow = decodeSnowflake(id);
    assert.equal(snow.valid, true, id);
    const rebuilt =
      (BigInt(snow.timestamp - EPOCH) << 22n) |
      (BigInt(snow.worker) << 17n) |
      (BigInt(snow.process) << 12n) |
      BigInt(snow.increment);
    assert.equal(rebuilt.toString(), id, 'les morceaux ne recollent pas pour ' + id);
    assert.deepEqual(
      snow.segments.map((part) => part.bits),
      SNOWFLAKE_LAYOUT.map((part) => part.bits)
    );
    assert.equal(snow.segments.map((part) => part.binary).join(''), snow.binary, '64 bits, pas un de moins');
  }
});

test('flocon : ce qui n’est pas un identifiant est refusé', () => {
  assert.equal(decodeSnowflake('123').valid, false, 'trop court');
  assert.equal(decodeSnowflake('abc').valid, false);
  assert.equal(decodeSnowflake('').valid, false);
  assert.equal(decodeSnowflake(null).reason, 'no id');
  // 20 chiffres : l'horodatage tombe après demain, donc ce n'est pas un flocon
  const future = decodeSnowflake('99999999999999999999');
  assert.equal(future.valid, false);
  assert.equal(future.reason, 'out of range');
  assert.ok(future.worker === 0 || future.worker > 0, 'les morceaux restent lus pour le diagnostic');
});

test('saisie libre : mention, adresse de profil, texte autour', () => {
  assert.equal(extractId(KNOWN), KNOWN);
  assert.equal(extractId('<@' + KNOWN + '>'), KNOWN);
  assert.equal(extractId('<@!' + KNOWN + '>'), KNOWN);
  assert.equal(extractId('https://discord.com/users/' + KNOWN), KNOWN);
  assert.equal(extractId('regarde ' + KNOWN + ' stp'), KNOWN);
  assert.equal(extractId('  ' + KNOWN + '\n'), KNOWN);
  assert.equal(extractId('rien ici'), null);
  assert.equal(extractId(''), null);
  assert.equal(extractId(null), null);
});

test('âge et dates : lisibles, et sans dépendre de la locale', () => {
  const date = formatDate(1462015105796);
  assert.equal(date.utc, 'Sat, 30 Apr 2016 11:18:25 GMT');
  assert.equal(date.day, '2016-04-30');
  assert.equal(date.time, '11:18:25');
  assert.equal(date.unix, 1462015105);

  const age = formatAge(1462015105796, Date.UTC(2026, 9, 18));
  assert.equal(age.years, 10);
  assert.equal(age.months, 5);
  assert.equal(age.text, '10 years, 5 months, 18 days');
  assert.equal(age.short, '10y 5mo 18d');
  const hour = formatAge(Date.now() - 3600000, Date.now());
  assert.equal(hour.hours, 1);
  assert.equal(hour.text, '0 days', 'moins d’un jour : on compte en jours');
});

/* ==================================================================
 * drapeaux, Nitro, couleur, visuels
 * ================================================================== */

test('drapeaux publics : décodés bit à bit, sans rien inventer', () => {
  assert.equal(PUBLIC_FLAGS.length, 15);
  const flags = decodeFlags(4194305); // Staff (1) + Active Developer (1 << 22)
  assert.deepEqual(flags.list.map((flag) => flag.id), ['staff', 'active_developer']);
  assert.equal(flags.count, 2);
  assert.deepEqual(flags.unknown, []);

  const all = decodeFlags(PUBLIC_FLAGS.reduce((sum, flag) => sum + (1 << flag.bit), 0));
  assert.equal(all.count, PUBLIC_FLAGS.length, 'tous les drapeaux sont reconnus');
  assert.deepEqual(all.unknown, []);

  const mystery = decodeFlags(1 << 30);
  assert.deepEqual(mystery.list, [], 'un bit inconnu n’est pas inventé');
  assert.deepEqual(mystery.unknown, [{ bit: 30, value: 1 << 30 }]);

  assert.deepEqual(decodeFlags(0).list, []);
  assert.deepEqual(decodeFlags(null).list, []);
  assert.deepEqual(decodeFlags(undefined).raw, 0);
});

test('nitro, couleur d’accent et visuels du CDN', () => {
  assert.equal(premiumOf(2).name, 'Nitro');
  assert.equal(premiumOf(3).name, 'Nitro Basic');
  assert.equal(premiumOf(0).name, 'None');
  assert.equal(premiumOf(null), null);
  assert.equal(premiumOf(99).name, 'Unknown');

  assert.equal(accentHex(7506394), '#7289da');
  assert.equal(accentHex(0), '#000000');
  assert.equal(accentHex(null), null);
  assert.equal(accentHex(0xffffff + 1), null, 'hors gamme');

  const assets = assetUrls(USER, 512);
  assert.equal(assets.avatar,
    'https://cdn.discordapp.com/avatars/' + KNOWN + '/' + USER.avatar + '.gif?size=512',
    'un hash animé donne un .gif');
  assert.equal(assets.avatarPng.slice(-13), '.png?size=512');
  assert.equal(assets.banner,
    'https://cdn.discordapp.com/banners/' + KNOWN + '/' + USER.banner + '.png?size=512');
  assert.equal(assets.decoration,
    'https://cdn.discordapp.com/avatar-decoration-presets/deco-hash.png?size=512');
  assert.equal(assets.profile, 'https://discord.com/users/' + KNOWN);
  assert.equal(assets.mention, '<@' + KNOWN + '>');

  // sans avatar : l'avatar par défaut, indexé par l'identifiant
  const none = assetUrls({ id: KNOWN, discriminator: '0' });
  assert.equal(none.avatar, null);
  assert.equal(none.avatarDefault, defaultAvatar(KNOWN, '0'));
  assert.match(none.avatarDefault, /^https:\/\/cdn\.discordapp\.com\/embed\/avatars\/[0-5]\.png$/);
  // anciens comptes à quatre chiffres : l'index vient du discriminateur
  assert.equal(defaultAvatar(KNOWN, '0001'), 'https://cdn.discordapp.com/embed/avatars/1.png');
  assert.equal(defaultAvatar(KNOWN, '0004'), 'https://cdn.discordapp.com/embed/avatars/4.png');
  // taille bornée
  assert.ok(assetUrls(USER, 99999).avatar.endsWith('?size=4096'), 'taille bornée à 4096');
  assert.ok(assetUrls(USER, 1).avatar.endsWith('?size=16'), 'et à 16 au minimum');
});

test('vue normalisée d’un utilisateur et d’un membre', () => {
  const profile = describeUser(USER, { size: 256 });
  assert.equal(profile.display, 'Wumpus', 'le nom global l’emporte');
  assert.equal(profile.username, 'wumpus');
  assert.equal(profile.legacyTag, null, 'discriminateur 0 : plus d’ancienne balise');
  assert.equal(profile.bot, false);
  assert.equal(profile.mfa, true);
  assert.equal(profile.locale, 'en-US');
  assert.equal(profile.accentColor, '#7289da');
  assert.equal(profile.premium.name, 'Nitro');
  assert.equal(profile.flags.count, 2);
  assert.equal(profile.created.timestamp, 1462015105796);
  assert.match(profile.assets.avatar, /\?size=256$/);
  assert.equal(describeUser(null), null);
  assert.equal(describeUser({}), null);

  // ancienne balise name#0001 quand le discriminateur existe encore
  const legacy = describeUser({ id: KNOWN, username: 'old', discriminator: '0137' });
  assert.equal(legacy.legacyTag, 'old#0137');
  assert.equal(legacy.display, 'old');

  const member = describeMember(MEMBER, { id: GUILD_IN, name: 'zach-db' }, ROLES);
  assert.equal(member.nick, 'zach');
  assert.equal(member.guild.name, 'zach-db');
  assert.deepEqual(member.roles.map((role) => role.name), ['Moderator', 'Member'],
    '@everyone est écarté, les rôles triés par position');
  assert.equal(member.roles[1].color, '#7289da');
  assert.equal(member.joinedAt, MEMBER.joined_at);
  assert.equal(member.mutedUntil, null);
});

/* ==================================================================
 * la route, de bout en bout
 * ================================================================== */

test('api : sans jeton, l’outil répond quand même (mode hors ligne)', async () => {
  process.env.DISCORD_TOKEN = '';
  const { status, body } = await ask('id=' + KNOWN);
  process.env.DISCORD_TOKEN = 'test-token';

  assert.equal(status, 200);
  assert.equal(body.ok, true);
  assert.equal(body.mode, 'offline');
  assert.equal(body.token, false);
  assert.equal(body.id, KNOWN);
  assert.equal(body.snowflake.timestamp, 1462015105796, 'le flocon est décodé sans réseau');
  assert.equal(body.profile, undefined, 'aucun profil sans jeton');
  assert.match(body.notice, /DISCORD_TOKEN/);
});

test('api : saisie invalide → 400, et l’explication attendue', async () => {
  const bad = await ask('id=abc');
  assert.equal(bad.status, 400);
  assert.equal(bad.body.ok, false);
  assert.match(bad.body.hint, /17 to 20 digits/);

  const empty = await ask('id=');
  assert.equal(empty.status, 400);
  assert.match(empty.body.error, /No Discord user ID/);

  // une mention fonctionne aussi bien qu'un nombre nu
  const mention = await ask('id=' + encodeURIComponent('<@!' + KNOWN + '>'));
  assert.equal(mention.status, 200);
  assert.equal(mention.body.id, KNOWN);
});

test('api : profil complet, drapeaux décodés, visuels et débit relayé', async () => {
  const { status, body } = await ask('id=' + KNOWN);
  assert.equal(status, 200);
  assert.equal(body.ok, true);
  assert.equal(body.mode, 'online');
  assert.equal(body.token, true);
  assert.equal(body.source, 'Discord API v10');
  assert.equal(typeof body.elapsed, 'number');

  assert.deepEqual(body.user, USER, 'l’objet brut de Discord est rendu tel quel');
  assert.equal(body.profile.display, 'Wumpus');
  assert.deepEqual(body.profile.flags.list.map((flag) => flag.name),
    ['Discord Employee', 'Active Developer']);
  assert.equal(body.profile.accentColor, '#7289da');
  assert.match(body.profile.assets.avatar, /^https:\/\/cdn\.discordapp\.com\/avatars\//);
  assert.equal(body.profile.created.date.iso, '2016-04-30T11:18:25.796Z');
  assert.equal(body.ratelimit.remaining, 4, 'les compteurs de débit de Discord sont relayés');
  assert.equal(body.ratelimit.bucket, 'bucket-1');
  assert.equal(body.guilds.enabled, false, 'les serveurs communs restent opt-in');

  // le jeton reste sur le serveur : jamais dans la réponse
  assert.ok(!JSON.stringify(body).includes('test-token'), 'le jeton a fui dans la réponse');
  const call = seen.find((entry) => entry.url === '/users/' + KNOWN);
  assert.equal(call.auth, 'Bot test-token', 'le serveur s’authentifie avec le jeton bot');
  assert.match(call.agent, /zach-db/, 'Discord exige un user-agent');
});

test('api : taille des visuels, serveurs communs, rôles et pseudos', async () => {
  const { status, body } = await ask('id=' + KNOWN + '&guilds=1&size=256');
  assert.equal(status, 200);
  assert.match(body.profile.assets.avatar, /\?size=256$/);

  assert.equal(body.guilds.enabled, true);
  assert.equal(body.guilds.total, 2, 'le bot est dans deux serveurs');
  assert.equal(body.guilds.checked, 2);
  assert.equal(body.guilds.mutual.length, 1, 'un seul compte ce membre');
  const [member] = body.guilds.mutual;
  assert.equal(member.guild.name, 'zach-db');
  assert.equal(member.nick, 'zach');
  assert.deepEqual(member.roles.map((role) => role.name), ['Moderator', 'Member']);
  assert.equal(member.joinedAt, MEMBER.joined_at);
  assert.equal(body.guilds.stopped, null);
});

test('api : inconnu, jeton refusé et limite de débit sont dits clairement', async () => {
  const missing = await ask('id=' + UNKNOWN);
  assert.equal(missing.status, 404);
  assert.equal(missing.body.ok, false);
  assert.equal(missing.body.code, 10013);
  assert.match(missing.body.error, /Unknown User/);
  assert.equal(missing.body.snowflake.valid, true, 'le flocon reste décodé même si le compte a disparu');

  refuseToken = true;
  const refused = await ask('id=' + KNOWN);
  refuseToken = false;
  assert.equal(refused.status, 502);
  assert.match(refused.body.error, /refused the token/);
  assert.match(refused.body.error, /DISCORD_TOKEN/);

  rateLimitOnce = true;
  const limited = await ask('id=' + KNOWN);
  assert.equal(limited.status, 429);
  assert.equal(limited.body.retry_after, 0.5, 'le délai demandé par Discord est relayé');

  const method = await fetch(base + '/api/discord/user', { method: 'POST', body: 'id=1' });
  assert.equal(method.status, 405);
  await method.text();
});

test('api : la table des drapeaux, et l’état du jeton dans /api/health', async () => {
  const flags = await (await fetch(base + '/api/discord/flags')).json();
  assert.equal(flags.epoch, EPOCH);
  assert.equal(flags.api, 10);
  assert.equal(flags.flags.length, PUBLIC_FLAGS.length);
  assert.equal(flags.premium[2], 'Nitro');
  assert.deepEqual(flags, flagTable());

  const health = await (await fetch(base + '/api/health')).json();
  assert.equal(health.discord, true, 'health dit si un jeton est configuré');
  assert.ok(!JSON.stringify(health).includes('test-token'));
});

test('api : la page de l’outil est servie, et le menu la cite', async () => {
  const page = await fetch(base + '/tools/discord-lookup/');
  assert.equal(page.status, 200);
  const html = await page.text();
  assert.match(html, /<html lang="en">/);
  assert.match(html, /id="lookupForm"/, 'le formulaire est dans la page');
  assert.match(html, /<script src="\/lookup.js" type="module">/);

  const moved = await fetch(base + '/tools/discord-lookup', { redirect: 'manual' });
  assert.equal(moved.status, 301, 'sans slash final, on redirige');
  assert.equal(moved.headers.get('location'), '/tools/discord-lookup/');

  for (const file of ['/lookup.js', '/lib/discord.js', '/lib/discord-api.js']) {
    const asset = await fetch(base + file);
    assert.equal(asset.status, 200, file);
    assert.match(asset.headers.get('content-type'), /javascript/, file);
    assert.ok((await asset.text()).length > 0, file);
  }
});

test('api : garde-fou de débit, pour ne pas user le jeton du serveur', async () => {
  // les identifiants invalides n'atteignent pas Discord : la boucle est gratuite
  const limit = Number(process.env.DISCORD_RATE_MAX);
  let refused = 0;
  for (let i = 0; i < limit + 4; i++) {
    const { status, body } = await ask('id=nope');
    if (status === 429) {
      refused += 1;
      assert.ok(body.retry_after >= 1, 'le délai à attendre est annoncé');
      assert.match(body.error, /Too many lookups/);
    }
  }
  assert.ok(refused >= 3, 'au-delà de ' + limit + ' recherches par minute, la route refuse : ' + refused);
});
