# zach-db

**tools by zach** — un regroupement d'outils.
La page d'accueil est une **vitrine** : fond noir animé, logo, instruments
dessinés sur canvas. Aucun outil n'y est cité — la seule porte d'entrée est le
**menu déroulant** en haut de chaque page. Trois outils sont en ligne :

- **Combos, trier par site** — extraction ultra-rapide de morceaux `xxxx:xxxx`
  dans de gros `.txt`, et tri de ces lignes par site ;
- **Discord lookup** — tout ce que raconte un identifiant Discord : le flocon
  décodé (date de création, worker, incrément), puis le profil complet, les
  badges, les visuels et les serveurs communs via l'API officielle ;
- **Guns.lol views** — gonfle le compteur de vues d'un profil guns.lol avec des
  proxys publics gratuits : récolte, test au tunnel, puis envoi de vraies
  requêtes de vue, une par adresse.

Site moderne et sobre : noir et blanc, aucun emoji, aucune police externe,
aucun framework, aucune dépendance npm — le décor (grille en perspective,
noyau filaire, oscilloscope, halos lents, bandeau défilant, fil de lecture,
apparitions au défilement) est fait de CSS, de SVG et de canvas, jamais
d'images. L'accueil est noir imposé ; les pages d'outil suivent le thème du
système. Tout s'arrête si le système demande moins de mouvement.
Une barre de progression suit l'avancement du traitement, ligne à ligne.

**Outil en ligne — Combos, trier par site** (`/tools/group-by-site/`)

~~~
entrée :  https://www.roblox.com/x:Thou_miriba:N2Z6PQXg4XLnTSi
          http://www.netflix.com/y:user1:pass1
          https://account.roblox.com/z:user2:pass2

liste :   roblox.com    2 valeurs
          netflix.com   1 valeur

clic sur "roblox.com" → Thou_miriba:N2Z6PQXg4XLnTSi
                        user2:pass2
~~~

**Outil en ligne — Discord lookup** (`/tools/discord-lookup/`)

