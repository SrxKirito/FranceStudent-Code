'use strict';
const fs=require('node:fs/promises'),path=require('node:path'),{spawn,execFileSync}=require('node:child_process');
const {CONFIG}=require('../src/config');
const ROOT=path.resolve(__dirname,'..'),SESSION=path.join(CONFIG.dataDir,'plugins/blender-session.json'),PREFERENCES=path.join(CONFIG.dataDir,'plugins/creative.json');
const signature=server=>server?require('node:crypto').createHash('sha256').update(JSON.stringify([server.command,server.args||[],server.env||{}])).digest('hex'):null;
async function saveSettings(prefs){await fs.mkdir(path.dirname(PREFERENCES),{recursive:true});const temp=PREFERENCES+'.tmp';await fs.writeFile(temp,JSON.stringify(prefs),{mode:0o600});await fs.rename(temp,PREFERENCES);}
async function markInstalled(kind,server){const prefs=await settings();prefs.verified={...prefs.verified,[kind]:signature(server)};await saveSettings(prefs);}
async function exists(file){try{return (await fs.stat(file)).isFile();}catch{return false;}}
function studioPath(){return process.platform==='darwin'?'/Applications/RobloxStudio.app/Contents/MacOS/StudioMCP':path.join(process.env.LOCALAPPDATA||'','Roblox','mcp.bat');}
async function settings(){try{return JSON.parse(await fs.readFile(PREFERENCES,'utf8'));}catch(error){if(error.code==='ENOENT')return {};throw error;}}
async function blenderPath(){const prefs=await settings();if(prefs.blender&&await exists(prefs.blender))return prefs.blender;return require('../src/tools/sandbox').findBlender(null)?.path||null;}
async function status(){
 const config=await require('../src/mcp/manager').manager.readConfig();
 const blender=await blenderPath(),studio=studioPath(),servers=config.defs,prefs=await settings();
 const connection=(kind,name)=>{const server=servers.find(s=>s.name===name&&!s.disabled);return {configured:!!server,installed:!!server&&prefs.verified?.[kind]===signature(server)};};
 return {roblox:{available:await exists(studio),...connection('roblox','Roblox_Studio'),guide:'https://create.roblox.com/docs/studio/mcp'},blender:{available:!!blender,...connection('blender','FranceStudent_Blender'),sessionFile:SESSION,addon:path.join(ROOT,'plugins/blender/francestudent_connect.py'),executable:blender}};
}
async function configure(kind,extensionCenter){
 const current=await require('../src/mcp/manager').manager.readConfig();
 const name=kind==='roblox'?'Roblox_Studio':kind==='blender'?'FranceStudent_Blender':null;
 if(!name)throw Error('Plugin inconnu.');
 const existing=current.defs.find(server=>server.name===name);
 if(existing){if(existing.disabled)await extensionCenter.mcpAction('toggle',{name,disabled:false});return {configured:true,existing:true};}
 let command,args,env={};
 if(kind==='roblox'){
  const script=studioPath();if(!await exists(script))throw Error('Serveur officiel Roblox Studio introuvable. Mets Studio à jour, puis active « Enable Studio as MCP server » dans Assistant > Manage MCP Servers.');
  // Le résolveur MCP existant encadre correctement les .bat et chemins à espaces.
  command=script;args=[];
 }else{
  command=process.env.FS_CODEX_NODE_BINARY||execFileSync(process.platform==='win32'?'where.exe':'which',['node'],{encoding:'utf8',windowsHide:true}).trim().split(/\r?\n/)[0];
  args=[path.join(ROOT,'plugins/blender/mcp-server.cjs')];env={FS_BLENDER_SESSION_FILE:SESSION};
  await fs.mkdir(path.dirname(SESSION),{recursive:true});
 }
 await extensionCenter.mcpAction('add',{name,command,args,env});return {configured:true};
}
async function chooseBlender(dialog,win){
 const selected=await dialog.showOpenDialog(win,{title:'Choisir Blender',properties:['openFile'],...(process.platform==='win32'?{filters:[{name:'Blender',extensions:['exe']}]}:{})});
 if(selected.canceled||!selected.filePaths.length)return null;
 const file=await fs.realpath(selected.filePaths[0]);if(!/^blender(?:\.exe)?$/i.test(path.basename(file)))throw Error('Choisis l’exécutable Blender.');
 const prefs=await settings();prefs.blender=file;await saveSettings(prefs);return file;
}
async function launchBlender(extensionCenter){
 const executable=await blenderPath();if(!executable)throw Error('Blender introuvable. Installe-le ou choisis son exécutable.');
 await configure('blender',extensionCenter);
 const child=spawn(executable,['--python',path.join(ROOT,'plugins/blender/bootstrap.py')],{cwd:ROOT,env:{...process.env,FRANCESTUDENT_BLENDER_SESSION_FILE:SESSION},stdio:'ignore',windowsHide:true,detached:true});
 await new Promise((resolve,reject)=>{child.once('spawn',resolve);child.once('error',reject);});child.unref();return {launched:true,message:'Blender démarre dans une nouvelle fenêtre connectée. Les autres fenêtres restent indépendantes.'};
}
async function verify(kind){
 const manager=require('../src/mcp/manager').manager;await manager.ensureStarted();
 const server=kind==='roblox'?'Roblox_Studio':kind==='blender'?'FranceStudent_Blender':null;
 if(!server)throw Error('Plugin inconnu.');
 const entry=manager.list().find(item=>item.name===server);if(!entry||entry.status!=='running')throw Error(entry?.error||'Configure d’abord ce plugin.');
 const tool=kind==='roblox'?'list_roblox_studios':'scene_info';
 const configured=(await manager.readConfig()).defs.find(item=>item.name===server&&!item.disabled);
 // Lecture de connexion seulement : aucune modification de la scène.
 const result=await manager.call(server,tool,{});if(result.isError)throw Error(result.text);
 let content;try{content=JSON.parse(result.text);}catch{content=result.text;}
 if(kind==='roblox'){
  const studios=Array.isArray(content)?content:content?.studios||content?.roblox_studios||content?.instances;
  const connected=Array.isArray(studios)?studios.length>0:null;
  if(connected===true&&configured)await markInstalled(kind,configured);
  return {connected,serverReady:true,server,tool,result:content,message:connected===true?'Une session Studio répond. Choisis son studio_id pour agir.':connected===false?'Le serveur répond, mais aucune session Studio n’est connectée. Ouvre un projet dans Studio.':'Le serveur Studio répond. La liste ci-dessous permet de vérifier les sessions disponibles.'};
 }
 if(!content||typeof content.blender_version!=='string'||!Array.isArray(content.objects))throw Error('Réponse inattendue du plugin Blender.');
 if(configured)await markInstalled(kind,configured);
 return {connected:true,server,tool,result:content,message:'La scène Blender répond.'};
}
module.exports={status,configure,chooseBlender,launchBlender,verify,SESSION};
