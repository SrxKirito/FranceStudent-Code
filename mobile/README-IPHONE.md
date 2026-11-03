# FranceStudent Chat pour iPhone — SideStore

Version iPhone du même chat que l'application Android. Minimum : **iOS 16.4**.

Le projet contient l'interface complète, les projets et réglages, la dictée vocale,
la connexion native et l'enregistrement des fichiers dans l'app **Fichiers**.

## Obtenir l'IPA sans Mac personnel

La compilation doit s'exécuter sur macOS avec Xcode. Le workflow
`.github/workflows/build-iphone.yml` utilise une machine macOS de GitHub Actions.
Il construit un IPA **non signé**, sans identifiant Apple ni certificat dans GitHub.
SideStore se charge ensuite de la signature sur l'iPhone.

1. Mettre le dossier `mobile` et `.github` à la racine d'un dépôt GitHub.
2. Ouvrir **Actions → Compiler FranceStudent pour SideStore → Run workflow**.
3. Attendre la fin de la compilation, puis télécharger l'artefact
   **FranceStudent-iPhone-SideStore** depuis la page du run.
4. Décompresser cet artefact : il contient `FranceStudent-iPhone.ipa`.
5. Sur l'iPhone où SideStore est déjà configuré, ouvrir **SideStore → My Apps → +**
   et sélectionner l'IPA dans Fichiers. Accepter la signature avec son propre compte Apple.

Une archive ZIP des sources ne s'installe pas dans SideStore. Il faut l'IPA produit
par une compilation réussie. Les limites et renouvellements dépendent du compte
Apple et de la configuration SideStore ; aucun compte Apple n'est stocké ici.

## Compiler sur un Mac

Prérequis : Xcode 16 ou ultérieur, Node.js 22 ou ultérieur, CocoaPods.

```bash
cd mobile
npm ci
npm run ipa
```

Résultat : `mobile/dist/FranceStudent-iPhone.ipa`.
Le script refuse une exécution sous Windows et cible un véritable appareil arm64,
pas un simulateur. Il lance `cap sync ios` avant chaque compilation.

## Fichiers et autorisations

- Les fichiers téléchargés se trouvent dans **Fichiers → Sur mon iPhone → FranceStudent Chat**.
- Le microphone et la reconnaissance vocale sont demandés pour la dictée.
- La caméra et les photos sont utilisées lorsqu'on joint une image ou change l'avatar.
- La connexion au compte utilise les mêmes serveurs FranceStudent que l'application Android.
- Le clavier, l'encoche et la zone d'accueil iOS sont pris en compte par l'interface.
- Pour créer une présentation à partir d’un sujet ou de documents joints, demander « Crée un PowerPoint de 5 diapositives sur… ». Le fichier `.pptx`, modifiable et accompagné de notes si fournies, se télécharge depuis la réponse comme les autres documents. La génération du fichier s'effectue sur le téléphone, sans service de conversion externe.
- Après une mise à jour de PptxGenJS, `npm run vendor:powerpoint` actualise le générateur embarqué et ses licences.

## Vérifications

### Contrôler l’agent de l’ordinateur avec IDE Link

Dans **France IDE**, le scanner QR natif associe l’app à un projet Code de
FranceStudent IDE et ouvre sa conversation directement dans l’app. Les deux clients
doivent intégrer le protocole IDE Link 2. Le lien manuel avec PIN reste disponible.
Le panneau propose conversation en direct, plan, questions et confirmations,
file, consignes Agent/Plan, arrêt et pièces jointes (4 fichiers, 2 Mio).
Le PC doit rester allumé et connecté à Internet ; la génération tourne sur le PC.

Le QR contient un ticket privé à usage unique valable dix minutes. Le jeton de
session reste en mémoire : fermer le panneau suspend son suivi. Sans mémorisation,
quitter le processus de l’app nécessite une nouvelle association. **Déconnecter** révoque
l’accès côté IDE. Ne partage pas de capture du QR. La reprise de lecture au retour
dans le panneau n’envoie aucune nouvelle consigne. Un envoi sans réponse réseau
doit être vérifié dans l’IDE avant d’être soumis de nouveau.

Implémentation : `www/js/ide-link.js` et `www/ide-link.css`, avec les plugins
`QRScanner` et `CapacitorHttp` déjà présents. Le client accepte uniquement les
adresses HTTPS publiques de l’IDE, temporaires ou fixes, et refuse les IP, noms
locaux, ports personnalisés et redirections. Pas de nouveau
paquet natif tiers. En cas de caméra indisponible, coller le lien QR
ou saisir l’adresse et le PIN affichés par l’IDE.