~~~
entrée :  175928847299117063        (ou <@175928847299117063>, ou l'URL du profil)

flocon :  créé le 2016-04-30T11:18:25.796Z · 10 ans, 5 mois, 18 jours
          42 bits d'horodatage · worker 1 · process 0 · incrément 7

profil :  Wumpus (@wumpus) · 2FA · Nitro · #7289da
 (jeton)  badges : Discord Employee, Active Developer
          avatar, bannière, décoration → adresses du CDN prêtes à copier
          serveurs communs : pseudo, date d'arrivée, rôles
~~~

**Outil en ligne — Guns.lol views** (`/tools/guns-views/`)

~~~
entrée :  https://guns.lol/zach   (ou « zach », ou « @zach »)

proxys :  2417 récoltés · 118 testés · 21 utilisables · 97 morts
couches : page 20/20 · pixel 20/20 · view 19/20 · événement 12/20
résultat: 19 vues acceptées sur 20 tentées, en 34 s
~~~

## Le site : une vitrine, un menu, des outils

~~~
/                          accueil : la vitrine (fond noir animé, aucun outil cité)
/tools/group-by-site/      l'outil « Combos — trier par site »
/tools/discord-lookup/     l'outil « Discord lookup »
/tools/guns-views/         l'outil « Guns.lol views »
/api/tools                 le registre des outils, en JSON
/api/group, /api/extract   les API du tri par site
/api/discord/user          le profil Discord complet (?id=, ?guilds=1, ?size=)
/api/discord/flags         la table des drapeaux publics décodés
/api/guns/views            les vues guns.lol (?user=, ?views=, ?rounds=, ?direct=1)
/api/guns/proxies          la réserve de proxys : sources, compteurs, test
~~~

**L'accueil** ne présente aucun outil : c'est la vitrine du site. Fond noir
imposé (`html.void`, quel que soit le thème du système), et par-dessus, trois
calques dessinés en direct par `public/home.js` avec un seul
`requestAnimationFrame` :

- **le vide** — une grille en perspective qui défile vers l'horizon, de la
  poussière qui se relie au curseur, un halo doux ;
- **le noyau** — une sphère filaire (12 parallèles × 36 sommets) qui tourne et
  se penche vers le pointeur, balayée par un anneau de lecture, le logo au
  centre ;
- **le signal** — un oscilloscope pleine largeur (bruit lissé, encre qui goutte
  du haut vers la courbe, balayage vertical), que le curseur soulève en passant.

S'y ajoutent une ligne monospace qui **se décode** caractère par caractère
(`TOOLS BY ZACH`), une **télémétrie** vivante (heure locale, images/s,
poussière, pointeur, temps écoulé), un bandeau défilant et un balayage CRT très
discret. Rien d'autre : la page ne se décrit pas, elle ne parle pas des outils —
il n'y a ni paragraphe explicatif, ni légende, ni manifeste.
Les animations restent actives même si le système demande de réduire les
mouvements ; sans canvas ni JavaScript, la page reste noire et lisible.

`test/home.test.js` rejoue la boucle dans Node (horloge et `requestAnimationFrame`
virtuels, contexte 2D qui enregistre les tracés au lieu de les dessiner) : il
vérifie que les trois calques produisent une image **différente à chaque frame**,
que les lignes de la grille défilent vraiment vers l'horizon, que la boucle se
réarme. Un test vérifie aussi que le réglage système « mouvement réduit »
ne fige plus l'animation.

**Le menu déroulant** (un `<details>`, donc ouvert même sans JavaScript) est la
seule citation des outils sur l'accueil. Il est présent sur toutes les pages :
l'outil en cours est nommé dans le déclencheur, marqué `aria-current` et le
sélecteur passe en négatif. `public/chrome.js` ne fait que le confort — Échap,
clic extérieur, flèches — et nomme l'outil courant d'après le registre.

**Chaque outil a sa page** sous `public/tools/<id>/`, sa propre logique
(`app.js` pour le tri par site, `lookup.js` pour Discord, `guns.js` pour
guns.lol), et partage l'habillage `public/chrome.js` (menu + décor) ainsi que
`public/styles.css`.

Le registre `public/lib/tools.js` reste la **source de vérité** (`/api/tools` le
sert tel quel). Ajouter un outil :

1. une entrée dans `public/lib/tools.js` (`id`, `name`, `short`, `tagline`,
   `path`, `status: 'available' | 'soon'`, `tags`, `points`, `api`, `cli`…) ;
2. la page `public/tools/<id>/index.html` (reprendre l'en-tête, le menu et le
   pied de page d'un outil existant) ;
3. une entrée `<a class="tool-item">` dans le menu déroulant **de chaque page**
   (accueil compris), et le compte `<b>N online</b>`.

`test/tools.test.js` vérifie que ces endroits racontent la même histoire :
champs complets, identifiants uniques, page présente sur le disque, menu
identique au registre sur chaque page — et surtout **aucune citation d'outil sur
l'accueil en dehors du menu**. Un outil `status: 'soon'` y apparaît grisé, sans
lien.

## Discord lookup

`/tools/discord-lookup/` — deux temps, et le premier ne demande rien à personne.

**1. Le flocon de neige, décodé dans le navigateur.** Un identifiant Discord est
un entier 64 bits : 42 bits de millisecondes depuis l'epoch Discord
(`1420070400000`, 1er janvier 2015), 5 bits de worker interne, 5 bits de
processus, 12 bits d'incrément. `public/lib/discord.js` les sépare pendant la
frappe : date de création (UTC), âge du compte, worker, incrément, hexadécimal,
mention `<@…>`, lien de profil, avatar par défaut. La saisie est libre — nombre
nu, mention `<@!…>`, adresse `discord.com/users/…` copiée depuis l'application :
le premier flocon trouvé gagne. Cette partie fonctionne **sans réseau et sans
jeton**, et `test/discord.test.js` vérifie que les morceaux se recollent à
l'identique.

**2. Le profil complet, relayé par le serveur.** `GET /api/discord/user?id=…`
appelle l'API officielle (v10) avec le jeton bot du serveur et rend tout :

- l'objet brut de Discord, tel quel (`user`), plus une vue normalisée
  (`profile`) : nom affiché, pseudo, ancienne balise `nom#0000`, discriminateur,
  bot/système, 2FA, vérifié, langue, Nitro, couleur d'accent (en `#rrggbb`),
  hashes d'avatar et de bannière, décoration, `primary_guild` ;
- les **drapeaux publics** décodés bit à bit (15 drapeaux documentés — un bit
  inconnu est signalé comme tel, jamais inventé) ;
- les **adresses du CDN** prêtes à l'emploi : avatar `.png`/`.webp`/`.gif` (un
  hash `a_…` est animé), bannière, décoration, avatar par défaut (indexé par
  l'identifiant, ou par le discriminateur pour les anciens comptes), à la taille
  demandée (`?size=16…4096`) ;
- avec `?guilds=1`, les **serveurs communs** : le bot interroge chaque serveur
  où il se trouve (`GET /guilds/<id>/members/<user>`) et rend pseudo, date
  d'arrivée, boost, suspension, et les noms de rôles triés par position.

**Le jeton reste sur le serveur.** Le navigateur ne reçoit que le résultat —
`test/discord.test.js` le vérifie assertion par assertion : la chaîne du jeton
n'apparaît jamais dans une réponse. Un garde-fou de débit (`DISCORD_RATE_MAX` recherches par
adresse et par minute, 30 par défaut) évite qu'un visiteur n'use le quota du bot,
et les compteurs `x-ratelimit-*` de Discord sont relayés tels quels.

**Sans jeton, l'outil ne se bloque pas** : il répond `mode: "offline"` avec le
flocon complet et une note expliquant quoi poser sur le serveur. La page le dit
dès le chargement, en lisant `/api/health`.

~~~
DISCORD_TOKEN=…            # applications → Bot → Reset token (aucun intent requis)
DISCORD_GUILD_CAP=40       # serveurs examinés au plus avec ?guilds=1
DISCORD_RATE_MAX=30        # recherches par adresse et par minute
DISCORD_TIMEOUT_MS=8000    # délai d'un appel à Discord
DISCORD_API_BASE=…         # base de l'API (tests : un faux Discord local)
~~~

Le site reste **noir et blanc** : avatar et bannière arrivent en niveaux de
gris, et la case « Show colours » leur rend leurs couleurs à la demande. La
seule couleur affichée d'office est la pastille de `accent_color` — c'est une
donnée, pas du décor.

## Guns.lol views

`/tools/guns-views/` — un pseudo, et le serveur se charge du reste. Aucun compte,
aucun jeton : guns.lol n'est jamais parlé autrement qu'en navigateur.

**Ce qu'une vue déclenche vraiment.** Un profil guns.lol est servi avec un
challenge `_gpp_ch` (proof-of-work WebAssembly), et le compteur bouge sur deux
chemins : le pixel d'analytics `sa.guns.lol/simple.gif` et l'événement signé
`POST /api/analytics/record`, protégé par Cloudflare **et** par le
proof-of-work. L'ancien `POST /api/view/<pseudo>` existe toujours. Le serveur
rejoue les quatre couches dans l'ordre — page, pixel, `view`, `record` — et note
ce que chacune a répondu ; il ne devine rien.

**Le proof-of-work, résolu en Node pur.** Le jeton du challenge porte cinq
nibbles retirés à des positions connues : on les retrouve par force brute
(`sha256(sceau + sel + horodatage) == empreinte`), puis le nonce est assemblé
avec un score et une intégrité **BLAKE3**. `public/lib/guns-api.js` embarque donc
BLAKE3 et SHA-256 (`node:crypto`) sans la moindre dépendance, et
`test/guns.test.js` recoupe BLAKE3 sur les vecteurs officiels (0, 1 et 1024
octets).

**Les proxys.** `public/lib/guns.js` liste sept sources publiques (proxifly,
monosans, mmpx12, roosterkid, zloi-user, hookzof, Geonode). Toutes sont
revérifiées en continu et annoncent explicitement le protocole : les listes
fourre-tout n'offrent que 5 à 15 % de survivants, celles-ci bien davantage. Un
candidat ne passe que si un vrai `CONNECT` (ou une poignée de main SOCKS5) suivi
d'une requête HTTP complète vers `guns.lol:443` répond en 2xx ou en 3xx.
Le transport est écrit à la main
sur `node:http`, `node:net` et `node:tls` : aucune dépendance, et le proxy ne voit jamais
autre chose qu'un tunnel chiffré.

**Une vue par adresse.** guns.lol déduplique les vues par IP et par jour : un
proxy utilisable vaut une vue. La page envoie donc une vue par proxy, en
parallèle, et une couche qui échoue trois fois de suite est abandonnée en cours
de route plutôt que de gaspiller toute la réserve.

**Sans proxy, l'outil ne se bloque pas** : il bascule en mode direct (une vue par
tour) et le dit. Le rapport donne, couche par couche, les compteurs exacts ;
`test/guns-page.test.js` charge la page dans un DOM simulé.

