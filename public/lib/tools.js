/*
 * zach-db — registre des outils.
 *
 * Une seule source de vérité : la page d'accueil (cartes), le sélecteur d'outil
 * de l'en-tête (public/chrome.js) et GET /api/tools lisent cette liste.
 *
 * Ajouter un outil :
 *   1. une entrée ici (id, nom, chemin, statut…) ;
 *   2. la page public/tools/<id>/index.html ;
 *   3. sa carte dans public/index.html (le test test/tools.test.js vérifie
 *      que la carte et le registre sont d'accord).
 *
 * Aucun import : ce fichier est lu à la fois par le navigateur (module ES) et
 * par le serveur Node.
 */

/** Statuts possibles d'un outil. */
export const STATUS = ['available', 'soon'];

export const TOOLS = [
  {
    id: 'group-by-site',
    name: 'Combos — group by site',
    short: 'Group by site',
    tagline: 'Sort huge .txt dumps by site, then pull out the values of any site you click.',
    description:
      'Each line is read once in a Web Worker: the site is detected (subdomains grouped), ' +
      'the xxxx:xxxx pair is extracted, and the counters are displayed live. Click a site to ' +
      'read the file a second time and stream only its values.',
    path: '/tools/group-by-site/',
    status: 'available',
    tags: ['web worker', 'line-by-line streaming', 'dedupe per site', 'custom regex'],
    input: '.txt files — drag and drop, several at once',
    output: 'one .txt per site, or the whole site list',
    speed: '~70 MB/s',
    api: '/api/group',
    cli: 'node cli.js file.txt --group',
    points: [
      'Sites sorted by weight, listed while the file is being read',
      'Modes: last pair, first, longest, all, or your own regex',
      'Nothing is uploaded: the file never leaves the browser',
    ],
  },
  {
    id: 'discord-lookup',
    name: 'Discord lookup',
    short: 'Discord lookup',
    tagline: 'Paste a user ID and read everything Discord exposes: profile, badges, assets, creation date, mutual servers.',
    description:
      'A user ID, a mention or a profile URL is enough. The snowflake is decoded on the spot — creation date, ' +
      'internal worker, increment — then the server asks Discord with its own bot token and returns the whole ' +
      'user object: names, public flags, banner, accent colour, CDN assets, and on demand the servers the bot ' +
      'shares with that account, with nicknames, join dates and role names.',
    path: '/tools/discord-lookup/',
    status: 'available',
    tags: ['snowflake decode', 'public flags', 'cdn assets', 'mutual servers'],
    input: 'a Discord user ID, a mention, or a profile URL',
    output: 'the profile card, the decoded snowflake, and the raw JSON',
    speed: '~1 API call · 300 ms',
    api: '/api/discord/user',
    cli: 'node cli.js discord 175928847299117063',
    points: [
      'Creation date, worker and increment read from the ID alone — no token, no network',
      'With a bot token on the server: names, badges, avatar, banner, accent colour, Nitro, locale',
      'Mutual servers with nicknames, join dates and role names, one request per server',
      'The token never reaches the browser: the server proxies every call to Discord',
    ],
  },
];

/** Outils utilisables dès maintenant. */
export const availableTools = () => TOOLS.filter((tool) => tool.status === 'available');

/** Chemin normalisé : slash final, sans query ni hash. */
export function normalizePath(pathname) {
  const clean = String(pathname || '/').split('?')[0].split('#')[0];
  return clean.length > 1 && !clean.endsWith('/') ? clean + '/' : clean || '/';
}

/** L'outil affiché à ce chemin, ou null (page d'accueil, 404…). */
export function findToolByPath(pathname) {
  const target = normalizePath(pathname);
  return TOOLS.find((tool) => normalizePath(tool.path) === target) || null;
}

/** L'outil portant cet identifiant, ou null. */
export function findToolById(id) {
  return TOOLS.find((tool) => tool.id === id) || null;
}
