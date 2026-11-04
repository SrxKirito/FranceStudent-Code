'use strict';
const {ui}=require('../ui-bridge');
const {state,activateConversation,record}=require('../state');
const runtime=require('./codex-runtime');
async function runAgent(task,options={}){
 if(state.motionDesign)throw Error('Le moteur Codex Code ne doit pas accéder à l’espace Motion.');
 if(state.incognito)throw Error('Le mode éphémère n’est pas encore disponible pour ce moteur expérimental. Désactive-le pour conserver la conversation, ou utilise le moteur historique.');
 if(!state.workspace)throw Error('Ouvre un dossier pour utiliser l’agent Codex.');
 if(String(state.model).startsWith('custom:'))throw Error('Ce moteur expérimental utilise pour l’instant les modèles du compte FranceStudent.');
 if(options.shouldStop?.())return {completed:false,message:'Tâche interrompue.'};
 activateConversation('agent');
 const attachments=await require('./codex-attachments').prepare();
 const toolOptions={readOnly:!!options.readOnly,toolGroups:require('../tools/selection').current()||options.toolGroups,ecoMode:!!state.ecoMode};
 const extensions=await require('../tools/selection').run(toolOptions.toolGroups,()=>require('./codex-tools').extensions({includeMcp:!toolOptions.readOnly,task}));
 const client=await runtime.ensure(),abort=new AbortController(),hostAbort=new AbortController();
 const executeHostTool=require('./codex-tools').createExecutor({...toolOptions,task,extensionsMode:require('../settings').extensionsMode()},hostAbort.signal);
 const seenRequests=new Set(),expiredRequests=new Set(),hostCalls=new Map(),commandOutput=new Map();
 let requestQueue=Promise.resolve();
 let message='',failure=null,outcome=null,threadId=null,stopping=false,pollBusy=false;
 let done;const ended=new Promise(resolve=>{done=resolve;});
 const spinner=ui.spinner('Agent Codex');
 const sendStop=()=>client.request('/stop',{}).catch(()=>{});
 const stop=()=>{if(stopping)return;stopping=true;hostAbort.abort();void sendStop();};
 const off=ui.onInterrupt(stop);
 const onEvent=async m=>{
  const p=m.params||{},item=p.item,callId=item?(p.threadId||'')+':'+item.id:null;
  if(m.method==='local/backup')ui.info('Sauvegarde avant demande enregistrée.');
  if(m.method==='local/status')spinner.update(p.message);
  if(m.method==='local/toolExpired'){
   expiredRequests.add(p.id);
   hostCalls.get(p.id)?.abort();
  }
  if(m.method==='serverRequest/resolved')expiredRequests.add(p.requestId);
  if(m.method==='item/commandExecution/outputDelta' && !p.parentThreadId && typeof p.delta==='string') {
   const key=String(p.itemId||'command'), text=((commandOutput.get(key)||'')+p.delta).slice(-4000); commandOutput.set(key,text);
   if (/https?:\/\/(?:localhost|127\.0\.0\.1):\d+/i.test(text) && /(?:ready|listening|running|started|local:|serveur|server)/i.test(text)) require('../ui-bridge').getUiBackend().serverPreviewOutput?.(text);
  }
  if(m.method==='local/usage'){const usage=require('../api/api').usage;for(const name of Object.keys(usage))if(Number.isFinite(p.delta?.[name]))usage[name]+=p.delta[name];}
  if(m.method==='local/error'){failure=p.message;done();return;}
  if(m.method==='item/started'){
   if(item.type==='commandExecution')ui.tool('run_command',item.command,{codex:true,callId});
   else if(item.type==='fileChange')for(const change of item.changes||[]){const relative=require('node:path').relative(state.workspace,change.path).replace(/\\/g,'/');ui.tool('write_file',relative,{codex:true,callId:callId+':'+change.path,path:relative,fileKind:change.kind?.type||'update'});}
   else if(item.type==='mcpToolCall')ui.tool(item.server==='francestudent_web'?'web_source':'mcp_call',item.server+'.'+item.tool,{codex:true,callId});
   else if(item.type==='dynamicToolCall')ui.tool(item.tool,item.arguments?.path||item.tool,{codex:true,callId});
   else if(item.type==='collabAgentToolCall')ui.tool('subagent',({spawnAgent:'Lancer',wait:'Attendre',closeAgent:'Fermer',sendInput:'Transmettre une consigne',resumeAgent:'Reprendre'}[item.tool]||item.tool),{codex:true,callId});
  }
  if(m.method==='item/completed'){
   if(item.type==='agentMessage'){if(!p.parentThreadId){ui.assistant(item.text);record('assistant',item.text);if(item.phase!=='commentary')message=item.text;}else ui.info('Sous-agent : '+item.text);}
   else if(item.type==='commandExecution')ui.result((item.aggregatedOutput||'')+'\nÉtat : '+item.status+(item.exitCode!=null?' · code '+item.exitCode:''),{callId,tone:item.status==='completed'&&item.exitCode===0?undefined:'error'});
   else if(item.type==='fileChange')for(const change of item.changes||[])ui.result(change.path+'\nÉtat : '+item.status,{callId:callId+':'+change.path,tone:item.status==='completed'?undefined:'error',...(item.status==='completed'?require('./codex-change-stats').changeStats(change)||{}:{})});
   else if(item.type==='mcpToolCall')ui.result(JSON.stringify(item.result||item.error||{}),{callId,tone:item.status==='completed'&&!item.error&&!item.result?.isError?undefined:'error'});
   else if(item.type==='dynamicToolCall')ui.result((item.contentItems||[]).map(content=>content.text||'').filter(Boolean).join('\n'),{callId,tone:item.success===true?undefined:'error'});
   else if(item.type==='collabAgentToolCall')ui.result(JSON.stringify({agents:item.receiverThreadIds,status:item.status}),{callId,tone:item.status==='completed'?undefined:'error'});
  }
  if(m.method==='error'&&!p.willRetry&&!p.parentThreadId)failure=p.error?.message||'Erreur du moteur Codex';
  if(m.method==='turn/completed'&&!p.parentThreadId){outcome=p.turn;done();}
  if(m.id!=null){
   try{
    let result;
    if(m.method==='item/tool/call'){
     const call=new AbortController();
     hostCalls.set(m.id,call);
     try{result=await executeHostTool(p.tool,p.arguments??{},call.signal);}
     catch(error){result={success:false,contentItems:[{type:'inputText',text:JSON.stringify({error:error.message,executionUncertain:!!error.executionUncertain})}]};}
     finally{hostCalls.delete(m.id);}
     if(call.signal.aborted)return;
    }else if(m.method==='item/commandExecution/requestApproval'){
     const answer=await ui.askCommand(p.reason||'Autoriser cette commande Codex ?',p.command||'');result={decision:/^(o|oui|y|yes|t|tout|tt)$/i.test(String(answer).trim())?'accept':(p.availableDecisions?.includes('decline')?'decline':'cancel')};
    }else if(m.method==='item/fileChange/requestApproval')result={decision:await ui.confirm(p.reason||'Autoriser la modification de ces fichiers ?')?'accept':'decline'};
    else if(m.method==='item/tool/requestUserInput'){
     const answers={};for(const q of p.questions||[]){const answer=await require('../tools/ask-user').askUser({question:q.question,options:q.options?.length>1?q.options:undefined});answers[q.id]={answers:answer.skipped?[]:[...answer.selected,answer.text].filter(Boolean)};}result={answers};
    }else{await client.request('/answer',{id:m.id,error:{code:-32601,message:'Fonction non prise en charge par cette copie'}});return;}
    if(!stopping&&!outcome&&!expiredRequests.has(m.id))await client.request('/answer',{id:m.id,result});
   }catch(e){
    if(e.code==='ACTION_CANCELED')stop();
    else if(!stopping&&!outcome&&!expiredRequests.has(m.id)){
     ui.warn(e.message);
     await client.request('/answer',{id:m.id,error:{code:-32603,message:'Impossible de traiter la demande de l’outil.'}}).catch(()=>{});
    }
   }
  }
 };
 const events=client.events(abort.signal,m=>{
  if(m.id==null)return onEvent(m);
  if(stopping||outcome||seenRequests.has(m.id))return;
  seenRequests.add(m.id);
  // Une demande attend l’utilisateur ou un outil. Le flux doit continuer à lire
  // les événements d’arrêt et d’expiration pendant cette attente.
  requestQueue=requestQueue.then(()=>{
   if(!stopping&&!outcome&&!expiredRequests.has(m.id))return onEvent(m);
  }).catch(error=>{if(!stopping&&!outcome){failure=error.message;stop();done();}});
 }).then(()=>{if(!abort.signal.aborted&&!outcome){failure='Le flux Codex a été interrompu. La conversation reste enregistrée.';stop();done();}}).catch(e=>{if(e.name!=='AbortError'){failure=e.message;stop();done();}});
 const polling=setInterval(async()=>{if(pollBusy)return;pollBusy=true;try{if(options.shouldStop?.())stop();if(stopping||!threadId||outcome)return;const steering=options.drainSteering?.()||[];if(steering.length){await client.request('/steer',{text:steering.join('\n\n')});ui.info('Nouvelle consigne transmise à Codex.');}}catch(e){ui.warn(e.message);}finally{pollBusy=false;}},300);
 try{
  if(options.shouldStop?.()||stopping)return {completed:false,message:'Tâche interrompue.'};
  record('user',task);
  const previous=state.chatIds.agent;
  const result=await client.request('/start',{model:state.model,folder:state.workspace,text:task+attachments.text,visibleText:task,images:attachments.input,extensions,ecoMode:!!state.ecoMode,conversationId:previous?.startsWith('codex:')?previous.slice(6):null,newConversation:!previous?.startsWith('codex:'),autoApproveFiles:state.fullAccess||state.autoApprove,autoApproveCommands:state.fullAccess||state.autoApproveCommands,...toolOptions});
  if(stopping&&!outcome)await sendStop();
  attachments.commit();
  threadId=result.threadId;state.chatIds.agent='codex:'+threadId;state.chatId=state.chatIds.agent;state.historyMode='agent';
  state.conversationSettings.agent={model:state.model,webSearch:state.webSearch,private:state.private,incognito:state.incognito,motionDesign:false,engine:'codex'};
  state.modelHandoffs.agent=null;
  await require('../project/conversations').touch({id:state.chatId,firstMessage:task,model:state.model,workspace:state.workspace,mode:'agent',settings:state.conversationSettings.agent,frProject:null});
  await ended;
  if(failure||outcome?.error)throw Error(require('./codex-protocol').errorText(failure||outcome.error));
  const completed=outcome?.status==='completed';
  if(!completed&&!message)ui.info('Tâche interrompue. La conversation et ses sauvegardes sont conservées.');
  return {completed,message};
 }finally{if(threadId&&!outcome)stop();clearInterval(polling);off();spinner.stop();hostAbort.abort();abort.abort();await events;}
}
async function history(id){
 const client=await runtime.ensure(),result=await client.request('/conversations/open',{id:String(id).replace(/^codex:/,'')});
 const entries=[];for(const e of result.events){const p=e.params||{},item=p.item;if(e.method==='item/completed'){
  const callId=p.threadId+':'+item.id;
  if(item.type==='userMessage'&&!p.parentThreadId)entries.push({type:'user',text:item.content.filter(c=>c.type==='text').map(c=>c.text).join('\n')});
  else if(item.type==='agentMessage')entries.push({type:p.parentThreadId?'info':'assistant',text:(p.parentThreadId?'Sous-agent : ':'')+item.text});
  else if(item.type==='commandExecution')entries.push({type:'tool',name:'run_command',arg:item.command,codex:true,callId},{type:'result',callId,text:(item.aggregatedOutput||'')+'\nÉtat : '+item.status,tone:item.status==='completed'&&item.exitCode===0?null:'error'});
  else if(item.type==='fileChange')for(const change of item.changes||[]){const relative=require('node:path').relative(state.workspace,change.path).replace(/\\/g,'/');const id=callId+':'+change.path;entries.push({type:'tool',name:'write_file',arg:relative,path:relative,fileKind:change.kind?.type||'update',codex:true,callId:id},{type:'result',callId:id,text:change.path+' · '+item.status,tone:item.status==='completed'?null:'error',...(item.status==='completed'?require('./codex-change-stats').changeStats(change)||{}:{})});}
  else if(item.type==='mcpToolCall')entries.push({type:'tool',name:item.server==='francestudent_web'?'web_source':'mcp_call',arg:item.server+'.'+item.tool,codex:true,callId},{type:'result',callId,text:JSON.stringify(item.result||item.error||{}),tone:item.status==='completed'&&!item.error&&!item.result?.isError?null:'error'});
  else if(item.type==='dynamicToolCall')entries.push({type:'tool',name:item.tool,arg:item.arguments?.path||item.tool,codex:true,callId},{type:'result',callId,text:(item.contentItems||[]).map(content=>content.text||'').filter(Boolean).join('\n'),tone:item.success===true?null:'error'});
  else if(item.type==='collabAgentToolCall')entries.push({type:'tool',name:'subagent',arg:item.tool,codex:true,callId},{type:'result',callId,text:JSON.stringify({agents:item.receiverThreadIds,status:item.status}),tone:item.status==='completed'?null:'error'});
 }else if(e.method==='local/questionAnswer')entries.push({type:'user',text:'Réponse : '+JSON.stringify(p.result)});}
 return entries;
}
module.exports={runAgent,history};
