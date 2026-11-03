const assert = require('node:assert/strict');
const fs = require('node:fs');
const vm = require('node:vm');
let platform = 'ios', clicks = 0, photos = 0, files = 0, received;
const context = vm.createContext({
  window: { Capacitor: { getPlatform: () => platform, Plugins: { AttachmentPicker: {
      async pickPhotos() { photos++; return { files: [] }; },
      async pickFiles() { files++; return { files: [{ name: 'cours.txt', mime: 'text/plain', data: btoa('Bonjour') }] }; }
    } } } },
  $: () => ({ click() { clicks++; } }), atob, Uint8Array, File,
  showToast(message) { throw new Error(message); }
});
vm.runInContext(fs.readFileSync(__dirname + '/www/js/composer.js', 'utf8'), context);
context.addFiles = async values => { received = values; };
(async () => {
  await context.openAttachmentPicker('photo-input');
  assert.equal(photos, 1);
  assert.equal(received, undefined, 'Annuler ne crée aucune pièce jointe');
  await context.openAttachmentPicker('file-input');
  assert.equal(files, 1);
  assert.equal(await received[0].text(), 'Bonjour');
  assert.equal(received[0].name, 'cours.txt');
  assert.equal(clicks, 0, 'iOS évite le sélecteur web intermédiaire');
  platform = 'android';
  await context.openAttachmentPicker('photo-input');
  assert.equal(clicks, 1);
  console.log('OK : routage natif iOS Photos/Fichiers, annulation, pièces jointes et sélecteur Android.');
})().catch(error => { console.error(error); process.exitCode = 1; });
