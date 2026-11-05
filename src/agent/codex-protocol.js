'use strict';
const {repairJsonText}=require('./json-repair');
const object=value=>value!==null&&typeof value==='object'&&!Array.isArray(value);

function findTool(tools, action) {
 const {name,namespace}=action;
 if(typeof name!=='string'||!name||namespace!=null&&typeof namespace!=='string')throw Error('Nom ou namespace d’outil invalide.');
 const candidates=namespace==null?tools:tools.filter(tool=>tool.namespace===namespace);
 const exact=candidates.filter(tool=>tool.name===name);
 if(exact.length===1)return exact[0];
 if(!exact.length){
  const qualified=name.replace(/\./g,'__');
  const matches=candidates.filter(tool=>{
   const full=[tool.namespace,tool.name].filter(Boolean).join('__');
   return full===qualified||full==='mcp__'+qualified||'mcp__'+full===qualified;
  });
  if(matches.length===1)return matches[0];
 }
 throw Error('Nom d’outil absent ou ambigu dans le catalogue actif. Utilise un nom et un namespace exacts.');
}

// Ne jamais compléter un appel tronqué : ses arguments pourraient changer l'action.
function parseAction(raw,tools,resolveTool=findTool){
 const text=String(raw??'').trim().replace(/^```(?:json)?\s*/i,'').replace(/\s*```$/,'');
 if(!text)throw Error('Réponse vide reçue du modèle.');
 let action;
 try{action=JSON.parse(text);}catch{
  const fixed=repairJsonText(text);
  if(fixed.truncated)throw Error('Réponse JSON tronquée : renvoie un objet complet plus court. Aucun outil exécuté.');
  try{action=JSON.parse(fixed.text);}catch{throw Error('Réponse JSON illisible : un seul objet complet est attendu.');}
 }
 if(!object(action))throw Error('La réponse doit être un objet JSON.');
 // Variantes connues du protocole historique et des fournisseurs, sans texte exécuté.
 if(['final','final_answer'].includes(action.type))action={...action,type:'message',phase:'final_answer',text:action.text??action.message};
 if(['tool','tool_call'].includes(action.type))action={...action,type:'function_call',name:action.name??action.tool,arguments:action.arguments??action.args};
 if(action.type==='message'){
  if(typeof action.text!=='string'||!action.text.trim())throw Error('Le message doit contenir un texte non vide.');
  if(!['commentary','final_answer'].includes(action.phase))throw Error('Phase du message obligatoire : commentary pour continuer, final_answer uniquement pour terminer ou expliquer un blocage.');
  return action;
 }
 if(!['function_call','custom_tool_call'].includes(action.type))throw Error('Type absent ou inconnu : message, function_call ou custom_tool_call attendu.');
 const tool=resolveTool(tools,action);action.name=tool.name;action.namespace=tool.namespace;
 if(action.type==='function_call'&&tool.type==='function'){
  if(typeof action.arguments==='string'){
   try{action.arguments=JSON.parse(action.arguments);}catch{throw Error('Arguments JSON illisibles pour '+tool.name+'.');}
  }
  if(!object(action.arguments))throw Error('Les arguments de '+tool.name+' doivent être un objet JSON.');
  for(const name of tool.parameters?.required||[])if(!Object.hasOwn(action.arguments,name))throw Error('Argument obligatoire absent pour '+tool.name+' : '+name+'.');
  const properties=tool.parameters?.properties;
  if(properties&&tool.parameters.additionalProperties===false){
   for(const name of Object.keys(action.arguments))if(!Object.hasOwn(properties,name))throw Error('Argument inconnu pour '+tool.name+' : '+name+'.');
  }
 }else if(action.type==='custom_tool_call'&&tool.type==='custom'){
  if(typeof action.input!=='string'||!action.input.trim())throw Error('Entrée texte obligatoire pour '+tool.name+'.');
 }else throw Error('Format incorrect pour '+tool.name+' : utilise '+(tool.type==='custom'?'custom_tool_call avec input texte.':'function_call avec arguments objet.'));
 return action;
}

