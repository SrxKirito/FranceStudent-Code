const assert = require('node:assert/strict');
const fs = require('node:fs');
const vm = require('node:vm');
const JSZip = require('jszip');
const calls = [];
const context = vm.createContext({
  console, setTimeout, clearTimeout, setImmediate, clearImmediate, TextEncoder, TextDecoder,
  Uint8Array, ArrayBuffer, Blob, document: {},
  FileReader: class {
    readAsDataURL(blob) { blob.arrayBuffer().then(bytes => { this.result = 'data:' + blob.type + ';base64,' + Buffer.from(bytes).toString('base64'); this.onload(); }); }
  },
  fileSaverPlugin: () => ({ preview: async args => calls.push(args) }),
  showToast(message) { throw new Error(message); }
});
context.window = context;
context.Capacitor = { getPlatform: () => 'ios' };
for (const file of ['pptxgen/pptxgen.bundle.js','js/powerpoint-visuals.js','js/powerpoint.js','js/render.js','js/preview.js']) vm.runInContext(fs.readFileSync(__dirname + '/www/' + file, 'utf8'), context);
context.fileSaverPlugin = () => ({ preview: async args => calls.push(args) });
(async () => {
  // L’original est utilisé même si l’assistant n’a reçu que son texte extrait.
  context.storedPreview = async () => ({ name:'cours.pdf', blob:new Blob(['original PDF'],{type:'application/pdf'}) });
  await context.previewAttachment({previewId:'local',name:'cours.pdf',kind:'text',data:'texte extrait'});
  assert.equal(calls[0].name,'cours.pdf');
  assert.equal(Buffer.from(calls[0].data,'base64').toString(),'original PDF');
  const code=JSON.stringify({title:'Exemple',slides:[{title:'Objectif',bullets:['Une idée claire']}]});
  await context.previewGeneratedFile(code,'pptx','exemple.pptx');
  const zip=await JSZip.loadAsync(Buffer.from(calls[1].data,'base64'));
  assert.ok(zip.file('ppt/slides/slide1.xml'),'L’aperçu reçoit un vrai PowerPoint');
  assert.equal(calls[1].name,'exemple.pptx');
  await context.previewAttachment({name:'ancien.pdf',kind:'text',data:'Texte disponible'});
  assert.match(calls[2].name,/texte extrait\.txt$/,'Une ancienne extraction n’est pas présentée comme le PDF original');
  console.log('OK : original joint, vrai PPTX généré et repli explicite pour les anciens documents.');
})().catch(error=>{console.error(error);process.exitCode=1;});
