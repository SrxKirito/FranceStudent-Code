'use strict';
// Catalogue partagé avec le serveur MCP du moteur Code. Aucune extension Motion.
const READ_ONLY = new Set(['list_directory','search_files','read_file','read_attachment','semantic_search','project_sources','view_image','update_plan','roblox_scene','use_skill','ask_user']);
const NAMES = new Set([...READ_ONLY,'create_directory','write_file','edit_file','move_path','copy_path','delete_path','remember','mcp_call','github','browse','diagnostics','roblox_check','roblox_env','rojo_serve','roblox_playtest','blender']);
const string = {type:'string'};
const integer = {type:'integer'};
const boolean = {type:'boolean'};
const pathProperties = {path:string};
const pairProperties = {from:string,to:string};
const schema = (properties,required=Object.keys(properties)) => ({type:'object',properties,required,additionalProperties:false});
const INPUT_SCHEMAS = {
 list_directory:schema({path:string,recursive:boolean},[]),
 read_file:schema({path:string,start_line:integer,end_line:integer},['path']),
 search_files:schema({query:string,path:string,regex:boolean,glob:string},['query']),
 semantic_search:schema({query:string,path:string,glob:string,max_results:integer},['query']),
 create_directory:schema(pathProperties),
 write_file:schema({path:string,content:string}),
 edit_file:schema({path:string,old_string:{type:'string',minLength:1},new_string:string,replace_all:{type:'boolean'}},['path','old_string','new_string']),
 move_path:schema(pairProperties),
 copy_path:schema(pairProperties),
 delete_path:schema(pathProperties),
 remember:schema({note:string}),
 view_image:schema(pathProperties),
 update_plan:schema({steps:{type:'array',items:schema({step:string,status:{type:'string',enum:['pending','in_progress','completed']}},['step'])}}),
 mcp_call:schema({server:string,tool:string,arguments:{type:'object',additionalProperties:true},describe:boolean},['server','tool']),
 browse:schema({url:string,full_page:boolean,width:integer,height:integer,wait_ms:integer,max_chars:integer},['url']),
 github:schema({action:string,path:string,branch:string,message:string,paths:{type:'array',items:string},content:string,sha:string,tag:string,target:string,title:string,body:string,prerelease:boolean,id:{anyOf:[string,integer]},latest:boolean,head:string,base:string,draft:boolean},['action']),
 use_skill:schema({name:string},['name'])
};
const DESCRIPTIONS={
 update_plan:'Met à jour le plan visible. Utilise au plus une étape in_progress et marque completed après vérification.',
 view_image:'Examine une image PNG, JPEG, WebP ou GIF du projet. Demande l’autorisation de transmettre l’image au modèle.',
 edit_file:'Modifie un fichier existant du projet en remplaçant un extrait exact. Lis d’abord le fichier avec read_file. Ajoute assez de contexte pour que old_string soit unique. Une chaîne new_string vide supprime l’extrait. Les autorisations de l’IDE s’appliquent.',
 mcp_call:'Appelle un serveur MCP configuré dans les réglages de cet IDE. {server,tool,arguments?:{},describe?:true}. describe:true découvre le schéma sans exécuter. Une confirmation reste requise selon les réglages avant un appel réel.',
 use_skill:'Charge les instructions d’un skill installé dans cet IDE. {name}.',
 project_sources:'Lit les dossiers supplémentaires explicitement choisis dans le projet, sans les modifier. {action:"sources"} liste les sources ; {action:"list",source,path?} liste un dossier ; {action:"read",source,path,start_line?,end_line?} lit un fichier ; {action:"search",source,query,path?} cherche du texte. Utilise les identifiants renvoyés par sources.',
 roblox_check:'Vérifie un projet Roblox/Luau avec les outils installés. {files?:["src/script.luau"],build?:true,timeout_ms?}. Peut exécuter rojo build, demande les confirmations existantes ; n’invente pas un test réussi si les outils sont absents.',
 roblox_scene:'Analyse statique du graphe de scène Roblox dans le projet. {detail?:true,tree?:false}. tree:true renvoie l’arbre Studio. Lecture seule ; aucun contrôle direct de Roblox Studio.',
 roblox_env:'Vérifie les outils Roblox/Blender installés. {action:"check"} (défaut), ou {action:"studio"} prépare la connexion Rojo du projet. Aucun téléchargement automatique.',
 rojo_serve:'Gère la synchronisation locale Rojo avec Studio. {action:"status"|"connect"|"start"|"stop",port?:1024..65535}. Ne prétends pas que Studio est connecté sans preuve dans le résultat.',
 roblox_playtest:'Prépare un build et ouvre le projet dans Roblox Studio : {} ou {timeout_ms?}. {action:"logs",since_ms?} relit les logs sans relancer. Le démarrage n’atteste pas un test F5 réussi.',
 blender:'Outil Blender local du projet. {action:"detect"|"templates"} découvre l’installation ou les modèles ; {action:"inspect"|"validate"|"render"|"script"|"manifest"|"export_blender",path,output?,name?,timeout_ms?,script_args?:[]} traite un fichier du projet. Actions import_roblox et export_blender préparent l’import/export local ; elles ne publient aucun asset sur Roblox. Une action script exécute un script Python existant, après ses confirmations.'
};
function catalog() {
 const blocks=require('./prompt').TOOL_CATALOG.split(/\n(?=(?:\d+\. )?[a-z_]+ —)/);
 return [...NAMES].map(name=>({name,description:(DESCRIPTIONS[name]||blocks.find(block=>new RegExp('^(?:\\d+\\. )?'+name+' —').test(block.trim()))?.trim()||name).slice(0,6500),inputSchema:INPUT_SCHEMAS[name]||{type:'object',properties:{},additionalProperties:true}}));
}
function assertAllowed(name,{readOnly=false,toolGroups=null,ecoMode=false}={}) {
 if(!NAMES.has(name))throw Error('Outil de l’IDE inconnu.');
 if(readOnly&&!READ_ONLY.has(name))throw Error('Outil indisponible en lecture seule.');
 if(ecoMode&&name==='task')throw Error('Sous-agents désactivés en mode Éco.');
 const selection=require('../tools/selection');
 return selection.run(toolGroups,()=>selection.assertAllowed(name));
}
async function extensions({includeSkills=true,includeMcp=true,task=''}={}) {
 const {state}=require('../state');
 if(state.motionDesign)throw Error('Les extensions Code sont interdites dans Motion.');
 const sections=[];
 if(includeMcp&&require('../tools/selection').allowed('mcp_call')){
  const manager=require('../mcp/manager').manager;
  try{const servers=await manager.ensureStarted();for(const server of servers.filter(s=>s.status==='failed'))sections.push('MCP '+server.name+' indisponible : '+server.error);let text=manager.catalog();if(require('../settings').extensionsMode()==='manual')text=require('./extensions').filterMcpCatalog(text,task);if(text)sections.push('OUTILS MCP CONFIGURÉS DANS CET IDE (utiliser mcp_call, describe:true pour les arguments) :\n'+text);
   if(servers.some(s=>s.name==='FranceStudent_Blender'&&s.status==='running'))sections.push('Blender ouvert : pour agir dans sa session, utilise mcp_call sur FranceStudent_Blender, commence par scene_info. Le catalogue ne prouve pas que Blender répond. L’outil blender historique travaille sur des fichiers en arrière-plan ; ne le substitue pas silencieusement à la session ouverte. Respecte le refus des scripts Python.');
   if(servers.some(s=>s.name==='Roblox_Studio'&&s.status==='running'))sections.push('Roblox Studio ouvert : utilise le MCP officiel Roblox_Studio, liste les sessions avec list_roblox_studios, puis leur studio_id. Vérifie le schéma avant une action ; ne génère ni publie des assets payants sans demande correspondante.');
  }catch(error){sections.push('Configuration MCP indisponible : '+error.message);}
 }
 if(includeSkills&&require('../tools/selection').allowed('use_skill')){let catalog=await require('../skills').catalog(state.workspace,'code',{task});if(require('../settings').extensionsMode()==='manual')catalog=require('./extensions').filterSkillsCatalog(catalog,task);if(catalog)sections.push('SKILLS PERTINENTS POUR CETTE DEMANDE (charger avec use_skill si utile) :\n'+catalog);}
 return sections.join('\n\n');
}
function createExecutor(options,signal) {
 let queue=Promise.resolve();const uncertain=new Set();
 const canonical=value=>Array.isArray(value)?value.map(canonical):value&&typeof value==='object'?Object.fromEntries(Object.keys(value).sort().map(k=>[k,canonical(value[k])])):value;
 const execute=async(name,args,callSignal)=>{
  const {state}=require('../state');
  const cancellation=signal&&callSignal?AbortSignal.any([signal,callSignal]):signal||callSignal;
  if(cancellation?.aborted)throw Error('Tâche ou appel interrompu.');
  if(state.motionDesign)throw Error('L’espace Code est fermé.');
  assertAllowed(name,options);
  if(options.extensionsMode==='manual'){
   const mentions=require('./extensions').mentions;
   if(name==='use_skill'&&!mentions(options.task,args.name))throw Error('Ce skill doit être nommé dans la demande en mode manuel.');
   if(name==='mcp_call'&&!mentions(options.task,args.server)&&!mentions(options.task,args.tool))throw Error('Ce serveur ou outil MCP doit être nommé dans la demande en mode manuel.');
  }
  return require('../tools/selection').run(options.toolGroups,async()=>{
   const {TOOLS,validateToolCall,describeCall}=require('../tools/registry');
   const action={name,args};validateToolCall(action);
   const key=name==='mcp_call'&&args.describe!==true?JSON.stringify(canonical(args)):null;
   if(key&&uncertain.has(key))throw Error('Le résultat du précédent appel MCP est incertain. Ne pas répéter cette action ; vérifier son état séparément.');
   // Ces outils ajoutent leurs images à la file habituelle. Les retirer de cette
   // file uniquement pour les renvoyer dans le résultat MCP de cet appel.
   const before=state.pendingImages.length;
   try{
    const result=await require('../tools/action-control').run(name,describeCall(action),()=>TOOLS[name].run(args),cancellation);
    if(key&&result.executionUncertain)uncertain.add(key);
    const images=state.pendingImages.splice(before);
    if(cancellation?.aborted)throw Object.assign(Error('Interruption demandée. Le résultat de cet outil est écarté ; des effets déjà produits restent possibles.'),{executionUncertain:true});
    const contentItems=[{type:'inputText',text:JSON.stringify(result)}];
    for(const image of images){if(!/^data:image\//i.test(String(image)))throw Error('Image du connecteur indisponible ; aucun contenu visuel confirmé.');contentItems.push({type:'inputImage',imageUrl:image});}
    return {success:!result.denied&&!result.interrupted&&!result.is_error&&!result.error&&!result.executionUncertain,contentItems};
   }catch(error){state.pendingImages.splice(before);if(key&&(error.executionUncertain||cancellation?.aborted))uncertain.add(key);throw error;}
  });
 };
 return (name,args,callSignal)=>{const job=queue.then(()=>execute(name,args,callSignal));queue=job.catch(()=>{});return job;};
}
module.exports={NAMES,READ_ONLY,catalog,assertAllowed,extensions,createExecutor};
