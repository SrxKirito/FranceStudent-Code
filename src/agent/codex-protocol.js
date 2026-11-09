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
 return /l['’]outil (?:de modification(?: du projet)?|d['’][ée]criture) n['’]est pas (?:accessible|disponible|activ[ée])/i.test(text)
  || /\bje ne peux pas (?:ex[ée]cuter|utiliser|appeler) (?:ici )?les outils (?:de modification|d['’][ée]criture)\b/i.test(text);
}
function claimsToolsUnavailable(action){
 if(action?.type!=='message'||action.phase!=='final_answer'||typeof action.text!=='string')return false;
 const text=action.text;
 // Une mention des images n'annule pas une affirmation sur les fichiers du projet.
 return claimsWriteToolsUnavailable(text)
  || /(?:je\s+)?n['’]ai\s+(?:pas|aucun)\s+acc[eè]s\s+(?:aux?|[àa] (?:des?|mes?|tes?|vos?))\s+(?:outils?|fichiers?|dossiers?|disque)/i.test(text)
  || /(?:je\s+)?(?:ne\s+peux\s+(?:pas|plus)|n['’]ai\s+pas\s+pu)\s+acc[eé]der\s+(?:au|aux|[àa] (?:des?|mes?|tes?|vos?))\s+(?:projet|outils?|fichiers?|dossiers?|disque)/i.test(text)
  || /(?:je\s+)?ne\s+dispose\s+(?:pas|d['’]aucun)\s+(?:d['’])?(?:outils?|acc[eè]s\s+(?:aux?|[àa] (?:des?|mes?|tes?|vos?))\s+(?:outils?|fichiers?|dossiers?|disque))/i.test(text)
  || /(?:je\s+)?n['’]ai\s+aucun\s+outil/i.test(text)
  || /\bje n['’]ai acc[eè]s qu['’][àa][^.!?\n]{0,180}\b(?:m[ée]t[ée]o|recherche web)\b/i.test(text)
  || /\b(?:edit_file|apply_patch|read_file)\b[^.!?\n]{0,120}\bn['’]en (?:fait|font) pas partie\b/i.test(text)
  || /\b(?:les )?(?:appels|outils) locaux (?:[^.!?\n]{0,80}? )?ne sont pas (?:ex[ée]cutables|disponibles|accessibles)\b/i.test(text)
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
  +'Si tu as déjà lu le fichier à modifier, utilise edit_file ou apply_patch à partir du contenu lu. '
  +'Sinon, recherche ou lis la cible sans répéter une lecture déjà suffisante. '
  +'Respecte la demande utilisateur et les autorisations. Ne redonne pas de compte rendu à cette étape. '
  +'Voici les formes et schémas exacts des outils du projet disponibles : '+JSON.stringify(formats);
}

// Vérifier l’accès via un outil du catalogue déjà filtré par les permissions.
function accessProbe(tools,{canDiscover=true,readOnly=false}={}){
 const listings=tools.filter(tool=>tool.type==='function'&&(
  tool.name==='list_directory'&&String(tool.namespace||'').includes('francestudent_ide')||
  tool.name==='mcp__francestudent_ide__list_directory'));
 if(listings.length===1){
  const tool=listings[0];
  return {type:'function_call',name:tool.name,namespace:tool.namespace,arguments:{path:'.'}};
 }
 const discovery=tools.find(tool=>tool.bridgeType==='tool_search'&&tool.parameters?.properties?.query);
 if(canDiscover&&discovery&&!(discovery.parameters.required||[]).some(key=>key!=='query')){
  return {type:'function_call',name:discovery.name,namespace:discovery.namespace,arguments:{query:'francestudent_ide list_directory search_files read_file'}};
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
module.exports={parseAction,errorText,claimsToolsUnavailable,claimsWriteToolsUnavailable,projectRecoveryPrompt,accessProbe};
