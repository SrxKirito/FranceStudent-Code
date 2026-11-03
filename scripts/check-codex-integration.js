'use strict';
// Parcours manuel, sur un dossier de démonstration uniquement.
const path=require('node:path'),fs=require('node:fs');
const profile=path.resolve(__dirname,'../../francestudent-ide-codex-data');
process.env.FS_DATA_DIR=path.join(profile,'core');process.env.FS_STATE_DIR=path.join(profile,'state');process.env.FS_AGENT_ENGINE='codex';
const {state}=require('../src/state'),{setUiBackend}=require('../src/ui-bridge');
const folder=path.resolve(__dirname,'../../francestudent-codex-prototype/playground/ide-check');fs.mkdirSync(folder,{recursive:true});
const transcript=require('../desktop/conversation-transcript').createTranscriptStore(path.join(process.env.FS_DATA_DIR,'conversation-transcripts'));
const entries=[];
const backend=require('../desktop/backend').createDesktopBackend((channel,data)=>{if(channel==='entry'){entries.push(data);transcript.capture(state.chatIds.agent,data);console.log(data.type,data.type==='tool'?data.name:data.type==='assistant'?data.text:data.type==='error'?data.text:'');}});
setUiBackend(backend);state.workspace=folder;state.model=-2003;state.mode='agent';state.autoApprove=true;state.autoApproveCommands=true;
(async()=>{
 const resume=process.argv.includes('--resume');if(resume){const saved=JSON.parse(fs.readFileSync(path.join(profile,'integration-check.json'),'utf8'));state.chatIds.agent=saved.id;state.chatId=saved.id;state.conversationSettings.agent={model:state.model,engine:'codex'};}
 await require('../src/project/memory').open(folder);await transcript.begin(state.chatIds.agent,{mode:'agent',model:state.model,workspace:folder,settings:{model:state.model,engine:'codex'}});
 const task=resume?'Quel mot de contrôle t’ai-je donné dans notre conversation ? Réponds uniquement avec ce mot.':'Crée le fichier integration.txt contenant exactement « Agent Codex intégré ». Puis lis-le avec une commande pour vérifier son contenu. Retiens pour cette conversation le mot de contrôle cuivre-842.';
 await transcript.capture(state.chatIds.agent,{type:'user',text:task});backend.startRun(task);
 const result=await require('../src/agent/agent').runAgent(task);
 await transcript.finish(state.chatIds.agent);await transcript.flush();backend.endRun({ok:result.completed});
 if(!result.completed||!fs.readFileSync(path.join(folder,'integration.txt'),'utf8').includes('Agent Codex intégré')||resume&&!result.message.includes('cuivre-842'))throw Error('Le parcours d’intégration n’a pas abouti.');
 const saved=await transcript.load(state.chatIds.agent),backups=await require('../src/project/file-versions').list();
 console.log(JSON.stringify({completed:result.completed,id:state.chatIds.agent,visibleEntries:saved.entries.length,codexTools:entries.filter(e=>e.type==='tool'&&e.codex).length,backups:backups.length,engine:backend.status().agentEngine}));
 fs.writeFileSync(path.join(profile,'integration-check.json'),JSON.stringify({id:state.chatIds.agent,folder}));
 if(resume){const versions=require('../src/project/file-versions'),point=await versions.save(folder,'Contrôle restauration de la copie');fs.writeFileSync(path.join(folder,'ancien.txt'),'changement temporaire');const preview=await versions.preview(folder,point.id);const restored=await versions.restore(folder,point.id,preview.expected);if(!fs.readFileSync(path.join(folder,'ancien.txt'),'utf8').includes('avant')||!restored.safetyId)throw Error('Restauration de la copie non confirmée.');console.log(JSON.stringify({restored:restored.restored,safetyBackup:restored.safetyId}));}
})().catch(e=>{console.error(e.message);process.exitCode=1;}).finally(()=>require('../src/agent/codex-runtime').stop());
