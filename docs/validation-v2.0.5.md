# Validation de FranceStudent IDE 2.0.5 — 31 octobre 2026

Release publiée : https://github.com/SrxKirito/FranceStudent-Code/releases/tag/v2.0.5
Sources construites et tag immuable : `8781c5dd14def77055c2ff8b8868fe8c58089089`.

## Contrôles

- Validation complète : https://github.com/SrxKirito/FranceStudent-Code/actions/runs/41217639401 (réussie).
- Windows x64 : 840 tests unitaires, 837 réussis, 3 ignorés ; 38 parcours Electron réussis. Essai de l’application empaquetée réussi : terminal natif, dictée locale et vrai moteur EffectCraft.
- Mac Apple Silicon ARM64 : 840 tests unitaires, 833 réussis, 7 ignorés ; quatre parcours migration/sécurité/mise à jour et essai de l’application empaquetée réussis. Signature ad hoc vérifiée dans le paquet et dans le DMG monté.
- Audit npm sans vulnérabilité ; lint sans erreur (trois avertissements). Renderer reconstruit et vérifié.
- Transmission des artefacts validés : https://github.com/SrxKirito/FranceStudent-Code/actions/runs/41219391529.
- Six assets publiés : installateur Windows, blockmap, latest.yml, DMG ARM64, ZIP ARM64 et SHA256SUMS.txt. Tailles et empreintes distantes comparées aux fichiers récupérés de la CI. Métadonnées Windows SHA-512 vérifiées ; version et architecture ARM64 du ZIP Mac contrôlées.

## Correctifs de préparation

- Dépendances minimatch, ASAR et glob corrigées pour obtenir un audit propre et un assemblage compatible.
- Les dialogues de nouveautés, Roblox et sauvegardes ne se superposent plus. Parcours vérifié dans Electron et dans les paquets construits.
- Les tests suivent les nouvelles cartes d’outils, l’intégralité du catalogue intégré et l’ordre des introductions, tout en conservant leurs assertions de contenu et de persistance.
- Les vérifications Linux restent actives ; seuls Windows et macOS ARM64 construisent des applications.

## Limites

Windows reste non signé en l’absence de certificat ; macOS est signé ad hoc et non notarisé. Les essais CI ne constituent pas un essai sur Mac physique. Les services Cloudflare/ntfy et la connexion d’un téléphone physique ne sont pas validés par les scénarios simulés d’IDE Link. Le relais public de découverte conserve ses limites de disponibilité et de quota. Aucun portable ni paquet Mac Intel n’est publié.
