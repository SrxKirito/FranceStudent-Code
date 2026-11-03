'use strict';
// Parcours manuel minimal, profil et projet isolés ; aucune suite de tests.
const fs=require('node:fs'),path=require('node:path');
const base=path.resolve(__dirname,'../../francestudent-ide-codex-data/verification');fs.mkdirSync(base,{recursive:true});
const fixture=fs.mkdtempSync(path.join(base,'quota-')),core=path.join(fixture,'core'),workspace=path.join(fixture,'projet');
fs.mkdirSync(core);fs.mkdirSync(workspace);
fs.copyFileSync(path.resolve(base,'../core/session.json'),path.join(core,'session.json'));
process.env.FS_DATA_DIR=core;process.env.FS_STATE_DIR=path.join(fixture,'state');process.env.FS_AGENT_ENGINE='codex';
fs.writeFileSync(path.join(workspace,'controle.txt'),'PROTOCOLE-OK');
const {state}=require('../src/state');state.workspace=workspace;state.model=-2003;state.mode='agent';state.autoApproveCommands=true;
const backend=require('../desktop/backend').createDesktopBackend((channel,data)=>{
 if(channel==='entry'&&['tool','assistant','error'].includes(data.type))console.log(data.type,data.type==='tool'?data.name:data.text);
 if(channel==='prompt')backend.resolvePrompt(data.id,'n');
});require('../src/ui-bridge').setUiBackend(backend);
(async()=>{
 await require('../src/project/memory').open(workspace);
 const deadline=Date.now()+120000;
 const result=await require('../src/agent/agent').runAgent('Lis controle.txt dans le dossier courant et réponds uniquement avec son contenu.',{toolGroups:['terminal'],shouldStop:()=>Date.now()>deadline});
 const usage=require('../src/api/api').usage;
 console.log(JSON.stringify({completed:result.completed,contentVerified:result.message.trim()==='PROTOCOLE-OK',requests:usage.requests,chars:usage.chars}));
 if(!result.completed||result.message.trim()!=='PROTOCOLE-OK')throw Error('La lecture demandée n’a pas été confirmée.');
})().catch(error=>{console.error(error.message);process.exitCode=1;}).finally(()=>require('../src/agent/codex-runtime').stop());
