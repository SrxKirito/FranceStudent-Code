const assert = require('node:assert/strict');
const fs = require('node:fs');
const vm = require('node:vm');
const JSZip = require('jszip');
const { DOMParser } = require('@xmldom/xmldom');
const read = name => fs.readFileSync(__dirname + '/www/' + name, 'utf8');

async function main() {
  // Run the exact browser bundle shipped in the app, without Node's require.
  const context = vm.createContext({ console: { ...console, error() {} }, setTimeout, clearTimeout, setImmediate, clearImmediate, TextEncoder, TextDecoder, Uint8Array, ArrayBuffer, Blob, document: {} });
  context.window = context;
  vm.runInContext(read('pptxgen/pptxgen.bundle.js'), context);
  vm.runInContext(read('js/powerpoint-visuals.js'), context);
  vm.runInContext(read('js/powerpoint.js'), context);
  vm.runInContext(read('js/render.js'), context);
  const deck = {
    filename: '../../Énergie: étude.pptx', title: 'Énergie & climat', subtitle: 'Étude de cas',
    slides: [
      { title: 'Les énergies renouvelables', bullets: ['Éolien, solaire et hydraulique', 'Une production à adapter aux besoins'], notes: 'Expliquer le rôle du stockage.' },
      { title: 'Coûts et bénéfices', bullets: ['Comparer les coûts sur toute la durée de vie', 'Réduire les émissions de CO₂'], notes: 'Source : documents fournis.' }
    ]
  };
  context.source = JSON.stringify(deck);
  assert.equal(vm.runInContext('detectsPowerPointRequest("Crée un PowerPoint de 5 diapositives sur le climat")', context), true);
  assert.equal(vm.runInContext('detectsPowerPointRequest("Quelle application ouvre un PowerPoint ?")', context), false);
  const name = vm.runInContext('powerPointFileName(source)', context);
  assert.ok(name.endsWith('.pptx'));
  assert.doesNotMatch(name, /[/\\:]/);
  assert.throws(() => vm.runInContext('parsePowerPoint("{incomplet")', context), /incomplète/);
  assert.throws(() => vm.runInContext('parsePowerPoint(JSON.stringify({slides:[]}))', context), /1 et 40/);
  assert.throws(() => vm.runInContext('parsePowerPoint(JSON.stringify({slides:Array(41).fill({})}))', context), /1 et 40/);
  context.markdown = 'Voici la présentation.\n```pptx\n' + context.source + '\n```';
  const html = vm.runInContext('renderMarkdown(markdown)', context);
  assert.ok(html.includes('file-wrap file-only'));
  assert.ok(html.includes('data-name="' + name + '"'));
  assert.equal((html.match(/class="file-card"/g) || []).length, 1);
  assert.equal(vm.runInContext('renderMarkdown(markdown, true)', context).includes('class="file-card"'), false);

  const bytes = await vm.runInContext('makePowerPoint(source)', context);
  assert.equal(Buffer.from(bytes).subarray(0, 2).toString(), 'PK', 'Véritable archive Office, pas du texte renommé');
  const zip = await JSZip.loadAsync(bytes);
  const slideFiles = Object.keys(zip.files).filter(name => /^ppt\/slides\/slide\d+\.xml$/.test(name));
  assert.equal(slideFiles.length, 2);
  assert.ok(Object.keys(zip.files).some(name => /^ppt\/media\/.*\.png$/.test(name)), 'Illustrations réellement intégrées dans le PPTX');
  for (const file of Object.keys(zip.files).filter(name => /\.(xml|rels)$/.test(name))) {
    const source = await zip.file(file).async('string');
    const errors = [];
    new DOMParser({ onError: (level, message) => errors.push(message) }).parseFromString(source, 'application/xml');
    assert.deepEqual(errors, [], 'XML Office valide : ' + file);
  }
  const first = await zip.file('ppt/slides/slide1.xml').async('string');
  assert.ok(first.includes('Les énergies renouvelables'));
  assert.ok(first.includes('Éolien, solaire et hydraulique'));
  assert.ok(first.includes('&amp; climat'));
  assert.ok((await zip.file('ppt/notesSlides/notesSlide1.xml').async('string')).includes('Expliquer le rôle du stockage.'));
  assert.ok((await zip.file('[Content_Types].xml').async('string')).includes('presentationml.presentation.main+xml'));

  const dense = { title: 'Cours complet', slides: [{ title: 'Notions', bullets: Array.from({ length: 20 }, (_, i) => 'Notion ' + i + ' : ' + 'explication '.repeat(30)) }] };
  context.dense = JSON.stringify(dense);
  const pages = vm.runInContext('powerPointPages(parsePowerPoint(dense))', context);
  assert.ok(pages.length > 1);
  const body = pages.flatMap(page => page.bullets).join(' ');
  for (let i = 0; i < 20; i++) assert.ok(body.includes('Notion ' + i + ' :'), 'Aucun point perdu');

  // Exercise the existing download handler and its native file-saving route.
  context.saveFile = async (name, data) => { context.saved = { name, data }; return name; };
  context.showToast = (text, error) => { context.toast = { text, error }; };
  context.button = { disabled: false, textContent: '', classList: { contains: () => true, add() {} }, setAttribute() {}, removeAttribute() {} };
  await vm.runInContext('downloadCode(source, "pptx", null, button, powerPointFileName(source))', context);
  assert.equal(context.saved.name, name);
  assert.equal(context.button.disabled, false);
  assert.equal((await JSZip.loadAsync(context.saved.data)).file('ppt/presentation.xml') !== null, true);
  assert.equal(context.toast.error, undefined);
  context.saved = null;
  await vm.runInContext('downloadCode("{incomplet", "pptx", null, button, "invalide.pptx")', context);
  assert.equal(context.saved, null, 'Un contenu invalide ne produit pas un faux PowerPoint');
  assert.equal(context.toast.error, true);
  assert.equal(context.button.disabled, false);
  // Send an actual draft through the composer, including its attached course.
  const prompt = { value: 'Prépare un PowerPoint sur ce cours.' };
  const composer = vm.createContext({
    console, window: {}, document: {}, store: { agentId: -1002, powerpointMode: false, conversations: [] },
    busy: false, currentId: null, $: id => id === 'prompt' ? prompt : null,
    currentConversation: () => null, makeId: () => 'test-deck', saveStore() {}, renderHistory() {},
    appendMessage: () => ({}), renderMessageAttachments() {}, addUserActions() {}, rememberAgent() {},
    runAssistant: async (conversation, text) => { composer.sent = text; }
  });
  vm.runInContext(read('js/powerpoint.js'), composer);
  vm.runInContext(read('js/composer.js'), composer);
  vm.runInContext('resizePrompt = () => {}; renderAttachments = () => {}; pendingFiles = [{kind:"text", name:"cours.txt", data:"Énergies : solaire et éolien."}]', composer);
  await vm.runInContext('sendMessage()', composer);
  assert.ok(composer.sent.startsWith('Création PowerPoint.'));
  assert.ok(composer.sent.includes('Énergies : solaire et éolien.'));
  assert.equal(composer.store.conversations[0].messages[0].content, 'Prépare un PowerPoint sur ce cours.');
  assert.equal(composer.store.conversations[0].messages[0].prompt, composer.sent, 'Le protocole est conservé pour régénérer la réponse');
  prompt.value = 'Génère-moi une présentation sur la photosynthèse, 4 diapositives';
  composer.store.powerpointMode = true;
  await vm.runInContext('sendMessage()', composer);
  assert.ok(composer.sent.startsWith('Création PowerPoint.'));
  prompt.value = 'Explique la photosynthèse';
  await vm.runInContext('sendMessage()', composer);
  assert.equal(composer.sent.startsWith('Création PowerPoint.'), false, 'Un ancien mode sauvegardé ne force plus PowerPoint');
  console.log('OK : bundle navigateur, vraie archive PPTX, XML Office, diapositives modifiables, accents, notes, pagination et téléchargement.');
}
main().catch(error => { console.error(error); process.exitCode = 1; });
