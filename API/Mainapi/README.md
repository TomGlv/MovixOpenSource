# Main API Movix

C'est le cœur applicatif du projet. Si le frontend affiche un catalogue, authentifie un user, synchronise du `localStorage`, gère les commentaires, le Wishboard, le Top 10, le Live TV, le debrid ou les pages VIP, il finit très souvent ici.

Le service tourne en mode cluster via `server.js` : un master lance plusieurs workers, surveille les redémarrages et gère un graceful shutdown. `app.js` monte ensuite Express, Redis, le pool MySQL, les caches disque et les routes injectées par dépendances.

## Ce que le service gère

- auth, sessions et profils
- recherche, metadata TMDB et agrégation de sources
- sync frontend <-> backend pour une partie de l'état utilisateur
- commentaires, likes, listes partagées, Wishboard et soumission de liens
- Live TV, proxies, debrid et intégrations de scraping
- VIP, invoices, wrapped et features communautaires

## Démarrage

```bash
cd API/Mainapi
cp .env.example .env
npm install
npm run dev
```

Ne lance pas le service avec un `.env` vide : MySQL, Redis, JWT, TMDB et plusieurs routes métier en dépendent directement.

Notes utiles :

- le serveur HTTP écoute actuellement sur `http://localhost:25565`
- `server.js` bind aujourd'hui le port `25565` en dur
- `NUM_WORKERS` permet de régler le nombre de workers du cluster
- MySQL et Redis sont nécessaires pour une grosse partie des routes

## Architecture

```text
API/Mainapi/
|-- server.js                 # Master cluster + workers + graceful shutdown
|-- app.js                    # Bootstrap Express, middleware, deps partagées
|-- mysqlPool.js              # Pool MySQL unique
|-- config/redis.js           # Redis
|-- middleware/               # CORS, sécurité, auth
|-- routes/                   # Modules avec configure(deps)
|-- commentsRoutes.js         # Commentaires
|-- likesRoutes.js            # Likes / dislikes
|-- sharedListsRoutes.js      # Listes partagées
|-- liveTvRoutes.js           # Live TV
|-- wishboardRoutes.js        # Wishboard
|-- top10Routes.js            # Classements
|-- wrappedRoutes.js          # Wrapped
|-- linkSubmissionsRoutes.js  # Soumission de liens
|-- utils/                    # Cache, proxies, axios helpers, VIP, etc.
|-- cache/                    # Caches disque
`-- exportscripts/            # SQL et scripts de migration
```

Le pattern important dans `routes/` : beaucoup de modules exposent `configure(deps)`. C'est `app.js` qui injecte les clients HTTP, le cache, les helpers et les constantes partagées avant montage.

## Variables d'environnement à renseigner en premier

Le fichier `API/Mainapi/.env.example` est la référence complète. En pratique, les groupes de variables à traiter en premier sont :

- cœur applicatif : `JWT_SECRET`, `TMDB_API_KEY`, `FRONTEND_BASE_URL`
- données : `DB_HOST`, `DB_PORT`, `DB_USER`, `DB_PASSWORD`, `DB_NAME`
- cache et coordination : `REDIS_HOST`, `REDIS_PORT`, `REDIS_PASSWORD`, `NUM_WORKERS`
- scraping / proxy : `PROXY_SERVER_URL`, `IPTV_STREAM_PROXY`, `SOCKS5_PROXIES`, `HTTP_PROXIES`
- anti-abuse / forms : `TURNSTILE_SECRET_KEY`, `TURNSTILE_INVISIBLE_SECRETKEY`, puis `TURNSTILE_DOMAINS_n`, `TURNSTILE_SECRET_KEY_n` et `TURNSTILE_INVISIBLE_SECRETKEY_n` (n de 2 à 10) au-delà de 10 domaines : la clé suit l'`Origin` de la requête (`utils/turnstile.js`)
- paiement / VIP : variables `VIP_*`, `BLOCKCYPHER_TOKEN`

Certaines intégrations sont très spécifiques à des sources données, par exemple les cookies `DARKIWORLD_*`, `FSTREAM_LOGIN_*` ou `XTREAM_*`.

`FSTREAM_BASE_URL` définit l'origine commune aux recherches, à la session et aux pages FrenchStream (`https://french-stream.net` par défaut). Les anciennes URLs `.one` en cache sont normalisées avant les appels, y compris les API d'épisodes : les POST de recherche ne doivent pas suivre une redirection 301 qui perdrait leur formulaire.

FStream partage les liens bruts par saison ; `episode` sélectionne toujours l'épisode à résoudre. Les anciens caches par épisode sont repris progressivement. `FSTREAM_CACHE_REFRESH_MS` vaut 10 minutes par défaut : une requête déclenche l'actualisation lorsque les données sont périmées. Une recherche sans fiche validée attend également ce délai, tandis qu'une panne peut être retentée après une minute. Les liens utilisables sont conservés si l'actualisation échoue.

