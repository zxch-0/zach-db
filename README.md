# zach-db

**tools by zach** — un regroupement d'outils pour les gros fichiers `.txt`.
La page d'accueil est une **vitrine** : fond noir animé, logo, instruments
dessinés sur canvas. Aucun outil n'y est cité — la seule porte d'entrée est le
**menu déroulant** en haut de chaque page. Un seul outil est en ligne pour
l'instant : **Combos, trier par site** (extraction ultra-rapide de morceaux
`xxxx:xxxx` et tri de ces lignes par site).

Site moderne et sobre : noir et blanc, aucun emoji, aucune police externe,
aucun framework, aucune dépendance npm — le décor (grille en perspective,
noyau filaire, oscilloscope, halos lents, bandeau défilant, fil de lecture,
apparitions au défilement) est fait de CSS, de SVG et de canvas, jamais
d'images. L'accueil est noir imposé ; les pages d'outil suivent le thème du
système. Tout s'arrête si le système demande moins de mouvement.
Une barre de progression suit l'avancement du traitement, ligne à ligne.

**Outil en ligne — Combos, trier par site** (`/tools/group-by-site/`)

```
entrée :  https://www.roblox.com/x:Thou_miriba:N2Z6PQXg4XLnTSi
          http://www.netflix.com/y:user1:pass1
          https://account.roblox.com/z:user2:pass2

liste :   roblox.com    2 valeurs
          netflix.com   1 valeur

clic sur "roblox.com" → Thou_miriba:N2Z6PQXg4XLnTSi
                        user2:pass2
```

## Le site : une vitrine, un menu, des outils

```
/                          accueil : la vitrine (fond noir animé, aucun outil cité)
/tools/group-by-site/      l'outil « Combos — trier par site »
/api/tools                 le registre des outils, en JSON
/api/group, /api/extract   les API de cet outil
```

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
`prefers-reduced-motion` fige tout sur une image fixe composée ; sans canvas ni
JavaScript, la page reste noire et lisible.

`test/home.test.js` rejoue la boucle dans Node (horloge et `requestAnimationFrame`
virtuels, contexte 2D qui enregistre les tracés au lieu de les dessiner) : il
vérifie que les trois calques produisent une image **différente à chaque frame**,
que les lignes de la grille défilent vraiment vers l'horizon, que la boucle se
réarme, et qu'en mouvement réduit une image fixe est composée sans qu'aucune
boucle ne démarre.

**Le menu déroulant** (un `<details>`, donc ouvert même sans JavaScript) est la
seule citation des outils sur l'accueil. Il est présent sur toutes les pages :
l'outil en cours est nommé dans le déclencheur, marqué `aria-current` et le
sélecteur passe en négatif. `public/chrome.js` ne fait que le confort — Échap,
clic extérieur, flèches — et nomme l'outil courant d'après le registre.

**Chaque outil a sa page** sous `public/tools/<id>/`, sa propre logique
(`app.js` pour le premier), et partage l'habillage `public/chrome.js`
(menu + décor) ainsi que `public/styles.css`.

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

```bash
npm start            # http://localhost:3000 → la vitrine
npm test             # 70 tests (moteurs, workers, serveur, registre, interface, animation)
npm run check        # syntaxe de tous les modules
npm run bench        # mesure sur un fichier généré
```

Tout est dans `public/` : l'accueil (`index.html` + `home.js`), la page de
l'outil (`tools/group-by-site/index.html`, sections 01 à 03 puis les blocs `API`
et `CLI` dépliables avec bouton « copier »), l'habillage partagé (`chrome.js`)
et les moteurs (`lib/`). On peut aussi glisser un `.txt` directement sur la zone
de dépôt. Aucune requête ne part : les seules ressources chargées sont
`/styles.css`, `/home.js` ou `/app.js`, `/chrome.js`, `/worker.js` et les
modules de `public/lib/` — le logo est un SVG écrit dans la page, jamais une
image.

Un dossier servi sans slash final (`/tools/group-by-site`) est redirigé (301)
vers sa forme avec slash. Les fichiers statiques partent avec `ETag` +
`no-cache` : le navigateur redemande, le serveur répond `304` si rien n'a
changé — aucune feuille de style périmée après une modification.

## Ligne de commande (les plus gros fichiers)

```bash
node cli.js gros.txt -o resultat.txt --mode=last --dedupe --stats
node cli.js dossier/*.txt -o resultat.txt --mode=first
zcat gros.txt.gz | node cli.js --mode=last > resultat.txt
```

Tri par site :

```bash
node cli.js gros.txt --group                        # site + compteurs (TSV)
node cli.js gros.txt --group --json                 # la même en JSON
node cli.js gros.txt --group --site=roblox.com -o roblox.txt
node cli.js gros.txt --group --split=dossier/       # un .txt par site
```

Mémoire constante, `.gz` accepté, `--keep-hosts` pour garder `domaine.tld:port`,
`--exact` pour ne pas regrouper les sous-domaines.

## API (curl)

```bash
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
```

Tri par site :

```bash
# la liste des sites avec leurs compteurs (JSON par défaut)
curl -X POST --data-binary @fichier.txt 'https://MON-APP.onrender.com/api/group'
curl -X POST --data-binary @fichier.txt 'https://MON-APP.onrender.com/api/group?format=tsv'

# toutes les valeurs d'un seul site, écrites au fil de l'eau
curl -X POST --data-binary @fichier.txt \
  'https://MON-APP.onrender.com/api/group?site=roblox.com' -o roblox.txt
curl -X POST --data-binary @fichier.txt \
  'https://MON-APP.onrender.com/api/group?site=roblox.com&format=ndjson' -o roblox.ndjson
```

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
requête, 256 Mo par défaut).

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

```
public/index.html                 accueil : la vitrine (fond noir animé)
public/home.js                    moteur visuel de l'accueil (canvas, décodage, télémétrie)
public/chrome.js                  habillage partagé : menu des outils + décor
public/styles.css                 noir et blanc, sobre : cartes, halos, bandeau
public/lib/tools.js               registre des outils (source de vérité)
public/lib/parse.js               moteur d'extraction (navigateur / serveur / CLI)
public/lib/group.js               moteur de tri par site (mêmes règles)
public/tools/group-by-site/       l'outil : page, barre de progression, résultats
public/app.js                     interface de cet outil (listes, téléchargements)
public/worker.js                  Web Worker : lecture en flux du fichier
server.js                         serveur HTTP + API (aucune dépendance)
cli.js                            ligne de commande
bench.js                          benchmark
test/parse.test.js                moteur d'extraction
test/group.test.js                moteur de tri par site
test/worker.test.js               worker du navigateur
test/tools.test.js                registre ↔ accueil ↔ pages
test/home.test.js                 le fond de l'accueil est réellement animé
test/site.test.js                 serveur HTTP + API
test/ui.test.js                   interface : fumée, cohérence, aucun emoji, décor
Dockerfile, render.yaml
```

`public/` est autonome : on peut aussi le servir en statique (GitHub Pages,
Nginx…) et n'y utiliser que le traitement local.
