const assert = require('node:assert/strict');
const fs = require('node:fs');
const vm = require('node:vm');

async function scenario(background, recover) {
  const listeners = new Map();
  let reads = 0, submissions = 0;
  const old = { id: 'old', role: 'assistant', content: 'ancienne réponse', createdAt: '2026-01-01' };
  const context = vm.createContext({
    document: { hidden: false, body: {}, addEventListener(n, cb) { listeners.set(n, cb); }, removeEventListener(n) { listeners.delete(n); } },
    window: { addEventListener() {} }, navigator: { onLine: true }, $() { return null; },
    stopRequested: false, setTimeout(cb) { cb(); },
    apiFetch: async () => ({ ok: true, json: async () => ({ chatMessages: ++reads === 1 || !recover ? [old] : [old,
      { id: 'user', role: 'user', content: 'question', createdAt: '2026-01-02' },
      { id: 'answer', role: 'assistant', content: 'nouvelle réponse', createdAt: '2026-01-03' }
    ] }) }),
  });
  vm.runInContext(fs.readFileSync(__dirname + '/www/js/stream.js', 'utf8'), context);
  context.streamChatRequest = async (...args) => {
    submissions++;
    if (background === true) {
      context.document.hidden = true;
      listeners.get('visibilitychange')();
      context.document.hidden = false;
    }
    if (background === 'native') args[3]('réponse partielle');
    throw Object.assign(new TypeError('Failed to fetch'), {backgrounded:background==='native'});
  };
  let result, error;
  try { result = await context.streamChat({ chatId: 'chat' }, 'question', [], () => {}); } catch (e) { error = e; }
  assert.equal(submissions, 1);
  assert.equal(listeners.has('visibilitychange'), false);
  return { result, error, reads };
}
(async () => {
  const restored = await scenario(true, true);
  assert.equal(restored.result, 'nouvelle réponse');
  const native = await scenario('native', true);
  assert.equal(native.result, 'nouvelle réponse', 'Récupération sans événement visibilitychange');
  const partial = await scenario('native', false);
  assert.equal(partial.error.partialOutput, 'réponse partielle');
  const foreground = await scenario(false, true);
  assert.equal(foreground.error.message, 'Failed to fetch');
  assert.equal(foreground.reads, 1);
  const missing = await scenario(true, false);
  assert.match(missing.error.message, /suspendue/);
  assert.equal(missing.result, undefined);
  console.log('OK: récupération après suspension, aucune ancienne réponse ni seconde génération, nettoyage des écouteurs.');
})().catch(e => { console.error(e); process.exitCode = 1; });
