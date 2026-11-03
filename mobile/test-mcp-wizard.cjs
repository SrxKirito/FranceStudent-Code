const assert = require('node:assert/strict');
const fs = require('node:fs');
const vm = require('node:vm');
const nodes = new Map();
const get = id => {
  if (!nodes.has(id)) nodes.set(id, { value: '', checked: true, hidden: false, textContent: '', reset() {}, close() {}, focus() {} });
  return nodes.get(id);
};
let auth = 'bearer';
let sent;
const context = vm.createContext({
  $: get, URL, console,
  document: { querySelector: () => ({ value: auth }) }
});
vm.runInContext(fs.readFileSync(__dirname + '/www/js/settings.js', 'utf8'), context);
vm.runInContext(`settingsApi = async (path, opts) => { globalThis.sent = JSON.parse(opts.body); return {id:'server'}; }; loadMcpServers = async () => {}; mcpStep = 3;`, context);
get('mcp-label').value = 'test_server';
get('mcp-url').value = 'https://example.com/mcp';
get('mcp-token').value = 'Bearer secret';
get('mcp-headers').value = '{"X-Key":"value"}';
async function submit() { await vm.runInContext('submitMcpForm({preventDefault(){}})', context); }
(async () => {
  await submit();
  assert.equal(context.sent.authorization, 'secret');
  assert.equal(context.sent.headers['X-Key'], 'value');
  assert.equal(context.sent.auth_type, 'bearer');
  auth = 'none';
  await submit();
  assert.equal(context.sent.auth_type, 'none');
  assert.equal(context.sent.authorization, undefined);
  assert.equal(context.sent.headers, undefined);
  auth = 'bearer';
  context.sent = null;
  get('mcp-headers').value = '[]';
  await submit();
  assert.equal(context.sent, null);
  assert.match(get('mcp-form-error').textContent, /JSON/);
  get('mcp-label').value = 'invalid name';
  await submit();
  assert.match(get('mcp-form-error').textContent, /uniquement/);
  console.log('OK: MCP token, secure headers, anonymous auth and validation.');
})().catch(error => { console.error(error); process.exitCode = 1; });