~~~
GUNS_VIEWS=15                 # vues par tour
GUNS_ROUNDS=1                 # tours successifs
GUNS_PROXIES=1500             # proxys récoltés au plus
GUNS_CONCURRENCY=6            # vues en parallèle
GUNS_VALIDATE_CONCURRENCY=120 # tunnels testés en parallèle
GUNS_VALIDATE_TIMEOUT_MS=5000 # délai d'un test de proxy
GUNS_VALIDATE_MAX=0           # 0 = tester toute la réserve
GUNS_PROXY_PER_SOURCE=400     # lignes gardées par liste
GUNS_TIMEOUT_MS=8000          # délai d'une requête
GUNS_BUDGET_MS=60000          # budget d'une passe complète
GUNS_RATE_MAX=6               # passes par adresse et par minute
GUNS_PROXY_SOURCES=…          # liste d'URL séparées par des virgules
~~~

Les vues mettent quelques minutes à apparaître sur le profil : c'est normal, le
compteur est calculé côté guns.lol.

## Comment ça marche

1. Le fichier est découpé en flux dans un **Web Worker** : la page reste
   fluide, rien ne transite par le réseau. Une **barre de progression** affiche
   les lignes traitées et le pourcentage avancé.
2. Une passe d'**analyse** compte les sites et les valeurs sans stocker le
   texte : la liste des sites s'affiche au fur et à mesure.
