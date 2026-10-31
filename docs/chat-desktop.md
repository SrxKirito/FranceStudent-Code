# Chat de l’IDE : outils, activité et affichage

Le chat desktop propose **Outils** dans la rangée du modèle, avec les préréglages
**Coder**, **Explorer** et **Complet**, ainsi que des cases par groupe. Le choix
s’applique à la prochaine demande Code ; une tâche déjà lancée garde ses outils.
Le choix est conservé par dossier pendant la session de l’IDE. Le réglage initial
Complet conserve le fonctionnement historique. Les tâches placées dans la file
conservent leur sélection lors de leur exécution, réessai ou reprise.

La lecture locale, les pièces jointes, la vision, le plan, les questions et le
suivi/arrêt des jobs restent disponibles. Les autorisations restent indépendantes :
le terminal ou MCP peut lui-même agir sur des fichiers. Le mode Plan conserve ses
restrictions de lecture seule. Le sélecteur Code est masqué en Motion ; le vrai
moteur EffectCraft et la séparation de ses conversations restent actifs.

Les appels successifs sont réunis dans une carte d’activité repliable. Chaque appel
affiche son outil, sa cible ou commande, et son état. Son résultat complet est
monté dans le DOM à l’ouverture du détail ; les résultats ordinaires restent repliés.
Une erreur ouvre automatiquement sa carte et reste signalée dans le résumé.
Un appel sans résultat à la fin de la tâche indique **Résultat non reçu** ; aucune
cause ni réussite n’est déduite de cette absence. Les associations suivent l’ordre
FIFO des événements, comme le backend ; aucun identifiant d’appel supplémentaire
n’a été inventé dans le protocole.

Le journal visible, l’export et l’historique conservent les événements d’origine.
Le chargement d’un ancien historique reconstruit les mêmes cartes sans supprimer
les résultats. Les cartes et la réflexion sont utilisables au clavier. Les éléments
Code/Motion sont finalisés avant le changement d’espace afin de ne pas partager
des résultats entre leurs vues.

L’affichage des fragments reste regroupé (80 ms pour les réponses courtes,
180 ms au-delà de 12 000 caractères). Les longues réponses en cours utilisent un
texte échappé léger, puis leur Markdown est rendu à la fin. Au-delà de 64 000
caractères, l’affichage final reste en texte complet pour éviter le coût de coloration.
Un contenu identique n’est pas repeint. Une fenêtre masquée conserve les fragments
sans lancer de rendus intermédiaires ; son retour affiche le contenu reçu. Le
défilement vers le bas est regroupé par frame et respecte une lecture plus haut.

Le pont `agentTools` fournit uniquement le catalogue des groupes. `submit` accepte
une sélection validée et ne permet pas au renderer de forcer le drapeau interne
`queued`. La sélection traverse aussi les commandes `/plan` via la portée
asynchrone ; elle ne devient jamais une instruction textuelle au modèle.

État du 31 octobre 2026 : syntaxe JavaScript contrôlée et bundle renderer régénéré
par `node scripts/build-renderer.js`. `npm run build:renderer` reste bloqué par les
dépendances absentes (`@xterm/xterm`). Aperçus Chrome headless inspectés en plein
écran 1280×900 et avec panneau de chat 420 px dans une fenêtre 900×600, à partir des
sources de rendu et de données de démonstration. Ces aperçus ne valident pas Electron,
les appels du fournisseur ou le moteur EffectCraft en fonctionnement.

Conformément à la préférence de développement, aucune suite automatisée n’a été
exécutée. Scénarios préparés : `e2e/chat-tools.e2e.test.js` (choix transmis au moteur,
résultats montés à la demande, erreurs visibles, résultats manquants, petite fenêtre)
et `test/stream-rendering.test.js` (texte long intermédiaire puis Markdown final).
Avant publication : tests du chat/compositeur et du streaming, historique long,
copie/sélection de texte, file et changement de projet, commandes `/plan`, clavier,
Mode Motion, accès/confirmations et vrais appels d’outils en environnement Electron.