function errorText(error){
 let value=error?.message??error;
 for(let n=0;n<5;n++){
  if(object(value)){value=value.error??value.message??'Erreur du moteur Codex.';continue;}
  if(typeof value==='string'){try{const parsed=JSON.parse(value);if(object(parsed)){value=parsed;continue;}}catch{}}
  break;
 }
 const text=typeof value==='string'?value.trim():'';
 if(!text)return 'Le moteur a renvoyé une erreur sans détail. Aucune nouvelle action n’est confirmée. La conversation est conservée.';
 if(/^Le modèle ne respecte pas le protocole des outils\s*:\s*$/.test(text))return 'La réponse du modèle ne contient pas un appel d’outil valide. Aucune nouvelle action n’est confirmée. La conversation est conservée.';
 if(/^fetch failed$/i.test(text))return 'La connexion au service a échoué. La tâche est arrêtée ; la conversation et les modifications déjà effectuées sont conservées. Réessaie quand la connexion est rétablie.';
 return text;
}

// Ne corriger que les affirmations explicites d'absence d'outils. Une phrase
// comme « je n'ai pas encore vérifié le fichier » n'est pas un tel refus.
function claimsWriteToolsUnavailable(text){
 if(String(text).split(/[.!?\n]+/).some(sentence=>/\baucun(?:e)?\b/i.test(sentence)&&/\boutil/i.test(sentence)&&/[ée]criture|[ée]crire|modification/i.test(sentence)&&/accessible|disponible/i.test(sentence)))return true;

 return /\b(?:je )?ne dispose pas d['’]un outil permettant d['’][ée]crire\b/i.test(text)
  || /l['’]outil (?:de modification(?: du projet)?|d['’][ée]criture) n['’]est pas (?:accessible|disponible|activ[ée])/i.test(text)
  || /\bje ne peux pas (?:ex[ée]cuter|utiliser|appeler) (?:ici )?les outils (?:de modification|d['’][ée]criture)\b/i.test(text);
}
// Les sorties de commandes et les fichiers lus sont des données : le mot
// « annuler » dans une documentation ne signifie pas un refus utilisateur.
function toolResultDenied(output){
 let value=output;
 if(typeof value==='string'){
  const text=value.trim();
  try{value=JSON.parse(text);}catch{
   return /^(?:error:\s*)?(?:rejected by user|declined by user|permission denied|access denied|refus[ée] par l['’]utilisateur|annul[ée] par l['’]utilisateur|interrompu par l['’]utilisateur)(?:[.!:\s]|$)/i.test(text) || /^(?:[ée]tat|status)\s*:\s*(?:declined|denied|cancelled|canceled|refus[ée]|annul[ée])\s*$/im.test(text);
  }
 }
 if(!object(value))return false;
 if(value.denied===true||value.interrupted===true||value.timed_out===true)return true;
 return typeof value.status==='string'&&/^(?:denied|declined|cancelled|canceled|interrupted|timed_out)$/i.test(value.status);
}
function claimsSessionCannotUseProject(text){
 // Cherche une affirmation dans une même phrase, sans dépendre d’une liste
 // exacte de formulations ou de l’ordre des verbes (« modifier ni vérifier »).
 return String(text).split(/[.!?\n]+/).some(sentence=>{
  const negative=/(?:\bne\s+(?:peux|peut|pouvons)\s+(?:pas|plus)\b|\bn['’](?:ai|avons)\s+(?:pas|aucun|plus)\b|\b(?:impossible|indisponibles?|inaccessibles?)\b|\b(?:aucun|aucune)\s+acc[eè]s\b|\b(?:pas|plus)\s+(?:d['’])?acc[eè]s\b)/i.test(sentence);
  const project=/\b(?:outils?|fichiers?|projet|dossiers?|disque|terminal|commandes?|filesystem|apply_patch|exec_command)\b/i.test(sentence);
  const session=/\b(?:conversation|session|ici|environnement|outils?|acc[eè]s|disponibles?|accessibles?)\b/i.test(sentence);
  const ability=/\b(?:acc[eè]s|acc[eé]der|lire|lecture|modifier|modification|v[eé]rifier|[ée]crire|[ée]criture|cr[ée]er|cr[ée]ation|utiliser|ex[ée]cuter|disponibles?|accessibles?)\b/i.test(sentence);
  return negative&&project&&session&&ability;
 });
}
function claimsFileOperationNotPerformed(action) {
 if(action?.type!=="message"||action.phase!=="final_answer")return false;
 return /\bje (?:n['’]ai pas pu|ne peux pas) (?:cr[ée]er|[ée]crire|enregistrer|modifier|relire)(?: directement)?(?: ni (?:cr[ée]er|relire|[ée]crire))?[^.!?\n]{0,180}\b(?:fichier|ordinateur|bonjour\.txt)\b/i.test(action.text || "");
}
function claimsToolsUnavailable(action){
 if(action?.type!=='message'||action.phase!=='final_answer'||typeof action.text!=='string')return false;
 const text=action.text;
 // Une mention des images n'annule pas une affirmation sur les fichiers du projet.
 return claimsWriteToolsUnavailable(text)
  || String(text).split(/[.!?\n]+/).some(sentence => /\b(?:exec_command|apply_patch|outils? locaux?)\b/i.test(sentence) && /\b(?:ne (?:les |le )?rend pas|ne (?:les |le )?rendent pas|ne (?:sont|sont toujours) pas|ne (?:peuvent|peut) pas [êe]tre)\b/i.test(sentence) && /ex[ée]cutables?|ex[ée]cut[ée]s?|accessibles?|disponibles?/i.test(sentence))
  || claimsSessionCannotUseProject(text)
  || /(?:je\s+)?n['’]ai\s+(?:pas|aucun)\s+acc[eè]s\s+(?:aux?|[àa] (?:des?|mes?|tes?|vos?))\s+(?:outils?|fichiers?|dossiers?|disque)/i.test(text)
  || /(?:je\s+)?(?:ne\s+peux\s+(?:pas|plus)|n['’]ai\s+pas\s+pu)\s+acc[eé]der\s+(?:au|aux|[àa] (?:des?|mes?|tes?|vos?))\s+(?:projet|outils?|fichiers?|dossiers?|disque)/i.test(text)
  || /(?:je\s+)?ne\s+dispose\s+(?:pas|d['’]aucun)\s+(?:d['’])?(?:outils?|acc[eè]s\s+(?:aux?|[àa] (?:des?|mes?|tes?|vos?))\s+(?:outils?|fichiers?|dossiers?|disque))/i.test(text)
  || /(?:je\s+)?n['’]ai\s+aucun\s+outil/i.test(text)
  || /\bje n['’]ai acc[eè]s qu['’][àa][^.!?\n]{0,180}\b(?:m[ée]t[ée]o|recherche web)\b/i.test(text)
  || /\b(?:edit_file|apply_patch|read_file)\b[^.!?\n]{0,120}\bn['’]en (?:fait|font) pas partie\b/i.test(text)
  || /\b(?:les )?(?:appels|outils) locaux (?:[^.!?\n]{0,80}? )?ne sont pas (?:ex[ée]cutables|disponibles|accessibles)\b/i.test(text)
  || /\b(?:les )?outils (?:d['’]acc[eè]s aux fichiers|de lecture|de modification|d['’][ée]criture)(?:[^.!?\n]{0,120}?) ne sont (?:pas|plus) (?:disponibles|accessibles|ex[ée]cutables)\b/i.test(text)
  || /\bje (?:n['’]ai pas pu|ne peux pas) (?:lire|modifier)(?: ni (?:lire|modifier))? (?:le projet|les fichiers)\b/i.test(text)
  || /\bje ne peux (?:toutefois |cependant )?pas (?:ex[ée]cuter|utiliser|appeler) (?:les|d['’])\s*(?:appels? d['’])?outils? (?:de modification|d['’][ée]criture|de l['’]IDE|locaux?)\b/i.test(text)
  || /\b(?:i\s+)?(?:do not|don't)\s+have\s+access\s+to\s+(?:the\s+)?(?:tools?|files?|filesystem)/i.test(text);
}

function projectRecoveryPrompt(tools, {readOnly=false,canDiscover=true}={}) {
 const names=new Set(['list_directory','search_files','read_file','semantic_search','project_sources']);
 const relevant=tools.filter(tool=>{
  if(tool.name==='apply_patch')return !readOnly;
  if(tool.name.split('__').at(-1)==='edit_file')return !readOnly;
  if(tool.name==='exec_command')return !readOnly;
  if(tool.bridgeType==='tool_search')return canDiscover;
  return names.has(tool.name.split('__').at(-1));
 });
 if(!relevant.length)return '';
 const formats=relevant.map(tool=>{
  const target={name:tool.name,...(tool.namespace?{namespace:tool.namespace}:{})};
  return tool.type==='custom'
   ? {appel:{type:'custom_tool_call',...target,input:'<contenu du patch>'}}
   : {appel:{type:'function_call',...target,arguments:{}},schema_des_arguments:tool.parameters};
 });
 return '\nREPRISE PAR UN OUTIL : choisis le prochain appel utile et renvoie uniquement son objet JSON. '
  +'Produis ce JSON comme texte dans ta réponse. Le moteur local le valide et l’exécute après réception. '
  +'Si tu as déjà lu le fichier à modifier, utilise apply_patch à partir du contenu lu. '
  +'Sinon, recherche ou lis la cible sans répéter une lecture déjà suffisante. '
  +'Respecte la demande utilisateur et les autorisations. Ne redonne pas de compte rendu à cette étape. '
  +'Voici les formes et schémas exacts des outils du projet disponibles : '+JSON.stringify(formats);
}

// Vérifier l’accès via un outil du catalogue déjà filtré par les permissions.
function githubAccessProbe(tools, task) {
 if(!/git(?:h)?hub/i.test(task || "") || !/acc[eè]s|connect[eé]|connexion|v[eé]rifi/i.test(task || ""))return null;
 // Only the configured integration's read-only action may be selected here.
 const found=tools.filter(tool=>tool.type==='function' && tool.name==='github' && /francestudent_integrations/.test(tool.namespace || ''));
 if(found.length!==1)return null;
 const tool=found[0];
 return {type:'function_call',name:tool.name,namespace:tool.namespace,arguments:{action:'overview'}};
}
function accessProbe(tools,{canDiscover=true,readOnly=false}={}){
 const listings=tools.filter(tool=>tool.type==='function'&&(
  tool.name==='list_directory'&&String(tool.namespace||'').includes('francestudent_ide')||
  tool.name==='mcp__francestudent_ide__list_directory'));
 if(listings.length===1){
  const tool=listings[0];
  return {type:'function_call',name:tool.name,namespace:tool.namespace,arguments:{path:'.'}};
 }
 const matches=readOnly?[]:tools.filter(tool=>tool.name==='exec_command'&&tool.type==='function');
 if(matches.length===1){
  const tool=matches[0],schema=tool.parameters;
  if(schema?.properties?.cmd&&!(schema.required||[]).some(key=>key!=='cmd')){
   return {type:'function_call',name:tool.name,namespace:tool.namespace,arguments:{cmd:'node -p "JSON.stringify(require(\'node:fs\').readdirSync(\'.\').slice(0,80))"'}};
  }
 }
 return null;
}
module.exports={githubAccessProbe,claimsFileOperationNotPerformed,parseAction,errorText,claimsToolsUnavailable,claimsWriteToolsUnavailable,toolResultDenied,projectRecoveryPrompt,accessProbe};