3. Un clic sur un site déclenche une seconde passe ciblée, écrite au fil de
   l'eau, affichée puis téléchargeable en `.txt`.

Le moteur d'extraction partagé (navigateur, serveur, CLI) reste dans
`public/lib/parse.js` ; le tri par site dans `public/lib/group.js`.
Le décor, lui, est facultatif : sans `IntersectionObserver` ni
`requestAnimationFrame`, la page s'affiche à l'identique, sans animation.

Vitesse mesurée : **~230 Mo/s** sans dédoublonnage (~100 Mo/s avec), et
**~70 Mo/s** pour le tri par site (200 sites sur 150 Mo). Le parseur travaille
ligne par ligne, sans allocation inutile.

## Trier par site

Trois temps, tous dans le navigateur :

1. **Analyse** du fichier : un passage complet range chaque ligne par site
   (`roblox.com`, `netflix.com`, …) et compte les valeurs. La liste des sites
   s'affiche au fur et à mesure, triée du plus gros au plus petit.
2. **Clic sur un site** : un second passage lit le fichier et n'écrit que les
   valeurs de ce site, affichées en direct.
3. **Téléchargement** : un `.txt` par site (`roblox.com.txt`), ou la liste
   complète (`site<TAB>valeur<TAB>octets`).

Détail des sites :

- l'hôte est lu sur la ligne (`https://`, `http://`, `//` ou directement
  `roblox.com/login`) : ports, IP et `user:pass@hote` sont gérés ;
