"use strict";
const test=require('node:test'),assert=require('node:assert/strict'),fs=require('node:fs'),os=require('node:os'),path=require('node:path');
const root=fs.mkdtempSync(path.join(os.tmpdir(),'frst-actions-'));process.env.FS_DATA_DIR=root;
const github=require('../src/github'),connector=require('../src/github-connector');
const token=github.getToken;github.getToken=()=> 'secret-test';test.after(()=>{github.getToken=token;fs.rmSync(root,{recursive:true,force:true});});
const git=(_,args,__,cb)=>cb(null,args[0]==='remote'?'https://github.com/example/project.git':'main','');
const call=(args,fetchImpl)=>connector.execute(root,args,{fetchImpl,execFileImpl:git});
test('dispatch exige une référence explicite et ne prétend pas que la compilation est terminée',async()=>{
 const calls=[];const fetcher=async(url,init)=>{calls.push({url,init});return new Response(null,{status:204});};
 await assert.rejects(call({action:'dispatch_workflow',workflow:'build.yml'},fetcher),/Branche/);assert.equal(calls.length,0);
 const value=await call({action:'dispatch_workflow',workflow:'build.yml',ref:'main',inputs:{release:true}},fetcher);
 assert.equal(calls.length,1);assert.match(calls[0].url,/workflows\/build.yml\/dispatches$/);assert.deepEqual(JSON.parse(calls[0].init.body),{ref:'main',inputs:{release:true}});assert.equal(value.dispatched,true);assert.match(value.message,/non confirmées/);
 assert.equal(connector.READ_ACTIONS.has('dispatch_workflow'),false);assert.equal(connector.READ_ACTIONS.has('download_artifact'),false);
 await assert.rejects(call({action:'dispatch_workflow',workflow:'build.yml',ref:'main',inputs:{bad:{secret:'x'}}},fetcher),/Entrées/);
});
test('suivi des workflows : statut, SHA, jobs et annotations',async()=>{
 const runs=await call({action:'workflow_runs',workflow:'build.yml',head_sha:'abc',page:2},async url=>{assert.match(url,/head_sha=abc/);assert.match(url,/page=2/);return Response.json({total_count:1,workflow_runs:[{id:9,status:'completed',conclusion:'success',head_sha:'abc'}]});});assert.equal(runs.runs[0].head_sha,'abc');
 const result=await call({action:'workflow_jobs',id:9},async()=>Response.json({total_count:1,jobs:[{id:10,status:'completed',conclusion:'failure',steps:[{name:'Build',conclusion:'failure'}]}]}));assert.equal(result.jobs[0].steps[0].conclusion,'failure');
 const annotations=await call({action:'job_annotations',id:10},async()=>Response.json([{message:'Runner unavailable',annotation_level:'failure'}]));assert.equal(annotations[0].message,'Runner unavailable');
 await assert.rejects(call({action:'workflow_runs',per_page:101},async()=>{throw Error('Ne doit pas appeler le réseau');}),/Pagination/);
});
test('le téléchargement protège les fichiers locaux et retire le jeton pour le stockage signé',async()=>{
 let calls=0;
 const fetcher=async(url,init)=>{calls++;if(calls===1){assert.match(init.headers.Authorization,/secret-test/);return new Response(null,{status:302,headers:{location:'https://example.blob.core.windows.net/file?signature=test'}});}assert.equal(init.headers.Authorization,undefined);return new Response(Buffer.from('archive-bytes'));};
 const result=await call({action:'download_artifact',id:5,path:'artifact.zip'},fetcher);assert.equal(result.size,13);assert.equal(fs.readFileSync(path.join(root,'artifact.zip'),'utf8'),'archive-bytes');
 await assert.rejects(call({action:'download_artifact',id:5,path:'artifact.zip'},fetcher));assert.equal(calls,2);
 await assert.rejects(call({action:'download_artifact',id:5,path:'../outside.zip'},fetcher),/projet/);
 await assert.rejects(call({action:'download_artifact',id:5,path:'bad.zip'},async()=>new Response(null,{status:302,headers:{location:'https://evil.invalid/file'}})),/Destination/);assert.equal(fs.existsSync(path.join(root,'bad.zip')),false);
});
test('fusion liée au SHA relu et relance sans répétition automatique',async()=>{
 let count=0;const f=async(url,init)=>{count++;assert.equal(JSON.parse(init.body).sha,'a'.repeat(40));return Response.json({merged:true});};
 await assert.rejects(call({action:'merge_pull_request',id:2,sha:'short',merge_method:'squash'},f),/SHA/);assert.equal(count,0);
 const result=await call({action:'merge_pull_request',id:2,sha:'a'.repeat(40),merge_method:'squash'},f);assert.equal(result.merged,true);
 let attempts=0;await assert.rejects(call({action:'rerun_workflow',id:9},async()=>{attempts++;throw Error('fetch failed');}),e=>e.executionUncertain===true);assert.equal(attempts,1);
});
test('les nouveaux paramètres et actions sont exposés au moteur Codex',()=>{
 const tool=require('../src/agent/codex-tools').catalog().find(t=>t.name==='github');
 for(const name of ['dispatch_workflow','download_artifact','merge_pull_request'])assert.ok(tool.inputSchema.properties.action.enum.includes(name));
 for(const key of ['workflow','ref','inputs','page','merge_method'])assert.ok(tool.inputSchema.properties[key]);
});

test('refuser une écriture Actions empêche son exécution, les lectures restent consultables',async()=>{
 const bridge=require('../src/ui-bridge'),old=connector.execute;let executed=0,confirmed=0;
 bridge.setUiBackend({confirm:async()=>{confirmed++;return false;}});
 connector.execute=async()=>{executed++;return {ok:true};};
 try{
  const tool=require('../src/tools/github');
  for(const action of ['dispatch_workflow','rerun_workflow','cancel_workflow','download_artifact','merge_pull_request'])assert.equal((await tool.run({action})).denied,true);
  assert.equal(executed,0);assert.equal(confirmed,5);
  assert.equal((await tool.run({action:'workflows'})).ok,true);assert.equal(confirmed,5);
 }finally{connector.execute=old;bridge.setUiBackend(null);}
});
