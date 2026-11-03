'use strict';
const test=require('node:test');
const assert=require('node:assert/strict');
const {ContextEconomy}=require('../desktop/codex-runtime/context-economy');
const {select}=require('../src/skills/presets');

test('compaction preserves full text without a reader and recovers it with one',()=>{
 const economy=new ContextEconomy(),long='ligne-'.repeat(4000);
 const input=[{type:'function_call_output',call_id:'x',output:long}];
 assert.equal(economy.compact(input,'a').input[0].output,long);
 const compacted=economy.compact(input,'a',{allowReferences:true});
 assert.ok(compacted.after<compacted.before);
 const ref=JSON.parse(compacted.input[0].output);
 let recovered='',start=0;
 do{const part=economy.read('a',{id:ref.context_id,start,max_chars:8000});recovered+=part.content;start=part.next_start;}while(start!==null);
 assert.equal(recovered,long);
 assert.throws(()=>economy.read('b',{id:ref.context_id}),/conversation/);
});
test('compaction keeps multimodal output untouched',()=>{
 const output=[{type:'input_image',image_url:'data:image/png;base64,AAA'}];
 assert.deepEqual(new ContextEconomy().compact([{type:'function_call_output',output}],'a',{allowReferences:true}).input[0].output,output);
});
test('skill presets keep matching, general and explicitly named skills',()=>{
 const skills=[{name:'code',description:'JavaScript programming'},{name:'finance',description:'finance budget'},{name:'design',description:'graphic design'},{name:'general',description:'instructions'}];
 assert.deepEqual(select(skills,'Corrige le code JavaScript et utilise finance').map(x=>x.name),['code','finance','general']);
 assert.deepEqual(select(skills,'Analyse mon budget').map(x=>x.name),['finance','general']);
 assert.deepEqual(select(skills,'Bonjour').map(x=>x.name),['code','finance','design','general']);
});
test('Codex loads an installed skill and respects manual selection',async()=>{
 const fs=require('node:fs/promises'),os=require('node:os'),path=require('node:path');
 const folder=await fs.mkdtemp(path.join(os.tmpdir(),'frst-codex-skill-'));
 const {state}=require('../src/state');state.workspace=folder;state.motionDesign=false;state.pendingImages=[];
 await require('../src/skills').createSkill('validation-code',{workspace:folder,scope:'projet',description:'Code JavaScript'});
 const executor=require('../src/agent/codex-tools').createExecutor({toolGroups:['skills'],task:'Utilise validation-code',extensionsMode:'manual'});
 const result=await executor('use_skill',{name:'validation-code'});
 assert.equal(result.success,true);
 assert.match(result.contentItems[0].text,/validation-code/);
 const refused=require('../src/agent/codex-tools').createExecutor({toolGroups:['skills'],task:'Bonjour',extensionsMode:'manual'});
 await assert.rejects(refused('use_skill',{name:'validation-code'}),/nommé/);
});