- `www.roblox.com` et `account.roblox.com` sont regroupés sous `roblox.com`
  (case à décocher pour garder l'hôte exact) ;
- `roblox.co.uk` reste distinct de `roblox.com` ;
- une ligne sans URL va dans le groupe `(sans site)` ;
- seul le site situé **avant le combo, dans le même bloc** (entre crochets
  `[…]`), compte : un site cité avant un bloc entre crochets, après le
  combo, ou le domaine d'un email du combo (`…@gmail.com:…`) n'est jamais
  compté comme un site — sans site associé, la valeur va dans `(sans site)`.
  Ex. `[https://sso.exemple.com/login:quelquun@gmail.com:mdp](…)` →
  `sso.exemple.com`, pas `gmail.com` ;
- les lignes sans couple `xxxx:xxxx` sont simplement comptées comme « ignorées ».

Les modes (dernier couple, premier, le plus long, tous, regex perso)
s'appliquent à chaque ligne, plus le dédoublonnage **par site** et la case
« garder les `domaine.tld:port` ».

## Les modes

| mode      | ce qui est gardé sur chaque ligne                        |
| --------- | -------------------------------------------------------- |
| `last`    | le dernier couple — **par défaut**, cas de l'exemple      |
| `first`   | le premier couple                                         |
| `longest` | le couple dont la partie droite est la plus longue        |
| `all`     | tous les couples                                          |
| `custom`  | une regex perso (1er groupe capturant = valeur gardée)    |

Options : `dedupe` (doublons supprimés), `hosts` (ne plus ignorer les faux
couples `domaine.tld:port`, ignorés par défaut, voir plus bas).

## Faire tourner le site

~~~
npm start            # http://localhost:3000 → la vitrine
npm test             # 105 tests (moteurs, workers, serveur, registre, interface, animation, Discord, guns.lol)
npm run check        # syntaxe de tous les modules
npm run bench        # mesure sur un fichier généré
~~~

Tout est dans `public/` : l'accueil (`index.html` + `home.js`), les trois pages
d'outil (`tools/group-by-site/index.html`, `tools/discord-lookup/index.html` et
`tools/guns-views/index.html`, chacune avec ses sections numérotées puis les
blocs `API`, `CLI` — et `Bot token` — dépliables avec bouton « copier »),
l'habillage partagé (`chrome.js`) et les moteurs (`lib/`). On peut aussi glisser
un `.txt` directement sur la zone de dépôt.

Côté ressources, chaque page ne charge que `/styles.css`, son module
(`/home.js`, `/app.js`, `/lookup.js` ou `/guns.js`), `/chrome.js`, `/worker.js`
et les modules de `public/lib/` — le logo est un SVG écrit dans la page, jamais
une image. Seule exception, assumée : après une recherche Discord réussie,
l'avatar et la bannière viennent de `cdn.discordapp.com`
(`referrerpolicy="no-referrer"`, aucune adresse figée dans le HTML).

Un dossier servi sans slash final (`/tools/group-by-site`) est redirigé (301)
vers sa forme avec slash. Les fichiers statiques partent avec `ETag` +
`no-cache` : le navigateur redemande, le serveur répond `304` si rien n'a
changé — aucune feuille de style périmée après une modification.

## Ligne de commande (les plus gros fichiers)

