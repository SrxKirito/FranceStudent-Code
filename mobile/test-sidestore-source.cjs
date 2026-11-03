const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const JSZip = require('jszip');
const plist = require('plist');
const { makeSource } = require('./scripts/make-sidestore-source.cjs');
(async () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'sidestore-test-'));
  try {
    const zip = new JSZip();
    zip.file('Payload/App.app/Info.plist', plist.build({ CFBundleIdentifier: 'org.francestudent.chat', CFBundleShortVersionString: '1.1.99', MinimumOSVersion: '16.4', NSCameraUsageDescription: 'Joindre une photo.' }));
    const ipa = path.join(dir, 'test.ipa');
    fs.writeFileSync(ipa, await zip.generateAsync({ type: 'nodebuffer' }));
    const source = await makeSource(ipa, { repo: 'SrxKirito/Francestudent-Iphone', commit: 'a'.repeat(40), date: '2026-10-30T21:00:00Z' });
    const app = source.apps[0];
    assert.equal(app.version, '1.1.99');
    assert.equal(app.versions[0].size, fs.statSync(ipa).size);
    assert.match(app.downloadURL, /releases\/download\/ios-1\.1\.99\/FranceStudent-iPhone\.ipa$/);
    assert.equal(app.versions[0].downloadURL, app.downloadURL);
    assert.deepEqual(app.appPermissions.privacy, { NSCameraUsageDescription: 'Joindre une photo.' });
    assert.equal('marketplaceID' in app, false);
    await assert.rejects(makeSource(ipa, { repo: '../invalid', commit: 'a'.repeat(40) }));
    console.log('OK : version, taille et permissions extraites de l’IPA, liens versionnés et source SideStore.');
  } finally { fs.rmSync(dir, { recursive: true }); }
})().catch(error => { console.error(error); process.exitCode = 1; });
