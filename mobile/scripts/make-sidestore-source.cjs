const fs = require('node:fs');
const path = require('node:path');
const JSZip = require('jszip');
const plist = require('plist');
const bplist = require('bplist-parser');

async function makeSource(ipaPath, { repo, commit, date = new Date().toISOString() }) {
  if (!/^[a-z0-9][\w.-]*\/[a-z0-9][\w.-]*$/i.test(repo) || !/^[a-f0-9]{40}$/.test(commit)) throw new Error('Dépôt ou commit invalide.');
  const bytes = fs.readFileSync(ipaPath);
  const zip = await JSZip.loadAsync(bytes, { checkCRC32: true });
  const infoPath = Object.keys(zip.files).find(name => /^Payload\/[^/]+\.app\/Info.plist$/.test(name));
  if (!infoPath) throw new Error('Application absente de l’IPA.');
  const raw = await zip.file(infoPath).async('nodebuffer');
  const info = raw.subarray(0, 6).toString() === 'bplist' ? bplist.parseBuffer(raw)[0] : plist.parse(raw.toString());
  if (info.CFBundleIdentifier !== 'org.francestudent.chat') throw new Error('Identifiant de l’application inattendu.');
  const version = String(info.CFBundleShortVersionString);
  if (!/^\d+\.\d+(\.\d+)?$/.test(version)) throw new Error('Version iOS invalide.');
  const tag = 'ios-' + version;
  const sourceURL = `https://raw.githubusercontent.com/${repo}/main/source.json`;
  const iconURL = `https://raw.githubusercontent.com/${repo}/${commit}/mobile/ios/App/App/Assets.xcassets/AppIcon.appiconset/AppIcon-512@2x.png`;
  const appVersion = {
    version, date,
    localizedDescription: 'Dernière version de FranceStudent Chat : améliorations et corrections de l’application.',
    downloadURL: `https://github.com/${repo}/releases/download/${tag}/FranceStudent-iPhone.ipa`,
    size: bytes.length, minOSVersion: info.MinimumOSVersion || '16.4'
  };
  const privacy = Object.fromEntries(Object.entries(info).filter(([key]) => /^NS.*UsageDescription$/.test(key)));
  return {
    name: 'FranceStudent Chat', identifier: 'org.francestudent.source', sourceURL,
    subtitle: 'Mises à jour de FranceStudent pour iPhone', iconURL,
    website: `https://github.com/${repo}`, tintColor: '#2563EB',
    apps: [{
      name: 'FranceStudent Chat', bundleIdentifier: info.CFBundleIdentifier,
      developerName: 'FranceStudent', localizedDescription: 'Chat IA, documents, images et présentations PowerPoint.',
      iconURL, tintColor: '#2563EB',
      version, versionDate: date, downloadURL: appVersion.downloadURL, size: bytes.length,
      versions: [appVersion], appPermissions: { entitlements: [], privacy }
    }], news: []
  };
}

module.exports = { makeSource };
if (require.main === module) {
  const root = path.resolve(__dirname, '..');
  makeSource(path.join(root, 'dist/FranceStudent-iPhone.ipa'), { repo: process.env.GITHUB_REPOSITORY, commit: process.env.GITHUB_SHA })
    .then(source => {
      fs.writeFileSync(path.join(root, 'dist/source.json'), JSON.stringify(source, null, 2) + '\n');
      console.log('Source SideStore générée depuis l’IPA : ' + source.apps[0].version);
    }).catch(error => { console.error(error.message); process.exitCode = 1; });
}
