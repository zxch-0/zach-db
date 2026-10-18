/*
 * zach-db — client Discord, partagé par le serveur et la CLI.
 *
 * Une seule fonction publique, `lookup()` : elle rend la réponse complète
 * (statut HTTP compris) que la route /api/discord/user renvoie telle quelle et
 * que la CLI met en page. Le jeton ne quitte jamais le serveur : c'est lui qui
 * parle à Discord, le navigateur ne reçoit que le résultat.
 *
 * Endpoints utilisés (API v10, authentification « Bot ») :
 *   GET /users/{id}                          l'utilisateur, ses drapeaux, ses visuels
 *   GET /users/@me/guilds                    les serveurs où le bot est présent
 *   GET /guilds/{id}/members/{user.id}       ce compte est-il membre ? (404 = non)
 *   GET /guilds/{id}/roles                   les noms des rôles du membre
 *
 * Zéro dépendance : `fetch` et `AbortSignal.timeout` sont fournis par Node 18+.
 */
import {
  API_VERSION,
  decodeSnowflake,
  describeMember,
  describeUser,
  extractId,
  PUBLIC_FLAGS,
  PREMIUM_TYPES,
  EPOCH,
} from './discord.js';

export const DEFAULT_API = 'https://discord.com/api/v' + API_VERSION;

/** Environnement lisible aussi dans un navigateur (où `process` n'existe pas). */
const env = typeof process !== 'undefined' && process.env ? process.env : {};

/** Nombre de serveurs examinés au plus quand on cherche les serveurs communs. */
export const GUILD_CAP = Number(env.DISCORD_GUILD_CAP) || 40;

/**
 * Configuration lue à chaque appel : un jeton posé après le démarrage du
 * serveur est pris en compte sans redémarrer.
 */
export function config(overrides = {}) {
  const token = String(
    overrides.token || env.DISCORD_TOKEN || env.DISCORD_BOT_TOKEN || env.ZACH_DB_DISCORD_TOKEN || ''
  ).trim();
  const api = String(overrides.api || env.DISCORD_API_BASE || DEFAULT_API).replace(/\/+$/, '');
  return {
    token,
    api,
    timeout: Number(overrides.timeout || env.DISCORD_TIMEOUT_MS) || 8000,
    guildCap: Number(overrides.guildCap || GUILD_CAP) || 40,
  };
}

/** Erreur portant le statut HTTP à renvoyer au client. */
export class DiscordError extends Error {
  constructor(status, message, extra = {}) {
    super(message);
    this.name = 'DiscordError';
    this.status = status;
    Object.assign(this, extra);
  }
}

/** Les compteurs de débit renvoyés par Discord, quand ils sont là. */
function rateLimitOf(headers) {
  if (!headers || typeof headers.get !== 'function') return null;
  const limit = headers.get('x-ratelimit-limit');
  if (limit === null) return null;
  return {
    limit: Number(limit),
    remaining: Number(headers.get('x-ratelimit-remaining')),
    reset: Number(headers.get('x-ratelimit-reset')),
    bucket: headers.get('x-ratelimit-bucket'),
    global: headers.get('x-ratelimit-global') === 'true',
  };
}

/** Un appel GET à l'API Discord : jeton bot, délai, erreur normalisée. */
export async function get(pathname, cfg) {
  let response;
  try {
    response = await fetch(cfg.api + pathname, {
      headers: {
        authorization: 'Bot ' + cfg.token,
        accept: 'application/json',
        'user-agent': 'DiscordBot (https://github.com/zxch-0/zach-db, 1.0.0)',
      },
      signal: typeof AbortSignal !== 'undefined' && AbortSignal.timeout
        ? AbortSignal.timeout(cfg.timeout)
        : undefined,
    });
  } catch (err) {
    const reason = err && err.name === 'TimeoutError'
      ? 'timeout after ' + cfg.timeout + ' ms'
      : (err && err.message) || 'network error';
    throw new DiscordError(504, 'Discord API unreachable: ' + reason);
  }

  const ratelimit = rateLimitOf(response.headers);
  const text = await response.text();
  let body = null;
  if (text) {
    try {
      body = JSON.parse(text);
    } catch {
      body = text;
    }
  }

  if (!response.ok) {
    const detail = body && typeof body === 'object' ? body : {};
    const message = detail.message || response.statusText || 'HTTP ' + response.status;
    if (response.status === 429) {
      throw new DiscordError(429, 'Rate limited by Discord', {
        retryAfter: Number(detail.retry_after) || 1, code: detail.code, ratelimit,
      });
    }
    if (response.status === 401 || response.status === 403) {
      throw new DiscordError(502,
        'Discord refused the token (' + response.status + ' ' + message + ') — check DISCORD_TOKEN',
        { code: detail.code, ratelimit });
    }
    if (response.status === 404) {
      throw new DiscordError(404, message === 'Unknown User' ? 'Unknown User' : message,
        { code: detail.code, ratelimit });
    }
    throw new DiscordError(response.status >= 500 ? 502 : response.status, message,
      { code: detail.code, ratelimit });
  }
  return { body, ratelimit };
}