FStream et Wiflix vérifient les titres français, originaux et alternatifs. Une année différente ou absente nécessite des indices supplémentaires : affiche TMDB identique, ou concordance du titre avec plusieurs acteurs/créateurs ou un synopsis corroboré. Le synopsis seul ne suffit pas. Pour les séries, l'année de la saison et celle de la série sont admises ; la saison demandée reste contrôlée. Les diagnostics indiquent les motifs d'acceptation ou de rejet des candidats.

PurStream conserve les succès pendant six heures et les absences pendant cinq minutes. La date d'une tentative échouée est séparée de celle des données conservées. Un stream en 404 provoque une revalidation de son identifiant fournisseur. La source TV Direct a été retirée : ses anciens appels renvoient 410 sans contacter le fournisseur. `CLONE_LINKS_MISSING_RETRY_MS` espace les tentatives sur un fichier Uqload déclaré absent (24 heures par défaut).

Cpasmal privilégie les proxys dédiés de `SOCKS5_PROXIES`, puis le pool partagé en repli. Ses journaux de refus indiquent le proxy et le chemin ciblés, sans identifiants ni paramètres de requête.

Les proxys Cpasmal refusés sont écartés pendant une minute dans le worker (30 secondes sur erreur réseau). Le diagnostic d'un 403 indique également le nombre de tentatives et leurs statuts HTTP.

Les routes Cpasmal film et épisode servent le cache immédiatement et l'actualisent en arrière-plan si nécessaire. Sans cache utilisable, elles renvoient `202` avec `pending: true`, `code: "retrieval_in_progress"` et `Retry-After: 2` : rappeler la même URL pour obtenir le résultat une fois la récupération terminée. Une panne amont donne ensuite un `503`, sans créer de faux cache « introuvable » ; les nouvelles tentatives sont espacées d'une minute.

Redis partage désormais la récupération Cpasmal entre workers, les recherches positives pendant 40 minutes et les fiches série validées pendant 10 minutes. Les extractions sont limitées à trois lecteurs par épisode et douze requêtes par worker ; au-delà de trois lecteurs, le premier résultat est publié avant la liste complète. Une publication partielle conserve les lecteurs déjà utilisables. Sans Redis, le repli local reste limité à 64 récupérations simultanées ; les caches de recherche locaux sont bornés en nombre d'entrées et en octets.

Les recherches Coflix positives sont partagées pendant 30 minutes et les échecs pendant une minute lorsque Redis est disponible. Chaque worker écarte pendant 30 secondes les proxys refusés ou en panne. Les prérequêtes CORS autorisées annoncent `Access-Control-Max-Age: 600` pour permettre leur réutilisation par le navigateur.

## Fichiers SQLite pour Darkino / DarkiWorld

La source téléchargements (`routes/darkiworld.js` et `utils/darkiworldSqlite.js`) lit des snapshots SQLite locaux : `mirror.sqlite`, `darkino.sqlite` et `links_small.sqlite`. Ces fichiers ne sont pas versionnés dans le dépôt public.

1. Télécharger [l’archive des fichiers SQLite sur Pixeldrain](https://pixeldrain.com/u/n2M1s1MA).
2. Extraire les fichiers `.sqlite` dans `API/Mainapi/darkino-backups/`.
3. Pour utiliser un autre dossier, définir `DARKIWORLD_SQLITE_DIR` avec son chemin absolu, par exemple `/home/container/darkino-backups`.

Démarrer ou redémarrer Main API après l’installation des fichiers. Sans ces snapshots, les liens absents du cache local peuvent renvoyer `sqlite_miss`. Avec `HYDRACKER_BLACKOUT=true` (valeur par défaut), aucune résolution en direct auprès d’Hydracker ou de DarkiWorld ne prend le relais.

## Points d'entrée utiles

- auth et profils : `routes/authRoutes.js`, `routes/sessions.js`, `routes/profiles.js`
- persistance frontend : `routes/sync.js`
- recherche et catalogues : `routes/search.js`, `routes/tmdb.js`
- scraping / lecture : `routes/cpasmal.js`, `routes/fstream.js`, `routes/wiflix.js`, `liveTvRoutes.js`
- communautaire : `commentsRoutes.js`, `likesRoutes.js`, `sharedListsRoutes.js`, `wishboardRoutes.js`, `linkSubmissionsRoutes.js`
- VIP / paiements : `utils/vipDonations.js`, `routes/vipDonations.js`

## À garder en tête

- Le backend actif est ici, pas dans l'ancien contenu direct de `API/`.
- Plusieurs tables MySQL sont initialisées automatiquement au démarrage.
- Une partie du comportement applicatif dépend de caches disque et de proxys externes ; un bug peut venir d'ailleurs que du code route lui-même.
- Si une feature touche la lecture vidéo, regarde aussi `API/proxiesembed/` et parfois l'extension navigateur.
