# FranceStudent IDE

FranceStudent IDE réunit un éditeur de code, un agent IA et un chat connecté à ton compte FranceStudent. Cette version est un fork du projet [FranceStudent Code d’EsteG7](https://github.com/EsteG7/francestudents-ide) ; les crédits et licences des contributeurs d’origine sont conservés.

[Téléchargements et versions](https://github.com/SrxKirito/FranceStudent-Code/releases) · [Guide d’utilisation](docs/guide-utilisation.md) · [Application mobile](https://github.com/SrxKirito/Francestudent-Mobile)

## Ce que permet l’application

- Ouvrir un projet local, éditer ses fichiers et utiliser le terminal intégré.
- Discuter avec l’agent de code, choisir un modèle et ajuster la réflexion lorsque le modèle le permet.
- Joindre des fichiers et consulter les réponses et les fichiers générés dans le chat.
- Utiliser les skills du compte FranceStudent et gérer les outils disponibles pour l’agent.
- Associer un téléphone avec IDE Link pour suivre et piloter la tâche en cours. La consultation des autres projets et discussions locales depuis le téléphone est en lecture seule ; elle ne change pas la discussion active sur l’ordinateur.
- Utiliser EffectCraft pour le motion design dans un espace distinct du projet de code.

Les fonctionnalités dépendent du compte, du modèle choisi et des services FranceStudent. Vérifie les modifications proposées par l’agent et les autorisations accordées aux outils.

## Installer

Télécharge l’installateur adapté depuis les [releases](https://github.com/SrxKirito/FranceStudent-Code/releases), puis connecte-toi à ton compte FranceStudent. Les fichiers proposés peuvent varier selon la version et la plateforme. Windows peut afficher un avertissement lorsque l’installateur n’est pas signé par un éditeur reconnu.

## Développement

Prérequis : Node.js et npm, ainsi que les dépendances nécessaires à Electron. Depuis le dossier du dépôt :

```bash
npm ci
npm run desktop
```

Les instructions de compilation, les vérifications et les limites par plateforme figurent dans [CONTRIBUTING.md](CONTRIBUTING.md) et les [guides](docs/README.md). Les données personnelles, dépendances installées, sorties de compilation et secrets ne doivent pas être ajoutés au dépôt.

## Crédits

Projet initial : [EsteG7 et les contributeurs de FranceStudent Code](https://github.com/EsteG7/francestudents-ide). Ce fork est maintenu sur [SrxKirito/FranceStudent-Code](https://github.com/SrxKirito/FranceStudent-Code). Consulte [CREDITS.md](CREDITS.md) et les licences des dépendances.