~~~
node cli.js gros.txt -o resultat.txt --mode=last --dedupe --stats
node cli.js dossier/*.txt -o resultat.txt --mode=first
zcat gros.txt.gz | node cli.js --mode=last > resultat.txt
~~~

Tri par site :

~~~
node cli.js gros.txt --group                        # site + compteurs (TSV)
node cli.js gros.txt --group --json                 # la même en JSON
node cli.js gros.txt --group --site=roblox.com -o roblox.txt
node cli.js gros.txt --group --split=dossier/       # un .txt par site
~~~

Mémoire constante, `.gz` accepté, `--keep-hosts` pour garder `domaine.tld:port`,
`--exact` pour ne pas regrouper les sous-domaines.

Discord lookup :

~~~
node cli.js discord 175928847299117063                  # ce que dit l'identifiant
DISCORD_TOKEN=… node cli.js discord 175928847299117063   # profil complet
node cli.js discord '<@175928847299117063>' --guilds --json -o profil.json
~~~

Guns.lol views :

~~~
node cli.js guns zach                          # des vues, une par proxy public
node cli.js guns zach --views=25 --concurrency=10
node cli.js guns zach --read --json -o rapport.json
node cli.js guns zach --pool                   # ne fait que tester la réserve
node cli.js guns zach --direct                  # sans proxy, une vue par tour
~~~

## API (curl)

~~~
# le corps de la requête est le texte à traiter
curl -X POST --data-binary @fichier.txt \
  'https://MON-APP.onrender.com/api/extract?mode=last&dedupe=1' -o resultat.txt

# un dossier du serveur (ZACH_DB_DIR) : tout, ou une sélection
curl 'https://MON-APP.onrender.com/api/extract?dir=/data&mode=last' -o resultat.txt
curl -X POST 'https://MON-APP.onrender.com/api/extract?dir=/data&paths=1&mode=last' \
  -d 'a.txt
b.txt' -o resultat.txt

curl 'https://MON-APP.onrender.com/api/health'

# le registre des outils servi par le hub
curl 'https://MON-APP.onrender.com/api/tools'
~~~

Tri par site :

~~~
# la liste des sites avec leurs compteurs (JSON par défaut)
curl -X POST --data-binary @fichier.txt 'https://MON-APP.onrender.com/api/group'
curl -X POST --data-binary @fichier.txt 'https://MON-APP.onrender.com/api/group?format=tsv'

# toutes les valeurs d'un seul site, écrites au fil de l'eau
curl -X POST --data-binary @fichier.txt \
  'https://MON-APP.onrender.com/api/group?site=roblox.com' -o roblox.txt
curl -X POST --data-binary @fichier.txt \
  'https://MON-APP.onrender.com/api/group?site=roblox.com&format=ndjson' -o roblox.ndjson
~~~

Discord lookup :

~~~
# le profil complet (mode offline si le serveur n'a pas de jeton)
curl 'https://MON-APP.onrender.com/api/discord/user?id=175928847299117063'

# serveurs communs, visuels en 2048 px, mention acceptée en entrée
curl 'https://MON-APP.onrender.com/api/discord/user?id=%3C%40175928847299117063%3E&guilds=1&size=2048'

# la table des drapeaux, et l'état du jeton
curl 'https://MON-APP.onrender.com/api/discord/flags'
curl 'https://MON-APP.onrender.com/api/health'      # → "discord": true | false
~~~

Guns.lol views :

~~~
# quinze vues, une par proxy public ; le rapport dit ce que chaque couche a répondu
curl 'https://MON-APP.onrender.com/api/guns/views?user=zach&views=15'

# la réserve seule : sources, compteurs, échantillon testé
curl 'https://MON-APP.onrender.com/api/guns/proxies'

# mode direct (adresse du serveur), compteur lu avant et après
curl 'https://MON-APP.onrender.com/api/guns/views?user=zach&direct=1&read=1'
~~~

`/api/extract?group=1` est un alias. Paramètres : `mode`, `regex`, `dedupe=1`,
`hosts=1`, `subdomains=0` (hôte exact), `site`, `format` (`json`, `tsv`, `txt`,
`ndjson`), `dir`, `paths=1`, `gz=0`.
La réponse est diffusée en flux (compression gzip si le client l'accepte), donc
un fichier de plusieurs Go ne passe jamais entièrement en mémoire.

## Déploiement sur Render

**Méthode 1 — sans Docker (recommandé)** : *New → Web Service*, connectez le
dépôt, puis Runtime `Node`, Build Command `npm install --omit=dev`, Start
Command `npm start`. C'est tout (aucune dépendance à installer).

**Méthode 2 — avec Docker** : *New → Web Service → Docker*, le `Dockerfile` est
déjà prêt.

**Méthode 3 — Blueprint** : *New → Blueprint*, le `render.yaml` est déjà prêt.

> Le traitement principal se fait dans le navigateur du visiteur : le plan
> gratuit de Render suffit largement pour le site. L'API serveur, elle, tourne
> sur la petite instance Render — pour de très gros volumes, préférez la page
> web ou la CLI.

Variables utiles : `PORT` (fourni par Render), `ZACH_DB_DIR` (dossier autorisé
pour `?dir=`, vide par défaut), `ZACH_DB_BODY_LIMIT` (taille max d'un corps de
requête, 256 Mo par défaut), et pour Discord lookup `DISCORD_TOKEN` (secret,
jamais envoyé au navigateur), `DISCORD_GUILD_CAP`, `DISCORD_RATE_MAX`,
`DISCORD_RATE_WINDOW`, `DISCORD_TIMEOUT_MS`.

Pour Guns.lol views, aucun secret : `GUNS_VIEWS`, `GUNS_ROUNDS`, `GUNS_PROXIES`,
`GUNS_CONCURRENCY`, `GUNS_VALIDATE_CONCURRENCY`, `GUNS_TIMEOUT_MS`,
`GUNS_BUDGET_MS`, `GUNS_RATE_MAX`, `GUNS_PROXY_SOURCES`.

## Détail de la détection

Un « couple » est une suite de segments séparés par `:`, où chaque segment ne
contient que ces caractères : lettres (accents compris), chiffres, `.`, `_`,
`@`, `+`, `-`. Tout le reste (espaces, `/`, `[`, `]`, `(`, `)`, `<`, `>`, `"`,
`#`, `?`, `&`, `%`, `\`, `|`…) coupe le couple.

- `Thou_miriba:N2Z6PQXg4XLnTSi` → gardé.
- `sp4ce:secret42` au milieu de `prefix    sp4ce:secret42   suffix` → gardé.
- `a:b:c` → deux couples : `a:b` puis `b:c`.
- `monsite.com:8080` (hôte:port d'une URL) → **ignoré** par défaut : c'est un
  port, pas un couple. Les IP (`127.0.0.1:8080`) sont conservées, et la case
  « garder les domaine.tld:port » désactive ce filtre.
- `user:1111` juste après un `:` → gardé.

Le moteur est dans `lib/parse.js` et sert aux trois usages (navigateur, serveur,
CLI) : un seul code, donc un seul comportement.

## Arborescence

~~~
public/index.html                 accueil : la vitrine (fond noir animé)
public/home.js                    moteur visuel de l'accueil (canvas, décodage, télémétrie)
public/chrome.js                  habillage partagé : menu des outils + décor
public/styles.css                 noir et blanc, sobre : cartes, halos, bandeau
public/lib/tools.js               registre des outils (source de vérité)
public/lib/parse.js               moteur d'extraction (navigateur / serveur / CLI)
public/lib/group.js               moteur de tri par site (mêmes règles)
public/lib/discord.js             flocon, drapeaux, adresses du CDN (isomorphe)
public/lib/discord-api.js         client Discord : serveur et CLI, un seul code
public/tools/group-by-site/       l'outil : page, barre de progression, résultats
public/app.js                     interface de cet outil (listes, téléchargements)
public/worker.js                  Web Worker : lecture en flux du fichier
public/tools/discord-lookup/      l'outil : identifiant, flocon, profil, serveurs
public/lookup.js                  interface de cet outil (recherche, affichage)
public/lib/guns.js                slugs, proxys, challenge, en-têtes (isomorphe)
public/lib/guns-api.js            transport CONNECT, BLAKE3, PoW, envoi des vues
public/tools/guns-views/          l'outil : cible, réserve de proxys, journal
public/guns.js                    interface de cet outil (rapport, journal)
server.js                         serveur HTTP + API (aucune dépendance)
cli.js                            ligne de commande (extraction, tri, discord, guns)
bench.js                          benchmark
test/parse.test.js                moteur d'extraction
test/group.test.js                moteur de tri par site
test/worker.test.js               worker du navigateur
test/tools.test.js                registre ↔ accueil ↔ pages
test/home.test.js                 le fond de l'accueil est réellement animé
test/discord.test.js              flocon, drapeaux, CDN, route (faux Discord)
test/lookup.test.js               la page Discord lookup dans un DOM simulé
test/site.test.js                 serveur HTTP + API
test/ui.test.js                   interface : fumée, cohérence, aucun emoji, décor
test/guns.test.js                 slugs, proxys, challenge, BLAKE3, PoW
test/guns-page.test.js            la page Guns.lol views dans un DOM simulé
Dockerfile, render.yaml
~~~

`public/` est autonome : on peut le servir en statique (GitHub Pages, Nginx…).
Le tri par site y reste entier (tout se passe dans le navigateur) ; Discord
lookup y garde le décodage du flocon, et il lui faut le serveur Node pour le
profil complet — c'est lui qui détient le jeton. Guns.lol views, lui, a besoin
du serveur pour tout : un navigateur ne sait pas ouvrir de tunnel vers un proxy
HTTP.
