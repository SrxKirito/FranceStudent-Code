const assert = require('node:assert/strict');
const fs = require('node:fs');
const vm = require('node:vm');
const path = require('node:path');
const saved = { avatar: 'data:image/png;base64,abc', conversations: [] };
const context = vm.createContext({
  window: { crypto: { randomUUID: () => 'device' }, addEventListener() {} },
  crypto: { randomUUID: () => 'device' },
  document: { getElementById: () => null, addEventListener() {} },
  localStorage: { getItem: () => JSON.stringify(saved), setItem() {} },
  console, URL, setTimeout, clearTimeout
});
for (const file of ['core', 'stream', 'models', 'conversations']) {
  vm.runInContext(fs.readFileSync(path.join(__dirname, 'www/js', file + '.js'), 'utf8'), context);
}
assert.equal(vm.runInContext('loadStore().avatar', context), saved.avatar);
assert.equal(vm.runInContext('providerLabel("Azure", "GPT-5")', context), 'OpenAI');
const imageId = '11111111-1111-4111-8111-111111111111';
context.imageId = imageId;
assert.equal(vm.runInContext('collectGeneratedImages({images:[{id:imageId}]})[0].id', context), imageId);
assert.equal(vm.runInContext('collectGeneratedImages({images:[imageId]})[0].id', context), imageId);
assert.equal(vm.runInContext('collectGeneratedImages({parts:[{type:"output_image", imageId}]})[0].id', context), imageId);
assert.equal(vm.runInContext('collectGeneratedImages({parts:[{type:"input_image", imageId}]}).length', context), 0);
vm.runInContext(`
  apiFetch = async () => ({ok:true, json:async () => ({chatMessages:[{
    id:'message', role:'assistant', content:null, images:[{id:imageId}]
  }]})});
  renderHistory = () => {};
  globalThis.conversation = {id:'chat-local', chatId:'chat-server', messages:[]};
`, context);
(async () => {
  assert.equal(await vm.runInContext('loadConversationFromServer(conversation)', context), true);
  assert.equal(vm.runInContext('conversation.messages[0].images[0].messageId', context), 'message');
  assert.equal(vm.runInContext('conversation.messages[0].images[0].chatId', context), 'chat-server');
  assert.equal(vm.runInContext('collectGeneratedImages({parts:JSON.stringify([{type:"output_image",imageId}])})[0].id', context), imageId);
  vm.runInContext(`
    globalThis.imageRequests = [];
    getAccessToken = async force => force ? 'renewed' : 'initial';
    window.Capacitor = { isNativePlatform: () => true, Plugins: { CapacitorHttp: {
      request: async options => {
        imageRequests.push(options);
        return imageRequests.length === 1 ? {status:401} : {status:200,headers:{'Content-Type':'image/png'},data:'aGVsbG8='};
      }
    }}};
  `, context);
  assert.equal(await vm.runInContext('fetchGeneratedImage("/test-image")', context), 'data:image/png;base64,aGVsbG8=');
  assert.equal(vm.runInContext('imageRequests[1].headers.Authorization', context), 'Bearer renewed');
  assert.equal(vm.runInContext('imageRequests[1].responseType', context), 'arraybuffer');
  console.log('OK: avatar restoration, provider recognition, image-only server history and image identifiers.');
})().catch(error => { console.error(error); process.exitCode = 1; });
