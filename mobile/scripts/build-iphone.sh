#!/bin/bash
set -euo pipefail

if [[ "$(uname -s)" != "Darwin" ]]; then
  echo "La compilation iPhone nécessite macOS et Xcode. Utilisez le workflow GitHub Actions fourni."
  exit 1
fi

APP_ROOT="$(cd "$(dirname "$0")/.." && pwd)"
cd "$APP_ROOT"
command -v xcodebuild >/dev/null || { echo "Installez Xcode 16 ou ultérieur et ses outils de ligne de commande."; exit 1; }
command -v pod >/dev/null || { echo "Installez CocoaPods avant de lancer cette commande."; exit 1; }

node scripts/verify-iphone.cjs
npx cap sync ios

BUILD_ROOT="$APP_ROOT/ios/build-sidestore"
OUTPUT_ROOT="$APP_ROOT/dist"
mkdir -p "$BUILD_ROOT" "$OUTPUT_ROOT"
xcodebuild \
  -workspace ios/App/App.xcworkspace \
  -scheme App \
  -configuration Release \
  -sdk iphoneos \
  -destination 'generic/platform=iOS' \
  -derivedDataPath "$BUILD_ROOT/DerivedData" \
  MARKETING_VERSION="${APP_VERSION:-1.0}" CURRENT_PROJECT_VERSION="${APP_BUILD:-1}" \
  CODE_SIGNING_ALLOWED=NO CODE_SIGNING_REQUIRED=NO CODE_SIGN_IDENTITY= \
  build

BUILT_APP="$BUILD_ROOT/DerivedData/Build/Products/Release-iphoneos/App.app"
test -d "$BUILT_APP" || { echo "L'application iPhone compilée est introuvable."; exit 1; }
EXECUTABLE=$(/usr/libexec/PlistBuddy -c 'Print :CFBundleExecutable' "$BUILT_APP/Info.plist")
test -f "$BUILT_APP/$EXECUTABLE"
/usr/bin/lipo "$BUILT_APP/$EXECUTABLE" -verify_arch arm64

STAGING_ROOT="$(mktemp -d "$BUILD_ROOT/payload.XXXXXX")"
mkdir -p "$STAGING_ROOT/Payload"
ditto "$BUILT_APP" "$STAGING_ROOT/Payload/App.app"
(
  cd "$STAGING_ROOT"
  ditto -c -k --keepParent Payload "$OUTPUT_ROOT/FranceStudent-iPhone.ipa"
)
/usr/bin/unzip -t "$OUTPUT_ROOT/FranceStudent-iPhone.ipa"
echo "IPA non signé prêt pour SideStore : $OUTPUT_ROOT/FranceStudent-iPhone.ipa"
