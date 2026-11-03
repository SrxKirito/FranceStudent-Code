const fs = require('node:fs');
const vm = require('node:vm');
const assert = require('node:assert/strict');
const posted = [];
let reads = 0;
class Document {}
Object.defineProperty(Document.prototype, 'cookie', { get() { return ''; }, set() {} });
const context = vm.createContext({
  Document, HTMLDocument: Document, prompt: () => 'false',
  document: { addEventListener() {}, removeEventListener() {} }, navigator: {},
  Capacitor: { Plugins: {}, DEBUG: false },
  Uint8Array, TextDecoder, TextEncoder, atob, btoa, File,
  XMLHttpRequest: class {}, fetch,
  webkit: { messageHandlers: { bridge: { postMessage(message) {
    posted.push(message);
    const data = message.pluginId === 'ChatStream'
      ? message.methodName === 'start' ? { id: 'native', status: 200 }
        : message.methodName === 'read' ? reads++ === 0 ? { data: btoa('data: test\n\n'), done: false } : { done: true } : {}
      : message.pluginId === "QRScanner" ? { value: "https://test.trycloudflare.com/" } : { files: [] };
    Promise.resolve().then(() => context.Capacitor.fromNative({ callbackId: message.callbackId, pluginId: message.pluginId, methodName: message.methodName, success: true, data }));
  } } } }
});
context.window = context;
// Exact runtime shipped by the installed Capacitor iOS dependency.
vm.runInContext(fs.readFileSync(__dirname + '/node_modules/@capacitor/ios/Capacitor/Capacitor/assets/native-bridge.js', 'utf8'), context);
assert.equal(context.Capacitor.getPlatform(), 'ios');
assert.equal(context.Capacitor.registerPlugin, undefined, 'Le runtime embarqué ne fournit pas cette API du SDK web');
// Same wrappers emitted by Capacitor JSExport.swift for registered native plugins.
for (const [plugin, methods] of Object.entries({ ChatStream: ['start', 'read', 'cancel'], AttachmentPicker: ['pickPhotos', 'pickFiles'], FileSaver: ['save', 'preview'], QRScanner: ['scan'], IDELinkVault: ['read', 'save', 'remove'] })) {
  for (const method of methods) vm.runInContext(`(function(w){var p=w.Capacitor.Plugins;var t=p['${plugin}']=p['${plugin}']||{};t['${method}']=function(options){return w.Capacitor.nativePromise('${plugin}','${method}',options);};})(window);`, context);
}
const core = fs.readFileSync(__dirname + '/www/js/core.js', 'utf8');
vm.runInContext(core.slice(core.indexOf('async function nativeStreamingFetch'), core.indexOf('async function apiFetch')), context);
vm.runInContext(fs.readFileSync(__dirname + '/www/js/composer.js', 'utf8'), context);
vm.runInContext(fs.readFileSync(__dirname + '/www/js/render.js', 'utf8'), context);
context.showToast = message => { throw new Error(message); };
(async () => {
  const response = await context.nativeStreamingFetch('url', { headers: {}, body: '{}' });
  assert.equal(await response.text(), 'data: test\n\n');
  await context.openAttachmentPicker('photo-input');
  await context.openAttachmentPicker('file-input');
  await context.fileSaverPlugin().preview({ name: 'test.pdf', data: 'dGVzdA==' });
  assert.deepEqual(posted.filter(m => m.pluginId !== 'Console').map(m => m.pluginId + '.' + m.methodName), [
    'ChatStream.start', 'ChatStream.read', 'ChatStream.read', 'AttachmentPicker.pickPhotos', 'AttachmentPicker.pickFiles', 'FileSaver.preview'
  ]);
  vm.runInContext(fs.readFileSync(__dirname + '/www/js/library.js', 'utf8'), context);
  context.URL=URL;
  context.URLSearchParams=URLSearchParams;
  vm.runInContext(fs.readFileSync(__dirname + '/www/js/ide-link.js', 'utf8'), context);
  assert.equal(await context.scanFranceIDEAddress(),'https://test.trycloudflare.com/');
  assert.equal(posted.at(-1).pluginId,'QRScanner');
  assert.equal(posted.at(-1).methodName,'scan');
  for (const method of ['read', 'save', 'remove']) {
    await context.Capacitor.Plugins.IDELinkVault[method](method === 'save' ? { value: '{"v":1}' } : {});
    assert.equal(posted.at(-1).pluginId, 'IDELinkVault');
    assert.equal(posted.at(-1).methodName, method);
  }
  context.Capacitor.Plugins.QRScanner.scan=async()=>({cancelled:true});
  assert.equal(await context.scanFranceIDEAddress(),null);
  context.Capacitor.Plugins.QRScanner.scan=async()=>({value:'javascript:alert(1)'});
  await assert.rejects(()=>context.scanFranceIDEAddress());
  console.log('OK : véritable bridge iOS, sans registerPlugin : réponse, Photos, Fichiers et aperçu atteignent le canal natif.');
})().catch(error => { console.error(error); process.exitCode = 1; });
