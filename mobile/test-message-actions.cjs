const assert = require('node:assert/strict');
const fs = require('node:fs');
const vm = require('node:vm');
function element() {
  return { dataset: {}, children: [], attributes: {}, querySelector: () => null, appendChild(child) { this.children.push(child); }, setAttribute(key, value) { this.attributes[key] = value; } };
}
const context = vm.createContext({ console, window: {}, document: { createElement: element } });
for (const file of ['render', 'conversations']) vm.runInContext(fs.readFileSync(__dirname + '/www/js/' + file + '.js', 'utf8'), context);
context.source = 'Voici le code.\n```html\n<!-- app.html -->\n<p>Bonjour</p>\n```\nConclusion.\n```js\n// app.js\nconsole.log(1);\n```\nFin de la réponse.';
const html = vm.runInContext('renderMarkdown(source)', context);
assert.ok(html.indexOf('message-downloads') > html.indexOf('Fin de la réponse.'));
assert.equal((html.match(/class="file-card"/g) || []).length, 2);
assert.ok(html.includes('data-file-index="0" data-name="app.html"'));
assert.ok(html.includes('data-file-index="1" data-name="app.js"'));
assert.equal(html.includes('class=\'code-download\''), false);
assert.equal(vm.runInContext('renderMarkdown(source, true)', context).includes('class="file-card"'), false);
context.pdf = '```pdf\nDocument\n```';
const pdfHtml = vm.runInContext('renderMarkdown(pdf)', context);
assert.ok(pdfHtml.includes('file-wrap file-only'));
assert.ok(pdfHtml.includes('data-name="document.pdf"'));
assert.ok(pdfHtml.indexOf('message-downloads') > pdfHtml.indexOf('Document'));
const row = element();
context.row = row;
vm.runInContext('addUserActions(row, 4)', context);
assert.equal(row.dataset.index, '4');
const buttons = row.children[0].children;
assert.deepEqual(buttons.map(button => button.dataset.action), ['edit-sent', 'copy']);
for (const button of buttons) {
  assert.ok(button.className.includes('icon-only'));
  assert.ok(!button.innerHTML.includes('<span>'));
  assert.ok(button.attributes['aria-label']);
}
context.fileCard = { dataset: { fileIndex: '1', name: 'app.js' }, closest: () => ({ querySelector: selector => {
  assert.equal(selector, '.file-wrap[data-file-index="1"]');
  return { querySelector: () => ({ querySelector: selector => ({ textContent: selector === 'pre code' ? 'console.log(1);' : 'js' }) }) };
} }) };
vm.runInContext('downloadCode = (...args) => { globalThis.downloaded = args; }; handleMessageClick({target:{closest:selector=>selector===".file-card"?fileCard:null}})', context);
assert.equal(context.downloaded[0], 'console.log(1);');
assert.equal(context.downloaded[4], 'app.js');
vm.runInContext('previewGeneratedFile = (...args) => { globalThis.previewed = args; }; handleMessageClick({target:{closest:selector=>selector===".file-card"?fileCard:null}})', context);
assert.equal(context.previewed[0], 'console.log(1);');
assert.equal(context.previewed[2], 'app.js');
console.log('OK : actions utilisateur sans texte, fichiers en fin de réponse, masqués pendant le flux et téléchargement du bon bloc.');
