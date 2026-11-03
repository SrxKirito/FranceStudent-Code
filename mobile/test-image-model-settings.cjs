const assert = require('node:assert/strict');
const fs = require('node:fs');
const vm = require('node:vm');
const element = () => ({
  children: [], attributes: {}, textContent: '',
  classList: { values: new Set(['hidden']), contains(v) { return this.values.has(v); }, add(v) { this.values.add(v); }, remove(v) { this.values.delete(v); } },
  set innerHTML(value) { this.children = []; },
  appendChild(child) { this.children.push(child); },
  setAttribute(k, v) { this.attributes[k] = v; },
  querySelector() { return this.children.find(c => c.attributes['aria-selected'] === 'true') || null; },
  focus() { this.focused = true; }
});
const nodes = Object.fromEntries(['image-tool-toggle', 'settings-image-models', 'settings-image-model-button', 'settings-image-model-name', 'settings-image-model-logo'].map(id => [id, element()]));
let saved = 0;
const context = vm.createContext({
  window: {}, document: { querySelectorAll: () => [], createElement: element },
  $: id => nodes[id], store: { imageModel: 'gpt-image-2.5-flare', imageTool: true, imageToolSynced: 'old' },
  saveStore() { saved++; }, providerMark: () => '',
  modelOption(model, selected) { const node = element(); node.model = model; node.setAttribute('aria-selected', String(model.id === selected)); return node; },
  closeMenus() { context.closeSettingsImageModelMenu(); }
});
for (const name of ['composer', 'settings']) vm.runInContext(fs.readFileSync(__dirname + '/www/js/' + name + '.js', 'utf8'), context);
context.renderToggles = () => {};
context.renderImageModel = () => {};
context.renderImageSettings();
const menu = nodes['settings-image-models'];
assert.equal(menu.children.length, 3, 'Les modèles existent sans ancien menu dans le chat');
assert.equal(nodes['settings-image-model-name'].textContent, 'GPT Image 2.5 Flare');
nodes['settings-image-model-button'].onclick({ stopPropagation() {} });
assert.equal(menu.classList.contains('hidden'), false);
assert.equal(menu.children[1].focused, true);
menu.children[0].onclick({ stopPropagation() {} });
assert.equal(context.store.imageModel, 'gpt-image-2.5-sunburst');
assert.equal(context.store.imageToolSynced, null);
assert.equal(saved, 1);
assert.equal(nodes['settings-image-model-name'].textContent, 'GPT Image 2.5 Sunburst');
assert.equal(menu.classList.contains('hidden'), true);
console.log('OK : liste sans ancien menu, ouverture, sélection, sauvegarde et fermeture.');
