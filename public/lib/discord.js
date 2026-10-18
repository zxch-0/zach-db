/*
 * zach-db — tout ce que raconte un identifiant Discord.
 *
 * Module isomorphe : le serveur l'utilise pour parler à l'API Discord
 * (route /api/discord/user), la page l'utilise pour décoder un identifiant
 * sans aucun réseau, la CLI l'importe aussi, et les tests le vérifient sur des
 * vecteurs connus. Aucun import, aucun DOM, aucun fetch : que des calculs.
 *
 * Un identifiant Discord est un « flocon de neige » (snowflake), un entier
 * 64 bits composé ainsi :
 *
 *   bits 63..22   millisecondes écoulées depuis l'epoch Discord (2015-01-01)
 *   bits 21..17   identifiant interne du worker qui a émis l'identifiant
 *   bits 16..12   identifiant interne du processus
 *   bits 11..0    incrément, +1 à chaque identifiant émis par ce processus
 *
 * La date de création du compte se lit donc dans l'identifiant seul : c'est la
 * partie de cet outil qui fonctionne toujours, même sans jeton ni réseau.
 */

/** Epoch Discord : 2015-01-01T00:00:00.000Z, en millisecondes. */
export const EPOCH = 1420070400000;

/** Version d'API utilisée par le serveur. */
export const API_VERSION = 10;

/** Hôtes officiels (jamais construits à partir d'une saisie utilisateur). */
export const CDN = 'https://cdn.discordapp.com';
export const PROFILE = 'https://discord.com/users/';

/** Découpage du flocon, dans l'ordre des bits (pour l'affichage). */
export const SNOWFLAKE_LAYOUT = [
  { name: 'timestamp', bits: 42 },
  { name: 'worker', bits: 5 },
  { name: 'process', bits: 5 },
  { name: 'increment', bits: 12 },
];

/* ==================================================================
 * Identifiants
 * ================================================================== */

/**
 * Retrouve un identifiant dans une saisie libre : nombre nu, mention
 * (<@123>, <@!123>), ou adresse de profil / de message copiée depuis
 * Discord. Renvoie la chaîne de chiffres, ou null.
 */
export function extractId(input) {
  const text = String(input == null ? '' : input).trim();
  if (!text) return null;

  const mention = text.match(/<@!?(\d{15,25})>/);
  if (mention) return mention[1];

  const link = text.match(
    /(?:discord(?:app)?\.com|discord\.gg|discord\.media)\/\S*?(?:users|members|profile)\/(\d{15,25})/
  );
  if (link) return link[1];

  const bare = text.match(/(\d{15,25})/);
  return bare ? bare[1] : null;
}

/** Format ISO 8601 d'une date de création, et ses morceaux lisibles. */
export function formatDate(timestamp) {
  const date = new Date(timestamp);
  const iso = date.toISOString();
  return {
    iso,
    utc: date.toUTCString(),
    day: iso.slice(0, 10),
    time: iso.slice(11, 19),
    unix: Math.floor(timestamp / 1000),
  };
}

/**
 * Âge d'un compte : durée complète (années, mois, jours) plus les totaux.
 * `text` est la phrase affichée, `short` la forme compacte.
 */
export function formatAge(timestamp, now = Date.now()) {
  const ms = Math.max(0, now - timestamp);
  const from = new Date(timestamp);
  const to = new Date(now);

  let years = to.getUTCFullYear() - from.getUTCFullYear();
  let months = to.getUTCMonth() - from.getUTCMonth();
  let days = to.getUTCDate() - from.getUTCDate();
  if (days < 0) {
    months -= 1;
    // nombre de jours du mois précédent
    days += new Date(Date.UTC(to.getUTCFullYear(), to.getUTCMonth(), 0)).getUTCDate();
  }
  if (months < 0) {
    years -= 1;
    months += 12;
  }

  const parts = [];
  if (years) parts.push(years + (years === 1 ? ' year' : ' years'));
  if (months) parts.push(months + (months === 1 ? ' month' : ' months'));
  if (days || !parts.length) parts.push(days + (days === 1 ? ' day' : ' days'));

  const compact = [];
  if (years) compact.push(years + 'y');
  if (months) compact.push(months + 'mo');
  if (days || !compact.length) compact.push(days + 'd');

  return {
    ms,
    seconds: Math.floor(ms / 1000),
    minutes: Math.floor(ms / 60000),
    hours: Math.floor(ms / 3600000),
    days: Math.floor(ms / 86400000),
    years,
    months,
    calendarDays: days,
    text: parts.join(', '),
    short: compact.join(' '),
  };
}

