# zach-db

Extraction ultra-rapide de morceaux `xxxx:xxxx` depuis de gros fichiers texte.
Site volontairement nu : noir et blanc, aucune police externe, aucun effet,
aucune image, aucun framework, aucune dépendance npm.

```
entrée :  [https://www.roblox.com/tr/CreateAccount:Thou_miriba:N2Z6PQXg4XLnTSi](...)1111
sortie :  Thou_miriba:N2Z6PQXg4XLnTSi
```

## Comment ça marche

1. Le fichier est découpé en flux dans un **Web Worker** : l'onglet reste fluide,
   rien ne transite par le réseau.
2. Une passe **comptage** mesure la taille de la sortie sans la stocker.
3. Une passe **collecte** écrit le résultat et le télécharge.
   Si la sortie dépasse 32 Mo, elle est produite en plusieurs fichiers
   (`-part001.txt`, `-part002.txt`, …) : la mémoire du navigateur reste bornée,
   et le résultat reste **exact** (aucune ligne perdue).

Vitesse mesurée : **~230 Mo/s** sans dédoublonnage, ~100 Mo/s avec (fichier de
231 Mo en 1 s). Le parseur travaille ligne par ligne, sans allocation inutile.

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
npm test             # 31 tests (moteur, worker navigateur, serveur HTTP)
npm run bench        # mesure sur un fichier généré
```

## Ligne de commande (les plus gros fichiers)

```bash
node cli.js gros.txt -o resultat.txt --mode=last --dedupe --stats
node cli.js dossier/*.txt -o resultat.txt --mode=first
zcat gros.txt.gz | node cli.js --mode=last > resultat.txt
```

Mémoire constante, `.gz` accepté, `--keep-hosts` pour garder `domaine.tld:port`.

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

Paramètres : `mode`, `regex`, `dedupe=1`, `hosts=1`, `dir`, `paths=1`, `gz=0`.
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
public/index.html     page unique
public/styles.css     noir et blanc, ~100 lignes
public/app.js         interface (passes comptage + collecte, téléchargements)
public/worker.js      Web Worker : lecture en flux du fichier
server.js             serveur HTTP + API (aucune dépendance)
cli.js                ligne de commande
bench.js              benchmark
test/parse.test.js    moteur
test/worker.test.js   worker du navigateur
Dockerfile, render.yaml
```

`public/` est autonome : on peut aussi le servir en statique (GitHub Pages,
Nginx…) et n'y utiliser que le traitement local.
