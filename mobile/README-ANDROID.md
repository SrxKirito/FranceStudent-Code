# Android — IDE Link

L’interface dans `www` est partagée avec iPhone : conversation, activité,
sélection des outils, QR/PIN et reconnexion au projet mémorisé.

`npm ci` puis `npm run sync` crée le projet Capacitor Android ignoré par Git,
copie les plugins de `android-native` et synchronise les ressources. Les fichiers
MainActivity et plugins générés viennent de ces sources : les modifier ici,
puis relancer la préparation. `npm run apk` construit un APK debug avec Java 21
et le SDK Android installés. Le workflow Compiler Android fournit aussi cet APK
comme artefact de vérification ; ce n’est pas une signature de distribution.

Le coffre utilise AndroidKeyStore et AES-GCM. Seul le texte chiffré va dans les
préférences privées, avec une clé non exportée. Une restauration sans la clé du
téléphone exige un nouveau scan. Ni clés ni association dans localStorage.

Le scanner utilise [Google Code Scanner](https://developers.google.com/ml-kit/vision/barcode-scanning/code-scanner),
limité aux QR codes. Google Play Services doit être disponible ; le module peut
être téléchargé au premier usage. Sinon, utiliser le lien et le PIN. L’association
reste temporaire si WebCrypto ou le coffre n’est pas disponible. La reconnexion
ne maintient pas un service Android permanent en arrière-plan.

La compilation CI ne remplace pas un essai sur téléphone : vérifier scanner,
annulation, coffre après relance, révocation, veille et changement de projet.
