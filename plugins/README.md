# Connexions Roblox Studio et Blender

Ces connexions appartiennent à l’espace **Code** de la copie expérimentale. Elles utilisent les outils MCP déjà soumis aux confirmations de l’IDE. Elles ne publient aucune scène automatiquement.

## Roblox Studio

Dans **Plugins → Roblox Studio**, cliquer sur **Configurer le plugin**. L’IDE cherche le lanceur officiel `%LOCALAPPDATA%\Roblox\mcp.bat` sous Windows, ou `StudioMCP` dans l’application RobloxStudio sous macOS. S’il manque, mettre Studio à jour puis activer **Assistant → … → Manage MCP Servers → Enable Studio as MCP server**. L’IDE ne modifie pas ce réglage à la place de l’utilisateur.

Ouvrir un projet dans Studio puis **Vérifier la connexion**. Le serveur MCP peut répondre sans aucune session ouverte : la liste des instances reste la preuve de la session disponible. L’agent doit utiliser le `studio_id` retourné, lire les schémas et vérifier les résultats. Les outils de génération propres à Roblox peuvent consommer ses crédits ; cette connexion ne les inclut pas dans le quota FranceStudent.

Source : [guide officiel Roblox Studio MCP](https://create.roblox.com/docs/studio/mcp).

## Blender

Dans **Plugins → Blender**, cliquer sur **Configurer le plugin** puis **Choisir Blender…** si son exécutable n’est pas détecté. **Ouvrir Blender connecté** lance une nouvelle fenêtre avec `bootstrap.py`, qui charge l’extension locale pour cette session. Cela ne change pas les préférences enregistrées et ne ferme pas les autres fenêtres.

Pour une fenêtre déjà ouverte : **Enregistrer l’extension Blender…**, installer ce fichier Python avec le gestionnaire d’extensions/add-ons de Blender, l’activer, puis ouvrir le panneau **Vue 3D → N → FranceStudent**. Renseigner le **Fichier IDE** indiqué dans les détails du plugin de l’IDE et cliquer sur **Connecter à l’IDE**. Revenir dans l’IDE et cliquer sur **Vérifier la connexion**.

Outils fournis : inventaire de scène, inspection d’objet, primitives, transformations, matériaux et suppression de noms précis. La capture lit le viewport d’une vraie fenêtre avec une vue 3D ouverte. Les scripts Python restent désactivés par défaut ; l’utilisateur peut les activer dans le panneau Blender. Un script autorisé s’exécute avec les droits de Blender et peut produire des effets avant une erreur ou un arrêt. Les échecs avec effets possibles et les pertes de connexion sont marqués comme incertains afin d’éviter de répéter une mutation à l’aveugle.

L’extension utilise un socket limité à `127.0.0.1`, un port attribué par le système et une clé aléatoire par connexion. Le fichier de session reste dans le dossier de données local de l’IDE ; il n’est ni intégré au code ni envoyé au modèle. Les appels Blender s’exécutent sur son thread principal via un timer, sans thread Python manipulant `bpy`. La déconnexion ferme le socket et retire le fichier de session correspondant. Un fichier restant après un crash ne prouve pas une connexion active.

## État de validation

Les cartes partagent le composant GitHub et affichent les logos Simple Icons (crédits dans `desktop/renderer/assets/plugin-logos-NOTICE.md`). Une vérification réussie avec une session réelle classe le plugin dans **Installés**, avec un raccourci de navigation. L’état est conservé dans `plugins/creative.json` du profil ; son empreinte dépend de la commande, des arguments et de l’environnement MCP. Un serveur désactivé ou modifié demande une nouvelle vérification. Ce classement ne prouve pas une connexion en cours. Pour Roblox, un serveur répondant sans session Studio ne suffit pas.

Le classement, la relecture de cet état et son invalidation ont été contrôlés avec des données simulées. Le retour depuis Motion restaure également l’état d’accueil du chat Code, même si celui-ci contient seulement les notices de session.

Le 2 novembre 2026, les cartes et dialogues ont été contrôlés avec les vrais composants du renderer dans un aperçu local, et la syntaxe JavaScript/Python a été vérifiée. Sur ce PC, ni le lanceur MCP officiel Studio ni Blender n’étaient détectés aux emplacements habituels. Aucune connexion à un vrai Studio ni exécution dans Blender ne sont donc revendiquées. Ces parcours, l’installation de l’add-on, la capture du viewport, les versions de Blender/Studio et macOS restent à vérifier avec les applications installées. Aucune suite automatisée ni publication.