/**
 * Décompose un flocon de neige. `valid` reste faux si la chaîne n'est pas un
 * identifiant Discord plausible (trop court, ou daté avant/après l'epoch).
 */
export function decodeSnowflake(input) {
  const id = extractId(input);
  const base = { id: id || String(input == null ? '' : input), valid: false };
  if (!id) return { ...base, reason: 'no id' };

  let value;
  try {
    value = BigInt(id);
  } catch {
    return { ...base, reason: 'not a number' };
  }

  const timestamp = Number((value >> 22n) + BigInt(EPOCH));
  const worker = Number((value & 0x3e0000n) >> 17n);
  const process = Number((value & 0x1f000n) >> 12n);
  const increment = Number(value & 0xfffn);
  const binary = value.toString(2).padStart(64, '0');

  if (timestamp < EPOCH || timestamp > Date.now() + 86400000) {
    return { ...base, reason: 'out of range', timestamp, binary, worker, process, increment };
  }

  // chaque tranche de bits, pour dessiner la règle du flocon
  let cursor = 0;
  const segments = SNOWFLAKE_LAYOUT.map((part) => {
    const slice = binary.slice(cursor, cursor + part.bits);
    cursor += part.bits;
    return { ...part, binary: slice, value: parseInt(slice, 2) };
  });

  return {
    id,
    valid: true,
    epoch: EPOCH,
    timestamp,
    date: formatDate(timestamp),
    age: formatAge(timestamp),
    worker,
    process,
    increment,
    binary,
    hex: '0x' + value.toString(16).toUpperCase(),
    bigint: value.toString(),
    segments,
  };
}

/* ==================================================================
 * Drapeaux publics, Nitro, couleur d'accent
 * ================================================================== */

/**
 * Drapeaux publics documentés (champ `public_flags`). Les bits non listés
 * sont signalés à part plutôt qu'inventés : l'outil ne devine rien.
 */
export const PUBLIC_FLAGS = [
  { bit: 0, id: 'staff', name: 'Discord Employee', label: 'Works at Discord' },
  { bit: 1, id: 'partner', name: 'Partnered Server Owner', label: 'Owns a partnered server' },
  { bit: 2, id: 'hypesquad_events', name: 'HypeSquad Events', label: 'Attended a HypeSquad event in person' },
  { bit: 3, id: 'bug_hunter_1', name: 'Bug Hunter', label: 'Acknowledged bug report — level 1' },
  { bit: 6, id: 'bravery', name: 'HypeSquad Bravery', label: 'Online house 1' },
  { bit: 7, id: 'brilliance', name: 'HypeSquad Brilliance', label: 'Online house 2' },
  { bit: 8, id: 'balance', name: 'HypeSquad Balance', label: 'Online house 3' },
  { bit: 9, id: 'premium_early_supporter', name: 'Early Nitro Supporter', label: 'Subscribed to Nitro before 10 October 2018' },
  { bit: 10, id: 'team_pseudo_user', name: 'Team Account', label: 'Account owned by a developer team' },
  { bit: 14, id: 'bug_hunter_2', name: 'Bug Hunter', label: 'Acknowledged bug report — level 2' },
  { bit: 16, id: 'verified_bot', name: 'Verified Bot', label: 'Public bot approved by Discord' },
  { bit: 17, id: 'verified_developer', name: 'Early Verified Bot Developer', label: 'Passed the bot verification gate early' },
  { bit: 18, id: 'certified_moderator', name: 'Certified Moderator', label: 'Alumni of the moderator programs' },
  { bit: 19, id: 'bot_http_interactions', name: 'HTTP Interactions Bot', label: 'Answers interactions over HTTP only' },
  { bit: 22, id: 'active_developer', name: 'Active Developer', label: 'Has at least one active application' },
];

