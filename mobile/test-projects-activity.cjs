const assert = require('node:assert/strict');
const fs = require('node:fs');
const vm = require('node:vm');
const context = vm.createContext({ console, Intl, URL, Date, window: { addEventListener() {} }, document: { addEventListener() {} }, store: { conversations: [], agentId: 12 }, makeId: () => 'local', serverTime: value => Date.parse(value) || 0, providerLabel: value => value });
for (const name of ['projects', 'account-activity', 'stream']) vm.runInContext(fs.readFileSync(__dirname + '/www/js/' + name + '.js', 'utf8'), context);
const json = value => JSON.parse(JSON.stringify(value));
assert.deepEqual(json(vm.runInContext('projectFormBody("  Révisions  ", "Mon cours")', context)), { name: 'Révisions', customInstructions: 'Mon cours' });
assert.throws(() => vm.runInContext('projectFormBody("   ", "")', context));
assert.throws(() => vm.runInContext('projectFormBody("x", "x".repeat(10001))', context));
assert.equal(vm.runInContext('matchingProjects([{name:"École"}, {name:"Autre"}], "ecole", "name").length', context), 1);
vm.runInContext('mergeProjectChats("project-1", [{id:"remote", title:"Maths", agent:{id:42}, createdAt:"2026-10-01"}])', context);
assert.equal(context.store.conversations[0].projectId, 'project-1');
assert.equal(context.store.conversations[0].agentId, 42);
vm.runInContext('mergeProjectChats("project-1", [{id:"remote", title:"Maths corrigé", agent:{id:42}, createdAt:"2026-10-01"}])', context);
assert.equal(context.store.conversations.length, 1);
const summary = vm.runInContext('summarizeActivity({totalTokenCount:1000,last7DaysTokenUsage:[{date:"2026-10-28",inputTokens:20,outputTokens:30,reasoningTokens:10,totalTokens:50},{date:"2026-10-29",inputTokens:0,outputTokens:0,totalTokens:0}]})', context);
assert.equal(summary.total, 50); // Le reasoning ne doit pas être compté deux fois.
assert.equal(summary.active, 1);
assert.equal(summary.average, 25);
assert.equal(summary.lifetime, 1000);
assert.equal(summary.peak.date, '2026-10-28');
assert.equal(vm.runInContext('summarizeActivity({}).lifetime', context), null);
vm.runInContext(`
  syncImageTool = async () => {};
  syncFileInstructions = async () => {};
  imagePromptPrefix = () => '';
  globalThis.sent = null;
  apiFetch = async (path, opts) => { globalThis.sent = JSON.parse(opts.body); return {ok:false,status:418,text:async()=>''}; };
`, context);
(async () => {
  await assert.rejects(() => vm.runInContext('streamChat({agentId:42,projectId:"project-1",messages:[]}, "Bonjour", [])', context));
  assert.equal(context.sent.projectId, 'project-1');
  await assert.rejects(() => vm.runInContext('streamChat({agentId:42,messages:[]}, "Bonjour", [])', context));
  assert.equal(Object.hasOwn(context.sent, 'projectId'), false);
  console.log('OK: projets, validation, import des discussions, contexte envoyé au serveur et statistiques sans double comptage.');
})().catch(error => { console.error(error); process.exitCode = 1; });