Pour scanner une seule fois, coche **Mémoriser cet iPhone pour ce projet** sur
le PC avant d’activer IDE Link, puis scanne dans l’app à jour. Au redémarrage,
rouvre le même projet Code sur le PC et France IDE sur l’iPhone. Le tunnel peut
changer d’adresse : l’app retrouve le PC via des annonces AES-256-GCM sur le
service public [ntfy.sh](https://docs.ntfy.sh/faq/), sans domaine, compte ntfy ou
serveur à héberger. Le PC doit rester éveillé et connecté ; fermé, il ne répond pas.
Cette autorisation couvre aussi les prochaines conversations du même projet.

`www/js/ide-link-remembered.js` conserve les identifiants durables dans le
Trousseau via le pont local `IDELinkVault` ajouté à `FileSaverPlugin.swift`
et enregistré dans `FranceStudentViewController.swift`. Il utilise le framework
Security d’iOS, sans dépendance tierce, localStorage ou synchronisation iCloud.
Une preuve HMAC mutuelle, liée à l’origine HTTPS et à un défi à usage unique,
vérifie le PC avant d’obtenir un nouveau jeton de session. Les annonces publiques
ne contiennent ni clés, conversation, fichier ou nom du projet ; le fournisseur
voit les métadonnées réseau. Ses [conditions](https://docs.ntfy.sh/terms/) et
[limites](https://docs.ntfy.sh/publish/#limitations) s’appliquent, sans garantie
de disponibilité. Une panne peut retarder la découverte. Reprise seulement dans
le panneau ouvert ou à son retour au premier plan, sans APNs.

**Suspendre IDE Link** sur PC conserve l’association. Réassocier/décocher sur PC,
**Déconnecter** sur mobile ou changer explicitement de compte sur PC révoque
l’accès. **Oublier sur cet iPhone** et la déconnexion du compte mobile retirent
le Trousseau local ; pour un téléphone perdu, révoquer depuis le PC.
Un seul PC/projet est mémorisé à la fois sur l’iPhone. Les anciennes apps et
la page navigateur restent temporaires. L’option avancée de domaine Cloudflare
fixe reste facultative ; aucun jeton Cloudflare n’est envoyé au téléphone.

**Outils** propose Coder (fichiers, terminal, skills), Explorer (web, skills) et
Complet, avec choix individuel des groupes. La sélection s’applique à la prochaine
demande et est conservée par la file de l’IDE. Lecture locale, questions et plan
restent disponibles. Cette sélection ne remplace pas les permissions de l’IDE.
Le mode Plan conserve sa restriction de lecture seule.

La vue sépare Conversation et Activité, avec Markdown partagé, détails techniques
repliables et pièces jointes retirables. Les messages inchangés conservent leurs
nœuds DOM. Le suivi utilise `since=<revision>` et ralentit de 1,5 à cinq secondes
après plusieurs réponses inchangées. Les gains réels restent à mesurer.
Les erreurs réseau espacent les lectures jusqu’à quinze secondes ; les actions
de l’utilisateur ne sont jamais renvoyées automatiquement.

État du 31 octobre 2026 : syntaxe contrôlée et aperçu 390 px inspecté dans Chrome
headless avec données de démonstration ; tests automatisés,
build Xcode et essai sur iPhone à réaliser avant publication. Contrôles dédiés :
`node test-ide-link.cjs`, `node test-ide-link-remembered.cjs`,
`node test-ios-bridge.cjs`, `node test-library.cjs`.
Vérifier aussi expiration, révocation, coupure réseau, retour au premier plan,
clavier et questions résolues depuis l’ordinateur. Pour la mémorisation : relance
des deux apps, nouvelle adresse du tunnel, coffre verrouillé, panne/quota ntfy,
annonce/preuve falsifiée, révocation hors ligne et changement de compte/projet.
Les scénarios préparés simulent les services et le Trousseau ; aucun essai réel
ntfy/Cloudflare, Keychain ou compilation Swift n’est validé ici.

```bash
node scripts/verify-iphone.cjs
node test-restoration.cjs
node test-general-settings.cjs
node test-mcp-wizard.cjs
node test-projects-activity.cjs
node test-message-actions.cjs
node test-mobile-input.cjs
node test-powerpoint.cjs
```

Ces vérifications ne remplacent pas une compilation Xcode ni un essai sur iPhone.

Références : [Capacitor 7 iOS](https://capacitorjs.com/docs/v7/ios),
[installation de SideStore](https://docs.sidestore.io/docs/installation/install).

## Mises à jour dans SideStore

Ajouter une seule fois cette URL dans les sources de SideStore :

`https://raw.githubusercontent.com/SrxKirito/Francestudent-Iphone/main/source.json`

Sur `main`, les modifications iPhone ou communes déclenchent la compilation iPhone ; une modification limitée aux sources natives Android ne la déclenche pas. Après les tests et une compilation réussie, le workflow publie une Release GitHub avec l’IPA et la source. La version iOS augmente à chaque nouveau run ; le numéro et la taille annoncés sont extraits de l’IPA compilé. SideStore peut ensuite proposer la mise à jour directement. L’installation et la signature restent gérées par SideStore.

## Reprise, bibliothèque et notifications locales

Le client sauvegarde les réponses en attente, le texte reçu et le dernier identifiant SSE. Au retour, il utilise `GET /chats/{chatId}/stream?last_event_id=…` pour reprendre le flux existant, sans renvoyer le message au modèle. Si le flux n’est plus disponible, il recherche la réponse enregistrée dans le chat. La conservation et la durée de vie des générations restent gérées par le serveur FranceStudent.

La Bibliothèque regroupe localement les pièces jointes originales, les fichiers générés et les images. Elle propose recherche, filtres, aperçu, enregistrement et classement dans un projet. Les originaux déjà perdus dans les anciennes versions ne peuvent pas être recréés à partir du texte extrait.

Le bouton de notifications de la Bibliothèque demande l’autorisation iOS. Une notification locale est produite si le transport natif reçoit la fin du flux alors que l’app est en arrière-plan. Cela ne fournit pas de notification APNs lorsque l’app est complètement arrêtée : l’intégration d’un service push côté serveur et une signature disposant des capacités APNs seraient nécessaires.