/** Types d'abonnement Nitro (`premium_type`, visible pour le bot lui-même). */
export const PREMIUM_TYPES = {
  0: 'None',
  1: 'Nitro Classic',
  2: 'Nitro',
  3: 'Nitro Basic',
};

/** Décode un champ de bits en liste de drapeaux, sans rien inventer. */
export function decodeFlags(raw) {
  const bits = Number(raw) || 0;
  const list = [];
  let rest = bits;
  for (const flag of PUBLIC_FLAGS) {
    const value = 1 << flag.bit;
    if ((bits & value) === value) {
      list.push({ ...flag, value });
      rest &= ~value;
    }
  }
  const unknown = [];
  for (let bit = 0; bit < 32 && rest; bit++) {
    if ((rest & (1 << bit)) === 0) continue;
    unknown.push({ bit, value: 1 << bit });
    rest &= ~(1 << bit);
  }
  return { raw: bits, count: list.length, list, unknown };
}

/** `accent_color` (entier 0xRRGGBB) en notation CSS, ou null. */
export function accentHex(accentColor) {
  if (accentColor === null || accentColor === undefined || accentColor === '') return null;
  const value = Number(accentColor);
  if (!Number.isFinite(value) || value < 0 || value > 0xffffff) return null;
  return '#' + value.toString(16).padStart(6, '0');
}

/** Nom de l'abonnement Nitro, ou null si le champ est absent. */
export function premiumOf(premiumType) {
  if (premiumType === null || premiumType === undefined) return null;
  return { type: Number(premiumType), name: PREMIUM_TYPES[Number(premiumType)] || 'Unknown' };
}

/* ==================================================================
 * Adresses des visuels (règles officielles du CDN)
 * ================================================================== */

const sizeParam = (size) => '?size=' + Math.min(4096, Math.max(16, Number(size) || 1024));
const isAnimated = (hash) => typeof hash === 'string' && hash.startsWith('a_');

/**
 * Avatar par défaut quand le compte n'en a pas : l'index vient de
 * l'identifiant (comptes « pomelo ») ou du discriminateur à 4 chiffres
 * (anciens comptes).
 */
export function defaultAvatar(id, discriminator = '0') {
  const legacy = /^\d{4}$/.test(String(discriminator)) && String(discriminator) !== '0000';
  let index;
  if (legacy) index = Number(discriminator) % 5;
  else index = Number((BigInt(extractId(id) || '0') >> 22n) % 6n);
  return CDN + '/embed/avatars/' + index + '.png';
}

