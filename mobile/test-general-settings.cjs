const assert = require('node:assert/strict');
const fs = require('node:fs');
const vm = require('node:vm');
const nodes = new Map();
const get = id => {
  if (!nodes.has(id)) nodes.set(id, { value: '', disabled: false, textContent: '', classList: { toggle() {} }, querySelectorAll() { return []; }, close() {}, focus() {} });
  return nodes.get(id);
};
const calls = [];
let failMode = false;
const context = vm.createContext({
  $: get, URL, console,
  store: { session: 'test', webSearch: true }, settingsLoaded: {}, saveStore() {},
  settingsApi: async (path, opts) => {
    if (opts) {
      calls.push({ path, method: opts.method, body: JSON.parse(opts.body) });
      if (failMode && opts.method === 'PATCH') throw new Error('server unavailable');
      return {};
    }
    return { gptReasoning: 'high', customInstructions: 'Mon style', webSearchMode: 'open' };
  }
});
vm.runInContext(fs.readFileSync(__dirname + '/www/js/general-settings.js', 'utf8'), context);
const json = value => JSON.parse(JSON.stringify(value));
assert.deepEqual(json(vm.runInContext('parseWebDomains("Wikipedia.org, https://example.com/ wikipedia.org")', context)), ['wikipedia.org', 'example.com']);
assert.throws(() => vm.runInContext('parseWebDomains("https://example.com/path")', context));
assert.throws(() => vm.runInContext('parseWebDomains("https://user:pass@example.com")', context));
assert.deepEqual(json(vm.runInContext('normalizeWebDomainSettings(null)', context)), {filterType:'allowlist',allowedDomains:[],blockedDomains:[]});
assert.deepEqual(json(vm.runInContext('normalizeWebDomainSettings({filterType:"blocklist",allowedDomains:null,blockedDomains:["example.com"]})', context)), {filterType:'blocklist',allowedDomains:[],blockedDomains:['example.com']});
assert.throws(() => vm.runInContext('normalizeWebDomainSettings({allowedDomains:"invalid"})', context), /invalide/);
(async () => {
  await vm.runInContext('loadGeneralSettings()', context);
  assert.equal(get('gpt-reasoning').value, 'high');
  assert.equal(get('custom-instructions').value, 'Mon style');
  get('custom-instructions').value = '';
  await vm.runInContext('saveGeneralSettings({preventDefault(){}})', context);
  assert.deepEqual(calls.pop().body, { gptReasoning: 'high', customInstructions: '' });
  assert.equal(context.store.customInstructionsManaged, true);
  await vm.runInContext('loadWebDomainSettings()', context);
  get('web-search-mode').value = 'filtered';
  get('web-filter-type').value = 'allowlist';
  get('web-allowed-domains').value = 'wikipedia.org';
  get('web-blocked-domains').value = 'example.com';
  await vm.runInContext('saveWebSettings({preventDefault(){}})', context);
  assert.equal(calls[0].method, 'PUT');
  assert.deepEqual(calls[0].body, { filterType: 'allowlist', allowedDomains: ['wikipedia.org'], blockedDomains: ['example.com'] });
  assert.deepEqual(calls[1].body, { webSearchMode: 'filtered' });
  calls.length = 0;
  get('web-allowed-domains').value = '';
  await vm.runInContext('saveWebSettings({preventDefault(){}})', context);
  assert.equal(calls.length, 0);
  get('web-search-mode').value = 'disabled';
  await vm.runInContext('saveWebSettings({preventDefault(){}})', context);
  assert.equal(context.store.webSearch, false);
  assert.equal(calls.length, 1);
  failMode = true;
  get('web-search-mode').value = 'filtered';
  get('web-allowed-domains').value = 'wikipedia.org';
  await vm.runInContext('saveWebSettings({preventDefault(){}})', context);
  assert.match(get('web-settings-status').textContent, /Listes enregistrées, mais/);
  assert.equal(context.store.webSearchMode, 'disabled');
  console.log('OK: chargement, instructions vides, PATCH partiel, domaines, ordre des sauvegardes, recherche désactivée et échec partiel.');
})().catch(error => { console.error(error); process.exitCode = 1; });
