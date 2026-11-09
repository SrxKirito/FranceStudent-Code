'use strict';
const readline=require('node:readline'),path=require('node:path');
const tools=require(path.join(process.env.FRANCESTUDENT_SOURCE,'src/agent/codex-tools'));
const send=(id,result,error)=>process.stdout.write(JSON.stringify(error?{jsonrpc:'2.0',id,error}:{jsonrpc:'2.0',id,result})+'\n');
const pendingCalls=new Map();
readline.createInterface({input:process.stdin}).on('line',async line=>{
 let message;try{message=JSON.parse(line);}catch{return;}
 if(!message||typeof message!=='object'||Array.isArray(message))return;
 if(message.method==='notifications/cancelled'){
  pendingCalls.get(message.params?.requestId)?.abort();
  return;
 }
 if(message.id===undefined)return;
 try{
  if(message.method==='initialize')return send(message.id,{protocolVersion:message.params?.protocolVersion||'2024-11-05',capabilities:{tools:{}},serverInfo:{name:'francestudent-ide',version:'0.2.0'}});
  if(message.method==='ping')return send(message.id,{});
  if(message.method==='tools/list')return send(message.id,{tools:[...tools.catalog(),{name:'read_context',description:'Relit un résultat passé abrégé dans le contexte, sans répéter son exécution. Utilise context_id comme id et next_start pour poursuivre. Ce snapshot ne prouve pas l’état actuel des fichiers.',inputSchema:{type:'object',properties:{id:{type:'string'},start:{type:'integer',minimum:0},max_chars:{type:'integer',minimum:200,maximum:12000}},required:['id'],additionalProperties:false}}]});
  if(message.method!=='tools/call')return send(message.id,null,{code:-32601,message:'Méthode inconnue'});
  if(typeof message.params?.name!=='string')return send(message.id,null,{code:-32602,message:'Nom d’outil manquant'});
  if(pendingCalls.has(message.id))return;
  const base=process.env.FS_CODEX_HOST_URL;
  const read=message.params?.name==='read_context';
  const controller=new AbortController();
  pendingCalls.set(message.id,controller);
  try {
   const response=await fetch(base+(read?'/context/read':'/host-tools/call'),{method:'POST',headers:{Authorization:'Bearer '+process.env.FRANCESTUDENT_BRIDGE_KEY,Origin:base,'Content-Type':'application/json'},body:JSON.stringify(read?message.params.arguments??{}:message.params),signal:controller.signal});
   const value=await response.json();if(!response.ok)throw Error(value.error||'Outil indisponible');
   send(message.id,{isError:!value.success,content:value.contentItems.map(item=>item.type==='inputImage'?{type:'image',mimeType:item.imageUrl.match(/^data:([^;]+)/)[1],data:item.imageUrl.split(',')[1]}:{type:'text',text:item.text})});
  } catch(error) {
   if(!controller.signal.aborted)throw error;
  } finally {
   pendingCalls.delete(message.id);
  }
 }catch(error){send(message.id,{isError:true,content:[{type:'text',text:error.message}]});}
});
