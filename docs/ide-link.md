# IDE Link : piloter l’agent depuis son iPhone

Le parcours normal reste **Activer IDE Link → Scanner le QR code**, sans domaine,
compte Cloudflare ni serveur à héberger. Pour retrouver automatiquement le même
projet après fermeture puis relance de l’IDE, coche **Mémoriser cet iPhone pour ce
projet** avant le premier scan dans l’app iPhone à jour.

## Scanner une seule fois et retrouver son ordinateur

1. Ouvre le projet Code sur le PC et son panneau **IDE Link**.
2. Coche **Mémoriser cet iPhone pour ce projet**, puis active IDE Link.
3. Dans l’app iPhone, ouvre **France IDE → Scanner le QR code** et scanne le QR.
4. Après un redémarrage du PC ou de l’IDE, rouvre le même projet Code : IDE Link
   reprend automatiquement. Ouvre France IDE sur l’iPhone pour retrouver le PC.

L’adresse temporaire du tunnel peut changer ; c’est **l’association** qui reste.
Le PC annonce sa nouvelle adresse sous forme chiffrée au service public
[ntfy.sh](https://docs.ntfy.sh/faq/). Aucun compte ntfy, domaine ni déploiement
n’est demandé. L’iPhone vérifie l’identité du PC avant de reprendre l’accès.
Les identifiants sont protégés par le coffre système sur le PC et par le
Trousseau iOS, sans localStorage ni synchronisation iCloud. Le navigateur et les
anciennes apps conservent le fonctionnement temporaire avec QR/PIN. La mémorisation
nécessite le pont Trousseau et WebCrypto dans la WebView iOS ; sans ces capacités,
le scan fonctionne seulement pour la session courante.

La mémorisation autorise aussi l’accès aux prochaines conversations de ce projet.
**Suspendre IDE Link** ferme la connexion mais conserve l’association ; active-le
à nouveau pour reprendre. **Révoquer et associer un autre appareil**, décocher la
mémorisation ou **Déconnecter** sur le téléphone retire l’accès. La déconnexion ou
le changement explicite de compte sur le PC efface toutes les associations ; la
déconnexion du compte mobile efface l’association du Trousseau. **Oublier sur cet
iPhone** retire uniquement la copie locale : pour révoquer un téléphone perdu,
utilise les contrôles du PC. Un seul PC/projet est mémorisé à la fois dans l’app.

Le PC doit rester éveillé, connecté et ouvert sur le projet Code. Fermer l’IDE
arrête le tunnel ; aucun service permanent n’est installé. Un passage en Motion
ou un autre projet ferme le partage précédent tout en conservant son association.
Une nouvelle conversation du même projet peut être suivie sans nouveau scan.
La reconnexion s’effectue dans le panneau mobile ouvert ou à son retour au premier
plan, sans notification APNs ni exécution garantie en arrière-plan. En cas d’échec
du démarrage automatique, ouvre le panneau PC et relance IDE Link.

### Données et disponibilité de la découverte

ntfy reçoit un identifiant aléatoire de canal et une annonce AES-256-GCM contenant
l’adresse, un numéro de séquence, une expiration et l’état en ligne/révoqué. Le
service ne reçoit ni conversation, fichier, nom de projet, clé de déchiffrement
ni identifiant d’accès IDE Link. Il voit cependant les métadonnées de transport,
dont les adresses IP et horaires ; consulter sa [politique de confidentialité](https://docs.ntfy.sh/privacy/).
L’échange avec l’IDE passe toujours par le tunnel HTTPS Cloudflare.

Le service public est externe, soumis à ses [limites](https://docs.ntfy.sh/publish/#limitations)
et à ses [conditions](https://docs.ntfy.sh/terms/), sans garantie de disponibilité.
Le PC publie au démarrage, aux changements d’état puis toutes les 30 minutes,
avec une validité de 45 minutes. Les échecs sont espacés et l’installation limite
ses tentatives à 150 par jour. Un quota partagé ou une panne peut retarder la
découverte ; une session déjà connectée reste utilisable tant que son tunnel
fonctionne. Les annonces chiffrées peuvent rester dans le
[cache ntfy](https://docs.ntfy.sh/publish/#message-caching) après leur expiration ;
le client refuse les annonces expirées et les signatures invalides. Une révocation
coupe immédiatement l’accès au PC, même si son annonce ne peut pas être publiée.

Voir le [contrat technique](#contrat-avec-lapplication-iphone) et les limites de
validation ci-dessous. Ce parcours est développé dans les sources locales ;
aucune publication ni validation physique n’est revendiquée.

## Garder la même adresse après fermeture de l’IDE

Cette configuration est facultative. Dans le panneau PC, déplie **Options avancées
· adresse fixe**, puis coche **Utiliser mon propre domaine pour une adresse fixe**.
Le mode temporaire reste disponible par défaut. Un Quick Tunnel change de nom
à chaque lancement et ne peut pas conserver son URL : une adresse fixe utilise
un tunnel Cloudflare dédié et ton propre domaine.
[Référence Cloudflare](https://developers.cloudflare.com/tunnel/get-started/quick-tunnels/).

Si tu n’as encore ni domaine ni tunnel :

1. Crée un compte Cloudflare et ajoute un domaine que tu possèdes, ou enregistre
   un domaine. Le domaine est nécessaire pour publier l’application ; l’IDE ne
   crée pas de compte, n’achète pas de domaine et n’effectue pas de changement DNS.
2. Dans le tableau de bord, ouvre **Networking → Tunnels → Create Tunnel** et crée
   un tunnel dédié à IDE Link, pour cet ordinateur.
3. Ajoute une application publiée : nom public, par exemple `ide.ton-domaine.fr`,
   type **HTTP**, service **127.0.0.1:43821**. Si tu changes le port, utilise le même
   dans les deux applications. Garde le nom public d’origine comme en-tête Host.
4. Dans l’IDE, saisis l’URL `https://ide.ton-domaine.fr`, puis colle uniquement le
   jeton du tunnel (pas la commande entière). L’IDE lance le cloudflared embarqué ;
   il n’est pas nécessaire d’installer une deuxième instance comme service.
5. Clique **Enregistrer le choix**, puis **Activer IDE Link**. L’IDE vérifie que
   l’adresse publique rejoint bien son propre serveur avant d’afficher le QR.

[Guide officiel de création](https://developers.cloudflare.com/tunnel/get-started/).
Les jetons peuvent être fournis à cloudflared via `TUNNEL_TOKEN` ; l’IDE utilise
cette variable uniquement dans le processus enfant, jamais dans ses arguments.
[Paramètres officiels](https://developers.cloudflare.com/tunnel/reference/run-parameters/#token).

Le domaine, le port et le jeton protégé par le coffre système sont conservés dans
les réglages existants. Le jeton n’est ni affiché à nouveau, ni placé dans le QR,
ni enregistré en clair. Sans coffre utilisable, l’enregistrement fixe est refusé.
L’option **Effacer la configuration** retire ces réglages locaux ; révoquer le
jeton Cloudflare lui-même se fait dans Cloudflare.

Après redémarrage, l’adresse fixe est réutilisée à l’activation. Sans mémorisation,
l’activation et un nouveau scan sont nécessaires à chaque démarrage. Avec un
iPhone mémorisé pour le projet, la reprise automatique décrite ci-dessus utilise
aussi cette adresse fixe. Aucun service ne tourne quand l’IDE est fermé : le
domaine reste réservé mais ne peut pas piloter l’agent hors connexion.

L’app iPhone accepte maintenant l’adresse publique fixe en HTTPS, en plus du
domaine temporaire. Les adresses IP, domaines locaux, identifiants intégrés et
redirections restent refusés. Une éventuelle authentification interactive
Cloudflare Access supplémentaire n’est pas prise en charge par le client natif.

État de développement : stockage/configuration et tunnel fixe préparés, syntaxe
contrôlée. Tests `test/ide-link-settings.test.js` et scénario tunnel fixe dans
`test/ide-link.test.js` préparés, non exécutés selon la consigne. Aucun vrai domaine,
tunnel, chiffrement système ou parcours iPhone n’est validé par ces simulations.
Avant publication : reprise à froid, coffre verrouillé, port occupé, domaine mal
routé, arrêt pendant la vérification, renouvellement/révocation et vrai tunnel.
Le panneau de configuration et son guide ont été inspectés dans un aperçu Chrome
avec valeurs fictives ; cela ne constitue pas un essai de connexion Cloudflare.

Dans l’IDE, ouvre un projet Code puis **IDE Link** à côté des contrôles du chat.
Active la connexion et laisse l’ordinateur allumé, avec Internet disponible.
Dans l’app FranceStudent iPhone, ouvre **France IDE → Scanner le QR code**.
Avec les deux clients mis à jour, le scan associe le téléphone et ouvre le contrôle
dans l’app. Aucun compte ou cookie FranceStudent n’est transmis par ce QR.

Le téléphone retrouve la conversation, la réponse en cours, le plan de travail,
la file et les questions/confirmations de l’agent. Il peut envoyer une demande en
mode Agent ou Plan, joindre jusqu’à quatre fichiers (2 Mio au total), interrompre
la tâche, suspendre/reprendre la file, retirer une demande et orienter une tâche
quand l’IDE le permet. Les autorisations restent celles de l’agent sur l’ordinateur.
Les commandes `/` ne sont pas acceptées à distance.

L’IDE indique l’appareil associé. **Révoquer et associer un autre appareil** crée
un nouveau QR et invalide immédiatement l’ancien accès. **Arrêter IDE Link** coupe
le tunnel. **Déconnecter** dans l’app révoque aussi l’accès et prépare une nouvelle
association sur l’ordinateur. Fermer seulement le panneau mobile suspend le suivi ;
le rouvrir reprend la session tant que le processus de l’app est conservé.

Le QR est privé : il contient un ticket aléatoire de 256 bits dans le fragment du
lien, valable dix minutes et une seule fois. Le PIN manuel partage cette expiration
et la limite de cinq essais. Après association, les deux sont invalidés et remplacés
par un jeton distinct. Ne partage pas de capture du QR ou du PIN.

Sans scanner, déplie **Connexion manuelle avec un PIN**, puis colle l’adresse dans
l’app et saisis le PIN. Depuis l’appareil photo iOS ou un navigateur, le QR ouvre la
page web de contrôle et réalise la même association unique. Les anciennes apps qui
n’acceptent pas le nouveau QR peuvent utiliser l’adresse et le PIN manuellement.

## Contrat avec l’application iPhone

L’application mobile est maintenue dans le dépôt séparé
[SrxKirito/Francestudent-Iphone](https://github.com/SrxKirito/Francestudent-Iphone).
Le client de contrôle est `android-app/www/js/ide-link.js`, chargé par `index.html`
avec `www/js/ide-link-remembered.js` ; son style est `www/ide-link.css`. Il utilise
`QRScanner`, `CapacitorHttp` et le pont local `IDELinkVault` ajouté au fichier Swift
existant `FileSaverPlugin.swift` et enregistré dans `FranceStudentViewController`.
Le pont utilise Security/Keychain d’iOS, sans nouveau paquet natif tiers.

- `POST /api/pair` : `{ticket, deviceName, remember?}` ou `{pin, deviceName, remember?}` ;
  réponse `{token, protocolVersion: 2, remembered?}`. Le fragment `#ide-link=…`
  fournit le ticket. `remembered` n’est délivré que si les deux clients demandent
  la mémorisation ; il contient les identifiants à conserver dans leurs coffres.
- `GET /api/identity?nonce=…` : preuve HMAC du PC, liée à l’origine HTTPS,
  l’association, un nonce mobile et un défi à usage unique valable 30 secondes.
- `POST /api/resume` : `{challenge, mac}` ; vérifie la preuve mobile, consomme
  le défi et délivre le bearer de la session courante. Les HMAC `server:` et
  `client:` sont distincts pour empêcher la réflexion. Aucun secret durable
  n’est envoyé dans la requête de reprise.
- `POST /api/state` : historique, texte en cours, plan, questions, file et
  `session.project` (nom du dossier uniquement).
- `POST /api/tasks`, `/api/queue`, `/api/prompt` : mêmes contrôles et limites que
  le client web existant ; `Authorization: Bearer …` obligatoire.
- `POST /api/disconnect` : invalide le jeton et prépare un nouveau QR côté IDE.

Le transport natif envoie explicitement `Origin: capacitor://localhost` ; les
origines Capacitor exactes autorisées sont `capacitor://localhost`,
`https://localhost` et `http://localhost`. Un prévol CORS autorise seulement POST,
Authorization et Content-Type. Le Host doit correspondre au tunnel courant et
l’association reste obligatoire. Le client iPhone exige un hôte public en HTTPS
et refuse les ports personnalisés, chemins et redirections. Il accepte
les domaines fixes configurés dans l’IDE ; les IP et noms locaux restent refusés.

Le bearer de session reste en mémoire, jamais dans localStorage. En mode mémorisé,
seuls les identifiants durables et la dernière séquence acceptée vont au Trousseau
`WhenUnlockedThisDeviceOnly`. `desktop/ide-link-remembered.js` conserve leur
équivalent chiffré par `src/secret-storage`, séparément pour chaque projet.
La découverte utilise l’[API de lecture ntfy](https://docs.ntfy.sh/subscribe/api/),
AES-GCM avec AAD fixe et des séquences réservées par blocs avant publication pour
éviter leur réutilisation après crash. Les défis et bearers restent en mémoire.
Le suivi lit l’état toutes les 1,5 seconde lorsque le panneau est visible et
ralentit à cinq secondes après plusieurs réponses inchangées ;
les erreurs réseau espacent progressivement les lectures jusqu’à quinze secondes.
aucune consigne n’est renvoyée automatiquement en cas de coupure réseau. Si un
envoi échoue sans réponse, vérifier l’IDE avant de le soumettre à nouveau.

## Limites et validation à effectuer

Cette fonction concerne le projet Code courant. Un changement de projet ou
passage en Motion arrête le partage existant. Un changement de conversation
arrête le mode temporaire ; le mode mémorisé suit la nouvelle conversation du
même projet et invalide les écritures en cours de l’ancienne. L’ordinateur doit
rester éveillé et le tunnel Cloudflare opérationnel ; aucune exécution cloud,
notification APNs ni continuité iOS en arrière-plan n’est fournie. Fermer le
processus mobile oblige à refaire l’association en mode temporaire ; la
mémorisation permet la reprise depuis le Trousseau. Le nom de l’appareil indique une
association, pas une preuve de présence réseau. Il n’y a pas de synchronisation
générale des fichiers ou de choix de plusieurs conversations à distance.

Développement du 31 octobre 2026 : code et scénarios préparés ; suites automatisées
non exécutées, conformément à la préférence du contributeur. Contrôles de syntaxe
JavaScript effectués et `desktop/renderer/app.js` régénéré par
`node scripts/build-renderer.js`. La commande complète `npm run build:renderer`
reste bloquée par l’absence de `node_modules` (`@xterm/xterm` introuvable).

Avant publication : installer les dépendances, construire le renderer complet,
exécuter les tests IDE Link unitaires (dont `test/ide-link-remembered.test.js`)
et Electron, puis les contrôles mobiles `test-ide-link.cjs`,
`test-ide-link-remembered.cjs`, `test-ios-bridge.cjs` et `test-library.cjs`. Construire l’IPA
sur macOS et essayer sur iPhone : caméra, scan annulé, QR expiré/utilisé,
PIN incorrect, révocation, coupure réseau, retour de veille, clavier/petite fenêtre,
questions simultanées desktop/mobile, pièces jointes et isolation Code/Motion.
Pour la mémorisation : quitter/relancer les deux apps, changer l’URL du tunnel,
verrouiller les coffres, couper ntfy ou simuler son quota, suspendre/révoquer,
changer de compte/projet et refuser une annonce ou une preuve falsifiée. Les
tests préparés simulent réseau et coffres ; ils ne valident pas DPAPI/Keychain,
les services publics, la compilation Swift ni la connexion sur iPhone physique.
Le rendu mobile à 390 px et son panneau d’outils ont été inspectés dans Chrome
headless avec les sources et des données de démonstration. Le runtime
d’automatisation native de l’ordinateur n’a pas pu être initialisé. Cet aperçu
ne valide pas le tunnel réel, Electron, WKWebView/iPhone ou la compilation Xcode.
Les aperçus de la mémorisation PC et de l’écran mobile hors ligne ont aussi été
inspectés dans Chrome avec données fictives. À 900×600, le panneau PC défile ;
les instructions et explications de confidentialité sont dépliables pour garder
le QR visible. Cela ne valide pas les capacités WebCrypto d’un ancien iOS.

## Sélection des outils et interface mobile

**Conversation** regroupe les messages et réponses Markdown. **Activité** regroupe
les appels d’outils et résultats dans des détails repliables. Le plan est consultable,
la file reste proche du compositeur et les pièces jointes peuvent être retirées
individuellement. Le panneau d’outils propose :

- **Coder** : fichiers, terminal/diagnostics et skills.
- **Explorer** : web/navigateur et skills, avec les lectures locales de base.
- **Complet** : tous les groupes exposés par l’IDE.

Chaque groupe peut être coché séparément. Lecture/recherche locale, pièces jointes,
vision, plan, questions et suivi/arrêt des jobs restent disponibles. Le choix
s’applique à la prochaine demande et est conservé dans la file, y compris après
redémarrage de l’IDE. Orienter une tâche conserve les outils de cette tâche active.
Cette sélection ne remplace pas les permissions : un terminal ou MCP peut lui-même
agir sur les fichiers. Pour préparer seulement un plan, choisir **Plan · lecture seule**.

`POST /api/tasks` accepte `toolGroups: string[]` (IDs de `/api/state.toolGroups`).
`[]` conserve les outils de base ; absence/null conserve le comportement historique.
Le registre valide chaque appel et son exécution, y compris les lots et sous-agents.
Les portées asynchrones sont séparées ; un sous-agent ne peut pas élargir son parent.
Le catalogue principal et les rappels omettent les outils exclus. MCP exclu n’est
pas démarré par la tâche ; son catalogue est omis, comme celui des skills exclus.
La signature du cache inclut cette sélection. Les règles Code/Motion restent actives.

`POST /api/state?since=<revision>` renvoie `{unchanged:true, revision}` si l’état
est identique, après authentification. Le serveur sérialise encore l’état complet
pour calculer sa révision ; il ne s’agit pas d’un flux incrémental. Le mobile ne
reconstruit plus les messages inchangés et conserve leurs détails ouverts.
Les gains de quota fournisseur et de consommation réseau réelle restent à mesurer.

Scénarios préparés, non exécutés : `test/tool-selection.test.js` (groupes, portées
concurrentes/imbriquées, catalogue filtré), nouveaux cas `test/ide-link.test.js`
(sélection transmise et réponses inchangées). Avant publication, compléter avec
file restaurée, bascule de groupes sur une conversation existante, appels natifs,
lots, MCP exclu, skills exclus, Plan, Mode Motion et essais physiques iPhone.
