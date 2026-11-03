const fs=require('node:fs'),vm=require('node:vm'),assert=require('node:assert/strict');
const source=fs.readFileSync(__dirname+'/www/js/core.js','utf8');
let starts=0, reads=0, cancelled=false, fail=false;
const encoded=Buffer.from('été terminé');
const chunks=[encoded.subarray(0,1),encoded.subarray(1,4),encoded.subarray(4)];
const context=vm.createContext({Uint8Array,TextDecoder,atob,window:{Capacitor:{Plugins:{ChatStream:{
  async start(){starts++;return {status:200,id:'one'};},
  async read(){if(fail)return {done:true,error:'connection lost',backgrounded:true};return reads<chunks.length?{data:chunks[reads++].toString('base64'),done:false}:{done:true};},
  async cancel(){cancelled=true;}
}}}}});
vm.runInContext(source.slice(source.indexOf('async function nativeStreamingFetch'),source.indexOf('async function apiFetch')),context);
(async()=>{
  const response=await context.nativeStreamingFetch('url',{headers:{},body:'{}'});
  assert.equal(await response.text(),'été terminé','Les caractères UTF-8 sont conservés entre blocs natifs');
  fail=true;
  const second=await context.nativeStreamingFetch('url',{headers:{},body:'{}'});
  await assert.rejects(second.body.getReader().read(),e=>e.name==='TypeError'&&e.backgrounded===true);
  await second.body.getReader().cancel();assert.equal(cancelled,true);
  assert.equal(starts,2,'Un seul POST par demande, sans repli automatique');
  console.log('OK : octets natifs, UTF-8, état arrière-plan natif, annulation et absence de double envoi.');
})().catch(e=>{console.error(e);process.exitCode=1;});
