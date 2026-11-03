'use strict';
const fs=require('node:fs/promises'),net=require('node:net'),readline=require('node:readline');
const schema=(properties={},required=[])=>({type:'object',properties,required,additionalProperties:false});
const text={type:'string'},vector={type:'array',items:{type:'number'},minItems:3,maxItems:3};
const TOOLS=[
 {name:'scene_info',description:'Lit les objets et transformations de la scène Blender ouverte (200 objets maximum). Vérifie aussi si les scripts Python sont autorisés.',inputSchema:schema()},
 {name:'object_info',description:'Lit les transformations d’un objet Blender nommé exactement.',inputSchema:schema({name:text},['name'])},
 {name:'create_primitive',description:'Crée une primitive dans la scène ouverte sans supprimer les objets existants.',inputSchema:schema({kind:{enum:['cube','sphere','cylinder','plane','cone','torus'],type:'string'},name:text,location:vector,scale:vector},['kind','name'])},
 {name:'transform_object',description:'Modifie la position, rotation en radians ou échelle d’un objet précis.',inputSchema:schema({name:text,location:vector,rotation:vector,scale:vector},['name'])},
 {name:'set_material',description:'Attribue une nouvelle couleur RGBA (0 à 1) à un objet précis, sans modifier les matériaux partagés des autres objets.',inputSchema:schema({name:text,color:{type:'array',items:{type:'number',minimum:0,maximum:1},minItems:4,maxItems:4}},['name','color'])},
 {name:'delete_objects',description:'Supprime uniquement les objets explicitement nommés. Requiert une demande utilisateur correspondante.',inputSchema:schema({names:{type:'array',items:text,minItems:1,maxItems:100}},['names'])},
 {name:'get_screenshot',description:'Capture réellement le viewport 3D Blender et retourne les pixels. Nécessite une fenêtre et une vue 3D ouvertes.',inputSchema:schema()},
 {name:'execute_python',description:'Exécute du Python dans la scène ouverte seulement si l’utilisateur a activé cette option dans le panneau Blender FranceStudent. Variable result JSON pour le résultat ; ne pas contourner un refus.',inputSchema:schema({code:{type:'string',maxLength:100000}},['code'])}
];
async function call(action,args={},timeoutMs=45000){
 if(!TOOLS.some(tool=>tool.name===action))throw Error('Outil Blender inconnu.');
 const file=process.env.FS_BLENDER_SESSION_FILE;if(!file)throw Error('Fichier de connexion Blender non configuré.');
 let session;try{session=JSON.parse(await fs.readFile(file,'utf8'));}catch{throw Error('Blender non connecté. Ouvre Blender depuis le plugin de l’IDE ou active FranceStudent Connect dans ta session.');}
 if(session.host!=='127.0.0.1'||!Number.isInteger(session.port)||session.port<1024||session.port>65535||!/^[a-f0-9]{64}$/.test(session.token||''))throw Error('Connexion Blender invalide.');
 return new Promise((resolve,reject)=>{
  const client=net.createConnection({host:'127.0.0.1',port:session.port});let buffer='',sent=false,settled=false;
  const fail=error=>{if(settled)return;settled=true;client.destroy();reject(Object.assign(Error(error.message+(sent?' Le résultat est incertain ; vérifie la scène avant de répéter.':'')),{executionUncertain:sent}));};
  client.setEncoding('utf8');client.setTimeout(timeoutMs,()=>fail(Error('Délai de Blender dépassé.')));
  client.on('connect',()=>{const payload=JSON.stringify({token:session.token,action,arguments:args})+'\n';if(Buffer.byteLength(payload)>1024*1024)return fail(Error('Requête Blender trop grande.'));sent=true;client.write(payload);});
  client.on('data',chunk=>{buffer+=chunk;if(buffer.length>12*1024*1024)return fail(Error('Réponse Blender trop grande.'));const end=buffer.indexOf('\n');if(end<0)return;try{const response=JSON.parse(buffer.slice(0,end));settled=true;client.destroy();resolve(response);}catch{fail(Error('Réponse Blender invalide.'));}});
  client.on('error',error=>fail(Error(error.code==='ECONNREFUSED'?'Blender ne répond pas : relance sa connexion locale.':error.message)));
  client.on('end',()=>{if(!settled)fail(Error('Connexion Blender fermée avant le résultat.'));});
 });
}
function serve(){
 const send=(id,result)=>process.stdout.write(JSON.stringify({jsonrpc:'2.0',id,result})+'\n');
 readline.createInterface({input:process.stdin}).on('line',async line=>{
  let message;try{message=JSON.parse(line);}catch{return;}if(message.id===undefined)return;
  if(message.method==='initialize')return send(message.id,{protocolVersion:message.params?.protocolVersion||'2025-06-18',capabilities:{tools:{}},serverInfo:{name:'FranceStudent-Blender',version:'0.1.0'}});
  if(message.method==='tools/list')return send(message.id,{tools:TOOLS});
  if(message.method==='ping')return send(message.id,{});
  if(message.method!=='tools/call')return process.stdout.write(JSON.stringify({jsonrpc:'2.0',id:message.id,error:{code:-32601,message:'Méthode inconnue'}})+'\n');
  try{const result=await call(message.params.name,message.params.arguments||{});const content=[];if(result.result?.image)content.push({type:'image',...result.result.image});else content.push({type:'text',text:JSON.stringify(result.success?result.result:result)});send(message.id,{isError:!result.success,structuredContent:{executionUncertain:!result.success&&result.effects_may_have_occurred===true},content});}
  catch(error){send(message.id,{isError:true,structuredContent:{executionUncertain:!!error.executionUncertain},content:[{type:'text',text:JSON.stringify({error:error.message,executionUncertain:!!error.executionUncertain})}]});}
 });
}
if(require.main===module)serve();
module.exports={call,TOOLS};