/** L'utilisateur, ou une erreur DiscordError. */
export async function fetchUser(id, cfg) {
  const { body, ratelimit } = await get('/users/' + id, cfg);
  return { user: body, ratelimit };
}

/**
 * Serveurs communs : le bot interroge chaque serveur où il se trouve et garde
 * ceux où le compte est membre. Coûteux (une requête par serveur), donc
 * plafonné et arrêté net dès que Discord signale un dépassement de débit.
 */
export async function scanGuilds(userId, cfg) {
  const result = { enabled: true, total: 0, checked: 0, mutual: [], stopped: null, errors: [] };

  let guilds;
  try {
    guilds = (await get('/users/@me/guilds?limit=200', cfg)).body;
  } catch (err) {
    result.stopped = err.message;
    return result;
  }
  if (!Array.isArray(guilds)) {
    result.stopped = 'unexpected answer from /users/@me/guilds';
    return result;
  }

  result.total = guilds.length;
  const cap = Math.min(guilds.length, cfg.guildCap);
  for (const guild of guilds.slice(0, cap)) {
    result.checked += 1;
    try {
      const member = (await get('/guilds/' + guild.id + '/members/' + userId, cfg)).body;
      let roles = [];
      try {
        roles = (await get('/guilds/' + guild.id + '/roles', cfg)).body || [];
      } catch {
        // les noms de rôles sont un confort : sans eux, le membre reste affiché
      }
      result.mutual.push(describeMember(member, guild, roles));
    } catch (err) {
      if (err.status === 429) {
        result.stopped = 'rate limited by Discord after ' + result.checked + ' servers (retry in ' +
          err.retryAfter + ' s)';
        break;
      }
      if (err.status === 404 || err.status === 403) continue; // pas membre, ou pas d'accès
      result.errors.push(guild.id + ': ' + err.message);
      if (result.errors.length >= 5) {
        result.stopped = 'stopped after 5 errors';
        break;
      }
    }
  }
  if (!result.stopped && guilds.length > cap) {
    result.stopped = 'first ' + cap + ' of ' + guilds.length + ' servers checked (DISCORD_GUILD_CAP)';
  }
  return result;
}

/**
 * La recherche complète. Renvoie toujours un objet prêt à être envoyé :
 * `status` pour la réponse HTTP, le reste pour le corps.
 *
 * Sans jeton, l'outil ne se bloque pas : il rend tout ce que l'identifiant
 * raconte (date de création, worker, incrément, adresses de visuels par défaut)
 * avec `mode: 'offline'`.
 */
export async function lookup(input, options = {}) {
  const cfg = config(options);
  const started = Date.now();
  const raw = input == null ? '' : String(input);
  const id = extractId(raw);
  const snowflake = decodeSnowflake(id || raw);

  if (!id || !snowflake.valid) {
    return {
      status: 400,
      ok: false,
      mode: 'invalid',
      error: id ? 'That number is not a Discord snowflake' : 'No Discord user ID found in the input',
      hint: 'Expected 17 to 20 digits, a mention like <@175928847299117063>, or a profile URL',
      input: raw.slice(0, 200),
      snowflake,
    };
  }

  const size = Math.min(4096, Math.max(16, Number(options.size) || 1024));
  const base = {
    id,
    snowflake,
    size,
    source: 'Discord API v' + API_VERSION,
    epoch: EPOCH,
    token: Boolean(cfg.token),
    fetchedAt: new Date().toISOString(),
  };

  if (!cfg.token) {
    return {
      ...base,
      status: 200,
      ok: true,
      mode: 'offline',
      elapsed: Date.now() - started,
      notice: 'No DISCORD_TOKEN on the server: everything below is decoded from the ID itself. ' +
        'Set a bot token to fetch the live profile, badges and assets.',
    };
  }

  let user;
  let ratelimit = null;
  try {
    const answer = await fetchUser(id, cfg);
    user = answer.user;
    ratelimit = answer.ratelimit;
  } catch (err) {
    if (!(err instanceof DiscordError)) throw err;
    return {
      ...base,
      status: err.status,
      ok: false,
      mode: 'error',
      error: err.message,
      code: err.code == null ? null : err.code,
      retry_after: err.retryAfter == null ? null : err.retryAfter,
      ratelimit: err.ratelimit || ratelimit,
      elapsed: Date.now() - started,
    };
  }

  const profile = describeUser(user, { size });
  const guilds = options.guilds ? await scanGuilds(id, cfg) : { enabled: false, total: 0, checked: 0, mutual: [], stopped: null, errors: [] };

  return {
    ...base,
    status: 200,
    ok: true,
    mode: 'online',
    user,
    profile,
    guilds,
    ratelimit,
    elapsed: Date.now() - started,
  };
}

/** La table des drapeaux, pour la documentation et la page. */
export function flagTable() {
  return { epoch: EPOCH, api: API_VERSION, flags: PUBLIC_FLAGS, premium: PREMIUM_TYPES };
}
