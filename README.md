# zach-db

Extraction ultra-rapide de morceaux `xxxx:xxxx` depuis de gros fichiers texte,
et tri de ces lignes par site.
Site moderne et sobre : noir et blanc, aucun emoji, aucune police externe,
aucun framework, aucune dépendance npm — le décor (grille en pointillés,
halos lents, bandeau défilant, halos qui suivent le curseur, fil de lecture,
apparitions au défilement) est fait de CSS et d'un peu de code, jamais
d'images. Thème sombre automatique, tout s'arrête si le système demande
moins de mouvement.
Une barre de progression suit l'avancement du traitement, ligne à ligne.

**Vue unique — Trier par site**

```
entrée :  https://www.roblox.com/x:Thou_miriba:N2Z6PQXg4XLnTSi
          http://www.netflix.com/y:user1:pass1
          https://account.roblox.com/z:user2:pass2

liste :   roblox.com    2 valeurs
          netflix.com   1 valeur

clic sur "roblox.com" → Thou_miriba:N2Z6PQXg4XLnTSi
                        user2:pass2
```

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

## Le site

```bash
npm start            # http://localhost:3000
npm test             # 53 tests (moteurs, workers, serveur HTTP, interface)
npm run bench        # mesure sur un fichier généré
```

Tout est dans `public/` : en-tête collant, section 01 à 03, puis les blocs
`API` et `CLI` dépliables (avec bouton « copier »). On peut aussi glisser un
`.txt` directement sur la zone de dépôt. Aucune requête ne part : les seules
ressources chargées sont `/styles.css`, `/app.js`, `/worker.js` et les moteurs
de `public/lib/`.

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
public/lib/parse.js   moteur d'extraction (partagé navigateur / serveur / CLI)
public/lib/group.js   moteur de tri par site (mêmes briques, mêmes règles)
public/index.html     page unique : tri par site, barre de progression, décor
public/styles.css     noir et blanc, sobre : cartes, halos, bandeau, animations
public/app.js         interface (analyse, listes, téléchargements)
public/worker.js      Web Worker : lecture en flux du fichier
server.js             serveur HTTP + API (aucune dépendance)
cli.js                ligne de commande
bench.js              benchmark
test/parse.test.js    moteur d'extraction
test/group.test.js    moteur de tri par site
test/worker.test.js   worker du navigateur
test/site.test.js     serveur HTTP + API
test/ui.test.js       interface : fumée, cohérence, aucun emoji, décor CSS
Dockerfile, render.yaml
```

`public/` est autonome : on peut aussi le servir en statique (GitHub Pages,
Nginx…) et n'y utiliser que le traitement local.