/** Toutes les adresses de visuels d'un utilisateur, prêtes à afficher. */
export function assetUrls(user, size = 1024) {
  const id = String((user && user.id) || '');
  const avatar = user && user.avatar ? String(user.avatar) : null;
  const banner = user && user.banner ? String(user.banner) : null;
  const decoration = user && user.avatar_decoration_data && user.avatar_decoration_data.asset
    ? String(user.avatar_decoration_data.asset)
    : null;

  const assets = {
    avatar: null,
    avatarPng: null,
    avatarGif: null,
    avatarWebp: null,
    avatarDefault: id ? defaultAvatar(id, (user && user.discriminator) || '0') : null,
    avatarAnimated: avatar ? isAnimated(avatar) : false,
    banner: null,
    bannerPng: null,
    bannerGif: null,
    bannerAnimated: banner ? isAnimated(banner) : false,
    decoration: null,
    decorationSku: (user && user.avatar_decoration_data && user.avatar_decoration_data.sku_id) || null,
    profile: id ? PROFILE + id : null,
    mention: id ? '<@' + id + '>' : null,
  };

  if (avatar) {
    const stem = CDN + '/avatars/' + id + '/' + avatar;
    assets.avatar = stem + '.' + (assets.avatarAnimated ? 'gif' : 'png') + sizeParam(size);
    assets.avatarPng = stem + '.png' + sizeParam(size);
    assets.avatarWebp = stem + '.webp' + sizeParam(size);
    if (assets.avatarAnimated) assets.avatarGif = stem + '.gif' + sizeParam(size);
  }
  if (banner) {
    const stem = CDN + '/banners/' + id + '/' + banner;
    assets.banner = stem + '.' + (assets.bannerAnimated ? 'gif' : 'png') + sizeParam(size);
    assets.bannerPng = stem + '.png' + sizeParam(size);
    if (assets.bannerAnimated) assets.bannerGif = stem + '.gif' + sizeParam(size);
  }
  if (decoration) {
    assets.decoration = CDN + '/avatar-decoration-presets/' + decoration + '.png' + sizeParam(size);
  }
  return assets;
}

/* ==================================================================
 * Vue normalisée d'un utilisateur
 * ================================================================== */

/**
 * Transforme l'objet brut renvoyé par Discord en la vue affichée par la page
 * (mêmes champs côté serveur, côté page et côté CLI : une seule vérité).
 */
export function describeUser(user, { size = 1024 } = {}) {
  if (!user || typeof user !== 'object' || !user.id) return null;
  const id = String(user.id);
  const discriminator = user.discriminator == null ? '0' : String(user.discriminator);
  const legacy = /^\d{4}$/.test(discriminator) && discriminator !== '0000';
  const flags = decodeFlags(user.public_flags == null ? user.flags : user.public_flags);

  return {
    id,
    username: user.username == null ? null : String(user.username),
    globalName: user.global_name == null ? null : String(user.global_name),
    display: user.global_name || user.username || id,
    discriminator,
    legacyTag: legacy && user.username ? user.username + '#' + discriminator : null,
    mention: '<@' + id + '>',
    url: PROFILE + id,
    bot: Boolean(user.bot),
    system: Boolean(user.system),
    mfa: user.mfa_enabled === undefined ? null : Boolean(user.mfa_enabled),
    verified: user.verified === undefined ? null : Boolean(user.verified),
    locale: user.locale == null ? null : String(user.locale),
    email: user.email == null ? null : String(user.email),
    accentColor: accentHex(user.accent_color),
    premium: premiumOf(user.premium_type),
    flags,
    avatarHash: user.avatar == null ? null : String(user.avatar),
    bannerHash: user.banner == null ? null : String(user.banner),
    decoration: user.avatar_decoration_data || null,
    primaryGuild: user.primary_guild || null,
    assets: assetUrls(user, size),
    created: decodeSnowflake(id),
  };
}

/** Un membre trouvé dans un serveur commun, aplati pour l'affichage. */
export function describeMember(member, guild, roles) {
  const byId = new Map((roles || []).map((role) => [String(role.id), role]));
  const list = ((member && member.roles) || []).map((id) => byId.get(String(id))).filter(Boolean);
  return {
    guild: guild ? { id: String(guild.id), name: guild.name, icon: guild.icon || null } : null,
    nick: (member && member.nick) || null,
    guildAvatar: (member && member.avatar) || null,
    joinedAt: (member && member.joined_at) || null,
    premiumSince: (member && member.premium_since) || null,
    pending: Boolean(member && member.pending),
    mutedUntil: (member && member.communication_disabled_until) || null,
    roles: list
      .filter((role) => role.id !== String(guild && guild.id) && role.name !== '@everyone')
      .sort((a, b) => (b.position || 0) - (a.position || 0))
      .map((role) => ({
        id: String(role.id),
        name: role.name,
        position: role.position,
        color: accentHex(role.color),
        hoist: Boolean(role.hoist),
        managed: Boolean(role.managed),
      })),
  };
}
